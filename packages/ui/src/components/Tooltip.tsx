import clsx from 'clsx';

import { viewportSize } from '../hooks/viewport';
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { FocusEvent, HTMLAttributes, PointerEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  side?: Side;
  delayMs?: number;
  children: ReactElement;
}

interface Placement {
  left: number;
  top: number;
  side: Side;
}

const GAP = 8;
const EDGE = 6;
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

export function Tooltip({ content, side = 'top', delayMs = 400, children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  // A pending open timer must not outlive the component.
  useEffect(() => clearTimer, [clearTimer]);

  // Measure after the tip is in the DOM so the flip decision uses its real size.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;

    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const { width: vw, height: vh } = viewportSize();

    const fits = (s: Side) => {
      if (s === 'top') return a.top - t.height - GAP >= EDGE;
      if (s === 'bottom') return a.bottom + t.height + GAP <= vh - EDGE;
      if (s === 'left') return a.left - t.width - GAP >= EDGE;
      return a.right + t.width + GAP <= vw - EDGE;
    };

    const chosen = fits(side) ? side : fits(OPPOSITE[side]) ? OPPOSITE[side] : side;

    let left: number;
    let top: number;
    if (chosen === 'top' || chosen === 'bottom') {
      left = a.left + a.width / 2 - t.width / 2;
      top = chosen === 'top' ? a.top - t.height - GAP : a.bottom + GAP;
    } else {
      top = a.top + a.height / 2 - t.height / 2;
      left = chosen === 'left' ? a.left - t.width - GAP : a.right + GAP;
    }
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - t.width - EDGE));
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - t.height - EDGE));

    setPlacement((prev) =>
      prev && prev.left === left && prev.top === top && prev.side === chosen
        ? prev
        : { left, top, side: chosen },
    );
  }, [open, side]);

  // Any scroll or resize invalidates the measured rect, so drop the tooltip.
  useEffect(() => {
    if (!open) return;
    const onMove = () => close();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, close]);

  const child = children as ReactElement<HTMLAttributes<HTMLElement>>;
  const childProps = child.props;

  const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
    childProps.onPointerEnter?.(event);
    anchorRef.current = event.currentTarget;
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), Math.max(0, delayMs));
  };

  const handleFocus = (event: FocusEvent<HTMLElement>) => {
    childProps.onFocus?.(event);
    const el = event.currentTarget;
    anchorRef.current = el;
    // Only keyboard focus should surface the tip; a click already showed intent.
    let keyboard = true;
    try {
      keyboard = el.matches(':focus-visible');
    } catch {
      keyboard = true;
    }
    if (keyboard) setOpen(true);
  };

  const trigger = cloneElement(child, {
    onPointerEnter: handlePointerEnter,
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerLeave?.(event);
      close();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      childProps.onPointerDown?.(event);
      close();
    },
    onFocus: handleFocus,
    onBlur: (event: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(event);
      close();
    },
    'aria-describedby': open ? id : childProps['aria-describedby'],
  });

  if (content === undefined || content === null || content === '') return trigger;

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className={clsx(
              'pointer-events-none fixed z-[200] max-w-[18rem] animate-fade-in rounded-md border border-line',
              'bg-surface-3 px-2 py-1 text-xs font-medium text-text shadow-pop',
            )}
            style={{
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              visibility: placement ? 'visible' : 'hidden',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
