import clsx from 'clsx';
import type { Artwork as ArtworkData, EntityKind } from '@ritmo/core';
import { useTranslation } from '../hooks/useTranslation';
import { MoreHorizontal, Shuffle } from '../icons';
import { Artwork } from './Artwork';
import { DropdownMenu } from './DropdownMenu';
import type { MenuItemSpec } from './DropdownMenu';
import { IconButton } from './IconButton';
import { LikeButton } from './LikeButton';
import { PlayButton } from './PlayButton';

export interface EntityHeroProps {
  kind: EntityKind;
  title: string;
  subtitle?: React.ReactNode;
  /** e.g. "Album" / "Playlist" / "Artist". */
  eyebrow?: string;
  artwork?: ArtworkData;
  /** Meta line under the title: track count, duration, year. */
  meta?: React.ReactNode;
  playing?: boolean;
  onPlay: () => void;
  onShuffle?: () => void;
  liked?: boolean;
  onToggleLike?: () => void;
  menuItems?: MenuItemSpec[];
  /** Round artwork + no eyebrow, for artists. */
  round?: boolean;
  /** Editable title/description, for owned playlists. */
  editable?: boolean;
  onEdit?: () => void;
  children?: React.ReactNode;
  className?: string;
}

const ART_SIZE = 200;

/**
 * Long names must not wrap to four lines, so the scale drops with length. The
 * ceiling is deliberately modest: a poster-sized title is the streaming-app
 * header, not a desktop one.
 */
function titleScale(length: number): string {
  if (length <= 12) return 'text-4xl md:text-5xl';
  if (length <= 22) return 'text-3xl md:text-4xl';
  if (length <= 34) return 'text-2xl md:text-3xl';
  return 'text-2xl';
}

export function EntityHero({
  kind,
  title,
  subtitle,
  eyebrow,
  artwork,
  meta,
  playing = false,
  onPlay,
  onShuffle,
  liked = false,
  onToggleLike,
  menuItems,
  round,
  editable = false,
  onEdit,
  children,
  className,
}: EntityHeroProps) {
  const { t } = useTranslation();
  const isRound = round ?? kind === 'artist';
  const showEyebrow = !isRound && eyebrow !== undefined && eyebrow !== '';
  const clickableTitle = editable && onEdit !== undefined;

  return (
    // Flat ground on purpose: no artwork-derived gradient, no blurred cover
    // layer — the album art is a framed object, not a light source.
    <header className={clsx('min-w-0 max-w-full bg-bg', className)}>
      <div className="flex min-w-0 max-w-full flex-col gap-5 px-6 pb-6 pt-10 md:flex-row md:items-end md:gap-6">
        <Artwork
          {...(artwork ? { artwork } : {})}
          name={title}
          size={ART_SIZE}
          shape={isRound ? 'circle' : 'square'}
          rounded="sm"
          eager
          className="max-w-full border border-line"
        />

        {/* The 2px accent rule is a border on the text block, so it tracks the
            text's height rather than the artwork's. */}
        <div className="flex min-w-0 max-w-full flex-1 flex-col gap-3 border-l-2 border-accent pl-4 md:pl-5">
          {showEyebrow ? <p className="rule-label">{eyebrow}</p> : null}

          {clickableTitle ? (
            <button
              type="button"
              onClick={onEdit}
              title={t('playlist.editDetails')}
              className={clsx(
                'min-w-0 max-w-full text-balance break-words rounded-xs text-left font-semibold leading-[1.1] tracking-tight text-text outline-none',
                'transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-accent',
                titleScale(title.length),
              )}
            >
              {title}
            </button>
          ) : (
            <h1
              className={clsx(
                'min-w-0 max-w-full text-balance break-words font-semibold leading-[1.1] tracking-tight text-text',
                titleScale(title.length),
              )}
            >
              {title}
            </h1>
          )}

          {subtitle !== undefined && subtitle !== null && subtitle !== '' ? (
            clickableTitle ? (
              <button
                type="button"
                onClick={onEdit}
                title={t('playlist.editDetails')}
                className="line-clamp-3 min-w-0 max-w-full break-words rounded-xs text-left text-sm text-text-dim outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
              >
                {subtitle}
              </button>
            ) : (
              // Long descriptions are clamped: prose must not set the column's width.
              <p className="line-clamp-3 min-w-0 max-w-full break-words text-sm text-text-dim">
                {subtitle}
              </p>
            )
          ) : null}

          {meta !== undefined && meta !== null && meta !== '' ? (
            <p className="mono min-w-0 max-w-full truncate text-xs text-text-faint">{meta}</p>
          ) : null}

          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <PlayButton
              playing={playing}
              size="lg"
              label={playing ? t('common.pause') : t('common.play')}
              onToggle={onPlay}
            />
            {onShuffle ? (
              <IconButton icon={Shuffle} label={t('player.shuffle')} size="lg" onClick={onShuffle} />
            ) : null}
            {onToggleLike ? <LikeButton liked={liked} onToggle={onToggleLike} /> : null}
            {menuItems && menuItems.length > 0 ? (
              <DropdownMenu items={menuItems} align="start">
                <IconButton icon={MoreHorizontal} label={t('common.more')} size="lg" />
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      </div>

      {children}
    </header>
  );
}
