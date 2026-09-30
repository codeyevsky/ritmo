import { useMemo } from 'react';
import type { LibraryStats, Playlist, ScanProgress, ScanResult, Track, Uri } from '@ritmo/core';

import { useServices } from '../services';
import { useLibraryStore } from '../store/library';
import { useSettingsStore } from '../store/settings';

export interface LibraryApi {
  playlists: Playlist[];
  likedUris: Set<Uri>;
  offlineUris: Set<Uri>;
  stats?: LibraryStats;
  scan?: ScanProgress;
  scanning: boolean;
  lastScan?: ScanResult;
  scanError?: Error;
  isLiked(uri: Uri): boolean;
  isOffline(uri: Uri): boolean;
  toggleLike(track: Track): Promise<void>;
  /** Refreshes playlists, stats, likes and downloads together. */
  refresh(): Promise<void>;
  refreshPlaylists(): Promise<void>;
  refreshStats(): Promise<void>;
  createPlaylist(name: string, opts?: { description?: string; tracks?: Track[] }): Promise<Playlist>;
  renamePlaylist(uri: Uri, name: string): Promise<void>;
  setPlaylistDescription(uri: Uri, description: string): Promise<void>;
  duplicatePlaylist(uri: Uri, name?: string): Promise<Playlist>;
  removePlaylist(uri: Uri): Promise<void>;
  addToPlaylist(uri: Uri, tracks: Track[], at?: number): Promise<void>;
  removeFromPlaylist(uri: Uri, positions: number[]): Promise<void>;
  movePlaylistTrack(uri: Uri, from: number, to: number): Promise<void>;
  playlistsContaining(trackUri: Uri): Promise<Playlist[]>;
  download(track: Track): Promise<void>;
  removeDownload(trackUri: Uri): Promise<void>;
  /** Rescans the configured music folders. Resolves undefined where unsupported. */
  rescan(): Promise<ScanResult | undefined>;
  cancelScan(): Promise<void>;
}

/**
 * Playlist and download mutations reject on failure: they are explicit user
 * actions, so the calling view owns the error toast. `toggleLike` is the
 * exception — it is optimistic and rolls itself back.
 */
export function useLibrary(): LibraryApi {
  const { library, registry } = useServices();

  const playlists = useLibraryStore((s) => s.playlists);
  const likedUris = useLibraryStore((s) => s.likedUris);
  const offlineUris = useLibraryStore((s) => s.offlineUris);
  const stats = useLibraryStore((s) => s.stats);
  const scan = useLibraryStore((s) => s.scan);
  const scanning = useLibraryStore((s) => s.scanning);
  const lastScan = useLibraryStore((s) => s.lastScan);
  const scanError = useLibraryStore((s) => s.scanError);
  const toggleLike = useLibraryStore((s) => s.toggleLike);
  const refresh = useLibraryStore((s) => s.invalidate);
  const refreshPlaylists = useLibraryStore((s) => s.refreshPlaylists);
  const refreshStats = useLibraryStore((s) => s.refreshStats);
  const cancelScan = useLibraryStore((s) => s.cancelScan);

  const actions = useMemo(
    () => ({
      isLiked: (uri: Uri) => useLibraryStore.getState().likedUris.has(uri),
      isOffline: (uri: Uri) => useLibraryStore.getState().offlineUris.has(uri),

      createPlaylist: async (name: string, opts?: { description?: string; tracks?: Track[] }) => {
        const playlist = await library.playlists.create(name, opts);
        await useLibraryStore.getState().refreshPlaylists();
        void useLibraryStore.getState().refreshStats();
        return playlist;
      },
      renamePlaylist: async (uri: Uri, name: string) => {
        await library.playlists.rename(uri, name);
        await useLibraryStore.getState().refreshPlaylists();
      },
      setPlaylistDescription: async (uri: Uri, description: string) => {
        await library.playlists.setDescription(uri, description);
        await useLibraryStore.getState().refreshPlaylists();
      },
      duplicatePlaylist: async (uri: Uri, name?: string) => {
        const copy = await library.playlists.duplicate(uri, name);
        await useLibraryStore.getState().refreshPlaylists();
        return copy;
      },
      removePlaylist: async (uri: Uri) => {
        await library.playlists.remove(uri);
        await useLibraryStore.getState().refreshPlaylists();
        void useLibraryStore.getState().refreshStats();
      },
      addToPlaylist: async (uri: Uri, tracks: Track[], at?: number) => {
        await library.playlists.addTracks(uri, tracks, at);
        await useLibraryStore.getState().refreshPlaylists();
      },
      removeFromPlaylist: async (uri: Uri, positions: number[]) => {
        await library.playlists.removeTracks(uri, positions);
        await useLibraryStore.getState().refreshPlaylists();
      },
      movePlaylistTrack: (uri: Uri, from: number, to: number) => library.playlists.move(uri, from, to),
      playlistsContaining: (trackUri: Uri) => library.playlists.containing(trackUri),

      download: async (track: Track) => {
        const stream = await registry.resolveStream(track);
        await library.offline.download(track, stream);
        await useLibraryStore.getState().refreshOffline();
        void useLibraryStore.getState().refreshStats();
      },
      removeDownload: async (trackUri: Uri) => {
        await library.offline.remove(trackUri);
        await useLibraryStore.getState().refreshOffline();
        void useLibraryStore.getState().refreshStats();
      },

      rescan: () =>
        useLibraryStore.getState().startScan(useSettingsStore.getState().settings.musicFolders),
    }),
    [library, registry],
  );

  return {
    playlists,
    likedUris,
    offlineUris,
    stats,
    scan,
    scanning,
    lastScan,
    scanError,
    toggleLike,
    refresh,
    refreshPlaylists,
    refreshStats,
    cancelScan,
    ...actions,
  };
}

/** Narrow subscription for a single row's heart icon. */
export function useIsLiked(uri: Uri | undefined): boolean {
  return useLibraryStore((s) => (uri ? s.likedUris.has(uri) : false));
}

/** Narrow subscription for a single row's download badge. */
export function useIsOffline(uri: Uri | undefined): boolean {
  return useLibraryStore((s) => (uri ? s.offlineUris.has(uri) : false));
}
