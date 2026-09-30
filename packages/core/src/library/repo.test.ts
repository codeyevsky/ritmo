import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LibraryError, Repo } from './repo';
import { createFakeHost, track } from './testing';
import type { ListOpts } from './repo';
import type { Artist, Uri } from '../types';
import type { HostBridge } from '../host/types';

type FakeHost = HostBridge & { sql: string[] };
type RawQuery = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

const NOW = Date.parse('2024-03-01T12:00:00Z');

let host: FakeHost;
let repo: Repo;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  host = createFakeHost();
  repo = new Repo(host);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Makes the next `times` reads fail the way an unreadable database file does. */
function failQueries(target: FakeHost, times: number): void {
  let remaining = times;
  const real = target.db.query.bind(target.db) as RawQuery;
  target.db.query = ((sql: string, params?: unknown[]) => {
    if (remaining > 0) {
      remaining -= 1;
      return Promise.reject(new Error('SQLITE_IOERR: disk I/O error'));
    }
    return real(sql, params);
  }) as HostBridge['db']['query'];
}

async function rawTrack(uri: Uri): Promise<Record<string, unknown>> {
  const rows = await host.db.query('SELECT * FROM tracks WHERE uri = ?', [uri]);
  return rows[0]!;
}

async function pageAll(opts: ListOpts): Promise<{ uris: Uri[]; sizes: number[]; totals: Array<number | undefined> }> {
  const uris: Uri[] = [];
  const sizes: number[] = [];
  const totals: Array<number | undefined> = [];
  let cursor: string | undefined;
  do {
    const page: { items: Array<{ uri: Uri }>; cursor?: string; total?: number } =
      await repo.listTracks({ ...opts, cursor });
    uris.push(...page.items.map((t) => t.uri));
    sizes.push(page.items.length);
    totals.push(page.total);
    cursor = page.cursor;
    expect(sizes.length).toBeLessThan(10);
  } while (cursor !== undefined);
  return { uris, sizes, totals };
}

