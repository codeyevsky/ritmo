/**
 * The user's own files, as a provider.
 *
 * Everything here is a query against the schema in `docs/schema.sql` — the Rust
 * scanner owns writing those rows, this file only reads them. It never touches
 * the filesystem itself: `path` comes out of the database and is handed to
 * `host.files.toPlayableUrl` for playback.
 *
 * Every column that holds JSON is treated as untrusted: a half-written scan or a
 * hand-edited database must degrade to a listenable track, not to an exception.
 */

import { emptySearchResults, makeUri } from '../types';
import type {
  Album, AlbumRef, Artist, ArtistRef, Artwork, ArtworkSource, EntityKind, Page,
  Playlist, ProviderId, SearchQuery, SearchResults, Shelf, ShelfItem, StreamRef,
  Track, Uri,
} from '../types';
import type { DatabaseBridge } from '../host/types';
import { ProviderError } from './types';
import type { MusicProvider, ProviderCapabilities, ProviderContext } from './types';
import { normalizeKey } from '../util/text';

const PROVIDER = 'local' as const;

const CAPABILITIES: ProviderCapabilities = {
  search: true,
  albums: true,
  artists: true,
  playlists: true,
  stations: false,
  related: true,
  shelves: true,
  downloadable: false,
  needsNetwork: false,
};

const ALL_KINDS: EntityKind[] = ['track', 'album', 'artist', 'playlist'];

const SHELF_SIZE = 24;
const ALBUM_PAGE = 50;
const TOP_TRACKS = 20;
/** An album untouched for this long is fair game for the "Rediscover" shelf. */
const REDISCOVER_MS = 60 * 24 * 60 * 60 * 1000;

/** Track ordering inside an album: NULL disc/track numbers sort last, not first. */
const ALBUM_TRACK_ORDER =
  'ORDER BY COALESCE(disc_number, 1), COALESCE(track_number, 1000000), title COLLATE NOCASE';

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  alac: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  wv: 'audio/x-wavpack',
  ape: 'audio/x-ape',
  mpc: 'audio/x-musepack',
};

export class LocalProvider implements MusicProvider {
  readonly id: ProviderId = PROVIDER;
  readonly displayName = 'This computer';
  readonly capabilities = CAPABILITIES;

  constructor(private readonly ctx: ProviderContext) {}

