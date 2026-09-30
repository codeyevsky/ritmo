//! Byte sources for the decoder.
//!
//! Local files are handed to symphonia directly. Remote URLs are downloaded by
//! a tokio task into a part file under `<cache>/audio/tmp`, which the decoder
//! reads synchronously through a blocking reader. The part file doubles as the
//! seek window: a backward seek is an ordinary file seek, a long forward seek
//! restarts the transfer with a `Range` request.
//!
//! Icecast/SHOUTcast stations interleave `StreamTitle` blocks into the audio
//! bytes. The writer strips them before they reach the part file — the decoder
//! must never see them — and publishes the title through [`IcyMetadata`].

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Once, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use futures_util::StreamExt;
use parking_lot::{Condvar, Mutex};
use reqwest::header::{HeaderMap, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode};
use sha2::{Digest, Sha256};
use symphonia::core::io::MediaSource;
use tokio::io::AsyncWriteExt;
use tokio::runtime::{Builder, Handle, Runtime};
use tokio::task::AbortHandle;
use tracing::{debug, warn};

use crate::error::{AppError, AppResult};
use crate::state::Paths;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long to wait for response headers before giving up on a transfer.
const HEADER_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a reader waits for the next byte before declaring the stream dead.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// A forward seek no further than this ahead of the download window is served
/// by waiting; anything beyond restarts the transfer with a ranged request.
const SEQUENTIAL_WINDOW: u64 = 256 * 1024;
const STALE_PART_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Request/response header pair that turns on ICY in-band metadata.
const ICY_REQUEST: &str = "Icy-MetaData";
const ICY_METAINT: &str = "icy-metaint";
/// A length byte counts 16-byte units, so a block is at most 255 * 16 bytes.
const ICY_UNIT: usize = 16;
const USER_AGENT: &str = concat!("Ritmo/", env!("CARGO_PKG_VERSION"));

pub struct SourceSpec {
    pub url: String,
    pub local_path: Option<String>,
    pub headers: std::collections::HashMap<String, String>,
    pub mime: Option<String>,
}

/// An opened byte source plus whatever the opener learned on the way.
pub struct OpenedSource {
    pub media: Box<dyn MediaSource>,
    pub ext_hint: Option<String>,
    /// Present only for HTTP sources that advertised `icy-metaint`.
    pub icy: Option<Arc<IcyMetadata>>,
}

/// Local paths open directly; everything else streams over HTTP into a
/// disk-backed cache that the decoder reads synchronously.
pub fn open_source(spec: &SourceSpec, paths: &Paths) -> AppResult<OpenedSource> {
    if let Some(path) = local_file(spec) {
        if path.is_file() || !is_remote(&spec.url) {
            let hint = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .filter(|e| !e.is_empty());
            let file = File::open(&path).map_err(|e| match e.kind() {
                io::ErrorKind::NotFound => AppError::NotFound(path.display().to_string()),
                _ => AppError::Io(e),
            })?;
            return Ok(OpenedSource { media: Box::new(file), ext_hint: hint, icy: None });
        }
        warn!(path = %path.display(), "local copy is gone, streaming instead");
    }

    if !is_remote(&spec.url) {
        return Err(AppError::BadRequest(format!("unplayable source url: {}", spec.url)));
    }

    let hint = remote_ext_hint(spec);
    let tmp_dir = paths.cache.join("audio").join("tmp");
    fs::create_dir_all(&tmp_dir)?;
    sweep_stale_parts(&tmp_dir);

    let key = cache_key(&spec.url);
    let warm_path = tmp_dir.join(format!("{key}.audio"));
    if warm_path.is_file() {
        match File::open(&warm_path) {
            Ok(file) => {
                debug!(key = %key, "serving audio from the warm stream cache");
                return Ok(OpenedSource { media: Box::new(file), ext_hint: hint, icy: None });
            }
            Err(e) => warn!("warm stream cache entry unreadable, re-streaming: {e}"),
        }
    }

    let stream = HttpStream::open(spec, tmp_dir, warm_path, key)?;
    let icy = stream.icy();
    Ok(OpenedSource { media: Box::new(stream), ext_hint: hint, icy })
}

