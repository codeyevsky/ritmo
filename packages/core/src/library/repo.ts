/**
 * The library database, as an object.
 *
 * Every query in here targets the frozen schema in `docs/schema.sql`. The Rust
 * scanner writes the same rows through the same column names, so a track that
 * came from a folder scan and a track that came from Audius are indistinguishable
 * once stored.
 *
 * Two invariants shape the whole file:
 *
 *   1. `host.db` may not exist at all (the web host has no SQLite), and a
 *      half-written scan may leave malformed JSON in a `*_json` column. Neither
 *      may reach the UI as an exception — reads degrade to empty, writes
 *      degrade to no-ops, and the cause is handed once to `onError`.
 *   2. Paging is keyset-based. `OFFSET 40000` re-walks 40 000 rows on every
 *      keystroke; comparing against the last row's sort value does not.
 */

import { makeUri } from '../types';
import { chunk } from '../util/async';

export { chunk };

import type {
  Album, AlbumRef, Artist, ArtistRef, Artwork, ArtworkSource, Page, Playlist,
  ProviderId, Track, Uri,
} from '../types';
import type { HostBridge } from '../host/types';
import { normalizeKey } from '../util/text';

export type LibraryErrorSink = (e: unknown) => void;

export class LibraryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'LibraryError';
  }
}

/**
 * SQLite's historical `SQLITE_MAX_VARIABLE_NUMBER` is 999 and some hosts still
 * ship that build, so a statement never carries more than ~500 parameters and a
 * transaction never carries more than this many statements.
 */
const STATEMENT_BATCH = 400;
/** 5 columns per playlist item / track upsert row ⇒ 500 parameters worst case. */
const ROWS_PER_INSERT = 100;
/** Parameter budget for a generated `IN (…)` list. */
const IN_CHUNK = 400;

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

/**
 * Failures are deduplicated per host rather than per instance: a host without a
 * database would otherwise report the same "no such table" five times over, once
 * from each library sub-module.
 */
const reportedByHost = new WeakMap<HostBridge, Set<string>>();

export interface DbStatement {
  sql: string;
  params?: unknown[];
}

/**
 * `DatabaseBridge` with the exceptions taken out. Reads answer with an empty
 * result, writes answer with `0`/`false`, and the first occurrence of each
 * distinct failure is pushed to `onError`.
 */
export class SafeDb {
  onError: LibraryErrorSink | undefined;

  constructor(private readonly host: HostBridge) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      return await this.host.db.query<T>(sql, params);
    } catch (err) {
      this.report(err, sql);
      return [];
    }
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    try {
      return await this.host.db.execute(sql, params);
    } catch (err) {
      this.report(err, sql);
      return 0;
    }
  }

  /** Runs `statements` as one transaction. `false` means nothing was written. */
  async transaction(statements: DbStatement[]): Promise<boolean> {
    if (statements.length === 0) return true;
    try {
      await this.host.db.transaction(statements);
      return true;
    } catch (err) {
      this.report(err, statements[0]?.sql ?? 'transaction');
      return false;
    }
  }

  /** Same as {@link transaction} but split so no single commit exceeds the batch cap. */
  async batched(statements: DbStatement[]): Promise<boolean> {
    let ok = true;
    for (const group of chunk(statements, STATEMENT_BATCH)) {
      ok = (await this.transaction(group)) && ok;
    }
    return ok;
  }

  /** First numeric column of the first row — for `COUNT(*)`/`SUM(...)` queries. */
  async number(sql: string, params: unknown[] = [], fallback = 0): Promise<number> {
    const row = await this.one<Record<string, unknown>>(sql, params);
    if (row === undefined) return fallback;
    for (const value of Object.values(row)) {
      const n = asNumber(value);
      if (n !== undefined) return n;
    }
    return fallback;
  }

  async text(sql: string, params: unknown[] = []): Promise<string | undefined> {
    const row = await this.one<Record<string, unknown>>(sql, params);
    if (row === undefined) return undefined;
    for (const value of Object.values(row)) {
      const s = nonEmpty(asString(value));
      if (s !== undefined) return s;
    }
    return undefined;
  }

  private report(err: unknown, sql: string): void {
    const key = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    let seen = reportedByHost.get(this.host);
    if (seen === undefined) {
      seen = new Set<string>();
      reportedByHost.set(this.host, seen);
    }
    if (seen.has(key)) return;
    seen.add(key);
    this.onError?.(new LibraryError(`library database unavailable (${firstLine(sql)})`, err));
  }
}

/** Fields a user may correct by hand. Everything else comes from the file. */
export interface TrackDetailsPatch {
  title?: string;
  artists?: string[];
  albumName?: string;
  /** ISO date or a bare year. */
  releaseDate?: string;
  genres?: string[];
  trackNumber?: number | undefined;
  discNumber?: number | undefined;
}

/**
 * The file stamps a domain {@link Track} does not carry, straight off the row.
 *
 * `path`, `file_size` and `file_mtime` are the scanner's record of the file on
 * disk and `added_at` is when the row joined the library, which is what the
 * Details surfaces report instead of what the tags claim.
 */
export interface TrackFile {
  uri: Uri;
  /** Absolute path on disk; absent for anything that is not a local file. */
  path?: string;
  sizeBytes?: number;
  /** Last modification time of the file itself, as reported by the scanner. */
  modifiedAt?: number;
  addedAt?: number;
}

export interface ListOpts {
  provider?: ProviderId;
  sort?: 'title' | 'artist' | 'album' | 'added' | 'duration' | 'plays';
  dir?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  genre?: string;
  search?: string;
}

export interface LibraryStats {
  tracks: number;
  albums: number;
  artists: number;
  playlists: number;
  liked: number;
  totalDurationMs: number;
  localBytes: number;
}

/** Ordering expression + the joins it needs. Always non-NULL, or keyset paging breaks. */
interface SortSpec {
  expr: string;
  joins: string[];
}

const TRACK_COLUMNS = [
  'uri', 'provider', 'title', 'title_key', 'artists_json', 'primary_artist',
  'album_uri', 'album_json', 'duration_ms', 'track_number', 'disc_number',
  'release_date', 'genres_json', 'artwork_json', 'popularity', 'explicit',
  'is_live', 'gain_db', 'path', 'meta_json', 'added_at', 'updated_at',
] as const;

/**
 * `added_at` is deliberately absent from the update list: re-reading a file or
 * enriching a remote track must not make it look newly added. Every other
 * nullable column falls back to what is already stored, so a lean search result
 * can never erase a fully tagged row.
 */
const TRACK_UPSERT = `INSERT INTO tracks (${TRACK_COLUMNS.join(', ')})
VALUES (${TRACK_COLUMNS.map(() => '?').join(', ')})
ON CONFLICT(uri) DO UPDATE SET
  provider       = excluded.provider,
  title          = COALESCE(NULLIF(excluded.title, ''), tracks.title),
  title_key      = COALESCE(NULLIF(excluded.title_key, ''), tracks.title_key),
  artists_json   = CASE WHEN excluded.artists_json IN ('', '[]') THEN tracks.artists_json ELSE excluded.artists_json END,
  primary_artist = COALESCE(excluded.primary_artist, tracks.primary_artist),
  album_uri      = COALESCE(excluded.album_uri, tracks.album_uri),
  album_json     = COALESCE(excluded.album_json, tracks.album_json),
  duration_ms    = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE tracks.duration_ms END,
  track_number   = COALESCE(excluded.track_number, tracks.track_number),
  disc_number    = COALESCE(excluded.disc_number, tracks.disc_number),
  release_date   = COALESCE(excluded.release_date, tracks.release_date),
  genres_json    = COALESCE(excluded.genres_json, tracks.genres_json),
  artwork_json   = COALESCE(excluded.artwork_json, tracks.artwork_json),
  popularity     = COALESCE(excluded.popularity, tracks.popularity),
  explicit       = MAX(excluded.explicit, tracks.explicit),
  is_live        = MAX(excluded.is_live, tracks.is_live),
  gain_db        = COALESCE(excluded.gain_db, tracks.gain_db),
  path           = COALESCE(excluded.path, tracks.path),
  meta_json      = COALESCE(excluded.meta_json, tracks.meta_json),
  updated_at     = excluded.updated_at`;

