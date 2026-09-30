import type { RepeatMode, Settings, Track, Uri } from '../types';

/**
 * The seam between platform-independent core logic and the shell it runs in.
 *
 * Three implementations exist:
 *   - `TauriHost`     — desktop; forwards to Rust commands over IPC.
 *   - `CapacitorHost` — mobile; native plugins + Capacitor Preferences/Filesystem.
 *   - `WebHost`       — plain browser / tests; fetch + IndexedDB + in-memory stubs.
 *
 * Anything that touches the filesystem, the network, the OS media session or a
 * real database belongs here. Core code never branches on platform; it asks the
 * bridge and checks a capability flag.
 */
export interface HostBridge {
  readonly platform: 'desktop' | 'mobile' | 'web';
  readonly capabilities: HostCapabilities;

  http: HttpClient;
  kv: KeyValueStore;
  db: DatabaseBridge;
  files: FileBridge;
  /** Absent on `web`. */
  localLibrary?: LocalLibraryBridge;
  /** Absent on `web`; OS-level media controls + now-playing metadata. */
  mediaSession?: MediaSessionBridge;
  /** Absent on `web`. */
  notifications?: NotificationBridge;
  /**
   * Absent everywhere but the desktop: exporting, importing and publishing
   * packs are file-dialog operations, and only the Tauri host has dialogs and
   * a filesystem it is allowed to write outside the app's own directories.
   */
  packFiles?: PackFileBridge;
  /** Absent where there is no window to manage (mobile, web). */
  window?: WindowBridge;

  /**
   * Upload a tree `packFiles.publish()` has already written to GitHub Pages and
   * return the address to share. Desktop only, and the counterpart to the
   * folder publish rather than a replacement for it: a folder still serves any
   * static host. The token is a secret the caller reads from `kv`; it is used
   * for this one call and never stored by the host.
   */
  publishToGithub?(opts: GithubPublishOptions): Promise<GithubPublishResult>;
  /** Resolve a token's account without publishing, so Settings can validate it. */
  checkGithubToken?(token: string): Promise<GithubTokenCheck>;

  /** Read/write the persisted Settings blob. */
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;

  /** Open a URL in the user's real browser, not in the app WebView. */
  openExternal(url: string): Promise<void>;

  /** App + platform versions, for the About pane and bug reports. */
  getVersion(): Promise<{ app: string; platform: string; engine: string }>;

  /**
   * Representative colour of the desktop wallpaper, for `accent: 'wallpaper'`.
   * Desktop only — the web and mobile hosts cannot see the desktop, and resolve
   * nothing at all. `undefined` means "no wallpaper to read", not an error.
   */
  systemAccent?(): Promise<SystemAccent | undefined>;
}

/** Answer to {@link HostBridge.systemAccent}. */
export interface SystemAccent {
  /** `#rrggbb`. */
  hex: string;
  /** Absolute path of the image it came from; for logs and the About pane. */
  wallpaperPath?: string;
}

export interface HostCapabilities {
  /** Rust/native audio engine available (gapless, EQ, ReplayGain). */
  nativeAudio: boolean;
  /** Can scan folders on disk. */
  localFiles: boolean;
  /** Can persist audio for offline playback. */
  offlineDownloads: boolean;
  /** MPRIS / MediaSession / iOS now-playing. */
  osMediaControls: boolean;
  systemTray: boolean;
  globalShortcuts: boolean;
  /** HTTP requests bypass CORS (i.e. go through native code). */
  unrestrictedHttp: boolean;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /** Milliseconds; the host applies a sane default when omitted. */
  timeoutMs?: number;
  /**
   * Seconds to serve a cached copy for. `0` / omitted bypasses the cache.
   * The cache is keyed on method+url+body and lives on disk on desktop.
   */
  cacheTtlSec?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** True when this came from the disk cache rather than the network. */
  fromCache: boolean;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  /** Convenience wrapper that also parses JSON and throws on non-2xx. */
  json<T>(req: HttpRequest): Promise<T>;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

/**
 * Thin SQL passthrough. Core owns the schema and the queries; the host only
 * has to execute them. On mobile this is backed by the same SQLite file format
 * so a library can be copied between devices.
 */
export interface DatabaseBridge {
  /** Returns rows as plain objects keyed by column name. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Returns affected row count. */
  execute(sql: string, params?: unknown[]): Promise<number>;
  /** All statements commit or none do. */
  transaction(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
}

export interface FileBridge {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Total bytes under a directory — used to enforce the cache budget. */
  dirSize(path: string): Promise<number>;
  /** Native folder picker. Returns `undefined` if the user cancelled. */
  pickFolder(): Promise<string | undefined>;
  /**
   * Convert an absolute local path into something the WebView's `<audio>`/`<img>`
   * can actually load (a `asset://`-style URL on Tauri, `capacitor://` on mobile).
   */
  toPlayableUrl(path: string): string;

