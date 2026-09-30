import type { EqualizerSettings, PlaybackError, StreamRef, Track } from '../types';

/**
 * What an engine knows about a track.
 *
 * The native engine receives (and therefore can echo back) only the fields it
 * needs to decode — see `WireTrack` in docs/ipc.md. Events carry this, not a
 * full `Track`: anything richer has to be looked up by `uri` against the queue,
 * which is the only component that owns the complete object.
 */
export type EngineTrack = Pick<Track, 'uri' | 'title' | 'durationMs'> &
  Partial<Pick<Track, 'isLive' | 'gainDb' | 'path'>>;

/**
 * The audio output abstraction.
 *
 * Two implementations, chosen at startup from `HostCapabilities.nativeAudio`:
 *
 *   - `RustAudioEngine`  — desktop. symphonia decode → biquad EQ → ReplayGain →
 *     cpal output. True gapless (pre-decodes the next track into a second
 *     buffer), crossfade, and sample-accurate seek.
 *   - `HtmlAudioEngine`  — mobile/web. Two `HTMLAudioElement`s swapped for
 *     crossfade, WebAudio `BiquadFilterNode` chain for EQ. No gapless guarantee.
 *
 * Both are *stateless about the queue*. They play one track, report events, and
 * expose a "preload this next" hook. All ordering logic lives in QueueEngine.
 */
export interface AudioEngine {
  readonly kind: 'rust' | 'html';
  /** Gapless requires the engine to pre-decode; `false` means fall back to crossfade 0. */
  readonly supportsGapless: boolean;
  readonly supportsEqualizer: boolean;
  readonly supportsReplayGain: boolean;

  init(): Promise<void>;
  dispose(): Promise<void>;

  /**
   * Load and begin playing `stream`. Resolves once playback has actually
   * started (first audio frame out), so callers can distinguish "buffering"
   * from "playing".
   */
  load(track: Track, stream: StreamRef, opts?: { startAtMs?: number; autoplay?: boolean }): Promise<void>;

  /**
   * Hand the engine the *next* track so it can pre-buffer. Calling it again
   * replaces the previous hint. Passing `undefined` clears it.
   */
  preload(track: Track | undefined, stream: StreamRef | undefined): Promise<void>;

  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  /** Absolute position in ms. Ignored for live streams. */
  seek(positionMs: number): Promise<void>;

  /** 0..1 linear. Engine applies its own taper. */
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;

  setEqualizer(eq: EqualizerSettings): Promise<void>;
  /** `gainDb` of `undefined` means "no metadata, use the preamp only". */
  setReplayGain(opts: { enabled: boolean; gainDb?: number; preampDb: number }): Promise<void>;
  setCrossfadeMs(ms: number): Promise<void>;

  /** Current playhead. Cheap enough to poll at 60fps. */
  getPosition(): number;
  getDuration(): number;

  on(handler: (event: EngineEvent) => void): () => void;

  /** Real-time magnitude spectrum for the visualiser, or `undefined` if unavailable. */
  getSpectrum?(bins: number): Float32Array | undefined;
}

export type EngineEvent =
  /** First audio frame emitted for the current track. */
  | { type: 'started'; track: EngineTrack }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'stopped' }
  /** Throttled to ~4Hz; the UI interpolates between these with rAF. */
  | { type: 'progress'; positionMs: number; durationMs: number; bufferedMs: number }
  /** Buffer underrun; UI shows a spinner without changing play/pause state. */
  | { type: 'stalled' }
  | { type: 'canplay' }
  /**
   * The current track reached its natural end. If the engine had a preloaded
   * track it has *already* switched to it and `advancedTo` names it — the
   * controller must reconcile its queue rather than issuing a new `load`.
   */
  | { type: 'ended'; advancedTo?: EngineTrack }
  /** Engine noticed `stream.expiresAt` elapsed and needs a fresh StreamRef. */
  | { type: 'needsRestream'; track: EngineTrack }
  /**
   * In-band title from a live stream (ICY / Vorbis comment). This is the only
   * way to learn what a radio station is playing right now, since the station
   * itself is the "track".
   */
  | { type: 'streamTitle'; title: string }
  | { type: 'error'; error: PlaybackError; track?: EngineTrack };
