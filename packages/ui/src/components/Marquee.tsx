import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { usePrefersReducedMotion } from '../hooks';

export interface MarqueeProps {
  children: ReactNode;
  className?: string;
}

/** px per second — slow enough to read a long track title comfortably. */
const SPEED = 42;

export function Marquee({ children, className }: MarqueeProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const [metrics, setMetrics] = useState({ overflow: 0, contentWidth: 0 });
  const [engaged, setEngaged] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      const contentWidth = content.scrollWidth;
      const overflow = Math.max(0, contentWidth - viewport.clientWidth);
      setMetrics((prev) =>
        Math.abs(prev.overflow - overflow) < 1 && Math.abs(prev.contentWidth - contentWidth) < 1
          ? prev
          : { overflow, contentWidth },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [children]);

  const running = metrics.overflow > 1 && engaged && !reducedMotion;

  return (
    <div
      ref={viewportRef}
      onPointerEnter={() => setEngaged(true)}
      onPointerLeave={() => setEngaged(false)}
      onFocus={() => setEngaged(true)}
      onBlur={() => setEngaged(false)}
      className={clsx('relative overflow-hidden', className)}
    >
      <div
        className={clsx(
          'flex items-center',
          running ? 'marquee-run w-max' : 'w-full min-w-0',
        )}
        style={
          running
            ? ({
                '--marquee-duration': `${Math.max(4, metrics.contentWidth / SPEED)}s`,
              } as CSSProperties)
            : undefined
        }
      >
        <span
          ref={contentRef}
          className={clsx(running ? 'whitespace-nowrap pr-10' : 'min-w-0 truncate')}
        >
          {children}
        </span>
        {running ? (
          <span aria-hidden="true" className="whitespace-nowrap pr-10">
            {children}
          </span>
        ) : null}
      </div>
    </div>
  );
}