  private get db(): DatabaseBridge {
    return this.ctx.host.db;
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    const text = query.text.trim();
    const results = emptySearchResults();
    if (text.length === 0) return results;

    const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : ALL_KINDS;
    const limit = clampLimit(query.limit, 25);
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));

    const jobs: Array<Promise<void>> = [];
    if (kinds.includes('track')) {
      jobs.push(this.searchTracks(text, limit, offset).then((t) => { results.tracks = t; }));
    }
    if (kinds.includes('album')) {
      jobs.push(this.searchAlbums(text, limit, offset).then((a) => { results.albums = a; }));
    }
    if (kinds.includes('artist')) {
      jobs.push(this.searchArtists(text, limit, offset).then((a) => { results.artists = a; }));
    }
    if (kinds.includes('playlist')) {
      jobs.push(this.searchPlaylists(text, limit, offset).then((p) => { results.playlists = p; }));
    }
    await Promise.all(jobs);
    return results;
  }

  private async searchTracks(text: string, limit: number, offset: number): Promise<Track[]> {
    const match = ftsQuery(text);
    if (match === undefined) return [];
    const rows = await this.rows(
      `SELECT t.* FROM tracks_fts f JOIN tracks t ON t.uri = f.uri
       WHERE tracks_fts MATCH ? AND t.provider = 'local'
       ORDER BY rank LIMIT ? OFFSET ?`,
      [match, limit, offset],
    );
    if (rows.length > 0) return rows.map(rowToTrack);
    // FTS tokenisation can miss what a plain substring finds ("beat" inside
    // "heartbeat"), and a stale index finds nothing at all.
    const fallback = await this.rows(
      `SELECT * FROM tracks
       WHERE provider = 'local' AND (title_key LIKE ? ESCAPE '\\' OR LOWER(COALESCE(primary_artist, '')) LIKE ? ESCAPE '\\')
       ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?`,
      [containsPattern(normalizeKey(text)), containsPattern(text.toLowerCase()), limit, offset],
    );
    return fallback.map(rowToTrack);
  }

  private async searchAlbums(text: string, limit: number, offset: number): Promise<Album[]> {
    const rows = await this.rows(
      `SELECT * FROM albums
       WHERE provider = 'local' AND (name_key LIKE ? ESCAPE '\\' OR LOWER(COALESCE(primary_artist, '')) LIKE ? ESCAPE '\\')
       ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
      [containsPattern(normalizeKey(text)), containsPattern(text.toLowerCase()), limit, offset],
    );
    return rows.map(rowToAlbum);
  }

  private async searchArtists(text: string, limit: number, offset: number): Promise<Artist[]> {
    const rows = await this.rows(
      `SELECT * FROM artists
       WHERE provider = 'local' AND name_key LIKE ? ESCAPE '\\'
       ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
      [containsPattern(normalizeKey(text)), limit, offset],
    );
    return rows.map(rowToArtist);
  }

  private async searchPlaylists(text: string, limit: number, offset: number): Promise<Playlist[]> {
    const rows = await this.rows(
      `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_uri = p.uri) AS track_count
       FROM playlists p
       WHERE p.provider IN ('local', 'ritmo') AND LOWER(p.name) LIKE ? ESCAPE '\\'
       ORDER BY p.sort_order, p.updated_at DESC LIMIT ? OFFSET ?`,
      [containsPattern(text.toLowerCase()), limit, offset],
    );
    return rows.map(rowToPlaylist);
  }

  async getTrack(uri: Uri): Promise<Track> {
    const row = await this.one('SELECT * FROM tracks WHERE uri = ? LIMIT 1', [uri]);
    if (!row) throw new ProviderError('not_found', `local track not found: ${uri}`, PROVIDER);
    return rowToTrack(row);
  }

  async getAlbum(uri: Uri): Promise<Album> {
    const [row, trackRows] = await Promise.all([
      this.one('SELECT * FROM albums WHERE uri = ? LIMIT 1', [uri]),
      this.rows(`SELECT * FROM tracks WHERE album_uri = ? ${ALBUM_TRACK_ORDER}`, [uri]),
    ]);
    if (!row && trackRows.length === 0) {
      throw new ProviderError('not_found', `local album not found: ${uri}`, PROVIDER);
    }
    const tracks = trackRows.map(rowToTrack);
    const album = row ? rowToAlbum(row) : albumFromTracks(uri, tracks);
    album.tracks = tracks;
    if (album.totalTracks === undefined || album.totalTracks < tracks.length) {
      album.totalTracks = tracks.length;
    }
    if (!album.artwork) album.artwork = tracks.find((t) => t.artwork)?.artwork;
    return album;
  }

  async getArtist(uri: Uri): Promise<Artist> {
    const row = await this.one('SELECT * FROM artists WHERE uri = ? LIMIT 1', [uri]);
    if (row) return rowToArtist(row);
    const name = await this.artistName(uri);
    if (name === undefined) {
      throw new ProviderError('not_found', `local artist not found: ${uri}`, PROVIDER);
    }
    return { uri, provider: PROVIDER, name };
  }

  async getArtistAlbums(uri: Uri, cursor?: string): Promise<Page<Album>> {
    const name = await this.artistName(uri);
    const offset = parseCursor(cursor);
    const rows = await this.rows(
      `SELECT * FROM albums
       WHERE provider = 'local'
         AND (artists_json LIKE ? ESCAPE '\\' OR (? IS NOT NULL AND primary_artist = ?))
       ORDER BY COALESCE(release_date, '') DESC, name COLLATE NOCASE
       LIMIT ? OFFSET ?`,
      [refPattern(uri), name ?? null, name ?? null, ALBUM_PAGE + 1, offset],
    );
    const items = rows.slice(0, ALBUM_PAGE).map(rowToAlbum);
    return {
      items,
      cursor: rows.length > ALBUM_PAGE ? String(offset + ALBUM_PAGE) : undefined,
    };
  }

  async getArtistTopTracks(uri: Uri): Promise<Track[]> {
    const name = await this.artistName(uri);
    const rows = await this.rows(
      `SELECT t.*, (SELECT COUNT(*) FROM play_history h WHERE h.track_uri = t.uri) AS play_count
       FROM tracks t
       WHERE t.provider = 'local'
         AND (t.artists_json LIKE ? ESCAPE '\\' OR (? IS NOT NULL AND t.primary_artist = ?))
       ORDER BY play_count DESC, COALESCE(t.popularity, 0) DESC, t.title COLLATE NOCASE
       LIMIT ?`,
      [refPattern(uri), name ?? null, name ?? null, TOP_TRACKS],
    );
    return rows.map(rowToTrack);
  }

  async getPlaylist(uri: Uri): Promise<Playlist> {
    const row = await this.one('SELECT * FROM playlists WHERE uri = ? LIMIT 1', [uri]);
    if (!row) throw new ProviderError('not_found', `local playlist not found: ${uri}`, PROVIDER);
    const itemRows = await this.rows(
      'SELECT track_json FROM playlist_items WHERE playlist_uri = ? ORDER BY position',
      [uri],
    );
    const tracks: Track[] = [];
    for (const item of itemRows) {
      const track = parseTrackSnapshot(item.track_json);
      if (track) tracks.push(track);
    }
    const playlist = rowToPlaylist(row);
    playlist.tracks = tracks;
    playlist.trackCount = tracks.length;
    return playlist;
  }

  async getStream(track: Track): Promise<StreamRef> {
    const path = track.path ?? (await this.pathFor(track.uri));
    if (path === undefined || path.length === 0) {
      throw new ProviderError('not_found', `local track has no file path: ${track.uri}`, PROVIDER);
    }
    return {
      url: this.ctx.host.files.toPlayableUrl(path),
      kind: 'progressive',
      mimeType: mimeForPath(path),
      localPath: path,
    };
  }

  async getRelatedTracks(track: Track, limit: number): Promise<Track[]> {
    const want = clampLimit(limit, 20, 300);
    const picked: Track[] = [];
    const seen = new Set<Uri>([track.uri]);
    const absorb = (rows: Array<Record<string, unknown>>): void => {
      for (const row of rows) {
        if (picked.length >= want) return;
        const candidate = rowToTrack(row);
        if (candidate.uri.length === 0 || seen.has(candidate.uri)) continue;
        seen.add(candidate.uri);
        picked.push(candidate);
      }
    };

    const albumUri = track.album?.uri;
    if (albumUri !== undefined && albumUri.length > 0) {
      absorb(await this.safeRows(
        `SELECT * FROM tracks WHERE provider = 'local' AND album_uri = ? AND uri <> ? ${ALBUM_TRACK_ORDER} LIMIT ?`,
        [albumUri, track.uri, want],
      ));
    }

    const artist = track.artists[0];
    if (picked.length < want && artist) {
      absorb(await this.safeRows(
        `SELECT * FROM tracks
         WHERE provider = 'local' AND uri <> ?
           AND (artists_json LIKE ? ESCAPE '\\' OR primary_artist = ?)
         ORDER BY RANDOM() LIMIT ?`,
        [track.uri, refPattern(artist.uri), artist.name, want],
      ));
    }

    const genre = track.genres?.[0];
    if (picked.length < want && genre !== undefined && genre.length > 0) {
      absorb(await this.safeRows(
        `SELECT * FROM tracks
         WHERE provider = 'local' AND uri <> ? AND genres_json IS NOT NULL
           AND LOWER(genres_json) LIKE ? ESCAPE '\\'
         ORDER BY RANDOM() LIMIT ?`,
        [track.uri, containsPattern(genre.toLowerCase()), want],
      ));
    }

    return picked;
  }

  async getShelves(): Promise<Shelf[]> {
    const playedSince = Date.now() - REDISCOVER_MS;
    const [recentRows, rediscoverRows, topRows] = await Promise.all([
      this.safeRows(
        `SELECT a.*, MAX(t.added_at) AS recent_at
         FROM albums a JOIN tracks t ON t.album_uri = a.uri
         WHERE a.provider = 'local'
         GROUP BY a.uri
         ORDER BY recent_at DESC LIMIT ?`,
        [SHELF_SIZE],
      ),
      this.safeRows(
        `SELECT a.* FROM albums a
         WHERE a.provider = 'local'
           AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_uri = a.uri)
           AND NOT EXISTS (
             SELECT 1 FROM play_history h JOIN tracks t2 ON t2.uri = h.track_uri
             WHERE t2.album_uri = a.uri AND h.played_at >= ?)
         ORDER BY RANDOM() LIMIT ?`,
        [playedSince, SHELF_SIZE],
      ),
      this.safeRows(
        `SELECT t.*, COUNT(h.id) AS play_count, MAX(h.played_at) AS last_played
         FROM tracks t JOIN play_history h ON h.track_uri = t.uri
         WHERE t.provider = 'local'
         GROUP BY t.uri
         ORDER BY play_count DESC, last_played DESC LIMIT ?`,
        [SHELF_SIZE],
      ),
    ]);

    const shelves: Shelf[] = [];
    pushShelf(shelves, 'local-recent', SHELF_COPY.recent, albumItems(recentRows));
    pushShelf(shelves, 'local-rediscover', SHELF_COPY.rediscover, albumItems(rediscoverRows));
    pushShelf(shelves, 'local-top', SHELF_COPY.top, trackItems(topRows));
    return shelves;
  }

  /** How many tracks the scan has produced — gates local-only recommendations. */
  async countTracks(): Promise<number> {
    const row = await this.one(
      "SELECT COUNT(*) AS n FROM tracks WHERE provider = 'local'",
      [],
    );
    return row ? Math.max(0, Math.trunc(asNumber(row.n) ?? 0)) : 0;
  }

  /** Random local tracks tagged with `genre`; the genre match is substring-wise
   *  because tags in the wild read "Alternative Rock" where we ask for "Rock". */
  async tracksByGenre(genre: string, limit: number, excludeUri?: Uri): Promise<Track[]> {
    const needle = genre.trim().toLowerCase();
    if (needle.length === 0) return [];
    const rows = await this.safeRows(
      `SELECT * FROM tracks
       WHERE provider = 'local' AND genres_json IS NOT NULL
         AND LOWER(genres_json) LIKE ? ESCAPE '\\'
         AND (? IS NULL OR uri <> ?)
       ORDER BY RANDOM() LIMIT ?`,
      [containsPattern(needle), excludeUri ?? null, excludeUri ?? null, clampLimit(limit, 25, 300)],
    );
    return rows.map(rowToTrack);
  }

  private async pathFor(uri: Uri): Promise<string | undefined> {
    const row = await this.one('SELECT path FROM tracks WHERE uri = ? LIMIT 1', [uri]);
    return row ? asString(row.path) : undefined;
  }

  /** The `artists` table is optional data; tracks always carry their refs. */
  private async artistName(uri: Uri): Promise<string | undefined> {
    const row = await this.one('SELECT name FROM artists WHERE uri = ? LIMIT 1', [uri]);
    const fromTable = row ? asString(row.name) : undefined;
    if (fromTable !== undefined && fromTable.length > 0) return fromTable;

    const fromTrack = await this.one(
      `SELECT artists_json, primary_artist FROM tracks
       WHERE provider = 'local' AND artists_json LIKE ? ESCAPE '\\' LIMIT 1`,
      [refPattern(uri)],
    );
    if (!fromTrack) return undefined;
    const refs = parseArtistRefs(fromTrack.artists_json, asString(fromTrack.primary_artist), PROVIDER);
    return refs.find((r) => r.uri === uri)?.name ?? asString(fromTrack.primary_artist);
  }

  private async rows(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    try {
      return await this.db.query<Record<string, unknown>>(sql, params);
    } catch (err) {
      throw new ProviderError('unknown', `local query failed: ${errText(err)}`, PROVIDER, err);
    }
  }

  private async one(sql: string, params: unknown[]): Promise<Record<string, unknown> | undefined> {
    const rows = await this.rows(sql, params);
    return rows[0];
  }

  /** Shelves and recommendations are decoration: a broken query yields nothing. */
  private async safeRows(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    try {
      return await this.db.query<Record<string, unknown>>(sql, params);
    } catch {
      return [];
    }
  }
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
  const provider: ProviderId | 'ritmo' = raw === 'ritmo'
    ? 'ritmo'
    : raw !== undefined && isProviderId(raw) ? raw : 'ritmo';
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

