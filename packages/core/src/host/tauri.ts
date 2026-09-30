/**
 * Desktop host — every capability is a Tauri command from `docs/ipc.md`.
 *
 * Nothing here talks to the network, the filesystem or the OS directly: the
 * WebView is sandboxed and CORS-jailed, so all of that lives in Rust and this
 * file is a typed wire adapter. If a command is not in `docs/ipc.md` it does
 * not exist.
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { defaultSettings } from '../types';
import type {
  RepeatMode,
  Settings,
  Track,
} from '../types';
import type {
  DatabaseBridge,
  DownloadRequest,
  DownloadResult,
  FileBridge,
  GithubPublishOptions,
  GithubPublishResult,
  GithubTokenCheck,
  HostBridge,
  HostCapabilities,
  HttpClient,
  HttpRequest,
  HttpResponse,
  ImportResult,
  KeyValueStore,
  LocalLibraryBridge,
  MediaSessionBridge,
  MediaSessionCommand,
  NotificationBridge,
  PackFileBridge,
  PackPublishRequest,
  PackPublishResult,
  ScanProgress,
  ScanResult,
  SystemAccent,
  WindowBridge,
} from './types';

/** Mirrors `state::events` on the Rust side. */
const EVENT_SCAN = 'ritmo://scan';
const EVENT_DOWNLOAD = 'ritmo://download';
const EVENT_MEDIA_COMMAND = 'ritmo://media-command';

const CAPABILITIES: HostCapabilities = {
  nativeAudio: true,
  localFiles: true,
  offlineDownloads: true,
  osMediaControls: true,
  systemTray: true,
  globalShortcuts: true,
  unrestrictedHttp: true,
};

interface DownloadEvent {
  id: string;
  received: number;
  total?: number | null;
}

/**
 * Subscribing is async but the bridge API is synchronous, so the unsubscribe
 * handle has to work even when it is called before `listen` resolves.
 */
function subscribe<T>(event: string, onEvent: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | undefined;
  let cancelled = false;

  void listen<T>(event, (e) => onEvent(e.payload))
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch((err: unknown) => {
      console.warn(`ritmo: could not subscribe to ${event}`, err);
    });

  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = undefined;
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}

/**
 * Provider code matches on this text to decide whether a failure is worth
 * retrying, so status, URL and a body excerpt all have to be in the message.
 */
function httpFailureMessage(req: HttpRequest, res: HttpResponse): string {
  const method = req.method ?? 'GET';
  const excerpt = res.body.length > 0 ? res.body.slice(0, 200) : '<empty body>';
  return `HTTP ${res.status} ${method} ${req.url}: ${excerpt}`;
}

class TauriHttp implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    return invoke<HttpResponse>('http_request', {
      req: {
        url: req.url,
        method: req.method ?? 'GET',
        headers: req.headers ?? {},
        body: req.body,
        timeoutMs: req.timeoutMs,
        cacheTtlSec: req.cacheTtlSec,
      },
    });
  }

  async json<T>(req: HttpRequest): Promise<T> {
    const res = await this.request(req);
    if (res.status < 200 || res.status >= 300) throw new Error(httpFailureMessage(req, res));
    try {
      return JSON.parse(res.body) as T;
    } catch (err) {
      throw new Error(
        `HTTP ${res.status} ${req.url}: response is not JSON (${describe(err)}): ${res.body.slice(0, 200)}`,
      );
    }
  }
}

class TauriKv implements KeyValueStore {
  async get(key: string): Promise<string | undefined> {
    return (await invoke<string | null>('kv_get', { key })) ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await invoke<void>('kv_set', { key, value });
  }

  async remove(key: string): Promise<void> {
    await invoke<void>('kv_remove', { key });
  }

  async keys(prefix?: string): Promise<string[]> {
    return invoke<string[]>('kv_keys', { prefix: prefix ?? null });
  }
}

class TauriDb implements DatabaseBridge {
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return invoke<T[]>('db_query', { sql, params: params ?? [] });
  }

  async execute(sql: string, params?: unknown[]): Promise<number> {
    return invoke<number>('db_execute', { sql, params: params ?? [] });
  }

  async transaction(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
    if (statements.length === 0) return;
    await invoke<void>('db_transaction', {
      statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
    });
  }
}

