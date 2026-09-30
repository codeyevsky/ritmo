/**
 * Mobile host — Capacitor plugins behind the same bridge the desktop uses.
 *
 * Every plugin is pulled in through {@link loadPlugin}, which imports it by a
 * *variable* specifier. That is deliberate: `@ritmo/core` is compiled into the
 * desktop and browser bundles too, where none of these packages are installed.
 * A literal `import('@capacitor/filesystem')` would make those builds fail to
 * resolve; a variable one leaves resolution to runtime, so a missing plugin
 * surfaces as the descriptive error below instead of a build break.
 *
 * Audio plays through the HTML engine here (`nativeAudio: false`), and the OS
 * transport controls come from `navigator.mediaSession`, which Android and iOS
 * both wire to the notification/lock screen.
 */

import { defaultSettings, makeUri } from '../types';
import type { ArtistRef, Artwork, Settings, Track } from '../types';
import { normalizeKey } from '../util/text';
import type {
  DatabaseBridge, DownloadRequest, DownloadResult, FileBridge, HostBridge,
  HostCapabilities, HttpClient, HttpRequest, HttpResponse, KeyValueStore,
  LocalLibraryBridge, MediaSessionBridge, ScanProgress, ScanResult,
} from './types';
import {
  BrowserMediaSession, MemoryResponseCache, describeError, mergeStoredSettings,
  parseJsonBody,
} from './web';

const KV_PREFIX = 'ritmo:';
const DEFAULT_TIMEOUT_MS = 20000;
/** Statements per transaction while scanning — big enough to amortise the
 *  bridge round-trip, small enough that a failure loses little work. */
const SCAN_BATCH = 240;
const PROGRESS_INTERVAL_MS = 100;

const CAPABILITIES: HostCapabilities = {
  nativeAudio: false,
  localFiles: true,
  offlineDownloads: true,
  osMediaControls: true,
  systemTray: false,
  globalShortcuts: false,
  unrestrictedHttp: true,
};

function unavailable(operation: string): Error {
  return new Error(`CapacitorHost cannot ${operation}: no mobile plugin provides it`);
}

// --- plugin loading ---------------------------------------------------------

async function loadPlugin(specifier: string): Promise<Record<string, unknown>> {
  try {
    const mod: unknown = await import(/* @vite-ignore */ specifier);
    if (typeof mod !== 'object' || mod === null) {
      throw new Error('module did not export an object');
    }
    return mod as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `CapacitorHost: plugin "${specifier}" is unavailable in this build: ${describeError(err)}`,
    );
  }
}

function pick<T>(mod: Record<string, unknown>, name: string, specifier: string): T {
  const value = mod[name];
  if (value === undefined || value === null) {
    throw new Error(`CapacitorHost: "${specifier}" does not export ${name}`);
  }
  return value as T;
}

/** Memoised loader; a failed load is not cached so a retry can succeed. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending === undefined) {
      pending = load().catch((err: unknown) => {
        pending = undefined;
        throw err;
      });
    }
    return pending;
  };
}

interface CapacitorGlobal {
  convertFileSrc(url: string): string;
  isNativePlatform(): boolean;
  getPlatform(): string;
}

interface CapHttpOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  data?: string;
  responseType?: string;
  connectTimeout?: number;
  readTimeout?: number;
}

interface CapHttpResponse {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}

interface CapHttpPlugin {
  request(options: CapHttpOptions): Promise<CapHttpResponse>;
}

interface PreferencesPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

interface FsEntry {
  name?: string;
  type?: string;
  size?: number;
  mtime?: number;
  uri?: string;
}

interface FsStat {
  type?: string;
  size?: number;
  mtime?: number;
  uri?: string;
}

interface FsListener {
  remove(): Promise<void>;
}

interface FsProgressEvent {
  url?: string;
  bytes?: number;
  contentLength?: number;
}

interface FilesystemPlugin {
  readdir(options: { path: string; directory?: string }): Promise<{ files: Array<FsEntry | string> }>;
  stat(options: { path: string; directory?: string }): Promise<FsStat>;
  readFile(options: { path: string; directory?: string; encoding?: string }): Promise<{ data: unknown }>;
  writeFile(options: {
    path: string; data: string; directory?: string; encoding?: string; recursive?: boolean;
  }): Promise<{ uri?: string }>;
  deleteFile(options: { path: string; directory?: string }): Promise<void>;
  downloadFile(options: {
    url: string; path: string; directory?: string; headers?: Record<string, string>;
    progress?: boolean; recursive?: boolean;
  }): Promise<{ path?: string }>;
  addListener(
    event: 'progress',
    handler: (event: FsProgressEvent) => void,
  ): Promise<FsListener>;
}

interface SQLiteDb {
  open(): Promise<void>;
  isDBOpen(): Promise<{ result?: boolean }>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<{
    changes?: { changes?: number };
  }>;
  executeSet(
    set: Array<{ statement: string; values: unknown[] }>,
    transaction?: boolean,
  ): Promise<{ changes?: { changes?: number } }>;
}

interface SQLiteConnectionLike {
  checkConnectionsConsistency(): Promise<{ result?: boolean }>;
  isConnection(database: string, readonly: boolean): Promise<{ result?: boolean }>;
  createConnection(
    database: string, encrypted: boolean, mode: string, version: number, readonly: boolean,
  ): Promise<SQLiteDb>;
  retrieveConnection(database: string, readonly: boolean): Promise<SQLiteDb>;
}

type SQLiteConnectionCtor = new (plugin: unknown) => SQLiteConnectionLike;

/**
 * `FileBridge.toPlayableUrl` is synchronous, so it cannot await the module
 * import; the Capacitor runtime injects the same object on `window`, and this
 * caches whichever of the two answers first.
 */