// --- shelf assembly ---------------------------------------------------------

/**
 * Shelf headings carry an i18n key plus an English literal: this module has no
 * locale, and the key would be unreadable if the dictionary ever lost it.
 */
const SHELF_COPY = {
  recent: {
    titleKey: 'shelf.localRecentTitle',
    title: 'Recently added',
  },
  rediscover: {
    titleKey: 'shelf.localRediscoverTitle',
    title: 'Rediscover',
    subtitleKey: 'shelf.localRediscoverSubtitle',
    subtitle: "Albums you haven't played in a while",
  },
  top: {
    titleKey: 'shelf.localTopTitle',
    title: 'Your most played',
  },
} as const;

function pushShelf(
  into: Shelf[],
  id: string,
  copy: (typeof SHELF_COPY)[keyof typeof SHELF_COPY],
  items: ShelfItem[],
): void {
  if (items.length === 0) return;
  into.push({ id, ...copy, items });
}

function albumItems(rows: Array<Record<string, unknown>>): ShelfItem[] {
  return rows.map((row) => ({ type: 'album', album: rowToAlbum(row) }));
}

function trackItems(rows: Array<Record<string, unknown>>): ShelfItem[] {
  return rows.map((row) => ({ type: 'track', track: rowToTrack(row) }));
}

