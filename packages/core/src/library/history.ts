/**
 * Play history: the raw material behind "Recently played", the year-in-review
 * shelves and the `plays` sort order.
 *
 * Every row keeps a `track_json` snapshot so statistics survive a provider
 * going away, and only rows with `completed = 1` feed the "top" rankings — a
 * four-second skip is data about the skip, not about the song.
 */

import type { AlbumRef, ArtistRef, PlayHistoryEntry, PlayReason, Track, Uri } from '../types';
import type { HostBridge } from '../host/types';
import type { LibraryErrorSink, Repo } from './repo';
import {
  SafeDb, asString, clampLimit, intOr, nonEmpty, parseArtwork, parseTrackSnapshot,
} from './repo';

const REASONS: PlayReason[] = ['user', 'auto_next', 'repeat', 'radio', 'resume'];

export class History {
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

  async record(entry: PlayHistoryEntry): Promise<void> {
    const uri = entry.track?.uri;
    if (uri === undefined || uri.length === 0) return;
    await this.db.execute(
      `INSERT INTO play_history (track_uri, track_json, played_at, played_ms, reason, completed)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uri,
        JSON.stringify(entry.track),
        intOr(entry.playedAt, Date.now()),
        Math.max(0, intOr(entry.playedMs, 0)),
        REASONS.includes(entry.reason) ? entry.reason : 'user',
        entry.completed ? 1 : 0,
      ],
    );
  }

  async recentlyPlayed(limit = 50): Promise<Track[]> {
    // `MAX(played_at)` with bare columns is SQLite's documented "row that
    // produced the max" behaviour, so the snapshot belongs to the newest play.
    const rows = await this.db.query(
      `SELECT track_uri, track_json, MAX(played_at) AS played_at
         FROM play_history
        GROUP BY track_uri
        ORDER BY played_at DESC
        LIMIT ?`,
      [clampLimit(limit, 50, 500)],
    );
    return this.hydrate(rows);
  }

  async recentEntries(limit = 100): Promise<PlayHistoryEntry[]> {
    const rows = await this.db.query(
      `SELECT track_json, played_at, played_ms, reason, completed
         FROM play_history ORDER BY played_at DESC, id DESC LIMIT ?`,
      [clampLimit(limit, 100, 100000)],
    );
    const out: PlayHistoryEntry[] = [];
    for (const row of rows) {
      const track = parseTrackSnapshot(row.track_json);
      if (track === undefined) continue;
      const reason = asString(row.reason);
      out.push({
        track,
        playedAt: intOr(row.played_at, 0),
        playedMs: intOr(row.played_ms, 0),
        reason: reason !== undefined && isReason(reason) ? reason : 'user',
        completed: intOr(row.completed, 0) !== 0,
      });
    }
    return out;
  }

  async topTracks(sinceMs: number, limit = 20): Promise<Array<{ track: Track; plays: number }>> {
    const rows = await this.db.query(
      `SELECT track_uri, track_json, COUNT(*) AS plays, MAX(played_at) AS last_at
         FROM play_history
        WHERE completed = 1 AND played_at >= ?
        GROUP BY track_uri
        ORDER BY plays DESC, last_at DESC
        LIMIT ?`,
      [floorTime(sinceMs), clampLimit(limit, 20, 200)],
    );
    const tracks = await this.hydrate(rows);
    const plays = new Map<Uri, number>();
    for (const row of rows) {
      const uri = nonEmpty(asString(row.track_uri));
      if (uri !== undefined) plays.set(uri, intOr(row.plays, 0));
    }
    return tracks.map((track) => ({ track, plays: plays.get(track.uri) ?? 0 }));
  }

  async topArtists(
    sinceMs: number,
    limit = 20,
  ): Promise<Array<{ artist: ArtistRef; plays: number }>> {
    const rows = await this.db.query(
      `SELECT json_extract(track_json, '$.artists[0].uri')  AS artist_uri,
              json_extract(track_json, '$.artists[0].name') AS artist_name,
              COUNT(*) AS plays
         FROM play_history
        WHERE completed = 1 AND played_at >= ? AND json_valid(track_json)
        GROUP BY artist_uri
        ORDER BY plays DESC
        LIMIT ?`,
      [floorTime(sinceMs), clampLimit(limit, 20, 200)],
    );
    const out: Array<{ artist: ArtistRef; plays: number }> = [];
    for (const row of rows) {
      const uri = nonEmpty(asString(row.artist_uri));
      const name = nonEmpty(asString(row.artist_name));
      if (uri === undefined || name === undefined) continue;
      out.push({ artist: { uri, name }, plays: intOr(row.plays, 0) });
    }
    return out;
  }

  async topAlbums(sinceMs: number, limit = 20): Promise<Array<{ album: AlbumRef; plays: number }>> {
    const rows = await this.db.query(
      `SELECT json_extract(track_json, '$.album.uri')     AS album_uri,
              json_extract(track_json, '$.album.name')    AS album_name,
              json_extract(track_json, '$.album.artwork') AS album_artwork,
              COUNT(*) AS plays
         FROM play_history
        WHERE completed = 1 AND played_at >= ? AND json_valid(track_json)
        GROUP BY album_uri
        ORDER BY plays DESC
        LIMIT ?`,
      [floorTime(sinceMs), clampLimit(limit, 20, 200)],
    );
    const out: Array<{ album: AlbumRef; plays: number }> = [];
    for (const row of rows) {
      const uri = nonEmpty(asString(row.album_uri));
      const name = nonEmpty(asString(row.album_name));
      if (uri === undefined || name === undefined) continue;
      out.push({
        album: { uri, name, artwork: parseArtwork(row.album_artwork) },
        plays: intOr(row.plays, 0),
      });
    }
    return out;
  }

  /** Total audio actually heard — skips included, because they were heard too. */
  async listeningMs(sinceMs: number): Promise<number> {
    return this.db.number(
      'SELECT COALESCE(SUM(played_ms), 0) AS n FROM play_history WHERE played_at >= ?',
      [floorTime(sinceMs)],
    );
  }

  async playCount(trackUri: Uri): Promise<number> {
    return this.db.number(
      'SELECT COUNT(*) AS n FROM play_history WHERE track_uri = ? AND completed = 1',
      [trackUri],
    );
  }

  async lastPlayedAt(trackUri: Uri): Promise<number | undefined> {
    const row = await this.db.one(
      'SELECT MAX(played_at) AS played_at FROM play_history WHERE track_uri = ?',
      [trackUri],
    );
    if (row === undefined || row.played_at === null || row.played_at === undefined) return undefined;
    const at = intOr(row.played_at, 0);
    return at > 0 ? at : undefined;
  }

  async clear(): Promise<void> {
    await this.db.execute('DELETE FROM play_history');
  }

  async prune(keepDays: number): Promise<number> {
    const days = Math.max(1, Math.trunc(keepDays));
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.db.execute('DELETE FROM play_history WHERE played_at < ?', [cutoff]);
  }

  /**
   * Snapshots render even when the library row is gone, but a live row has had
   * artwork and tags enriched since the play, so it wins where it exists.
   */
  private async hydrate(rows: Array<Record<string, unknown>>): Promise<Track[]> {
    const snapshots: Track[] = [];
    for (const row of rows) {
      const track = parseTrackSnapshot(row.track_json);
      if (track !== undefined) {
        snapshots.push(track);
        continue;
      }
      const uri = nonEmpty(asString(row.track_uri));
      if (uri !== undefined) {
        snapshots.push({ uri, provider: providerFromUri(uri), title: uri, artists: [], durationMs: 0 });
      }
    }
    if (snapshots.length === 0) return [];
    const live = new Map<Uri, Track>();
    for (const track of await this.repo.getTracks(snapshots.map((t) => t.uri))) {
      live.set(track.uri, track);
    }
    return snapshots.map((snapshot) => live.get(snapshot.uri) ?? snapshot);
  }
}

function isReason(value: string): value is PlayReason {
  return (REASONS as string[]).includes(value);
}

/** Guards against `NaN`/`-Infinity` reaching SQL as a bind parameter. */
function floorTime(sinceMs: number): number {
  return Number.isFinite(sinceMs) ? Math.max(0, Math.trunc(sinceMs)) : 0;
}

function providerFromUri(uri: Uri): Track['provider'] {
  const colon = uri.indexOf(':');
  const head = colon > 0 ? uri.slice(0, colon) : '';
  switch (head) {
    case 'audius':
    case 'jamendo':
    case 'archive':
    case 'radio':
      return head;
    default:
      return 'local';
  }
}
