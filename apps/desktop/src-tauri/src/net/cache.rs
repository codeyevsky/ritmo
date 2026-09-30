//! Disk-backed response cache, living in the `http_cache` table so it shares
//! the library database's WAL and backup story instead of inventing a second
//! on-disk format.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::{debug, warn};

use crate::db::Database;
use crate::error::AppResult;

use super::http::HttpResponse;

/// Past this the table stops behaving like a cache and starts costing more in
/// WAL churn than the round trips it saves.
const MAX_ROWS: i64 = 20_000;
/// Trimming needs a sort over the whole table, so it runs on a counter rather
/// than on every stored response.
const TRIM_EVERY: u32 = 200;

/// `sha256(method + "\n" + url + "\n" + body)`, hex. The body is part of the
/// key because POST search endpoints differ only there.
pub fn cache_key(method: &str, url: &str, body: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(method.as_bytes());
    hasher.update(b"\n");
    hasher.update(url.as_bytes());
    hasher.update(b"\n");
    hasher.update(body.unwrap_or_default().as_bytes());
    hex::encode(hasher.finalize())
}

pub struct ResponseCache {
    db: Arc<Database>,
    puts_since_trim: AtomicU32,
}

impl ResponseCache {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            puts_since_trim: AtomicU32::new(0),
        }
    }

    pub fn get(&self, key: &str) -> AppResult<Option<HttpResponse>> {
        let rows = super::db_query(
            &self.db,
            "SELECT status, headers_json, body FROM http_cache \
             WHERE key = ?1 AND expires_at > ?2",
            vec![json!(key), json!(super::now_ms())],
        )?;

        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };

        let Some(status) = row.get("status").and_then(Value::as_u64) else {
            warn!(key, "cache row has no status; ignoring it");
            return Ok(None);
        };
        let body = row
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let headers = row
            .get("headers_json")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(raw).ok())
            .unwrap_or_default();

        Ok(Some(HttpResponse {
            status: status as u16,
            headers,
            body,
            from_cache: true,
        }))
    }

    pub fn put(&self, key: &str, url: &str, res: &HttpResponse, ttl_sec: u64) -> AppResult<()> {
        // Caching an error would pin a provider outage in place for the whole
        // TTL, and a zero TTL is the caller's way of saying "bypass".
        if ttl_sec == 0 || !(200..300).contains(&res.status) {
            return Ok(());
        }

        let now = super::now_ms();
        let expires_at = now.saturating_add(ttl_sec.saturating_mul(1_000).min(i64::MAX as u64) as i64);
        let headers_json = serde_json::to_string(&res.headers).unwrap_or_else(|e| {
            warn!(error = %e, "could not encode response headers; caching without them");
            "{}".to_string()
        });

        super::db_execute(
            &self.db,
            "INSERT INTO http_cache (key, url, status, headers_json, body, created_at, expires_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(key) DO UPDATE SET \
               url = excluded.url, status = excluded.status, \
               headers_json = excluded.headers_json, body = excluded.body, \
               created_at = excluded.created_at, expires_at = excluded.expires_at",
            vec![
                json!(key),
                json!(url),
                json!(res.status),
                json!(headers_json),
                json!(res.body),
                json!(now),
                json!(expires_at),
            ],
        )?;

        if self.puts_since_trim.fetch_add(1, Ordering::Relaxed) + 1 >= TRIM_EVERY {
            self.puts_since_trim.store(0, Ordering::Relaxed);
            self.trim()?;
        }
        Ok(())
    }

    pub fn prune_expired(&self) -> AppResult<usize> {
        let removed = super::db_execute(
            &self.db,
            "DELETE FROM http_cache WHERE expires_at <= ?1",
            vec![json!(super::now_ms())],
        )?;
        let trimmed = self.trim()?;
        if removed + trimmed > 0 {
            debug!(removed, trimmed, "pruned http cache");
        }
        Ok(removed + trimmed)
    }

    pub fn clear(&self) -> AppResult<()> {
        super::db_execute(&self.db, "DELETE FROM http_cache", vec![])?;
        self.puts_since_trim.store(0, Ordering::Relaxed);
        Ok(())
    }

    fn trim(&self) -> AppResult<usize> {
        super::db_execute(
            &self.db,
            "DELETE FROM http_cache WHERE key IN ( \
               SELECT key FROM http_cache ORDER BY created_at DESC LIMIT -1 OFFSET ?1 \
             )",
            vec![json!(MAX_ROWS)],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_stable_across_calls() {
        let a = cache_key("GET", "https://api.audius.co/v1/tracks/trending", None);
        let b = cache_key("GET", "https://api.audius.co/v1/tracks/trending", None);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn key_is_body_sensitive() {
        let url = "https://lrclib.net/api/search";
        let none = cache_key("POST", url, None);
        let empty = cache_key("POST", url, Some(""));
        let one = cache_key("POST", url, Some(r#"{"q":"alpha"}"#));
        let two = cache_key("POST", url, Some(r#"{"q":"beta"}"#));

        // An absent body and an empty body hash the same; different bodies must not.
        assert_eq!(none, empty);
        assert_ne!(one, two);
        assert_ne!(one, none);
    }

    #[test]
    fn key_separates_method_and_url_fields() {
        assert_ne!(
            cache_key("GET", "https://x.test/a", None),
            cache_key("POST", "https://x.test/a", None)
        );
        assert_ne!(
            cache_key("GET", "https://x.test/a", None),
            cache_key("GET", "https://x.test/b", None)
        );
        // The "\n" delimiter must stop fields bleeding into one another.
        assert_ne!(
            cache_key("GET", "https://x.test/a", Some("b")),
            cache_key("GET", "https://x.test/a\nb", None)
        );
    }

    #[test]
    fn key_matches_a_known_digest() {
        // Pinned so a refactor of the hashing order invalidates the test rather
        // than silently invalidating every user's cache.
        assert_eq!(
            cache_key("GET", "https://x.test/", None),
            {
                let mut h = Sha256::new();
                h.update(b"GET\nhttps://x.test/\n");
                hex::encode(h.finalize())
            }
        );
    }
}
