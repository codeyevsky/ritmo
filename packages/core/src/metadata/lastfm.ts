/**
 * Last.fm authentication + scrobbling.
 *
 * Contains a self-contained MD5 because the API signs every authenticated call
 * and core may not import `node:crypto` (it has to run in a WebView) nor pull in
 * a dependency. Verified against the RFC 1321 test vectors.
 */

import type { Track } from '../types';
import type { HostBridge, HttpResponse } from '../host/types';
import { ProviderError } from '../providers/types';

export const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_AUTH_URL = 'https://www.last.fm/api/auth/';

/** A play counts once it passes half the track… */
export const LASTFM_SCROBBLE_THRESHOLD_RATIO = 0.5;
/** …or four minutes, whichever comes first. */
export const LASTFM_SCROBBLE_THRESHOLD_MS = 240_000;

/** Hard API limit: the batch endpoint rejects more than 50 plays per request. */
const MAX_BATCH = 50;
/** Last.fm silently discards plays older than two weeks. */
const MAX_QUEUE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Tracks shorter than this are not scrobbleable per the API rules. */
const MIN_SCROBBLE_DURATION_MS = 30_000;
const QUEUE_KEY = 'lastfm:queue';
const MAX_QUEUED = 1000;

// ---------------------------------------------------------------------------
// MD5
// ---------------------------------------------------------------------------

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const MD5_SINE = (() => {
  const table = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) {
    table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  }
  return table;
})();

/** Hand-rolled so the hash never depends on a TextEncoder global being present. */
function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

function rotl(value: number, count: number): number {
  return (value << count) | (value >>> (32 - count));
}