const ALBUM_COLUMNS = [
  'uri', 'provider', 'name', 'name_key', 'artists_json', 'primary_artist',
  'artwork_json', 'release_date', 'album_type', 'total_tracks', 'genres_json',
  'updated_at',
] as const;

const ALBUM_UPSERT = `INSERT INTO albums (${ALBUM_COLUMNS.join(', ')})
VALUES (${ALBUM_COLUMNS.map(() => '?').join(', ')})
ON CONFLICT(uri) DO UPDATE SET
  provider       = excluded.provider,
  name           = COALESCE(NULLIF(excluded.name, ''), albums.name),
  name_key       = COALESCE(NULLIF(excluded.name_key, ''), albums.name_key),
  artists_json   = CASE WHEN excluded.artists_json IN ('', '[]') THEN albums.artists_json ELSE excluded.artists_json END,
  primary_artist = COALESCE(excluded.primary_artist, albums.primary_artist),
  artwork_json   = COALESCE(excluded.artwork_json, albums.artwork_json),
  release_date   = COALESCE(excluded.release_date, albums.release_date),
  album_type     = COALESCE(excluded.album_type, albums.album_type),
  total_tracks   = COALESCE(excluded.total_tracks, albums.total_tracks),
  genres_json    = COALESCE(excluded.genres_json, albums.genres_json),
  updated_at     = excluded.updated_at`;

const ARTIST_COLUMNS = [
  'uri', 'provider', 'name', 'name_key', 'artwork_json', 'genres_json',
  'followers', 'bio', 'updated_at',
] as const;

const ARTIST_UPSERT = `INSERT INTO artists (${ARTIST_COLUMNS.join(', ')})
VALUES (${ARTIST_COLUMNS.map(() => '?').join(', ')})
ON CONFLICT(uri) DO UPDATE SET
  provider     = excluded.provider,
  name         = COALESCE(NULLIF(excluded.name, ''), artists.name),
  name_key     = COALESCE(NULLIF(excluded.name_key, ''), artists.name_key),
  artwork_json = COALESCE(excluded.artwork_json, artists.artwork_json),
  genres_json  = COALESCE(excluded.genres_json, artists.genres_json),
  followers    = COALESCE(excluded.followers, artists.followers),
  bio          = COALESCE(excluded.bio, artists.bio),
  updated_at   = excluded.updated_at`;

/**
 * `tracks.album_uri` has a foreign key to `albums(uri)` and the schema enables
 * `foreign_keys = ON`, so a remote track whose album was never stored would
 * abort the whole upsert transaction. A stub row keeps the reference valid and
 * is never allowed to overwrite a real album.
 */
const ALBUM_STUB = `INSERT INTO albums (uri, provider, name, name_key, artists_json, primary_artist, artwork_json, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(uri) DO NOTHING`;

/** NULL disc/track numbers sort last, not first — an untagged bonus track belongs at the end. */
const ALBUM_TRACK_ORDER =
  'ORDER BY COALESCE(disc_number, 1), COALESCE(track_number, 1000000), title COLLATE NOCASE';

/** Recomputes `albums.total_tracks` after a track moved into or out of one. */
const ALBUM_TOTALS = `UPDATE albums
   SET total_tracks = (SELECT COUNT(*) FROM tracks WHERE album_uri = albums.uri),
       updated_at = ?
 WHERE uri = ?`;

/** One hand-edited column and the value it takes. */
type TrackEdit = readonly [column: string, value: unknown];

/**
 * An ordered item table whose `position` is a dense 0-based ordinal. Both of
 * them reference a track by uri without a foreign key, so a track that leaves
 * the library has to be spliced out here by hand.
 */
interface ItemTable {
  table: string;
  owner: string;
  /** Copied through a rewrite verbatim; the insert order is owner, position, these. */
  carried: readonly string[];
}

const PLAYLIST_ITEMS: ItemTable = {
  table: 'playlist_items',
  owner: 'playlist_uri',
  carried: ['track_uri', 'track_json', 'added_at'],
};

const PACK_ITEMS: ItemTable = {
  table: 'pack_items',
  owner: 'pack_uri',
  carried: ['match_json', 'track_json', 'track_uri', 'added_at'],
};

export class Repo {
  private readonly db: SafeDb;

  constructor(host: HostBridge) {
    this.db = new SafeDb(host);
  }

  get onError(): LibraryErrorSink | undefined {
    return this.db.onError;
  }

  set onError(fn: LibraryErrorSink | undefined) {
    this.db.onError = fn;
  }

  async getTrack(uri: Uri): Promise<Track | undefined> {
    const row = await this.db.one('SELECT * FROM tracks WHERE uri = ?', [uri]);
    return row === undefined ? undefined : rowToTrack(row);
  }

  async getTracks(uris: Uri[]): Promise<Track[]> {
    const wanted = dedupe(uris);
    if (wanted.length === 0) return [];
    const found = new Map<Uri, Track>();
    for (const group of chunk(wanted, IN_CHUNK)) {
      const rows = await this.db.query(
        `SELECT * FROM tracks WHERE uri IN (${placeholders(group.length)})`,
        group,
      );
      for (const row of rows) {
        const track = rowToTrack(row);
        if (track.uri.length > 0) found.set(track.uri, track);
      }
    }
    const out: Track[] = [];
    for (const uri of uris) {
      const track = found.get(uri);
      if (track !== undefined) out.push(track);
    }
    return out;
  }

  /**
   * File stamps for the given tracks, in no particular order and with the rows
   * that do not exist simply missing.
   *
   * A separate read rather than extra fields on `Track`: every surface that
   * shows a track would carry four columns it never renders, and only the
   * Details views ask for them.
   */
  async getTrackFiles(uris: Uri[]): Promise<TrackFile[]> {
    const wanted = dedupe(uris);
    if (wanted.length === 0) return [];
    const out: TrackFile[] = [];
    for (const group of chunk(wanted, IN_CHUNK)) {
      const rows = await this.db.query(
        `SELECT uri, path, file_size, file_mtime, added_at FROM tracks
          WHERE uri IN (${placeholders(group.length)})`,
        group,
      );
      for (const row of rows) {
        const uri = nonEmpty(asString(row.uri));
        if (uri === undefined) continue;
        out.push({
          uri,
          path: nonEmpty(asString(row.path)),
          sizeBytes: positiveInt(row.file_size),
          modifiedAt: positiveInt(row.file_mtime),
          addedAt: positiveInt(row.added_at),
        });
      }
    }
    return out;
  }

  /**
   * Applies a user edit to a local track.
   *
   * Tags on disk are never written, so the columns touched here are recorded in
   * `tracks.edited_json` — the Rust scanner's upsert skips anything named there,
   * which is what keeps a rescan from reading the file again and undoing the
   * edit. Technical fields (duration, gain, file stamps) are never edited and
   * therefore keep refreshing from the file.
   */
  async updateTrackDetails(uri: Uri, patch: TrackDetailsPatch): Promise<void> {
    if (uri.length === 0) return;

    const edits: TrackEdit[] = [];
    const put = (column: string, value: unknown): void => {
      edits.push([column, value]);
    };

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (title.length > 0) {
        put('title', title);
        put('title_key', normalizeKey(title));
      }
    }

