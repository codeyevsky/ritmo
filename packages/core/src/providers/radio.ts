import type {
  Album, Artist, Artwork, Page, Playlist, SearchQuery, SearchResults,
  Shelf, ShelfItem, Station, StreamRef, Track, Uri,
} from '../types';
import { emptySearchResults, makeUri, parseUri } from '../types';
import type { MusicProvider, ProviderCapabilities, ProviderContext } from './types';
import { ProviderError } from './types';

/** Round-robin DNS entry that lists the real mirrors. */
const SERVERS_URL = 'https://all.api.radio-browser.info/json/servers';

/**
 * Used only when the mirror directory itself is unreachable. Radio-Browser
 * hosts come and go, hence the list rather than one hard-coded name.
 */
const FALLBACK_MIRRORS = [
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'at1.api.radio-browser.info',
  'nl1.api.radio-browser.info',
  'fi1.api.radio-browser.info',
  'all.api.radio-browser.info',
] as const;

/** Radio-Browser asks every client to identify itself so it can shed abuse. */
const USER_AGENT = 'Ritmo/0.1';

const SEARCH_TTL_SEC = 300;
/** Station popularity rankings move slowly; the home screen does not need a
 *  fresh count of clicks every five minutes. */
const SHELF_TTL_SEC = 1800;
const MIRROR_TTL_SEC = 21600;

const MIRROR_KEY = 'mirror';
const MAX_ATTEMPTS = 3;

const SHELF_LIMIT = 20;
const TAG_LIMIT = 60;
const GENRE_TAGS = 6;
const PER_GENRE = 4;
const MIN_TAG_LENGTH = 3;
const MAX_TAGS_PER_STATION = 12;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;

const HLS_MIME = 'application/vnd.apple.mpegurl';

const CODEC_MIME: Record<string, string> = {
  MP3: 'audio/mpeg',
  MP2: 'audio/mpeg',
  AAC: 'audio/aac',
  'AAC+': 'audio/aac',
  AACP: 'audio/aac',
  'AAC+H': 'audio/aac',
  OGG: 'audio/ogg',
  VORBIS: 'audio/ogg',
  OPUS: 'audio/ogg',
  FLAC: 'audio/flac',
  WAV: 'audio/wav',
  WMA: 'audio/x-ms-wma',
  HLS: HLS_MIME,
};

interface RbServer {
  name?: unknown;
  ip?: unknown;
}

interface RbStation {
  stationuuid?: unknown;
  name?: unknown;
  url?: unknown;
  url_resolved?: unknown;
  homepage?: unknown;
  favicon?: unknown;
  tags?: unknown;
  country?: unknown;
  countrycode?: unknown;
  language?: unknown;
  votes?: unknown;
  codec?: unknown;
  bitrate?: unknown;
  clickcount?: unknown;
}

interface RbTag {
  name?: unknown;
  stationcount?: unknown;
}

export class RadioProvider implements MusicProvider {
  readonly id = 'radio' as const;
  readonly displayName = 'Radyo';
  readonly capabilities: ProviderCapabilities = {
    search: true,
    albums: false,
    artists: false,
    playlists: false,
    stations: true,
    related: false,
    shelves: true,
    downloadable: false,
    needsNetwork: true,
  };

  private mirror: string | undefined;
  private pendingMirror: Promise<string> | undefined;
  private readonly deadMirrors = new Set<string>();

  constructor(private readonly ctx: ProviderContext) {}

  async init(): Promise<void> {
    if (this.mirror || this.ctx.offline()) return;
    try {
      await this.resolveMirror();
    } catch {
      // Not fatal: the first real request picks a mirror again.
    }
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    const results = emptySearchResults();
    const text = query.text.trim();
    if (!text) return results;

    const kinds = query.kinds;
    const wantStations = !kinds || kinds.includes('station');
    const wantTracks = !kinds || kinds.includes('track');
    if (!wantStations && !wantTracks) return results;

    const params = new URLSearchParams();
    params.set('name', text);
    params.set('limit', String(clampLimit(query.limit ?? DEFAULT_SEARCH_LIMIT)));
    params.set('offset', String(clampOffset(query.offset)));
    params.set('hidebroken', 'true');
    params.set('order', 'votes');
    params.set('reverse', 'true');

    const stations = mapStations(
      await this.get<RbStation[]>(`/json/stations/search?${params.toString()}`, SEARCH_TTL_SEC),
    );
    if (wantStations) results.stations = stations;
    // Radio hits have to be playable straight from the results list, so the
    // same stations are surfaced as live Tracks too.
    if (wantTracks) results.tracks = stations.map(stationToTrack);
    return results;
  }

