//! Local library scanner.
//!
//! One pass over the configured folders: walk, diff against what the database
//! already knows, read tags for the files that actually changed, cache album
//! art, then upsert artists → albums → tracks in foreign-key order.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use walkdir::{DirEntry, WalkDir};

use crate::audio::EmitFn;
use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::library::artwork::{self, ArtSource};
use crate::library::tags::{self, FileTags};
use crate::library::watcher::Watcher;
use crate::state::{events, Paths};

/// Statements per transaction. Big enough that the WAL fsync cost disappears,
/// small enough that a cancelled scan loses almost nothing.
const BATCH: usize = 500;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

const PHASE_WALKING: &str = "walking";
const PHASE_READING: &str = "reading";
const PHASE_ARTWORK: &str = "artwork";
const PHASE_DONE: &str = "done";

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub errors: Vec<ScanError>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

pub struct Scanner {
    db: Arc<Database>,
    paths: Paths,
    emit: EmitFn,
    scanning: AtomicBool,
    cancelled: AtomicBool,
    watcher: Mutex<Option<Watcher>>,
    /// The watcher thread needs an owned handle back to us; holding it weakly
    /// keeps `Scanner` droppable even if nobody ever calls `set_watching(false)`.
    me: Weak<Scanner>,
}

impl Scanner {
    pub fn new(db: Arc<Database>, paths: Paths, emit: EmitFn) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            db,
            paths,
            emit,
            scanning: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            watcher: Mutex::new(None),
            me: me.clone(),
        })
    }

    pub fn is_scanning(&self) -> bool {
        self.scanning.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        if self.is_scanning() {
            tracing::info!("library scan cancellation requested");
            self.cancelled.store(true, Ordering::SeqCst);
        }
    }

    pub fn scan(&self, folders: Vec<String>) -> AppResult<ScanResult> {
        if self
            .scanning
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(AppError::BadRequest(
                "a library scan is already running".into(),
            ));
        }
        let _running = ScanGuard(&self.scanning);
        self.cancelled.store(false, Ordering::SeqCst);

        let progress = Progress::new(&self.emit);
        let started = Instant::now();
        let outcome = self.run(&folders, &progress);
        progress.send(PHASE_DONE, None);

        match outcome {
            Ok(mut result) => {
                result.duration_ms = started.elapsed().as_millis() as u64;
                tracing::info!(
                    added = result.added,
                    updated = result.updated,
                    removed = result.removed,
                    errors = result.errors.len(),
                    ms = result.duration_ms,
                    "library scan finished"
                );
                Ok(result)
            }
            Err(e) => {
                tracing::error!(error = %e, "library scan failed");
                Err(e)
            }
        }
    }

    pub fn set_watching(&self, enabled: bool, folders: Vec<String>) -> AppResult<()> {
        let mut slot = self.watcher.lock();
        if let Some(existing) = slot.take() {
            existing.stop();
        }
        if !enabled || folders.is_empty() {
            return Ok(());
        }
        let me = self
            .me
            .upgrade()
            .ok_or_else(|| AppError::Other("scanner is shutting down".into()))?;
        *slot = Some(Watcher::start(&me, &folders)?);
        Ok(())
    }

    pub fn refresh_file(&self, path: &str) -> AppResult<Option<Value>> {
        let path = canonical_path(Path::new(path));
        if !tags::is_audio_file(&path) {
            return Ok(None);
        }
        let Some(path_str) = path.to_str().map(str::to_owned) else {
            return Ok(None);
        };
        let meta = match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => m,
            _ => return Ok(None),
        };
        let (mtime, size) = stamp(&meta);

        let found = Found { path, path_str, mtime, size };
        let row = build_row(&found, tags::read(&found.path)?);
        let existing = self.stamps_for(&[found.path_str.clone()])?;

        let (artists, albums) = aggregate(std::slice::from_ref(&row));
        let art = self.resolve_artwork(&albums, None);
        self.write_rows(std::slice::from_ref(&row), &artists, &albums, &art, &existing)?;

        let album = row.album.as_ref().and_then(|a| albums.get(&a.uri));
        Ok(Some(track_value(
            &row,
            album,
            row.album.as_ref().and_then(|a| art.get(&a.uri)),
        )))
    }

    fn run(&self, folders: &[String], progress: &Progress) -> AppResult<ScanResult> {
        let mut result = ScanResult::default();

        let roots: Vec<PathBuf> = folders
            .iter()
            .map(|f| canonical_path(Path::new(f)))
            .collect();

        let mut found: Vec<Found> = Vec::new();
        let mut counts: Vec<u64> = Vec::with_capacity(roots.len());
        for root in &roots {
            let before = found.len();
            if !root.is_dir() {
                result.errors.push(ScanError {
                    path: root.to_string_lossy().into_owned(),
                    message: "not a directory".into(),
                });
                counts.push(0);
                continue;
            }
            self.walk(root, &mut found, &mut result.errors, progress);
            counts.push((found.len() - before) as u64);
            if self.is_cancelled() {
                break;
            }
        }
        while counts.len() < roots.len() {
            counts.push(0);
        }
        progress.send(PHASE_WALKING, None);

        let on_disk: HashSet<&str> = found.iter().map(|f| f.path_str.as_str()).collect();
        let existing = self.local_stamps()?;

        let stale: Vec<&Found> = found
            .iter()
            .filter(|f| match existing.get(&f.path_str) {
                Some(seen) => seen.mtime != f.mtime || seen.size != f.size,
                None => true,
            })
            .collect();
        tracing::info!(
            files = found.len(),
            changed = stale.len(),
            "library scan walked {} folder(s)",
            roots.len()
        );

        // Tag reading is the expensive half: one mutex-free task per file, and
        // the database is not touched until every row is in memory.
        let read: Vec<Read> = stale
            .par_iter()
            .map(|f| {
                if self.is_cancelled() {
                    return Read::Skipped;
                }
                progress.tick(PHASE_READING, Some(&f.path_str));
                match tags::read(&f.path) {
                    Ok(t) => {
                        progress.imported.fetch_add(1, Ordering::Relaxed);
                        Read::Row(Box::new(build_row(f, t)))
                    }
                    Err(e) => Read::Failed(ScanError {
                        path: f.path_str.clone(),
                        message: e.to_string(),
                    }),
                }
            })
            .collect();

        let mut rows: Vec<TrackRow> = Vec::with_capacity(read.len());
        for item in read {
            match item {
                Read::Row(row) => rows.push(*row),
                Read::Failed(e) => result.errors.push(e),
                Read::Skipped => {}
            }
        }

        let (artists, albums) = aggregate(&rows);
        progress.send(PHASE_ARTWORK, None);
        let art = self.resolve_artwork(&albums, Some(progress));

        let (added, updated) = self.write_rows(&rows, &artists, &albums, &art, &existing)?;
        result.added = added;
        result.updated = updated;

        if self.is_cancelled() {
            tracing::warn!(
                added,
                updated,
                "library scan cancelled; committed what had been read"
            );
            return Ok(result);
        }

        result.removed = self.prune(&roots, &on_disk, &existing)?;
        // Also catches albums left empty by a re-tag rather than a deletion.
        self.prune_orphans()?;

        let now = now_ms();
        let state: Vec<(String, Vec<Value>)> = roots
            .iter()
            .zip(counts.iter())
            .map(|(root, count)| {
                (
                    SQL_SCAN_STATE.to_owned(),
                    vec![
                        json!(root.to_string_lossy().into_owned()),
                        json!(now),
                        json!(count),
                    ],
                )
            })
            .collect();
        self.commit(state)?;

        Ok(result)
    }

    fn walk(
        &self,
        root: &Path,
        out: &mut Vec<Found>,
        errors: &mut Vec<ScanError>,
        progress: &Progress,
    ) {
        let walker = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(descend);
        for entry in walker {
            if self.is_cancelled() {
                return;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    errors.push(ScanError {
                        path: e
                            .path()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        message: e.to_string(),
                    });
                    continue;
                }
            };
            if !entry.file_type().is_file() || !tags::is_audio_file(entry.path()) {
                continue;
            }
            let Some(path_str) = entry.path().to_str().map(str::to_owned) else {
                errors.push(ScanError {
                    path: entry.path().to_string_lossy().into_owned(),
                    message: "path is not valid UTF-8".into(),
                });
                continue;
            };
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(e) => {
                    errors.push(ScanError { path: path_str, message: e.to_string() });
                    continue;
                }
            };
            let (mtime, size) = stamp(&meta);
            progress.seen.fetch_add(1, Ordering::Relaxed);
            progress.tick(PHASE_WALKING, Some(&path_str));
            out.push(Found { path: entry.into_path(), path_str, mtime, size });
        }
    }

    fn resolve_artwork(
        &self,
        albums: &BTreeMap<String, AlbumAgg>,
        progress: Option<&Progress>,
    ) -> HashMap<String, Value> {
        albums
            .par_iter()
            .filter_map(|(uri, album)| {
                if self.is_cancelled() {
                    return None;
                }
                if let Some(p) = progress {
                    p.tick(PHASE_ARTWORK, Some(&album.name));
                }
                let art = match album.art.as_ref()? {
                    ArtPick::Embedded(file) => {
                        let bytes = tags::read_picture(file)?;
                        let source = ArtSource::Embedded(&bytes);
                        artwork::cache_for_album(&self.paths, &album.hash, source)
                    }
                    ArtPick::Folder(file) => {
                        artwork::cache_for_album(&self.paths, &album.hash, ArtSource::File(file))
                    }
                };
                match art {
                    Ok(art) => art.map(|a| (uri.clone(), a)),
                    Err(e) => {
                        tracing::warn!(album = %album.name, error = %e, "artwork cache failed");
                        None
                    }
                }
            })
            .collect()
    }

    fn write_rows(
        &self,
        rows: &[TrackRow],
        artists: &BTreeMap<String, ArtistRef>,
        albums: &BTreeMap<String, AlbumAgg>,
        art: &HashMap<String, Value>,
        existing: &HashMap<String, Stamp>,
    ) -> AppResult<(u32, u32)> {
        if rows.is_empty() {
            return Ok((0, 0));
        }
        let now = now_ms();

        let statements: Vec<(String, Vec<Value>)> = artists
            .values()
            .map(|a| {
                (
                    SQL_ARTIST.to_owned(),
                    vec![
                        json!(a.uri),
                        json!(a.name),
                        json!(tags::normalize_key(&a.name)),
                        json!(now),
                    ],
                )
            })
            .collect();
        self.commit(statements)?;

        let statements: Vec<(String, Vec<Value>)> = albums
            .values()
            .map(|album| {
                (
                    SQL_ALBUM.to_owned(),
                    vec![
                        json!(album.uri),
                        json!(album.name),
                        json!(tags::normalize_key(&album.name)),
                        refs_json(&album.artists),
                        json!(album.artists.first().map(|a| a.name.clone())),
                        art.get(&album.uri).cloned().unwrap_or(Value::Null),
                        json!(album.date),
                        Value::Null,
                        json!(album.tracks_seen),
                        strings_json(&album.genres),
                        json!(now),
                    ],
                )
            })
            .collect();
        self.commit(statements)?;

        let mut added = 0u32;
        let mut updated = 0u32;
        let mut statements: Vec<(String, Vec<Value>)> = Vec::with_capacity(rows.len());
        for row in rows {
            if existing.contains_key(&row.path) {
                updated += 1;
            } else {
                added += 1;
            }
            let album = row.album.as_ref().and_then(|a| albums.get(&a.uri));
            let album_art = row.album.as_ref().and_then(|a| art.get(&a.uri));
            statements.push((
                SQL_TRACK.to_owned(),
                vec![
                    json!(row.uri),
                    json!(row.title),
                    json!(tags::normalize_key(&row.title)),
                    refs_json(&row.artists),
                    json!(row.artists.first().map(|a| a.name.clone())),
                    json!(row.album.as_ref().map(|a| a.uri.clone())),
                    album
                        .map(|a| album_ref_value(a, album_art))
                        .unwrap_or(Value::Null),
                    json!(row.duration_ms),
                    json!(row.track_number),
                    json!(row.disc_number),
                    json!(row.date),
                    strings_json(&row.genres),
                    album_art.cloned().unwrap_or(Value::Null),
                    json!(row.gain_db),
                    json!(row.path),
                    row.meta.clone(),
                    json!(now),
                    json!(now),
                    json!(row.mtime),
                    json!(row.size),
                ],
            ));
        }
        self.commit(statements)?;

        let totals: Vec<(String, Vec<Value>)> = albums
            .keys()
            .map(|uri| (SQL_ALBUM_TOTALS.to_owned(), vec![json!(uri), json!(uri)]))
            .collect();
        self.commit(totals)?;

        Ok((added, updated))
    }

    fn prune(
        &self,
        roots: &[PathBuf],
        on_disk: &HashSet<&str>,
        existing: &HashMap<String, Stamp>,
    ) -> AppResult<u32> {
        let mut gone: Vec<&String> = Vec::new();
        for path in existing.keys() {
            if on_disk.contains(path.as_str()) {
                continue;
            }
            let p = Path::new(path);
            if !roots.iter().any(|root| p.starts_with(root)) {
                continue;
            }
            // Only absence counts as removal: an unreadable mount must never
            // be allowed to empty the library.
            if p.exists() {
                continue;
            }
            gone.push(path);
        }
        if gone.is_empty() {
            return Ok(0);
        }

        let statements: Vec<(String, Vec<Value>)> = gone
            .iter()
            .map(|path| (SQL_DELETE_TRACK_BY_PATH.to_owned(), vec![json!(path)]))
            .collect();
        self.commit(statements)?;
        tracing::info!(removed = gone.len(), "pruned vanished local tracks");
        Ok(gone.len() as u32)
    }

    /// Drops albums and artists that no track references any more.
    pub(crate) fn prune_orphans(&self) -> AppResult<()> {
        self.db.execute_json(SQL_PRUNE_ALBUMS, &[])?;
        self.db.execute_json(SQL_PRUNE_ARTISTS, &[])?;
        Ok(())
    }

    /// Forgets `path` and, if it was a directory, everything beneath it.
    /// Returns the uris that disappeared.
    pub(crate) fn forget_path(&self, path: &Path) -> AppResult<Vec<String>> {
        let Some(path_str) = path.to_str() else {
            return Ok(Vec::new());
        };
        let prefix = format!("{path_str}{}", std::path::MAIN_SEPARATOR);
        let rows = self.db.query_json(
            SQL_SELECT_TRACKS_UNDER,
            &[
                json!(path_str),
                json!(prefix.chars().count() as i64),
                json!(prefix),
            ],
        )?;
        let uris: Vec<String> = rows
            .iter()
            .filter_map(|r| r.get("uri").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        if uris.is_empty() {
            return Ok(uris);
        }
        let statements: Vec<(String, Vec<Value>)> = uris
            .iter()
            .map(|uri| (SQL_DELETE_TRACK.to_owned(), vec![json!(uri)]))
            .collect();
        self.commit(statements)?;
        self.prune_orphans()?;
        Ok(uris)
    }

    pub(crate) fn emitter(&self) -> &EmitFn {
        &self.emit
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn commit(&self, statements: Vec<(String, Vec<Value>)>) -> AppResult<()> {
        for chunk in statements.chunks(BATCH) {
            self.db.transaction_json(chunk)?;
        }
        Ok(())
    }

    fn local_stamps(&self) -> AppResult<HashMap<String, Stamp>> {
        let rows = self.db.query_json(SQL_SELECT_LOCAL_STAMPS, &[])?;
        Ok(stamp_map(rows))
    }

    fn stamps_for(&self, paths: &[String]) -> AppResult<HashMap<String, Stamp>> {
        let mut out = HashMap::new();
        for path in paths {
            let rows = self
                .db
                .query_json(SQL_SELECT_STAMP_BY_PATH, &[json!(path)])?;
            out.extend(stamp_map(rows));
        }
        Ok(out)
    }
}

struct ScanGuard<'a>(&'a AtomicBool);