let coreSync: CapacitorGlobal | undefined;

function capacitorFromGlobal(): CapacitorGlobal | undefined {
  if (coreSync !== undefined) return coreSync;
  const holder = globalThis as { Capacitor?: unknown };
  const candidate = holder.Capacitor;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const maybe = candidate as { convertFileSrc?: unknown };
  if (typeof maybe.convertFileSrc !== 'function') return undefined;
  coreSync = candidate as CapacitorGlobal;
  return coreSync;
}

const core = once(async (): Promise<CapacitorGlobal> => {
  const mod = await loadPlugin('@capacitor/core');
  const value = pick<CapacitorGlobal>(mod, 'Capacitor', '@capacitor/core');
  coreSync = value;
  return value;
});

const capHttp = once(async (): Promise<CapHttpPlugin> => {
  const mod = await loadPlugin('@capacitor/core');
  return pick<CapHttpPlugin>(mod, 'CapacitorHttp', '@capacitor/core');
});

const preferences = once(async (): Promise<PreferencesPlugin> => {
  const mod = await loadPlugin('@capacitor/preferences');
  return pick<PreferencesPlugin>(mod, 'Preferences', '@capacitor/preferences');
});

const filesystem = once(async (): Promise<FilesystemPlugin> => {
  const mod = await loadPlugin('@capacitor/filesystem');
  return pick<FilesystemPlugin>(mod, 'Filesystem', '@capacitor/filesystem');
});

/**
 * One shared connection named `ritmo`, opened following the plugin's documented
 * consistency dance so a live-reload that left a connection behind reuses it
 * instead of failing with "connection already exists".
 */
const sqliteDb = once(async (): Promise<SQLiteDb> => {
  const mod = await loadPlugin('@capacitor-community/sqlite');
  const plugin = pick<unknown>(mod, 'CapacitorSQLite', '@capacitor-community/sqlite');
  const Ctor = pick<SQLiteConnectionCtor>(mod, 'SQLiteConnection', '@capacitor-community/sqlite');
  const connection = new Ctor(plugin);

  const consistent = (await connection.checkConnectionsConsistency()).result === true;
  const existing = (await connection.isConnection('ritmo', false)).result === true;
  const db = consistent && existing
    ? await connection.retrieveConnection('ritmo', false)
    : await connection.createConnection('ritmo', false, 'no-encryption', 1, false);

  if ((await db.isDBOpen()).result !== true) await db.open();
  return db;
});

// --- http -------------------------------------------------------------------

class CapacitorHttpClient implements HttpClient {
  private readonly cache = new MemoryResponseCache();

