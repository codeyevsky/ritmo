//! Filesystem watching for incremental library updates.
//!
//! Editors and taggers save by writing a temp file and renaming it over the
//! original, so a single logical edit arrives as a burst of create/modify/
//! remove events. Everything is therefore collected into a set and only acted
//! on once the burst has been quiet for a second.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::library::scanner::{canonical_path, descend, Scanner};
use crate::library::tags;
use crate::state::events;

const DEBOUNCE: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(200);
/// Ceiling on how long a continuously-written folder can defer its batch.
const MAX_BATCH_AGE: Duration = Duration::from_secs(15);

pub(crate) struct Watcher {
    inner: Option<RecommendedWatcher>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Watcher {
    pub(crate) fn start(scanner: &Arc<Scanner>, folders: &[String]) -> AppResult<Self> {
        let (tx, rx) = channel::<notify::Result<Event>>();
        let mut inner =
            notify::recommended_watcher(tx).map_err(|e| AppError::Other(format!("fs watch: {e}")))?;

        let mut roots: Vec<PathBuf> = Vec::with_capacity(folders.len());
        for folder in folders {
            let root = canonical_path(Path::new(folder));
            if !root.is_dir() {
                tracing::warn!(folder = %root.display(), "not watching: not a directory");
                continue;
            }
            match inner.watch(&root, RecursiveMode::Recursive) {
                Ok(()) => roots.push(root),
                Err(e) => tracing::warn!(folder = %root.display(), error = %e, "watch failed"),
            }
        }
        if roots.is_empty() {
            return Err(AppError::BadRequest(
                "none of the given folders can be watched".into(),
            ));
        }

        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let stop = stop.clone();
            let scanner = Arc::downgrade(scanner);
            std::thread::Builder::new()
                .name("ritmo-fs-watch".into())
                .spawn(move || debounce_loop(rx, scanner, roots, stop))
                .map_err(AppError::Io)?
        };

        Ok(Self { inner: Some(inner), stop, worker: Some(worker) })
    }

    pub(crate) fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Dropping the watcher closes the event channel, which is what actually
        // unblocks the worker if it is parked in `recv_timeout`.
        self.inner.take();
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                tracing::error!("fs watch worker panicked");
            }
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn debounce_loop(
    rx: Receiver<notify::Result<Event>>,
    scanner: Weak<Scanner>,
    roots: Vec<PathBuf>,
    stop: Arc<AtomicBool>,
) {
    let mut touched: BTreeSet<PathBuf> = BTreeSet::new();
    let mut vanished: BTreeSet<PathBuf> = BTreeSet::new();
    let mut opened: Option<Instant> = None;
    let mut latest = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        match rx.recv_timeout(POLL) {
            Ok(Ok(event)) => {
                classify(&event, &roots, &mut touched, &mut vanished);
                latest = Instant::now();
                opened.get_or_insert(latest);
            }
            Ok(Err(e)) => tracing::warn!(error = %e, "filesystem watch error"),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if touched.is_empty() && vanished.is_empty() {
            opened = None;
            continue;
        }
        let settled = latest.elapsed() >= DEBOUNCE;
        let overdue = opened.is_some_and(|since| since.elapsed() >= MAX_BATCH_AGE);
        if !settled && !overdue {
            continue;
        }

        let Some(scanner) = scanner.upgrade() else {
            return;
        };
        opened = None;
        flush(
            &scanner,
            std::mem::take(&mut touched),
            std::mem::take(&mut vanished),
            &roots,
            &stop,
        );
    }
}