  async getTrack(uri: Uri): Promise<Track> {
    return stationToTrack(await this.loadStation(parseUri(uri).id));
  }

  async getStation(uri: Uri): Promise<Station> {
    return this.loadStation(parseUri(uri).id);
  }

  async getAlbum(_uri: Uri): Promise<Album> {
    throw ProviderError.unsupported('radio', 'getAlbum');
  }

  async getArtist(_uri: Uri): Promise<Artist> {
    throw ProviderError.unsupported('radio', 'getArtist');
  }

  async getArtistAlbums(_uri: Uri, _cursor?: string): Promise<Page<Album>> {
    throw ProviderError.unsupported('radio', 'getArtistAlbums');
  }

  async getArtistTopTracks(_uri: Uri): Promise<Track[]> {
    throw ProviderError.unsupported('radio', 'getArtistTopTracks');
  }

  async getPlaylist(_uri: Uri): Promise<Playlist> {
    throw ProviderError.unsupported('radio', 'getPlaylist');
  }

  async getStream(track: Track): Promise<StreamRef> {
    const uuid = uriTail(track.uri);
    let url = metaString(track.meta, 'streamUrl');
    let codec = metaString(track.meta, 'codec');
    if (!url) {
      const station = await this.loadStation(uuid);
      url = station.streamUrl;
      codec = station.codec;
    }
    if (!url) {
      throw new ProviderError(
        'not_found', `radio station ${uuid} has no resolved stream url`, 'radio',
      );
    }

    this.countClick(uuid);
    const kind: StreamRef['kind'] = url.endsWith('.m3u8') ? 'hls' : 'progressive';
    return {
      url,
      kind,
      mimeType: kind === 'hls' ? HLS_MIME : mimeFromCodec(codec),
    };
  }

  async getShelves(): Promise<Shelf[]> {
    const [popular, turkish] = await Promise.allSettled([
      this.popular(SHELF_LIMIT),
      this.byCountryCode('TR', SHELF_LIMIT),
    ]);

    const shelves: Shelf[] = [];
    appendShelf(shelves, 'radio-top', SHELF_COPY.top, popular);
    appendShelf(shelves, 'radio-tr', SHELF_COPY.turkey, turkish);
    return shelves;
  }

  private async loadStation(uuid: string): Promise<Station> {
    if (!uuid) throw new ProviderError('not_found', 'empty radio station uuid', 'radio');
    const stations = mapStations(
      await this.get<RbStation[]>(
        `/json/stations/byuuid/${encodeURIComponent(uuid)}`, SEARCH_TTL_SEC,
      ),
    );
    const station = stations[0];
    if (!station) {
      throw new ProviderError('not_found', `radio station ${uuid} not found`, 'radio');
    }
    return station;
  }

