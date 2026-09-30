//! SQLite storage for the library, settings and caches.
//!
//! One connection behind a mutex: SQLite in WAL mode serialises writers anyway,
//! and the whole working set is small enough that a pool would buy nothing but
//! a second class of `SQLITE_BUSY` to handle. Long-running work (library scans)
//! batches its statements into transactions so the lock is never held for long.

pub mod commands;
pub mod json;
pub mod schema;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde_json::{Map, Value as JsonValue};
use tracing::{debug, info, warn};

use crate::error::AppResult;

/// `mmap_size` of 256 MiB covers a large library's hot pages without the
/// address-space cost mattering on the 64-bit targets we ship.
const PRAGMAS: &str = "\
PRAGMA journal_mode = WAL;\
PRAGMA synchronous = NORMAL;\
PRAGMA foreign_keys = ON;\
PRAGMA busy_timeout = 5000;\
PRAGMA temp_store = MEMORY;\
PRAGMA cache_size = -32000;\
PRAGMA mmap_size = 268435456;";

/// Reclaiming less than this is not worth rewriting the whole file for.
const VACUUM_THRESHOLD_BYTES: i64 = 32 * 1024 * 1024;

pub struct Database {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        let db = Self::configure(conn, path.to_path_buf())?;
        info!(path = %path.display(), "library database ready");
        Ok(db)
    }

    /// Used by the unit tests and by any caller that wants a throwaway library.
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure(conn, PathBuf::from(":memory:"))
    }

    fn configure(conn: Connection, path: PathBuf) -> AppResult<Self> {
        conn.execute_batch(PRAGMAS)?;
        let version = schema::migrate(&conn)?;
        debug!(version, "schema at version");
        Ok(Self { conn: Mutex::new(conn), path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn query_json(
        &self,
        sql: &str,
        params: &[JsonValue],
    ) -> AppResult<Vec<Map<String, JsonValue>>> {
        let bound = bind(params);
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(sql)?;
        // Owned up front: `query` needs the statement mutably afterwards.
        let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
        let mut rows = stmt.query(params_from_iter(bound.iter()))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(json::row_to_map(row, &names));
        }
        Ok(out)
    }

    pub fn execute_json(&self, sql: &str, params: &[JsonValue]) -> AppResult<usize> {
        let bound = bind(params);
        let conn = self.conn.lock();
        Ok(conn.execute(sql, params_from_iter(bound.iter()))?)
    }

    pub fn transaction_json(&self, stmts: &[(String, Vec<JsonValue>)]) -> AppResult<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for (sql, params) in stmts {
            let bound = bind(params);
            tx.execute(sql.as_str(), params_from_iter(bound.iter()))?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn maintenance(&self) -> AppResult<()> {
        let conn = self.conn.lock();

        let expired = conn.execute("DELETE FROM http_cache WHERE expires_at <= ?1", [now_ms()])?;
        if expired > 0 {
            debug!(rows = expired, "pruned expired http cache entries");
        }

        conn.execute_batch("PRAGMA optimize")?;

        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let freelist: i64 = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
        let slack = freelist.saturating_mul(page_size);
        if slack > VACUUM_THRESHOLD_BYTES {
            info!(slack_bytes = slack, "vacuuming database");
            conn.execute_batch("VACUUM")?;
        }
        Ok(())
    }

    /// Repopulates `tracks_fts` from `tracks`; the migration runner calls this
    /// too, so search survives a corrupted index.
    pub fn rebuild_fts(&self) -> AppResult<()> {
        let conn = self.conn.lock();
        schema::rebuild_fts(&conn)
    }

    pub fn kv_get(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row("SELECT value FROM settings_kv WHERE key = ?1", [key], |row| row.get(0))
            .optional()?)
    }

    pub fn kv_set(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings_kv(key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )?;
        Ok(())
    }

    pub fn kv_remove(&self, key: &str) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM settings_kv WHERE key = ?1", [key])?;
        Ok(())
    }

    pub fn kv_keys(&self, prefix: Option<&str>) -> AppResult<Vec<String>> {
        let conn = self.conn.lock();
        let keys = match prefix {
            Some(prefix) => {
                let mut stmt = conn.prepare(
                    "SELECT key FROM settings_kv WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key",
                )?;
                let pattern = format!("{}%", escape_like(prefix));
                let rows = stmt.query_map([pattern], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<String>>>()?
            }
            None => {
                let mut stmt = conn.prepare("SELECT key FROM settings_kv ORDER BY key")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<String>>>()?
            }
        };
        Ok(keys)
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        // A truncating checkpoint leaves no `-wal` sidecar behind, so a crash on
        // the next launch cannot find a half-applied log.
        if let Err(e) = self.conn.lock().execute_batch("PRAGMA wal_checkpoint(TRUNCATE)") {
            warn!(error = %e, "wal checkpoint on shutdown failed");
        }
    }
}

fn bind(params: &[JsonValue]) -> Vec<SqlValue> {
    params.iter().map(json::json_to_sql).collect()
}

/// `LIKE` treats `%` and `_` as wildcards; a key prefix must match literally.
fn escape_like(prefix: &str) -> String {
    let mut out = String::with_capacity(prefix.len());
    for ch in prefix.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Database {
        Database::open_in_memory().expect("in-memory database")
    }

    fn user_version(db: &Database) -> u32 {
        db.conn
            .lock()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user_version")
    }

    fn insert_track(db: &Database, uri: &str, title: &str, artist: &str, album: &str) {
        let affected = db
            .execute_json(
                "INSERT INTO tracks(uri, provider, title, title_key, artists_json, \
                 primary_artist, album_json, duration_ms, added_at, updated_at) \
                 VALUES (?1, 'local', ?2, ?3, ?4, ?5, ?6, 1000, 0, 0)",
                &[
                    json!(uri),
                    json!(title),
                    json!(title.to_lowercase()),
                    json!([{ "uri": "local:artist:1", "name": artist }]),
                    json!(artist),
                    json!({ "uri": "local:album:1", "name": album }),
                ],
            )
            .expect("insert track");
        assert_eq!(affected, 1);
    }

    fn fts_hits(db: &Database, query: &str) -> Vec<String> {
        db.query_json("SELECT uri FROM tracks_fts WHERE tracks_fts MATCH ?1", &[json!(query)])
            .expect("fts query")
            .into_iter()
            .filter_map(|row| match row.get("uri") {
                Some(JsonValue::String(s)) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn migration_reaches_latest_version_and_is_idempotent() {
        let db = db();
        let latest = schema::latest_version();
        assert_eq!(user_version(&db), latest);

        let conn = db.conn.lock();
        assert_eq!(schema::migrate(&conn).expect("re-migrate"), latest);
        assert_eq!(schema::migrate(&conn).expect("re-migrate twice"), latest);
        drop(conn);
        assert_eq!(user_version(&db), latest);

        // Every table the frozen schema promises must exist after migration 1.
        let tables = db
            .query_json(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
                &[],
            )
            .expect("list tables");
        let names: Vec<String> = tables
            .iter()
            .filter_map(|row| match row.get("name") {
                Some(JsonValue::String(s)) => Some(s.clone()),
                _ => None,
            })
            .collect();
        for expected in [
            "albums",
            "artists",
            "bazaar_sources",
            "http_cache",
            "likes",
            "offline_audio",
            "pack_items",
            "packs",
            "play_history",
            "playlist_items",
            "playlists",
            "provider_config",
            "scan_state",
            "settings_kv",
            "tracks",
            "tracks_fts",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing table {expected}");
        }
    }

    #[test]
    fn json_values_round_trip() {
        let db = db();
        db.execute_json(
            "CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT, payload BLOB)",
            &[],
        )
        .expect("create probe");

        let cases: Vec<(&str, JsonValue, JsonValue)> = vec![
            ("null", JsonValue::Null, JsonValue::Null),
            ("true", json!(true), json!(1)),
            ("false", json!(false), json!(0)),
            ("int", json!(-42), json!(-42)),
            ("big-int", json!(9_007_199_254_740_993i64), json!(9_007_199_254_740_993i64)),
            ("integral-float", json!(8.0), json!(8)),
            ("real", json!(1.5), json!(1.5)),
            ("text", json!("ritmo"), json!("ritmo")),
            ("array", json!([1, "a", null]), json!("[1,\"a\",null]")),
            ("object", json!({ "a": 1 }), json!("{\"a\":1}")),
        ];

        for (label, input, expected) in &cases {
            db.execute_json(
                "INSERT INTO probe(label, payload) VALUES (?1, ?2)",
                &[json!(label), input.clone()],
            )
            .expect("insert probe row");

            let rows = db
                .query_json("SELECT payload FROM probe WHERE label = ?1", &[json!(label)])
                .expect("select probe row");
            assert_eq!(rows.len(), 1, "{label}");
            let got = rows[0].get("payload").expect("payload column");
            assert_eq!(got, expected, "{label} round-tripped wrong");
        }

        let blob = db
            .query_json("SELECT CAST(x'526974' AS BLOB) AS b", &[])
            .expect("blob query");
        assert_eq!(blob[0].get("b"), Some(&json!("Uml0")));
    }

    #[test]
    fn transaction_is_all_or_nothing() {
        let db = db();
        let stmts = vec![
            ("INSERT INTO settings_kv(key, value) VALUES ('a', '1')".to_string(), vec![]),
            ("INSERT INTO settings_kv(key, value) VALUES ('b', ?1)".to_string(), vec![json!("2")]),
        ];
        db.transaction_json(&stmts).expect("commit");
        assert_eq!(db.kv_keys(None).expect("keys"), vec!["a".to_string(), "b".to_string()]);

        let bad = vec![
            ("INSERT INTO settings_kv(key, value) VALUES ('c', '3')".to_string(), vec![]),
            ("INSERT INTO settings_kv(key, value) VALUES ('a', 'dup')".to_string(), vec![]),
        ];
        assert!(db.transaction_json(&bad).is_err());
        assert_eq!(db.kv_get("c").expect("kv_get"), None);
        assert_eq!(db.kv_get("a").expect("kv_get"), Some("1".to_string()));
    }

    #[test]
    fn kv_helpers() {
        let db = db();
        assert_eq!(db.kv_get("missing").expect("kv_get"), None);

        db.kv_set("eq.volume", "0.8").expect("set");
        db.kv_set("eq.volume", "0.9").expect("overwrite");
        db.kv_set("eq.preset", "flat").expect("set");
        db.kv_set("queue.index", "3").expect("set");
        db.kv_set("100%_odd", "x").expect("set");

        assert_eq!(db.kv_get("eq.volume").expect("kv_get"), Some("0.9".to_string()));
        assert_eq!(
            db.kv_keys(Some("eq.")).expect("prefix keys"),
            vec!["eq.preset".to_string(), "eq.volume".to_string()]
        );
        // The wildcards in the prefix must be matched literally.
        assert_eq!(db.kv_keys(Some("100%_")).expect("escaped keys"), vec!["100%_odd".to_string()]);
        assert_eq!(db.kv_keys(Some("nope")).expect("no keys"), Vec::<String>::new());

        db.kv_remove("eq.preset").expect("remove");
        assert_eq!(db.kv_get("eq.preset").expect("kv_get"), None);
        db.kv_remove("eq.preset").expect("remove missing is a no-op");
    }

    #[test]
    fn fts_tracks_insert_update_delete() {
        let db = db();
        insert_track(&db, "local:track:1", "Kayıp Şehir", "Ezhel", "Müptezhel");
        insert_track(&db, "local:track:2", "Blue Monday", "New Order", "Substance");

        assert_eq!(fts_hits(&db, "sehir"), vec!["local:track:1".to_string()]);
        assert_eq!(fts_hits(&db, "muptezhel"), vec!["local:track:1".to_string()]);
        assert_eq!(fts_hits(&db, "order"), vec!["local:track:2".to_string()]);

        db.execute_json(
            "UPDATE tracks SET title = ?1, primary_artist = ?2, album_json = ?3 WHERE uri = ?4",
            &[
                json!("Ceza Vakti"),
                json!("Sagopa"),
                json!({ "uri": "local:album:2", "name": "Bir Pesimistin Gozyaslari" }),
                json!("local:track:1"),
            ],
        )
        .expect("update track");

        assert!(fts_hits(&db, "sehir").is_empty(), "stale row survived the update");
        assert_eq!(fts_hits(&db, "ceza"), vec!["local:track:1".to_string()]);
        assert_eq!(fts_hits(&db, "sagopa"), vec!["local:track:1".to_string()]);
        assert_eq!(fts_hits(&db, "pesimistin"), vec!["local:track:1".to_string()]);

        db.execute_json("DELETE FROM tracks WHERE uri = ?1", &[json!("local:track:1")])
            .expect("delete track");
        assert!(fts_hits(&db, "ceza").is_empty());
        assert_eq!(fts_hits(&db, "order"), vec!["local:track:2".to_string()]);

        let count = db
            .query_json("SELECT COUNT(*) AS n FROM tracks_fts", &[])
            .expect("count fts");
        assert_eq!(count[0].get("n"), Some(&json!(1)));
    }

    #[test]
    fn rebuild_fts_restores_a_wiped_index() {
        let db = db();
        insert_track(&db, "local:track:1", "Kayıp Şehir", "Ezhel", "Müptezhel");
        db.execute_json("DELETE FROM tracks_fts", &[]).expect("wipe index");
        assert!(fts_hits(&db, "sehir").is_empty());

        db.rebuild_fts().expect("rebuild");
        assert_eq!(fts_hits(&db, "sehir"), vec!["local:track:1".to_string()]);
        assert_eq!(fts_hits(&db, "muptezhel"), vec!["local:track:1".to_string()]);
    }

    #[test]
    fn maintenance_prunes_expired_cache_entries() {
        let db = db();
        let past = now_ms() - 60_000;
        let future = now_ms() + 60_000;
        for (key, expires) in [("stale", past), ("fresh", future)] {
            db.execute_json(
                "INSERT INTO http_cache(key, url, status, headers_json, body, created_at, expires_at) \
                 VALUES (?1, 'https://example.test/', 200, '{}', 'body', 0, ?2)",
                &[json!(key), json!(expires)],
            )
            .expect("insert cache row");
        }

        db.maintenance().expect("maintenance");

        let rows = db
            .query_json("SELECT key FROM http_cache ORDER BY key", &[])
            .expect("list cache");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("key"), Some(&json!("fresh")));
    }
}
