import type { AudioEngine, EngineEvent } from '../engine/types';
import type { HostBridge, MediaSessionCommand } from '../host/types';
import type { Library } from '../library';
import type { ProviderRegistry } from '../providers/registry';
import { ProviderError } from '../providers/types';
import { buildAutoplay, buildTrackRadio } from '../recommend';
import type {
  PlaybackError, PlaybackState, PlayHistoryEntry, PlayReason, QueueItem,
  QueueSnapshot, RepeatMode, Settings, StreamRef, Track, Uri,
} from '../types';
import { debounce, retry, throttle } from '../util/async';
import { Emitter } from '../util/emitter';
import type { QueueEngine, QueueEvent } from './queue';

export interface ControllerDeps {
  engine: AudioEngine;
  queue: QueueEngine;
  registry: ProviderRegistry;
  host: HostBridge;
  library: Library;
  settings: Settings;
  onScrobble?: (track: Track, playedAt: number) => void;
}

export type PlayerEvent =
  | { type: 'state'; state: PlaybackState }
  | { type: 'queue'; snapshot: QueueSnapshot }
  | { type: 'error'; error: PlaybackError };

/** Shape persisted under {@link SESSION_KEY}. */
export interface PersistedSession {
  queue: string;
  positionMs: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export const SESSION_KEY = 'player.session.v1';

const MAX_CONSECUTIVE_FAILURES = 3;
const STREAM_ATTEMPTS = 2;
const PRELOAD_TAIL_MS = 20_000;
const PRELOAD_FRACTION = 0.5;
const RESTART_PREVIOUS_MS = 3_000;
const SCROBBLE_CAP_MS = 240_000;
const AUTOPLAY_BATCH = 20;
const HISTORY_SEED_LIMIT = 30;
const SESSION_SAVE_MS = 2_000;
const MEDIA_POSITION_MS = 500;
/**
 * Progress arrives at ~4Hz; asking a 2s trailing debounce to save on every one
 * of those would starve it forever, so the save is only nudged once per bucket.
 */
const POSITION_SAVE_BUCKET_MS = 5_000;
const ADVANCE_GUARD = 512;

interface CurrentPlay {
  track: Track;
  startedAt: number;
  /** Wall-clock ms actually spent playing — immune to seeking. */
  accumulatedMs: number;
  playingSince: number | undefined;
  recorded: boolean;
}

export class PlaybackController {
  readonly events = new Emitter<PlayerEvent>();

  private readonly deps: ControllerDeps;
  private settings: Settings;
  private state: PlaybackState;
  private unsubs: Array<() => void> = [];

  /** Guards against a slow load landing after a newer one superseded it. */
  private loadSeq = 0;
  private loadedItemId: string | undefined;
  private preloadedItemId: string | undefined;
  private preloadArmed = false;
  private failureStreak = 0;
  private autoplayDeadEnd = false;
  /** Whether the transport was asked to run; `started` alone does not imply it. */
  private intendedPlaying = false;
  /** Queue item id whose one silent retry has already been used. */
  private retriedItemId: string | undefined;
  private resolvingExhaustion = false;
  private playReason: PlayReason = 'user';
  private currentPlay: CurrentPlay | undefined;
  /** Where `play()` must resume from when nothing is loaded into the engine yet. */
  private pendingStartMs = 0;
  private lastSavedBucket = -1;

  private readonly pushMediaPosition: () => void;
  private readonly saveSessionSoon: () => void;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.settings = deps.settings;
    this.state = {
      status: 'idle',
      positionMs: 0,
      durationMs: 0,
      volume: 1,
      muted: false,
      shuffle: deps.queue.isShuffled(),
      repeat: deps.queue.repeat(),
      bufferedMs: 0,
    };
    this.pushMediaPosition = throttle(() => {
      void this.syncMediaState();
    }, MEDIA_POSITION_MS);
    this.saveSessionSoon = debounce(() => {
      void this.persistSession();
    }, SESSION_SAVE_MS);
  }

  async init(): Promise<void> {
    await this.deps.engine.init();

    this.unsubs.push(this.deps.engine.on((ev) => {
      this.onEngineEvent(ev);
    }));
    this.unsubs.push(this.deps.queue.events.on((ev) => {
      this.onQueueEvent(ev);
    }));
    const media = this.deps.host.mediaSession;
    if (media) {
      this.unsubs.push(media.onCommand((cmd) => {
        void this.onMediaCommand(cmd);
      }));
    }

    await this.applySettings(this.settings);
    await this.restoreSession();

    this.emitState();
    this.emitQueue();
    void this.syncMediaFlags();
  }

