import { useMemo } from 'react';
import type {
  PlaybackError,
  PlaybackStatus,
  PlayReason,
  RepeatMode,
  Track,
  Uri,
} from '@ritmo/core';

import { useServices } from '../services';
import { usePlayerStore } from '../store/player';

export interface PlaybackContextRef {
  uri?: Uri;
  name?: string;
}

export interface PlayerActions {
  toggle(): void;
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seek(positionMs: number): void;
  /** Relative seek, clamped to the track — used by the arrow-key shortcuts. */
  seekBy(deltaMs: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setShuffle(on: boolean): void;
  setRepeat(mode: RepeatMode): void;
  cycleRepeat(): void;
  playTrack(track: Track, reason?: PlayReason): void;
  playContext(tracks: Track[], startIndex: number, context?: PlaybackContextRef): void;
  playUri(uri: Uri): void;
  startRadio(seed: Track): void;
}

export interface PlayerApi extends PlayerActions {
  status: PlaybackStatus;
  current?: Track;
  durationMs: number;
  bufferedMs: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  error?: PlaybackError;
  isPlaying: boolean;
  isLoading: boolean;
  scrubbing: boolean;
  setScrubbing(v: boolean): void;
}

const REPEAT_CYCLE: RepeatMode[] = ['off', 'all', 'one'];

/**
 * Every transport action lands here. The controller reports failures through
 * its own error event, so a rejected command must not become an unhandled
 * rejection in the view that triggered it.
 */
function fire(p: Promise<unknown>): void {
  void p.catch(() => {});
}

/**
 * Note there is no `positionMs`: it moves 4×/s and would re-render every
 * consumer of this hook. Read it with `useSmoothPosition()` in the one
 * component that draws the playhead.
 */
export function usePlayer(): PlayerApi {
  const { controller } = useServices();

  const status = usePlayerStore((s) => s.status);
  const current = usePlayerStore((s) => s.current);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const bufferedMs = usePlayerStore((s) => s.bufferedMs);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const error = usePlayerStore((s) => s.error);
  const scrubbing = usePlayerStore((s) => s.scrubbing);
  const setScrubbing = usePlayerStore((s) => s.setScrubbing);

  const actions = useMemo<PlayerActions>(
    () => ({
      toggle: () => fire(controller.toggle()),
      play: () => fire(controller.play()),
      pause: () => fire(controller.pause()),
      next: () => fire(controller.next()),
      previous: () => fire(controller.previous()),
      seek: (positionMs) => fire(controller.seek(Math.max(0, Math.round(positionMs)))),
      seekBy: (deltaMs) => {
        const { positionMs, durationMs: total } = usePlayerStore.getState();
        const target = positionMs + deltaMs;
        const clamped = total > 0 ? Math.min(Math.max(0, target), total) : Math.max(0, target);
        fire(controller.seek(Math.round(clamped)));
      },
      setVolume: (v) => fire(controller.setVolume(Math.min(1, Math.max(0, v)))),
      setMuted: (m) => fire(controller.setMuted(m)),
      setShuffle: (on) => fire(controller.setShuffle(on)),
      setRepeat: (mode) => fire(controller.setRepeat(mode)),
      cycleRepeat: () => {
        const at = REPEAT_CYCLE.indexOf(usePlayerStore.getState().repeat);
        const nextMode = REPEAT_CYCLE[(at + 1) % REPEAT_CYCLE.length] ?? 'off';
        fire(controller.setRepeat(nextMode));
      },
      playTrack: (track, reason) => fire(controller.playTrack(track, reason)),
      playContext: (tracks, startIndex, context) =>
        fire(controller.playContext(tracks, startIndex, context)),
      playUri: (uri) => fire(controller.playUri(uri)),
      startRadio: (seed) => fire(controller.startRadio(seed)),
    }),
    [controller],
  );

  return {
    status,
    current,
    durationMs,
    bufferedMs,
    volume,
    muted,
    shuffle,
    repeat,
    error,
    isPlaying: status === 'playing',
    isLoading: status === 'loading',
    scrubbing,
    setScrubbing,
    ...actions,
  };
}
