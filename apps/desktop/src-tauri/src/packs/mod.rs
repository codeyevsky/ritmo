//! File IO for packs: export one `pack.json`, import one, publish a whole
//! Bazaar tree. Wire shapes are fixed by `docs/ipc.md`, the documents
//! themselves by `docs/packs.md`.
//!
//! Everything here writes to paths the WebView named, so the module's one job
//! besides serialising JSON is deciding what it is allowed to touch. "The user
//! picked it" has to be a fact Rust remembers, not a claim the frontend makes:
//! a picker records the directory it returned and every read or write is
//! confined to one of those recordings, the same way `net::commands` confines
//! to the library roots.

pub mod export;
pub mod github;
pub mod import;
pub mod publish;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;

use crate::error::{AppError, AppResult};

/// Matches `docs/packs.md`: 2 MiB per `pack.json`, and the index's 500-pack cap
/// also bounds how much one publish may write.
pub const MAX_PACK_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_PACKS: usize = 500;

/// Extensions a cover may have. Anything else is not copied — publishing must
/// not become a way to place an arbitrary file under an arbitrary name.
const COVER_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "avif", "gif"];

/// Directories the user pointed at through a pack picker, this session.
static GRANTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();

fn grants() -> &'static Mutex<Vec<PathBuf>> {
    GRANTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Records a directory the user chose in a dialog. Called only from the
/// pickers, with a path the OS dialog itself produced.
pub fn grant(dir: &Path) {
    let mut held = grants().lock();
    if !held.iter().any(|existing| existing == dir) {
        held.push(dir.to_path_buf());
    }
}

/// Grants the parent of a chosen *file*, so a save dialog also permits a
/// sibling name the user types next time.
pub fn grant_parent(file: &Path) {
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() {
            grant(parent);
        }
    }
}

/// An absolute path inside one of the granted directories, with `..` and
/// symlink escapes resolved away. Reuses the net module's confinement so there
/// is one implementation of this check in the process.
pub fn confined(raw: &str) -> AppResult<PathBuf> {
    let roots = grants().lock().clone();
    if roots.is_empty() {
        return Err(AppError::BadRequest(
            "no folder has been chosen for packs yet".to_string(),
        ));
    }
    crate::net::commands::confine(&roots, raw)
}

/// One path component that is safe as a filename: a pack id straight out of a
/// remote index may not turn into `../../etc/anything`.
pub fn safe_component(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed != "."
        && trimmed != ".."
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(trimmed.to_string())
    } else {
        Err(AppError::BadRequest(format!("unsafe pack id: {raw:?}")))
    }
}

/// Lowercased cover extension, when it is one we are willing to write.
pub fn cover_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    COVER_EXTENSIONS
        .iter()
        .find(|allowed| **allowed == ext)
        .map(|allowed| (*allowed).to_string())
}

pub fn io_error(path: &Path, e: std::io::Error) -> AppError {
    match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(path.display().to_string()),
        _ => AppError::Io(e),
    }
}

pub async fn blocking<T, F>(work: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(e) => Err(AppError::Other(format!("pack task failed: {e}"))),
    }
}

/// `rfd` dialogs start where the user keeps documents, not where the app does.
pub fn start_dir() -> Option<PathBuf> {
    dirs::document_dir().or_else(dirs::home_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_ids_are_refused() {
        for bad in ["", ".", "..", "../etc", "a/b", "a\\b", "a b", "p\0"] {
            assert!(safe_component(bad).is_err(), "accepted {bad:?}");
        }
        assert_eq!(safe_component(" p_8f2c1a ").expect("id"), "p_8f2c1a");
    }

    #[test]
    fn only_image_extensions_are_copied() {
        assert_eq!(
            cover_extension(Path::new("/x/cover.JPG")).as_deref(),
            Some("jpg")
        );
        assert!(cover_extension(Path::new("/x/cover.svg")).is_none());
        assert!(cover_extension(Path::new("/x/cover")).is_none());
    }

    #[test]
    fn writes_are_refused_without_a_grant() {
        // The grant list is process-global, so this only holds before any
        // picker has run; asserting the error *shape* keeps the test order
        // independent.
        let path = std::env::temp_dir().join("ritmo-pack-no-grant.json");
        match confined(&path.to_string_lossy()) {
            Err(AppError::BadRequest(_)) => {}
            Ok(_) => assert!(grants().lock().iter().any(|root| path.starts_with(root))),
            Err(e) => panic!("unexpected error: {e}"),
        }
    }
}
