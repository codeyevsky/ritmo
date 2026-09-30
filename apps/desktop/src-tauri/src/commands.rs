//! App-level IPC commands: version info, settings persistence, OS media
//! session, notifications, the desktop accent and the deferred window reveal.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::mpris::{MediaMetadata, MediaState};
use crate::state::AppState;
use crate::wallpaper;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app: String,
    pub platform: String,
    pub engine: String,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        app: env!("CARGO_PKG_VERSION").to_string(),
        platform: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        engine: "tauri2-webkitgtk".to_string(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub data: PathBuf,
    pub cache: PathBuf,
    pub artwork: PathBuf,
    pub audio: PathBuf,
    pub http: PathBuf,
}

#[tauri::command]
pub fn app_paths(state: tauri::State<'_, AppState>) -> AppPaths {
    let p = &state.paths;
    AppPaths {
        data: p.data.clone(),
        cache: p.cache.clone(),
        artwork: p.artwork.clone(),
        audio: p.audio.clone(),
        http: p.http.clone(),
    }
}

fn settings_path(state: &AppState) -> PathBuf {
    state.paths.data.join("settings.json")
}

#[tauri::command]
pub fn settings_load(state: tauri::State<'_, AppState>) -> AppResult<Option<String>> {
    let path = settings_path(&state);
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(e)),
    }
}

#[tauri::command]
pub fn settings_save(state: tauri::State<'_, AppState>, json: String) -> AppResult<()> {
    // Reject malformed input before it can replace a good file — a corrupt
    // settings.json would make the app unopenable on next launch.
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| AppError::BadRequest(format!("settings is not valid JSON: {e}")))?;

    let path = settings_path(&state);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAccent {
    pub hex: String,
    pub wallpaper_path: Option<String>,
}

/// The desktop wallpaper's representative colour, so Ritmo's accent can follow
/// the system the way the shell's own does. `None` on a session with no
/// readable wallpaper — the frontend falls back to its default accent.
///
/// Decoding happens on the blocking pool: the file is on disk and may be a 4K
/// PNG, which is far too long to hold the IPC thread for.
#[tauri::command]
pub async fn system_accent() -> AppResult<Option<SystemAccent>> {
    tauri::async_runtime::spawn_blocking(|| {
        wallpaper::accent().map(|accent| SystemAccent {
            hex: accent.hex,
            wallpaper_path: Some(accent.path.to_string_lossy().into_owned()),
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("system_accent join: {e}")))
}

#[tauri::command]
pub fn media_set_metadata(
    state: tauri::State<'_, AppState>,
    track: Option<MediaMetadata>,
) -> AppResult<()> {
    state.mpris.set_metadata(track);
    Ok(())
}

#[tauri::command]
pub fn media_set_state(state: tauri::State<'_, AppState>, playback: MediaState) -> AppResult<()> {
    state.mpris.set_state(playback);
    Ok(())
}

#[tauri::command]
pub fn media_seeked(state: tauri::State<'_, AppState>, position_ms: u64) -> AppResult<()> {
    state.mpris.seeked(position_ms);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFlags {
    pub volume: Option<f64>,
    pub shuffle: Option<bool>,
    pub repeat: Option<String>,
}

#[tauri::command]
pub fn media_set_flags(state: tauri::State<'_, AppState>, flags: MediaFlags) -> AppResult<()> {
    if let Some(v) = flags.volume {
        state.mpris.set_volume(v);
    }
    if let Some(s) = flags.shuffle {
        state.mpris.set_shuffle(s);
    }
    if let Some(r) = flags.repeat {
        state.mpris.set_repeat(&r);
    }
    Ok(())
}

#[tauri::command]
pub async fn notify(title: String, body: String, icon_path: Option<String>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut n = notify_rust::Notification::new();
        n.summary(&title).body(&body).appname("Ritmo");
        // A per-track cover is nicer than the app icon, but only when it is a
        // real file — the notification daemon silently drops bad paths.
        match icon_path.as_deref() {
            Some(p) if std::path::Path::new(p).is_file() => n.icon(p),
            _ => n.icon("dev.ritmo.app"),
        };
        // Transient + Music category so the shell groups it with other players
        // and does not keep it in the notification tray.
        n.hint(notify_rust::Hint::Category("x-gnome.music".into()))
            .hint(notify_rust::Hint::Transient(true))
            .timeout(notify_rust::Timeout::Milliseconds(4000));
        if let Err(e) = n.show() {
            tracing::debug!("notification failed: {e}");
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("notify join: {e}")))
}

/// The window is created hidden so the user never sees an unstyled white flash
/// while the WebView boots; React calls this once it has painted.
#[tauri::command]
pub fn window_ready(window: tauri::Window) -> AppResult<()> {
    use tauri::Manager;
    if let Some(w) = window.get_webview_window("main") {
        // WebKitGTK keeps its zoom level across loads; pin it so a stray
        // ctrl+scroll can never leave the layout permanently rescaled.
        let _ = w.set_zoom(1.0);
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}
