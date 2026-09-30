/**
 * Viewport measurement that works inside a WebView.
 *
 * `window.innerWidth` is 0 in WebKitGTK while the window is still hidden — and
 * Ritmo deliberately creates its window hidden to avoid an unstyled flash. Any
 * module that measured at import time therefore captured a zero width, decided
 * the app was on a phone, and never recovered because revealing a window at its
 * existing size emits no `resize` event.
 *
 * `documentElement.clientWidth` is layout-derived and correct as soon as there
 * is a layout, and a `ResizeObserver` fires on the first real measurement.
 */

export interface ViewportSize {
  width: number;
  height: number;
}

/** Assumed until a real measurement arrives; desktop is the common case. */
export const FALLBACK_VIEWPORT: ViewportSize = { width: 1280, height: 800 };

export function viewportSize(): ViewportSize {
  if (typeof document === 'undefined') return FALLBACK_VIEWPORT;
  const root = document.documentElement;
  const width = root.clientWidth || window.innerWidth;
  const height = root.clientHeight || window.innerHeight;
  if (width > 0 && height > 0) return { width, height };
  return FALLBACK_VIEWPORT;
}

/** Calls `onChange` whenever the viewport is resized. Returns an unsubscribe. */
export function observeViewport(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {};

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(onChange);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }

  window.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    window.removeEventListener('orientationchange', onChange);
  };
}