class TauriFiles implements FileBridge {
  async exists(path: string): Promise<boolean> {
    return invoke<boolean>('file_exists', { path });
  }

  async readText(path: string): Promise<string> {
    return invoke<string>('read_text_file', { path });
  }

  async writeText(path: string, contents: string): Promise<void> {
    await invoke<void>('write_text_file', { path, contents });
  }

  async remove(path: string): Promise<void> {
    await invoke<void>('remove_file', { path });
  }

  async dirSize(path: string): Promise<number> {
    return invoke<number>('dir_size', { path });
  }

  async pickFolder(): Promise<string | undefined> {
    return (await invoke<string | null>('library_pick_folder')) ?? undefined;
  }

  toPlayableUrl(path: string): string {
    return convertFileSrc(path);
  }

  async download(req: DownloadRequest): Promise<DownloadResult> {
    const onProgress = req.onProgress;
    // Awaited before the command is issued so no early chunk is missed, and
    // torn down in `finally` — one leaked listener per download would otherwise
    // accumulate for the whole session.
    const stop = onProgress === undefined
      ? undefined
      : await listen<DownloadEvent>(EVENT_DOWNLOAD, (e) => {
          if (e.payload.id !== req.id) return;
          onProgress(e.payload.received, e.payload.total ?? undefined);
        });
    try {
      return await invoke<DownloadResult>('download_file', {
        id: req.id,
        url: req.url,
        headers: req.headers ?? null,
        destRelative: req.destRelative,
      });
    } finally {
      stop?.();
    }
  }

  async cancelDownload(id: string): Promise<void> {
    await invoke<void>('cancel_download', { id });
  }
}

class TauriLocalLibrary implements LocalLibraryBridge {
  async scan(folders: string[], onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const stop = onProgress === undefined
      ? undefined
      : await listen<ScanProgress>(EVENT_SCAN, (e) => onProgress(e.payload));
    try {
      return await invoke<ScanResult>('library_scan', { folders });
    } finally {
      stop?.();
    }
  }

  async cancelScan(): Promise<void> {
    await invoke<void>('library_cancel_scan');
  }

  async setWatching(enabled: boolean, folders: string[]): Promise<void> {
    await invoke<void>('library_set_watching', { enabled, folders });
  }

  async pickFiles(): Promise<string[] | undefined> {
    return (await invoke<string[] | null>('library_pick_files')) ?? undefined;
  }

  async pickAlbumFolder(): Promise<string | undefined> {
    return (await invoke<string | null>('library_pick_album')) ?? undefined;
  }

  async importFiles(paths: string[]): Promise<ImportResult> {
    return invoke<ImportResult>('library_import_files', { paths });
  }

  async refreshFile(path: string): Promise<Track | undefined> {
    return (await invoke<Track | null>('library_refresh_file', { path })) ?? undefined;
  }
}

/**
 * Pack file IO. Each picker's return value is also recorded on the Rust side,
 * which is what lets `pack_write`/`pack_publish` refuse a path the user never
 * chose — so these calls have to stay paired rather than being collapsed into
 * one "save" command.
 */
class TauriPackFiles implements PackFileBridge {
  async pickExportPath(defaultName?: string): Promise<string | undefined> {
    return (await invoke<string | null>('pack_pick_export_path', {
      defaultName: defaultName ?? null,
    })) ?? undefined;
  }

  async writePack(path: string, contents: string): Promise<void> {
    await invoke<void>('pack_write', { path, contents });
  }

  async pickImport(): Promise<string | undefined> {
    return (await invoke<string | null>('pack_pick_import')) ?? undefined;
  }

  async readPack(path: string): Promise<unknown> {
    return invoke<unknown>('pack_read', { path });
  }

  async pickPublishDir(): Promise<string | undefined> {
    return (await invoke<string | null>('pack_pick_publish_dir')) ?? undefined;
  }

  async stagingDir(): Promise<string> {
    return invoke<string>('pack_publish_staging_dir');
  }

