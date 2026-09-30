//! Playback orchestrator.
//!
//! One dedicated thread owns every piece of mutable playback state: the
//! decoders, the DSP chain, the output handle. Public methods never touch that
//! state — they queue a `Cmd` and return, which is what keeps `audio_pause`
//! instant even while a 320 kbps FLAC is being resampled. The only data flowing
//! the other way is a handful of atomics, so `position()` can be polled at
//! 60 fps without ever contending with the decoder.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tracing::{debug, error, info, warn};

use super::commands::{WireStream, WireTrack};
use super::decoder::Decoder;
use super::dsp::{
    downmix_mono, perceptual_volume, soft_clip, BandMeter, Crossfader, Equalizer, Resampler,
    SmoothGain,
};
use super::output::{DeviceInfo, MasterGain, Output};
use super::source::{open_source, IcyMetadata, OpenedSource, SourceSpec};
use crate::error::{AppError, AppResult};
use crate::state::{events, Paths};

/// Frames mixed per crossfade step.
const CHUNK_FRAMES: usize = 2048;
/// Upper bound on the samples pulled from a decoder in one pump iteration, so a
/// single fat chunk cannot delay command handling.
const MAX_BLOCK_FRAMES: usize = 16_384;

const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const SPECTRUM_EVERY: Duration = Duration::from_millis(33);
const IDLE_POLL: Duration = Duration::from_millis(50);
const BUSY_NAP: Duration = Duration::from_millis(5);

/// Decode until roughly this much audio is queued, then idle. Leaves the ring
/// (2 s) headroom for one more block and keeps pause/seek latency low, because
/// the loop is never parked inside a blocking `push`.
const HIGH_WATER_MS: u64 = 1_200;
/// How much has to be queued again before a stall is considered over.
const CANPLAY_MS: u64 = 150;
/// A track is only "ended" once the ring is this close to empty; announcing it
/// earlier lets the next `load` clear audio nobody has heard yet.
const TAIL_MS: u64 = 25;

const GAIN_RAMP_MS: f32 = 150.0;
const DEFAULT_BINS: usize = 64;
const EQ_BANDS: usize = 10;

pub type EmitFn = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub position_ms: u64,
    pub duration_ms: u64,
    pub buffered_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackError {
    code: &'static str,
    message: String,
    retryable: bool,
}

/// Mirrors the `EngineEvent` union in `packages/core/src/engine/types.ts`.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Event {
    Started {
        track: WireTrack,
    },
    Playing,
    Paused,
    Stopped,
    Progress {
        position_ms: u64,
        duration_ms: u64,
        buffered_ms: u64,
    },
    Stalled,
    Canplay,
    Ended {
        #[serde(skip_serializing_if = "Option::is_none")]
        advanced_to: Option<WireTrack>,
    },
    NeedsRestream {
        track: WireTrack,
    },
    /// ICY/Vorbis in-band title from a live stream — the only way to learn what
    /// a radio station is currently playing.
    StreamTitle {
        title: String,
    },
    Error {
        error: PlaybackError,
        #[serde(skip_serializing_if = "Option::is_none")]
        track: Option<WireTrack>,
    },
}

enum Cmd {
    Load {
        track: WireTrack,
        stream: WireStream,
        start_at_ms: Option<u64>,
        autoplay: bool,
    },
    Preload {
        track: Option<WireTrack>,
        stream: Option<WireStream>,
    },
    /// Result of opening a preload source off-thread.
    PreloadOpened {
        generation: u64,
        track: WireTrack,
        stream: WireStream,
        opened: OpenedSource,
    },
    Play,
    Pause,
    Stop,
    Seek(u64),
    SetEqualizer {
        enabled: bool,
        gains: Vec<f32>,
    },
    SetReplayGain {
        enabled: bool,
        gain_db: Option<f32>,
        preamp_db: f32,
    },
    SetCrossfade(u32),
    SetDevice(Option<String>),
    DeviceFailed(String),
    Shutdown,
}

struct Shared {
    position_ms: AtomicU64,
    duration_ms: AtomicU64,
    buffered_ms: AtomicU64,
    spectrum_bins: AtomicUsize,
    spectrum: Mutex<Vec<f32>>,
}

impl Shared {
    fn new() -> Self {
        Shared {
            position_ms: AtomicU64::new(0),
            duration_ms: AtomicU64::new(0),
            buffered_ms: AtomicU64::new(0),
            spectrum_bins: AtomicUsize::new(DEFAULT_BINS),
            spectrum: Mutex::new(vec![0.0; DEFAULT_BINS]),
        }
    }
}

