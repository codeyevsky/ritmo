import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItem, QueueSnapshot, Track } from '../types';
import { QueueEngine } from './queue';
import { mulberry32 } from './shuffle';

const t = (id: string, artist = 'a1'): Track => ({
  uri: `audius:track:${id}`,
  provider: 'audius',
  title: id,
  artists: [{ uri: `audius:artist:${artist}`, name: artist }],
  durationMs: 180_000,
});

/** `list('ABC')` → three tracks titled A, B, C, each by its own artist so the
 *  anti-clumping pass in the shuffle never has to compromise. */
const list = (ids: string): Track[] => [...ids].map((c) => t(c, `art-${c}`));

const many = (n: number): Track[] => Array.from({ length: n }, (_, i) => t(`T${i}`, `art${i}`));

const titles = (items: QueueItem[]): string => items.map((i) => i.track.title).join('');

/** Everything the queue still holds, order-insensitive — for conservation checks. */
function multiset(q: QueueEngine): string {
  const s = q.snapshot();
  const all = [...s.history, ...(s.current ? [s.current] : []), ...s.upcoming];
  return all.map((i) => i.track.uri).sort().join(',');
}

function allIds(q: QueueEngine): string[] {
  const s = q.snapshot();
  return [...s.history, ...(s.current ? [s.current] : []), ...s.upcoming].map((i) => i.id);
}

function drain(q: QueueEngine, max = 50): string[] {
  const played: string[] = [];
  for (let i = 0; i < max; i++) {
    const item = q.next();
    if (!item) break;
    played.push(item.track.title);
  }
  return played;
}

describe('QueueEngine.setContext', () => {
  it('makes startIndex current, keeps the rest in order and starts with no history', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABCDE'), 2, { uri: 'audius:playlist:p1', name: 'Evening' });
    const s = q.snapshot();
    expect(s.current?.track.title).toBe('C');
    expect(titles(s.upcoming)).toBe('DE');
    expect(s.history).toEqual([]);
    expect(s.contextUri).toBe('audius:playlist:p1');
    expect(s.contextName).toBe('Evening');
    expect(s.current?.contextUri).toBe('audius:playlist:p1');
    expect(s.current?.userQueued).toBe(false);
  });

  it('clamps and truncates an out-of-range startIndex instead of crashing', () => {
    const q = new QueueEngine({ seed: 1 });

    q.setContext(list('ABC'), -5);
    expect(q.current()?.track.title).toBe('A');
    expect(titles(q.snapshot().upcoming)).toBe('BC');

    q.setContext(list('ABC'), 99);
    expect(q.current()?.track.title).toBe('C');
    expect(q.snapshot().upcoming).toEqual([]);

    q.setContext(list('ABC'), 1.9);
    expect(q.current()?.track.title).toBe('B');

    q.setContext(list('ABC'), Number.NaN);
    expect(q.current()?.track.title).toBe('A');
  });

  it('yields no current item for an empty track list', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    q.setContext([], 0, { uri: 'audius:playlist:empty' });
    const s = q.snapshot();
    expect(s.current).toBeUndefined();
    expect(s.upcoming).toEqual([]);
    expect(s.history).toEqual([]);
    expect(s.contextUri).toBe('audius:playlist:empty');
  });

  it('discards the previous pass entirely', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    q.addToQueue(list('X'));
    q.next();
    q.setContext(list('PQR'), 0);
    const s = q.snapshot();
    expect(s.history).toEqual([]);
    expect(titles(s.upcoming)).toBe('QR');
    expect(s.current?.track.title).toBe('P');
  });
});

describe('QueueEngine item ids', () => {
  it('gives the same track two distinct ids when it appears twice', () => {
    const q = new QueueEngine({ seed: 1 });
    const dup = t('A');
    q.setContext([dup, t('B'), dup], 0);
    q.addNext([dup]);
    const ids = allIds(q);
    expect(new Set(ids).size).toBe(ids.length);
    const aCount = q.snapshot().upcoming.filter((i) => i.track.title === 'A').length;
    expect(aCount).toBe(2);
  });

  it('comes from a counter, not randomness: ids are stable and reproducible', () => {
    const build = (): QueueEngine => {
      const q = new QueueEngine({ seed: 5 });
      q.setContext(list('ABC'), 0);
      q.addNext(list('X'));
      return q;
    };
    const first = build();
    const ids = allIds(first);
    expect(allIds(first)).toEqual(ids);
    expect(allIds(build())).toEqual(ids);
    expect(first.snapshot().current?.id).toBe(first.snapshot().current?.id);
  });
});