fn is_remote(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

fn local_file(spec: &SourceSpec) -> Option<PathBuf> {
    if let Some(raw) = spec.local_path.as_deref() {
        if !raw.trim().is_empty() {
            return Some(PathBuf::from(raw));
        }
    }
    if spec.url.starts_with("file://") {
        if let Ok(url) = url::Url::parse(&spec.url) {
            if let Ok(path) = url.to_file_path() {
                return Some(path);
            }
        }
    }
    None
}

fn remote_ext_hint(spec: &SourceSpec) -> Option<String> {
    let from_url = url_extension(&spec.url);
    if let Some(ext) = from_url.as_deref() {
        if is_audio_ext(ext) {
            return Some(ext.to_string());
        }
    }
    if let Some(mime) = spec.mime.as_deref() {
        if let Some(ext) = mime_extension(mime) {
            return Some(ext.to_string());
        }
    }
    from_url
}

fn url_extension(raw: &str) -> Option<String> {
    let path = match url::Url::parse(raw) {
        Ok(url) => url.path().to_string(),
        Err(_) => raw.split(['?', '#']).next().unwrap_or(raw).to_string(),
    };
    let name = path.rsplit('/').next()?;
    let (_, ext) = name.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Extensions symphonia can make sense of. Used to decide whether a URL's
/// extension is a better hint than the server's declared content type.
fn is_audio_ext(ext: &str) -> bool {
    matches!(
        ext,
        "mp3"
            | "flac"
            | "ogg"
            | "oga"
            | "opus"
            | "m4a"
            | "m4b"
            | "mp4"
            | "aac"
            | "adts"
            | "alac"
            | "wav"
            | "wave"
            | "aiff"
            | "aif"
            | "aifc"
            | "mka"
            | "webm"
            | "caf"
    )
}

fn mime_extension(mime: &str) -> Option<&'static str> {
    let mime = mime.split(';').next().unwrap_or(mime).trim().to_ascii_lowercase();
    Some(match mime.as_str() {
        "audio/mpeg" | "audio/mp3" | "audio/mpeg3" | "audio/x-mpeg" => "mp3",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/ogg" | "application/ogg" | "audio/vorbis" | "audio/x-ogg" => "ogg",
        "audio/opus" => "opus",
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" | "audio/mp4a-latm" | "audio/alac" => "m4a",
        "audio/aac" | "audio/aacp" | "audio/x-aac" => "aac",
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => "wav",
        "audio/aiff" | "audio/x-aiff" => "aiff",
        "audio/webm" | "video/webm" | "audio/x-matroska" => "webm",
        "audio/x-caf" => "caf",
        _ => return None,
    })
}

fn cache_key(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    hex::encode(digest.get(..8).unwrap_or(&digest[..]))
}

fn part_path(dir: &Path, key: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    // The pid keeps two concurrently running instances off each other's files.
    dir.join(format!("{key}-{:x}-{seq:04x}.part", std::process::id()))
}

/// Crashed runs leave part files behind; nothing else ever cleans them up.
fn sweep_stale_parts(dir: &Path) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Some(cutoff) = SystemTime::now().checked_sub(STALE_PART_AGE) else { return };
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("part") {
                continue;
            }
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t < cutoff)
                .unwrap_or(false);
            if stale {
                debug!(path = %path.display(), "removing abandoned stream cache part");
                let _ = fs::remove_file(&path);
            }
        }
    });
}

fn http_client() -> AppResult<Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let built = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(USER_AGENT)
        // Transparent decompression would break byte offsets and Content-Length,
        // and audio payloads do not compress anyway.
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

fn runtime_handle() -> AppResult<Handle> {
    if let Ok(handle) = Handle::try_current() {
        return Ok(handle);
    }
    static FALLBACK: OnceLock<Runtime> = OnceLock::new();
    if let Some(rt) = FALLBACK.get() {
        return Ok(rt.handle().clone());
    }
    // A current-thread runtime would need somebody to call `block_on` before a
    // spawned task made progress, so give the fallback one real worker.
    let rt = Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name("ritmo-audio-net")
        .enable_all()
        .build()?;
    Ok(FALLBACK.get_or_init(|| rt).handle().clone())
}

struct TransferState {
    /// Absolute offset in the resource of byte 0 of the part file.
    base: u64,
    /// Bytes appended to the part file and flushed to the OS so far.
    written: u64,
    /// Length of the whole resource, once the server disclosed it.
    total: Option<u64>,
    /// Set once the response proved the body is ICY-interleaved.
    icy_metaint: Option<usize>,
    headers_ready: bool,
    finished: bool,
    cancelled: bool,
    error: Option<String>,
}

struct Transfer {
    path: PathBuf,
    /// Where a completed whole-resource transfer is promoted to on drop.
    warm_path: PathBuf,
    /// `Some` only when this transfer asked for in-band metadata.
    icy: Option<Arc<IcyMetadata>>,
    state: Mutex<TransferState>,
    progress: Condvar,
    abort: OnceLock<AbortHandle>,
}

