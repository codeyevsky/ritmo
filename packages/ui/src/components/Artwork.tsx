import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { initials } from '@ritmo/core';
import type { Artwork as ArtworkData, ArtworkSource } from '@ritmo/core';
import { useServices } from '../services';
import { Music } from '../icons';

export interface ArtworkProps {
  artwork?: ArtworkData;
  /** Rendered size in CSS px — picks the closest source and sets width/height. */
  size: number;
  /** Used for the generated fallback (initials + deterministic gradient). */
  name?: string;
  shape?: 'square' | 'circle';
  rounded?: 'xs' | 'sm' | 'md' | 'lg' | 'none';
  className?: string;
  /** Skips lazy loading for above-the-fold heroes. */
  eager?: boolean;
}

const ROUNDED: Record<NonNullable<ArtworkProps['rounded']>, string> = {
  none: 'rounded-none',
  xs: 'rounded-xs',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
};

/* ---------------------------------------------------------------------------
   Generated artwork. A station or a local track usually has no cover, and a
   grid of them is the worst case: a dozen tiles side by side that have to read
   as a dozen *different* things. Everything below is derived from the name —
   no assets, no network, no canvas — and is stable for the life of the name.
   --------------------------------------------------------------------------- */

/** FNV-ish 32-bit hash: the same name must always produce the same artwork. */
function hashName(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Hues are quantised into buckets walked by the golden angle rather than taken
 * straight from `hash % 360`: two different names then either share a hue
 * exactly or sit a clear step apart, instead of landing 4° from each other and
 * reading as a rendering mistake down a row of stations.
 */
const HUE_BUCKETS = 21;
const GOLDEN_ANGLE = 137.507764;

/** Contrast the initials must clear against the lighter of the two stops. */
const TEXT_CONTRAST = 4.8;

const SAT_TOP = 0.58;
const SAT_BOTTOM = 0.66;
const LIGHT_TOP = 0.4;

function srgbChannel(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an hsl() triplet, without a round-trip to CSS. */
function hslLuminance(hue: number, sat: number, light: number): number {
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const rgb: [number, number, number] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = light - c / 2;
  return (
    0.2126 * srgbChannel(rgb[0] + m) +
    0.7152 * srgbChannel(rgb[1] + m) +
    0.0722 * srgbChannel(rgb[2] + m)
  );
}

/**
 * Saturation is held and lightness is spent instead, so the tile keeps real
 * chroma. A fixed lightness would be a lie: cyan and yellow are roughly twice
 * as luminous as blue at the same HSL value, so each hue is walked down until
 * white on top actually clears {@link TEXT_CONTRAST}.
 */
function legibleLightness(hue: number, sat: number, start: number): number {
  let light = start;
  while (light > 0.12 && 1.05 / (hslLuminance(hue, sat, light) + 0.05) < TEXT_CONTRAST) {
    light -= 0.01;
  }
  return light;
}

const BAR_COUNT = 5;
const BAR_W = 9;
const BAR_GAP = 6;
const BAR_X0 = (100 - (BAR_COUNT * BAR_W + (BAR_COUNT - 1) * BAR_GAP)) / 2;

interface Generated {
  gradient: string;
  /** Motif bar heights in a 0–100 viewBox, tallest in the middle. */
  bars: number[];
}

function generate(name: string | undefined): Generated {
  const h = name ? hashName(name) : 1013904223;

  const hue = ((h % HUE_BUCKETS) * GOLDEN_ANGLE + 12) % 360;
  // 24°–44°: analogous, so the two stops never clash, but far enough apart to
  // read as a gradient rather than as one flat colour.
  const hue2 = (hue + 24 + ((h >>> 5) % 21)) % 360;

  // A dozen tiles against 21 hues will land on the same one sooner or later, so
  // depth and rake are second and third axes: two stations sharing a hue still
  // read as two tiles rather than as one repeated twice.
  const depth = ((h >>> 17) % 3) * 0.055;
  const rake = 118 + ((h >>> 9) % 5) * 23;

  const topLight = legibleLightness(hue, SAT_TOP, LIGHT_TOP - depth);
  const bottomLight = legibleLightness(hue2, SAT_BOTTOM, topLight * 0.46);

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const gradient =
    `linear-gradient(${rake}deg, hsl(${Math.round(hue)} ${pct(SAT_TOP)} ${pct(topLight)}), ` +
    `hsl(${Math.round(hue2)} ${pct(SAT_BOTTOM)} ${pct(bottomLight)}))`;

  // Echoes the Ritmo mark — five bars tapering out from the centre — with the
  // taper varied per name so no two tiles hold quite the same silhouette.
  const bars: number[] = [];
  for (let i = 0; i < BAR_COUNT; i += 1) {
    const taper = Math.abs(i - (BAR_COUNT - 1) / 2);
    const jitter = ((h >>> (i * 4)) % 4) * 4;
    bars.push(64 - taper * 14 + jitter);
  }

  return { gradient, bars };
}

/** One grapheme: an emoji ZWJ sequence, or a base character with its marks. */
const GRAPHEME =
  /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*|\P{M}\p{M}*/u;

/** Scripts where a single glyph already carries a whole word. */
const IDEOGRAPH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * `initials()` only ever sees letters and digits, so it answers "?" for a name
 * written entirely in emoji, and two ideographs — which read as a truncation
 * rather than as initials — for a CJK one. Both of those want one grapheme.
 * A name that merely *starts* with an emoji still has real initials to use.
 */
function labelFor(name: string): string {
  const derived = initials(name);
  if (derived === '?') return GRAPHEME.exec(name.trim())?.[0] ?? '';
  const head = [...derived][0] ?? '';
  return IDEOGRAPH.test(head) ? head : derived;
}

function isDirectUrl(url: string): boolean {
  return /^(https?:|data:|blob:|asset:|capacitor:)/i.test(url);
}

/** Below this the tile is an avatar, and the motif would only read as noise. */
const MOTIF_MIN_PX = 56;

export function Artwork({
  artwork,
  size,
  name,
  shape = 'square',
  rounded = 'md',
  className,
  eager = false,
}: ArtworkProps) {
  const { host } = useServices();
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const resolved = useMemo(() => {
    const raw = artwork?.sources ?? [];
    if (raw.length === 0) return { src: undefined, srcSet: undefined };
    const sources: ArtworkSource[] = [...raw].sort((a, b) => a.size - b.size);
    const toUrl = (s: ArtworkSource) => (isDirectUrl(s.url) ? s.url : host.files.toPlayableUrl(s.url));
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const target = size * dpr;
    const largest = sources[sources.length - 1];
    const chosen = sources.find((s) => s.size >= target) ?? largest;
    return {
      src: chosen ? toUrl(chosen) : undefined,
      // Let the browser refine the pick on high-DPI displays and on resize.
      srcSet: sources.length > 1 ? sources.map((s) => `${toUrl(s)} ${s.size}w`).join(', ') : undefined,
    };
  }, [artwork, host, size]);

  const art = useMemo(() => generate(name), [name]);
  const src = resolved.src;
  const broken = src !== undefined && failedUrl === src;
  const loaded = src !== undefined && loadedUrl === src;
  const showImage = src !== undefined && !broken;
  const label = name ? labelFor(name) : '';
  const glyphs = label === '' ? 0 : [...label].length;
  // The motif belongs to the generated gradient; over a real cover's blurred
  // placeholder it would be drawing on top of someone else's artwork.
  const showMotif = !showImage && artwork?.placeholder === undefined && size >= MOTIF_MIN_PX;

  return (
    <div
      className={clsx(
        'relative shrink-0 overflow-hidden bg-surface-2',
        shape === 'circle' ? 'rounded-full' : ROUNDED[rounded],
        className,
      )}
      style={{
        width: size,
        height: size,
        // Painted immediately so a grid of cards never flashes grey.
        backgroundImage: artwork?.placeholder ? `url(${artwork.placeholder})` : art.gradient,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {showImage ? (
        <img
          src={src}
          srcSet={resolved.srcSet}
          sizes={`${size}px`}
          alt=""
          width={size}
          height={size}
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
          decoding="async"
          draggable={false}
          onLoad={() => setLoadedUrl(src)}
          onError={() => setFailedUrl(src)}
          className={clsx(
            'h-full w-full select-none object-cover transition-opacity duration-300 ease-swift',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : (
        <>
          {showMotif ? (
            <svg
              aria-hidden="true"
              viewBox="0 0 100 100"
              preserveAspectRatio="xMidYMid meet"
              className="pointer-events-none absolute inset-0 h-full w-full text-white"
            >
              <g fill="currentColor" opacity={0.12}>
                {art.bars.map((height, i) => (
                  <rect
                    key={i}
                    x={BAR_X0 + i * (BAR_W + BAR_GAP)}
                    y={(100 - height) / 2}
                    width={BAR_W}
                    height={height}
                    rx={BAR_W / 2}
                  />
                ))}
              </g>
            </svg>
          ) : null}
          <span
            aria-hidden="true"
            className={clsx(
              'relative flex h-full w-full items-center justify-center font-semibold uppercase',
              // White rather than `text-text`: the ground underneath is the
              // generated gradient, which `legibleLightness` keeps dark enough
              // for it in every theme. A blurred cover placeholder is not ours
              // to assume anything about, so that case keeps the old treatment.
              artwork?.placeholder === undefined ? 'text-white/95' : 'text-text/70',
            )}
            style={{
              fontSize: Math.max(11, Math.round(size * (glyphs > 1 ? 0.36 : 0.44))),
              letterSpacing: glyphs > 1 ? '0.01em' : undefined,
              textShadow: showMotif ? '0 1px 3px rgb(0 0 0 / 0.3)' : undefined,
            }}
          >
            {label !== '' ? label : <Music className="h-1/3 w-1/3" />}
          </span>
        </>
      )}
    </div>
  );
}