    if (patch.artists !== undefined) {
      const names = patch.artists.map((n) => n.trim()).filter((n) => n.length > 0);
      const refs: ArtistRef[] = names.map((name) => ({
        uri: makeUri('local', 'artist', normalizeKey(name)),
        name,
      }));
      put('artists_json', JSON.stringify(refs));
      put('primary_artist', refs[0]?.name ?? null);
    }

    if (patch.albumName !== undefined) {
      // Only the track's inline album label changes; album membership stays put,
      // so a rename here does not silently split a release apart.
      const existing = await this.getTrack(uri);
      const name = patch.albumName.trim();
      const album =
        name.length > 0
          ? { ...(existing?.album ?? { uri: makeUri('local', 'album', normalizeKey(name)) }), name }
          : undefined;
      put('album_json', album ? JSON.stringify(album) : null);
    }

    if (patch.releaseDate !== undefined) {
      const date = patch.releaseDate.trim();
      put('release_date', date.length > 0 ? date : null);
    }

    if (patch.genres !== undefined) {
      const genres = patch.genres.map((g) => g.trim()).filter((g) => g.length > 0);
      put('genres_json', genres.length > 0 ? JSON.stringify(genres) : null);
    }

    if (patch.trackNumber !== undefined) put('track_number', patch.trackNumber ?? null);
    if (patch.discNumber !== undefined) put('disc_number', patch.discNumber ?? null);

    if (edits.length === 0) return;

