import clsx from 'clsx';
import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { TabItem } from './Tabs';

export interface SegmentedControlProps<T extends string = string> {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string = string>({
  items,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  const idsKey = items.map((item) => item.id).join('|');

  useLayoutEffect(() => {
    const measure = () => {
      const track = trackRef.current;
      const active = itemRefs.current.get(value);
      if (!track || !active) return;
      const trackRect = track.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const left = activeRect.left - trackRect.left + track.scrollLeft;
      const width = activeRect.width;
      setThumb((prev) =>
        prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.width - width) < 0.5
          ? prev
          : { left, width },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    const track = trackRef.current;
    if (track) observer.observe(track);
    const active = itemRefs.current.get(value);
    if (active) observer.observe(active);
    return () => observer.disconnect();
  }, [value, idsKey]);

  const select = (index: number) => {
    const target = items[index];
    if (!target) return;
    onChange(target.id);
    itemRefs.current.get(target.id)?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (items.length === 0) return;
    const current = items.findIndex((item) => item.id === value);
    const from = current < 0 ? 0 : current;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        select((from + 1) % items.length);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        select((from - 1 + items.length) % items.length);
        break;
      case 'Home':
        event.preventDefault();
        select(0);
        break;
      case 'End':
        event.preventDefault();
        select(items.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      onKeyDown={handleKeyDown}
      className={clsx(
        'relative inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-full bg-surface-2 p-1 scrollbar-thin',
        className,
      )}
    >
      {thumb ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 left-0 top-1 rounded-full bg-surface-3 transition-[transform,width] duration-300 ease-swift"
          style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
        />
      ) : null}

      {items.map((item) => {
        const selected = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) itemRefs.current.set(item.id, el);
              else itemRefs.current.delete(item.id);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={clsx(
              'relative z-[1] inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5',
              'text-[13px] font-semibold transition-colors duration-150 ease-swift',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              selected ? 'text-text' : 'text-text-dim hover:text-text',
            )}
          >
            {Icon ? <Icon className="h-4 w-4" /> : null}
            <span>{item.label}</span>
            {item.count !== undefined ? (
              <span className="tnum text-[11px] opacity-70">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
