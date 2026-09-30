//! Container demux + codec decode, producing interleaved `f32` at the source
//! sample rate. Resampling and mixing happen further down the graph.

use std::io;

use symphonia::core::audio::{SampleBuffer, SignalSpec};
use symphonia::core::codecs::{Decoder as CodecDecoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::{MetadataOptions, StandardTagKey, Tag, Value};
use symphonia::core::probe::{Hint, ProbeResult};
use symphonia::core::units::{Time, TimeBase};
use symphonia::default::{get_codecs, get_probe};
use tracing::{debug, warn};

use crate::error::{AppError, AppResult};

/// A single corrupt frame in a stream is normal (bad rip, dropped packet on a
/// radio relay); this many in a row means the stream is genuinely broken.
const MAX_CONSECUTIVE_DECODE_ERRORS: u32 = 3;

pub struct Decoder {
    reader: Box<dyn FormatReader>,
    codec: Box<dyn CodecDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    sample_rate: u32,
    channels: usize,
    duration_ms: Option<u64>,
    replaygain_db: Option<f32>,
    /// Milliseconds established by the last seek or sample-rate change.
    base_ms: u64,
    /// Frames emitted since `base_ms`, at the current `sample_rate`.
    frames_played: u64,
    sample_buf: Option<SampleBuffer<f32>>,
    buf_spec: Option<SignalSpec>,
    consecutive_errors: u32,
    /// First chunk, decoded during `open` when the container did not declare
    /// the signal spec up front.
    primed: Option<Vec<f32>>,
    title: Option<String>,
    metadata_read: bool,
}

impl Decoder {
    pub fn open(
        src: Box<dyn MediaSource>,
        ext_hint: Option<&str>,
        mime_hint: Option<&str>,
    ) -> AppResult<Self> {
        let mss = MediaSourceStream::new(src, MediaSourceStreamOptions::default());

        let mut hint = Hint::new();
        if let Some(ext) = ext_hint {
            let ext = ext.trim().trim_start_matches('.');
            if !ext.is_empty() {
                hint.with_extension(ext);
            }
        }
        if let Some(mime) = mime_hint {
            let mime = mime.split(';').next().unwrap_or(mime).trim();
            if !mime.is_empty() {
                hint.mime_type(mime);
            }
        }

        let fmt_opts = FormatOptions { enable_gapless: true, ..Default::default() };
        let meta_opts = MetadataOptions::default();

        let ProbeResult { format: mut reader, metadata: mut probed_meta } = get_probe()
            .format(&hint, mss, &fmt_opts, &meta_opts)
            .map_err(map_sym_error)?;

        let mut tags: Vec<Tag> = Vec::new();
        if let Some(md) = probed_meta.get() {
            if let Some(rev) = md.current() {
                tags.extend_from_slice(rev.tags());
            }
        }
        {
            let md = reader.metadata();
            if let Some(rev) = md.current() {
                tags.extend_from_slice(rev.tags());
            }
        }

        let params = reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .map(|t| (t.id, t.codec_params.clone()))
            .ok_or_else(|| AppError::Decode("stream contains no decodable audio track".into()))?;
        let (track_id, params) = params;

        let codec = get_codecs()
            .make(&params, &DecoderOptions { verify: false })
            .map_err(map_sym_error)?;

        let sample_rate = params.sample_rate.unwrap_or(0);
        let channels = params.channels.map(|c| c.count()).unwrap_or(0);
        let time_base = params.time_base.filter(|tb| tb.numer > 0 && tb.denom > 0);

        let duration_ms = match (params.n_frames, time_base, params.sample_rate) {
            (Some(frames), Some(tb), _) => Some(time_to_ms(tb.calc_time(frames))),
            (Some(frames), None, Some(rate)) if rate > 0 => {
                Some(frames.saturating_mul(1000) / u64::from(rate))
            }
            _ => None,
        };

        let mut dec = Decoder {
            reader,
            codec,
            track_id,
            time_base,
            sample_rate,
            channels,
            duration_ms,
            replaygain_db: parse_replaygain(&tags),
            base_ms: 0,
            frames_played: 0,
            sample_buf: None,
            buf_spec: None,
            consecutive_errors: 0,
            primed: None,
            title: now_playing(&tags),
            metadata_read: false,
        };

        // ADTS/raw streams often omit the spec in the header; the engine needs a
        // rate and channel count before it can open an output device, so pay for
        // one packet up front rather than guessing.
        if dec.sample_rate == 0 || dec.channels == 0 {
            dec.primed = dec.next_chunk()?;
            if dec.sample_rate == 0 || dec.channels == 0 {
                return Err(AppError::Decode("stream never declared a sample format".into()));
            }
        }

        Ok(dec)
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// None when the container carries no duration (live streams).
    pub fn duration_ms(&self) -> Option<u64> {
        self.duration_ms
    }

    /// Parsed from REPLAYGAIN_TRACK_GAIN / R128_TRACK_GAIN tags when present.
    pub fn replaygain_db(&self) -> Option<f32> {
        self.replaygain_db
    }

    /// Interleaved f32 at the source rate. `Ok(None)` = clean end of stream.
    pub fn next_chunk(&mut self) -> AppResult<Option<Vec<f32>>> {
        if let Some(primed) = self.primed.take() {
            return Ok(Some(primed));
        }

        loop {
            let packet = match self.reader.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => {
                    return Ok(None)
                }
                Err(SymError::ResetRequired) => {
                    self.reset_to_new_track()?;
                    continue;
                }
                Err(SymError::IoError(e)) => return Err(AppError::Io(e)),
                Err(e) => return Err(map_sym_error(e)),
            };

            self.refresh_metadata();

            if packet.track_id() != self.track_id {
                continue;
            }

            // The buffer is fetched with `last_decoded` rather than taken from
            // `decode`'s return value so the error arms below are not holding a
            // borrow of `self.codec` when they rebuild it.
            match self.codec.decode(&packet) {
                Ok(_) => {}
                Err(SymError::DecodeError(msg)) => {
                    self.consecutive_errors += 1;
                    debug!(ts = packet.ts(), "skipping undecodable packet: {msg}");
                    if self.consecutive_errors >= MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err(AppError::Decode(format!(
                            "{msg} ({} consecutive failures)",
                            self.consecutive_errors
                        )));
                    }
                    continue;
                }
                Err(SymError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => {
                    return Ok(None)
                }
                Err(SymError::ResetRequired) => {
                    self.reset_to_new_track()?;
                    continue;
                }
                Err(SymError::IoError(e)) => return Err(AppError::Io(e)),
                Err(e) => return Err(map_sym_error(e)),
            }

            let decoded = self.codec.last_decoded();
            let spec = *decoded.spec();
            let frames = decoded.frames();
            let capacity = decoded.capacity().max(frames);
            let channels = spec.channels.count();
            if channels == 0 {
                return Err(AppError::Decode("decoded buffer has no channels".into()));
            }
            if frames == 0 {
                continue;
            }

            let stale = match self.buf_spec {
                Some(prev) => prev != spec,
                None => true,
            };
            let too_small = self
                .sample_buf
                .as_ref()
                .map_or(true, |b| b.capacity() < capacity * channels);
            if stale || too_small {
                self.sample_buf = Some(SampleBuffer::<f32>::new(capacity as u64, spec));
                self.buf_spec = Some(spec);
            }

            let out = match self.sample_buf.as_mut() {
                Some(sb) => {
                    sb.copy_interleaved_ref(decoded);
                    sb.samples().to_vec()
                }
                None => return Err(AppError::Decode("sample buffer unavailable".into())),
            };

            self.consecutive_errors = 0;
            self.note_spec(spec.rate, channels);
            if out.is_empty() {
                continue;
            }
            self.frames_played += (out.len() / channels) as u64;
            return Ok(Some(out));
        }
    }

    pub fn seek_ms(&mut self, ms: u64) -> AppResult<()> {
        let to = SeekTo::Time {
            time: Time::new(ms / 1000, (ms % 1000) as f64 / 1000.0),
            track_id: Some(self.track_id),
        };
        let seeked = self.reader.seek(SeekMode::Accurate, to).map_err(map_sym_error)?;

        self.codec.reset();
        self.primed = None;
        self.consecutive_errors = 0;

        // Report where we actually landed, not where we asked to go: accurate
        // seeks always stop at or before the request.
        self.base_ms = match self.time_base {
            Some(tb) => time_to_ms(tb.calc_time(seeked.actual_ts)),
            None if self.sample_rate > 0 => {
                seeked.actual_ts.saturating_mul(1000) / u64::from(self.sample_rate)
            }
            None => ms,
        };
        self.frames_played = 0;
        Ok(())
    }

    pub fn position_ms(&self) -> u64 {
        if self.sample_rate == 0 {
            return self.base_ms;
        }
        self.base_ms + self.frames_played.saturating_mul(1000) / u64::from(self.sample_rate)
    }

    /// Best-effort title/artist from stream metadata — used for ICY radio titles.
    pub fn stream_title(&mut self) -> Option<String> {
        self.refresh_metadata();
        self.title.clone()
    }

    /// An Ogg chain or an ADTS rate switch invalidates the codec instance; the
    /// frame counter deliberately survives so `position_ms` stays continuous.
    fn reset_to_new_track(&mut self) -> AppResult<()> {
        let picked = self
            .reader
            .tracks()
            .iter()
            .find(|t| t.id == self.track_id && t.codec_params.codec != CODEC_TYPE_NULL)
            .or_else(|| {
                self.reader.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            })
            .map(|t| (t.id, t.codec_params.clone()))
            .ok_or_else(|| AppError::Decode("stream reset left no decodable track".into()))?;
        let (track_id, params) = picked;

        let codec = get_codecs()
            .make(&params, &DecoderOptions { verify: false })
            .map_err(map_sym_error)?;

        warn!(track_id, "stream demanded a decoder reset");
        self.codec = codec;
        self.track_id = track_id;
        self.time_base = params.time_base.filter(|tb| tb.numer > 0 && tb.denom > 0);
        self.buf_spec = None;
        self.sample_buf = None;
        self.consecutive_errors = 0;
        if let Some(rate) = params.sample_rate {
            let channels = params.channels.map(|c| c.count()).unwrap_or(self.channels);
            self.note_spec(rate, channels);
        }
        Ok(())
    }

    /// Folds the frames played so far into `base_ms` whenever the rate changes,
    /// so the millisecond clock never jumps.
    fn note_spec(&mut self, rate: u32, channels: usize) {
        if rate == self.sample_rate && channels == self.channels {
            return;
        }
        if self.sample_rate > 0 {
            self.base_ms += self.frames_played.saturating_mul(1000) / u64::from(self.sample_rate);
        }
        self.frames_played = 0;
        if rate > 0 {
            self.sample_rate = rate;
        }
        if channels > 0 {
            self.channels = channels;
        }
    }

    fn refresh_metadata(&mut self) {
        let mut md = self.reader.metadata();
        if md.is_latest() && self.metadata_read {
            return;
        }
        self.metadata_read = true;
        if let Some(rev) = md.skip_to_latest() {
            if let Some(title) = now_playing(rev.tags()) {
                self.title = Some(title);
            }
        }
    }
}

fn map_sym_error(e: SymError) -> AppError {
    match e {
        SymError::IoError(e) => AppError::Io(e),
        other => AppError::Decode(other.to_string()),
    }
}

fn time_to_ms(t: Time) -> u64 {
    t.seconds.saturating_mul(1000) + (t.frac * 1000.0).round().clamp(0.0, 1000.0) as u64
}

fn now_playing(tags: &[Tag]) -> Option<String> {
    let mut title = None;
    let mut artist = None;
    for tag in tags {
        let key = tag.key.to_ascii_uppercase();
        let is_title = matches!(tag.std_key, Some(StandardTagKey::TrackTitle))
            || key == "TITLE"
            || key == "STREAMTITLE"
            || key == "ICY-NAME";
        let is_artist = matches!(tag.std_key, Some(StandardTagKey::Artist))
            || key == "ARTIST"
            || key == "ALBUMARTIST";
        if is_title && title.is_none() {
            title = tag_string(&tag.value);
        } else if is_artist && artist.is_none() {
            artist = tag_string(&tag.value);
        }
    }

    match (artist, title) {
        // Shoutcast packs "Artist - Title" into StreamTitle already; don't
        // double it up when the artist tag is a prefix of the title.
        (Some(a), Some(t)) if !t.to_lowercase().starts_with(&a.to_lowercase()) => {
            Some(format!("{a} - {t}"))
        }
        (_, Some(t)) => Some(t),
        (Some(a), None) => Some(a),
        (None, None) => None,
    }
}

fn tag_string(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => s.trim().to_string(),
        Value::Float(f) => f.to_string(),
        Value::SignedInt(i) => i.to_string(),
        Value::UnsignedInt(u) => u.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Flag | Value::Binary(_) => return None,
    };
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn parse_replaygain(tags: &[Tag]) -> Option<f32> {
    let mut replaygain = None;
    let mut r128 = None;
    for tag in tags {
        let key = tag.key.to_ascii_uppercase();
        if replaygain.is_none()
            && (matches!(tag.std_key, Some(StandardTagKey::ReplayGainTrackGain))
                || key == "REPLAYGAIN_TRACK_GAIN")
        {
            replaygain = parse_gain_db(&tag.value);
        }
        if r128.is_none() && key == "R128_TRACK_GAIN" {
            r128 = parse_r128_gain(&tag.value);
        }
    }
    replaygain.or(r128).filter(|g| g.is_finite() && g.abs() < 60.0)
}

/// Accepts the usual `"-7.23 dB"` spelling as well as bare numbers.
fn parse_gain_db(v: &Value) -> Option<f32> {
    match v {
        Value::Float(f) => Some(*f as f32),
        Value::SignedInt(i) => Some(*i as f32),
        Value::UnsignedInt(u) => Some(*u as f32),
        Value::String(s) => {
            let trimmed =
                s.trim().trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace());
            trimmed.trim().parse::<f32>().ok()
        }
        _ => None,
    }
}

