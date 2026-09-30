/**
 * Browser host — a development and preview shell, not a shipping target.
 *
 * It exists so the UI can be built with `vite dev` and no Rust toolchain. It is
 * honestly limited: no SQL database, no disk access, no native audio, and
 * `fetch` runs inside the WebView's CORS jail, so Audius/Jamendo/Archive/
 * Radio-Browser requests will mostly be refused by the browser. That refusal is
 * precisely why the desktop build proxies every request through Rust.
 *
 * The pieces that *are* real browser APIs — the response cache and the
 * `navigator.mediaSession` bridge — are exported, because the Capacitor host
 * runs in a WebView too and uses the same implementations.
 */

import { defaultSettings } from '../types';
import type { Settings, Track } from '../types';
import type {
  DatabaseBridge, DownloadResult, FileBridge, HostBridge, HostCapabilities,
  HttpClient, HttpRequest, HttpResponse, KeyValueStore, MediaSessionBridge,
  MediaSessionCommand,
} from './types';

const KV_PREFIX = 'ritmo:';
const SETTINGS_KEY = `${KV_PREFIX}settings`;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SEEK_STEP_SEC = 10;

const CAPABILITIES: HostCapabilities = {
  nativeAudio: false,
  localFiles: false,
  offlineDownloads: false,
  osMediaControls: true,
  systemTray: false,
  globalShortcuts: false,
  unrestrictedHttp: false,
};

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Provider code matches on this text to decide whether a failure is worth
 * retrying, so status, URL and a body excerpt all have to be in the message.
 */
export function httpFailureMessage(req: HttpRequest, res: HttpResponse): string {
  const method = req.method ?? 'GET';
  const excerpt = res.body.length > 0 ? res.body.slice(0, 200) : '<empty body>';
  return `HTTP ${res.status} ${method} ${req.url}: ${excerpt}`;
}

export function parseJsonBody<T>(req: HttpRequest, res: HttpResponse): T {
  if (res.status < 200 || res.status >= 300) throw new Error(httpFailureMessage(req, res));
  try {
    return JSON.parse(res.body) as T;
  } catch (err) {
    throw new Error(
      `HTTP ${res.status} ${req.url}: response is not JSON (${describeError(err)}): ${res.body.slice(0, 200)}`,
    );
  }
}

/** Optional `Settings` fields, absent from `defaultSettings()`. */
const OPTIONAL_SETTING_KEYS = new Set(['cacheDir', 'lastfm']);

/**
 * Settings written by an older build are missing whatever fields were added
 * since, so the stored blob is layered over the current defaults instead of
 * replacing them.
 */
export function mergeStoredSettings(raw: unknown): Settings {
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

function cacheKey(req: HttpRequest): string {
  return `${req.method ?? 'GET'} ${req.url} ${req.body ?? ''}`;
}

/**
 * TTL cache for hosts with no disk cache behind them. Keyed exactly like the
 * Rust one (method + url + body) and LRU-capped, because a long browsing
 * session would otherwise retain every JSON payload it ever fetched.
 */
export class MemoryResponseCache {
  private readonly entries = new Map<string, { expiresAt: number; response: HttpResponse }>();

  constructor(private readonly maxEntries: number = 256) {}

  get(req: HttpRequest): HttpResponse | undefined {
    if ((req.cacheTtlSec ?? 0) <= 0) return undefined;
    const key = cacheKey(req);
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return { ...hit.response, fromCache: true };
  }

  put(req: HttpRequest, response: HttpResponse): void {
    const ttl = req.cacheTtlSec ?? 0;
    if (ttl <= 0) return;
    if (response.status < 200 || response.status >= 300) return;

    const key = cacheKey(req);
    this.entries.delete(key);
    this.entries.set(key, {
      expiresAt: Date.now() + ttl * 1000,
      response: { ...response, fromCache: false },
    });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

class WebHttp implements HttpClient {
  private readonly cache = new MemoryResponseCache();

  async request(req: HttpRequest): Promise<HttpResponse> {
    const cached = this.cache.get(req);
    if (cached !== undefined) return cached;

    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
    const timer = controller === undefined
      ? undefined
      : setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
        redirect: 'follow',
        signal: controller?.signal,
      });

      const headers: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });

      const response: HttpResponse = {
        status: res.status,
        headers,
        body: await res.text(),
        fromCache: false,
      };
      this.cache.put(req, response);
      return response;
    } catch (err) {
      throw new Error(
        `${req.method ?? 'GET'} ${req.url} failed in the browser host: ${describeError(err)} ` +
          '(a WebView cannot bypass CORS - run the desktop build for this provider)',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async json<T>(req: HttpRequest): Promise<T> {
    return parseJsonBody<T>(req, await this.request(req));
  }
}

/**
 * `localStorage` is absent in a bare Node test runner and throws in a
 * partitioned iframe, so every access degrades to a process-local map.
 */
function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

const fallbackStore = new Map<string, string>();

function readKey(key: string): string | undefined {
  const store = storage();
  if (store === undefined) return fallbackStore.get(key);
  try {
    return store.getItem(key) ?? undefined;
  } catch {
    return fallbackStore.get(key);
  }
}

function writeKey(key: string, value: string): void {
  const store = storage();
  if (store === undefined) {
    fallbackStore.set(key, value);
    return;
  }
  try {
    store.setItem(key, value);
  } catch {
    // Quota exceeded or private-mode refusal: keep the value for this session.
    fallbackStore.set(key, value);
  }
}

function deleteKey(key: string): void {
  fallbackStore.delete(key);
  const store = storage();
  if (store === undefined) return;
  try {
    store.removeItem(key);
  } catch {
    // Already gone from the fallback, which is all this host can promise.
  }
}

function allKeys(): string[] {
  const out = new Set<string>(fallbackStore.keys());
  const store = storage();
  if (store !== undefined) {
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) out.add(key);
      }
    } catch {
      // Fall back to whatever this session wrote.
    }
  }
  return [...out];
}