pub struct AudioEngine {
    /// `mpsc::Sender` is `Send` but not `Sync`, and Tauri's managed state has to
    /// be both.
    tx: Mutex<Sender<Cmd>>,
    shared: Arc<Shared>,
    /// Master level and mute. Written straight from the public API and read by
    /// the device callback, so it bypasses the command channel entirely.
    gain: Arc<MasterGain>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl AudioEngine {
    pub fn new(paths: Paths, emit: EmitFn) -> AppResult<Arc<Self>> {
        let (tx, rx) = mpsc::channel::<Cmd>();
        let shared = Arc::new(Shared::new());
        let gain = Arc::new(MasterGain::default());
        let worker_gain = Arc::clone(&gain);
        let err_tx = Arc::new(Mutex::new(tx.clone()));
        let worker_tx = tx.clone();
        let worker_shared = Arc::clone(&shared);

        let worker = std::thread::Builder::new()
            .name("ritmo-audio".to_string())
            .spawn(move || {
                let mut worker = Worker::new(paths, emit, worker_shared, worker_tx, err_tx, worker_gain);
                worker.run(rx);
                debug!("audio engine thread exited");
            })
            .map_err(AppError::Io)?;

        Ok(Arc::new(AudioEngine {
            tx: Mutex::new(tx),
            shared,
            gain,
            worker: Mutex::new(Some(worker)),
        }))
    }

    fn send(&self, cmd: Cmd) -> AppResult<()> {
        self.tx
            .lock()
            .send(cmd)
            .map_err(|_| AppError::Audio("audio engine thread is not running".to_string()))
    }

    pub fn load(
        &self,
        track: WireTrack,
        stream: WireStream,
        start_at_ms: Option<u64>,
        autoplay: bool,
    ) -> AppResult<()> {
        self.send(Cmd::Load { track, stream, start_at_ms, autoplay })
    }

    pub fn preload(
        &self,
        track: Option<WireTrack>,
        stream: Option<WireStream>,
    ) -> AppResult<()> {
        self.send(Cmd::Preload { track, stream })
    }

    pub fn play(&self) -> AppResult<()> {
        self.send(Cmd::Play)
    }

    pub fn pause(&self) -> AppResult<()> {
        self.send(Cmd::Pause)
    }

    pub fn stop(&self) -> AppResult<()> {
        self.send(Cmd::Stop)
    }

    pub fn seek(&self, position_ms: u64) -> AppResult<()> {
        self.send(Cmd::Seek(position_ms))
    }

    pub fn set_volume(&self, volume: f32) -> AppResult<()> {
        // Deliberately not a command: the decode thread blocks while the ring
        // is full, which would delay a volume change by up to the buffer depth.
        self.gain.set_level(perceptual_volume(volume.clamp(0.0, 1.0)));
        Ok(())
    }

    pub fn set_muted(&self, muted: bool) -> AppResult<()> {
        self.gain.set_muted(muted);
        Ok(())
    }

    pub fn set_equalizer(&self, enabled: bool, gains: Vec<f32>) -> AppResult<()> {
        self.send(Cmd::SetEqualizer { enabled, gains })
    }

    pub fn set_replaygain(
        &self,
        enabled: bool,
        gain_db: Option<f32>,
        preamp_db: f32,
    ) -> AppResult<()> {
        self.send(Cmd::SetReplayGain { enabled, gain_db, preamp_db })
    }

    pub fn set_crossfade(&self, ms: u32) -> AppResult<()> {
        self.send(Cmd::SetCrossfade(ms))
    }

    pub fn position(&self) -> Position {
        Position {
            position_ms: self.shared.position_ms.load(Ordering::Relaxed),
            duration_ms: self.shared.duration_ms.load(Ordering::Relaxed),
            buffered_ms: self.shared.buffered_ms.load(Ordering::Relaxed),
        }
    }

    pub fn spectrum(&self, bins: usize) -> Vec<f32> {
        let bins = bins.clamp(1, 1024);
        self.shared.spectrum_bins.store(bins, Ordering::Relaxed);
        let mut out: Vec<f32> = self.shared.spectrum.lock().clone();
        out.resize(bins, 0.0);
        out
    }

    pub fn devices(&self) -> Vec<DeviceInfo> {
        Output::list_devices()
    }

    pub fn set_device(&self, id: Option<String>) -> AppResult<()> {
        self.send(Cmd::SetDevice(id))
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        let _ = self.tx.lock().send(Cmd::Shutdown);
        if let Some(worker) = self.worker.lock().take() {
            let _ = worker.join();
        }
    }
}

/// One decodable track plus the per-track half of the DSP chain. Kept separate
/// from the master chain because a crossfade has two of these running at once
/// with different sample rates and different ReplayGain values.
struct Slot {
    track: WireTrack,
    stream: WireStream,
    decoder: Decoder,
    /// In-band title cell for a live stream; `None` for files and for stations
    /// that do not interleave metadata.
    icy: Option<Arc<IcyMetadata>>,
    resampler: Option<Resampler>,
    eq: Equalizer,
    replaygain: SmoothGain,
    /// Channel count the chain runs at. Equal to the device's channel count,
    /// except on a mono device where the source layout is preserved until
    /// `downmix_mono` folds it at the end of the master chain.
    chain_channels: usize,
    /// Processed samples produced but not yet consumed by the mixer.
    pending: Vec<f32>,
    decoder_done: bool,
    flushed: bool,
    started: bool,
    restream_reported: bool,
}

impl Slot {
    fn open(
        track: WireTrack,
        stream: WireStream,
        paths: &Paths,
        out_rate: u32,
        out_channels: usize,
    ) -> AppResult<Self> {
        let spec = source_spec(&stream);
        let opened = open_source(&spec, paths)?;
        Self::build(track, stream, opened, out_rate, out_channels)
    }

    fn build(
        track: WireTrack,
        stream: WireStream,
        opened: OpenedSource,
        out_rate: u32,
        out_channels: usize,
    ) -> AppResult<Self> {
        let OpenedSource { media, ext_hint, icy } = opened;
        // `open_source` resolved the extension against the real url or file it
        // ended up opening, which beats anything derivable from `stream` here.
        let ext_hint = ext_hint.map(|h| h.trim_start_matches('.').to_ascii_lowercase());
        let decoder = Decoder::open(media, ext_hint.as_deref(), stream.mime_type.as_deref())?;
        let dec_rate = decoder.sample_rate().max(1);
        let chain = chain_channels(decoder.channels().max(1), out_channels);

        Ok(Slot {
            track,
            stream,
            resampler: Resampler::new(dec_rate, out_rate, chain)?,
            eq: Equalizer::new(chain, out_rate),
            replaygain: SmoothGain::new(out_rate, GAIN_RAMP_MS),
            chain_channels: chain,
            decoder,
            icy,
            pending: Vec::new(),
            decoder_done: false,
            flushed: false,
            started: false,
            restream_reported: false,
        })
    }

    /// Rebuild everything that depends on the output format.
    fn reconfigure(&mut self, out_rate: u32, out_channels: usize) -> AppResult<()> {
        self.chain_channels = chain_channels(self.decoder.channels().max(1), out_channels);
        self.resampler = Resampler::new(
            self.decoder.sample_rate().max(1),
            out_rate,
            self.chain_channels,
        )?;
        self.eq.reconfigure(self.chain_channels, out_rate);
        self.replaygain = SmoothGain::new(out_rate, GAIN_RAMP_MS);
        self.pending.clear();
        self.flushed = false;
        Ok(())
    }

