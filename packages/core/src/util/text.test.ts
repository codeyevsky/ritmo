import { describe, expect, it } from 'vitest';
import {
  escapeLucene,
  initials,
  matchRanges,
  naturalCompare,
  normalizeKey,
  similarity,
  splitArtists,
  stripFeat,
  titleCase,
  tokenize,
} from './text';

/**
 * Verified against `library::tags::normalize_key` in
 * apps/desktop/src-tauri/src/library/tags.rs. The scanner writes the `*_key`
 * columns with that function and TypeScript queries them with this one, so a
 * change on either side that breaks a row here breaks library lookup.
 */
const GOLDEN: Array<[string, string]> = [
  ['İstanbul', 'istanbul'],
  ['ISSIZ', 'issiz'],
  ['Işık', 'isik'],
  ['ışık', 'isik'],
  ['Şarkı Söyle', 'sarki soyle'],
  ['Ğğ Üü Öö Çç', 'gg uu oo cc'],
  ['AC/DC', 'acdc'],
  ['Björk', 'bjork'],
  ['Mötley Crüe', 'motley crue'],
  ['The Beatles - Let It Be (Remastered)', 'the beatles let it be remastered'],
  ['  çok    boşluk  ', 'cok bosluk'],
  ['Tarkan – Şımarık', 'tarkan simarik'],
  ['ÅÄÖ', 'aao'],
  ['日本語', '日本語'],
];

describe('normalizeKey', () => {
  it.each(GOLDEN)('matches the Rust scanner for %j', (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });

  it('leaves ß alone, because it has no canonical decomposition on either side', () => {
    expect(normalizeKey('straße')).toBe('straße');
    expect(normalizeKey('STRASSE')).toBe('strasse');
    // Explicitly NOT equal: fixing only one implementation would silently
    // orphan every row the scanner already wrote.
    expect(normalizeKey('straße')).not.toBe(normalizeKey('strasse'));
  });

  it.each(GOLDEN)('is idempotent for %j', (input) => {
    const once = normalizeKey(input);
    expect(normalizeKey(once)).toBe(once);
  });

  it('is idempotent for inputs that already look normalised', () => {
    for (const s of ['', 'a', 'a b', '日本語', 'straße', 'acdc 2']) {
      expect(normalizeKey(normalizeKey(s))).toBe(normalizeKey(s));
    }
  });

  it('returns the empty string for input with nothing alphanumeric in it', () => {
    expect(normalizeKey('')).toBe('');
    expect(normalizeKey('   ')).toBe('');
    expect(normalizeKey('\t\n ')).toBe('');
    expect(normalizeKey('--- ... ///')).toBe('');
  });

  it('never emits a leading, trailing or doubled space', () => {
    for (const [input] of GOLDEN) {
      const key = normalizeKey(input);
      expect(key).toBe(key.trim());
      expect(key).not.toMatch(/ {2}/);
    }
    expect(normalizeKey(' - a - - b - ')).toBe('a b');
  });

  it('collides strings that differ only in case, diacritics or punctuation', () => {
    expect(normalizeKey('SEZEN AKSU')).toBe(normalizeKey('Sezen Aksu'));
    expect(normalizeKey('Sigur Rós')).toBe(normalizeKey('Sigur Ros'));
    expect(normalizeKey("Don't Stop")).toBe(normalizeKey('Dont Stop'));
    expect(normalizeKey('A.C.D.C.')).toBe(normalizeKey('ACDC'));
    expect(normalizeKey('Işık')).toBe(normalizeKey('ışık'));
  });

  it('drops punctuation instead of turning it into a word gap', () => {
    // Documented consequence of matching the scanner: "AC/DC" has to survive
    // as one token, so a hyphen cannot become a space either.
    expect(normalizeKey('Wu-Tang')).toBe('wutang');
    expect(normalizeKey('Wu-Tang')).not.toBe(normalizeKey('Wu Tang'));
  });
});

describe('tokenize', () => {
  it('splits on the normalised word gaps', () => {
    expect(tokenize('Şarkı Söyle')).toEqual(['sarki', 'soyle']);
    expect(tokenize('The Beatles - Let It Be')).toEqual(['the', 'beatles', 'let', 'it', 'be']);
  });

  it('keeps a slash-joined name as a single token', () => {
    expect(tokenize('AC/DC')).toEqual(['acdc']);
  });

  it('yields no tokens rather than one empty token for blank input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('!!!')).toEqual([]);
  });
});

