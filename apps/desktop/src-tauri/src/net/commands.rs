//! Tauri command surface for the net module.
//!
//! The filesystem commands are the interesting ones: the WebView can ask for
//! any path it likes, so each one is confined to the app's own directories or
//! to a folder the user has actually added to their library.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tauri::State;
use tracing::warn;

use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{DownloadReq, DownloadResult, HttpRequest, HttpResponse};

#[tauri::command]
pub async fn http_request(
    state: State<'_, AppState>,
    req: HttpRequest,
) -> AppResult<HttpResponse> {
    state.net.request(req).await
}

#[tauri::command]
pub async fn download_file(
    state: State<'_, AppState>,
    id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    dest_relative: String,
) -> AppResult<DownloadResult> {
    state
        .net
        .download(DownloadReq {
            id,
            url,
            headers,
            dest_relative,
        })
        .await
}

#[tauri::command]
pub async fn cancel_download(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.net.cancel_download(&id);
    Ok(())
}

#[tauri::command]
pub async fn cache_size(state: State<'_, AppState>) -> AppResult<u64> {
    let net = Arc::clone(&state.net);
    blocking(move || net.cache_size()).await
}

#[tauri::command]
pub async fn cache_prune(state: State<'_, AppState>, max_bytes: u64) -> AppResult<u64> {
    let net = Arc::clone(&state.net);
    blocking(move || net.cache_prune(max_bytes)).await
}

#[tauri::command]
pub async fn cache_clear(state: State<'_, AppState>) -> AppResult<()> {
    let net = Arc::clone(&state.net);
    blocking(move || net.cache_clear()).await
}

/// Opens a URL in the user's browser. Only web and mail schemes are allowed:
/// a provider response that came back with `file:` — or with anything the
/// desktop's URL handlers treat as executable — must not be able to turn into
/// a local command.
#[tauri::command]
pub async fn open_external(url: String) -> AppResult<()> {
    let parsed = url::Url::parse(&url)
        .map_err(|e| AppError::BadRequest(format!("invalid url {url:?}: {e}")))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => {}
        other => {
            return Err(AppError::BadRequest(format!(
                "refusing to open scheme {other:?}"
            )))
        }
    }

    // The reparsed form is handed to the shell rather than the caller's string,
    // so what reaches the handler is guaranteed to start with a known scheme
    // and can never be read as a command-line flag.
    let target = parsed.to_string();
    blocking(move || open::that_detached(target.as_str()).map_err(AppError::from)).await
}

#[tauri::command]
pub async fn dir_size(state: State<'_, AppState>, path: String) -> AppResult<u64> {
    let target = confine(&allowed_roots(&state), &path)?;
    blocking(move || Ok(super::dir_bytes(&target))).await
}

#[tauri::command]
pub async fn file_exists(state: State<'_, AppState>, path: String) -> AppResult<bool> {
    let target = confine(&allowed_roots(&state), &path)?;
    blocking(move || Ok(target.exists())).await
}

#[tauri::command]
pub async fn read_text_file(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let target = confine(&allowed_roots(&state), &path)?;
    blocking(move || std::fs::read_to_string(&target).map_err(|e| io_error(&target, e))).await
}

#[tauri::command]
pub async fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> AppResult<()> {
    let target = confine(&allowed_roots(&state), &path)?;
    blocking(move || {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
        }
        std::fs::write(&target, contents.as_bytes()).map_err(|e| io_error(&target, e))
    })
    .await
}

#[tauri::command]
pub async fn remove_file(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let target = confine(&allowed_roots(&state), &path)?;
    blocking(move || match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        // Idempotent: the caller wanted the file gone and it is gone.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(&target, e)),
    })
    .await
}

async fn blocking<T, F>(work: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(e) => Err(AppError::Other(format!("background task failed: {e}"))),
    }
}

fn io_error(path: &Path, e: std::io::Error) -> AppError {
    match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(path.display().to_string()),
        _ => AppError::Io(e),
    }
}

fn allowed_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots = vec![state.paths.data.clone(), state.paths.cache.clone()];
    roots.extend(music_roots(&state.db));
    roots
}

/// The music folders live inside the JSON `Settings` blob, whose storage key
/// belongs to the app module, so they are recovered by shape instead: any
/// `settings_kv` value that parses as an object carrying a `musicFolders`
/// array of strings contributes roots. `scan_state` is read as well, which
/// keeps the allow-list working before the first settings save.
fn music_roots(db: &Database) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    match super::db_query(db, "SELECT value FROM settings_kv", vec![]) {
        Ok(rows) => {
            for row in rows {
                let Some(raw) = row.get("value").and_then(Value::as_str) else {
                    continue;
                };
                let Ok(Value::Object(object)) = serde_json::from_str::<Value>(raw) else {
                    continue;
                };
                let Some(Value::Array(folders)) = object.get("musicFolders") else {
                    continue;
                };
                roots.extend(
                    folders
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(PathBuf::from),
                );
            }
        }
        Err(e) => warn!(error = %e, "could not read settings for the path allow-list"),
    }

    match super::db_query(db, "SELECT folder FROM scan_state", vec![]) {
        Ok(rows) => roots.extend(
            rows.iter()
                .filter_map(|row| row.get("folder").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
        ),
        Err(e) => warn!(error = %e, "could not read scan_state for the path allow-list"),
    }

    roots
}

