/**
 * The library layer, assembled.
 *
 * One `Library` per host. It owns nothing the sub-modules do not already own —
 * its job is wiring the shared error sink, running startup maintenance and
 * moving the whole user state in and out as JSON for backups and device
 * migration.
 */

import type { Album, Artist, EntityKind, Playlist, Settings, Track, Uri } from '../types';
import type { HostBridge } from '../host/types';
import { isSecretKey } from '../host/secrets';
import type { DbStatement, LibraryErrorSink } from './repo';
import {
  Repo, SafeDb, asString, intOr, isRecord, nonEmpty, parseAlbumSnapshot,
  parseArtistSnapshot, parseArtwork, parseTrackSnapshot,
} from './repo';
import { Playlists } from './playlists';
import { Likes } from './likes';
import { History } from './history';
import { Offline } from './offline';

const EXPORT_FORMAT = 'ritmo.library';
const EXPORT_VERSION = 1;
/** Play history older than this is statistically dead weight. */
const HISTORY_KEEP_DAYS = 365;

interface ExportedLike {
  uri: Uri;
  kind: EntityKind;
  likedAt: number;
  snapshot?: Track | Album | Artist;
}

export class Library {
  readonly repo: Repo;
  readonly playlists: Playlists;
  readonly likes: Likes;
  readonly history: History;
  readonly offline: Offline;

  private readonly sql: SafeDb;

  constructor(private readonly host: HostBridge, onError?: LibraryErrorSink) {
    this.repo = new Repo(host);
    this.playlists = new Playlists(host, this.repo);
    this.likes = new Likes(host, this.repo);
    this.history = new History(host, this.repo);
    this.offline = new Offline(host, this.repo);
    this.sql = new SafeDb(host);
    this.onError = onError;
  }

  get onError(): LibraryErrorSink | undefined {
    return this.sql.onError;
  }

  set onError(fn: LibraryErrorSink | undefined) {
    this.sql.onError = fn;
    this.repo.onError = fn;
    this.playlists.onError = fn;
    this.likes.onError = fn;
    this.history.onError = fn;
    this.offline.onError = fn;
  }

  /**
   * Mirrors the `db_maintenance` command: the bridge only exposes SQL, so the
   * same work is issued as statements. `PRAGMA optimize` goes through `query`
   * because a PRAGMA is allowed to answer with rows.
   */
  async init(): Promise<void> {
    await this.sql.execute('DELETE FROM http_cache WHERE expires_at <= ?', [Date.now()]);
    await this.sql.query('PRAGMA optimize');
    await this.history.prune(HISTORY_KEEP_DAYS);
  }

  /**
   * The whole user state as one JSON document, for a backup or a move to
   * another machine.
   *
   * Four things go in, and credentials are none of them: tokens live in `kv`
   * (see `host/secrets.ts`), which this never reads. `redactSecrets` is the
   * second lock on that door — a build that moved a secret into `Settings`
   * would be caught by it instead of writing the secret into a file the user
   * hands to someone else.
   */
  async exportAll(): Promise<string> {
    const [playlists, likes, history, settings] = await Promise.all([
      this.exportPlaylists(),
      this.exportLikes(),
      this.history.recentEntries(20000),
      this.loadSettings(),
    ]);
    return JSON.stringify(
      {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: Date.now(),
        playlists,
        likes,
        history,
        settings: redactSecrets(settings),
      },
      null,
      2,
    );
  }

