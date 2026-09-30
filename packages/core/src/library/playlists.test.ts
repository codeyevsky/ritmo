import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Playlists } from './playlists';
import { Repo } from './repo';
import { createFakeHost, track } from './testing';
import type { Track, Uri } from '../types';
import type { HostBridge } from '../host/types';

type FakeHost = HostBridge & { sql: string[] };

let host: FakeHost;
let repo: Repo;
let playlists: Playlists;

beforeEach(() => {
  host = createFakeHost();
  repo = new Repo(host);
  playlists = new Playlists(host, repo);
});

/** The raw item rows, so tests can see the stored `position` and not only the order. */
async function stored(uri: Uri): Promise<{ uris: Uri[]; positions: number[] }> {
  const rows = await host.db.query<{ position: number; track_uri: string }>(
    'SELECT position, track_uri FROM playlist_items WHERE playlist_uri = ? ORDER BY position ASC',
    [uri],
  );
  return { uris: rows.map((r) => r.track_uri), positions: rows.map((r) => r.position) };
}

function dense(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function ids(letters: string): Track[] {
  return [...letters].map((c) => track(c));
}

async function seeded(letters: string): Promise<Uri> {
  const p = await playlists.create('Liste', { tracks: ids(letters) });
  return p.uri;
}

function uri(letter: string): Uri {
  return `local:track:${letter}`;
}

describe('identity', () => {
  it('create mints an editable ritmo playlist that list() then returns', async () => {
    const created = await playlists.create('  Sabah  ');

    expect(created.uri).toMatch(/^ritmo:playlist:/);
    expect(created.name).toBe('Sabah');
    expect(created.editable).toBe(true);

    const listed = await playlists.list();
    expect(listed.map((p) => p.uri)).toEqual([created.uri]);
    expect(listed[0]!.provider).toBe('ritmo');
    expect(listed[0]!.editable).toBe(true);
  });

  it('remove cascades to playlist_items', async () => {
    const target = await seeded('abc');
    const survivor = await seeded('de');

    await playlists.remove(target);

    expect((await stored(target)).uris).toEqual([]);
    expect((await stored(survivor)).uris).toEqual([uri('d'), uri('e')]);
    expect(await playlists.get(target)).toBeUndefined();
  });

  it('duplicate copies the items under a new uri and leaves the original intact', async () => {
    const source = await seeded('abc');
    await playlists.rename(source, 'Kaynak');

    const copy = await playlists.duplicate(source);

    expect(copy.uri).not.toBe(source);
    expect(copy.uri).toMatch(/^ritmo:playlist:/);
    expect(copy.name).toBe('Kaynak (copy)');
    expect(await stored(copy.uri)).toEqual({ uris: [uri('a'), uri('b'), uri('c')], positions: dense(3) });
    expect((await stored(source)).uris).toEqual([uri('a'), uri('b'), uri('c')]);
  });
});

describe('position density', () => {
  it('addTracks appends with dense 0-based positions', async () => {
    const list = await seeded('ab');

    await playlists.addTracks(list, ids('cd'));

    expect(await stored(list)).toEqual({
      uris: [uri('a'), uri('b'), uri('c'), uri('d')],
      positions: dense(4),
    });
  });

  it('addTracks at an index reindexes the tail with no gaps and no duplicates', async () => {
    const list = await seeded('abc');

    await playlists.addTracks(list, ids('xy'), 1);

    expect(await stored(list)).toEqual({
      uris: [uri('a'), uri('x'), uri('y'), uri('b'), uri('c')],
      positions: dense(5),
    });
  });

  it('addTracks past the end appends rather than leaving a hole', async () => {
    const list = await seeded('ab');

    await playlists.addTracks(list, ids('z'), 99);

    expect(await stored(list)).toEqual({
      uris: [uri('a'), uri('b'), uri('z')],
      positions: dense(3),
    });
  });

  it('removeTracks closes the gaps left by several positions at once', async () => {
    const list = await seeded('abcde');

    await playlists.removeTracks(list, [0, 2, 4]);

    expect(await stored(list)).toEqual({ uris: [uri('b'), uri('d')], positions: dense(2) });
  });

  it('removeTracks ignores positions that do not exist', async () => {
    const list = await seeded('abc');

    await playlists.removeTracks(list, [7]);

    expect(await stored(list)).toEqual({
      uris: [uri('a'), uri('b'), uri('c')],
      positions: dense(3),
    });
  });
});

describe('move', () => {
  it('moves an item forwards keeping positions dense', async () => {
    const list = await seeded('abcde');

    await playlists.move(list, 1, 3);

    expect(await stored(list)).toEqual({
      uris: [uri('a'), uri('c'), uri('d'), uri('b'), uri('e')],
      positions: dense(5),
    });
  });

  it('moves an item backwards keeping positions dense', async () => {
    const list = await seeded('abcde');

    await playlists.move(list, 3, 1);

    expect(await stored(list)).toEqual({
      uris: [uri('a'), uri('d'), uri('b'), uri('c'), uri('e')],
      positions: dense(5),
    });
  });

  it('moves an item to index 0', async () => {
    const list = await seeded('abcde');

    await playlists.move(list, 4, 0);

    expect(await stored(list)).toEqual({
      uris: [uri('e'), uri('a'), uri('b'), uri('c'), uri('d')],
      positions: dense(5),
    });
  });

  it('moves an item to the last index', async () => {
    const list = await seeded('abcde');

    await playlists.move(list, 0, 4);

    expect(await stored(list)).toEqual({
      uris: [uri('b'), uri('c'), uri('d'), uri('e'), uri('a')],
      positions: dense(5),
    });
  });

  it('a move onto its own index changes nothing', async () => {
    const list = await seeded('abcde');

    await playlists.move(list, 2, 2);

    expect(await stored(list)).toEqual({
      uris: [uri('a'), uri('b'), uri('c'), uri('d'), uri('e')],
      positions: dense(5),
    });
  });

  it('a move from out of range leaves the list untouched', async () => {
    const list = await seeded('abc');

    await playlists.move(list, 9, 0);

    expect(await stored(list)).toEqual({
      uris: [uri('a'), uri('b'), uri('c')],
      positions: dense(3),
    });
  });

  it('conserves the track multiset across create → add → move → remove → get', async () => {
    const list = await seeded('abcde');
    await playlists.addTracks(list, ids('xy'), 2);
    await playlists.move(list, 6, 0);
    await playlists.move(list, 3, 5);
    await playlists.removeTracks(list, [1, 2]);

    const after = await playlists.get(list, true);
    const remaining = (after?.tracks ?? []).map((t) => t.uri);

    expect(remaining).toHaveLength(5);
    expect([...remaining].sort()).toEqual([...new Set(remaining)].sort());
    expect((await stored(list)).positions).toEqual(dense(5));
    expect((await stored(list)).uris).toEqual(remaining);
    expect(after?.trackCount).toBe(5);
  });
});

describe('snapshots', () => {
  it('renders a playlist whose provider rows were deleted from tracks', async () => {
    const remote = track('audius:track:zz', { title: 'Uzak Şarkı' });
    const list = (await playlists.create('Uzak', { tracks: [remote] })).uri;

    await host.db.execute('DELETE FROM tracks');
    expect(await repo.getTrack(remote.uri)).toBeUndefined();

    const rendered = await playlists.get(list, true);
    expect(rendered?.tracks?.map((t) => t.title)).toEqual(['Uzak Şarkı']);
    expect(rendered?.tracks?.[0]!.durationMs).toBe(remote.durationMs);
  });
});

describe('import / export', () => {
  it('exportM3u emits one #EXTINF and one location per track, preferring local paths', async () => {
    const local = track('a', { title: 'Yerel', durationMs: 90_000 });
    const remote = track('audius:track:r', { title: 'Akan', durationMs: 200_000 });
    const list = (await playlists.create('Karışık', { tracks: [local, remote] })).uri;

    const m3u = await playlists.exportM3u(list);
    const lines = m3u.trimEnd().split('\n');

    expect(lines[0]).toBe('#EXTM3U');
    expect(lines).toContain('#PLAYLIST:Karışık');
    expect(lines).toContain('#EXTINF:90,Artist a - Yerel');
    expect(lines).toContain('/music/a.mp3');
    expect(lines).toContain('#EXTINF:200,Artist r - Akan');
    expect(lines).toContain('audius:track:r');
    expect(lines.filter((l) => l.startsWith('#EXTINF:'))).toHaveLength(2);
  });

  it('importM3u round-trips an exported playlist', async () => {
    const tracks = [track('a'), track('audius:track:r'), track('c')];
    const list = (await playlists.create('Gezi', { tracks })).uri;
    const m3u = await playlists.exportM3u(list);

    const byLocation = new Map<string, Track>();
    for (const t of tracks) {
      byLocation.set(t.path ?? t.uri, t);
    }
    const imported = await playlists.importM3u('Gezi (m3u)', m3u, (path) =>
      Promise.resolve(byLocation.get(path)),
    );

    expect(imported.name).toBe('Gezi (m3u)');
    expect((await stored(imported.uri)).uris).toEqual(tracks.map((t) => t.uri));
    expect((await stored(imported.uri)).positions).toEqual(dense(3));
  });

  it('importM3u takes the #EXTINF duration only when the resolved track has none', async () => {
    const contents = ['#EXTM3U', '#EXTINF:42,A - B', '/music/a.mp3', '#EXTINF:42,C - D', '/music/b.mp3'].join('\n');

    const imported = await playlists.importM3u('Süreler', contents, (path) =>
      Promise.resolve(
        path === '/music/a.mp3'
          ? track('a', { durationMs: 0 })
          : track('b', { durationMs: 123_000 }),
      ),
    );

    const durations = (await playlists.get(imported.uri, true))?.tracks?.map((t) => t.durationMs);
    expect(durations).toEqual([42_000, 123_000]);
  });

  it('exportJson / importJson round-trip name, description and tracks', async () => {
    const tracks = ids('abc');
    const list = (await playlists.create('Akşam', { description: 'sakin', tracks })).uri;

    const restored = await playlists.importJson(await playlists.exportJson(list));

    expect(restored.uri).not.toBe(list);
    expect(restored.name).toBe('Akşam');
    expect(restored.description).toBe('sakin');
    expect((await stored(restored.uri)).uris).toEqual(tracks.map((t) => t.uri));
  });
});

describe('lookup and ordering', () => {
  it('containing finds every playlist holding the track and none that do not', async () => {
    const withIt1 = await seeded('abc');
    const withoutIt = await seeded('de');
    const withIt2 = await seeded('xb');

    const holders = (await playlists.containing(uri('b'))).map((p) => p.uri);

    expect(new Set(holders)).toEqual(new Set([withIt1, withIt2]));
    expect(holders).not.toContain(withoutIt);
  });

  it('setSortOrder is reflected in list ordering', async () => {
    const first = (await playlists.create('Bir')).uri;
    const second = (await playlists.create('İki')).uri;
    const third = (await playlists.create('Üç')).uri;
    expect((await playlists.list()).map((p) => p.uri)).toEqual([first, second, third]);

    await playlists.setSortOrder([third, first]);

    expect((await playlists.list()).map((p) => p.uri)).toEqual([third, first, second]);
  });
});