describe('upsertTracks', () => {
  it('inserts a track with every optional field intact', async () => {
    const full = track('a', {
      title: 'İlk Başlık',
      genres: ['Rock', 'Jazz'],
      releaseDate: '2001-05-04',
      trackNumber: 7,
      discNumber: 2,
      popularity: 0.5,
      gainDb: -3.5,
      explicit: true,
      artwork: { sources: [{ url: 'http://art/640.jpg', size: 640 }] },
      meta: { source: 'scan' },
    });

    await repo.upsertTracks([full]);

    expect(await repo.getTrack(full.uri)).toEqual({
      uri: full.uri,
      provider: 'local',
      title: 'İlk Başlık',
      artists: [{ uri: 'local:artist:art-a', name: 'Artist a' }],
      album: { uri: 'local:album:alb-a', name: 'Album a', artwork: undefined },
      durationMs: 180_000,
      trackNumber: 7,
      discNumber: 2,
      releaseDate: '2001-05-04',
      genres: ['Rock', 'Jazz'],
      artwork: { sources: [{ url: 'http://art/640.jpg', size: 640 }], placeholder: undefined, accent: undefined },
      popularity: 0.5,
      explicit: true,
      isLive: false,
      gainDb: -3.5,
      path: '/music/a.mp3',
      meta: { source: 'scan' },
    });
  });

  it('a second upsert carrying NULLs does not erase what is already stored', async () => {
    const full = track('a', {
      title: 'İlk Başlık',
      genres: ['Rock'],
      releaseDate: '2001-05-04',
      trackNumber: 7,
      discNumber: 2,
      popularity: 0.5,
      gainDb: -3.5,
      explicit: true,
      artwork: { sources: [{ url: 'http://art/640.jpg', size: 640 }] },
      meta: { source: 'scan' },
    });
    await repo.upsertTracks([full]);

    // A lean search result: a title, and nothing else the scan already knew.
    await repo.upsertTracks([
      track('a', {
        title: 'Zenginleşmiş Başlık',
        artists: [],
        album: undefined,
        durationMs: 0,
        genres: undefined,
        releaseDate: undefined,
        trackNumber: undefined,
        discNumber: undefined,
        popularity: undefined,
        gainDb: undefined,
        explicit: undefined,
        artwork: undefined,
        meta: undefined,
        path: undefined,
      }),
    ]);

    const stored = await repo.getTrack(full.uri);
    expect(stored?.title).toBe('Zenginleşmiş Başlık');
    expect(stored?.artists).toEqual(full.artists);
    expect(stored?.album).toMatchObject({ uri: 'local:album:alb-a', name: 'Album a' });
    expect(stored?.durationMs).toBe(180_000);
    expect(stored?.genres).toEqual(['Rock']);
    expect(stored?.releaseDate).toBe('2001-05-04');
    expect(stored?.trackNumber).toBe(7);
    expect(stored?.discNumber).toBe(2);
    expect(stored?.popularity).toBe(0.5);
    expect(stored?.gainDb).toBe(-3.5);
    expect(stored?.explicit).toBe(true);
    expect(stored?.artwork?.sources[0]!.url).toBe('http://art/640.jpg');
    expect(stored?.path).toBe('/music/a.mp3');
    expect(stored?.meta).toEqual({ source: 'scan' });
    expect((await rawTrack(full.uri)).title_key).toBe('zenginlesmis baslik');
  });

  it('preserves added_at across an update while moving updated_at', async () => {
    await repo.upsertTracks([track('a')]);
    const inserted = await rawTrack('local:track:a');
    expect(inserted.added_at).toBe(NOW);
    expect(inserted.updated_at).toBe(NOW);

    vi.setSystemTime(NOW + 60_000);
    await repo.upsertTracks([track('a', { title: 'Yeni' })]);

    const updated = await rawTrack('local:track:a');
    expect(updated.added_at).toBe(NOW);
    expect(updated.updated_at).toBe(NOW + 60_000);
  });

  it('stubs a missing album row so the foreign key never aborts the upsert', async () => {
    await repo.upsertTracks([track('audius:track:r')]);

    expect((await repo.getAlbum('audius:album:alb-r'))?.name).toBe('Album r');
  });
});

describe('getTracks', () => {
  it('answers in the caller order, not the database order', async () => {
    await repo.upsertTracks([track('a'), track('b'), track('c')]);

    const got = await repo.getTracks(['local:track:c', 'local:track:a', 'local:track:b']);

    expect(got.map((t) => t.uri)).toEqual(['local:track:c', 'local:track:a', 'local:track:b']);
  });

  it('skips uris with no row instead of leaving a hole', async () => {
    await repo.upsertTracks([track('a'), track('b')]);

    const got = await repo.getTracks(['local:track:gone', 'local:track:b', 'local:track:a']);

    expect(got.map((t) => t.uri)).toEqual(['local:track:b', 'local:track:a']);
  });
});

describe('listTracks sorting', () => {
  it('sorts by title on the folded key, so diacritics do not sort last', async () => {
    await repo.upsertTracks([
      track('z', { title: 'Zebra' }),
      track('b', { title: 'Bravo' }),
      track('e', { title: 'Éclair' }),
    ]);

    const asc = await repo.listTracks({ sort: 'title', dir: 'asc' });
    const desc = await repo.listTracks({ sort: 'title', dir: 'desc' });

    expect(asc.items.map((t) => t.title)).toEqual(['Bravo', 'Éclair', 'Zebra']);
    expect(desc.items.map((t) => t.title)).toEqual(['Zebra', 'Éclair', 'Bravo']);
  });

  it('sorts by artist on the artist row key, so diacritics do not sort last', async () => {
    const artists: Artist[] = [
      { uri: 'local:artist:n', provider: 'local', name: 'Nova' },
      { uri: 'local:artist:o', provider: 'local', name: 'Ödül' },
      { uri: 'local:artist:z', provider: 'local', name: 'Zulu' },
    ];
    await repo.upsertArtists(artists);
    await repo.upsertTracks(
      artists.map((a, i) => track(`t${i}`, { artists: [{ uri: a.uri, name: a.name }] })),
    );

    const asc = await repo.listTracks({ sort: 'artist', dir: 'asc' });

    expect(asc.items.map((t) => t.artists[0]!.name)).toEqual(['Nova', 'Ödül', 'Zulu']);
  });

  it('sorts by added time, newest first by default', async () => {
    for (const letter of 'abc') {
      await repo.upsertTracks([track(letter)]);
      vi.setSystemTime(Date.now() + 1000);
    }

    expect((await repo.listTracks({})).items.map((t) => t.uri)).toEqual([
      'local:track:c', 'local:track:b', 'local:track:a',
    ]);
  });
});

