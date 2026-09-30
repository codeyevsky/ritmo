import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';

import type { Rgb } from '@ritmo/core';
import { accentVariables, mix } from '@ritmo/core';

import { ContextMenuHost, ToastHost } from './components';
import {
  useBreakpoint,
  useMediaCommands,
  useScanProgress,
  useSettings,
  useShortcuts,
  useTranslation,
  useWallpaperAccent,
} from './hooks';
import type { TFunction } from './hooks';
import { ErrorBoundary } from './ErrorBoundary';
import type { ErrorBoundaryStrings } from './ErrorBoundary';
import { AppRoutes } from './routes';
import type { RitmoServices } from './services';
import { ServicesProvider, useServices } from './services';
import { CommandPalette } from './shell/CommandPalette';
import { FullScreenPlayer } from './shell/FullScreenPlayer';
import { MobileTabBar } from './shell/MobileTabBar';
import { NowPlayingBar } from './shell/NowPlayingBar';
import { RightPanel } from './shell/RightPanel';
import { ShortcutsDialog } from './shell/ShortcutsDialog';
import { Sidebar } from './shell/Sidebar';
import { TitleBar } from './shell/TitleBar';
import { bindStores, useUiStore } from './store';

/**
 * There is no reachable devtools console in a packaged build, so a crash is
 * written to the same key-value store the app already uses. Read it with
 * `sqlite3 ~/.local/share/ritmo/ritmo.db "SELECT value FROM settings_kv WHERE key='crash:last'"`.
 */
function reportCrash(services: RitmoServices) {
  return (error: Error, info: { componentStack?: string | null }) => {
    const payload = JSON.stringify({
      at: new Date().toISOString(),
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
    void services.host.kv.set('crash:last', payload).catch(() => undefined);
  };
}

export interface RitmoAppProps {
  services: RitmoServices;
}

/** Below this the right panel floats over the content instead of taking a column. */
const PANEL_FLOAT_BELOW = 1100;
const MOBILE_BELOW = 640;
/** Long enough to read as a wash, short enough not to feel laggy. */
const ACCENT_WASH_MS = 520;
/** Matches the `panel-in` / `panel-out` keyframes in the Tailwind config. */
const PANEL_MOTION_MS = 180;

/** The boundary cannot call `t()` itself — see `ErrorBoundary.strings`. */
function boundaryStrings(t: TFunction): ErrorBoundaryStrings {
  return {
    unexpected: t('errors.boundaryUnexpected'),
    title: t('errors.boundaryTitle'),
    body: t('errors.boundaryBody'),
    retry: t('common.retry'),
    copy: t('errors.copyError'),
    reload: t('errors.reloadApp'),
  };
}

export function RitmoApp({ services }: RitmoAppProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <ServicesProvider value={services}>
      <ErrorBoundary
        fullscreen
        label="Ritmo"
        strings={boundaryStrings(t)}
        onError={reportCrash(services)}
      >
        <BrowserRouter>
        <Shell />
        </BrowserRouter>
      </ErrorBoundary>
    </ServicesProvider>
  );
}

function Shell(): JSX.Element {
  const services = useServices();
  const { settings } = useSettings();
  const { t } = useTranslation();
  const { width } = useBreakpoint();
  const location = useLocation();

  const panelOpen = useUiStore((s) => s.panelOpen);
  const fullscreen = useUiStore((s) => s.fullscreen);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen);

  useShortcuts();
  useMediaCommands();
  useScanProgress();

  useEffect(() => {
    return bindStores({
      host: services.host,
      controller: services.controller,
      registry: services.registry,
      library: services.library,
    });
  }, [services]);

  useEffect(() => {
    // The desktop window is created hidden so the user never sees a flash of
    // unstyled, unpainted WebView; it is revealed after the first paint.
    const frame = requestAnimationFrame(() => {
      void services.host.window?.show();
    });
    return () => cancelAnimationFrame(frame);
  }, [services]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', settings.theme);
    root.setAttribute('data-density', settings.density);
    root.setAttribute('lang', settings.language);
  }, [settings.density, settings.language, settings.theme]);

  // 'wallpaper' is the one accent that is not itself a colour: the host reads
  // it off the desktop, and falls back to the default rather than to nothing.
  const fromWallpaper = settings.accent === 'wallpaper';
  const wallpaperAccent = useWallpaperAccent(fromWallpaper);
  const accentHex = fromWallpaper ? wallpaperAccent : settings.accent;
  const accentVars = useMemo(
    () => (accentHex ? accentVariables(accentHex, settings.theme) : undefined),
    [accentHex, settings.theme],
  );

  useAccentWash(accentVars);

  const isMobile = width < MOBILE_BELOW;
  const panelFloats = width < PANEL_FLOAT_BELOW;
  // `present`, not `panelOpen`: the inline panel owns a grid column, so the
  // column has to survive until the exit animation has finished playing.
  const panel = usePanelPresence(panelOpen, PANEL_MOTION_MS);
  const inlinePanel = panel.present && !panelFloats && !isMobile;
  const floatingPanel = panel.present && (panelFloats || isMobile);

  // SearchView pushes the query into the URL as the user types, and
  // SettingsView rewrites its `:section` as the user scrolls; keying the scroll
  // container on the full pathname there would remount the view mid-gesture —
  // stealing focus in search, and resetting the scroll position in settings.
  const routeKey = collapseRouteKey(location.pathname);

  return (
    <>
      <div
        id="ritmo-shell"
        aria-hidden={fullscreen || undefined}
        className={clsx(
          'grid h-[100dvh] w-full max-w-full overflow-hidden bg-bg font-sans text-text antialiased',
          isMobile
            ? 'grid-cols-1 grid-rows-[minmax(0,1fr)_auto_auto]'
            : [
                'grid-rows-[var(--title-h)_minmax(0,1fr)_var(--bar-h)]',
                // `minmax(0,auto)` rather than `auto`: the panel track may shrink
                // below its content instead of widening the shell.
                inlinePanel
                  ? 'grid-cols-[var(--sidebar-w)_minmax(0,1fr)_minmax(0,auto)]'
                  : 'grid-cols-[var(--sidebar-w)_minmax(0,1fr)]',
              ],
        )}
      >
        {isMobile ? null : <TitleBar className="col-span-full" />}
        {isMobile ? null : <Sidebar />}

        <main
          key={routeKey}
          id="ritmo-main"
          className={clsx(
            'scrollbar-thin relative min-w-0 overflow-y-auto overflow-x-hidden',
            !isMobile && 'row-start-2',
          )}
        >
          <ErrorBoundary
            resetKey={location.pathname}
            label={location.pathname}
            strings={boundaryStrings(t)}
          >
            <AppRoutes />
          </ErrorBoundary>
        </main>

        {inlinePanel ? <RightPanel className={panel.motion} /> : null}

        <NowPlayingBar className={clsx('col-span-full', !isMobile && 'row-start-3')} />
        {isMobile ? <MobileTabBar className="col-span-full" /> : null}
      </div>

      {floatingPanel ? (
        <RightPanel
          className={clsx(
            'fixed right-0 z-40 shadow-pop',
            panel.motion,
            isMobile ? 'bottom-0 top-0' : 'bottom-[var(--bar-h)] top-[var(--title-h)]',
          )}
        />
      ) : null}

      <ToastHost />
      <ContextMenuHost />
      <FullScreenPlayer
        open={fullscreen}
        onClose={() => useUiStore.setState({ fullscreen: false })}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => useUiStore.setState({ paletteOpen: false })}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => useUiStore.setState({ shortcutsOpen: false })}
      />
    </>
  );
}

