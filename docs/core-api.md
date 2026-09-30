# `@ritmo/core` public API — FROZEN CONTRACT

What `packages/ui` and `apps/web` are allowed to call. These signatures are
what the core modules were written to, so code against them rather than reading
the implementations.

Everything is exported from the package root: `import { ... } from '@ritmo/core'`.

## Types
All of `packages/core/src/types.ts`: `Track`, `Album`, `Artist`, `Playlist`,
`Station`, `Artwork`, `ArtistRef`, `AlbumRef`, `Uri`, `ProviderId`, `EntityKind`,
`StreamRef`, `SearchQuery`, `SearchResults`, `Page<T>`, `Shelf`, `ShelfItem`,
`RepeatMode`, `PlaybackStatus`, `PlaybackState`, `PlaybackError`, `PlayReason`,
`QueueItem`, `QueueSnapshot`, `Lyrics`, `LyricLine`, `LikedTrack`,
`PlayHistoryEntry`, `Settings`, `EqualizerSettings`, plus
`makeUri`, `parseUri`, `uriProvider`, `emptySearchResults`, `defaultSettings`,
`EQ_BANDS`, `EQ_PRESETS`.

## Host
```ts
function detectHost(): Promise<HostBridge>;
class TauriHost implements HostBridge {}
class WebHost implements HostBridge {}
class CapacitorHost implements HostBridge {}
```
`HostBridge` is `packages/core/src/host/types.ts` — read it.

## Engine
```ts
function createAudioEngine(host: HostBridge): Promise<AudioEngine>;
```
`AudioEngine` / `EngineEvent` are `packages/core/src/engine/types.ts`.

## Providers & search
```ts
class ProviderRegistry {
  constructor(host: HostBridge, settings: Settings);
  init(): Promise<void>;
  get(id: ProviderId): MusicProvider | undefined;
  require(id: ProviderId): MusicProvider;
  enabled(): MusicProvider[];
  forUri(uri: Uri): MusicProvider | undefined;
  updateSettings(settings: Settings): Promise<void>;
  resolveTrack(uri: Uri): Promise<Track>;
  resolveStream(track: Track): Promise<StreamRef>;
  shelves(): Promise<Shelf[]>;
  lastErrors(): Array<{ provider: ProviderId; error: ProviderError }>;
}

interface UnifiedSearchOptions { limit?: number; kinds?: EntityKind[]; timeoutMs?: number; providers?: ProviderId[] }
function unifiedSearch(registry: ProviderRegistry, query: string, opts?: UnifiedSearchOptions): Promise<SearchResults>;
function rankTracks(tracks: Track[], query: string): Track[];
function dedupeTracks(tracks: Track[]): Track[];

function buildTrackRadio(registry: ProviderRegistry, seed: Track, limit?: number): Promise<Track[]>;
function buildArtistRadio(registry: ProviderRegistry, artist: ArtistRef, limit?: number): Promise<Track[]>;
function buildAutoplay(registry: ProviderRegistry, recentlyPlayed: Track[], limit?: number): Promise<Track[]>;
function spaceByArtist(tracks: Track[], gap?: number): Track[];

class ProviderError extends Error { code: ProviderErrorCode; provider?: ProviderId }
const JAMENDO_SIGNUP_URL: string;
function stationToTrack(s: Station): Track;
```

