//! MPRIS (org.mpris.MediaPlayer2) integration.
//!
//! This is what makes Ritmo a first-class citizen on GNOME: the shell's media
//! widget, the lock screen, `playerctl` and the keyboard's media keys all talk
//! MPRIS rather than listening for global hotkeys. Registering here is
//! therefore cheaper *and* more correct than grabbing XF86Audio* ourselves —
//! and it is the only approach that works under Wayland, where an app cannot
//! grab global keys at all.
//!
//! `mpris_server::Player` is deliberately `!Send` (it is built on `Rc` and a
//! single-threaded zbus server), so it lives on its own thread with a
//! current-thread runtime and a `LocalSet`. The rest of the app talks to it
//! over an unbounded channel and never touches the D-Bus objects directly.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use mpris_server::{LoopStatus, Metadata, PlaybackStatus, Player, Time, TrackId};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::error::{AppError, AppResult};

/// Callback that forwards a `MediaSessionCommand` (see host/types.ts) to the
/// frontend. Installed by `lib.rs`, which emits it on `events::MEDIA_COMMAND`.
pub type CommandSink = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub uri: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    pub album: Option<String>,
    /// Absolute `file://` or `https://` URL. GNOME will not load a bare path.
    pub art_url: Option<String>,
    #[serde(default)]
    pub duration_ms: u64,
    pub track_number: Option<i32>,
    pub disc_number: Option<i32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    /// "playing" | "paused" | "stopped"
    pub status: PlayState,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub can_go_next: bool,
    pub can_go_previous: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayState {
    Playing,
    Paused,
    Stopped,
}

impl From<PlayState> for PlaybackStatus {
    fn from(s: PlayState) -> Self {
        match s {
            PlayState::Playing => PlaybackStatus::Playing,
            PlayState::Paused => PlaybackStatus::Paused,
            PlayState::Stopped => PlaybackStatus::Stopped,
        }
    }
}

enum Update {
    Metadata(Option<Box<MediaMetadata>>),
    State(MediaState),
    /// The playhead moved discontinuously; MPRIS requires an explicit `Seeked`
    /// signal for this, otherwise the shell's slider keeps drifting.
    Seeked(u64),
    Volume(f64),
    Shuffle(bool),
    Repeat(LoopStatus),
    Shutdown,
}

pub struct Mpris {
    tx: UnboundedSender<Update>,
}

impl Mpris {
    /// Spawns the D-Bus thread. Failing to reach the session bus is not fatal:
    /// the app must still run on a headless box or inside a container, so the
    /// error is logged and a handle whose sends go nowhere is returned.
    pub fn spawn(sink: CommandSink) -> Self {
        let (tx, rx) = unbounded_channel();
        std::thread::Builder::new()
            .name("ritmo-mpris".into())
            .spawn(move || {
                if let Err(e) = run_thread(rx, sink) {
                    tracing::warn!("MPRIS unavailable: {e}");
                }
            })
            .unwrap_or_else(|e| {
                tracing::warn!("could not spawn MPRIS thread: {e}");
                std::thread::spawn(|| {})
            });
        Self { tx }
    }

    pub fn set_metadata(&self, meta: Option<MediaMetadata>) {
        let _ = self.tx.send(Update::Metadata(meta.map(Box::new)));
    }

    pub fn set_state(&self, state: MediaState) {
        let _ = self.tx.send(Update::State(state));
    }

    pub fn seeked(&self, position_ms: u64) {
        let _ = self.tx.send(Update::Seeked(position_ms));
    }

    pub fn set_volume(&self, volume: f64) {
        let _ = self.tx.send(Update::Volume(volume.clamp(0.0, 1.0)));
    }

    pub fn set_shuffle(&self, on: bool) {
        let _ = self.tx.send(Update::Shuffle(on));
    }

    pub fn set_repeat(&self, mode: &str) {
        let status = match mode {
            "one" => LoopStatus::Track,
            "all" => LoopStatus::Playlist,
            _ => LoopStatus::None,
        };
        let _ = self.tx.send(Update::Repeat(status));
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Update::Shutdown);
    }
}

/// D-Bus object paths allow only `[A-Za-z0-9_]` between slashes, so a provider
/// URI has to be folded down before it can serve as a track id.
fn track_id(uri: &str) -> AppResult<TrackId> {
    let mut path = String::with_capacity(uri.len() + 20);
    path.push_str("/dev/ritmo/track/");
    for ch in uri.chars() {
        if ch.is_ascii_alphanumeric() {
            path.push(ch);
        } else {
            path.push('_');
        }
    }
    TrackId::try_from(path).map_err(|e| AppError::Other(format!("bad track id: {e}")))
}

fn build_metadata(m: &MediaMetadata) -> Metadata {
    let mut b = Metadata::builder().title(m.title.clone());
    if let Ok(id) = track_id(&m.uri) {
        b = b.trackid(id);
    }
    if !m.artists.is_empty() {
        b = b.artist(m.artists.clone());
    }
    if let Some(album) = &m.album {
        b = b.album(album.clone());
    }
    if let Some(art) = &m.art_url {
        b = b.art_url(art.clone());
    }
    if m.duration_ms > 0 {
        b = b.length(Time::from_millis(m.duration_ms as i64));
    }
    if let Some(n) = m.track_number {
        b = b.track_number(n);
    }
    if let Some(n) = m.disc_number {
        b = b.disc_number(n);
    }
    b.build()
}