    fn apply_eq(&mut self, enabled: bool, gains: &[f32]) {
        self.eq.set_gains(gains);
        self.eq.set_enabled(enabled);
    }

    fn apply_replaygain(
        &mut self,
        enabled: bool,
        fallback_db: Option<f32>,
        preamp_db: f32,
        immediate: bool,
    ) {
        // Library metadata first, then whatever tags the file itself carries,
        // then the engine-wide fallback the controller pushed.
        let db = if enabled {
            self.track
                .gain_db
                .or_else(|| self.decoder.replaygain_db())
                .or(fallback_db)
                .unwrap_or(0.0)
                + preamp_db
        } else {
            0.0
        };
        if immediate {
            self.replaygain.set_immediate(db_to_linear(db));
        } else {
            self.replaygain.set_target_db(db);
        }
    }

    /// Decode → channel adapt → resample → EQ → ReplayGain. `Ok(None)` once both
    /// the decoder and the resampler tail are exhausted.
    fn next_processed(&mut self) -> AppResult<Option<Vec<f32>>> {
        loop {
            if self.decoder_done {
                if self.flushed {
                    return Ok(None);
                }
                self.flushed = true;
                let tail = match self.resampler.as_mut() {
                    Some(r) => r.flush()?,
                    None => Vec::new(),
                };
                if tail.is_empty() {
                    return Ok(None);
                }
                let mut buf = tail;
                self.eq.process(&mut buf);
                self.replaygain.process(&mut buf);
                return Ok(Some(buf));
            }

            let Some(chunk) = self.decoder.next_chunk()? else {
                self.decoder_done = true;
                continue;
            };
            if chunk.is_empty() {
                continue;
            }

            let source_channels = self.decoder.channels().max(1);
            let mut buf = adapt_channels(chunk, source_channels, self.chain_channels);
            if let Some(resampler) = self.resampler.as_mut() {
                let resampled = resampler.process(&buf)?;
                if resampled.is_empty() {
                    continue;
                }
                buf = resampled;
            }
            self.eq.process(&mut buf);
            self.replaygain.process(&mut buf);
            return Ok(Some(buf));
        }
    }

    /// Next block of at most `max_samples`, or `Ok(None)` at end of stream. The
    /// cap keeps one oversized decoder packet from filling the ring in a single
    /// `push`, which is what makes that push non-blocking in practice.
    fn next_block(&mut self, max_samples: usize) -> AppResult<Option<Vec<f32>>> {
        if self.pending.is_empty() {
            match self.next_processed()? {
                Some(block) => self.pending = block,
                None => return Ok(None),
            }
        }
        if self.pending.len() <= max_samples {
            return Ok(Some(std::mem::take(&mut self.pending)));
        }
        Ok(Some(self.pending.drain(..max_samples).collect()))
    }

    /// Exactly `samples` values, zero-padded past the end of the stream. The
    /// crossfader needs both sides framed identically.
    fn take_exact(&mut self, samples: usize) -> AppResult<Vec<f32>> {
        while self.pending.len() < samples {
            match self.next_processed()? {
                Some(mut block) => self.pending.append(&mut block),
                None => break,
            }
        }
        let n = samples.min(self.pending.len());
        let mut out: Vec<f32> = self.pending.drain(..n).collect();
        out.resize(samples, 0.0);
        Ok(out)
    }

    fn is_exhausted(&self) -> bool {
        self.decoder_done && self.flushed && self.pending.is_empty()
    }
}

struct Worker {
    paths: Paths,
    emit: EmitFn,
    shared: Arc<Shared>,
    tx: Sender<Cmd>,
    err_tx: Arc<Mutex<Sender<Cmd>>>,

    out: Option<Arc<Output>>,
    device_id: Option<String>,

    current: Option<Slot>,
    fading_out: Option<Slot>,
    next: Option<Slot>,
    crossfader: Option<Crossfader>,

    gain: Arc<MasterGain>,
    meter: BandMeter,
    meter_bins: usize,

    playing: bool,
    eq_enabled: bool,
    eq_gains: Vec<f32>,
    rg_enabled: bool,
    rg_gain_db: Option<f32>,
    rg_preamp_db: f32,
    crossfade_ms: u32,

    preload_generation: u64,
    stalled: bool,
    /// Set once the current track has reached its end or failed, so the loop
    /// stops decoding until a new `load`, `seek` or `play` arrives.
    halted: bool,
    last_progress: Instant,
    /// Last in-band title emitted, so an unchanged one is not re-sent 4×/s.
    last_stream_title: Option<String>,
    last_spectrum: Instant,
}

impl Worker {
    fn new(
        paths: Paths,
        emit: EmitFn,
        shared: Arc<Shared>,
        tx: Sender<Cmd>,
        err_tx: Arc<Mutex<Sender<Cmd>>>,
        gain: Arc<MasterGain>,
    ) -> Self {
        Worker {
            paths,
            emit,
            shared,
            tx,
            err_tx,
            out: None,
            device_id: None,
            current: None,
            fading_out: None,
            next: None,
            crossfader: None,
            gain,
            meter: BandMeter::new(2, 48_000, DEFAULT_BINS),
            meter_bins: DEFAULT_BINS,
            playing: false,
            eq_enabled: false,
            eq_gains: vec![0.0; EQ_BANDS],
            rg_enabled: false,
            rg_gain_db: None,
            rg_preamp_db: 0.0,
            crossfade_ms: 0,
            preload_generation: 0,
            stalled: false,
            halted: false,
            last_progress: Instant::now(),
            last_stream_title: None,
            last_spectrum: Instant::now(),
        }
    }

