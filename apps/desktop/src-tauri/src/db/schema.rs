//! Schema migrations.
//!
//! `MIGRATIONS[N - 1]` is migration `N`; the applied version lives in
//! `PRAGMA user_version`. Migration 1 is a verbatim transcription of
//! `docs/schema.sql` (minus its connection pragmas, which `Database::open`
//! applies and which SQLite refuses inside a transaction).

use rusqlite::Connection;
use tracing::info;

use crate::error::{AppError, AppResult};

pub const MIGRATIONS: &[&str] = &[
    MIGRATION_0001_INITIAL,
    // 2 — user edits. Tags on disk stay untouched (the user chose in-app edits
    // only), so an override has to be recorded here or the next rescan would
    // read the file again and undo it. Holds a JSON array of column names.
    MIGRATION_0002_TRACK_EDITS,
    // 3 — packs and the Bazaar, verbatim from docs/packs.md.
    MIGRATION_0003_PACKS,
];

const MIGRATION_0002_TRACK_EDITS: &str = "ALTER TABLE tracks ADD COLUMN edited_json TEXT";

const MIGRATION_0003_PACKS: &str = r#"
CREATE TABLE IF NOT EXISTS packs (
  uri          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  author       TEXT,
  artwork_json TEXT,
  source       TEXT NOT NULL,
  source_url   TEXT,
  pack_url     TEXT,
  remote_id    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pack_items (
  pack_uri   TEXT NOT NULL REFERENCES packs(uri) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  match_json TEXT NOT NULL,
  track_json TEXT,
  track_uri  TEXT,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (pack_uri, position)
);
CREATE INDEX IF NOT EXISTS idx_pack_items_track ON pack_items(track_uri);

CREATE TABLE IF NOT EXISTS bazaar_sources (
  url           TEXT PRIMARY KEY,
  name          TEXT,
  added_at      INTEGER NOT NULL,
  last_fetch_at INTEGER,
  ok            INTEGER NOT NULL DEFAULT 1,
  error         TEXT
);
"#;

const MIGRATION_0001_INITIAL: &str = r#"
CREATE TABLE IF NOT EXISTS artists (
  uri          TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  name         TEXT NOT NULL,
  name_key     TEXT NOT NULL,
  artwork_json TEXT,
  genres_json  TEXT,
  followers    INTEGER,
  bio          TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artists_name_key ON artists(name_key);
CREATE INDEX IF NOT EXISTS idx_artists_provider ON artists(provider);

CREATE TABLE IF NOT EXISTS albums (
  uri            TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  name           TEXT NOT NULL,
  name_key       TEXT NOT NULL,
  artists_json   TEXT NOT NULL,
  primary_artist TEXT,
  artwork_json   TEXT,
  release_date   TEXT,
  album_type     TEXT,
  total_tracks   INTEGER,
  genres_json    TEXT,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_albums_name_key ON albums(name_key);
CREATE INDEX IF NOT EXISTS idx_albums_artist  ON albums(primary_artist);
CREATE INDEX IF NOT EXISTS idx_albums_provider ON albums(provider);

CREATE TABLE IF NOT EXISTS tracks (
  uri            TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  title          TEXT NOT NULL,
  title_key      TEXT NOT NULL,
  artists_json   TEXT NOT NULL,
  primary_artist TEXT,
  album_uri      TEXT REFERENCES albums(uri) ON DELETE SET NULL,
  album_json     TEXT,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  track_number   INTEGER,
  disc_number    INTEGER,
  release_date   TEXT,
  genres_json    TEXT,
  artwork_json   TEXT,
  popularity     REAL,
  explicit       INTEGER NOT NULL DEFAULT 0,
  is_live        INTEGER NOT NULL DEFAULT 0,
  gain_db        REAL,
  path           TEXT,
  meta_json      TEXT,
  added_at       INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  file_mtime     INTEGER,
  file_size      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path) WHERE path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracks_album     ON tracks(album_uri);
CREATE INDEX IF NOT EXISTS idx_tracks_title_key ON tracks(title_key);
CREATE INDEX IF NOT EXISTS idx_tracks_artist    ON tracks(primary_artist);
CREATE INDEX IF NOT EXISTS idx_tracks_provider  ON tracks(provider);
CREATE INDEX IF NOT EXISTS idx_tracks_added     ON tracks(added_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  uri UNINDEXED, title, artists, album, tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS trg_tracks_fts_ins AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(uri, title, artists, album)
  VALUES (new.uri, new.title, COALESCE(new.primary_artist, ''),
          COALESCE(json_extract(new.album_json, '$.name'), ''));
END;
CREATE TRIGGER IF NOT EXISTS trg_tracks_fts_del AFTER DELETE ON tracks BEGIN
  DELETE FROM tracks_fts WHERE uri = old.uri;
END;
CREATE TRIGGER IF NOT EXISTS trg_tracks_fts_upd AFTER UPDATE ON tracks BEGIN
  DELETE FROM tracks_fts WHERE uri = old.uri;
  INSERT INTO tracks_fts(uri, title, artists, album)
  VALUES (new.uri, new.title, COALESCE(new.primary_artist, ''),
          COALESCE(json_extract(new.album_json, '$.name'), ''));
END;

CREATE TABLE IF NOT EXISTS likes (
  uri      TEXT PRIMARY KEY,
  kind     TEXT NOT NULL,
  liked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_likes_kind ON likes(kind, liked_at DESC);

CREATE TABLE IF NOT EXISTS playlists (
  uri          TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  artwork_json TEXT,
  owner        TEXT,
  editable     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_playlists_sort ON playlists(sort_order, updated_at DESC);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_uri TEXT NOT NULL REFERENCES playlists(uri) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  track_uri    TEXT NOT NULL,
  track_json   TEXT NOT NULL,
  added_at     INTEGER NOT NULL,
  PRIMARY KEY (playlist_uri, position)
);
CREATE INDEX IF NOT EXISTS idx_pli_track ON playlist_items(track_uri);

CREATE TABLE IF NOT EXISTS play_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_uri  TEXT NOT NULL,
  track_json TEXT NOT NULL,
  played_at  INTEGER NOT NULL,
  played_ms  INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  completed  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_history_at    ON play_history(played_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_track ON play_history(track_uri, played_at DESC);

CREATE TABLE IF NOT EXISTS settings_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_config (
  provider TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (provider, key)
);

CREATE TABLE IF NOT EXISTS http_cache (
  key          TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  status       INTEGER NOT NULL,
  headers_json TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_http_cache_exp ON http_cache(expires_at);

CREATE TABLE IF NOT EXISTS offline_audio (
  track_uri     TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  mime          TEXT,
  downloaded_at INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offline_lru ON offline_audio(last_used_at);

CREATE TABLE IF NOT EXISTS scan_state (
  folder       TEXT PRIMARY KEY,
  last_scan_at INTEGER NOT NULL,
  file_count   INTEGER NOT NULL DEFAULT 0
);
"#;

/// The `tracks_fts` projection the triggers maintain. Reused by [`rebuild_fts`]
/// so the two can never drift apart.
const FTS_SELECT: &str = "SELECT uri, title, COALESCE(primary_artist, ''), \
     COALESCE(json_extract(album_json, '$.name'), '') FROM tracks";

pub fn latest_version() -> u32 {
    MIGRATIONS.len() as u32
}

/// Applies every migration the database is missing and returns the resulting
/// version. A no-op when already current.
pub fn migrate(conn: &Connection) -> AppResult<u32> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let target = latest_version();

    if current > target {
        return Err(AppError::Other(format!(
            "library database is at schema version {current}, but this build only knows {target}"
        )));
    }
    if current == target {
        return Ok(current);
    }

    // `unchecked_transaction` rather than `Connection::transaction` because the
    // caller only holds a shared reference; nothing else can touch this
    // connection while the migration runs.
    let tx = conn.unchecked_transaction()?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        tx.execute_batch(sql)?;
        info!(version = index + 1, "applied schema migration");
    }
    // Interpolated because SQLite does not accept bound parameters in a PRAGMA;
    // `target` is derived from a compile-time constant, never from input.
    tx.execute_batch(&format!("PRAGMA user_version = {target}"))?;
    tx.commit()?;

    rebuild_fts(conn)?;
    Ok(target)
}

/// Repopulates `tracks_fts` from `tracks`. `tracks_fts` is a standalone (not
/// external-content) FTS5 table, so a damaged index can be discarded and
/// regenerated without rewriting the `tracks` rows.
pub fn rebuild_fts(conn: &Connection) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM tracks_fts", [])?;
    tx.execute(
        &format!("INSERT INTO tracks_fts(uri, title, artists, album) {FTS_SELECT}"),
        [],
    )?;
    tx.commit()?;
    Ok(())
}