describe('listTracks keyset paging', () => {
  const COUNT = 25;
  const LIMIT = 7;
  let inserted: Uri[];

  beforeEach(async () => {
    inserted = [];
    for (let i = 0; i < COUNT; i += 1) {
      const t = track(`t${i}`);
      await repo.upsertTracks([t]);
      inserted.push(t.uri);
      vi.setSystemTime(Date.now() + 1000);
    }
    host.sql.length = 0;
  });

  it('visits every row exactly once paging by added time', async () => {
    const { uris, sizes, totals } = await pageAll({ sort: 'added', dir: 'desc', limit: LIMIT });

    expect(uris).toEqual([...inserted].reverse());
    expect(sizes).toEqual([7, 7, 7, 4]);
    expect(totals).toEqual([COUNT, undefined, undefined, undefined]);
  });

  it('visits every row exactly once paging by title', async () => {
    const byTitleKey = inserted
      .map((uri) => ({ uri, key: `track ${uri.slice('local:track:'.length)}` }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((x) => x.uri);

    const { uris, sizes } = await pageAll({ sort: 'title', dir: 'asc', limit: LIMIT });

    expect(uris).toEqual(byTitleKey);
    expect(new Set(uris).size).toBe(COUNT);
    expect(sizes).toEqual([7, 7, 7, 4]);
  });

  it('never resorts to OFFSET', async () => {
    await pageAll({ sort: 'added', dir: 'desc', limit: LIMIT });
    await pageAll({ sort: 'title', dir: 'asc', limit: LIMIT });

    expect(host.sql).not.toHaveLength(0);
    expect(host.sql.filter((s) => /\bOFFSET\b/i.test(s))).toEqual([]);
  });
});

describe('searchLocal', () => {
  beforeEach(async () => {
    await repo.upsertTracks([
      track('h', { title: 'Heartbeat City' }),
      track('o', { title: 'Öteki Yol' }),
    ]);
  });

  it('finds a track by a prefix of its title', async () => {
    expect((await repo.searchLocal('heartb')).tracks.map((t) => t.uri)).toEqual(['local:track:h']);
  });

  it('finds a track through FTS when the words are out of order', async () => {
    // No substring of `title_key` contains "city hea", so only the FTS index
    // can answer this one.
    expect((await repo.searchLocal('city hea')).tracks.map((t) => t.uri)).toEqual(['local:track:h']);
  });

  it('falls back to a substring scan for an infix FTS cannot tokenise', async () => {
    expect((await repo.searchLocal('beat ci')).tracks.map((t) => t.uri)).toEqual(['local:track:h']);
  });

  it('matches a diacritic-folded title through the normalised key', async () => {
    expect((await repo.searchLocal('oteki')).tracks.map((t) => t.uri)).toEqual(['local:track:o']);
  });

  it('is empty for a blank query without querying at all', async () => {
    host.sql.length = 0;

    expect(await repo.searchLocal('   ')).toEqual({ tracks: [], albums: [], artists: [] });
    expect(host.sql).toEqual([]);
  });
});

describe('getAlbum', () => {
  it('orders its tracks by disc then track number, untagged ones last', async () => {
    const album = { uri: 'local:album:one', name: 'Bir' };
    await repo.upsertTracks([
      track('d2t1', { album, discNumber: 2, trackNumber: 1, title: 'D2T1' }),
      track('d1t2', { album, discNumber: 1, trackNumber: 2, title: 'D1T2' }),
      track('d1t1', { album, discNumber: 1, trackNumber: 1, title: 'D1T1' }),
      track('bonus', { album, discNumber: undefined, trackNumber: undefined, title: 'Bonus' }),
    ]);

    const loaded = await repo.getAlbum(album.uri, true);

    expect(loaded?.tracks?.map((t) => t.title)).toEqual(['D1T1', 'D1T2', 'Bonus', 'D2T1']);
    expect(loaded?.totalTracks).toBe(4);
  });

  it('is undefined for an album with neither a row nor tracks', async () => {
    expect(await repo.getAlbum('local:album:nope', true)).toBeUndefined();
  });
});

/**
 * The two album columns of the scanner's `SQL_TRACK` upsert, verbatim. A rescan
 * only leaves a user edit alone because of these `instr(edited_json, …)` guards,
 * so the tests below prove the guard rather than the bookkeeping alone.
 */
async function rescanAlbumColumns(uri: Uri, albumUri: string | null): Promise<void> {
  const albumJson = albumUri === null ? null : JSON.stringify({ uri: albumUri, name: 'From tags' });
  await host.db.execute(
    `UPDATE tracks SET
       album_uri  = CASE WHEN instr(COALESCE(edited_json, ''), '"album_uri"') > 0
                         THEN album_uri ELSE ? END,
       album_json = CASE WHEN instr(COALESCE(edited_json, ''), '"album_json"') > 0
                         THEN album_json ELSE ? END
     WHERE uri = ?`,
    [albumUri, albumJson, uri],
  );
}

describe('setTrackAlbum', () => {
  const MIX = { uri: 'local:album:mix', name: 'Mixtape' };

  it('moves a track into an album and survives a rescan', async () => {
    await repo.upsertTracks([track('a')]);

    await repo.setTrackAlbum('local:track:a', MIX);

    const row = await rawTrack('local:track:a');
    expect(row.album_uri).toBe(MIX.uri);
    expect(JSON.parse(String(row.album_json))).toEqual(MIX);
    expect(JSON.parse(String(row.edited_json))).toEqual(
      expect.arrayContaining(['album_uri', 'album_json']),
    );

    // The album needs a row of its own, or `tracks.album_uri` breaks its
    // foreign key the moment the track points at it.
    expect((await repo.getAlbum(MIX.uri))?.name).toBe('Mixtape');
    expect((await repo.getAlbum(MIX.uri, true))?.tracks?.map((t) => t.uri)).toEqual([
      'local:track:a',
    ]);

    await rescanAlbumColumns('local:track:a', 'local:album:alb-a');

    expect((await repo.getTrack('local:track:a'))?.album).toEqual(MIX);
  });

  it('clears the album, keeps the track, and the clear survives a rescan', async () => {
    await repo.upsertTracks([track('a')]);

    await repo.setTrackAlbum('local:track:a', undefined);

    const row = await rawTrack('local:track:a');
    expect(row.album_uri).toBeNull();
    expect(row.album_json).toBeNull();
    expect(JSON.parse(String(row.edited_json))).toEqual(
      expect.arrayContaining(['album_uri', 'album_json']),
    );
    expect((await repo.getTrack('local:track:a'))?.album).toBeUndefined();
    expect((await repo.stats()).tracks).toBe(1);

    await rescanAlbumColumns('local:track:a', 'local:album:alb-a');

    expect((await repo.getTrack('local:track:a'))?.album).toBeUndefined();
  });

  it('leaves an edit made earlier by the details dialog in place', async () => {
    await repo.upsertTracks([track('a')]);
    await repo.updateTrackDetails('local:track:a', { title: 'Elden' });

    await repo.setTrackAlbum('local:track:a', MIX);

    expect(JSON.parse(String((await rawTrack('local:track:a')).edited_json))).toEqual(
      expect.arrayContaining(['title', 'title_key', 'album_uri', 'album_json']),
    );
  });

  it('is a no op for a track the library does not hold', async () => {
    await expect(repo.setTrackAlbum('local:track:ghost', MIX)).resolves.toBeUndefined();
    expect(await repo.getAlbum(MIX.uri)).toBeUndefined();
  });
});

describe('removeTracks', () => {
  const A = 'local:track:a';
  const B = 'local:track:b';
  const C = 'local:track:c';

  async function positionsOf(
    table: 'playlist_items' | 'pack_items',
    owner: string,
  ): Promise<Array<{ position: unknown; track: unknown }>> {
    const column = table === 'playlist_items' ? 'playlist_uri' : 'pack_uri';
    const rows = await host.db.query(
      `SELECT position, track_uri FROM ${table} WHERE ${column} = ? ORDER BY position ASC`,
      [owner],
    );
    return rows.map((row) => ({ position: row.position, track: row.track_uri }));
  }

  async function seed(): Promise<void> {
    await repo.upsertTracks([track('a'), track('b'), track('c')]);
    await host.db.execute("INSERT INTO likes (uri, kind, liked_at) VALUES (?, 'track', 1)", [B]);
    await host.db.execute(
      `INSERT INTO playlists (uri, provider, name, editable, created_at, updated_at)
       VALUES ('ritmo:playlist:p1', 'ritmo', 'Liste', 1, 1, 1)`,
    );
    await host.db.execute(
      `INSERT INTO packs (uri, name, source, created_at, updated_at)
       VALUES ('pack:k1', 'Paket', 'local', 1, 1)`,
    );
    for (const [position, uri] of [A, B, C].entries()) {
      await host.db.execute(
        `INSERT INTO playlist_items (playlist_uri, position, track_uri, track_json, added_at)
         VALUES ('ritmo:playlist:p1', ?, ?, ?, 1)`,
        [position, uri, JSON.stringify({ uri })],
      );
      await host.db.execute(
        `INSERT INTO pack_items (pack_uri, position, match_json, track_json, track_uri, added_at)
         VALUES ('pack:k1', ?, ?, ?, ?, 1)`,
        [position, JSON.stringify({ title: uri }), JSON.stringify({ uri }), uri],
      );
    }
    // A pack entry nothing ever resolved: it has no track to lose and must stay.
    await host.db.execute(
      `INSERT INTO pack_items (pack_uri, position, match_json, track_json, track_uri, added_at)
       VALUES ('pack:k1', 3, '{"title":"unresolved"}', NULL, NULL, 1)`,
    );
  }

  it('clears the track, its like and its list entries, leaving positions dense', async () => {
    await seed();

    await repo.removeTracks([B]);

    expect(await repo.getTrack(B)).toBeUndefined();
    const stats = await repo.stats();
    expect(stats.tracks).toBe(2);
    expect(stats.liked).toBe(0);
    expect(await positionsOf('playlist_items', 'ritmo:playlist:p1')).toEqual([
      { position: 0, track: A },
      { position: 1, track: C },
    ]);
    expect(await positionsOf('pack_items', 'pack:k1')).toEqual([
      { position: 0, track: A },
      { position: 1, track: C },
      { position: 2, track: null },
    ]);
  });

  it('removes several tracks at once and never touches a path on disk', async () => {
    await seed();
    const path = (await rawTrack(A)).path;

    await repo.removeTracks([A, C, A]);

    expect(await positionsOf('playlist_items', 'ritmo:playlist:p1')).toEqual([
      { position: 0, track: B },
    ]);
    // Nothing here writes to the filesystem; the row simply stops existing.
    expect(path).toBe('/music/a.mp3');
    expect((await repo.getTrack(B))?.uri).toBe(B);
  });

  it('is a no op for a track that is in no playlist', async () => {
    await repo.upsertTracks([track('a'), track('b')]);

    await expect(repo.removeTracks([A])).resolves.toBeUndefined();

    expect(await repo.getTrack(A)).toBeUndefined();
    expect((await repo.getTrack(B))?.uri).toBe(B);
  });

  it('does nothing for an empty list or a uri the library never held', async () => {
    await repo.upsertTracks([track('a')]);

    await expect(repo.removeTracks([])).resolves.toBeUndefined();
    await expect(repo.removeTracks(['local:track:ghost'])).resolves.toBeUndefined();

    expect((await repo.getTrack(A))?.uri).toBe(A);
  });
});

describe('stats', () => {
  it('counts match what was inserted', async () => {
    await repo.upsertTracks([
      track('a', { durationMs: 1000 }),
      track('b', { durationMs: 2000 }),
      track('audius:track:r', { durationMs: 4000 }),
    ]);
    await repo.upsertArtists([
      { uri: 'local:artist:n', provider: 'local', name: 'Nova' },
      { uri: 'local:artist:z', provider: 'local', name: 'Zulu' },
    ]);
    await host.db.execute("INSERT INTO likes (uri, kind, liked_at) VALUES ('local:track:a', 'track', 1)");
    await host.db.execute("INSERT INTO likes (uri, kind, liked_at) VALUES ('local:track:b', 'track', 2)");
    await host.db.execute("INSERT INTO likes (uri, kind, liked_at) VALUES ('local:album:alb-a', 'album', 3)");
    await host.db.execute(
      `INSERT INTO playlists (uri, provider, name, editable, created_at, updated_at)
       VALUES ('ritmo:playlist:p1', 'ritmo', 'Liste', 1, 1, 1)`,
    );
    await host.db.execute('UPDATE tracks SET file_size = 500 WHERE path IS NOT NULL');

    expect(await repo.stats()).toEqual({
      tracks: 3,
      albums: 3,
      artists: 2,
      playlists: 1,
      liked: 2,
      totalDurationMs: 7000,
      localBytes: 1000,
    });
  });

  it('is all zeroes on an empty library', async () => {
    expect(await repo.stats()).toEqual({
      tracks: 0,
      albums: 0,
      artists: 0,
      playlists: 0,
      liked: 0,
      totalDurationMs: 0,
      localBytes: 0,
    });
  });
});

describe('degradation', () => {
  it('a single rejected query answers empty, reports once and does not poison later reads', async () => {
    await repo.upsertTracks([track('a')]);
    const errors: unknown[] = [];
    repo.onError = (e) => errors.push(e);

    failQueries(host, 1);

    await expect(repo.getTrack('local:track:a')).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(LibraryError);
    expect((errors[0] as LibraryError).message).toContain('library database unavailable');

    expect((await repo.getTrack('local:track:a'))?.uri).toBe('local:track:a');
  });

  it('every read degrades to an empty result while the database is unreadable', async () => {
    await repo.upsertTracks([track('a')]);
    failQueries(host, Number.MAX_SAFE_INTEGER);
    repo.onError = () => {};

    expect(await repo.getTrack('local:track:a')).toBeUndefined();
    expect(await repo.getTracks(['local:track:a'])).toEqual([]);
    expect(await repo.getAlbum('local:album:alb-a')).toBeUndefined();
    expect(await repo.getAlbum('local:album:alb-a', true)).toBeUndefined();
    expect(await repo.getArtist('local:artist:art-a')).toBeUndefined();
    expect(await repo.getArtistAlbums('local:artist:art-a')).toEqual([]);
    expect(await repo.getArtistTracks('local:artist:art-a')).toEqual([]);
    expect(await repo.listTracks({})).toEqual({ items: [], total: 0 });
    expect(await repo.listAlbums({})).toEqual({ items: [], total: 0 });
    expect(await repo.listArtists({})).toEqual({ items: [], total: 0 });
    expect(await repo.searchLocal('a')).toEqual({ tracks: [], albums: [], artists: [] });
    expect(await repo.stats()).toEqual({
      tracks: 0,
      albums: 0,
      artists: 0,
      playlists: 0,
      liked: 0,
      totalDurationMs: 0,
      localBytes: 0,
    });
  });
});
