import clsx from 'clsx';
import { forwardRef } from 'react';
import { Pause, Play } from '../icons';
import { useTranslation } from '../hooks';
import { Spinner } from './Spinner';

export interface PlayButtonProps {
  playing: boolean;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  onToggle: () => void;
  label?: string;
  className?: string;
}

const SIZE: Record<'sm' | 'md' | 'lg' | 'xl', string> = {
  sm: 'h-8 w-8 text-[14px]',
  md: 'h-10 w-10 text-[17px]',
  lg: 'h-14 w-14 text-[23px]',
  xl: 'h-16 w-16 text-[26px]',
};

export const PlayButton = forwardRef<HTMLButtonElement, PlayButtonProps>(function PlayButton(
  { playing, loading = false, size = 'md', onToggle, label, className },
  ref,
) {
  const { t } = useTranslation();
  const accessibleLabel = label ?? (playing ? t('player.pause') : t('player.play'));

  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-label={accessibleLabel}
      aria-busy={loading || undefined}
      className={clsx(
        // A bright disc with a white triangle is the streaming-app signature;
        // a near-square accent key reads as a desktop toolbar control instead.
        'grid shrink-0 place-items-center rounded-md bg-accent text-on-accent',
        'transition-[background-color,transform] duration-150 ease-swift',
        'hover:bg-accent-hover active:scale-[0.97]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        SIZE[size],
        className,
      )}
    >
      {loading ? (
        <Spinner size={size === 'sm' || size === 'md' ? 'sm' : 'md'} />
      ) : playing ? (
        <Pause className="h-[1em] w-[1em]" />
      ) : (
        // The glyph's bounding box already sits right of the viewBox centre, so
        // inside a square it needs a nudge back to the left, not to the right.
        <Play className="h-[1em] w-[1em] -translate-x-[1px]" />
      )}
    </button>
  );
});