  async request(req: HttpRequest): Promise<HttpResponse> {
    const cached = this.cache.get(req);
    if (cached !== undefined) return cached;

    const http = await capHttp();
    const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const raw = await http.request({
      url: req.url,
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      data: req.body,
      // Without this the plugin parses JSON for us and the body would arrive
      // as an object, breaking the string contract of HttpResponse.
      responseType: 'text',
      connectTimeout: timeout,
      readTimeout: timeout,
    });

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.headers ?? {})) {
      headers[name.toLowerCase()] = value;
    }

    const response: HttpResponse = {
      status: raw.status,
      headers,
      body: typeof raw.data === 'string'
        ? raw.data
        : raw.data === undefined || raw.data === null ? '' : JSON.stringify(raw.data),
      fromCache: false,
    };
    this.cache.put(req, response);
    return response;
  }

  async json<T>(req: HttpRequest): Promise<T> {
    return parseJsonBody<T>(req, await this.request(req));
  }
}

// --- key/value --------------------------------------------------------------

class CapacitorKv implements KeyValueStore {
  async get(key: string): Promise<string | undefined> {
    const prefs = await preferences();
    return (await prefs.get({ key: KV_PREFIX + key })).value ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const prefs = await preferences();
    await prefs.set({ key: KV_PREFIX + key, value });
  }

  async remove(key: string): Promise<void> {
    const prefs = await preferences();
    await prefs.remove({ key: KV_PREFIX + key });
  }

  async keys(prefix?: string): Promise<string[]> {
    const prefs = await preferences();
    const wanted = KV_PREFIX + (prefix ?? '');
    return (await prefs.keys()).keys
      .filter((key) => key.startsWith(wanted))
      .map((key) => key.slice(KV_PREFIX.length))
      .sort();
  }
}

// --- database ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Same contract as the Tauri host: rows come back as plain objects keyed by
 * column name, and a transaction is all-or-nothing.
 *
 * The schema itself is not created here — `docs/schema.sql` is applied by the
 * library layer's migration step, exactly as it is on desktop.
 */
class CapacitorDb implements DatabaseBridge {
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const db = await sqliteDb();
    const res = await db.query(sql, params ?? []);
    const rows = res.values ?? [];
    return rows.filter(isRecord) as unknown as T[];
  }

  async execute(sql: string, params?: unknown[]): Promise<number> {
    const db = await sqliteDb();
    const res = await db.run(sql, params ?? [], true);
    return res.changes?.changes ?? 0;
  }

  async transaction(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
    if (statements.length === 0) return;
    const db = await sqliteDb();
    await db.executeSet(
      statements.map((s) => ({ statement: s.sql, values: s.params ?? [] })),
      true,
    );
  }
}

// --- files ------------------------------------------------------------------

/** `destRelative` is documented as relative to the app cache dir. */
const CACHE_DIRECTORY = 'CACHE';

function asDataString(data: unknown): string {
  if (typeof data === 'string') return data;
  throw new Error('CapacitorHost: Filesystem returned non-text file contents');
}

class CapacitorFiles implements FileBridge {
  async exists(path: string): Promise<boolean> {
    const fs = await filesystem();
    try {
      await fs.stat({ path });
      return true;
    } catch {
      return false;
    }
  }

  async readText(path: string): Promise<string> {
    const fs = await filesystem();
    return asDataString((await fs.readFile({ path, encoding: 'utf8' })).data);
  }

  async writeText(path: string, contents: string): Promise<void> {
    const fs = await filesystem();
    await fs.writeFile({ path, data: contents, encoding: 'utf8', recursive: true });
  }

  async remove(path: string): Promise<void> {
    const fs = await filesystem();
    await fs.deleteFile({ path });
  }

  async dirSize(path: string): Promise<number> {
    const fs = await filesystem();
    let total = 0;
    const queue = [path];
    while (queue.length > 0) {
      const dir = queue.pop();
      if (dir === undefined) continue;
      let entries: Array<FsEntry | string>;
      try {
        entries = (await fs.readdir({ path: dir })).files;
      } catch {
        continue;
      }
      for (const entry of entries) {
        const info = describeEntry(dir, entry);
        if (info === undefined) continue;
        if (info.isDirectory) queue.push(info.path);
        else total += info.size;
      }
    }
    return total;
  }

  async pickFolder(): Promise<string | undefined> {
    throw unavailable('open a native folder picker');
  }

  toPlayableUrl(path: string): string {
    const cap = capacitorFromGlobal();
    if (cap !== undefined) return cap.convertFileSrc(path);
    // Before the Capacitor runtime has attached there is nothing to convert
    // with; a file URL is the closest honest answer.
    return path.startsWith('file://') ? path : `file://${path.startsWith('/') ? '' : '/'}${path}`;
  }