    const statement = await this.trackEditStatement(uri, edits);
    await this.db.execute(statement.sql, statement.params ?? []);
  }

  /**
   * Moves a track into an album, or out of every album when `album` is
   * `undefined`; a cleared track stays in the library with no album at all.
   *
   * Album membership is a user edit like any other, so it goes through the same
   * `edited_json` bookkeeping as {@link updateTrackDetails}: `album_uri` and
   * `album_json` are both recorded there, the scanner's upsert skips anything
   * named there, and a rescan therefore cannot drag the track back to whatever
   * its file's tags say. The tags themselves are never written.
   */
  async setTrackAlbum(
    trackUri: Uri,
    album: { uri: Uri; name: string } | undefined,
  ): Promise<void> {
    if (trackUri.length === 0) return;
    const track = await this.getTrack(trackUri);
    if (track === undefined) return;

    const now = Date.now();
    const statements: DbStatement[] = [];
    let target: AlbumRef | undefined;

    if (album !== undefined) {
      const uri = album.uri.trim();
      if (uri.length === 0) return;
      target = { uri, name: nonEmpty(album.name.trim()) ?? 'Unknown album' };
      // `tracks.album_uri` references `albums(uri)` with foreign keys on, so an
      // album that has no row of its own needs the stub before the track can
      // point at it. `DO NOTHING` keeps a real album row intact.
      statements.push({ sql: ALBUM_STUB, params: albumStubParams(target, track, now) });
    }

    statements.push(
      await this.trackEditStatement(trackUri, [
        ['album_uri', target?.uri ?? null],
        ['album_json', target === undefined ? null : JSON.stringify(target)],
      ]),
    );

    // Both sides of the move changed size, and `albums.total_tracks` is what an
    // album reports when its track list has not been loaded.
    const touched = new Set<Uri>();
    for (const uri of [nonEmpty(track.album?.uri), target?.uri]) {
      if (uri === undefined || touched.has(uri)) continue;
      touched.add(uri);
      statements.push({ sql: ALBUM_TOTALS, params: [now, uri] });
    }

    if (!(await this.db.transaction(statements))) {
      throw new LibraryError('the album of a track could not be saved');
    }
  }

  /**
   * Forgets tracks: their rows, their likes and their place in every playlist
   * and pack, as one commit. Nothing on disk is touched — a local file stays
   * exactly where it is, which also means a rescan of the folder it sits in
   * brings the track straight back.
   */
  async removeTracks(uris: Uri[]): Promise<void> {
    const wanted = dedupe(uris);
    if (wanted.length === 0) return;
    const removed = new Set<Uri>(wanted);

    // Every read happens first: the delete has to be a single commit, and the
    // item tables are rewritten from what they hold right now.
    const statements: DbStatement[] = [
      ...(await this.itemRewrites(PLAYLIST_ITEMS, removed, wanted)),
      ...(await this.itemRewrites(PACK_ITEMS, removed, wanted)),
    ];
    for (const group of chunk(wanted, IN_CHUNK)) {
      const list = placeholders(group.length);
      statements.push({
        sql: `DELETE FROM likes WHERE kind = 'track' AND uri IN (${list})`,
        params: [...group],
      });
      // History keeps a full snapshot of what was played, so leaving these rows
      // behind kept a removed track on the home screen under "most played" and
      // "jump back in", where clicking it would try to play something that no
      // longer exists.
      statements.push({
        sql: `DELETE FROM play_history WHERE track_uri IN (${list})`,
        params: [...group],
      });
      statements.push({ sql: `DELETE FROM tracks WHERE uri IN (${list})`, params: [...group] });
    }

    if (!(await this.db.transaction(statements))) {
      throw new LibraryError('the tracks could not be removed from the library');
    }
  }

  /**
   * `UPDATE tracks …` for a hand edit, with the touched column names folded
   * into `tracks.edited_json`. Handed back rather than executed so a caller
   * that has to write something else in the same commit can compose it.
   */
  private async trackEditStatement(uri: Uri, edits: TrackEdit[]): Promise<DbStatement> {
    const columns = await this.editedColumns(uri);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of edits) {
      sets.push(`${column} = ?`);
      params.push(value);
      columns.add(column);
    }
    sets.push('edited_json = ?', 'updated_at = ?');
    params.push(JSON.stringify([...columns]), Date.now(), uri);
    return { sql: `UPDATE tracks SET ${sets.join(', ')} WHERE uri = ?`, params };
  }

  /**
   * Splices removed tracks out of every list that holds them.
   *
   * `position` is dense and 0-based, so an affected list is read, filtered and
   * written back whole — the same blunt rewrite `playlists.ts` uses, for the
   * same reason: patching `position ± 1` is where off-by-one bugs silently
   * duplicate or drop rows.
   */
  private async itemRewrites(
    spec: ItemTable,
    removed: Set<Uri>,
    uris: Uri[],
  ): Promise<DbStatement[]> {
    const owners = new Set<Uri>();
    for (const group of chunk(uris, IN_CHUNK)) {
      const rows = await this.db.query<Record<string, unknown>>(
        `SELECT DISTINCT ${spec.owner} AS owner FROM ${spec.table}
          WHERE track_uri IN (${placeholders(group.length)})`,
        group,
      );
      for (const row of rows) {
        const owner = nonEmpty(asString(row.owner));
        if (owner !== undefined) owners.add(owner);
      }
    }
    if (owners.size === 0) return [];

    const columns = [spec.owner, 'position', ...spec.carried];
    const out: DbStatement[] = [];
    for (const owner of owners) {
      const rows = await this.db.query<Record<string, unknown>>(
        `SELECT ${spec.carried.join(', ')} FROM ${spec.table}
          WHERE ${spec.owner} = ? ORDER BY position ASC`,
        [owner],
      );
      // A pack entry nothing could resolve has no `track_uri` at all and has to
      // survive: the manifest entry is the thing a pack promises to keep.
      const keep = rows.filter((row) => {
        const trackUri = asString(row.track_uri);
        return trackUri === undefined || !removed.has(trackUri);
      });
      out.push({ sql: `DELETE FROM ${spec.table} WHERE ${spec.owner} = ?`, params: [owner] });
      let position = 0;
      for (const group of chunk(keep, ROWS_PER_INSERT)) {
        const tuples: string[] = [];
        const params: unknown[] = [];
        for (const row of group) {
          tuples.push(`(${placeholders(columns.length)})`);
          params.push(owner, position, ...spec.carried.map((column) => row[column] ?? null));
          position += 1;
        }
        out.push({
          sql: `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
          params,
        });
      }
    }
    return out;
  }

  /** Column names the user has already edited on this track. */
  private async editedColumns(uri: Uri): Promise<Set<string>> {
    const row = await this.db.one<{ edited_json: unknown }>(
      'SELECT edited_json FROM tracks WHERE uri = ? LIMIT 1',
      [uri],
    );
    const raw = row?.edited_json;
    if (typeof raw !== 'string' || raw.length === 0) return new Set();
    try {
      const parsed: unknown = JSON.parse(raw);
      return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
    } catch {
      return new Set();
    }
  }

  async upsertTracks(tracks: Track[]): Promise<void> {
    if (tracks.length === 0) return;
    const now = Date.now();
    const statements: DbStatement[] = [];
    const stubbed = new Set<Uri>();
    for (const track of tracks) {
      if (track.uri.length === 0) continue;
      const album = track.album;
      if (album !== undefined && album.uri.length > 0 && !stubbed.has(album.uri)) {
        stubbed.add(album.uri);
        statements.push({ sql: ALBUM_STUB, params: albumStubParams(album, track, now) });
      }
      statements.push({ sql: TRACK_UPSERT, params: trackParams(track, now) });
    }
    await this.db.batched(statements);
  }

  async upsertAlbums(albums: Album[]): Promise<void> {
    if (albums.length === 0) return;
    const now = Date.now();
    const statements: DbStatement[] = [];
    for (const album of albums) {
      if (album.uri.length === 0) continue;
      statements.push({ sql: ALBUM_UPSERT, params: albumParams(album, now) });
    }
    await this.db.batched(statements);
  }

  async upsertArtists(artists: Artist[]): Promise<void> {
    if (artists.length === 0) return;
    const now = Date.now();
    const statements: DbStatement[] = [];
    for (const artist of artists) {
      if (artist.uri.length === 0) continue;
      statements.push({ sql: ARTIST_UPSERT, params: artistParams(artist, now) });
    }
    await this.db.batched(statements);
  }

  async getAlbum(uri: Uri, withTracks = false): Promise<Album | undefined> {
    const row = await this.db.one('SELECT * FROM albums WHERE uri = ?', [uri]);
    if (row === undefined && !withTracks) {
      // A provider may hand out tracks whose album row was never stored; the
      // album page still has to render, so it gets rebuilt from its tracks.
      const probe = await this.db.query(
        `SELECT * FROM tracks WHERE album_uri = ? ${ALBUM_TRACK_ORDER} LIMIT 500`,
        [uri],
      );
      if (probe.length === 0) return undefined;
      return albumFromTracks(uri, probe.map(rowToTrack));
    }
    if (!withTracks) return row === undefined ? undefined : rowToAlbum(row);

    const trackRows = await this.db.query(
      `SELECT * FROM tracks WHERE album_uri = ? ${ALBUM_TRACK_ORDER}`,
      [uri],
    );
    const tracks = trackRows.map(rowToTrack);
    if (row === undefined && tracks.length === 0) return undefined;
    const album = row === undefined ? albumFromTracks(uri, tracks) : rowToAlbum(row);
    album.tracks = tracks;
    if (album.totalTracks === undefined && tracks.length > 0) album.totalTracks = tracks.length;
    return album;
  }

  async getArtist(uri: Uri): Promise<Artist | undefined> {
    const row = await this.db.one('SELECT * FROM artists WHERE uri = ?', [uri]);
    if (row !== undefined) return rowToArtist(row);
    const probe = await this.db.one(
      `SELECT artists_json, provider, artwork_json FROM tracks
       WHERE artists_json LIKE ? ESCAPE '\\' LIMIT 1`,
      [refPattern(uri)],
    );
    if (probe === undefined) return undefined;
    const provider = providerOf(probe.provider, uri);
    const refs = parseArtistRefs(probe.artists_json, undefined, provider);
    const match = refs.find((r) => r.uri === uri) ?? refs[0];
    if (match === undefined) return undefined;
    return { uri, provider, name: match.name, artwork: parseArtwork(probe.artwork_json) };
  }

  async getArtistAlbums(uri: Uri): Promise<Album[]> {
    const pattern = refPattern(uri);
    const rows = await this.db.query(
      `SELECT * FROM albums WHERE artists_json LIKE ? ESCAPE '\\'
       UNION
       SELECT a.* FROM albums a
         JOIN tracks t ON t.album_uri = a.uri
        WHERE t.artists_json LIKE ? ESCAPE '\\'
       ORDER BY release_date DESC, name_key ASC`,
      [pattern, pattern],
    );
    return rows.map(rowToAlbum);
  }

  async getArtistTracks(uri: Uri, limit = 50): Promise<Track[]> {
    const name = await this.db.text('SELECT name FROM artists WHERE uri = ?', [uri]);
    const rows = await this.db.query(
      `SELECT * FROM tracks
        WHERE artists_json LIKE ? ESCAPE '\\'
           OR (? IS NOT NULL AND primary_artist = ?)
        ORDER BY popularity DESC, added_at DESC
        LIMIT ?`,
      [refPattern(uri), name ?? null, name ?? null, clampLimit(limit, 50, 500)],
    );
    return rows.map(rowToTrack);
  }

  async listTracks(opts: ListOpts): Promise<Page<Track>> {
    const limit = clampLimit(opts.limit, DEFAULT_PAGE, MAX_PAGE);
    const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
    const sort = trackSort(opts.sort ?? 'added');
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.provider !== undefined) {
      where.push('t.provider = ?');
      params.push(opts.provider);
    }
    if (opts.genre !== undefined && opts.genre.trim().length > 0) {
      where.push("LOWER(COALESCE(t.genres_json, '')) LIKE ? ESCAPE '\\'");
      params.push(genrePattern(opts.genre));
    }
    const search = opts.search?.trim();
    if (search !== undefined && search.length > 0) {
      where.push(`(t.title_key LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.primary_artist, '')) LIKE ? ESCAPE '\\')`);
      params.push(containsPattern(normalizeKey(search)), containsPattern(search.toLowerCase()));
    }

    const countSql = `SELECT COUNT(*) AS n FROM tracks t ${sort.joins.join(' ')} ${whereClause(where)}`;
    const countParams = [...params];

    const cursor = decodeCursor(opts.cursor);
    if (cursor !== undefined) {
      where.push(keysetClause(sort.expr, 't.uri', dir));
      params.push(cursor.value, cursor.value, cursor.uri);
    }
    params.push(limit);

    const rows = await this.db.query(
      `SELECT t.*, ${sort.expr} AS sort_key FROM tracks t ${sort.joins.join(' ')}
       ${whereClause(where)}
       ORDER BY ${sort.expr} ${dir}, t.uri ${dir}
       LIMIT ?`,
      params,
    );
    return this.toPage(rows, limit, rowToTrack, cursor === undefined ? countSql : undefined, countParams);
  }

  async listAlbums(opts: ListOpts): Promise<Page<Album>> {
    const limit = clampLimit(opts.limit, DEFAULT_PAGE, MAX_PAGE);
    const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
    const sort = albumSort(opts.sort ?? 'title');
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.provider !== undefined) {
      where.push('a.provider = ?');
      params.push(opts.provider);
    }
    if (opts.genre !== undefined && opts.genre.trim().length > 0) {
      where.push("LOWER(COALESCE(a.genres_json, '')) LIKE ? ESCAPE '\\'");
      params.push(genrePattern(opts.genre));
    }
    const search = opts.search?.trim();
    if (search !== undefined && search.length > 0) {
      where.push(`(a.name_key LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.primary_artist, '')) LIKE ? ESCAPE '\\')`);
      params.push(containsPattern(normalizeKey(search)), containsPattern(search.toLowerCase()));
    }

    const countSql = `SELECT COUNT(*) AS n FROM albums a ${whereClause(where)}`;
    const countParams = [...params];

    const cursor = decodeCursor(opts.cursor);
    if (cursor !== undefined) {
      where.push(keysetClause(sort.expr, 'a.uri', dir));
      params.push(cursor.value, cursor.value, cursor.uri);
    }
    params.push(limit);

    const rows = await this.db.query(
      `SELECT a.*, ${sort.expr} AS sort_key FROM albums a ${sort.joins.join(' ')}
       ${whereClause(where)}
       ORDER BY ${sort.expr} ${dir}, a.uri ${dir}
       LIMIT ?`,
      params,
    );
    return this.toPage(rows, limit, rowToAlbum, cursor === undefined ? countSql : undefined, countParams);
  }

  async listArtists(opts: ListOpts): Promise<Page<Artist>> {
    const limit = clampLimit(opts.limit, DEFAULT_PAGE, MAX_PAGE);
    const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
    const sort = artistSort(opts.sort ?? 'title');
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.provider !== undefined) {
      where.push('ar.provider = ?');
      params.push(opts.provider);
    }
    if (opts.genre !== undefined && opts.genre.trim().length > 0) {
      where.push("LOWER(COALESCE(ar.genres_json, '')) LIKE ? ESCAPE '\\'");
      params.push(genrePattern(opts.genre));
    }
    const search = opts.search?.trim();
    if (search !== undefined && search.length > 0) {
      where.push(`ar.name_key LIKE ? ESCAPE '\\'`);
      params.push(containsPattern(normalizeKey(search)));
    }

    const countSql = `SELECT COUNT(*) AS n FROM artists ar ${whereClause(where)}`;
    const countParams = [...params];

    const cursor = decodeCursor(opts.cursor);
    if (cursor !== undefined) {
      where.push(keysetClause(sort.expr, 'ar.uri', dir));
      params.push(cursor.value, cursor.value, cursor.uri);
    }
    params.push(limit);

    const rows = await this.db.query(
      `SELECT ar.*, ${sort.expr} AS sort_key FROM artists ar ${sort.joins.join(' ')}
       ${whereClause(where)}
       ORDER BY ${sort.expr} ${dir}, ar.uri ${dir}
       LIMIT ?`,
      params,
    );
    return this.toPage(rows, limit, rowToArtist, cursor === undefined ? countSql : undefined, countParams);
  }

  async searchLocal(
    query: string,
    limit = 20,
  ): Promise<{ tracks: Track[]; albums: Album[]; artists: Artist[] }> {
    const text = query.trim();
    if (text.length === 0) return { tracks: [], albums: [], artists: [] };
    const n = clampLimit(limit, 20, 200);
    const key = containsPattern(normalizeKey(text));
    const lower = containsPattern(text.toLowerCase());

    const [tracks, albums, artists] = await Promise.all([
      this.searchTracks(text, key, lower, n),
      this.db.query(
        `SELECT * FROM albums
          WHERE name_key LIKE ? ESCAPE '\\' OR LOWER(COALESCE(primary_artist, '')) LIKE ? ESCAPE '\\'
          ORDER BY name_key LIMIT ?`,
        [key, lower, n],
      ),
      this.db.query(
        `SELECT * FROM artists WHERE name_key LIKE ? ESCAPE '\\' ORDER BY name_key LIMIT ?`,
        [key, n],
      ),
    ]);

    return { tracks, albums: albums.map(rowToAlbum), artists: artists.map(rowToArtist) };
  }

  async stats(): Promise<LibraryStats> {
    const row = await this.db.one<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM tracks)                                    AS tracks,
         (SELECT COUNT(*) FROM albums)                                    AS albums,
         (SELECT COUNT(*) FROM artists)                                   AS artists,
         (SELECT COUNT(*) FROM playlists)                                 AS playlists,
         (SELECT COUNT(*) FROM likes WHERE kind = 'track')                AS liked,
         (SELECT COALESCE(SUM(duration_ms), 0) FROM tracks)               AS total_duration_ms,
         (SELECT COALESCE(SUM(file_size), 0) FROM tracks WHERE path IS NOT NULL) AS local_bytes`,
    );
    return {
      tracks: intOr(row?.tracks, 0),
      albums: intOr(row?.albums, 0),
      artists: intOr(row?.artists, 0),
      playlists: intOr(row?.playlists, 0),
      liked: intOr(row?.liked, 0),
      totalDurationMs: intOr(row?.total_duration_ms, 0),
      localBytes: intOr(row?.local_bytes, 0),
    };
  }

  async deleteByPathPrefix(prefix: string): Promise<number> {
    if (prefix.length === 0) return 0;
    return this.db.execute(
      `DELETE FROM tracks WHERE path IS NOT NULL AND path LIKE ? ESCAPE '\\'`,
      [`${escapeLike(prefix)}%`],
    );
  }

  /**
   * Deletes the rows nothing points at any more: an album whose last track just
   * left it, an artist whose last track just went.
   *
   * Called after anything that can orphan a row — removing a track from an
   * album, forgetting tracks, a rescan prune — because an album is only a
   * grouping of tracks, and one with none left is a row the Library would
   * otherwise keep counting for ever.
   */
  async vacuumOrphans(): Promise<void> {
    // Liked entities survive even with no tracks left: the user asked for them
    // explicitly, and re-adding the folder must not lose the like. Only local
    // albums are pruned at all — a remote album row is the provider's record of
    // its own catalogue, and holding none of its tracks is the normal state.
    await this.db.execute(
      `DELETE FROM albums
        WHERE albums.provider = 'local'
          AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_uri = albums.uri)
          AND NOT EXISTS (SELECT 1 FROM likes l WHERE l.uri = albums.uri)`,
    );
    // The artist references live inside `artists_json`, so they are collected
    // once into an ephemeral set rather than probed per artist row. `json_type`
    // guards against a scalar or malformed element aborting the statement.
    await this.db.execute(
      `DELETE FROM artists
        WHERE NOT EXISTS (SELECT 1 FROM likes l WHERE l.uri = artists.uri)
          AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.primary_artist = artists.name)
          AND artists.uri NOT IN (
            SELECT ref FROM (
              SELECT CASE WHEN json_type(j.value) = 'object'
                          THEN json_extract(j.value, '$.uri') END AS ref
                FROM tracks t
                JOIN json_each(CASE WHEN json_valid(t.artists_json) THEN t.artists_json ELSE '[]' END) j
              UNION
              SELECT CASE WHEN json_type(j.value) = 'object'
                          THEN json_extract(j.value, '$.uri') END AS ref
                FROM albums a
                JOIN json_each(CASE WHEN json_valid(a.artists_json) THEN a.artists_json ELSE '[]' END) j
            ) WHERE ref IS NOT NULL
          )`,
    );
  }

  private async searchTracks(
    text: string,
    key: string,
    lower: string,
    limit: number,
  ): Promise<Track[]> {
    const match = ftsQuery(text);
    if (match !== undefined) {
      const rows = await this.db.query(
        `SELECT t.* FROM tracks_fts f JOIN tracks t ON t.uri = f.uri
          WHERE tracks_fts MATCH ? ORDER BY rank LIMIT ?`,
        [match, limit],
      );
      if (rows.length > 0) return rows.map(rowToTrack);
    }
    // FTS tokenisation misses infixes ("beat" inside "heartbeat") and a stale
    // index misses everything, so a substring scan backs it up.
    const rows = await this.db.query(
      `SELECT * FROM tracks
        WHERE title_key LIKE ? ESCAPE '\\' OR LOWER(COALESCE(primary_artist, '')) LIKE ? ESCAPE '\\'
        ORDER BY title_key LIMIT ?`,
      [key, lower, limit],
    );
    return rows.map(rowToTrack);
  }

  private async toPage<T>(
    rows: Array<Record<string, unknown>>,
    limit: number,
    map: (row: Record<string, unknown>) => T,
    countSql: string | undefined,
    countParams: unknown[],
  ): Promise<Page<T>> {
    const page: Page<T> = { items: rows.map(map) };
    const last = rows[rows.length - 1];
    if (rows.length === limit && last !== undefined) {
      const uri = asString(last.uri);
      const sortKey = cursorValue(last.sort_key);
      if (uri !== undefined) page.cursor = encodeCursor(sortKey, uri);
    }
    if (countSql !== undefined) {
      page.total = await this.db.number(countSql, countParams, page.items.length);
    }
    return page;
  }
}