describe('similarity', () => {
  it('scores identical strings 1 regardless of case and diacritics', () => {
    expect(similarity('Mötley Crüe', 'Mötley Crüe')).toBe(1);
    expect(similarity('Mötley Crüe', 'motley crue')).toBe(1);
  });

  it('scores strings with nothing in common 0', () => {
    expect(similarity('Metallica', 'Björk')).toBe(0);
  });

  it('scores 0 when either side has no tokens', () => {
    expect(similarity('', 'Björk')).toBe(0);
    expect(similarity('Björk', '   ')).toBe(0);
    expect(similarity('', '')).toBe(0);
  });

  it('ignores token order', () => {
    expect(similarity('Sigur Rós', 'Rós Sigur')).toBe(1);
    expect(similarity('let it be', 'be it let')).toBe(similarity('let it be', 'let it be'));
  });

  it('is symmetric', () => {
    const pairs: Array<readonly [string, string]> = [
      ['Thunderstruck', 'AC/DC - Thunderstruck'],
      ['Thunderstruck', 'Thunderstuck'],
      ['Şarkı Söyle', 'sarki'],
      ['Metallica', 'Björk'],
    ];
    for (const [a, b] of pairs) {
      expect(similarity(a, b)).toBe(similarity(b, a));
    }
  });

  it('scores full token containment 1, so cross-provider dedupe matches', () => {
    expect(similarity('Thunderstruck', 'AC/DC - Thunderstruck')).toBe(1);
  });

  it('scores a near miss strictly between 0 and 1', () => {
    const score = similarity('Thunderstruck', 'Thunderstuck');
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(1);
  });
});

describe('matchRanges', () => {
  const slice = (haystack: string, ranges: Array<[number, number]>): string[] =>
    ranges.map(([lo, hi]) => haystack.slice(lo, hi));

  it('indexes the original string, not the folded copy', () => {
    const hay = 'Sigur Rós';
    expect(matchRanges(hay, 'ros')).toEqual([[6, 9]]);
    expect(slice(hay, matchRanges(hay, 'ros'))).toEqual(['Rós']);
  });

  it('ignores case and diacritics in both directions', () => {
    expect(slice('Mötley Crüe', matchRanges('Mötley Crüe', 'MOTLEY'))).toEqual(['Mötley']);
    expect(slice('Motley Crue', matchRanges('Motley Crue', 'möt'))).toEqual(['Mot']);
    expect(slice('İstanbul', matchRanges('İstanbul', 'ist'))).toEqual(['İst']);
  });

  it('keeps ranges aligned past an astral character', () => {
    const hay = '\u{1F3B5} Şarkı';
    expect(matchRanges(hay, 'sarki')).toEqual([[3, 8]]);
    expect(slice(hay, matchRanges(hay, 'sarki'))).toEqual(['Şarkı']);
  });

  it('returns ascending, non-overlapping ranges', () => {
    const ranges = matchRanges('abab ab', 'ab');
    expect(ranges).toEqual([
      [0, 4],
      [5, 7],
    ]);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]![0]).toBeGreaterThan(ranges[i - 1]![1]);
    }
  });

  it('falls back to per-token matching when the phrase is absent', () => {
    const hay = 'Sigur Rós';
    expect(matchRanges(hay, 'rós sigur')).toEqual([
      [0, 5],
      [6, 9],
    ]);
    expect(slice(hay, matchRanges(hay, 'rós sigur'))).toEqual(['Sigur', 'Rós']);
  });

  it('returns nothing for a single absent token or blank input', () => {
    expect(matchRanges('Sigur Rós', 'zz')).toEqual([]);
    expect(matchRanges('Sigur Rós', '')).toEqual([]);
    expect(matchRanges('Sigur Rós', '   ')).toEqual([]);
    expect(matchRanges('', 'ros')).toEqual([]);
  });

  it('matches only the tokens it can find in the fallback path', () => {
    const hay = 'Sigur Rós';
    expect(slice(hay, matchRanges(hay, 'sigur zzz'))).toEqual(['Sigur']);
  });
});

describe('naturalCompare', () => {
  it('orders embedded numbers numerically', () => {
    expect(naturalCompare('track2', 'track10')).toBeLessThan(0);
    expect(naturalCompare('Track 10', 'Track 9')).toBeGreaterThan(0);
    expect(['Track 10', 'Track 2', 'Track 1'].sort(naturalCompare)).toEqual([
      'Track 1',
      'Track 2',
      'Track 10',
    ]);
  });

  it('uses Turkish collation rather than code-point order', () => {
    // 'ş' (U+015F) sorts after 's' and before 't' in Turkish; a code-point
    // compare would put it after 't'.
    expect(naturalCompare('şarkı', 'tarkan')).toBeLessThan(0);
    expect(naturalCompare('çay', 'dağ')).toBeLessThan(0);
  });

  it('returns 0 only for equal strings and stays antisymmetric otherwise', () => {
    expect(naturalCompare('abc', 'abc')).toBe(0);
    expect(naturalCompare('abc', 'ABC')).not.toBe(0);
    expect(naturalCompare('abc', 'ABC')).toBe(-naturalCompare('ABC', 'abc'));
  });

  it('sorts case-only variants into a stable order', () => {
    const sorted = ['b', 'B', 'a', 'A'].sort(naturalCompare);
    expect(sorted).toEqual(['A', 'a', 'B', 'b']);
    expect([...sorted].reverse().sort(naturalCompare)).toEqual(sorted);
  });
});

