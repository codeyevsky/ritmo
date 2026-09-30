//! cpal output stage.
//!
//! The device callback is the only real-time thread in the process, so it does
//! exactly one thing: lock the ring, memcpy/convert out of it, unlock. Every
//! decision (what to play, how loud, when to stop) is made by the engine thread
//! and reaches the callback as plain data.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use parking_lot::{Condvar, Mutex, RwLock};
use serde::Serialize;
use tracing::{debug, warn};

use crate::error::{AppError, AppResult};

/// Seconds of audio the ring can hold. Enough to ride out a stuttering HTTP
/// read, short enough that a seek does not discard much decoding work.
const BUFFER_SECS: usize = 2;

/// How long `push` waits for the callback to free space before it gives up and
/// reports the device as dead. Only reachable if the backend stopped pulling.
const PUSH_TIMEOUT: Duration = Duration::from_secs(2);

/// Samples appended per lock acquisition. Keeping this well under one buffer
/// means the callback never waits more than a few microseconds on the producer.
const PUSH_SLICE: usize = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

type ErrorHandler = Box<dyn Fn(String) + Send + Sync>;

struct Ring {
    buf: VecDeque<f32>,
    /// Bumped by `clear`. A `push` blocked waiting for space compares the epoch
    /// it started with and abandons the rest of its buffer if it changed, so a
    /// seek can never append stale audio behind the new playhead.
    epoch: u64,
}

/// Master gain, shared between the caller and the device callback.
///
/// Lives outside `Output` so a volume or mute change never has to reach the
/// decode thread: the callback applies it after the ring buffer, so it is
/// audible within one device period no matter how much audio is already queued.
#[derive(Debug)]
pub struct MasterGain {
    /// Target level as `f32::to_bits`.
    target_bits: AtomicU32,
    muted: AtomicBool,
    /// Ramp state, touched only by the callback.
    current_bits: AtomicU32,
}

impl Default for MasterGain {
    fn default() -> Self {
        Self {
            target_bits: AtomicU32::new(1.0f32.to_bits()),
            muted: AtomicBool::new(false),
            current_bits: AtomicU32::new(1.0f32.to_bits()),
        }
    }
}

impl MasterGain {
    /// 0..1 linear, already perceptually tapered by the caller.
    pub fn set_level(&self, level: f32) {
        self.target_bits
            .store(level.clamp(0.0, 4.0).to_bits(), Ordering::Relaxed);
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    fn target(&self) -> f32 {
        if self.muted.load(Ordering::Relaxed) {
            0.0
        } else {
            f32::from_bits(self.target_bits.load(Ordering::Relaxed))
        }
    }

    /// Per-sample step that reaches the target in roughly `RAMP_MS`, so a jump
    /// to silence does not click.
    fn ramp_step(sample_rate: u32, channels: usize) -> f32 {
        const RAMP_MS: f32 = 12.0;
        let frames = (sample_rate as f32 * RAMP_MS / 1000.0).max(1.0);
        1.0 / (frames * channels.max(1) as f32)
    }

    fn advance(&self, current: f32, target: f32, step: f32) -> f32 {
        if (current - target).abs() <= step {
            target
        } else if current < target {
            current + step
        } else {
            current - step
        }
    }
}

struct Shared {
    ring: Mutex<Ring>,
    gain: Arc<MasterGain>,
    /// Needed by the callback to size the gain ramp.
    sample_rate: u32,
    channels: usize,
    /// Signalled by the callback after it has taken samples out of the ring.
    space: Condvar,
    capacity: usize,
    paused: AtomicBool,
    underruns: AtomicU64,
    on_error: RwLock<Option<ErrorHandler>>,
}

pub struct Output {
    shared: Arc<Shared>,
    /// Dropping the stream stops the device; nothing else touches it.
    _stream: cpal::Stream,
    sample_rate: u32,
    channels: usize,
}

impl Output {
    pub fn open(device_id: Option<&str>, gain: Arc<MasterGain>) -> AppResult<Self> {
        let host = cpal::default_host();
        let device = find_device(&host, device_id)?;
        let name = device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "<unnamed>".to_string());