  async dispose(): Promise<void> {
    for (const off of this.unsubs.splice(0)) {
      try {
        off();
      } catch {
        // A bridge that already tore itself down must not break shutdown.
      }
    }
    await this.recordCurrentPlay();
    await this.persistSession();
    try {
      await this.deps.engine.dispose();
    } finally {
      this.events.clear();
    }
  }

  async playTrack(track: Track, reason: PlayReason = 'user'): Promise<void> {
    this.resetGuards();
    this.deps.queue.setContext([track], 0);
    const item = this.deps.queue.current();
    if (item) await this.loadItem(item, reason, 0);
  }

  async playContext(
    tracks: Track[],
    startIndex: number,
    context?: { uri?: Uri; name?: string },
  ): Promise<void> {
    this.resetGuards();
    this.deps.queue.setContext(tracks, startIndex, context);
    const item = this.deps.queue.current();
    if (!item) {
      await this.stopPlayback();
      return;
    }
    await this.loadItem(item, 'user', 0);
  }

  async playUri(uri: Uri): Promise<void> {
    try {
      const track = await this.deps.registry.resolveTrack(uri);
      if (!track) {
        this.reportError({
          code: 'not_found',
          message: `Nothing playable at ${uri}`,
          retryable: false,
        });
        return;
      }
      await this.playTrack(track, 'user');
    } catch (e) {
      this.reportError(toPlaybackError(e));
    }
  }

  async startRadio(seed: Track): Promise<void> {
    this.resetGuards();
    let related: Track[] = [];
    try {
      related = await buildTrackRadio(this.deps.registry, seed, AUTOPLAY_BATCH * 2);
    } catch (e) {
      // A radio with only the seed still plays; surface the reason but continue.
      this.events.emit({ type: 'error', error: toPlaybackError(e) });
    }
    const tail = dedupeTracks(related).filter((t) => t.uri !== seed.uri);
    this.deps.queue.setContext([seed, ...tail], 0, { uri: seed.uri, name: seed.title });
    const item = this.deps.queue.current();
    if (item) await this.loadItem(item, 'radio', 0);
  }

  async toggle(): Promise<void> {
    if (this.state.status === 'playing') {
      await this.pause();
      return;
    }
    await this.play();
  }

  async play(): Promise<void> {
    const cur = this.deps.queue.current();
    if (!cur) {
      await this.next();
      return;
    }
    if (this.loadedItemId !== cur.id) {
      await this.loadItem(cur, 'resume', cur.track.isLive ? 0 : this.pendingStartMs);
      return;
    }
    if (!this.currentPlay || this.currentPlay.track.uri !== cur.track.uri) {
      this.currentPlay = {
        track: cur.track,
        startedAt: Date.now(),
        accumulatedMs: 0,
        playingSince: undefined,
        recorded: false,
      };
    }
    this.intendedPlaying = true;
    await this.deps.engine.play();
    this.markPlaying(true);
    this.state.status = 'playing';
    this.state.error = undefined;
    this.emitState();
    void this.syncMediaState();
    this.saveSessionSoon();
  }

  async pause(): Promise<void> {
    this.intendedPlaying = false;
    await this.deps.engine.pause();
    this.markPlaying(false);
    this.state.status = 'paused';
    this.emitState();
    void this.syncMediaState();
    this.saveSessionSoon();
  }

  async next(): Promise<void> {
    this.resetGuards();
    const item = this.deps.queue.next({ userInitiated: true });
    if (!item) return; // exhaustion is driven by the queue's `exhausted` event
    await this.loadItem(item, 'user', 0);
  }

  async previous(): Promise<void> {
    this.resetGuards();
    const cur = this.deps.queue.current();
    if (cur && !cur.track.isLive && this.state.positionMs > RESTART_PREVIOUS_MS) {
      await this.seek(0);
      return;
    }
    const item = this.deps.queue.previous();
    if (!item) {
      await this.seek(0);
      return;
    }
    await this.loadItem(item, 'user', 0);
  }

  async seek(positionMs: number): Promise<void> {
    const cur = this.state.current;
    if (!cur || cur.isLive === true) return;
    const max = this.state.durationMs > 0 ? this.state.durationMs : Number.MAX_SAFE_INTEGER;
    const target = Math.min(Math.max(Math.round(positionMs), 0), max);

    if (this.loadedItemId === undefined) {
      // Nothing decoded yet (restored session): remember where play() must start.
      this.pendingStartMs = target;
      this.state.positionMs = target;
      this.emitState();
      return;
    }

    await this.deps.engine.seek(target);
    // A jump needs an explicit Seeked signal; progress events alone leave the
    // desktop's slider interpolating from the position it last knew.
    void this.deps.host.mediaSession?.seeked?.(target);
    this.state.positionMs = target;
    this.emitState();
    void this.syncMediaState();
    this.saveSessionSoon();
  }

