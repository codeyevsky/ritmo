import { describe, expect, it, vi } from 'vitest';
import { emptySearchResults } from '../types';
import type { ProviderId, SearchQuery, SearchResults, Track, Uri } from '../types';
import { ProviderError } from '../providers/types';
import type { MusicProvider, ProviderCapabilities } from '../providers/types';
import type { ProviderRegistry } from '../providers/registry';
import { buildAutoplay, buildTrackRadio, spaceByArtist } from './index';

// --- fixtures ---------------------------------------------------------------

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

interface TrackOver {
  uri?: Uri;
  title?: string;
  artist?: string;
  durationMs?: number;
  genres?: string[];
}

function makeTrack(provider: ProviderId, id: string, over: TrackOver = {}): Track {
  const artist = over.artist ?? `Artist ${id}`;
  return {
    uri: over.uri ?? `${provider}:track:${id}`,
    provider,
    title: over.title ?? `Song ${id}`,
    artists: [{ uri: `${provider}:artist:${artist}`, name: artist }],
    durationMs: over.durationMs ?? 200_000,
    ...(over.genres === undefined ? {} : { genres: over.genres }),
  };
}

interface ProviderStub {
  id: ProviderId;
  capabilities?: Partial<ProviderCapabilities>;
  search?: (q: SearchQuery) => Promise<SearchResults>;
  getRelatedTracks?: (track: Track, limit: number) => Promise<Track[]>;
  getArtistTopTracks?: (uri: Uri) => Promise<Track[]>;
}

/** Only `get`, `ready`, `resetErrors`, `run` and `host.db` are reachable here. */
function stubRegistry(
  stubs: ProviderStub[],
  db: (sql: string) => Promise<Array<Record<string, unknown>>> = async () => [],
): ProviderRegistry {
  const providers = stubs.map((stub) => ({
    id: stub.id,
    displayName: stub.id,
    capabilities: { ...ALL_CAPS, ...stub.capabilities },
    search: stub.search ?? (async () => emptySearchResults()),
    ...(stub.getRelatedTracks === undefined ? {} : { getRelatedTracks: stub.getRelatedTracks }),
    ...(stub.getArtistTopTracks === undefined ? {} : { getArtistTopTracks: stub.getArtistTopTracks }),
  } as unknown as MusicProvider));

  return {
    host: { db: { query: (sql: string) => db(sql) } },
    get: (id: ProviderId) => providers.find((p) => p.id === id),
    available: () => providers,
    ready: () => Promise.resolve(providers),
    resetErrors: () => { /* no banner in tests */ },
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
  } as unknown as ProviderRegistry;
}

function results(tracks: Track[]): SearchResults {
  return { ...emptySearchResults(), tracks };
}

// --- spaceByArtist ----------------------------------------------------------

/** Smallest index distance between two tracks credited to the same artist. */
function minSameArtistDistance(tracks: Track[]): number {
  let best = Number.POSITIVE_INFINITY;
  const lastSeen = new Map<string, number>();
  tracks.forEach((track, i) => {
    const name = track.artists[0]?.name ?? '';
    const prev = lastSeen.get(name);
    if (prev !== undefined) best = Math.min(best, i - prev);
    lastSeen.set(name, i);
  });
  return best;
}