impl Transfer {
    fn start(
        handle: &Handle,
        client: Client,
        url: String,
        headers: HashMap<String, String>,
        want_base: u64,
        path: PathBuf,
        warm_path: PathBuf,
        icy: Option<Arc<IcyMetadata>>,
    ) -> AppResult<Arc<Self>> {
        // Create it here so the reader can open its own descriptor immediately,
        // without racing the task that will fill it.
        File::create(&path)?;

        let transfer = Arc::new(Transfer {
            path,
            warm_path,
            icy,
            state: Mutex::new(TransferState {
                base: want_base,
                written: 0,
                total: None,
                icy_metaint: None,
                headers_ready: false,
                finished: false,
                cancelled: false,
                error: None,
            }),
            progress: Condvar::new(),
            abort: OnceLock::new(),
        });

        let task = Arc::clone(&transfer);
        let join = handle.spawn(async move {
            let outcome = fetch(&task, client, url, headers, want_base).await;
            {
                let mut state = task.state.lock();
                if let Err(e) = outcome {
                    if state.error.is_none() && !state.cancelled {
                        warn!("audio transfer failed: {e}");
                        state.error = Some(e);
                    }
                }
                // Unblock anybody still waiting on headers that will never come.
                state.headers_ready = true;
                state.finished = true;
            }
            task.progress.notify_all();
        });
        let _ = transfer.abort.set(join.abort_handle());

        Ok(transfer)
    }

    /// Stops the download task. The task holds an `Arc` of its own, so without
    /// this an abandoned reader would leave a radio stream filling the disk.
    fn cancel(&self) {
        {
            let mut state = self.state.lock();
            // A transfer that already ran to completion must keep its flags so
            // the part file can still be promoted to the warm cache.
            if state.finished && state.error.is_none() {
                return;
            }
            state.cancelled = true;
            state.finished = true;
            state.headers_ready = true;
        }
        self.progress.notify_all();
        if let Some(abort) = self.abort.get() {
            abort.abort();
        }
    }

    fn wait_ready(&self, timeout: Duration) -> io::Result<(u64, Option<u64>)> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock();
        while !state.headers_ready {
            if self.progress.wait_until(&mut state, deadline).timed_out() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for the audio stream response",
                ));
            }
        }
        if let Some(e) = &state.error {
            return Err(io::Error::other(e.clone()));
        }
        Ok((state.base, state.total))
    }

    /// True when the part file holds the complete resource starting at byte 0,
    /// which makes it usable as a cache entry for the next play.
    fn holds_full_resource(&self) -> bool {
        let state = self.state.lock();
        state.finished
            && !state.cancelled
            && state.error.is_none()
            && state.base == 0
            && state.total.is_some_and(|total| state.written >= total)
    }
}

impl Drop for Transfer {
    fn drop(&mut self) {
        let promote = self.holds_full_resource();
        self.cancel();
        if promote {
            if self.warm_path.exists() {
                let _ = fs::remove_file(&self.path);
            } else if let Err(e) = fs::rename(&self.path, &self.warm_path) {
                debug!("could not promote the stream cache entry: {e}");
                let _ = fs::remove_file(&self.path);
            }
            return;
        }
        let _ = fs::remove_file(&self.path);
    }
}

async fn fetch(
    transfer: &Transfer,
    client: Client,
    url: String,
    headers: HashMap<String, String>,
    want_base: u64,
) -> Result<(), String> {
    let mut request = client.get(&url);
    for (name, value) in &headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if want_base > 0 {
        request = request.header(RANGE, format!("bytes={want_base}-"));
    }
    // Only the initial GET: a ranged re-request means we are seeking a finite
    // resource, where in-band metadata has no meaning.
    let want_icy = want_base == 0 && transfer.icy.is_some();
    if want_icy {
        request = request.header(ICY_REQUEST, "1");
    }

    let response = request.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();

    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        // We seeked to or past the end; report it as an empty window at `want_base`.
        {
            let mut state = transfer.state.lock();
            state.base = want_base;
            state.total = Some(want_base);
            state.headers_ready = true;
        }
        transfer.progress.notify_all();
        return Ok(());
    }
    if !status.is_success() {
        return Err(format!("HTTP {} for {url}", status.as_u16()));
    }

    // A 200 to a ranged request means the server ignored the range and is
    // sending the whole resource from the start.
    let (base, total) = match parse_content_range(response.headers()) {
        Some(range) => range,
        None => (0, response.content_length()),
    };
    let metaint = if want_icy { parse_metaint(response.headers()) } else { None };
    {
        let mut state = transfer.state.lock();
        state.base = base;
        state.total = total;
        state.icy_metaint = metaint;
        state.headers_ready = true;
    }
    transfer.progress.notify_all();
    if let Some(metaint) = metaint {
        debug!(metaint, url = %url, "station interleaves icy metadata");
    }

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(&transfer.path)
        .await
        .map_err(|e| format!("cannot write the stream cache: {e}"))?;

    let mut body = response.bytes_stream();
    let mut deinterleaver = metaint.map(IcyDeinterleaver::new);
    let mut audio_buf = Vec::new();
    let mut blocks = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| format!("stream aborted: {e}"))?;
        if chunk.is_empty() {
            continue;
        }
        let audio: &[u8] = match deinterleaver.as_mut() {
            Some(deinterleaver) => {
                audio_buf.clear();
                blocks.clear();
                deinterleaver.push(&chunk, &mut audio_buf, &mut blocks);
                for block in &blocks {
                    let Some(title) = parse_stream_title(block) else { continue };
                    if let Some(icy) = transfer.icy.as_ref() {
                        if icy.publish(title.clone()) {
                            debug!(title = %title, "icy stream title");
                        }
                    }
                }
                &audio_buf
            }
            None => &chunk,
        };
        if audio.is_empty() {
            continue;
        }
        file.write_all(audio).await.map_err(|e| format!("cannot write the stream cache: {e}"))?;
        // Flush before publishing the new length: the reader has its own
        // descriptor and must never be told about bytes still in tokio's buffer.
        file.flush().await.map_err(|e| format!("cannot write the stream cache: {e}"))?;
        {
            let mut state = transfer.state.lock();
            if state.cancelled {
                return Ok(());
            }
            state.written += audio.len() as u64;
        }
        transfer.progress.notify_all();
    }

    file.flush().await.map_err(|e| format!("cannot write the stream cache: {e}"))?;
    Ok(())
}

