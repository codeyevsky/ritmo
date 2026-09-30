import clsx from 'clsx';
import { forwardRef, useRef } from 'react';
import type { ReactNode, UIEvent } from 'react';

export interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
  onScrollEnd?: () => void;
}

const THRESHOLD = 240;
/** Extra distance the user must scroll back up before the callback re-arms. */
const HYSTERESIS = 120;

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { children, className, onScrollEnd },
  ref,
) {
  // Without the latch an infinite list fires `onScrollEnd` on every scroll
  // event while the user sits near the bottom waiting for the next page.
  const armed = useRef(true);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!onScrollEnd) return;
    const el = event.currentTarget;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining <= THRESHOLD) {
      if (!armed.current) return;
      armed.current = false;
      onScrollEnd();
    } else if (remaining > THRESHOLD + HYSTERESIS) {
      armed.current = true;
    }
  };

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      className={clsx('overflow-y-auto overscroll-contain scrollbar-thin', className)}
    >
      {children}
    </div>
  );
});