describe('spaceByArtist', () => {
  it('holds same-artist tracks more than `gap` apart when the pool allows it', () => {
    const input: Track[] = [];
    for (const artist of ['A', 'B', 'C']) {
      for (const n of [1, 2]) input.push(makeTrack('jamendo', `${artist}${n}`, { artist }));
    }

    const out = spaceByArtist(input, 2);
    expect(out).toHaveLength(6);
    expect(minSameArtistDistance(out)).toBeGreaterThan(2);
  });

  it('honours a larger gap when there are enough distinct artists', () => {
    const input: Track[] = [];
    for (const artist of ['A', 'B', 'C', 'D']) {
      for (const n of [1, 2]) input.push(makeTrack('jamendo', `${artist}${n}`, { artist }));
    }

    const out = spaceByArtist(input, 3);
    expect(minSameArtistDistance(out)).toBeGreaterThan(3);
  });

  it('returns every track even when one artist dominates the pool', () => {
    const input = ['1', '2', '3', '4', '5'].map((n) =>
      makeTrack('jamendo', n, { artist: 'Only Artist' }));

    const out = spaceByArtist(input, 3);
    expect(out.map((t) => t.uri).sort()).toEqual(input.map((t) => t.uri).sort());
  });

  it('loses nothing when spacing is only partly satisfiable', () => {
    const input = [
      makeTrack('jamendo', 'a1', { artist: 'A' }),
      makeTrack('jamendo', 'a2', { artist: 'A' }),
      makeTrack('jamendo', 'a3', { artist: 'A' }),
      makeTrack('jamendo', 'b1', { artist: 'B' }),
      makeTrack('jamendo', 'c1', { artist: 'C' }),
    ];
    const out = spaceByArtist(input, 3);
    expect(out).toHaveLength(5);
    expect(new Set(out.map((t) => t.uri)).size).toBe(5);
  });

  it('separates artists that differ only in case or diacritics', () => {
    const input = [
      makeTrack('jamendo', '1', { artist: 'Şebnem Ferah' }),
      makeTrack('jamendo', '2', { artist: 'sebnem ferah' }),
      makeTrack('jamendo', '3', { artist: 'Other' }),
      makeTrack('jamendo', '4', { artist: 'Another' }),
    ];
    const out = spaceByArtist(input, 2);
    const names = out.map((t) => t.artists[0]!.name.toLowerCase());
    expect(names.indexOf('şebnem ferah')).not.toBe(-1);
    // Normalised to the same key, so they must not end up adjacent.
    expect(Math.abs(names.indexOf('şebnem ferah') - names.indexOf('sebnem ferah'))).toBeGreaterThan(2);
  });

  it('passes the list straight through for gap 0 or fewer than three tracks', () => {
    const input = [
      makeTrack('jamendo', '1', { artist: 'A' }),
      makeTrack('jamendo', '2', { artist: 'A' }),
      makeTrack('jamendo', '3', { artist: 'A' }),
    ];
    expect(spaceByArtist(input, 0)).toEqual(input);
    expect(spaceByArtist(input.slice(0, 2), 3)).toEqual(input.slice(0, 2));
  });

  it('does not mutate its input', () => {
    const input: Track[] = [];
    for (const artist of ['A', 'B', 'C']) {
      for (const n of [1, 2]) input.push(makeTrack('jamendo', `${artist}${n}`, { artist }));
    }
    const snapshot = input.map((t) => t.uri);
    spaceByArtist(input, 2);
    expect(input.map((t) => t.uri)).toEqual(snapshot);
  });
});

// --- buildTrackRadio --------------------------------------------------------

const SEED = makeTrack('audius', 'seed', { artist: 'Seed Artist', genres: ['rock'] });

function radioRegistry(): ProviderRegistry {
  const related = Array.from({ length: 12 }, (_, i) =>
    makeTrack('audius', `rel${i}`, { artist: `Rel ${i}` }));
  const top = Array.from({ length: 8 }, (_, i) =>
    makeTrack('audius', `top${i}`, { artist: 'Seed Artist' }));
  const found = Array.from({ length: 10 }, (_, i) =>
    makeTrack('jamendo', `srch${i}`, { artist: `Srch ${i}` }));

  return stubRegistry([
    {
      id: 'audius',
      // The provider hands back the seed itself, as real "related" endpoints do.
      getRelatedTracks: async () => [SEED, ...related],
      getArtistTopTracks: async () => top,
      search: async () => results([]),
    },
    { id: 'jamendo', search: async () => results(found) },
  ]);
}

