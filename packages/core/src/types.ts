/**
 * Ritmo — core domain model.
 *
 * Every provider, every UI surface and both host bridges (Tauri / Capacitor)
 * speak exactly these shapes. Nothing in here may import from `react`, `node:*`
 * or any DOM global: this module has to run in a WebView, in Node and in a
 * Capacitor bridge unchanged.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Every source of music Ritmo can talk to. */
export type ProviderId =
  | 'local'
  | 'audius'
  | 'jamendo'
  | 'archive'
  | 'radio';

/**
 * Globally unique, stable, human-debuggable id: `"<provider>:<kind>:<native id>"`.
 * e.g. `"audius:track:7eP5n"`, `"local:album:9f2c…"`, `"radio:track:1a4b-…"`.
 *
 * Always build these with {@link makeUri} and take them apart with
 * {@link parseUri} — never by hand-rolling `split(':')`, because native ids are
 * allowed to contain colons.
 */
export type Uri = string;

export type EntityKind = 'track' | 'album' | 'artist' | 'playlist' | 'station';

export interface ParsedUri {
  provider: ProviderId;
  kind: EntityKind;
  id: string;
}

export function makeUri(provider: ProviderId, kind: EntityKind, id: string): Uri {
  return `${provider}:${kind}:${id}`;
}

export function parseUri(uri: Uri): ParsedUri {
  const first = uri.indexOf(':');
  const second = uri.indexOf(':', first + 1);
  if (first < 0 || second < 0) throw new Error(`Malformed Uri: ${uri}`);
  return {
    provider: uri.slice(0, first) as ProviderId,
    kind: uri.slice(first + 1, second) as EntityKind,
    // Native ids may legitimately contain ':' (archive.org paths do), so the
    // remainder is taken verbatim rather than split further.
    id: uri.slice(second + 1),
  };
}

