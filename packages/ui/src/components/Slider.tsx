import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Fires continuously while dragging. */
  onChange: (value: number) => void;
  /** Fires once on release — commit expensive work here. */
  onCommit?: (value: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  /** Secondary fill behind the value, 0..1 — used for the buffered range. */
  buffered?: number;
  label: string;
  orientation?: 'horizontal' | 'vertical';
  /**
   * `hairline` pins a 2px square-cornered track to the top edge and drops the
   * thumb — the player bar's window-wide progress rule. A variant rather than
   * something callers style from outside, because overriding another
   * component's internal layers breaks silently the moment they change.
   */
  variant?: 'default' | 'hairline';
  /** Replaces the default percentage `aria-valuetext`; SeekBar passes a clock. */
  valueText?: (value: number) => string;
  className?: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function pct(ratio: number): string {
  return `${clamp(ratio, 0, 1) * 100}%`;
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step,
  disabled = false,
  onChange,
  onCommit,
  onScrubStart,
  onScrubEnd,
  buffered,
  label,
  orientation = 'horizontal',
  variant = 'default',
  valueText,
  className,
}: SliderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  const horizontal = orientation === 'horizontal';
  const hairline = variant === 'hairline';
  const span = max - min || 1;
  const stepSize = step !== undefined && step > 0 ? step : span / 100;

  const shown = clamp(dragValue ?? value, min, max);
  const ratio = (shown - min) / span;

  // Native wheel and pointer-capture handlers read the live value and callbacks
  // through refs so the listeners never have to be torn down mid-gesture.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const callbacks = useRef({ onChange, onCommit, onScrubStart, onScrubEnd });
  callbacks.current = { onChange, onCommit, onScrubStart, onScrubEnd };
  const lastEmitted = useRef(shown);
  // Keep the de-dupe baseline in sync with externally driven values, or a
  // click landing on the last dragged-to value would be swallowed.
  if (!dragging) lastEmitted.current = value;

  const snap = useCallback(
    (raw: number): number => {
      const bounded = clamp(raw, min, max);
      if (step === undefined || step <= 0) return bounded;
      const snapped = min + Math.round((bounded - min) / step) * step;
      // Repeated 0.05 additions drift (0.30000000000000004); round to the
      // precision the step itself implies.
      const decimals = (String(step).split('.')[1] ?? '').length;
      const fixed = Number(snapped.toFixed(Math.min(decimals + 2, 10)));
      return clamp(fixed, min, max);
    },
    [min, max, step],
  );

  const valueFromPoint = useCallback(
    (clientX: number, clientY: number): number => {
      const el = rootRef.current;
      if (!el) return shownRef.current;
      const rect = el.getBoundingClientRect();
      let raw: number;
      if (horizontal) raw = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width;
      // Vertical sliders grow upwards, so the axis is inverted.
      else raw = rect.height === 0 ? 0 : 1 - (clientY - rect.top) / rect.height;
      return snap(min + clamp(raw, 0, 1) * span);
    },
    [horizontal, min, span, snap],
  );

  const emit = useCallback((next: number) => {
    if (next === lastEmitted.current) return;
    lastEmitted.current = next;
    callbacks.current.onChange(next);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const el = rootRef.current;
    el?.setPointerCapture(event.pointerId);
    el?.focus({ preventScroll: true });
    draggingRef.current = true;
    setDragging(true);
    callbacks.current.onScrubStart?.();
    const next = valueFromPoint(event.clientX, event.clientY);
    setDragValue(next);
    emit(next);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const next = valueFromPoint(event.clientX, event.clientY);
    setDragValue(next);
    emit(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    const el = rootRef.current;
    if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
    const next = valueFromPoint(event.clientX, event.clientY);
    setDragValue(null);
    emit(next);
    callbacks.current.onCommit?.(next);
    callbacks.current.onScrubEnd?.();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const big = stepSize * 10;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = shown + stepSize;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = shown - stepSize;
        break;
      case 'PageUp':
        next = shown + big;
        break;
      case 'PageDown':
        next = shown - big;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    // A focused slider owns the arrow keys; the global shortcuts must not also
    // seek or change the volume.
    event.stopPropagation();
    const snapped = snap(next);
    emit(snapped);
    callbacks.current.onCommit?.(snapped);
  };

  useEffect(() => {
    const el = rootRef.current;
    if (!el || disabled) return;
    const onWheel = (event: WheelEvent) => {
      const primary = horizontal
        ? event.deltaX !== 0
          ? event.deltaX
          : -event.deltaY
        : -event.deltaY;
      if (primary === 0) return;
      // passive:false is the whole point — without preventDefault the page
      // scrolls while the user is nudging a slider.
      event.preventDefault();
      const next = snap(shownRef.current + Math.sign(primary) * stepSize);
      if (next === shownRef.current) return;
      emit(next);
      callbacks.current.onCommit?.(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled, horizontal, snap, stepSize, emit]);

  const fillStyle: CSSProperties = horizontal ? { width: pct(ratio) } : { height: pct(ratio) };
  const bufferedStyle: CSSProperties = horizontal
    ? { width: pct(buffered ?? 0) }
    : { height: pct(buffered ?? 0) };
  const thumbStyle: CSSProperties = horizontal
    ? { left: pct(ratio), top: '50%', transform: 'translate(-50%, -50%)' }
    : { bottom: pct(ratio), left: '50%', transform: 'translate(-50%, 50%)' };

  return (
    <div
      ref={rootRef}
      role="slider"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={valueText ? valueText(shown) : `${Math.round(ratio * 100)}%`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={clsx(
        'group relative touch-none select-none outline-none',
        hairline ? 'rounded-none' : 'rounded-full',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        horizontal ? (hairline ? 'h-3 w-full' : 'h-5 w-full') : 'h-full w-5',
        disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <div
        className={clsx(
          'absolute overflow-hidden bg-surface-3',
          hairline ? 'rounded-none' : 'rounded-full',
          horizontal
            ? hairline
              ? 'left-0 right-0 top-0 h-[2px]'
              : 'left-0 right-0 top-1/2 h-1 -translate-y-1/2'
            : 'bottom-0 left-1/2 top-0 w-1 -translate-x-1/2',
        )}
      >
        {buffered !== undefined && (
          <div
            aria-hidden="true"
            className={clsx(
              'absolute bg-text-faint/50',
              hairline ? 'rounded-none' : 'rounded-full',
              horizontal ? 'bottom-0 left-0 top-0' : 'bottom-0 left-0 right-0',
            )}
            style={bufferedStyle}
          />
        )}
        <div
          aria-hidden="true"
          className={clsx(
            'absolute transition-colors duration-150 ease-swift',
            hairline ? 'rounded-none' : 'rounded-full',
            horizontal ? 'bottom-0 left-0 top-0' : 'bottom-0 left-0 right-0',
            dragging ? 'bg-accent' : 'bg-text group-hover:bg-accent group-focus-visible:bg-accent',
          )}
          style={fillStyle}
        />
      </div>

      {!disabled && !hairline && (
        <div
          aria-hidden="true"
          className={clsx(
            'absolute h-3 w-3 rounded-full bg-text shadow-card transition-opacity duration-150 ease-swift',
            dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
          style={thumbStyle}
        />
      )}
    </div>
  );
}
