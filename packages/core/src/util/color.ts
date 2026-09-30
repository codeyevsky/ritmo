/**
 * Colour maths for the dynamic accent: artwork in, WCAG-safe theme tokens out.
 *
 * `dominantColor` is the only DOM-dependent function in `@ritmo/core`; it is
 * feature-detected and resolves `undefined` wherever there is no document, so
 * the module still imports cleanly under Node and in the Capacitor bridge.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function clamp255(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function hexToRgb(hex: string): Rgb | undefined {
  const raw = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(raw)) return undefined;
  if (raw.length === 3 || raw.length === 4) {
    const r = raw[0];
    const g = raw[1];
    const b = raw[2];
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return {
      r: Number.parseInt(`${r}${r}`, 16),
      g: Number.parseInt(`${g}${g}`, 16),
      b: Number.parseInt(`${b}${b}`, 16),
    };
  }
  if (raw.length === 6 || raw.length === 8) {
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
    };
  }
  return undefined;
}

export function rgbToHex(c: Rgb): string {
  const part = (n: number): string => clamp255(n).toString(16).padStart(2, '0');
  return `#${part(c.r)}${part(c.g)}${part(c.b)}`;
}

function channelLuminance(v: number): number {
  const s = clamp255(v) / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(c: Rgb): number {
  return (
    0.2126 * channelLuminance(c.r) +
    0.7152 * channelLuminance(c.g) +
    0.0722 * channelLuminance(c.b)
  );
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return {
    r: clamp255(a.r + (b.r - a.r) * k),
    g: clamp255(a.g + (b.g - a.g) * k),
    b: clamp255(a.b + (b.b - a.b) * k),
  };
}

/**
 * Walks `fg` towards white or black — whichever side the background is not on
 * — until it clears `minRatio`. Returns the most extreme step if even the pure
 * endpoint cannot reach it (a mid-grey background against 7:1, say).
 */
export function ensureContrast(fg: Rgb, bg: Rgb, minRatio = 4.5): Rgb {
  if (contrastRatio(fg, bg) >= minRatio) return fg;
  const target = relativeLuminance(bg) > 0.18 ? BLACK : WHITE;
  let best = fg;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(fg, target, step / 20);
    best = candidate;
    if (contrastRatio(candidate, bg) >= minRatio) return candidate;
  }
  return best;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl(c: Rgb): Hsl {
  const r = clamp255(c.r) / 255;
  const g = clamp255(c.g) / 255;
  const b = clamp255(c.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(c: Hsl): Rgb {
  const h = ((c.h % 360) + 360) % 360;
  const s = clamp01(c.s);
  const l = clamp01(c.l);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - chroma / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [chroma, x, 0];
  else if (h < 120) rgb = [x, chroma, 0];
  else if (h < 180) rgb = [0, chroma, x];
  else if (h < 240) rgb = [0, x, chroma];
  else if (h < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  return {
    r: clamp255((rgb[0] + m) * 255),
    g: clamp255((rgb[1] + m) * 255),
    b: clamp255((rgb[2] + m) * 255),
  };
}

/** `amount` is a signed delta on HSL saturation: `0.2` vivid, `-0.2` washed out. */
export function saturate(c: Rgb, amount: number): Rgb {
  const hsl = rgbToHsl(c);
  return hslToRgb({ ...hsl, s: clamp01(hsl.s + amount) });
}

function lighten(c: Rgb, amount: number): Rgb {
  const hsl = rgbToHsl(c);
  return hslToRgb({ ...hsl, l: clamp01(hsl.l + amount) });
}

const LOAD_TIMEOUT_MS = 8_000;
const SAMPLE_EDGE = 48;

function loadImage(url: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    // Without this the pixels are unreadable: getImageData on a cross-origin
    // draw taints the canvas.
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    let done = false;
    const finish = (value: HTMLImageElement | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(undefined);
    }, LOAD_TIMEOUT_MS);
    img.onload = () => {
      finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? img : undefined);
    };
    img.onerror = () => {
      finish(undefined);
    };
    img.src = url;
  });
}

/**
 * Dominant colour of a cover, as `#rrggbb`. The image is drawn into a 48px
 * canvas and bucketed into a coarse 4-bit-per-channel histogram; near-black and
 * near-white pixels are ignored and saturated buckets are weighted up, so a
 * mostly-black sleeve yields its one vivid colour instead of grey.
 */