// --- sort specs -------------------------------------------------------------

const PLAYS_JOIN =
  `LEFT JOIN (SELECT track_uri, COUNT(*) AS c FROM play_history WHERE completed = 1 GROUP BY track_uri) h`;

function trackSort(sort: NonNullable<ListOpts['sort']>): SortSpec {
  switch (sort) {
    case 'title':
      return { expr: 't.title_key', joins: [] };
    case 'artist':
      // `tracks` has no artist key column, so the artist row supplies the folded
      // form when it exists and the denormalised name is the fallback.
      return {
        expr: "COALESCE(ar.name_key, LOWER(COALESCE(t.primary_artist, '')))",
        joins: ['LEFT JOIN artists ar ON ar.name = t.primary_artist'],
      };
    case 'album':
      return {
        expr: "COALESCE(al.name_key, '')",
        joins: ['LEFT JOIN albums al ON al.uri = t.album_uri'],
      };
    case 'duration':
      return { expr: 't.duration_ms', joins: [] };
    case 'plays':
      return { expr: 'COALESCE(h.c, 0)', joins: [`${PLAYS_JOIN} ON h.track_uri = t.uri`] };
    case 'added':
    default:
      return { expr: 't.added_at', joins: [] };
  }
}

function albumSort(sort: NonNullable<ListOpts['sort']>): SortSpec {
  switch (sort) {
    case 'artist':
      return { expr: "LOWER(COALESCE(a.primary_artist, ''))", joins: [] };
    case 'added':
      return {
        expr: 'COALESCE((SELECT MIN(added_at) FROM tracks WHERE album_uri = a.uri), a.updated_at)',
        joins: [],
      };
    case 'duration':
      return {
        expr: 'COALESCE((SELECT SUM(duration_ms) FROM tracks WHERE album_uri = a.uri), 0)',
        joins: [],
      };
    case 'plays':
      return {
        expr: `COALESCE((SELECT COUNT(*) FROM play_history h
                           JOIN tracks t ON t.uri = h.track_uri
                          WHERE t.album_uri = a.uri AND h.completed = 1), 0)`,
        joins: [],
      };
    case 'title':
    case 'album':
    default:
      return { expr: 'a.name_key', joins: [] };
  }
}

