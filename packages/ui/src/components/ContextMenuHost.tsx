import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { Portal } from './Portal';
import { MENU_SURFACE_ATTR, MENU_SURFACE_CLASS, MenuList } from './DropdownMenu';
import type { MenuItemSpec } from './DropdownMenu';
import { usePositioned } from '../hooks/usePositioned';
import { useClickOutside } from '../hooks/useClickOutside';
import { useTranslation } from '../hooks/useTranslation';

/** Imperative: one portal, one open menu at a time. Exposed through `useContextMenu`. */
export interface ContextMenuHandle {
  open(x: number, y: number, items: MenuItemSpec[]): void;
  close(): void;
}

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuItemSpec[];
}

const CLOSED: ContextMenuState = { open: false, x: 0, y: 0, items: [] };

// Module-level so `useContextMenu` — and any non-React caller — can drive the
// single mounted host without threading a ref through the tree.
let state: ContextMenuState = CLOSED;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ContextMenuState {
  return state;
}

export function openContextMenu(x: number, y: number, items: MenuItemSpec[]): void {
  if (items.length === 0) return;
  state = { open: true, x, y, items };
  emit();
}

export function closeContextMenu(): void {
  if (!state.open) return;
  state = CLOSED;
  emit();
}

export function useContextMenuController(): ContextMenuHandle {
  return useMemo<ContextMenuHandle>(() => ({ open: openContextMenu, close: closeContextMenu }), []);
}

/** Mounted exactly once by the app shell. */
export function ContextMenuHost(): ReactElement | null {
  const { t } = useTranslation();
  const menu = useSyncExternalStore(subscribe, snapshot, snapshot);
  const restoreRef = useRef<HTMLElement | null>(null);

  const { style, ref } = usePositioned({
    point: menu.open ? { x: menu.x, y: menu.y } : null,
    side: 'bottom',
    align: 'start',
    offset: 2,
    open: menu.open,
  });

  useClickOutside([ref], closeContextMenu, menu.open, `[${MENU_SURFACE_ATTR}]`);

  useEffect(() => {
    if (menu.open) {
      restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const target = restoreRef.current;
    restoreRef.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [menu.open]);

  useEffect(() => {
    if (!menu.open) return;
    const onScroll = (event: Event) => {
      const panel = ref.current;
      if (panel && event.target instanceof Node && panel.contains(event.target)) return;
      closeContextMenu();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeContextMenu);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeContextMenu);
    };
  }, [menu.open, ref]);

  if (!menu.open) return null;

  return (
    <Portal>
      <div ref={ref} style={style} data-menu-surface="" className={MENU_SURFACE_CLASS}>
        <MenuList
          items={menu.items}
          ariaLabel={t('common.more')}
          autoFocusFirst
          onClose={closeContextMenu}
          onDismissSelf={closeContextMenu}
        />
      </div>
    </Portal>
  );
}