        let supported = choose_config(&device)?;
        let sample_format = supported.sample_format();
        let sample_rate = supported.sample_rate();
        let channels = usize::from(supported.channels());
        if sample_rate == 0 || channels == 0 {
            return Err(AppError::Audio(format!(
                "device \"{name}\" reported an unusable config ({sample_rate} Hz, {channels} ch)"
            )));
        }

        let shared = Arc::new(Shared {
            ring: Mutex::new(Ring {
                buf: VecDeque::with_capacity(sample_rate as usize * channels * BUFFER_SECS),
                epoch: 0,
            }),
            gain,
            sample_rate,
            channels,
            space: Condvar::new(),
            capacity: sample_rate as usize * channels * BUFFER_SECS,
            paused: AtomicBool::new(true),
            underruns: AtomicU64::new(0),
            on_error: RwLock::new(None),
        });

        let err_shared = Arc::clone(&shared);
        let err_fn = move |e: cpal::StreamError| {
            // Underruns are a glitch report, not a device failure — surfacing
            // them as one would tear down playback on every hiccup.
            if matches!(e, cpal::StreamError::BufferUnderrun) {
                debug!("cpal reported a buffer underrun");
                return;
            }
            warn!(error = %e, "audio output stream failed");
            if let Some(handler) = err_shared.on_error.read().as_ref() {
                handler(e.to_string());
            }
        };

        let config = supported.config();
        let stream = match sample_format {
            SampleFormat::F32 => build_stream::<f32, _>(&device, &config, &shared, err_fn),
            SampleFormat::F64 => build_stream::<f64, _>(&device, &config, &shared, err_fn),
            SampleFormat::I8 => build_stream::<i8, _>(&device, &config, &shared, err_fn),
            SampleFormat::I16 => build_stream::<i16, _>(&device, &config, &shared, err_fn),
            SampleFormat::I24 => build_stream::<cpal::I24, _>(&device, &config, &shared, err_fn),
            SampleFormat::I32 => build_stream::<i32, _>(&device, &config, &shared, err_fn),
            SampleFormat::I64 => build_stream::<i64, _>(&device, &config, &shared, err_fn),
            SampleFormat::U8 => build_stream::<u8, _>(&device, &config, &shared, err_fn),
            SampleFormat::U16 => build_stream::<u16, _>(&device, &config, &shared, err_fn),
            SampleFormat::U24 => build_stream::<cpal::U24, _>(&device, &config, &shared, err_fn),
            SampleFormat::U32 => build_stream::<u32, _>(&device, &config, &shared, err_fn),
            SampleFormat::U64 => build_stream::<u64, _>(&device, &config, &shared, err_fn),
            other => {
                return Err(AppError::Audio(format!(
                    "device \"{name}\" only offers the unsupported sample format {other}"
                )))
            }
        }
        .map_err(|e| AppError::Audio(format!("cannot open \"{name}\": {e}")))?;

        stream
            .play()
            .map_err(|e| AppError::Audio(format!("cannot start \"{name}\": {e}")))?;

        debug!(
            device = %name,
            sample_rate,
            channels,
            format = %sample_format,
            "audio output opened"
        );

