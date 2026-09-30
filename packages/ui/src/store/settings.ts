import { create } from 'zustand';
import {
  accentVariables,
  debounce,
  defaultSettings,
  EQ_PRESETS,
} from '@ritmo/core';
import type {
  EqualizerSettings,
  HostBridge,
  PlaybackController,
  ProviderRegistry,
  Settings,
} from '@ritmo/core';

export interface SettingsBindings {
  host: HostBridge;
  controller: PlaybackController;
  registry: ProviderRegistry;
}

export interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  load(host: HostBridge): Promise<void>;
  /** Optimistic: state and the document update now, the disk write is debounced. */
  patch(p: Partial<Settings>): void;
  patchEqualizer(p: Partial<EqualizerSettings>): void;
  /** Applies a named preset from `EQ_PRESETS`; unknown names are ignored. */
  applyEqPreset(preset: string): void;
  reset(): Promise<void>;
  /** Installed once at bootstrap so patches reach the host and the controller. */
  bind(deps: SettingsBindings): void;
}

/** Fields whose change has to reach the audio path immediately. */
const PLAYBACK_KEYS = [
  'crossfadeMs',
  'gapless',
  'normalizeVolume',
  'preampDb',
  'equalizer',
  'skipShorterThanMs',
  'monoDownmix',
] as const satisfies ReadonlyArray<keyof Settings>;

/** Fields the provider layer reads. */
const PROVIDER_KEYS = [
  'enabledProviders',
  'offlineMode',
  'preferredQuality',
  'musicFolders',
  'cacheDir',
  'maxCacheBytes',
  'lastfm',
] as const satisfies ReadonlyArray<keyof Settings>;

const APPEARANCE_KEYS = ['theme', 'accent', 'density', 'language'] as const satisfies ReadonlyArray<keyof Settings>;

let bindings: SettingsBindings | undefined;
let loading: Promise<void> | undefined;
/** Custom properties currently written onto <html>, so a switch back to
 *  'wallpaper' can take them off again instead of leaving a stale accent. */
let appliedAccentVars: string[] = [];

const persist = debounce((settings: Settings) => {
  void bindings?.host.saveSettings(settings).catch((e) => {
    console.warn('settings could not be saved', e);
  });
}, 400);

function root(): HTMLElement | undefined {
  return typeof document === 'undefined' ? undefined : document.documentElement;
}

function applyAppearance(settings: Settings): void {
  const el = root();
  if (!el) return;

  el.setAttribute('data-theme', settings.theme);
  el.setAttribute('data-density', settings.density);
  el.lang = settings.language;

  for (const name of appliedAccentVars) el.style.removeProperty(name);
  appliedAccentVars = [];

  // 'wallpaper' is not a colour: RitmoApp resolves it from the host and paints
  // the result itself, so there is nothing to write here.
  if (settings.accent === 'wallpaper') return;

  const vars = accentVariables(settings.accent, settings.theme);
  for (const [name, value] of Object.entries(vars)) {
    el.style.setProperty(name, value);
    appliedAccentVars.push(name);
  }
}

function changed<K extends keyof Settings>(keys: readonly K[], patch: Partial<Settings>): boolean {
  return keys.some((k) => k in patch);
}

function pushSideEffects(next: Settings, patch: Partial<Settings>): void {
  applyAppearance(next);
  if (!bindings) return;
  if (changed(PLAYBACK_KEYS, patch)) {
    void bindings.controller.applySettings(next).catch((e) => console.warn('applySettings:', e));
  }
  if (changed(PROVIDER_KEYS, patch)) {
    void bindings.registry.updateSettings(next).catch((e) => console.warn('updateSettings:', e));
  }
  persist(next);
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: defaultSettings(),
  loaded: false,

  load: (host) => {
    if (get().loaded) return Promise.resolve();
    // Several surfaces mount at once and each wants settings; one read wins.
    if (loading) return loading;

    const pending = host
      .getSettings()
      .then((settings) => {
        // Merging over the defaults keeps a settings file written by an older
        // build from leaving new fields undefined.
        const merged: Settings = { ...defaultSettings(), ...settings };
        set({ settings: merged, loaded: true });
        applyAppearance(merged);
      })
      .catch((e: unknown) => {
        console.warn('settings could not be read, using defaults', e);
        const fallback = defaultSettings();
        set({ settings: fallback, loaded: true });
        applyAppearance(fallback);
      })
      .finally(() => {
        loading = undefined;
      });
    loading = pending;
    return pending;
  },

  patch: (p) => {
    const next: Settings = { ...get().settings, ...p };
    set({ settings: next });
    pushSideEffects(next, p);
  },

  patchEqualizer: (p) => {
    const eq: EqualizerSettings = { ...get().settings.equalizer, ...p };
    get().patch({ equalizer: eq });
  },

  applyEqPreset: (preset) => {
    const gains = EQ_PRESETS[preset];
    if (!gains) return;
    get().patchEqualizer({ preset, gains: [...gains] });
  },

  reset: async () => {
    const next = defaultSettings();
    set({ settings: next, loaded: true });
    applyAppearance(next);
    persist.cancel();
    if (!bindings) return;
    await bindings.host.saveSettings(next).catch((e) => console.warn('settings reset:', e));
    await bindings.controller.applySettings(next).catch((e) => console.warn('applySettings:', e));
    await bindings.registry.updateSettings(next).catch((e) => console.warn('updateSettings:', e));
  },

  bind: (deps) => {
    bindings = deps;
    applyAppearance(get().settings);
  },
}));

/** Releases the bootstrap bindings; used by the shell on teardown. */
export function unbindSettingsStore(): void {
  persist.flush();
  bindings = undefined;
}