## Library
```ts
class Library {
  readonly repo: Repo;
  readonly playlists: Playlists;
  readonly likes: Likes;
  readonly history: History;
  readonly offline: Offline;
  constructor(host: HostBridge, onError?: (e: unknown) => void);
  init(): Promise<void>;
  exportAll(): Promise<string>;
  importAll(json: string, opts?: { merge?: boolean }): Promise<void>;
}
```
`exportAll()` carries playlists, likes, history and `Settings` — never a
credential. Tokens live under the keys in `host/secrets.ts`, which is the `kv`
store the export does not read, and any field named after one is stripped from
the exported `Settings` as well.
```ts
interface ListOpts { provider?: ProviderId; sort?: 'title'|'artist'|'album'|'added'|'duration'|'plays'; dir?: 'asc'|'desc'; limit?: number; cursor?: string; genre?: string; search?: string }
interface LibraryStats { tracks: number; albums: number; artists: number; playlists: number; liked: number; totalDurationMs: number; localBytes: number }

class Repo {
  getTrack(uri: Uri): Promise<Track | undefined>;
  getTracks(uris: Uri[]): Promise<Track[]>;
  upsertTracks(tracks: Track[]): Promise<void>;
  upsertAlbums(albums: Album[]): Promise<void>;
  upsertArtists(artists: Artist[]): Promise<void>;
  getAlbum(uri: Uri, withTracks?: boolean): Promise<Album | undefined>;
  getArtist(uri: Uri): Promise<Artist | undefined>;
  getArtistAlbums(uri: Uri): Promise<Album[]>;
  getArtistTracks(uri: Uri, limit?: number): Promise<Track[]>;
  listTracks(opts: ListOpts): Promise<Page<Track>>;
  listAlbums(opts: ListOpts): Promise<Page<Album>>;
  listArtists(opts: ListOpts): Promise<Page<Artist>>;
  searchLocal(query: string, limit?: number): Promise<{ tracks: Track[]; albums: Album[]; artists: Artist[] }>;
  stats(): Promise<LibraryStats>;
}

class Playlists {
  list(): Promise<Playlist[]>;
  get(uri: Uri, withTracks?: boolean): Promise<Playlist | undefined>;
  create(name: string, opts?: { description?: string; tracks?: Track[] }): Promise<Playlist>;
  rename(uri: Uri, name: string): Promise<void>;
  setDescription(uri: Uri, description: string): Promise<void>;
  setArtwork(uri: Uri, artwork: Artwork | undefined): Promise<void>;
  remove(uri: Uri): Promise<void>;
  addTracks(uri: Uri, tracks: Track[], at?: number): Promise<void>;
  removeTracks(uri: Uri, positions: number[]): Promise<void>;
  removeTrackUri(uri: Uri, trackUri: Uri): Promise<void>;
  move(uri: Uri, from: number, to: number): Promise<void>;
  duplicate(uri: Uri, name?: string): Promise<Playlist>;
  setSortOrder(order: Uri[]): Promise<void>;
  exportM3u(uri: Uri): Promise<string>;
  exportJson(uri: Uri): Promise<string>;
  importM3u(name: string, contents: string, resolve: (path: string) => Promise<Track | undefined>): Promise<Playlist>;
  importJson(contents: string): Promise<Playlist>;
  containing(trackUri: Uri): Promise<Playlist[]>;
}

class Likes {
  like(uri: Uri, kind: EntityKind, snapshot?: Track | Album | Artist | Playlist): Promise<void>;
  unlike(uri: Uri): Promise<void>;
  toggle(uri: Uri, kind: EntityKind, snapshot?: Track): Promise<boolean>;
  isLiked(uri: Uri): Promise<boolean>;
  likedSet(uris: Uri[]): Promise<Set<Uri>>;
  listTracks(opts?: { limit?: number; cursor?: string }): Promise<Page<Track>>;
  listAlbums(): Promise<Album[]>;
  listArtists(): Promise<Artist[]>;
  count(kind?: EntityKind): Promise<number>;
}

class History {
  record(entry: PlayHistoryEntry): Promise<void>;
  recentlyPlayed(limit?: number): Promise<Track[]>;
  recentEntries(limit?: number): Promise<PlayHistoryEntry[]>;
  topTracks(sinceMs: number, limit?: number): Promise<Array<{ track: Track; plays: number }>>;
  topArtists(sinceMs: number, limit?: number): Promise<Array<{ artist: ArtistRef; plays: number }>>;
  topAlbums(sinceMs: number, limit?: number): Promise<Array<{ album: AlbumRef; plays: number }>>;
  listeningMs(sinceMs: number): Promise<number>;
  playCount(trackUri: Uri): Promise<number>;
  lastPlayedAt(trackUri: Uri): Promise<number | undefined>;
  clear(): Promise<void>;
  prune(keepDays: number): Promise<number>;
}

class Offline {
  download(track: Track, stream: StreamRef, onProgress?: (r: number, t?: number) => void): Promise<void>;
  cancel(trackUri: Uri): Promise<void>;
  remove(trackUri: Uri): Promise<void>;
  isOffline(trackUri: Uri): Promise<boolean>;
  offlineSet(uris: Uri[]): Promise<Set<Uri>>;
  localPathFor(trackUri: Uri): Promise<string | undefined>;
  list(): Promise<Array<{ track: Track; bytes: number; downloadedAt: number }>>;
  totalBytes(): Promise<number>;
  pruneTo(maxBytes: number): Promise<number>;
  downloadPlaylist(uri: Uri, resolveStream: (t: Track) => Promise<StreamRef>, onProgress?: (done: number, total: number) => void): Promise<void>;
}
```