function artistSort(sort: NonNullable<ListOpts['sort']>): SortSpec {
  switch (sort) {
    case 'added':
      return {
        expr: 'COALESCE((SELECT MIN(added_at) FROM tracks WHERE primary_artist = ar.name), ar.updated_at)',
        joins: [],
      };
    case 'duration':
      return {
        expr: 'COALESCE((SELECT SUM(duration_ms) FROM tracks WHERE primary_artist = ar.name), 0)',
        joins: [],
      };
    case 'plays':
      return {
        expr: `COALESCE((SELECT COUNT(*) FROM play_history h
                           JOIN tracks t ON t.uri = h.track_uri
                          WHERE t.primary_artist = ar.name AND h.completed = 1), 0)`,
        joins: [],
      };
    case 'title':
    case 'artist':
    case 'album':
    default:
      return { expr: 'ar.name_key', joins: [] };
  }
}

/**
 * `(expr, uri) > (v, u)` expanded by hand — row-value syntax only landed in
 * SQLite 3.15 and the mobile hosts do not guarantee it.
 */
function keysetClause(expr: string, uriColumn: string, dir: 'ASC' | 'DESC'): string {
  const cmp = dir === 'ASC' ? '>' : '<';
  return `(${expr} ${cmp} ? OR (${expr} = ? AND ${uriColumn} ${cmp} ?))`;
}

function whereClause(where: string[]): string {
  return where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
}

// --- cursors ----------------------------------------------------------------

export function encodeCursor(value: string | number, uri: Uri): string {
  return encodeURIComponent(JSON.stringify([value, uri]));
}

export function decodeCursor(cursor?: string): { value: string | number; uri: Uri } | undefined {
  if (cursor === undefined || cursor.length === 0) return undefined;
  try {
    const raw: unknown = JSON.parse(decodeURIComponent(cursor));
    if (!Array.isArray(raw) || raw.length < 2) return undefined;
    const value = raw[0];
    const uri = raw[1];
    if (typeof uri !== 'string') return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return { value, uri };
    if (typeof value === 'string') return { value, uri };
    return undefined;
  } catch {
    return undefined;
  }
}

function cursorValue(v: unknown): string | number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = asString(v);
  return s ?? 0;
}

// --- domain → row -----------------------------------------------------------

export function trackParams(track: Track, now: number): unknown[] {
  const title = track.title.length > 0 ? track.title : 'Unknown track';
  return [
    track.uri,
    track.provider,
    title,
    normalizeKey(title),
    JSON.stringify(track.artists ?? []),
    track.artists?.[0]?.name ?? null,
    nonEmpty(track.album?.uri) ?? null,
    track.album === undefined ? null : JSON.stringify(track.album),
    Math.max(0, Math.trunc(track.durationMs || 0)),
    intOrNull(track.trackNumber),
    intOrNull(track.discNumber),
    nonEmpty(track.releaseDate) ?? null,
    jsonArrayOrNull(track.genres),
    artworkJson(track.artwork),
    numberOrNull(track.popularity),
    track.explicit ? 1 : 0,
    track.isLive ? 1 : 0,
    numberOrNull(track.gainDb),
    nonEmpty(track.path) ?? null,
    recordJson(track.meta),
    now,
    now,
  ];
}

function albumParams(album: Album, now: number): unknown[] {
  const name = album.name.length > 0 ? album.name : 'Unknown album';
  return [
    album.uri,
    album.provider,
    name,
    normalizeKey(name),
    JSON.stringify(album.artists ?? []),
    album.artists?.[0]?.name ?? null,
    artworkJson(album.artwork),
    nonEmpty(album.releaseDate) ?? null,
    nonEmpty(album.albumType) ?? null,
    intOrNull(album.totalTracks),
    jsonArrayOrNull(album.genres),
    now,
  ];
}

