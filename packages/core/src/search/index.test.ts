import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySearchResults } from '../types';
import type { ProviderId, SearchQuery, SearchResults, Track } from '../types';
import { ProviderError } from '../providers/types';
import type { MusicProvider, ProviderCapabilities } from '../providers/types';
import type { ProviderRegistry } from '../providers/registry';
import { dedupeTracks, rankTracks, trackKey, unifiedSearch } from './index';

// --- fixtures ---------------------------------------------------------------

interface TrackOver {
  uri?: string;
  title?: string;
  artist?: string;
  durationMs?: number;
  popularity?: number;
}

function makeTrack(provider: ProviderId, over: TrackOver = {}): Track {
  const title = over.title ?? 'Thunderstruck';
  const artist = over.artist ?? 'AC/DC';
  return {
    uri: over.uri ?? `${provider}:track:${title}|${artist}|${over.durationMs ?? 0}`,
    provider,
    title,
    artists: [{ uri: `${provider}:artist:${artist}`, name: artist }],
    durationMs: over.durationMs ?? 292_000,
    ...(over.popularity === undefined ? {} : { popularity: over.popularity }),
  };
}

const ALL_CAPS: ProviderCapabilities = {
  search: true,
  albums: true,
  artists: true,
  playlists: true,
  stations: true,
  related: true,
  shelves: true,
  downloadable: true,
  needsNetwork: true,
};

function results(over: Partial<SearchResults> = {}): SearchResults {
  return { ...emptySearchResults(), ...over };
}

interface Stub {
  id: ProviderId;
  search: (q: SearchQuery) => Promise<SearchResults>;
  capabilities?: Partial<ProviderCapabilities>;
  isReady?: () => Promise<boolean>;
}

function stubProvider(stub: Stub): MusicProvider {
  return {
    id: stub.id,
    displayName: stub.id,
    capabilities: { ...ALL_CAPS, ...stub.capabilities },
    search: stub.search,
    ...(stub.isReady === undefined ? {} : { isReady: stub.isReady }),
  } as unknown as MusicProvider;
}

interface StubRegistry {
  registry: ProviderRegistry;
  resets: number[];
  /** What the real registry would have handed to `lastErrors()`. */
  errors: Array<{ provider: ProviderId; code: string }>;
}

