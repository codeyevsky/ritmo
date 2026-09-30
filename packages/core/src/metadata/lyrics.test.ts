import { describe, expect, it } from 'vitest';
import type { LyricLine } from '../types';
import { activeLyricIndex, parseLrc } from './lyrics';

function atMs(lines: LyricLine[]): number[] {
  return lines.map((l) => l.atMs);
}

describe('parseLrc timestamps', () => {
  it('reads a two-digit fraction as centiseconds', () => {
    const lines = parseLrc('[00:12.34]hello');
    expect(lines).toEqual([{ atMs: 12340, text: 'hello' }]);
  });

  it('reads a three-digit fraction as milliseconds', () => {
    expect(parseLrc('[00:12.345]hello')).toEqual([{ atMs: 12345, text: 'hello' }]);
  });

  it('reads a one-digit fraction as tenths', () => {
    expect(parseLrc('[00:12.3]hello')).toEqual([{ atMs: 12300, text: 'hello' }]);
  });

  it('accepts a bare mm:ss stamp', () => {
    expect(parseLrc('[01:02]hello')).toEqual([{ atMs: 62000, text: 'hello' }]);
  });

  it('accepts a colon as the fraction separator', () => {
    expect(parseLrc('[01:02:50]hello')).toEqual([{ atMs: 62500, text: 'hello' }]);
  });

  it('accepts minute counts past 99', () => {
    expect(atMs(parseLrc('[101:05.00]late'))).toEqual([101 * 60000 + 5000]);
  });
});

describe('parseLrc line shape', () => {
  it('repeats the text once per timestamp sharing the line', () => {
    const lines = parseLrc('[00:10.00][00:20.00][01:00.00]chorus');
    expect(lines).toEqual([
      { atMs: 10000, text: 'chorus' },
      { atMs: 20000, text: 'chorus' },
      { atMs: 60000, text: 'chorus' },
    ]);
  });

  it('drops metadata tags instead of emitting them as lines', () => {
    const lines = parseLrc(
      ['[ar:Sezen Aksu]', '[ti:Sarki]', '[al:Album]', '[by:someone]', '[00:05.00]first'].join('\n'),
    );
    expect(lines).toEqual([{ atMs: 5000, text: 'first' }]);
  });

  it('strips enhanced-LRC per-word timings from the text', () => {
    const lines = parseLrc('[00:05.00]<00:05.00>one <00:05.50>two');
    expect(lines).toEqual([{ atMs: 5000, text: 'one two' }]);
  });

  it('keeps a timestamped line with no text as an empty-text gap', () => {
    expect(parseLrc('[00:05.00]\n[00:07.00]word')).toEqual([
      { atMs: 5000, text: '' },
      { atMs: 7000, text: 'word' },
    ]);
  });

  it('ignores blank lines', () => {
    const lines = parseLrc('[00:01.00]a\n\n   \n[00:02.00]b\n');
    expect(lines).toEqual([
      { atMs: 1000, text: 'a' },
      { atMs: 2000, text: 'b' },
    ]);
  });

  it('parses CRLF input the same as LF input', () => {
    const body = '[ti:X]\r\n[00:01.00]a\r\n[00:02.00]b\r\n';
    expect(parseLrc(body)).toEqual(parseLrc(body.replace(/\r/g, '')));
  });

  it('returns nothing for a body with no timestamps', () => {
    expect(parseLrc('just some plain lyrics\nacross two lines')).toEqual([]);
  });

  it('returns nothing for an empty body', () => {
    expect(parseLrc('')).toEqual([]);
  });
});

