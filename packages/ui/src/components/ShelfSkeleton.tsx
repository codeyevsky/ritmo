import clsx from 'clsx';
import { Skeleton } from './Skeleton';

export interface ShelfSkeletonProps {
  /** Number of placeholder cards. */
  count?: number;
  size?: 'sm' | 'md';
  className?: string;
}

const CARD_W = { sm: 'w-[172px]', md: 'w-[204px]' } as const;
/** Matches `Card`: the artwork is flush inside the tile's hairlines. */
const ART_H = { sm: 'h-[170px]', md: 'h-[202px]' } as const;

export function ShelfSkeleton({ count = 6, size = 'md', className }: ShelfSkeletonProps) {
  return (
    <section aria-busy="true" className={clsx('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-3 w-40" rounded="sm" />
        <div className="h-px flex-1 bg-line" />
      </div>
      <div className="flex gap-4 overflow-hidden pb-1">
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            className={clsx('flex shrink-0 flex-col overflow-hidden rounded-md border border-line', CARD_W[size])}
          >
            <Skeleton className={clsx('w-full', ART_H[size])} rounded="sm" />
            <div className="flex flex-col gap-1.5 px-2.5 py-2">
              <Skeleton className="h-3.5 w-4/5" rounded="sm" />
              <Skeleton className="h-3 w-1/2" rounded="sm" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
