/**
 * String handling shared by search, dedupe and the library UI.
 *
 * {@link normalizeKey} is a wire contract: the Rust scanner fills the `*_key`
 * columns with `library::tags::normalize_key` and TypeScript queries them with
 * this function, so the two must agree character for character. The agreed
 * algorithm is: lowercase, canonical decomposition (NFD), drop the combining
 * marks in U+0300..U+036F and U+3099..U+309A, fold the dotless `\u0131` onto
 * `i`, drop everything that is not alphanumeric and collapse whitespace.
 */

/** Marks a canonical decomposition exposes; everything else non-alphanumeric
 *  is dropped by the alphanumeric filter anyway. */
const STRIPPED_MARK = /[\u0300-\u036f\u3099\u309a]/u;
const WHITESPACE = /\p{White_Space}/u;
const ALNUM = /[\p{Alphabetic}\p{N}]/u;

/**
 * Lowercase + decompose one character, dropping the marks. `\u0131` is handled
 * by hand because it has no canonical decomposition, while `\u0130` needs none:
 * lowercasing widens it to `i` + U+0307 and the dot is a stripped mark.
 */
function fold(ch: string): string {
  let out = '';
  for (const part of ch.toLowerCase().normalize('NFD')) {
    if (STRIPPED_MARK.test(part)) continue;
    out += part === '\u0131' ? 'i' : part;
  }
  return out;
}

/**
 * Search-normalised form: lowercase, combining marks dropped, Turkish letters
 * folded onto ASCII (İ I ı → i, ş → s, ğ → g, ü → u, ö → o, ç → c), every
 * non-alphanumeric character removed and whitespace collapsed to single spaces.
 *
 * Punctuation is *removed* rather than turned into a gap, so `"AC/DC"` becomes
 * `"acdc"` — the Rust scanner does the same.
 */
export function normalizeKey(s: string): string {
  let out = '';
  let gap = false;
  for (const raw of fold(s)) {
    if (WHITESPACE.test(raw)) {
      gap = out.length > 0;
      continue;
    }
    if (!ALNUM.test(raw)) continue;
    if (gap) {
      out += ' ';
      gap = false;
    }
    out += raw;
  }
  return out;
}

export function tokenize(s: string): string[] {
  const normalized = normalizeKey(s);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/** Dice coefficient over character bigrams, 0..1. */
function bigramRatio(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i + 1 < a.length; i += 1) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  let total = 0;
  for (let i = 0; i + 1 < b.length; i += 1) {
    total += 1;
    const g = b.slice(i, i + 2);
    const left = grams.get(g);
    if (left !== undefined && left > 0) {
      grams.set(g, left - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (a.length - 1 + total);
}

/**
 * Token-set ratio in 0..1. The shared tokens are compared against both full
 * strings, so full containment scores 1 — which is what cross-provider dedupe
 * needs, since the same recording arrives as `"Thunderstruck"` from one
 * provider and `"AC/DC - Thunderstruck"` from the next.
 */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const setA = new Set(ta);
  const setB = new Set(tb);
  const shared: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const t of setA) (setB.has(t) ? shared : onlyA).push(t);
  for (const t of setB) if (!setA.has(t)) onlyB.push(t);

  shared.sort();
  onlyA.sort();
  onlyB.sort();
  const base = shared.join(' ');
  const fullA = [...shared, ...onlyA].join(' ');
  const fullB = [...shared, ...onlyB].join(' ');

  return Math.max(bigramRatio(base, fullA), bigramRatio(base, fullB), bigramRatio(fullA, fullB));
}

const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on',
  'onto', 'or', 'the', 'to', 'vs', 'with',
  've', 'ile', 'ya', 'da', 'de', 'ki',
]);

const WORD_BREAK = /([^\p{Alphabetic}\p{N}'’]+)/u;

function capitalizeWord(word: string, isFirst: boolean): string {
  // Acronyms and stylised spellings stay untouched: DJ, EP, AC, DC, MF DOOM.
  if (word.length <= 5 && /\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word)) return word;
  const lower = word.toLowerCase();
  if (!isFirst && SMALL_WORDS.has(lower)) return lower;
  const head = [...lower][0];
  if (head === undefined) return lower;
  return head.toUpperCase() + lower.slice(head.length);
}

export function titleCase(s: string): string {
  const parts = s.split(WORD_BREAK);
  let wordIndex = 0;
  return parts
    .map((part) => {
      if (part.length === 0 || !ALNUM.test(part)) return part;
      const isFirst = wordIndex === 0;
      wordIndex += 1;
      return capitalizeWord(part, isFirst);
    })
    .join('');
}

const ARTIST_SEPARATORS = /[\u0000;]/u;

/**
 * Splits a credited-artist string into names. Only `;`, NUL and a
 * whitespace-padded slash separate, so `"AC/DC"` stays one artist and a
 * `"feat."` credit stays attached — matching `split_names` in the Rust scanner.
 */
export function splitArtists(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(ARTIST_SEPARATORS)) {
    for (const piece of part.split(' / ')) {
      const name = piece.trim();
      if (name.length > 0) out.push(name);
    }
  }
  return out;
}

