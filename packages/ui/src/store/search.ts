import { create } from 'zustand';
import { debounce, emptySearchResults, unifiedSearch } from '@ritmo/core';
import type {
  HostBridge,
  ProviderError,
  ProviderId,
  ProviderRegistry,
  SearchResults,
} from '@ritmo/core';

export type SearchStatus = 'idle' | 'loading' | 'done' | 'error';
export type SearchFilter = 'all' | 'tracks' | 'albums' | 'artists' | 'playlists' | 'stations';

export interface SearchStore {
  query: string;
  results: SearchResults;
  status: SearchStatus;
  providerErrors: Array<{ provider: ProviderId; error: ProviderError }>;
  error?: Error;
  recent: string[];
  filter: SearchFilter;
  /** Debounced 250 ms; the newest call always wins. */
  run(registry: ProviderRegistry, q: string): void;
  /** Same search without the debounce — used by Enter and the palette. */
  runNow(registry: ProviderRegistry, q: string): Promise<void>;
  setFilter(filter: SearchFilter): void;
  clear(): void;
  removeRecent(q: string): void;
  clearRecent(): void;
  /** Loads the persisted recent list and keeps the host for later writes. */
  bind(host: HostBridge): void;
}

const RECENT_KEY = 'search:recent';
const RECENT_MAX = 12;
const DEBOUNCE_MS = 250;
/** Per entity kind, after merging and de-duplicating across providers. */
const RESULT_LIMIT = 40;

let host: HostBridge | undefined;
/**
 * Monotonic ticket per search. A resolution whose ticket is stale is dropped,
 * so a slow "be" can never land on top of a fast "beatles".
 */
let seq = 0;
let inFlight: AbortController | undefined;

/** Retires whatever is running: the ticket bump drops late resolutions, the
 *  abort stops the merge and ranking work sitting behind them. */
function abandon(): void {
  seq++;
  inFlight?.abort();
  inFlight = undefined;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function saveRecent(recent: string[]): void {
  void host?.kv.set(RECENT_KEY, JSON.stringify(recent)).catch(() => {});
}

function parseRecent(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

async function execute(registry: ProviderRegistry, q: string): Promise<void> {
  abandon();
  const ticket = seq;
  const controller = new AbortController();
  inFlight = controller;

  useSearchStore.setState({ status: 'loading', error: undefined });
  try {
    const results = await unifiedSearch(registry, q, {
      limit: RESULT_LIMIT,
      signal: controller.signal,
      // Each provider paints as it lands; status stays 'loading' until the last.
      onPartial: (partial) => {
        if (ticket !== seq) return;
        useSearchStore.setState({ results: partial, providerErrors: registry.lastErrors() });
      },
    });
    if (ticket !== seq) return;
    useSearchStore.setState({
      results,
      status: 'done',
      providerErrors: registry.lastErrors(),
    });
    rememberQuery(q);
  } catch (e) {
    if (ticket !== seq) return;
    useSearchStore.setState({
      status: 'error',
      error: toError(e),
      providerErrors: registry.lastErrors(),
    });
  }
}

function rememberQuery(q: string): void {
  const trimmed = q.trim();
  if (trimmed.length < 2) return;
  const key = trimmed.toLocaleLowerCase('tr');
  const recent = [trimmed, ...useSearchStore.getState().recent.filter((r) => r.toLocaleLowerCase('tr') !== key)]
    .slice(0, RECENT_MAX);
  useSearchStore.setState({ recent });
  saveRecent(recent);
}

const runDebounced = debounce((registry: ProviderRegistry, q: string) => {
  void execute(registry, q);
}, DEBOUNCE_MS);

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: '',
  results: emptySearchResults(),
  status: 'idle',
  providerErrors: [],
  recent: [],
  filter: 'all',

  run: (registry, q) => {
    set({ query: q });
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      runDebounced.cancel();
      abandon();
      set({ results: emptySearchResults(), status: 'idle', providerErrors: [], error: undefined });
      return;
    }
    runDebounced(registry, trimmed);
  },

  runNow: async (registry, q) => {
    set({ query: q });
    const trimmed = q.trim();
    runDebounced.cancel();
    if (trimmed.length === 0) {
      abandon();
      set({ results: emptySearchResults(), status: 'idle', providerErrors: [], error: undefined });
      return;
    }
    await execute(registry, trimmed);
  },

  setFilter: (filter) => set({ filter }),

  clear: () => {
    runDebounced.cancel();
    abandon();
    set({ query: '', results: emptySearchResults(), status: 'idle', providerErrors: [], error: undefined });
  },

  removeRecent: (q) => {
    const recent = get().recent.filter((r) => r !== q);
    set({ recent });
    saveRecent(recent);
  },

  clearRecent: () => {
    set({ recent: [] });
    saveRecent([]);
  },

  bind: (bridge) => {
    // Idempotent: every mounted search surface calls this, but the recent list
    // only has to be read off disk once.
    if (host === bridge) return;
    host = bridge;
    void bridge.kv
      .get(RECENT_KEY)
      .then((raw) => set({ recent: parseRecent(raw) }))
      .catch(() => {});
  },
}));