    fn run(&mut self, rx: Receiver<Cmd>) {
        if let Err(e) = self.ensure_output() {
            warn!(error = %e, "no audio output at startup; retrying on first playback");
        }

        loop {
            loop {
                match rx.try_recv() {
                    Ok(cmd) => {
                        if !self.handle(cmd) {
                            return;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            if self.current.is_none() {
                match rx.recv_timeout(IDLE_POLL) {
                    Ok(cmd) => {
                        if !self.handle(cmd) {
                            return;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                continue;
            }

            if let Err(e) = self.pump() {
                self.report_failure(e);
            }
            self.publish_position();
            self.tick();
        }
    }

    /// `false` means shut down.
    fn handle(&mut self, cmd: Cmd) -> bool {
        match cmd {
            Cmd::Load { track, stream, start_at_ms, autoplay } => {
                self.do_load(track, stream, start_at_ms, autoplay)
            }
            Cmd::Preload { track, stream } => self.do_preload(track, stream),
            Cmd::PreloadOpened { generation, track, stream, opened } => {
                self.do_preload_opened(generation, track, stream, opened)
            }
            Cmd::Play => self.do_play(),
            Cmd::Pause => self.do_pause(),
            Cmd::Stop => self.do_stop(),
            Cmd::Seek(position_ms) => self.do_seek(position_ms),
            Cmd::SetEqualizer { enabled, gains } => self.do_set_equalizer(enabled, gains),
            Cmd::SetReplayGain { enabled, gain_db, preamp_db } => {
                self.do_set_replaygain(enabled, gain_db, preamp_db)
            }
            Cmd::SetCrossfade(ms) => {
                self.crossfade_ms = ms;
                debug!(ms, "crossfade duration changed");
            }
            Cmd::SetDevice(id) => self.do_set_device(id),
            Cmd::DeviceFailed(message) => self.do_device_failed(message),
            Cmd::Shutdown => return false,
        }
        true
    }

    fn ensure_output(&mut self) -> AppResult<()> {
        if self.out.is_some() {
            return Ok(());
        }
        let out = Arc::new(Output::open(self.device_id.as_deref(), self.gain.clone())?);
        let err_tx = Arc::clone(&self.err_tx);
        out.set_error_handler(Box::new(move |message| {
            let _ = err_tx.lock().send(Cmd::DeviceFailed(message));
        }));
        out.set_paused(!self.playing);
        self.out = Some(out);
        self.reconfigure_chain()
    }

    fn reconfigure_chain(&mut self) -> AppResult<()> {
        let Some(out) = self.out.clone() else { return Ok(()) };
        let rate = out.sample_rate().max(1);
        let channels = out.channels().max(1);

        self.meter.reconfigure(channels, rate, self.meter_bins);

        let gains = self.eq_gains.clone();
        let eq_enabled = self.eq_enabled;
        let (rg_enabled, rg_gain_db, rg_preamp_db) =
            (self.rg_enabled, self.rg_gain_db, self.rg_preamp_db);

        let mut failure = None;
        for holder in [&mut self.current, &mut self.fading_out, &mut self.next] {
            let Some(slot) = holder.as_mut() else { continue };
            if let Err(e) = slot.reconfigure(rate, channels) {
                failure = Some(e);
                continue;
            }
            slot.apply_eq(eq_enabled, &gains);
            slot.apply_replaygain(rg_enabled, rg_gain_db, rg_preamp_db, true);
        }
        // A rate change invalidates the fade curve, so a fade in flight is cut.
        self.crossfader = None;
        self.fading_out = None;

        match failure {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn do_load(
        &mut self,
        track: WireTrack,
        stream: WireStream,
        start_at_ms: Option<u64>,
        autoplay: bool,
    ) {
        self.crossfader = None;
        self.fading_out = None;
        self.current = None;
        // Any preloaded slot belongs to the queue position we just left; the
        // controller re-issues `preload` right after every `load`.
        self.next = None;
        self.preload_generation = self.preload_generation.wrapping_add(1);
        self.stalled = false;
        self.halted = false;

        if let Some(out) = self.out.clone() {
            out.clear();
        }
        self.shared
            .position_ms
            .store(start_at_ms.unwrap_or(0), Ordering::Relaxed);
        self.shared.duration_ms.store(
            if track.is_live { 0 } else { track.duration_ms },
            Ordering::Relaxed,
        );
        self.shared.buffered_ms.store(0, Ordering::Relaxed);
        self.reset_spectrum();
        self.last_stream_title = None;

        if stream_expired(&stream) {
            info!(uri = %track.uri, "stream url already expired; requesting a fresh one");
            self.playing = false;
            self.emit(Event::NeedsRestream { track });
            return;
        }

        if let Err(e) = self.ensure_output() {
            self.playing = false;
            self.emit_error(e, Some(track));
            return;
        }
        let Some(out) = self.out.clone() else { return };

        let opened = Slot::open(
            track.clone(),
            stream,
            &self.paths,
            out.sample_rate(),
            out.channels(),
        );
        let mut slot = match opened {
            Ok(slot) => slot,
            Err(e) => {
                self.playing = false;
                out.set_paused(true);
                self.emit_error(e, Some(track));
                return;
            }
        };
        slot.apply_eq(self.eq_enabled, &self.eq_gains);
        slot.apply_replaygain(self.rg_enabled, self.rg_gain_db, self.rg_preamp_db, true);

        if let Some(ms) = start_at_ms.filter(|ms| *ms > 0) {
            if slot.track.is_live {
                debug!(uri = %slot.track.uri, "ignoring start offset on a live stream");
            } else if let Err(e) = slot.decoder.seek_ms(ms) {
                warn!(uri = %slot.track.uri, error = %e, "start offset seek failed");
            }
        }

        self.shared
            .duration_ms
            .store(slot_duration_ms(&slot), Ordering::Relaxed);
        info!(uri = %slot.track.uri, title = %slot.track.title, autoplay, "track loaded");
        self.current = Some(slot);
        self.playing = autoplay;
        out.set_paused(!autoplay);
        if autoplay {
            self.emit(Event::Playing);
        }
    }

    fn do_preload(&mut self, track: Option<WireTrack>, stream: Option<WireStream>) {
        self.preload_generation = self.preload_generation.wrapping_add(1);
        self.next = None;
        let (Some(track), Some(stream)) = (track, stream) else { return };
        if stream_expired(&stream) {
            self.emit(Event::NeedsRestream { track });
            return;
        }

        let generation = self.preload_generation;
        let paths = self.paths.clone();
        let tx = self.tx.clone();
        let uri = track.uri.clone();
        // Opening a remote source costs a TCP+TLS round trip. Doing that here
        // would stall the decode loop long enough to drain the ring.
        let spawned = std::thread::Builder::new()
            .name("ritmo-preload".to_string())
            .spawn(move || {
                let spec = source_spec(&stream);
                match open_source(&spec, &paths) {
                    Ok(opened) => {
                        let _ = tx.send(Cmd::PreloadOpened {
                            generation,
                            track,
                            stream,
                            opened,
                        });
                    }
                    Err(e) => debug!(uri = %uri, error = %e, "preload source failed to open"),
                }
            });
        if let Err(e) = spawned {
            warn!(error = %e, "cannot spawn the preload thread");
        }
    }

    fn do_preload_opened(
        &mut self,
        generation: u64,
        track: WireTrack,
        stream: WireStream,
        opened: OpenedSource,
    ) {
        if generation != self.preload_generation {
            return;
        }
        let Some(out) = self.out.clone() else { return };
        match Slot::build(track, stream, opened, out.sample_rate(), out.channels()) {
            Ok(mut slot) => {
                slot.apply_eq(self.eq_enabled, &self.eq_gains);
                slot.apply_replaygain(self.rg_enabled, self.rg_gain_db, self.rg_preamp_db, true);
                debug!(uri = %slot.track.uri, "next track is pre-decoded");
                self.next = Some(slot);
            }
            Err(e) => debug!(error = %e, "preload decoder failed to open"),
        }
    }

    fn do_play(&mut self) {
        if self.current.is_none() {
            return;
        }
        if let Err(e) = self.ensure_output() {
            let track = self.current.as_ref().map(|s| s.track.clone());
            self.emit_error(e, track);
            return;
        }
        // A retry after a transient failure should really retry, but a track that
        // ran to its natural end must not announce `ended` a second time.
        let exhausted = self.current.as_ref().is_some_and(|slot| slot.is_exhausted());
        if !exhausted {
            self.halted = false;
        }
        self.playing = true;
        if let Some(out) = self.out.clone() {
            out.set_paused(false);
        }
        self.emit(Event::Playing);
    }

    fn do_pause(&mut self) {
        self.playing = false;
        if let Some(out) = self.out.clone() {
            out.set_paused(true);
        }
        self.emit(Event::Paused);
    }

    fn do_stop(&mut self) {
        self.playing = false;
        self.crossfader = None;
        self.fading_out = None;
        self.current = None;
        self.stalled = false;
        self.halted = false;
        if let Some(out) = self.out.clone() {
            out.set_paused(true);
            out.clear();
        }
        self.shared.position_ms.store(0, Ordering::Relaxed);
        self.shared.duration_ms.store(0, Ordering::Relaxed);
        self.shared.buffered_ms.store(0, Ordering::Relaxed);
        self.reset_spectrum();
        self.last_stream_title = None;
        self.emit(Event::Stopped);
    }

    fn do_seek(&mut self, position_ms: u64) {
        let is_live = match self.current.as_ref() {
            Some(slot) => slot.track.is_live,
            None => return,
        };
        if is_live {
            debug!("seek ignored on a live stream");
            return;
        }

        self.crossfader = None;
        self.fading_out = None;
        self.stalled = false;
        self.halted = false;

        let rate = self.out.as_ref().map_or(48_000, |o| o.sample_rate().max(1));
        if let Some(out) = self.out.clone() {
            out.clear();
        }

        let mut failure = None;
        if let Some(slot) = self.current.as_mut() {
            slot.pending.clear();
            slot.decoder_done = false;
            slot.flushed = false;
            if let Err(e) = slot.decoder.seek_ms(position_ms) {
                failure = Some(e);
            } else {
                // The resampler carries a fractional-sample history that no
                // longer lines up with the new playhead.
                match Resampler::new(
                    slot.decoder.sample_rate().max(1),
                    rate,
                    slot.chain_channels,
                ) {
                    Ok(resampler) => slot.resampler = resampler,
                    Err(e) => failure = Some(e),
                }
            }
        }
        if let Some(e) = failure {
            let track = self.current.as_ref().map(|s| s.track.clone());
            self.emit_error(e, track);
            return;
        }

        self.shared.position_ms.store(position_ms, Ordering::Relaxed);
        self.shared.buffered_ms.store(0, Ordering::Relaxed);
        self.publish_progress();
    }

    fn do_set_equalizer(&mut self, enabled: bool, gains: Vec<f32>) {
        self.eq_enabled = enabled;
        if !gains.is_empty() {
            self.eq_gains = gains;
        }
        let gains = self.eq_gains.clone();
        for holder in [&mut self.current, &mut self.fading_out, &mut self.next] {
            if let Some(slot) = holder.as_mut() {
                slot.apply_eq(enabled, &gains);
            }
        }
    }

    fn do_set_replaygain(&mut self, enabled: bool, gain_db: Option<f32>, preamp_db: f32) {
        self.rg_enabled = enabled;
        self.rg_gain_db = gain_db;
        self.rg_preamp_db = preamp_db;
        // Audible slots ramp so the change is not a step; the preloaded one can
        // jump because nothing of it has been heard yet.
        if let Some(slot) = self.current.as_mut() {
            slot.apply_replaygain(enabled, gain_db, preamp_db, false);
        }
        if let Some(slot) = self.fading_out.as_mut() {
            slot.apply_replaygain(enabled, gain_db, preamp_db, false);
        }
        if let Some(slot) = self.next.as_mut() {
            slot.apply_replaygain(enabled, gain_db, preamp_db, true);
        }
    }

    fn do_set_device(&mut self, id: Option<String>) {
        let id = id.filter(|s| !s.is_empty());
        if id == self.device_id && self.out.is_some() {
            return;
        }
        info!(device = ?id, "switching audio output device");
        self.device_id = id;

        let resume_at = self.shared.position_ms.load(Ordering::Relaxed);
        if let Some(out) = self.out.take() {
            out.clear();
        }
        self.crossfader = None;
        self.fading_out = None;

        if let Err(e) = self.ensure_output() {
            self.playing = false;
            let track = self.current.as_ref().map(|s| s.track.clone());
            self.emit_error(e, track);
            return;
        }

        // Everything the old ring held is gone, so the decoder is now ahead of
        // what the listener actually heard. Rewind it to the reported playhead.
        let is_live = self.current.as_ref().map_or(false, |s| s.track.is_live);
        if !is_live {
            if let Some(slot) = self.current.as_mut() {
                slot.pending.clear();
                slot.decoder_done = false;
                slot.flushed = false;
                if let Err(e) = slot.decoder.seek_ms(resume_at) {
                    debug!(error = %e, "could not realign the decoder after a device switch");
                }
            }
        }
        self.shared.buffered_ms.store(0, Ordering::Relaxed);
    }

    fn do_device_failed(&mut self, message: String) {
        error!(message = %message, "audio device failed");
        self.playing = false;
        self.out = None;
        self.crossfader = None;
        self.fading_out = None;
        let track = self.current.as_ref().map(|s| s.track.clone());
        self.emit(Event::Error {
            error: PlaybackError { code: "device", message, retryable: true },
            track,
        });
    }

    fn pump(&mut self) -> AppResult<()> {
        let Some(out) = self.out.clone() else {
            std::thread::sleep(IDLE_POLL);
            return Ok(());
        };
        if self.halted {
            std::thread::sleep(IDLE_POLL);
            return Ok(());
        }

        let rate = out.sample_rate().max(1);
        let queued = queued_ms(&out, rate);
        if queued >= HIGH_WATER_MS {
            std::thread::sleep(if self.playing { BUSY_NAP } else { IDLE_POLL });
            return Ok(());
        }

        self.update_stall(&out, queued);

        if self.fading_out.is_some() {
            return self.pump_crossfade(&out);
        }
        if self.should_start_crossfade() {
            self.begin_crossfade(rate);
            if self.fading_out.is_some() {
                return self.pump_crossfade(&out);
            }
        }
        self.pump_normal(&out, rate)
    }

    fn update_stall(&mut self, out: &Output, queued: u64) {
        if !self.playing {
            return;
        }
        let draining = self.current.as_ref().map_or(false, |s| s.is_exhausted());
        if !self.stalled && queued == 0 && !draining {
            warn!(underruns = out.take_underruns(), "audio buffer ran dry");
            self.stalled = true;
            self.emit(Event::Stalled);
        } else if self.stalled && queued >= CANPLAY_MS {
            self.stalled = false;
            self.emit(Event::Canplay);
        }
    }

    fn should_start_crossfade(&self) -> bool {
        if self.crossfade_ms == 0 {
            return false;
        }
        let (Some(current), Some(next)) = (self.current.as_ref(), self.next.as_ref()) else {
            return false;
        };
        // Mixing two buffers only makes sense in one layout, and the layouts can
        // differ on a mono device. Falling through to the gapless path is the
        // graceful loss.
        if current.chain_channels != next.chain_channels || current.track.is_live {
            return false;
        }
        let duration = self.shared.duration_ms.load(Ordering::Relaxed);
        if duration == 0 {
            return false;
        }
        duration.saturating_sub(current.decoder.position_ms()) <= u64::from(self.crossfade_ms)
    }

    /// Commit to the next track: it becomes `current` immediately so position and
    /// duration reporting follow what the listener is being told is playing,
    /// while the outgoing track keeps sounding out of `fading_out`.
    fn begin_crossfade(&mut self, rate: u32) {
        let Some(mut incoming) = self.next.take() else { return };
        let Some(outgoing) = self.current.take() else {
            self.next = Some(incoming);
            return;
        };

        incoming.started = true;
        let track = incoming.track.clone();
        let duration = slot_duration_ms(&incoming);
        let channels = incoming.chain_channels.max(1);

        self.crossfader = Some(Crossfader::new(rate, channels, self.crossfade_ms));
        self.fading_out = Some(outgoing);
        self.current = Some(incoming);
        self.shared.duration_ms.store(duration, Ordering::Relaxed);

        info!(uri = %track.uri, ms = self.crossfade_ms, "crossfading into the next track");
        self.emit(Event::Ended { advanced_to: Some(track.clone()) });
        self.emit(Event::Started { track });
    }

    fn pump_crossfade(&mut self, out: &Output) -> AppResult<()> {
        let channels = self.current.as_ref().map(|slot| slot.chain_channels.max(1));
        let Some(channels) = channels else {
            self.finish_crossfade();
            return Ok(());
        };
        let frames = self.crossfader.as_ref().and_then(|cf| {
            let remaining = cf.remaining_frames().min(CHUNK_FRAMES);
            if cf.is_done() || remaining == 0 {
                None
            } else {
                Some(remaining)
            }
        });
        let Some(frames) = frames else {
            self.finish_crossfade();
            return Ok(());
        };

        let samples = frames * channels;
        let outgoing = match self.fading_out.as_mut() {
            Some(slot) => match slot.take_exact(samples) {
                Ok(buf) => buf,
                Err(e) => {
                    // The track being faded out is already on its way off; losing
                    // it is not worth interrupting the incoming one.
                    debug!(error = %e, "outgoing track failed mid-crossfade");
                    vec![0.0; samples]
                }
            },
            None => vec![0.0; samples],
        };
        let incoming = match self.current.as_mut() {
            Some(slot) => slot.take_exact(samples)?,
            None => vec![0.0; samples],
        };

        let mut mixed = Vec::with_capacity(samples);
        let finished = match self.crossfader.as_mut() {
            Some(cf) => cf.mix(&outgoing, &incoming, &mut mixed),
            None => true,
        };

        self.master(out, mixed, channels)?;
        if finished {
            self.finish_crossfade();
        }
        Ok(())
    }

    fn finish_crossfade(&mut self) {
        self.crossfader = None;
        if let Some(slot) = self.fading_out.take() {
            debug!(uri = %slot.track.uri, "crossfade complete");
        }
    }

    fn pump_normal(&mut self, out: &Output, rate: u32) -> AppResult<()> {
        let channels = match self.current.as_ref() {
            Some(slot) => slot.chain_channels.max(1),
            None => return Ok(()),
        };
        let block = match self.current.as_mut() {
            Some(slot) => slot.next_block(MAX_BLOCK_FRAMES * channels)?,
            None => return Ok(()),
        };

        match block {
            Some(buf) => {
                if !buf.is_empty() {
                    self.master(out, buf, channels)?;
                    self.mark_started();
                }
                Ok(())
            }
            None => {
                self.on_track_end(out, rate);
                Ok(())
            }
        }
    }

    fn mark_started(&mut self) {
        let track = match self.current.as_mut() {
            Some(slot) if !slot.started => {
                slot.started = true;
                slot.track.clone()
            }
            _ => return,
        };
        info!(uri = %track.uri, "playback started");
        self.emit(Event::Started { track });
    }

    fn on_track_end(&mut self, out: &Output, rate: u32) {
        if self.next.is_some() {
            self.advance_gapless();
            return;
        }
        if !self.playing {
            // Paused at the end of a track: the ring will never drain, so hold
            // the `ended` announcement until playback resumes.
            std::thread::sleep(IDLE_POLL);
            return;
        }
        if queued_ms(out, rate) > TAIL_MS {
            // Announcing the end now would let the next `load` clear audio the
            // listener has not heard yet.
            std::thread::sleep(BUSY_NAP);
            return;
        }

        self.halted = true;
        self.playing = false;
        self.stalled = false;
        out.set_paused(true);
        if let Some(slot) = self.current.as_ref() {
            info!(uri = %slot.track.uri, "track ended");
        }
        self.emit(Event::Ended { advanced_to: None });
    }

    fn advance_gapless(&mut self) {
        let Some(mut incoming) = self.next.take() else { return };
        incoming.started = true;
        let track = incoming.track.clone();
        let duration = slot_duration_ms(&incoming);

        // Deliberately no `Output::clear()`: the ring still holds the tail of the
        // previous track and the new samples queue up right behind it.
        self.current = Some(incoming);
        self.shared.duration_ms.store(duration, Ordering::Relaxed);

        info!(uri = %track.uri, "gapless advance");
        self.emit(Event::Ended { advanced_to: Some(track.clone()) });
        self.emit(Event::Started { track });
    }

    fn master(&mut self, out: &Output, mut buf: Vec<f32>, chain_channels: usize) -> AppResult<()> {
        if out.channels() == 1 && chain_channels > 1 {
            downmix_mono(&mut buf, chain_channels);
        }
        soft_clip(&mut buf);
        self.feed_meter(out, &buf);
        out.push(&buf)
    }

    fn feed_meter(&mut self, out: &Output, buf: &[f32]) {
        let wanted = self.shared.spectrum_bins.load(Ordering::Relaxed).clamp(1, 1024);
        if wanted != self.meter_bins {
            self.meter_bins = wanted;
            self.meter
                .reconfigure(out.channels().max(1), out.sample_rate().max(1), wanted);
        }
        self.meter.feed(buf);
        // The visualiser cannot show more than display rate, and `magnitudes`
        // allocates, so snapshot at ~30 Hz rather than per chunk.
        if self.last_spectrum.elapsed() >= SPECTRUM_EVERY {
            self.last_spectrum = Instant::now();
            let magnitudes = self.meter.magnitudes();
            *self.shared.spectrum.lock() = magnitudes;
        }
    }

    fn publish_position(&self) {
        let Some(out) = self.out.as_ref() else { return };
        let rate = out.sample_rate().max(1);
        let buffered = queued_ms(out, rate);
        self.shared.buffered_ms.store(buffered, Ordering::Relaxed);

        let Some(slot) = self.current.as_ref() else { return };
        if slot.track.is_live {
            self.shared.duration_ms.store(0, Ordering::Relaxed);
            self.shared
                .position_ms
                .store(slot.decoder.position_ms(), Ordering::Relaxed);
            return;
        }
        // The decoder always runs ahead of the speaker by whatever is still
        // queued, so subtract it to get the position actually being heard.
        let heard = slot.decoder.position_ms().saturating_sub(buffered);
        let duration = self.shared.duration_ms.load(Ordering::Relaxed);
        let position = if duration > 0 { heard.min(duration) } else { heard };
        self.shared.position_ms.store(position, Ordering::Relaxed);
    }

    fn tick(&mut self) {
        if self.current.is_none() || self.last_progress.elapsed() < PROGRESS_EVERY {
            return;
        }
        self.check_expiry();
        self.publish_progress();
    }

    /// A url can go stale while it is still playing. Telling the controller early
    /// lets it resolve a replacement before the CDN actually starts refusing
    /// reads, so playback is not interrupted at all.
    fn check_expiry(&mut self) {
        let expired = self.current.as_ref().is_some_and(|slot| {
            slot.stream.local_path.is_none()
                && !slot.restream_reported
                && stream_expired(&slot.stream)
        });
        if !expired {
            return;
        }
        if let Some(slot) = self.current.as_mut() {
            slot.restream_reported = true;
        }
        if let Some(track) = self.current.as_ref().map(|slot| slot.track.clone()) {
            info!(uri = %track.uri, "stream url expired during playback");
            self.emit(Event::NeedsRestream { track });
        }
    }

    fn publish_progress(&mut self) {
        self.last_progress = Instant::now();
        self.publish_stream_title();
        self.emit(Event::Progress {
            position_ms: self.shared.position_ms.load(Ordering::Relaxed),
            duration_ms: self.shared.duration_ms.load(Ordering::Relaxed),
            buffered_ms: self.shared.buffered_ms.load(Ordering::Relaxed),
        });
    }

    fn publish_stream_title(&mut self) {
        // ICY metadata is the live-stream answer; the container-level title is
        // the only one a file or a Vorbis chain can offer.
        let title = match self.current.as_mut() {
            Some(slot) => match slot.icy.as_ref().and_then(|icy| icy.take_if_changed()) {
                Some(title) => Some(title),
                None => slot.decoder.stream_title(),
            },
            None => None,
        };
        let Some(title) = title else { return };
        let title = title.trim().to_string();
        if title.is_empty() || self.last_stream_title.as_deref() == Some(title.as_str()) {
            return;
        }
        self.last_stream_title = Some(title.clone());
        self.emit(Event::StreamTitle { title });
    }

    fn reset_spectrum(&mut self) {
        let bins = self.meter_bins;
        *self.shared.spectrum.lock() = vec![0.0; bins];
    }

    fn report_failure(&mut self, e: AppError) {
        self.playing = false;
        // Stop pumping this track: a decoder that failed once will keep failing,
        // and re-reporting it every 5 ms would flood the frontend.
        self.halted = true;
        if let Some(out) = self.out.clone() {
            out.set_paused(true);
        }

        if needs_restream(&e) {
            let already = self
                .current
                .as_ref()
                .map_or(true, |slot| slot.restream_reported);
            if let Some(slot) = self.current.as_mut() {
                slot.restream_reported = true;
            }
            if !already {
                if let Some(track) = self.current.as_ref().map(|s| s.track.clone()) {
                    warn!(uri = %track.uri, error = %e, "stream url rejected mid-playback");
                    self.emit(Event::NeedsRestream { track });
                }
            }
            return;
        }

        // A dead device has to be re-opened rather than reused.
        if matches!(e, AppError::Audio(_) | AppError::NoDevice) {
            self.out = None;
        }
        let track = self.current.as_ref().map(|s| s.track.clone());
        self.emit_error(e, track);
    }

    fn emit_error(&self, e: AppError, track: Option<WireTrack>) {
        let (code, retryable) = classify(&e);
        error!(error = %e, code, "playback failed");
        self.emit(Event::Error {
            error: PlaybackError { code, message: e.to_string(), retryable },
            track,
        });
    }

    fn emit(&self, event: Event) {
        match serde_json::to_value(&event) {
            Ok(payload) => (self.emit)(events::AUDIO, payload),
            Err(e) => error!(error = %e, "cannot serialise an engine event"),
        }
    }
}

fn slot_duration_ms(slot: &Slot) -> u64 {
    if slot.track.is_live {
        0
    } else {
        slot.decoder
            .duration_ms()
            .unwrap_or(slot.track.duration_ms)
    }
}

fn queued_ms(out: &Output, rate: u32) -> u64 {
    out.queued_frames() as u64 * 1_000 / u64::from(rate.max(1))
}

fn source_spec(stream: &WireStream) -> SourceSpec {
    SourceSpec {
        url: stream.url.clone(),
        local_path: stream.local_path.clone(),
        headers: stream.headers.clone(),
        mime: stream.mime_type.clone(),
    }
}

fn stream_expired(stream: &WireStream) -> bool {
    match stream.expires_at {
        Some(at) => at <= chrono::Utc::now().timestamp_millis(),
        None => false,
    }
}

/// A signed CDN url that went stale comes back as 401/403, which is a request to
/// re-resolve the stream rather than a playback failure.
fn needs_restream(e: &AppError) -> bool {
    let AppError::Http(message) = e else { return false };
    let message = message.to_ascii_lowercase();
    message.contains("403")
        || message.contains("401")
        || message.contains("forbidden")
        || message.contains("expired")
}

/// `PlaybackError.code` from `packages/core/src/types.ts`, plus whether retrying
/// the same track could plausibly work.
fn classify(e: &AppError) -> (&'static str, bool) {
    match e {
        AppError::NotFound(_) => ("not_found", false),
        AppError::Http(_) => ("network", true),
        AppError::Decode(_) => ("decode", false),
        AppError::Audio(_) | AppError::NoDevice => ("device", true),
        AppError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => ("not_found", false),
        AppError::Io(_) => ("unknown", true),
        AppError::BadRequest(_) | AppError::Cancelled | AppError::Db(_) => ("unknown", false),
        AppError::Other(_) => ("unknown", true),
    }
}

/// A mono device is the one case where the source layout survives the chain, so
/// `downmix_mono` can fold it after the gain stages instead of throwing away
/// channels before the EQ has seen them.
fn chain_channels(decoder_channels: usize, out_channels: usize) -> usize {
    if out_channels == 1 && decoder_channels > 1 {
        decoder_channels
    } else {
        out_channels.max(1)
    }
}

fn adapt_channels(buf: Vec<f32>, from: usize, to: usize) -> Vec<f32> {
    if from == to || from == 0 || to == 0 {
        return buf;
    }
    let frames = buf.len() / from;
    let mut out = Vec::with_capacity(frames * to);
    for frame in 0..frames {
        let base = frame * from;
        if from == 1 {
            let sample = buf.get(base).copied().unwrap_or(0.0);
            out.extend(std::iter::repeat(sample).take(to));
        } else if to == 1 {
            let mut sum = 0.0f32;
            for channel in 0..from {
                sum += buf.get(base + channel).copied().unwrap_or(0.0);
            }
            out.push(sum / from as f32);
        } else {
            // Fold or wrap: the first `min(from, to)` channels pass through and a
            // wider device gets them repeated rather than fed silence.
            for channel in 0..to {
                out.push(buf.get(base + channel % from).copied().unwrap_or(0.0));
            }
        }
    }
    out
}

fn db_to_linear(db: f32) -> f32 {
    10.0f32.powf(db / 20.0)
}

