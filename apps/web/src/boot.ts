/**
 * Composition root.
 *
 * Nothing else in the app constructs a service — it all happens here, once, in
 * dependency order, and the result is handed to `<RitmoApp>` as a plain object.
 * That is what lets `packages/core` and `packages/ui` stay free of any
 * platform branching: the only code that knows which host it is running on is
 * `detectHost`, and it runs here.
 */

import {
  Bazaar,
  Library,
  MetadataService,
  Packs,
  PlaybackController,
  ProviderRegistry,
  QueueEngine,
  createAudioEngine,
  defaultSettings,
  detectHost,
  type HostBridge,
  type Settings,
} from '@ritmo/core';
import type { RitmoServices } from '@ritmo/ui';

export interface BootProgress {
  (step: string): void;
}

export async function boot(onStep: BootProgress = () => {}): Promise<RitmoServices> {
  onStep('host');
  const host: HostBridge = await detectHost();

  // The window is created hidden so the user never sees an unstyled flash, but
  // it used to stay hidden until every service was ready, which meant nothing at
  // all on screen for the better part of a second. The boot screen has already
  // painted by here, so reveal it now and let the rest finish behind it.
  void host.window?.show().catch(() => undefined);

  onStep('settings');
  // A corrupt or partial settings file must not stop the app from opening, so a
  // failure here degrades to defaults rather than rejecting.
  let settings: Settings;
  try {
    settings = await host.getSettings();
  } catch (e) {
    console.warn('settings could not be read, using defaults', e);
    settings = defaultSettings();
  }

  onStep('library');
  const library = new Library(host, (e) => console.warn('library:', e));
  // Pruning expired cache rows and running PRAGMA optimize is housekeeping; it
  // has no bearing on the first frame, so it must not delay it.
  void library.init().catch((e) => console.warn('library maintenance:', e));

  // The registry and the audio engine are independent of each other, and the
  // engine's `init` can take a moment (it opens an output device), so they are
  // started together.
  onStep('providers');
  const [registry, engine] = await Promise.all([
    (async () => {
      const r = new ProviderRegistry(host, settings);
      // Returns as soon as the providers exist; their network warm-up is
      // awaited by the registry itself at the point of use.
      await r.init();
      return r;
    })(),
    createAudioEngine(host),
  ]);

  // Packs need the registry (they resolve entries against it) and the
  // library's repo (the local-library step, and the track snapshots).
  const packs = new Packs(host, library.repo, registry);
  packs.onError = (e) => console.warn('packs:', e);
  const bazaar = new Bazaar(host, packs);
  bazaar.onError = (e) => console.warn('bazaar:', e);

  onStep('player');
  const queue = new QueueEngine();
  const metadata = new MetadataService(host);

  const controller = new PlaybackController({
    engine,
    queue,
    registry,
    host,
    library,
    settings,
  });
  await controller.init();

  // Housekeeping that must not delay first paint.
  void library.offline.pruneTo(settings.maxCacheBytes).catch(() => {});
  if (settings.watchFolders && settings.musicFolders.length > 0) {
    void host.localLibrary
      ?.setWatching(true, settings.musicFolders)
      .catch((e) => console.warn('watcher:', e));
  }

  installCrashReporting(host);
  lockViewportScale();
  recordViewport(host);

  return { host, engine, registry, library, packs, bazaar, controller, metadata, settings };
}

/**
 * A packaged Tauri build has no reachable devtools console, so anything that
 * escapes React's error boundaries would otherwise vanish. Both handlers write
 * to the key-value store the app already owns; read it with
 * `sqlite3 ~/.local/share/ritmo/ritmo.db "SELECT value FROM settings_kv WHERE key LIKE 'crash:%'"`.
 */
function installCrashReporting(host: HostBridge): void {
  if (typeof window === 'undefined') return;

  const record = (key: string, detail: Record<string, unknown>): void => {
    console.error(`ritmo: ${key}`, detail);
    void host.kv
      .set(key, JSON.stringify({ at: new Date().toISOString(), ...detail }))
      .catch(() => undefined);
  };

  window.addEventListener('error', (e) => {
    record('crash:error', {
      message: e.message,
      source: `${e.filename}:${e.lineno}:${e.colno}`,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason;
    record('crash:rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

/**
 * WebKitGTK honours Ctrl+wheel and Ctrl+plus/minus as page zoom. In a browser
 * that is a feature; in an application window it silently rescales the whole
 * layout, which is why content stopped fitting the screen. The window is
 * resizable — only the zoom level is pinned.
 */
function lockViewportScale(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    },
    { passive: false, capture: true },
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      // `=` and `-` carry the unshifted zoom keys on most layouts; the numpad
      // reports 'Add'/'Subtract' through e.key as '+' and '-' as well.
      if (['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
    },
    { capture: true },
  );

  // Pinch-zoom on a touchpad arrives as a gesture event in WebKit.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    window.addEventListener(type, (e) => e.preventDefault(), { passive: false, capture: true });
  }
}

/**
 * Page zoom is invisible from the outside — the layout simply stops fitting.
 * Recording the viewport makes it checkable without a debugger:
 *   sqlite3 ~/.local/share/ritmo/ritmo.db \
 *     "SELECT value FROM settings_kv WHERE key='diag:viewport'"
 * `zoom` is 1 at 100 %; anything else means the view is scaled.
 */
function recordViewport(host: HostBridge): void {
  if (typeof window === 'undefined') return;
  const write = (): void => {
    void host.kv
      .set(
        'diag:viewport',
        JSON.stringify({
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          screenWidth: window.screen?.width,
          screenHeight: window.screen?.height,
          devicePixelRatio: window.devicePixelRatio,
          zoom:
            window.innerWidth > 0
              ? Math.round((window.outerWidth / window.innerWidth) * 1000) / 1000
              : null,
          at: new Date().toISOString(),
        }),
      )
      .catch(() => undefined);
  };
  // The window is created hidden, so at boot there is no layout: both measures
  // read 0 and revealing the window at its existing size emits no `resize`.
  // WebKitGTK also does not always settle both numbers at the same time, so the
  // first non-zero of either wins and the poll gives up rather than spinning.
  const measured = (): boolean =>
    document.documentElement.clientWidth > 0 || window.innerWidth > 0;

  if (measured()) {
    write();
  } else {
    let tries = 0;
    const poll = window.setInterval(() => {
      tries += 1;
      if (measured()) {
        write();
        window.clearInterval(poll);
      } else if (tries > 40) {
        window.clearInterval(poll);
      }
    }, 250);
  }

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (measured()) write();
    });
    ro.observe(document.documentElement);
  } else {
    window.addEventListener('resize', write, { passive: true });
  }
}
