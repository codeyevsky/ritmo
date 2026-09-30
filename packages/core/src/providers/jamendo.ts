/**
 * Jamendo — a catalogue of Creative Commons licensed music.
 *
 * Two things shape this client: there is no anonymous tier, so a user-supplied
 * `client_id` gates every call, and every response is wrapped in a `headers`
 * envelope that reports failure with HTTP 200, so the envelope has to be
 * inspected on every single request.
 */

import { emptySearchResults, makeUri, parseUri } from '../types';
import type {
  Album, AlbumRef, Artist, ArtistRef, Artwork, EntityKind, Page, ParsedUri,
  Playlist, SearchQuery, SearchResults, Shelf, ShelfItem, StreamRef, Track, Uri,
} from '../types';
import { ProviderError } from './types';
import type { MusicProvider, ProviderCapabilities, ProviderContext } from './types';

const PROVIDER = 'jamendo' as const;
const BASE = 'https://api.jamendo.com/v3.0';
const CLIENT_ID_KEY = 'clientId';

/** Where Settings sends the user to create a free API client. */
export const JAMENDO_SIGNUP_URL = 'https://devportal.jamendo.com/';

const TTL_SEARCH = 300;
const TTL_ENTITY = 3600;
// Weekly-popularity lists barely move; matched to the other providers'
// shelf TTLs so the home screen is not re-fetching one source every 15 min.
const TTL_SHELVES = 3600;
const TTL_OFFLINE = 7 * 24 * 3600;

const PAGE_LIMIT = 50;
/** Jamendo resizes cover art on demand via `imagesize`. */
const ART_SIZES = [100, 300, 600];

/** `include=` values we always want: genres and the licence URL live in them. */
const INCLUDES = 'musicinfo licenses stats';

interface RawHeaders {
  status?: string;
  code?: number | string;
  error_message?: string;
  results_count?: number;
  results_fullcount?: number;
}

interface Envelope<T> {
  headers?: RawHeaders;
  results?: T[];
}

interface RawStats {
  rate_listened_total?: number;
  rate_downloads_total?: number;
}

interface RawMusicInfo {
  lang?: string;
  tags?: { genres?: string[]; instruments?: string[]; vartags?: string[] };
}

interface RawTrack {
  id?: string;
  name?: string;
  /** Seconds. */
  duration?: number;
  artist_id?: string;
  artist_name?: string;
  album_id?: string;
  album_name?: string;
  album_image?: string;
  image?: string;
  audio?: string;
  audiodownload?: string;
  audiodownload_allowed?: boolean;
  releasedate?: string;
  license_ccurl?: string;
  shareurl?: string;
  prourl?: string;
  position?: number | string;
  popularity_total?: number;
  musicinfo?: RawMusicInfo;
  stats?: RawStats;
}

interface RawAlbum {
  id?: string;
  name?: string;
  releasedate?: string;
  artist_id?: string;
  artist_name?: string;
  image?: string;
  shareurl?: string;
  zip?: string;
  popularity_total?: number;
  tracks?: RawTrack[];
}

interface RawArtist {
  id?: string;
  name?: string;
  image?: string;
  website?: string;
  joindate?: string;
  shareurl?: string;
  albums?: RawAlbum[];
  tracks?: RawTrack[];
}

interface RawPlaylist {
  id?: string;
  name?: string;
  creationdate?: string;
  user_id?: string;
  user_name?: string;
  shareurl?: string;
  tracks?: RawTrack[];
}

/** Album/artist context for nested track lists, which omit their parent. */
interface TrackParent {
  artistId?: string;
  artistName?: string;
  albumId?: string;
  albumName?: string;
  albumImage?: string;
}

type Params = Record<string, string | number | boolean | undefined>;

