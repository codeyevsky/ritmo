//! Tauri commands for the local library. Wire shapes are fixed by docs/ipc.md.

use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::library::ScanResult;
use crate::state::AppState;

/// A scan walks tens of thousands of files and holds no lock the transport
/// commands need, so it goes to the blocking pool and the IPC thread is free
/// again immediately.
#[tauri::command]
pub async fn library_scan(
    state: State<'_, AppState>,
    folders: Vec<String>,
) -> AppResult<ScanResult> {
    let scanner = state.scanner.clone();
    tauri::async_runtime::spawn_blocking(move || scanner.scan(folders))
        .await
        .map_err(task_failed)?
}

#[tauri::command]
pub fn library_cancel_scan(state: State<'_, AppState>) -> AppResult<()> {
    state.scanner.cancel();
    Ok(())
}

#[tauri::command]
pub async fn library_set_watching(
    state: State<'_, AppState>,
    enabled: bool,
    folders: Vec<String>,
) -> AppResult<()> {
    let scanner = state.scanner.clone();
    // Tearing a watcher down joins its worker thread; that wait belongs on the
    // blocking pool too.
    tauri::async_runtime::spawn_blocking(move || scanner.set_watching(enabled, folders))
        .await
        .map_err(task_failed)?
}

#[tauri::command]
pub async fn library_refresh_file(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Option<Value>> {
    let scanner = state.scanner.clone();
    tauri::async_runtime::spawn_blocking(move || scanner.refresh_file(&path))
        .await
        .map_err(task_failed)?
}

/// Async commands are driven by the runtime's worker pool rather than the UI
/// thread, and the portal backend talks D-Bus, so awaiting the dialog here
/// never blocks the window.
#[tauri::command]
pub async fn library_pick_folder() -> AppResult<Option<String>> {
    Ok(folder_dialog("Choose a music folder")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

/// Folder picker aimed at a single release rather than a whole library root.
/// Same mechanism, different wording — the caller scans just this one folder, so
/// the tracks inside group into one album by their tags.
#[tauri::command]
pub async fn library_pick_album() -> AppResult<Option<String>> {
    Ok(folder_dialog("Choose an album folder")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

/// Multi-select picker for loose tracks. The extension filter mirrors
/// `tags::AUDIO_EXTENSIONS`, so the dialog can never offer a file the scanner
/// would then silently skip.
#[tauri::command]
pub async fn library_pick_files() -> AppResult<Option<Vec<String>>> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("Choose audio files")
        .add_filter("Audio", crate::library::tags::AUDIO_EXTENSIONS)
        .add_filter("All files", &["*"]);
    if let Some(start) = dirs::audio_dir().or_else(dirs::home_dir) {
        dialog = dialog.set_directory(start);
    }
    Ok(dialog.pick_files().await.map(|files| {
        files
            .into_iter()
            .map(|f| f.path().to_string_lossy().into_owned())
            .collect()
    }))
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: u32,
    /// Not audio, unreadable, or already present with an unchanged stamp.
    pub skipped: u32,
    pub errors: Vec<ImportError>,
    /// Full `Track` JSON for everything that landed, so the caller can show it
    /// without a second query.
    pub tracks: Vec<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportError {
    pub path: String,
    pub message: String,
}

/// Imports loose files without adding their directories as watched roots —
/// a single track dropped in from Downloads should not pull in its neighbours.
#[tauri::command]
pub async fn library_import_files(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> AppResult<ImportResult> {
    let scanner = state.scanner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = ImportResult::default();
        for path in paths {
            match scanner.refresh_file(&path) {
                Ok(Some(track)) => {
                    out.imported += 1;
                    out.tracks.push(track);
                }
                Ok(None) => out.skipped += 1,
                Err(e) => out.errors.push(ImportError { path, message: e.to_string() }),
            }
        }
        out
    })
    .await
    .map_err(task_failed)
}

fn folder_dialog(title: &str) -> rfd::AsyncFileDialog {
    let mut dialog = rfd::AsyncFileDialog::new().set_title(title);
    if let Some(start) = dirs::audio_dir().or_else(dirs::home_dir) {
        dialog = dialog.set_directory(start);
    }
    dialog
}

fn task_failed(e: tauri::Error) -> AppError {
    AppError::Other(format!("library task failed: {e}"))
}
