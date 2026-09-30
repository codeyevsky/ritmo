import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatBytes } from '@ritmo/core';

import { IconButton } from '../components';
import { useBreakpoint, useSettings, useTranslation } from '../hooks';
import {
  IconBazaar,
  IconHome,
  IconLibrary,
  IconLogo,
  IconPanelLeft,
  IconRadio,
  IconSearch,
  IconSettings,
} from '../icons';
import { useServices } from '../services';
import { useLibraryStore, useUiStore } from '../store';
import { NavItem } from './NavItem';
import type { ShortcutId } from './ShortcutsDialog';
import { SHORTCUTS } from './ShortcutsDialog';
import { SidebarCollections } from './SidebarCollections';

export interface SidebarProps {
  className?: string;
}

const WIDTH_KEY = 'ui.sidebarWidth';
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;
const COLLAPSED_WIDTH = 72;
const KEYBOARD_STEP = 16;
/** Narrower than this and there is no room for labels, collapsed or not. */
const RAIL_BELOW = 820;
/**
 * How long the labels get to fade before the rail layout takes over. Shorter
 * than the 200ms width transition in `globals.css` on purpose: the text has to
 * be gone before the column is, and the icon-rail reflow then lands while the
 * width is all but settled.
 */
const LABEL_FADE_MS = 150;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Only the destinations that actually answer to a chord print one. */
const NAV_SHORTCUT: Record<string, ShortcutId> = {
  '/search': 'focusSearch',
  '/settings': 'settings',
};

function hintFor(path: string): string | undefined {
  const id = NAV_SHORTCUT[path];
  if (id === undefined) return undefined;
  const spec = SHORTCUTS.find((entry) => entry.id === id);
  if (!spec) return undefined;
  // A 240px rail only has room for the shortest accepted chord.
  const chord = [...spec.chords].sort((a, b) => a.length - b.length)[0];
  return chord ? chord.join('+') : undefined;
}

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