describe('QueueEngine user-queued ordering', () => {
  it('keeps two consecutive Play next calls in the order they were made', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    q.addNext(list('X'));
    q.addNext(list('Y'));
    expect(titles(q.snapshot().upcoming)).toBe('XYBC');
  });

  it('lands Play next ahead of the context but behind nothing of its own', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    q.addToQueue(list('Q'));
    q.addNext(list('X'));
    expect(titles(q.snapshot().upcoming)).toBe('XQBC');
    q.addNext(list('YZ'));
    expect(titles(q.snapshot().upcoming)).toBe('XYZQBC');
  });

  it('appends Add to queue to the user-queued tail', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    q.addToQueue(list('X'));
    q.addToQueue(list('Y'));
    expect(titles(q.snapshot().upcoming)).toBe('XYBC');
    q.addNext(list('N'));
    q.addToQueue(list('Z'));
    expect(titles(q.snapshot().upcoming)).toBe('NXYZBC');
  });

  it('flags user-queued items and leaves context items unflagged', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('AB'), 0, { uri: 'audius:album:al1' });
    q.addToQueue(list('X'));
    const s = q.snapshot();
    expect(s.upcoming.map((i) => i.userQueued)).toEqual([true, false]);
    expect(s.upcoming[0]?.contextUri).toBeUndefined();
    expect(s.upcoming[1]?.contextUri).toBe('audius:album:al1');
  });

  it('consumes user-queued items: they do not come back when the context wraps', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('AB'), 0);
    q.addToQueue(list('X'));
    q.setRepeat('all');
    expect(titles(q.snapshot().upcoming)).toBe('XB');
    expect(q.next()?.track.title).toBe('X');
    expect(q.next()?.track.title).toBe('B');
    expect(q.next()?.track.title).toBe('A');
    expect(titles(q.snapshot().upcoming)).toBe('B');
    expect(q.snapshot().upcoming.some((i) => i.track.title === 'X')).toBe(false);
  });

  it('ignores empty additions without emitting', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('AB'), 0);
    let events = 0;
    q.events.on(() => { events++; });
    q.addNext([]);
    q.addToQueue([]);
    q.appendContext([]);
    expect(events).toBe(0);
  });
});

describe('QueueEngine.appendContext', () => {
  it('extends the context so the appended tracks repeat and are not user-queued', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('AB'), 0);
    q.appendContext(list('CD'));
    expect(titles(q.snapshot().upcoming)).toBe('BCD');
    expect(q.snapshot().upcoming.every((i) => i.userQueued === false)).toBe(true);
    q.setRepeat('all');
    drain(q, 3);
    expect(q.current()?.track.title).toBe('D');
    expect(q.next()?.track.title).toBe('A');
    expect(titles(q.snapshot().upcoming)).toBe('BCD');
  });
});

describe('QueueEngine.remove', () => {
  it('removes an upcoming item by id and ignores an unknown id', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABCD'), 0);
    const target = q.snapshot().upcoming[1];
    expect(target?.track.title).toBe('C');

    let events = 0;
    q.events.on(() => { events++; });
    q.remove('does-not-exist');
    expect(events).toBe(0);
    expect(titles(q.snapshot().upcoming)).toBe('BCD');

    q.remove(target?.id as string);
    expect(events).toBe(1);
    expect(titles(q.snapshot().upcoming)).toBe('BD');
  });

  it('drops a context row and leaves the user-queued block untouched', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABCD'), 0);
    q.addToQueue(list('X'));
    expect(titles(q.snapshot().upcoming)).toBe('XBCD');

    const ctx = q.snapshot().upcoming.find((i) => i.track.title === 'C');
    expect(ctx?.userQueued).toBe(false);
    q.remove(ctx?.id as string);

    const s = q.snapshot();
    expect(titles(s.upcoming)).toBe('XBD');
    expect(s.current?.track.title).toBe('A');
    expect(q.next()?.track.title).toBe('X');
  });

  it('does not resurrect a removed context track on a repeat-all wrap', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    q.setRepeat('all');
    q.remove(q.snapshot().upcoming[0]?.id as string); // drop B
    expect(titles(q.snapshot().upcoming)).toBe('C');
    q.next();
    expect(q.next()?.track.title).toBe('A');
    expect(titles(q.snapshot().upcoming)).toBe('C');
  });

  it('does not resurrect a removed context track when shuffle is turned off', () => {
    const q = new QueueEngine({ seed: 42 });
    q.setContext(list('ABCDEF'), 0);
    q.remove(q.snapshot().upcoming[2]?.id as string); // drop D
    q.setShuffle(true);
    q.setShuffle(false);
    expect(titles(q.snapshot().upcoming)).toBe('BCEF');
  });

  it('leaves the current item alone', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    const cur = q.current();
    q.remove(cur?.id as string);
    expect(q.current()?.id).toBe(cur?.id);
    expect(titles(q.snapshot().upcoming)).toBe('BC');
  });
});

