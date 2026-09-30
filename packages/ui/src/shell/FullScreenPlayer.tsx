import clsx from 'clsx';

import { viewportSize } from '../hooks/viewport';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RepeatMode } from '@ritmo/core';
import { formatDuration, formatReleaseYear } from '@ritmo/core';

import {
  Artwork,
  Button,
  EmptyState,
  IconButton,
  LikeButton,
  LyricsPane,
  PlayButton,
  SeekBar,
  Visualizer,
} from '../components';
import { useIsLiked, useLyrics, useSmoothPosition, useTranslation } from '../hooks';
import {
  IconChevronDown,
  IconLyrics,
  IconMusic,
  IconNext,
  IconPrevious,
  IconRepeat,
  IconRepeatOne,
  IconShuffle,
} from '../icons';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';

export interface FullScreenPlayerProps {
  open: boolean;
  onClose: () => void;
}

const REPEAT_CYCLE: RepeatMode[] = ['off', 'all', 'one'];
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function nextRepeat(mode: RepeatMode): RepeatMode {
  const index = REPEAT_CYCLE.indexOf(mode);
  return REPEAT_CYCLE[(index + 1) % REPEAT_CYCLE.length] ?? 'off';
}

export function FullScreenPlayer({ open, onClose }: FullScreenPlayerProps): JSX.Element | null {
  const { t } = useTranslation();
  const services = useServices();

  const current = usePlayerStore((s) => s.current);
  const status = usePlayerStore((s) => s.status);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const bufferedMs = usePlayerStore((s) => s.bufferedMs);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);

  const positionMs = useSmoothPosition();
  const liked = useIsLiked(current?.uri);
  const lyrics = useLyrics(current);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [showLyrics, setShowLyrics] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    ...viewportSize(),
  }));

  useEffect(() => {
    if (!open) return;
    const onResize = () => setViewport(viewportSize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    containerRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  const getSpectrum = useCallback(
    (bins: number) => services.engine.getSpectrum?.(bins),
    [services],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === root,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  if (!current) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('player.fullScreen')}
        className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-bg p-6"
      >
        <EmptyState
          icon={IconMusic}
          title={t('player.nothingPlaying')}
          body={t('player.nothingPlayingBody')}
          action={{ label: t('common.close'), onClick: onClose }}
        />
      </div>
    );
  }

  const wide = viewport.width >= 1024;
  const artSize = Math.round(Math.min(viewport.height * 0.38, wide ? 400 : viewport.width - 96));
  const seekable = durationMs > 0 && !current.isLive;
  const hasLyrics = Boolean(lyrics.lines?.length) || Boolean(lyrics.plain);
  const live = Boolean(current.isLive) || durationMs <= 0;

  // Source, year and length in one machine-readable line — the metadata a
  // desktop player prints, in place of an artwork-derived colour wash.
  const metaLine = [
    current.provider,
    current.releaseDate ? formatReleaseYear(current.releaseDate) : undefined,
    live ? t('common.live') : formatDuration(durationMs),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('player.fullScreen')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex animate-fade-in flex-col overflow-hidden bg-bg outline-none"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <IconButton icon={IconChevronDown} label={t('player.closeFullScreen')} onClick={onClose} />
        <p className="rule-label min-w-0 flex-1">
          <span className="min-w-0 truncate">{t('player.nowPlaying')}</span>
        </p>
        {hasLyrics && !wide ? (
          <IconButton
            icon={IconLyrics}
            label={t('lyrics.title')}
            active={showLyrics}
            onClick={() => setShowLyrics((v) => !v)}
          />
        ) : (
          <span className="h-9 w-9 shrink-0" />
        )}
      </header>

      <div
        className={clsx(
          'flex min-h-0 flex-1 items-center gap-10 overflow-hidden px-8 py-6',
          wide && hasLyrics ? 'justify-between' : 'justify-start',
        )}
      >
        {!showLyrics || wide ? (
          // Left-anchored: art then metadata, never a centred stack.
          <div
            className={clsx(
              'flex min-w-0 gap-8',
              wide ? 'items-center' : 'w-full flex-col items-start',
            )}
          >
            <div className="shrink-0 border border-line p-1">
              <Artwork
                artwork={current.artwork ?? current.album?.artwork}
                name={current.title}
                size={artSize}
                rounded="none"
                eager
                className="max-w-full"
              />
            </div>
            <div className="min-w-0 max-w-[560px]">
              <h1 className="truncate text-4xl font-semibold tracking-tight text-text">
                {current.title}
              </h1>
              <p className="mt-2 truncate text-lg text-text-dim">
                {current.artists.map((a) => a.name).join(', ')}
              </p>
              {current.album ? (
                <p className="mt-1 truncate text-sm text-text-faint">{current.album.name}</p>
              ) : null}
              <p className="mono mt-4 truncate text-[11px] uppercase tracking-[0.14em] text-text-faint">
                {metaLine}
              </p>
            </div>
          </div>
        ) : null}

        {hasLyrics && (wide || showLyrics) ? (
          <LyricsPane
            lines={lyrics.lines}
            plain={lyrics.plain}
            positionMs={positionMs}
            loading={lyrics.loading}
            source={lyrics.source}
            onSeek={(ms) => void services.controller.seek(ms)}
            className={clsx('min-h-0 min-w-0', wide ? 'h-full max-w-[520px] flex-1' : 'h-full w-full')}
          />
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line">
        <div className="px-8 pt-3">
          <SeekBar
            positionMs={positionMs}
            durationMs={durationMs}
            bufferedMs={bufferedMs}
            disabled={!seekable}
            onSeek={(ms) => void services.controller.seek(ms)}
            onScrubStart={() => usePlayerStore.setState({ scrubbing: true })}
            onScrubEnd={() => usePlayerStore.setState({ scrubbing: false })}
          />
        </div>

        {/* A thin spectrum strip riding directly under the progress line. */}
        <Visualizer
          getSpectrum={getSpectrum}
          active={status === 'playing'}
          className="mt-1 h-6 w-full opacity-60"
        />

        <div className="flex items-center gap-3 px-8 pb-5 pt-2">
          <IconButton
            icon={IconPrevious}
            label={t('player.previous')}
            size="lg"
            onClick={() => void services.controller.previous()}
          />
          <PlayButton
            playing={status === 'playing'}
            loading={status === 'loading'}
            size="lg"
            onToggle={() => void services.controller.toggle()}
            label={status === 'playing' ? t('player.pause') : t('player.play')}
          />
          <IconButton
            icon={IconNext}
            label={t('player.next')}
            size="lg"
            onClick={() => void services.controller.next()}
          />
          <IconButton
            icon={IconShuffle}
            label={t('player.shuffle')}
            size="lg"
            active={shuffle}
            onClick={() => void services.controller.setShuffle(!shuffle)}
          />
          <IconButton
            icon={repeat === 'one' ? IconRepeatOne : IconRepeat}
            label={repeat === 'one' ? t('player.repeatOne') : t('player.repeat')}
            size="lg"
            active={repeat !== 'off'}
            onClick={() => void services.controller.setRepeat(nextRepeat(repeat))}
          />
          <LikeButton
            liked={liked}
            onToggle={() => void useLibraryStore.getState().toggleLike(current)}
          />
          {hasLyrics && !wide ? (
            <Button
              variant="ghost"
              size="sm"
              leading={IconLyrics}
              className="ml-auto"
              onClick={() => setShowLyrics((v) => !v)}
            >
              {showLyrics ? t('lyrics.hide') : t('lyrics.show')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