fn parse_content_range(headers: &HeaderMap) -> Option<(u64, Option<u64>)> {
    let raw = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    let rest = raw.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let start = range.trim().split('-').next()?.trim().parse::<u64>().ok()?;
    let total = total.trim();
    let total = if total == "*" { None } else { total.parse::<u64>().ok() };
    Some((start, total))
}

/// Latest in-band title from a live stream, shared with the engine thread.
pub struct IcyMetadata {
    state: Mutex<IcyState>,
}

#[derive(Default)]
struct IcyState {
    latest: Option<String>,
    /// Cleared by `take_if_changed`; set again only by a genuinely new title.
    unread: bool,
}

impl IcyMetadata {
    fn new() -> Self {
        IcyMetadata { state: Mutex::new(IcyState::default()) }
    }

    /// Returns true when the title actually changed, so the caller can log it.
    fn publish(&self, title: String) -> bool {
        let mut state = self.state.lock();
        if state.latest.as_deref() == Some(title.as_str()) {
            return false;
        }
        state.latest = Some(title);
        state.unread = true;
        true
    }

    /// Returns the title only when it changed since the last call, so the
    /// caller can poll cheaply without re-emitting.
    pub fn take_if_changed(&self) -> Option<String> {
        let mut state = self.state.lock();
        if !state.unread {
            return None;
        }
        state.unread = false;
        state.latest.clone()
    }

    /// Part of the shared cell's contract even though the engine only ever
    /// polls `take_if_changed`; `source` is a private module, so nothing else
    /// keeps the symbol alive.
    #[allow(dead_code)]
    pub fn latest(&self) -> Option<String> {
        self.state.lock().latest.clone()
    }
}

fn parse_metaint(headers: &HeaderMap) -> Option<usize> {
    let raw = headers.get(ICY_METAINT)?.to_str().ok()?;
    let interval = raw.trim().parse::<usize>().ok()?;
    // Zero would make every byte a length byte; treat it as "no metadata".
    (interval > 0).then_some(interval)
}

/// Splits an ICY body — `metaint` audio bytes, a length byte, `len * 16`
/// metadata bytes, repeat — back into pure audio plus whole metadata blocks.
/// Network chunks fall wherever they like, so all of it is resumable state.
struct IcyDeinterleaver {
    metaint: usize,
    /// Audio bytes still owed before the next length byte.
    audio_left: usize,
    /// `Some(n)` while inside a metadata block, `None` while audio flows.
    meta_left: Option<usize>,
    meta: Vec<u8>,
}

impl IcyDeinterleaver {
    fn new(metaint: usize) -> Self {
        IcyDeinterleaver {
            metaint,
            audio_left: metaint,
            meta_left: None,
            meta: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &[u8], audio: &mut Vec<u8>, blocks: &mut Vec<Vec<u8>>) {
        let mut rest = chunk;
        while !rest.is_empty() {
            if let Some(left) = self.meta_left {
                let take = left.min(rest.len());
                let (head, tail) = rest.split_at(take);
                self.meta.extend_from_slice(head);
                rest = tail;
                if left == take {
                    blocks.push(std::mem::take(&mut self.meta));
                    self.meta_left = None;
                    self.audio_left = self.metaint;
                } else {
                    self.meta_left = Some(left - take);
                }
                continue;
            }
            if self.audio_left == 0 {
                let (length, tail) = rest.split_at(1);
                rest = tail;
                let bytes = usize::from(length[0]) * ICY_UNIT;
                if bytes == 0 {
                    // The usual case: the station repeats "nothing changed".
                    self.audio_left = self.metaint;
                } else {
                    self.meta.clear();
                    self.meta_left = Some(bytes);
                }
                continue;
            }
            let take = self.audio_left.min(rest.len());
            let (head, tail) = rest.split_at(take);
            audio.extend_from_slice(head);
            rest = tail;
            self.audio_left -= take;
        }
    }
}

/// Stations are split between UTF-8 and latin-1, and neither announces which.
fn decode_icy_text(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_string(),
        Err(_) => raw.iter().map(|&b| char::from(b)).collect(),
    }
}

