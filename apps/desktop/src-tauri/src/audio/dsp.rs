//! Sample-domain primitives for the playback graph: EQ, gain smoothing,
//! resampling, crossfade and the visualiser meter.
//!
//! Everything here works on interleaved `f32` and is allocation-free on the hot
//! path (the resampler is the exception — rubato needs staging buffers).

use rubato::audioadapter::{Adapter, AdapterMut};
use rubato::{
    Async, FixedAsync, Indexing, Resampler as RubatoResampler, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};

use crate::error::{AppError, AppResult};

/// Centre frequencies of the graphic EQ, mirroring `EQ_BANDS` in
/// `packages/core/src/types.ts`. The two sides must stay in lockstep.
pub const EQ_BANDS: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

const MAX_GAIN_DB: f32 = 12.0;

/// Bands sit roughly one octave apart, and for a peaking filter spanning `n`
/// octaves `Q = sqrt(2^n) / (2^n - 1)`, which is `sqrt(2)` at `n = 1`.
const BAND_Q: f64 = std::f64::consts::SQRT_2;

/// Filters whose centre sits this close to Nyquist are bypassed: the bilinear
/// transform warps them into uselessness and the coefficients get unstable.
const NYQUIST_GUARD: f64 = 0.45;

#[derive(Clone, Copy, Debug)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    const IDENTITY: Biquad = Biquad { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };

    /// RBJ audio-EQ-cookbook peaking filter.
    fn peaking(freq: f64, sample_rate: f64, q: f64, gain_db: f64) -> Self {
        if sample_rate <= 0.0 || q <= 0.0 {
            return Self::IDENTITY;
        }
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / (2.0 * q);

        let a0 = 1.0 + alpha / a;
        if a0 == 0.0 || !a0.is_finite() {
            return Self::IDENTITY;
        }
        Biquad {
            b0: (1.0 + alpha * a) / a0,
            b1: (-2.0 * cos_w0) / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: (-2.0 * cos_w0) / a0,
            a2: (1.0 - alpha / a) / a0,
        }
    }

    /// RBJ constant-0 dB-peak-gain band-pass, used by the meter's filter bank.
    fn bandpass(freq: f64, sample_rate: f64, q: f64) -> Self {
        if sample_rate <= 0.0 || q <= 0.0 {
            return Self::IDENTITY;
        }
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / (2.0 * q);

        let a0 = 1.0 + alpha;
        if a0 == 0.0 || !a0.is_finite() {
            return Self::IDENTITY;
        }
        Biquad {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: (-2.0 * cos_w0) / a0,
            a2: (1.0 - alpha) / a0,
        }
    }

    /// Transposed direct form II — fewest state words, best numerical behaviour
    /// of the direct forms for low centre frequencies.
    #[inline]
    fn step(&self, x: f64, s: &mut [f64; 2]) -> f64 {
        let y = self.b0 * x + s[0];
        s[0] = self.b1 * x - self.a1 * y + s[1];
        s[1] = self.b2 * x - self.a2 * y;
        y
    }
}

struct EqBand {
    coeffs: Biquad,
    active: bool,
    state: Vec<[f64; 2]>,
}

/// Cascaded peaking biquads on the ten [`EQ_BANDS`].
pub struct Equalizer {
    channels: usize,
    sample_rate: u32,
    enabled: bool,
    gains: [f32; EQ_BANDS.len()],
    bands: Vec<EqBand>,
}

impl Equalizer {
    pub fn new(channels: usize, sample_rate: u32) -> Self {
        let mut eq = Equalizer {
            channels: channels.max(1),
            sample_rate: sample_rate.max(1),
            enabled: false,
            gains: [0.0; EQ_BANDS.len()],
            bands: Vec::with_capacity(EQ_BANDS.len()),
        };
        eq.rebuild(true);
        eq
    }

