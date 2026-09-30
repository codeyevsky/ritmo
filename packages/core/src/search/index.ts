/**
 * Unified search across every enabled provider.
 *
 * The screen has to feel instant even when one catalogue is having a bad day,
 * so every provider gets its own timeout and its own failure lane: results are
 * merged from whoever answered, and the stragglers are reported through
 * `registry.lastErrors()` rather than by rejecting.
 *
 * Nothing waits for the slowest source either: {@link UnifiedSearchOptions.onPartial}
 * is called with the merged set each time a provider lands, so the first
 * answer paints immediately and the rest fill in behind it.
 */

import { emptySearchResults } from '../types';
import type {
  Album, EntityKind, ProviderId, SearchQuery, SearchResults, Station, Track, Uri,
} from '../types';
import { ProviderError } from '../providers/types';
import type { MusicProvider } from '../providers/types';
import { providerRank } from '../providers/registry';
import type { ProviderRegistry } from '../providers/registry';
import { normalizeKey } from '../util/text';

export interface UnifiedSearchOptions {
  limit?: number;
  kinds?: EntityKind[];
  timeoutMs?: number;
  providers?: ProviderId[];
  /** Called after each provider resolves, with everything merged so far. */
  onPartial?: (results: SearchResults) => void;
  /** Aborting drops every result still to come, merge and ranking included. */
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 50;
/** Search-as-you-type budget: a source slower than this is not worth the wait. */
const DEFAULT_TIMEOUT_MS = 2500;
/** Headroom over `limit` for what dedupe and per-kind splitting will discard. */
const PER_PROVIDER_SLACK = 20;
const PER_PROVIDER_MAX = 80;
/** Two copies of the same recording rarely agree on duration to the second. */
const DURATION_SLACK_MS = 3000;
const ALL_KINDS: EntityKind[] = ['track', 'album', 'artist', 'playlist', 'station'];

export async function unifiedSearch(
  registry: ProviderRegistry,
  query: string,
  opts: UnifiedSearchOptions = {},
): Promise<SearchResults> {
  const text = query.trim();
  if (text.length === 0) return emptySearchResults();

  const limit = clampInt(opts.limit, DEFAULT_LIMIT, 1, 200);
  const timeoutMs = clampInt(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60_000);
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : ALL_KINDS;
  const wanted = opts.providers;
  const { onPartial, signal } = opts;

  registry.resetErrors();

  // `ready()` both filters out the unconfigured sources and records why, so an
  // unusable provider costs nothing instead of a full timeout per keystroke.
  const targets = (await registry.ready()).filter((p) =>
    p.capabilities.search
    && (wanted === undefined || wanted.includes(p.id))
    && servesAnyKind(p, kinds));

  const request: SearchQuery = {
    text,
    kinds,
    limit: Math.min(PER_PROVIDER_MAX, limit + PER_PROVIDER_SLACK),
  };

  const parts: SearchResults[] = [];
  await Promise.all(targets.map(async (provider) => {
    const part = await searchOne(registry, provider, request, timeoutMs);
    // A superseded query must neither paint nor pay for the ranking work.
    if (signal?.aborted === true) return;
    parts.push(part);
    onPartial?.(mergeParts(parts, kinds, limit, text));
  }));

  if (signal?.aborted === true) return emptySearchResults();
  return mergeParts(parts, kinds, limit, text);
}

/** Dedupes and ranks everything gathered so far into one result set. */
function mergeParts(
  parts: SearchResults[],
  kinds: EntityKind[],
  limit: number,
  text: string,
): SearchResults {
  const merged = emptySearchResults();
  if (kinds.includes('track')) {
    merged.tracks = rankTracks(dedupeTracks(parts.flatMap((r) => r.tracks)), text).slice(0, limit);
  }
  if (kinds.includes('album')) {
    merged.albums = rankNamed(dedupeAlbums(parts.flatMap((r) => r.albums)), text).slice(0, limit);
  }
  if (kinds.includes('artist')) {
    merged.artists = rankNamed(dedupeByUri(parts.flatMap((r) => r.artists)), text).slice(0, limit);
  }
  if (kinds.includes('playlist')) {
    merged.playlists = rankNamed(dedupeByUri(parts.flatMap((r) => r.playlists)), text).slice(0, limit);
  }
  if (kinds.includes('station')) {
    merged.stations = rankStations(dedupeStations(parts.flatMap((r) => r.stations)), text).slice(0, limit);
  }
  return merged;
}

async function searchOne(
  registry: ProviderRegistry,
  provider: MusicProvider,
  request: SearchQuery,
  timeoutMs: number,
): Promise<SearchResults> {
  try {
    return await registry.run(provider.id, 'search', (p) => withTimeout(
      p.search({ ...request }),
      timeoutMs,
      () => new ProviderError('network', `${p.id} search timed out`, p.id),
    ));
  } catch {
    return emptySearchResults();
  }
}

/**
 * Exact normalised title match first, then a title prefix match, then provider
 * popularity, then provider priority. Stable: equal candidates keep the order
 * their provider returned them in.
 */
export function rankTracks(tracks: Track[], query: string): Track[] {
  const q = normalizeKey(query);
  return tracks
    .map((track, index) => ({
      track,
      index,
      tier: titleTier(track.title, q),
      popularity: track.popularity ?? 0,
      rank: providerRank(track.provider),
    }))
    .sort((a, b) =>
      a.tier - b.tier
      || b.popularity - a.popularity
      || a.rank - b.rank
      || a.index - b.index)
    .map((e) => e.track);
}

/**
 * Collapses the same recording offered by several providers, keeping the copy
 * from the highest-priority one — so a file on disk always beats a stream.
 */
export function dedupeTracks(tracks: Track[]): Track[] {
  const out: Track[] = [];
  const byKey = new Map<string, number[]>();
  const byUri = new Map<string, number>();

  for (const track of tracks) {
    const existingUri = byUri.get(track.uri);
    if (existingUri !== undefined) continue;

    const key = trackKey(track);
    const slots = byKey.get(key);
    let merged = false;
    if (slots) {
      for (const slot of slots) {
        const kept = out[slot];
        if (!kept || !durationsMatch(kept.durationMs, track.durationMs)) continue;
        if (providerRank(track.provider) < providerRank(kept.provider)) {
          byUri.delete(kept.uri);
          out[slot] = track;
          byUri.set(track.uri, slot);
        }
        merged = true;
        break;
      }
    }
    if (merged) continue;

    const slot = out.length;
    out.push(track);
    byUri.set(track.uri, slot);
    if (slots) slots.push(slot);
    else byKey.set(key, [slot]);
  }
  return out;
}

export function primaryArtistName(track: Track): string {
  return track.artists[0]?.name ?? '';
}

/** Identity used for cross-provider deduplication: title + primary artist. */
export function trackKey(track: Track): string {
  return `${normalizeKey(track.title)}|${normalizeKey(primaryArtistName(track))}`;
}

function durationsMatch(a: number, b: number): boolean {
  // A missing duration (live streams, lazy providers) can't disprove a match.
  if (a <= 0 || b <= 0) return true;
  return Math.abs(a - b) <= DURATION_SLACK_MS;
}

function titleTier(title: string, normalisedQuery: string): number {
  const t = normalizeKey(title);
  if (normalisedQuery.length === 0) return 3;
  if (t === normalisedQuery) return 0;
  if (t.startsWith(normalisedQuery)) return 1;
  if (t.includes(normalisedQuery)) return 2;
  return 3;
}

interface Named {
  uri: Uri;
  name: string;
  provider: ProviderId | 'ritmo';
}

function rankNamed<T extends Named>(items: T[], query: string): T[] {
  const q = normalizeKey(query);
  return items
    .map((item, index) => ({ item, index, tier: titleTier(item.name, q), rank: namedRank(item.provider) }))
    .sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.index - b.index)
    .map((e) => e.item);
}

