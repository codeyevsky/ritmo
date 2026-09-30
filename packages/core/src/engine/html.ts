/**
 * `HTMLAudioElement` + WebAudio engine — mobile (Capacitor) and plain browser.
 *
 * Two elements are kept alive for the whole session so the next track can
 * buffer while the current one plays, and so a crossfade has somewhere to fade
 * *to*. Each element owns exactly one `MediaElementAudioSourceNode`: the spec
 * forbids creating a second one for the same element, so the graph is built
 * once per deck and never torn down.
 *
 * This file and `./tauri.ts` are the only modules in `@ritmo/core` allowed to
 * touch DOM globals, and both must stay importable under Node (tests, SSR),
 * hence the `typeof window` guards.
 */

import { EQ_BANDS } from '../types';
import type { EqualizerSettings, PlaybackError, StreamRef, Track } from '../types';
import type { AudioEngine, EngineEvent } from './types';

const EQ_Q = 1.41;
const PROGRESS_INTERVAL_MS = 250;
const LOAD_TIMEOUT_MS = 30_000;
const METADATA_TIMEOUT_MS = 10_000;
/** Points sampled along the equal-power curve handed to `setValueCurveAtTime`. */
const CURVE_POINTS = 64;
const FADE_TICK_MS = 20;
/** ReplayGain + preamp is allowed to boost by at most +12 dB before clipping bites. */
const MAX_GAIN_LINEAR = 4;

interface DeckGraph {
  source: MediaElementAudioSourceNode;
  filters: BiquadFilterNode[];
  rgGain: GainNode;
  volGain: GainNode;
  analyser: AnalyserNode;
}

interface Deck {
  el: HTMLAudioElement;
  graph?: DeckGraph;
  track?: Track;
  stream?: StreamRef;
  /** True once `started` has been emitted for whatever is on this deck now. */
  started: boolean;
  /** One-shot latch so an expired stream produces a single `needsRestream`. */
  restreamNotified: boolean;
  /** Timer driving the no-WebAudio volume ramp fallback. */
  fadeTimer?: ReturnType<typeof setInterval>;
}

/** Carries the `PlaybackError` that was also emitted, for callers that catch. */
class EngineLoadError extends Error {
  readonly error: PlaybackError;
  constructor(error: PlaybackError) {
    super(error.message);
    this.name = 'EngineLoadError';
    this.error = error;
  }
}

