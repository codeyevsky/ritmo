import clsx from 'clsx';

import type { TKey } from '@ritmo/core';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';

import type { RepeatMode, Track } from '@ritmo/core';
import { formatDuration } from '@ritmo/core';

import {
  Artwork,
  Button,
  IconButton,
  LikeButton,
  Marquee,
  PlayButton,
  SeekBar,
  VolumeControl,
} from '../components';
import { useBreakpoint, useIsLiked, useSmoothPosition, useTranslation } from '../hooks';
import {
  IconChevronUp,
  IconFullscreen,
  IconNext,
  IconPrevious,
  IconQueue,
  IconRepeat,
  IconRepeatOne,
  IconShuffle,
} from '../icons';
import { entityPath } from '../routes';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore, useUiStore } from '../store';

export interface NowPlayingBarProps {
  className?: string;
}

const REPEAT_CYCLE: RepeatMode[] = ['off', 'all', 'one'];

/** Above this the bar can afford every secondary toggle. */
const ALL_TOGGLES_ABOVE = 900;
/** Below this the left status cluster is all that is left. */
const NO_TOGGLES_BELOW = 700;

/**
 * The progress line is a window-wide 2px rule on the bar's top edge, not a
 * centred pill track — that silhouette is the streaming-app signature.
 *
 * `SeekBar` keeps a 20px pointer target, so these overrides pull its track to
 * the top of that target: the rule lands on the window edge while the whole
 * 20px strip stays grabbable, and no hit area is stolen from the view above.
 * If SeekBar's internals ever move, the overrides simply stop applying and the
 * track falls back to the middle of the strip.
 */
function nextRepeat(mode: RepeatMode): RepeatMode {
  const index = REPEAT_CYCLE.indexOf(mode);
  return REPEAT_CYCLE[(index + 1) % REPEAT_CYCLE.length] ?? 'off';
}

/**
 * One control for the whole side panel. Called without a tab, `togglePanel`
 * leaves `tab` alone, so the panel comes back on whichever of Queue / Lyrics /
 * Now playing the user left it on. The per-tab chords (`Q`, `Y`) still pass a
 * tab and so still open the panel on that specific one.
 */
function toggleDetails(): void {
  useUiStore.getState().togglePanel();
}

function coverOf(track: Track) {
  return track.artwork ?? track.album?.artwork;
}

