import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Calls `handler` on a pointerdown outside every element in `refs`.
 *
 * Pointerdown rather than click so a menu closes before the element under the
 * cursor reacts, and the trigger is passed in `refs` so closing it does not
 * race the trigger's own toggle into reopening the menu.
 */
export function useClickOutside(
  refs: Array<RefObject<HTMLElement | null>>,
  handler: (event: PointerEvent) => void,
  active = true,
  /**
   * CSS selector for elements that count as inside even though they are not
   * under any ref. Submenus render into their own portal, so they are not
   * descendants of the panel that owns them; without this a click on a submenu
   * item reads as outside, the menu closes, the item unmounts and its action
   * never runs.
   */
  insideSelector?: string,
): void {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const selectorRef = useRef(insideSelector);
  selectorRef.current = insideSelector;

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // A node already detached cannot be located relative to the refs, and it
      // almost always means the click removed it — treat it as inside.
      if (!target.isConnected) return;
      for (const ref of refsRef.current) {
        const el = ref.current;
        if (el && (el === target || el.contains(target))) return;
      }
      const selector = selectorRef.current;
      if (selector && target instanceof Element && target.closest(selector) !== null) return;
      if (selector && target.parentElement?.closest(selector) != null) return;
      handlerRef.current(event);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [active]);
}