describe('QueueEngine.move', () => {
  it('reorders within upcoming', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABCDE'), 0);
    const d = q.snapshot().upcoming[2];
    q.move(d?.id as string, 0);
    expect(titles(q.snapshot().upcoming)).toBe('DBCE');
    q.move(d?.id as string, 2);
    expect(titles(q.snapshot().upcoming)).toBe('BCDE');
  });

  it('is a no-op for an unknown id', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    let events = 0;
    q.events.on(() => { events++; });
    q.move('nope', 0);
    expect(events).toBe(0);
    expect(titles(q.snapshot().upcoming)).toBe('BC');
  });

  it('clamps an out-of-range target rather than dropping the item', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABCD'), 0);
    const b = q.snapshot().upcoming[0]?.id as string;

    q.move(b, 99);
    expect(titles(q.snapshot().upcoming)).toBe('CDB');
    q.move(b, -4);
    expect(titles(q.snapshot().upcoming)).toBe('BCD');
    expect(multiset(q)).toBe(['A', 'B', 'C', 'D'].map((x) => `audius:track:${x}`).sort().join(','));
  });
});

describe('QueueEngine.next repeat modes', () => {
  it('repeat one replays on an automatic advance but still moves when the user asks', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    q.setRepeat('one');
    const before = q.snapshot();

    expect(q.next({ userInitiated: false })?.track.title).toBe('A');
    expect(q.next()?.track.title).toBe('A');
    expect(q.snapshot()).toEqual(before);

    expect(q.next({ userInitiated: true })?.track.title).toBe('B');
    expect(titles(q.snapshot().history)).toBe('A');
    expect(q.next({ userInitiated: false })?.track.title).toBe('B');
    expect(titles(q.snapshot().history)).toBe('A');
  });

  it('repeat all wraps to the start of the context with fresh ids', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    q.setRepeat('all');
    const firstPassIds = new Set(allIds(q));

    expect(drain(q, 5)).toEqual(['B', 'C', 'A', 'B', 'C']);
    expect(q.next()?.track.title).toBe('A');

    const ids = allIds(q);
    expect(new Set(ids).size).toBe(ids.length);
    expect(q.snapshot().upcoming.every((i) => !firstPassIds.has(i.id))).toBe(true);
    expect(titles(q.snapshot().history).endsWith('ABCABC')).toBe(true);
  });

  it('repeat off ends the queue with undefined and one exhausted event', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    let exhausted = 0;
    q.events.on((e) => { if (e.type === 'exhausted') exhausted++; });

    expect(q.next()?.track.title).toBe('B');
    expect(q.next()?.track.title).toBe('C');
    expect(exhausted).toBe(0);
    expect(q.next()).toBeUndefined();
    expect(exhausted).toBe(1);
    // The exhausted queue keeps its current track so the UI can still show it.
    expect(q.current()?.track.title).toBe('C');
    expect(q.snapshot().upcoming).toEqual([]);
  });

  it('reports exhaustion for an empty queue', () => {
    const q = new QueueEngine({ seed: 1 });
    let exhausted = 0;
    q.events.on((e) => { if (e.type === 'exhausted') exhausted++; });
    expect(q.next()).toBeUndefined();
    expect(exhausted).toBe(1);
  });

  it('peekNext reports what next would return, and nothing when a shuffled wrap is undecided', () => {
    const q = new QueueEngine({ seed: 42 });
    q.setContext(list('ABC'), 0);
    expect(q.peekNext()?.track.title).toBe('B');

    q.setRepeat('one');
    expect(q.peekNext()?.track.title).toBe('A');

    q.setRepeat('off');
    drain(q, 2);
    expect(q.peekNext()).toBeUndefined();

    q.setRepeat('all');
    expect(q.peekNext()?.track.title).toBe('A');

    q.setShuffle(true);
    expect(q.peekNext()).toBeUndefined();
  });
});

