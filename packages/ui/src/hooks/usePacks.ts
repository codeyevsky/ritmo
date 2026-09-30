import { useCallback, useEffect, useMemo } from 'react';
import type { Artwork, Pack, Track, Uri } from '@ritmo/core';

import { useServices } from '../services';
import { usePacksStore } from '../store/packs';

export interface PacksApi {
  packs: Pack[];
  loading: boolean;
  /** True only where export/import/publish can work (the desktop app). */
  canPublish: boolean;
  refresh(): Promise<void>;
  create(name: string, opts?: { description?: string; tracks?: Track[] }): Promise<Pack>;
  update(uri: Uri, patch: { name?: string; description?: string; author?: string; artwork?: Artwork }): Promise<void>;
  remove(uri: Uri): Promise<void>;
  addTracks(uri: Uri, tracks: Track[], at?: number): Promise<void>;
  removeAt(uri: Uri, positions: number[]): Promise<void>;
  move(uri: Uri, from: number, to: number): Promise<void>;
  reresolve(uri: Uri): Promise<{ resolved: number; unavailable: number }>;
}

/**
 * Every mutation rejects on failure: they are explicit user actions, so the
 * calling view owns the toast. The list is refreshed after each one, because
 * the sidebar renders from it.
 */
export function usePacks(): PacksApi {
  const { packs: service, host } = useServices();
  const packs = usePacksStore((s) => s.packs);
  const loading = usePacksStore((s) => s.loading);

  const refresh = useCallback(() => usePacksStore.getState().refresh(service), [service]);

  // One load per mount is enough: the store is shared, and every mutation
  // below refreshes it.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const actions = useMemo(
    () => ({
      create: async (name: string, opts?: { description?: string; tracks?: Track[] }) => {
        const created = await service.create(name, opts);
        await usePacksStore.getState().refresh(service);
        return created;
      },
      update: async (
        uri: Uri,
        patch: { name?: string; description?: string; author?: string; artwork?: Artwork },
      ) => {
        await service.update(uri, patch);
        await usePacksStore.getState().refresh(service);
      },
      remove: async (uri: Uri) => {
        await service.remove(uri);
        await usePacksStore.getState().refresh(service);
      },
      addTracks: async (uri: Uri, tracks: Track[], at?: number) => {
        await service.addTracks(uri, tracks, at);
        await usePacksStore.getState().refresh(service);
      },
      removeAt: async (uri: Uri, positions: number[]) => {
        await service.removeAt(uri, positions);
        await usePacksStore.getState().refresh(service);
      },
      move: (uri: Uri, from: number, to: number) => service.move(uri, from, to),
      reresolve: async (uri: Uri) => {
        const report = await service.reresolve(uri);
        await usePacksStore.getState().refresh(service);
        return report;
      },
    }),
    [service],
  );

  return {
    packs,
    loading,
    canPublish: host.packFiles !== undefined,
    refresh,
    ...actions,
  };
}