  async importAll(json: string, opts?: { merge?: boolean }): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(json) as unknown;
    } catch (err) {
      this.onError?.(err);
      return;
    }
    if (!isRecord(payload)) return;
    const merge = opts?.merge === true;

    if (!merge) {
      // `playlist_items` cascades from `playlists`.
      await this.sql.batched([
        { sql: 'DELETE FROM playlists' },
        { sql: 'DELETE FROM likes' },
        { sql: 'DELETE FROM play_history' },
      ]);
    }

    await this.importPlaylists(payload.playlists);
    await this.importLikes(payload.likes);
    await this.importHistory(payload.history);
    await this.importSettings(payload.settings);
  }

  private async exportPlaylists(): Promise<Playlist[]> {
    const out: Playlist[] = [];
    for (const summary of await this.playlists.list()) {
      const full = await this.playlists.get(summary.uri, true);
      out.push(full ?? summary);
    }
    return out;
  }

  private async exportLikes(): Promise<ExportedLike[]> {
    const rows = await this.sql.query(
      'SELECT uri, kind, liked_at FROM likes ORDER BY liked_at ASC',
    );
    const entries: ExportedLike[] = [];
    for (const row of rows) {
      const uri = nonEmpty(asString(row.uri));
      const kind = asString(row.kind);
      if (uri === undefined || kind === undefined) continue;
      entries.push({ uri, kind: kind as EntityKind, likedAt: intOr(row.liked_at, 0) });
    }

    const trackUris = entries.filter((e) => e.kind === 'track').map((e) => e.uri);
    const tracks = new Map<Uri, Track>();
    for (const track of await this.repo.getTracks(trackUris)) tracks.set(track.uri, track);

    for (const entry of entries) {
      if (entry.kind === 'track') {
        entry.snapshot = tracks.get(entry.uri);
      } else if (entry.kind === 'album') {
        entry.snapshot = await this.repo.getAlbum(entry.uri);
      } else if (entry.kind === 'artist') {
        entry.snapshot = await this.repo.getArtist(entry.uri);
      }
    }
    return entries;
  }

  private async loadSettings(): Promise<Settings | undefined> {
    try {
      return await this.host.getSettings();
    } catch (err) {
      this.onError?.(err);
      return undefined;
    }
  }

  private async importPlaylists(value: unknown): Promise<void> {
    if (!Array.isArray(value)) return;
    for (const raw of value) {
      if (!isRecord(raw)) continue;
      const name = nonEmpty(asString(raw.name)) ?? 'Imported playlist';
      const tracks: Track[] = [];
      if (Array.isArray(raw.tracks)) {
        for (const item of raw.tracks) {
          const track = parseTrackSnapshot(item);
          if (track !== undefined) tracks.push(track);
        }
      }
      // Importing always mints a fresh `ritmo:playlist:` uri: an incoming uri
      // may already be taken locally, and merging into it would silently
      // rewrite somebody else's list.
      const created = await this.playlists.create(name, {
        description: nonEmpty(asString(raw.description)),
        tracks,
      });
      const artwork = parseArtwork(raw.artwork);
      if (artwork !== undefined) await this.playlists.setArtwork(created.uri, artwork);
    }
  }

  private async importLikes(value: unknown): Promise<void> {
    if (!Array.isArray(value)) return;
    const statements: DbStatement[] = [];
    const tracks: Track[] = [];
    const albums: Album[] = [];
    const artists: Artist[] = [];

    for (const raw of value) {
      if (!isRecord(raw)) continue;
      const uri = nonEmpty(asString(raw.uri));
      const kind = nonEmpty(asString(raw.kind));
      if (uri === undefined || kind === undefined) continue;
      const likedAt = intOr(raw.likedAt ?? raw.liked_at, Date.now());
      statements.push({
        sql: `INSERT INTO likes (uri, kind, liked_at) VALUES (?, ?, ?)
              ON CONFLICT(uri) DO UPDATE SET kind = excluded.kind, liked_at = MIN(likes.liked_at, excluded.liked_at)`,
        params: [uri, kind, likedAt],
      });

      const snapshot = raw.snapshot;
      if (!isRecord(snapshot)) continue;
      const withUri = { ...snapshot, uri };
      if (kind === 'track') {
        const track = parseTrackSnapshot(withUri);
        if (track !== undefined) tracks.push(track);
      } else if (kind === 'album') {
        const album = parseAlbumSnapshot(withUri);
        if (album !== undefined) albums.push(album);
      } else if (kind === 'artist') {
        const artist = parseArtistSnapshot(withUri);
        if (artist !== undefined) artists.push(artist);
      }
    }

    // Entities first: a like whose row is missing renders as nothing at all.
    await this.repo.upsertTracks(tracks);
    await this.repo.upsertAlbums(albums);
    await this.repo.upsertArtists(artists);
    await this.sql.batched(statements);
  }

  private async importHistory(value: unknown): Promise<void> {
    if (!Array.isArray(value)) return;
    const statements: DbStatement[] = [];
    for (const raw of value) {
      if (!isRecord(raw)) continue;
      const track = parseTrackSnapshot(raw.track);
      if (track === undefined) continue;
      statements.push({
        sql: `INSERT INTO play_history (track_uri, track_json, played_at, played_ms, reason, completed)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          track.uri,
          JSON.stringify(track),
          intOr(raw.playedAt ?? raw.played_at, 0),
          Math.max(0, intOr(raw.playedMs ?? raw.played_ms, 0)),
          nonEmpty(asString(raw.reason)) ?? 'user',
          raw.completed === true || intOr(raw.completed, 0) !== 0 ? 1 : 0,
        ],
      });
    }
    await this.sql.batched(statements);
  }

  private async importSettings(value: unknown): Promise<void> {
    if (!isRecord(value)) return;
    try {
      // Spread over the live settings so a backup from an older build cannot
      // leave a required field undefined.
      const current = await this.host.getSettings();
      await this.host.saveSettings({ ...current, ...value } as Settings);
    } catch (err) {
      this.onError?.(err);
    }
  }
}

/**
 * Drops any field named after a credential key. Returns the value untouched
 * when there is nothing to drop, so the common case does not copy the blob.
 */
function redactSecrets(settings: Settings | undefined): Settings | undefined {
  if (settings === undefined) return undefined;
  const entries = Object.entries(settings as unknown as Record<string, unknown>);
  const secrets = entries.filter(([key]) => isSecretKey(key));
  if (secrets.length === 0) return settings;
  return Object.fromEntries(
    entries.filter(([key]) => !isSecretKey(key)),
  ) as unknown as Settings;
}

export * from './repo';
export * from './playlists';
export * from './likes';
export * from './history';
export * from './offline';