  /** Stream a remote URL to disk for offline playback. */
  download(req: DownloadRequest): Promise<DownloadResult>;
  cancelDownload(id: string): Promise<void>;
}

export interface DownloadRequest {
  id: string;
  url: string;
  headers?: Record<string, string>;
  /** Path relative to the app cache dir. */
  destRelative: string;
  onProgress?: (received: number, total?: number) => void;
}

export interface DownloadResult {
  path: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Local library (desktop/mobile only)
// ---------------------------------------------------------------------------

export interface LocalLibraryBridge {
  /**
   * Walk `folders`, read tags, extract cover art and upsert everything into the
   * database. Reports progress so the UI can show a live counter, and resolves
   * with the final tally.
   */
  scan(folders: string[], onProgress?: (p: ScanProgress) => void): Promise<ScanResult>;
  cancelScan(): Promise<void>;
  /** Start/stop filesystem watching for incremental updates. */
  setWatching(enabled: boolean, folders: string[]): Promise<void>;
  /** Re-read tags for one file after an external edit. */
  refreshFile(path: string): Promise<Track | undefined>;

  /** Multi-select picker for loose tracks. `undefined` = cancelled. */
  pickFiles?(): Promise<string[] | undefined>;

  /** Folder picker aimed at one release rather than a library root. */
  pickAlbumFolder?(): Promise<string | undefined>;