        Ok(Output { shared, _stream: stream, sample_rate, channels })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Appends interleaved `f32`. Blocks while the ring is full so the decoder
    /// thread is paced by the device instead of growing an unbounded queue.
    pub fn push(&self, frames: &[f32]) -> AppResult<()> {
        if frames.is_empty() {
            return Ok(());
        }
        let deadline = Instant::now() + PUSH_TIMEOUT;
        let epoch = self.shared.ring.lock().epoch;
        let mut written = 0usize;

        while written < frames.len() {
            let mut ring = self.shared.ring.lock();
            if ring.epoch != epoch {
                return Ok(());
            }
            let mut room = self.shared.capacity.saturating_sub(ring.buf.len());
            while room == 0 {
                if self.shared.space.wait_until(&mut ring, deadline).timed_out() {
                    return Err(AppError::Audio(
                        "audio device stopped consuming samples".to_string(),
                    ));
                }
                if ring.epoch != epoch {
                    return Ok(());
                }
                room = self.shared.capacity.saturating_sub(ring.buf.len());
            }
            let take = room.min(PUSH_SLICE).min(frames.len() - written);
            if let Some(chunk) = frames.get(written..written + take) {
                ring.buf.extend(chunk.iter().copied());
            }
            written += take;
        }
        Ok(())
    }

    pub fn set_paused(&self, paused: bool) {
        self.shared.paused.store(paused, Ordering::Relaxed);
        if !paused {
            // The callback only signals after draining, so a producer parked
            // while we were paused needs a nudge to re-check.
            self.shared.space.notify_all();
        }
    }

    /// Frames (not samples) still waiting for the device.
    pub fn queued_frames(&self) -> usize {
        self.shared.ring.lock().buf.len() / self.channels.max(1)
    }

    pub fn clear(&self) {
        {
            let mut ring = self.shared.ring.lock();
            ring.buf.clear();
            ring.epoch = ring.epoch.wrapping_add(1);
        }
        self.shared.space.notify_all();
    }

    /// Number of callbacks that ran short since the last call, reset to zero.
    pub fn take_underruns(&self) -> u64 {
        self.shared.underruns.swap(0, Ordering::Relaxed)
    }

    /// Fires when the cpal stream errors, e.g. the device was unplugged.
    pub fn set_error_handler(&self, f: Box<dyn Fn(String) + Send + Sync>) {
        *self.shared.on_error.write() = Some(f);
    }

    pub fn list_devices() -> Vec<DeviceInfo> {
        let host = cpal::default_host();
        let default_id = host
            .default_output_device()
            .and_then(|d| d.id().ok())
            .map(|id| id.to_string());

        let devices = match host.output_devices() {
            Ok(d) => d,
            Err(e) => {
                warn!(error = %e, "cannot enumerate audio output devices");
                return Vec::new();
            }
        };

        let mut out = Vec::new();
        for device in devices {
            let Ok(id) = device.id() else { continue };
            let id = id.to_string();
            let name = device
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|_| id.clone());
            let is_default = default_id.as_deref() == Some(id.as_str());
            out.push(DeviceInfo { id, name, is_default });
        }
        out
    }
}

fn build_stream<T, E>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    shared: &Arc<Shared>,
    on_error: E,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
    E: FnMut(cpal::StreamError) + Send + 'static,
{
    let shared = Arc::clone(shared);
    device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| drain_into(&shared, data),
        on_error,
        None,
    )
}

#[inline]
fn silence<T: Sample>() -> T {
    T::EQUILIBRIUM
}