// Jamendo expects form-style queries: `include=musicinfo+licenses`, never
// `%2B`-joined values.
function qs(params: Params): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${key}=${encodeURIComponent(String(value)).replace(/%20/g, '+')}`);
  }
  return parts.join('&');
}

function compact<T>(items: Array<T | undefined>): T[] {
  return items.filter((item): item is T => item !== undefined);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const value = rec[key];
    if (typeof value === 'number' && value >= 100 && value < 600) return value;
  }
  const message = typeof rec['message'] === 'string' ? rec['message'] : '';
  const match = /\b([1-5]\d{2})\b/.exec(message);
  if (!match) return undefined;
  const found = match[1];
  return found === undefined ? undefined : Number(found);
}

function wrap(err: unknown, what: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = httpStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status === 404) return new ProviderError('not_found', `${what} not found`, PROVIDER, err);
  if (status === 429) return new ProviderError('rate_limited', 'Jamendo rate limit exceeded', PROVIDER, err);
  if (status === 401 || status === 403) {
    return new ProviderError('auth', 'Jamendo rejected the client_id', PROVIDER, err);
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new ProviderError('unknown', `Jamendo ${what}: ${status} ${message}`, PROVIDER, err);
  }
  return new ProviderError('network', `Jamendo ${what}: ${message}`, PROVIDER, err);
}

/** Same log10 curve as Audius so cross-provider ranking stays comparable. */
function popularity(...counts: Array<number | undefined>): number | undefined {
  for (const count of counts) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) continue;
    return Math.min(1, Math.log10(1 + count) / 7);
  }
  return undefined;
}

function withImageSize(url: string, size: number): string {
  const mark = url.indexOf('?');
  const base = mark < 0 ? url : url.slice(0, mark);
  const query = mark < 0 ? '' : url.slice(mark + 1);
  const kept = query
    .split('&')
    .filter((part) => part.length > 0 && !/^(imagesize|width)=/.test(part));
  kept.push(`imagesize=${size}`);
  return `${base}?${kept.join('&')}`;
}

function artwork(...candidates: Array<string | undefined>): Artwork | undefined {
  const url = candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0);
  if (!url) return undefined;
  return { sources: ART_SIZES.map((size) => ({ url: withImageSize(url, size), size })) };
}

function genresOf(raw: RawTrack): string[] | undefined {
  const genres = raw.musicinfo?.tags?.genres;
  if (!Array.isArray(genres)) return undefined;
  const out = compact(genres.map((genre) => str(genre)));
  return out.length > 0 ? out : undefined;
}

function artistRef(id: string | undefined, name: string | undefined): ArtistRef | undefined {
  if (!id || !name) return undefined;
  return { uri: makeUri(PROVIDER, 'artist', id), name };
}

function albumRef(
  id: string | undefined,
  name: string | undefined,
  image: string | undefined,
): AlbumRef | undefined {
  if (!id || !name) return undefined;
  const ref: AlbumRef = { uri: makeUri(PROVIDER, 'album', id), name };
  const art = artwork(image);
  if (art) ref.artwork = art;
  return ref;
}

function trackNumberOf(raw: RawTrack): number | undefined {
  const position = typeof raw.position === 'string' ? Number(raw.position) : raw.position;
  return typeof position === 'number' && Number.isFinite(position) && position > 0
    ? Math.trunc(position)
    : undefined;
}

function mapTrack(raw: RawTrack, parent?: TrackParent): Track | undefined {
  if (!raw.id || !raw.name) return undefined;
  const ref = artistRef(raw.artist_id ?? parent?.artistId, raw.artist_name ?? parent?.artistName);
  const album = albumRef(
    raw.album_id ?? parent?.albumId,
    raw.album_name ?? parent?.albumName,
    raw.album_image ?? parent?.albumImage ?? raw.image,
  );
  const track: Track = {
    uri: makeUri(PROVIDER, 'track', raw.id),
    provider: PROVIDER,
    title: raw.name,
    artists: ref ? [ref] : [],
    durationMs: typeof raw.duration === 'number' ? Math.round(raw.duration * 1000) : 0,
    meta: {
      // Everything Jamendo content needs for attribution, plus the stream URLs
      // so getStream can usually skip a round trip.
      license: raw.license_ccurl,
      shareUrl: raw.shareurl ?? raw.prourl,
      audio: raw.audio,
      audiodownload: raw.audiodownload,
      audiodownloadAllowed: raw.audiodownload_allowed === true,
      artistId: raw.artist_id ?? parent?.artistId,
      albumId: raw.album_id ?? parent?.albumId,
    },
  };
  if (album) track.album = album;
  if (raw.releasedate) track.releaseDate = raw.releasedate;
  const number = trackNumberOf(raw);
  if (number !== undefined) track.trackNumber = number;
  const genres = genresOf(raw);
  if (genres) track.genres = genres;
  const art = artwork(raw.image, raw.album_image, parent?.albumImage);
  if (art) track.artwork = art;
  const pop = popularity(raw.popularity_total, raw.stats?.rate_listened_total);
  if (pop !== undefined) track.popularity = pop;
  return track;
}

function mapAlbum(raw: RawAlbum, tracks?: Track[]): Album | undefined {
  if (!raw.id || !raw.name) return undefined;
  const ref = artistRef(raw.artist_id, raw.artist_name);
  const album: Album = {
    uri: makeUri(PROVIDER, 'album', raw.id),
    provider: PROVIDER,
    name: raw.name,
    artists: ref ? [ref] : [],
  };
  const art = artwork(raw.image);
  if (art) album.artwork = art;
  if (raw.releasedate) album.releaseDate = raw.releasedate;
  const count = tracks?.length ?? raw.tracks?.length;
  if (typeof count === 'number' && count > 0) album.totalTracks = count;
  if (tracks) {
    album.tracks = tracks;
    const genres = [...new Set(tracks.flatMap((track) => track.genres ?? []))];
    if (genres.length > 0) album.genres = genres;
  }
  return album;
}

function mapArtist(raw: RawArtist): Artist | undefined {
  if (!raw.id || !raw.name) return undefined;
  const artist: Artist = {
    uri: makeUri(PROVIDER, 'artist', raw.id),
    provider: PROVIDER,
    name: raw.name,
  };
  const art = artwork(raw.image);
  if (art) artist.artwork = art;
  return artist;
}

function mapPlaylist(raw: RawPlaylist, tracks?: Track[]): Playlist | undefined {
  if (!raw.id || !raw.name) return undefined;
  const playlist: Playlist = {
    uri: makeUri(PROVIDER, 'playlist', raw.id),
    provider: PROVIDER,
    name: raw.name,
    editable: false,
  };
  const owner = str(raw.user_name);
  if (owner) playlist.owner = owner;
  const count = tracks?.length ?? raw.tracks?.length;
  if (typeof count === 'number') playlist.trackCount = count;
  if (tracks) {
    playlist.tracks = tracks;
    const cover = tracks.find((track) => track.artwork !== undefined)?.artwork;
    if (cover) playlist.artwork = cover;
  }
  return playlist;
}

export class JamendoProvider implements MusicProvider {
  readonly id = PROVIDER;
  readonly displayName = 'Jamendo';
  readonly capabilities: ProviderCapabilities = {
    search: true,
    albums: true,
    artists: true,
    playlists: true,
    stations: false,
    // Jamendo exposes no similar-tracks endpoint; radio seeds come from
    // elsewhere in the recommender.
    related: false,
    shelves: true,
    downloadable: true,
    needsNetwork: true,
  };

  #clientId: string | undefined;

  constructor(private readonly ctx: ProviderContext) {}

  async init(): Promise<void> {
    // A missing key is not fatal here — every call reports it individually so
    // the provider stays registered and Settings can still offer the signup
    // link.
    this.#clientId ??= (await this.ctx.config.get(CLIENT_ID_KEY))?.trim() || undefined;
  }

  async isReady(): Promise<boolean> {
    // `init` only fills the field when a key exists, so re-running it is how a
    // client id entered after startup gets picked up.
    if (this.#clientId === undefined) await this.init();
    return this.#clientId !== undefined;
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    const text = query.text.trim();
    const results = emptySearchResults();
    if (text.length === 0) return results;

    const kinds = query.kinds ?? ['track', 'album', 'artist', 'playlist'];
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const params: Params = { search: text, limit, offset };

    const jobs: Array<Promise<void>> = [];
    if (kinds.includes('track')) {
      jobs.push(
        this.#get<RawTrack>('/tracks/', params, TTL_SEARCH).then((rows) => {
          results.tracks = compact(rows.map((row) => mapTrack(row)));
        }),
      );
    }
    if (kinds.includes('album')) {
      jobs.push(
        this.#get<RawAlbum>('/albums/', params, TTL_SEARCH).then((rows) => {
          results.albums = compact(rows.map((row) => mapAlbum(row)));
        }),
      );
    }
    if (kinds.includes('artist')) {
      jobs.push(
        this.#get<RawArtist>('/artists/', params, TTL_SEARCH).then((rows) => {
          results.artists = compact(rows.map(mapArtist));
        }),
      );
    }
    if (kinds.includes('playlist')) {
      jobs.push(
        this.#get<RawPlaylist>('/playlists/', params, TTL_SEARCH).then((rows) => {
          results.playlists = compact(rows.map((row) => mapPlaylist(row)));
        }),
      );
    }
    if (jobs.length === 0) return results;

    const settled = await Promise.allSettled(jobs);
    const failures = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    if (failures.length === settled.length) throw wrap(failures.at(0)?.reason, 'search');
    return results;
  }

  async getTrack(uri: Uri): Promise<Track> {
    const id = this.#nativeId(uri, 'track');
    const rows = await this.#get<RawTrack>('/tracks/', { id }, TTL_ENTITY);
    const raw = rows.at(0);
    const track = raw ? mapTrack(raw) : undefined;
    if (!track) throw new ProviderError('not_found', `Jamendo track not found: ${id}`, PROVIDER);
    return track;
  }

  async getAlbum(uri: Uri): Promise<Album> {
    const id = this.#nativeId(uri, 'album');
    const rows = await this.#get<RawAlbum>('/albums/tracks/', { id }, TTL_ENTITY);
    const raw = rows.at(0);
    if (!raw) throw new ProviderError('not_found', `Jamendo album not found: ${id}`, PROVIDER);
    const parent: TrackParent = {
      artistId: raw.artist_id,
      artistName: raw.artist_name,
      albumId: raw.id,
      albumName: raw.name,
      albumImage: raw.image,
    };
    const tracks = compact((raw.tracks ?? []).map((row) => mapTrack(row, parent)));
    const album = mapAlbum(raw, tracks);
    if (!album) throw new ProviderError('parse', `Could not read Jamendo album: ${id}`, PROVIDER);
    return album;
  }

  async getArtist(uri: Uri): Promise<Artist> {
    const id = this.#nativeId(uri, 'artist');
    const rows = await this.#get<RawArtist>('/artists/', { id }, TTL_ENTITY);
    const raw = rows.at(0);
    const artist = raw ? mapArtist(raw) : undefined;
    if (!artist) throw new ProviderError('not_found', `Jamendo artist not found: ${id}`, PROVIDER);
    return artist;
  }

  async getArtistAlbums(uri: Uri, cursor?: string): Promise<Page<Album>> {
    const id = this.#nativeId(uri, 'artist');
    const offset = parseCursor(cursor);
    const rows = await this.#get<RawArtist>(
      '/artists/albums/',
      { id, limit: PAGE_LIMIT, offset },
      TTL_ENTITY,
    );
    const raw = rows.at(0);
    if (!raw) throw new ProviderError('not_found', `Jamendo artist not found: ${id}`, PROVIDER);
    const albums = raw.albums ?? [];
    const items = compact(
      albums.map((album) =>
        mapAlbum({ ...album, artist_id: album.artist_id ?? raw.id, artist_name: album.artist_name ?? raw.name }),
      ),
    );
    // Jamendo's ordering options differ per endpoint, so the contract's
    // "newest first" is enforced here instead of with an `order` param that
    // would fail the whole request if rejected.
    items.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
    const page: Page<Album> = { items };
    if (albums.length >= PAGE_LIMIT) page.cursor = String(offset + PAGE_LIMIT);
    return page;
  }

  async getArtistTopTracks(uri: Uri): Promise<Track[]> {
    const id = this.#nativeId(uri, 'artist');
    const rows = await this.#get<RawArtist>(
      '/artists/tracks/',
      { id, order: 'popularity_total', limit: 10 },
      TTL_ENTITY,
    );
    const raw = rows.at(0);
    if (!raw) return [];
    const parent: TrackParent = { artistId: raw.id, artistName: raw.name };
    return compact((raw.tracks ?? []).map((row) => mapTrack(row, parent)));
  }

  async getPlaylist(uri: Uri): Promise<Playlist> {
    const id = this.#nativeId(uri, 'playlist');
    const rows = await this.#get<RawPlaylist>('/playlists/tracks/', { id }, TTL_ENTITY);
    const raw = rows.at(0);
    if (!raw) throw new ProviderError('not_found', `Jamendo playlist not found: ${id}`, PROVIDER);
    const tracks = compact((raw.tracks ?? []).map((row) => mapTrack(row)));
    const playlist = mapPlaylist(raw, tracks);
    if (!playlist) throw new ProviderError('parse', `Could not read Jamendo playlist: ${id}`, PROVIDER);
    return playlist;
  }

  async getStream(track: Track): Promise<StreamRef> {
    const id = this.#nativeId(track.uri, 'track');
    const meta = track.meta ?? {};
    let audio = str(meta['audio']);
    let download = str(meta['audiodownload']);
    let allowed = meta['audiodownloadAllowed'] === true;

    // Tracks that came back from the library database keep their meta, but a
    // Uri handed to us from elsewhere needs one lookup.
    if (!audio && !download) {
      const rows = await this.#get<RawTrack>('/tracks/', { id }, TTL_ENTITY);
      const raw = rows.at(0);
      if (!raw) throw new ProviderError('not_found', `Jamendo track not found: ${id}`, PROVIDER);
      audio = str(raw.audio);
      download = str(raw.audiodownload);
      allowed = raw.audiodownload_allowed === true;
    }

    const quality = this.ctx.quality();
    const wantsFull = quality === 'high' || quality === 'lossless';
    const url = wantsFull && allowed && download ? download : audio ?? download;
    if (!url) {
      throw new ProviderError('not_found', `No Jamendo stream for: ${id}`, PROVIDER);
    }
    return { url, mimeType: 'audio/mpeg', kind: 'progressive' };
  }

  async getShelves(): Promise<Shelf[]> {
    const [popular, albums] = await Promise.allSettled([
      this.#get<RawTrack>('/tracks/', { order: 'popularity_week', limit: 20 }, TTL_SHELVES),
      this.#get<RawAlbum>('/albums/', { order: 'popularity_week', limit: 20 }, TTL_SHELVES),
    ]);

    const shelves: Shelf[] = [];
    if (popular.status === 'fulfilled') {
      const items: ShelfItem[] = compact(popular.value.map((row) => mapTrack(row)))
        .map((track) => ({ type: 'track', track }));
      if (items.length > 0) {
        shelves.push({
          id: 'jamendo-popular',
          titleKey: 'shelf.jamendoPopularTitle',
          title: 'Popular on Jamendo',
          subtitleKey: 'shelf.jamendoPopularSubtitle',
          subtitle: 'Creative Commons licensed',
          items,
        });
      }
    }
    if (albums.status === 'fulfilled') {
      const items: ShelfItem[] = compact(albums.value.map((row) => mapAlbum(row)))
        .map((album) => ({ type: 'album', album }));
      if (items.length > 0) {
        shelves.push({
          id: 'jamendo-new-albums',
          titleKey: 'shelf.jamendoNewAlbumsTitle',
          title: 'New albums',
          items,
        });
      }
    }
    return shelves;
  }

  #nativeId(uri: Uri, expected: EntityKind): string {
    let parsed: ParsedUri;
    try {
      parsed = parseUri(uri);
    } catch (err) {
      throw new ProviderError('parse', `Invalid Jamendo uri: ${uri}`, PROVIDER, err);
    }
    if (parsed.provider !== PROVIDER || parsed.kind !== expected || parsed.id.length === 0) {
      throw new ProviderError('parse', `Expected a Jamendo ${expected} uri: ${uri}`, PROVIDER);
    }
    return parsed.id;
  }

  async #requireClientId(): Promise<string> {
    if (!this.#clientId) await this.init();
    const clientId = this.#clientId;
    if (!clientId) {
      throw new ProviderError('auth', 'Jamendo needs a client_id — set one under Settings › Sources', PROVIDER);
    }
    return clientId;
  }

  async #get<T>(path: string, params: Params, ttlSec: number): Promise<T[]> {
    const clientId = await this.#requireClientId();
    const offline = this.ctx.offline();
    const url = `${BASE}${path}?${qs({
      ...params,
      format: 'json',
      client_id: clientId,
      include: INCLUDES,
    })}`;

    let envelope: Envelope<T>;
    try {
      envelope = await this.ctx.host.http.json<Envelope<T>>({
        url,
        cacheTtlSec: offline ? Math.max(ttlSec, TTL_OFFLINE) : ttlSec,
        timeoutMs: 15_000,
      });
    } catch (err) {
      if (offline) {
        throw new ProviderError('offline', "You're offline and this content isn't cached", PROVIDER, err);
      }
      throw wrap(err, path);
    }
    return unwrap(envelope, path);
  }
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const value = Number(cursor);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Jamendo signals failure with HTTP 200 and a non-success envelope. */
function unwrap<T>(envelope: Envelope<T>, what: string): T[] {
  const headers = envelope.headers;
  const status = headers?.status;
  if (status !== undefined && status !== 'success') {
    const rawCode = headers?.code;
    const code = typeof rawCode === 'string' ? Number(rawCode) : rawCode;
    const message = str(headers?.error_message) ?? `Jamendo rejected the ${what} request`;
    if (code === 5) throw new ProviderError('rate_limited', `Jamendo: ${message}`, PROVIDER);
    if (code === 2 || code === 3) {
      throw new ProviderError('auth', `Invalid Jamendo client_id: ${message}`, PROVIDER);
    }
    throw new ProviderError('unknown', `Jamendo: ${message}`, PROVIDER);
  }
  const results = envelope.results;
  if (results === undefined) {
    throw new ProviderError('parse', `Unexpected shape in the Jamendo ${what} response`, PROVIDER);
  }
  return results;
}
