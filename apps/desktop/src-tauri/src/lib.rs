//! Process wiring.
//!
//! Everything the subsystems need is built once here, in dependency order, and
//! handed to Tauri's managed state. The subsystems themselves never reach for
//! an `AppHandle`: they emit through a closure installed from this file, which
//! is what keeps them testable outside Tauri.

pub mod audio;
pub mod commands;
pub mod db;
pub mod error;
pub mod library;
pub mod mpris;
pub mod net;
pub mod packs;
pub mod state;
pub mod zoom;
pub mod wallpaper;

mod single_instance;
mod tray;

use std::sync::Arc;

use tauri::{Emitter, Manager, WindowEvent};

use crate::audio::{AudioEngine, EmitFn};
use crate::db::Database;
use crate::library::Scanner;
use crate::mpris::Mpris;
use crate::net::Net;
use crate::state::{events, AppState, Paths};

pub fn run() {
    init_tracing();

    // Two processes would fight over the SQLite file and the MPRIS bus name, so
    // a second launch raises the first window and exits.
    let listener = match single_instance::acquire() {
        Ok(l) => Some(l),
        Err(()) => {
            tracing::info!("another Ritmo instance is already running; raising it");
            return;
        }
    };

    let result = tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();

            let paths = Paths::resolve()?;
            tracing::info!(data = %paths.data.display(), cache = %paths.cache.display(), "paths resolved");

            // One emit closure for every subsystem: the channel travels with the
            // payload so no module needs its own wiring.
            let emit: EmitFn = {
                let handle = handle.clone();
                Arc::new(move |channel: &str, payload: serde_json::Value| {
                    if let Err(e) = handle.emit(channel, payload) {
                        tracing::debug!(channel, error = %e, "event not delivered");
                    }
                })
            };

            let database = Arc::new(Database::open(&paths.data.join("ritmo.db"))?);
            let audio = AudioEngine::new(paths.clone(), emit.clone())?;
            let scanner = Scanner::new(database.clone(), paths.clone(), emit.clone());
            let net = Net::new(database.clone(), paths.clone(), emit.clone())?;

            // MPRIS commands that are about the *window* rather than playback are
            // handled here; everything else is forwarded to the frontend, which
            // owns the transport state.
            let mpris = Arc::new(Mpris::spawn({
                let handle = handle.clone();
                Arc::new(move |cmd: serde_json::Value| {
                    match cmd.get("type").and_then(|v| v.as_str()) {
                        Some("raise") => {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        Some("quit") => {
                            // Give the frontend a moment to persist its session.
                            let _ = handle.emit(events::MEDIA_COMMAND, &cmd);
                            let h = handle.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(250));
                                h.exit(0);
                            });
                        }
                        _ => {
                            if let Err(e) = handle.emit(events::MEDIA_COMMAND, &cmd) {
                                tracing::debug!(error = %e, "media command not delivered");
                            }
                        }
                    }
                })
            }));

            app.manage(AppState {
                db: database,
                audio,
                scanner,
                net,
                mpris,
                paths,
            });

            if let Some(main) = app.get_webview_window("main") {
                zoom::lock(&main);
            }

            if let Err(e) = tray::build(&handle) {
                // A missing StatusNotifier host is common on bare WMs; the app is
                // perfectly usable without a tray icon.
                tracing::warn!(error = %e, "tray icon unavailable");
            }

            if let Some(listener) = listener {
                single_instance::serve(listener, handle.clone());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if close_to_tray(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // app
            commands::app_info,
            commands::app_paths,
            commands::settings_load,
            commands::settings_save,
            commands::media_set_metadata,
            commands::media_set_state,
            commands::media_seeked,
            commands::media_set_flags,
            commands::notify,
            commands::system_accent,
            commands::window_ready,
            // db
            db::commands::db_query,
            db::commands::db_execute,
            db::commands::db_transaction,
            db::commands::db_maintenance,
            db::commands::kv_get,
            db::commands::kv_set,
            db::commands::kv_remove,
            db::commands::kv_keys,
            // audio
            audio::commands::audio_load,
            audio::commands::audio_preload,
            audio::commands::audio_play,
            audio::commands::audio_pause,
            audio::commands::audio_stop,
            audio::commands::audio_seek,
            audio::commands::audio_set_volume,
            audio::commands::audio_set_muted,
            audio::commands::audio_set_equalizer,
            audio::commands::audio_set_replaygain,
            audio::commands::audio_set_crossfade,
            audio::commands::audio_position,
            audio::commands::audio_spectrum,
            audio::commands::audio_devices,
            audio::commands::audio_set_device,
            // library
            library::commands::library_scan,
            library::commands::library_cancel_scan,
            library::commands::library_set_watching,
            library::commands::library_refresh_file,
            library::commands::library_pick_folder,
            library::commands::library_pick_album,
            library::commands::library_pick_files,
            library::commands::library_import_files,
            // packs
            packs::export::pack_pick_export_path,
            packs::export::pack_write,
            packs::import::pack_pick_import,
            packs::import::pack_read,
            packs::publish::pack_pick_publish_dir,
            packs::publish::pack_publish,
            packs::publish::pack_publish_staging_dir,
            packs::github::pack_publish_github,
            packs::github::github_check_token,
            // net
            net::commands::http_request,
            net::commands::download_file,
            net::commands::cancel_download,
            net::commands::cache_size,
            net::commands::cache_prune,
            net::commands::cache_clear,
            net::commands::open_external,
            net::commands::dir_size,
            net::commands::file_exists,
            net::commands::read_text_file,
            net::commands::write_text_file,
            net::commands::remove_file,
        ])
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            app.run(|handle, event| {
                if let tauri::RunEvent::ExitRequested { .. } = event {
                    if let Some(state) = handle.try_state::<AppState>() {
                        state.mpris.shutdown();
                        let _ = state.audio.stop();
                    }
                    single_instance::cleanup();
                }
            });
        }
        Err(e) => {
            tracing::error!(error = %e, "Ritmo could not start");
            eprintln!("Ritmo failed to start: {e}");
            single_instance::cleanup();
            std::process::exit(1);
        }
    }
}

/// Read straight from disk rather than caching: window closes are rare, the file
/// is a few hundred bytes, and this way the setting takes effect immediately
/// after the user toggles it.
fn close_to_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let path = state.paths.data.join("settings.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("closeToTray").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_env("RUST_LOG")
        .unwrap_or_else(|_| EnvFilter::new("ritmo_lib=info,warn"));
    let _ = fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .with_writer(std::io::stderr)
        .try_init();
}
