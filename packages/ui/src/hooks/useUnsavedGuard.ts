import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export interface UnsavedGuard {
  /** True while a navigation is held back, waiting on the user's answer. */
  asking: boolean;
  /** Drops the held navigation: the user stays where they are. */
  stay: () => void;
  /** Runs the held navigation, with the guard out of the way for that one hop. */
  leave: () => void;
}

/**
 * The guard a mounted view has installed, if any.
 *
 * Module level because a navigation started from the shell — the history
 * buttons, the command palette — has no way to reach a view's own state, and
 * `useBlocker` needs the data router this app does not use.
 */
let installed: ((go: () => void) => void) | undefined;

/**
 * Runs `go`, unless a view with unsaved work has asked to be consulted first.
 * Controls that navigate on their own rather than through a link go through it.
 */
export function guardedNavigation(go: () => void): void {
  if (installed === undefined) go();
  else installed(go);
}

/** The in-app path a click is about to follow, or nothing if it is not one. */
function linkTarget(event: MouseEvent): string | undefined {
  if (event.defaultPrevented || event.button !== 0) return undefined;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined;
  const from = event.target;
  if (!(from instanceof Element)) return undefined;
  const anchor = from.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return undefined;
  if (anchor.target !== '' && anchor.target !== '_self') return undefined;
  if (anchor.origin !== window.location.origin) return undefined;
  const to = `${anchor.pathname}${anchor.search}${anchor.hash}`;
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return to === here ? undefined : to;
}

/**
 * Holds a navigation back while a view is carrying edits it has not written, so
 * the view can ask before they are dropped.
 *
 * Three ways out of a page are covered: a link click, caught in the capture
 * phase before the router ever sees it; a programmatic navigation that went
 * through {@link guardedNavigation}; and a reload or a closed window, which the
 * browser's own prompt handles.
 */
export function useUnsavedGuard(active: boolean): UnsavedGuard {
  const navigate = useNavigate();
  const [held, setHeld] = useState<(() => void) | undefined>(undefined);

  // The listeners are installed once per activation and would otherwise close
  // over a stale `active`.
  const activeRef = useRef(active);
  activeRef.current = active;

  const hold = useCallback((go: () => void) => {
    if (!activeRef.current) {
      go();
      return;
    }
    setHeld(() => go);
  }, []);

  useEffect(() => {
    if (!active) return;
    installed = hold;

    const onClick = (event: MouseEvent) => {
      const to = linkTarget(event);
      if (to === undefined) return;
      // React's own click handler sits further down the tree, so stopping
      // propagation here is what keeps a <Link> from navigating.
      event.preventDefault();
      event.stopPropagation();
      hold(() => navigate(to));
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome still reads returnValue; the string itself is never shown.
      event.returnValue = '';
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      if (installed === hold) installed = undefined;
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [active, hold, navigate]);

  const stay = useCallback(() => setHeld(undefined), []);

  const leave = useCallback(() => {
    const go = held;
    setHeld(undefined);
    if (go === undefined) return;
    // Out of the way first: the guard is what held this hop back, and it would
    // otherwise hold the replay as well.
    installed = undefined;
    go();
  }, [held]);

  return { asking: held !== undefined, stay, leave };
}
