//! The frontend's only door to the network and to the filesystem.
//!
//! Every provider request in the app funnels through [`Net::request`], which
//! buys three things a WebView `fetch` cannot: no CORS jail, a shared on-disk
//! response cache, and a per-host rate gate that keeps Ritmo inside the
//! published limits of the metadata services it depends on.

pub mod commands;

mod cache;
mod download;
mod http;
mod throttle;

pub use download::{DownloadReq, DownloadResult};
pub use http::{HttpMethod, HttpRequest, HttpResponse};
pub use throttle::HostThrottle;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use serde_json::{json, Map, Value};
use tracing::{info, warn};

use crate::audio::EmitFn;
use crate::db::Database;
use crate::error::AppResult;
use crate::state::Paths;

use cache::ResponseCache;

pub struct Net {
    paths: Paths,
    db: Arc<Database>,
    emit: EmitFn,
    client: reqwest::Client,
    cache: ResponseCache,
    throttle: HostThrottle,
    /// Cancellation flags for in-flight downloads, keyed by the caller's id.
    cancels: DashMap<String, Arc<AtomicBool>>,
    /// Final destinations currently being streamed into. The LRU pruner reads
    /// this so it can never delete a file a download is halfway through.
    writing: DashMap<PathBuf, ()>,
}

impl Net {
    pub fn new(db: Arc<Database>, paths: Paths, emit: EmitFn) -> AppResult<Arc<Self>> {
        let client = http::build_client()?;
        let cache = ResponseCache::new(Arc::clone(&db));
        Ok(Arc::new(Self {
            paths,
            db,
            emit,
            client,
            cache,
            throttle: HostThrottle::new(),
            cancels: DashMap::new(),
            writing: DashMap::new(),
        }))
    }

    pub async fn request(&self, req: HttpRequest) -> AppResult<HttpResponse> {
        http::perform(self, req).await
    }

    /// The shared client, for the few callers that speak an API too specific to
    /// go through [`Net::request`] — the pack publisher's GitHub calls. Handing
    /// this out rather than letting them build their own is what keeps one
    /// connection pool and, more importantly, one `User-Agent`: several of the
    /// hosts Ritmo talks to reject a request without it.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub async fn download(&self, req: DownloadReq) -> AppResult<DownloadResult> {
        download::run(self, req).await
    }

    pub fn cancel_download(&self, id: &str) {
        match self.cancels.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                info!(id, "download cancellation requested");
            }
            None => warn!(id, "cancel requested for an unknown download"),
        }
    }

    /// Bytes currently occupied by the on-disk cache tree (offline audio and
    /// extracted artwork). The response cache lives in SQLite next to the
    /// library database and is therefore not counted here.
    pub fn cache_size(&self) -> AppResult<u64> {
        Ok(dir_bytes(&self.paths.cache))
    }

    pub fn cache_prune(&self, max_bytes: u64) -> AppResult<u64> {
        download::prune_lru(self, max_bytes)
    }

    pub fn cache_clear(&self) -> AppResult<()> {
        self.cache.clear()?;

        // Artwork is deliberately spared: it is small, and re-extracting it
        // costs a full library rescan.
        let mut removed = 0u64;
        for entry in walkdir::WalkDir::new(&self.paths.audio)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.into_path();
            if self.is_in_flight(&path) {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => warn!(path = %path.display(), error = %e, "could not delete cached audio"),
            }
        }

        let rows = db_query(&self.db, "SELECT track_uri, path FROM offline_audio", vec![])?;
        for row in rows {
            let Some(uri) = row.get("track_uri").and_then(Value::as_str) else {
                continue;
            };
            let in_flight = row
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|p| self.is_in_flight(Path::new(p)));
            if in_flight {
                continue;
            }
            db_execute(
                &self.db,
                "DELETE FROM offline_audio WHERE track_uri = ?1",
                vec![json!(uri)],
            )?;
        }

        info!(files = removed, "cache cleared");
        Ok(())
    }

    /// True for a download's destination and for its `.part` sibling, so a
    /// sweep over the audio directory leaves both alone.
    fn is_in_flight(&self, path: &Path) -> bool {
        if self.writing.contains_key(path) {
            return true;
        }
        match path.to_str().and_then(|s| s.strip_suffix(".part")) {
            Some(stem) => self.writing.contains_key(Path::new(stem)),
            None => false,
        }
    }
}

/// The db layer speaks JSON parameters; funnelling every net query through
/// these two shims keeps that conversion out of the call sites.
fn db_query(db: &Database, sql: &str, params: Vec<Value>) -> AppResult<Vec<Map<String, Value>>> {
    db.query_json(sql, &params)
}

fn db_execute(db: &Database, sql: &str, params: Vec<Value>) -> AppResult<usize> {
    db.execute_json(sql, &params)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn dir_bytes(root: &Path) -> u64 {
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .fold(0u64, |acc, len| acc.saturating_add(len))
}