## Packs & the Bazaar
```ts
class Packs {
  constructor(host: HostBridge, repo: Repo, registry: ProviderRegistry);
  list(): Promise<Pack[]>;
  get(uri: Uri, withTracks?: boolean): Promise<Pack | undefined>;
  create(name: string, opts?: { description?: string; author?: string; tracks?: Track[] }): Promise<Pack>;
  update(uri: Uri, patch: { name?: string; description?: string; author?: string; artwork?: Artwork }): Promise<void>;
  remove(uri: Uri): Promise<void>;
  addTracks(uri: Uri, tracks: Track[], at?: number): Promise<void>;
  removeAt(uri: Uri, positions: number[]): Promise<void>;
  move(uri: Uri, from: number, to: number): Promise<void>;
  setSortOrder(order: Uri[]): Promise<void>;
  containing(trackUri: Uri): Promise<Pack[]>;
  toManifest(uri: Uri): Promise<PackManifest>;
  install(manifest: PackManifest, origin?: { sourceUrl?: string; packUrl?: string }): Promise<Pack>;
  reresolve(uri: Uri): Promise<{ resolved: number; unavailable: number }>;
}

class Bazaar {
  constructor(host: HostBridge, packs: Packs);
  sources(): Promise<BazaarSource[]>;
  addSource(url: string): Promise<BazaarSource>;   // validates + fetches immediately
  removeSource(url: string): Promise<void>;
  refresh(url?: string): Promise<void>;            // all sources when omitted
  catalogue(): Promise<BazaarEntry[]>;
  preview(entry: BazaarEntry): Promise<PackManifest>;
  installFromBazaar(entry: BazaarEntry): Promise<Pack>;
}
```
Types: `Pack`, `PackItem`, `PackEntry`, `PackManifest`, `BazaarSource`,
`BazaarEntry`, `InstallReport`, plus `PackError`, `manifestToJson`,
`parseManifest`, `parseIndex`, `parseJson`, `packUri`, `packIdOf`, `newPackId`,
`matchScore`, `bestMatch`, `durationsMatch` and the caps
`MAX_PACKS_PER_INDEX` / `MAX_TRACKS_PER_PACK` / `MAX_INDEX_BYTES` / `MAX_PACK_BYTES`.

A pack ships track *identity*, not audio: `install` resolves each entry by the
exact provider `uri`, then the local library, then a fuzzy title+artist+duration
match across the enabled providers, and **keeps** whatever resolves to nothing as
unavailable. `docs/packs.md` is the contract for both wire documents and for the
trust boundary `Bazaar` enforces.

## Player
```ts
type PlayerEvent =
  | { type: 'state'; state: PlaybackState }
  | { type: 'queue'; snapshot: QueueSnapshot }
  | { type: 'error'; error: PlaybackError };

class PlaybackController {
  readonly events: Emitter<PlayerEvent>;
  constructor(deps: ControllerDeps);
  init(): Promise<void>;
  dispose(): Promise<void>;
  playTrack(track: Track, reason?: PlayReason): Promise<void>;
  playContext(tracks: Track[], startIndex: number, context?: { uri?: Uri; name?: string }): Promise<void>;
  playUri(uri: Uri): Promise<void>;
  startRadio(seed: Track): Promise<void>;
  toggle(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  setMuted(m: boolean): Promise<void>;
  setShuffle(on: boolean): Promise<void>;
  setRepeat(mode: RepeatMode): Promise<void>;
  applySettings(settings: Settings): Promise<void>;
  getState(): PlaybackState;
  getQueue(): QueueSnapshot;
}

interface ControllerDeps {
  engine: AudioEngine; queue: QueueEngine; registry: ProviderRegistry;
  host: HostBridge; library: Library; settings: Settings;
  onScrobble?: (track: Track, playedAt: number) => void;
}

class QueueEngine {
  readonly events: Emitter<{ type: 'changed'; snapshot: QueueSnapshot } | { type: 'exhausted' }>;
  setContext(tracks: Track[], startIndex: number, context?: { uri?: Uri; name?: string }): void;
  addNext(tracks: Track[]): void;
  addToQueue(tracks: Track[]): void;
  remove(itemId: string): void;
  move(itemId: string, toIndex: number): void;
  clearUpcoming(): void;
  clear(): void;
  current(): QueueItem | undefined;
  peekNext(): QueueItem | undefined;
  snapshot(): QueueSnapshot;
  isShuffled(): boolean;
  repeat(): RepeatMode;
}
```

