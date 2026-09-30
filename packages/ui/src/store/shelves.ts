import { create } from 'zustand';
import { readShelfCache, writeShelfCache } from '@ritmo/core';
import type { HostBridge, ProviderError, ProviderId, ProviderRegistry, Shelf } from '@ritmo/core';

/**
 * Home's shelves, held for the whole session.
 *
 * Three things make the screen paint instantly instead of on the slowest
 * provider's clock:
 *   1. the rows live here rather than in a per-mount `useAsync`, so navigating
 *      away from Home and back re-renders instead of re-fetching;
 *   2. the assembled list is persisted, and a mount with a matching provider
 *      signature paints it straight off disk while the fan-out revalidates;
 *   3. `registry.shelves()` reports partials, so the first provider to answer
 *      is on screen without waiting for the rest.
 */

export type ShelvesStatus = 'idle' | 'loading' | 'done' | 'error';

export interface ShelvesStore {
  shelves: Shelf[];
  status: ShelvesStatus;
  /** A revalidation running behind rows that are already on screen. */
  refreshing: boolean;
  providerErrors: Array<{ provider: ProviderId; error: ProviderError }>;
  error?: Error;
  /** Provider signature the rows on screen were assembled under. */
  fingerprint?: string;
  /** Fetches once per signature per session; a no-op for one already served. */
  load(registry: ProviderRegistry, fingerprint: string): void;
  /** Re-fetches unconditionally, keeping the current rows on screen. */
  refresh(registry: ProviderRegistry, fingerprint: string): void;
  /** Hands over the bridge the cache is read from and written to. */
  bind(host: HostBridge): void;
}

let host: HostBridge | undefined;
/** Monotonic ticket per run; a resolution with a stale ticket is dropped. */
let seq = 0;
/** Signature of the run in flight or already served this session. */
let served: string | undefined;

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

async function execute(
  registry: ProviderRegistry,
  fingerprint: string,
  useCache: boolean,
): Promise<void> {
  const ticket = ++seq;
  served = fingerprint;

  const before = useShelvesStore.getState();
  // Rows assembled under a different provider set are not a head start, they
  // are wrong; only a same-signature refresh gets to keep what is on screen.
  const keep = before.fingerprint === fingerprint && before.shelves.length > 0;

  useShelvesStore.setState({
    fingerprint,
    status: keep ? 'done' : 'loading',
    refreshing: keep,
    error: undefined,
    ...(keep ? {} : { shelves: [], providerErrors: [] }),
  });

  /** Set once fresh rows are on screen; from then on the cache is irrelevant. */
  let painted = keep;

  if (useCache && !keep) {
    // Deliberately not awaited: the fan-out below starts in the same tick, so
    // a cold cache costs nothing and a warm one simply wins the race.
    void readShelfCache(host?.kv, fingerprint)
      .then((entry) => {
        if (ticket !== seq || painted || !entry) return;
        useShelvesStore.setState({ shelves: entry.shelves, status: 'done', refreshing: true });
      })
      .catch(() => {});
  }

  try {
    const shelves = await registry.shelves({
      onPartial: (partial) => {
        if (ticket !== seq || partial.length === 0) return;
        // While the cached list is still on screen a shorter partial would
        // collapse rows the reader is looking at and grow them back a moment
        // later, so the swap waits until the fresh set has caught up.
        if (!painted && partial.length < useShelvesStore.getState().shelves.length) return;
        painted = true;
        useShelvesStore.setState({
          shelves: partial,
          status: 'done',
          refreshing: true,
          providerErrors: registry.lastErrors(),
        });
      },
    });

    if (ticket !== seq) return;
    useShelvesStore.setState({
      shelves,
      status: 'done',
      refreshing: false,
      providerErrors: registry.lastErrors(),
    });
    await writeShelfCache(host?.kv, fingerprint, shelves);
  } catch (e) {
    if (ticket !== seq) return;
    // `shelves()` only rejects before any provider ran, so anything still on
    // screen is a cached paint worth keeping behind the banner.
    const rows = useShelvesStore.getState().shelves;
    useShelvesStore.setState({
      status: rows.length > 0 ? 'done' : 'error',
      refreshing: false,
      error: toError(e),
      providerErrors: registry.lastErrors(),
    });
    // Let the next mount retry rather than treat this signature as served.
    if (served === fingerprint) served = undefined;
  }
}

export const useShelvesStore = create<ShelvesStore>(() => ({
  shelves: [],
  status: 'idle',
  refreshing: false,
  providerErrors: [],

  load: (registry, fingerprint) => {
    if (served === fingerprint) return;
    void execute(registry, fingerprint, true);
  },

  refresh: (registry, fingerprint) => {
    void execute(registry, fingerprint, false);
  },

  bind: (bridge) => {
    host = bridge;
  },
}));

/** Drops the bridge and the served marker so a rebind re-fetches once. */
export function unbindShelvesStore(): void {
  host = undefined;
  served = undefined;
  seq++;
}