    pub fn set_enabled(&mut self, on: bool) {
        if self.enabled == on {
            return;
        }
        self.enabled = on;
        // Stale filter memory would pop back in on re-enable.
        self.reset_state();
    }

    /// dB per band, len 10. Values outside ±12 dB are clamped.
    pub fn set_gains(&mut self, gains: &[f32]) {
        for (i, slot) in self.gains.iter_mut().enumerate() {
            let g = gains.get(i).copied().unwrap_or(0.0);
            *slot = if g.is_finite() { g.clamp(-MAX_GAIN_DB, MAX_GAIN_DB) } else { 0.0 };
        }
        self.rebuild(false);
    }

    pub fn reconfigure(&mut self, channels: usize, sample_rate: u32) {
        let channels = channels.max(1);
        let sample_rate = sample_rate.max(1);
        if channels == self.channels && sample_rate == self.sample_rate {
            return;
        }
        self.channels = channels;
        self.sample_rate = sample_rate;
        self.rebuild(true);
    }

    /// In place, interleaved.
    pub fn process(&mut self, buf: &mut [f32]) {
        if !self.enabled || buf.is_empty() {
            return;
        }
        let channels = self.channels;
        for band in self.bands.iter_mut() {
            if !band.active {
                continue;
            }
            for frame in buf.chunks_mut(channels) {
                for (ch, sample) in frame.iter_mut().enumerate() {
                    let Some(state) = band.state.get_mut(ch) else { continue };
                    *sample = band.coeffs.step(f64::from(*sample), state) as f32;
                }
            }
        }
    }

    fn rebuild(&mut self, reset_state: bool) {
        let sr = f64::from(self.sample_rate);
        let limit = sr * NYQUIST_GUARD;
        if self.bands.len() != EQ_BANDS.len() {
            self.bands.clear();
            for _ in 0..EQ_BANDS.len() {
                self.bands.push(EqBand {
                    coeffs: Biquad::IDENTITY,
                    active: false,
                    state: vec![[0.0; 2]; self.channels],
                });
            }
        }
        for (i, band) in self.bands.iter_mut().enumerate() {
            let freq = f64::from(EQ_BANDS.get(i).copied().unwrap_or(0.0));
            let gain = f64::from(self.gains.get(i).copied().unwrap_or(0.0));
            let usable = freq > 0.0 && freq < limit;
            band.active = usable && gain.abs() > 1e-3;
            band.coeffs = if band.active {
                Biquad::peaking(freq, sr, BAND_Q, gain)
            } else {
                Biquad::IDENTITY
            };
            if reset_state || band.state.len() != self.channels {
                band.state.clear();
                band.state.resize(self.channels, [0.0; 2]);
            }
        }
    }

    fn reset_state(&mut self) {
        for band in self.bands.iter_mut() {
            for s in band.state.iter_mut() {
                *s = [0.0; 2];
            }
        }
    }
}

/// One-pole smoothed gain — prevents zipper noise on volume/ReplayGain changes.
pub struct SmoothGain {
    current: f32,
    target: f32,
    coeff: f32,
}

impl SmoothGain {
    pub fn new(sample_rate: u32, ramp_ms: f32) -> Self {
        let sr = (sample_rate.max(1) as f32).max(1.0);
        let ramp_s = if ramp_ms.is_finite() { (ramp_ms / 1000.0).max(0.0) } else { 0.0 };
        let coeff = if ramp_s <= 0.0 { 1.0 } else { 1.0 - (-1.0 / (ramp_s * sr)).exp() };
        SmoothGain { current: 1.0, target: 1.0, coeff: coeff.clamp(1e-6, 1.0) }
    }

    pub fn set_target_linear(&mut self, g: f32) {
        self.target = if g.is_finite() { g.max(0.0) } else { 0.0 };
    }

    pub fn set_target_db(&mut self, db: f32) {
        let linear = if db.is_finite() { 10f32.powf(db / 20.0) } else { 1.0 };
        self.set_target_linear(linear);
    }

