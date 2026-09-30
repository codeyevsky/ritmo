import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../host/types';
import type { Shelf, ShelfItem, Track } from '../types';
import {
  SHELF_CACHE_ITEMS_PER_SHELF,
  SHELF_CACHE_KEY,
  SHELF_CACHE_MAX_AGE_MS,
  readShelfCache,
  trimShelvesForCache,
  writeShelfCache,
} from './shelfCache';

// --- fixtures ---------------------------------------------------------------

const FINGERPRINT = 'local,audius|false|high';

function track(n: number): Track {
  return {
    uri: `audius:track:${n}`,
    provider: 'audius',
    title: `Track ${n}`,
    artists: [{ uri: 'audius:artist:1', name: 'Someone' }],
    durationMs: 200_000,
  };
}

function trackShelf(id: string, items: number): Shelf {
  return {
    id,
    title: id,
    items: Array.from({ length: items }, (_, i): ShelfItem => ({ type: 'track', track: track(i) })),
  };
}

function memoryKv(initial: Record<string, string> = {}): KeyValueStore & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: (key) => Promise.resolve(store.get(key)),
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
    keys: (prefix) => Promise.resolve(
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
    ),
  };
}

/** The web host has no database, so every operation rejects. */
function throwingKv(): KeyValueStore {
  const boom = (): Promise<never> => Promise.reject(new Error('no database on this host'));
  return { get: boom, set: boom, remove: boom, keys: boom };
}

// --- round trip -------------------------------------------------------------

describe('shelf cache round trip', () => {
  it('serves rows back to the same fingerprint', async () => {
    const kv = memoryKv();
    const shelves = [trackShelf('trending', 5), trackShelf('underground', 3)];

    expect(await writeShelfCache(kv, FINGERPRINT, shelves)).toBe(true);

    const entry = await readShelfCache(kv, FINGERPRINT);
    expect(entry?.fingerprint).toBe(FINGERPRINT);
    expect(entry?.shelves.map((s) => s.id)).toEqual(['trending', 'underground']);
    expect(entry?.shelves[0]?.items).toHaveLength(5);
  });

  it('ignores an entry written under a different fingerprint', async () => {
    const kv = memoryKv();
    await writeShelfCache(kv, FINGERPRINT, [trackShelf('trending', 3)]);

    expect(await readShelfCache(kv, 'local|false|high')).toBeUndefined();
    // The entry is still there for the fingerprint it belongs to.
    expect(await readShelfCache(kv, FINGERPRINT)).toBeDefined();
  });

  it('stamps the entry so an ancient one is not painted', async () => {
    const kv = memoryKv();
    const savedAt = 1_000_000;
    await writeShelfCache(kv, FINGERPRINT, [trackShelf('trending', 3)], savedAt);

    expect(await readShelfCache(kv, FINGERPRINT, savedAt + SHELF_CACHE_MAX_AGE_MS)).toBeDefined();
    expect(await readShelfCache(kv, FINGERPRINT, savedAt + SHELF_CACHE_MAX_AGE_MS + 1)).toBeUndefined();
  });
});

// --- size discipline --------------------------------------------------------

describe('shelf cache size discipline', () => {
  it('trims each row to the per-shelf cap before storing', async () => {
    const kv = memoryKv();
    await writeShelfCache(kv, FINGERPRINT, [trackShelf('trending', 40)]);

    const entry = await readShelfCache(kv, FINGERPRINT);
    expect(entry?.shelves[0]?.items).toHaveLength(SHELF_CACHE_ITEMS_PER_SHELF);
  });

  it('strips the nested tracklists a shelf card never renders', () => {
    const album: ShelfItem = {
      type: 'album',
      album: {
        uri: 'archive:album:1',
        provider: 'archive',
        name: 'Live at Wherever',
        artists: [{ uri: 'archive:artist:1', name: 'Band' }],
        tracks: Array.from({ length: 30 }, (_, i) => track(i)),
      },
    };
    const [trimmed] = trimShelvesForCache([{ id: 'a', title: 'a', items: [album] }]);
    const kept = trimmed?.items[0];

    expect(kept?.type).toBe('album');
    expect(kept?.type === 'album' ? kept.album.tracks : 'missing').toBeUndefined();
    // The original is untouched: this list is still on screen.
    expect(album.album.tracks).toHaveLength(30);
  });

  it('refuses to store a payload over the byte cap', async () => {
    const kv = memoryKv();
    // Artwork data URIs are what make a shelf payload explode in practice.
    const bloated: Shelf[] = Array.from({ length: 6 }, (_, s) => ({
      id: `shelf-${s}`,
      title: `shelf-${s}`,
      items: Array.from({ length: SHELF_CACHE_ITEMS_PER_SHELF }, (_, i): ShelfItem => ({
        type: 'track',
        track: {
          ...track(i),
          artwork: { sources: [{ url: `data:image/png;base64,${'A'.repeat(20_000)}`, size: 640 }] },
        },
      })),
    }));

    expect(await writeShelfCache(kv, FINGERPRINT, bloated)).toBe(false);
    expect(kv.store.has(SHELF_CACHE_KEY)).toBe(false);
  });

  it('does not cache an empty result', async () => {
    const kv = memoryKv();
    expect(await writeShelfCache(kv, FINGERPRINT, [])).toBe(false);
    expect(await writeShelfCache(kv, FINGERPRINT, [{ id: 'bare', title: 'bare', items: [] }])).toBe(false);
    expect(kv.store.has(SHELF_CACHE_KEY)).toBe(false);
  });
});

// --- degradation ------------------------------------------------------------

describe('shelf cache degradation', () => {
  it('falls back to the uncached path when kv throws', async () => {
    const kv = throwingKv();
    await expect(readShelfCache(kv, FINGERPRINT)).resolves.toBeUndefined();
    await expect(writeShelfCache(kv, FINGERPRINT, [trackShelf('trending', 3)])).resolves.toBe(false);
  });

  it('falls back when there is no store at all', async () => {
    await expect(readShelfCache(undefined, FINGERPRINT)).resolves.toBeUndefined();
    await expect(writeShelfCache(undefined, FINGERPRINT, [trackShelf('trending', 3)])).resolves.toBe(false);
  });

  it('ignores an unparseable or wrongly-shaped entry', async () => {
    expect(await readShelfCache(memoryKv({ [SHELF_CACHE_KEY]: 'not json' }), FINGERPRINT)).toBeUndefined();
    expect(await readShelfCache(memoryKv({ [SHELF_CACHE_KEY]: '[]' }), FINGERPRINT)).toBeUndefined();
    expect(await readShelfCache(memoryKv({ [SHELF_CACHE_KEY]: '' }), FINGERPRINT)).toBeUndefined();
    expect(await readShelfCache(
      memoryKv({ [SHELF_CACHE_KEY]: JSON.stringify({ fingerprint: FINGERPRINT, shelves: [] }) }),
      FINGERPRINT,
    )).toBeUndefined();
  });

  it('drops rows whose items survived a schema change in the wrong shape', async () => {
    const raw = JSON.stringify({
      fingerprint: FINGERPRINT,
      savedAt: Date.now(),
      shelves: [
        { id: 'good', title: 'good', items: [{ type: 'track', track: { uri: 'audius:track:1' } }] },
        { id: 'bad', title: 'bad', items: [{ type: 'mystery', payload: 1 }] },
        { id: 'alsoBad', items: [] },
      ],
    });
    const entry = await readShelfCache(memoryKv({ [SHELF_CACHE_KEY]: raw }), FINGERPRINT);
    expect(entry?.shelves.map((s) => s.id)).toEqual(['good']);
  });
});
