import { describe, expect, it } from 'vitest';
import type { Rgb } from './color';
import {
  accentVariables,
  contrastRatio,
  ensureContrast,
  hexToRgb,
  mix,
  relativeLuminance,
  rgbToHex,
  saturate,
} from './color';

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const GREY: Rgb = { r: 128, g: 128, b: 128 };

const THEMES = ['dark', 'light', 'oled'] as const;

const ACCENTS = ['#12e29a', '#ff0000', '#ffff00', '#123456', '#808080', '#000000', '#ffffff'];

const TOKENS = [
  '--c-accent',
  '--c-accent-hover',
  '--c-on-accent',
  '--c-bg',
  '--c-surface',
  '--c-surface-2',
  '--c-surface-3',
  '--c-line',
  '--c-text',
  '--c-text-dim',
  '--c-text-faint',
];

function parseTriplet(value: string): Rgb {
  const parts = value.split(' ').map(Number);
  return { r: parts[0]!, g: parts[1]!, b: parts[2]! };
}

describe('hexToRgb', () => {
  it('reads the six-digit form with or without the hash', () => {
    expect(hexToRgb('#ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(hexToRgb('ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(hexToRgb('  #FF8800  ')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('expands the three-digit form by doubling each nibble', () => {
    expect(hexToRgb('#fff')).toEqual(WHITE);
    expect(hexToRgb('#08f')).toEqual({ r: 0, g: 136, b: 255 });
    expect(hexToRgb('08f')).toEqual({ r: 0, g: 136, b: 255 });
  });

  it('ignores the alpha channel in the four- and eight-digit forms', () => {
    expect(hexToRgb('#08f8')).toEqual({ r: 0, g: 136, b: 255 });
    expect(hexToRgb('#ff880080')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('returns undefined for anything that is not a hex colour', () => {
    for (const bad of ['', '#', 'nope', '#12345', '#1234567', '#zzzzzz', 'rgb(1,2,3)', '18 226 154']) {
      expect(hexToRgb(bad)).toBeUndefined();
    }
  });
});

describe('rgbToHex', () => {
  it('round-trips every accepted hex form', () => {
    for (const hex of ['#12e29a', '#000000', '#ffffff', '#ff8800', '#123456']) {
      expect(rgbToHex(hexToRgb(hex)!)).toBe(hex);
    }
    // The short form widens to its expanded six-digit spelling.
    expect(rgbToHex(hexToRgb('#08f')!)).toBe('#0088ff');
  });

  it('clamps out-of-range channels and rounds fractional ones', () => {
    expect(rgbToHex({ r: -5, g: 300, b: 128.6 })).toBe('#00ff81');
    expect(rgbToHex({ r: Number.NaN, g: Number.NaN, b: Number.NaN })).toBe('#000000');
  });

  it('always emits a seven-character lowercase string', () => {
    for (const c of [BLACK, WHITE, GREY, { r: 1, g: 2, b: 3 }]) {
      expect(rgbToHex(c)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('relativeLuminance', () => {
  it('spans 0 for black to 1 for white', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
  });

  it('weights green above red above blue', () => {
    const red = relativeLuminance({ r: 255, g: 0, b: 0 });
    const green = relativeLuminance({ r: 0, g: 255, b: 0 });
    const blue = relativeLuminance({ r: 0, g: 0, b: 255 });
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black against white', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 10);
  });

  it('is symmetric in its arguments', () => {
    const pairs: Array<[Rgb, Rgb]> = [
      [BLACK, WHITE],
      [GREY, WHITE],
      [{ r: 18, g: 226, b: 154 }, { r: 10, g: 11, b: 13 }],
    ];
    for (const [a, b] of pairs) {
      expect(contrastRatio(a, b)).toBe(contrastRatio(b, a));
    }
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio(GREY, GREY)).toBe(1);
    expect(contrastRatio(BLACK, BLACK)).toBe(1);
  });
});

describe('ensureContrast', () => {
  it('returns the original colour untouched when it already passes', () => {
    const fg = WHITE;
    expect(ensureContrast(fg, BLACK, 4.5)).toBe(fg);
  });

  it('reaches the requested ratio against a light background', () => {
    const fg: Rgb = { r: 18, g: 226, b: 154 };
    expect(contrastRatio(fg, WHITE)).toBeLessThan(4.5);
    const fixed = ensureContrast(fg, WHITE, 4.5);
    expect(contrastRatio(fixed, WHITE)).toBeGreaterThanOrEqual(4.5);
    // Darkened, because the background is the light side.
    expect(relativeLuminance(fixed)).toBeLessThan(relativeLuminance(fg));
  });

  it('reaches the requested ratio against a dark background', () => {
    const bg: Rgb = { r: 10, g: 11, b: 13 };
    const fg: Rgb = { r: 20, g: 22, b: 26 };
    expect(contrastRatio(fg, bg)).toBeLessThan(4.5);
    const fixed = ensureContrast(fg, bg, 4.5);
    expect(contrastRatio(fixed, bg)).toBeGreaterThanOrEqual(4.5);
    expect(relativeLuminance(fixed)).toBeGreaterThan(relativeLuminance(fg));
  });

  it('honours a stricter ratio when one is reachable', () => {
    const fixed = ensureContrast({ r: 120, g: 120, b: 120 }, WHITE, 7);
    expect(contrastRatio(fixed, WHITE)).toBeGreaterThanOrEqual(7);
  });

  it('returns the extreme endpoint when the ratio is unreachable', () => {
    // Nothing clears 7:1 against mid grey; black is the best available.
    expect(contrastRatio(BLACK, GREY)).toBeLessThan(7);
    expect(ensureContrast(WHITE, GREY, 7)).toEqual(BLACK);
  });

  it('defaults to the WCAG AA body ratio', () => {
    const fixed = ensureContrast({ r: 200, g: 200, b: 200 }, WHITE);
    expect(contrastRatio(fixed, WHITE)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('mix', () => {
  const a: Rgb = { r: 0, g: 50, b: 100 };
  const b: Rgb = { r: 200, g: 150, b: 0 };

  it('returns the endpoints at t=0 and t=1', () => {
    expect(mix(a, b, 0)).toEqual(a);
    expect(mix(a, b, 1)).toEqual(b);
  });

  it('returns the midpoint at t=0.5', () => {
    expect(mix(a, b, 0.5)).toEqual({ r: 100, g: 100, b: 50 });
    expect(mix(BLACK, WHITE, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('clamps t into 0..1', () => {
    expect(mix(a, b, -1)).toEqual(a);
    expect(mix(a, b, 2)).toEqual(b);
    expect(mix(a, b, Number.NaN)).toEqual(a);
  });
});

describe('saturate', () => {
  const accent: Rgb = { r: 18, g: 226, b: 154 };

  it('is a no-op at amount 0', () => {
    expect(saturate(accent, 0)).toEqual(accent);
  });

  it('collapses to a neutral grey at amount -1', () => {
    const flat = saturate(accent, -1);
    expect(flat.r).toBe(flat.g);
    expect(flat.g).toBe(flat.b);
  });

  it('widens the channel spread on the way up and narrows it on the way down', () => {
    const spread = (c: Rgb): number => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    const washed: Rgb = { r: 120, g: 150, b: 130 };
    expect(spread(saturate(washed, 0.3))).toBeGreaterThan(spread(washed));
    expect(spread(saturate(washed, -0.3))).toBeLessThan(spread(washed));
  });

  it('clamps the resulting saturation instead of wrapping it', () => {
    expect(saturate(accent, 5)).toEqual(saturate(accent, 1));
    expect(saturate(accent, -5)).toEqual(saturate(accent, -1));
  });

  it('keeps an already-grey colour grey when desaturated further', () => {
    const flat = saturate(GREY, -0.5);
    expect(flat.r).toBe(flat.g);
    expect(flat.g).toBe(flat.b);
  });

  it('resolves the undefined hue of a grey to red when saturating it', () => {
    // An achromatic colour has no hue, so rgbToHsl reports 0 and saturating
    // pushes it towards red. Callers only ever pass real artwork colours, but
    // the behaviour is deterministic and worth pinning down.
    const vivid = saturate(GREY, 0.5);
    expect(vivid.r).toBeGreaterThan(vivid.g);
    expect(vivid.g).toBe(vivid.b);
  });
});

describe('accentVariables', () => {
  it('returns the same token set for every theme', () => {
    const sets = THEMES.map((theme) => Object.keys(accentVariables('#12e29a', theme)).sort());
    for (const keys of sets) {
      expect(keys).toEqual([...TOKENS].sort());
    }
  });

  it.each(THEMES)('emits a valid 0..255 RGB triplet for every token in the %s theme', (theme) => {
    for (const accent of ACCENTS) {
      const vars = accentVariables(accent, theme);
      for (const token of TOKENS) {
        const value = vars[token]!;
        expect(value).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
        const { r, g, b } = parseTriplet(value);
        for (const channel of [r, g, b]) {
          expect(Number.isInteger(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('passes a valid accent through verbatim', () => {
    expect(accentVariables('#ff0000', 'dark')['--c-accent']).toBe('255 0 0');
    expect(accentVariables('12e29a', 'light')['--c-accent']).toBe('18 226 154');
  });

  it('falls back to the brand green for an unparseable accent', () => {
    for (const bad of ['', 'not-a-colour', '#12345']) {
      expect(accentVariables(bad, 'dark')['--c-accent']).toBe('18 226 154');
    }
  });

  it('keeps the OLED background at true black so the panel can switch pixels off', () => {
    for (const accent of ACCENTS) {
      expect(accentVariables(accent, 'oled')['--c-bg']).toBe('0 0 0');
    }
  });

  it('tints each surface step further from the base than the one before it', () => {
    const vars = accentVariables('#ff0000', 'dark');
    const levels = ['--c-bg', '--c-surface', '--c-surface-2', '--c-surface-3'].map((token) =>
      relativeLuminance(parseTriplet(vars[token]!)),
    );
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]!).toBeGreaterThan(levels[i - 1]!);
    }
  });

  it.each(THEMES)('keeps every text token WCAG-legible on the %s background', (theme) => {
    for (const accent of ACCENTS) {
      const vars = accentVariables(accent, theme);
      const bg = parseTriplet(vars['--c-bg']!);
      expect(contrastRatio(parseTriplet(vars['--c-text']!), bg)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(parseTriplet(vars['--c-text-dim']!), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseTriplet(vars['--c-text-faint']!), bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEMES)('keeps the on-accent foreground legible on the accent in the %s theme', (theme) => {
    for (const accent of ACCENTS) {
      const vars = accentVariables(accent, theme);
      const ratio = contrastRatio(
        parseTriplet(vars['--c-on-accent']!),
        parseTriplet(vars['--c-accent']!),
      );
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('brightens the hover accent on dark themes and darkens it on light', () => {
    for (const accent of ['#12e29a', '#123456']) {
      for (const theme of ['dark', 'oled'] as const) {
        const vars = accentVariables(accent, theme);
        expect(relativeLuminance(parseTriplet(vars['--c-accent-hover']!))).toBeGreaterThan(
          relativeLuminance(parseTriplet(vars['--c-accent']!)),
        );
      }
      const light = accentVariables(accent, 'light');
      expect(relativeLuminance(parseTriplet(light['--c-accent-hover']!))).toBeLessThan(
        relativeLuminance(parseTriplet(light['--c-accent']!)),
      );
    }
  });

  it('is a pure function of accent and theme', () => {
    expect(accentVariables('#12e29a', 'dark')).toEqual(accentVariables('#12e29a', 'dark'));
    expect(accentVariables('#12e29a', 'dark')).not.toEqual(accentVariables('#12e29a', 'light'));
  });
});