/// `R128_TRACK_GAIN` is Q7.8 dB relative to -23 LUFS; ReplayGain references
/// -18 LUFS, hence the +5 dB shift.
fn parse_r128_gain(v: &Value) -> Option<f32> {
    let raw = match v {
        Value::SignedInt(i) => *i as f64,
        Value::UnsignedInt(u) => *u as f64,
        Value::Float(f) => *f,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    Some((raw / 256.0 + 5.0) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(key: &str, value: &str) -> Tag {
        Tag::new(None, key, Value::String(value.to_string()))
    }

    #[test]
    fn parses_replaygain_track_gain() {
        let tags = vec![tag("REPLAYGAIN_TRACK_GAIN", "-7.23 dB")];
        let g = parse_replaygain(&tags).expect("gain");
        assert!((g + 7.23).abs() < 1e-4, "got {g}");
    }

    #[test]
    fn parses_positive_replaygain_without_unit() {
        let tags = vec![tag("replaygain_track_gain", "+2.5")];
        let g = parse_replaygain(&tags).expect("gain");
        assert!((g - 2.5).abs() < 1e-4, "got {g}");
    }

    #[test]
    fn converts_r128_q78_to_replaygain_db() {
        // -1536 / 256 = -6 LU, +5 dB reference shift => -1 dB.
        let tags = vec![tag("R128_TRACK_GAIN", "-1536")];
        let g = parse_replaygain(&tags).expect("gain");
        assert!((g + 1.0).abs() < 1e-4, "got {g}");
    }

    #[test]
    fn replaygain_wins_over_r128() {
        let tags =
            vec![tag("R128_TRACK_GAIN", "-1536"), tag("REPLAYGAIN_TRACK_GAIN", "-3.00 dB")];
        let g = parse_replaygain(&tags).expect("gain");
        assert!((g + 3.0).abs() < 1e-4, "got {g}");
    }

    #[test]
    fn rejects_absurd_gains() {
        assert_eq!(parse_replaygain(&[tag("REPLAYGAIN_TRACK_GAIN", "999 dB")]), None);
        assert_eq!(parse_replaygain(&[tag("REPLAYGAIN_TRACK_GAIN", "loud")]), None);
    }

    #[test]
    fn builds_now_playing_from_artist_and_title() {
        let tags = vec![tag("ARTIST", "Boards of Canada"), tag("TITLE", "Dayvan Cowboy")];
        assert_eq!(now_playing(&tags).as_deref(), Some("Boards of Canada - Dayvan Cowboy"));
    }

    #[test]
    fn does_not_duplicate_shoutcast_style_titles() {
        let tags =
            vec![tag("ARTIST", "Aphex Twin"), tag("StreamTitle", "Aphex Twin - Xtal")];
        assert_eq!(now_playing(&tags).as_deref(), Some("Aphex Twin - Xtal"));
    }

    #[test]
    fn title_only_streams_report_the_title() {
        assert_eq!(now_playing(&[tag("TITLE", "Untitled")]).as_deref(), Some("Untitled"));
        assert_eq!(now_playing(&[]), None);
    }

    #[test]
    fn time_to_ms_rounds_the_fraction() {
        assert_eq!(time_to_ms(Time::new(3, 0.5)), 3500);
        assert_eq!(time_to_ms(Time::new(0, 0.0)), 0);
    }
}