describe('QueueEngine.previous', () => {
  it('walks back through history in play order and returns the current track to upcoming', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABCD'), 0);
    drain(q, 3);
    expect(titles(q.snapshot().history)).toBe('ABC');
    expect(q.current()?.track.title).toBe('D');

    expect(q.previous()?.track.title).toBe('C');
    expect(titles(q.snapshot().history)).toBe('AB');
    expect(titles(q.snapshot().upcoming)).toBe('D');

    expect(q.previous()?.track.title).toBe('B');
    expect(q.previous()?.track.title).toBe('A');
    expect(q.snapshot().history).toEqual([]);
    expect(titles(q.snapshot().upcoming)).toBe('BCD');
  });

  it('returns undefined and emits nothing with an empty history', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('AB'), 0);
    let events = 0;
    q.events.on(() => { events++; });
    expect(q.previous()).toBeUndefined();
    expect(events).toBe(0);
  });

  it('caps history at 200 entries, dropping the oldest', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(many(250), 0);
    drain(q, 249);
    const history = q.snapshot().history;
    expect(history).toHaveLength(200);
    expect(history[0]?.track.title).toBe('T49');
    expect(history[199]?.track.title).toBe('T248');
    expect(q.current()?.track.title).toBe('T249');
  });
});

describe('QueueEngine shuffle', () => {
  it('keeps the current track and reshuffles only the context part of upcoming', () => {
    const q = new QueueEngine({ seed: 42 });
    q.setContext(list('ABCDEFGHIJ'), 0);
    q.addNext(list('X'));
    q.addToQueue(list('Y'));
    expect(titles(q.snapshot().upcoming)).toBe('XYBCDEFGHIJ');

    q.setShuffle(true);
    const s = q.snapshot();
    expect(s.current?.track.title).toBe('A');
    expect(titles(s.upcoming.slice(0, 2))).toBe('XY');
    const ctx = titles(s.upcoming.slice(2));
    expect([...ctx].sort().join('')).toBe('BCDEFGHIJ');
    expect(ctx).not.toBe('BCDEFGHIJ');
  });

  it('restores the exact original context order when switched off', () => {
    const q = new QueueEngine({ seed: 42 });
    q.setContext(list('ABCDEFGHIJ'), 0);
    q.addToQueue(list('Y'));
    q.setShuffle(true);
    q.setShuffle(false);
    expect(titles(q.snapshot().upcoming)).toBe('YBCDEFGHIJ');
    expect(q.current()?.track.title).toBe('A');
  });

  it('resumes the original order after the track that is playing', () => {
    const q = new QueueEngine({ seed: 42 });
    const order = 'ABCDEFGHIJ';
    q.setContext(list(order), 0);
    q.setShuffle(true);
    q.next();
    const playing = q.next()?.track.title as string;
    q.setShuffle(false);

    const at = order.indexOf(playing);
    expect(titles(q.snapshot().upcoming)).toBe(order.slice(at + 1));
    const ids = allIds(q);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('conserves every track across on → off → on toggles', () => {
    const q = new QueueEngine({ seed: 42 });
    q.setContext(list('ABCDEFGH'), 0);
    q.addNext(list('X'));
    q.addToQueue(list('Y'));
    const expected = multiset(q);

    for (const on of [true, false, true, false, true]) {
      q.setShuffle(on);
      expect(multiset(q)).toBe(expected);
      const ids = allIds(q);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('shuffles the remainder of a new context while keeping startIndex current', () => {
    const q = new QueueEngine({ seed: 42 });
    q.setShuffle(true);
    q.setContext(list('ABCDEFGH'), 3);
    const s = q.snapshot();
    expect(s.current?.track.title).toBe('D');
    expect(titles(s.upcoming).split('').sort().join('')).toBe('ABCEFGH');
    expect(titles(s.upcoming)).not.toBe('ABCEFGH');
  });

  it('ignores a toggle to the mode it is already in', () => {
    const q = new QueueEngine({ seed: 42 });
    q.setContext(list('ABCD'), 0);
    let events = 0;
    q.events.on(() => { events++; });
    q.setShuffle(false);
    q.setRepeat('off');
    expect(events).toBe(0);
    q.setShuffle(true);
    q.setRepeat('all');
    expect(events).toBe(2);
    expect(q.isShuffled()).toBe(true);
    expect(q.repeat()).toBe('all');
  });

  it('never leaves a track in both history and upcoming after un-shuffling', () => {
    const q = new QueueEngine({ seed: 42 });
    q.setContext(list('ABCDEFGHIJ'), 0);
    q.setShuffle(true);
    drain(q, 4);
    q.setShuffle(false);
    const s = q.snapshot();
    const upcoming = new Set(s.upcoming.map((i) => i.id));
    expect(s.history.some((i) => upcoming.has(i.id))).toBe(false);
    expect(upcoming.has(s.current?.id as string)).toBe(false);
  });
});

describe('QueueEngine serialize/restore', () => {
  const build = (): QueueEngine => {
    const q = new QueueEngine({ seed: 7 });
    q.setContext(list('ABCDEF'), 1, { uri: 'audius:playlist:p1', name: 'Mix' });
    q.addNext(list('X'));
    q.addToQueue(list('Y'));
    q.setRepeat('all');
    q.setShuffle(true);
    q.next();
    return q;
  };

  it('round-trips the snapshot, the shuffle flag and the repeat mode', () => {
    const a = build();
    const b = new QueueEngine({ seed: 999 });
    b.restore(a.serialize());
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.isShuffled()).toBe(true);
    expect(b.repeat()).toBe('all');
  });

  it('round-trips the pristine context order, so un-shuffling still works after a restart', () => {
    const a = build();
    const b = new QueueEngine({ seed: 999 });
    b.restore(a.serialize());
    a.setShuffle(false);
    b.setShuffle(false);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(titles(b.snapshot().upcoming)).toBe(titles(a.snapshot().upcoming));
  });

  it('round-trips the id counter so new items cannot collide with restored ones', () => {
    const a = build();
    const b = new QueueEngine({ seed: 999 });
    b.restore(a.serialize());
    const before = new Set(allIds(b));
    b.addNext(list('Z'));
    const added = b.snapshot().upcoming[0];
    expect(added?.track.title).toBe('Z');
    expect(before.has(added?.id as string)).toBe(false);
  });

  it('survives a restore of its own serialised state twice over', () => {
    const a = build();
    const json = a.serialize();
    a.restore(json);
    expect(a.serialize()).toBe(json);
  });

  it('rejects malformed JSON without corrupting the queue', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    const before = q.snapshot();

    for (const bad of ['{not json', '[]', 'null', '"x"', '{"v":1}', JSON.stringify({ v: 99 })]) {
      expect(() => { q.restore(bad); }).toThrow();
    }

    expect(q.snapshot()).toEqual(before);
    expect(q.next()?.track.title).toBe('B');
    expect(q.next()?.track.title).toBe('C');
  });

  it('skips unusable entries instead of rejecting the whole payload', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0);
    const raw = JSON.parse(q.serialize()) as Record<string, unknown>;
    const entries = raw.entries as unknown[];
    entries.push({ id: 'junk', origin: 'context' }, 42, { id: 'junk2', track: {}, origin: 'context' });
    (raw.upcoming as string[]).push('junk', 'never-seen');

    const restored = new QueueEngine({ seed: 2 });
    restored.restore(JSON.stringify(raw));
    expect(titles(restored.snapshot().upcoming)).toBe('BC');
    expect(restored.current()?.track.title).toBe('A');
  });
});

describe('QueueEngine clearing', () => {
  it('clearUpcoming keeps the current track and stops the context from repeating past it', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABCD'), 1);
    q.addToQueue(list('X'));
    q.setRepeat('all');
    q.clearUpcoming();

    expect(q.current()?.track.title).toBe('B');
    expect(q.snapshot().upcoming).toEqual([]);
    expect(q.next()?.track.title).toBe('B');
    expect(titles(q.snapshot().history)).toBe('B');
  });

  it('clear empties everything', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(list('ABC'), 0, { uri: 'audius:playlist:p1', name: 'Mix' });
    q.next();
    q.clear();
    expect(q.snapshot()).toEqual({
      history: [],
      current: undefined,
      upcoming: [],
      contextUri: undefined,
      contextName: undefined,
    });
    expect(q.next()).toBeUndefined();
  });
});