impl Drop for ScanGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct Progress<'a> {
    emit: &'a EmitFn,
    seen: AtomicU64,
    imported: AtomicU64,
    last: Mutex<Instant>,
}

impl<'a> Progress<'a> {
    fn new(emit: &'a EmitFn) -> Self {
        Self {
            emit,
            seen: AtomicU64::new(0),
            imported: AtomicU64::new(0),
            // Backdated so the first tick always gets through.
            last: Mutex::new(Instant::now() - PROGRESS_INTERVAL),
        }
    }

    fn tick(&self, phase: &str, current: Option<&str>) {
        // A worker that loses the race just skips its update; the counters are
        // atomic, so the next event carries its work anyway.
        let Some(mut last) = self.last.try_lock() else {
            return;
        };
        if last.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        *last = Instant::now();
        drop(last);
        self.send(phase, current);
    }

    fn send(&self, phase: &str, current: Option<&str>) {
        let mut payload = Map::new();
        payload.insert("phase".into(), json!(phase));
        payload.insert("filesSeen".into(), json!(self.seen.load(Ordering::Relaxed)));
        payload.insert(
            "filesImported".into(),
            json!(self.imported.load(Ordering::Relaxed)),
        );
        if let Some(path) = current {
            payload.insert("currentPath".into(), json!(path));
        }
        (self.emit)(events::SCAN, Value::Object(payload));
    }
}

