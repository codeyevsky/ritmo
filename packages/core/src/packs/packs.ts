/**
 * Packs — named, ordered, shareable sets of tracks.
 *
 * Storage mirrors `playlists.ts`: `pack_items.position` is a dense 0-based
 * ordinal and every mutation reads the list, splices it in memory and rewrites
 * the whole thing inside one transaction, because patching `position ± 1` is
 * where off-by-one bugs silently duplicate or drop rows.
 *
 * What differs is that a pack row remembers *two* things per entry. `match_json`
 * is the manifest entry as written, `track_json` is the resolved snapshot — and
 * the second one is allowed to be NULL. That is the whole point of the format:
 * an entry nothing can resolve today is kept and shown as unavailable, so a
 * pack never loses tracks just because a subscriber lacks a source.
 */

import { pLimit } from '../util/async';
import { dedupeTracks } from '../search';
import { SafeDb, asString, chunk, intOr, nonEmpty, parseArtwork, parseTrackSnapshot } from '../library/repo';
import type { DbStatement, LibraryErrorSink, Repo } from '../library/repo';
import type { HostBridge } from '../host/types';
import type { ProviderRegistry } from '../providers/registry';
import type { MusicProvider } from '../providers/types';
import type { Artwork, Track, Uri } from '../types';
import { bestMatch, probesFor, searchTextFor } from './match';
import { entryFromTrack, newPackId, packIdOf, packUri, parseManifest } from './manifest';
import { PACK_FORMAT, PACK_VERSION } from './types';
import type { InstallReport, Pack, PackEntry, PackItem, PackManifest } from './types';

/** 6 columns per row ⇒ 480 bound parameters at worst, inside SQLite's 999. */
const PACK_ROWS_PER_INSERT = 80;
/** Installing a 200-track pack must not open 200 requests. */
const RESOLVE_CONCURRENCY = 4;
/** Per-provider candidates for the fuzzy pass; more only costs bandwidth. */
const CANDIDATES_PER_PROVIDER = 8;

const ITEM_COLUMNS = 'pack_uri, position, match_json, track_json, track_uri, added_at';

const PACK_WITH_COUNTS = `SELECT p.*,
    (SELECT COUNT(*) FROM pack_items i WHERE i.pack_uri = p.uri) AS track_count,
    (SELECT COUNT(*) FROM pack_items i WHERE i.pack_uri = p.uri AND i.track_uri IS NULL)
      AS unavailable_count
  FROM packs p`;

interface StoredItem {
  entry: PackEntry;
  entryJson: string;
  track: Track | undefined;
  trackJson: string | null;
  trackUri: Uri | null;
  addedAt: number;
  /** Position as stored; meaningless once an item list has been spliced. */
  position: number;
}

export interface PackPatch {
  name?: string;
  description?: string;
  author?: string;
  artwork?: Artwork;
}

export interface PackCreateOptions {
  description?: string;
  author?: string;
  tracks?: Track[];
}

export interface PackOrigin {
  /** The `index.json` it came from, for updates. */
  sourceUrl?: string;
  /** The `pack.json` it came from. */
  packUrl?: string;
}

export class Packs {
  private readonly db: SafeDb;

  constructor(
    host: HostBridge,
    private readonly repo: Repo,
    private readonly registry: ProviderRegistry,
  ) {
    this.db = new SafeDb(host);
  }

  get onError(): LibraryErrorSink | undefined {
    return this.db.onError;
  }

  set onError(fn: LibraryErrorSink | undefined) {
    this.db.onError = fn;
  }

  async list(): Promise<Pack[]> {
    const rows = await this.db.query(
      `${PACK_WITH_COUNTS} ORDER BY p.sort_order ASC, p.updated_at DESC`,
    );
    return rows.map(rowToPack);
  }

