import { create } from 'zustand';
import type { Pack, Packs } from '@ritmo/core';

/**
 * The sidebar's pack list.
 *
 * Deliberately not wired through `bindStores`: every caller already holds the
 * `Packs` service from the services context, so passing it in keeps this store
 * free of a binding lifecycle it does not need.
 */
export interface PacksStore {
  packs: Pack[];
  loading: boolean;
  refresh(service: Packs): Promise<void>;
}

export const usePacksStore = create<PacksStore>((set) => ({
  packs: [],
  loading: false,

  refresh: async (service) => {
    set({ loading: true });
    try {
      set({ packs: await service.list(), loading: false });
    } catch (e) {
      // `host.db` can be missing entirely (the web host has no database), and
      // an empty sidebar section is the right answer to that.
      console.warn('packs could not be listed', e);
      set({ loading: false });
    }
  },
}));