  async setVolume(v: number): Promise<void> {
    const vol = Math.min(Math.max(v, 0), 1);
    await this.deps.engine.setVolume(vol);
    this.state.volume = vol;
    this.emitState();
    void this.syncMediaFlags();
    this.saveSessionSoon();
  }

  async setMuted(m: boolean): Promise<void> {
    await this.deps.engine.setMuted(m);
    this.state.muted = m;
    this.emitState();
    void this.syncMediaFlags();
    this.saveSessionSoon();
  }

  async setShuffle(on: boolean): Promise<void> {
    this.deps.queue.setShuffle(on);
    this.state.shuffle = this.deps.queue.isShuffled();
    this.emitState();
    void this.syncMediaFlags();
    await this.ensurePreload();
    this.saveSessionSoon();
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    this.deps.queue.setRepeat(mode);
    this.state.repeat = this.deps.queue.repeat();
    this.emitState();
    void this.syncMediaFlags();
    await this.ensurePreload();
    this.saveSessionSoon();
  }

  async applySettings(settings: Settings): Promise<void> {
    this.settings = settings;
    const engine = this.deps.engine;
    await engine.setCrossfadeMs(Math.max(0, Math.round(settings.crossfadeMs)));
    if (engine.supportsEqualizer) await engine.setEqualizer(settings.equalizer);
    if (engine.supportsReplayGain) {
      await engine.setReplayGain({
        enabled: settings.normalizeVolume,
        gainDb: this.state.current?.gainDb,
        preampDb: settings.preampDb,
      });
    }
  }

  getState(): PlaybackState {
    return { ...this.state };
  }

  getQueue(): QueueSnapshot {
    return this.deps.queue.snapshot();
  }

  private onEngineEvent(ev: EngineEvent): void {
    switch (ev.type) {
      case 'started': {
        // The engine echoes back only the decode subset, so the full object has
        // to come from the queue; falling back to the echo would drop artists,
        // album and artwork.
        this.state.current = this.fullTrackFor(ev.track.uri) ?? this.state.current;
        // `started` means "first frame decoded", not "transport running": a
        // restored session pre-buffers while paused and must stay paused.
        this.state.status = this.intendedPlaying ? 'playing' : 'paused';
        const dur = this.deps.engine.getDuration();
        if (dur > 0) this.state.durationMs = dur;
        this.markPlaying(this.intendedPlaying);
        this.emitState();
        void this.syncMediaState();
        break;
      }
      case 'playing': {
        this.markPlaying(true);
        this.state.status = 'playing';
        this.state.error = undefined;
        this.emitState();
        void this.syncMediaState();
        break;
      }
      case 'paused': {
        this.markPlaying(false);
        this.state.status = 'paused';
        this.emitState();
        void this.syncMediaState();
        break;
      }
      case 'stopped': {
        this.markPlaying(false);
        this.state.status = 'idle';
        this.state.positionMs = 0;
        this.state.bufferedMs = 0;
        this.emitState();
        void this.syncMediaState();
        break;
      }
      case 'progress': {
        this.state.positionMs = ev.positionMs;
        if (ev.durationMs > 0) this.state.durationMs = ev.durationMs;
        this.state.bufferedMs = ev.bufferedMs;
        this.emitState();
        this.pushMediaPosition();
        this.maybeArmPreload();
        this.maybeSaveProgress();
        break;
      }
      case 'stalled':
      case 'canplay':
        // Buffering churn: the UI reads `bufferedMs`, the transport state is unchanged.
        break;
      case 'ended': {
        void this.handleEnded(ev.advancedTo);
        break;
      }
      case 'needsRestream': {
        void this.restream(ev.track);
        break;
      }
      case 'streamTitle': {
        this.applyStreamTitle(ev.title);
        break;
      }
      case 'error': {
        void this.handleEngineError(ev.error);
        break;
      }
    }
  }

  private onQueueEvent(ev: QueueEvent): void {
    if (ev.type === 'changed') {
      this.state.shuffle = this.deps.queue.isShuffled();
      this.state.repeat = this.deps.queue.repeat();
      this.events.emit({ type: 'queue', snapshot: ev.snapshot });
      void this.ensurePreload();
      void this.syncMediaState();
      this.saveSessionSoon();
      return;
    }
    void this.onExhausted();
  }