describe('titleCase', () => {
  it('lowercases small words except in first position', () => {
    expect(titleCase('the dark side of the moon')).toBe('The Dark Side of the Moon');
    expect(titleCase('the')).toBe('The');
    expect(titleCase('of mice and men')).toBe('Of Mice and Men');
  });

  it('lowercases Turkish small words too', () => {
    expect(titleCase('aşk ve gurur')).toBe('Aşk ve Gurur');
  });

  it('leaves short all-caps words alone', () => {
    expect(titleCase('AC/DC')).toBe('AC/DC');
    expect(titleCase('MF DOOM')).toBe('MF DOOM');
  });

  it('treats an apostrophe as part of the word', () => {
    expect(titleCase("don't stop")).toBe("Don't Stop");
  });

  it('gives first-word status to the first real word, not to the punctuation', () => {
    expect(titleCase('(the wall)')).toBe('(The Wall)');
  });

  it('uppercases the dotless i to ASCII I, matching the default locale', () => {
    expect(titleCase('ışık')).toBe('Işık');
  });

  it('passes blank input through unchanged', () => {
    expect(titleCase('')).toBe('');
    expect(titleCase('   ')).toBe('   ');
  });
});

describe('splitArtists', () => {
  it('splits on semicolons and NUL', () => {
    expect(splitArtists('A; B')).toEqual(['A', 'B']);
    expect(splitArtists('A B')).toEqual(['A', 'B']);
  });

  it('splits on a whitespace-padded slash only', () => {
    expect(splitArtists('A / B')).toEqual(['A', 'B']);
    expect(splitArtists('AC/DC')).toEqual(['AC/DC']);
    expect(splitArtists('AC/DC / Metallica')).toEqual(['AC/DC', 'Metallica']);
  });

  it('keeps a feat. credit attached to the name', () => {
    expect(splitArtists('A feat. B')).toEqual(['A feat. B']);
    expect(splitArtists('Tarkan ft. Sezen')).toEqual(['Tarkan ft. Sezen']);
  });

  it('trims each name and drops the empty ones', () => {
    expect(splitArtists('  A ;  B  ')).toEqual(['A', 'B']);
    expect(splitArtists('')).toEqual([]);
    expect(splitArtists('; ;')).toEqual([]);
    expect(splitArtists('A;;B')).toEqual(['A', 'B']);
  });

  it('applies both separators in one pass', () => {
    expect(splitArtists('A;B / C')).toEqual(['A', 'B', 'C']);
  });
});

describe('initials', () => {
  it('takes at most the first two word heads', () => {
    expect(initials('The Beatles')).toBe('TB');
    expect(initials('a b c d')).toBe('AB');
    expect(initials('Madonna')).toBe('M');
  });

  it('uppercases non-ASCII heads', () => {
    expect(initials('Şebnem Ferah')).toBe('ŞF');
    expect(initials('ışık kaya')).toBe('IK');
  });

  it('falls back to ? when there is no word at all', () => {
    expect(initials('')).toBe('?');
    expect(initials('!!!')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

describe('stripFeat', () => {
  it('removes a bracketed credit in every bracket style', () => {
    expect(stripFeat('Song (feat. X)')).toBe('Song');
    expect(stripFeat('Song [ft. X]')).toBe('Song');
    expect(stripFeat('Song {featuring X}')).toBe('Song');
    expect(stripFeat('Song (with X)')).toBe('Song');
    expect(stripFeat('Song (ft X)')).toBe('Song');
  });

  it('removes a dashed or trailing credit', () => {
    expect(stripFeat('Song - feat. X')).toBe('Song');
    expect(stripFeat('Song – ft. Y')).toBe('Song');
    expect(stripFeat('Song feat. X')).toBe('Song');
    expect(stripFeat('Song featuring X and Y')).toBe('Song');
  });

  it('keeps other parentheticals and collapses the leftover whitespace', () => {
    expect(stripFeat('Song (Remastered)')).toBe('Song (Remastered)');
    expect(stripFeat('Song (feat. X) (Live)')).toBe('Song (Live)');
    expect(stripFeat('Song   (feat. X)   Live')).toBe('Song Live');
  });

  it('does not strip a word that merely starts with feat', () => {
    expect(stripFeat('Song Featherweight')).toBe('Song Featherweight');
    expect(stripFeat('Song Feature')).toBe('Song Feature');
  });

  it('never collapses a title that is only a credit', () => {
    expect(stripFeat('(feat. X)')).toBe('(feat. X)');
    expect(stripFeat('  (feat. X)  ')).toBe('(feat. X)');
    expect(stripFeat('feat. X')).toBe('feat. X');
  });
});

describe('escapeLucene', () => {
  const SPECIALS = [
    '+', '-', '&', '|', '!', '(', ')', '{', '}', '[', ']', '^', '"', '~', '*', '?', ':', '\\', '/',
  ];

  it.each(SPECIALS)('escapes %j', (c) => {
    expect(escapeLucene(c)).toBe(`\\${c}`);
  });

  it('escapes every special in a realistic query', () => {
    expect(escapeLucene('AC/DC')).toBe('AC\\/DC');
    expect(escapeLucene('title:(Şarkı)')).toBe('title\\:\\(Şarkı\\)');
  });

  it('leaves ordinary text, spaces and dots untouched', () => {
    expect(escapeLucene('Björk 2024')).toBe('Björk 2024');
    expect(escapeLucene('')).toBe('');
  });
});
