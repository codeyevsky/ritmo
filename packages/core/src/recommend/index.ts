/**
 * Radio and autoplay.
 *
 * Everything here is assembled from several weak signals — the provider's own
 * "related" endpoint, the artist's top tracks, a genre search and the local
 * library — because no single source is deep enough to keep a queue interesting
 * for an hour.
 *
 * Ordering is deterministic: the shuffle is seeded from the seed URI, so
 * closing and re-opening a song radio gives the same queue back instead of
 * silently rewriting what the user was listening to.
 */

import { uriProvider } from '../types';
import type { ArtistRef, ProviderId, Track, Uri } from '../types';
import type { ProviderRegistry } from '../providers/registry';
import { LocalProvider } from '../providers/local';
import { dedupeTracks, primaryArtistName, trackKey, unifiedSearch } from '../search/index';
import { normalizeKey } from '../util/text';

const DEFAULT_RADIO_LIMIT = 60;
const DEFAULT_AUTOPLAY_LIMIT = 30;
const HISTORY_EXCLUDE = 50;
/** Below this the local library is too thin to contribute variety. */
const LOCAL_MIN_TRACKS = 50;
const DEFAULT_ARTIST_GAP = 3;
/** How many tracks each cycle of the interleave takes from each pool. */
const POOL_WEIGHTS = [2, 1, 1, 1];

/** "Song radio": a long, varied queue seeded from one track. */
export async function buildTrackRadio(
  registry: ProviderRegistry,
  seed: Track,
  limit = DEFAULT_RADIO_LIMIT,
): Promise<Track[]> {
  const want = clampInt(limit, DEFAULT_RADIO_LIMIT, 1, 500);
  const artist = seed.artists[0];
  const genre = seed.genres?.[0];
  const term = genre ?? artist?.name ?? seed.title;

  const [recent, related, top, searched, local] = await Promise.all([
    recentlyPlayedUris(registry, HISTORY_EXCLUDE),
    relatedFrom(registry, seed, want),
    artist ? artistTopTracks(registry, artist) : noTracks(),
    searchTracks(registry, term, want),
    localByGenre(registry, genre, want, seed.uri),
  ]);

  return assemble([related, top, searched, local], {
    seedKey: `track-radio:${seed.uri}`,
    exclude: recent,
    always: [seed.uri],
    want,
  });
}

export async function buildArtistRadio(
  registry: ProviderRegistry,
  artist: ArtistRef,
  limit = DEFAULT_RADIO_LIMIT,
): Promise<Track[]> {
  const want = clampInt(limit, DEFAULT_RADIO_LIMIT, 1, 500);
  const [recent, top] = await Promise.all([
    recentlyPlayedUris(registry, HISTORY_EXCLUDE),
    artistTopTracks(registry, artist),
  ]);

  const anchor = top[0];
  const genre = anchor?.genres?.[0];
  const [related, searched, local] = await Promise.all([
    anchor ? relatedFrom(registry, anchor, want) : noTracks(),
    searchTracks(registry, artist.name, want),
    localByGenre(registry, genre, want),
  ]);

  return assemble([top, related, searched, local], {
    seedKey: `artist-radio:${artist.uri}`,
    exclude: recent,
    always: [],
    want,
  });
}

