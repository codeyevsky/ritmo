import { Fragment, cloneElement, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEventHandler,
  KeyboardEventHandler,
  ReactElement,
  Ref,
} from 'react';
import { Portal } from './Portal';
import { Check, ChevronRight } from '../icons';
import type { IconComponent } from '../icons';
import { usePositioned } from '../hooks/usePositioned';
import { useClickOutside } from '../hooks/useClickOutside';
import { useTranslation } from '../hooks/useTranslation';

export interface MenuItemSpec {
  id: string;
  label: string;
  icon?: IconComponent;
  /** Renders a check mark; used by "Add to playlist". */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** A submenu; mutually exclusive with `onSelect`. */
  items?: MenuItemSpec[];
  onSelect?: () => void;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string;
  separatorBefore?: boolean;
}

export interface DropdownMenuProps {
  items: MenuItemSpec[];
  /** The element that opens the menu; receives ref + aria wiring. */
  children: ReactElement;
  side?: 'bottom' | 'top';
  align?: 'start' | 'end';
  className?: string;
}

/** Shared chrome for every floating menu surface, including submenus. */
/** Marks every floating menu surface, so click-outside can span portals. */
export const MENU_SURFACE_ATTR = 'data-menu-surface';

export const MENU_SURFACE_CLASS =
  'z-50 min-w-[12rem] animate-fade-in overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface-2 p-1 shadow-pop scrollbar-thin';

/** Milliseconds a hovered-open submenu survives the pointer moving to a sibling. */
const SUBMENU_GRACE_MS = 250;
const TYPEAHEAD_WINDOW_MS = 600;

function hasSubmenu(item: MenuItemSpec): boolean {
  return Array.isArray(item.items) && item.items.length > 0;
}

function fold(text: string): string {
  return text.toLocaleLowerCase('tr');
}

// ── item ────────────────────────────────────────────────────────────────────

interface MenuItemButtonProps {
  item: MenuItemSpec;
  active: boolean;
  submenu: boolean;
  submenuOpen: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onPointerEnter: () => void;
  onClick: () => void;
}

