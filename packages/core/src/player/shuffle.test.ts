import { describe, expect, it } from 'vitest';
import { mulberry32, seedFrom, shuffled, shuffledSpaced } from './shuffle';

const keyOf = (s: string): string => s.split('/')[0] as string;

/** `n` keys with `per` copies each, tagged so every item is distinguishable. */
function pool(n: number, per: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < n; k++) for (let i = 0; i < per; i++) out.push(`a${k}/${i}`);
  return out;
}

function firstCollision(items: string[]): number {
  for (let i = 1; i < items.length; i++) {
    if (keyOf(items[i] as string) === keyOf(items[i - 1] as string)) return i;
  }
  return -1;
}

const sorted = (xs: string[]): string[] => [...xs].sort();

describe('mulberry32', () => {
  it('produces the same sequence for the same seed and a different one otherwise', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const c = mulberry32(12346);
    const seqA = Array.from({ length: 16 }, () => a());
    const seqB = Array.from({ length: 16 }, () => b());
    const seqC = Array.from({ length: 16 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('stays within [0, 1) over a long run', () => {
    const rand = mulberry32(0);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 20000; i++) {
      const v = rand();
      expect(Number.isFinite(v)).toBe(true);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
    // A generator stuck near one end would still satisfy the bounds above.
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.99);
  });

  it('accepts a seed of 0 without collapsing to a constant', () => {
    const rand = mulberry32(0);
    const draws = new Set(Array.from({ length: 32 }, () => rand()));
    expect(draws.size).toBe(32);
  });
});

describe('seedFrom', () => {
  it('is stable per string and separates similar strings', () => {
    expect(seedFrom('ritmo:playlist:42')).toBe(seedFrom('ritmo:playlist:42'));
    expect(seedFrom('ritmo:playlist:42')).not.toBe(seedFrom('ritmo:playlist:43'));
    expect(seedFrom('ab')).not.toBe(seedFrom('ba'));
    expect(seedFrom('')).toBe(seedFrom(''));
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const s of ['', 'a', 'audius:track:xyz', 'ünlü şarkı', 'x'.repeat(500)]) {
      const h = seedFrom(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('shuffled', () => {
  it('conserves the multiset and the length', () => {
    const items = pool(7, 3);
    for (let seed = 1; seed <= 50; seed++) {
      const out = shuffled(items, mulberry32(seed));
      expect(out).toHaveLength(items.length);
      expect(sorted(out)).toEqual(sorted(items));
    }
  });

  it('is a pure function of (items, seed)', () => {
    const items = pool(5, 4);
    expect(shuffled(items, mulberry32(99))).toEqual(shuffled(items, mulberry32(99)));
    expect(shuffled(items, mulberry32(99))).not.toEqual(shuffled(items, mulberry32(100)));
  });

  it('does not mutate its input', () => {
    const items = pool(6, 2);
    const before = [...items];
    shuffled(items, mulberry32(3));
    expect(items).toEqual(before);
  });

  it('handles empty and single-element inputs', () => {
    expect(shuffled([], mulberry32(1))).toEqual([]);
    expect(shuffled(['only'], mulberry32(1))).toEqual(['only']);
  });

  it('is not identity-biased: the first element varies across seeds', () => {
    const items = pool(10, 1);
    const heads = new Set<string>();
    let identical = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const out = shuffled(items, mulberry32(seed));
      heads.add(out[0] as string);
      if (out.join() === items.join()) identical++;
    }
    expect(heads.size).toBeGreaterThan(5);
    // 200 draws from 10! permutations: landing on the input order repeatedly
    // would mean the swap loop is skipping work.
    expect(identical).toBeLessThan(3);
  });
});

describe('shuffledSpaced', () => {
  it('conserves the multiset for every pool shape', () => {
    for (const items of [pool(1, 5), pool(2, 9), pool(6, 6), pool(20, 1), pool(3, 10)]) {
      for (let seed = 1; seed <= 25; seed++) {
        const out = shuffledSpaced(items, keyOf, 3, mulberry32(seed));
        expect(out).toHaveLength(items.length);
        expect(sorted(out)).toEqual(sorted(items));
      }
    }
  });

  it('keeps same-key items apart whenever the pool allows it', () => {
    // gap 3 needs at least 4 distinct keys to be satisfiable at all.
    for (const [n, per] of [[4, 5], [5, 6], [6, 6], [8, 3], [10, 2], [12, 4]] as const) {
      const items = pool(n, per);
      for (let seed = 1; seed <= 200; seed++) {
        const out = shuffledSpaced(items, keyOf, 3, mulberry32(seed));
        expect(firstCollision(out), `n=${n} per=${per} seed=${seed}`).toBe(-1);
      }
    }
  });

  it('honours the gap, not just adjacency, when there is room', () => {
    const items = pool(8, 4);
    for (let seed = 1; seed <= 100; seed++) {
      const out = shuffledSpaced(items, keyOf, 3, mulberry32(seed));
      const lastAt = new Map<string, number>();
      out.forEach((item, i) => {
        const k = keyOf(item);
        const prev = lastAt.get(k);
        if (prev !== undefined) expect(i - prev).toBeGreaterThan(3);
        lastAt.set(k, i);
      });
    }
  });

  it('terminates and returns every item when spacing is impossible', () => {
    const items = pool(1, 5);
    const out = shuffledSpaced(items, keyOf, 3, mulberry32(7));
    expect(out).toHaveLength(5);
    expect(sorted(out)).toEqual(sorted(items));
  });

  it('terminates on a large single-key pool', () => {
    const items = pool(1, 500);
    const out = shuffledSpaced(items, keyOf, 3, mulberry32(7));
    expect(sorted(out)).toEqual(sorted(items));
  });

  it('keeps same-key items apart on a lopsided but feasible pool', () => {
    // A real playlist: a few artists with several tracks, plus a long tail of
    // one-offs. The heavy keys must not be left over for the final slots.
    const items = [...pool(3, 4), ...['b0/0', 'b1/0', 'b2/0', 'b3/0', 'b4/0', 'b5/0', 'b6/0', 'b7/0', 'b8/0']];
    for (let seed = 1; seed <= 200; seed++) {
      const out = shuffledSpaced(items, keyOf, 3, mulberry32(seed));
      expect(sorted(out)).toEqual(sorted(items));
      expect(firstCollision(out), `seed=${seed}`).toBe(-1);
    }
  });

  it('returns every item when one key dominates the pool', () => {
    const items = [...pool(1, 20), 'b0/0', 'b1/0', 'b2/0', 'b3/0'];
    const out = shuffledSpaced(items, keyOf, 3, mulberry32(11));
    expect(sorted(out)).toEqual(sorted(items));
    // The gap rule forbids the dominant key in the three slots after its own
    // first appearance, so the separators must land early rather than at the end.
    const rareAt = out.map((x, i) => [x, i] as const).filter(([x]) => keyOf(x) !== 'a0').map(([, i]) => i);
    expect(rareAt).toHaveLength(4);
    expect(Math.min(...rareAt)).toBeLessThanOrEqual(3);
  });

  it('skips relaxation for a non-positive gap or a pool below three items', () => {
    const items = pool(3, 4);
    expect(shuffledSpaced(items, keyOf, 0, mulberry32(5))).toEqual(shuffled(items, mulberry32(5)));
    expect(shuffledSpaced(items, keyOf, -1, mulberry32(5))).toEqual(shuffled(items, mulberry32(5)));
    const two = ['a0/0', 'a0/1'];
    expect(shuffledSpaced(two, keyOf, 3, mulberry32(5))).toEqual(shuffled(two, mulberry32(5)));
  });

  it('is deterministic per seed yet varies across seeds', () => {
    const items = pool(6, 4);
    expect(shuffledSpaced(items, keyOf, 3, mulberry32(21)))
      .toEqual(shuffledSpaced(items, keyOf, 3, mulberry32(21)));
    const heads = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      heads.add(shuffledSpaced(items, keyOf, 3, mulberry32(seed))[0] as string);
    }
    expect(heads.size).toBeGreaterThan(5);
  });

  it('does not mutate its input', () => {
    const items = pool(5, 3);
    const before = [...items];
    shuffledSpaced(items, keyOf, 3, mulberry32(4));
    expect(items).toEqual(before);
  });
});