struct Found {
    path: PathBuf,
    path_str: String,
    mtime: i64,
    size: i64,
}

struct Stamp {
    mtime: i64,
    size: i64,
}

enum Read {
    Row(Box<TrackRow>),
    Failed(ScanError),
    Skipped,
}

#[derive(Clone)]
struct ArtistRef {
    uri: String,
    name: String,
}

struct AlbumKey {
    uri: String,
    name: String,
    artist: ArtistRef,
}

struct AlbumAgg {
    uri: String,
    hash: String,
    name: String,
    artists: Vec<ArtistRef>,
    date: Option<String>,
    genres: Vec<String>,
    tracks_seen: u32,
    art: Option<ArtPick>,
}

enum ArtPick {
    /// Path of a track whose tags carry a picture.
    Embedded(PathBuf),
    Folder(PathBuf),
}

struct TrackRow {
    uri: String,
    path: String,
    title: String,
    artists: Vec<ArtistRef>,
    album: Option<AlbumKey>,
    duration_ms: u64,
    track_number: Option<u32>,
    disc_number: Option<u32>,
    date: Option<String>,
    genres: Vec<String>,
    gain_db: Option<f32>,
    meta: Value,
    mtime: i64,
    size: i64,
    has_embedded_art: bool,
}

fn build_row(found: &Found, tags: FileTags) -> TrackRow {
    let artists: Vec<ArtistRef> = if tags.artists.is_empty() {
        vec![artist_ref("Unknown Artist")]
    } else {
        tags.artists.iter().map(|n| artist_ref(n)).collect()
    };

    let album = tags.album.as_ref().and_then(|name| {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        let artist_name = tags
            .album_artist
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| artists.first().map(|a| a.name.clone()))
            .unwrap_or_else(|| "Unknown Artist".to_owned());
        Some(AlbumKey {
            uri: format!("local:album:{}", album_hash(&artist_name, name)),
            name: name.to_owned(),
            artist: artist_ref(&artist_name),
        })
    });

    let mut meta = Map::new();
    if let Some(v) = tags.bitrate {
        meta.insert("bitrate".into(), json!(v));
    }
    if let Some(v) = tags.sample_rate {
        meta.insert("sampleRate".into(), json!(v));
    }
    if let Some(v) = tags.channels {
        meta.insert("channels".into(), json!(v));
    }

    TrackRow {
        uri: track_uri(&found.path_str),
        path: found.path_str.clone(),
        title: tags.title,
        artists,
        album,
        duration_ms: tags.duration_ms,
        track_number: tags.track_number,
        disc_number: tags.disc_number,
        date: tags.date,
        genres: tags.genres,
        gain_db: tags.gain_db,
        meta: Value::Object(meta),
        mtime: found.mtime,
        size: found.size,
        has_embedded_art: tags.has_embedded_art,
    }
}