export function uriProvider(uri: Uri): ProviderId {
  return uri.slice(0, uri.indexOf(':')) as ProviderId;
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/**
 * Artwork is always a set of candidate sizes so the UI can pick per surface
 * (48px list row vs. 640px hero) instead of downloading one oversized image.
 */
export interface Artwork {
  /** Sorted ascending by `size`. May be empty. */
  sources: ArtworkSource[];
  /** Tiny inline blurhash/base64 LQIP for instant paint, when the provider offers one. */
  placeholder?: string;
  /** Dominant colour as `#rrggbb`, used to tint the page. Filled in lazily by the UI. */
  accent?: string;
}

export interface ArtworkSource {
  url: string;
  /** Longest edge in CSS pixels. */
  size: number;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface ArtistRef {
  uri: Uri;
  name: string;
}

export interface AlbumRef {
  uri: Uri;
  name: string;
  artwork?: Artwork;
}

export interface Track {
  uri: Uri;
  provider: ProviderId;
  title: string;
  artists: ArtistRef[];
  album?: AlbumRef;
  /** Milliseconds. `0` means "unknown / unbounded" — live radio uses this. */
  durationMs: number;
  /** 1-based position within its album/disc, when known. */
  trackNumber?: number;
  discNumber?: number;
  /** ISO-8601 date or bare year. */
  releaseDate?: string;
  genres?: string[];
  artwork?: Artwork;
  /** Provider-reported popularity, normalised to 0..1. Used only for ranking. */
  popularity?: number;
  explicit?: boolean;
  /** True for endless sources (radio): disables seek + progress bar. */
  isLive?: boolean;
  /** ReplayGain track gain in dB, if the file or provider carries one. */
  gainDb?: number;
  /** Set for `local:` tracks — absolute path on disk. */
  path?: string;
  /** Free-form provider payload; never read by the UI. */
  meta?: Record<string, unknown>;
}

export interface Album {
  uri: Uri;
  provider: ProviderId;
  name: string;
  artists: ArtistRef[];
  artwork?: Artwork;
  releaseDate?: string;
  /** `album` | `single` | `ep` | `compilation` — free-form, provider dependent. */
  albumType?: string;
  totalTracks?: number;
  genres?: string[];
  /** Populated only by `getAlbum`, not by search results. */
  tracks?: Track[];
}

export interface Artist {
  uri: Uri;
  provider: ProviderId;
  name: string;
  artwork?: Artwork;
  genres?: string[];
  /** Follower count as reported by the provider, if any. */
  followers?: number;
  /** Prose biography, usually stitched in from MusicBrainz/Wikidata. */
  bio?: string;
}

export interface Playlist {
  uri: Uri;
  provider: ProviderId | 'ritmo';
  name: string;
  description?: string;
  artwork?: Artwork;
  owner?: string;
  trackCount?: number;
  /** True for playlists the user owns locally and may therefore edit. */
  editable?: boolean;
  tracks?: Track[];
}

/** An internet radio station. Modelled apart from Track because it never ends. */
export interface Station {
  uri: Uri;
  name: string;
  streamUrl: string;
  /** Provider-reported codec, e.g. `MP3`, `AAC`. */
  codec?: string;
  bitrate?: number;
  country?: string;
  language?: string;
  tags?: string[];
  homepage?: string;
  artwork?: Artwork;
  /** Radio-Browser click/vote counts, used for ranking. */
  votes?: number;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * A resolved, directly-playable audio URL. Providers hand these out on demand
 * because many of them are short-lived signed URLs that must not be cached in
 * the library database.
 */
export interface StreamRef {
  url: string;
  /** MIME type when known, so the engine can pick a decoder without sniffing. */
  mimeType?: string;
  /** `hls` needs a different code path from a plain progressive file. */
  kind: 'progressive' | 'hls';
  /** Wall-clock ms after which `url` must be re-resolved. Absent = no expiry. */
  expiresAt?: number;
  /** Extra headers the request must carry (Referer-locked CDNs). */
  headers?: Record<string, string>;
  /** Absolute local path, set when this stream was served from the offline cache. */
  localPath?: string;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchQuery {
  text: string;
  /** Which entity kinds to return. Default: all of them. */
  kinds?: EntityKind[];
  limit?: number;
  offset?: number;
}

export interface SearchResults {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  stations: Station[];
}

export function emptySearchResults(): SearchResults {
  return { tracks: [], albums: [], artists: [], playlists: [], stations: [] };
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; absent when exhausted. */
  cursor?: string;
  total?: number;
}

// ---------------------------------------------------------------------------
// Home / discovery
// ---------------------------------------------------------------------------

/** One horizontally-scrolling row on the Home screen. */
export interface Shelf {
  id: string;
  /** English fallback: rendered verbatim when `titleKey` is absent or unknown. */
  title: string;
  subtitle?: string;
  /**
   * Dot-path i18n key (`shelf.*`). Providers are locale-agnostic and have no
   * `t()`, so they ship a key plus the English literal above; the UI resolves
   * the key and degrades to the literal rather than to a raw key.
   */
  titleKey?: string;
  subtitleKey?: string;
  items: ShelfItem[];
}

export type ShelfItem =
  | { type: 'track'; track: Track }
  | { type: 'album'; album: Album }
  | { type: 'artist'; artist: Artist }
  | { type: 'playlist'; playlist: Playlist }
  | { type: 'station'; station: Station };

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export type RepeatMode = 'off' | 'all' | 'one';

export type PlaybackStatus =
  | 'idle'      // nothing loaded
  | 'loading'   // resolving stream / buffering first bytes
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

export interface PlaybackState {
  status: PlaybackStatus;
  /** The track currently loaded into the engine, if any. */
  current?: Track;
  /** Playhead in ms. Monotonic while playing; reset on track change. */
  positionMs: number;
  /** Engine's view of the loaded track's length; may refine `current.durationMs`. */
  durationMs: number;
  /** 0..1, linear. The engine applies its own perceptual curve. */
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Seconds of audio buffered ahead of the playhead. */
  bufferedMs: number;
  /** Present when `status === 'error'`. */
  error?: PlaybackError;
}

export interface PlaybackError {
  code:
    | 'stream_unresolved'   // provider could not produce a StreamRef
    | 'network'
    | 'decode'
    | 'not_found'
    | 'device'              // audio output disappeared
    | 'unknown';
  message: string;
  /** Whether retrying the same track might work. */
  retryable: boolean;
}

/** Why a track started — drives scrobbling and "recently played" semantics. */
export type PlayReason = 'user' | 'auto_next' | 'repeat' | 'radio' | 'resume';

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface QueueItem {
  /** Instance id — unique per queue entry, so the same track can appear twice. */
  id: string;
  track: Track;
  /** True when the user explicitly queued it ("Add to queue"), which makes it
   *  play before the rest of the context and disappear once consumed. */
  userQueued: boolean;
  /** Where this item came from, for the "Playing from …" label. */
  contextUri?: Uri;
}

export interface QueueSnapshot {
  /** Items already played, most recent last. */
  history: QueueItem[];
  current?: QueueItem;
  /** Upcoming items in play order (shuffle already applied). */
  upcoming: QueueItem[];
  contextUri?: Uri;
  contextName?: string;
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

export interface Lyrics {
  /** Plain unsynced text, always present when lyrics were found at all. */
  plain: string;
  /** Synced lines, sorted ascending by `atMs`. Absent when only plain exist. */
  synced?: LyricLine[];
  source: string;
}

export interface LyricLine {
  atMs: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export interface LikedTrack {
  track: Track;
  likedAt: number;
}

export interface PlayHistoryEntry {
  track: Track;
  playedAt: number;
  /** How much of the track actually elapsed, in ms. */
  playedMs: number;
  reason: PlayReason;
  /** True once the play crossed the scrobble threshold (50% or 4 min). */
  completed: boolean;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  // Appearance
  theme: 'dark' | 'light' | 'oled';
  /** `#rrggbb`, or 'wallpaper' to take the accent from the desktop wallpaper. */
  accent: string;
  language: 'tr' | 'en';
  /** Compact list rows / larger touch targets. */
  density: 'comfortable' | 'compact';

  // Playback
  crossfadeMs: number;          // 0 disables
  gapless: boolean;
  normalizeVolume: boolean;     // apply ReplayGain
  /** Extra dB applied when a track carries no gain metadata. */
  preampDb: number;
  equalizer: EqualizerSettings;
  /** Stop after the current track finishes. */
  monoDownmix: boolean;
  /** Skip tracks shorter than this when auto-advancing (jingles, intros). */
  skipShorterThanMs: number;

  // Library
  musicFolders: string[];
  watchFolders: boolean;
  /** Where downloads and artwork cache live. */
  cacheDir?: string;
  maxCacheBytes: number;

  // Network
  preferredQuality: 'low' | 'medium' | 'high' | 'lossless';
  /** Don't hit the network at all — offline cache only. */
  offlineMode: boolean;

  // Integrations
  enabledProviders: ProviderId[];
  lastfm?: { username: string; sessionKey: string };
  discordRichPresence: boolean;

  // Desktop behaviour
  closeToTray: boolean;
  startMinimized: boolean;
  showDesktopNotifications: boolean;
}

export interface EqualizerSettings {
  enabled: boolean;
  /** Gain in dB per band, same length/order as {@link EQ_BANDS}. */
  gains: number[];
  preset: string;
}

/**
 * Arch Linux's brand blue, from `/etc/os-release` `ANSI_COLOR="38;2;23;147;209"`.
 * Ritmo's default accent, so the app looks like it belongs on the system it
 * ships on rather than like a clone of a streaming service.
 */
export const ARCH_BLUE = '#1793d1';

/** Centre frequencies (Hz) of the 10-band graphic EQ. */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_PRESETS: Record<string, number[]> = {
  Flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Bass:       [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  Treble:     [0, 0, 0, 0, 0, 1, 3, 4, 5, 6],
  Vocal:      [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  Electronic: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  Rock:       [4, 3, 2, 0, -1, -1, 1, 3, 4, 4],
  Acoustic:   [3, 2, 1, 1, 0, 1, 2, 2, 1, 0],
  Loudness:   [6, 4, 0, -1, -2, -1, 0, 2, 5, 6],
};

export function defaultSettings(): Settings {
  return {
    theme: 'dark',
    accent: ARCH_BLUE,
    language: 'en',
    density: 'comfortable',
    crossfadeMs: 0,
    gapless: true,
    normalizeVolume: true,
    preampDb: 0,
    equalizer: { enabled: false, gains: [...(EQ_PRESETS.Flat ?? [])], preset: 'Flat' },
    monoDownmix: false,
    skipShorterThanMs: 0,
    musicFolders: [],
    watchFolders: true,
    maxCacheBytes: 4 * 1024 * 1024 * 1024,
    preferredQuality: 'high',
    offlineMode: false,
    enabledProviders: ['local', 'audius', 'jamendo', 'archive', 'radio'],
    discordRichPresence: false,
    closeToTray: false,
    startMinimized: false,
    showDesktopNotifications: true,
  };
}