  async download(req: DownloadRequest): Promise<DownloadResult> {
    const fs = await filesystem();
    const onProgress = req.onProgress;

    let listener: FsListener | undefined;
    if (onProgress !== undefined) {
      listener = await fs.addListener('progress', (event) => {
        if (event.url !== undefined && event.url !== req.url) return;
        const total = event.contentLength;
        onProgress(event.bytes ?? 0, total !== undefined && total > 0 ? total : undefined);
      });
    }

    try {
      const res = await fs.downloadFile({
        url: req.url,
        path: req.destRelative,
        directory: CACHE_DIRECTORY,
        headers: req.headers,
        progress: onProgress !== undefined,
        recursive: true,
      });

      const path = res.path ?? req.destRelative;
      let bytes = 0;
      try {
        const stat = res.path === undefined
          ? await fs.stat({ path: req.destRelative, directory: CACHE_DIRECTORY })
          : await fs.stat({ path: res.path });
        bytes = stat.size ?? 0;
      } catch {
        // The bytes are only used for cache accounting; a failed stat must not
        // invalidate a download that actually completed.
      }
      return { path, bytes };
    } finally {
      // A leaked progress listener would fire for every later download.
      if (listener !== undefined) await listener.remove();
    }
  }

  async cancelDownload(): Promise<void> {
    throw unavailable('cancel an in-flight download');
  }
}

// --- local library ----------------------------------------------------------

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'm4b', 'mp4', 'aac', 'alac', 'flac', 'ogg', 'oga', 'opus',
  'wav', 'aiff', 'aif', 'wma', 'wv', 'ape', 'mpc',
]);

const COVER_NAMES = /^(?:cover|folder|front|album|albumart|artwork)\.(?:jpe?g|png|webp)$/i;

const UNKNOWN_ARTIST = 'Unknown artist';

/** `1-05 Title` — disc and track in one filename prefix. */
const DISC_TRACK_PREFIX = /^(\d{1,2})[-.](\d{1,2})(?:\s*[-._)\]]\s*|\s+)(.+)$/;
/** `05 Title`, `05 - Title`, `05. Title`. A separator is required so a bare
 *  year such as `1984 Song` is not read as track 198. */
const TRACK_PREFIX = /^(\d{1,3})(?:\s*[-._)\]]\s*|\s+)(.+)$/;
const ARTIST_TITLE_SPLIT = /\s+[-–—]\s+/;
const DISC_DIR = /^(?:cd|disc|disk)\s*(\d{1,2})$/i;
const YEAR_PREFIX = /^(\d{4})\s*[-._–—]\s*(.+)$/;

interface WalkedFile {
  path: string;
  size: number;
  mtime: number;
  /** Cover image sitting next to the file, if the folder had one. */
  coverPath?: string;
}

interface EntryInfo {
  path: string;
  name: string;
  size: number;
  mtime: number;
  isDirectory: boolean;
}

function trimTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && path.charAt(end - 1) === '/') end -= 1;
  return path.slice(0, end);
}

function joinPath(dir: string, name: string): string {
  return `${trimTrailingSlash(dir)}/${name}`;
}

