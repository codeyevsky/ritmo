import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useTranslation } from '../hooks/useTranslation';
import { ChevronLeft, ChevronRight } from '../icons';
import { IconButton } from './IconButton';

export interface ShelfProps {
  title: string;
  subtitle?: string;
  /** Renders a "see all" link when provided. */
  onSeeAll?: () => void;
  children: React.ReactNode;
  className?: string;
}

export function Shelf({ title, subtitle, onSeeAll, children, className }: ShelfProps) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setAtStart(el.scrollLeft <= 1);
    // 1px slack: fractional layout widths never land exactly on the maximum.
    setAtEnd(max <= 1 || el.scrollLeft >= max - 1);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [measure]);

  // A ResizeObserver on the track never fires when its *content* grows, so the
  // arrows/masks are also re-evaluated whenever the card set changes.
  useEffect(() => {
    measure();
  }, [children, measure]);

  const scrollByPage = useCallback((dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth, behavior: 'smooth' });
  }, []);

  const scrollable = !atStart || !atEnd;

  return (
    <section className={clsx('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-1">
        {/* `.rule-label` draws its own hairline to its right edge, so the
            heading takes the free space and the controls sit past the rule. */}
        <div className="flex items-center gap-3">
          <h2 className="rule-label min-w-0 flex-1">
            <span className="min-w-0 truncate">{title}</span>
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {onSeeAll ? (
              <button
                type="button"
                onClick={onSeeAll}
                className="mono rounded-xs text-[11px] uppercase tracking-[0.14em] text-text-faint outline-none transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
              >
                {t('common.seeAll')}
              </button>
            ) : null}
            {scrollable ? (
              <div className="flex items-center gap-1">
                <IconButton
                  icon={ChevronLeft}
                  label={t('common.back')}
                  size="sm"
                  disabled={atStart}
                  onClick={() => scrollByPage(-1)}
                />
                <IconButton
                  icon={ChevronRight}
                  label={t('common.forward')}
                  size="sm"
                  disabled={atEnd}
                  onClick={() => scrollByPage(1)}
                />
              </div>
            ) : null}
          </div>
        </div>
        {subtitle !== undefined && subtitle !== '' ? (
          <p className="truncate text-xs text-text-dim">{subtitle}</p>
        ) : null}
      </div>

      <div className="relative">
        <div
          ref={trackRef}
          className={clsx(
            'flex snap-x snap-proximity gap-4 overflow-x-auto overflow-y-hidden scroll-smooth pb-1',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:snap-start',
          )}
        >
          {children}
        </div>
        <div
          aria-hidden="true"
          className={clsx(
            'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-bg to-transparent transition-opacity duration-200',
            atStart ? 'opacity-0' : 'opacity-100',
          )}
        />
        <div
          aria-hidden="true"
          className={clsx(
            'pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-bg to-transparent transition-opacity duration-200',
            atEnd ? 'opacity-0' : 'opacity-100',
          )}
        />
      </div>
    </section>
  );
}