  async get(uri: Uri, withTracks = false): Promise<Pack | undefined> {
    const row = await this.db.one(`${PACK_WITH_COUNTS} WHERE p.uri = ?`, [uri]);
    if (row === undefined) return undefined;
    const pack = rowToPack(row);
    if (!withTracks) return pack;

    const items = await this.loadItems(uri);
    pack.items = items.map((item, position) => {
      const out: PackItem = { position, entry: item.entry, addedAt: item.addedAt };
      if (item.track !== undefined) out.track = item.track;
      return out;
    });
    pack.tracks = items
      .map((item) => item.track)
      .filter((track): track is Track => track !== undefined);
    pack.trackCount = items.length;
    pack.unavailableCount = items.length - pack.tracks.length;
    return pack;
  }

  async create(name: string, opts?: PackCreateOptions): Promise<Pack> {
    const tracks = opts?.tracks ?? [];
    const now = Date.now();
    const id = newPackId();
    const uri = packUri(id);
    const label = nonEmpty(name.trim()) ?? 'Untitled pack';

    if (tracks.length > 0) await this.repo.upsertTracks(tracks);

    const sortOrder = await this.db.number(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM packs',
      [],
      0,
    );
    await this.db.transaction([
      {
        sql: `INSERT INTO packs (uri, name, description, author, artwork_json, source,
                source_url, pack_url, remote_id, created_at, updated_at, sort_order)
              VALUES (?, ?, ?, ?, NULL, 'local', NULL, NULL, ?, ?, ?, ?)`,
        params: [
          uri,
          label,
          nonEmpty(opts?.description?.trim()) ?? null,
          nonEmpty(opts?.author?.trim()) ?? null,
          id,
          now,
          now,
          sortOrder,
        ],
      },
      ...insertItems(uri, tracks.map((track) => storedFromTrack(track, now))),
    ]);

    return {
      uri,
      id,
      name: label,
      description: nonEmpty(opts?.description?.trim()),
      author: nonEmpty(opts?.author?.trim()),
      source: 'local',
      remoteId: id,
      createdAt: now,
      updatedAt: now,
      trackCount: tracks.length,
      unavailableCount: 0,
    };
  }