function basename(path: string): string {
  const trimmed = trimTrailingSlash(path);
  const cut = trimmed.lastIndexOf('/');
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

function dirname(path: string): string {
  const trimmed = trimTrailingSlash(path);
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function isAudioPath(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(path));
}

/** Older Filesystem versions answered `readdir` with bare names. */
function describeEntry(dir: string, entry: FsEntry | string): EntryInfo | undefined {
  if (typeof entry === 'string') {
    if (entry.length === 0 || entry === '.' || entry === '..') return undefined;
    return {
      path: joinPath(dir, entry),
      name: entry,
      size: 0,
      mtime: 0,
      // Without a type field the only signal is the extension; treating
      // extensionless names as directories keeps the walk going.
      isDirectory: extensionOf(entry) === '',
    };
  }
  const name = entry.name;
  if (name === undefined || name.length === 0 || name === '.' || name === '..') return undefined;
  return {
    path: joinPath(dir, name),
    name,
    size: entry.size ?? 0,
    mtime: entry.mtime ?? 0,
    isDirectory: entry.type === 'directory',
  };
}

interface PathMeta {
  title: string;
  artist: string;
  album?: string;
  trackNumber?: number;
  discNumber?: number;
  releaseDate?: string;
}

/**
 * Tag reading needs a decoder Capacitor does not have, so metadata is inferred
 * from the path: `Artist - Title.mp3`, `NN Title.mp3` and the common
 * `Artist/Album/NN Title.mp3` (with `CD1` disc folders and `1999 - Album`
 * year-prefixed folders) all round-trip. Anything else keeps the filename as
 * the title, which is still better than an empty row. The HTML engine fills in
 * the real duration when the track is first played.
 */
function parsePathMeta(path: string, roots: string[]): PathMeta {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();

  let rest = stem;
  let trackNumber: number | undefined;
  let discNumber: number | undefined;

  const discTrack = DISC_TRACK_PREFIX.exec(rest);
  const plainTrack = discTrack === null ? TRACK_PREFIX.exec(rest) : null;
  if (discTrack !== null && discTrack[1] !== undefined && discTrack[2] !== undefined && discTrack[3] !== undefined) {
    discNumber = Number.parseInt(discTrack[1], 10);
    trackNumber = Number.parseInt(discTrack[2], 10);
    rest = discTrack[3].trim();
  } else if (plainTrack !== null && plainTrack[1] !== undefined && plainTrack[2] !== undefined) {
    trackNumber = Number.parseInt(plainTrack[1], 10);
    rest = plainTrack[2].trim();
  }

  let title = rest.length > 0 ? rest : stem;
  let artist: string | undefined;
  const parts = rest.split(ARTIST_TITLE_SPLIT).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length >= 2) {
    artist = parts[0];
    title = parts.slice(1).join(' - ');
  }

  const chain = folderChain(dirname(path), roots);
  let albumDir = chain.length > 0 ? chain[chain.length - 1] : undefined;
  let artistDir = chain.length > 1 ? chain[chain.length - 2] : undefined;

  if (albumDir !== undefined) {
    const disc = DISC_DIR.exec(albumDir);
    if (disc !== null && disc[1] !== undefined) {
      discNumber = discNumber ?? Number.parseInt(disc[1], 10);
      albumDir = artistDir;
      artistDir = chain.length > 2 ? chain[chain.length - 3] : undefined;
    }
  }

  let album: string | undefined;
  let releaseDate: string | undefined;
  if (albumDir !== undefined && albumDir.length > 0) {
    const year = YEAR_PREFIX.exec(albumDir);
    if (year !== null && year[1] !== undefined && year[2] !== undefined) {
      releaseDate = year[1];
      album = year[2].trim();
    } else {
      album = albumDir;
    }
  }

  const meta: PathMeta = {
    title: title.length > 0 ? title : stem,
    artist: artist ?? (artistDir !== undefined && artistDir.length > 0 ? artistDir : UNKNOWN_ARTIST),
  };
  if (album !== undefined && album.length > 0) meta.album = album;
  if (trackNumber !== undefined && trackNumber > 0) meta.trackNumber = trackNumber;
  if (discNumber !== undefined && discNumber > 0) meta.discNumber = discNumber;
  if (releaseDate !== undefined) meta.releaseDate = releaseDate;
  return meta;
}

/**
 * Directory names between the scan root and the file, nearest last. Capped at
 * three because deeper nesting carries no reliable meaning — and because a path
 * that matches no configured root must not contribute its whole prefix.
 */
