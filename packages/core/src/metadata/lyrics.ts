/**
 * LRCLIB lyrics + LRC parsing.
 *
 * Results are memoised in `host.kv`, misses included: a track without lyrics is
 * the common case and re-asking on every play would be pure latency for both
 * sides. The miss tombstone carries a timestamp so lyrics added upstream are
 * still picked up, a week later.
 */

import type { Lyrics, LyricLine, Track } from '../types';
import type { HostBridge } from '../host/types';

const LRCLIB_API = 'https://lrclib.net/api';
const SOURCE = 'LRCLIB';
const USER_AGENT = 'Ritmo/0.1.0 ( https://github.com/codeyevsky/ritmo )';

const HTTP_TTL_SEC = 86400;
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Search results within this of the track length are considered the same song. */
const DURATION_TOLERANCE_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[([](?:feat|ft|featuring|with)\b[^)\]]*[)\]]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const longest = Math.max(a.length, b.length);
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / longest;
  const aTokens = new Set(a.split(' '));
  let shared = 0;
  for (const token of b.split(' ')) if (aTokens.has(token)) shared += 1;
  const union = aTokens.size + b.split(' ').length - shared;
  return union > 0 ? shared / union : 0;
}

// ---------------------------------------------------------------------------
// LRC parsing
// ---------------------------------------------------------------------------

