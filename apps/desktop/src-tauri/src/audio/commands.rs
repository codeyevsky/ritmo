//! Tauri surface for the audio engine. Every command here is a thin delegation:
//! the engine itself only queues a message, so none of these block the caller.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::engine::Position;
use super::output::DeviceInfo;
use crate::error::AppResult;
use crate::state::AppState;

/// The slice of `Track` the engine actually needs. It is echoed back inside
/// `started` / `ended` / `error` events, so the controller can match on `uri`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTrack {
    pub uri: String,
    pub title: String,
    pub duration_ms: u64,
    #[serde(default)]
    pub is_live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gain_db: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Mirrors `StreamRef` from the core domain model.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireStream {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
}

#[tauri::command]
pub fn audio_load(
    state: tauri::State<'_, AppState>,
    track: WireTrack,
    stream: WireStream,
    start_at_ms: Option<u64>,
    autoplay: bool,
) -> AppResult<()> {
    state.audio.load(track, stream, start_at_ms, autoplay)
}

#[tauri::command]
pub fn audio_preload(
    state: tauri::State<'_, AppState>,
    track: Option<WireTrack>,
    stream: Option<WireStream>,
) -> AppResult<()> {
    state.audio.preload(track, stream)
}

#[tauri::command]
pub fn audio_play(state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.audio.play()
}

#[tauri::command]
pub fn audio_pause(state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.audio.pause()
}

#[tauri::command]
pub fn audio_stop(state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.audio.stop()
}

#[tauri::command]
pub fn audio_seek(state: tauri::State<'_, AppState>, position_ms: u64) -> AppResult<()> {
    state.audio.seek(position_ms)
}

#[tauri::command]
pub fn audio_set_volume(state: tauri::State<'_, AppState>, volume: f32) -> AppResult<()> {
    state.audio.set_volume(volume)
}

#[tauri::command]
pub fn audio_set_muted(state: tauri::State<'_, AppState>, muted: bool) -> AppResult<()> {
    state.audio.set_muted(muted)
}

#[tauri::command]
pub fn audio_set_equalizer(
    state: tauri::State<'_, AppState>,
    enabled: bool,
    gains: Vec<f32>,
) -> AppResult<()> {
    state.audio.set_equalizer(enabled, gains)
}

#[tauri::command]
pub fn audio_set_replaygain(
    state: tauri::State<'_, AppState>,
    enabled: bool,
    gain_db: Option<f32>,
    preamp_db: f32,
) -> AppResult<()> {
    state.audio.set_replaygain(enabled, gain_db, preamp_db)
}

#[tauri::command]
pub fn audio_set_crossfade(state: tauri::State<'_, AppState>, ms: u32) -> AppResult<()> {
    state.audio.set_crossfade(ms)
}

#[tauri::command]
pub fn audio_position(state: tauri::State<'_, AppState>) -> Position {
    state.audio.position()
}

#[tauri::command]
pub fn audio_spectrum(state: tauri::State<'_, AppState>, bins: usize) -> Vec<f32> {
    state.audio.spectrum(bins)
}

#[tauri::command]
pub fn audio_devices(state: tauri::State<'_, AppState>) -> Vec<DeviceInfo> {
    state.audio.devices()
}

#[tauri::command]
pub fn audio_set_device(state: tauri::State<'_, AppState>, id: Option<String>) -> AppResult<()> {
    state.audio.set_device(id)
}