function MenuItemButton({
  item,
  active,
  submenu,
  submenuOpen,
  buttonRef,
  onPointerEnter,
  onClick,
}: MenuItemButtonProps) {
  const ItemIcon = item.icon;
  const checkable = item.checked !== undefined;
  return (
    <button
      ref={buttonRef}
      type="button"
      role={checkable ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={checkable ? item.checked === true : undefined}
      aria-haspopup={submenu ? 'menu' : undefined}
      aria-expanded={submenu ? submenuOpen : undefined}
      aria-disabled={item.disabled === true || undefined}
      disabled={item.disabled === true}
      tabIndex={active ? 0 : -1}
      onPointerEnter={onPointerEnter}
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-[13px] leading-5 outline-none transition-colors duration-100',
        item.disabled === true
          ? 'cursor-default text-text-faint'
          : item.danger === true
            ? 'text-danger hover:bg-danger/10'
            : 'text-text hover:bg-surface-3',
        active &&
          item.disabled !== true &&
          (item.danger === true ? 'bg-danger/10' : 'bg-surface-3'),
        'focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">
        {item.checked === true ? (
          <Check className="h-3.5 w-3.5 text-accent" />
        ) : ItemIcon ? (
          <ItemIcon className="h-4 w-4" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint !== undefined && (
        <span className="shrink-0 font-num text-[11px] tabular-nums text-text-faint">{item.hint}</span>
      )}
      {submenu && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-text-faint" />}
    </button>
  );
}

// ── submenu ─────────────────────────────────────────────────────────────────

interface MenuSubItemProps {
  item: MenuItemSpec;
  active: boolean;
  open: boolean;
  autoFocusFirst: boolean;
  depth: number;
  registerRef: (el: HTMLButtonElement | null) => void;
  onPointerEnter: () => void;
  onOpen: () => void;
  onDismissSelf: () => void;
  onCloseAll: () => void;
  onSurfaceHover: () => void;
}

function MenuSubItem({
  item,
  active,
  open,
  autoFocusFirst,
  depth,
  registerRef,
  onPointerEnter,
  onOpen,
  onDismissSelf,
  onCloseAll,
  onSurfaceHover,
}: MenuSubItemProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { style, ref: panelRef } = usePositioned({
    anchorRef: triggerRef,
    side: 'right',
    align: 'start',
    offset: 2,
    open,
  });

  const registerLive = useRef(registerRef);
  registerLive.current = registerRef;
  const setRef = useCallback((el: HTMLButtonElement | null) => {
    triggerRef.current = el;
    registerLive.current(el);
  }, []);

  const dismissSelf = useCallback(() => {
    onDismissSelf();
    triggerRef.current?.focus({ preventScroll: true });
  }, [onDismissSelf]);

  return (
    <>
      <MenuItemButton
        item={item}
        active={active}
        submenu
        submenuOpen={open}
        buttonRef={setRef}
        onPointerEnter={onPointerEnter}
        onClick={onOpen}
      />
      {open && (
        <Portal>
          <div
            ref={panelRef}
            style={style}
            className={MENU_SURFACE_CLASS}
            data-menu-surface=""
            onPointerEnter={onSurfaceHover}
          >
            <MenuList
              items={item.items ?? []}
              ariaLabel={item.label}
              depth={depth + 1}
              autoFocusFirst={autoFocusFirst}
              onClose={onCloseAll}
              onDismissSelf={dismissSelf}
            />
          </div>
        </Portal>
      )}
    </>
  );
}

// ── list ────────────────────────────────────────────────────────────────────

export interface MenuListProps {
  items: MenuItemSpec[];
  /** Dismisses the whole menu tree — called once a leaf item has run. */
  onClose: () => void;
  /** Dismisses only this level; the root passes the same callback as `onClose`. */
  onDismissSelf?: () => void;
  autoFocusFirst?: boolean;
  ariaLabel: string;
  depth?: number;
  className?: string;
}

export function MenuList({
  items,
  onClose,
  onDismissSelf,
  autoFocusFirst = false,
  ariaLabel,
  depth = 0,
  className,
}: MenuListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ id: string; keyboard: boolean } | null>(null);
  const typeahead = useRef({ buffer: '', at: 0 });
  const closeTimer = useRef<number | undefined>(undefined);

  const dismissSelf = onDismissSelf ?? onClose;

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  }, []);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const firstEnabled = items.findIndex((item) => item.disabled !== true);

  useEffect(() => {
    if (autoFocusFirst && firstEnabled >= 0) setActive(firstEnabled);
    // A mouse-opened menu keeps focus on the surface so type-ahead and the
    // arrow keys work without pre-highlighting a row.
    else listRef.current?.focus({ preventScroll: true });
    // Mount only: later prop changes must not yank focus back.
  }, []);

  useEffect(() => {
    if (active < 0) return;
    itemRefs.current[active]?.focus({ preventScroll: true });
  }, [active]);

  const move = (direction: 1 | -1) => {
    const n = items.length;
    if (n === 0) return;
    let index = active;
    for (let hop = 0; hop < n; hop += 1) {
      index = index < 0 ? (direction === 1 ? 0 : n - 1) : (index + direction + n) % n;
      const candidate = items[index];
      if (candidate && candidate.disabled !== true) {
        setActive(index);
        return;
      }
    }
  };

  const activate = (index: number, viaKeyboard: boolean) => {
    const item = items[index];
    if (!item || item.disabled === true) return;
    if (hasSubmenu(item)) {
      clearCloseTimer();
      setSub({ id: item.id, keyboard: viaKeyboard });
      return;
    }
    item.onSelect?.();
    onClose();
  };

  const hoverItem = (index: number) => {
    const item = items[index];
    if (!item || item.disabled === true) return;
    setActive(index);
    if (hasSubmenu(item)) {
      clearCloseTimer();
      setSub((prev) => (prev?.id === item.id ? prev : { id: item.id, keyboard: false }));
      return;
    }
    if (!sub) return;
    // Give the pointer a moment to reach the submenu, which sits past the
    // sibling rows it has to travel over.
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = undefined;
      setSub(null);
    }, SUBMENU_GRACE_MS);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        if (firstEnabled >= 0) setActive(firstEnabled);
        return;
      case 'End': {
        event.preventDefault();
        event.stopPropagation();
        for (let i = items.length - 1; i >= 0; i -= 1) {
          const item = items[i];
          if (item && item.disabled !== true) {
            setActive(i);
            return;
          }
        }
        return;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        activate(active, true);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        if (sub) {
          setSub(null);
          itemRefs.current[active]?.focus({ preventScroll: true });
        } else {
          dismissSelf();
        }
        return;
      case 'ArrowRight': {
        const item = items[active];
        if (item && hasSubmenu(item)) {
          event.preventDefault();
          event.stopPropagation();
          clearCloseTimer();
          setSub({ id: item.id, keyboard: true });
        }
        return;
      }
      case 'ArrowLeft':
        event.preventDefault();
        event.stopPropagation();
        if (sub) {
          setSub(null);
          itemRefs.current[active]?.focus({ preventScroll: true });
        } else if (depth > 0) {
          dismissSelf();
        }
        return;
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      default:
        break;
    }

    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    const now = Date.now();
    const buffer =
      (now - typeahead.current.at < TYPEAHEAD_WINDOW_MS ? typeahead.current.buffer : '') + fold(event.key);
    typeahead.current = { buffer, at: now };
    const found = items.findIndex(
      (item) => item.disabled !== true && fold(item.label).startsWith(buffer),
    );
    if (found >= 0) {
      event.preventDefault();
      event.stopPropagation();
      setActive(found);
    }
  };

  return (
    <div
      ref={listRef}
      role="menu"
      aria-label={ariaLabel}
      aria-orientation="vertical"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={clsx('flex flex-col outline-none', className)}
    >
      {items.map((item, index) => {
        const registerRef = (el: HTMLButtonElement | null) => {
          itemRefs.current[index] = el;
        };
        return (
          <Fragment key={item.id}>
            {item.separatorBefore === true && index > 0 && (
              <div role="separator" aria-hidden="true" className="my-1 h-px shrink-0 bg-line" />
            )}
            {hasSubmenu(item) ? (
              <MenuSubItem
                item={item}
                active={active === index}
                open={sub?.id === item.id}
                autoFocusFirst={sub?.id === item.id && sub.keyboard}
                depth={depth}
                registerRef={registerRef}
                onPointerEnter={() => hoverItem(index)}
                onOpen={() => activate(index, false)}
                onDismissSelf={() => setSub(null)}
                onCloseAll={onClose}
                onSurfaceHover={clearCloseTimer}
              />
            ) : (
              <MenuItemButton
                item={item}
                active={active === index}
                submenu={false}
                submenuOpen={false}
                buttonRef={registerRef}
                onPointerEnter={() => hoverItem(index)}
                onClick={() => activate(index, false)}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ── trigger ─────────────────────────────────────────────────────────────────

interface TriggerInjected {
  ref?: Ref<HTMLElement>;
  onClick?: MouseEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  'aria-haspopup'?: 'menu';
  'aria-expanded'?: boolean;
}

export function DropdownMenu({
  items,
  children,
  side = 'bottom',
  align = 'start',
  className,
}: DropdownMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [fromKeyboard, setFromKeyboard] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  const { style, ref: panelRef } = usePositioned({
    anchorRef: triggerRef,
    side,
    align,
    offset: 6,
    open,
  });

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useClickOutside([panelRef, triggerRef], () => setOpen(false), open, `[${MENU_SURFACE_ATTR}]`);

  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      const panel = panelRef.current;
      if (panel && event.target instanceof Node && panel.contains(event.target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, panelRef]);

  const child = children as ReactElement<TriggerInjected>;
  const childRef = (child as unknown as { ref?: Ref<HTMLElement> }).ref;

  const setTriggerRef = useCallback(
    (el: HTMLElement | null) => {
      triggerRef.current = el;
      if (typeof childRef === 'function') childRef(el);
      else if (childRef && typeof childRef === 'object') {
        (childRef as { current: HTMLElement | null }).current = el;
      }
    },
    [childRef],
  );

  const trigger = cloneElement(child, {
    ref: setTriggerRef,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onClick: (event) => {
      child.props.onClick?.(event);
      setFromKeyboard(false);
      setOpen((prev) => !prev);
    },
    onKeyDown: (event) => {
      child.props.onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setFromKeyboard(true);
        setOpen(true);
      }
    },
  });

  return (
    <>
      {trigger}
      {open && (
        <Portal>
          <div
            ref={panelRef}
            style={style}
            data-menu-surface=""
            className={clsx(MENU_SURFACE_CLASS, className)}
          >
            <MenuList
              items={items}
              ariaLabel={t('common.more')}
              autoFocusFirst={fromKeyboard}
              onClose={close}
              onDismissSelf={close}
            />
          </div>
        </Portal>
      )}
    </>
  );
}