  async publish(dir: string, request: PackPublishRequest): Promise<PackPublishResult> {
    return invoke<PackPublishResult>('pack_publish', {
      dir,
      request: {
        name: request.name,
        description: request.description ?? null,
        packs: request.packs.map((pack) => ({
          id: pack.id,
          name: pack.name,
          description: pack.description ?? null,
          author: pack.author ?? null,
          trackCount: Math.max(0, Math.round(pack.trackCount)),
          updatedAt: Math.max(0, Math.round(pack.updatedAt)),
          json: pack.json,
          coverPath: pack.coverPath ?? null,
          artworkUrl: pack.artworkUrl ?? null,
        })),
      },
    });
  }
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** MPRIS refuses a bare path: GNOME only loads `file://` or `http(s)://`. */
function artUrl(track: Track): string | null {
  const sources = track.artwork?.sources ?? [];
  const best = sources.length > 0 ? sources[sources.length - 1] : undefined;
  const url = best?.url;
  if (url === undefined || url.length === 0) return null;
  if (HAS_SCHEME.test(url)) return url;

  const posix = url.replace(/\\/g, '/');
  const absolute = posix.startsWith('/') ? posix : `/${posix}`;
  return `file://${absolute.split('/').map(encodeURIComponent).join('/')}`;
}

/** The flat shape `mpris::MediaMetadata` deserialises — not a whole `Track`. */
function toMediaMetadata(track: Track): Record<string, unknown> {
  return {
    uri: track.uri,
    title: track.title,
    artists: track.artists.map((a) => a.name).filter((n) => n.length > 0),
    album: track.album?.name ?? null,
    artUrl: artUrl(track),
    durationMs: Math.max(0, Math.round(track.durationMs)),
    trackNumber: track.trackNumber ?? null,
    discNumber: track.discNumber ?? null,
  };
}

class TauriMediaSession implements MediaSessionBridge {
  async setMetadata(track: Track | undefined): Promise<void> {
    await invoke<void>('media_set_metadata', {
      track: track === undefined ? null : toMediaMetadata(track),
    });
  }

  async setPlaybackState(state: {
    status: 'playing' | 'paused' | 'stopped';
    positionMs: number;
    durationMs: number;
    canGoNext: boolean;
    canGoPrevious: boolean;
  }): Promise<void> {
    // The command takes the whole state as one `playback` argument.
    await invoke<void>('media_set_state', {
      playback: {
        status: state.status,
        positionMs: Math.max(0, Math.round(state.positionMs)),
        durationMs: Math.max(0, Math.round(state.durationMs)),
        canGoNext: state.canGoNext,
        canGoPrevious: state.canGoPrevious,
      },
    });
  }

  onCommand(handler: (cmd: MediaSessionCommand) => void): () => void {
    return subscribe<MediaSessionCommand>(EVENT_MEDIA_COMMAND, handler);
  }

  async setFlags(flags: {
    volume?: number;
    shuffle?: boolean;
    repeat?: RepeatMode;
  }): Promise<void> {
    await invoke<void>('media_set_flags', {
      flags: {
        volume: flags.volume ?? null,
        shuffle: flags.shuffle ?? null,
        repeat: flags.repeat ?? null,
      },
    });
  }