    pub fn set_immediate(&mut self, g: f32) {
        self.set_target_linear(g);
        self.current = self.target;
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        if (self.current - self.target).abs() <= 1e-6 {
            self.current = self.target;
            if (self.current - 1.0).abs() > 1e-6 {
                let g = self.current;
                for s in buf.iter_mut() {
                    *s *= g;
                }
            }
            return;
        }
        for s in buf.iter_mut() {
            self.current += (self.target - self.current) * self.coeff;
            *s *= self.current;
        }
    }
}

/// Number of input frames handed to rubato per pass.
const RESAMPLE_CHUNK: usize = 1024;

/// Read adapter over an interleaved slice. rubato 1.0 talks `audioadapter`
/// buffers and the concrete buffer types live in a crate we do not depend on,
/// so the two adapters it needs are implemented here.
struct InterleavedRef<'d> {
    data: &'d [f32],
    channels: usize,
    frames: usize,
}

impl<'a, 'd> Adapter<'a, f32> for InterleavedRef<'d> {
    unsafe fn read_sample_unchecked(&self, channel: usize, frame: usize) -> f32 {
        self.data.get(frame * self.channels + channel).copied().unwrap_or(0.0)
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frames(&self) -> usize {
        self.frames
    }
}

struct InterleavedMut<'d> {
    data: &'d mut [f32],
    channels: usize,
    frames: usize,
}

impl<'a, 'd> Adapter<'a, f32> for InterleavedMut<'d> {
    unsafe fn read_sample_unchecked(&self, channel: usize, frame: usize) -> f32 {
        self.data.get(frame * self.channels + channel).copied().unwrap_or(0.0)
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frames(&self) -> usize {
        self.frames
    }
}

impl<'a, 'd> AdapterMut<'a, f32> for InterleavedMut<'d> {
    unsafe fn write_sample_unchecked(&mut self, channel: usize, frame: usize, value: &f32) -> bool {
        if let Some(slot) = self.data.get_mut(frame * self.channels + channel) {
            *slot = *value;
        }
        false
    }
}

/// rubato wrapper; `new` returns `Ok(None)` when rates already match.
pub struct Resampler {
    inner: Async<f32>,
    channels: usize,
    ratio: f64,
    pending: Vec<f32>,
    scratch: Vec<f32>,
}

impl Resampler {
    pub fn new(from_rate: u32, to_rate: u32, channels: usize) -> AppResult<Option<Self>> {
        if from_rate == 0 || to_rate == 0 {
            return Err(AppError::Audio(format!("invalid resample rates {from_rate} -> {to_rate}")));
        }
        if channels == 0 {
            return Err(AppError::Audio("resampler needs at least one channel".into()));
        }
        if from_rate == to_rate {
            return Ok(None);
        }

        let ratio = f64::from(to_rate) / f64::from(from_rate);
        let params = SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: 0.95,
            // Linear interpolation between a densely oversampled sinc table is
            // cheaper than cubic and, at 256x oversampling, already below the
            // noise floor of 16-bit source material.
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };
        let inner = Async::<f32>::new_sinc(
            ratio,
            1.0,
            &params,
            RESAMPLE_CHUNK,
            channels,
            FixedAsync::Input,
        )
        .map_err(|e| AppError::Audio(format!("resampler setup failed: {e}")))?;

        let scratch_frames = inner.output_frames_max();
        Ok(Some(Resampler {
            inner,
            channels,
            ratio,
            pending: Vec::with_capacity(RESAMPLE_CHUNK * channels * 2),
            scratch: vec![0.0; scratch_frames * channels],
        }))
    }