  private async onMediaCommand(cmd: MediaSessionCommand): Promise<void> {
    switch (cmd.type) {
      case 'play':
        await this.play();
        break;
      case 'pause':
        await this.pause();
        break;
      case 'toggle':
        await this.toggle();
        break;
      case 'next':
        await this.next();
        break;
      case 'previous':
        await this.previous();
        break;
      case 'stop':
        await this.stopPlayback();
        break;
      case 'seek':
        await this.seek(cmd.positionMs);
        break;
      case 'setVolume':
        await this.setVolume(cmd.volume);
        break;
      case 'setShuffle':
        await this.setShuffle(cmd.shuffle);
        break;
      case 'setRepeat':
        await this.setRepeat(cmd.repeat);
        break;
      case 'raise':
      case 'quit':
        // Window lifecycle is the shell's business, not the player's.
        break;
    }
  }

  /**
   * Mirror the writable MPRIS properties. Fired on every transport change; the
   * bridge is optional so mobile and web simply skip it.
   */
  private async syncMediaFlags(): Promise<void> {
    const media = this.deps.host.mediaSession;
    if (!media?.setFlags) return;
    try {
      await media.setFlags({
        volume: this.state.muted ? 0 : this.state.volume,
        shuffle: this.state.shuffle,
        repeat: this.state.repeat,
      });
    } catch {
      // See pushMetadata.
    }
  }

  private async loadItem(item: QueueItem, reason: PlayReason, startAtMs: number): Promise<void> {
    const token = ++this.loadSeq;
    this.retriedItemId = undefined;
    await this.recordCurrentPlay();

    const track = item.track;
    const startAt = track.isLive === true ? 0 : Math.max(0, Math.round(startAtMs));
    this.markPlaying(false);
    this.currentPlay = undefined;
    this.preloadArmed = false;
    this.state.status = 'loading';
    this.state.current = track;
    this.state.positionMs = startAt;
    this.state.durationMs = track.durationMs;
    this.state.bufferedMs = 0;
    this.state.error = undefined;
    this.emitState();
    void this.pushMetadata(track);

    let stream: StreamRef;
    try {
      stream = await this.resolveStream(track);
      if (token !== this.loadSeq) return;
      await this.applyGainFor(track);
      this.intendedPlaying = true;
      await this.deps.engine.load(track, stream, { startAtMs: startAt, autoplay: true });
    } catch (e) {
      if (token !== this.loadSeq) return;
      await this.onLoadFailure(e);
      return;
    }
    if (token !== this.loadSeq) return;

    this.loadedItemId = item.id;
    this.pendingStartMs = 0;
    this.failureStreak = 0;
    this.playReason = reason;
    this.currentPlay = {
      track,
      startedAt: Date.now(),
      accumulatedMs: 0,
      playingSince: Date.now(),
      recorded: false,
    };
    const dur = this.deps.engine.getDuration();
    this.state.durationMs = dur > 0 ? dur : track.durationMs;
    this.state.status = 'playing';
    this.emitState();
    void this.syncMediaState();
    this.saveSessionSoon();
    // Any hint the previous track left behind now names the wrong track.
    await this.clearPreload();
  }

  private async onLoadFailure(e: unknown): Promise<void> {
    const error = toPlaybackError(e);
    this.failureStreak++;
    this.loadedItemId = undefined;
    this.state.status = 'error';
    this.state.error = error;
    this.events.emit({ type: 'error', error });
    this.emitState();

    if (this.failureStreak >= MAX_CONSECUTIVE_FAILURES) {
      // A dead provider must not be allowed to spin the whole queue.
      this.state.status = 'paused';
      this.emitState();
      void this.syncMediaState();
      return;
    }
    await this.autoAdvance('auto_next');
  }

  private async handleEngineError(error: PlaybackError): Promise<void> {
    this.markPlaying(false);

    // A CDN hiccup mid-stream is common (archive.org redirects to a per-item
    // host that occasionally refuses a range request) and recovers on a second
    // attempt. Re-resolving once, silently, beats telling the user the track is
    // broken when it plays fine a moment later.
    if (error.retryable && (await this.retryCurrentOnce())) return;

    this.failureStreak++;
    this.state.status = 'error';
    this.state.error = error;
    this.events.emit({ type: 'error', error });
    this.emitState();

    if (this.failureStreak >= MAX_CONSECUTIVE_FAILURES) {
      this.state.status = 'paused';
      this.emitState();
      void this.syncMediaState();
      return;
    }
    await this.autoAdvance('auto_next');
  }