  async seeked(positionMs: number): Promise<void> {
    await invoke<void>('media_seeked', { positionMs: Math.max(0, Math.round(positionMs)) });
  }
}

class TauriNotifications implements NotificationBridge {
  async show(n: { title: string; body: string; iconPath?: string }): Promise<void> {
    await invoke<void>('notify', {
      title: n.title,
      body: n.body,
      iconPath: n.iconPath ?? null,
    });
  }
}

interface Accelerator {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** `CmdOrCtrl`: either modifier satisfies the binding. */
  cmdOrCtrl: boolean;
}

/** Accelerator spelling → the normalised `KeyboardEvent.key` it stands for. */
const KEY_ALIASES: Record<string, string> = {
  SPACEBAR: 'SPACE',
  ' ': 'SPACE',
  RIGHT: 'ARROWRIGHT',
  LEFT: 'ARROWLEFT',
  UP: 'ARROWUP',
  DOWN: 'ARROWDOWN',
  ESC: 'ESCAPE',
  RETURN: 'ENTER',
  DEL: 'DELETE',
  PLUS: '+',
  MINUS: '-',
  COMMA: ',',
  PERIOD: '.',
  SLASH: '/',
  BACKSLASH: '\\',
};

function normalizeKeyToken(token: string): string {
  const upper = token.toUpperCase();
  return KEY_ALIASES[upper] ?? upper;
}

function eventKeyToken(e: KeyboardEvent): string {
  if (e.key === ' ') return 'SPACE';
  return e.key.toUpperCase();
}

function parseAccelerator(accelerator: string): Accelerator {
  const tokens: string[] = [];
  for (const raw of accelerator.split('+')) {
    const token = raw.trim();
    // `Ctrl++` splits into an empty tail; the intended key is a literal plus.
    if (token.length === 0) {
      if (tokens.length > 0 && tokens[tokens.length - 1] !== '+') tokens.push('+');
      continue;
    }
    tokens.push(token);
  }

  const parsed: Accelerator = {
    key: '',
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    cmdOrCtrl: false,
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    const isLast = i === tokens.length - 1;
    switch (token.toUpperCase()) {
      case 'CTRL':
      case 'CONTROL':
        parsed.ctrl = true;
        continue;
      case 'SHIFT':
        parsed.shift = true;
        continue;
      case 'ALT':
      case 'OPTION':
        parsed.alt = true;
        continue;
      case 'META':
      case 'SUPER':
      case 'CMD':
      case 'COMMAND':
        parsed.meta = true;
        continue;
      case 'CMDORCTRL':
      case 'COMMANDORCONTROL':
        parsed.cmdOrCtrl = true;
        continue;
      default:
        break;
    }
    if (!isLast) {
      throw new Error(`Unsupported accelerator modifier "${token}" in "${accelerator}"`);
    }
    parsed.key = normalizeKeyToken(token);
  }

  if (parsed.key.length === 0) {
    throw new Error(`Accelerator "${accelerator}" has no key`);
  }
  return parsed;
}

function matches(accel: Accelerator, e: KeyboardEvent): boolean {
  if (eventKeyToken(e) !== accel.key) return false;
  if (e.altKey !== accel.alt) return false;
  if (e.shiftKey !== accel.shift) return false;
  if (accel.cmdOrCtrl) return e.ctrlKey || e.metaKey;
  return e.ctrlKey === accel.ctrl && e.metaKey === accel.meta;
}

/** A shortcut must never steal a keystroke the user is typing into a field. */
function isTextEntry(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

class TauriWindow implements WindowBridge {
  async minimize(): Promise<void> {
    await getCurrentWindow().minimize();
  }

  async hide(): Promise<void> {
    await getCurrentWindow().hide();
  }

  async show(): Promise<void> {
    const win = getCurrentWindow();
    await win.show();
    // Raising the window is a courtesy, not part of showing it: if the ACL or
    // the compositor refuses, the window is already visible and the caller — the
    // very first effect after mount — must not have its chain broken.
    try {
      await win.setFocus();
    } catch (err) {
      console.debug('ritmo: could not focus the window', err);
    }
  }

  async setFullscreen(on: boolean): Promise<void> {
    await getCurrentWindow().setFullscreen(on);
  }

  /**
   * App-scoped, **not** system-global: the global-shortcut plugin is not part of
   * this build, so bindings are a document `keydown` listener and only fire
   * while a Ritmo window has focus. Real media keys (XF86AudioPlay and friends)
   * reach the app through MPRIS as `ritmo://media-command` events instead.
   */
  async registerShortcut(accelerator: string, handler: () => void): Promise<() => void> {
    const accel = parseAccelerator(accelerator);
    if (typeof document === 'undefined') return () => undefined;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || e.defaultPrevented) return;
      if (isTextEntry(e.target)) return;
      if (!matches(accel, e)) return;
      e.preventDefault();
      handler();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }
}

/** Optional `Settings` fields, absent from `defaultSettings()`. */
const OPTIONAL_SETTING_KEYS = new Set(['cacheDir', 'lastfm']);

/**
 * Settings written by an older build are missing whatever fields were added
 * since, so the stored blob is layered over the current defaults instead of
 * replacing them.
 */
function mergeStoredSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;

