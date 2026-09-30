//! Resumable streaming downloads for offline playback, plus the LRU eviction
//! that keeps the audio cache inside its budget.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tracing::{debug, info, warn};

use crate::error::{AppError, AppResult};
use crate::state::events;

use super::Net;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadReq {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// Relative to the audio cache directory.
    pub dest_relative: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub bytes: u64,
}

pub async fn run(net: &Net, req: DownloadReq) -> AppResult<DownloadResult> {
    let dest = resolve_dest(&net.paths.audio, &req.dest_relative)?;
    let part = part_path(&dest);

    let url = reqwest::Url::parse(&req.url)
        .map_err(|e| AppError::BadRequest(format!("invalid download url {:?}: {e}", req.url)))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::BadRequest(format!(
                "refusing to download scheme {other:?}"
            )))
        }
    }

    let flag = Arc::new(AtomicBool::new(false));
    // Two writers on one `.part` file would interleave their chunks, so an id
    // already in flight is rejected rather than joined.
    match net.cancels.entry(req.id.clone()) {
        Entry::Occupied(_) => {
            return Err(AppError::BadRequest(format!(
                "download {:?} is already in progress",
                req.id
            )))
        }
        Entry::Vacant(slot) => {
            slot.insert(Arc::clone(&flag));
        }
    }
    net.writing.insert(dest.clone(), ());
    let _active = Active {
        net,
        id: req.id.clone(),
        dest: dest.clone(),
    };

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    match stream_to_disk(net, &req, &url, &dest, &part, &flag).await {
        Ok(bytes) => {
            info!(id = %req.id, bytes, path = %dest.display(), "download complete");
            Ok(DownloadResult {
                path: dest.to_string_lossy().into_owned(),
                bytes,
            })
        }
        Err(AppError::Cancelled) => {
            // A cancelled download has no resumable meaning: the caller asked
            // for it to go away.
            if let Err(e) = tokio::fs::remove_file(&part).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    warn!(path = %part.display(), error = %e, "could not delete partial file");
                }
            }
            Err(AppError::Cancelled)
        }
        // Anything else leaves the `.part` file behind on purpose so the next
        // attempt can resume from where this one stopped.
        Err(e) => Err(e),
    }
}

/// Releases the cancellation slot and the write marker however the download
/// ends, including on an early `?`.
struct Active<'a> {
    net: &'a Net,
    id: String,
    dest: PathBuf,
}

impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.net.cancels.remove(&self.id);
        self.net.writing.remove(&self.dest);
    }
}

struct Stream {
    resp: reqwest::Response,
    /// Whether the server honoured the resume range.
    append: bool,
    already_on_disk: u64,
    total: Option<u64>,
}

enum Opened {
    Ready(Stream),
    /// The server refused the `Range` we asked for; the `.part` file is stale.
    RangeRejected,
}

async fn stream_to_disk(
    net: &Net,
    req: &DownloadReq,
    url: &reqwest::Url,
    dest: &Path,
    part: &Path,
    flag: &AtomicBool,
) -> AppResult<u64> {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let resume_from = match tokio::fs::metadata(part).await {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => 0,
    };

    net.throttle.acquire(&host).await;
    if flag.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }

    let stream = match open(net, req, url, resume_from).await? {
        Opened::Ready(stream) => stream,
        Opened::RangeRejected => {
            warn!(id = %req.id, resume_from, "server rejected the resume range; restarting");
            if let Err(e) = tokio::fs::remove_file(part).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(AppError::Io(e));
                }
            }
            match open(net, req, url, 0).await? {
                Opened::Ready(stream) => stream,
                Opened::RangeRejected => {
                    return Err(AppError::Http(
                        "server rejected a request that carried no range".to_string(),
                    ))
                }
            }
        }
    };

    let Stream {
        mut resp,
        append,
        already_on_disk,
        total,
    } = stream;

    let mut file = if append {
        debug!(id = %req.id, already_on_disk, "resuming download");
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(part)
            .await?
    } else {
        tokio::fs::File::create(part).await?
    };

    let mut received = already_on_disk;
    // Back-dated so the very first chunk already satisfies the interval and the
    // UI gets a datapoint without waiting 250 ms for one.
    let mut last_emit = Instant::now()
        .checked_sub(PROGRESS_INTERVAL)
        .unwrap_or_else(Instant::now);

    loop {
        if flag.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => return Err(AppError::Http(e.to_string())),
        };
        file.write_all(&chunk).await?;
        received = received.saturating_add(chunk.len() as u64);

        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            emit_progress(net, &req.id, received, total);
        }
    }

    // A short read must never be promoted into place: the renamed file would
    // look complete to every later reader.
    if let Some(expected) = total {
        if received < expected {
            return Err(AppError::Http(format!(
                "download truncated at {received} of {expected} bytes"
            )));
        }
    }

    file.flush().await?;
    file.sync_all().await?;
    drop(file);

    tokio::fs::rename(part, dest).await?;
    sync_parent_dir(dest).await;

    emit_progress(net, &req.id, received, total.or(Some(received)));
    Ok(received)
}

