/**
 * Audius — decentralised, artist-owned streaming.
 *
 * The network deliberately has no canonical API host: clients ask
 * `api.audius.co` which discovery nodes are currently healthy and then talk to
 * one of them. Nodes drop out or fall behind the chain often enough that every
 * request has to be able to fail over to a sibling, so the chosen host is
 * treated as a cache rather than as configuration.
 */

import { emptySearchResults, makeUri, parseUri } from '../types';
import type {
  Album, Artist, Artwork, ArtistRef, EntityKind, Page, ParsedUri, Playlist,
  SearchQuery, SearchResults, Shelf, ShelfItem, StreamRef, Track, Uri,
} from '../types';
import { ProviderError } from './types';
import type { MusicProvider, ProviderCapabilities, ProviderContext } from './types';

const PROVIDER = 'audius' as const;
const APP_NAME = 'Ritmo';
const NODE_DIRECTORY = 'https://api.audius.co';
const HOST_KEY = 'host';

const TTL_SEARCH = 300;
const TTL_ENTITY = 3600;
/** Trending lists are recomputed upstream on the order of hours, so a home
 *  screen that re-fetches them every 15 minutes pays latency for nothing. */
const TTL_SHELVES = 3600;
/** The node directory is the one thing that must not go stale for an hour:
 *  a rotated-out node is how every other call starts failing. */
const TTL_NODES = 900;
/** Offline reads may only ever come out of the host's disk cache. */
const TTL_OFFLINE = 7 * 24 * 3600;

/**
 * Used only when the node directory itself is unreachable — these three have
 * been stable long enough to be worth a shot before giving up entirely.
 */
const FALLBACK_NODES = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://discoveryprovider3.audius.co',
];

/** Audius serves exactly these three square crops. */
const ART_SIZES: Array<readonly [string, number]> = [
  ['150x150', 150],
  ['480x480', 480],
  ['1000x1000', 1000],
];

// Raw wire shapes. Everything is optional: discovery nodes run different
// versions and omit fields freely.

interface Envelope<T> { data?: T }

type RawArtwork = Partial<Record<string, string>>;

interface RawUser {
  id?: string;
  handle?: string;
  name?: string;
  bio?: string;
  follower_count?: number;
  track_count?: number;
  profile_picture?: RawArtwork;
  cover_photo?: RawArtwork;
  is_verified?: boolean;
}

interface RawTrack {
  id?: string;
  title?: string;
  /** Seconds, not milliseconds. */
  duration?: number;
  genre?: string;
  mood?: string;
  tags?: string;
  release_date?: string;
  permalink?: string;
  artwork?: RawArtwork;
  user?: RawUser;
  play_count?: number;
  favorite_count?: number;
  repost_count?: number;
  is_streamable?: boolean;
  downloadable?: boolean;
  is_downloadable?: boolean;
}

interface RawPlaylist {
  id?: string;
  playlist_name?: string;
  description?: string;
  artwork?: RawArtwork;
  user?: RawUser;
  track_count?: number;
  total_play_count?: number;
  favorite_count?: number;
  repost_count?: number;
  is_album?: boolean;
}

type Params = Record<string, string | number | boolean | undefined>;

function qs(params: Params): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

function compact<T>(items: Array<T | undefined>): T[] {
  return items.filter((item): item is T => item !== undefined);
}

function trimSlash(host: string): string {
  return host.endsWith('/') ? host.slice(0, -1) : host;
}

/**
 * The HostBridge contract does not fix an error class for `http.json`, so the
 * status is recovered from whatever the implementation attached — a numeric
 * field if present, otherwise the three-digit code every implementation puts in
 * its message.
 */
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

/** 5xx and transport failures mean "this node is sick", so try another one. */
function isNodeFailure(err: unknown): boolean {
  if (err instanceof ProviderError) return err.code === 'network';
  const status = httpStatus(err);
  return status === undefined || status >= 500;
}

