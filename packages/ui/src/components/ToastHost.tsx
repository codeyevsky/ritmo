import { useCallback, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import type { ReactElement } from 'react';
import { Portal } from './Portal';
import { Toast } from './Toast';
import type { ToastSpec } from './Toast';

export interface ToastHostProps {
  className?: string;
}

/** Visible at once; anything beyond this waits for a slot to free up. */
export const TOAST_STACK_LIMIT = 4;

// Module-level store so the scan worker, download queue and any other
// non-React caller can raise a toast without a hook.
let toasts: ToastSpec[] = [];
const listeners = new Set<() => void>();
let sequence = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ToastSpec[] {
  return toasts;
}

export function pushToast(spec: Omit<ToastSpec, 'id'> & { id?: string }): string {
  sequence += 1;
  const id = spec.id ?? `toast-${sequence}`;
  const next: ToastSpec = { ...spec, id };
  const index = toasts.findIndex((toast) => toast.id === id);
  // Re-pushing an existing id updates in place rather than stacking, which is
  // what the library scan relies on to report live progress.
  toasts = index >= 0 ? toasts.map((toast, i) => (i === index ? next : toast)) : [...toasts, next];
  emit();
  return id;
}

export function dismissToast(id: string): void {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function clearToasts(): void {
  if (toasts.length === 0) return;
  toasts = [];
  emit();
}

export function getToasts(): ToastSpec[] {
  return toasts;
}

/** Mounted exactly once by the app shell. */
export function ToastHost({ className }: ToastHostProps): ReactElement {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const onDismiss = useCallback((id: string) => dismissToast(id), []);
  const visible = all.slice(0, TOAST_STACK_LIMIT);

  return (
    <Portal>
      {/* Each toast carries its own live-region role, so this wrapper stays
          semantically inert — nested live regions double-announce. */}
      <div
        className={clsx(
          'pointer-events-none fixed right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2',
          'bottom-[calc(var(--bar-h)+1rem)]',
          className,
        )}
      >
        {visible.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </Portal>
  );
}
