import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { activeLyricIndex } from '@ritmo/core';
import type { LyricLine } from '@ritmo/core';
import { useTranslation } from '../hooks/useTranslation';
import { Music } from '../icons';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';

export interface LyricsPaneProps {
  lines?: LyricLine[];
  plain?: string;
  positionMs: number;
  onSeek?: (ms: number) => void;
  loading?: boolean;
  source?: string;
  className?: string;
}

/** How long a manual scroll wins over auto-scroll. */
const LOCK_MS = 4000;
const SKELETON_WIDTHS = ['w-3/4', 'w-1/2', 'w-5/6', 'w-2/3', 'w-4/5', 'w-1/3', 'w-3/5', 'w-2/4'];

export function LyricsPane({ lines, plain, positionMs, onSeek, loading = false, source, className }: LyricsPaneProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef(new Map<number, HTMLButtonElement>());
  const lockTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [locked, setLocked] = useState(false);

  const activeIndex = useMemo(
    () => (lines && lines.length > 0 ? activeLyricIndex(lines, positionMs) : -1),
    [lines, positionMs],
  );

  const lock = useCallback(() => {
    setLocked(true);
    if (lockTimer.current) clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(() => setLocked(false), LOCK_MS);
  }, []);

  useEffect(() => () => {
    if (lockTimer.current) clearTimeout(lockTimer.current);
  }, []);

  // Listening for the *input* (wheel/touch/pointer) instead of `scroll` keeps
  // the pane's own smooth-scrolling from looking like a manual scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('wheel', lock, { passive: true });
    el.addEventListener('touchmove', lock, { passive: true });
    el.addEventListener('pointerdown', lock, { passive: true });
    return () => {
      el.removeEventListener('wheel', lock);
      el.removeEventListener('touchmove', lock);
      el.removeEventListener('pointerdown', lock);
    };
  }, [lock]);

  useEffect(() => {
    if (locked || activeIndex < 0) return;
    const container = scrollRef.current;
    const node = lineRefs.current.get(activeIndex);
    if (!container || !node) return;
    container.scrollTo({
      top: node.offsetTop - container.clientHeight / 2 + node.offsetHeight / 2,
      behavior: 'smooth',
    });
  }, [activeIndex, locked]);

  const attribution =
    source !== undefined && source !== '' ? (
      <p className="mono shrink-0 border-t border-line px-6 py-2 text-[11px] text-text-faint">
        {t('lyrics.source', { source })}
      </p>
    ) : null;

  if (loading) {
    return (
      <div className={clsx('flex flex-col', className)}>
        <div aria-live="polite" aria-busy="true" className="flex flex-1 flex-col gap-4 px-6 py-8">
          {SKELETON_WIDTHS.map((w) => (
            <Skeleton key={w} className={clsx('h-5', w)} />
          ))}
        </div>
      </div>
    );
  }

  const hasSynced = lines !== undefined && lines.length > 0;
  const hasPlain = plain !== undefined && plain.trim() !== '';

  if (!hasSynced && !hasPlain) {
    return (
      <div className={clsx('flex flex-col', className)}>
        <div className="flex flex-1 items-center justify-center px-6 py-8">
          <EmptyState icon={Music} title={t('lyrics.notFound')} body={t('lyrics.notFoundBody')} />
        </div>
      </div>
    );
  }

  if (!hasSynced) {
    const paragraphs = (plain ?? '').split(/\n{2,}/);
    return (
      <div className={clsx('flex flex-col', className)}>
        <div ref={scrollRef} className="scrollbar-thin flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto flex max-w-prose flex-col gap-4 text-center">
            {paragraphs.map((para, i) => (
              <p key={i} className="selectable whitespace-pre-line text-base leading-relaxed text-text-dim">
                {para}
              </p>
            ))}
          </div>
        </div>
        {attribution}
      </div>
    );
  }

  return (
    <div className={clsx('flex flex-col', className)}>
      <div ref={scrollRef} className="scrollbar-thin relative flex-1 overflow-y-auto px-6">
        {/* Half-viewport padding so the first and last lines can reach the centre. */}
        <div className="flex flex-col gap-1 py-[45%]">
          {(lines ?? []).map((line, i) => {
            const distance = Math.abs(i - activeIndex);
            return (
              <button
                key={`${line.atMs}-${i}`}
                type="button"
                ref={(node) => {
                  if (node) lineRefs.current.set(i, node);
                  else lineRefs.current.delete(i);
                }}
                disabled={!onSeek}
                onClick={() => onSeek?.(line.atMs)}
                aria-current={i === activeIndex ? 'true' : undefined}
                className={clsx(
                  // `.selectable` restores text selection *and* resets the
                  // cursor, so a seekable line has to re-assert the pointer.
                  'selectable rounded-xs px-2 py-1.5 text-left font-semibold outline-none transition-all duration-300 ease-swift',
                  'focus-visible:ring-2 focus-visible:ring-accent',
                  onSeek && 'cursor-pointer hover:text-text',
                  i === activeIndex
                    ? 'text-2xl text-text'
                    : distance === 1
                      ? 'text-lg text-text-dim'
                      : 'text-lg text-text-faint',
                )}
              >
                {line.text === '' ? '\u00a0' : line.text}
              </button>
            );
          })}
        </div>
      </div>
      {attribution}
    </div>
  );
}