## Metadata
```ts
class MetadataService {
  constructor(host: HostBridge);
  enrichTrack(track: Track): Promise<Track>;
  enrichArtist(artist: Artist, lang?: 'tr' | 'en'): Promise<Artist>;
  lyrics(track: Track): Promise<Lyrics | undefined>;
}
function parseLrc(lrc: string): LyricLine[];
function activeLyricIndex(lines: LyricLine[], positionMs: number): number;   // -1 before the first line
class LastfmClient { /* getAuthUrl, completeAuth, updateNowPlaying, scrobble, flushQueue */ }
```

## i18n
```ts
type Lang = 'tr' | 'en';
function dict(lang: Lang): Dict;
function createT(lang: Lang): (key: TKey, params?: Record<string, string | number>) => string;
const LANGS: Array<{ id: Lang; label: string }>;
```
Key groups: `nav.*`, `player.*`, `home.*`, `search.*`, `library.*`, `playlist.*`,
`album.*`, `artist.*`, `queue.*`, `lyrics.*`, `settings.*`, `shortcuts.*`,
`errors.*`, `common.*`. Keys are dot paths, e.g. `t('player.shuffle')`,
`t('library.scanFound', { count: 42 })`.

## Utilities
```ts
class Emitter<E> { on(h: (e: E) => void): () => void; once(h: (e: E) => void): () => void; emit(e: E): void; clear(): void; readonly size: number }

function withTimeout<T>(p: Promise<T>, ms: number, message?: string): Promise<T>;
function retry<T>(fn: (attempt: number) => Promise<T>, opts?: { attempts?: number; baseMs?: number; maxMs?: number; jitter?: boolean; shouldRetry?: (e: unknown, a: number) => boolean }): Promise<T>;
function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T>;
function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void; flush(): void };
function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void };
function memoizeAsync<A extends unknown[], R>(fn: (...a: A) => Promise<R>, opts?: { ttlMs?: number; key?: (...a: A) => string; max?: number }): ((...a: A) => Promise<R>) & { clear(): void };
function singleFlight<A extends unknown[], R>(fn: (...a: A) => Promise<R>, key: (...a: A) => string): (...a: A) => Promise<R>;
function sleep(ms: number): Promise<void>;
function chunk<T>(items: T[], size: number): T[][];

function normalizeKey(s: string): string;
function tokenize(s: string): string[];
function similarity(a: string, b: string): number;
function titleCase(s: string): string;
function splitArtists(s: string): string[];
function matchRanges(haystack: string, needle: string): Array<[number, number]>;
function naturalCompare(a: string, b: string): number;
function initials(name: string): string;
function stripFeat(title: string): string;

function formatDuration(ms: number): string;                  // "3:07"
function formatDurationLong(ms: number, lang: Lang): string;  // "1 sa 2 dk"
function formatCount(n: number, lang: Lang): string;
function formatBytes(n: number, lang: Lang): string;
function formatDate(ms: number, lang: Lang): string;
function formatRelative(ms: number, lang: Lang): string;
function formatReleaseYear(date?: string): string;
function formatBitrate(kbps?: number): string;
function formatTrackPosition(disc?: number, track?: number): string;

interface Rgb { r: number; g: number; b: number }
function hexToRgb(hex: string): Rgb | undefined;
function rgbToHex(c: Rgb): string;
function contrastRatio(a: Rgb, b: Rgb): number;
function ensureContrast(fg: Rgb, bg: Rgb, minRatio?: number): Rgb;
function mix(a: Rgb, b: Rgb, t: number): Rgb;
function saturate(c: Rgb, amount: number): Rgb;
function dominantColor(imageUrl: string): Promise<string | undefined>;
function accentVariables(accentHex: string, theme: 'dark' | 'light' | 'oled'): Record<string, string>;
```

## Helper the UI needs constantly
Artwork URLs for `local:` entities are absolute filesystem paths. Always render
them through `services.host.files.toPlayableUrl(path)` — a bare path will not
load in the WebView.
