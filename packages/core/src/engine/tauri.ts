/**
 * Desktop engine — a thin client over the Rust audio commands in `docs/ipc.md`.
 *
 * All real work (symphonia decode, biquad EQ, ReplayGain, cpal output, gapless
 * and crossfade) happens in Rust. This class only marshals arguments, forwards
 * the `ritmo://audio` event stream and keeps a local playhead mirror so
 * `getPosition()` can stay synchronous and smooth at 60 fps while the engine
 * only reports progress at 4 Hz.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { EQ_BANDS } from '../types';
import type { EqualizerSettings, PlaybackError, StreamRef, Track } from '../types';
import type { AudioEngine, EngineEvent, EngineTrack } from './types';

const AUDIO_EVENT = 'ritmo://audio';
/** Best-effort cap on how long `load` waits for the first audio frame. */
const START_TIMEOUT_MS = 30_000;
/** One spectrum round-trip per frame at most; the visualiser polls far harder. */
const SPECTRUM_MIN_INTERVAL_MS = 16;

/** The subset of `Track` the Rust engine needs — see `WireTrack` in docs/ipc.md. */
interface WireTrack {
  uri: string;
  title: string;
  durationMs: number;
  isLive: boolean;
  gainDb?: number;
  path?: string;
}

/** Mirrors `StreamRef` on the wire. */
interface WireStream {
  url: string;
  mimeType?: string;
  kind: StreamRef['kind'];
  expiresAt?: number;
  headers?: Record<string, string>;
  localPath?: string;
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Carries the mapped `PlaybackError` for callers that catch a failed command. */
class EngineCommandError extends Error {
  readonly error: PlaybackError;
  constructor(error: PlaybackError) {
    super(error.message);
    this.name = 'EngineCommandError';
    this.error = error;
  }
}

function monotonic(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isExpired(stream: StreamRef): boolean {
  return stream.expiresAt !== undefined && stream.expiresAt <= Date.now();
}

/** `AppError` reaches the WebView as `{ code, message }`. */
function toPlaybackError(e: unknown): PlaybackError {
  const wire = (typeof e === 'object' && e !== null ? e : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const rawCode = typeof wire.code === 'string' ? wire.code : '';
  const code: PlaybackError['code'] =
    rawCode === 'network' || rawCode === 'decode' || rawCode === 'not_found' || rawCode === 'device'
      ? rawCode
      : 'unknown';

  let message = typeof wire.message === 'string' ? wire.message : '';
  if (!message) message = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  if (!message) message = 'The audio engine rejected the command.';

  return { code, message, retryable: code === 'network' || code === 'unknown' };
}

function toWireTrack(track: Track): WireTrack {
  const wire: WireTrack = {
    uri: track.uri,
    title: track.title,
    durationMs: track.durationMs,
    isLive: track.isLive === true,
  };
  if (track.gainDb !== undefined) wire.gainDb = track.gainDb;
  if (track.path !== undefined) wire.path = track.path;
  return wire;
}

function toWireStream(stream: StreamRef): WireStream {
  const wire: WireStream = { url: stream.url, kind: stream.kind };
  if (stream.mimeType !== undefined) wire.mimeType = stream.mimeType;
  if (stream.expiresAt !== undefined) wire.expiresAt = stream.expiresAt;
  if (stream.headers !== undefined) wire.headers = stream.headers;
  if (stream.localPath !== undefined) wire.localPath = stream.localPath;
  return wire;
}

function hasIpc(): boolean {
  return typeof window !== 'undefined';
}

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasIpc()) {
    throw new EngineCommandError({
      code: 'device',
      message: `Tauri IPC is unavailable: \`${name}\` cannot run outside the desktop shell.`,
      retryable: false,
    });
  }
  try {
    return await invoke<T>(name, args);
  } catch (e) {
    throw new EngineCommandError(toPlaybackError(e));
  }
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  return command<AudioDevice[]>('audio_devices');
}

/** `undefined` hands output back to the system default device. */
export async function setAudioDevice(id?: string): Promise<void> {
  await command<void>('audio_set_device', { id: id ?? null });
}

export class TauriAudioEngine implements AudioEngine {
  readonly kind = 'rust' as const;
  readonly supportsGapless = true;
  readonly supportsEqualizer = true;
  readonly supportsReplayGain = true;

  private unlisten: (() => void) | undefined;
  private disposed = false;
  private handlers = new Set<(event: EngineEvent) => void>();

  private currentTrack: EngineTrack | undefined;
  private positionMs = 0;
  private durationMs = 0;
  private bufferedMs = 0;
  /** `monotonic()` reading that `positionMs` was sampled at. */
  private sampledAt = monotonic();
  private playing = false;
  private stalled = false;