fn classify(
    event: &Event,
    roots: &[PathBuf],
    touched: &mut BTreeSet<PathBuf>,
    vanished: &mut BTreeSet<PathBuf>,
) {
    match event.kind {
        EventKind::Create(_) => collect(&event.paths, roots, touched),
        EventKind::Remove(_) => collect(&event.paths, roots, vanished),
        // A `Both` rename carries (from, to) in that exact order.
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            if let Some(from) = event.paths.first() {
                collect(std::slice::from_ref(from), roots, vanished);
            }
            if let Some(to) = event.paths.get(1) {
                collect(std::slice::from_ref(to), roots, touched);
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            collect(&event.paths, roots, vanished)
        }
        EventKind::Modify(ModifyKind::Name(_))
        | EventKind::Modify(ModifyKind::Data(_))
        | EventKind::Modify(ModifyKind::Any) => collect(&event.paths, roots, touched),
        // Imprecise backends report everything as `Any`. Queueing the path as
        // both is safe: `flush` decides which it was by looking at the disk.
        EventKind::Any | EventKind::Other => {
            collect(&event.paths, roots, touched);
            collect(&event.paths, roots, vanished);
        }
        _ => {}
    }
}

fn collect(paths: &[PathBuf], roots: &[PathBuf], into: &mut BTreeSet<PathBuf>) {
    for path in paths {
        if !inside_roots(path, roots) {
            continue;
        }
        into.insert(canonical_path(path));
    }
}

/// Events for paths outside the watched roots, or below a dot-directory, are
/// dropped. The roots themselves may well live under a dot-directory, so the
/// check only looks at the part below the root.
fn inside_roots(path: &Path, roots: &[PathBuf]) -> bool {
    let Some(root) = roots.iter().find(|root| path.starts_with(root)) else {
        return false;
    };
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    !relative
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// `stop` is honoured mid-batch: tearing the watcher down joins this thread,
/// and a folder that just had ten thousand files moved into it must not hold
/// the caller hostage.
fn flush(
    scanner: &Scanner,
    touched: BTreeSet<PathBuf>,
    vanished: BTreeSet<PathBuf>,
    roots: &[PathBuf],
    stop: &AtomicBool,
) {
    let mut added: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();

    for path in vanished {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        // A path that reappeared within the debounce window was a temp-file
        // dance, not a deletion.
        if path.exists() {
            continue;
        }
        match scanner.forget_path(&path) {
            Ok(uris) => removed.extend(uris),
            Err(e) => tracing::warn!(path = %path.display(), error = %e, "forget failed"),
        }
    }

    for path in touched {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        if nomedia_blocked(&path, roots) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            // A whole folder moved in: the kernel reports the directory, not
            // the files that came with it.
            let walker = WalkDir::new(&path)
                .follow_links(false)
                .into_iter()
                .filter_entry(descend);
            for entry in walker.flatten() {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if entry.file_type().is_file() && tags::is_audio_file(entry.path()) {
                    refresh(scanner, entry.path(), &mut added);
                }
            }
        } else if meta.is_file() && tags::is_audio_file(&path) {
            refresh(scanner, &path, &mut added);
        }
    }

    if added.is_empty() && removed.is_empty() {
        return;
    }
    tracing::debug!(added = added.len(), removed = removed.len(), "library changed");
    (scanner.emitter())(
        events::LIBRARY_CHANGED,
        json!({ "added": added, "removed": removed }),
    );
}

fn refresh(scanner: &Scanner, path: &Path, added: &mut Vec<String>) {
    let Some(text) = path.to_str() else {
        return;
    };
    match scanner.refresh_file(text) {
        Ok(Some(track)) => {
            if let Some(uri) = track.get("uri").and_then(Value::as_str) {
                added.push(uri.to_owned());
            }
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(path = text, error = %e, "refresh failed"),
    }
}

fn nomedia_blocked(path: &Path, roots: &[PathBuf]) -> bool {
    let Some(root) = roots.iter().find(|root| path.starts_with(root)) else {
        return true;
    };
    let mut dir = path.parent();
    while let Some(current) = dir {
        if current.join(".nomedia").exists() {
            return true;
        }
        if current == root.as_path() {
            break;
        }
        dir = current.parent();
    }
    false
}
