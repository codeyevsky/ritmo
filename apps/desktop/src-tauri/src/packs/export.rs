//! Writing one `pack.json` to a path the user picks.

use std::path::Path;

use tracing::info;

use crate::error::{AppError, AppResult};

use super::{blocking, confined, grant_parent, io_error, start_dir, MAX_PACK_BYTES};

/// Save dialog for a single pack. The chosen file's directory is recorded, so
/// the following `pack_write` is allowed to land there and nowhere else.
#[tauri::command]
pub async fn pack_pick_export_path(default_name: Option<String>) -> AppResult<Option<String>> {
    let suggested = file_name(default_name.as_deref());
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("Export pack")
        .set_file_name(&suggested)
        .add_filter("Ritmo pack", &["json"]);
    if let Some(start) = start_dir() {
        dialog = dialog.set_directory(start);
    }

    let Some(handle) = dialog.save_file().await else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    grant_parent(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Writes `contents` verbatim. The caller has already serialised the document;
/// this end only enforces where it may go and how big it may be.
#[tauri::command]
pub async fn pack_write(path: String, contents: String) -> AppResult<()> {
    let target = confined(&path)?;
    if !has_json_extension(&target) {
        return Err(AppError::BadRequest(format!(
            "a pack must be written as .json: {path:?}"
        )));
    }
    if contents.len() as u64 > MAX_PACK_BYTES {
        return Err(AppError::BadRequest(format!(
            "a pack may not exceed {MAX_PACK_BYTES} bytes"
        )));
    }

    blocking(move || {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
        }
        std::fs::write(&target, contents.as_bytes()).map_err(|e| io_error(&target, e))?;
        info!(path = %target.display(), "pack exported");
        Ok(())
    })
    .await
}

fn has_json_extension(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase() == "json")
        .unwrap_or(false)
}

/// A filename the OS will accept, derived from the pack's own name.
fn file_name(name: Option<&str>) -> String {
    let stem: String = name
        .unwrap_or("")
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = stem.trim();
    if trimmed.is_empty() {
        return "pack.json".to_string();
    }
    // Truncated by characters, not bytes: slicing a multi-byte name in half
    // would panic.
    let clipped: String = trimmed.chars().take(80).collect();
    format!("{clipped}.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggested_names_stay_filenames() {
        assert_eq!(file_name(None), "pack.json");
        assert_eq!(file_name(Some("   ")), "pack.json");
        assert_eq!(file_name(Some("Late Night Drive")), "Late Night Drive.json");
        assert_eq!(file_name(Some("../etc/passwd")), ".._etc_passwd.json");
    }

    #[test]
    fn only_json_is_accepted() {
        assert!(has_json_extension(Path::new("/x/a.JSON")));
        assert!(!has_json_extension(Path::new("/x/a.sh")));
        assert!(!has_json_extension(Path::new("/x/a")));
    }
}
