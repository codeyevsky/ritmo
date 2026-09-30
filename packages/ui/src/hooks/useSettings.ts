import { useEffect, useMemo, useRef } from 'react';
import type { EqualizerSettings, Settings } from '@ritmo/core';

import { useServices } from '../services';
import { useSettingsStore } from '../store/settings';

export interface SettingsApi {
  settings: Settings;
  loaded: boolean;
  patch(p: Partial<Settings>): void;
  patchEqualizer(p: Partial<EqualizerSettings>): void;
  applyEqPreset(preset: string): void;
  reset(): Promise<void>;
  /** Opens the native picker and appends the chosen folder. */
  addMusicFolder(): Promise<string | undefined>;
  removeMusicFolder(path: string): void;
}

export function useSettings(): SettingsApi {
  const { host } = useServices();
  const settings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const patch = useSettingsStore((s) => s.patch);
  const patchEqualizer = useSettingsStore((s) => s.patchEqualizer);
  const applyEqPreset = useSettingsStore((s) => s.applyEqPreset);
  const reset = useSettingsStore((s) => s.reset);
  const load = useSettingsStore((s) => s.load);

  // Self-bootstrapping: whichever surface asks for settings first triggers the
  // single read, so a view is never rendered against defaults by accident.
  useEffect(() => {
    void load(host);
  }, [host, load]);

  const folders = settings.musicFolders;
  const watch = settings.watchFolders;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  // Paths may contain anything, so the joined form is only a change signal —
  // the watcher is always handed the real array.
  const foldersKey = folders.join('|');

  // Keeps the filesystem watcher in step with the folder list; the composition
  // root only sets it up once, at boot.
  useEffect(() => {
    const local = host.localLibrary;
    if (!local) return;
    const list = foldersRef.current;
    void local.setWatching(watch && list.length > 0, list).catch(() => {});
  }, [host, watch, foldersKey]);

  const actions = useMemo(
    () => ({
      addMusicFolder: async (): Promise<string | undefined> => {
        const picked = await host.files.pickFolder();
        if (!picked) return undefined;
        const current = useSettingsStore.getState().settings.musicFolders;
        if (current.includes(picked)) return picked;
        useSettingsStore.getState().patch({ musicFolders: [...current, picked] });
        return picked;
      },
      removeMusicFolder: (path: string): void => {
        const current = useSettingsStore.getState().settings.musicFolders;
        useSettingsStore.getState().patch({ musicFolders: current.filter((f) => f !== path) });
      },
    }),
    [host],
  );

  return { settings, loaded, patch, patchEqualizer, applyEqPreset, reset, ...actions };
}