  /**
   * Imports the given files without adding their directories as watched roots:
   * a single track pulled in from Downloads must not drag its neighbours along.
   */
  importFiles?(paths: string[]): Promise<ImportResult>;
}

export interface ImportResult {
  imported: number;
  /** Not audio, unreadable, or already present unchanged. */
  skipped: number;
  errors: Array<{ path: string; message: string }>;
  tracks: Track[];
}

export interface ScanProgress {
  phase: 'walking' | 'reading' | 'artwork' | 'done';
  filesSeen: number;
  filesImported: number;
  /** Absolute path currently being read — shown in the progress row. */
  currentPath?: string;
}

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  errors: Array<{ path: string; message: string }>;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Packs (desktop only)
// ---------------------------------------------------------------------------

/**
 * File IO for `docs/packs.md`'s two documents. The picker calls and the
 * read/write calls are deliberately separate: the Rust side records the
 * directory a dialog returned and confines every later write to it, so the
 * WebView cannot name a path the user never chose.
 */
export interface PackFileBridge {
  /** Save dialog for one `pack.json`. `undefined` = cancelled. */
  pickExportPath(defaultName?: string): Promise<string | undefined>;
  /** Writes an already-serialised `pack.json` to a picked path. */
  writePack(path: string, contents: string): Promise<void>;
  /** Open dialog for one `pack.json`. `undefined` = cancelled. */
  pickImport(): Promise<string | undefined>;
  /** The parsed document, still untrusted — run it through `parseManifest`. */
  readPack(path: string): Promise<unknown>;
  /** Folder picker for a publish target. `undefined` = cancelled. */
  pickPublishDir(): Promise<string | undefined>;
  /**
   * An empty folder inside the app's cache to publish into when the destination
   * is a host rather than a place the user picked. Emptied on every call, so a
   * pack deleted since the last publish is not still in the tree that goes up.
   */
  stagingDir(): Promise<string>;
  /** Writes `index.json` + `packs/*.json` + `covers/*` into `dir`. */
  publish(dir: string, request: PackPublishRequest): Promise<PackPublishResult>;
}

export interface PackPublishEntry {
  /** Becomes `packs/<id>.json`; must be `[A-Za-z0-9._-]+`. */
  id: string;
  name: string;
  description?: string;
  author?: string;
  trackCount: number;
  updatedAt: number;
  /** The serialised `pack.json`; its `artwork` is rewritten by the publisher. */
  json: string;
  /** Absolute local image to copy into `covers/`, when the pack has one. */
  coverPath?: string;
  /** Absolute `http(s)` cover, used when there is no local file to copy. */
  artworkUrl?: string;
}

export interface PackPublishRequest {
  name: string;
  description?: string;
  packs: PackPublishEntry[];
}

export interface PackPublishResult {
  dir: string;
  indexPath: string;
  packs: number;
  covers: number;
}

export interface GithubPublishOptions {
  /** A personal access token with the `public_repo` scope. */
  token: string;
  /** Repository name under the token's own account; created when absent. */
  repo: string;
  /** Defaults to the repository's default branch. */
  branch?: string;
  /** A folder a picker — or `stagingDir()` — returned this session. */
  dir: string;
}

export interface GithubPublishResult {
  /** `https://<owner>.github.io/<repo>/index.json` — the address to share. */
  indexUrl: string;
  repoUrl: string;
  /**
   * Pages was switched on by this publish, so the address needs about a minute
   * before it answers.
   */
  pagesPending: boolean;
}

export interface GithubTokenCheck {
  login: string;
  /**
   * False only when the token itself says it lacks `public_repo`. A
   * fine-grained token reports no scopes at all, so this is `true` for one of
   * those and any real shortfall surfaces when it is used.
   */
  scopesOk: boolean;
}

// ---------------------------------------------------------------------------
// OS media session
// ---------------------------------------------------------------------------

export interface MediaSessionBridge {
  /** Push now-playing metadata to MPRIS / MediaSession / iOS. */
  setMetadata(track: Track | undefined): Promise<void>;
  setPlaybackState(state: {
    status: 'playing' | 'paused' | 'stopped';
    positionMs: number;
    durationMs: number;
    canGoNext: boolean;
    canGoPrevious: boolean;
  }): Promise<void>;
  /**
   * Subscribe to hardware/OS transport commands. Returns an unsubscribe fn.
   * `seek` carries an absolute target in ms.
   */
  onCommand(handler: (cmd: MediaSessionCommand) => void): () => void;

  /**
   * Mirror app state the OS also exposes as writable properties. MPRIS clients
   * read these back, so without this the desktop's volume slider and shuffle
   * toggle keep showing whatever they were last set to.
   */
  setFlags?(flags: { volume?: number; shuffle?: boolean; repeat?: RepeatMode }): Promise<void>;

  /**
   * Announce a discontinuous playhead jump. Progress updates alone are not
   * enough: MPRIS requires an explicit `Seeked` signal or the shell's slider
   * interpolates from the old position.
   */
  seeked?(positionMs: number): Promise<void>;
}

export type MediaSessionCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'stop' }
  | { type: 'seek'; positionMs: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'setShuffle'; shuffle: boolean }
  | { type: 'setRepeat'; repeat: RepeatMode }
  /** The OS asked to bring the window forward; handled natively, ignored here. */
  | { type: 'raise' }
  | { type: 'quit' };

export interface NotificationBridge {
  show(n: { title: string; body: string; iconPath?: string }): Promise<void>;
}

export interface WindowBridge {
  minimize(): Promise<void>;
  hide(): Promise<void>;
  show(): Promise<void>;
  setFullscreen(on: boolean): Promise<void>;
  /** Register an app-global accelerator; returns an unregister fn. */
  registerShortcut(accelerator: string, handler: () => void): Promise<() => void>;
}

/** Marker for the "resolve a Uri without knowing its provider" helper. */
export type UriResolver = (uri: Uri) => Promise<Track | undefined>;
