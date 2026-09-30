import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { formatDuration, formatReleaseYear } from '@ritmo/core';

import type { TabItem } from '../components';
import { Artwork, Badge, EmptyState, IconButton, LyricsPane, Visualizer } from '../components';
import { useLyrics, useSmoothPosition, useTranslation } from '../hooks';
import { IconClose, IconMusic } from '../icons';
import { entityPath } from '../routes';
import { useServices } from '../services';
import { usePlayerStore, useUiStore } from '../store';
import { QueuePanel } from './QueuePanel';

export type RightPanelTab = 'queue' | 'nowPlaying';

export interface RightPanelProps {
  className?: string;
}

/**
 * Tabs as mono caps with a 2px rule under the active one — the same vocabulary
 * as `.rule-label`, rather than the filled pills of a streaming app.
 */
function PanelTabs({
  items,
  value,
  onChange,
}: {
  items: Array<TabItem<RightPanelTab>>;
  value: RightPanelTab;
  onChange: (id: RightPanelTab) => void;
}): JSX.Element {
  const refs = useRef(new Map<RightPanelTab, HTMLButtonElement>());

  const focusTab = (index: number): void => {
    const target = items[index];
    if (!target) return;
    onChange(target.id);
    refs.current.get(target.id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (items.length === 0) return;
    const found = items.findIndex((item) => item.id === value);
    const from = found < 0 ? 0 : found;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab((from + 1) % items.length);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab((from - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(items.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div role="tablist" onKeyDown={onKeyDown} className="flex min-w-0 flex-1 items-end gap-4">
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) refs.current.set(item.id, el);
              else refs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={clsx(
              'mono relative min-w-0 truncate pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em]',
              'outline-none transition-colors duration-150 ease-swift focus-visible:ring-2 focus-visible:ring-accent',
              selected ? 'text-text' : 'text-text-faint hover:text-text-dim',
            )}
          >
            {item.label}
            {selected ? (
              <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function RightPanel({ className }: RightPanelProps): JSX.Element {
  const { t } = useTranslation();
  const services = useServices();
  const navigate = useNavigate();
  const tab = useUiStore((s) => s.tab);
  const lyricsCue = useUiStore((s) => s.lyricsCue);
  const current = usePlayerStore((s) => s.current);
  const status = usePlayerStore((s) => s.status);
  const positionMs = useSmoothPosition();
  const lyrics = useLyrics(current);
  const hasLyrics = Boolean(lyrics.lines?.length) || Boolean(lyrics.plain?.trim());

  const items = useMemo<Array<TabItem<RightPanelTab>>>(
    () => [
      { id: 'queue', label: t('queue.title') },
      { id: 'nowPlaying', label: t('player.nowPlaying') },
    ],
    [t],
  );

  const activeLabel = items.find((item) => item.id === tab)?.label ?? '';

  // `Y` sets the tab and bumps the cue in one commit, so by the time this runs
  // the lyrics section is mounted and can be scrolled to.
  const lyricsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (lyricsCue === 0) return;
    lyricsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [lyricsCue]);

  const getSpectrum = useCallback(
    (bins: number) => services.engine.getSpectrum?.(bins),
    [services],
  );

  return (
    <aside
      aria-label={t('player.rightPanel')}
      className={clsx(
        'row-start-2 flex w-[min(100vw,var(--panel-w))] min-w-0 max-w-full flex-col overflow-hidden border-l border-line bg-surface',
        className,
      )}
    >
      <div className="flex min-w-0 items-end gap-2 border-b border-line px-3">
        <PanelTabs items={items} value={tab} onChange={(id) => useUiStore.setState({ tab: id })} />
        <IconButton
          icon={IconClose}
          label={t('common.close')}
          size="sm"
          className="mb-1 shrink-0"
          onClick={() => useUiStore.setState({ panelOpen: false })}
        />
      </div>

      <p aria-live="polite" className="sr-only">
        {activeLabel}
      </p>

      <div className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === 'queue' ? <QueuePanel /> : null}

        {tab === 'nowPlaying' ? (
          current ? (
            <div className="flex min-w-0 flex-col gap-4 p-4">
              {/* A hairline matte instead of a dominant-colour bloom. */}
              <div className="mx-auto max-w-full border border-line p-1">
                <Artwork
                  artwork={current.artwork ?? current.album?.artwork}
                  name={current.title}
                  size={300}
                  rounded="none"
                  eager
                  className="max-w-full"
                />
              </div>

              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold tracking-tight text-text">
                  {current.title}
                </h2>
                <p className="min-w-0 truncate text-sm text-text-dim">
                  {current.artists.map((artist, index) => (
                    <span key={`${artist.uri}-${index}`}>
                      {index > 0 ? <span aria-hidden="true">, </span> : null}
                      <Link
                        to={entityPath(artist.uri)}
                        className="rounded-xs outline-none hover:text-text hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {artist.name}
                      </Link>
                    </span>
                  ))}
                </p>
                <p className="mono mt-1 truncate text-[10px] uppercase tracking-[0.12em] text-text-faint">
                  {current.provider}
                </p>
              </div>

              <Visualizer
                getSpectrum={getSpectrum}
                active={status === 'playing'}
                className="h-10 w-full opacity-80"
              />

              <p className="rule-label">{t('player.nowPlaying')}</p>
              <dl className="flex flex-col gap-1.5 text-xs">
                {current.album ? (
                  <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line/40 pb-1.5">
                    <dt className="mono shrink-0 text-[10px] uppercase tracking-[0.12em] text-text-faint">
                      {t('album.title')}
                    </dt>
                    <dd className="min-w-0 truncate text-right text-text-dim">
                      <Link
                        to={entityPath(current.album.uri)}
                        className="rounded-xs outline-none hover:text-text hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {current.album.name}
                      </Link>
                    </dd>
                  </div>
                ) : null}
                {current.releaseDate ? (
                  <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line/40 pb-1.5">
                    <dt className="mono shrink-0 text-[10px] uppercase tracking-[0.12em] text-text-faint">
                      {t('album.year')}
                    </dt>
                    <dd className="mono shrink-0 text-text-dim">
                      {formatReleaseYear(current.releaseDate)}
                    </dd>
                  </div>
                ) : null}
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <dt className="mono shrink-0 text-[10px] uppercase tracking-[0.12em] text-text-faint">
                    {t('player.duration')}
                  </dt>
                  <dd className="mono shrink-0 whitespace-nowrap text-text-dim">
                    {current.isLive || current.durationMs === 0
                      ? t('player.live')
                      : formatDuration(current.durationMs)}
                  </dd>
                </div>
                {current.genres && current.genres.length > 0 ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1">
                    {current.genres.slice(0, 4).map((genre) => (
                      <Badge key={genre}>{genre}</Badge>
                    ))}
                  </div>
                ) : null}
              </dl>

              {/* The pane keeps its own scroller so the synced line can stay
                  centred; a bounded height is what gives it one here. */}
              <section
                ref={lyricsRef}
                aria-labelledby="now-playing-lyrics"
                className="flex min-w-0 flex-col gap-2 border-t border-line pt-3"
              >
                <h3 id="now-playing-lyrics" className="rule-label">
                  <span className="min-w-0 truncate">{t('lyrics.title')}</span>
                </h3>
                <LyricsPane
                  lines={lyrics.lines}
                  plain={lyrics.plain}
                  positionMs={positionMs}
                  loading={lyrics.loading}
                  source={lyrics.source}
                  onSeek={(ms) => void services.controller.seek(ms)}
                  // A definite height only when there is something to scroll;
                  // the not-found state must not leave 60vh of empty panel.
                  className={clsx(
                    (lyrics.loading || hasLyrics) && 'h-[60vh] min-h-[240px]',
                  )}
                />
              </section>
            </div>
          ) : (
            <EmptyState
              icon={IconMusic}
              title={t('player.nothingPlaying')}
              body={t('player.nothingPlayingBody')}
              action={{ label: t('nav.home'), onClick: () => navigate('/') }}
              className="p-6"
            />
          )
        ) : null}
      </div>
    </aside>
  );
}
