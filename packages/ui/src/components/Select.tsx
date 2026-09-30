import clsx from 'clsx';

import { viewportSize } from '../hooks/viewport';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from '../icons';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
  label?: string;
  placeholder?: string;
  size?: 'sm' | 'md';
  className?: string;
}

interface Box {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

const SIZE: Record<'sm' | 'md', string> = {
  sm: 'h-8 px-2.5 text-[13px]',
  md: 'h-10 px-3 text-sm',
};

const TYPE_AHEAD_RESET_MS = 600;

/**
 * A real listbox rather than a native `<select>`: WebKitGTK gives the native
 * popup its own unstyleable chrome, which looks broken next to the app shell.
 */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  label,
  placeholder,
  size = 'md',
  className,
}: SelectProps<T>) {
  const autoId = useId();
  const buttonId = `select-${autoId}`;
  const listId = `${buttonId}-list`;
  const labelId = `${buttonId}-label`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [box, setBox] = useState<Box | null>(null);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const typeAhead = useRef({ buffer: '', at: 0 });

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const { width: viewportW, height: viewportH } = viewportSize();
    const below = viewportH - rect.bottom - 12;
    const above = rect.top - 12;
    const useAbove = below < 200 && above > below;
    const maxHeight = Math.max(120, Math.min(340, useAbove ? above : below));
    const width = Math.max(rect.width, 180);
    setBox({
      left: Math.max(8, Math.min(rect.left, viewportW - width - 8)),
      top: useAbove ? rect.top - 6 : rect.bottom + 6,
      width,
      maxHeight,
      above: useAbove,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onViewportChange = () => place();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const firstEnabled = () => options.findIndex((option) => !option.disabled);
  const lastEnabled = () => {
    for (let i = options.length - 1; i >= 0; i -= 1) {
      const option = options[i];
      if (option && !option.disabled) return i;
    }
    return -1;
  };

  const step = (from: number, dir: 1 | -1) => {
    if (options.length === 0) return -1;
    let index = from < 0 ? (dir === 1 ? -1 : 0) : from;
    for (let n = 0; n < options.length; n += 1) {
      index = (index + dir + options.length) % options.length;
      const option = options[index];
      if (option && !option.disabled) return index;
    }
    return from;
  };

  const openMenu = (index?: number) => {
    const fallback = selectedIndex >= 0 ? selectedIndex : firstEnabled();
    setActiveIndex(index ?? fallback);
    setOpen(true);
  };

  const closeMenu = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu();
  };

  const handleButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(lastEnabled());
    }
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((prev) => step(prev, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((prev) => step(prev, -1));
        return;
      case 'Home':
        event.preventDefault();
        setActiveIndex(firstEnabled());
        return;
      case 'End':
        event.preventDefault();
        setActiveIndex(lastEnabled());
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(activeIndex);
        return;
      case 'Escape':
        event.preventDefault();
        closeMenu();
        return;
      case 'Tab':
        closeMenu();
        return;
      default:
        break;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const state = typeAhead.current;
      state.buffer = now - state.at > TYPE_AHEAD_RESET_MS ? event.key : state.buffer + event.key;
      state.at = now;
      const needle = state.buffer.toLocaleLowerCase();
      const found = options.findIndex(
        (option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(needle),
      );
      if (found >= 0) setActiveIndex(found);
    }
  };

  return (
    <div className={clsx('inline-flex min-w-0 flex-col gap-1.5', className)}>
      {label ? (
        <span id={labelId} className="text-[13px] font-medium text-text-dim">
          {label}
        </span>
      ) : null}

      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={label ? labelId : undefined}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={handleButtonKeyDown}
        className={clsx(
          'inline-flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 font-medium',
          'transition-[border-color,background-color] duration-150 ease-swift hover:border-text-faint',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          SIZE[size],
        )}
      >
        <span className={clsx('truncate', selected ? 'text-text' : 'text-text-faint')}>
          {selected ? selected.label : (placeholder ?? '')}
        </span>
        <ChevronDown
          className={clsx(
            'h-4 w-4 shrink-0 text-text-faint transition-transform duration-200 ease-swift',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && box
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-labelledby={label ? labelId : buttonId}
              aria-activedescendant={activeIndex >= 0 ? `${buttonId}-opt-${activeIndex}` : undefined}
              onKeyDown={handleListKeyDown}
              className="fixed z-[180] animate-fade-in overflow-y-auto rounded-lg border border-line bg-surface-2 p-1 shadow-pop outline-none scrollbar-thin"
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                maxHeight: box.maxHeight,
                transform: box.above ? 'translateY(-100%)' : undefined,
              }}
            >
              {options.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === activeIndex;
                return (
                  <div
                    key={option.value}
                    id={`${buttonId}-opt-${index}`}
                    data-idx={index}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    onPointerEnter={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                    onClick={() => commit(index)}
                    className={clsx(
                      'flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-sm',
                      option.disabled && 'cursor-not-allowed opacity-40',
                      isActive && !option.disabled ? 'bg-surface-3' : 'bg-transparent',
                    )}
                  >
                    <span className="grid h-5 w-4 shrink-0 place-items-center">
                      {isSelected ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className={clsx('truncate text-text', isSelected && 'font-semibold')}>
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="text-[12px] leading-snug text-text-faint">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