    /// Interleaved in, interleaved out. Buffers internally: may return fewer
    /// or more frames than it was given.
    pub fn process(&mut self, input: &[f32]) -> AppResult<Vec<f32>> {
        self.pending.extend_from_slice(input);

        let mut out = Vec::new();
        let mut offset = 0usize;
        loop {
            let need = self.inner.input_frames_next();
            let available = self.pending.len() / self.channels - offset;
            if need == 0 || available < need {
                break;
            }
            let consumed = self.run(offset, &mut out)?;
            if consumed == 0 {
                break;
            }
            offset += consumed;
        }
        if offset > 0 {
            self.pending.drain(..offset * self.channels);
        }
        Ok(out)
    }

    pub fn flush(&mut self) -> AppResult<Vec<f32>> {
        let mut out = Vec::new();
        let real_frames = self.pending.len() / self.channels;
        let delay = self.inner.output_delay();
        // Pad with silence so the tail of the buffered input and the
        // interpolator's own delay line are pushed all the way through.
        let pad = self.inner.input_frames_max() + delay + 1;
        self.pending.resize((real_frames + pad) * self.channels, 0.0);

        let mut offset = 0usize;
        loop {
            let need = self.inner.input_frames_next();
            let available = self.pending.len() / self.channels - offset;
            if need == 0 || available < need {
                break;
            }
            let consumed = self.run(offset, &mut out)?;
            if consumed == 0 {
                break;
            }
            offset += consumed;
        }

        self.pending.clear();
        self.inner.reset();

        let want_frames = (real_frames as f64 * self.ratio).round() as usize + delay;
        let want = (want_frames * self.channels).min(out.len());
        out.truncate(want);
        Ok(out)
    }

    fn run(&mut self, input_offset: usize, out: &mut Vec<f32>) -> AppResult<usize> {
        let out_frames = self.inner.output_frames_max();
        let needed = out_frames * self.channels;
        if self.scratch.len() < needed {
            self.scratch.resize(needed, 0.0);
        }
        let indexing = Indexing {
            input_offset,
            output_offset: 0,
            partial_len: None,
            active_channels_mask: None,
        };

        let in_frames = self.pending.len() / self.channels;
        let src = InterleavedRef { data: &self.pending, channels: self.channels, frames: in_frames };
        let mut dst = InterleavedMut {
            data: &mut self.scratch,
            channels: self.channels,
            frames: out_frames,
        };
        let (consumed, produced) = self
            .inner
            .process_into_buffer(&src, &mut dst, Some(&indexing))
            .map_err(|e| AppError::Audio(format!("resample failed: {e}")))?;

        let produced_samples = (produced * self.channels).min(self.scratch.len());
        out.extend_from_slice(&self.scratch[..produced_samples]);
        Ok(consumed)
    }
}

/// Equal-power (sin/cos) crossfade so perceived loudness stays flat mid-fade.
pub struct Crossfader {
    channels: usize,
    total: usize,
    remaining: usize,
}

impl Crossfader {
    pub fn new(sample_rate: u32, channels: usize, duration_ms: u32) -> Self {
        let channels = channels.max(1);
        let frames = (u64::from(sample_rate) * u64::from(duration_ms) / 1000) as usize;
        Crossfader { channels, total: frames, remaining: frames }
    }

    /// The engine builds a fresh crossfader per fade rather than resetting one,
    /// so this is only exercised by the tests — kept because reuse is the
    /// cheaper path if the engine ever pools them.
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.remaining = self.total;
    }

    pub fn is_done(&self) -> bool {
        self.remaining == 0
    }

    pub fn remaining_frames(&self) -> usize {
        self.remaining
    }

    /// Mixes `outgoing` (fading out) with `incoming` (fading in) into `out`.
    /// Shorter slice governs; returns true once the fade completed.
    pub fn mix(&mut self, outgoing: &[f32], incoming: &[f32], out: &mut Vec<f32>) -> bool {
        out.clear();
        let samples = outgoing.len().min(incoming.len());
        let frames = samples / self.channels;
        out.reserve(frames * self.channels);

        let total = self.total as f32;
        for f in 0..frames {
            let (g_out, g_in) = if self.remaining == 0 || self.total == 0 {
                (0.0, 1.0)
            } else {
                let t = (total - self.remaining as f32) / total;
                let phase = t * std::f32::consts::FRAC_PI_2;
                let (sin, cos) = phase.sin_cos();
                (cos, sin)
            };
            let base = f * self.channels;
            for c in 0..self.channels {
                let a = outgoing.get(base + c).copied().unwrap_or(0.0);
                let b = incoming.get(base + c).copied().unwrap_or(0.0);
                out.push(a * g_out + b * g_in);
            }
            if self.remaining > 0 {
                self.remaining -= 1;
            }
        }
        self.remaining == 0
    }
}

