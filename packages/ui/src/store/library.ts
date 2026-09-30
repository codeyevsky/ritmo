import { create } from 'zustand';
import type {
  Album,
  Artist,
  EntityKind,
  HostBridge,
  Library,
  LibraryStats,
  Playlist,
  ScanProgress,
  ScanResult,
  Track,
  Uri,
} from '@ritmo/core';

export interface LibraryBindings {
  host: HostBridge;
  library: Library;
}

export interface LibraryStore {
  playlists: Playlist[];
  /** Replaced wholesale on every change so referential equality is meaningful. */
  likedUris: Set<Uri>;
  offlineUris: Set<Uri>;
  stats?: LibraryStats;
  scan?: ScanProgress;
  scanning: boolean;
  /** Result of the most recent finished scan — drives the summary toast. */
  lastScan?: ScanResult;
  scanError?: Error;
  refreshPlaylists(): Promise<void>;
  refreshStats(): Promise<void>;
  refreshLiked(): Promise<void>;
  refreshOffline(): Promise<void>;
  /** Everything at once; called after any mutation that can touch several lists. */
  invalidate(): Promise<void>;
  toggleLike(track: Track): Promise<void>;
  /**
   * Like/unlike anything the library can hold. Every like in the app must go
   * through the store: `likedUris` is what `useIsLiked` renders from, so calling
   * the repo directly updates the database and leaves the heart stale.
   */
  toggleEntityLike(
    uri: Uri,
    kind: EntityKind,
    snapshot?: Track | Album | Artist | Playlist,
  ): Promise<void>;
  isLiked(uri: Uri): boolean;
  isOffline(uri: Uri): boolean;
  /** Walks the configured folders, streaming progress into the store. */
  startScan(folders: string[]): Promise<ScanResult | undefined>;
  cancelScan(): Promise<void>;
  bind(deps: LibraryBindings): () => void;
}

const LIKED_PAGE = 500;
const LIKED_PAGE_CAP = 40;

let bindings: LibraryBindings | undefined;

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** The likes table is paged; the UI wants the whole uri set to drive heart icons. */
async function collectLikedUris(library: Library): Promise<Set<Uri>> {
  const uris = new Set<Uri>();
  let cursor: string | undefined;
  for (let page = 0; page < LIKED_PAGE_CAP; page++) {
    const res = await library.likes.listTracks({ limit: LIKED_PAGE, cursor });
    for (const track of res.items) uris.add(track.uri);
    if (!res.cursor || res.items.length === 0) break;
    cursor = res.cursor;
  }
  return uris;
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  playlists: [],
  likedUris: new Set<Uri>(),
  offlineUris: new Set<Uri>(),
  scanning: false,

  refreshPlaylists: async () => {
    if (!bindings) return;
    try {
      set({ playlists: await bindings.library.playlists.list() });
    } catch (e) {
      console.warn('playlists could not be listed', e);
    }
  },

  refreshStats: async () => {
    if (!bindings) return;
    try {
      set({ stats: await bindings.library.repo.stats() });
    } catch (e) {
      console.warn('library stats could not be read', e);
    }
  },

  refreshLiked: async () => {
    if (!bindings) return;
    try {
      set({ likedUris: await collectLikedUris(bindings.library) });
    } catch (e) {
      console.warn('liked tracks could not be read', e);
    }
  },

  refreshOffline: async () => {
    if (!bindings) return;
    try {
      const rows = await bindings.library.offline.list();
      set({ offlineUris: new Set(rows.map((r) => r.track.uri)) });
    } catch (e) {
      console.warn('offline list could not be read', e);
    }
  },

  invalidate: async () => {
    await Promise.all([
      get().refreshPlaylists(),
      get().refreshStats(),
      get().refreshLiked(),
      get().refreshOffline(),
    ]);
  },

  toggleLike: async (track) => {
    if (!bindings) return;
    const before = get().likedUris;
    const optimistic = new Set(before);
    if (optimistic.has(track.uri)) optimistic.delete(track.uri);
    else optimistic.add(track.uri);
    set({ likedUris: optimistic });

    try {
      const liked = await bindings.library.likes.toggle(track.uri, 'track', track);
      // The repo is the authority: reconcile if it disagreed with the guess.
      if (liked !== optimistic.has(track.uri)) {
        const corrected = new Set(get().likedUris);
        if (liked) corrected.add(track.uri);
        else corrected.delete(track.uri);
        set({ likedUris: corrected });
      }
      void get().refreshStats();
    } catch (e) {
      console.warn('like could not be saved', e);
      set({ likedUris: before });
    }
  },

  toggleEntityLike: async (uri, kind, snapshot) => {
    if (!bindings || uri.length === 0) return;
    const before = get().likedUris;
    const optimistic = new Set(before);
    if (optimistic.has(uri)) optimistic.delete(uri);
    else optimistic.add(uri);
    set({ likedUris: optimistic });

    try {
      const liked = await bindings.library.likes.toggle(uri, kind, snapshot);
      if (liked !== optimistic.has(uri)) {
        const corrected = new Set(get().likedUris);
        if (liked) corrected.add(uri);
        else corrected.delete(uri);
        set({ likedUris: corrected });
      }
      void get().refreshStats();
    } catch (e) {
      console.warn('like could not be saved', toError(e));
      set({ likedUris: before });
    }
  },

  isLiked: (uri) => get().likedUris.has(uri),
  isOffline: (uri) => get().offlineUris.has(uri),

  startScan: async (folders) => {
    const deps = bindings;
    const local = deps?.host.localLibrary;
    if (deps === undefined || local === undefined || get().scanning || folders.length === 0) {
      return undefined;
    }

    set({
      scanning: true,
      scanError: undefined,
      lastScan: undefined,
      scan: { phase: 'walking', filesSeen: 0, filesImported: 0 },
    });

    try {
      const result = await local.scan(folders, (p) => set({ scan: p }));
      // A scan prunes the files that are gone, which can leave a local album
      // row behind with no tracks pointing at it.
      await deps.library.repo.vacuumOrphans();
      set({ scanning: false, scan: undefined, lastScan: result });
      await get().invalidate();
      return result;
    } catch (e) {
      set({ scanning: false, scan: undefined, scanError: toError(e) });
      return undefined;
    }
  },

  cancelScan: async () => {
    const local = bindings?.host.localLibrary;
    if (!local) return;
    try {
      await local.cancelScan();
    } catch (e) {
      console.warn('scan could not be cancelled', e);
    } finally {
      set({ scanning: false, scan: undefined });
    }
  },

  bind: (deps) => {
    bindings = deps;
    void get().invalidate();
    return () => {
      if (bindings === deps) bindings = undefined;
    };
  },
}));