/** Routes whose sub-paths are the *same* screen, so the scroll container keeps
 *  its identity as the parameter changes. */
const COLLAPSED_ROUTES = ['/search', '/settings'];

function collapseRouteKey(pathname: string): string {
  return COLLAPSED_ROUTES.find((route) => pathname.startsWith(route)) ?? pathname;
}

interface PanelPresence {
  /** True while the panel belongs in the tree — its exit included. */
  present: boolean;
  /** Animation utility to apply, or undefined when nothing is in flight. */
  motion: string | undefined;
}

/**
 * Keeps the right panel mounted through its exit animation and reports which
 * animation to run.
 *
 * The state the app launches with is deliberately not animated: a panel that
 * was open when the user quit should already be there on the first paint
 * instead of sliding in over the window reveal. That is what the ref buys —
 * only a *change* of `open` starts an animation.
 */
function usePanelPresence(open: boolean, durationMs: number): PanelPresence {
  const [present, setPresent] = useState(open);
  const [motion, setMotion] = useState<string | undefined>(undefined);
  const previous = useRef(open);

  useEffect(() => {
    if (previous.current === open) return;
    previous.current = open;
    if (open) setPresent(true);
    setMotion(open ? 'animate-panel-in' : 'animate-panel-out');
    const id = window.setTimeout(() => {
      setMotion(undefined);
      if (!open) setPresent(false);
    }, durationMs);
    return () => window.clearTimeout(id);
  }, [open, durationMs]);

  return { present, motion };
}

function parseTriplet(value: string): Rgb | undefined {
  const parts = value.trim().split(/[\s,]+/);
  if (parts.length !== 3) return undefined;
  const [r, g, b] = parts.map(Number);
  if (r === undefined || g === undefined || b === undefined) return undefined;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return undefined;
  return { r, g, b };
}

function formatTriplet(colour: Rgb): string {
  return `${Math.round(colour.r)} ${Math.round(colour.g)} ${Math.round(colour.b)}`;
}

/**
 * Fades the accent custom properties to their new values.
 *
 * A CSS transition cannot do this: the variables hold bare `R G B` triplets fed
 * to `rgb(var(--c-accent) / <alpha>)`, and untyped custom properties are not
 * animatable — so the interpolation is done here, in one rAF loop.
 */
function useAccentWash(vars: Record<string, string> | undefined): void {
  const frameRef = useRef(0);
  const appliedRef = useRef<string[]>([]);

  useEffect(() => {
    const root = document.documentElement;
    if (!vars) {
      // Nothing to derive an accent from: drop the inline overrides so the
      // stylesheet's own accent takes over again.
      for (const name of appliedRef.current) root.style.removeProperty(name);
      appliedRef.current = [];
      return;
    }
    appliedRef.current = Object.keys(vars);
    const computed = getComputedStyle(root);
    const from = new Map<string, Rgb>();
    const to = new Map<string, Rgb>();

    for (const [name, value] of Object.entries(vars)) {
      const target = parseTriplet(value);
      const previous = parseTriplet(computed.getPropertyValue(name));
      if (target && previous) {
        from.set(name, previous);
        to.set(name, target);
      } else {
        // Non-numeric value, or nothing to fade from on first paint.
        root.style.setProperty(name, value);
      }
    }
    if (to.size === 0) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      for (const [name, colour] of to) root.style.setProperty(name, formatTriplet(colour));
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / ACCENT_WASH_MS);
      const eased = 1 - (1 - progress) ** 3;
      for (const [name, target] of to) {
        const previous = from.get(name);
        if (!previous) continue;
        root.style.setProperty(name, formatTriplet(mix(previous, target, eased)));
      }
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [vars]);
}