/** User-owned ('ritmo') collections outrank anything a provider suggests. */
function namedRank(provider: ProviderId | 'ritmo'): number {
  return provider === 'ritmo' ? -1 : providerRank(provider);
}

function dedupeByUri<T extends { uri: Uri }>(items: T[]): T[] {
  const seen = new Set<Uri>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.uri)) continue;
    seen.add(item.uri);
    out.push(item);
  }
  return out;
}

function dedupeAlbums(albums: Album[]): Album[] {
  const out: Album[] = [];
  const slots = new Map<string, number>();
  const seenUri = new Set<Uri>();
  for (const album of albums) {
    if (seenUri.has(album.uri)) continue;
    seenUri.add(album.uri);
    const key = `${normalizeKey(album.name)}|${normalizeKey(album.artists[0]?.name ?? '')}`;
    const slot = slots.get(key);
    if (slot === undefined) {
      slots.set(key, out.length);
      out.push(album);
      continue;
    }
    const kept = out[slot];
    if (kept && providerRank(album.provider) < providerRank(kept.provider)) out[slot] = album;
  }
  return out;
}

function dedupeStations(stations: Station[]): Station[] {
  const seen = new Set<string>();
  const out: Station[] = [];
  for (const station of stations) {
    const key = station.streamUrl.length > 0 ? station.streamUrl : station.uri;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(station);
  }
  return out;
}

function rankStations(stations: Station[], query: string): Station[] {
  const q = normalizeKey(query);
  return stations
    .map((station, index) => ({ station, index, tier: titleTier(station.name, q), votes: station.votes ?? 0 }))
    .sort((a, b) => a.tier - b.tier || b.votes - a.votes || a.index - b.index)
    .map((e) => e.station);
}

function servesAnyKind(provider: MusicProvider, kinds: EntityKind[]): boolean {
  return kinds.some((kind) => {
    switch (kind) {
      case 'track': return true;
      case 'album': return provider.capabilities.albums;
      case 'artist': return provider.capabilities.artists;
      case 'playlist': return provider.capabilities.playlists;
      case 'station': return provider.capabilities.stations;
      default: return false;
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
