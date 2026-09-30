import { create } from 'zustand';
import type {
  PlaybackController,
  PlaybackError,
  PlaybackState,
  PlaybackStatus,
  QueueSnapshot,
  RepeatMode,
  Track,
} from '@ritmo/core';

/**
 * The player state is kept flat rather than as a nested `PlaybackState` object
 * so that `usePlayerStore(s => s.volume)` really does isolate a re-render:
 * progress lands ~4 times a second and a single nested object reference would
 * invalidate every selector in the shell on each one.
 */
export interface PlayerStore {
  status: PlaybackStatus;
  current?: Track;
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  error?: PlaybackError;
  queue: QueueSnapshot;
  /** True while the user drags the seek bar — position updates are ignored then. */
  scrubbing: boolean;
  applyState(s: PlaybackState): void;
  applyQueue(q: QueueSnapshot): void;
  setScrubbing(v: boolean): void;
  setError(e?: PlaybackError): void;
}

function emptyQueue(): QueueSnapshot {
  return { history: [], upcoming: [] };
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  status: 'idle',
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
  volume: 1,
  muted: false,
  shuffle: false,
  repeat: 'off',
  queue: emptyQueue(),
  scrubbing: false,

  applyState: (s) => {
    set((prev) => ({
      status: s.status,
      current: s.current,
      // The seek bar owns the playhead mid-drag; adopting engine progress here
      // would make the thumb jump back under the pointer.
      positionMs: prev.scrubbing ? prev.positionMs : s.positionMs,
      durationMs: s.durationMs,
      bufferedMs: s.bufferedMs,
      volume: s.volume,
      muted: s.muted,
      shuffle: s.shuffle,
      repeat: s.repeat,
      error: s.error,
    }));
  },

  applyQueue: (q) => set({ queue: q }),

  setScrubbing: (v) => set({ scrubbing: v }),

  setError: (e) => set({ error: e }),
}));

/** Subscribes the store to controller events. Returns an unsubscribe fn. */
export function bindPlayerStore(controller: PlaybackController): () => void {
  const { applyState, applyQueue, setError } = usePlayerStore.getState();

  // Prime from the controller first: it may have restored a session before the
  // UI mounted, and no event will be replayed for that.
  applyState(controller.getState());
  applyQueue(controller.getQueue());

  return controller.events.on((e) => {
    switch (e.type) {
      case 'state':
        applyState(e.state);
        break;
      case 'queue':
        applyQueue(e.snapshot);
        break;
      case 'error':
        setError(e.error);
        break;
    }
  });
}
