import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Likes } from './likes';
import { Repo } from './repo';
import { createFakeHost, track } from './testing';
import type { Album, Artist, Uri } from '../types';
import type { HostBridge } from '../host/types';

type FakeHost = HostBridge & { sql: string[] };

let host: FakeHost;
let repo: Repo;
let likes: Likes;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-03-01T12:00:00Z'));
  host = createFakeHost();
  repo = new Repo(host);
  likes = new Likes(host, repo);
});

afterEach(() => {
  vi.useRealTimers();
});

const album: Album = {
  uri: 'audius:album:al1',
  provider: 'audius',
  name: 'Gece',
  artists: [{ uri: 'audius:artist:ar1', name: 'Ay' }],
};

const artist: Artist = { uri: 'audius:artist:ar1', provider: 'audius', name: 'Ay' };

/** Like `letters` one at a time, a second apart, so `liked_at` never ties. */
async function likeInOrder(letters: string): Promise<Uri[]> {
  const out: Uri[] = [];
  for (const letter of letters) {
    const t = track(letter);
    await likes.like(t.uri, 'track', t);
    out.push(t.uri);
    vi.advanceTimersByTime(1000);
  }
  return out;
}

describe('like state', () => {
  it('like then unlike flips isLiked', async () => {
    const t = track('a');

    expect(await likes.isLiked(t.uri)).toBe(false);
    await likes.like(t.uri, 'track', t);
    expect(await likes.isLiked(t.uri)).toBe(true);
    await likes.unlike(t.uri);
    expect(await likes.isLiked(t.uri)).toBe(false);
  });

  it('toggle returns the state it just moved to', async () => {
    const t = track('a');

    expect(await likes.toggle(t.uri, 'track', t)).toBe(true);
    expect(await likes.isLiked(t.uri)).toBe(true);
    expect(await likes.toggle(t.uri, 'track', t)).toBe(false);
    expect(await likes.isLiked(t.uri)).toBe(false);
  });

  it('an empty uri is never liked', async () => {
    await likes.like('', 'track');

    expect(await likes.count()).toBe(0);
  });

  it('liking twice keeps one row', async () => {
    const t = track('a');

    await likes.like(t.uri, 'track', t);
    await likes.like(t.uri, 'track', t);

    expect(await likes.count('track')).toBe(1);
  });
});

describe('snapshots', () => {
  it('liking a remote track stores its snapshot so listTracks can render it', async () => {
    const remote = track('audius:track:r', { title: 'Uzak', durationMs: 123_000 });

    await likes.like(remote.uri, 'track', remote);

    const page = await likes.listTracks();
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.uri).toBe(remote.uri);
    expect(item.title).toBe('Uzak');
    expect(item.durationMs).toBe(123_000);
    expect(item.artists[0]!.name).toBe('Artist r');
    expect(item.album?.name).toBe('Album r');
  });

  it('a like with no snapshot leaves nothing for listTracks to join', async () => {
    await likes.like('audius:track:ghost', 'track');

    expect(await likes.isLiked('audius:track:ghost')).toBe(true);
    expect((await likes.listTracks()).items).toEqual([]);
  });

  it('liked albums and artists come back from their own tables', async () => {
    await likes.like(album.uri, 'album', album);
    await likes.like(artist.uri, 'artist', artist);

    expect((await likes.listAlbums()).map((a) => a.name)).toEqual(['Gece']);
    expect((await likes.listArtists()).map((a) => a.name)).toEqual(['Ay']);
  });
});

describe('likedSet', () => {
  it('answers a whole list in one query', async () => {
    const liked = await likeInOrder('ab');
    const asked = [...liked, track('c').uri, track('d').uri, track('e').uri];

    host.sql.length = 0;
    const set = await likes.likedSet(asked);

    expect(set).toEqual(new Set(liked));
    expect(host.sql.filter((s) => s.includes('FROM likes WHERE uri IN'))).toHaveLength(1);
    expect(host.sql).toHaveLength(1);
  });

  it('is empty without touching the database when asked for nothing', async () => {
    host.sql.length = 0;

    expect(await likes.likedSet([])).toEqual(new Set());
    expect(host.sql).toEqual([]);
  });
});

describe('count', () => {
  it('counts per kind and in total', async () => {
    await likeInOrder('ab');
    await likes.like(album.uri, 'album', album);
    await likes.like(artist.uri, 'artist', artist);

    expect(await likes.count('track')).toBe(2);
    expect(await likes.count('album')).toBe(1);
    expect(await likes.count('playlist')).toBe(0);
    expect(await likes.count()).toBe(4);
  });
});

describe('listTracks paging', () => {
  it('is newest-liked-first', async () => {
    const order = await likeInOrder('abcde');

    const page = await likes.listTracks();

    expect(page.items.map((t) => t.uri)).toEqual([...order].reverse());
    expect(page.total).toBe(5);
    expect(page.cursor).toBeUndefined();
  });

  it('pages with its cursor without repeating or skipping a row', async () => {
    const order = await likeInOrder('abcde');
    const seen: Uri[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await likes.listTracks({ limit: 2, cursor });
      seen.push(...page.items.map((t) => t.uri));
      cursor = page.cursor;
      if (pages === 0) expect(page.total).toBe(5);
      else expect(page.total).toBeUndefined();
      pages += 1;
    } while (cursor !== undefined);

    expect(seen).toEqual([...order].reverse());
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
  });

  it('pages across likes that share a timestamp without repeating or skipping a row', async () => {
    const same: Uri[] = [];
    for (const letter of 'abcd') {
      const t = track(letter);
      await likes.like(t.uri, 'track', t);
      same.push(t.uri);
    }

    const seen: Uri[] = [];
    let cursor: string | undefined;
    do {
      const page = await likes.listTracks({ limit: 2, cursor });
      seen.push(...page.items.map((t) => t.uri));
      cursor = page.cursor;
    } while (cursor !== undefined);

    expect(new Set(seen)).toEqual(new Set(same));
    expect(seen).toHaveLength(4);
    expect(seen).toEqual([...same].sort().reverse());
  });
});
