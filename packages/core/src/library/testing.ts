/**
 * Test fixtures for the library layer.
 *
 * `createFakeHost` is not a mock of the query strings: it runs the frozen
 * `docs/schema.sql` in an in-memory SQLite database via `node:sqlite` and lets
 * the modules under test execute their real SQL. A wrong column name, a broken
 * `ON CONFLICT` clause or a keyset predicate that skips rows therefore fails
 * here instead of on a user's library.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultSettings } from '../types';
import type { ProviderId, Settings, Track } from '../types';
import type {
  DatabaseBridge, FileBridge, HostBridge, HttpClient, HttpRequest, HttpResponse,
  KeyValueStore, LocalLibraryBridge,
} from '../host/types';

// Vite's builtin-module list predates `node:sqlite`, so a static import of it
// fails to resolve under vitest. `createRequire` loads it as the plain Node
// builtin it is.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/schema.sql');

let cachedDdl: string | undefined;

/**
 * The DDL minus its `PRAGMA` lines: `journal_mode = WAL` is meaningless for a
 * `:memory:` database and `foreign_keys` has to be set on the connection
 * itself, not inside the script.
 */
function ddl(): string {
  if (cachedDdl === undefined) {
    cachedDdl = readFileSync(SCHEMA_PATH, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().toUpperCase().startsWith('PRAGMA '))
      .join('\n');
  }
  return cachedDdl;
}

type Bindable = null | number | bigint | string | Uint8Array;

/** The host hands SQLite a JSON-serialised scalar, never a live JS object. */
function bindable(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function bindAll(params: unknown[] | undefined): Bindable[] {
  return (params ?? []).map(bindable);
}

/** node:sqlite answers with null-prototype rows; the Tauri host with plain ones. */
function plainRow(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

function absent(member: string): never {
  throw new Error(`fake host: ${member} is not available in library tests`);
}

export interface FakeHostOptions {
  /**
   * Answers `host.http`. Without one every HTTP call throws, which is what the
   * library tests want; the Bazaar tests hand in a map of canned documents.
   */
  http?: (req: HttpRequest) => Promise<HttpResponse>;
}

export function createFakeHost(opts: FakeHostOptions = {}): HostBridge & { sql: string[] } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(ddl());

  const sql: string[] = [];
  const store = new Map<string, string>();
  let settings: Settings = defaultSettings();

  const db: DatabaseBridge = {
    query<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<T[]> {
      sql.push(statement);
      const rows = sqlite.prepare(statement).all(...bindAll(params));
      return Promise.resolve(rows.map(plainRow) as T[]);
    },
    execute(statement: string, params?: unknown[]): Promise<number> {
      sql.push(statement);
      return Promise.resolve(sqlite.prepare(statement).run(...bindAll(params)).changes as number);
    },
    transaction(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
      if (statements.length === 0) return Promise.resolve();
      sqlite.exec('BEGIN');
      try {
        for (const statement of statements) {
          sql.push(statement.sql);
          sqlite.prepare(statement.sql).run(...bindAll(statement.params));
        }
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return Promise.resolve();
    },
  };

  const kv: KeyValueStore = {
    get: (key) => Promise.resolve(store.get(key)),
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
    keys: (prefix) =>
      Promise.resolve(
        [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
      ),
  };

  const answer = opts.http;
  const http: HttpClient = {
    request: (req) => (answer === undefined ? absent('http.request') : answer(req)),
    async json<T>(req: HttpRequest): Promise<T> {
      if (answer === undefined) return absent('http.json');
      const res = await answer(req);
      return JSON.parse(res.body) as T;
    },
  };

  const files: FileBridge = {
    exists: () => absent('files.exists'),
    readText: () => absent('files.readText'),
    writeText: () => absent('files.writeText'),
    remove: () => absent('files.remove'),
    dirSize: () => absent('files.dirSize'),
    pickFolder: () => absent('files.pickFolder'),
    toPlayableUrl: () => absent('files.toPlayableUrl'),
    download: () => absent('files.download'),
    cancelDownload: () => absent('files.cancelDownload'),
  };

  const localLibrary: LocalLibraryBridge = {
    scan: () => absent('localLibrary.scan'),
    cancelScan: () => absent('localLibrary.cancelScan'),
    setWatching: () => absent('localLibrary.setWatching'),
    refreshFile: () => absent('localLibrary.refreshFile'),
  };

  return {
    platform: 'desktop',
    capabilities: {
      nativeAudio: true,
      localFiles: true,
      offlineDownloads: true,
      osMediaControls: false,
      systemTray: false,
      globalShortcuts: false,
      unrestrictedHttp: true,
    },
    sql,
    http,
    kv,
    db,
    files,
    localLibrary,
    getSettings: () => Promise.resolve(settings),
    saveSettings: (next) => {
      settings = next;
      return Promise.resolve();
    },
    openExternal: () => absent('openExternal'),
    getVersion: () =>
      Promise.resolve({ app: '0.0.0-test', platform: 'test', engine: 'node:sqlite' }),
  };
}

const PROVIDERS: ProviderId[] = ['local', 'audius', 'jamendo', 'archive', 'radio'];

/**
 * A renderable Track. `id` may be a bare id (`'a'` ⇒ `local:track:a`) or a full
 * uri, so a remote fixture is written as `track('audius:track:a')`.
 */
export function track(id: string, over?: Partial<Track>): Track {
  const uri = id.includes(':') ? id : `local:track:${id}`;
  const head = uri.slice(0, uri.indexOf(':'));
  const provider = (PROVIDERS as string[]).includes(head) ? (head as ProviderId) : 'local';
  const slug = uri.slice(uri.lastIndexOf(':') + 1);
  const base: Track = {
    uri,
    provider,
    title: `Track ${slug}`,
    artists: [{ uri: `${provider}:artist:art-${slug}`, name: `Artist ${slug}` }],
    album: { uri: `${provider}:album:alb-${slug}`, name: `Album ${slug}` },
    durationMs: 180_000,
  };
  if (provider === 'local') base.path = `/music/${slug}.mp3`;
  return { ...base, ...over };
}
