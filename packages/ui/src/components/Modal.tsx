import { useCallback, useEffect, useId, useRef } from 'react';
import clsx from 'clsx';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Portal, useBodyScrollLock } from './Portal';
import { IconButton } from './IconButton';
import { Close } from '../icons';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useTranslation } from '../hooks/useTranslation';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Rendered in the footer, right-aligned. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Blocks backdrop/Escape dismissal for destructive confirmations. */
  dismissible?: boolean;
  className?: string;
}

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  actions,
  children,
  dismissible = true,
  className,
}: ModalProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const descriptionId = `${uid}-description`;

  useBodyScrollLock(open);

  // Declared before useFocusTrap on purpose: effects run in hook order, so this
  // records the outside element before the trap pulls focus into the panel.
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

  const dismiss = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    // Only the modal holding focus sees this, so nested dialogs close innermost
    // first without a global listener stack.
    event.stopPropagation();
    dismiss();
  };

  if (!open) return null;

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onKeyDown={handleKeyDown}
      >
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
          aria-describedby={description !== undefined ? descriptionId : undefined}
          className={clsx(
            'relative z-10 flex max-h-[calc(100vh-4rem)] w-full animate-slide-up flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop',
            SIZE[size],
            className,
          )}
        >
          {(title !== undefined || description !== undefined || dismissible) && (
            <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                {title !== undefined && (
                  <h2 id={titleId} className="truncate text-base font-semibold text-text">
                    {title}
                  </h2>
                )}
                {description !== undefined && (
                  <p id={descriptionId} className="mt-1 text-[13px] leading-snug text-text-dim">
                    {description}
                  </p>
                )}
              </div>
              {dismissible && (
                <IconButton icon={Close} label={t('common.close')} size="sm" onClick={onClose} />
              )}
            </header>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>

          {actions !== undefined && (
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
              {actions}
            </footer>
          )}
        </div>
      </div>
    </Portal>
  );
}