function folderChain(dir: string, roots: string[]): string[] {
  const isRoot = (candidate: string): boolean =>
    roots.some((root) => trimTrailingSlash(root) === trimTrailingSlash(candidate));

  const chain: string[] = [];
  let cursor = trimTrailingSlash(dir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (cursor.length <= 1 || isRoot(cursor)) break;
    chain.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return chain.slice(-3);
}

/**
 * FNV-1a in two 32-bit lanes. Core has no crypto primitive and none is needed:
 * the id only has to be stable for a given path, and `tracks.path` carries a
 * unique index that catches any collision as a conflict on the same row.
 */
function pathId(path: string): string {
  let a = 0x811c9dc5;
  let b = 0x811c9dc5 ^ 0x5bf03635;
  for (let i = 0; i < path.length; i += 1) {
    const c = path.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

interface Statement {
  sql: string;
  params?: unknown[];
}

const UPSERT_ARTIST = `
INSERT INTO artists (uri, provider, name, name_key, updated_at)
VALUES (?, 'local', ?, ?, ?)
ON CONFLICT(uri) DO UPDATE SET
  name = excluded.name, name_key = excluded.name_key, updated_at = excluded.updated_at`;

const UPSERT_ALBUM = `
INSERT INTO albums (uri, provider, name, name_key, artists_json, primary_artist,
                    artwork_json, release_date, updated_at)
VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(uri) DO UPDATE SET
  name = excluded.name,
  name_key = excluded.name_key,
  artists_json = excluded.artists_json,
  primary_artist = excluded.primary_artist,
  artwork_json = COALESCE(excluded.artwork_json, albums.artwork_json),
  release_date = COALESCE(excluded.release_date, albums.release_date),
  updated_at = excluded.updated_at`;

const UPSERT_TRACK = `
INSERT INTO tracks (uri, provider, title, title_key, artists_json, primary_artist,
                    album_uri, album_json, duration_ms, track_number, disc_number,
                    release_date, artwork_json, path, added_at, updated_at,
                    file_mtime, file_size)
VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(uri) DO UPDATE SET
  title = excluded.title,
  title_key = excluded.title_key,
  artists_json = excluded.artists_json,
  primary_artist = excluded.primary_artist,
  album_uri = excluded.album_uri,
  album_json = excluded.album_json,
  track_number = excluded.track_number,
  disc_number = excluded.disc_number,
  release_date = excluded.release_date,
  artwork_json = excluded.artwork_json,
  path = excluded.path,
  updated_at = excluded.updated_at,
  file_mtime = excluded.file_mtime,
  file_size = excluded.file_size`;

function artworkFor(coverPath: string | undefined, files: FileBridge): Artwork | undefined {
  if (coverPath === undefined) return undefined;
  return { sources: [{ url: files.toPlayableUrl(coverPath), size: 512 }] };
}

function trackFromFile(file: WalkedFile, roots: string[], files: FileBridge): Track {
  const meta = parsePathMeta(file.path, roots);
  const artists: ArtistRef[] = [
    { uri: makeUri('local', 'artist', normalizeKey(meta.artist)), name: meta.artist },
  ];
  const artwork = artworkFor(file.coverPath, files);

  const track: Track = {
    uri: makeUri('local', 'track', pathId(file.path)),
    provider: 'local',
    title: meta.title,
    artists,
    durationMs: 0,
    path: file.path,
  };
  if (meta.album !== undefined) {
    const albumUri = makeUri('local', 'album', pathId(`${normalizeKey(meta.artist)}/${normalizeKey(meta.album)}`));
    track.album = { uri: albumUri, name: meta.album, artwork };
  }
  if (meta.trackNumber !== undefined) track.trackNumber = meta.trackNumber;
  if (meta.discNumber !== undefined) track.discNumber = meta.discNumber;
  if (meta.releaseDate !== undefined) track.releaseDate = meta.releaseDate;
  if (artwork !== undefined) track.artwork = artwork;
  return track;
}

function upsertStatements(track: Track, file: WalkedFile, now: number): Statement[] {
  const primary = track.artists[0];
  const artistsJson = JSON.stringify(track.artists);
  const artworkJson = track.artwork === undefined ? null : JSON.stringify(track.artwork);
  const statements: Statement[] = [];

  for (const artist of track.artists) {
    statements.push({
      sql: UPSERT_ARTIST,
      params: [artist.uri, artist.name, normalizeKey(artist.name), now],
    });
  }

  if (track.album !== undefined) {
    statements.push({
      sql: UPSERT_ALBUM,
      params: [
        track.album.uri, track.album.name, normalizeKey(track.album.name), artistsJson,
        primary?.name ?? null, artworkJson, track.releaseDate ?? null, now,
      ],
    });
  }

  statements.push({
    sql: UPSERT_TRACK,
    params: [
      track.uri,
      track.title,
      normalizeKey(track.title),
      artistsJson,
      primary?.name ?? null,
      track.album?.uri ?? null,
      track.album === undefined ? null : JSON.stringify(track.album),
      track.durationMs,
      track.trackNumber ?? null,
      track.discNumber ?? null,
      track.releaseDate ?? null,
      artworkJson,
      file.path,
      now,
      now,
      file.mtime,
      file.size,
    ],
  });

  return statements;
}

interface KnownTrack {
  uri: string;
  mtime: number;
  size: number;
}

function progressReporter(onProgress?: (p: ScanProgress) => void): (p: ScanProgress) => void {
  if (onProgress === undefined) return () => undefined;
  let last = 0;
  return (p) => {
    const now = Date.now();
    // A 20k-file folder would otherwise re-render the progress row 20k times.
    if (p.phase !== 'done' && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    onProgress(p);
  };
}

class CapacitorLocalLibrary implements LocalLibraryBridge {
  private cancelled = false;
  private scanning = false;

  constructor(private readonly db: DatabaseBridge, private readonly files: FileBridge) {}

  async scan(folders: string[], onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const startedAt = Date.now();
    const report = progressReporter(onProgress);
    const errors: Array<{ path: string; message: string }> = [];
    const roots = folders.map(trimTrailingSlash).filter((f) => f.length > 0);

    this.cancelled = false;
    this.scanning = true;
    let added = 0;
    let updated = 0;
    let removed = 0;
    let filesSeen = 0;
    let filesImported = 0;

    try {
      const walked: WalkedFile[] = [];
      for (const root of roots) {
        if (this.cancelled) break;
        await this.walk(root, walked, errors, (path) => {
          filesSeen += 1;
          report({ phase: 'walking', filesSeen, filesImported, currentPath: path });
        });
      }

      const known = await this.knownTracks(roots, errors);
      const seen = new Set<string>();
      let batch: Statement[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const pending = batch;
        batch = [];
        try {
          await this.db.transaction(pending);
        } catch (err) {
          errors.push({ path: '<database>', message: describeError(err) });
        }
      };

      const now = Date.now();
      for (const file of walked) {
        if (this.cancelled) break;
        seen.add(file.path);

        const prior = known.get(file.path);
        const unchanged = prior !== undefined
          && prior.mtime === file.mtime
          && prior.size === file.size;
        if (unchanged) continue;

        batch.push(...upsertStatements(trackFromFile(file, roots, this.files), file, now));
        if (prior === undefined) added += 1;
        else updated += 1;
        filesImported += 1;
        report({ phase: 'reading', filesSeen, filesImported, currentPath: file.path });

        if (batch.length >= SCAN_BATCH) await flush();
      }
      await flush();

      // Only a scan that ran to completion may delete: a cancelled one has not
      // seen the files it never reached.
      if (!this.cancelled) {
        const gone = [...known.entries()].filter(([path]) => !seen.has(path));
        for (let i = 0; i < gone.length; i += SCAN_BATCH) {
          const slice = gone.slice(i, i + SCAN_BATCH);
          try {
            await this.db.transaction(
              slice.map(([, row]) => ({ sql: 'DELETE FROM tracks WHERE uri = ?', params: [row.uri] })),
            );
            removed += slice.length;
          } catch (err) {
            errors.push({ path: '<database>', message: describeError(err) });
          }
        }
      }

      report({ phase: 'done', filesSeen, filesImported });
      return { added, updated, removed, errors, durationMs: Date.now() - startedAt };
    } finally {
      this.scanning = false;
    }
  }

  async cancelScan(): Promise<void> {
    if (this.scanning) this.cancelled = true;
  }

  /**
   * There is no inotify equivalent behind Capacitor's Filesystem, so watching
   * is a no-op rather than an error: the setting defaults to on, and failing
   * here would surface a spurious startup error. Incremental updates instead
   * happen on the next scan, which skips files whose mtime and size match.
   */
  async setWatching(): Promise<void> {
    return undefined;
  }

  async refreshFile(path: string): Promise<Track | undefined> {
    if (!isAudioPath(path)) return undefined;
    const fs = await filesystem();

    let stat: FsStat;
    try {
      stat = await fs.stat({ path });
    } catch {
      return undefined;
    }
    if (stat.type === 'directory') return undefined;

    const file: WalkedFile = {
      path,
      size: stat.size ?? 0,
      mtime: stat.mtime ?? 0,
      coverPath: await this.findCover(dirname(path)),
    };
    const track = trackFromFile(file, [], this.files);
    await this.db.transaction(upsertStatements(track, file, Date.now()));
    return track;
  }

  private async walk(
    root: string,
    into: WalkedFile[],
    errors: Array<{ path: string; message: string }>,
    tick: (path: string) => void,
  ): Promise<void> {
    const fs = await filesystem();
    const queue = [root];

    while (queue.length > 0) {
      if (this.cancelled) return;
      const dir = queue.pop();
      if (dir === undefined) continue;

      let entries: Array<FsEntry | string>;
      try {
        entries = (await fs.readdir({ path: dir })).files;
      } catch (err) {
        errors.push({ path: dir, message: describeError(err) });
        continue;
      }

      const audio: EntryInfo[] = [];
      let coverPath: string | undefined;
      for (const entry of entries) {
        const info = describeEntry(dir, entry);
        if (info === undefined) continue;
        if (info.isDirectory) {
          queue.push(info.path);
          continue;
        }
        if (coverPath === undefined && COVER_NAMES.test(info.name)) coverPath = info.path;
        if (isAudioPath(info.path)) audio.push(info);
      }

      for (const info of audio) {
        const file: WalkedFile = { path: info.path, size: info.size, mtime: info.mtime };
        if (coverPath !== undefined) file.coverPath = coverPath;
        into.push(file);
        tick(info.path);
      }
    }
  }

  private async findCover(dir: string): Promise<string | undefined> {
    const fs = await filesystem();
    try {
      for (const entry of (await fs.readdir({ path: dir })).files) {
        const info = describeEntry(dir, entry);
        if (info !== undefined && !info.isDirectory && COVER_NAMES.test(info.name)) return info.path;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async knownTracks(
    roots: string[],
    errors: Array<{ path: string; message: string }>,
  ): Promise<Map<string, KnownTrack>> {
    const out = new Map<string, KnownTrack>();
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await this.db.query<Record<string, unknown>>(
        "SELECT uri, path, file_mtime, file_size FROM tracks WHERE provider = 'local' AND path IS NOT NULL",
      );
    } catch (err) {
      errors.push({ path: '<database>', message: describeError(err) });
      return out;
    }

    for (const row of rows) {
      const path = typeof row['path'] === 'string' ? row['path'] : undefined;
      const uri = typeof row['uri'] === 'string' ? row['uri'] : undefined;
      if (path === undefined || uri === undefined) continue;
      // Rows from a folder the user has since removed from Settings are not
      // this scan's business, so they must not count as "gone".
      const inScope = roots.some((root) => path === root || path.startsWith(`${root}/`));
      if (!inScope) continue;
      out.set(path, {
        uri,
        mtime: typeof row['file_mtime'] === 'number' ? row['file_mtime'] : -1,
        size: typeof row['file_size'] === 'number' ? row['file_size'] : -1,
      });
    }
    return out;
  }
}

// --- host -------------------------------------------------------------------

export class CapacitorHost implements HostBridge {
  readonly platform = 'mobile' as const;
  readonly capabilities: HostCapabilities = CAPABILITIES;

  readonly http: HttpClient = new CapacitorHttpClient();
  readonly kv: KeyValueStore = new CapacitorKv();
  readonly db: DatabaseBridge = new CapacitorDb();
  readonly files: FileBridge = new CapacitorFiles();
  readonly localLibrary: LocalLibraryBridge;
  readonly mediaSession: MediaSessionBridge = new BrowserMediaSession();

  constructor() {
    this.localLibrary = new CapacitorLocalLibrary(this.db, this.files);
    // Warms `Capacitor.convertFileSrc` for the synchronous `toPlayableUrl`.
    void core().catch(() => undefined);
  }

  async getSettings(): Promise<Settings> {
    try {
      const raw = await this.kv.get('settings');
      if (raw === undefined || raw.length === 0) return defaultSettings();
      return mergeStoredSettings(JSON.parse(raw));
    } catch {
      return defaultSettings();
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.kv.set('settings', JSON.stringify(settings));
  }

  /** `_system` is Capacitor's signal to hand the URL to the real browser. */
  async openExternal(url: string): Promise<void> {
    if (typeof window === 'undefined') throw unavailable('open a URL without a window');
    window.open(url, '_system');
  }

  async getVersion(): Promise<{ app: string; platform: string; engine: string }> {
    let platform = 'mobile';
    try {
      platform = (await core()).getPlatform();
    } catch {
      // Version info is diagnostic; a missing plugin must not break the About pane.
    }
    return { app: '0.1.0', platform, engine: 'capacitor-webview' };
  }
}
