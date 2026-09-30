//! Process-wide state, held in Tauri's managed-state map.
//!
//! Every subsystem gets its own field rather than one big mutex, so a long
//! library scan can never block a transport command.

use std::path::PathBuf;
use std::sync::Arc;

use crate::audio::AudioEngine;
use crate::db::Database;
use crate::library::Scanner;
use crate::mpris::Mpris;
use crate::net::Net;

pub struct AppState {
    pub db: Arc<Database>,
    pub audio: Arc<AudioEngine>,
    pub scanner: Arc<Scanner>,
    pub net: Arc<Net>,
    pub mpris: Arc<Mpris>,
    pub paths: Paths,
}

/// Resolved once at startup so no module has to re-derive XDG locations.
#[derive(Clone, Debug)]
pub struct Paths {
    /// `~/.local/share/ritmo` — database, settings.
    pub data: PathBuf,
    /// `~/.cache/ritmo` — http cache, artwork, offline audio.
    pub cache: PathBuf,
    /// `<cache>/artwork`
    pub artwork: PathBuf,
    /// `<cache>/audio` — completed offline downloads.
    pub audio: PathBuf,
    /// `<cache>/http` — provider response cache.
    pub http: PathBuf,
}

impl Paths {
    pub fn resolve() -> anyhow::Result<Self> {
        let data = dirs::data_dir()
            .ok_or_else(|| anyhow::anyhow!("no XDG data dir"))?
            .join("ritmo");
        let cache = dirs::cache_dir()
            .ok_or_else(|| anyhow::anyhow!("no XDG cache dir"))?
            .join("ritmo");
        let p = Paths {
            artwork: cache.join("artwork"),
            audio: cache.join("audio"),
            http: cache.join("http"),
            data,
            cache,
        };
        for d in [&p.data, &p.cache, &p.artwork, &p.audio, &p.http] {
            std::fs::create_dir_all(d)?;
        }
        Ok(p)
    }
}

/// Event channel names. The frontend subscribes to these exact strings.
pub mod events {
    /// `EngineEvent` JSON from the audio engine.
    pub const AUDIO: &str = "ritmo://audio";
    /// `ScanProgress` JSON while a library scan runs.
    pub const SCAN: &str = "ritmo://scan";
    /// `{ id, received, total }` download progress.
    pub const DOWNLOAD: &str = "ritmo://download";
    /// `MediaSessionCommand` JSON forwarded from MPRIS / tray / hotkeys.
    pub const MEDIA_COMMAND: &str = "ritmo://media-command";
    /// Emitted when the library changed underneath the app (fs watcher).
    pub const LIBRARY_CHANGED: &str = "ritmo://library-changed";
}