function playbackError(
  code: PlaybackError['code'],
  message: string,
  retryable = false,
): PlaybackError {
  return { code, message, retryable };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function dbToLinear(db: number): number {
  const linear = Math.pow(10, db / 20);
  return linear > MAX_GAIN_LINEAR ? MAX_GAIN_LINEAR : linear < 0 ? 0 : linear;
}

/**
 * Clears any automation in flight before pinning a parameter. Overlapping a
 * `setValueAtTime` with a running `setValueCurveAtTime` throws, and older
 * WebViews lack `cancelAndHoldAtTime`, so both are handled defensively.
 */
function resetParam(param: AudioParam, value: number, now: number): void {
  const holdable = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  try {
    if (typeof holdable.cancelAndHoldAtTime === 'function') holdable.cancelAndHoldAtTime(now);
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
  } catch {
    param.value = value;
  }
}

function monotonic(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isExpired(stream: StreamRef): boolean {
  return stream.expiresAt !== undefined && stream.expiresAt <= Date.now();
}

function resolveAudioContextCtor(): (new () => AudioContext) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext;
}

function mapMediaError(el: HTMLAudioElement): PlaybackError {
  const err = el.error;
  const detail = err?.message ? `: ${err.message}` : '';
  switch (err?.code) {
    case 2 /* MEDIA_ERR_NETWORK */:
      return playbackError('network', `Network error while streaming${detail}`, true);
    case 3 /* MEDIA_ERR_DECODE */:
      return playbackError('decode', `Audio could not be decoded${detail}`, false);
    case 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */:
      return playbackError('not_found', `Source is missing or its format is unsupported${detail}`, false);
    case 1 /* MEDIA_ERR_ABORTED */:
      return playbackError('unknown', `Loading was aborted${detail}`, true);
    default:
      return playbackError('unknown', `Unknown playback error${detail}`, true);
  }
}

function bufferedAheadMs(el: HTMLAudioElement): number {
  const ranges = el.buffered;
  const t = el.currentTime;
  for (let i = 0; i < ranges.length; i++) {
    // A tolerance keeps the range matched right after a seek, when currentTime
    // can sit a few ms before the start of the range that was just fetched.
    if (ranges.start(i) <= t + 0.25 && ranges.end(i) >= t) {
      const ahead = (ranges.end(i) - t) * 1000;
      return ahead > 0 ? Math.round(ahead) : 0;
    }
  }
  return 0;
}

export class HtmlAudioEngine implements AudioEngine {
  readonly kind = 'html' as const;
  readonly supportsGapless = false;
  readonly supportsEqualizer = true;
  readonly supportsReplayGain = true;

  private decks: [Deck, Deck] | undefined;
  private activeIdx: 0 | 1 = 0;
  private ctx: AudioContext | undefined;
  private hlsNative = false;
  private disposed = false;

  private volume = 1;
  private muted = false;
  private crossfadeMs = 0;
  private eq: EqualizerSettings = { enabled: false, gains: EQ_BANDS.map(() => 0), preset: 'Flat' };
  private rg: { enabled: boolean; gainDb?: number; preampDb: number } = {
    enabled: false,
    preampDb: 0,
  };

  private crossfadeTimer: ReturnType<typeof setTimeout> | undefined;
  private crossfading = false;
  private progressTimer: ReturnType<typeof setInterval> | undefined;
  private handlers = new Set<(event: EngineEvent) => void>();
  private detach: Array<() => void> = [];

  async init(): Promise<void> {
    if (this.decks || this.disposed) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const a = this.createDeck();
    const b = this.createDeck();
    this.decks = [a, b];
    this.hlsNative =
      a.el.canPlayType('application/vnd.apple.mpegurl') !== '' ||
      a.el.canPlayType('audio/mpegurl') !== '';

    const Ctor = resolveAudioContextCtor();
    if (Ctor) {
      try {
        this.ctx = new Ctor();
      } catch {
        // No WebAudio (locked-down WebView): fall back to element volume only.
        this.ctx = undefined;
      }
    }
    this.buildGraph(a);
    this.buildGraph(b);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelCrossfade();
    this.stopProgressTimer();
    for (const off of this.detach.splice(0)) off();
    this.handlers.clear();
    const decks = this.decks;
    this.decks = undefined;
    if (decks) {
      for (const deck of decks) {
        if (deck.fadeTimer !== undefined) clearInterval(deck.fadeTimer);
        try {
          deck.el.pause();
          deck.el.removeAttribute('src');
          deck.el.load();
        } catch {
          /* element already detached */
        }
        deck.el.remove();
      }
    }
    const ctx = this.ctx;
    this.ctx = undefined;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        /* already closed */
      }
    }
  }

  async load(
    track: Track,
    stream: StreamRef,
    opts?: { startAtMs?: number; autoplay?: boolean },
  ): Promise<void> {
    const decks = this.requireDecks();
    if (isExpired(stream)) {
      this.emit({ type: 'needsRestream', track });
      return;
    }
    if (stream.kind === 'hls' && !this.hlsNative) {
      throw this.fail(
        playbackError(
          'decode',
          'HLS streams need native support (Safari/iOS); no HLS decoder is bundled on this platform.',
          false,
        ),
        track,
      );
    }

    this.cancelCrossfade();

    // Adopt the preloaded deck when it already holds this exact stream, so a
    // "next track" click costs nothing. Either way the other deck is released.
    const idle = decks[this.activeIdx === 0 ? 1 : 0];
    if (idle.stream !== undefined && idle.stream.url === stream.url && !isExpired(idle.stream)) {
      this.resetDeck(decks[this.activeIdx]);
      this.activeIdx = this.activeIdx === 0 ? 1 : 0;
    } else {
      this.resetDeck(idle);
    }

    const deck = decks[this.activeIdx];
    const reusing = deck.stream !== undefined && deck.stream.url === stream.url;
    deck.track = track;
    deck.stream = stream;
    deck.started = false;
    deck.restreamNotified = false;

    if (!reusing) {
      try {
        deck.el.pause();
      } catch {
        /* nothing playing */
      }
      deck.el.src = stream.url;
      deck.el.load();
    }
    deck.el.muted = this.muted;
    this.applyEqualizer(deck);
    this.applyReplayGain(deck);
    this.applyVolume(deck);

    const startAtMs = opts?.startAtMs ?? 0;
    if (startAtMs > 0) await this.applyStartOffset(deck, startAtMs);

    this.startProgressTimer();

    if (opts?.autoplay === false) {
      if (deck.el.readyState < 3) await this.awaitDeck(deck, 'canplay', LOAD_TIMEOUT_MS);
      return;
    }

    await this.resumeContext();
    const playing = this.awaitDeck(deck, 'playing', LOAD_TIMEOUT_MS);
    try {
      await deck.el.play();
    } catch (e) {
      void playing.catch(() => undefined);
      throw this.fail(this.mapPlayRejection(e, deck), track);
    }
    await playing;
  }

  async preload(track: Track | undefined, stream: StreamRef | undefined): Promise<void> {
    const decks = this.decks;
    if (!decks || this.crossfading) return;
    const idle = decks[this.activeIdx === 0 ? 1 : 0];

    if (!track || !stream) {
      this.resetDeck(idle);
      return;
    }
    if (isExpired(stream)) {
      this.emit({ type: 'needsRestream', track });
      return;
    }
    // Nothing can be pre-buffered for HLS we cannot decode; `load` reports it.
    if (stream.kind === 'hls' && !this.hlsNative) {
      this.resetDeck(idle);
      return;
    }
    if (idle.stream !== undefined && idle.stream.url === stream.url) {
      idle.track = track;
      this.applyReplayGain(idle);
      return;
    }

    this.resetDeck(idle);
    idle.track = track;
    idle.stream = stream;
    idle.el.muted = this.muted;
    idle.el.src = stream.url;
    idle.el.load();
    this.applyEqualizer(idle);
    this.applyReplayGain(idle);
    this.silenceDeck(idle);
  }

  async play(): Promise<void> {
    const deck = this.activeDeck();
    if (!deck) return;
    await this.resumeContext();
    try {
      await deck.el.play();
    } catch (e) {
      const error = this.mapPlayRejection(e, deck);
      this.emit({ type: 'error', error, track: deck.track });
      throw new EngineLoadError(error);
    }
    this.startProgressTimer();
  }

  async pause(): Promise<void> {
    const decks = this.decks;
    if (!decks) return;
    // Both decks run during a crossfade, so pausing only the active one would
    // leave the incoming track audible.
    for (const deck of decks) {
      if (deck === decks[this.activeIdx] || this.crossfading) deck.el.pause();
    }
  }

  async stop(): Promise<void> {
    const decks = this.decks;
    this.cancelCrossfade();
    this.stopProgressTimer();
    if (!decks) return;
    for (const deck of decks) this.resetDeck(deck);
    this.emit({ type: 'stopped' });
  }

  async seek(positionMs: number): Promise<void> {
    const deck = this.activeDeck();
    if (!deck || !deck.track) return;
    if (deck.track.isLive || !Number.isFinite(deck.el.duration)) return;
    const target = Math.max(0, positionMs) / 1000;
    try {
      deck.el.currentTime = Math.min(target, deck.el.duration);
    } catch {
      // Source is not seekable (chunked transfer without ranges).
      return;
    }
    this.emitProgress(deck);
  }

  async setVolume(volume: number): Promise<void> {
    this.volume = clamp01(volume);
    const decks = this.decks;
    if (!decks || this.crossfading) return;
    this.applyVolume(decks[this.activeIdx]);
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    const decks = this.decks;
    if (!decks) return;
    for (const deck of decks) deck.el.muted = muted;
  }

  async setEqualizer(eq: EqualizerSettings): Promise<void> {
    this.eq = eq;
    const decks = this.decks;
    if (!decks) return;
    for (const deck of decks) this.applyEqualizer(deck);
  }

  async setReplayGain(opts: { enabled: boolean; gainDb?: number; preampDb: number }): Promise<void> {
    this.rg = opts;
    const decks = this.decks;
    if (!decks) return;
    for (const deck of decks) this.applyReplayGain(deck);
  }

  async setCrossfadeMs(ms: number): Promise<void> {
    this.crossfadeMs = Math.max(0, Math.round(ms));
    if (this.crossfadeMs === 0) this.cancelCrossfade();
  }

  getPosition(): number {
    const deck = this.activeDeck();
    if (!deck) return 0;
    const t = deck.el.currentTime;
    return Number.isFinite(t) ? Math.round(t * 1000) : 0;
  }

  getDuration(): number {
    const deck = this.activeDeck();
    if (!deck) return 0;
    if (deck.track?.isLive) return 0;
    const d = deck.el.duration;
    if (Number.isFinite(d) && d > 0) return Math.round(d * 1000);
    return deck.track?.durationMs ?? 0;
  }

  on(handler: (event: EngineEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  getSpectrum(bins: number): Float32Array | undefined {
    const deck = this.activeDeck();
    const ctx = this.ctx;
    if (!deck?.graph || !ctx || bins <= 0) return undefined;

    const analyser = deck.graph.analyser;
    const raw = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(raw);

    const nyquist = ctx.sampleRate / 2;
    const minHz = 20;
    const maxHz = Math.min(20_000, nyquist);
    if (maxHz <= minHz || raw.length === 0) return new Float32Array(bins);
    const ratio = maxHz / minHz;

    const out = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      const lowHz = minHz * Math.pow(ratio, i / bins);
      const highHz = minHz * Math.pow(ratio, (i + 1) / bins);
      let lo = Math.floor((lowHz / nyquist) * raw.length);
      let hi = Math.ceil((highHz / nyquist) * raw.length);
      if (lo < 0) lo = 0;
      if (hi > raw.length) hi = raw.length;
      if (hi <= lo) hi = Math.min(raw.length, lo + 1);

      let sum = 0;
      let n = 0;
      for (let j = lo; j < hi; j++) {
        sum += raw[j] ?? 0;
        n++;
      }
      out[i] = n > 0 ? sum / n / 255 : 0;
    }
    return out;
  }

  private createDeck(): Deck {
    const el = document.createElement('audio');
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.volume = 1;
    // Some mobile WebViews refuse to buffer an element that is not in the
    // document, so the decks live hidden in the body rather than detached.
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
    (document.body ?? document.documentElement).appendChild(el);

    const deck: Deck = { el, started: false, restreamNotified: false };
    this.attachListeners(deck);
    return deck;
  }

  private attachListeners(deck: Deck): void {
    const el = deck.el;
    const bind = (type: string, fn: () => void): void => {
      el.addEventListener(type, fn);
      this.detach.push(() => el.removeEventListener(type, fn));
    };

    bind('playing', () => {
      if (!this.isActive(deck)) return;
      if (!deck.started && deck.track) {
        deck.started = true;
        this.emit({ type: 'started', track: deck.track });
      }
      this.emit({ type: 'playing' });
      this.startProgressTimer();
    });
    bind('pause', () => {
      if (!this.isActive(deck) || this.crossfading) return;
      // `pause` also fires on the way to `ended`; the ended handler owns that.
      if (deck.el.ended) return;
      this.emit({ type: 'paused' });
    });
    bind('waiting', () => {
      if (this.isActive(deck)) this.emit({ type: 'stalled' });
    });
    bind('canplay', () => {
      if (this.isActive(deck)) this.emit({ type: 'canplay' });
    });
    bind('timeupdate', () => {
      if (this.isActive(deck)) this.maybeCrossfade(deck);
    });
    bind('ended', () => this.onEnded(deck));
    bind('error', () => {
      // Releasing a deck clears its `src`, which some browsers report as an
      // error; only the deck the user is listening to may raise one.
      if (!this.isActive(deck) || !deck.stream) return;
      this.emit({ type: 'error', error: mapMediaError(deck.el), track: deck.track });
    });
  }

  private buildGraph(deck: Deck): void {
    const ctx = this.ctx;
    if (!ctx || deck.graph) return;
    try {
      const source = ctx.createMediaElementSource(deck.el);
      const filters = EQ_BANDS.map((hz) => {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = hz;
        f.Q.value = EQ_Q;
        f.gain.value = 0;
        return f;
      });
      const rgGain = ctx.createGain();
      const volGain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.7;

      let node: AudioNode = source;
      for (const f of filters) {
        node.connect(f);
        node = f;
      }
      node.connect(rgGain);
      rgGain.connect(volGain);
      volGain.connect(analyser);
      analyser.connect(ctx.destination);

      deck.graph = { source, filters, rgGain, volGain, analyser };
      deck.el.volume = 1;
    } catch {
      // createMediaElementSource throws when a source already exists for this
      // element. Leaving `graph` unset degrades to element-level volume, the
      // only safe option: the node can never be created a second time.
      deck.el.volume = clamp01(this.volume);
    }
  }

  private async resumeContext(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'suspended') return;
    try {
      await ctx.resume();
    } catch {
      /* reported below */
    }
    if (ctx.state === 'suspended') {
      this.emit({
        type: 'error',
        error: playbackError(
          'device',
          'Audio output is suspended: the platform requires a user gesture before playback can start.',
          true,
        ),
        track: this.activeDeck()?.track,
      });
    }
  }

  private applyEqualizer(deck: Deck): void {
    const graph = deck.graph;
    const ctx = this.ctx;
    if (!graph || !ctx) return;
    const now = ctx.currentTime;
    graph.filters.forEach((f, i) => {
      resetParam(f.gain, this.eq.enabled ? (this.eq.gains[i] ?? 0) : 0, now);
    });
  }

  private applyReplayGain(deck: Deck): void {
    // The per-deck track gain is preferred so the preloaded track is already
    // level-matched when a crossfade brings it in.
    const gainDb = deck.track?.gainDb ?? this.rg.gainDb;
    const linear = this.rg.enabled ? dbToLinear((gainDb ?? 0) + this.rg.preampDb) : 1;
    const graph = deck.graph;
    const ctx = this.ctx;
    if (!graph || !ctx) return;
    resetParam(graph.rgGain.gain, linear, ctx.currentTime);
  }

  private applyVolume(deck: Deck): void {
    const graph = deck.graph;
    const ctx = this.ctx;
    if (deck.fadeTimer !== undefined) {
      clearInterval(deck.fadeTimer);
      deck.fadeTimer = undefined;
    }
    if (graph && ctx) {
      resetParam(graph.volGain.gain, this.volume, ctx.currentTime);
      deck.el.volume = 1;
    } else {
      deck.el.volume = clamp01(this.volume);
    }
  }

  private silenceDeck(deck: Deck): void {
    const graph = deck.graph;
    const ctx = this.ctx;
    if (deck.fadeTimer !== undefined) {
      clearInterval(deck.fadeTimer);
      deck.fadeTimer = undefined;
    }
    if (graph && ctx) {
      resetParam(graph.volGain.gain, 0, ctx.currentTime);
    } else {
      deck.el.volume = 0;
    }
  }

  private resetDeck(deck: Deck): void {
    if (deck.fadeTimer !== undefined) {
      clearInterval(deck.fadeTimer);
      deck.fadeTimer = undefined;
    }
    deck.track = undefined;
    deck.stream = undefined;
    deck.started = false;
    deck.restreamNotified = false;
    try {
      deck.el.pause();
      deck.el.removeAttribute('src');
      // Required to actually release the network connection and buffer.
      deck.el.load();
    } catch {
      /* element already torn down */
    }
    this.applyVolume(deck);
  }

  private async applyStartOffset(deck: Deck, ms: number): Promise<void> {
    if (deck.el.readyState < 1) {
      await new Promise<void>((resolve) => {
        const el = deck.el;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = (): void => {
          el.removeEventListener('loadedmetadata', done);
          el.removeEventListener('error', done);
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
        el.addEventListener('loadedmetadata', done);
        el.addEventListener('error', done);
        timer = setTimeout(done, METADATA_TIMEOUT_MS);
      });
    }
    try {
      const d = deck.el.duration;
      const target = ms / 1000;
      deck.el.currentTime = Number.isFinite(d) && d > 0 ? Math.min(target, d) : target;
    } catch {
      /* not seekable; start from zero */
    }
  }

  private awaitDeck(deck: Deck, event: 'playing' | 'canplay', timeoutMs: number): Promise<void> {
    const el = deck.el;
    if (event === 'canplay' && el.readyState >= 3) return Promise.resolve();
    if (event === 'playing' && !el.paused && el.readyState >= 3) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        el.removeEventListener(event, onOk);
        el.removeEventListener('error', onErr);
        if (timer !== undefined) clearTimeout(timer);
      };
      const onOk = (): void => {
        cleanup();
        resolve();
      };
      const onErr = (): void => {
        cleanup();
        // The deck's own `error` listener already published the event.
        reject(new EngineLoadError(mapMediaError(el)));
      };
      el.addEventListener(event, onOk);
      el.addEventListener('error', onErr);
      timer = setTimeout(() => {
        cleanup();
        reject(
          this.fail(
            playbackError('network', 'Timed out waiting for the audio stream.', true),
            deck.track,
          ),
        );
      }, timeoutMs);
    });
  }

  private maybeCrossfade(deck: Deck): void {
    if (this.crossfadeMs <= 0 || this.crossfading || !this.decks) return;
    if (!deck.track || deck.track.isLive) return;
    const d = deck.el.duration;
    if (!Number.isFinite(d) || d <= 0 || deck.el.paused) return;

    const next = this.decks[this.activeIdx === 0 ? 1 : 0];
    if (!next.track || !next.stream) return;

    const remainingMs = (d - deck.el.currentTime) * 1000;
    // Do not fade a track shorter than the fade itself into oblivion.
    const fadeMs = Math.min(this.crossfadeMs, (d * 1000) / 2);
    if (remainingMs > fadeMs || remainingMs <= 0) return;
    this.beginCrossfade(fadeMs);
  }

  private beginCrossfade(fadeMs: number): void {
    const decks = this.decks;
    if (!decks) return;
    const from = decks[this.activeIdx];
    const to = decks[this.activeIdx === 0 ? 1 : 0];
    if (!to.track || !to.stream) return;

    this.crossfading = true;
    void this.resumeContext();
    try {
      if (to.el.currentTime > 0) to.el.currentTime = 0;
    } catch {
      /* not seekable; it will start wherever it is */
    }
    this.applyEqualizer(to);
    this.applyReplayGain(to);
    this.ramp(to, 'in', fadeMs);
    this.ramp(from, 'out', fadeMs);
    void to.el.play().catch((e: unknown) => {
      const error = this.mapPlayRejection(e, to);
      this.emit({ type: 'error', error, track: to.track });
      this.cancelCrossfade();
    });
    this.crossfadeTimer = setTimeout(() => this.completeCrossfade(), fadeMs);
  }

  private completeCrossfade(): void {
    const decks = this.decks;
    this.crossfadeTimer = undefined;
    this.crossfading = false;
    if (!decks) return;

    const prev = decks[this.activeIdx];
    this.activeIdx = this.activeIdx === 0 ? 1 : 0;
    const next = decks[this.activeIdx];
    this.resetDeck(prev);
    this.applyVolume(next);

    const track = next.track;
    next.started = true;
    this.emit({ type: 'ended', advancedTo: track });
    if (track) this.emit({ type: 'started', track });
    // The incoming deck's own `playing` event was suppressed while it was idle.
    this.emit({ type: 'playing' });
  }

  private cancelCrossfade(): void {
    if (this.crossfadeTimer !== undefined) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = undefined;
    }
    if (!this.crossfading) return;
    this.crossfading = false;
    const decks = this.decks;
    if (!decks) return;
    const active = decks[this.activeIdx];
    const other = decks[this.activeIdx === 0 ? 1 : 0];
    this.applyVolume(active);
    try {
      other.el.pause();
      if (other.el.currentTime > 0) other.el.currentTime = 0;
    } catch {
      /* nothing to rewind */
    }
    this.silenceDeck(other);
  }

  /** Equal-power (sin/cos) fade, scheduled on the graph or timed on the element. */
  private ramp(deck: Deck, dir: 'in' | 'out', ms: number): void {
    const peak = clamp01(this.volume);
    const shape = (t: number): number =>
      peak * (dir === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2));

    const graph = deck.graph;
    const ctx = this.ctx;
    if (deck.fadeTimer !== undefined) {
      clearInterval(deck.fadeTimer);
      deck.fadeTimer = undefined;
    }

    if (graph && ctx) {
      const g = graph.volGain.gain;
      const t0 = ctx.currentTime;
      try {
        const curve = new Float32Array(CURVE_POINTS);
        for (let i = 0; i < CURVE_POINTS; i++) curve[i] = shape(i / (CURVE_POINTS - 1));
        resetParam(g, shape(0), t0);
        g.setValueCurveAtTime(curve, t0, Math.max(0.01, ms / 1000));
      } catch {
        // Automation rejected: snap to the end value rather than leaving the
        // deck stuck at silence.
        resetParam(g, shape(1), t0);
      }
      return;
    }

    const start = monotonic();
    deck.el.volume = clamp01(shape(0));
    deck.fadeTimer = setInterval(() => {
      const t = Math.min(1, (monotonic() - start) / Math.max(1, ms));
      deck.el.volume = clamp01(shape(t));
      if (t >= 1 && deck.fadeTimer !== undefined) {
        clearInterval(deck.fadeTimer);
        deck.fadeTimer = undefined;
      }
    }, FADE_TICK_MS);
  }

  private onEnded(deck: Deck): void {
    if (!this.isActive(deck) || !this.decks) return;
    // A crossfade already scheduled the handover; its timer owns the swap.
    if (this.crossfading) return;

    const next = this.decks[this.activeIdx === 0 ? 1 : 0];
    if (next.track && next.stream) {
      const track = next.track;
      this.activeIdx = this.activeIdx === 0 ? 1 : 0;
      this.resetDeck(deck);
      next.started = false;
      this.applyEqualizer(next);
      this.applyReplayGain(next);
      this.applyVolume(next);
      this.emit({ type: 'ended', advancedTo: track });
      void this.resumeContext().then(() =>
        next.el.play().catch((e: unknown) => {
          this.emit({ type: 'error', error: this.mapPlayRejection(e, next), track });
        }),
      );
      return;
    }
    this.stopProgressTimer();
    this.emit({ type: 'ended' });
  }

  private startProgressTimer(): void {
    if (this.progressTimer !== undefined || typeof window === 'undefined') return;
    this.progressTimer = setInterval(() => this.tick(), PROGRESS_INTERVAL_MS);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer === undefined) return;
    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
  }

  private tick(): void {
    const deck = this.activeDeck();
    if (!deck || !deck.track) return;
    const stream = deck.stream;
    if (stream && !deck.restreamNotified && isExpired(stream)) {
      deck.restreamNotified = true;
      this.emit({ type: 'needsRestream', track: deck.track });
    }
    if (deck.el.paused || deck.el.readyState < 1) return;
    this.emitProgress(deck);
    this.maybeCrossfade(deck);
  }

  private emitProgress(deck: Deck): void {
    const el = deck.el;
    const live = deck.track?.isLive === true;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : 0;
    this.emit({
      type: 'progress',
      positionMs: Number.isFinite(el.currentTime) ? Math.round(el.currentTime * 1000) : 0,
      durationMs: live ? 0 : Math.round(duration || deck.track?.durationMs || 0),
      bufferedMs: bufferedAheadMs(el),
    });
  }

  private mapPlayRejection(e: unknown, deck: Deck): PlaybackError {
    if (deck.el.error) return mapMediaError(deck.el);
    const name = e instanceof Error ? e.name : '';
    const message = e instanceof Error ? e.message : String(e);
    if (name === 'NotAllowedError') {
      return playbackError(
        'device',
        'Playback was blocked; a user gesture is required before audio can start.',
        true,
      );
    }
    if (name === 'NotSupportedError') {
      return playbackError('not_found', `Source format is not supported: ${message}`, false);
    }
    if (name === 'AbortError') {
      return playbackError('unknown', 'The play request was aborted by a newer load.', true);
    }
    return playbackError('unknown', message || 'Playback could not be started.', true);
  }

  private fail(error: PlaybackError, track?: Track): EngineLoadError {
    this.emit({ type: 'error', error, track });
    return new EngineLoadError(error);
  }

  private isActive(deck: Deck): boolean {
    return this.decks !== undefined && this.decks[this.activeIdx] === deck;
  }

  private activeDeck(): Deck | undefined {
    return this.decks?.[this.activeIdx];
  }

  private requireDecks(): [Deck, Deck] {
    const decks = this.decks;
    if (!decks) {
      throw this.fail(
        playbackError(
          'device',
          'HTML audio engine unavailable: no DOM in this environment, or init() was never called.',
          false,
        ),
      );
    }
    return decks;
  }

  private emit(event: EngineEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        // A broken subscriber must not take the audio pipeline down with it.
      }
    }
  }
}