describe('QueueEngine changed event', () => {
  let q: QueueEngine;
  let snapshots: QueueSnapshot[];

  beforeEach(() => {
    q = new QueueEngine({ seed: 42 });
    snapshots = [];
    q.events.on((e) => { if (e.type === 'changed') snapshots.push(e.snapshot); });
  });

  it('fires once per mutation and carries the new snapshot', () => {
    q.setContext(list('ABCD'), 0);
    expect(snapshots).toHaveLength(1);
    expect(titles(snapshots[0]?.upcoming ?? [])).toBe('BCD');

    const mutations: Array<() => void> = [
      () => q.addNext(list('X')),
      () => q.addToQueue(list('Y')),
      () => q.appendContext(list('Z')),
      () => q.move(q.snapshot().upcoming[0]?.id as string, 1),
      () => q.remove(q.snapshot().upcoming[0]?.id as string),
      () => q.setShuffle(true),
      () => q.setRepeat('all'),
      () => { q.next(); },
      () => { q.previous(); },
      () => q.clearUpcoming(),
      () => q.clear(),
    ];
    for (const mutate of mutations) {
      const before = snapshots.length;
      mutate();
      expect(snapshots).toHaveLength(before + 1);
      expect(snapshots[snapshots.length - 1]).toEqual(q.snapshot());
    }
  });

  it('delivers a snapshot that later mutations cannot retroactively change', () => {
    q.setContext(list('ABC'), 0);
    const first = snapshots[0] as QueueSnapshot;
    q.next();
    expect(titles(first.upcoming)).toBe('BC');
    expect(first.current?.track.title).toBe('A');
  });

  it('keeps emitting after a subscriber throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    q.events.on(() => { throw new Error('bad listener'); });
    q.setContext(list('AB'), 0);
    q.next();
    expect(snapshots).toHaveLength(2);
    spy.mockRestore();
  });
});