/// The real-time path. No allocation, no logging, no second lock.
fn drain_into<T>(shared: &Shared, data: &mut [T])
where
    T: SizedSample + FromSample<f32>,
{
    if shared.paused.load(Ordering::Relaxed) {
        data.fill(silence::<T>());
        return;
    }

    let target = shared.gain.target();
    let step = MasterGain::ramp_step(shared.sample_rate, shared.channels);
    let mut gain = f32::from_bits(shared.gain.current_bits.load(Ordering::Relaxed));

    let want = data.len();
    let filled;
    {
        let mut ring = shared.ring.lock();
        let avail = ring.buf.len().min(want);
        let (front, back) = ring.buf.as_slices();
        let n_front = front.len().min(avail);
        if let (Some(dst), Some(src)) = (data.get_mut(..n_front), front.get(..n_front)) {
            for (d, s) in dst.iter_mut().zip(src.iter().copied()) {
                gain = shared.gain.advance(gain, target, step);
                *d = T::from_sample_((s * gain).clamp(-1.0, 1.0));
            }
        }
        let n_back = avail - n_front;
        if n_back > 0 {
            if let (Some(dst), Some(src)) = (data.get_mut(n_front..avail), back.get(..n_back)) {
                for (d, s) in dst.iter_mut().zip(src.iter().copied()) {
                    gain = shared.gain.advance(gain, target, step);
                *d = T::from_sample_((s * gain).clamp(-1.0, 1.0));
                }
            }
        }
        ring.buf.drain(..avail);
        shared.gain.current_bits.store(gain.to_bits(), Ordering::Relaxed);
        filled = avail;
    }

    if filled < want {
        if let Some(tail) = data.get_mut(filled..) {
            tail.fill(silence::<T>());
        }
        shared.underruns.fetch_add(1, Ordering::Relaxed);
    }
    shared.space.notify_all();
}

fn find_device(host: &cpal::Host, wanted: Option<&str>) -> AppResult<cpal::Device> {
    if let Some(wanted) = wanted.filter(|w| !w.is_empty()) {
        if let Ok(parsed) = wanted.parse::<cpal::DeviceId>() {
            if let Some(device) = host.device_by_id(&parsed) {
                return Ok(device);
            }
        }
        // A persisted setting may predate a host switch or a driver rename, so
        // fall back to matching the human-readable name before giving up.
        if let Ok(devices) = host.output_devices() {
            for device in devices {
                let by_name = device
                    .description()
                    .ok()
                    .is_some_and(|d| d.name() == wanted);
                if by_name {
                    return Ok(device);
                }
            }
        }
        warn!(device = wanted, "requested audio device is gone, using the default");
    }
    host.default_output_device().ok_or(AppError::NoDevice)
}

/// Lower is better: sample format dominates, then distance from stereo, then
/// whether we can keep the device's own rate (resampling costs us CPU).
fn config_score(range: &cpal::SupportedStreamConfigRange, exact_rate: bool) -> Option<u32> {
    let format = match range.sample_format() {
        SampleFormat::F32 => 0,
        SampleFormat::I16 => 1,
        SampleFormat::U16 => 2,
        SampleFormat::I32 => 3,
        SampleFormat::F64 => 4,
        SampleFormat::I24 => 5,
        SampleFormat::U24 => 6,
        SampleFormat::I8 => 7,
        SampleFormat::U8 => 8,
        SampleFormat::U32 => 9,
        SampleFormat::I64 => 10,
        SampleFormat::U64 => 11,
        // DSD and anything added to the enum later: we have no converter.
        _ => return None,
    };
    let channel_penalty = i32::from(range.channels()).saturating_sub(2).unsigned_abs();
    Some(format * 1000 + channel_penalty * 10 + u32::from(!exact_rate))
}

fn choose_config(device: &cpal::Device) -> AppResult<cpal::SupportedStreamConfig> {
    let default = device.default_output_config().ok();
    let preferred_rate = default.as_ref().map_or(48_000, |c| c.sample_rate());

    let ranges = device
        .supported_output_configs()
        .map_err(|e| AppError::Audio(format!("cannot query output configs: {e}")))?;

    let mut best: Option<(u32, cpal::SupportedStreamConfig)> = None;
    for range in ranges {
        let rate = preferred_rate.clamp(range.min_sample_rate(), range.max_sample_rate());
        let Some(score) = config_score(&range, rate == preferred_rate) else { continue };
        let Some(config) = range.try_with_sample_rate(rate) else { continue };
        if best.as_ref().map_or(true, |(best_score, _)| score < *best_score) {
            best = Some((score, config));
        }
    }

    if let Some((_, config)) = best {
        return Ok(config);
    }
    default.ok_or_else(|| AppError::Audio("device exposes no usable output config".to_string()))
}
