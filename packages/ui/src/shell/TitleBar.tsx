import clsx from 'clsx';
import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { IconButton } from '../components';
import { useSettings, useToast, useTranslation } from '../hooks';
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconMaximize,
  IconMinimize,
  IconRestore,
} from '../icons';
import { useServices } from '../services';

export interface TitleBarProps {
  className?: string;
}

const TRAY_HINT_KEY = 'ui.trayHintShown';
/** Long enough to read the tray toast before the window disappears. */
const TRAY_HINT_DELAY_MS = 1800;

/**
 * react-router records its position in the history stack as `idx` on
 * `history.state`; there is no public "can go forward" API, and this is the
 * only way to tell a forward entry from the end of the stack.
 */
function historyIndex(): number {
  const state = window.history.state as { idx?: unknown } | null;
  const idx = state && typeof state.idx === 'number' ? state.idx : 0;
  return idx;
}

export function TitleBar({ className }: TitleBarProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const services = useServices();
  const { settings } = useSettings();
  const { show } = useToast();
  const [fullscreen, setFullscreen] = useState(false);

  const nav = useMemo(() => {
    const idx = historyIndex();
    return { canBack: idx > 0, canForward: idx < window.history.length - 1 };
    // `location.key` changes on every navigation, which is exactly when the
    // history position needs re-reading.
  }, [location.key]);

  const win = services.host.window;

  const onMinimize = useCallback(() => {
    void win?.minimize();
  }, [win]);

  const onToggleMaximize = useCallback(() => {
    if (!win) return;
    const next = !fullscreen;
    setFullscreen(next);
    // `WindowBridge` exposes no maximize/unmaximize pair, so the enlarge
    // control drives real fullscreen instead.
    void win.setFullscreen(next);
  }, [fullscreen, win]);

  const onClose = useCallback(() => {
    if (!win) return;
    void (async () => {
      if (!settings.closeToTray) {
        await win.hide();
        return;
      }
      const seen = await services.host.kv.get(TRAY_HINT_KEY);
      if (seen) {
        await win.hide();
        return;
      }
      await services.host.kv.set(TRAY_HINT_KEY, '1');
      show({
        title: t('player.trayHintTitle'),
        body: t('player.trayHintBody'),
        tone: 'neutral',
        durationMs: 6000,
      });
      if (settings.showDesktopNotifications) {
        void services.host.notifications?.show({
          title: t('player.trayHintTitle'),
          body: t('player.trayHintBody'),
        });
      }
      window.setTimeout(() => {
        void win.hide();
      }, TRAY_HINT_DELAY_MS);
    })();
  }, [services, settings.closeToTray, settings.showDesktopNotifications, show, t, win]);

  return (
    <header
      className={clsx(
        'drag-region z-20 flex h-[var(--title-h)] min-w-0 select-none items-center gap-2 overflow-hidden border-b border-line bg-bg px-2',
        className,
      )}
      // Tauri's own drag affordance is an attribute rather than a class; both
      // are set so the shell drags under Tauri and under a plain browser.
      data-tauri-drag-region
    >
      <div className="no-drag flex shrink-0 items-center gap-1">
        <IconButton
          icon={IconChevronLeft}
          label={t('common.back')}
          size="sm"
          disabled={!nav.canBack}
          onClick={() => navigate(-1)}
        />
        <IconButton
          icon={IconChevronRight}
          label={t('common.forward')}
          size="sm"
          disabled={!nav.canForward}
          onClick={() => navigate(1)}
        />
      </div>

      {/* A hairline, not a gap, marks where the history controls end. */}
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line" />

      {/* The centre is intentionally empty draggable space: search lives in SearchView. */}
      <div className="drag-region h-full min-w-0 flex-1" data-tauri-drag-region />

      {win ? (
        <div className="no-drag flex shrink-0 items-center gap-0.5">
          <IconButton
            icon={IconMinimize}
            label={t('common.minimize')}
            size="sm"
            onClick={onMinimize}
          />
          <IconButton
            icon={fullscreen ? IconRestore : IconMaximize}
            label={fullscreen ? t('common.restore') : t('common.maximize')}
            size="sm"
            active={fullscreen}
            onClick={onToggleMaximize}
          />
          <IconButton
            icon={IconClose}
            label={t('common.close')}
            size="sm"
            onClick={onClose}
            className="hover:bg-danger hover:text-text"
          />
        </div>
      ) : null}
    </header>
  );
}