/// `pub(crate)` so the pack module can confine to its own granted roots with
/// the same implementation rather than a second copy of it.
pub(crate) fn confine(roots: &[PathBuf], raw: &str) -> AppResult<PathBuf> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(AppError::BadRequest("path is empty or invalid".to_string()));
    }
    let requested = Path::new(raw);
    if !requested.is_absolute() {
        return Err(AppError::BadRequest(format!(
            "path must be absolute: {raw:?}"
        )));
    }

    let candidate = resolve_existing_prefix(&lexical_normalize(requested));
    for root in roots {
        let real_root = resolve_existing_prefix(&lexical_normalize(root));
        if candidate.starts_with(&real_root) {
            return Ok(candidate);
        }
    }
    Err(AppError::BadRequest(format!(
        "path is outside the allowed directories: {raw:?}"
    )))
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `canonicalize` needs the target to exist, but a write legitimately names a
/// file that does not yet. Canonicalising the deepest existing ancestor is
/// still enough to defeat a symlink escape, because every component above the
/// new leaf is a real directory.
fn resolve_existing_prefix(path: &Path) -> PathBuf {
    let mut tail: Vec<OsString> = Vec::new();
    let mut cursor = path.to_path_buf();

    loop {
        if let Ok(real) = std::fs::canonicalize(&cursor) {
            let mut out = real;
            for segment in tail.iter().rev() {
                out.push(segment);
            }
            return out;
        }
        let name = cursor.file_name().map(|s| s.to_os_string());
        let parent = cursor.parent().map(Path::to_path_buf);
        match (name, parent) {
            (Some(name), Some(parent)) if !parent.as_os_str().is_empty() => {
                tail.push(name);
                cursor = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_are_rejected() {
        let roots = vec![PathBuf::from("/tmp")];
        assert!(matches!(
            confine(&roots, "relative/path"),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(confine(&roots, ""), Err(AppError::BadRequest(_))));
    }

    #[test]
    fn traversal_cannot_climb_out_of_a_root() {
        let dir = std::env::temp_dir().join("ritmo-confine-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let roots = vec![dir.clone()];

        let escape = format!("{}/../../etc/passwd", dir.display());
        assert!(matches!(
            confine(&roots, &escape),
            Err(AppError::BadRequest(_))
        ));

        let inside = format!("{}/sub/./file.m3u", dir.display());
        let resolved = confine(&roots, &inside).expect("path inside the root");
        assert!(resolved.ends_with("sub/file.m3u"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sibling_directory_with_a_shared_prefix_is_not_inside() {
        let base = std::env::temp_dir().join("ritmo-prefix-test");
        let root = base.join("music");
        let sibling = base.join("music-private");
        std::fs::create_dir_all(&root).expect("root");
        std::fs::create_dir_all(&sibling).expect("sibling");

        let roots = vec![root];
        let target = format!("{}/secret.txt", sibling.display());
        assert!(matches!(
            confine(&roots, &target),
            Err(AppError::BadRequest(_))
        ));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn normalisation_collapses_dot_segments() {
        assert_eq!(
            lexical_normalize(Path::new("/a/./b/../c/")),
            PathBuf::from("/a/c")
        );
        assert_eq!(lexical_normalize(Path::new("/../..")), PathBuf::from("/"));
    }

    #[test]
    fn nonexistent_leaves_keep_their_name() {
        let dir = std::env::temp_dir();
        let resolved = resolve_existing_prefix(&dir.join("ritmo-does-not-exist/leaf.txt"));
        assert!(resolved.ends_with("ritmo-does-not-exist/leaf.txt"));
    }

    #[test]
    fn only_web_and_mail_schemes_survive_scheme_checks() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<b>",
            "smb://host/share",
            "ritmo://audio",
        ] {
            let parsed = url::Url::parse(bad).expect("parsable url");
            assert!(
                !matches!(parsed.scheme(), "http" | "https" | "mailto"),
                "{bad} should not be openable"
            );
        }
        for good in ["http://x.test", "https://x.test/a?b=c", "mailto:a@b.test"] {
            let parsed = url::Url::parse(good).expect("parsable url");
            assert!(matches!(parsed.scheme(), "http" | "https" | "mailto"));
        }
    }
}