export function Sidebar({ className }: SidebarProps): JSX.Element {
  const { t, lang } = useTranslation();
  const services = useServices();
  const navigate = useNavigate();

  const { width: viewportWidth } = useBreakpoint();
  const pinnedCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const collapsed = pinnedCollapsed || viewportWidth < RAIL_BELOW;
  const stats = useLibraryStore((s) => s.stats);
  const { settings } = useSettings();

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const widthRef = useRef(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  /**
   * `collapsed` drives the width at once; `rail` is what the children see, and
   * it lags behind by one label fade. Swapping both in the same frame is what
   * made the collapse snap: the labels vanished from a column that was still
   * 240px wide.
   */
  const [rail, setRail] = useState(collapsed);
  const [labelsHidden, setLabelsHidden] = useState(false);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clampWidth(next);
      widthRef.current = clamped;
      setWidth(clamped);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void services.host.kv.get(WIDTH_KEY).then((raw) => {
      if (!alive || !raw) return;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) commitWidth(parsed);
    });
    return () => {
      alive = false;
    };
  }, [commitWidth, services]);

  // The shell grid's first column is `var(--sidebar-w)`, so the sidebar is the
  // single writer of that variable — collapse and resize both flow through here.
  const widthWrittenFor = useRef(collapsed);
  useEffect(() => {
    const root = document.documentElement;
    // Only the collapse toggle is worth animating. A drag has to stay under the
    // pointer and an arrow-key nudge has to land on the keystroke, so those
    // width edits switch the transition off for the frame that applies them.
    const toggled = widthWrittenFor.current !== collapsed;
    widthWrittenFor.current = collapsed;
    root.setAttribute('data-sidebar-resize', toggled ? 'off' : 'on');
    root.style.setProperty('--sidebar-w', collapsed ? `${COLLAPSED_WIDTH}px` : `${width}px`);
  }, [collapsed, width]);

  // Labels lead, the rail follows. Keyed on `collapsed` alone: the states this
  // effect sets must not re-enter it, or the cleanup would cancel its own
  // pending step.
  const railChoreoFor = useRef(collapsed);
  useEffect(() => {
    if (railChoreoFor.current === collapsed) return;
    railChoreoFor.current = collapsed;

    if (prefersReducedMotion()) {
      setLabelsHidden(false);
      setRail(collapsed);
      return;
    }
    if (collapsed) {
      setLabelsHidden(true);
      const id = window.setTimeout(() => {
        setRail(true);
        setLabelsHidden(false);
      }, LABEL_FADE_MS);
      return () => window.clearTimeout(id);
    }
    // Expanding: the labels mount transparent so they fade up with the column
    // instead of appearing at full strength inside a 72px rail.
    setRail(false);
    setLabelsHidden(true);
    const frame = window.requestAnimationFrame(() => setLabelsHidden(false));
    return () => window.cancelAnimationFrame(frame);
  }, [collapsed]);

  const persist = useCallback(() => {
    void services.host.kv.set(WIDTH_KEY, String(widthRef.current));
  }, [services]);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed || event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      setResizing(true);

      const onMove = (e: PointerEvent) => commitWidth(startWidth + (e.clientX - startX));
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setResizing(false);
        persist();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [collapsed, commitWidth, persist],
  );

  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      commitWidth(widthRef.current + (event.key === 'ArrowRight' ? KEYBOARD_STEP : -KEYBOARD_STEP));
      persist();
    },
    [commitWidth, persist],
  );

  const usedBytes = stats?.localBytes ?? 0;
  const maxCacheBytes = settings.maxCacheBytes;
  const usedRatio = maxCacheBytes > 0 ? Math.min(1, usedBytes / maxCacheBytes) : 0;

  return (
    <nav
      aria-label={t('nav.primary')}
      data-labels={labelsHidden ? 'hidden' : 'shown'}
      className={clsx(
        'sidebar-labels relative row-start-2 flex min-h-0 min-w-0 flex-col gap-1 border-r border-line bg-surface px-2 py-2',
        className,
      )}
    >
      <div className={clsx('flex min-w-0 items-center gap-2', rail ? 'flex-col' : 'px-1')}>
        <button
          type="button"
          onClick={() => navigate('/')}
          aria-label={t('nav.home')}
          className="flex h-9 min-w-0 items-center gap-2 rounded-sm px-1 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconLogo className="h-5 w-5 shrink-0 text-accent" />
          {rail ? null : (
            <span className="mono truncate text-[13px] font-semibold uppercase tracking-[0.18em] text-text">
              Ritmo
            </span>
          )}
        </button>
        {rail ? null : <span className="min-w-0 flex-1" />}
        <IconButton
          icon={IconPanelLeft}
          label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          size="sm"
          active={collapsed}
          disabled={viewportWidth < RAIL_BELOW}
          className="shrink-0"
          onClick={() => useUiStore.setState({ sidebarCollapsed: !pinnedCollapsed })}
        />
      </div>

      {rail ? (
        <hr className="my-2 border-line" />
      ) : (
        <p className="rule-label mt-3 px-2 pb-1.5">{t('nav.primary')}</p>
      )}

      <div className="flex flex-col">
        <NavItem to="/" icon={IconHome} label={t('nav.home')} collapsed={rail} />
        <NavItem
          to="/search"
          icon={IconSearch}
          label={t('nav.search')}
          collapsed={rail}
          hint={hintFor('/search')}
        />
        <NavItem to="/library" icon={IconLibrary} label={t('nav.library')} collapsed={rail} />
        <NavItem to="/radio" icon={IconRadio} label={t('nav.radio')} collapsed={rail} />
        <NavItem to="/bazaar" icon={IconBazaar} label={t('bazaar.title')} collapsed={rail} />
      </div>

      <SidebarCollections collapsed={rail} className="mt-3" />

      <div className="mt-2 border-t border-line pt-2">
        {rail ? null : (
          <div className="px-2 pb-2">
            <div className="flex min-w-0 items-baseline justify-between gap-2 overflow-hidden">
              <span className="mono min-w-0 truncate text-[10px] uppercase tracking-[0.12em] text-text-faint">
                {t('settings.storageUsed')}
              </span>
              <span className="mono shrink-0 whitespace-nowrap text-[10px] text-text-dim">
                {formatBytes(usedBytes, lang)} / {formatBytes(maxCacheBytes, lang)}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={t('settings.storageUsed')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedRatio * 100)}
              className="mt-1.5 h-[3px] overflow-hidden bg-surface-3"
            >
              <div
                className={clsx(
                  'h-full origin-left transition-transform duration-500 ease-swift',
                  usedRatio > 0.9 ? 'bg-warn' : 'bg-accent',
                )}
                style={{ transform: `scaleX(${usedRatio})` }}
              />
            </div>
          </div>
        )}
        <NavItem
          to="/settings"
          icon={IconSettings}
          label={t('nav.settings')}
          collapsed={rail}
          hint={hintFor('/settings')}
        />
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('nav.resizeSidebar')}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={collapsed ? COLLAPSED_WIDTH : width}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
        className={clsx(
          'absolute right-[-3px] top-0 z-10 h-full w-1.5 touch-none outline-none',
          collapsed ? 'pointer-events-none' : 'cursor-col-resize',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-accent after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-100',
          resizing && 'after:opacity-100',
        )}
      />
    </nav>
  );
}