  /**
   * One silent re-resolve of the current item. Returns false when there is
   * nothing to retry or the retry was already spent on this track, so the
   * caller falls through to the visible error path.
   */
  private async retryCurrentOnce(): Promise<boolean> {
    const item = this.deps.queue.current();
    if (!item || this.retriedItemId === item.id) return false;
    this.retriedItemId = item.id;

    const resumeAt = item.track.isLive === true ? 0 : this.state.positionMs;
    const token = ++this.loadSeq;
    try {
      const stream = await this.resolveStream(item.track);
      if (token !== this.loadSeq) return true;
      await this.deps.engine.load(item.track, stream, { startAtMs: resumeAt, autoplay: true });
    } catch {
      return false;
    }
    if (token !== this.loadSeq) return true;
    this.loadedItemId = item.id;
    this.state.status = 'playing';
    this.state.error = undefined;
    this.emitState();
    return true;
  }

  private async handleEnded(advancedTo: { uri: Uri } | undefined): Promise<void> {
    this.markPlaying(false);
    await this.recordCurrentPlay();

    if (advancedTo) {
      const adopted = this.reconcileTo(advancedTo);
      if (adopted) {
        this.adoptEngineAdvance(adopted);
        return;
      }
      // The queue drifted away from what the engine pre-buffered (reorder,
      // removal); fall through and load whatever is genuinely next.
    }
    await this.autoAdvance('auto_next');
  }

  /**
   * The engine only ever pre-buffers what `peekNext()` reported, so a match
   * there is the one safe signal that the queue may advance without a load.
   */
  private reconcileTo(track: { uri: Uri }): QueueItem | undefined {
    const peek = this.deps.queue.peekNext();
    if (!peek || peek.track.uri !== track.uri) return undefined;
    const item = this.deps.queue.next({ userInitiated: false });
    if (item && item.track.uri === track.uri) return item;
    return undefined;
  }

  private adoptEngineAdvance(item: QueueItem): void {
    this.loadSeq++;
    this.loadedItemId = item.id;
    this.preloadedItemId = undefined;
    this.preloadArmed = false;
    this.failureStreak = 0;
    this.playReason = this.deps.queue.repeat() === 'one' ? 'repeat' : 'auto_next';
    this.currentPlay = {
      track: item.track,
      startedAt: Date.now(),
      accumulatedMs: 0,
      playingSince: Date.now(),
      recorded: false,
    };
    const dur = this.deps.engine.getDuration();
    this.state.current = item.track;
    this.state.status = 'playing';
    this.state.positionMs = 0;
    this.state.durationMs = dur > 0 ? dur : item.track.durationMs;
    this.state.bufferedMs = 0;
    this.state.error = undefined;
    this.emitState();
    void this.pushMetadata(item.track);
    void this.syncMediaState();
    this.saveSessionSoon();
  }

  private async autoAdvance(reason: PlayReason): Promise<void> {
    if (this.failureStreak >= MAX_CONSECUTIVE_FAILURES) return;
    const threshold = Math.max(0, this.settings.skipShorterThanMs);

    for (let guard = 0; guard < ADVANCE_GUARD; guard++) {
      const item = this.deps.queue.next({ userInitiated: false });
      if (!item) return; // `exhausted` already fired; autoplay picks it up

      const tooShort = threshold > 0 &&
        item.track.isLive !== true &&
        item.track.durationMs > 0 &&
        item.track.durationMs < threshold &&
        item.id !== this.loadedItemId;
      if (tooShort) continue;

      const effective = this.deps.queue.repeat() === 'one' && item.id === this.loadedItemId
        ? 'repeat'
        : reason;
      await this.loadItem(item, effective, 0);
      return;
    }
  }

  private async onExhausted(): Promise<void> {
    if (this.resolvingExhaustion) return;
    this.resolvingExhaustion = true;
    let appended = false;
    try {
      // 'all' wraps inside the queue and 'one' never drains, so autoplay is
      // only ever the answer for 'off'.
      if (this.deps.queue.repeat() !== 'off') return;
      if (this.autoplayDeadEnd) {
        await this.settleAtEnd();
        return;
      }

      let candidates: Track[] = [];
      try {
        const recent = await this.deps.library.history.recentlyPlayed(HISTORY_SEED_LIMIT);
        candidates = await buildAutoplay(this.deps.registry, toSeedTracks(recent), AUTOPLAY_BATCH);
      } catch {
        candidates = [];
      }

      const seen = this.knownUris();
      const fresh = dedupeTracks(candidates).filter((t) => !seen.has(t.uri));
      if (fresh.length === 0) {
        // Nothing left to invent: stop, rather than looping on an empty source.
        this.autoplayDeadEnd = true;
        await this.settleAtEnd();
        return;
      }
      this.deps.queue.appendContext(fresh);
      appended = true;
    } finally {
      this.resolvingExhaustion = false;
    }
    if (appended) await this.autoAdvance('auto_next');
  }