describe('parseLrc offset', () => {
  it('pulls every timestamp earlier for a positive offset', () => {
    const lines = parseLrc('[offset:+500]\n[00:10.00]a\n[00:20.00]b');
    expect(atMs(lines)).toEqual([9500, 19500]);
  });

  it('pushes every timestamp later for a negative offset', () => {
    expect(atMs(parseLrc('[offset:-500]\n[00:10.00]a'))).toEqual([10500]);
  });

  it('clamps a timestamp the offset would push below zero', () => {
    expect(atMs(parseLrc('[offset:+2000]\n[00:01.00]a\n[00:10.00]b'))).toEqual([0, 8000]);
  });

  it('applies the offset even when the tag comes after the lines', () => {
    expect(atMs(parseLrc('[00:10.00]a\n[offset:+500]'))).toEqual([9500]);
  });

  it('ignores a non-numeric offset', () => {
    expect(atMs(parseLrc('[offset:soon]\n[00:10.00]a'))).toEqual([10000]);
  });
});

describe('parseLrc ordering', () => {
  it('sorts ascending when the input is out of order', () => {
    const lines = parseLrc('[00:30.00]c\n[00:10.00]a\n[00:20.00]b');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    expect(atMs(lines)).toEqual([10000, 20000, 30000]);
  });

  it('keeps file order between two lines sharing a timestamp', () => {
    const lines = parseLrc('[00:10.00]first\n[00:10.00]second');
    expect(lines.map((l) => l.text)).toEqual(['first', 'second']);
  });

  it('sorts stamps that the offset reordered relative to the file', () => {
    // The offset is global, so relative order cannot change — but clamping at 0 can tie.
    const lines = parseLrc('[offset:+5000]\n[00:02.00]a\n[00:01.00]b');
    expect(atMs(lines)).toEqual([0, 0]);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });
});

describe('activeLyricIndex', () => {
  const lines: LyricLine[] = [
    { atMs: 1000, text: 'a' },
    { atMs: 2000, text: 'b' },
    { atMs: 3000, text: 'c' },
  ];

  it('returns -1 before the first line', () => {
    expect(activeLyricIndex(lines, 0)).toBe(-1);
    expect(activeLyricIndex(lines, 999)).toBe(-1);
  });

  it('holds the last line for any position past it', () => {
    expect(activeLyricIndex(lines, 3000)).toBe(2);
    expect(activeLyricIndex(lines, 10_000_000)).toBe(2);
  });

  it('activates a line exactly at its own timestamp', () => {
    expect(activeLyricIndex(lines, 1000)).toBe(0);
    expect(activeLyricIndex(lines, 2000)).toBe(1);
  });

  it('keeps the previous line one millisecond before the boundary', () => {
    expect(activeLyricIndex(lines, 1999)).toBe(0);
  });

  it('returns -1 for an empty array', () => {
    expect(activeLyricIndex([], 0)).toBe(-1);
    expect(activeLyricIndex([], 5000)).toBe(-1);
  });

  it('returns the last of several lines sharing one timestamp', () => {
    const tied: LyricLine[] = [
      { atMs: 0, text: 'x' },
      { atMs: 1000, text: 'a' },
      { atMs: 1000, text: 'b' },
      { atMs: 2000, text: 'c' },
    ];
    expect(activeLyricIndex(tied, 1000)).toBe(2);
  });

  it('agrees with a linear scan across a 2000-line file', () => {
    const many: LyricLine[] = Array.from({ length: 2000 }, (_, i) => ({
      atMs: i * 137,
      text: `line ${i}`,
    }));
    const naive = (positionMs: number): number => {
      let found = -1;
      for (let i = 0; i < many.length; i += 1) {
        const line = many[i]!;
        if (line.atMs <= positionMs) found = i;
      }
      return found;
    };

    const last = many[many.length - 1]!.atMs;
    const probes: number[] = [-1, 0, last, last + 1];
    for (let n = 0; n < 46; n += 1) {
      // Deterministic spread that lands on, just before and just after boundaries.
      const at = Math.trunc((n * (last + 200)) / 46);
      probes.push(at, at - 1, at + 1);
    }

    for (const at of probes) {
      expect(activeLyricIndex(many, at)).toBe(naive(at));
    }
  });
});