/// Visualiser meter span. 40 Hz is below the lowest bass note that matters on
/// laptop speakers; 16 kHz is where the EQ stops.
const METER_LOW_HZ: f64 = 40.0;
const METER_HIGH_HZ: f64 = 16_000.0;
const METER_FLOOR_DB: f32 = -60.0;
/// Envelope release time constant, in seconds.
const METER_RELEASE_S: f32 = 0.25;
const MAX_BINS: usize = 128;

struct MeterBand {
    coeffs: Biquad,
    state: [f64; 2],
    active: bool,
    /// Pink-noise tilt so a typical mix produces a roughly level bar graph.
    makeup_db: f32,
    /// Mean square of the last buffer that passed through this band.
    energy: f64,
}

/// Band-limited RMS meters feeding the visualiser. A filter bank is used rather
/// than an FFT to avoid pulling in another dependency for a cosmetic feature.
pub struct BandMeter {
    channels: usize,
    sample_rate: u32,
    bands: Vec<MeterBand>,
    levels: Vec<f32>,
}

impl BandMeter {
    pub fn new(channels: usize, sample_rate: u32, bins: usize) -> Self {
        let mut m = BandMeter {
            channels: channels.max(1),
            sample_rate: sample_rate.max(1),
            bands: Vec::new(),
            levels: Vec::new(),
        };
        m.build(bins);
        m
    }

    pub fn reconfigure(&mut self, channels: usize, sample_rate: u32, bins: usize) {
        let channels = channels.max(1);
        let sample_rate = sample_rate.max(1);
        let bins = bins.clamp(1, MAX_BINS);
        if channels == self.channels && sample_rate == self.sample_rate && bins == self.bands.len()
        {
            return;
        }
        self.channels = channels;
        self.sample_rate = sample_rate;
        self.build(bins);
    }

    pub fn feed(&mut self, buf: &[f32]) {
        let channels = self.channels;
        let frames = buf.len() / channels;
        if frames == 0 || self.bands.is_empty() {
            return;
        }

        let inv_ch = 1.0 / channels as f64;
        for band in self.bands.iter_mut() {
            if !band.active {
                continue;
            }
            let mut energy = 0.0f64;
            for frame in buf.chunks(channels) {
                // The meter is mono: the bars are cosmetic and this halves the
                // biquad count on stereo material.
                let mono: f64 = frame.iter().map(|s| f64::from(*s)).sum::<f64>() * inv_ch;
                let y = band.coeffs.step(mono, &mut band.state);
                energy += y * y;
            }
            band.energy = energy / frames as f64;
        }

        let release = (-(frames as f32) / (METER_RELEASE_S * self.sample_rate as f32)).exp();
        for (i, band) in self.bands.iter().enumerate() {
            let Some(level) = self.levels.get_mut(i) else { continue };
            if !band.active {
                *level = 0.0;
                continue;
            }
            let rms = band.energy.sqrt() as f32;
            let db = 20.0 * (rms + 1e-9).log10() + band.makeup_db;
            let target = ((db - METER_FLOOR_DB) / -METER_FLOOR_DB).clamp(0.0, 1.0);
            // Instant attack, exponential release: bars jump and then fall.
            *level = if target > *level { target } else { *level * release };
        }
    }

