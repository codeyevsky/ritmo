import { beforeEach, describe, expect, it } from 'vitest';

import { Packs } from './packs';
import { manifestToJson, parseJson, parseManifest } from './manifest';
import { Repo } from '../library/repo';
import { createFakeHost, track } from '../library/testing';
import { ProviderRegistry } from '../providers/registry';
import { defaultSettings } from '../types';
import type { Track, Uri } from '../types';
import type { HostBridge } from '../host/types';

type FakeHost = HostBridge & { sql: string[] };

let host: FakeHost;
let repo: Repo;
let packs: Packs;

/**
 * No providers: every network source would be a stub anyway, and resolution
 * steps 1 and 2 (the exact uri, then the local library) are the two that have
 * a real implementation to exercise here.
 */
function registryFor(state: HostBridge): ProviderRegistry {
  return new ProviderRegistry(state, { ...defaultSettings(), enabledProviders: [] });
}

beforeEach(() => {
  host = createFakeHost();
  repo = new Repo(host);
  packs = new Packs(host, repo, registryFor(host));
});

/** The raw rows, so a test can see the stored `position`, not only the order. */
async function stored(uri: Uri): Promise<{
  positions: number[];
  trackUris: Array<string | null>;
  titles: string[];
}> {
  const rows = await host.db.query<{
    position: number;
    track_uri: string | null;
    match_json: string;
  }>(
    'SELECT position, track_uri, match_json FROM pack_items WHERE pack_uri = ? ORDER BY position ASC',
    [uri],
  );
  return {
    positions: rows.map((r) => r.position),
    trackUris: rows.map((r) => r.track_uri),
    titles: rows.map((r) => String((JSON.parse(r.match_json) as { title: string }).title)),
  };
}