  /** Top-clicked is the livelier ranking; top-voted is the stable backstop. */
  private async popular(limit: number): Promise<Station[]> {
    try {
      const stations = mapStations(
        await this.get<RbStation[]>(
          `/json/stations/topclick/${limit}?hidebroken=true`, SHELF_TTL_SEC,
        ),
      );
      if (stations.length) return stations;
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'offline') throw err;
    }
    return mapStations(
      await this.get<RbStation[]>(
        `/json/stations/topvote/${limit}?hidebroken=true`, SHELF_TTL_SEC,
      ),
    );
  }

  private async byCountryCode(code: string, limit: number): Promise<Station[]> {
    const params = new URLSearchParams({
      order: 'votes',
      reverse: 'true',
      limit: String(limit),
      hidebroken: 'true',
    });
    return mapStations(
      await this.get<RbStation[]>(
        `/json/stations/bycountrycodeexact/${encodeURIComponent(code)}?${params.toString()}`,
        SHELF_TTL_SEC,
      ),
    );
  }

  private async byTag(tag: string, limit: number): Promise<Station[]> {
    const params = new URLSearchParams({
      order: 'votes',
      reverse: 'true',
      limit: String(limit),
      hidebroken: 'true',
    });
    return mapStations(
      await this.get<RbStation[]>(
        `/json/stations/bytag/${encodeURIComponent(tag)}?${params.toString()}`,
        SEARCH_TTL_SEC,
      ),
    );
  }

  /** The click counter is what keeps the community ranking meaningful. */
  private countClick(uuid: string): void {
    if (!uuid || this.ctx.offline()) return;
    void this.get<unknown>(`/json/url/${encodeURIComponent(uuid)}`, 0)
      .catch(() => undefined);
  }

  private async get<T>(path: string, cacheTtlSec: number): Promise<T> {
    if (this.ctx.offline()) {
      throw new ProviderError('offline', 'Radio-Browser requires a network connection', 'radio');
    }

    let last: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const host = await this.resolveMirror();
      try {
        return await this.ctx.host.http.json<T>({
          url: `https://${host}${path}`,
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          cacheTtlSec,
        });
      } catch (err) {
        last = err;
        this.demoteMirror(host);
      }
    }
    throw wrapError(last, `GET ${path}`);
  }

  private resolveMirror(): Promise<string> {
    const current = this.mirror;
    if (current) return Promise.resolve(current);

    const inflight = this.pendingMirror;
    if (inflight) return inflight;

    const pending = this.pickMirror().then(
      (host) => {
        this.mirror = host;
        this.pendingMirror = undefined;
        return host;
      },
      (err: unknown) => {
        this.pendingMirror = undefined;
        throw wrapError(err, 'mirror discovery');
      },
    );
    this.pendingMirror = pending;
    return pending;
  }

  private async pickMirror(): Promise<string> {
    const stored = await this.ctx.config.get(MIRROR_KEY).catch(() => undefined);
    if (stored && !this.deadMirrors.has(stored)) return stored;

    let hosts: string[] = [];
    try {
      const servers = await this.ctx.host.http.json<RbServer[]>({
        url: SERVERS_URL,
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        cacheTtlSec: MIRROR_TTL_SEC,
      });
      if (Array.isArray(servers)) {
        for (const server of servers) {
          const name = str(server?.name);
          if (name && !hosts.includes(name)) hosts.push(name);
        }
      }
    } catch {
      // The directory is itself a single host and goes down like the rest.
      hosts = [];
    }
    if (!hosts.length) hosts = [...FALLBACK_MIRRORS];

    const alive = hosts.filter((host) => !this.deadMirrors.has(host));
    const pool = alive.length ? alive : hosts;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    if (!chosen) {
      throw new ProviderError('network', 'no Radio-Browser mirror available', 'radio');
    }

    await this.ctx.config.set(MIRROR_KEY, chosen).catch(() => undefined);
    return chosen;
  }

  private demoteMirror(host: string): void {
    this.deadMirrors.add(host);
    if (this.mirror === host) this.mirror = undefined;
    // Every mirror failing usually means the network died, not the mirrors;
    // clearing lets the next attempt start from a clean slate.
    if (this.deadMirrors.size >= FALLBACK_MIRRORS.length) this.deadMirrors.clear();
  }
}

export function stationToTrack(s: Station): Track {
  const uuid = uriTail(s.uri);
  const tags = s.tags ?? [];
  return {
    uri: makeUri('radio', 'track', uuid),
    provider: 'radio',
    title: s.name,
    artists: [{ uri: makeUri('radio', 'artist', 'live'), name: s.country ?? 'Radyo' }],
    durationMs: 0,
    genres: tags.length ? tags : undefined,
    artwork: s.artwork,
    isLive: true,
    meta: {
      streamUrl: s.streamUrl,
      codec: s.codec,
      bitrate: s.bitrate,
      tags,
    },
  };
}