/** Fills the queue when it drains, mixing history with fresh discovery. */
export async function buildAutoplay(
  registry: ProviderRegistry,
  recentlyPlayed: Track[],
  limit = DEFAULT_AUTOPLAY_LIMIT,
): Promise<Track[]> {
  const want = clampInt(limit, DEFAULT_AUTOPLAY_LIMIT, 1, 300);
  const [recent, fromDb] = await Promise.all([
    recentlyPlayedUris(registry, HISTORY_EXCLUDE),
    recentlyPlayed.length === 0 ? recentlyPlayedTracks(registry, 20) : noTracks(),
  ]);

  // The caller passes its history most-recent-first; the DB fallback is already
  // ordered that way too.
  const seeds = (recentlyPlayed.length > 0 ? recentlyPlayed : fromDb).slice(0, 4);
  if (seeds.length === 0) return [];

  for (const track of recentlyPlayed) recent.add(track.uri);

  const perSeed = Math.max(8, Math.ceil(want / Math.max(1, seeds.length)) * 2);
  const relatedPools = await Promise.all(seeds.map((seed) => relatedFrom(registry, seed, perSeed)));
  const artistPools = await Promise.all(
    seeds.map((seed) => {
      const artist = seed.artists[0];
      return artist ? artistTopTracks(registry, artist) : noTracks();
    }),
  );

  const genre = dominantGenre(seeds);
  const anchor = seeds[0];
  const [searched, local] = await Promise.all([
    searchTracks(registry, genre ?? anchor?.artists[0]?.name ?? anchor?.title ?? '', want),
    localByGenre(registry, genre, want),
  ]);

  return assemble([relatedPools.flat(), artistPools.flat(), searched, local], {
    seedKey: `autoplay:${anchor?.uri ?? ''}`,
    exclude: recent,
    always: seeds.map((s) => s.uri),
    want,
  });
}

/** No two tracks by the same artist within `gap` positions, when the pool allows. */
export function spaceByArtist(tracks: Track[], gap = DEFAULT_ARTIST_GAP): Track[] {
  const window = Math.max(0, Math.trunc(gap));
  if (window === 0 || tracks.length < 3) return [...tracks];

  const pool = [...tracks];
  const out: Track[] = [];
  const recentArtists: string[] = [];

  while (pool.length > 0) {
    let pick = pool.findIndex((t) => !recentArtists.includes(artistKey(t)));
    if (pick < 0) pick = 0;
    const [chosen] = pool.splice(pick, 1);
    if (!chosen) break;
    out.push(chosen);
    recentArtists.push(artistKey(chosen));
    if (recentArtists.length > window) recentArtists.shift();
  }
  return out;
}

interface AssembleOptions {
  seedKey: string;
  exclude: Set<Uri>;
  /** Excluded even when the exclusion set has to be relaxed (the seed itself). */
  always: Uri[];
  want: number;
}

/**
 * Shuffles each pool, then round-robins them with decreasing weight so the
 * strongest signal leads without the queue becoming a single artist's album.
 */
function assemble(pools: Track[][], opts: AssembleOptions): Track[] {
  const strict = collect(pools, opts, opts.exclude);
  if (strict.length > 0) return strict;
  // Everything the sources offered was in the recent-plays window; a repeat is
  // better than an empty queue.
  return collect(pools, opts, new Set<Uri>());
}

function collect(pools: Track[][], opts: AssembleOptions, exclude: Set<Uri>): Track[] {
  const rng = mulberry32(hashString(opts.seedKey));
  const banned = new Set<Uri>(opts.always);
  const seenUri = new Set<Uri>();
  const seenKey = new Set<string>();

  const cleaned = pools.map((pool) => {
    const kept: Track[] = [];
    for (const track of shuffle(pool, rng)) {
      if (track.uri.length === 0 || banned.has(track.uri) || exclude.has(track.uri)) continue;
      if (seenUri.has(track.uri)) continue;
      const key = trackKey(track);
      if (seenKey.has(key)) continue;
      seenUri.add(track.uri);
      seenKey.add(key);
      kept.push(track);
    }
    return kept;
  });

  const merged: Track[] = [];
  const cursors = cleaned.map(() => 0);
  let progressed = true;
  while (merged.length < opts.want && progressed) {
    progressed = false;
    for (let i = 0; i < cleaned.length; i += 1) {
      const pool = cleaned[i];
      if (!pool) continue;
      const weight = POOL_WEIGHTS[i] ?? 1;
      for (let n = 0; n < weight; n += 1) {
        const at = cursors[i] ?? 0;
        const track = pool[at];
        if (!track) break;
        cursors[i] = at + 1;
        merged.push(track);
        progressed = true;
        if (merged.length >= opts.want) break;
      }
      if (merged.length >= opts.want) break;
    }
  }

  return spaceByArtist(dedupeTracks(merged), DEFAULT_ARTIST_GAP).slice(0, opts.want);
}

// --- sources ----------------------------------------------------------------

async function noTracks(): Promise<Track[]> {
  return [];
}

