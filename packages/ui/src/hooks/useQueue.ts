import { useMemo } from 'react';
import type { QueueEngine, QueueItem, QueueSnapshot, Track, Uri } from '@ritmo/core';

import { useServices } from '../services';
import type { RitmoServices } from '../services';
import { usePlayerStore } from '../store/player';

export interface QueueApi {
  snapshot: QueueSnapshot;
  current?: QueueItem;
  history: QueueItem[];
  upcoming: QueueItem[];
  /** "Next in queue" — explicitly queued by the user, removable. */
  userQueued: QueueItem[];
  /** "Next from <context>" — the rest of the album/playlist/radio. */
  fromContext: QueueItem[];
  contextUri?: Uri;
  contextName?: string;
  /** False when the host exposed no mutable queue; the panel then hides its controls. */
  editable: boolean;
  addNext(tracks: Track[]): void;
  addToQueue(tracks: Track[]): void;
  remove(itemId: string): void;
  move(itemId: string, toIndex: number): void;
  clearUpcoming(): void;
  clear(): void;
  /** Jumps straight to a queued item. */
  playItem(item: QueueItem): void;
}

/**
 * `RitmoServices` is frozen and carries the controller but not the QueueEngine,
 * yet the queue panel has to reorder, remove and clear entries. So the engine is
 * looked for on the services object (the composition root may expose it) and
 * otherwise on the controller it was built with. Both are runtime lookups, and a
 * miss degrades the queue to read-only instead of throwing.
 */
function queueEngineOf(services: RitmoServices): QueueEngine | undefined {
  const exposed = (services as RitmoServices & { queue?: QueueEngine }).queue;
  if (exposed) return exposed;
  const deps = (services.controller as unknown as { deps?: { queue?: QueueEngine } }).deps;
  return deps?.queue;
}

export function useQueue(): QueueApi {
  const services = useServices();
  const snapshot = usePlayerStore((s) => s.queue);

  const engine = useMemo(() => queueEngineOf(services), [services]);

  const split = useMemo(() => {
    const userQueued: QueueItem[] = [];
    const fromContext: QueueItem[] = [];
    for (const item of snapshot.upcoming) {
      if (item.userQueued) userQueued.push(item);
      else fromContext.push(item);
    }
    return { userQueued, fromContext };
  }, [snapshot]);

  const actions = useMemo(
    () => ({
      addNext: (tracks: Track[]) => engine?.addNext(tracks),
      addToQueue: (tracks: Track[]) => engine?.addToQueue(tracks),
      remove: (itemId: string) => engine?.remove(itemId),
      move: (itemId: string, toIndex: number) => engine?.move(itemId, toIndex),
      clearUpcoming: () => engine?.clearUpcoming(),
      clear: () => engine?.clear(),
      playItem: (item: QueueItem) => {
        const upcoming = usePlayerStore.getState().queue.upcoming;
        // There is no "jump to index" on the engine, so the item is pulled to
        // the front of the queue and then consumed by a normal advance.
        if (engine && upcoming.some((u) => u.id === item.id)) {
          engine.move(item.id, 0);
          void services.controller.next().catch(() => {});
          return;
        }
        void services.controller.playTrack(item.track).catch(() => {});
      },
    }),
    [engine, services],
  );

  return {
    snapshot,
    current: snapshot.current,
    history: snapshot.history,
    upcoming: snapshot.upcoming,
    userQueued: split.userQueued,
    fromContext: split.fromContext,
    contextUri: snapshot.contextUri,
    contextName: snapshot.contextName,
    editable: engine !== undefined,
    ...actions,
  };
}
