import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '../util/emitter';
import { createFakeHost, track } from '../library/testing';
import { Library } from '../library';
import { QueueEngine } from './queue';
import { PlaybackController } from './controller';
import { defaultSettings } from '../types';
import type { AudioEngine, EngineEvent } from '../engine/types';
import type { ProviderRegistry } from '../providers/registry';
import type { StreamRef, Track } from '../types';

/**
 * A stand-in for the real engine that lets a test push engine events by hand.
 * It deliberately echoes back only the fields the native engine actually
 * carries (`WireTrack` in docs/ipc.md), because faithfully reproducing that
 * truncation is the whole point of these tests.
 */
function createFakeEngine() {
  const events = new Emitter<EngineEvent>();
  const loaded: Track[] = [];
  let position = 0;
  let duration = 0;

  const engine: AudioEngine = {
    kind: 'rust',
    supportsGapless: true,
    supportsEqualizer: true,
    supportsReplayGain: true,
    init: async () => undefined,
    dispose: async () => undefined,
    load: async (t, _stream, opts) => {
      loaded.push(t);
      duration = t.durationMs;
      position = opts?.startAtMs ?? 0;
    },
    preload: async () => undefined,
    play: async () => undefined,
    pause: async () => undefined,
    stop: async () => undefined,
    seek: async (ms) => {
      position = ms;
    },
    setVolume: async () => undefined,
    setMuted: async () => undefined,
    setEqualizer: async () => undefined,
    setReplayGain: async () => undefined,
    setCrossfadeMs: async () => undefined,
    getPosition: () => position,
    getDuration: () => duration,
    on: (h) => events.on(h),
  };

  /** Exactly what the Rust side emits: uri, title, durationMs and the flags. */
  const emitStarted = (t: Track): void => {
    events.emit({
      type: 'started',
      track: { uri: t.uri, title: t.title, durationMs: t.durationMs, isLive: t.isLive },
    });
  };

  return { engine, events, loaded, emitStarted };
}

function createFakeRegistry(stream: StreamRef): ProviderRegistry {
  return {
    resolveStream: async () => stream,
    resolveTrack: async (uri: string) => track(uri),
    forUri: () => undefined,
    shelves: async () => [],
    lastErrors: () => [],
  } as unknown as ProviderRegistry;
}

describe('PlaybackController', () => {
  let host: ReturnType<typeof createFakeHost>;
  let library: Library;
  let fake: ReturnType<typeof createFakeEngine>;
  let controller: PlaybackController;

  const stream: StreamRef = { url: 'https://example.invalid/a.mp3', kind: 'progressive' };

  beforeEach(async () => {
    host = createFakeHost();
    library = new Library(host);
    await library.init();
    fake = createFakeEngine();
    controller = new PlaybackController({
      engine: fake.engine,
      queue: new QueueEngine(),
      registry: createFakeRegistry(stream),
      host,
      library,
      settings: defaultSettings(),
    });
    await controller.init();
  });

  afterEach(async () => {
    await controller.dispose();
    vi.useRealTimers();
  });

  it('keeps the full track when the engine echoes back only its decode subset', async () => {
    const full = track('radio1', {
      title: 'Cool FM',
      artists: [{ uri: 'radio:artist:live', name: 'NG' }],
      album: { uri: 'album:1', name: 'Canlı' },
      isLive: true,
      durationMs: 0,
    });

    await controller.playTrack(full);
    fake.emitStarted(full);

    const current = controller.getState().current;
    expect(current?.uri).toBe(full.uri);
    // The regression: adopting the engine's echo dropped these and the player
    // bar threw on `track.artists.map`.
    expect(current?.artists).toEqual(full.artists);
    expect(current?.album).toEqual(full.album);
  });

  it('never exposes a current track without an artists array', async () => {
    const tracks = [track('a'), track('b'), track('c')];
    await controller.playContext(tracks, 0);

    for (const t of tracks) {
      fake.emitStarted(t);
      const current = controller.getState().current;
      expect(Array.isArray(current?.artists)).toBe(true);
      await controller.next();
    }
  });

  it('stays paused when the engine reports a frame for a track it only pre-buffered', async () => {
    // A restored session loads with autoplay:false; the engine still decodes a
    // first frame, and treating that as "playing" made the app announce itself
    // as playing on launch while producing no sound.
    const t = track('restored');
    await controller.playTrack(t);
    await controller.pause();

    fake.emitStarted(t);

    expect(controller.getState().status).toBe('paused');
  });

  it('reports playing once the transport was actually asked to run', async () => {
    const t = track('live-one');
    await controller.playTrack(t);
    fake.emitStarted(t);
    expect(controller.getState().status).toBe('playing');
  });

  it('ignores a started event for a track that is no longer queued', async () => {
    const a = track('a');
    await controller.playTrack(a);
    fake.emitStarted(a);

    const before = controller.getState().current;
    fake.emitStarted(track('stale'));
    expect(controller.getState().current).toEqual(before);
  });

  it('emits a state event carrying the enriched current track', async () => {
    const full = track('x', { artists: [{ uri: 'artist:x', name: 'X' }] });
    const seen: Array<Track | undefined> = [];
    controller.events.on((e) => {
      if (e.type === 'state') seen.push(e.state.current);
    });

    await controller.playTrack(full);
    fake.emitStarted(full);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t === undefined || Array.isArray(t.artists))).toBe(true);
  });

  /**
   * The artist page handed `playContext` a top-tracks list that held the same
   * recording twice. The queue is right to keep one entry per position, so the
   * contract worth pinning is that playback walks the positions in order and
   * lands on each of them exactly once.
   */
  it('plays a context with repeated tracks one position at a time', async () => {
    const a = track('a');
    const tracks = [a, track('b'), a, track('c')];

    await controller.playContext(tracks, 0);
    const played = [controller.getQueue().current?.id];
    for (let i = 0; i < tracks.length - 1; i++) {
      await controller.next();
      played.push(controller.getQueue().current?.id);
    }

    expect(fake.loaded.map((t) => t.uri)).toEqual(tracks.map((t) => t.uri));
    expect(new Set(played).size).toBe(tracks.length);
    expect(controller.getQueue().upcoming).toEqual([]);
  });
});
