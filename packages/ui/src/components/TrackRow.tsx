import { forwardRef } from 'react';
import clsx from 'clsx';
import { formatDuration } from '@ritmo/core';
import type { Track } from '@ritmo/core';
import { useTranslation } from '../hooks/useTranslation';
import { Close, Downloaded, GripVertical, MoreHorizontal, Play } from '../icons';
import { Artwork } from './Artwork';
import { Badge } from './Badge';
import { DropdownMenu } from './DropdownMenu';
import type { MenuItemSpec } from './DropdownMenu';
import { IconButton } from './IconButton';
import { LikeButton } from './LikeButton';
import { Marquee } from './Marquee';
import { ProviderBadge } from './ProviderBadge';

export type TrackRowVariant = 'list' | 'compact' | 'queue' | 'search';

export interface TrackRowProps {
  track: Track;
  /** 1-based; omit to hide the index column. */
  index?: number;
  variant?: TrackRowVariant;
  active?: boolean;
  playing?: boolean;
  liked?: boolean;
  offline?: boolean;
  selected?: boolean;
  /** Hides the album column in contexts where it is redundant. */
  hideAlbum?: boolean;
  showArtwork?: boolean;
  onPlay: () => void;
  onToggleLike?: () => void;
  /** Adds a trailing remove control; the queue and a local album both use it. */
  onRemove?: () => void;
  /** What that control announces. Defaults to the queue's wording. */
  removeLabel?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  /** Present only in the queue, where rows are draggable. */
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  menuItems?: MenuItemSpec[];
  /** Additive: lets `TrackTable` own a single-tab-stop focus cursor. */
  tabIndex?: number;
  className?: string;
}

export interface TrackRowGridOptions {
  variant: TrackRowVariant;
  hasIndex: boolean;
  hasArtwork: boolean;
  hasAlbum: boolean;
  /** A row with a remove control carries one extra trailing column. */
  hasRemove?: boolean;
}

/**
 * The templates are written out in full rather than composed at runtime because
 * Tailwind only generates arbitrary values it can see as literals in the source.
 */
export function trackRowGridClass(o: TrackRowGridOptions): string {
  const artwork = o.hasArtwork && o.variant !== 'compact';
  if (o.variant === 'queue') {
    if (o.hasRemove === true) {
      return artwork
        ? 'grid-cols-[28px_40px_minmax(0,1fr)_auto_32px_48px_32px_32px]'
        : 'grid-cols-[28px_minmax(0,1fr)_auto_32px_48px_32px_32px]';
    }
    return artwork
      ? 'grid-cols-[28px_40px_minmax(0,1fr)_auto_32px_48px_32px]'
      : 'grid-cols-[28px_minmax(0,1fr)_auto_32px_48px_32px]';
  }
  const album = o.hasAlbum && (o.variant === 'list' || o.variant === 'search');
  const leading = (o.variant !== 'search' && o.hasIndex ? 1 : 0) + (artwork ? 1 : 0);
  const remove = o.hasRemove === true;
  if (leading === 2) {
    if (album) {
      return remove
        ? 'grid-cols-[40px_40px_minmax(0,1fr)_minmax(0,1fr)_auto_32px_48px_32px_32px]'
        : 'grid-cols-[40px_40px_minmax(0,1fr)_minmax(0,1fr)_auto_32px_48px_32px]';
    }
    return remove
      ? 'grid-cols-[40px_40px_minmax(0,1fr)_auto_32px_48px_32px_32px]'
      : 'grid-cols-[40px_40px_minmax(0,1fr)_auto_32px_48px_32px]';
  }
  if (leading === 1) {
    if (album) {
      return remove
        ? 'grid-cols-[40px_minmax(0,1fr)_minmax(0,1fr)_auto_32px_48px_32px_32px]'
        : 'grid-cols-[40px_minmax(0,1fr)_minmax(0,1fr)_auto_32px_48px_32px]';
    }
    return remove
      ? 'grid-cols-[40px_minmax(0,1fr)_auto_32px_48px_32px_32px]'
      : 'grid-cols-[40px_minmax(0,1fr)_auto_32px_48px_32px]';
  }
  if (album) {
    return remove
      ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_32px_48px_32px_32px]'
      : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_32px_48px_32px]';
  }
  return remove
    ? 'grid-cols-[minmax(0,1fr)_auto_32px_48px_32px_32px]'
    : 'grid-cols-[minmax(0,1fr)_auto_32px_48px_32px]';
}

const BAR_DELAYS = ['[animation-delay:0ms]', '[animation-delay:160ms]', '[animation-delay:320ms]'];

function Equalizer() {
  return (
    <span aria-hidden="true" className="flex h-4 w-4 items-end justify-center gap-[2px]">
      {BAR_DELAYS.map((delay) => (
        <span
          key={delay}
          className={clsx(
            'h-full w-[3px] origin-bottom rounded-sm bg-accent',
            'animate-[bar-bounce_900ms_ease-in-out_infinite]',
            delay,
          )}
        />
      ))}
    </span>
  );
}

