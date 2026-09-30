import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { History } from './history';
import { Repo } from './repo';
import { createFakeHost, track } from './testing';
import type { PlayHistoryEntry, Track } from '../types';
import type { HostBridge } from '../host/types';

type FakeHost = HostBridge & { sql: string[] };

const NOW = Date.parse('2024-03-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let host: FakeHost;
let history: History;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  host = createFakeHost();
  history = new History(host, new Repo(host));
});

afterEach(() => {
  vi.useRealTimers();
});

function entry(t: Track, at: number, over?: Partial<PlayHistoryEntry>): PlayHistoryEntry {
  return { track: t, playedAt: at, playedMs: 60_000, reason: 'user', completed: true, ...over };
}

async function play(t: Track, at: number, over?: Partial<PlayHistoryEntry>): Promise<void> {
  await history.record(entry(t, at, over));
}

describe('record', () => {
  it('recentEntries returns what record stored', async () => {
    await play(track('a'), NOW, { playedMs: 12_345, reason: 'radio', completed: false });

    const entries = await history.recentEntries();

    expect(entries).toHaveLength(1);
    const only = entries[0]!;
    expect(only.track.uri).toBe('local:track:a');
    expect(only.track.title).toBe('Track a');
    expect(only.playedAt).toBe(NOW);
    expect(only.playedMs).toBe(12_345);
    expect(only.reason).toBe('radio');
    expect(only.completed).toBe(false);
  });

  it('recentEntries is newest first', async () => {
    await play(track('a'), NOW - 2000);
    await play(track('b'), NOW);
    await play(track('c'), NOW - 1000);

    expect((await history.recentEntries()).map((e) => e.track.uri)).toEqual([
      'local:track:b', 'local:track:c', 'local:track:a',
    ]);
  });

  it('an unrecognised reason is stored as "user"', async () => {
    await play(track('a'), NOW, { reason: 'telepathy' as PlayHistoryEntry['reason'] });

    expect((await history.recentEntries())[0]!.reason).toBe('user');
  });

  it('a track with no uri is not recorded', async () => {
    await play(track('a', { uri: '' }), NOW);

    expect(await history.recentEntries()).toEqual([]);
  });
});

describe('recentlyPlayed', () => {
  it('dedupes by uri, newest first', async () => {
    await play(track('a'), NOW - 3000);
    await play(track('b'), NOW - 2000);
    await play(track('a'), NOW - 1000);

    expect((await history.recentlyPlayed()).map((t) => t.uri)).toEqual([
      'local:track:a', 'local:track:b',
    ]);
  });

  it('keeps the snapshot of the newest play, not the oldest', async () => {
    await play(track('a', { title: 'Eski Başlık' }), NOW - 5000);
    await play(track('a', { title: 'Yeni Başlık' }), NOW);

    expect((await history.recentlyPlayed()).map((t) => t.title)).toEqual(['Yeni Başlık']);
  });
});

