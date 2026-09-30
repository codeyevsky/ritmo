import type {
  Album, Artist, Page, Playlist, ProviderId, SearchQuery, SearchResults,
  Shelf, Station, StreamRef, Track, Uri,
} from '../types';
import type { HostBridge } from '../host/types';

/**
 * Capability flags. The UI reads these to decide what to render — a provider
 * that can't list albums must not get an "Albums" tab.
 */
export interface ProviderCapabilities {
  search: boolean;
  /** Can resolve `getAlbum` / album browsing. */
  albums: boolean;
  artists: boolean;
  /** Can list provider-curated playlists. */
  playlists: boolean;
  /** Serves endless radio streams rather than finite tracks. */
  stations: boolean;
  /** Can produce a "similar tracks" seed list for autoplay/radio. */
  related: boolean;
  /** Contributes rows to the Home screen. */
  shelves: boolean;
  /** Streams may be persisted to disk for offline playback. */
  downloadable: boolean;
  /** Requires the network; `local` is the only one that doesn't. */
  needsNetwork: boolean;
}

/**
 * Everything a provider is handed at construction. Providers must route **all**
 * I/O through `host` — never `fetch` directly — because on desktop requests go
 * through the Rust side to escape the WebView's CORS jail and to hit the shared
 * disk cache.
 */
export interface ProviderContext {
  host: HostBridge;
  /** Resolved from Settings.preferredQuality. */
  quality: () => 'low' | 'medium' | 'high' | 'lossless';
  /** When true the provider must serve from cache or throw `offline`. */
  offline: () => boolean;
  /** Per-provider key/value store, namespaced automatically. */
  config: ProviderConfigStore;
}

export interface ProviderConfigStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/**
 * A source of music. Every method is allowed to throw {@link ProviderError};
 * the registry catches those so one dead provider can never break a search.
 *
 * Unsupported operations must throw `unsupported` rather than returning empty,
 * so callers can tell "nothing found" from "can't ask".
 */
export interface MusicProvider {
  readonly id: ProviderId;
  /** Shown in Settings and in result badges. */
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  /** Called once before first use. Must be idempotent and cheap. */
  init?(): Promise<void>;

  /**
   * False when the provider is missing required configuration (an API key,
   * say). Aggregate callers skip it instead of paying a round trip for a call
   * that can only fail. Must be cheap: the registry caches the answer.
   */
  isReady?(): Promise<boolean>;

  search(query: SearchQuery): Promise<SearchResults>;

  getTrack(uri: Uri): Promise<Track>;
  getAlbum(uri: Uri): Promise<Album>;
  getArtist(uri: Uri): Promise<Artist>;
  /** Discography, newest first. */
  getArtistAlbums(uri: Uri, cursor?: string): Promise<Page<Album>>;
  /** Most-played tracks for an artist header. */
  getArtistTopTracks(uri: Uri): Promise<Track[]>;
  getPlaylist(uri: Uri): Promise<Playlist>;
  getStation?(uri: Uri): Promise<Station>;

  /**
   * Resolve a directly-playable URL. Called immediately before playback and
   * again whenever a previous StreamRef expired, so it must stay fast and
   * must not be memoised beyond `expiresAt`.
   */
  getStream(track: Track): Promise<StreamRef>;

  /** Seed tracks for "song radio" / autoplay after the queue drains. */
  getRelatedTracks?(track: Track, limit: number): Promise<Track[]>;

  /** Rows for the Home screen. Must tolerate being called with no user data. */
  getShelves?(): Promise<Shelf[]>;
}

export type ProviderErrorCode =
  | 'unsupported'
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'offline'
  | 'auth'
  | 'parse'
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly provider?: ProviderId,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  static unsupported(provider: ProviderId, op: string): ProviderError {
    return new ProviderError('unsupported', `${provider} does not support ${op}`, provider);
  }
}