async fn open(
    net: &Net,
    req: &DownloadReq,
    url: &reqwest::Url,
    resume_from: u64,
) -> AppResult<Opened> {
    let mut rb = net.client.get(url.clone());
    // Byte offsets and progress totals only mean anything on the untransformed
    // entity: the shared client advertises gzip/brotli, and a content-coded
    // body would make `Content-Range` and the bytes written disagree.
    if !has_header(req.headers.as_ref(), "accept-encoding") {
        rb = rb.header(reqwest::header::ACCEPT_ENCODING, "identity");
    }
    if let Some(headers) = &req.headers {
        for (name, value) in headers {
            rb = rb.header(name.as_str(), value.as_str());
        }
    }
    if resume_from > 0 {
        rb = rb.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }

    let resp = rb.send().await.map_err(|e| AppError::Http(e.to_string()))?;
    let status = resp.status();

    if resume_from > 0 {
        if status == reqwest::StatusCode::PARTIAL_CONTENT {
            let total = content_range_total(resp.headers())
                .or_else(|| resp.content_length().map(|len| len + resume_from));
            return Ok(Opened::Ready(Stream {
                resp,
                append: true,
                already_on_disk: resume_from,
                total,
            }));
        }
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(Opened::RangeRejected);
        }
    }

    if !status.is_success() {
        return Err(AppError::Http(format!("{status} for {url}")));
    }

    // 200 in answer to a Range request means the server ignored it, so the
    // bytes on disk are worthless and the file is rewritten from zero.
    Ok(Opened::Ready(Stream {
        total: resp.content_length(),
        resp,
        append: false,
        already_on_disk: 0,
    }))
}

/// Evicts offline audio, least recently used first, until the cache tree fits
/// inside `max_bytes`. Returns the number of bytes freed.
pub fn prune_lru(net: &Net, max_bytes: u64) -> AppResult<u64> {
    // Expired response rows do not live in the cache tree, but a prune is the
    // natural moment to drop them.
    if let Err(e) = net.cache.prune_expired() {
        warn!(error = %e, "could not prune the response cache");
    }

    let mut total = super::dir_bytes(&net.paths.cache);
    if total <= max_bytes {
        return Ok(0);
    }

    let rows = super::db_query(
        &net.db,
        "SELECT track_uri, path, bytes FROM offline_audio ORDER BY last_used_at ASC",
        vec![],
    )?;

    let mut freed = 0u64;
    for row in rows {
        if total <= max_bytes {
            break;
        }
        let Some(track_uri) = row.get("track_uri").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = row.get("path").and_then(Value::as_str) else {
            continue;
        };
        let path = PathBuf::from(path);
        if net.is_in_flight(&path) {
            continue;
        }

        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or_else(|_| {
            row.get("bytes").and_then(Value::as_u64).unwrap_or(0)
        });
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                warn!(path = %path.display(), error = %e, "could not evict offline audio");
                continue;
            }
        }
        super::db_execute(
            &net.db,
            "DELETE FROM offline_audio WHERE track_uri = ?1",
            vec![json!(track_uri)],
        )?;

        freed = freed.saturating_add(size);
        total = total.saturating_sub(size);
    }

    info!(freed, budget = max_bytes, "pruned offline audio cache");
    Ok(freed)
}

/// Maps `destRelative` onto a real path under the audio cache, refusing
/// anything that could reach outside it.
fn resolve_dest(root: &Path, dest_relative: &str) -> AppResult<PathBuf> {
    if dest_relative.is_empty() {
        return Err(AppError::BadRequest("destRelative is empty".to_string()));
    }
    if dest_relative.contains('\0') {
        return Err(AppError::BadRequest(
            "destRelative contains a NUL byte".to_string(),
        ));
    }
    if Path::new(dest_relative).is_absolute()
        || dest_relative.starts_with('/')
        || dest_relative.starts_with('\\')
    {
        return Err(AppError::BadRequest(format!(
            "destRelative must be relative: {dest_relative:?}"
        )));
    }

    let mut out = root.to_path_buf();
    // Both separators are rejected explicitly: on Unix a literal `..\..` is a
    // legal single filename, and this path is also read on Windows.
    for segment in dest_relative.split(['/', '\\']) {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(AppError::BadRequest(format!(
                "destRelative may not traverse upwards: {dest_relative:?}"
            )));
        }
        out.push(segment);
    }

    if out == root {
        return Err(AppError::BadRequest(format!(
            "destRelative names no file: {dest_relative:?}"
        )));
    }
    if !out.starts_with(root) {
        return Err(AppError::BadRequest(format!(
            "destRelative escapes the cache directory: {dest_relative:?}"
        )));
    }
    Ok(out)
}

