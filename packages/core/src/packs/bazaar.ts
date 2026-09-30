/**
 * The Bazaar — packs published by anyone, browsed without a Ritmo server.
 *
 * A publisher writes a static `index.json` plus the pack files next to it and
 * shares the index URL. This file is the only place that fetches those
 * documents, and therefore the only place that has to be paranoid.
 *
 * ## The trust boundary, and why it is here
 *
 * An index is a remote document written by a stranger. Every field is hostile
 * input, so all of the following is enforced *before* a byte of it reaches the
 * pack layer, the database or the UI:
 *
 *   * **`http`/`https` only.** A `file:`, `data:` or `javascript:` url in an
 *     index would turn "subscribe to a catalogue" into "read my disk" or
 *     "run this"; the scheme is checked on the source url and again on every
 *     `url`/`artwork` the document offers.
 *   * **Same origin as the index.** Relative paths resolve against the index
 *     url — that is what lets a publisher move their tree — but an absolute one
 *     that points somewhere else is refused. Without this, a harmless-looking
 *     index could aim the app at an intranet host and use it as a proxy, and a
 *     pack could claim to come from a source it does not belong to.
 *   * **Cost caps:** {@link MAX_PACKS_PER_INDEX} packs, {@link MAX_TRACKS_PER_PACK}
 *     tracks, {@link MAX_INDEX_BYTES} for an index and {@link MAX_PACK_BYTES}
 *     for a pack. A source cannot be allowed to decide how much memory,
 *     database or screen the app spends on it.
 *   * **Text, never markup.** Strings arrive already stripped of control
 *     characters and truncated by `manifest.ts`, and the UI renders them as
 *     React text nodes — there is no `dangerouslySetInnerHTML` anywhere in
 *     this feature, so a `<script>` in a pack name is just characters.
 *   * **Failure is per source.** Every fetch is isolated: a malformed or
 *     oversized document marks *that* source not-ok with a visible error and
 *     leaves every other source, and the rest of the Bazaar, working.
 */

import { PackError, parseIndex, parseJson, parseManifest, utf8Size } from './manifest';
import type { RawIndexEntry } from './manifest';
import type { HostBridge } from '../host/types';
import type { BazaarEntry, BazaarSource, Pack, PackManifest } from './types';
import type { Packs } from './packs';
import { SafeDb, asBool, asString, intOr, nonEmpty } from '../library/repo';
import type { LibraryErrorSink } from '../library/repo';

/** Contract caps. Raising any of these is a change to `docs/packs.md`. */
export const MAX_PACKS_PER_INDEX = 500;
export const MAX_TRACKS_PER_PACK = 5000;
export const MAX_INDEX_BYTES = 1024 * 1024;
export const MAX_PACK_BYTES = 2 * 1024 * 1024;

/** A stranger's server must not be able to hold a request open. */
const FETCH_TIMEOUT_MS = 15_000;
/** Indexes are small and change slowly; this keeps a browse from re-fetching. */
const INDEX_CACHE_TTL_SEC = 300;
/** Where a fetched catalogue is parked between sessions. */
const CACHE_PREFIX = 'bazaar:index:';

export class Bazaar {
  private readonly db: SafeDb;
  /** Last good catalogue per source url; survives a failed refresh. */
  private readonly cache = new Map<string, BazaarEntry[]>();

  constructor(private readonly host: HostBridge, private readonly packs: Packs) {
    this.db = new SafeDb(host);
  }

  get onError(): LibraryErrorSink | undefined {
    return this.db.onError;
  }

  set onError(fn: LibraryErrorSink | undefined) {
    this.db.onError = fn;
  }

  async sources(): Promise<BazaarSource[]> {
    const rows = await this.db.query(
      'SELECT url, name, added_at, last_fetch_at, ok, error FROM bazaar_sources ORDER BY added_at ASC',
    );
    const out: BazaarSource[] = [];
    for (const row of rows) {
      const url = nonEmpty(asString(row.url));
      if (url === undefined) continue;
      const source: BazaarSource = {
        url,
        name: nonEmpty(asString(row.name)),
        addedAt: intOr(row.added_at, 0),
        ok: asBool(row.ok),
        error: nonEmpty(asString(row.error)),
      };
      const fetchedAt = intOr(row.last_fetch_at, 0);
      if (fetchedAt > 0) source.lastFetchAt = fetchedAt;
      const cached = await this.cachedEntries(url);
      if (cached !== undefined) source.packCount = cached.length;
      out.push(source);
    }
    return out;
  }

