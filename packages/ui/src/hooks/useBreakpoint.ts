import { useSyncExternalStore } from 'react';

import { observeViewport, viewportSize } from './viewport';

export interface Breakpoint {
  /** < 640px — bottom tab bar, compact now-playing strip. */
  isMobile: boolean;
  /** < 820px — the sidebar shows icons only. */
  isCompact: boolean;
  /** >= 1100px — the right panel can sit inline instead of overlaying. */
  isWide: boolean;
  width: number;
}

export const BREAKPOINTS = { mobile: 640, compact: 820, wide: 1100 } as const;

function measure(): Breakpoint {
  const width = viewportSize().width;
  return {
    width,
    isMobile: width < BREAKPOINTS.mobile,
    isCompact: width < BREAKPOINTS.compact,
    isWide: width >= BREAKPOINTS.wide,
  };
}

// One resize listener and one cached snapshot for the whole tree: every
// component reading the breakpoint otherwise installs its own listener, and
// `useSyncExternalStore` requires a referentially stable snapshot.
let snapshot = measure();
const listeners = new Set<() => void>();

function onResize(): void {
  const next = measure();
  if (
    next.width === snapshot.width &&
    next.isMobile === snapshot.isMobile &&
    next.isCompact === snapshot.isCompact &&
    next.isWide === snapshot.isWide
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

let unobserve: (() => void) | undefined;

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    unobserve = observeViewport(onResize);
    onResize();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unobserve?.();
      unobserve = undefined;
    }
  };
}

function getSnapshot(): Breakpoint {
  return snapshot;
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