function wrap(err: unknown, what: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = httpStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status === 404) return new ProviderError('not_found', `${what} not found`, PROVIDER, err);
  if (status === 429) return new ProviderError('rate_limited', `Audius rate limit exceeded`, PROVIDER, err);
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `Audius denied access (${status})`, PROVIDER, err);
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new ProviderError('unknown', `Audius ${what}: ${status} ${message}`, PROVIDER, err);
  }
  return new ProviderError('network', `Audius ${what}: ${message}`, PROVIDER, err);
}

/**
 * log10 saturating at ten million plays: the busiest Audius tracks sit around
 * 10^7, so dividing by 7 spreads the realistic range across 0..1 without a
 * hard cliff at the top.
 */
function popularity(...counts: Array<number | undefined>): number | undefined {
  let total = 0;
  let seen = false;
  for (const count of counts) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) continue;
    seen = true;
    total += count;
  }
  if (!seen) return undefined;
  return Math.min(1, Math.log10(1 + total) / 7);
}

function artwork(raw: RawArtwork | undefined): Artwork | undefined {
  if (!raw) return undefined;
  const sources = compact(
    ART_SIZES.map(([key, size]) => {
      const url = raw[key];
      return typeof url === 'string' && url.length > 0 ? { url, size } : undefined;
    }),
  );
  return sources.length > 0 ? { sources } : undefined;
}