fn aggregate(rows: &[TrackRow]) -> (BTreeMap<String, ArtistRef>, BTreeMap<String, AlbumAgg>) {
    let mut artists: BTreeMap<String, ArtistRef> = BTreeMap::new();
    let mut albums: BTreeMap<String, AlbumAgg> = BTreeMap::new();

    for row in rows {
        for artist in &row.artists {
            artists
                .entry(artist.uri.clone())
                .or_insert_with(|| artist.clone());
        }
        let Some(key) = row.album.as_ref() else {
            continue;
        };
        artists
            .entry(key.artist.uri.clone())
            .or_insert_with(|| key.artist.clone());

        let agg = albums.entry(key.uri.clone()).or_insert_with(|| AlbumAgg {
            uri: key.uri.clone(),
            hash: key.uri.rsplit(':').next().unwrap_or_default().to_owned(),
            name: key.name.clone(),
            artists: vec![key.artist.clone()],
            date: None,
            genres: Vec::new(),
            tracks_seen: 0,
            art: None,
        });
        agg.tracks_seen += 1;
        if agg.date.is_none() {
            agg.date = row.date.clone();
        }
        for genre in &row.genres {
            if !agg.genres.iter().any(|g| g == genre) {
                agg.genres.push(genre.clone());
            }
        }
        // Embedded art wins; a cover file next to the track is the fallback.
        if row.has_embedded_art {
            if !matches!(agg.art, Some(ArtPick::Embedded(_))) {
                agg.art = Some(ArtPick::Embedded(PathBuf::from(&row.path)));
            }
        } else if agg.art.is_none() {
            if let Some(dir) = Path::new(&row.path).parent() {
                if let Some(file) = artwork::find_folder_art(dir) {
                    agg.art = Some(ArtPick::Folder(file));
                }
            }
        }
    }

    (artists, albums)
}