/** Inline on purpose: the status line truncates as a whole, not per artist. */
function ArtistLinks({ track, className }: { track: Track; className?: string }): JSX.Element {
  return (
    <span className={className}>
      {track.artists.map((artist, index) => (
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
    </span>
  );
}

/** Square, hairline-framed cover art; no bloom, no artwork-derived wash. */
function Cover({ track, size }: { track: Track; size: number }): JSX.Element {
  return (
    <span className="block shrink-0 overflow-hidden rounded-xs border border-line">
      <Artwork artwork={coverOf(track)} name={track.title} size={size} rounded="none" eager />
    </span>
  );
}

/**
 * Engine errors arrive as raw transport text — a dead station produced
 * "io error: request failed: error sending request for url (...)" on the bar.
 * The underlying message is kept on `title` so it is still reachable when
 * something needs reporting.
 */
function playbackErrorText(
  error: { code: string; message: string },
  t: (key: TKey) => string,
): string {
  switch (error.code) {
    case 'network':
    case 'stream_unresolved':
      return t('errors.streamFailed');
    case 'not_found':
      return t('errors.notFound');
    case 'decode':
      return t('errors.decodeFailed');
    case 'device':
      return t('errors.noDevice');
    default:
      return t('errors.generic');
  }
}

export function NowPlayingBar({ className }: NowPlayingBarProps): JSX.Element {
  const { t } = useTranslation();
  const services = useServices();
  const { width } = useBreakpoint();
  const isMobile = width < 640;

  const status = usePlayerStore((s) => s.status);
  const current = usePlayerStore((s) => s.current);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const bufferedMs = usePlayerStore((s) => s.bufferedMs);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const error = usePlayerStore((s) => s.error);
  const contextName = usePlayerStore((s) => s.queue.contextName);

  const [windowFullscreen, setWindowFullscreen] = useState(false);
  const positionMs = useSmoothPosition();
  const liked = useIsLiked(current?.uri);
  const panelOpen = useUiStore((s) => s.panelOpen);

  const { controller } = services;
  const playing = status === 'playing';
  const seekable = Boolean(current) && durationMs > 0 && !current?.isLive;
  const live = Boolean(current?.isLive) || durationMs <= 0;

  const onToggle = useCallback(() => void controller.toggle(), [controller]);
  const onToggleLike = useCallback(() => {
    if (!current) return;
    void useLibraryStore.getState().toggleLike(current);
  }, [current, services]);

  const openFullScreen = useCallback(() => useUiStore.setState({ fullscreen: true }), []);

  if (!current) {
    return (
      <div
        className={clsx(
          'flex h-[var(--bar-h)] w-full min-w-0 max-w-full items-center justify-center overflow-hidden border-t border-line bg-surface px-4',
          className,
        )}
      >
        <p className="mono truncate text-[11px] uppercase tracking-[0.14em] text-text-faint">
          {t('player.nothingPlaying')}
        </p>
      </div>
    );
  }

  // The strip reserves less height than SeekBar's 20px pointer target: the
  // target is allowed to hang into the padding above the row's content, which
  // keeps the rule on the window edge without a dead band under it.
  const seekLine = (heightClass: string): JSX.Element => (
    <div className={clsx('relative z-10 w-full shrink-0', heightClass)}>
      <SeekBar
        bare
        variant="hairline"
        className="absolute inset-x-0 top-0"
        positionMs={positionMs}
        durationMs={durationMs}
        bufferedMs={bufferedMs}
        disabled={!seekable}
        onSeek={(ms) => void controller.seek(ms)}
        onScrubStart={() => usePlayerStore.setState({ scrubbing: true })}
        onScrubEnd={() => usePlayerStore.setState({ scrubbing: false })}
      />
    </div>
  );

  if (isMobile) {
    return (
      // `max-w-full` + a clipped content row: nothing here can ever push the
      // bar wider than its grid column.
      <div
        className={clsx(
          'flex w-full min-w-0 max-w-full flex-col border-t border-line bg-surface',
          className,
        )}
      >
        {seekLine('h-5')}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden px-3 pb-2">
          <button
            type="button"
            onClick={openFullScreen}
            aria-label={t('player.openFullScreen')}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Cover track={current} size={40} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text">{current.title}</span>
              <span className="block truncate text-xs text-text-dim">
                {current.artists.map((a) => a.name).join(', ')}
              </span>
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <LikeButton liked={liked} onToggle={onToggleLike} />
            <PlayButton playing={playing} loading={status === 'loading'} size="md" onToggle={onToggle} />
            <IconButton
              icon={IconNext}
              label={t('player.next')}
              size="md"
              onClick={() => void controller.next()}
            />
          </div>
        </div>
      </div>
    );
  }

  const showToggles = width >= NO_TOGGLES_BELOW;
  const showAllToggles = width >= ALL_TOGGLES_ABOVE;

  return (
    // The root stays unclipped so SeekBar's hover clock can escape upwards;
    // the status row below does the horizontal clipping instead.
    <div
      className={clsx(
        'relative flex h-[var(--bar-h)] w-full min-w-0 max-w-full flex-col border-t border-line bg-surface',
        className,
      )}
    >
      {seekLine('h-3')}

      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden px-3 pb-1">
        {/* Capped near a third of the bar so the transport lands close to the
            middle instead of hugging the metadata. */}
        <div className="flex min-w-0 max-w-[32%] shrink basis-[32%] items-center gap-3">
          <Cover track={current} size={48} />
          {/* h-12 matches the artwork: two lines, never taller than the cover. */}
          <div className="flex h-12 min-w-0 flex-1 flex-col justify-center gap-0.5">
            {current.album ? (
              <Link
                to={entityPath(current.album.uri)}
                className="block min-w-0 rounded-xs text-[13px] font-medium leading-tight text-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Marquee>{current.title}</Marquee>
              </Link>
            ) : (
              <span className="block truncate text-[13px] font-medium leading-tight text-text">
                {current.title}
              </span>
            )}
            {/* Artists and the playback context share one truncating line. */}
            <span className="block min-w-0 truncate text-[11px] leading-tight text-text-dim">
              <ArtistLinks track={current} />
              {contextName ? (
                <span className="text-text-faint">
                  <span aria-hidden="true"> · </span>
                  {t('player.playingFrom')} {contextName}
                </span>
              ) : null}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center">
          <LikeButton liked={liked} onToggle={onToggleLike} />
          <IconButton
            icon={IconChevronUp}
            label={t('player.openFullScreen')}
            size="sm"
            onClick={openFullScreen}
          />
        </div>

        {/* Transport and its clock read as one group. */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center gap-0.5">
            <IconButton
              icon={IconPrevious}
              label={t('player.previous')}
              size="sm"
              onClick={() => void controller.previous()}
            />
            <PlayButton
              playing={playing}
              loading={status === 'loading'}
              size="md"
              onToggle={onToggle}
              label={playing ? t('player.pause') : t('player.play')}
              className="mx-1"
            />
            <IconButton
              icon={IconNext}
              label={t('player.next')}
              size="sm"
              onClick={() => void controller.next()}
            />
            <IconButton
              icon={IconShuffle}
              label={t('player.shuffle')}
              size="sm"
              active={shuffle}
              onClick={() => void controller.setShuffle(!shuffle)}
            />
            <IconButton
              icon={repeat === 'one' ? IconRepeatOne : IconRepeat}
              label={
                repeat === 'one'
                  ? t('player.repeatOne')
                  : repeat === 'all'
                    ? t('player.repeatAll')
                    : t('player.repeat')
              }
              size="sm"
              active={repeat !== 'off'}
              onClick={() => void controller.setRepeat(nextRepeat(repeat))}
            />
          </div>

          <span className="mono whitespace-nowrap text-[11px] text-text-faint">
            {live ? (
              <span className="text-accent">{t('common.live')}</span>
            ) : (
              <>
                <span className="text-text-dim">{formatDuration(positionMs)}</span>
                <span aria-hidden="true"> / </span>
                {formatDuration(durationMs)}
              </>
            )}
          </span>
        </div>

        {error ? (
          <div className="flex min-w-0 shrink items-center gap-2" role="alert">
            <span className="min-w-0 truncate text-[11px] text-danger" title={error.message}>
              {playbackErrorText(error, t)}
            </span>
            {error.retryable ? (
              <Button
                size="sm"
                variant="subtle"
                className="shrink-0"
                onClick={() => void controller.play()}
              >
                {t('common.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Absorbs whatever is left so the toggles stay pinned right. */}
        <span aria-hidden="true" className="min-w-0 flex-1" />

        {showToggles ? (
          <div className="flex shrink-0 items-center gap-0.5 pl-2">
            {/* A pressed frame, not just the accent tint: this toggle moves a
                whole column of the shell, so its state has to be readable at a
                glance rather than inferred from the panel being there. */}
            <IconButton
              icon={IconQueue}
              label={t('player.details')}
              size="sm"
              active={panelOpen}
              className={clsx(panelOpen && 'bg-accent/10 ring-1 ring-inset ring-accent/40')}
              onClick={toggleDetails}
            />
            <VolumeControl
              volume={volume}
              muted={muted}
              onVolume={(v) => void controller.setVolume(v)}
              onToggleMute={() => void controller.setMuted(!muted)}
            />
            {showAllToggles && services.host.window ? (
              <IconButton
                icon={IconFullscreen}
                label={t('player.windowFullScreen')}
                size="sm"
                active={windowFullscreen}
                onClick={() => {
                  const next = !windowFullscreen;
                  setWindowFullscreen(next);
                  void services.host.window?.setFullscreen(next);
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
