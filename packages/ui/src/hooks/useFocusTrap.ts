import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      el.getAttribute('aria-hidden') !== 'true' &&
      !el.hasAttribute('disabled') &&
      // getClientRects is the cheapest reliable "is rendered" check; it also
      // excludes anything inside a display:none subtree.
      el.getClientRects().length > 0,
  );
}

/**
 * Keeps Tab focus inside `ref` while `active`, and moves focus to the first
 * tabbable element (or `[data-autofocus]`) when the trap turns on.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;

    if (!root.contains(document.activeElement)) {
      const preferred = root.querySelector<HTMLElement>('[data-autofocus]');
      const target = preferred ?? tabbables(root)[0] ?? root;
      if (target === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const list = tabbables(root);
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const outside = !current || !root.contains(current);
      if (event.shiftKey) {
        if (outside || current === first) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (outside || current === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, [ref, active]);
}