interface FoldedIndex {
  text: string;
  /** Source offset the folded code *unit* at this index came from. */
  start: number[];
  /** Source offset just past the character the folded code unit came from. */
  end: number[];
}

/**
 * `start`/`end` are indexed by UTF-16 code unit of `text`, not by code point,
 * because `String.prototype.indexOf` reports code-unit offsets: one entry per
 * code point would shift every mapping after the first astral character (an
 * emoji in a title) and lose the range entirely.
 */
function foldWithIndex(s: string): FoldedIndex {
  let text = '';
  const start: number[] = [];
  const end: number[] = [];
  let offset = 0;
  for (const ch of s) {
    for (const out of fold(ch)) {
      text += out;
      for (let unit = 0; unit < out.length; unit += 1) {
        start.push(offset);
        end.push(offset + ch.length);
      }
    }
    offset += ch.length;
  }
  return { text, start, end };
}

function findAll(hay: FoldedIndex, needle: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = hay.text.indexOf(needle, from);
    if (at < 0) break;
    const lo = hay.start[at];
    const hi = hay.end[at + needle.length - 1];
    if (lo !== undefined && hi !== undefined) ranges.push([lo, hi]);
    from = at + needle.length;
  }
  return ranges;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
      continue;
    }
    out.push([range[0], range[1]]);
  }
  return out;
}

/**
 * Half-open `[start, end)` index pairs into `haystack` itself (never into a
 * folded copy) that match `needle` ignoring case and diacritics. Falls back to
 * per-token matching when the phrase is absent, so `"rós sigur"` still
 * highlights both words of "Sigur Rós".
 */
export function matchRanges(haystack: string, needle: string): Array<[number, number]> {
  const wanted = foldWithIndex(needle).text.trim();
  if (wanted.length === 0 || haystack.length === 0) return [];
  const hay = foldWithIndex(haystack);

  const phrase = findAll(hay, wanted);
  if (phrase.length > 0) return mergeRanges(phrase);

  const tokens = wanted.split(/\s+/u).filter((t) => t.length > 0);
  if (tokens.length < 2) return [];
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) ranges.push(...findAll(hay, token));
  return mergeRanges(ranges);
}

const COLLATOR = new Intl.Collator(['tr', 'en'], { numeric: true, sensitivity: 'base' });

/** Locale-aware compare with embedded numbers ordered numerically ("Track 2" < "Track 10"). */
export function naturalCompare(a: string, b: string): number {
  const primary = COLLATOR.compare(a, b);
  if (primary !== 0) return primary;
  // Deterministic tiebreak so case-only differences keep a stable order.
  return a === b ? 0 : a < b ? -1 : 1;
}

export function initials(name: string): string {
  const words = name.split(/[^\p{Alphabetic}\p{N}]+/u).filter((w) => w.length > 0);
  let out = '';
  for (const word of words) {
    const head = [...word][0];
    if (head === undefined) continue;
    out += head.toUpperCase();
    if (out.length >= 2) break;
  }
  return out.length > 0 ? out : '?';
}

/** Escapes the Lucene query syntax the Archive.org advancedsearch API speaks. */
export function escapeLucene(s: string): string {
  return s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (c) => `\\${c}`);
}

const FEAT_BRACKETED = /\s*[([{]\s*(?:feat|ft|featuring|with)\b\.?\s*[^)\]}]*[)\]}]/gi;
const FEAT_DASHED = /\s+[-–—]\s+(?:feat|ft|featuring)\b\.?\s+.*$/i;
const FEAT_TRAILING = /\s+(?:feat|ft|featuring)\b\.?\s+.*$/i;

/** `"Song (feat. X)"` / `"Song - feat. X"` / `"Song feat. X"` → `"Song"`. */
export function stripFeat(title: string): string {
  const stripped = title
    .replace(FEAT_BRACKETED, '')
    .replace(FEAT_DASHED, '')
    .replace(FEAT_TRAILING, '');
  const cleaned = stripped.replace(/\s{2,}/g, ' ').trim();
  // A title that is *only* a credit ("feat. X") must not collapse to nothing.
  return cleaned.length > 0 ? cleaned : title.trim();
}
