import { useCallback } from 'react';
import type { MouseEvent } from 'react';

import { useContextMenuController } from '../components/ContextMenuHost';

type ContextMenuHandle = ReturnType<typeof useContextMenuController>;
/** Menu item shape taken straight from the host, so no second definition exists. */
export type ContextMenuItems = Parameters<ContextMenuHandle['open']>[2];

export type OpenContextMenu = (e: MouseEvent, items: ContextMenuItems) => void;

/**
 * Right-click anywhere. One portal and one open menu at a time, so the handle
 * is a singleton the host owns; this only converts a pointer event into a
 * position and suppresses the native menu.
 */
export function useContextMenu(): OpenContextMenu {
  const menu = useContextMenuController();

  return useCallback<OpenContextMenu>(
    (e, items) => {
      // An empty menu should leave the browser's own menu alone rather than
      // swallowing the click and showing nothing.
      if (items.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      menu.open(e.clientX, e.clientY, items);
    },
    [menu],
  );
}