fn artist_ref(name: &str) -> ArtistRef {
    ArtistRef {
        uri: format!("local:artist:{}", hash16(&name.to_lowercase())),
        name: name.to_owned(),
    }
}

/// `local:track:<hex16 of sha256(canonical absolute path)>`
pub(crate) fn track_uri(path: &str) -> String {
    format!("local:track:{}", hash16(path))
}

fn album_hash(album_artist: &str, album: &str) -> String {
    hash16(&format!(
        "{}\u{0}{}",
        album_artist.to_lowercase(),
        album.to_lowercase()
    ))
}

fn hash16(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    hex::encode(&digest[..16])
}

fn refs_json(refs: &[ArtistRef]) -> Value {
    Value::Array(
        refs.iter()
            .map(|a| json!({ "uri": a.uri, "name": a.name }))
            .collect(),
    )
}

fn strings_json(values: &[String]) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    Value::Array(values.iter().map(|v| json!(v)).collect())
}

fn album_ref_value(album: &AlbumAgg, art: Option<&Value>) -> Value {
    let mut out = Map::new();
    out.insert("uri".into(), json!(album.uri));
    out.insert("name".into(), json!(album.name));
    if let Some(art) = art {
        out.insert("artwork".into(), art.clone());
    }
    Value::Object(out)
}

