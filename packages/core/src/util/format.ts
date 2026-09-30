/**
 * Display formatting. Every locale-sensitive piece goes through `Intl` so the
 * Turkish decimal comma, the "1,2 B" compact form and "12 Mart 2024" all come
 * out right without a hand-rolled separator in sight.
 */

export type Lang = 'tr' | 'en';

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

function nf(lang: Lang, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${lang}|${JSON.stringify(opts)}`;
  const cached = numberFormats.get(key);
  if (cached) return cached;
  const made = new Intl.NumberFormat(lang, opts);
  numberFormats.set(key, made);
  return made;
}

function dtf(lang: Lang, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${lang}|${JSON.stringify(opts)}`;
  const cached = dateFormats.get(key);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat(lang, opts);
  dateFormats.set(key, made);
  return made;
}

function rtf(lang: Lang): Intl.RelativeTimeFormat | undefined {
  const cached = relativeFormats.get(lang);
  if (cached) return cached;
  if (typeof Intl.RelativeTimeFormat !== 'function') return undefined;
  const made = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' });
  relativeFormats.set(lang, made);
  return made;
}

const UNITS: Record<Lang, { hour: string; minute: string; second: string }> = {
  tr: { hour: 'sa', minute: 'dk', second: 'sn' },
  en: { hour: 'hr', minute: 'min', second: 'sec' },
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `3:07`, `1:02:44`, and `0:00` for an unknown or zero length (live radio). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}

/** `1 sa 2 dk` / `1 hr 2 min`, for playlist and album totals. */
export function formatDurationLong(ms: number, lang: Lang): string {
  const u = UNITS[lang];
  if (!Number.isFinite(ms) || ms <= 0) return `0 ${u.minute}`;
  const total = Math.round(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) {
    const h = nf(lang, {}).format(hours);
    return minutes > 0 ? `${h} ${u.hour} ${minutes} ${u.minute}` : `${h} ${u.hour}`;
  }
  if (minutes > 0) return `${minutes} ${u.minute}`;
  return `${seconds} ${u.second}`;
}

/** `1,2 B` (bin) in Turkish, `1.2K` in English. */
export function formatCount(n: number, lang: Lang): string {
  if (!Number.isFinite(n)) return nf(lang, {}).format(0);
  const value = Math.trunc(n);
  if (Math.abs(value) < 1000) return nf(lang, {}).format(value);
  try {
    return nf(lang, {
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    // Runtimes built without the compact-notation data still have to render
    // something sane.
    const scales: Array<[number, string]> =
      lang === 'tr'
        ? [[1e9, 'Mr'], [1e6, 'Mn'], [1e3, 'B']]
        : [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [size, suffix] of scales) {
      if (Math.abs(value) >= size) {
        const scaled = nf(lang, { maximumFractionDigits: 1 }).format(value / size);
        return lang === 'tr' ? `${scaled} ${suffix}` : `${scaled}${suffix}`;
      }
    }
    return nf(lang, {}).format(value);
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(n: number, lang: Lang): string {
  if (!Number.isFinite(n) || n <= 0) return `0 ${BYTE_UNITS[0]}`;
  const exp = Math.max(0, Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024))));
  const value = n / 1024 ** exp;
  const digits = exp === 0 ? 0 : value < 10 ? 1 : 0;
  const unit = BYTE_UNITS[exp] ?? BYTE_UNITS[0];
  return `${nf(lang, { maximumFractionDigits: digits }).format(value)} ${unit}`;
}

export function formatDate(ms: number, lang: Lang): string {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return dtf(lang, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

const RELATIVE_SCALES: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

const RELATIVE_FALLBACK: Record<Lang, Record<string, string>> = {
  tr: { year: 'yıl', month: 'ay', week: 'hf', day: 'gün', hour: 'sa', minute: 'dk', second: 'sn' },
  en: { year: 'yr', month: 'mo', week: 'wk', day: 'd', hour: 'hr', minute: 'min', second: 'sec' },
};

/** `3 dk önce` / `3 min ago`, and `şimdi` / `just now` under ~45 s. */
export function formatRelative(ms: number, lang: Lang): string {
  if (!Number.isFinite(ms)) return '';
  const delta = Date.now() - ms;
  const abs = Math.abs(delta);
  if (abs < 45_000) return lang === 'tr' ? 'şimdi' : 'just now';

  let unit: Intl.RelativeTimeFormatUnit = 'second';
  let amount = Math.round(abs / 1000);
  for (const [candidate, size] of RELATIVE_SCALES) {
    if (abs >= size) {
      unit = candidate;
      amount = Math.round(abs / size);
      break;
    }
  }

  const formatter = rtf(lang);
  // Past is negative for Intl; `delta > 0` means the timestamp is behind us.
  if (formatter) return formatter.format(delta >= 0 ? -amount : amount, unit);

  const label = RELATIVE_FALLBACK[lang][unit] ?? unit;
  if (lang === 'tr') return delta >= 0 ? `${amount} ${label} önce` : `${amount} ${label} sonra`;
  return delta >= 0 ? `${amount} ${label} ago` : `in ${amount} ${label}`;
}

/** First four-digit year in an ISO date or a bare year string. */
export function formatReleaseYear(date?: string): string {
  if (date === undefined || date.length === 0) return '';
  const match = /\d{4}/.exec(date);
  return match?.[0] ?? '';
}

export function formatBitrate(kbps?: number): string {
  if (kbps === undefined || !Number.isFinite(kbps) || kbps <= 0) return '';
  return `${Math.round(kbps)} kbps`;
}

/** `5` on a single-disc release, `2-5` once a second disc is in play. */
export function formatTrackPosition(disc?: number, track?: number): string {
  if (track === undefined || !Number.isFinite(track) || track <= 0) return '';
  const position = Math.trunc(track);
  if (disc !== undefined && Number.isFinite(disc) && disc > 1) {
    return `${Math.trunc(disc)}-${position}`;
  }
  return String(position);
}
