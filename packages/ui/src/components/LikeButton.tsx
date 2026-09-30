import clsx from 'clsx';
import { forwardRef } from 'react';
import { Heart, HeartFilled } from '../icons';
import { useTranslation } from '../hooks';

export interface LikeButtonProps {
  liked: boolean;
  onToggle: () => void;
  size?: 'sm' | 'md';
  className?: string;
}

const SIZE: Record<'sm' | 'md', string> = {
  sm: 'h-8 w-8 text-[15px]',
  md: 'h-9 w-9 text-[19px]',
};

export const LikeButton = forwardRef<HTMLButtonElement, LikeButtonProps>(function LikeButton(
  { liked, onToggle, size = 'md', className },
  ref,
) {
  const { t } = useTranslation();
  const label = liked ? t('player.unlike') : t('player.like');

  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={liked}
      title={label}
      className={clsx(
        'grid shrink-0 place-items-center rounded-full transition-[color,transform] duration-150 ease-swift',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'hover:scale-[1.12] active:scale-[0.92]',
        liked ? 'text-accent' : 'text-text-faint hover:text-text',
        SIZE[size],
        className,
      )}
    >
      {liked ? <HeartFilled className="h-[1em] w-[1em]" /> : <Heart className="h-[1em] w-[1em]" />}
    </button>
  );
});