/// The `Track` shape from `packages/core/src/types.ts`.
fn track_value(row: &TrackRow, album: Option<&AlbumAgg>, art: Option<&Value>) -> Value {
    let mut out = Map::new();
    out.insert("uri".into(), json!(row.uri));
    out.insert("provider".into(), json!("local"));
    out.insert("title".into(), json!(row.title));
    out.insert("artists".into(), refs_json(&row.artists));
    if let Some(album) = album {
        out.insert("album".into(), album_ref_value(album, art));
    }
    out.insert("durationMs".into(), json!(row.duration_ms));
    if let Some(n) = row.track_number {
        out.insert("trackNumber".into(), json!(n));
    }
    if let Some(n) = row.disc_number {
        out.insert("discNumber".into(), json!(n));
    }
    if let Some(date) = &row.date {
        out.insert("releaseDate".into(), json!(date));
    }
    if !row.genres.is_empty() {
        out.insert("genres".into(), strings_json(&row.genres));
    }
    if let Some(art) = art {
        out.insert("artwork".into(), art.clone());
    }
    out.insert("explicit".into(), json!(false));
    out.insert("isLive".into(), json!(false));
    if let Some(gain) = row.gain_db {
        out.insert("gainDb".into(), json!(gain));
    }
    out.insert("path".into(), json!(row.path));
    out.insert("meta".into(), row.meta.clone());
    Value::Object(out)
}