    /// `bins` values in 0..1, log-spaced 40 Hz..16 kHz, with decay so the bars
    /// fall smoothly.
    pub fn magnitudes(&self) -> Vec<f32> {
        self.levels.clone()
    }

    fn build(&mut self, bins: usize) {
        let bins = bins.clamp(1, MAX_BINS);
        let sr = f64::from(self.sample_rate);
        let limit = sr * NYQUIST_GUARD;
        let span = METER_HIGH_HZ / METER_LOW_HZ;
        let step = if bins > 1 { span.powf(1.0 / (bins - 1) as f64) } else { 1.0 };
        let octaves_per_bin = if bins > 1 { step.log2() } else { 1.0 };
        // Same octave-bandwidth-to-Q relation as the EQ, floored so very coarse
        // bin counts do not turn the filters into DC blockers.
        let pow = 2f64.powf(octaves_per_bin);
        let q = if pow > 1.0 { (pow.sqrt() / (pow - 1.0)).max(0.7) } else { 0.7 };

        self.bands.clear();
        self.levels.clear();
        for i in 0..bins {
            let freq = METER_LOW_HZ * step.powi(i as i32);
            let active = freq > 0.0 && freq < limit;
            self.bands.push(MeterBand {
                coeffs: if active { Biquad::bandpass(freq, sr, q) } else { Biquad::IDENTITY },
                state: [0.0; 2],
                active,
                makeup_db: (2.0 * (freq / METER_LOW_HZ).log2() + 12.0) as f32,
                energy: 0.0,
            });
            self.levels.push(0.0);
        }
    }
}

pub fn downmix_mono(buf: &mut Vec<f32>, channels: usize) {
    if channels <= 1 {
        return;
    }
    let frames = buf.len() / channels;
    let inv = 1.0 / channels as f32;
    for f in 0..frames {
        let base = f * channels;
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += buf.get(base + c).copied().unwrap_or(0.0);
        }
        if let Some(slot) = buf.get_mut(f) {
            *slot = sum * inv;
        }
    }
    buf.truncate(frames);
}

/// Perceptual taper so a 50 % slider sounds like half volume.
///
/// Halving perceived loudness is roughly -10 dB, i.e. a linear gain of 0.316,
/// which `v^(5/3)` reproduces while keeping the 0 and 1 endpoints exact.
pub fn perceptual_volume(v: f32) -> f32 {
    if !v.is_finite() {
        return 0.0;
    }
    v.clamp(0.0, 1.0).powf(5.0 / 3.0)
}

/// Knee above which [`soft_clip`] starts bending the signal.
const CLIP_KNEE: f32 = 0.7;

