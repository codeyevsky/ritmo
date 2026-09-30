import clsx from 'clsx';

export interface SkeletonProps {
  className?: string;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
}

const ROUNDED: Record<'sm' | 'md' | 'lg' | 'full', string> = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

/** The `.shimmer` sheen degrades to a flat tint under prefers-reduced-motion. */
export function Skeleton({ className, rounded = 'md' }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={clsx('shimmer bg-surface-2', ROUNDED[rounded], className)}
    />
  );
}
