import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { viewportSize } from './viewport';
import type { CSSProperties, RefObject } from 'react';

export type PositionedSide = 'top' | 'bottom' | 'left' | 'right';
export type PositionedAlign = 'start' | 'center' | 'end';

export interface UsePositionedOptions {
  /** Anchor element; ignored when `point` is given. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Virtual anchor in viewport coordinates — the context menu uses this. */
  point?: { x: number; y: number } | null;
  side?: PositionedSide;
  align?: PositionedAlign;
  offset?: number;
  /** Skips measurement while false so a closed overlay costs nothing. */
  open?: boolean;
  /** Minimum gap kept between the floating element and the viewport edge. */
  padding?: number;
}

export interface UsePositionedResult {
  /** Attach to the floating element. */
  ref: RefObject<HTMLDivElement>;
  style: CSSProperties;
  /** The side actually used after flipping. */
  side: PositionedSide;
}

interface Placement {
  left: number;
  top: number;
  side: PositionedSide;
  maxHeight: number;
  maxWidth: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const HIDDEN: CSSProperties = { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };

/**
 * Viewport-aware fixed positioning: flips to the opposite side when the
 * preferred one does not fit, then shifts along the cross axis to stay on
 * screen. Recomputed on scroll and resize, coalesced into one frame.
 */
export function usePositioned(options: UsePositionedOptions): UsePositionedResult {
  const {
    anchorRef,
    point = null,
    side = 'bottom',
    align = 'start',
    offset = 6,
    open = true,
    padding = 8,
  } = options;

  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Depend on the coordinates, not the object, so an inline `point` literal
  // does not retrigger measurement on every render.
  const pointX = point?.x;
  const pointY = point?.y;

  const compute = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    let anchor: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null = null;
    if (pointX !== undefined && pointY !== undefined) {
      anchor = { left: pointX, top: pointY, right: pointX, bottom: pointY, width: 0, height: 0 };
    } else {
      const el2 = anchorRef?.current;
      if (el2) {
        const r = el2.getBoundingClientRect();
        anchor = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
    }
    if (!anchor) return;

    const { width: vw, height: vh } = viewportSize();
    const rect = el.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    let resolved: PositionedSide = side;
    let left: number;
    let top: number;

    if (side === 'bottom' || side === 'top') {
      const below = vh - anchor.bottom - offset - padding;
      const above = anchor.top - offset - padding;
      if (side === 'bottom') resolved = h > below && above > below ? 'top' : 'bottom';
      else resolved = h > above && below > above ? 'bottom' : 'top';
      top = resolved === 'bottom' ? anchor.bottom + offset : anchor.top - offset - h;
      left =
        align === 'end'
          ? anchor.right - w
          : align === 'center'
            ? anchor.left + (anchor.width - w) / 2
            : anchor.left;
    } else {
      const after = vw - anchor.right - offset - padding;
      const before = anchor.left - offset - padding;
      if (side === 'right') resolved = w > after && before > after ? 'left' : 'right';
      else resolved = w > before && after > before ? 'right' : 'left';
      left = resolved === 'right' ? anchor.right + offset : anchor.left - offset - w;
      top =
        align === 'end'
          ? anchor.bottom - h
          : align === 'center'
            ? anchor.top + (anchor.height - h) / 2
            : anchor.top;
    }

    left = clamp(left, padding, Math.max(padding, vw - w - padding));
    top = clamp(top, padding, Math.max(padding, vh - h - padding));
    const maxHeight = Math.max(64, vh - top - padding);
    const maxWidth = Math.max(160, vw - left - padding);

    setPlacement((prev) => {
      if (
        prev &&
        prev.side === resolved &&
        Math.abs(prev.left - left) < 0.5 &&
        Math.abs(prev.top - top) < 0.5 &&
        Math.abs(prev.maxHeight - maxHeight) < 0.5 &&
        Math.abs(prev.maxWidth - maxWidth) < 0.5
      ) {
        // Identity-stable so clamping the height cannot feed back into a loop
        // through the ResizeObserver below.
        return prev;
      }
      return { left, top, side: resolved, maxHeight, maxWidth };
    });
  }, [anchorRef, pointX, pointY, side, align, offset, padding]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    compute();

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    };

    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule);
      if (ref.current) observer.observe(ref.current);
      const anchor = anchorRef?.current;
      if (anchor) observer.observe(anchor);
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer?.disconnect();
    };
  }, [open, compute, anchorRef]);

  const style: CSSProperties = placement
    ? {
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      }
    : HIDDEN;

  return { ref, style, side: placement?.side ?? side };
}