class WebKv implements KeyValueStore {
  async get(key: string): Promise<string | undefined> {
    return readKey(KV_PREFIX + key);
  }

  async set(key: string, value: string): Promise<void> {
    writeKey(KV_PREFIX + key, value);
  }

  async remove(key: string): Promise<void> {
    deleteKey(KV_PREFIX + key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const wanted = KV_PREFIX + (prefix ?? '');
    return allKeys()
      .filter((key) => key.startsWith(wanted))
      .map((key) => key.slice(KV_PREFIX.length))
      .sort();
  }
}

/**
 * There is no SQLite in the browser host. The library layer treats a rejecting
 * `db` as "no persistence" and keeps working in memory, so throwing is correct
 * behaviour rather than a silent empty result.
 */
class WebDb implements DatabaseBridge {
  async query<T = Record<string, unknown>>(): Promise<T[]> {
    throw new Error('WebHost has no SQL database');
  }

  async execute(): Promise<number> {
    throw new Error('WebHost has no SQL database');
  }

  async transaction(): Promise<void> {
    throw new Error('WebHost has no SQL database');
  }
}

function unsupported(operation: string): Error {
  return new Error(`WebHost cannot ${operation}: the browser has no filesystem access`);
}

class WebFiles implements FileBridge {
  async exists(): Promise<boolean> {
    throw unsupported('check whether a file exists');
  }

  async readText(): Promise<string> {
    throw unsupported('read a text file');
  }

  async writeText(): Promise<void> {
    throw unsupported('write a text file');
  }

  async remove(): Promise<void> {
    throw unsupported('delete a file');
  }

  async dirSize(): Promise<number> {
    throw unsupported('measure a directory');
  }

  async pickFolder(): Promise<string | undefined> {
    return undefined;
  }

  /** Remote URLs are already playable, and local paths never occur here. */
  toPlayableUrl(path: string): string {
    return path;
  }

  async download(): Promise<DownloadResult> {
    throw unsupported('download audio for offline playback');
  }

  async cancelDownload(): Promise<void> {
    throw unsupported('cancel a download');
  }
}

/**
 * `navigator.mediaSession` bridge, shared by the browser and Capacitor hosts:
 * the same API drives the Android notification, the iOS lock screen and the
 * desktop-browser transport keys.
 */
export class BrowserMediaSession implements MediaSessionBridge {
  private readonly handlers = new Set<(cmd: MediaSessionCommand) => void>();
  /** Last reported playhead, needed to turn relative seeks into absolute ones. */
  private positionMs = 0;
  private durationMs = 0;

  private get session(): MediaSession | undefined {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
    return navigator.mediaSession;
  }

