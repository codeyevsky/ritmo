/**
 * User playlists.
 *
 * `playlist_items.position` is a dense, 0-based ordinal and every mutation here
 * keeps it that way by reading the item list, splicing it in memory and
 * rewriting the whole list inside a single transaction. That is deliberately
 * blunt: patching individual rows with `position = position ± 1` is where
 * off-by-one bugs silently duplicate or drop tracks, and the schema's own note
 * says a rewrite is the cheaper trade at playlist sizes.
 *
 * Each row also carries a full `track_json` snapshot, so a playlist keeps
 * rendering after a remote provider goes away or rate-limits us.
 */

import type { Artwork, Playlist, Track, Uri } from '../types';
import type { HostBridge } from '../host/types';
import type { DbStatement, LibraryErrorSink, Repo } from './repo';
import {
  ROWS_PER_INSERT, SafeDb, asString, chunk, intOr, nonEmpty,
  parsePlaylistSnapshot, parseTrackSnapshot, placeholders, rowToPlaylist,
} from './repo';

const ITEM_COLUMNS = 'playlist_uri, position, track_uri, track_json, added_at';

const PLAYLIST_WITH_COUNT = `SELECT p.*,
    (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_uri = p.uri) AS track_count
  FROM playlists p`;

/** Monotonic within a process; combined with the wall clock it cannot collide. */
let uriCounter = 0;

function newPlaylistUri(): Uri {
  uriCounter += 1;
  return `ritmo:playlist:${Date.now()}-${uriCounter}`;
}

interface StoredItem {
  trackUri: Uri;
  trackJson: string;
  addedAt: number;
  /** Position as stored; meaningless once an item list has been spliced. */
  position: number;
}

export class Playlists {
  private readonly db: SafeDb;

  constructor(host: HostBridge, private readonly repo: Repo) {
    this.db = new SafeDb(host);
  }

  get onError(): LibraryErrorSink | undefined {
    return this.db.onError;
  }

  set onError(fn: LibraryErrorSink | undefined) {
    this.db.onError = fn;
  }

  async list(): Promise<Playlist[]> {
    const rows = await this.db.query(
      `${PLAYLIST_WITH_COUNT} ORDER BY p.sort_order ASC, p.updated_at DESC`,
    );
    return rows.map(rowToPlaylist);
  }

  async get(uri: Uri, withTracks = false): Promise<Playlist | undefined> {
    const row = await this.db.one(`${PLAYLIST_WITH_COUNT} WHERE p.uri = ?`, [uri]);
    if (row === undefined) return undefined;
    const playlist = rowToPlaylist(row);
    if (!withTracks) return playlist;
    playlist.tracks = await this.tracksOf(uri);
    playlist.trackCount = playlist.tracks.length;
    return playlist;
  }

  async create(name: string, opts?: { description?: string; tracks?: Track[] }): Promise<Playlist> {
    const uri = newPlaylistUri();
    const now = Date.now();
    const label = nonEmpty(name.trim()) ?? 'Untitled playlist';
    const description = nonEmpty(opts?.description?.trim());
    const tracks = opts?.tracks ?? [];
    const sortOrder = await this.db.number(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM playlists',
      [],
      0,
    );

    if (tracks.length > 0) await this.repo.upsertTracks(tracks);

    const statements: DbStatement[] = [
      {
        sql: `INSERT INTO playlists (uri, provider, name, description, artwork_json, owner, editable, created_at, updated_at, sort_order)
              VALUES (?, 'ritmo', ?, ?, NULL, NULL, 1, ?, ?, ?)`,
        params: [uri, label, description ?? null, now, now, sortOrder],
      },
      ...insertItems(uri, tracks.map((t) => toStored(t, now))),
    ];
    await this.db.transaction(statements);

    return {
      uri,
      provider: 'ritmo',
      name: label,
      description,
      editable: true,
      trackCount: tracks.length,
      tracks: tracks.length > 0 ? [...tracks] : undefined,
    };
  }