async function relatedFrom(registry: ProviderRegistry, seed: Track, want: number): Promise<Track[]> {
  const id: ProviderId = seed.provider ?? uriProvider(seed.uri);
  const provider = registry.get(id);
  if (!provider || !provider.capabilities.related || provider.getRelatedTracks === undefined) return [];
  try {
    return await registry.run(id, 'getRelatedTracks', (p) =>
      p.getRelatedTracks?.(seed, want) ?? Promise.resolve([]));
  } catch {
    return [];
  }
}

async function artistTopTracks(registry: ProviderRegistry, artist: ArtistRef): Promise<Track[]> {
  const id = uriProvider(artist.uri);
  const provider = registry.get(id);
  if (!provider || !provider.capabilities.artists) return [];
  try {
    return await registry.run(id, 'getArtistTopTracks', (p) => p.getArtistTopTracks(artist.uri));
  } catch {
    return [];
  }
}

async function searchTracks(registry: ProviderRegistry, term: string, want: number): Promise<Track[]> {
  if (term.trim().length === 0) return [];
  try {
    const results = await unifiedSearch(registry, term, { kinds: ['track'], limit: want });
    return results.tracks;
  } catch {
    return [];
  }
}

/** The local library only joins in once it is big enough to add variety. */
async function localByGenre(
  registry: ProviderRegistry,
  genre: string | undefined,
  want: number,
  excludeUri?: Uri,
): Promise<Track[]> {
  if (genre === undefined || genre.trim().length === 0) return [];
  const local = registry.get('local');
  if (!(local instanceof LocalProvider)) return [];
  try {
    if (await local.countTracks() < LOCAL_MIN_TRACKS) return [];
    return await local.tracksByGenre(genre, want, excludeUri);
  } catch {
    return [];
  }
}

async function recentlyPlayedUris(registry: ProviderRegistry, count: number): Promise<Set<Uri>> {
  const out = new Set<Uri>();
  try {
    const rows = await registry.host.db.query<{ track_uri: unknown }>(
      'SELECT track_uri FROM play_history ORDER BY played_at DESC LIMIT ?',
      [count],
    );
    for (const row of rows) {
      if (typeof row.track_uri === 'string' && row.track_uri.length > 0) out.add(row.track_uri);
    }
  } catch {
    // No history table yet (fresh install) — nothing to exclude.
  }
  return out;
}

async function recentlyPlayedTracks(registry: ProviderRegistry, count: number): Promise<Track[]> {
  try {
    const rows = await registry.host.db.query<{ track_json: unknown }>(
      'SELECT track_json FROM play_history ORDER BY played_at DESC LIMIT ?',
      [count],
    );
    const out: Track[] = [];
    for (const row of rows) {
      const track = parseTrack(row.track_json);
      if (track) out.push(track);
    }
    return out;
  } catch {
    return [];
  }
}

function parseTrack(value: unknown): Track | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as Partial<Track>;
  if (typeof candidate.uri !== 'string' || candidate.uri.length === 0) return undefined;
  if (typeof candidate.title !== 'string') return undefined;
  return {
    ...candidate,
    uri: candidate.uri,
    title: candidate.title,
    provider: candidate.provider ?? uriProvider(candidate.uri),
    artists: Array.isArray(candidate.artists) ? candidate.artists : [],
    durationMs: typeof candidate.durationMs === 'number' ? candidate.durationMs : 0,
  };
}

function dominantGenre(tracks: Track[]): string | undefined {
  const tally = new Map<string, { label: string; n: number }>();
  for (const track of tracks) {
    for (const genre of track.genres ?? []) {
      const key = normalizeKey(genre);
      if (key.length === 0) continue;
      const hit = tally.get(key);
      if (hit) hit.n += 1;
      else tally.set(key, { label: genre, n: 1 });
    }
  }
  let best: { label: string; n: number } | undefined;
  for (const entry of tally.values()) {
    if (!best || entry.n > best.n) best = entry;
  }
  return best?.label;
}

function artistKey(track: Track): string {
  return normalizeKey(primaryArtistName(track));
}

// --- deterministic shuffle --------------------------------------------------

/** FNV-1a: cheap, no dependencies, and stable across engines. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
