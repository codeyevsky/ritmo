import { useMemo } from 'react';

import { dismissToast, pushToast } from '../components/ToastHost';

/** Exactly what the singleton host accepts, so the two cannot drift apart. */
export type ToastInput = Parameters<typeof pushToast>[0];

export interface ToastApi {
  /** Returns the toast id; push again with the same id to update it in place. */
  show(spec: ToastInput): string;
  /** Alias of {@link ToastApi.show}, kept for call sites that read better this way. */
  toast(spec: ToastInput): string;
  dismiss(id: string): void;
}

export function useToast(): ToastApi {
  // The host is a module singleton, so this identity never has to change.
  return useMemo<ToastApi>(
    () => ({
      show: (spec) => pushToast(spec),
      toast: (spec) => pushToast(spec),
      dismiss: (id) => dismissToast(id),
    }),
    [],
  );
}