const META_RE = /^\[([a-zA-Z#]+):(.*)\]$/;
const LEAD_STAMP_RE = /^\s*\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
/** Enhanced-LRC per-word timings; they are not rendered, so strip them. */
const WORD_STAMP_RE = /<\d{1,4}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function fractionToMs(digits: string | undefined): number {
  if (digits === undefined) return 0;
  const value = Number(digits);
  if (!Number.isFinite(value)) return 0;
  if (digits.length === 1) return value * 100;
  if (digits.length === 2) return value * 10;
  return value;
}

/**
 * Parse an `.lrc` body into ascending synced lines.
 *
 * Handles `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]` and `[mm:ss:xx]`, several
 * timestamps sharing one text, and `[tag:value]` metadata — of which only
 * `offset` affects the output.
 */
export function parseLrc(lrc: string): LyricLine[] {
  if (lrc.length === 0) return [];
  const rawLines = lrc.split(/\r?\n/);

  let offsetMs = 0;
  for (const raw of rawLines) {
    const meta = META_RE.exec(raw.trim());
    if (meta && meta[1]?.toLowerCase() === 'offset') {
      const parsed = Number((meta[2] ?? '').trim());
      if (Number.isFinite(parsed)) offsetMs = parsed;
    }
  }

  const collected: Array<{ atMs: number; text: string; seq: number }> = [];
  let seq = 0;

  for (const raw of rawLines) {
    let rest = raw;
    const stamps: number[] = [];
    for (;;) {
      const match = LEAD_STAMP_RE.exec(rest);
      if (!match) break;
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) break;
      stamps.push(minutes * 60000 + seconds * 1000 + fractionToMs(match[3]));
      rest = rest.slice(match[0].length);
    }
    if (stamps.length === 0) continue;

    const text = rest.replace(WORD_STAMP_RE, '').replace(/\s+/g, ' ').trim();
    for (const stamp of stamps) {
      // A positive `offset` means "show the lyrics earlier", i.e. pull timestamps back.
      collected.push({ atMs: Math.max(0, stamp - offsetMs), text, seq: seq++ });
    }
  }

  collected.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
  return collected.map(({ atMs, text }) => ({ atMs, text }));
}

/**
 * Index of the line that should be highlighted at `positionMs`, or `-1` before
 * the first line. Binary search because the lyrics view calls this every frame.
 */
export function activeLyricIndex(lines: LyricLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid];
    if (line === undefined) break;
    if (line.atMs <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function lyricsFromPayload(payload: unknown): Lyrics | undefined {
  if (!isRecord(payload)) return undefined;

  if (payload['instrumental'] === true) return { plain: '♪', source: SOURCE };

  const synced = asString(payload['syncedLyrics']);
  const plainRaw = asString(payload['plainLyrics']);
  const lines = synced !== undefined ? parseLrc(synced) : [];

  const plain = plainRaw ?? (lines.length > 0 ? lines.map((l) => l.text).join('\n') : undefined);
  if (plain === undefined || plain.trim().length === 0) return undefined;

  return lines.length > 0
    ? { plain, synced: lines, source: SOURCE }
    : { plain, source: SOURCE };
}

async function requestJson(
  host: HostBridge,
  url: string,
): Promise<{ status: number; data: unknown }> {
  const res = await host.http.request({
    url,
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    cacheTtlSec: HTTP_TTL_SEC,
    timeoutMs: 15000,
  });
  if (res.status < 200 || res.status >= 300) return { status: res.status, data: undefined };
  try {
    return { status: res.status, data: JSON.parse(res.body) as unknown };
  } catch {
    return { status: res.status, data: undefined };
  }
}

async function searchFallback(
  host: HostBridge,
  artist: string,
  title: string,
  durationMs: number,
): Promise<Lyrics | undefined> {
  const query = `${artist} ${title}`.trim();
  if (query.length === 0) return undefined;

  const { data } = await requestJson(host, `${LRCLIB_API}/search?q=${encodeURIComponent(query)}`);
  if (!Array.isArray(data)) return undefined;

  const wantTitle = normalizeName(title);
  const wantArtist = normalizeName(artist);

  let best: Lyrics | undefined;
  let bestScore = 0;
  for (const raw of data) {
    if (!isRecord(raw)) continue;
    const candidate = lyricsFromPayload(raw);
    if (!candidate) continue;

    const titleScore = similarity(normalizeName(asString(raw['trackName']) ?? ''), wantTitle);
    const artistScore = similarity(normalizeName(asString(raw['artistName']) ?? ''), wantArtist);
    if (titleScore < 0.5) continue;

    let durationScore = 0.5;
    const seconds = asNumber(raw['duration']);
    if (durationMs > 0 && seconds !== undefined) {
      const delta = Math.abs(seconds * 1000 - durationMs);
      durationScore = delta <= DURATION_TOLERANCE_MS ? 1 : Math.max(0, 1 - delta / 60000);
    }

    // Synced lyrics are worth a nudge over an equally-plausible plain match.
    const score = titleScore * 0.35 + artistScore * 0.25 + durationScore * 0.4
      + (candidate.synced !== undefined ? 0.05 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 0.55 ? best : undefined;
}

function reviveLyrics(value: unknown): Lyrics | undefined {
  if (!isRecord(value)) return undefined;
  const plain = asString(value['plain']);
  if (plain === undefined) return undefined;

  const synced: LyricLine[] = [];
  if (Array.isArray(value['synced'])) {
    for (const raw of value['synced']) {
      if (!isRecord(raw)) continue;
      const atMs = asNumber(raw['atMs']);
      const text = typeof raw['text'] === 'string' ? raw['text'] : undefined;
      if (atMs !== undefined && text !== undefined) synced.push({ atMs, text });
    }
  }

  return synced.length > 0
    ? { plain, synced, source: asString(value['source']) ?? SOURCE }
    : { plain, source: asString(value['source']) ?? SOURCE };
}

async function readCache(host: HostBridge, uri: string): Promise<Lyrics | undefined | 'miss'> {
  try {
    const hit = await host.kv.get(`lyrics:${uri}`);
    if (hit !== undefined) {
      const revived = reviveLyrics(JSON.parse(hit) as unknown);
      if (revived !== undefined) return revived;
    }
    const tomb = await host.kv.get(`lyrics:miss:${uri}`);
    if (tomb !== undefined) {
      const parsed = JSON.parse(tomb) as unknown;
      const at = isRecord(parsed) ? asNumber(parsed['at']) : undefined;
      if (at !== undefined && Date.now() - at < MISS_TTL_MS) return 'miss';
      await host.kv.remove(`lyrics:miss:${uri}`);
    }
  } catch {
    // A corrupt cache entry must never block a fresh lookup.
  }
  return undefined;
}

async function writeCache(host: HostBridge, uri: string, lyrics: Lyrics | undefined): Promise<void> {
  try {
    if (lyrics === undefined) {
      await host.kv.set(`lyrics:miss:${uri}`, JSON.stringify({ at: Date.now() }));
    } else {
      await host.kv.set(`lyrics:${uri}`, JSON.stringify(lyrics));
      await host.kv.remove(`lyrics:miss:${uri}`);
    }
  } catch {
    // Caching is an optimisation; losing it is not a failure worth surfacing.
  }
}

/**
 * Lyrics for `track`, or `undefined` when none exist. Never throws: the lyrics
 * pane is decorative and must not be able to break playback.
 */
export async function fetchLyrics(host: HostBridge, track: Track): Promise<Lyrics | undefined> {
  // Radio "tracks" carry stream titles at best, so a lookup is guaranteed noise.
  if (track.isLive === true) return undefined;

  const artist = track.artists[0]?.name ?? '';
  const title = track.title.trim();
  if (title.length === 0) return undefined;

  const cached = await readCache(host, track.uri);
  if (cached === 'miss') return undefined;
  if (cached !== undefined) return cached;

  let found: Lyrics | undefined;
  try {
    const params = new URLSearchParams({ artist_name: artist, track_name: title });
    if (track.album?.name) params.set('album_name', track.album.name);
    if (track.durationMs > 0) params.set('duration', String(Math.round(track.durationMs / 1000)));

    const direct = await requestJson(host, `${LRCLIB_API}/get?${params.toString()}`);
    found = direct.status === 200 ? lyricsFromPayload(direct.data) : undefined;

    if (found === undefined) {
      found = await searchFallback(host, artist, title, track.durationMs);
    }
  } catch {
    // Network failure is transient — do not tombstone it.
    return undefined;
  }

  await writeCache(host, track.uri, found);
  return found;
}