  async rename(uri: Uri, name: string): Promise<void> {
    const label = nonEmpty(name.trim()) ?? 'Untitled playlist';
    await this.db.execute('UPDATE playlists SET name = ?, updated_at = ? WHERE uri = ?', [
      label, Date.now(), uri,
    ]);
  }

  async setDescription(uri: Uri, description: string): Promise<void> {
    await this.db.execute('UPDATE playlists SET description = ?, updated_at = ? WHERE uri = ?', [
      nonEmpty(description.trim()) ?? null, Date.now(), uri,
    ]);
  }

  async setArtwork(uri: Uri, artwork: Artwork | undefined): Promise<void> {
    const json =
      artwork === undefined || (artwork.sources.length === 0 && artwork.placeholder === undefined)
        ? null
        : JSON.stringify(artwork);
    await this.db.execute('UPDATE playlists SET artwork_json = ?, updated_at = ? WHERE uri = ?', [
      json, Date.now(), uri,
    ]);
  }

  async remove(uri: Uri): Promise<void> {
    // `playlist_items` cascades on delete, so one statement is enough.
    await this.db.execute('DELETE FROM playlists WHERE uri = ?', [uri]);
  }

  async addTracks(uri: Uri, tracks: Track[], at?: number): Promise<void> {
    if (tracks.length === 0) return;
    await this.repo.upsertTracks(tracks);
    const now = Date.now();
    const items = await this.loadItems(uri);
    const insertAt = at === undefined
      ? items.length
      : Math.min(items.length, Math.max(0, Math.trunc(at)));
    const next = [
      ...items.slice(0, insertAt),
      ...tracks.map((t) => toStored(t, now)),
      ...items.slice(insertAt),
    ];
    await this.rewrite(uri, next, now);
  }

  async removeTracks(uri: Uri, positions: number[]): Promise<void> {
    if (positions.length === 0) return;
    const drop = new Set(positions.map((p) => Math.trunc(p)));
    const items = await this.loadItems(uri);
    const next = items.filter((item) => !drop.has(item.position));
    if (next.length === items.length) return;
    await this.rewrite(uri, next, Date.now());
  }