fn stamp_map(rows: Vec<Map<String, Value>>) -> HashMap<String, Stamp> {
    let mut out = HashMap::with_capacity(rows.len());
    for row in rows {
        let Some(path) = row.get("path").and_then(Value::as_str) else {
            continue;
        };
        out.insert(
            path.to_owned(),
            Stamp {
                mtime: row.get("file_mtime").and_then(Value::as_i64).unwrap_or(-1),
                size: row.get("file_size").and_then(Value::as_i64).unwrap_or(-1),
            },
        );
    }
    out
}

/// Dot-directories and anything sitting under a `.nomedia` marker are skipped
/// wholesale; files are always let through so the caller can filter by
/// extension.
pub(crate) fn descend(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if entry.file_name().to_string_lossy().starts_with('.') {
        return false;
    }
    if entry.file_type().is_dir() && entry.path().join(".nomedia").exists() {
        return false;
    }
    true
}

fn stamp(meta: &std::fs::Metadata) -> (i64, i64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (mtime, meta.len() as i64)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Absolute, symlink-free form. Track uris hash this string, so it has to be
/// stable no matter how the caller spelled the path; a path whose file is
/// already gone still resolves through its parent.
pub(crate) fn canonical_path(path: &Path) -> PathBuf {
    if let Ok(resolved) = std::fs::canonicalize(path) {
        return trim_verbatim(resolved);
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if !parent.as_os_str().is_empty() {
            if let Ok(resolved) = std::fs::canonicalize(parent) {
                return trim_verbatim(resolved).join(name);
            }
        }
    }
    if path.is_relative() {
        if let Ok(cwd) = std::env::current_dir() {
            return cwd.join(path);
        }
    }
    path.to_path_buf()
}

#[cfg(windows)]
fn trim_verbatim(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(trimmed) => PathBuf::from(trimmed),
        None => path,
    }
}

#[cfg(not(windows))]
fn trim_verbatim(path: PathBuf) -> PathBuf {
    path
}

const SQL_SELECT_LOCAL_STAMPS: &str = "SELECT path, file_mtime, file_size FROM tracks \
     WHERE provider = 'local' AND path IS NOT NULL";

const SQL_SELECT_STAMP_BY_PATH: &str = "SELECT path, file_mtime, file_size FROM tracks \
     WHERE provider = 'local' AND path = ?";

const SQL_SELECT_TRACKS_UNDER: &str = "SELECT uri FROM tracks \
     WHERE provider = 'local' AND path IS NOT NULL AND (path = ? OR substr(path, 1, ?) = ?)";

const SQL_DELETE_TRACK: &str = "DELETE FROM tracks WHERE uri = ?";

const SQL_DELETE_TRACK_BY_PATH: &str = "DELETE FROM tracks WHERE provider = 'local' AND path = ?";

const SQL_ARTIST: &str = "INSERT INTO artists (uri, provider, name, name_key, updated_at) \
     VALUES (?, 'local', ?, ?, ?) \
     ON CONFLICT(uri) DO UPDATE SET \
       name = excluded.name, name_key = excluded.name_key, updated_at = excluded.updated_at";

const SQL_ALBUM: &str = "INSERT INTO albums \
     (uri, provider, name, name_key, artists_json, primary_artist, artwork_json, release_date, \
      album_type, total_tracks, genres_json, updated_at) \
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
     ON CONFLICT(uri) DO UPDATE SET \
       name = excluded.name, \
       name_key = excluded.name_key, \
       artists_json = excluded.artists_json, \
       primary_artist = excluded.primary_artist, \
       artwork_json = COALESCE(excluded.artwork_json, albums.artwork_json), \
       release_date = COALESCE(excluded.release_date, albums.release_date), \
       total_tracks = excluded.total_tracks, \
       genres_json = COALESCE(excluded.genres_json, albums.genres_json), \
       updated_at = excluded.updated_at";

