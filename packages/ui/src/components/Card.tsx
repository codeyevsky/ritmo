import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { Artwork as ArtworkData, Uri } from '@ritmo/core';
import { useTranslation } from '../hooks/useTranslation';
import { MoreHorizontal } from '../icons';
import { Artwork } from './Artwork';
import { DropdownMenu } from './DropdownMenu';
import type { MenuItemSpec } from './DropdownMenu';
import { IconButton } from './IconButton';
import { PlayButton } from './PlayButton';

export interface CardProps {
  kind: 'album' | 'artist' | 'playlist' | 'station';
  title: string;
  subtitle?: string;
  artwork?: ArtworkData;
  uri: Uri;
  onOpen: () => void;
  onPlay?: () => void;
  playing?: boolean;
  menuItems?: MenuItemSpec[];
  size?: 'sm' | 'md';
  className?: string;
}

/** Outer width minus the tile's two hairlines, so the artwork sits flush. */
const ART_PX = { sm: 170, md: 202 } as const;
const CARD_W = { sm: 'w-[172px]', md: 'w-[204px]' } as const;

/** Digit runs get the tabular face so years and counts line up down a shelf. */
const NUMERIC = /(\d+(?:[.,:]\d+)*)/g;

function withMonoNumerals(text: string): ReactNode {
  const parts = text.split(NUMERIC);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="mono">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function Card({
  kind,
  title,
  subtitle,
  artwork,
  uri,
  onOpen,
  onPlay,
  playing = false,
  menuItems,
  size = 'md',
  className,
}: CardProps) {
  const { t } = useTranslation();
  const round = kind === 'artist';

  return (
    <button
      type="button"
      onClick={onOpen}
      data-uri={uri}
      className={clsx(
        // `.tile` owns the hairline, the accent-on-hover border and the faint
        // fill; nothing here floats, so there is no shadow.
        'tile group relative flex shrink-0 flex-col overflow-hidden rounded-md text-left outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent',
        playing && 'ring-1 ring-inset ring-accent/60',
        CARD_W[size],
        className,
      )}
    >
      <div className="relative">
        <Artwork
          artwork={artwork}
          name={title}
          size={ART_PX[size]}
          shape={round ? 'circle' : 'square'}
          rounded="xs"
        />
        {onPlay ? (
          <span
            onClick={(e) => e.stopPropagation()}
            className={clsx(
              // Opacity only: a control that slides in from the corner is the
              // streaming-card gesture this design drops.
              'absolute bottom-2 right-2 transition-opacity duration-150 ease-swift',
              playing
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            )}
          >
            <PlayButton
              playing={playing}
              size="sm"
              label={playing ? t('common.pause') : t('common.play')}
              onToggle={onPlay}
            />
          </span>
        ) : null}
        {menuItems && menuItems.length > 0 ? (
          <span
            onClick={(e) => e.stopPropagation()}
            className="absolute right-1 top-1 opacity-0 transition-opacity duration-150 ease-swift group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <DropdownMenu items={menuItems} align="end">
              <IconButton icon={MoreHorizontal} label={t('common.more')} size="sm" />
            </DropdownMenu>
          </span>
        ) : null}
      </div>

      <div className="min-w-0 px-2.5 py-2">
        <div className={clsx('line-clamp-2 text-sm', playing ? 'text-accent' : 'text-text')}>{title}</div>
        {subtitle !== undefined && subtitle !== '' ? (
          <div className="mt-0.5 truncate text-xs text-text-dim">{withMonoNumerals(subtitle)}</div>
        ) : null}
      </div>
    </button>
  );
}