describe('buildTrackRadio', () => {
  it('never includes the seed track', async () => {
    const out = await buildTrackRadio(radioRegistry(), SEED, 40);
    expect(out.length).toBeGreaterThan(0);
    expect(out.map((t) => t.uri)).not.toContain(SEED.uri);
  });

  it('excludes the seed even when it only reaches the queue through search', async () => {
    const registry = stubRegistry([
      { id: 'audius', search: async () => results([SEED, makeTrack('audius', 'other')]) },
    ]);
    const out = await buildTrackRadio(registry, SEED, 20);
    expect(out.map((t) => t.uri)).toEqual(['audius:track:other']);
  });

  it('collapses a song offered by two providers into one queue entry', async () => {
    const shared = { title: 'Shared Song', artist: 'Shared Artist', durationMs: 200_000 };
    const registry = stubRegistry([
      {
        id: 'audius',
        getRelatedTracks: async () => [makeTrack('audius', 'dup', shared)],
        getArtistTopTracks: async () => [],
        search: async () => results([]),
      },
      { id: 'jamendo', search: async () => results([makeTrack('jamendo', 'dup', shared)]) },
    ]);

    const out = await buildTrackRadio(registry, SEED, 20);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Shared Song');
  });

  it('never returns more than the requested limit', async () => {
    for (const limit of [1, 5, 17]) {
      const out = await buildTrackRadio(radioRegistry(), SEED, limit);
      expect(out).toHaveLength(limit);
    }
  });

  it('never returns duplicate uris', async () => {
    const out = await buildTrackRadio(radioRegistry(), SEED, 40);
    expect(new Set(out.map((t) => t.uri)).size).toBe(out.length);
  });

  it('gives the same order for the same seed uri on a re-open', async () => {
    const first = await buildTrackRadio(radioRegistry(), SEED, 30);
    const second = await buildTrackRadio(radioRegistry(), SEED, 30);
    expect(second.map((t) => t.uri)).toEqual(first.map((t) => t.uri));
    expect(first.length).toBeGreaterThan(5);
  });

  it('gives a different order for a different seed uri over the same candidate pool', async () => {
    const pool = Array.from({ length: 16 }, (_, i) =>
      makeTrack('audius', `pool${i}`, { artist: `Pool ${i}` }));
    const build = (): ProviderRegistry => stubRegistry([{
      id: 'audius',
      getRelatedTracks: async () => pool,
      getArtistTopTracks: async () => [],
      search: async () => results([]),
    }]);

    const a = await buildTrackRadio(build(), SEED, 16);
    const b = await buildTrackRadio(build(), { ...SEED, uri: 'audius:track:seed-2' }, 16);

    expect(new Set(b.map((t) => t.uri))).toEqual(new Set(a.map((t) => t.uri)));
    expect(b.map((t) => t.uri)).not.toEqual(a.map((t) => t.uri));
  });

  it('does not depend on Math.random', async () => {
    const random = vi.spyOn(Math, 'random');
    try {
      await buildTrackRadio(radioRegistry(), SEED, 20);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it('excludes recently played tracks, and relaxes that rather than returning nothing', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeTrack('audius', `rel${i}`, { artist: `Rel ${i}` }));
    const history = candidates.map((t) => ({ track_uri: t.uri }));

    const partial = stubRegistry(
      [{
        id: 'audius',
        getRelatedTracks: async () => candidates,
        getArtistTopTracks: async () => [makeTrack('audius', 'fresh', { artist: 'Fresh' })],
        search: async () => results([]),
      }],
      async () => history,
    );
    expect((await buildTrackRadio(partial, SEED, 20)).map((t) => t.uri))
      .toEqual(['audius:track:fresh']);

    const exhausted = stubRegistry(
      [{
        id: 'audius',
        getRelatedTracks: async () => candidates,
        getArtistTopTracks: async () => [],
        search: async () => results([]),
      }],
      async () => history,
    );
    const relaxed = await buildTrackRadio(exhausted, SEED, 20);
    expect(relaxed).toHaveLength(6);
  });

  it('returns an empty queue instead of throwing when every provider fails', async () => {
    const registry = stubRegistry(
      [{
        id: 'audius',
        getRelatedTracks: async () => { throw new Error('related down'); },
        getArtistTopTracks: async () => { throw new Error('top down'); },
        search: async () => { throw new Error('search down'); },
      }],
      async () => { throw new Error('no history table'); },
    );
    await expect(buildTrackRadio(registry, SEED, 20)).resolves.toEqual([]);
  });
});

// --- buildAutoplay ----------------------------------------------------------

describe('buildAutoplay', () => {
  it('returns nothing when there is no history to seed from', async () => {
    const getRelatedTracks = vi.fn(async () => [makeTrack('audius', 'x')]);
    const registry = stubRegistry([{ id: 'audius', getRelatedTracks }]);

    await expect(buildAutoplay(registry, [])).resolves.toEqual([]);
    expect(getRelatedTracks).not.toHaveBeenCalled();
  });

  it('returns nothing when the history table itself is unavailable', async () => {
    const registry = stubRegistry(
      [{ id: 'audius', getRelatedTracks: async () => [makeTrack('audius', 'x')] }],
      async () => { throw new Error('no such table: play_history'); },
    );
    await expect(buildAutoplay(registry, [])).resolves.toEqual([]);
  });

  it('returns nothing when every provider fails for a non-empty history', async () => {
    const registry = stubRegistry(
      [{
        id: 'audius',
        getRelatedTracks: async () => { throw new Error('down'); },
        getArtistTopTracks: async () => { throw new Error('down'); },
        search: async () => { throw new Error('down'); },
      }],
      async () => { throw new Error('down'); },
    );

    await expect(buildAutoplay(registry, [makeTrack('audius', 'hist')], 10)).resolves.toEqual([]);
  });

  it('seeds from the database when the caller has no in-memory history', async () => {
    const stored = makeTrack('audius', 'stored', { artist: 'Stored Artist' });
    const suggestion = makeTrack('audius', 'suggested', { artist: 'Suggested Artist' });
    const registry = stubRegistry(
      [{
        id: 'audius',
        getRelatedTracks: async () => [suggestion],
        getArtistTopTracks: async () => [],
        search: async () => results([]),
      }],
      async (sql) => (sql.includes('track_json') ? [{ track_json: JSON.stringify(stored) }] : []),
    );

    const out = await buildAutoplay(registry, [], 10);
    expect(out.map((t) => t.uri)).toEqual([suggestion.uri]);
  });

  it('never replays a track the caller just played', async () => {
    const played = makeTrack('audius', 'played', { artist: 'Played Artist' });
    const fresh = makeTrack('audius', 'fresh', { artist: 'Fresh Artist' });
    const registry = stubRegistry([{
      id: 'audius',
      getRelatedTracks: async () => [played, fresh],
      getArtistTopTracks: async () => [played],
      search: async () => results([played]),
    }]);

    const out = await buildAutoplay(registry, [played], 10);
    expect(out.map((t) => t.uri)).toEqual([fresh.uri]);
  });

  it('respects the limit and stays deterministic for the same anchor', async () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      makeTrack('audius', `p${i}`, { artist: `P ${i}` }));
    const build = (): ProviderRegistry => stubRegistry([{
      id: 'audius',
      getRelatedTracks: async () => pool,
      getArtistTopTracks: async () => [],
      search: async () => results([]),
    }]);

    const anchor = makeTrack('audius', 'anchor', { artist: 'Anchor' });
    const first = await buildAutoplay(build(), [anchor], 7);
    const second = await buildAutoplay(build(), [anchor], 7);

    expect(first).toHaveLength(7);
    expect(second.map((t) => t.uri)).toEqual(first.map((t) => t.uri));
  });
});