/// Pulls `StreamTitle` out of a `key='value';` block. Values may contain `;`,
/// so the scan looks for the closing `';` and not for a bare separator.
fn parse_stream_title(block: &[u8]) -> Option<String> {
    let text = decode_icy_text(block);
    let text = text.trim_end_matches('\0');
    // Byte lengths survive ASCII lowercasing, so indices stay interchangeable.
    let key = "streamtitle='";
    let start = text.to_ascii_lowercase().find(key)? + key.len();
    let rest = text.get(start..)?;
    let value = match rest.find("';") {
        Some(end) => rest.get(..end)?,
        // Some servers drop the final separator; nothing may follow the quote.
        None => rest.strip_suffix('\'')?,
    };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Blocking reader over a transfer's part file.
pub struct HttpStream {
    client: Client,
    handle: Handle,
    url: String,
    headers: HashMap<String, String>,
    key: String,
    tmp_dir: PathBuf,
    warm_path: PathBuf,
    /// Absolute offset in the resource of byte 0 of the current part file.
    base: u64,
    /// Absolute read position in the resource.
    pos: u64,
    /// Where the descriptor sits inside the part file.
    cursor: u64,
    total: Option<u64>,
    /// Declared before `transfer` so the descriptor is closed before
    /// `Transfer::drop` renames or unlinks the part file — Windows refuses both
    /// while a handle is open.
    file: File,
    transfer: Arc<Transfer>,
}

impl HttpStream {
    fn open(
        spec: &SourceSpec,
        tmp_dir: PathBuf,
        warm_path: PathBuf,
        key: String,
    ) -> AppResult<Self> {
        let client = http_client()?;
        let handle = runtime_handle()?;
        let transfer = Transfer::start(
            &handle,
            client.clone(),
            spec.url.clone(),
            spec.headers.clone(),
            0,
            part_path(&tmp_dir, &key),
            warm_path.clone(),
            Some(Arc::new(IcyMetadata::new())),
        )?;
        let (base, total) = transfer.wait_ready(HEADER_TIMEOUT)?;
        let file = File::open(&transfer.path)?;

        debug!(url = %spec.url, total = ?total, "streaming audio over http");
        Ok(HttpStream {
            client,
            handle,
            url: spec.url.clone(),
            headers: spec.headers.clone(),
            key,
            tmp_dir,
            warm_path,
            base,
            pos: 0,
            cursor: 0,
            total,
            file,
            transfer,
        })
    }

    /// Restarts the download at `target` with a ranged request and points the
    /// reader at the new part file.
    fn rebase(&mut self, target: u64) -> io::Result<()> {
        let transfer = Transfer::start(
            &self.handle,
            self.client.clone(),
            self.url.clone(),
            self.headers.clone(),
            target,
            part_path(&self.tmp_dir, &self.key),
            self.warm_path.clone(),
            None,
        )
        .map_err(|e| io::Error::other(e.to_string()))?;

        let (base, total) = transfer.wait_ready(HEADER_TIMEOUT)?;
        let file = File::open(&transfer.path)?;
        debug!(target, base, "restarted the audio transfer at a byte offset");

        let previous_file = std::mem::replace(&mut self.file, file);
        let previous_transfer = std::mem::replace(&mut self.transfer, transfer);
        previous_transfer.cancel();
        drop(previous_file);
        drop(previous_transfer);

        self.base = base;
        self.pos = target;
        self.cursor = 0;
        if total.is_some() {
            self.total = total;
        }
        Ok(())
    }

    /// The shared title cell, handed out only when the station really does
    /// interleave metadata — otherwise the engine would poll a dead cell.
    fn icy(&self) -> Option<Arc<IcyMetadata>> {
        if self.transfer.state.lock().icy_metaint.is_none() {
            return None;
        }
        self.transfer.icy.clone()
    }

    /// Blocks until at least one byte is readable at `self.pos`, returning how
    /// many are available, or `0` at end of stream.
    fn wait_available(&self) -> io::Result<u64> {
        let deadline = Instant::now() + STALL_TIMEOUT;
        let mut state = self.transfer.state.lock();
        loop {
            let end = state.base.saturating_add(state.written);
            if end > self.pos {
                return Ok(end - self.pos);
            }
            if let Some(e) = &state.error {
                return Err(io::Error::other(e.clone()));
            }
            if state.finished {
                return Ok(0);
            }
            if self.transfer.progress.wait_until(&mut state, deadline).timed_out() {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "audio stream stalled"));
            }
        }
    }
}

impl Drop for HttpStream {
    fn drop(&mut self) {
        // Runs before the fields are dropped; `Transfer::drop` cannot do this
        // itself because the download task keeps the last `Arc` alive.
        self.transfer.cancel();
    }
}