function dense(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function ids(letters: string): Track[] {
  return [...letters].map((c) => track(c));
}

describe('identity', () => {
  it('create mints a pack:<id> uri that list() then returns', async () => {
    const created = await packs.create('  Late Night Drive  ');

    expect(created.uri).toMatch(/^pack:/);
    expect(created.name).toBe('Late Night Drive');
    expect(created.source).toBe('local');

    const listed = await packs.list();
    expect(listed.map((p) => p.uri)).toEqual([created.uri]);
    expect(listed[0]!.trackCount).toBe(0);
  });

  it('remove cascades to pack_items and leaves other packs alone', async () => {
    const target = (await packs.create('A', { tracks: ids('abc') })).uri;
    const survivor = (await packs.create('B', { tracks: ids('de') })).uri;

    await packs.remove(target);

    expect((await stored(target)).positions).toEqual([]);
    expect((await stored(survivor)).positions).toEqual(dense(2));
    expect(await packs.get(target)).toBeUndefined();
  });

  it('update patches only what it was given', async () => {
    const { uri } = await packs.create('A', { description: 'first' });
    await packs.update(uri, { name: 'B' });

    const after = await packs.get(uri);
    expect(after?.name).toBe('B');
    expect(after?.description).toBe('first');

    await packs.update(uri, { artwork: { sources: [{ url: 'https://x/c.jpg', size: 300 }] } });
    expect((await packs.get(uri))?.artwork?.sources[0]?.url).toBe('https://x/c.jpg');
  });
});

describe('position stays dense', () => {
  it('through an append', async () => {
    const { uri } = await packs.create('A', { tracks: ids('ab') });
    await packs.addTracks(uri, ids('cd'));

    const rows = await stored(uri);
    expect(rows.positions).toEqual(dense(4));
    expect(rows.trackUris).toEqual(['a', 'b', 'c', 'd'].map((c) => `local:track:${c}`));
  });

  it('through an insert in the middle', async () => {
    const { uri } = await packs.create('A', { tracks: ids('ad') });
    await packs.addTracks(uri, ids('bc'), 1);

    const rows = await stored(uri);
    expect(rows.positions).toEqual(dense(4));
    expect(rows.trackUris).toEqual(['a', 'b', 'c', 'd'].map((c) => `local:track:${c}`));
  });

  it('through a multi-position removal', async () => {
    const { uri } = await packs.create('A', { tracks: ids('abcde') });
    await packs.removeAt(uri, [0, 2, 4]);

    const rows = await stored(uri);
    expect(rows.positions).toEqual(dense(2));
    expect(rows.trackUris).toEqual(['local:track:b', 'local:track:d']);
  });

  it('through a move in both directions', async () => {
    const { uri } = await packs.create('A', { tracks: ids('abcd') });

    await packs.move(uri, 0, 2);
    expect((await stored(uri)).trackUris).toEqual(
      ['b', 'c', 'a', 'd'].map((c) => `local:track:${c}`),
    );

    await packs.move(uri, 3, 0);
    const rows = await stored(uri);
    expect(rows.positions).toEqual(dense(4));
    expect(rows.trackUris).toEqual(['d', 'b', 'c', 'a'].map((c) => `local:track:${c}`));
  });

  it('after a move past the ends, which is clamped rather than dropped', async () => {
    const { uri } = await packs.create('A', { tracks: ids('abc') });
    await packs.move(uri, 0, 99);
    expect((await stored(uri)).trackUris).toEqual(
      ['b', 'c', 'a'].map((c) => `local:track:${c}`),
    );
    expect((await stored(uri)).positions).toEqual(dense(3));
  });
});

describe('manifest round trip', () => {
  it('toManifest → install keeps order, titles and resolution', async () => {
    const tracks = ids('abc');
    await repo.upsertTracks(tracks);
    const source = await packs.create('Late Night Drive', {
      description: 'for the motorway',
      author: 'codeyevsky',
      tracks,
    });

    const manifest = await packs.toManifest(source.uri);
    expect(manifest.format).toBe('ritmopack');
    expect(manifest.name).toBe('Late Night Drive');
    expect(manifest.tracks.map((e) => e.title)).toEqual(tracks.map((t) => t.title));
    expect(manifest.tracks[0]?.uri).toBe('local:track:a');

    // Through the serialised form as well: an export writes text, and an
    // import has to come back from text.
    const reparsed = parseManifest(parseJson(manifestToJson(manifest)));
    const installed = await packs.install(reparsed);

    expect(installed.uri).not.toBe(source.uri);
    expect(installed.name).toBe('Late Night Drive');
    expect(installed.trackCount).toBe(3);
    expect(installed.unavailableCount).toBe(0);

    const full = await packs.get(installed.uri, true);
    expect(full?.tracks?.map((t) => t.uri)).toEqual(tracks.map((t) => t.uri));
    expect((await stored(installed.uri)).positions).toEqual(dense(3));
  });

  it('records where a remote pack came from', async () => {
    const manifest = await packs.toManifest((await packs.create('A', { tracks: ids('a') })).uri);
    const installed = await packs.install(manifest, {
      sourceUrl: 'https://host.example/packs/index.json',
      packUrl: 'https://host.example/packs/packs/p_1.json',
    });

    expect(installed.source).toBe('remote');
    expect(installed.sourceUrl).toBe('https://host.example/packs/index.json');
    expect(installed.packUrl).toBe('https://host.example/packs/packs/p_1.json');
  });
});

describe('resolution', () => {
  it('takes the exact uri when the library already has it', async () => {
    await repo.upsertTracks([track('a')]);
    const installed = await packs.install({
      format: 'ritmopack',
      version: 1,
      id: 'p_1',
      name: 'A',
      createdAt: 1,
      updatedAt: 1,
      tracks: [{ uri: 'local:track:a', title: 'Whatever the publisher typed', artists: ['x'], durationMs: 0 }],
    });

    const full = await packs.get(installed.uri, true);
    expect(full?.tracks?.[0]?.uri).toBe('local:track:a');
    // The entry is kept as written even though the resolved track disagrees.
    expect(full?.items?.[0]?.entry.title).toBe('Whatever the publisher typed');
  });

  it('falls back to a fuzzy title+artist+duration match in the local library', async () => {
    await repo.upsertTracks([
      { ...track('x'), title: 'Power Aerobic', artists: [{ uri: 'local:artist:v', name: 'Van Snyder' }], durationMs: 210_000 },
    ]);

    const installed = await packs.install({
      format: 'ritmopack',
      version: 1,
      id: 'p_1',
      name: 'A',
      createdAt: 1,
      updatedAt: 1,
      // No uri at all, a different credit spelling and a duration a second off.
      tracks: [{ title: 'Power Aerobic', artists: ['Van Snyder feat. Nobody'], durationMs: 211_000 }],
    });

    expect(installed.unavailableCount).toBe(0);
    const full = await packs.get(installed.uri, true);
    expect(full?.tracks?.[0]?.uri).toBe('local:track:x');
  });

  it('keeps an entry that resolves to nothing, and reresolve picks it up later', async () => {
    const installed = await packs.install({
      format: 'ritmopack',
      version: 1,
      id: 'p_1',
      name: 'A',
      createdAt: 1,
      updatedAt: 1,
      tracks: [
        { uri: 'audius:track:gone', title: 'Nothing Serves This', artists: ['Ghost'], durationMs: 123_000 },
        { uri: 'local:track:a', title: 'Track a', artists: ['Artist a'], durationMs: 180_000 },
      ],
    });

    // Nothing is dropped: both entries are stored, one without a track.
    const rows = await stored(installed.uri);
    expect(rows.positions).toEqual(dense(2));
    expect(rows.trackUris[0]).toBeNull();
    expect(rows.titles).toEqual(['Nothing Serves This', 'Track a']);
    expect(installed.trackCount).toBe(2);
    expect(installed.unavailableCount).toBe(2);

    const before = await packs.get(installed.uri, true);
    expect(before?.items?.[0]?.track).toBeUndefined();

    // The missing recording arrives — a folder scan, a newly enabled source.
    await repo.upsertTracks([
      { ...track('ghost'), title: 'Nothing Serves This', artists: [{ uri: 'local:artist:g', name: 'Ghost' }], durationMs: 123_000 },
      track('a'),
    ]);

    const report = await packs.reresolve(installed.uri);
    expect(report).toEqual({ resolved: 2, unavailable: 0 });

    const after = await packs.get(installed.uri, true);
    expect(after?.unavailableCount).toBe(0);
    expect(after?.items?.map((item) => item.entry.title)).toEqual([
      'Nothing Serves This',
      'Track a',
    ]);
    // The order is untouched by a re-resolve.
    expect((await stored(installed.uri)).positions).toEqual(dense(2));
  });
});

describe('containing', () => {
  it('lists the packs holding a track', async () => {
    const withIt = await packs.create('A', { tracks: ids('ab') });
    await packs.create('B', { tracks: ids('c') });

    const found = await packs.containing('local:track:a');
    expect(found.map((p) => p.uri)).toEqual([withIt.uri]);
  });
});

describe('a host without a database', () => {
  it('degrades to empty instead of throwing', async () => {
    const broken = createFakeHost();
    const failing: HostBridge = {
      ...broken,
      db: {
        query: () => Promise.reject(new Error('no such table')),
        execute: () => Promise.reject(new Error('no such table')),
        transaction: () => Promise.reject(new Error('no such table')),
      },
    };
    const errors: unknown[] = [];
    const offline = new Packs(failing, new Repo(failing), registryFor(failing));
    offline.onError = (e) => errors.push(e);

    await expect(offline.list()).resolves.toEqual([]);
    await expect(offline.get('pack:missing')).resolves.toBeUndefined();
    await expect(offline.create('A')).resolves.toMatchObject({ name: 'A' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