  async removeTrackUri(uri: Uri, trackUri: Uri): Promise<void> {
    const items = await this.loadItems(uri);
    const next = items.filter((item) => item.trackUri !== trackUri);
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

  /**
   * `orderedTrackIds` are the current `position` values in their new order.
   * Positions the caller left out keep their relative order and are appended,
   * so a stale drag never truncates a playlist.
   */
  async reorder(uri: Uri, orderedTrackIds: number[]): Promise<void> {
    const items = await this.loadItems(uri);
    if (items.length === 0) return;
    const byPosition = new Map<number, StoredItem>();
    for (const item of items) byPosition.set(item.position, item);

    const next: StoredItem[] = [];
    const used = new Set<number>();
    for (const raw of orderedTrackIds) {
      const position = Math.trunc(raw);
      const item = byPosition.get(position);
      if (item === undefined || used.has(position)) continue;
      used.add(position);
      next.push(item);
    }
    for (const item of items) {
      if (!used.has(item.position)) next.push(item);
    }
    await this.rewrite(uri, next, Date.now());
  }

  async duplicate(uri: Uri, name?: string): Promise<Playlist> {
    const source = await this.db.one(`${PLAYLIST_WITH_COUNT} WHERE p.uri = ?`, [uri]);
    const items = await this.loadItems(uri);
    const original = source === undefined ? undefined : rowToPlaylist(source);
    const label = nonEmpty(name?.trim())
      ?? `${original?.name ?? 'Untitled playlist'} (copy)`;

    const copyUri = newPlaylistUri();
    const now = Date.now();
    const sortOrder = await this.db.number(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM playlists',
      [],
      0,
    );
    const artworkJson = original?.artwork === undefined ? null : JSON.stringify(original.artwork);

    await this.db.transaction([
      {
        sql: `INSERT INTO playlists (uri, provider, name, description, artwork_json, owner, editable, created_at, updated_at, sort_order)
              VALUES (?, 'ritmo', ?, ?, ?, NULL, 1, ?, ?, ?)`,
        params: [copyUri, label, original?.description ?? null, artworkJson, now, now, sortOrder],
      },
      ...insertItems(copyUri, items),
    ]);

    return {
      uri: copyUri,
      provider: 'ritmo',
      name: label,
      description: original?.description,
      artwork: original?.artwork,
      editable: true,
      trackCount: items.length,
    };
  }

  async setSortOrder(order: Uri[]): Promise<void> {
    if (order.length === 0) return;
    const statements: DbStatement[] = order.map((uri, index) => ({
      sql: 'UPDATE playlists SET sort_order = ? WHERE uri = ?',
      params: [index, uri],
    }));
    // Anything the sidebar did not list keeps a stable relative order behind the
    // explicit ones — `rowid` rather than the old `sort_order`, which would keep
    // inflating on every drag.
    statements.push({
      sql: `UPDATE playlists SET sort_order = ? + rowid WHERE uri NOT IN (${placeholders(order.length)})`,
      params: [order.length, ...order],
    });
    await this.db.batched(statements);
  }

  async exportM3u(uri: Uri): Promise<string> {
    const playlist = await this.get(uri, true);
    const lines: string[] = ['#EXTM3U'];
    if (playlist !== undefined) lines.push(`#PLAYLIST:${playlist.name}`);
    for (const track of playlist?.tracks ?? []) {
      const seconds = track.durationMs > 0 ? Math.round(track.durationMs / 1000) : -1;
      const artist = track.artists[0]?.name ?? '';
      lines.push(`#EXTINF:${seconds},${artist} - ${track.title}`);
      lines.push(track.path !== undefined && track.path.length > 0 ? track.path : track.uri);
    }
    return `${lines.join('\n')}\n`;
  }

  async exportJson(uri: Uri): Promise<string> {
    const playlist = await this.get(uri, true);
    return JSON.stringify(
      {
        format: 'ritmo.playlist',
        version: 1,
        exportedAt: Date.now(),
        playlist: playlist ?? { uri, provider: 'ritmo', name: 'Untitled playlist', tracks: [] },
      },
      null,
      2,
    );
  }

  async importM3u(
    name: string,
    contents: string,
    resolve: (path: string) => Promise<Track | undefined>,
  ): Promise<Playlist> {
    const tracks: Track[] = [];
    let durationMs: number | undefined;

    for (const raw of contents.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (line.startsWith('#')) {
        const seconds = parseExtInf(line);
        if (seconds !== undefined) durationMs = seconds;
        continue;
      }
      let resolved: Track | undefined;
      try {
        resolved = await resolve(line);
      } catch {
        resolved = undefined;
      }
      if (resolved !== undefined) {
        // `#EXTINF` is often the only duration an M3U carries; never let it
        // overwrite what the file itself reported.
        if (resolved.durationMs === 0 && durationMs !== undefined && durationMs > 0) {
          resolved = { ...resolved, durationMs };
        }
        tracks.push(resolved);
      }
      durationMs = undefined;
    }

    return this.create(name, { tracks });
  }

  async importJson(contents: string): Promise<Playlist> {
    let payload: unknown;
    try {
      payload = JSON.parse(contents) as unknown;
    } catch {
      payload = undefined;
    }
    const candidate =
      payload !== null && typeof payload === 'object' && 'playlist' in payload
        ? (payload as { playlist: unknown }).playlist
        : payload;
    const snapshot = parsePlaylistSnapshot(candidate);
    return this.create(snapshot?.name ?? 'Imported playlist', {
      description: snapshot?.description,
      tracks: snapshot?.tracks ?? [],
    });
  }

  async containing(trackUri: Uri): Promise<Playlist[]> {
    const rows = await this.db.query(
      `${PLAYLIST_WITH_COUNT}
        WHERE EXISTS (SELECT 1 FROM playlist_items i WHERE i.playlist_uri = p.uri AND i.track_uri = ?)
        ORDER BY p.sort_order ASC, p.updated_at DESC`,
      [trackUri],
    );
    return rows.map(rowToPlaylist);
  }

  private async tracksOf(uri: Uri): Promise<Track[]> {
    const items = await this.loadItems(uri);
    const tracks: Array<Track | undefined> = items.map((item) => parseTrackSnapshot(item.trackJson));
    const missing: Uri[] = [];
    items.forEach((item, i) => {
      if (tracks[i] === undefined) missing.push(item.trackUri);
    });
    if (missing.length > 0) {
      // A snapshot written by an older build (or corrupted) still has a live
      // row to fall back on.
      const recovered = new Map<Uri, Track>();
      for (const track of await this.repo.getTracks(missing)) recovered.set(track.uri, track);
      items.forEach((item, i) => {
        if (tracks[i] === undefined) tracks[i] = recovered.get(item.trackUri);
      });
    }
    const out: Track[] = [];
    for (const track of tracks) {
      if (track !== undefined) out.push(track);
    }
    return out;
  }

  private async loadItems(uri: Uri): Promise<StoredItem[]> {
    const rows = await this.db.query(
      `SELECT position, track_uri, track_json, added_at FROM playlist_items
        WHERE playlist_uri = ? ORDER BY position ASC`,
      [uri],
    );
    const out: StoredItem[] = [];
    for (const row of rows) {
      const trackUri = nonEmpty(asString(row.track_uri));
      const trackJson = asString(row.track_json);
      if (trackUri === undefined || trackJson === undefined) continue;
      out.push({
        trackUri,
        trackJson,
        addedAt: intOr(row.added_at, Date.now()),
        position: intOr(row.position, out.length),
      });
    }
    return out;
  }

  /**
   * One transaction, even when the item count pushes past the usual statement
   * batch: a partially rewritten playlist would have duplicate or missing
   * positions, which is worse than a long commit.
   */
  private async rewrite(uri: Uri, items: StoredItem[], now: number): Promise<void> {
    await this.db.transaction([
      { sql: 'DELETE FROM playlist_items WHERE playlist_uri = ?', params: [uri] },
      ...insertItems(uri, items),
      { sql: 'UPDATE playlists SET updated_at = ? WHERE uri = ?', params: [now, uri] },
    ]);
  }
}

function toStored(track: Track, now: number): StoredItem {
  return { trackUri: track.uri, trackJson: JSON.stringify(track), addedAt: now, position: -1 };
}

function insertItems(playlistUri: Uri, items: StoredItem[]): DbStatement[] {
  if (items.length === 0) return [];
  const out: DbStatement[] = [];
  let position = 0;
  for (const group of chunk(items, ROWS_PER_INSERT)) {
    const tuples: string[] = [];
    const params: unknown[] = [];
    for (const item of group) {
      tuples.push('(?, ?, ?, ?, ?)');
      params.push(playlistUri, position, item.trackUri, item.trackJson, item.addedAt);
      position += 1;
    }
    out.push({
      sql: `INSERT INTO playlist_items (${ITEM_COLUMNS}) VALUES ${tuples.join(', ')}`,
      params,
    });
  }
  return out;
}

/** `#EXTINF:<seconds>,<artist> - <title>` — only the duration is useful here,
 *  the label is whatever the exporting app felt like writing. */
function parseExtInf(line: string): number | undefined {
  if (!line.toUpperCase().startsWith('#EXTINF:')) return undefined;
  const body = line.slice('#EXTINF:'.length);
  const comma = body.indexOf(',');
  const seconds = Number.parseFloat(comma < 0 ? body : body.slice(0, comma));
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}