  private async settleAtEnd(): Promise<void> {
    await this.recordCurrentPlay();
    this.markPlaying(false);
    this.state.status = 'ended';
    this.emitState();
    try {
      await this.deps.engine.pause();
    } catch {
      // Already stopped; the reported state is what matters.
    }
    void this.syncMediaState();
    this.saveSessionSoon();
  }

  private async stopPlayback(): Promise<void> {
    this.intendedPlaying = false;
    this.loadSeq++;
    await this.recordCurrentPlay();
    this.markPlaying(false);
    this.currentPlay = undefined;
    this.loadedItemId = undefined;
    this.pendingStartMs = 0;
    try {
      await this.deps.engine.stop();
    } catch {
      // Nothing was playing.
    }
    await this.clearPreload();
    this.state.status = 'idle';
    this.state.positionMs = 0;
    this.state.bufferedMs = 0;
    this.emitState();
    void this.syncMediaState();
    this.saveSessionSoon();
  }

  private async restream(ref: { uri: Uri; isLive?: boolean }): Promise<void> {
    const cur = this.deps.queue.current();
    if (!cur || cur.track.uri !== ref.uri) return;
    const track = cur.track;
    const token = ++this.loadSeq;
    const resumeAt = track.isLive === true ? 0 : this.state.positionMs;
    const wasPlaying = this.state.status === 'playing';
    try {
      const stream = await this.resolveStream(track);
      if (token !== this.loadSeq) return;
      this.intendedPlaying = wasPlaying;
      await this.deps.engine.load(track, stream, { startAtMs: resumeAt, autoplay: wasPlaying });
    } catch (e) {
      if (token !== this.loadSeq) return;
      await this.onLoadFailure(e);
      return;
    }
    if (token !== this.loadSeq) return;
    this.loadedItemId = cur.id;
    this.failureStreak = 0;
    this.state.status = wasPlaying ? 'playing' : 'paused';
    this.state.error = undefined;
    this.emitState();
  }

  private maybeArmPreload(): void {
    if (this.preloadArmed) return;
    const cur = this.deps.queue.current();
    if (!cur || cur.track.isLive === true) return;
    const dur = this.state.durationMs;
    if (dur <= 0) return;
    const pastHalf = this.state.positionMs >= dur * PRELOAD_FRACTION;
    const nearEnd = dur - this.state.positionMs <= PRELOAD_TAIL_MS;
    if (!pastHalf && !nearEnd) return;
    this.preloadArmed = true;
    void this.ensurePreload();
  }

  private async ensurePreload(): Promise<void> {
    if (!this.preloadArmed) return;
    const next = this.deps.queue.peekNext();
    // Live radio has no finite stream worth pre-buffering.
    if (!next || next.track.isLive === true) {
      await this.clearPreload();
      return;
    }
    if (next.id === this.preloadedItemId) return;

    this.preloadedItemId = next.id;
    try {
      const stream = await this.resolveStream(next.track);
      if (this.preloadedItemId !== next.id) return;
      await this.deps.engine.preload(next.track, stream);
    } catch {
      // A failed preload is not a playback failure: it must not count towards
      // the failure streak, and the real load will try again.
      if (this.preloadedItemId === next.id) this.preloadedItemId = undefined;
    }
  }

  private async clearPreload(): Promise<void> {
    if (this.preloadedItemId === undefined) return;
    this.preloadedItemId = undefined;
    try {
      await this.deps.engine.preload(undefined, undefined);
    } catch {
      // Clearing a hint is advisory.
    }
  }

  private async resolveStream(track: Track): Promise<StreamRef> {
    try {
      const local = await this.deps.library.offline.localPathFor(track.uri);
      if (local) {
        return {
          url: this.deps.host.files.toPlayableUrl(local),
          kind: 'progressive',
          localPath: local,
        };
      }
    } catch {
      // Offline index trouble must not stop a perfectly playable remote stream.
    }
    return retry(() => this.deps.registry.resolveStream(track), { attempts: STREAM_ATTEMPTS });
  }

