/**
 * "Liked Songs" and everything else the user starred.
 *
 * The `likes` table only stores `(uri, kind, liked_at)`, so liking a remote
 * entity always stores its snapshot in the matching entity table first. Without
 * that, the liked-songs view would be a list of URIs with nothing to render the
 * moment Audius is unreachable.
 */

import type { Album, Artist, EntityKind, Page, Playlist, Track, Uri } from '../types';
import type { HostBridge } from '../host/types';
import type { LibraryErrorSink, Repo } from './repo';
import {
  IN_CHUNK, SafeDb, asString, chunk, clampLimit, decodeCursor, dedupe, encodeCursor,
  intOr, isRecord, nonEmpty, parseAlbumSnapshot, parseArtistSnapshot,
  parsePlaylistSnapshot, parseTrackSnapshot, placeholders, rowToAlbum, rowToArtist,
  rowToTrack,
} from './repo';

const LIKE_UPSERT = `INSERT INTO likes (uri, kind, liked_at) VALUES (?, ?, ?)
ON CONFLICT(uri) DO UPDATE SET kind = excluded.kind`;

/** `editable` is never touched on conflict: a provider playlist must not become editable. */
const PLAYLIST_UPSERT = `INSERT INTO playlists
  (uri, provider, name, description, artwork_json, owner, editable, created_at, updated_at, sort_order)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(uri) DO UPDATE SET
  name         = COALESCE(NULLIF(excluded.name, ''), playlists.name),
  description  = COALESCE(excluded.description, playlists.description),
  artwork_json = COALESCE(excluded.artwork_json, playlists.artwork_json),
  owner        = COALESCE(excluded.owner, playlists.owner),
  updated_at   = excluded.updated_at`;

export class Likes {
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

  async like(
    uri: Uri,
    kind: EntityKind,
    snapshot?: Track | Album | Artist | Playlist,
  ): Promise<void> {
    if (uri.length === 0) return;
    // The entity row goes in first so nothing ever joins a like to a missing row.
    if (snapshot !== undefined) await this.store(uri, kind, snapshot);
    await this.db.execute(LIKE_UPSERT, [uri, kind, Date.now()]);
  }

  async unlike(uri: Uri): Promise<void> {
    await this.db.execute('DELETE FROM likes WHERE uri = ?', [uri]);
  }

  /** `snapshot` widens with `kind`, exactly as {@link Likes.like} accepts it. */
  async toggle(
    uri: Uri,
    kind: EntityKind,
    snapshot?: Track | Album | Artist | Playlist,
  ): Promise<boolean> {
    if (await this.isLiked(uri)) {
      await this.unlike(uri);
      return false;
    }
    await this.like(uri, kind, snapshot);
    return true;
  }

  async isLiked(uri: Uri): Promise<boolean> {
    const row = await this.db.one('SELECT 1 AS hit FROM likes WHERE uri = ?', [uri]);
    return row !== undefined;
  }

  /** One round trip for a whole rendered list instead of one per row. */
  async likedSet(uris: Uri[]): Promise<Set<Uri>> {
    const out = new Set<Uri>();
    const wanted = dedupe(uris);
    if (wanted.length === 0) return out;
    for (const group of chunk(wanted, IN_CHUNK)) {
      const rows = await this.db.query(
        `SELECT uri FROM likes WHERE uri IN (${placeholders(group.length)})`,
        group,
      );
      for (const row of rows) {
        const uri = nonEmpty(asString(row.uri));
        if (uri !== undefined) out.add(uri);
      }
    }
    return out;
  }

  async listTracks(opts?: { limit?: number; cursor?: string }): Promise<Page<Track>> {
    const limit = clampLimit(opts?.limit, 100, 500);
    const where = ["l.kind = 'track'"];
    const params: unknown[] = [];
    const cursor = decodeCursor(opts?.cursor);
    if (cursor !== undefined) {
      where.push('(l.liked_at < ? OR (l.liked_at = ? AND l.uri < ?))');
      params.push(cursor.value, cursor.value, cursor.uri);
    }
    params.push(limit);

    const rows = await this.db.query(
      `SELECT t.*, l.liked_at AS liked_at
         FROM likes l JOIN tracks t ON t.uri = l.uri
        WHERE ${where.join(' AND ')}
        ORDER BY l.liked_at DESC, l.uri DESC
        LIMIT ?`,
      params,
    );

    const page: Page<Track> = { items: rows.map(rowToTrack) };
    const last = rows[rows.length - 1];
    if (rows.length === limit && last !== undefined) {
      const uri = asString(last.uri);
      if (uri !== undefined) page.cursor = encodeCursor(intOr(last.liked_at, 0), uri);
    }
    if (cursor === undefined) {
      page.total = await this.db.number(
        `SELECT COUNT(*) AS n FROM likes l JOIN tracks t ON t.uri = l.uri WHERE l.kind = 'track'`,
        [],
        page.items.length,
      );
    }
    return page;
  }

  async listAlbums(): Promise<Album[]> {
    const rows = await this.db.query(
      `SELECT a.* FROM likes l JOIN albums a ON a.uri = l.uri
        WHERE l.kind = 'album' ORDER BY l.liked_at DESC`,
    );
    return rows.map(rowToAlbum);
  }

  async listArtists(): Promise<Artist[]> {
    const rows = await this.db.query(
      `SELECT ar.* FROM likes l JOIN artists ar ON ar.uri = l.uri
        WHERE l.kind = 'artist' ORDER BY l.liked_at DESC`,
    );
    return rows.map(rowToArtist);
  }

  async count(kind?: EntityKind): Promise<number> {
    if (kind === undefined) return this.db.number('SELECT COUNT(*) AS n FROM likes');
    return this.db.number('SELECT COUNT(*) AS n FROM likes WHERE kind = ?', [kind]);
  }

  /**
   * Persists the snapshot into the table that matches `kind`. The payload is
   * re-parsed rather than trusted: callers hand us whatever the provider
   * returned, and a Track passed as an "album" must not create a junk row.
   */
  private async store(uri: Uri, kind: EntityKind, snapshot: unknown): Promise<void> {
    if (!isRecord(snapshot)) return;
    const withUri = { ...snapshot, uri };
    switch (kind) {
      case 'track': {
        if (typeof snapshot.title !== 'string') return;
        const track = parseTrackSnapshot(withUri);
        if (track !== undefined) await this.repo.upsertTracks([track]);
        return;
      }
      case 'album': {
        if (typeof snapshot.name !== 'string') return;
        const album = parseAlbumSnapshot(withUri);
        if (album !== undefined) await this.repo.upsertAlbums([album]);
        return;
      }
      case 'artist': {
        if (typeof snapshot.name !== 'string') return;
        const artist = parseArtistSnapshot(withUri);
        if (artist !== undefined) await this.repo.upsertArtists([artist]);
        return;
      }
      case 'playlist': {
        if (typeof snapshot.name !== 'string') return;
        const playlist = parsePlaylistSnapshot(withUri);
        if (playlist === undefined) return;
        const now = Date.now();
        await this.db.execute(PLAYLIST_UPSERT, [
          playlist.uri,
          playlist.provider,
          playlist.name,
          playlist.description ?? null,
          playlist.artwork === undefined ? null : JSON.stringify(playlist.artwork),
          playlist.owner ?? null,
          playlist.editable === true ? 1 : 0,
          now,
          now,
        ]);
        return;
      }
      default:
        // Stations live only in the `likes` table — Radio-Browser is the source
        // of truth and its stream URLs go stale, so there is nothing to cache.
        return;
    }
  }
}
