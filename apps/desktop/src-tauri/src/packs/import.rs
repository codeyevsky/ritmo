//! Reading one `pack.json` the user picks.

use serde_json::Value;
use tracing::info;

use crate::error::{AppError, AppResult};

use super::{blocking, confined, grant_parent, io_error, start_dir, MAX_PACK_BYTES};

#[tauri::command]
pub async fn pack_pick_import() -> AppResult<Option<String>> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("Import a pack")
        .add_filter("Ritmo pack", &["json"])
        .add_filter("All files", &["*"]);
    if let Some(start) = start_dir() {
        dialog = dialog.set_directory(start);
    }

    let Some(handle) = dialog.pick_file().await else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    grant_parent(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Parses the file and hands back the document. The size is checked from the
/// directory entry *before* the read, so a multi-gigabyte "pack" never reaches
/// memory, and the `format` marker is checked here so an unrelated JSON file
/// fails with a clear error instead of importing as an empty pack.
#[tauri::command]
pub async fn pack_read(path: String) -> AppResult<Value> {
    let target = confined(&path)?;
    blocking(move || {
        let meta = std::fs::metadata(&target).map_err(|e| io_error(&target, e))?;
        if meta.len() > MAX_PACK_BYTES {
            return Err(AppError::BadRequest(format!(
                "{} is {} bytes, over the {MAX_PACK_BYTES} limit",
                target.display(),
                meta.len()
            )));
        }

        let text = std::fs::read_to_string(&target).map_err(|e| io_error(&target, e))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| AppError::BadRequest(format!("not valid JSON: {e}")))?;
        if value.get("format").and_then(Value::as_str) != Some("ritmopack") {
            return Err(AppError::BadRequest(
                "not a ritmopack document".to_string(),
            ));
        }
        info!(path = %target.display(), "pack read");
        Ok(value)
    })
    .await
}