  private async applyGainFor(track: Track): Promise<void> {
    if (!this.deps.engine.supportsReplayGain) return;
    await this.deps.engine.setReplayGain({
      enabled: this.settings.normalizeVolume,
      gainDb: track.gainDb,
      preampDb: this.settings.preampDb,
    });
  }

  private markPlaying(on: boolean): void {
    const play = this.currentPlay;
    if (!play) return;
    if (on) {
      if (play.playingSince === undefined) play.playingSince = Date.now();
      return;
    }
    if (play.playingSince !== undefined) {
      play.accumulatedMs += Date.now() - play.playingSince;
      play.playingSince = undefined;
    }
  }

  private async recordCurrentPlay(): Promise<void> {
    const play = this.currentPlay;
    if (!play || play.recorded) return;
    play.recorded = true;
    this.markPlaying(false);

    const dur = play.track.durationMs > 0 ? play.track.durationMs : this.state.durationMs;
    const playedMs = dur > 0
      ? Math.min(Math.round(play.accumulatedMs), dur)
      : Math.round(play.accumulatedMs);
    if (playedMs <= 0) return;

    // Unbounded sources have no half-way point, so only the 4 minute rule applies.
    const threshold = dur > 0 ? Math.min(dur * 0.5, SCROBBLE_CAP_MS) : SCROBBLE_CAP_MS;
    const completed = playedMs >= threshold;
    const entry: PlayHistoryEntry = {
      track: play.track,
      playedAt: play.startedAt,
      playedMs,
      reason: this.playReason,
      completed,
    };
    try {
      await this.deps.library.history.record(entry);
    } catch {
      // History is best-effort; losing a row must never break playback.
    }
    if (completed) this.deps.onScrobble?.(play.track, play.startedAt);
  }

  private knownUris(): Set<string> {
    const snap = this.deps.queue.snapshot();
    const uris = new Set<string>();
    for (const item of snap.history) uris.add(item.track.uri);
    if (snap.current) uris.add(snap.current.track.uri);
    for (const item of snap.upcoming) uris.add(item.track.uri);
    return uris;
  }

  /**
   * A radio station's "track" never changes, so the song it is currently playing
   * arrives out of band and is stored on the track's `meta`. The object is
   * replaced rather than mutated so React sees a new reference.
   */
  private applyStreamTitle(title: string): void {
    const cur = this.state.current;
    if (!cur || cur.isLive !== true) return;
    if (cur.meta?.streamTitle === title) return;
    this.state.current = { ...cur, meta: { ...cur.meta, streamTitle: title } };
    this.emitState();
    void this.pushMetadata(this.state.current);
  }

  /** The queue is the only holder of complete `Track` objects. */
  private fullTrackFor(uri: Uri): Track | undefined {
    const cur = this.deps.queue.current();
    if (cur?.track.uri === uri) return cur.track;
    if (this.state.current?.uri === uri) return this.state.current;
    return this.deps.queue.snapshot().upcoming.find((i) => i.track.uri === uri)?.track;
  }

  private async pushMetadata(track: Track | undefined): Promise<void> {
    const media = this.deps.host.mediaSession;
    if (!media) return;
    try {
      await media.setMetadata(track);
    } catch {
      // MPRIS/MediaSession is decorative; never let it break the transport.
    }
  }

  private async syncMediaState(): Promise<void> {
    const media = this.deps.host.mediaSession;
    if (!media) return;
    const snap = this.deps.queue.snapshot();
    const status = this.state.status === 'playing'
      ? 'playing'
      : this.state.status === 'idle' || this.state.status === 'ended'
        ? 'stopped'
        : 'paused';
    try {
      await media.setPlaybackState({
        status,
        positionMs: this.state.positionMs,
        durationMs: this.state.durationMs,
        canGoNext: snap.upcoming.length > 0 || this.deps.queue.peekNext() !== undefined,
        canGoPrevious: snap.history.length > 0 || this.state.positionMs > RESTART_PREVIOUS_MS,
      });
    } catch {
      // See pushMetadata.
    }
  }

  private maybeSaveProgress(): void {
    const bucket = Math.floor(this.state.positionMs / POSITION_SAVE_BUCKET_MS);
    if (bucket === this.lastSavedBucket) return;
    this.lastSavedBucket = bucket;
    this.saveSessionSoon();
  }

  private async persistSession(): Promise<void> {
    const payload: PersistedSession = {
      queue: this.deps.queue.serialize(),
      positionMs: Math.max(0, Math.round(this.state.positionMs)),
      volume: this.state.volume,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
    };
    try {
      await this.deps.host.kv.set(SESSION_KEY, JSON.stringify(payload));
    } catch {
      // Losing one session snapshot is not worth surfacing to the user.
    }
  }