function artistParams(artist: Artist, now: number): unknown[] {
  const name = artist.name.length > 0 ? artist.name : 'Unknown artist';
  return [
    artist.uri,
    artist.provider,
    name,
    normalizeKey(name),
    artworkJson(artist.artwork),
    jsonArrayOrNull(artist.genres),
    intOrNull(artist.followers),
    nonEmpty(artist.bio) ?? null,
    now,
  ];
}

function albumStubParams(album: AlbumRef, track: Track, now: number): unknown[] {
  const name = album.name.length > 0 ? album.name : 'Unknown album';
  return [
    album.uri,
    track.provider,
    name,
    normalizeKey(name),
    JSON.stringify(track.artists ?? []),
    track.artists?.[0]?.name ?? null,
    artworkJson(album.artwork ?? track.artwork),
    now,
  ];
}

function artworkJson(artwork: Artwork | undefined): string | null {
  if (artwork === undefined) return null;
  const sources = artwork.sources ?? [];
  if (sources.length === 0 && artwork.placeholder === undefined) return null;
  return JSON.stringify(artwork);
}

function jsonArrayOrNull(values: string[] | undefined): string | null {
  if (values === undefined) return null;
  const clean = values.map((v) => v.trim()).filter((v) => v.length > 0);
  return clean.length === 0 ? null : JSON.stringify(clean);
}

function recordJson(meta: Record<string, unknown> | undefined): string | null {
  if (meta === undefined || Object.keys(meta).length === 0) return null;
  try {
    return JSON.stringify(meta);
  } catch {
    return null;
  }
}

function intOrNull(v: number | undefined): number | null {
  if (v === undefined || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

function numberOrNull(v: number | undefined): number | null {
  if (v === undefined || !Number.isFinite(v)) return null;
  return v;
}

// --- row → domain -----------------------------------------------------------

export function rowToTrack(r: Record<string, unknown>): Track {
  const uri = asString(r.uri) ?? '';
  const provider = providerOf(r.provider, uri);
  return {
    uri,
    provider,
    title: asString(r.title) ?? 'Unknown track',
    artists: parseArtistRefs(r.artists_json, asString(r.primary_artist), provider),
    album: parseAlbumRef(r.album_json, asString(r.album_uri)),
    durationMs: nonNegativeInt(r.duration_ms),
    trackNumber: positiveInt(r.track_number),
    discNumber: positiveInt(r.disc_number),
    releaseDate: nonEmpty(asString(r.release_date)),
    genres: parseStringArray(r.genres_json),
    artwork: parseArtwork(r.artwork_json),
    popularity: clamp01(asNumber(r.popularity)),
    explicit: asBool(r.explicit),
    isLive: asBool(r.is_live),
    gainDb: asNumber(r.gain_db),
    path: nonEmpty(asString(r.path)),
    meta: parseRecord(r.meta_json),
  };
}

export function rowToAlbum(r: Record<string, unknown>): Album {
  const uri = asString(r.uri) ?? '';
  const provider = providerOf(r.provider, uri);
  return {
    uri,
    provider,
    name: asString(r.name) ?? 'Unknown album',
    artists: parseArtistRefs(r.artists_json, asString(r.primary_artist), provider),
    artwork: parseArtwork(r.artwork_json),
    releaseDate: nonEmpty(asString(r.release_date)),
    albumType: nonEmpty(asString(r.album_type)),
    totalTracks: positiveInt(r.total_tracks),
    genres: parseStringArray(r.genres_json),
  };
}

export function rowToArtist(r: Record<string, unknown>): Artist {
  const uri = asString(r.uri) ?? '';
  return {
    uri,
    provider: providerOf(r.provider, uri),
    name: asString(r.name) ?? 'Unknown artist',
    artwork: parseArtwork(r.artwork_json),
    genres: parseStringArray(r.genres_json),
    followers: positiveInt(r.followers),
    bio: nonEmpty(asString(r.bio)),
  };
}

export function rowToPlaylist(r: Record<string, unknown>): Playlist {
  const uri = asString(r.uri) ?? '';
  const raw = asString(r.provider);
  const provider: ProviderId | 'ritmo' =
    raw !== undefined && isProviderId(raw) ? raw : 'ritmo';
  return {
    uri,
    provider,
    name: asString(r.name) ?? 'Untitled playlist',
    description: nonEmpty(asString(r.description)),
    artwork: parseArtwork(r.artwork_json),
    owner: nonEmpty(asString(r.owner)),
    trackCount: positiveInt(r.track_count),
    editable: asBool(r.editable),
  };
}

function albumFromTracks(uri: Uri, tracks: Track[]): Album {
  const first = tracks[0];
  return {
    uri,
    provider: first?.provider ?? providerOf(undefined, uri),
    name: first?.album?.name ?? 'Unknown album',
    artists: first?.artists ?? [],
    artwork: tracks.find((t) => t.artwork !== undefined)?.artwork,
    releaseDate: first?.releaseDate,
    totalTracks: tracks.length,
    genres: first?.genres,
  };
}

// --- SQL text ---------------------------------------------------------------

export function placeholders(n: number): string {
  return new Array(Math.max(0, n)).fill('?').join(', ');
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function containsPattern(s: string): string {
  return `%${escapeLike(s)}%`;
}

/** Matches one `{"uri":"…"}` entry inside an `artists_json` array. */
export function refPattern(uri: Uri): string {
  return `%${escapeLike(`"uri":"${uri}"`)}%`;
}

function genrePattern(genre: string): string {
  return `%${escapeLike(`"${genre.trim().toLowerCase()}"`)}%`;
}

/**
 * FTS5 MATCH expression: every token quoted so punctuation and reserved words
 * are literals, with a prefix wildcard on the last token — the one still being
 * typed.
 */
export function ftsQuery(text: string): string | undefined {
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  const last = tokens.length - 1;
  return tokens
    .map((t, i) => `"${t.replace(/"/g, '""')}"${i === last ? '*' : ''}`)
    .join(' ');
}

function firstLine(sql: string): string {
  const line = sql.trim().split('\n', 1)[0] ?? sql;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

// --- collections ------------------------------------------------------------


export function dedupe(uris: readonly Uri[]): Uri[] {
  const seen = new Set<Uri>();
  const out: Uri[] = [];
  for (const uri of uris) {
    if (uri.length === 0 || seen.has(uri)) continue;
    seen.add(uri);
    out.push(uri);
  }
  return out;
}

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(limit)));
}

export { ROWS_PER_INSERT, IN_CHUNK, STATEMENT_BATCH };

// --- tolerant value coercion ------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.length > 0 ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const n = asNumber(v);
  return n !== undefined && n !== 0;
}

export function intOr(v: unknown, fallback: number): number {
  const n = asNumber(v);
  return n === undefined ? fallback : Math.trunc(n);
}

function nonNegativeInt(v: unknown): number {
  const n = asNumber(v);
  return n === undefined || n < 0 ? 0 : Math.trunc(n);
}

function positiveInt(v: unknown): number | undefined {
  const n = asNumber(v);
  if (n === undefined || n <= 0) return undefined;
  return Math.trunc(n);
}

function clamp01(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  return Math.min(1, Math.max(0, v));
}

function isProviderId(v: string): v is ProviderId {
  return v === 'local' || v === 'audius' || v === 'jamendo' || v === 'archive' || v === 'radio';
}