/** Only `ready`, `resetErrors` and `run` are reachable from unifiedSearch. */
function stubRegistry(providers: MusicProvider[]): StubRegistry {
  const resets: number[] = [];
  const errors: Array<{ provider: ProviderId; code: string }> = [];
  const registry = {
    available: () => providers,
    ready: async (): Promise<MusicProvider[]> => {
      const out: MusicProvider[] = [];
      for (const provider of providers) {
        if (await (provider.isReady?.() ?? true)) out.push(provider);
        else errors.push({ provider: provider.id, code: 'auth' });
      }
      return out;
    },
    resetErrors: () => {
      resets.push(1);
      errors.length = 0;
    },
    run: async <T>(id: ProviderId, op: string, fn: (p: MusicProvider) => Promise<T>): Promise<T> => {
      const provider = providers.find((p) => p.id === id);
      if (!provider) throw new ProviderError('unsupported', `no ${id}`, id);
      try {
        return await fn(provider);
      } catch (err) {
        throw err instanceof ProviderError
          ? err
          : new ProviderError('unknown', `${id}.${op}`, id, err);
      }
    },
  };
  return { registry: registry as unknown as ProviderRegistry, resets, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

// --- dedupeTracks -----------------------------------------------------------

describe('dedupeTracks', () => {
  it('collapses the same song from two providers onto the higher-priority copy', () => {
    const jamendo = makeTrack('jamendo', { durationMs: 292_000 });
    const local = makeTrack('local', { durationMs: 293_500 });

    const out = dedupeTracks([jamendo, local]);
    expect(out).toHaveLength(1);
    expect(out[0]!.provider).toBe('local');
  });

  it('keeps the higher-priority copy regardless of input order', () => {
    const jamendo = makeTrack('jamendo');
    const local = makeTrack('local');
    expect(dedupeTracks([local, jamendo])[0]!.provider).toBe('local');
    expect(dedupeTracks([jamendo, local])[0]!.provider).toBe('local');
  });

  it('applies the full local > jamendo > audius > archive > radio order', () => {
    const order: ProviderId[] = ['local', 'jamendo', 'audius', 'archive', 'radio'];
    for (let i = 0; i < order.length - 1; i += 1) {
      const better = order[i]!;
      const worse = order[i + 1]!;
      const out = dedupeTracks([makeTrack(worse), makeTrack(better)]);
      expect(out).toHaveLength(1);
      expect(out[0]!.provider).toBe(better);
    }

    const all = dedupeTracks([...order].reverse().map((id) => makeTrack(id)));
    expect(all).toHaveLength(1);
    expect(all[0]!.provider).toBe('local');
  });

  it('matches titles and artists that differ only in punctuation and case', () => {
    const a = makeTrack('jamendo', { title: 'Thunderstruck', artist: 'AC/DC' });
    const b = makeTrack('local', { title: 'thunder-struck!', artist: 'ac/dc.' });
    expect(trackKey(a)).toBe('thunderstruck|acdc');
    expect(trackKey(a)).toBe(trackKey(b));
    expect(dedupeTracks([a, b])).toHaveLength(1);
  });

  it('does not match an artist whose punctuation was really a word gap', () => {
    // Punctuation is deleted rather than turned into a space, so "AC/DC" and
    // "AC DC" are different keys — matching the Rust scanner.
    const slash = makeTrack('jamendo', { artist: 'AC/DC' });
    const spaced = makeTrack('local', { artist: 'AC DC' });
    expect(trackKey(slash)).not.toBe(trackKey(spaced));
    expect(dedupeTracks([slash, spaced])).toHaveLength(2);
  });

  it('keeps a live version whose duration is more than 3s away', () => {
    const studio = makeTrack('jamendo', { durationMs: 292_000 });
    const live = makeTrack('audius', { durationMs: 295_001 });
    expect(dedupeTracks([studio, live])).toHaveLength(2);
  });

  it('treats a 3s difference as the same recording and 3001ms as a different one', () => {
    expect(dedupeTracks([
      makeTrack('jamendo', { durationMs: 200_000 }),
      makeTrack('audius', { durationMs: 203_000 }),
    ])).toHaveLength(1);

    expect(dedupeTracks([
      makeTrack('jamendo', { durationMs: 200_000 }),
      makeTrack('audius', { durationMs: 203_001 }),
    ])).toHaveLength(2);
  });

  it('treats an unknown (zero) duration as compatible with any duration', () => {
    const streamed = makeTrack('radio', { durationMs: 0 });
    const known = makeTrack('jamendo', { durationMs: 292_000 });
    expect(dedupeTracks([streamed, known])).toHaveLength(1);
  });

  it('drops an exact duplicate uri even when it is the higher-priority provider', () => {
    const one = makeTrack('local', { uri: 'local:track:same' });
    const two = makeTrack('local', { uri: 'local:track:same', durationMs: 999_000 });
    expect(dedupeTracks([one, two])).toEqual([one]);
  });

  it('keeps distinct songs and their input order', () => {
    const a = makeTrack('jamendo', { title: 'A' });
    const b = makeTrack('jamendo', { title: 'B' });
    const c = makeTrack('audius', { title: 'C' });
    expect(dedupeTracks([a, b, c]).map((t) => t.title)).toEqual(['A', 'B', 'C']);
  });

  it('keeps the same title by a different artist', () => {
    const a = makeTrack('jamendo', { title: 'Hurt', artist: 'Nine Inch Nails' });
    const b = makeTrack('jamendo', { title: 'Hurt', artist: 'Johnny Cash' });
    expect(dedupeTracks([a, b])).toHaveLength(2);
  });
});

// --- rankTracks -------------------------------------------------------------

describe('rankTracks', () => {
  it('orders exact title match, then prefix, then substring, then the rest', () => {
    const none = makeTrack('jamendo', { title: 'Rock Anthem' });
    const substring = makeTrack('jamendo', { title: 'Benim Sarkim' });
    const prefix = makeTrack('jamendo', { title: 'Sarki Soylemek' });
    const exact = makeTrack('jamendo', { title: 'Sarki' });

    const out = rankTracks([none, substring, prefix, exact], 'sarki');
    expect(out.map((t) => t.title)).toEqual(['Sarki', 'Sarki Soylemek', 'Benim Sarkim', 'Rock Anthem']);
  });

  it('puts an exact match ahead of a far more popular partial match', () => {
    const popular = makeTrack('jamendo', { title: 'Sarki Soylemek', popularity: 1 });
    const exact = makeTrack('jamendo', { title: 'Sarki', popularity: 0 });
    expect(rankTracks([popular, exact], 'sarki')[0]!.title).toBe('Sarki');
  });

  it('breaks a tier tie by descending popularity', () => {
    const low = makeTrack('jamendo', { title: 'Sarki', artist: 'Low', popularity: 0.1 });
    const high = makeTrack('jamendo', { title: 'Sarki', artist: 'High', popularity: 0.9 });
    const none = makeTrack('jamendo', { title: 'Sarki', artist: 'None' });

    const out = rankTracks([low, none, high], 'sarki');
    expect(out.map((t) => t.artists[0]!.name)).toEqual(['High', 'Low', 'None']);
  });

  it('breaks a popularity tie by provider priority', () => {
    const archive = makeTrack('archive', { title: 'Sarki', popularity: 0.5 });
    const local = makeTrack('local', { title: 'Sarki', popularity: 0.5 });
    expect(rankTracks([archive, local], 'sarki').map((t) => t.provider)).toEqual(['local', 'archive']);
  });

  it('is stable: fully tied candidates keep their input order', () => {
    const tied = ['one', 'two', 'three', 'four', 'five'].map((n) =>
      makeTrack('jamendo', { title: 'Sarki', artist: n, popularity: 0.5 }));
    const out = rankTracks(tied, 'sarki');
    expect(out.map((t) => t.artists[0]!.name)).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(rankTracks([...tied].reverse(), 'sarki').map((t) => t.artists[0]!.name))
      .toEqual(['five', 'four', 'three', 'two', 'one']);
  });

  it('matches through diacritics and the dotless i', () => {
    const noisy = makeTrack('jamendo', { title: 'Something Else', popularity: 1 });
    const turkish = makeTrack('jamendo', { title: 'Şarkı', popularity: 0 });
    expect(rankTracks([noisy, turkish], 'sarki')[0]!.title).toBe('Şarkı');
    expect(rankTracks([noisy, turkish], 'ŞARKI')[0]!.title).toBe('Şarkı');
  });

  it('falls back to popularity order when the query normalises to nothing', () => {
    const a = makeTrack('jamendo', { title: 'A', popularity: 0.2 });
    const b = makeTrack('jamendo', { title: 'B', popularity: 0.8 });
    expect(rankTracks([a, b], '!!!').map((t) => t.title)).toEqual(['B', 'A']);
  });

  it('does not mutate the input array', () => {
    const input = [
      makeTrack('jamendo', { title: 'Zzz' }),
      makeTrack('jamendo', { title: 'Sarki' }),
    ];
    const snapshot = input.map((t) => t.title);
    rankTracks(input, 'sarki');
    expect(input.map((t) => t.title)).toEqual(snapshot);
  });
});

// --- unifiedSearch ----------------------------------------------------------

describe('unifiedSearch', () => {
  it('returns empty results for a blank query without asking any provider', async () => {
    const search = vi.fn(async () => results());
    const { registry, resets } = stubRegistry([stubProvider({ id: 'jamendo', search })]);

    expect(await unifiedSearch(registry, '   ')).toEqual(emptySearchResults());
    expect(search).not.toHaveBeenCalled();
    expect(resets).toHaveLength(0);
  });

  it('merges the tracks every provider returned', async () => {
    const { registry } = stubRegistry([
      stubProvider({
        id: 'jamendo',
        search: async () => results({ tracks: [makeTrack('jamendo', { title: 'J1' })] }),
      }),
      stubProvider({
        id: 'audius',
        search: async () => results({ tracks: [makeTrack('audius', { title: 'A1' })] }),
      }),
      stubProvider({
        id: 'archive',
        search: async () => results({ tracks: [makeTrack('archive', { title: 'R1' })] }),
      }),
    ]);

    const out = await unifiedSearch(registry, 'anything', { kinds: ['track'] });
    expect(out.tracks.map((t) => t.title).sort()).toEqual(['A1', 'J1', 'R1']);
  });

  it('dedupes across providers as part of the merge', async () => {
    const { registry } = stubRegistry([
      stubProvider({ id: 'jamendo', search: async () => results({ tracks: [makeTrack('jamendo')] }) }),
      stubProvider({ id: 'local', search: async () => results({ tracks: [makeTrack('local')] }) }),
    ]);

    const out = await unifiedSearch(registry, 'thunderstruck', { kinds: ['track'] });
    expect(out.tracks).toHaveLength(1);
    expect(out.tracks[0]!.provider).toBe('local');
  });

  it('keeps the results of the providers that answered when one rejects', async () => {
    const { registry } = stubRegistry([
      stubProvider({
        id: 'jamendo',
        search: async () => { throw new ProviderError('network', 'down', 'jamendo'); },
      }),
      stubProvider({
        id: 'audius',
        search: async () => results({ tracks: [makeTrack('audius', { title: 'Survivor' })] }),
      }),
    ]);

    const out = await unifiedSearch(registry, 'survivor', { kinds: ['track'] });
    expect(out.tracks.map((t) => t.title)).toEqual(['Survivor']);
  });

  it('returns empty results rather than rejecting when every provider fails', async () => {
    const { registry } = stubRegistry([
      stubProvider({ id: 'jamendo', search: async () => { throw new Error('boom'); } }),
      stubProvider({ id: 'audius', search: () => Promise.reject(new Error('boom')) }),
    ]);

    await expect(unifiedSearch(registry, 'x')).resolves.toEqual(emptySearchResults());
  });

  it('drops a provider that hangs past timeoutMs and still returns the fast ones', async () => {
    vi.useFakeTimers();
    let settled = false;
    const { registry } = stubRegistry([
      stubProvider({
        id: 'archive',
        search: () => new Promise<SearchResults>(() => { /* never settles */ }),
      }),
      stubProvider({
        id: 'jamendo',
        search: async () => results({ tracks: [makeTrack('jamendo', { title: 'Fast' })] }),
      }),
    ]);

    const pending = unifiedSearch(registry, 'fast', { kinds: ['track'], timeoutMs: 1000 })
      .then((r) => { settled = true; return r; });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const out = await pending;
    expect(settled).toBe(true);
    expect(out.tracks.map((t) => t.title)).toEqual(['Fast']);
  });

  it('honours kinds: only the requested kind is filled, and the request says so', async () => {
    const seen: SearchQuery[] = [];
    const { registry } = stubRegistry([
      stubProvider({
        id: 'jamendo',
        search: async (q) => {
          seen.push(q);
          return results({
            tracks: [makeTrack('jamendo', { title: 'T' })],
            albums: [{ uri: 'jamendo:album:1', provider: 'jamendo', name: 'Alb', artists: [] }],
            artists: [{ uri: 'jamendo:artist:1', provider: 'jamendo', name: 'Art' }],
          });
        },
      }),
    ]);

    const out = await unifiedSearch(registry, 'query', { kinds: ['track'] });
    expect(out.tracks).toHaveLength(1);
    expect(out.albums).toEqual([]);
    expect(out.artists).toEqual([]);
    expect(seen[0]!.kinds).toEqual(['track']);
  });

  it('only asks providers that serve the requested kind', async () => {
    const stations = vi.fn(async () => results());
    const noStations = vi.fn(async () => results());
    const { registry } = stubRegistry([
      stubProvider({ id: 'radio', search: stations, capabilities: { stations: true } }),
      stubProvider({ id: 'jamendo', search: noStations, capabilities: { stations: false } }),
    ]);

    await unifiedSearch(registry, 'jazz', { kinds: ['station'] });
    expect(stations).toHaveBeenCalledTimes(1);
    expect(noStations).not.toHaveBeenCalled();
  });

  it('skips providers that cannot search at all', async () => {
    const search = vi.fn(async () => results());
    const { registry } = stubRegistry([
      stubProvider({ id: 'local', search, capabilities: { search: false } }),
    ]);
    await unifiedSearch(registry, 'x');
    expect(search).not.toHaveBeenCalled();
  });

  it('honours the providers allow-list', async () => {
    const wanted = vi.fn(async () => results({ tracks: [makeTrack('audius', { title: 'Y' })] }));
    const other = vi.fn(async () => results());
    const { registry } = stubRegistry([
      stubProvider({ id: 'audius', search: wanted }),
      stubProvider({ id: 'jamendo', search: other }),
    ]);

    await unifiedSearch(registry, 'x', { providers: ['audius'] });
    expect(wanted).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('truncates the merged list to limit while asking providers for more', async () => {
    const seen: SearchQuery[] = [];
    const many = Array.from({ length: 30 }, (_, i) =>
      makeTrack('jamendo', { title: `Song ${i}`, popularity: 1 - i / 100 }));
    const { registry } = stubRegistry([
      stubProvider({
        id: 'jamendo',
        search: async (q) => { seen.push(q); return results({ tracks: many }); },
      }),
    ]);

    const out = await unifiedSearch(registry, 'song', { kinds: ['track'], limit: 3 });
    expect(out.tracks).toHaveLength(3);
    expect(seen[0]!.limit).toBeGreaterThan(3);
  });

  it('resets the error banner once per search', async () => {
    const { registry, resets } = stubRegistry([
      stubProvider({ id: 'jamendo', search: async () => results() }),
    ]);
    await unifiedSearch(registry, 'x');
    expect(resets).toHaveLength(1);
  });

  it('keeps the per-provider budget just over the merged limit', async () => {
    const seen: SearchQuery[] = [];
    const { registry } = stubRegistry([
      stubProvider({ id: 'jamendo', search: async (q) => { seen.push(q); return results(); } }),
    ]);

    await unifiedSearch(registry, 'x', { limit: 40 });
    expect(seen[0]!.limit).toBe(60);

    seen.length = 0;
    await unifiedSearch(registry, 'x', { limit: 200 });
    expect(seen[0]!.limit).toBe(80);
  });
});

// --- unifiedSearch: progressive results -------------------------------------

describe('unifiedSearch progressive results', () => {
  it('emits one partial per provider, each a superset of the last', async () => {
    const { registry } = stubRegistry([
      stubProvider({ id: 'local', search: async () => results({ tracks: [makeTrack('local', { title: 'A' })] }) }),
      stubProvider({ id: 'jamendo', search: async () => results({ tracks: [makeTrack('jamendo', { title: 'B' })] }) }),
      stubProvider({ id: 'audius', search: async () => results({ tracks: [makeTrack('audius', { title: 'C' })] }) }),
    ]);

    const sizes: number[] = [];
    const out = await unifiedSearch(registry, 'x', {
      kinds: ['track'],
      onPartial: (r) => sizes.push(r.tracks.length),
    });

    expect(sizes).toHaveLength(3);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes.at(-1)).toBe(3);
    expect(out.tracks).toHaveLength(3);
  });

  it('does not make a fast provider wait for one that exceeds timeoutMs', async () => {
    vi.useFakeTimers();
    const partials: number[] = [];
    const { registry } = stubRegistry([
      stubProvider({
        id: 'archive',
        search: () => new Promise<SearchResults>(() => { /* never settles */ }),
      }),
      stubProvider({
        id: 'jamendo',
        search: async () => results({ tracks: [makeTrack('jamendo', { title: 'Fast' })] }),
      }),
    ]);

    const pending = unifiedSearch(registry, 'fast', {
      kinds: ['track'],
      timeoutMs: 1000,
      onPartial: (r) => partials.push(r.tracks.length),
    });

    // The fast provider has painted while the slow one is still 1s from its
    // own deadline.
    await vi.advanceTimersByTimeAsync(0);
    expect(partials).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1001);
    const out = await pending;
    expect(partials).toEqual([1, 1]);
    expect(out.tracks.map((t) => t.title)).toEqual(['Fast']);
  });

  it('never calls a provider that reports itself unconfigured', async () => {
    const unconfigured = vi.fn(async () => results());
    const answering = vi.fn(async () => results({ tracks: [makeTrack('audius', { title: 'Y' })] }));
    const { registry, errors } = stubRegistry([
      stubProvider({ id: 'jamendo', search: unconfigured, isReady: async () => false }),
      stubProvider({ id: 'audius', search: answering }),
    ]);

    const out = await unifiedSearch(registry, 'x', { kinds: ['track'] });

    expect(unconfigured).not.toHaveBeenCalled();
    expect(answering).toHaveBeenCalledTimes(1);
    expect(out.tracks.map((t) => t.title)).toEqual(['Y']);
    // Reported as needing credentials, not as an outage.
    expect(errors).toEqual([{ provider: 'jamendo', code: 'auth' }]);
  });

  it('emits nothing more once the search is aborted', async () => {
    const controller = new AbortController();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const { registry } = stubRegistry([
      stubProvider({ id: 'local', search: async () => results({ tracks: [makeTrack('local', { title: 'A' })] }) }),
      stubProvider({
        id: 'audius',
        search: async () => {
          await gate;
          return results({ tracks: [makeTrack('audius', { title: 'B' })] });
        },
      }),
    ]);

    const partials: SearchResults[] = [];
    const out = await unifiedSearch(registry, 'x', {
      kinds: ['track'],
      signal: controller.signal,
      onPartial: (r) => {
        partials.push(r);
        // Stands in for the user typing one more character.
        controller.abort();
        release();
      },
    });

    expect(partials).toHaveLength(1);
    expect(partials[0]!.tracks.map((t) => t.title)).toEqual(['A']);
    expect(out).toEqual(emptySearchResults());
  });

  it('paints the fast providers while a 3s one is still outstanding', async () => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const after = <T>(ms: number, value: T): Promise<T> =>
      new Promise<T>((resolve) => { timers.push(setTimeout(() => resolve(value), ms)); });

    const { registry } = stubRegistry([
      stubProvider({
        id: 'archive',
        search: () => after(3000, results({ tracks: [makeTrack('archive', { title: 'Slow' })] })),
      }),
      stubProvider({
        id: 'jamendo',
        search: () => after(50, results({ tracks: [makeTrack('jamendo', { title: 'Fast1' })] })),
      }),
      stubProvider({
        id: 'audius',
        search: () => after(50, results({ tracks: [makeTrack('audius', { title: 'Fast2' })] })),
      }),
    ]);

    const started = performance.now();
    let firstPartialMs: number | undefined;

    try {
      await unifiedSearch(registry, 'x', {
        kinds: ['track'],
        timeoutMs: 300,
        onPartial: () => { firstPartialMs ??= performance.now() - started; },
      });
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }

    expect(firstPartialMs).toBeDefined();
    expect(firstPartialMs!).toBeLessThan(100);
  });
});
