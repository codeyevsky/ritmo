import clsx from 'clsx';
import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { IconComponent } from '../icons';

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  count?: number;
  icon?: IconComponent;
}

export interface TabsProps<T extends string = string> {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  variant?: 'underline' | 'pill';
  className?: string;
}

export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  variant = 'underline',
  className,
}: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  // A stable dep: `items` is usually a fresh array literal on every render.
  const idsKey = items.map((item) => item.id).join('|');

  useLayoutEffect(() => {
    if (variant !== 'underline') return;

    const measure = () => {
      const list = listRef.current;
      const active = tabRefs.current.get(value);
      if (!list || !active) return;
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const left = activeRect.left - listRect.left + list.scrollLeft;
      const width = activeRect.width;
      setIndicator((prev) =>
        prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.width - width) < 0.5
          ? prev
          : { left, width },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    const list = listRef.current;
    if (list) observer.observe(list);
    const active = tabRefs.current.get(value);
    if (active) observer.observe(active);
    return () => observer.disconnect();
  }, [value, idsKey, variant]);

  const focusTab = (index: number) => {
    const target = items[index];
    if (!target) return;
    onChange(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const current = items.findIndex((item) => item.id === value);
    const from = current < 0 ? 0 : current;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab((from + 1) % items.length);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab((from - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(items.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={handleKeyDown}
      className={clsx(
        'relative flex items-center overflow-x-auto scrollbar-thin',
        variant === 'underline' ? 'gap-6 border-b border-line' : 'gap-1',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) tabRefs.current.set(item.id, el);
              else tabRefs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={clsx(
              'inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold',
              'transition-colors duration-150 ease-swift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              variant === 'underline'
                ? clsx(
                    'h-10 rounded-sm text-sm',
                    selected ? 'text-text' : 'text-text-dim hover:text-text',
                  )
                : clsx(
                    'h-8 rounded-full px-3.5 text-[13px]',
                    selected
                      ? 'bg-surface-3 text-text'
                      : 'text-text-dim hover:bg-surface-2 hover:text-text',
                  ),
            )}
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
            <span>{item.label}</span>
            {item.count !== undefined ? (
              <span
                className={clsx(
                  'tnum rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
                  selected ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-text-faint',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}

      {variant === 'underline' && indicator ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 h-[2px] rounded-full bg-accent transition-[transform,width] duration-300 ease-swift"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      ) : null}
    </div>
  );
}