/// Recomputed from the table rather than from the scan so an incremental pass
/// that touched one file does not shrink the album to one track.
const SQL_ALBUM_TOTALS: &str = "UPDATE albums SET total_tracks = t.n, \
       album_type = CASE WHEN t.n = 1 THEN 'single' WHEN t.n <= 5 THEN 'ep' ELSE 'album' END \
     FROM (SELECT COUNT(*) AS n FROM tracks WHERE album_uri = ?) AS t \
     WHERE albums.uri = ?";

const SQL_TRACK: &str = "INSERT INTO tracks \
     (uri, provider, title, title_key, artists_json, primary_artist, album_uri, album_json, \
      duration_ms, track_number, disc_number, release_date, genres_json, artwork_json, \
      explicit, is_live, gain_db, path, meta_json, added_at, updated_at, file_mtime, file_size) \
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?) \
     ON CONFLICT(uri) DO UPDATE SET \
       title = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"title\"') > 0 \
                    THEN tracks.title ELSE excluded.title END, \
       title_key = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"title_key\"') > 0 \
                    THEN tracks.title_key ELSE excluded.title_key END, \
       artists_json = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"artists_json\"') > 0 \
                    THEN tracks.artists_json ELSE excluded.artists_json END, \
       primary_artist = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"primary_artist\"') > 0 \
                    THEN tracks.primary_artist ELSE excluded.primary_artist END, \
       album_uri = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"album_uri\"') > 0 \
                    THEN tracks.album_uri ELSE excluded.album_uri END, \
       album_json = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"album_json\"') > 0 \
                    THEN tracks.album_json ELSE excluded.album_json END, \
       release_date = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"release_date\"') > 0 \
                    THEN tracks.release_date ELSE excluded.release_date END, \
       genres_json = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"genres_json\"') > 0 \
                    THEN tracks.genres_json ELSE excluded.genres_json END, \
       artwork_json = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"artwork_json\"') > 0 \
                    THEN tracks.artwork_json ELSE excluded.artwork_json END, \
       track_number = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"track_number\"') > 0 \
                    THEN tracks.track_number ELSE excluded.track_number END, \
       disc_number = CASE WHEN instr(COALESCE(tracks.edited_json, ''), '\"disc_number\"') > 0 \
                    THEN tracks.disc_number ELSE excluded.disc_number END, \
       duration_ms = excluded.duration_ms, \
       gain_db = excluded.gain_db, \
       path = excluded.path, \
       meta_json = excluded.meta_json, \
       updated_at = excluded.updated_at, \
       file_mtime = excluded.file_mtime, \
       file_size = excluded.file_size";

const SQL_SCAN_STATE: &str = "INSERT INTO scan_state (folder, last_scan_at, file_count) \
     VALUES (?, ?, ?) \
     ON CONFLICT(folder) DO UPDATE SET \
       last_scan_at = excluded.last_scan_at, file_count = excluded.file_count";

const SQL_PRUNE_ALBUMS: &str = "DELETE FROM albums WHERE provider = 'local' \
     AND NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.album_uri = albums.uri)";

const SQL_PRUNE_ARTISTS: &str = "DELETE FROM artists WHERE provider = 'local' AND uri NOT IN ( \
       SELECT uri FROM ( \
         SELECT json_extract(j.value, '$.uri') AS uri \
           FROM tracks t, json_each(t.artists_json) j WHERE t.provider = 'local' \
         UNION \
         SELECT json_extract(j.value, '$.uri') AS uri \
           FROM albums a, json_each(a.artists_json) j WHERE a.provider = 'local' \
       ) WHERE uri IS NOT NULL \
     )";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_are_stable_and_namespaced() {
        assert_eq!(
            track_uri("/music/a.flac"),
            track_uri("/music/a.flac"),
        );
        assert!(track_uri("/music/a.flac").starts_with("local:track:"));
        assert_eq!(track_uri("/music/a.flac").len(), "local:track:".len() + 32);
        assert_eq!(album_hash("Portishead", "Dummy"), album_hash("portishead", "dummy"));
        assert_ne!(album_hash("Air", "Moon Safari"), album_hash("Moon Safari", "Air"));
    }
}