/// Hard-clip guard applied last, after EQ/ReplayGain boosts.
pub fn soft_clip(buf: &mut [f32]) {
    for s in buf.iter_mut() {
        let x = *s;
        if !x.is_finite() {
            *s = 0.0;
            continue;
        }
        let mag = x.abs();
        if mag <= CLIP_KNEE {
            continue;
        }
        // 1 - e^-t is C1-continuous with the linear region at the knee and
        // asymptotes to 1.0, so the output can never leave [-1, 1].
        let over = (mag - CLIP_KNEE) / (1.0 - CLIP_KNEE);
        let shaped = CLIP_KNEE + (1.0 - CLIP_KNEE) * (1.0 - (-over).exp());
        *s = if x.is_sign_negative() { -shaped } else { shaped };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(len: usize) -> Vec<f32> {
        (0..len).map(|i| ((i as f32) * 0.037).sin() * 0.5).collect()
    }

    #[test]
    fn peaking_at_unity_gain_is_identity() {
        let b = Biquad::peaking(1000.0, 48_000.0, BAND_Q, 0.0);
        assert!((b.b0 - 1.0).abs() < 1e-12);
        assert!((b.b1 - b.a1).abs() < 1e-12);
        assert!((b.b2 - b.a2).abs() < 1e-12);
    }

    #[test]
    fn eq_with_flat_gains_is_identity() {
        let mut eq = Equalizer::new(2, 48_000);
        eq.set_enabled(true);
        eq.set_gains(&[0.0; 10]);

        let input = ramp(4096);
        let mut buf = input.clone();
        eq.process(&mut buf);

        for (a, b) in input.iter().zip(buf.iter()) {
            assert!((a - b).abs() < 1e-6, "flat EQ altered the signal: {a} vs {b}");
        }
    }

    #[test]
    fn eq_with_boost_changes_the_signal() {
        let mut eq = Equalizer::new(1, 48_000);
        eq.set_enabled(true);
        eq.set_gains(&[0.0, 0.0, 0.0, 0.0, 0.0, 9.0, 0.0, 0.0, 0.0, 0.0]);

        let input = ramp(2048);
        let mut buf = input.clone();
        eq.process(&mut buf);

        let diff: f32 = input.iter().zip(buf.iter()).map(|(a, b)| (a - b).abs()).sum();
        assert!(diff > 1.0, "a +9 dB band should be audible, total diff was {diff}");
        assert!(buf.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn eq_gains_are_clamped() {
        let mut eq = Equalizer::new(1, 48_000);
        eq.set_gains(&[99.0, -99.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(eq.gains.first().copied(), Some(MAX_GAIN_DB));
        assert_eq!(eq.gains.get(1).copied(), Some(-MAX_GAIN_DB));
    }

    #[test]
    fn smooth_gain_converges_monotonically() {
        let mut g = SmoothGain::new(48_000, 20.0);
        g.set_immediate(1.0);
        g.set_target_linear(0.25);

        let mut buf = vec![1.0f32; 48_000];
        g.process(&mut buf);

        let mut prev = 1.0f32;
        for v in buf.iter() {
            assert!(*v <= prev + 1e-9, "gain ramp went back up: {v} after {prev}");
            assert!(*v >= 0.25 - 1e-6);
            prev = *v;
        }
        assert!((prev - 0.25).abs() < 1e-3, "did not converge, ended at {prev}");
    }

    #[test]
    fn smooth_gain_db_matches_linear() {
        let mut g = SmoothGain::new(48_000, 0.0);
        g.set_target_db(-6.0206);
        g.set_immediate(g.target);
        let mut buf = vec![1.0f32];
        g.process(&mut buf);
        assert!((buf.first().copied().unwrap_or(0.0) - 0.5).abs() < 1e-3);
    }

    #[test]
    fn resampler_is_none_for_equal_rates() {
        let r = Resampler::new(44_100, 44_100, 2).expect("construction must succeed");
        assert!(r.is_none());
    }

    #[test]
    fn resampler_roughly_preserves_duration() {
        let mut r = Resampler::new(44_100, 48_000, 2)
            .expect("construction must succeed")
            .expect("rates differ so a resampler is required");

        let frames = 44_100;
        let input: Vec<f32> = (0..frames * 2).map(|i| ((i / 2) as f32 * 0.01).sin()).collect();
        let mut out = r.process(&input).expect("process");
        out.extend(r.flush().expect("flush"));

        let out_frames = out.len() / 2;
        let expected = 48_000f64;
        let err = (out_frames as f64 - expected).abs() / expected;
        assert!(err < 0.02, "expected ~{expected} frames, got {out_frames}");
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn crossfade_holds_constant_power() {
        let mut fade_out = Crossfader::new(48_000, 1, 200);
        let mut fade_in = Crossfader::new(48_000, 1, 200);
        let n = fade_out.remaining_frames();
        assert!(n > 0);

        let ones = vec![1.0f32; n];
        let zeros = vec![0.0f32; n];

        let mut gains_out = Vec::new();
        let mut gains_in = Vec::new();
        assert!(fade_out.mix(&ones, &zeros, &mut gains_out));
        assert!(fade_in.mix(&zeros, &ones, &mut gains_in));
        assert_eq!(gains_out.len(), n);
        assert_eq!(gains_in.len(), n);

        for i in 0..n {
            let a = gains_out.get(i).copied().unwrap_or(0.0);
            let b = gains_in.get(i).copied().unwrap_or(0.0);
            let power = a * a + b * b;
            let db = 10.0 * power.log10();
            assert!(db.abs() < 0.5, "power deviated by {db} dB at frame {i}");
        }
    }

    #[test]
    fn crossfade_reports_completion_and_resets() {
        let mut x = Crossfader::new(48_000, 2, 10);
        let n = x.remaining_frames();
        assert!(!x.is_done());

        let half = vec![0.5f32; n * 2];
        let mut out = Vec::new();
        assert!(x.mix(&half, &half, &mut out));
        assert!(x.is_done());
        assert_eq!(out.len(), n * 2);

        x.reset();
        assert_eq!(x.remaining_frames(), n);
        assert!(!x.is_done());
    }

    #[test]
    fn perceptual_volume_is_monotonic_with_unit_endpoints() {
        assert_eq!(perceptual_volume(0.0), 0.0);
        assert_eq!(perceptual_volume(1.0), 1.0);

        let mut prev = -1.0f32;
        for i in 0..=1000 {
            let v = perceptual_volume(i as f32 / 1000.0);
            assert!(v > prev - 1e-9, "not monotonic at {i}: {v} after {prev}");
            assert!((0.0..=1.0).contains(&v));
            prev = v;
        }
        // Half the slider should land near -10 dB.
        let half = perceptual_volume(0.5);
        assert!((half - 0.3150).abs() < 0.01, "0.5 mapped to {half}");
    }

    #[test]
    fn band_meter_reacts_to_signal_and_decays() {
        let mut m = BandMeter::new(2, 48_000, 16);
        assert_eq!(m.magnitudes().len(), 16);
        assert!(m.magnitudes().iter().all(|v| *v == 0.0));

        let tone: Vec<f32> = (0..48_000)
            .flat_map(|i| {
                let v = (i as f32 * std::f32::consts::TAU * 1000.0 / 48_000.0).sin() * 0.5;
                [v, v]
            })
            .collect();
        m.feed(&tone);
        let loud = m.magnitudes();
        assert!(loud.iter().any(|v| *v > 0.1), "a 1 kHz tone should light a bar");
        assert!(loud.iter().all(|v| (0.0..=1.0).contains(v)));

        let silence = vec![0.0f32; 48_000 * 2];
        m.feed(&silence);
        let quiet = m.magnitudes();
        for (a, b) in loud.iter().zip(quiet.iter()) {
            assert!(b <= a, "levels must not rise on silence");
        }
    }

    #[test]
    fn downmix_halves_the_buffer() {
        let mut buf = vec![1.0, -1.0, 0.5, 0.5, 0.0, 1.0];
        downmix_mono(&mut buf, 2);
        assert_eq!(buf, vec![0.0, 0.5, 0.5]);
    }

    #[test]
    fn soft_clip_bounds_the_signal() {
        let mut buf = vec![0.1, 0.7, 1.5, -1.5, 40.0, f32::NAN, f32::INFINITY];
        soft_clip(&mut buf);
        assert_eq!(buf.first().copied(), Some(0.1));
        assert_eq!(buf.get(1).copied(), Some(0.7));
        for v in buf.iter() {
            assert!(v.is_finite());
            assert!(v.abs() <= 1.0, "soft clip let {v} through");
        }
        assert!(buf.get(2).copied().unwrap_or(0.0) > 0.7);
        assert!(buf.get(3).copied().unwrap_or(0.0) < -0.7);
    }
}