/**
 * Shelf headings carry an i18n key plus an English literal: this module has no
 * locale, and the key would be unreadable if the dictionary ever lost it.
 */
const SHELF_COPY = {
  top: {
    titleKey: 'shelf.radioTopTitle',
    title: 'Most-played stations',
    subtitleKey: 'shelf.radioTopSubtitle',
    subtitle: 'What listeners are tuning into right now',
  },
  turkey: {
    titleKey: 'shelf.radioTurkeyTitle',
    title: 'From Türkiye',
    subtitleKey: 'shelf.radioTurkeySubtitle',
    subtitle: 'Stations based in Türkiye, ranked by votes',
  },
} as const;

function appendShelf(
  shelves: Shelf[],
  id: string,
  copy: (typeof SHELF_COPY)[keyof typeof SHELF_COPY],
  result: PromiseSettledResult<Station[]>,
): void {
  if (result.status !== 'fulfilled' || !result.value.length) return;
  const items: ShelfItem[] = result.value.map((station) => ({
    type: 'station' as const,
    station,
  }));
  shelves.push({ id, ...copy, items });
}

function mapStations(raw: unknown): Station[] {
  if (!Array.isArray(raw)) return [];
  const out: Station[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const station = toStation(item);
    if (!station || seen.has(station.uri)) continue;
    seen.add(station.uri);
    out.push(station);
  }
  return out;
}

/**
 * `url` is frequently a `.pls`/`.m3u` playlist file that the engine cannot
 * decode, so only the already-followed `url_resolved` is accepted.
 */
function toStation(input: unknown): Station | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const s = input as RbStation;
  const uuid = str(s.stationuuid);
  const streamUrl = str(s.url_resolved);
  if (!uuid || !streamUrl) return undefined;

  return {
    uri: makeUri('radio', 'station', uuid),
    name: str(s.name) ?? 'Unnamed station',
    streamUrl,
    codec: normalizeCodec(str(s.codec)),
    bitrate: positive(s.bitrate),
    country: str(s.countrycode)?.toUpperCase(),
    language: str(s.language),
    tags: splitTags(s.tags),
    homepage: httpUrl(str(s.homepage)),
    artwork: faviconArtwork(str(s.favicon)),
    votes: nonNegative(s.votes),
  };
}

function faviconArtwork(url: string | undefined): Artwork | undefined {
  const safe = httpUrl(url);
  if (!safe) return undefined;
  return { sources: [{ url: safe, size: 256 }] };
}

function splitTags(raw: unknown): string[] | undefined {
  const text = str(raw);
  if (!text) return undefined;
  const out: string[] = [];
  for (const part of text.split(',')) {
    const tag = part.trim();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_STATION) break;
  }
  return out.length ? out : undefined;
}

function normalizeCodec(codec: string | undefined): string | undefined {
  if (!codec) return undefined;
  const upper = codec.toUpperCase();
  return upper === 'UNKNOWN' ? undefined : upper;
}

function mimeFromCodec(codec: string | undefined): string | undefined {
  if (!codec) return undefined;
  return CODEC_MIME[codec.trim().toUpperCase()];
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value : undefined;
}

/**
 * Station and track Uris share the station uuid; taking the tail works for
 * both without caring which kind was handed in.
 */
function uriTail(uri: Uri): string {
  try {
    return parseUri(uri).id;
  } catch {
    return uri;
  }
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function positive(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function nonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!meta) return undefined;
  const value = meta[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  return Math.floor(offset);
}

function wrapError(err: unknown, context: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const status = statusFrom(message);
  if (status === 404 || status === 410) {
    return new ProviderError('not_found', `${context}: ${message}`, 'radio', err);
  }
  if (status === 429) {
    return new ProviderError('rate_limited', `${context}: ${message}`, 'radio', err);
  }
  return new ProviderError('network', `${context}: ${message}`, 'radio', err);
}

function statusFrom(message: string): number | undefined {
  const match = /\b([1-5]\d{2})\b/.exec(message);
  if (!match || !match[1]) return undefined;
  return Number.parseInt(match[1], 10);
}