/**
 * The bug these cover: the queue panel listed the same track twice under
 * "Next in queue" while a different track was playing. The engine turned out
 * to be sound — a provider's top-tracks list genuinely held the recording
 * twice — but the invariants that would have made the engine a suspect are
 * worth pinning down, because nothing else in the app enforces them.
 */
describe('QueueEngine current/upcoming separation', () => {
  /** What the queue panel renders: the playhead row, then the upcoming rows. */
  const assertSeparated = (q: QueueEngine, where: string): void => {
    const s = q.snapshot();
    const upcomingIds = s.upcoming.map((i) => i.id);
    if (s.current) {
      expect(upcomingIds, `current is also upcoming after ${where}`)
        .not.toContain(s.current.id);
    }
    expect(new Set(upcomingIds).size, `duplicate ids in upcoming after ${where}`)
      .toBe(upcomingIds.length);
    const all = [...s.history, ...(s.current ? [s.current] : []), ...s.upcoming].map((i) => i.id);
    expect(new Set(all).size, `an id is held twice after ${where}`).toBe(all.length);
  };

  it('holds through the transitions that move entries between the three blocks', () => {
    const q = new QueueEngine({ seed: 7 });

    const steps: Array<[string, () => void]> = [
      ['setContext', () => q.setContext(list('ABCDEF'), 2, { uri: 'ctx', name: 'Ctx' })],
      ['addNext', () => q.addNext(list('XY'))],
      ['addToQueue', () => q.addToQueue(list('Z'))],
      ['next', () => { q.next(); }],
      ['next', () => { q.next(); }],
      ['previous', () => { q.previous(); }],
      ['shuffle on', () => q.setShuffle(true)],
      ['next while shuffled', () => { q.next(); }],
      ['shuffle off', () => q.setShuffle(false)],
      ['appendContext', () => q.appendContext(list('GH'))],
      ['repeat all', () => q.setRepeat('all')],
      ['drain past the wrap', () => drain(q, 20)],
      ['repeat one', () => q.setRepeat('one')],
      ['next under repeat one', () => { q.next(); }],
      ['user next under repeat one', () => { q.next({ userInitiated: true }); }],
      ['remove', () => { const id = q.snapshot().upcoming[0]?.id; if (id) q.remove(id); }],
      ['move', () => { const id = q.snapshot().upcoming[0]?.id; if (id) q.move(id, 3); }],
      ['restore of its own state', () => q.restore(q.serialize())],
      ['clearUpcoming', () => q.clearUpcoming()],
    ];

    for (const [name, step] of steps) {
      step();
      assertSeparated(q, name);
    }
  });

  it('holds across a seeded walk over every mutation', () => {
    const rand = mulberry32(0xc0ffee);
    const pick = (n: number): number => Math.floor(rand() * n);

    for (let run = 0; run < 40; run++) {
      const q = new QueueEngine({ seed: run });
      for (let step = 0; step < 40; step++) {
        const upcoming = q.snapshot().upcoming;
        const someId = upcoming[pick(Math.max(1, upcoming.length))]?.id;
        switch (pick(11)) {
          case 0: q.setContext(list('ABCDE').slice(0, 1 + pick(5)), pick(5), { uri: 'ctx' }); break;
          case 1: q.addNext(list('XY').slice(0, 1 + pick(2))); break;
          case 2: q.addToQueue(list('Z')); break;
          case 3: q.appendContext(list('GH')); break;
          case 4: q.next({ userInitiated: rand() < 0.5 }); break;
          case 5: q.previous(); break;
          case 6: q.setShuffle(rand() < 0.5); break;
          case 7: q.setRepeat(pick(3) === 0 ? 'off' : pick(2) === 0 ? 'all' : 'one'); break;
          case 8: if (someId) q.move(someId, pick(upcoming.length + 1)); break;
          case 9: if (someId) q.remove(someId); break;
          default: q.restore(q.serialize()); break;
        }
        assertSeparated(q, `run ${run} step ${step}`);
      }
    }
  });
});