export const TrackRow = forwardRef<HTMLDivElement, TrackRowProps>(function TrackRow(
  {
    track,
    index,
    variant = 'list',
    active = false,
    playing = false,
    liked = false,
    offline = false,
    selected = false,
    hideAlbum = false,
    showArtwork = true,
    onPlay,
    onToggleLike,
    onRemove,
    removeLabel,
    onContextMenu,
    onClick,
    dragHandleProps,
    menuItems,
    tabIndex = 0,
    className,
  },
  ref,
) {
  const { t } = useTranslation();
  const compact = variant === 'compact';
  const withArtwork = showArtwork && !compact;
  const withAlbum = !hideAlbum && (variant === 'list' || variant === 'search');
  const withIndex = variant !== 'search' && variant !== 'queue' && index !== undefined;
  const artists = track.artists.map((a) => a.name).join(', ');
  const remote = track.provider !== 'local';

  const grid = trackRowGridClass({
    variant,
    hasIndex: index !== undefined,
    hasArtwork: showArtwork,
    hasAlbum: !hideAlbum,
    hasRemove: onRemove !== undefined,
  });

  return (
    <div
      ref={ref}
      role="row"
      tabIndex={tabIndex}
      aria-selected={selected}
      onClick={onClick}
      onDoubleClick={onPlay}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          // preventDefault marks the key as consumed so TrackTable does not replay it.
          e.preventDefault();
          onPlay();
        }
      }}
      className={clsx(
        // Rows are ruled, not tinted in alternating bands; the playing row is
        // marked in the gutter the way an editor marks the active line.
        'group grid h-full min-w-0 max-w-full items-center gap-3 border-b border-line/50 px-3 outline-none transition-colors',
        compact || variant === 'queue' ? 'min-h-[44px]' : 'min-h-[56px]',
        selected ? 'bg-surface-3' : 'hover:bg-surface-2/70 focus-visible:bg-surface-2/70',
        active && 'gutter-mark',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
        grid,
        className,
      )}
    >
      {variant === 'queue' ? (
        <div role="gridcell" className="flex shrink-0 items-center">
          {/* dragHandleProps is spread last so the queue owns the pointer wiring and label. */}
          <span
            role="button"
            tabIndex={-1}
            aria-label={t('library.sortBy')}
            className="flex h-7 w-7 cursor-grab items-center justify-center text-text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 active:cursor-grabbing"
            {...dragHandleProps}
          >
            <GripVertical className="h-4 w-4" />
          </span>
        </div>
      ) : null}

      {withIndex ? (
        <div role="gridcell" className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
            aria-label={t('common.play')}
            className="mono relative flex h-10 w-10 items-center justify-center rounded-xs text-sm text-text-dim outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {playing ? (
              <Equalizer />
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className={clsx(
                    'transition-opacity group-hover:opacity-0 group-focus-within:opacity-0',
                    active && 'text-accent',
                  )}
                >
                  {index}
                </span>
                <Play className="absolute h-4 w-4 text-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
              </>
            )}
          </button>
        </div>
      ) : null}

      {withArtwork ? (
        <div role="gridcell" className="flex shrink-0 items-center">
          <Artwork artwork={track.artwork} name={track.title} size={40} rounded="xs" />
        </div>
      ) : null}

      <div role="gridcell" className="flex min-w-0 flex-col justify-center">
        <div className={clsx('min-w-0 text-sm', active ? 'text-accent' : 'text-text')}>
          {variant === 'queue' ? <Marquee>{track.title}</Marquee> : <span className="block truncate">{track.title}</span>}
        </div>
        <div className="min-w-0 truncate text-xs text-text-dim">{artists}</div>
      </div>

      {withAlbum ? (
        <div role="gridcell" className="min-w-0 truncate text-sm text-text-dim">
          {track.album?.name ?? ''}
        </div>
      ) : null}

      <div role="gridcell" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        {track.explicit ? (
          <Badge tone="neutral">
            <span aria-hidden="true">E</span>
            <span className="sr-only">{t('common.explicit')}</span>
          </Badge>
        ) : null}
        {track.isLive ? (
          <Badge tone="danger" className="uppercase">
            {t('common.live')}
          </Badge>
        ) : null}
        {offline ? (
          <span title={t('common.downloaded')} className="text-accent">
            <Downloaded className="h-4 w-4" />
            <span className="sr-only">{t('common.downloaded')}</span>
          </span>
        ) : null}
        {remote ? <ProviderBadge provider={track.provider} size="sm" withLabel={false} /> : null}
      </div>

      <div role="gridcell" className="flex shrink-0 items-center justify-center">
        {onToggleLike ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className={clsx(
              'transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100',
              liked ? 'opacity-100' : 'opacity-0',
            )}
          >
            <LikeButton liked={liked} onToggle={onToggleLike} size="sm" />
          </div>
        ) : null}
      </div>

      <div role="gridcell" className="mono shrink-0 whitespace-nowrap text-right text-[13px] text-text-dim">
        {track.isLive || track.durationMs <= 0 ? '—' : formatDuration(track.durationMs)}
      </div>

      <div role="gridcell" className="flex shrink-0 items-center justify-center">
        {menuItems && menuItems.length > 0 ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <DropdownMenu items={menuItems} align="end">
              <IconButton icon={MoreHorizontal} label={t('common.more')} size="sm" />
            </DropdownMenu>
          </div>
        ) : null}
      </div>

      {onRemove ? (
        <div role="gridcell" className="flex shrink-0 items-center justify-center">
          <div
            onClick={(e) => e.stopPropagation()}
            className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <IconButton
              icon={Close}
              label={removeLabel ?? t('queue.remove')}
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
});