function providerOf(v: unknown, uri: Uri): ProviderId {
  const raw = asString(v);
  if (raw !== undefined && isProviderId(raw)) return raw;
  const colon = uri.indexOf(':');
  if (colon > 0) {
    const fromUri = uri.slice(0, colon);
    if (isProviderId(fromUri)) return fromUri;
  }
  return 'local';
}

/** Accepts either a JSON TEXT column or an already-decoded value. */
export function decodeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function parseRecord(v: unknown): Record<string, unknown> | undefined {
  const raw = decodeJson(v);
  return isRecord(raw) ? raw : undefined;
}

export function parseStringArray(v: unknown): string[] | undefined {
  const raw = decodeJson(v);
  if (typeof raw === 'string') {
    const one = raw.trim();
    return one.length > 0 ? [one] : undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    const s = asString(item);
    if (s !== undefined && s.trim().length > 0) out.push(s.trim());
  }
  return out.length > 0 ? out : undefined;
}

export function parseArtistRefs(
  v: unknown,
  fallbackName: string | undefined,
  provider: ProviderId,
): ArtistRef[] {
  const raw = decodeJson(v);
  const out: ArtistRef[] = [];
  const seen = new Set<string>();
  const add = (uri: string | undefined, name: string | undefined): void => {
    const label = name?.trim();
    if (label === undefined || label.length === 0) return;
    const ref: ArtistRef = {
      uri: uri !== undefined && uri.length > 0 ? uri : makeUri(provider, 'artist', normalizeKey(label)),
      name: label,
    };
    if (seen.has(ref.uri)) return;
    seen.add(ref.uri);
    out.push(ref);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        add(undefined, item);
        continue;
      }
      if (!isRecord(item)) continue;
      add(asString(item.uri), asString(item.name));
    }
  } else if (isRecord(raw)) {
    add(asString(raw.uri), asString(raw.name));
  } else if (typeof raw === 'string') {
    add(undefined, raw);
  }

  if (out.length === 0) add(undefined, fallbackName ?? 'Unknown artist');
  return out;
}

export function parseAlbumRef(v: unknown, albumUri: string | undefined): AlbumRef | undefined {
  const raw = decodeJson(v);
  if (isRecord(raw)) {
    const uri = nonEmpty(asString(raw.uri)) ?? nonEmpty(albumUri);
    const name = nonEmpty(asString(raw.name));
    if (uri === undefined && name === undefined) return undefined;
    return { uri: uri ?? '', name: name ?? '', artwork: parseArtwork(raw.artwork) };
  }
  const name = typeof raw === 'string' ? nonEmpty(raw) : undefined;
  const uri = nonEmpty(albumUri);
  if (uri === undefined && name === undefined) return undefined;
  return { uri: uri ?? '', name: name ?? '' };
}

export function parseArtwork(v: unknown): Artwork | undefined {
  const raw = decodeJson(v);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    return raw.length > 0 ? { sources: [{ url: raw, size: 0 }] } : undefined;
  }
  let sources: ArtworkSource[] = [];
  let placeholder: string | undefined;
  let accent: string | undefined;
  if (Array.isArray(raw)) {
    sources = toSources(raw);
  } else if (isRecord(raw)) {
    sources = toSources(raw.sources);
    placeholder = nonEmpty(asString(raw.placeholder));
    accent = nonEmpty(asString(raw.accent));
  }
  if (sources.length === 0 && placeholder === undefined) return undefined;
  sources.sort((a, b) => a.size - b.size);
  return { sources, placeholder, accent };
}

function toSources(v: unknown): ArtworkSource[] {
  if (!Array.isArray(v)) return [];
  const out: ArtworkSource[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      if (item.length > 0) out.push({ url: item, size: 0 });
      continue;
    }
    if (!isRecord(item)) continue;
    const url = nonEmpty(asString(item.url));
    if (url === undefined) continue;
    out.push({ url, size: Math.max(0, Math.trunc(asNumber(item.size) ?? 0)) });
  }
  return out;
}

/**
 * `playlist_items.track_json` and `play_history.track_json` hold a camelCase
 * domain snapshot, not a table row — a provider that disappears must still
 * render from these.
 */
export function parseTrackSnapshot(v: unknown): Track | undefined {
  const raw = decodeJson(v);
  if (!isRecord(raw)) return undefined;
  const uri = nonEmpty(asString(raw.uri));
  if (uri === undefined) return undefined;
  const provider = providerOf(raw.provider, uri);
  return {
    uri,
    provider,
    title: asString(raw.title) ?? 'Unknown track',
    artists: parseArtistRefs(raw.artists, undefined, provider),
    album: parseAlbumRef(raw.album, undefined),
    durationMs: nonNegativeInt(raw.durationMs),
    trackNumber: positiveInt(raw.trackNumber),
    discNumber: positiveInt(raw.discNumber),
    releaseDate: nonEmpty(asString(raw.releaseDate)),
    genres: parseStringArray(raw.genres),
    artwork: parseArtwork(raw.artwork),
    popularity: clamp01(asNumber(raw.popularity)),
    explicit: asBool(raw.explicit),
    isLive: asBool(raw.isLive),
    gainDb: asNumber(raw.gainDb),
    path: nonEmpty(asString(raw.path)),
    meta: parseRecord(raw.meta),
  };
}

export function parseAlbumSnapshot(v: unknown): Album | undefined {
  const raw = decodeJson(v);
  if (!isRecord(raw)) return undefined;
  const uri = nonEmpty(asString(raw.uri));
  if (uri === undefined) return undefined;
  const provider = providerOf(raw.provider, uri);
  return {
    uri,
    provider,
    name: asString(raw.name) ?? 'Unknown album',
    artists: parseArtistRefs(raw.artists, undefined, provider),
    artwork: parseArtwork(raw.artwork),
    releaseDate: nonEmpty(asString(raw.releaseDate)),
    albumType: nonEmpty(asString(raw.albumType)),
    totalTracks: positiveInt(raw.totalTracks),
    genres: parseStringArray(raw.genres),
  };
}

export function parseArtistSnapshot(v: unknown): Artist | undefined {
  const raw = decodeJson(v);
  if (!isRecord(raw)) return undefined;
  const uri = nonEmpty(asString(raw.uri));
  if (uri === undefined) return undefined;
  return {
    uri,
    provider: providerOf(raw.provider, uri),
    name: asString(raw.name) ?? 'Unknown artist',
    artwork: parseArtwork(raw.artwork),
    genres: parseStringArray(raw.genres),
    followers: positiveInt(raw.followers),
    bio: nonEmpty(asString(raw.bio)),
  };
}

export function parsePlaylistSnapshot(v: unknown): Playlist | undefined {
  const raw = decodeJson(v);
  if (!isRecord(raw)) return undefined;
  const uri = nonEmpty(asString(raw.uri));
  if (uri === undefined) return undefined;
  const providerRaw = asString(raw.provider);
  const provider: ProviderId | 'ritmo' =
    providerRaw !== undefined && isProviderId(providerRaw) ? providerRaw : 'ritmo';
  const tracks: Track[] = [];
  if (Array.isArray(raw.tracks)) {
    for (const item of raw.tracks) {
      const track = parseTrackSnapshot(item);
      if (track !== undefined) tracks.push(track);
    }
  }
  return {
    uri,
    provider,
    name: asString(raw.name) ?? 'Untitled playlist',
    description: nonEmpty(asString(raw.description)),
    artwork: parseArtwork(raw.artwork),
    owner: nonEmpty(asString(raw.owner)),
    trackCount: tracks.length > 0 ? tracks.length : positiveInt(raw.trackCount),
    editable: asBool(raw.editable),
    tracks: tracks.length > 0 ? tracks : undefined,
  };
}