function genresOf(raw: RawTrack): string[] | undefined {
  const out: string[] = [];
  for (const value of [raw.genre, raw.mood]) {
    if (typeof value === 'string' && value.trim().length > 0 && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

function artistRef(user: RawUser | undefined): ArtistRef | undefined {
  const name = user?.name ?? user?.handle;
  if (!user?.id || !name) return undefined;
  return { uri: makeUri(PROVIDER, 'artist', user.id), name };
}

function mapTrack(raw: RawTrack): Track | undefined {
  if (!raw.id || !raw.title) return undefined;
  const ref = artistRef(raw.user);
  const art = artwork(raw.artwork);
  const track: Track = {
    uri: makeUri(PROVIDER, 'track', raw.id),
    provider: PROVIDER,
    title: raw.title,
    artists: ref ? [ref] : [],
    durationMs: typeof raw.duration === 'number' ? Math.round(raw.duration * 1000) : 0,
    meta: {
      handle: raw.user?.handle,
      permalink: raw.permalink,
      playCount: raw.play_count,
      favoriteCount: raw.favorite_count,
      repostCount: raw.repost_count,
      downloadable: raw.is_downloadable ?? raw.downloadable ?? false,
    },
  };
  if (raw.release_date) track.releaseDate = raw.release_date;
  const genres = genresOf(raw);
  if (genres) track.genres = genres;
  if (art) track.artwork = art;
  const pop = popularity(raw.play_count, raw.favorite_count);
  if (pop !== undefined) track.popularity = pop;
  return track;
}

function mapArtist(raw: RawUser): Artist | undefined {
  const name = raw.name ?? raw.handle;
  if (!raw.id || !name) return undefined;
  const artist: Artist = {
    uri: makeUri(PROVIDER, 'artist', raw.id),
    provider: PROVIDER,
    name,
  };
  const art = artwork(raw.profile_picture) ?? artwork(raw.cover_photo);
  if (art) artist.artwork = art;
  if (typeof raw.follower_count === 'number') artist.followers = raw.follower_count;
  if (raw.bio) artist.bio = raw.bio;
  return artist;
}

function mapPlaylist(raw: RawPlaylist, tracks?: Track[]): Playlist | undefined {
  if (!raw.id || !raw.playlist_name) return undefined;
  const playlist: Playlist = {
    uri: makeUri(PROVIDER, 'playlist', raw.id),
    provider: PROVIDER,
    name: raw.playlist_name,
    editable: false,
  };
  if (raw.description) playlist.description = raw.description;
  const art = artwork(raw.artwork);
  if (art) playlist.artwork = art;
  const owner = raw.user?.name ?? raw.user?.handle;
  if (owner) playlist.owner = owner;
  const count = raw.track_count ?? tracks?.length;
  if (typeof count === 'number') playlist.trackCount = count;
  if (tracks) playlist.tracks = tracks;
  return playlist;
}

export class AudiusProvider implements MusicProvider {
  readonly id = PROVIDER;
  readonly displayName = 'Audius';
  readonly capabilities: ProviderCapabilities = {
    search: true,
    // Audius models releases as playlists with `is_album`; there is no album
    // entity to resolve, so the UI must not offer album browsing.
    albums: false,
    artists: true,
    playlists: true,
    stations: false,
    related: true,
    shelves: true,
    downloadable: true,
    needsNetwork: true,
  };

  #host: string | undefined;
  #nodes: string[] = [];
  #nodeIndex = 0;
  #bootstrap: Promise<void> | undefined;

  constructor(private readonly ctx: ProviderContext) {}

  async init(): Promise<void> {
    this.#bootstrap ??= this.#resolveHost();
    try {
      await this.#bootstrap;
    } catch (err) {
      // A failed bootstrap must not poison every later call.
      this.#bootstrap = undefined;
      throw err;
    }
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    const text = query.text.trim();
    const results = emptySearchResults();
    if (text.length === 0) return results;

    const kinds = query.kinds ?? ['track', 'artist', 'playlist'];
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);
    const params: Params = { query: text, limit, offset };

    const jobs: Array<Promise<void>> = [];
    if (kinds.includes('track')) {
      jobs.push(
        this.#get<Envelope<RawTrack[]>>('/tracks/search', params, TTL_SEARCH).then((res) => {
          results.tracks = compact((res.data ?? []).map(mapTrack));
        }),
      );
    }
    if (kinds.includes('artist')) {
      jobs.push(
        this.#get<Envelope<RawUser[]>>('/users/search', params, TTL_SEARCH).then((res) => {
          results.artists = compact((res.data ?? []).map(mapArtist));
        }),
      );
    }
    if (kinds.includes('playlist')) {
      jobs.push(
        this.#get<Envelope<RawPlaylist[]>>('/playlists/search', params, TTL_SEARCH).then((res) => {
          results.playlists = compact((res.data ?? []).map((raw) => mapPlaylist(raw)));
        }),
      );
    }
    if (jobs.length === 0) return results;

    const settled = await Promise.allSettled(jobs);
    const failures = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    // Partial results are worth more than an exception; only a total wipeout
    // is reported so the registry can mark the provider unhealthy.
    if (failures.length === settled.length) throw wrap(failures.at(0)?.reason, 'search');
    return results;
  }

  async getTrack(uri: Uri): Promise<Track> {
    const id = this.#nativeId(uri, 'track');
    const res = await this.#get<Envelope<RawTrack>>(`/tracks/${encodeURIComponent(id)}`, {}, TTL_ENTITY);
    const track = res.data ? mapTrack(res.data) : undefined;
    if (!track) throw new ProviderError('not_found', `Audius track not found: ${id}`, PROVIDER);
    return track;
  }

  async getAlbum(_uri: Uri): Promise<Album> {
    throw ProviderError.unsupported(PROVIDER, 'getAlbum');
  }

  async getArtist(uri: Uri): Promise<Artist> {
    const id = this.#nativeId(uri, 'artist');
    const res = await this.#get<Envelope<RawUser>>(`/users/${encodeURIComponent(id)}`, {}, TTL_ENTITY);
    const artist = res.data ? mapArtist(res.data) : undefined;
    if (!artist) throw new ProviderError('not_found', `Audius artist not found: ${id}`, PROVIDER);
    return artist;
  }

  async getArtistAlbums(_uri: Uri, _cursor?: string): Promise<Page<Album>> {
    throw ProviderError.unsupported(PROVIDER, 'getArtistAlbums');
  }

  async getArtistTopTracks(uri: Uri): Promise<Track[]> {
    const id = this.#nativeId(uri, 'artist');
    const res = await this.#get<Envelope<RawTrack[]>>(
      `/users/${encodeURIComponent(id)}/tracks`,
      { sort: 'plays', limit: 10 },
      TTL_ENTITY,
    );
    return compact((res.data ?? []).map(mapTrack));
  }

  async getPlaylist(uri: Uri): Promise<Playlist> {
    const id = this.#nativeId(uri, 'playlist');
    const path = `/playlists/${encodeURIComponent(id)}`;
    const [meta, contents] = await Promise.all([
      this.#get<Envelope<RawPlaylist[] | RawPlaylist>>(path, {}, TTL_ENTITY),
      this.#get<Envelope<RawTrack[]>>(`${path}/tracks`, {}, TTL_ENTITY),
    ]);
    // `/playlists/{id}` answers with a single-element array; older nodes with
    // a bare object.
    const rawMeta = Array.isArray(meta.data) ? meta.data.at(0) : meta.data;
    if (!rawMeta) throw new ProviderError('not_found', `Audius playlist not found: ${id}`, PROVIDER);
    const tracks = compact((contents.data ?? []).map(mapTrack));
    const playlist = mapPlaylist(rawMeta, tracks);
    if (!playlist) throw new ProviderError('parse', `Could not read Audius playlist: ${id}`, PROVIDER);
    return playlist;
  }

  async getStream(track: Track): Promise<StreamRef> {
    const id = this.#nativeId(track.uri, 'track');
    const host = await this.#requireHost();
    // The endpoint 302s to a short-lived signed CDN URL; both the WebView's
    // <audio> and the Rust reader follow redirects, so handing out the stable
    // redirector avoids ever having to think about expiry.
    return {
      url: `${host}/v1/tracks/${encodeURIComponent(id)}/stream?${qs({ app_name: APP_NAME })}`,
      mimeType: 'audio/mpeg',
      kind: 'progressive',
    };
  }

  async getRelatedTracks(track: Track, limit: number): Promise<Track[]> {
    const id = this.#nativeId(track.uri, 'track');
    const res = await this.#get<Envelope<RawTrack[]>>(
      `/tracks/${encodeURIComponent(id)}/related`,
      { limit: Math.min(Math.max(limit, 1), 100) },
      TTL_ENTITY,
    );
    return compact((res.data ?? []).map(mapTrack))
      .filter((candidate) => candidate.uri !== track.uri);
  }

  async getShelves(): Promise<Shelf[]> {
    const [trending, underground, playlists] = await Promise.allSettled([
      this.#get<Envelope<RawTrack[]>>('/tracks/trending', { time: 'week', limit: 20 }, TTL_SHELVES),
      this.#get<Envelope<RawTrack[]>>('/tracks/trending/underground', { limit: 20 }, TTL_SHELVES),
      this.#get<Envelope<RawPlaylist[]>>('/playlists/trending', { time: 'week', limit: 20 }, TTL_SHELVES),
    ]);

    const shelves: Shelf[] = [];
    const trackItems = (entry: PromiseSettledResult<Envelope<RawTrack[]>>): ShelfItem[] =>
      entry.status === 'fulfilled'
        ? compact((entry.value.data ?? []).map(mapTrack)).map((track) => ({ type: 'track', track }))
        : [];

    const top = trackItems(trending);
    if (top.length > 0) {
      shelves.push({
        id: 'audius-trending',
        titleKey: 'shelf.audiusTrendingTitle',
        title: 'Trending on Audius',
        items: top,
      });
    }

    const rising = trackItems(underground);
    if (rising.length > 0) {
      shelves.push({
        id: 'audius-underground',
        titleKey: 'shelf.audiusUndergroundTitle',
        title: 'On the rise',
        subtitleKey: 'shelf.audiusUndergroundSubtitle',
        subtitle: 'Fresh finds from independent artists',
        items: rising,
      });
    }

    if (playlists.status === 'fulfilled') {
      const items: ShelfItem[] = compact((playlists.value.data ?? []).map((raw) => mapPlaylist(raw)))
        .map((playlist) => ({ type: 'playlist', playlist }));
      if (items.length > 0) {
        shelves.push({
          id: 'audius-playlists',
          titleKey: 'shelf.audiusPlaylistsTitle',
          title: 'Trending playlists',
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
      throw new ProviderError('parse', `Invalid Audius uri: ${uri}`, PROVIDER, err);
    }
    if (parsed.provider !== PROVIDER || parsed.kind !== expected || parsed.id.length === 0) {
      throw new ProviderError('parse', `Audius ${expected} adresi bekleniyordu: ${uri}`, PROVIDER);
    }
    return parsed.id;
  }

  async #resolveHost(): Promise<void> {
    const cached = (await this.ctx.config.get(HOST_KEY))?.trim();
    if (cached) {
      this.#host = trimSlash(cached);
      return;
    }
    await this.#rotateHost();
  }

  async #requireHost(): Promise<string> {
    if (!this.#host) await this.init();
    const host = this.#host;
    if (!host) throw new ProviderError('network', 'No Audius node found', PROVIDER);
    return host;
  }

  /** Discard the current node and commit to the next healthy-looking one. */
  async #rotateHost(): Promise<void> {
    if (this.#nodeIndex >= this.#nodes.length) {
      this.#nodes = await this.#fetchNodes();
      this.#nodeIndex = 0;
    }
    const next = this.#nodes.at(this.#nodeIndex);
    this.#nodeIndex += 1;
    if (!next) {
      this.#host = undefined;
      await this.ctx.config.set(HOST_KEY, '');
      throw new ProviderError('network', 'Could not reach any Audius node', PROVIDER);
    }
    this.#host = trimSlash(next);
    await this.ctx.config.set(HOST_KEY, this.#host);
  }

  async #fetchNodes(): Promise<string[]> {
    try {
      const res = await this.ctx.host.http.json<Envelope<string[]>>({
        url: NODE_DIRECTORY,
        cacheTtlSec: TTL_NODES,
        timeoutMs: 10_000,
      });
      const nodes = (res.data ?? []).filter(
        (node): node is string => typeof node === 'string' && node.startsWith('http'),
      );
      if (nodes.length > 0) return shuffle(nodes);
    } catch {
      // Falling back to the hardcoded list is strictly better than failing.
    }
    return [...FALLBACK_NODES];
  }

  async #get<T>(path: string, params: Params, ttlSec: number): Promise<T> {
    const offline = this.ctx.offline();
    const host = await this.#requireHost();
    const query = qs({ ...params, app_name: APP_NAME });

    try {
      return await this.ctx.host.http.json<T>({
        url: `${host}/v1${path}?${query}`,
        cacheTtlSec: offline ? Math.max(ttlSec, TTL_OFFLINE) : ttlSec,
        timeoutMs: 15_000,
      });
    } catch (err) {
      if (offline) {
        throw new ProviderError('offline', "You're offline and this content isn't cached", PROVIDER, err);
      }
      if (!isNodeFailure(err)) throw wrap(err, path);

      await this.#rotateHost();
      const retryHost = await this.#requireHost();
      try {
        return await this.ctx.host.http.json<T>({
          url: `${retryHost}/v1${path}?${query}`,
          cacheTtlSec: ttlSec,
          timeoutMs: 15_000,
        });
      } catch (retryErr) {
        throw wrap(retryErr, path);
      }
    }
  }
}

/** Spread load across the node set instead of hammering whichever is first. */
function shuffle(items: string[]): string[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
