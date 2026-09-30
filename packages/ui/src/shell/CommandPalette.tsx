import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { RepeatMode, Track } from '@ritmo/core';
import { normalizeKey, similarity, unifiedSearch } from '@ritmo/core';

import { ErrorBanner, Input, Skeleton } from '../components';
import { useSettings, useTranslation } from '../hooks';
import {
  IconHeart,
  IconHome,
  IconLibrary,
  IconMusic,
  IconQueue,
  IconRadio,
  IconRepeat,
  IconSearch,
  IconSettings,
  IconShuffle,
} from '../icons';
import { entityPath, searchPath } from '../routes';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

type IconComponent = React.ComponentType<{ className?: string }>;

interface PaletteAction {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: IconComponent;
  run: () => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const TRACK_LIMIT = 8;
const STATIC_LIMIT_PER_GROUP = 6;
const MIN_SCORE = 0.32;
const THEMES = ['dark', 'light', 'oled'] as const;
const REPEAT_CYCLE: RepeatMode[] = ['off', 'all', 'one'];

function score(query: string, label: string): number {
  if (!query) return 1;
  const haystack = normalizeKey(label);
  const needle = normalizeKey(query);
  if (haystack.startsWith(needle)) return 1;
  if (haystack.includes(needle)) return 0.85;
  return similarity(needle, haystack);
}

export function CommandPalette({ open, onClose }: CommandPaletteProps): JSX.Element | null {
  const { t } = useTranslation();
  const services = useServices();
  const navigate = useNavigate();
  const { settings, patch } = useSettings();

  const playlists = useLibraryStore((s) => s.playlists);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);

  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [retryToken, setRetryToken] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setTracks([]);
    setFailed(false);
    setHighlight(0);
    // Autofocus has to wait for the overlay to exist in the DOM.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setTracks([]);
      setSearching(false);
      setFailed(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void unifiedSearch(services.registry, trimmed, { limit: TRACK_LIMIT, kinds: ['track'] })
        .then((results) => {
          if (!alive) return;
          setTracks(results.tracks.slice(0, TRACK_LIMIT));
          setFailed(false);
        })
        .catch(() => {
          if (alive) setFailed(true);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, query, retryToken, services]);

  const staticActions = useMemo<PaletteAction[]>(() => {
    const navGroup = t('common.navigate');
    const settingsGroup = t('settings.title');
    const playlistGroup = t('nav.playlists');
    const go = (path: string) => () => navigate(path);

    const items: PaletteAction[] = [
      { id: 'nav-home', group: navGroup, label: t('nav.home'), icon: IconHome, run: go('/') },
      { id: 'nav-search', group: navGroup, label: t('nav.search'), icon: IconSearch, run: go(searchPath('')) },
      { id: 'nav-library', group: navGroup, label: t('nav.library'), icon: IconLibrary, run: go('/library') },
      { id: 'nav-radio', group: navGroup, label: t('nav.radio'), icon: IconRadio, run: go('/radio') },
      { id: 'nav-liked', group: navGroup, label: t('nav.liked'), icon: IconHeart, run: go('/liked') },
      { id: 'nav-queue', group: navGroup, label: t('queue.title'), icon: IconQueue, run: go('/queue') },
      { id: 'nav-settings', group: navGroup, label: t('nav.settings'), icon: IconSettings, run: go('/settings') },
    ];

    for (const playlist of playlists) {
      items.push({
        id: `playlist-${playlist.uri}`,
        group: playlistGroup,
        label: playlist.name,
        icon: IconMusic,
        run: () => navigate(entityPath(playlist.uri)),
      });
    }

    const themeIndex = THEMES.indexOf(settings.theme);
    const nextTheme = THEMES[(themeIndex + 1) % THEMES.length] ?? 'dark';
    const nextThemeLabel =
      nextTheme === 'dark'
        ? t('settings.themeDark')
        : nextTheme === 'light'
          ? t('settings.themeLight')
          : t('settings.themeOled');
    items.push(
      {
        id: 'set-theme',
        group: settingsGroup,
        label: t('settings.theme'),
        hint: nextThemeLabel,
        icon: IconSettings,
        run: () => patch({ theme: nextTheme }),
      },
      {
        id: 'set-shuffle',
        group: settingsGroup,
        label: t('player.shuffle'),
        hint: shuffle ? t('common.on') : t('common.off'),
        icon: IconShuffle,
        run: () => void services.controller.setShuffle(!shuffle),
      },
      {
        id: 'set-repeat',
        group: settingsGroup,
        label: t('player.repeat'),
        hint:
          repeat === 'one' ? t('player.repeatOne') : repeat === 'all' ? t('player.repeatAll') : t('common.off'),
        icon: IconRepeat,
        run: () => {
          const index = REPEAT_CYCLE.indexOf(repeat);
          void services.controller.setRepeat(REPEAT_CYCLE[(index + 1) % REPEAT_CYCLE.length] ?? 'off');
        },
      },
      {
        id: 'set-crossfade',
        group: settingsGroup,
        label: t('settings.crossfade'),
        hint: settings.crossfadeMs > 0 ? t('common.on') : t('common.off'),
        icon: IconSettings,
        run: () => patch({ crossfadeMs: settings.crossfadeMs > 0 ? 0 : 5000 }),
      },
      {
        id: 'set-offline',
        group: settingsGroup,
        label: t('settings.offlineMode'),
        hint: settings.offlineMode ? t('common.on') : t('common.off'),
        icon: IconSettings,
        run: () => patch({ offlineMode: !settings.offlineMode }),
      },
    );

    return items;
  }, [navigate, patch, playlists, repeat, services, settings, shuffle, t]);

  const actions = useMemo<PaletteAction[]>(() => {
    const trimmed = query.trim();
    const perGroup = new Map<string, PaletteAction[]>();
    const scored = staticActions
      .map((action) => ({ action, s: score(trimmed, action.label) }))
      .filter((entry) => !trimmed || entry.s >= MIN_SCORE)
      .sort((a, b) => b.s - a.s);

    for (const { action } of scored) {
      const bucket = perGroup.get(action.group) ?? [];
      if (bucket.length >= STATIC_LIMIT_PER_GROUP) continue;
      bucket.push(action);
      perGroup.set(action.group, bucket);
    }

    // Groups keep the declaration order of `staticActions` so the list does not
    // reshuffle wholesale between keystrokes.
    const ordered: PaletteAction[] = [];
    const seen = new Set<string>();
    for (const action of staticActions) {
      if (seen.has(action.group)) continue;
      seen.add(action.group);
      ordered.push(...(perGroup.get(action.group) ?? []));
    }

    const trackGroup = t('search.tracks');
    for (const track of tracks) {
      ordered.push({
        id: `track-${track.uri}`,
        group: trackGroup,
        label: track.title,
        hint: track.artists.map((a) => a.name).join(', '),
        icon: IconMusic,
        run: () => void services.controller.playTrack(track, 'user'),
      });
    }
    return ordered;
  }, [query, services, staticActions, t, tracks]);

  useEffect(() => {
    setHighlight((current) => (current >= actions.length ? 0 : current));
  }, [actions.length]);

  useEffect(() => {
    optionRefs.current.get(highlight)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const runAt = useCallback(
    (index: number) => {
      const action = actions[index];
      if (!action) return;
      action.run();
      onClose();
    },
    [actions, onClose],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((i) => (actions.length === 0 ? 0 : (i + 1) % actions.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((i) => (actions.length === 0 ? 0 : (i - 1 + actions.length) % actions.length));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        runAt(highlight);
      }
    },
    [actions.length, highlight, onClose, runAt],
  );

  if (!open) return null;

  let lastGroup = '';

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-start justify-center bg-bg/70 p-4 pt-[12vh] backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('common.commandPalette')}
        className="flex max-h-[68vh] w-full max-w-[640px] animate-slide-up flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-pop"
        onKeyDown={onKeyDown}
      >
        <div className="border-b border-line/60 p-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={t('common.commandPalettePlaceholder')}
            aria-label={t('common.commandPalette')}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={actions[highlight] ? `palette-option-${highlight}` : undefined}
            autoComplete="off"
            size="lg"
            leading={IconSearch}
            clearable
            onClear={() => setQuery('')}
          />
        </div>

        {failed ? (
          <ErrorBanner
            title={t('errors.searchFailed')}
            tone="warn"
            onRetry={() => {
              setFailed(false);
              setRetryToken((n) => n + 1);
            }}
            className="m-2"
          />
        ) : null}

        <ul
          id="palette-list"
          role="listbox"
          aria-label={t('common.commandPalette')}
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2"
        >
          {actions.map((action, index) => {
            const header = action.group !== lastGroup ? action.group : null;
            lastGroup = action.group;
            const Glyph = action.icon;
            const active = index === highlight;
            return (
              <li key={action.id}>
                {header ? (
                  <p
                    className={clsx(
                      'px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint',
                      index === 0 ? 'pt-1' : 'pt-3',
                    )}
                  >
                    {header}
                  </p>
                ) : null}
                <div
                  id={`palette-option-${index}`}
                  role="option"
                  aria-selected={active}
                  ref={(el) => {
                    if (el) optionRefs.current.set(index, el);
                    else optionRefs.current.delete(index);
                  }}
                  onPointerMove={() => setHighlight(index)}
                  onClick={() => runAt(index)}
                  className={clsx(
                    'flex h-10 cursor-pointer items-center gap-3 rounded-md px-2 text-sm',
                    active ? 'bg-surface-3 text-text' : 'text-text-dim',
                  )}
                >
                  {Glyph ? <Glyph className="h-4 w-4 shrink-0" /> : null}
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                  {action.hint ? (
                    <span className="shrink-0 truncate text-xs text-text-faint">{action.hint}</span>
                  ) : null}
                </div>
              </li>
            );
          })}

          {searching ? (
            <li className="flex flex-col gap-2 p-2" aria-live="polite" aria-label={t('common.loading')}>
              <Skeleton className="h-10 w-full" rounded="md" />
              <Skeleton className="h-10 w-full" rounded="md" />
            </li>
          ) : null}

          {!searching && actions.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-text-faint">
              {t('search.noResults')}
            </li>
          ) : null}
        </ul>

        <div className="flex items-center gap-4 border-t border-line/60 px-3 py-2 text-[11px] text-text-faint">
          <span>↑ ↓ {t('common.navigate')}</span>
          <span>↵ {t('common.select')}</span>
          <span>Esc {t('common.close')}</span>
        </div>
      </div>
    </div>
  );
}