export async function dominantColor(imageUrl: string): Promise<string | undefined> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return undefined;
  if (imageUrl.length === 0) return undefined;

  const img = await loadImage(imageUrl);
  if (!img) return undefined;

  const scale = Math.min(1, SAMPLE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return undefined;

  let pixels: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, w, h);
    pixels = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return undefined;
  }

  interface Bucket {
    r: number;
    g: number;
    b: number;
    count: number;
    score: number;
  }
  const buckets = new Map<number, Bucket>();
  let fallbackR = 0;
  let fallbackG = 0;
  let fallbackB = 0;
  let fallbackN = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3] ?? 0;
    if (a < 128) continue;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    fallbackR += r;
    fallbackG += g;
    fallbackB += b;
    fallbackN += 1;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 26 || min > 232) continue;
    const saturation = max === 0 ? 0 : (max - min) / max;

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0, score: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.count += 1;
    // Vividness beats sheer pixel count so a large muddy background does not
    // win over the album's actual colour.
    bucket.score += 0.35 + saturation;
    buckets.set(key, bucket);
  }

  let winner: Bucket | undefined;
  for (const bucket of buckets.values()) {
    if (!winner || bucket.score > winner.score) winner = bucket;
  }

  if (!winner) {
    if (fallbackN === 0) return undefined;
    return rgbToHex({ r: fallbackR / fallbackN, g: fallbackG / fallbackN, b: fallbackB / fallbackN });
  }

  const average: Rgb = {
    r: winner.r / winner.count,
    g: winner.g / winner.count,
    b: winner.b / winner.count,
  };
  const hsl = rgbToHsl(average);
  // Keep the accent usable as a surface tint and as a button fill: clamp the
  // lightness into a mid band and give very grey colours a little help.
  return rgbToHex(
    hslToRgb({
      h: hsl.h,
      s: clamp01(hsl.s < 0.2 ? hsl.s + 0.12 : Math.min(hsl.s, 0.9)),
      l: Math.max(0.38, Math.min(0.62, hsl.l)),
    }),
  );
}

type Theme = 'dark' | 'light' | 'oled';

interface Surfaces {
  bg: Rgb;
  surface: Rgb;
  surface2: Rgb;
  surface3: Rgb;
  line: Rgb;
  text: Rgb;
  textDim: Rgb;
  textFaint: Rgb;
}

/** Base palettes; the numbers are the frozen ones from `docs/ui-spec.md`. */
const BASE: Record<Theme, Surfaces> = {
  dark: {
    bg: { r: 10, g: 11, b: 13 },
    surface: { r: 20, g: 22, b: 26 },
    surface2: { r: 28, g: 31, b: 36 },
    surface3: { r: 38, g: 42, b: 48 },
    line: { r: 44, g: 48, b: 55 },
    text: { r: 244, g: 245, b: 247 },
    textDim: { r: 161, g: 167, b: 176 },
    textFaint: { r: 108, g: 114, b: 124 },
  },
  oled: {
    bg: { r: 0, g: 0, b: 0 },
    surface: { r: 9, g: 9, b: 11 },
    surface2: { r: 17, g: 17, b: 20 },
    surface3: { r: 26, g: 26, b: 30 },
    line: { r: 32, g: 32, b: 36 },
    text: { r: 244, g: 245, b: 247 },
    textDim: { r: 161, g: 167, b: 176 },
    textFaint: { r: 108, g: 114, b: 124 },
  },
  light: {
    bg: { r: 255, g: 255, b: 255 },
    surface: { r: 246, g: 247, b: 249 },
    surface2: { r: 238, g: 240, b: 244 },
    surface3: { r: 228, g: 231, b: 236 },
    line: { r: 221, g: 224, b: 230 },
    text: { r: 16, g: 18, b: 22 },
    textDim: { r: 94, g: 100, b: 110 },
    textFaint: { r: 138, g: 144, b: 154 },
  },
};

/** How much accent bleeds into each surface, per theme. OLED keeps a true black. */
const TINT: Record<Theme, [number, number, number, number, number]> = {
  dark: [0.05, 0.06, 0.07, 0.08, 0.1],
  oled: [0, 0.04, 0.05, 0.06, 0.08],
  light: [0.03, 0.05, 0.06, 0.07, 0.09],
};

function triplet(c: Rgb): string {
  return `${clamp255(c.r)} ${clamp255(c.g)} ${clamp255(c.b)}`;
}

/**
 * The themed surface tokens derived from a single accent, as `R G B` triplets
 * matching `globals.css` so the UI can drop them straight onto an element with
 * `style.setProperty`.
 */
export function accentVariables(accentHex: string, theme: Theme): Record<string, string> {
  const base = BASE[theme];
  const accent = hexToRgb(accentHex) ?? { r: 18, g: 226, b: 154 };
  const tint = TINT[theme];

  const bg = mix(base.bg, accent, tint[0]);
  const surface = mix(base.surface, accent, tint[1]);
  const surface2 = mix(base.surface2, accent, tint[2]);
  const surface3 = mix(base.surface3, accent, tint[3]);
  const line = mix(base.line, accent, tint[4]);

  const text = ensureContrast(base.text, bg, 7);
  const textDim = ensureContrast(base.textDim, bg, 4.5);
  const textFaint = ensureContrast(base.textFaint, bg, 3);

  const hover = theme === 'light' ? lighten(accent, -0.07) : lighten(accent, 0.08);
  const onAccentSeed = relativeLuminance(accent) > 0.35
    ? mix(accent, BLACK, 0.86)
    : mix(accent, WHITE, 0.9);
  const onAccent = ensureContrast(onAccentSeed, accent, 4.5);

  return {
    '--c-accent': triplet(accent),
    '--c-accent-hover': triplet(hover),
    '--c-on-accent': triplet(onAccent),
    '--c-bg': triplet(bg),
    '--c-surface': triplet(surface),
    '--c-surface-2': triplet(surface2),
    '--c-surface-3': triplet(surface3),
    '--c-line': triplet(line),
    '--c-text': triplet(text),
    '--c-text-dim': triplet(textDim),
    '--c-text-faint': triplet(textFaint),
  };
}