/** Exported for the RFC 1321 test vectors; not part of the public core API. */
export function md5Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const byteLen = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lowBits = (byteLen << 3) >>> 0;
  const highBits = Math.floor(byteLen / 536870912) >>> 0;
  bytes.push(lowBits & 0xff, (lowBits >>> 8) & 0xff, (lowBits >>> 16) & 0xff, (lowBits >>> 24) & 0xff);
  bytes.push(highBits & 0xff, (highBits >>> 8) & 0xff, (highBits >>> 16) & 0xff, (highBits >>> 24) & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89 | 0;
  let h2 = 0x98badcfe | 0;
  let h3 = 0x10325476;
  const block = new Int32Array(16);

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let j = 0; j < 16; j += 1) {
      const o = chunk + j * 4;
      block[j] =
        ((bytes[o] ?? 0) |
          ((bytes[o + 1] ?? 0) << 8) |
          ((bytes[o + 2] ?? 0) << 16) |
          ((bytes[o + 3] ?? 0) << 24)) |
        0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + (MD5_SINE[i] ?? 0) + (block[g] ?? 0)) | 0, MD5_SHIFT[i] ?? 0)) | 0;
      a = tmp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
  }

  let hex = '';
  for (const word of [h0, h1, h2, h3]) {
    for (let i = 0; i < 4; i += 1) {
      hex += (((word >>> (i * 8)) & 0xff) + 0x100).toString(16).slice(1);
    }
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

interface QueuedScrobble {
  artist: string;
  track: string;
  timestamp: number;
  album?: string;
  duration?: number;
  trackNumber?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Codes that mean "the session/key is dead" — retrying can never help. */
const AUTH_ERRORS = new Set([4, 9, 10, 14, 15, 26]);
/** Codes that mean "try again later". */
const TRANSIENT_ERRORS = new Set([8, 11, 16, 29]);

function retryable(err: unknown): boolean {
  return err instanceof ProviderError && (err.code === 'network' || err.code === 'rate_limited');
}

function toQueued(track: Track, playedAt: number): QueuedScrobble | undefined {
  const artist = track.artists[0]?.name?.trim();
  const title = track.title.trim();
  if (!artist || title.length === 0) return undefined;
  if (track.durationMs > 0 && track.durationMs < MIN_SCROBBLE_DURATION_MS) return undefined;

  // PlayHistoryEntry.playedAt is epoch ms, but a caller handing us seconds would
  // otherwise silently scrobble everything into 1970.
  const ms = playedAt < 1e11 ? playedAt * 1000 : playedAt;

  return {
    artist,
    track: title,
    timestamp: Math.floor(ms / 1000),
    album: track.album?.name,
    duration: track.durationMs > 0 ? Math.round(track.durationMs / 1000) : undefined,
    trackNumber: track.trackNumber,
  };
}

function reviveQueue(raw: string): QueuedScrobble[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: QueuedScrobble[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const artist = asString(entry['artist']);
    const track = asString(entry['track']);
    const timestamp = asNumber(entry['timestamp']);
    if (!artist || !track || timestamp === undefined) continue;
    out.push({
      artist,
      track,
      timestamp,
      album: asString(entry['album']),
      duration: asNumber(entry['duration']),
      trackNumber: asNumber(entry['trackNumber']),
    });
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function batchParams(session: string, batch: QueuedScrobble[]): Record<string, string> {
  const params: Record<string, string> = { method: 'track.scrobble', sk: session };
  batch.forEach((entry, i) => {
    params[`artist[${i}]`] = entry.artist;
    params[`track[${i}]`] = entry.track;
    params[`timestamp[${i}]`] = String(entry.timestamp);
    if (entry.album !== undefined) params[`album[${i}]`] = entry.album;
    if (entry.duration !== undefined) params[`duration[${i}]`] = String(entry.duration);
    if (entry.trackNumber !== undefined) params[`trackNumber[${i}]`] = String(entry.trackNumber);
  });
  return params;
}

/** A retry must not double-count a play Last.fm already took. */
function dedupe(entries: QueuedScrobble[]): QueuedScrobble[] {
  const seen = new Set<string>();
  const out: QueuedScrobble[] = [];
  for (const entry of entries) {
    const key = `${entry.timestamp}|${entry.artist.toLowerCase()}|${entry.track.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export class LastfmClient {
  /** Only one drain may own the persisted queue at a time. */
  private draining = false;
  /** Plays handed in while a drain is running; merged in without touching kv. */
  private readonly deferred: QueuedScrobble[] = [];

  constructor(
    private readonly host: HostBridge,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {}

  /**
   * Desktop-style auth: fetch a request token, send the user to the returned URL
   * in their real browser, then call {@link completeAuth} once they approve.
   */
  async getAuthUrl(): Promise<{ token: string; url: string }> {
    const body = await this.call('GET', { method: 'auth.getToken' });
    const token = asString(body['token']);
    if (token === undefined) {
      throw new ProviderError('parse', 'Last.fm returned no request token');
    }
    return {
      token,
      url: `${LASTFM_AUTH_URL}?api_key=${encodeURIComponent(this.apiKey)}&token=${encodeURIComponent(token)}`,
    };
  }

  async completeAuth(token: string): Promise<{ username: string; sessionKey: string }> {
    const body = await this.call('GET', { method: 'auth.getSession', token });
    const session = isRecord(body['session']) ? body['session'] : undefined;
    const username = session ? asString(session['name']) : undefined;
    const sessionKey = session ? asString(session['key']) : undefined;
    if (username === undefined || sessionKey === undefined) {
      throw new ProviderError('auth', 'Last.fm did not grant a session');
    }
    return { username, sessionKey };
  }

  async updateNowPlaying(session: string, track: Track): Promise<void> {
    const entry = toQueued(track, Date.now());
    if (entry === undefined) return;

    const params: Record<string, string> = {
      method: 'track.updateNowPlaying',
      artist: entry.artist,
      track: entry.track,
      sk: session,
    };
    if (entry.album !== undefined) params['album'] = entry.album;
    if (entry.duration !== undefined) params['duration'] = String(entry.duration);
    if (entry.trackNumber !== undefined) params['trackNumber'] = String(entry.trackNumber);

    try {
      await this.call('POST', params);
    } catch (err) {
      // Now-playing is ephemeral, so transient failures are dropped; a dead
      // session however has to reach the UI so it can ask for re-authorisation.
      if (err instanceof ProviderError && err.code === 'auth') throw err;
    }
  }

  /**
   * Submits `plays` together with any previously failed ones, oldest first so
   * the listening history stays in order. Transient failures are persisted and
   * retried rather than lost.
   */
  async scrobble(session: string, plays: Array<{ track: Track; playedAt: number }>): Promise<void> {
    const entries: QueuedScrobble[] = [];
    for (const play of plays) {
      const entry = toQueued(play.track, play.playedAt);
      if (entry !== undefined) entries.push(entry);
    }
    await this.drain(session, entries);
  }

  /** Retries persisted failures. Returns how many plays Last.fm accepted. */
  async flushQueue(session: string): Promise<number> {
    return this.drain(session, []);
  }

  private async drain(session: string, extra: QueuedScrobble[]): Promise<number> {
    if (this.draining) {
      // The in-flight drain picks these up, so they never race over kv.
      this.deferred.push(...extra);
      return 0;
    }
    this.draining = true;
    try {
      const stored = await this.takeQueue();
      const pending = dedupe([...stored, ...extra, ...this.deferred.splice(0)]);
      const cutoff = Math.floor((Date.now() - MAX_QUEUE_AGE_MS) / 1000);
      const fresh = pending
        .filter((e) => e.timestamp >= cutoff)
        .sort((a, b) => a.timestamp - b.timestamp);

      const accepted = fresh.length > 0 ? await this.submit(session, fresh) : 0;
      if (this.deferred.length > 0) await this.appendQueue(this.deferred.splice(0));
      return accepted;
    } finally {
      this.draining = false;
    }
  }

  /** Sends batches, re-queueing whatever could not be delivered. */
  private async submit(session: string, entries: QueuedScrobble[]): Promise<number> {
    let accepted = 0;
    let authError: ProviderError | undefined;
    const failed: QueuedScrobble[] = [];

    for (const batch of chunk(entries, MAX_BATCH)) {
      if (authError !== undefined) {
        failed.push(...batch);
        continue;
      }
      try {
        await this.call('POST', batchParams(session, batch));
        accepted += batch.length;
      } catch (err) {
        if (retryable(err)) {
          failed.push(...batch);
        } else if (err instanceof ProviderError && err.code === 'auth') {
          // Keep the plays: once the user re-authorises they will go through.
          failed.push(...batch);
          authError = err;
        }
        // Anything else (rejected parameters) is permanently undeliverable.
      }
    }

    if (failed.length > 0) await this.appendQueue(failed);
    if (authError !== undefined) throw authError;
    return accepted;
  }

  private async takeQueue(): Promise<QueuedScrobble[]> {
    let raw: string | undefined;
    try {
      raw = await this.host.kv.get(QUEUE_KEY);
      if (raw !== undefined) await this.host.kv.remove(QUEUE_KEY);
    } catch {
      return [];
    }
    return raw === undefined ? [] : reviveQueue(raw);
  }

  private async appendQueue(entries: QueuedScrobble[]): Promise<void> {
    try {
      const existing = await this.host.kv.get(QUEUE_KEY);
      const merged = dedupe([...(existing === undefined ? [] : reviveQueue(existing)), ...entries])
        .sort((a, b) => a.timestamp - b.timestamp);
      // Newest plays are the ones worth keeping if the queue ever runs away.
      await this.host.kv.set(QUEUE_KEY, JSON.stringify(merged.slice(-MAX_QUEUED)));
    } catch {
      // Nothing useful to do if the key/value store itself is unavailable.
    }
  }

  /** `md5(sorted "k"+"v" concatenation + secret)`, excluding `format`. */
  private sign(params: Record<string, string>): string {
    let payload = '';
    for (const key of Object.keys(params).sort()) {
      if (key === 'format' || key === 'callback') continue;
      payload += key + (params[key] ?? '');
    }
    return md5Hex(payload + this.apiSecret);
  }

  private async call(
    method: 'GET' | 'POST',
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    if (this.apiKey.length === 0 || this.apiSecret.length === 0) {
      throw new ProviderError('auth', 'Last.fm API key and secret are not configured');
    }

    const signed: Record<string, string> = { ...params, api_key: this.apiKey };
    signed['api_sig'] = this.sign(signed);
    signed['format'] = 'json';
    const form = new URLSearchParams(signed).toString();

    let res: HttpResponse;
    try {
      res = await this.host.http.request(
        method === 'GET'
          ? { url: `${LASTFM_API_URL}?${form}`, method: 'GET', timeoutMs: 15000 }
          : {
              url: LASTFM_API_URL,
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
              body: form,
              timeoutMs: 15000,
            },
      );
    } catch (err) {
      throw new ProviderError('network', 'Last.fm request failed', undefined, err);
    }

    let body: unknown;
    try {
      body = JSON.parse(res.body) as unknown;
    } catch {
      body = undefined;
    }

    const code = isRecord(body) ? asNumber(body['error']) : undefined;
    if (code !== undefined) {
      const message =
        (isRecord(body) ? asString(body['message']) : undefined) ?? `Last.fm error ${code}`;
      if (AUTH_ERRORS.has(code)) throw new ProviderError('auth', message);
      if (code === 29) throw new ProviderError('rate_limited', message);
      if (TRANSIENT_ERRORS.has(code)) throw new ProviderError('network', message);
      throw new ProviderError('parse', message);
    }

    if (res.status === 429) throw new ProviderError('rate_limited', 'Last.fm rate limit reached');
    if (res.status >= 500) throw new ProviderError('network', `Last.fm HTTP ${res.status}`);
    if (res.status < 200 || res.status >= 300) {
      throw new ProviderError('unknown', `Last.fm HTTP ${res.status}`);
    }
    if (!isRecord(body)) throw new ProviderError('parse', 'Last.fm returned a malformed response');
    return body;
  }
}