  async update(uri: Uri, patch: PackPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(nonEmpty(patch.name.trim()) ?? 'Untitled pack');
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(nonEmpty(patch.description.trim()) ?? null);
    }
    if (patch.author !== undefined) {
      sets.push('author = ?');
      params.push(nonEmpty(patch.author.trim()) ?? null);
    }
    if (patch.artwork !== undefined) {
      sets.push('artwork_json = ?');
      params.push(artworkJson(patch.artwork));
    }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(Date.now(), uri);
    await this.db.execute(`UPDATE packs SET ${sets.join(', ')} WHERE uri = ?`, params);
  }

  async remove(uri: Uri): Promise<void> {
    // `pack_items` cascades on delete, so one statement is enough.
    await this.db.execute('DELETE FROM packs WHERE uri = ?', [uri]);
  }

  async addTracks(uri: Uri, tracks: Track[], at?: number): Promise<void> {
    if (tracks.length === 0) return;
    await this.repo.upsertTracks(tracks);
    const now = Date.now();
    const items = await this.loadItems(uri);
    const insertAt = at === undefined
      ? items.length
      : Math.min(items.length, Math.max(0, Math.trunc(at)));
    await this.rewrite(uri, [
      ...items.slice(0, insertAt),
      ...tracks.map((track) => storedFromTrack(track, now)),
      ...items.slice(insertAt),
    ], now);
  }

  async removeAt(uri: Uri, positions: number[]): Promise<void> {
    if (positions.length === 0) return;
    const drop = new Set(positions.map((p) => Math.trunc(p)));
    const items = await this.loadItems(uri);
    const next = items.filter((item) => !drop.has(item.position));
    if (next.length === items.length) return;
    await this.rewrite(uri, next, Date.now());
  }

  async move(uri: Uri, from: number, to: number): Promise<void> {
    const items = await this.loadItems(uri);
    const src = Math.trunc(from);
    if (src < 0 || src >= items.length) return;
    const moved = items[src];
    if (moved === undefined) return;
    const dst = Math.min(items.length - 1, Math.max(0, Math.trunc(to)));
    if (dst === src) return;
    const next = [...items];
    next.splice(src, 1);
    next.splice(dst, 0, moved);
    await this.rewrite(uri, next, Date.now());
  }

  async setSortOrder(order: Uri[]): Promise<void> {
    if (order.length === 0) return;
    await this.db.batched(
      order.map((uri, index) => ({
        sql: 'UPDATE packs SET sort_order = ? WHERE uri = ?',
        params: [index, uri],
      })),
    );
  }

  /** Every pack holding this track, for the "Add to pack" check marks. */
  async containing(trackUri: Uri): Promise<Pack[]> {
    const rows = await this.db.query(
      `${PACK_WITH_COUNTS}
        WHERE EXISTS (SELECT 1 FROM pack_items i WHERE i.pack_uri = p.uri AND i.track_uri = ?)
        ORDER BY p.sort_order ASC, p.updated_at DESC`,
      [trackUri],
    );
    return rows.map(rowToPack);
  }

  /** Serialise to the `pack.json` shape in docs/packs.md. */
  async toManifest(uri: Uri): Promise<PackManifest> {
    const pack = await this.get(uri);
    const items = await this.loadItems(uri);
    const now = Date.now();
    const manifest: PackManifest = {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      id: pack?.remoteId ?? packIdOf(uri),
      name: pack?.name ?? 'Untitled pack',
      createdAt: pack?.createdAt ?? now,
      updatedAt: pack?.updatedAt ?? now,
      tracks: items.map((item) => item.entry),
    };
    if (pack?.description !== undefined) manifest.description = pack.description;
    if (pack?.author !== undefined) manifest.author = pack.author;
    // Only an http(s) cover survives a round trip: a local cache path means
    // nothing on the machine that installs the pack. Publishing rewrites this
    // to the `covers/` file it copied.
    const cover = pack?.artwork?.sources.filter((s) => isRemoteUrl(s.url)).pop();
    if (cover !== undefined) manifest.artwork = cover.url;
    return manifest;
  }

  /**
   * Import a manifest, resolving each entry. Unresolved entries are **kept** —
   * `install` never drops a track, it only records that nothing serves it yet.
   */
  async install(manifest: PackManifest, origin?: PackOrigin): Promise<Pack> {
    const safe = parseManifest(manifest);
    const now = Date.now();
    const id = newPackId();
    const uri = packUri(id);
    const remote = origin?.packUrl !== undefined || origin?.sourceUrl !== undefined;

    const resolved = await this.resolveAll(safe.tracks);
    const tracks = resolved.filter((track): track is Track => track !== undefined);
    if (tracks.length > 0) await this.repo.upsertTracks(tracks);

    const sortOrder = await this.db.number(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM packs',
      [],
      0,
    );
    const items = safe.tracks.map((entry, index) => storedFromEntry(entry, resolved[index], now));

    await this.db.transaction([
      {
        sql: `INSERT INTO packs (uri, name, description, author, artwork_json, source,
                source_url, pack_url, remote_id, created_at, updated_at, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          uri,
          safe.name,
          safe.description ?? null,
          safe.author ?? null,
          artworkJson(remoteArtwork(safe.artwork)),
          remote ? 'remote' : 'local',
          origin?.sourceUrl ?? null,
          origin?.packUrl ?? null,
          safe.id,
          safe.createdAt,
          now,
          sortOrder,
        ],
      },
      ...insertItems(uri, items),
    ]);

    const installed = await this.get(uri);
    return installed ?? {
      uri,
      id,
      name: safe.name,
      source: remote ? 'remote' : 'local',
      remoteId: safe.id,
      createdAt: safe.createdAt,
      updatedAt: now,
      trackCount: items.length,
      unavailableCount: items.length - tracks.length,
    };
  }

  /** Re-resolve only the unavailable entries of an installed pack. */
  async reresolve(uri: Uri): Promise<InstallReport> {
    const items = await this.loadItems(uri);
    const pending = items.filter((item) => item.track === undefined);
    if (pending.length === 0) {
      return { resolved: items.length, unavailable: 0 };
    }

    const found = await this.resolveAll(pending.map((item) => item.entry));
    const tracks = found.filter((track): track is Track => track !== undefined);
    if (tracks.length > 0) await this.repo.upsertTracks(tracks);

    // Positions are untouched, so the rows are patched in place rather than
    // rewritten: a re-resolve must never reorder a pack.
    const statements: DbStatement[] = [];
    pending.forEach((item, index) => {
      const track = found[index];
      if (track === undefined) return;
      statements.push({
        sql: 'UPDATE pack_items SET track_json = ?, track_uri = ? WHERE pack_uri = ? AND position = ?',
        params: [JSON.stringify(track), track.uri, uri, item.position],
      });
    });
    if (statements.length > 0) {
      statements.push({
        sql: 'UPDATE packs SET updated_at = ? WHERE uri = ?',
        params: [Date.now(), uri],
      });
      await this.db.batched(statements);
    }

    const stillMissing = pending.length - tracks.length;
    return { resolved: items.length - stillMissing, unavailable: stillMissing };
  }

  // ── resolution ────────────────────────────────────────────────────────────

  private resolveAll(entries: readonly PackEntry[]): Promise<Array<Track | undefined>> {
    const limit = pLimit(RESOLVE_CONCURRENCY);
    return Promise.all(entries.map((entry) => limit(() => this.resolveEntry(entry))));
  }

  /**
   * The contract's order: the exact provider `uri`, then the local library,
   * then a fuzzy match across the enabled providers. Each step is allowed to
   * fail quietly — a dead source means "unavailable", never a rejected import.
   */
  private async resolveEntry(entry: PackEntry): Promise<Track | undefined> {
    const exact = await this.resolveByUri(entry.uri);
    if (exact !== undefined) return exact;

    const local = await this.resolveLocally(entry);
    if (local !== undefined) return local;

    return this.resolveAcrossProviders(entry);
  }

  private async resolveByUri(uri: Uri | undefined): Promise<Track | undefined> {
    if (uri === undefined || uri.length === 0) return undefined;
    const known = await this.repo.getTrack(uri);
    if (known !== undefined) return known;
    // A uri whose provider is not enabled is not an error: the fuzzy pass may
    // still find the same recording somewhere the user does have.
    if (this.registry.forUri(uri) === undefined) return undefined;
    try {
      return await this.registry.resolveTrack(uri);
    } catch {
      return undefined;
    }
  }

  private async resolveLocally(entry: PackEntry): Promise<Track | undefined> {
    for (const text of probesFor(entry)) {
      const found = await this.repo.searchLocal(text, CANDIDATES_PER_PROVIDER);
      const match = bestMatch(entry, found.tracks);
      if (match !== undefined) return match;
    }
    return undefined;
  }

  private async resolveAcrossProviders(entry: PackEntry): Promise<Track | undefined> {
    const providers = await this.searchableProviders();
    if (providers.length === 0) return undefined;

    const text = searchTextFor(entry);
    const parts = await Promise.all(providers.map(async (provider) => {
      try {
        const results = await this.registry.run(provider.id, 'search', (p) =>
          p.search({ text, kinds: ['track'], limit: CANDIDATES_PER_PROVIDER }));
        return results.tracks;
      } catch {
        return [];
      }
    }));

    // Deduped first so the candidate list is one row per recording, from the
    // highest-priority provider that offered it.
    return bestMatch(entry, dedupeTracks(parts.flat()));
  }

  /** Enabled, configured, network-permitted providers that can be searched. */
  private async searchableProviders(): Promise<MusicProvider[]> {
    try {
      return (await this.registry.ready()).filter((p) => p.capabilities.search);
    } catch {
      return [];
    }
  }

  // ── storage ───────────────────────────────────────────────────────────────

  private async loadItems(uri: Uri): Promise<StoredItem[]> {
    const rows = await this.db.query(
      `SELECT position, match_json, track_json, track_uri, added_at FROM pack_items
        WHERE pack_uri = ? ORDER BY position ASC`,
      [uri],
    );
    const out: StoredItem[] = [];
    for (const row of rows) {
      const entryJson = asString(row.match_json);
      if (entryJson === undefined) continue;
      let entry: PackEntry;
      try {
        entry = parseManifestEntry(JSON.parse(entryJson) as unknown);
      } catch {
        continue;
      }
      const trackJson = nonEmpty(asString(row.track_json));
      const track = trackJson === undefined ? undefined : parseTrackSnapshot(trackJson);
      out.push({
        entry,
        entryJson,
        track,
        trackJson: track === undefined ? null : trackJson ?? null,
        trackUri: track?.uri ?? null,
        addedAt: intOr(row.added_at, Date.now()),
        position: intOr(row.position, out.length),
      });
    }
    return out;
  }

  /**
   * One transaction even when the item count passes the usual batch: a
   * partially rewritten pack would have duplicate or missing positions, which
   * is worse than a long commit.
   */
  private async rewrite(uri: Uri, items: StoredItem[], now: number): Promise<void> {
    await this.db.transaction([
      { sql: 'DELETE FROM pack_items WHERE pack_uri = ?', params: [uri] },
      ...insertItems(uri, items),
      { sql: 'UPDATE packs SET updated_at = ? WHERE uri = ?', params: [now, uri] },
    ]);
  }
}

// ── row/entry mapping ───────────────────────────────────────────────────────

function rowToPack(r: Record<string, unknown>): Pack {
  const uri = asString(r.uri) ?? '';
  const pack: Pack = {
    uri,
    id: packIdOf(uri),
    name: asString(r.name) ?? 'Untitled pack',
    description: nonEmpty(asString(r.description)),
    author: nonEmpty(asString(r.author)),
    artwork: parseArtwork(r.artwork_json),
    source: asString(r.source) === 'remote' ? 'remote' : 'local',
    sourceUrl: nonEmpty(asString(r.source_url)),
    packUrl: nonEmpty(asString(r.pack_url)),
    remoteId: nonEmpty(asString(r.remote_id)),
    createdAt: intOr(r.created_at, 0),
    updatedAt: intOr(r.updated_at, 0),
    trackCount: intOr(r.track_count, 0),
    unavailableCount: intOr(r.unavailable_count, 0),
  };
  return pack;
}

/** A stored `match_json` blob back into an entry; malformed rows are skipped. */
function parseManifestEntry(value: unknown): PackEntry {
  const manifest = parseManifest({
    format: PACK_FORMAT,
    version: PACK_VERSION,
    tracks: [value],
  });
  const entry = manifest.tracks[0];
  if (entry === undefined) throw new Error('unusable pack item');
  return entry;
}

function storedFromTrack(track: Track, now: number): StoredItem {
  const entry = entryFromTrack(track);
  return {
    entry,
    entryJson: JSON.stringify(entry),
    track,
    trackJson: JSON.stringify(track),
    trackUri: track.uri,
    addedAt: now,
    position: -1,
  };
}

function storedFromEntry(entry: PackEntry, track: Track | undefined, now: number): StoredItem {
  return {
    entry,
    entryJson: JSON.stringify(entry),
    track,
    trackJson: track === undefined ? null : JSON.stringify(track),
    trackUri: track?.uri ?? null,
    addedAt: now,
    position: -1,
  };
}

function insertItems(uri: Uri, items: readonly StoredItem[]): DbStatement[] {
  if (items.length === 0) return [];
  const out: DbStatement[] = [];
  let position = 0;
  for (const group of chunk(items, PACK_ROWS_PER_INSERT)) {
    const tuples: string[] = [];
    const params: unknown[] = [];
    for (const item of group) {
      tuples.push('(?, ?, ?, ?, ?, ?)');
      params.push(uri, position, item.entryJson, item.trackJson, item.trackUri, item.addedAt);
      position += 1;
    }
    out.push({
      sql: `INSERT INTO pack_items (${ITEM_COLUMNS}) VALUES ${tuples.join(', ')}`,
      params,
    });
  }
  return out;
}

function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Manifest artwork is only trusted when it is already an absolute web URL. */
function remoteArtwork(url: string | undefined): Artwork | undefined {
  if (url === undefined || !isRemoteUrl(url)) return undefined;
  return { sources: [{ url, size: 0 }] };
}

function artworkJson(artwork: Artwork | undefined): string | null {
  if (artwork === undefined) return null;
  if (artwork.sources.length === 0 && artwork.placeholder === undefined) return null;
  return JSON.stringify(artwork);
}