impl Read for HttpStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.total.is_some_and(|total| self.pos >= total) {
            return Ok(0);
        }
        // Can only happen if a server answered a ranged request with a window
        // that starts after what we asked for.
        if self.pos < self.base {
            self.rebase(self.pos)?;
        }

        let available = self.wait_available()?;
        if available == 0 {
            return Ok(0);
        }

        let mut want = buf.len().min(usize::try_from(available).unwrap_or(usize::MAX));
        if let Some(total) = self.total {
            want = want.min(usize::try_from(total - self.pos).unwrap_or(usize::MAX));
        }
        let Some(slice) = buf.get_mut(..want) else { return Ok(0) };
        if slice.is_empty() {
            return Ok(0);
        }

        let offset = self.pos - self.base;
        if self.cursor != offset {
            self.file.seek(SeekFrom::Start(offset))?;
            self.cursor = offset;
        }
        let read = self.file.read(slice)?;
        self.cursor += read as u64;
        self.pos += read as u64;
        Ok(read)
    }
}

impl Seek for HttpStream {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(n) => n,
            SeekFrom::Current(delta) => offset_by(self.pos, delta)?,
            SeekFrom::End(delta) => {
                let total = self.total.ok_or_else(|| {
                    io::Error::new(io::ErrorKind::Unsupported, "stream length is unknown")
                })?;
                offset_by(total, delta)?
            }
        };

        if self.total.is_some_and(|total| target >= total) {
            self.pos = target;
            return Ok(target);
        }

        let (base, written, active) = {
            let state = self.transfer.state.lock();
            (state.base, state.written, !state.finished && state.error.is_none())
        };
        let end = base.saturating_add(written);
        let inside_window = target >= base && target <= end;
        // Waiting beats a fresh connection only when the sequential download is
        // practically there already; a real seek inside a 40 MB FLAC must not
        // sit through tens of megabytes of transfer.
        let nearly_there = active && target > end && target - end <= SEQUENTIAL_WINDOW;

        if inside_window || nearly_there {
            self.pos = target;
            return Ok(target);
        }
        self.rebase(target)?;
        Ok(target)
    }

    fn stream_position(&mut self) -> io::Result<u64> {
        Ok(self.pos)
    }
}

impl MediaSource for HttpStream {
    fn is_seekable(&self) -> bool {
        self.total.is_some()
    }

    fn byte_len(&self) -> Option<u64> {
        self.total
    }
}