  async setMetadata(track: Track | undefined): Promise<void> {
    const session = this.session;
    if (session === undefined) return;
    if (track === undefined) {
      session.metadata = null;
      return;
    }
    if (typeof MediaMetadata === 'undefined') return;

    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artists.map((a) => a.name).filter((n) => n.length > 0).join(', '),
      album: track.album?.name ?? '',
      artwork: (track.artwork?.sources ?? []).map((s) => ({
        src: s.url,
        sizes: `${s.size}x${s.size}`,
      })),
    });
  }

  async setPlaybackState(state: {
    status: 'playing' | 'paused' | 'stopped';
    positionMs: number;
    durationMs: number;
    canGoNext: boolean;
    canGoPrevious: boolean;
  }): Promise<void> {
    this.positionMs = Math.max(0, state.positionMs);
    this.durationMs = Math.max(0, state.durationMs);

    const session = this.session;
    if (session === undefined) return;
    session.playbackState = state.status === 'stopped' ? 'none' : state.status;

    if (typeof session.setPositionState !== 'function') return;
    try {
      if (this.durationMs <= 0) {
        // Live streams have no length, and a zero duration is rejected outright.
        session.setPositionState();
        return;
      }
      const duration = this.durationMs / 1000;
      session.setPositionState({
        duration,
        position: Math.min(this.positionMs / 1000, duration),
        playbackRate: 1,
      });
    } catch {
      // Chromium throws on a position/duration pair it dislikes; the transport
      // controls still work, only the scrubber is missing.
    }
  }

  onCommand(handler: (cmd: MediaSessionCommand) => void): () => void {
    this.handlers.add(handler);
    if (this.handlers.size === 1) this.attach();
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) this.detach();
    };
  }

  private emit(cmd: MediaSessionCommand): void {
    for (const handler of [...this.handlers]) handler(cmd);
  }

  private setAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    const session = this.session;
    if (session === undefined) return;
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Action unknown to this browser: skip it rather than lose the rest.
    }
  }

  private attach(): void {
    this.setAction('play', () => this.emit({ type: 'play' }));
    this.setAction('pause', () => this.emit({ type: 'pause' }));
    this.setAction('stop', () => this.emit({ type: 'stop' }));
    this.setAction('nexttrack', () => this.emit({ type: 'next' }));
    this.setAction('previoustrack', () => this.emit({ type: 'previous' }));
    this.setAction('seekto', (details) => {
      const seconds = details.seekTime;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;
      this.emit({ type: 'seek', positionMs: Math.max(0, Math.round(seconds * 1000)) });
    });
    this.setAction('seekbackward', (details) => {
      const step = (details.seekOffset ?? DEFAULT_SEEK_STEP_SEC) * 1000;
      this.emit({ type: 'seek', positionMs: Math.max(0, Math.round(this.positionMs - step)) });
    });
    this.setAction('seekforward', (details) => {
      const step = (details.seekOffset ?? DEFAULT_SEEK_STEP_SEC) * 1000;
      const target = Math.round(this.positionMs + step);
      this.emit({
        type: 'seek',
        positionMs: this.durationMs > 0 ? Math.min(target, this.durationMs) : target,
      });
    });
  }

  private detach(): void {
    const actions: MediaSessionAction[] = [
      'play', 'pause', 'stop', 'nexttrack', 'previoustrack',
      'seekto', 'seekbackward', 'seekforward',
    ];
    for (const action of actions) this.setAction(action, null);
  }
}

export class WebHost implements HostBridge {
  readonly platform = 'web' as const;
  readonly capabilities: HostCapabilities = CAPABILITIES;

  readonly http: HttpClient = new WebHttp();
  readonly kv: KeyValueStore = new WebKv();
  readonly db: DatabaseBridge = new WebDb();
  readonly files: FileBridge = new WebFiles();
  readonly mediaSession: MediaSessionBridge = new BrowserMediaSession();

  async getSettings(): Promise<Settings> {
    const raw = readKey(SETTINGS_KEY);
    if (raw === undefined || raw.length === 0) return defaultSettings();
    try {
      return mergeStoredSettings(JSON.parse(raw));
    } catch {
      return defaultSettings();
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    writeKey(SETTINGS_KEY, JSON.stringify(settings));
  }

  async openExternal(url: string): Promise<void> {
    if (typeof window === 'undefined') {
      throw new Error('WebHost cannot open a URL without a window');
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async getVersion(): Promise<{ app: string; platform: string; engine: string }> {
    const agent = typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent;
    return { app: '0.1.0', platform: 'web', engine: agent };
  }
}
