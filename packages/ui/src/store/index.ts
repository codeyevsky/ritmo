import type { HostBridge, Library, PlaybackController, ProviderRegistry } from '@ritmo/core';

import { bindPlayerStore } from './player';
import { unbindSettingsStore, useSettingsStore } from './settings';
import { useLibraryStore } from './library';
import { useSearchStore } from './search';
import { unbindShelvesStore, useShelvesStore } from './shelves';

export { usePlayerStore, bindPlayerStore } from './player';
export type { PlayerStore } from './player';

export { useSettingsStore, unbindSettingsStore } from './settings';
export type { SettingsStore, SettingsBindings } from './settings';

export { useLibraryStore } from './library';
export type { LibraryStore, LibraryBindings } from './library';

export { useUiStore } from './ui';
export type { UiStore, RightPanelTab, LibraryLayout } from './ui';

export { usePacksStore } from './packs';
export type { PacksStore } from './packs';

export { useSearchStore } from './search';
export type { SearchStore, SearchStatus, SearchFilter } from './search';

export { useShelvesStore, unbindShelvesStore } from './shelves';
export type { ShelvesStore, ShelvesStatus } from './shelves';

export interface StoreBindings {
  host: HostBridge;
  controller: PlaybackController;
  registry: ProviderRegistry;
  library: Library;
}

/**
 * Wires every store to the services, once, from the shell. Returns a teardown
 * so hot-reload and tests do not accumulate duplicate controller subscriptions.
 */
export function bindStores(deps: StoreBindings): () => void {
  const unbindPlayer = bindPlayerStore(deps.controller);
  useSettingsStore.getState().bind(deps);
  void useSettingsStore.getState().load(deps.host);
  const unbindLibrary = useLibraryStore.getState().bind({ host: deps.host, library: deps.library });
  useSearchStore.getState().bind(deps.host);
  useShelvesStore.getState().bind(deps.host);

  return () => {
    unbindPlayer();
    unbindLibrary();
    unbindSettingsStore();
    unbindShelvesStore();
  };
}