fn offset_by(origin: u64, delta: i64) -> io::Result<u64> {
    origin
        .checked_add_signed(delta)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek position out of range"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(url: &str, mime: Option<&str>) -> SourceSpec {
        SourceSpec {
            url: url.to_string(),
            local_path: None,
            headers: HashMap::new(),
            mime: mime.map(|m| m.to_string()),
        }
    }

    #[test]
    fn cache_key_is_stable_and_short() {
        let a = cache_key("https://example.test/a.mp3");
        assert_eq!(a.len(), 16);
        assert_eq!(a, cache_key("https://example.test/a.mp3"));
        assert_ne!(a, cache_key("https://example.test/b.mp3"));
    }

    #[test]
    fn extension_comes_from_the_url_path() {
        assert_eq!(url_extension("https://h.test/x/song.FLAC?token=1").as_deref(), Some("flac"));
        assert_eq!(url_extension("https://h.test/v1/tracks/abc/stream"), None);
        assert_eq!(url_extension("https://h.test/a.verylongext"), None);
    }

    #[test]
    fn mime_fills_in_when_the_url_has_no_extension() {
        assert_eq!(remote_ext_hint(&spec("https://h.test/stream", Some("audio/mpeg"))).as_deref(), Some("mp3"));
        assert_eq!(
            remote_ext_hint(&spec("https://h.test/s", Some("audio/ogg; codecs=opus"))).as_deref(),
            Some("ogg")
        );
        assert_eq!(remote_ext_hint(&spec("https://h.test/s", None)), None);
    }

    #[test]
    fn url_extension_wins_over_a_generic_mime() {
        let hint = remote_ext_hint(&spec("https://h.test/track.flac", Some("application/octet-stream")));
        assert_eq!(hint.as_deref(), Some("flac"));
    }

    #[test]
    fn parses_content_range_variants() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_RANGE, "bytes 1024-2047/8192".parse().expect("header"));
        assert_eq!(parse_content_range(&headers), Some((1024, Some(8192))));

        let mut unknown = HeaderMap::new();
        unknown.insert(CONTENT_RANGE, "bytes 512-1023/*".parse().expect("header"));
        assert_eq!(parse_content_range(&unknown), Some((512, None)));

        assert_eq!(parse_content_range(&HeaderMap::new()), None);
    }

    #[test]
    fn local_path_takes_priority_over_the_url() {
        let s = SourceSpec {
            url: "https://h.test/song.mp3".into(),
            local_path: Some("/music/song.flac".into()),
            headers: HashMap::new(),
            mime: None,
        };
        assert_eq!(local_file(&s), Some(PathBuf::from("/music/song.flac")));
    }

    #[cfg(unix)]
    #[test]
    fn file_urls_resolve_to_paths() {
        let s = spec("file:///music/a%20b.mp3", None);
        assert_eq!(local_file(&s), Some(PathBuf::from("/music/a b.mp3")));
    }

    #[test]
    fn remote_detection_excludes_local_schemes() {
        assert!(is_remote("http://h.test/a"));
        assert!(is_remote("https://h.test/a"));
        assert!(!is_remote("file:///a"));
        assert!(!is_remote("/a/b.mp3"));
    }

    #[test]
    fn signed_seek_offsets_are_checked() {
        assert_eq!(offset_by(100, -40).ok(), Some(60));
        assert!(offset_by(10, -40).is_err());
        assert!(offset_by(u64::MAX, 1).is_err());
    }

    #[test]
    fn opening_a_missing_local_file_reports_not_found() {
        let paths = Paths {
            data: PathBuf::from("/nonexistent-ritmo-data"),
            cache: PathBuf::from("/nonexistent-ritmo-cache"),
            artwork: PathBuf::from("/nonexistent-ritmo-cache/artwork"),
            audio: PathBuf::from("/nonexistent-ritmo-cache/audio"),
            http: PathBuf::from("/nonexistent-ritmo-cache/http"),
        };
        let s = SourceSpec {
            url: String::new(),
            local_path: Some("/definitely/not/here.flac".into()),
            headers: HashMap::new(),
            mime: None,
        };
        match open_source(&s, &paths) {
            Err(e) => assert_eq!(e.code(), "not_found"),
            Ok(_) => panic!("a missing local file must not open"),
        }
    }

    const METAINT: usize = 4;

    /// Pads a metadata payload out to the 16-byte units a length byte counts.
    fn meta_block(payload: &str) -> Vec<u8> {
        let mut block = payload.as_bytes().to_vec();
        let units = block.len().div_ceil(ICY_UNIT).max(1);
        block.resize(units * ICY_UNIT, 0);
        block
    }

    /// Builds an ICY body: 18 audio bytes across `METAINT`-sized runs, with an
    /// empty block, a one-unit block, another empty block and a two-unit block.
    fn interleaved_script() -> (Vec<u8>, Vec<u8>, Vec<Vec<u8>>) {
        let audio: Vec<u8> = (1u8..=18).collect();
        let first = meta_block("StreamTitle='A';");
        let second = meta_block("StreamTitle='A longer title';StreamUrl='http://x';");
        assert_eq!(first.len(), ICY_UNIT);
        assert_eq!(second.len(), 4 * ICY_UNIT);

        let mut wire = Vec::new();
        let mut runs = audio.chunks(METAINT);
        let mut push_run = |wire: &mut Vec<u8>| {
            if let Some(run) = runs.next() {
                wire.extend_from_slice(run);
            }
        };
        push_run(&mut wire);
        wire.push(0); // L == 0: unchanged, the common case
        push_run(&mut wire);
        wire.push((first.len() / ICY_UNIT) as u8);
        wire.extend_from_slice(&first);
        push_run(&mut wire);
        wire.push(0);
        push_run(&mut wire);
        wire.push((second.len() / ICY_UNIT) as u8);
        wire.extend_from_slice(&second);
        push_run(&mut wire); // trailing partial run, no length byte yet

        (wire, audio, vec![first, second])
    }

    fn deinterleave(wire: &[u8], chunk_size: usize) -> (Vec<u8>, Vec<Vec<u8>>) {
        let mut deinterleaver = IcyDeinterleaver::new(METAINT);
        let mut audio = Vec::new();
        let mut blocks = Vec::new();
        for chunk in wire.chunks(chunk_size) {
            let mut got = Vec::new();
            deinterleaver.push(chunk, &mut got, &mut blocks);
            audio.extend_from_slice(&got);
        }
        (audio, blocks)
    }

    #[test]
    fn deinterleaver_strips_metadata_at_every_chunk_boundary() {
        let (wire, want_audio, want_blocks) = interleaved_script();
        // Every size from one byte at a time up to the whole body in one go, so
        // chunks land mid-metadata, mid-audio and across several blocks at once.
        for chunk_size in 1..=wire.len() {
            let (audio, blocks) = deinterleave(&wire, chunk_size);
            assert_eq!(audio, want_audio, "audio corrupted at chunk size {chunk_size}");
            assert_eq!(blocks, want_blocks, "blocks wrong at chunk size {chunk_size}");
        }
    }

    #[test]
    fn deinterleaver_handles_one_chunk_with_several_blocks() {
        let (wire, want_audio, want_blocks) = interleaved_script();
        let (audio, blocks) = deinterleave(&wire, wire.len());
        assert_eq!(audio, want_audio);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks, want_blocks);
    }

    #[test]
    fn deinterleaver_emits_nothing_for_a_lone_metadata_chunk() {
        let mut deinterleaver = IcyDeinterleaver::new(METAINT);
        let mut audio = Vec::new();
        let mut blocks = Vec::new();
        // The whole first audio run, then a length byte and a partial block.
        deinterleaver.push(&[1, 2, 3, 4, 1], &mut audio, &mut blocks);
        assert_eq!(audio, vec![1, 2, 3, 4]);
        assert!(blocks.is_empty());

        audio.clear();
        deinterleaver.push(&meta_block("StreamTitle='x';")[..8], &mut audio, &mut blocks);
        assert!(audio.is_empty());
        assert!(blocks.is_empty());

        deinterleaver.push(&meta_block("StreamTitle='x';")[8..], &mut audio, &mut blocks);
        assert_eq!(blocks.len(), 1);
        assert_eq!(parse_stream_title(&blocks[0]).as_deref(), Some("x"));
    }

    #[test]
    fn deinterleaver_treats_zero_length_as_unchanged() {
        let mut deinterleaver = IcyDeinterleaver::new(2);
        let mut audio = Vec::new();
        let mut blocks = Vec::new();
        deinterleaver.push(&[9, 9, 0, 8, 8, 0, 7, 7, 0], &mut audio, &mut blocks);
        assert_eq!(audio, vec![9, 9, 8, 8, 7, 7]);
        assert!(blocks.is_empty());
    }

    #[test]
    fn parses_a_plain_stream_title() {
        let block = meta_block("StreamTitle='Artist - Title';StreamUrl='http://h.test/';");
        assert_eq!(parse_stream_title(&block).as_deref(), Some("Artist - Title"));
    }

    #[test]
    fn stream_title_may_contain_separators_and_dashes() {
        let block = meta_block("StreamTitle='AC/DC - Hells; Bells - Live';StreamUrl='';");
        assert_eq!(parse_stream_title(&block).as_deref(), Some("AC/DC - Hells; Bells - Live"));
    }

    #[test]
    fn an_empty_or_absent_stream_title_is_ignored() {
        assert_eq!(parse_stream_title(&meta_block("StreamTitle='';")), None);
        assert_eq!(parse_stream_title(&meta_block("StreamTitle='   ';")), None);
        assert_eq!(parse_stream_title(&meta_block("StreamUrl='http://h.test/';")), None);
        assert_eq!(parse_stream_title(&[]), None);
    }

    #[test]
    fn nul_padding_is_trimmed() {
        let mut block = b"StreamTitle='Padded';".to_vec();
        block.resize(64, 0);
        assert_eq!(parse_stream_title(&block).as_deref(), Some("Padded"));
        // A value whose separator was dropped still ends at the closing quote.
        let mut bare = b"StreamTitle='Bare'".to_vec();
        bare.resize(32, 0);
        assert_eq!(parse_stream_title(&bare).as_deref(), Some("Bare"));
    }

    #[test]
    fn malformed_metadata_yields_none() {
        assert_eq!(parse_stream_title(b"StreamTitle=no quotes here"), None);
        assert_eq!(parse_stream_title(b"StreamTitle='never closed"), None);
        assert_eq!(parse_stream_title(b"\x00\x00\x00\x00"), None);
        // Invalid UTF-8 falls back to latin-1 instead of panicking.
        assert_eq!(parse_stream_title(b"\xff\xfe\x01rubbish"), None);
        let latin1 = b"StreamTitle='Bj\xf6rk - J\xf3ga';";
        assert_eq!(parse_stream_title(latin1).as_deref(), Some("Björk - Jóga"));
    }

    #[test]
    fn take_if_changed_fires_once_per_new_title() {
        let icy = IcyMetadata::new();
        assert_eq!(icy.take_if_changed(), None);
        assert_eq!(icy.latest(), None);

        assert!(icy.publish("One".to_string()));
        assert_eq!(icy.take_if_changed().as_deref(), Some("One"));
        assert_eq!(icy.take_if_changed(), None);
        assert_eq!(icy.latest().as_deref(), Some("One"));

        // A repeat of the current title must not re-arm the flag.
        assert!(!icy.publish("One".to_string()));
        assert_eq!(icy.take_if_changed(), None);

        assert!(icy.publish("Two".to_string()));
        assert_eq!(icy.take_if_changed().as_deref(), Some("Two"));
        assert_eq!(icy.take_if_changed(), None);
    }

    #[test]
    fn metaint_header_must_be_a_positive_number() {
        let mut headers = HeaderMap::new();
        headers.insert(ICY_METAINT, "16000".parse().expect("header"));
        assert_eq!(parse_metaint(&headers), Some(16_000));

        let mut zero = HeaderMap::new();
        zero.insert(ICY_METAINT, "0".parse().expect("header"));
        assert_eq!(parse_metaint(&zero), None);

        let mut junk = HeaderMap::new();
        junk.insert(ICY_METAINT, "not-a-number".parse().expect("header"));
        assert_eq!(parse_metaint(&junk), None);

        assert_eq!(parse_metaint(&HeaderMap::new()), None);
    }
}