describe('QueueEngine duplicate tracks in one context', () => {
  /** What `getArtistTopTracks` handed the queue: the same recording, twice. */
  const withRepeats = (): Track[] => [t('A'), t('B'), t('A'), t('C'), t('A')];

  it('keeps one entry per position, each with its own id', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(withRepeats(), 0, { uri: 'audius:artist:x', name: 'Artist' });

    const s = q.snapshot();
    expect(s.current?.track.title).toBe('A');
    // Four positions follow position 0, repeats and all — the list is not collapsed.
    expect(titles(s.upcoming)).toBe('BACA');
    expect(new Set(s.upcoming.map((i) => i.id)).size).toBe(4);
    expect(s.upcoming.map((i) => i.id)).not.toContain(s.current?.id);
  });

  it('never plays the same position twice', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(withRepeats(), 0);

    const played: string[] = [q.current()?.id as string];
    for (;;) {
      const item = q.next();
      if (!item) break;
      played.push(item.id);
    }

    expect(played).toHaveLength(5);
    expect(new Set(played).size).toBe(5);
  });

  it('removes only the position the user removed, not its twin', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(withRepeats(), 0);
    // Position 2 — the first repeat of A inside `upcoming`.
    const twin = q.snapshot().upcoming[1];
    q.remove(twin?.id as string);

    expect(titles(q.snapshot().upcoming)).toBe('BCA');
  });

  it('replays every position once per repeat-all pass', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setRepeat('all');
    q.setContext(withRepeats(), 0);

    const firstPass = drain(q, 4).join('');
    expect(firstPass).toBe('BACA');
    // The wrap is a new pass over the same five positions, with fresh ids.
    expect(drain(q, 5).join('')).toBe('ABACA');
  });

  it('shuffles positions rather than tracks, so every copy still gets played', () => {
    const q = new QueueEngine({ seed: 3 });
    q.setShuffle(true);
    q.setContext(withRepeats(), 0);

    const s = q.snapshot();
    expect(s.upcoming).toHaveLength(4);
    expect([...titles(s.upcoming)].sort().join('')).toBe('AABC');
    expect(s.upcoming.map((i) => i.id)).not.toContain(s.current?.id);
  });

  it('round-trips each position separately through serialize/restore', () => {
    const q = new QueueEngine({ seed: 1 });
    q.setContext(withRepeats(), 1);
    const before = q.snapshot();

    const restored = new QueueEngine({ seed: 99 });
    restored.restore(q.serialize());

    expect(restored.snapshot()).toEqual(before);
    expect(allIds(restored)).toEqual(allIds(q));
  });

  it('starting mid-list leaves the earlier copies out of upcoming', () => {
    const q = new QueueEngine({ seed: 1 });
    // What `playContext(tracks, 2)` does: position 2 plays, positions 0-1 do not.
    q.setContext(withRepeats(), 2, { uri: 'audius:artist:x' });

    const s = q.snapshot();
    expect(s.current?.track.title).toBe('A');
    expect(titles(s.upcoming)).toBe('CA');
    expect(s.history).toEqual([]);
  });
});
