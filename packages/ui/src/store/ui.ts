import { create } from 'zustand';

export type RightPanelTab = 'queue' | 'nowPlaying';
export type LibraryLayout = 'grid' | 'list';

export interface UiStore {
  tab: RightPanelTab;
  panelOpen: boolean;
  /** Bumped whenever something asks for the lyrics; the panel scrolls to them. */
  lyricsCue: number;
  sidebarCollapsed: boolean;
  fullscreen: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  libraryView: LibraryLayout;
  /** Last visited route per top-level nav entry, so tabs resume where they were. */
  routes: Record<string, string>;

  setTab(tab: RightPanelTab): void;
  setPanelOpen(open: boolean): void;
  /** Opens the panel on `tab`, or closes it when that tab is already showing. */
  togglePanel(tab?: RightPanelTab): void;
  /** Opens Now playing and brings the lyrics, which live inside it, into view. */
  showLyrics(): void;
  setSidebarCollapsed(collapsed: boolean): void;
  toggleSidebar(): void;
  setFullscreen(open: boolean): void;
  toggleFullscreen(): void;
  setPaletteOpen(open: boolean): void;
  setShortcutsOpen(open: boolean): void;
  setLibraryView(view: LibraryLayout): void;
  rememberRoute(key: string, route: string): void;
  routeFor(key: string): string | undefined;
  /** True while a dialog owns the keyboard — `useShortcuts` stands down then. */
  modalOpen(): boolean;
  /** Closes the topmost transient layer. Returns false when there was none. */
  closeTopLayer(): boolean;
}

const STORAGE_KEY = 'ritmo:ui';

interface PersistedUi {
  tab: RightPanelTab;
  panelOpen: boolean;
  sidebarCollapsed: boolean;
  libraryView: LibraryLayout;
  routes: Record<string, string>;
}

function isTab(v: unknown): v is RightPanelTab {
  return v === 'queue' || v === 'nowPlaying';
}

/** Lyrics used to be a tab of its own; installs that were left on it land on
 *  Now playing, which is where the lyrics moved. */
function readTab(v: unknown): RightPanelTab | undefined {
  if (v === 'lyrics') return 'nowPlaying';
  return isTab(v) ? v : undefined;
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

function readPersisted(): Partial<PersistedUi> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const rec = parsed as Record<string, unknown>;
    const out: Partial<PersistedUi> = {};
    const tab = readTab(rec.tab);
    if (tab) out.tab = tab;
    if (typeof rec.panelOpen === 'boolean') out.panelOpen = rec.panelOpen;
    if (typeof rec.sidebarCollapsed === 'boolean') out.sidebarCollapsed = rec.sidebarCollapsed;
    if (rec.libraryView === 'grid' || rec.libraryView === 'list') out.libraryView = rec.libraryView;
    if (isStringMap(rec.routes)) out.routes = rec.routes;
    return out;
  } catch {
    // A corrupt blob must never keep the shell from opening.
    return {};
  }
}

const restored = readPersisted();

export const useUiStore = create<UiStore>((set, get) => ({
  tab: restored.tab ?? 'queue',
  panelOpen: restored.panelOpen ?? false,
  lyricsCue: 0,
  sidebarCollapsed: restored.sidebarCollapsed ?? false,
  // Overlays are deliberately not restored: reopening full screen or the
  // command palette on launch would trap a user who quit from that state.
  fullscreen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  libraryView: restored.libraryView ?? 'grid',
  routes: restored.routes ?? {},

  setTab: (tab) => set({ tab, panelOpen: true }),
  setPanelOpen: (open) => set({ panelOpen: open }),

  togglePanel: (tab) => {
    const state = get();
    if (!tab) {
      set({ panelOpen: !state.panelOpen });
      return;
    }
    if (state.panelOpen && state.tab === tab) set({ panelOpen: false });
    else set({ panelOpen: true, tab });
  },

  showLyrics: () => set((s) => ({ panelOpen: true, tab: 'nowPlaying', lyricsCue: s.lyricsCue + 1 })),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setFullscreen: (open) => set({ fullscreen: open }),
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),

  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setLibraryView: (view) => set({ libraryView: view }),

  rememberRoute: (key, route) => set((s) => ({ routes: { ...s.routes, [key]: route } })),
  routeFor: (key) => get().routes[key],

  modalOpen: () => {
    const s = get();
    return s.paletteOpen || s.shortcutsOpen;
  },

  closeTopLayer: () => {
    const s = get();
    if (s.paletteOpen) {
      set({ paletteOpen: false });
      return true;
    }
    if (s.shortcutsOpen) {
      set({ shortcutsOpen: false });
      return true;
    }
    if (s.fullscreen) {
      set({ fullscreen: false });
      return true;
    }
    if (s.panelOpen) {
      set({ panelOpen: false });
      return true;
    }
    return false;
  },
}));

if (typeof localStorage !== 'undefined') {
  let last = '';
  useUiStore.subscribe((s) => {
    const snapshot: PersistedUi = {
      tab: s.tab,
      panelOpen: s.panelOpen,
      sidebarCollapsed: s.sidebarCollapsed,
      libraryView: s.libraryView,
      routes: s.routes,
    };
    const json = JSON.stringify(snapshot);
    // Overlay toggles fire often and carry nothing persistable; skip the write.
    if (json === last) return;
    last = json;
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      // Private-mode quota failures are not worth surfacing.
    }
  });
}
