/**
 * Disk cache for the assembled Home shelves.
 *
 * The providers' HTTP responses are already cached by the host, but reassembling
 * shelves out of them still costs a full fan-out on every launch. Persisting the
 * finished list lets Home paint from disk on mount and revalidate behind it.
 *
 * Two hard rules, because this cache lives in the same store as the user's
 * library and a bloated one is worse than none:
 *   1. rows are trimmed to {@link SHELF_CACHE_ITEMS_PER_SHELF} items and
 *      stripped of nested track lists before storing;
 *   2. a payload over {@link SHELF_CACHE_MAX_BYTES} is dropped, not written.
 *
 * Every function here degrades to the uncached path: `kv` is absent on hosts
 * with no database and may reject at any time, which is never an error worth
 * surfacing to the reader.
 */

import type { KeyValueStore } from '../host/types';
import type { Shelf, ShelfItem } from '../types';

/** Bump the suffix whenever the stored shape changes; old entries then miss. */
export const SHELF_CACHE_KEY = 'shelves.v1';

/** Shelf items carry full Track/Album objects with artwork, so only the part
 *  of a row that fits on screen before scrolling is worth persisting. */
export const SHELF_CACHE_ITEMS_PER_SHELF = 12;

export const SHELF_CACHE_MAX_BYTES = 512 * 1024;

/** Past this, stream URLs and trending picks are stale enough that painting
 *  them would be a lie rather than a head start. */
export const SHELF_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ShelfCacheEntry {
  /** Provider-set signature the rows were assembled under. A cached entry is
   *  only ever served back to the same signature. */
  fingerprint: string;
  savedAt: number;
  shelves: Shelf[];
}

/**
 * The cached rows for `fingerprint`, or `undefined` when there is nothing
 * usable — no store, no entry, a different provider set, an entry too old to
 * trust, or anything at all going wrong.
 */
export async function readShelfCache(
  kv: KeyValueStore | undefined,
  fingerprint: string,
  now: number = Date.now(),
): Promise<ShelfCacheEntry | undefined> {
  if (!kv) return undefined;
  let raw: string | undefined;
  try {
    raw = await kv.get(SHELF_CACHE_KEY);
  } catch {
    return undefined;
  }
  if (raw === undefined || raw.length === 0) return undefined;

  const entry = parseEntry(raw);
  if (!entry) return undefined;
  if (entry.fingerprint !== fingerprint) return undefined;
  if (now - entry.savedAt > SHELF_CACHE_MAX_AGE_MS) return undefined;
  if (entry.shelves.length === 0) return undefined;
  return entry;
}

/**
 * Persists `shelves` against `fingerprint`. Returns whether anything was
 * written: an empty list, an oversized payload and a failing store all report
 * `false` rather than throwing.
 */
export async function writeShelfCache(
  kv: KeyValueStore | undefined,
  fingerprint: string,
  shelves: Shelf[],
  now: number = Date.now(),
): Promise<boolean> {
  if (!kv) return false;
  const trimmed = trimShelvesForCache(shelves);
  // Never cache "nothing": a total provider outage would then be replayed
  // from disk on the next launch as if it were the real answer.
  if (trimmed.length === 0) return false;

  const entry: ShelfCacheEntry = { fingerprint, savedAt: now, shelves: trimmed };
  const json = JSON.stringify(entry);
  if (byteLength(json) > SHELF_CACHE_MAX_BYTES) return false;

  try {
    await kv.set(SHELF_CACHE_KEY, json);
    return true;
  } catch {
    return false;
  }
}

/** Caps each row and strips the nested track lists the cards never render. */
export function trimShelvesForCache(
  shelves: Shelf[],
  itemsPerShelf: number = SHELF_CACHE_ITEMS_PER_SHELF,
): Shelf[] {
  const cap = Math.max(1, Math.trunc(itemsPerShelf));
  const out: Shelf[] = [];
  for (const shelf of shelves) {
    const items = shelf.items.slice(0, cap).map(lighten);
    if (items.length === 0) continue;
    out.push({ ...shelf, items });
  }
  return out;
}

/**
 * A shelf card shows a name, artists and artwork, so an album or playlist that
 * arrived with its full tracklist attached is carrying kilobytes the cache has
 * no use for. The fresh fetch behind the cached paint restores them.
 */
function lighten(item: ShelfItem): ShelfItem {
  switch (item.type) {
    case 'album': {
      if (item.album.tracks === undefined) return item;
      const { tracks: _tracks, ...album } = item.album;
      return { type: 'album', album };
    }
    case 'playlist': {
      if (item.playlist.tracks === undefined) return item;
      const { tracks: _tracks, ...playlist } = item.playlist;
      return { type: 'playlist', playlist };
    }
    default:
      return item;
  }
}

function byteLength(json: string): number {
  // `length` counts UTF-16 units, which understates every non-Latin title;
  // TextEncoder is present in every host this runs in, but the cap must not
  // depend on it.
  if (typeof TextEncoder === 'undefined') return json.length;
  return new TextEncoder().encode(json).length;
}

function parseEntry(raw: string): ShelfCacheEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const { fingerprint, savedAt, shelves } = parsed;
  if (typeof fingerprint !== 'string') return undefined;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;
  if (!Array.isArray(shelves)) return undefined;

  const valid = shelves.filter(isShelf);
  return { fingerprint, savedAt, shelves: valid };
}

/** Structural check only: a row that survived a schema change with the wrong
 *  item shape must not reach the renderer as a crash. */
function isShelf(value: unknown): value is Shelf {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.title !== 'string') return false;
  if (!Array.isArray(value.items)) return false;
  return value.items.every(isShelfItem);
}

function isShelfItem(value: unknown): value is ShelfItem {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'track': return isRecord(value.track) && typeof value.track.uri === 'string';
    case 'album': return isRecord(value.album) && typeof value.album.uri === 'string';
    case 'artist': return isRecord(value.artist) && typeof value.artist.uri === 'string';
    case 'playlist': return isRecord(value.playlist) && typeof value.playlist.uri === 'string';
    case 'station': return isRecord(value.station) && typeof value.station.uri === 'string';
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