  private async restoreSession(): Promise<void> {
    let raw: string | undefined;
    try {
      raw = await this.deps.host.kv.get(SESSION_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    const session = parseSession(raw);
    if (!session) return;

    try {
      this.deps.queue.restore(session.queue);
    } catch {
      return;
    }

    this.state.volume = Math.min(Math.max(session.volume, 0), 1);
    this.state.shuffle = this.deps.queue.isShuffled();
    this.state.repeat = this.deps.queue.repeat();
    try {
      await this.deps.engine.setVolume(this.state.volume);
    } catch {
      // Device may not be ready yet; the next setVolume wins.
    }

    const cur = this.deps.queue.current();
    if (!cur) return;

    const at = cur.track.isLive === true ? 0 : Math.max(0, Math.round(session.positionMs));
    this.state.current = cur.track;
    this.state.durationMs = cur.track.durationMs;
    this.state.positionMs = at;
    this.state.status = 'paused';
    this.pendingStartMs = at;
    this.lastSavedBucket = Math.floor(at / POSITION_SAVE_BUCKET_MS);
    void this.pushMetadata(cur.track);
    void this.syncMediaState();

    // Offline mode gets a lazy restore: the decoder is only fed once the user
    // actually presses play. `autoplay: false` keeps launch silent either way.
    if (this.settings.offlineMode) return;

    // Resolving the stream is a network round trip, and `init()` is awaited
    // before the app renders. Pre-buffering the restored track is a nicety, not
    // a prerequisite for showing the window, so it runs detached; `play()`
    // resolves again if this has not landed by the time the user presses it.
    void this.prebufferRestored(cur, at);
  }

  private async prebufferRestored(cur: QueueItem, at: number): Promise<void> {
    try {
      const stream = await this.resolveStream(cur.track);
      await this.applyGainFor(cur.track);
      this.intendedPlaying = false;
      await this.deps.engine.load(cur.track, stream, { startAtMs: at, autoplay: false });
      this.loadedItemId = cur.id;
      this.state.status = 'paused';
    } catch {
      // Stale signed URL or no network at launch: play() will resolve again.
      this.loadedItemId = undefined;
    }
  }

  private resetGuards(): void {
    this.failureStreak = 0;
    this.autoplayDeadEnd = false;
  }

  private reportError(error: PlaybackError): void {
    this.state.status = 'error';
    this.state.error = error;
    this.events.emit({ type: 'error', error });
    this.emitState();
  }

  private emitState(): void {
    this.events.emit({ type: 'state', state: this.getState() });
  }

  private emitQueue(): void {
    this.events.emit({ type: 'queue', snapshot: this.deps.queue.snapshot() });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks) {
    if (seen.has(t.uri)) continue;
    seen.add(t.uri);
    out.push(t);
  }
  return out;
}

/** Accepts either `Track[]` or `PlayHistoryEntry[]` so autoplay seeding is shape-agnostic. */
function toSeedTracks(items: readonly unknown[]): Track[] {
  const out: Track[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (typeof item.uri === 'string') {
      out.push(item as unknown as Track);
      continue;
    }
    const inner = item.track;
    if (isRecord(inner) && typeof inner.uri === 'string') out.push(inner as unknown as Track);
  }
  return out;
}

function parseSession(raw: string): PersistedSession | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.queue !== 'string') return undefined;
  const repeat = parsed.repeat;
  return {
    queue: parsed.queue,
    positionMs: typeof parsed.positionMs === 'number' && Number.isFinite(parsed.positionMs)
      ? parsed.positionMs
      : 0,
    volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
      ? parsed.volume
      : 1,
    shuffle: parsed.shuffle === true,
    repeat: repeat === 'all' || repeat === 'one' ? repeat : 'off',
  };
}

function toPlaybackError(e: unknown): PlaybackError {
  if (e instanceof ProviderError) {
    switch (e.code) {
      case 'not_found':
        return { code: 'not_found', message: e.message, retryable: false };
      case 'network':
      case 'rate_limited':
        return { code: 'network', message: e.message, retryable: true };
      case 'offline':
        return { code: 'network', message: e.message, retryable: false };
      case 'unsupported':
      case 'auth':
      case 'parse':
        return { code: 'stream_unresolved', message: e.message, retryable: false };
      default:
        return { code: 'unknown', message: e.message, retryable: true };
    }
  }
  if (e instanceof Error) {
    return { code: 'stream_unresolved', message: e.message, retryable: true };
  }
  return { code: 'unknown', message: String(e), retryable: false };
}