  private spectrum: Float32Array | undefined;
  private spectrumBins = 0;
  private spectrumInFlight = false;
  private spectrumAt = 0;

  async init(): Promise<void> {
    if (this.unlisten || this.disposed || !hasIpc()) return;
    // The Rust payload is already exactly an `EngineEvent`; no translation.
    this.unlisten = await listen<EngineEvent>(AUDIO_EVENT, (event: { payload: EngineEvent }) => {
      this.ingest(event.payload);
      this.emit(event.payload);
    });
    await this.refreshPosition();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const off = this.unlisten;
    this.unlisten = undefined;
    if (off) off();
    this.handlers.clear();
    this.spectrum = undefined;
  }

  async load(
    track: Track,
    stream: StreamRef,
    opts?: { startAtMs?: number; autoplay?: boolean },
  ): Promise<void> {
    if (isExpired(stream)) {
      this.emit({ type: 'needsRestream', track });
      return;
    }
    const autoplay = opts?.autoplay !== false;
    const startAtMs = opts?.startAtMs;

    this.currentTrack = track;
    this.positionMs = startAtMs ?? 0;
    this.durationMs = track.isLive === true ? 0 : track.durationMs;
    this.bufferedMs = 0;
    this.sampledAt = monotonic();
    this.playing = false;
    this.stalled = false;

    const pending = autoplay ? this.waitForStart() : undefined;
    try {
      await command<void>('audio_load', {
        track: toWireTrack(track),
        stream: toWireStream(stream),
        startAtMs: startAtMs ?? null,
        autoplay,
      });
    } catch (e) {
      pending?.cancel();
      const error = e instanceof EngineCommandError ? e.error : toPlaybackError(e);
      this.emit({ type: 'error', error, track });
      throw e;
    }
    if (pending) await pending.promise;
    await this.refreshPosition();
  }

  async preload(track: Track | undefined, stream: StreamRef | undefined): Promise<void> {
    if (!track || !stream) {
      await command<void>('audio_preload', { track: null, stream: null });
      return;
    }
    if (isExpired(stream)) {
      this.emit({ type: 'needsRestream', track });
      return;
    }
    await command<void>('audio_preload', {
      track: toWireTrack(track),
      stream: toWireStream(stream),
    });
  }

  async play(): Promise<void> {
    await command<void>('audio_play');
    this.sampledAt = monotonic();
    this.playing = true;
    this.stalled = false;
    await this.refreshPosition();
  }

  async pause(): Promise<void> {
    // Freeze the mirror before the event arrives so a progress bar polled in
    // the same frame does not keep creeping forward.
    this.positionMs = this.getPosition();
    this.playing = false;
    this.sampledAt = monotonic();
    await command<void>('audio_pause');
  }

  async stop(): Promise<void> {
    this.playing = false;
    this.stalled = false;
    this.positionMs = 0;
    this.bufferedMs = 0;
    this.sampledAt = monotonic();
    await command<void>('audio_stop');
  }

  async seek(positionMs: number): Promise<void> {
    if (this.currentTrack?.isLive === true) return;
    const target = Math.max(0, Math.round(positionMs));
    const clamped = this.durationMs > 0 ? Math.min(target, this.durationMs) : target;
    this.positionMs = clamped;
    this.sampledAt = monotonic();
    await command<void>('audio_seek', { positionMs: clamped });
  }

  async setVolume(volume: number): Promise<void> {
    const v = volume < 0 ? 0 : volume > 1 ? 1 : volume;
    await command<void>('audio_set_volume', { volume: v });
  }

  async setMuted(muted: boolean): Promise<void> {
    await command<void>('audio_set_muted', { muted });
  }

  async setEqualizer(eq: EqualizerSettings): Promise<void> {
    // Rust expects exactly one gain per band, so a short or long array from
    // persisted settings is normalised here rather than rejected there.
    const gains = EQ_BANDS.map((_, i) => eq.gains[i] ?? 0);
    await command<void>('audio_set_equalizer', { enabled: eq.enabled, gains });
  }

  async setReplayGain(opts: {
    enabled: boolean;
    gainDb?: number;
    preampDb: number;
  }): Promise<void> {
    await command<void>('audio_set_replaygain', {
      enabled: opts.enabled,
      gainDb: opts.gainDb ?? null,
      preampDb: opts.preampDb,
    });
  }

  async setCrossfadeMs(ms: number): Promise<void> {
    await command<void>('audio_set_crossfade', { ms: Math.max(0, Math.round(ms)) });
  }

  getPosition(): number {
    if (!this.playing || this.stalled) return this.clampPosition(this.positionMs);
    const elapsed = monotonic() - this.sampledAt;
    return this.clampPosition(this.positionMs + (elapsed > 0 ? elapsed : 0));
  }