  /** Validates the url, stores it, then fetches immediately. */
  async addSource(url: string): Promise<BazaarSource> {
    const safe = requireWebUrl(url, 'source');
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO bazaar_sources (url, name, added_at, last_fetch_at, ok, error)
       VALUES (?, NULL, ?, NULL, 1, NULL)
       ON CONFLICT(url) DO NOTHING`,
      [safe, now],
    );
    await this.refresh(safe);
    const listed = await this.sources();
    return listed.find((source) => source.url === safe)
      ?? { url: safe, addedAt: now, ok: true };
  }

  async removeSource(url: string): Promise<void> {
    this.cache.delete(url);
    await this.db.execute('DELETE FROM bazaar_sources WHERE url = ?', [url]);
    try {
      await this.host.kv.remove(CACHE_PREFIX + url);
    } catch {
      // No key-value store (the web host may have none) is not a failure to
      // remove a source: the row is already gone.
    }
  }

  /** Refreshes one source, or every subscribed source when `url` is omitted. */
  async refresh(url?: string): Promise<void> {
    if (url !== undefined) {
      await this.refreshOne(url);
      return;
    }
    const sources = await this.sources();
    // Sequential on purpose: a browse of ten sources should not open ten
    // sockets at once, and one slow host must not delay the others' rows by
    // holding a shared batch open.
    for (const source of sources) await this.refreshOne(source.url);
  }

  /** Everything the subscribed sources currently offer. */
  async catalogue(): Promise<BazaarEntry[]> {
    const sources = await this.sources();
    const out: BazaarEntry[] = [];
    for (const source of sources) {
      let entries = await this.cachedEntries(source.url);
      if (entries === undefined && source.ok) {
        // First browse of the session: fill the cache rather than showing an
        // empty Bazaar next to a source that is perfectly fine.
        await this.refreshOne(source.url);
        entries = await this.cachedEntries(source.url);
      }
      if (entries !== undefined) out.push(...entries);
    }
    return out;
  }

  /** Fetches the entry's `pack.json` and installs it, origin recorded. */
  async installFromBazaar(entry: BazaarEntry): Promise<Pack> {
    const manifest = await this.fetchManifest(entry);
    return this.packs.install(manifest, {
      sourceUrl: entry.sourceUrl,
      packUrl: entry.url,
    });
  }

  /** The pack a card is previewing, without installing anything. */
  async preview(entry: BazaarEntry): Promise<PackManifest> {
    return this.fetchManifest(entry);
  }

  // ── fetching ──────────────────────────────────────────────────────────────

  private async fetchManifest(entry: BazaarEntry): Promise<PackManifest> {
    // Re-checked here and not only when the index was parsed: an entry may have
    // been held in the cache across a session, and this is the call that opens
    // the socket.
    const packUrl = requireSameOrigin(entry.url, entry.sourceUrl, 'pack');
    const body = await this.fetchText(packUrl, MAX_PACK_BYTES, 0);
    const manifest = parseManifest(parseJson(body), { maxTracks: MAX_TRACKS_PER_PACK });
    const artwork = manifest.artwork;
    if (artwork !== undefined) {
      // Relative to the pack file, and it has to stay on the publisher's own
      // origin; anything else is dropped rather than refused, because a bad
      // cover must not cost the user the pack.
      const resolved = sameOriginOrUndefined(artwork, packUrl);
      if (resolved === undefined) delete manifest.artwork;
      else manifest.artwork = resolved;
    }
    return manifest;
  }

  private async refreshOne(url: string): Promise<void> {
    const now = Date.now();
    try {
      const safe = requireWebUrl(url, 'source');
      const body = await this.fetchText(safe, MAX_INDEX_BYTES, INDEX_CACHE_TTL_SEC);
      const index = parseIndex(parseJson(body), { maxPacks: MAX_PACKS_PER_INDEX });

      const entries: BazaarEntry[] = [];
      for (const raw of index.packs) {
        const entry = toEntry(raw, safe, index.name);
        // One unusable row does not condemn the index: the publisher may have
        // a single typo'd url among 200 good packs.
        if (entry !== undefined) entries.push(entry);
      }

      this.cache.set(url, entries);
      await this.writeCache(url, entries);
      await this.db.execute(
        'UPDATE bazaar_sources SET name = ?, last_fetch_at = ?, ok = 1, error = NULL WHERE url = ?',
        [index.name ?? null, now, url],
      );
    } catch (err) {
      // A bad source is disabled with a visible reason and nothing else moves.
      await this.db.execute(
        'UPDATE bazaar_sources SET last_fetch_at = ?, ok = 0, error = ? WHERE url = ?',
        [now, describe(err), url],
      );
    }
  }

  /**
   * One HTTP GET with a hard ceiling on what it may return. The cap is checked
   * against the declared `Content-Length` *and* the body that arrived, because
   * a hostile server is free to lie in either direction.
   */
  private async fetchText(url: string, maxBytes: number, cacheTtlSec: number): Promise<string> {
    let status: number;
    let body: string;
    let headers: Record<string, string>;
    try {
      const res = await this.host.http.request({
        url,
        method: 'GET',
        timeoutMs: FETCH_TIMEOUT_MS,
        cacheTtlSec,
      });
      status = res.status;
      body = res.body;
      headers = res.headers;
    } catch (err) {
      throw new PackError('network', `${url} could not be fetched`, err);
    }

    if (status < 200 || status >= 300) {
      throw new PackError('network', `${url} answered HTTP ${status}`);
    }
    const declared = Number(headerValue(headers, 'content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new PackError('too_large', `${url} declares ${declared} bytes, over the ${maxBytes} limit`);
    }
    const size = utf8Size(body);
    if (size > maxBytes) {
      throw new PackError('too_large', `${url} is ${size} bytes, over the ${maxBytes} limit`);
    }
    return body;
  }

  // ── catalogue cache ───────────────────────────────────────────────────────

  private async cachedEntries(url: string): Promise<BazaarEntry[] | undefined> {
    const live = this.cache.get(url);
    if (live !== undefined) return live;
    let raw: string | undefined;
    try {
      raw = await this.host.kv.get(CACHE_PREFIX + url);
    } catch {
      return undefined;
    }
    if (raw === undefined || raw.length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;

    // The cache is re-validated on read: it was written by this app, but it
    // holds a stranger's strings and the rules may have tightened since.
    const entries: BazaarEntry[] = [];
    for (const item of parsed) {
      const entry = reviveEntry(item, url);
      if (entry !== undefined) entries.push(entry);
    }
    this.cache.set(url, entries);
    return entries;
  }

  private async writeCache(url: string, entries: BazaarEntry[]): Promise<void> {
    try {
      await this.host.kv.set(CACHE_PREFIX + url, JSON.stringify(entries));
    } catch {
      // Degrade, never propagate: without a key-value store the catalogue is
      // simply re-fetched next session.
    }
  }
}

// ── url rules ───────────────────────────────────────────────────────────────

function parseUrl(raw: string, base?: string): URL | undefined {
  try {
    return base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return undefined;
  }
}

function isWeb(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** An absolute `http`/`https` url, or a `PackError`. */
export function requireWebUrl(raw: string, what: string): string {
  const trimmed = raw.trim();
  const url = parseUrl(trimmed);
  if (url === undefined) throw new PackError('unsafe_url', `${what} url is not a url: ${trimmed}`);
  if (!isWeb(url)) {
    throw new PackError('unsafe_url', `${what} url must be http or https, not ${url.protocol}`);
  }
  return url.toString();
}

/**
 * Resolves `raw` against `base` — so a relative path works and a publisher can
 * move their whole tree — and refuses anything that lands on another origin.
 */
export function requireSameOrigin(raw: string, base: string, what: string): string {
  const parent = parseUrl(base);
  if (parent === undefined || !isWeb(parent)) {
    throw new PackError('unsafe_url', `${what} has no usable index url`);
  }
  const url = parseUrl(raw.trim(), parent.toString());
  if (url === undefined) throw new PackError('unsafe_url', `${what} url is not a url: ${raw}`);
  if (!isWeb(url)) {
    throw new PackError('unsafe_url', `${what} url must be http or https, not ${url.protocol}`);
  }
  if (url.origin !== parent.origin) {
    throw new PackError(
      'unsafe_url',
      `${what} url ${url.origin} is outside the index's own origin ${parent.origin}`,
    );
  }
  return url.toString();
}