function albumFromTracks(uri: Uri, tracks: Track[]): Album {
  const first = tracks[0];
  return {
    uri,
    provider: PROVIDER,
    name: first?.album?.name ?? 'Unknown album',
    artists: first?.artists ?? [],
    artwork: tracks.find((t) => t.artwork)?.artwork,
    releaseDate: first?.releaseDate,
    totalTracks: tracks.length,
    genres: first?.genres,
  };
}

// --- SQL text ---------------------------------------------------------------

/**
 * FTS5 MATCH expression: every token quoted (so punctuation and reserved words
 * like `OR` are literals) with a prefix wildcard on the last one, which is the
 * one the user is still typing.
 */
function ftsQuery(text: string): string | undefined {
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  const last = tokens.length - 1;
  return tokens
    .map((t, i) => `"${t.replace(/"/g, '""')}"${i === last ? '*' : ''}`)
    .join(' ');
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function containsPattern(s: string): string {
  return `%${escapeLike(s)}%`;
}

/** Matches a `{"uri":"…"}` entry inside an `artists_json` array. */
function refPattern(uri: Uri): string {
  return `%${escapeLike(`"uri":"${uri}"`)}%`;
}

function parseCursor(cursor?: string): number {
  if (cursor === undefined) return 0;
  const n = Number(cursor);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function mimeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return MIME_BY_EXT[path.slice(dot + 1).toLowerCase()];
}

function clampLimit(limit: number | undefined, fallback: number, max = 200): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(limit)));
}

// --- tolerant value coercion ------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const n = asNumber(v);
  if (n !== undefined) return n !== 0;
  return false;
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
  return PROVIDER;
}

/** Accepts either a JSON TEXT column or an already-decoded value. */
function decode(v: unknown): unknown {
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
  const raw = decode(v);
  return isRecord(raw) ? raw : undefined;
}

function parseStringArray(v: unknown): string[] | undefined {
  const raw = decode(v);
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

function parseArtistRefs(v: unknown, fallbackName: string | undefined, provider: ProviderId): ArtistRef[] {
  const raw = decode(v);
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
      if (typeof item === 'string') { add(undefined, item); continue; }
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

function parseAlbumRef(v: unknown, albumUri: string | undefined): AlbumRef | undefined {
  const raw = decode(v);
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

function parseArtwork(v: unknown): Artwork | undefined {
  const raw = decode(v);
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

/** `playlist_items.track_json` is a camelCase domain snapshot, not a table row. */
function parseTrackSnapshot(v: unknown): Track | undefined {
  const raw = decode(v);
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

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  const s = asString(err);
  return s ?? 'unknown error';
}
