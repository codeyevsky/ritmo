/**
 * Shuffle model.
 *
 * Every random decision the queue makes goes through a seeded PRNG, so a
 * shuffled order is a pure function of `(items, seed)`. That is what lets the
 * persisted queue come back after a restart without silently reordering, and
 * what makes the queue unit-testable.
 */

/** Deterministic PRNG so a shuffle can be reproduced from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over UTF-16 code units — stable across platforms and JS engines. */
export function seedFrom(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function swap<T>(arr: T[], i: number, j: number): void {
  const a = arr[i] as T;
  const b = arr[j] as T;
  arr[i] = b;
  arr[j] = a;
}

export function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    if (j !== i) swap(out, i, j);
  }
  return out;
}

/**
 * How far ahead the relaxation pass is willing to look for a non-colliding
 * candidate. Bounding it keeps the pass linear on huge playlists; the only cost
 * of giving up early is one under-spaced neighbour pair.
 */
const MAX_SCAN = 64;

/** Fisher–Yates, then relax so no two adjacent items share a key, when possible. */
export function shuffledSpaced<T>(
  items: T[],
  keyOf: (t: T) => string,
  gap: number,
  rand: () => number,
): T[] {
  const pool = shuffled(items, rand);
  if (gap <= 0 || pool.length < 3) return pool;

  const keys = pool.map((item) => keyOf(item));
  const left = new Map<string, number>();
  for (const key of keys) left.set(key, (left.get(key) ?? 0) + 1);
  const taken = new Array<boolean>(pool.length).fill(false);
  const lastAt = new Map<string, number>();
  const out: T[] = [];
  let cursor = 0;

  while (out.length < pool.length) {
    while (cursor < pool.length && taken[cursor] === true) cursor++;
    let pick = -1;
    let pickLeft = -1;
    let scanned = 0;
    for (let i = cursor; i < pool.length && scanned < MAX_SCAN; i++) {
      if (taken[i] === true) continue;
      scanned++;
      const key = keys[i] as string;
      const at = lastAt.get(key);
      // `gap` counts the items that must sit *between* two same-key entries.
      if (at !== undefined && out.length - at <= gap) continue;
      // Of the eligible candidates, take the one whose key has the most copies
      // still unplaced. Taking the first eligible one instead drains the rare
      // keys early and leaves the last few slots holding nothing but copies of
      // one key — a collision the pool could have avoided. Ties keep pool
      // order, so the shuffle stays as random as the spacing allows.
      const remaining = left.get(key) ?? 0;
      if (remaining > pickLeft) {
        pick = i;
        pickLeft = remaining;
      }
    }
    if (pick < 0) pick = cursor;

    const picked = keys[pick] as string;
    taken[pick] = true;
    left.set(picked, (left.get(picked) ?? 1) - 1);
    lastAt.set(picked, out.length);
    out.push(pool[pick] as T);
  }

  return out;
}