fn cmd(kind: &str) -> serde_json::Value {
    serde_json::json!({ "type": kind })
}

fn run_thread(mut rx: UnboundedReceiver<Update>, sink: CommandSink) -> AppResult<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| AppError::Other(format!("mpris runtime: {e}")))?;
    let local = tokio::task::LocalSet::new();

    local.block_on(&rt, async move {
        let player = Player::builder("dev.ritmo.app")
            .identity("Ritmo")
            // The basename of the installed .desktop file, without the
            // extension. Get this wrong and the GNOME media widget falls back
            // to a generic note glyph instead of the app icon.
            .desktop_entry("dev.ritmo.app")
            .can_quit(true)
            .can_raise(true)
            .can_play(true)
            .can_pause(true)
            .can_seek(true)
            .can_go_next(true)
            .can_go_previous(true)
            .can_control(true)
            .build()
            .await
            .map_err(|e| AppError::Other(format!("mpris bus: {e}")))?;
        let player = Rc::new(player);

        // MPRIS `Seek` is a *relative* offset, so the last reported playhead has
        // to be kept here to turn it into the absolute position the frontend wants.
        let position = Rc::new(Cell::new(0u64));
        let seekable = Rc::new(Cell::new(true));

        {
            let s = sink.clone();
            player.connect_play(move |_| s(cmd("play")));
        }
        {
            let s = sink.clone();
            player.connect_pause(move |_| s(cmd("pause")));
        }
        {
            let s = sink.clone();
            player.connect_play_pause(move |_| s(cmd("toggle")));
        }
        {
            let s = sink.clone();
            player.connect_stop(move |_| s(cmd("stop")));
        }
        {
            let s = sink.clone();
            player.connect_next(move |_| s(cmd("next")));
        }
        {
            let s = sink.clone();
            player.connect_previous(move |_| s(cmd("previous")));
        }
        {
            let s = sink.clone();
            let pos = position.clone();
            let can_seek = seekable.clone();
            player.connect_seek(move |_, offset: Time| {
                if !can_seek.get() {
                    return;
                }
                let target = (pos.get() as i64).saturating_add(offset.as_millis()).max(0) as u64;
                s(serde_json::json!({ "type": "seek", "positionMs": target }));
            });
        }
        {
            let s = sink.clone();
            let can_seek = seekable.clone();
            player.connect_set_position(move |_, _id: &TrackId, at: Time| {
                if !can_seek.get() {
                    return;
                }
                s(serde_json::json!({ "type": "seek", "positionMs": at.as_millis().max(0) }));
            });
        }
        {
            let s = sink.clone();
            player.connect_set_volume(move |_, v: f64| {
                s(serde_json::json!({ "type": "setVolume", "volume": v.clamp(0.0, 1.0) }));
            });
        }
        {
            let s = sink.clone();
            player.connect_set_shuffle(move |_, on: bool| {
                s(serde_json::json!({ "type": "setShuffle", "shuffle": on }));
            });
        }
        {
            let s = sink.clone();
            player.connect_set_loop_status(move |_, status: LoopStatus| {
                let mode = match status {
                    LoopStatus::None => "off",
                    LoopStatus::Track => "one",
                    LoopStatus::Playlist => "all",
                };
                s(serde_json::json!({ "type": "setRepeat", "repeat": mode }));
            });
        }
        {
            let s = sink.clone();
            player.connect_raise(move |_| s(cmd("raise")));
        }
        {
            let s = sink.clone();
            player.connect_quit(move |_| s(cmd("quit")));
        }

        let runner = player.clone();
        tokio::task::spawn_local(async move { runner.run().await });
        tracing::info!("MPRIS registered on org.mpris.MediaPlayer2.dev.ritmo.app");

        while let Some(update) = rx.recv().await {
            match update {
                Update::Metadata(Some(m)) => {
                    seekable.set(m.duration_ms > 0);
                    let _ = player.set_metadata(build_metadata(&m)).await;
                }
                Update::Metadata(None) => {
                    let _ = player.set_metadata(Metadata::new()).await;
                }
                Update::State(s) => {
                    position.set(s.position_ms);
                    player.set_position(Time::from_millis(s.position_ms as i64));
                    let _ = player.set_playback_status(s.status.into()).await;
                    let _ = player.set_can_go_next(s.can_go_next).await;
                    let _ = player.set_can_go_previous(s.can_go_previous).await;
                    let _ = player.set_can_seek(s.duration_ms > 0).await;
                }
                Update::Seeked(ms) => {
                    position.set(ms);
                    player.set_position(Time::from_millis(ms as i64));
                    let _ = player.seeked(Time::from_millis(ms as i64)).await;
                }
                Update::Volume(v) => {
                    let _ = player.set_volume(v).await;
                }
                Update::Shuffle(on) => {
                    let _ = player.set_shuffle(on).await;
                }
                Update::Repeat(status) => {
                    let _ = player.set_loop_status(status).await;
                }
                Update::Shutdown => break,
            }
        }
        Ok::<(), AppError>(())
    })
}
