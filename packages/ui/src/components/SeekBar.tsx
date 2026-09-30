import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { formatDuration } from '@ritmo/core';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Slider } from './Slider';
import { useTranslation } from '../hooks/useTranslation';

export interface SeekBarProps {
  positionMs: number;
  durationMs: number;
  bufferedMs?: number;
  disabled?: boolean;
  onSeek: (positionMs: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  /** Hides the numeric labels for the compact bar. */
  bare?: boolean;
  /** Passed straight to {@link Slider}; `hairline` is the top-edge rule. */
  variant?: 'default' | 'hairline';
  className?: string;
}

/** A zeroed clock rather than copy: identical in every locale. */
const NO_TIME = '0:00';
/** How long the committed playhead is held before the store takes over again. */
const COMMIT_GRACE_MS = 700;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function SeekBar({
  positionMs,
  durationMs,
  bufferedMs,
  disabled = false,
  onSeek,
  onScrubStart,
  onScrubEnd,
  bare = false,
  variant = 'default',
  className,
}: SeekBarProps) {
  const { t } = useTranslation();
  const live = durationMs <= 0;
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const [hover, setHover] = useState<{ ratio: number; ms: number } | null>(null);
  const graceRef = useRef<number | undefined>(undefined);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (graceRef.current !== undefined) window.clearTimeout(graceRef.current);
    },
    [],
  );

  const shownMs = clamp(scrubMs ?? positionMs, 0, Math.max(0, durationMs));

  const handleCommit = (value: number) => {
    const target = Math.round(value);
    setScrubMs(target);
    onSeek(target);
    if (graceRef.current !== undefined) window.clearTimeout(graceRef.current);
    // Hold the committed playhead briefly so the bar does not snap back to the
    // pre-seek position while the controller is still applying the seek.
    graceRef.current = window.setTimeout(() => setScrubMs(null), COMMIT_GRACE_MS);
  };

  const handleHover = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (live || disabled || event.pointerType !== 'mouse') return;
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    setHover({ ratio, ms: ratio * durationMs });
  };

  const buffered =
    bufferedMs !== undefined && durationMs > 0 ? clamp(bufferedMs / durationMs, 0, 1) : undefined;

  const bar = (
    <div
      ref={trackRef}
      className="relative min-w-0 flex-1"
      onPointerMove={handleHover}
      onPointerLeave={() => setHover(null)}
    >
      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 rounded-sm bg-surface-3 px-1.5 py-0.5 font-num text-[11px] tabular-nums text-text shadow-pop"
          style={{ left: `${hover.ratio * 100}%` }}
        >
          {formatDuration(hover.ms)}
        </div>
      )}

      {live ? (
        // Live radio has no length to scrub; announce the state instead of
        // exposing an empty slider.
        <div className="relative h-5 w-full" role="img" aria-label={t('common.live')}>
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full w-full animate-pulse rounded-full bg-accent/40" />
          </div>
        </div>
      ) : (
        <Slider
          variant={variant}
          value={shownMs}
          min={0}
          max={durationMs}
          step={1000}
          disabled={disabled}
          buffered={buffered}
          // The dictionary has no dedicated progress-bar key; "now playing" is
          // the closest existing name for what this control scrubs.
          label={t('player.nowPlaying')}
          valueText={formatDuration}
          onChange={setScrubMs}
          onCommit={handleCommit}
          onScrubStart={onScrubStart}
          onScrubEnd={onScrubEnd}
        />
      )}
    </div>
  );

  if (bare) return <div className={clsx('flex w-full items-center', className)}>{bar}</div>;

  return (
    <div className={clsx('flex w-full items-center gap-2', className)}>
      {live ? (
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-accent">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          {t('common.live')}
        </span>
      ) : (
        <span className="w-11 shrink-0 text-right font-num text-[11px] tabular-nums text-text-dim">
          {formatDuration(shownMs)}
        </span>
      )}
      {bar}
      <span className="w-11 shrink-0 font-num text-[11px] tabular-nums text-text-dim">
        {live ? NO_TIME : formatDuration(durationMs)}
      </span>
    </div>
  );
}