  const stored = raw as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(stored)) {
    // `key in base` alone would drop the optional fields, which `defaultSettings`
    // deliberately leaves unset.
    if (value !== undefined && (key in base || OPTIONAL_SETTING_KEYS.has(key))) {
      merged[key] = value;
    }
  }

  // Values retired by later builds: a settings.json written before the system
  // theme and the artwork accent were dropped would otherwise leave the app
  // with a theme it cannot paint and an accent it cannot resolve.
  if (merged['theme'] === 'system') merged['theme'] = 'dark';
  if (merged['accent'] === 'dynamic') merged['accent'] = 'wallpaper';

  const eq = stored['equalizer'];
  if (typeof eq === 'object' && eq !== null && !Array.isArray(eq)) {
    const gains = (eq as Record<string, unknown>)['gains'];
    merged['equalizer'] = {
      ...base.equalizer,
      ...(eq as Record<string, unknown>),
      gains: Array.isArray(gains) && gains.length === base.equalizer.gains.length
        ? gains.map((g) => (typeof g === 'number' && Number.isFinite(g) ? g : 0))
        : base.equalizer.gains,
    };
  }

  return merged as unknown as Settings;
}

export class TauriHost implements HostBridge {
  readonly platform = 'desktop' as const;
  readonly capabilities: HostCapabilities = CAPABILITIES;

  readonly http: HttpClient = new TauriHttp();
  readonly kv: KeyValueStore = new TauriKv();
  readonly db: DatabaseBridge = new TauriDb();
  readonly files: FileBridge = new TauriFiles();
  readonly localLibrary: LocalLibraryBridge = new TauriLocalLibrary();
  readonly mediaSession: MediaSessionBridge = new TauriMediaSession();
  readonly notifications: NotificationBridge = new TauriNotifications();
  readonly packFiles: PackFileBridge = new TauriPackFiles();
  readonly window: WindowBridge = new TauriWindow();

  async getSettings(): Promise<Settings> {
    const json = await invoke<string | null>('settings_load');
    if (json === null || json.length === 0) return defaultSettings();
    try {
      return mergeStoredSettings(JSON.parse(json));
    } catch (err) {
      // A hand-edited or truncated settings.json must not brick startup; the
      // next save rewrites it from the defaults.
      console.warn('ritmo: settings.json is not valid JSON, using defaults', err);
      return defaultSettings();
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    await invoke<void>('settings_save', { json: JSON.stringify(settings) });
  }

  async openExternal(url: string): Promise<void> {
    await invoke<void>('open_external', { url });
  }

  /**
   * The token is passed per call and never kept here: it lives in `kv`, and the
   * Rust side puts it in one request header without logging it.
   */
  async publishToGithub(opts: GithubPublishOptions): Promise<GithubPublishResult> {
    return invoke<GithubPublishResult>('pack_publish_github', {
      token: opts.token,
      repo: opts.repo,
      branch: opts.branch ?? null,
      dir: opts.dir,
    });
  }

  async checkGithubToken(token: string): Promise<GithubTokenCheck> {
    return invoke<GithubTokenCheck>('github_check_token', { token });
  }

  async getVersion(): Promise<{ app: string; platform: string; engine: string }> {
    return invoke<{ app: string; platform: string; engine: string }>('app_info');
  }

  /**
   * A missing wallpaper is a `null`, not a rejection; anything that does reject
   * (no `gsettings`, an unreadable file) is likewise "no colour" rather than an
   * error the UI has to handle, so the caller can just take the fallback.
   */
  async systemAccent(): Promise<SystemAccent | undefined> {
    try {
      const found = await invoke<{ hex: string; wallpaperPath?: string | null } | null>(
        'system_accent',
      );
      if (found === null || typeof found.hex !== 'string') return undefined;
      return {
        hex: found.hex,
        ...(found.wallpaperPath ? { wallpaperPath: found.wallpaperPath } : {}),
      };
    } catch (err) {
      console.warn('ritmo: the desktop accent could not be read', err);
      return undefined;
    }
  }
}

/**
 * True only when the Tauri IPC is actually reachable. Safe to call in a plain
 * browser: the global check short-circuits and a failed command resolves to
 * `false` rather than rejecting.
 */
export async function isTauri(): Promise<boolean> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false;
  try {
    await invoke<{ app: string }>('app_info');
    return true;
  } catch {
    return false;
  }
}