describe('rankings count only completed plays', () => {
  it('topTracks ignores incomplete skips', async () => {
    const kept = track('a');
    const skipped = track('skip');
    await play(kept, NOW - 3000);
    await play(kept, NOW - 2000);
    await play(track('b'), NOW - 1000);
    for (let i = 0; i < 5; i += 1) {
      await play(skipped, NOW - 500 + i, { completed: false, playedMs: 4000 });
    }

    const top = await history.topTracks(0);

    expect(top.map((r) => [r.track.uri, r.plays])).toEqual([
      ['local:track:a', 2],
      ['local:track:b', 1],
    ]);
    expect(top.map((r) => r.track.uri)).not.toContain(skipped.uri);
  });

  it('topArtists ignores incomplete skips', async () => {
    const ay = [{ uri: 'local:artist:ay', name: 'Ay' }];
    const gun = [{ uri: 'local:artist:gun', name: 'Gün' }];
    await play(track('a', { artists: ay }), NOW - 3000);
    await play(track('b', { artists: ay }), NOW - 2000);
    await play(track('c', { artists: gun }), NOW - 1000);
    for (let i = 0; i < 9; i += 1) {
      await play(track('d', { artists: gun }), NOW + i, { completed: false });
    }

    expect(await history.topArtists(0)).toEqual([
      { artist: { uri: 'local:artist:ay', name: 'Ay' }, plays: 2 },
      { artist: { uri: 'local:artist:gun', name: 'Gün' }, plays: 1 },
    ]);
  });

  it('topAlbums ignores incomplete skips', async () => {
    const gece = { uri: 'local:album:gece', name: 'Gece' };
    const sabah = { uri: 'local:album:sabah', name: 'Sabah' };
    await play(track('a', { album: gece }), NOW - 3000);
    await play(track('b', { album: gece }), NOW - 2000);
    await play(track('c', { album: sabah }), NOW - 1000);
    for (let i = 0; i < 9; i += 1) {
      await play(track('d', { album: sabah }), NOW + i, { completed: false });
    }

    expect((await history.topAlbums(0)).map((r) => [r.album.uri, r.plays])).toEqual([
      ['local:album:gece', 2],
      ['local:album:sabah', 1],
    ]);
  });

  it('sinceMs excludes older rows from every ranking', async () => {
    const old = track('old');
    const fresh = track('fresh');
    for (let i = 0; i < 4; i += 1) await play(old, NOW - 10 * DAY + i);
    await play(fresh, NOW - 1000);

    const since = NOW - DAY;

    expect((await history.topTracks(since)).map((r) => r.track.uri)).toEqual([fresh.uri]);
    expect((await history.topArtists(since)).map((r) => r.artist.name)).toEqual(['Artist fresh']);
    expect((await history.topAlbums(since)).map((r) => r.album.name)).toEqual(['Album fresh']);
    expect(await history.listeningMs(since)).toBe(60_000);
  });
});

describe('aggregates', () => {
  it('listeningMs sums played_ms across complete and incomplete plays alike', async () => {
    await play(track('a'), NOW - 3000, { playedMs: 100 });
    await play(track('b'), NOW - 2000, { playedMs: 250, completed: false });
    await play(track('c'), NOW - 1000, { playedMs: 1 });

    expect(await history.listeningMs(0)).toBe(351);
  });

  it('listeningMs is 0 with no history', async () => {
    expect(await history.listeningMs(0)).toBe(0);
  });

  it('playCount counts only the completed plays of one track', async () => {
    const t = track('a');
    await play(t, NOW - 3000);
    await play(t, NOW - 2000);
    await play(t, NOW - 1000, { completed: false });
    await play(track('b'), NOW);

    expect(await history.playCount(t.uri)).toBe(2);
    expect(await history.playCount('local:track:nope')).toBe(0);
  });

  it('lastPlayedAt reports the newest play regardless of completion', async () => {
    const t = track('a');
    await play(t, NOW - 5000);
    await play(t, NOW - 1000, { completed: false });

    expect(await history.lastPlayedAt(t.uri)).toBe(NOW - 1000);
    expect(await history.lastPlayedAt('local:track:nope')).toBeUndefined();
  });
});

describe('prune', () => {
  it('deletes only rows older than the cutoff and returns how many it deleted', async () => {
    await play(track('ancient'), NOW - 40 * DAY);
    await play(track('old'), NOW - 31 * DAY);
    await play(track('edge'), NOW - 30 * DAY);
    await play(track('recent'), NOW - DAY);

    expect(await history.prune(30)).toBe(2);

    expect((await history.recentEntries()).map((e) => e.track.uri)).toEqual([
      'local:track:recent', 'local:track:edge',
    ]);
  });

  it('keeps at least one day of history even when asked for less', async () => {
    await play(track('today'), NOW - 1000);
    await play(track('lastweek'), NOW - 7 * DAY);

    expect(await history.prune(0)).toBe(1);
    expect((await history.recentEntries()).map((e) => e.track.uri)).toEqual(['local:track:today']);
  });
});
