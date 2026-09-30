import { useCallback, useEffect, useId, useRef, useState } from 'react';
import clsx from 'clsx';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Portal, useBodyScrollLock } from './Portal';
import { IconButton } from './IconButton';
import { Close } from '../icons';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useTranslation } from '../hooks/useTranslation';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Drag distance that dismisses regardless of speed. */
const DISMISS_PX = 96;
/** px/ms — a quick flick dismisses from a much shorter drag. */
const DISMISS_VELOCITY = 0.5;

interface DragState {
  pointerId: number;
  startY: number;
  startedAt: number;
}

export function Sheet({ open, onClose, title, children, className }: SheetProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const uid = useId();
  const titleId = `${uid}-title`;

  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const target = restoreRef.current;
      restoreRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open]);

  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (open) return;
    dragRef.current = null;
    setOffset(0);
    setDragging(false);
  }, [open]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startedAt: performance.now() };
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(Math.max(0, event.clientY - drag.startY));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const travelled = Math.max(0, event.clientY - drag.startY);
    const elapsed = Math.max(1, performance.now() - drag.startedAt);
    if (travelled > DISMISS_PX || travelled / elapsed > DISMISS_VELOCITY) {
      onClose();
      return;
    }
    setOffset(0);
  };

  const dismiss = useCallback(() => onClose(), [onClose]);

  if (!open) return null;

  const panelStyle: CSSProperties = offset > 0 ? { transform: `translateY(${offset}px)` } : {};

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-end justify-center" onKeyDown={handleKeyDown}>
        <div
          aria-hidden="true"
          className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-sm"
          onClick={dismiss}
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title !== undefined ? titleId : undefined}
          style={panelStyle}
          className={clsx(
            'relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-xl border-t border-line bg-surface shadow-pop',
            dragging ? 'animate-none' : 'animate-slide-up transition-transform duration-200 ease-swift',
            className,
          )}
        >
          <div
            className="shrink-0 cursor-grab touch-none px-4 pb-1 pt-3 active:cursor-grabbing"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div aria-hidden="true" className="mx-auto h-1 w-10 rounded-full bg-surface-3" />
          </div>

          <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-1">
            <div className="min-w-0 flex-1">
              {title !== undefined && (
                <h2 id={titleId} className="truncate text-base font-semibold text-text">
                  {title}
                </h2>
              )}
            </div>
            <IconButton icon={Close} label={t('common.close')} size="sm" onClick={onClose} />
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] scrollbar-thin">
            {children}
          </div>
        </div>
      </div>
    </Portal>
  );
}