function sameOriginOrUndefined(raw: string, base: string): string | undefined {
  try {
    return requireSameOrigin(raw, base, 'artwork');
  } catch {
    return undefined;
  }
}

// ── index entries ───────────────────────────────────────────────────────────

function toEntry(
  raw: RawIndexEntry,
  sourceUrl: string,
  sourceName: string | undefined,
): BazaarEntry | undefined {
  let url: string;
  try {
    url = requireSameOrigin(raw.url, sourceUrl, 'pack');
  } catch {
    return undefined;
  }
  const entry: BazaarEntry = {
    sourceUrl,
    sourceName,
    id: raw.id,
    name: raw.name,
    description: raw.description,
    author: raw.author,
    trackCount: Math.min(raw.trackCount, MAX_TRACKS_PER_PACK),
    url,
    updatedAt: raw.updatedAt,
  };
  if (raw.artwork !== undefined) {
    entry.artwork = sameOriginOrUndefined(raw.artwork, sourceUrl);
  }
  return entry;
}

/** A cached entry back into a validated one; anything off is dropped. */
function reviveEntry(value: unknown, sourceUrl: string): BazaarEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const url = asString(raw.url);
  const name = asString(raw.name);
  const id = asString(raw.id);
  if (url === undefined || name === undefined || id === undefined) return undefined;
  return toEntry(
    {
      id,
      name,
      description: nonEmpty(asString(raw.description)),
      author: nonEmpty(asString(raw.author)),
      trackCount: intOr(raw.trackCount, 0),
      artwork: nonEmpty(asString(raw.artwork)),
      url,
      updatedAt: intOr(raw.updatedAt, 0),
    },
    sourceUrl,
    nonEmpty(asString(raw.sourceName)),
  );
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function describe(err: unknown): string {
  if (err instanceof PackError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