  getDuration(): number {
    return this.durationMs;
  }

  on(handler: (event: EngineEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * The IPC round-trip is asynchronous but the interface is not, so the most
   * recent frame is returned while a refresh is kicked off for the next call.
   */
  getSpectrum(bins: number): Float32Array | undefined {
    if (bins <= 0 || this.disposed || !hasIpc()) return undefined;
    const now = monotonic();
    if (!this.spectrumInFlight && (this.spectrumBins !== bins || now - this.spectrumAt >= SPECTRUM_MIN_INTERVAL_MS)) {
      this.spectrumInFlight = true;
      this.spectrumAt = now;
      void invoke<number[]>('audio_spectrum', { bins })
        .then((values: number[]) => {
          this.spectrum = Float32Array.from(values);
          this.spectrumBins = bins;
        })
        .catch(() => {
          this.spectrum = undefined;
          this.spectrumBins = 0;
        })
        .finally(() => {
          this.spectrumInFlight = false;
        });
    }
    return this.spectrumBins === bins ? this.spectrum : undefined;
  }

  private clampPosition(value: number): number {
    const p = value < 0 ? 0 : value;
    // Interpolation must never overshoot the last known duration, or the
    // progress bar reaches the end before the engine says the track did.
    return Math.round(this.durationMs > 0 && p > this.durationMs ? this.durationMs : p);
  }

  private ingest(event: EngineEvent): void {
    switch (event.type) {
      case 'started':
        this.currentTrack = event.track;
        this.positionMs = 0;
        this.durationMs = event.track.isLive === true ? 0 : event.track.durationMs;
        this.playing = true;
        this.stalled = false;
        this.sampledAt = monotonic();
        break;
      case 'playing':
        this.playing = true;
        this.stalled = false;
        this.sampledAt = monotonic();
        break;
      case 'progress':
        this.positionMs = event.positionMs;
        if (event.durationMs > 0) this.durationMs = event.durationMs;
        this.bufferedMs = event.bufferedMs;
        this.stalled = false;
        this.sampledAt = monotonic();
        break;
      case 'stalled':
        this.positionMs = this.getPosition();
        this.stalled = true;
        this.sampledAt = monotonic();
        break;
      case 'paused':
        this.positionMs = this.getPosition();
        this.playing = false;
        this.sampledAt = monotonic();
        break;
      case 'ended':
        if (event.advancedTo) {
          this.currentTrack = event.advancedTo;
          this.positionMs = 0;
          this.durationMs = event.advancedTo.isLive === true ? 0 : event.advancedTo.durationMs;
          this.playing = true;
        } else {
          this.positionMs = this.durationMs;
          this.playing = false;
        }
        this.stalled = false;
        this.bufferedMs = 0;
        this.sampledAt = monotonic();
        break;
      case 'stopped':
        this.currentTrack = undefined;
        this.positionMs = 0;
        this.durationMs = 0;
        this.bufferedMs = 0;
        this.playing = false;
        this.stalled = false;
        this.sampledAt = monotonic();
        break;
      case 'error':
        this.playing = false;
        this.stalled = false;
        this.positionMs = this.clampPosition(this.positionMs);
        this.sampledAt = monotonic();
        break;
      default:
        break;
    }
  }

  private async refreshPosition(): Promise<void> {
    if (!hasIpc()) return;
    try {
      const p = await invoke<{ positionMs: number; durationMs: number; bufferedMs: number }>(
        'audio_position',
      );
      this.positionMs = p.positionMs;
      if (p.durationMs > 0) this.durationMs = p.durationMs;
      this.bufferedMs = p.bufferedMs;
      this.sampledAt = monotonic();
    } catch {
      // Nothing loaded yet, or the engine is still starting up: the mirror
      // stays on whatever the last event said.
    }
  }

  /**
   * Resolves on the first `started`/`playing` for the load in flight, rejects
   * if the engine reports an error instead. A timeout resolves rather than
   * rejects: `audio_load` already succeeded, so failing the caller here would
   * surface a phantom error for a track that is merely slow to buffer.
   */
  private waitForStart(): { promise: Promise<void>; cancel: () => void } {
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      if (off) off();
      off = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const promise = new Promise<void>((resolve, reject) => {
      off = this.on((event) => {
        if (event.type === 'started' || event.type === 'playing') {
          settle();
          resolve();
        } else if (event.type === 'error') {
          settle();
          reject(new EngineCommandError(event.error));
        }
      });
      timer = setTimeout(() => {
        settle();
        resolve();
      }, START_TIMEOUT_MS);
    });
    return { promise, cancel: settle };
  }

  private emit(event: EngineEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        // A throwing subscriber must not break the event pump.
      }
    }
  }
}