fn has_header(headers: Option<&HashMap<String, String>>, name: &str) -> bool {
    headers.is_some_and(|map| map.keys().any(|k| k.eq_ignore_ascii_case(name)))
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name: OsString = dest.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

fn content_range_total(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    raw.rsplit('/').next()?.trim().parse::<u64>().ok()
}

/// The rename is only durable once the directory entry itself reaches disk.
/// `fsync` on a directory is not portable, so a failure here is logged and the
/// download still counts as done.
async fn sync_parent_dir(dest: &Path) {
    let Some(dir) = dest.parent() else { return };
    match tokio::fs::File::open(dir).await {
        Ok(handle) => {
            if let Err(e) = handle.sync_all().await {
                debug!(dir = %dir.display(), error = %e, "directory fsync failed");
            }
        }
        Err(e) => debug!(dir = %dir.display(), error = %e, "directory could not be opened for fsync"),
    }
}

fn emit_progress(net: &Net, id: &str, received: u64, total: Option<u64>) {
    (net.emit)(
        events::DOWNLOAD,
        json!({ "id": id, "received": received, "total": total }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/var/cache/ritmo/audio")
    }

    #[test]
    fn plain_relative_destinations_resolve_under_the_root() {
        let resolved = resolve_dest(&root(), "audius/track/7eP5n.mp3").expect("valid dest");
        assert_eq!(
            resolved,
            PathBuf::from("/var/cache/ritmo/audio/audius/track/7eP5n.mp3")
        );
        assert!(resolved.starts_with(root()));
    }

    #[test]
    fn colons_in_a_segment_are_allowed() {
        // Track uris are the natural filename source and they contain colons.
        let resolved = resolve_dest(&root(), "archive:track:etree-1977.mp3").expect("valid dest");
        assert_eq!(
            resolved,
            PathBuf::from("/var/cache/ritmo/audio/archive:track:etree-1977.mp3")
        );
    }

    #[test]
    fn traversal_is_rejected() {
        for bad in [
            "../secrets",
            "..",
            "a/../../b",
            "a/b/../../../c",
            "./../x",
            "nested/../../../../etc/passwd",
            "..\\windows\\win.ini",
            "a\\..\\..\\b",
        ] {
            let err = resolve_dest(&root(), bad).expect_err(bad);
            assert!(
                matches!(err, AppError::BadRequest(_)),
                "{bad} produced {err:?}"
            );
        }
    }

    #[test]
    fn absolute_and_empty_destinations_are_rejected() {
        for bad in ["/etc/passwd", "/", "\\\\server\\share\\x", "", "\0"] {
            let err = resolve_dest(&root(), bad).expect_err(bad);
            assert!(
                matches!(err, AppError::BadRequest(_)),
                "{bad} produced {err:?}"
            );
        }
    }

    #[test]
    fn a_destination_that_names_only_separators_is_rejected() {
        for bad in [".", "./", "./.", "//"] {
            assert!(resolve_dest(&root(), bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn part_file_sits_next_to_its_destination() {
        let dest = PathBuf::from("/var/cache/ritmo/audio/a/b.mp3");
        assert_eq!(
            part_path(&dest),
            PathBuf::from("/var/cache/ritmo/audio/a/b.mp3.part")
        );
    }

    #[test]
    fn caller_headers_are_matched_case_insensitively() {
        let mut map = HashMap::new();
        map.insert("Accept-Encoding".to_string(), "gzip".to_string());
        assert!(has_header(Some(&map), "accept-encoding"));
        assert!(!has_header(Some(&map), "range"));
        assert!(!has_header(None, "accept-encoding"));
    }

    #[test]
    fn content_range_yields_the_full_length() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_RANGE,
            "bytes 200-1000/1067".parse().expect("literal header"),
        );
        assert_eq!(content_range_total(&headers), Some(1067));

        headers.insert(
            reqwest::header::CONTENT_RANGE,
            "bytes 0-5/*".parse().expect("literal header"),
        );
        assert_eq!(content_range_total(&headers), None);

        assert_eq!(
            content_range_total(&reqwest::header::HeaderMap::new()),
            None
        );
    }
}
