import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Track, Uri } from '@ritmo/core';
import { useContextMenu } from '../hooks/useContextMenu';
import { useTranslation } from '../hooks/useTranslation';
import { ChevronDown, ChevronUp, Clock } from '../icons';
import { Skeleton } from './Skeleton';
import { TrackRow, trackRowGridClass } from './TrackRow';
import type { TrackRowPending } from './TrackRow';
import type { MenuItemSpec } from './DropdownMenu';

export interface TrackTableColumn {
  id: 'index' | 'title' | 'album' | 'added' | 'duration' | 'plays';
  sortable?: boolean;
  width?: string;
}

export interface TrackTableProps {
  tracks: Track[];
  columns?: TrackTableColumn[];
  currentUri?: Uri;
  playing?: boolean;
  likedSet?: Set<Uri>;
  offlineSet?: Set<Uri>;
  hideAlbum?: boolean;
  sort?: { column: TrackTableColumn['id']; dir: 'asc' | 'desc' };
  onSort?: (column: TrackTableColumn['id']) => void;
  onPlay: (index: number) => void;
  onToggleLike?: (track: Track) => void;
  menuItemsFor?: (track: Track, index: number) => MenuItemSpec[];
  /** Adds a trailing remove control to every row, next to the row menu. */
  onRemoveTrack?: (track: Track, index: number) => void;
  /** What that control announces; required whenever `onRemoveTrack` is given. */
  removeLabel?: string;
  /** Rows carrying an edit the user has staged but not saved yet. */
  pendingRows?: ReadonlyMap<Uri, TrackRowPending>;
  /** What each of those readings announces. */
  pendingLabels?: Readonly<Record<TrackRowPending, string>>;
  /** Overrides `removeLabel` on a row staged for removal, where it undoes. */
  restoreLabel?: string;
  /** Enables Shift/Ctrl range selection and returns the selected set. */
  selectable?: boolean;
  onSelectionChange?: (uris: Set<Uri>) => void;
  /** Called when the viewport nears the end — drives keyset paging. */
  onEndReached?: () => void;
  loading?: boolean;
  emptyState?: React.ReactNode;
  /** Additive: chooses the row chrome and the default row height. */
  variant?: 'list' | 'compact';
  /** Fixed row height in px; required by the virtualiser. */
  rowHeight?: number;
  className?: string;
}

const DEFAULT_COLUMNS: TrackTableColumn[] = [
  { id: 'index' },
  { id: 'title', sortable: true },
  { id: 'album', sortable: true },
  { id: 'duration', sortable: true },
];

const SKELETON_ROWS = 8;
/** How many rows from the bottom `onEndReached` should fire at. */
const END_THRESHOLD = 6;

export function TrackTable({
  tracks,
  columns,
  currentUri,
  playing = false,
  likedSet,
  offlineSet,
  hideAlbum = false,
  sort,
  onSort,
  onPlay,
  onToggleLike,
  menuItemsFor,
  onRemoveTrack,
  removeLabel,
  pendingRows,
  pendingLabels,
  restoreLabel,
  selectable = false,
  onSelectionChange,
  onEndReached,
  loading = false,
  emptyState,
  variant = 'list',
  rowHeight,
  className,
}: TrackTableProps) {
  const { t } = useTranslation();
  const openContextMenu = useContextMenu();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowNodes = useRef(new Map<number, HTMLDivElement>());
  const wantFocus = useRef(false);
  const endFiredFor = useRef(-1);

  const [cursor, setCursor] = useState(-1);
  const [anchor, setAnchor] = useState(-1);
  const [selected, setSelected] = useState<Set<Uri>>(() => new Set());

  const height = rowHeight ?? (variant === 'compact' ? 44 : 56);
  const cols = columns ?? DEFAULT_COLUMNS;

  const shape = useMemo(() => {
    const ids = new Set(cols.map((c) => c.id));
    return {
      hasIndex: ids.has('index'),
      showAlbum: !hideAlbum && ids.has('album'),
      sortableOf: (id: TrackTableColumn['id']) => cols.some((c) => c.id === id && c.sortable === true),
    };
  }, [cols, hideAlbum]);

  const grid = trackRowGridClass({
    variant,
    hasIndex: shape.hasIndex,
    hasArtwork: variant !== 'compact',
    hasAlbum: shape.showAlbum,
    hasRemove: onRemoveTrack !== undefined,
  });

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => height,
    overscan: 8,
    getItemKey: (i) => tracks[i]?.uri ?? i,
  });
  const virtualItems = virtualizer.getVirtualItems();

  const commitSelection = useCallback(
    (next: Set<Uri>) => {
      setSelected(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );

  const selectRange = useCallback(
    (from: number, to: number) => {
      const lo = Math.max(0, Math.min(from, to));
      const hi = Math.min(tracks.length - 1, Math.max(from, to));
      const next = new Set<Uri>();
      for (let i = lo; i <= hi; i += 1) {
        const track = tracks[i];
        if (track) next.add(track.uri);
      }
      commitSelection(next);
    },
    [commitSelection, tracks],
  );

  const moveCursor = useCallback(
    (to: number, extend: boolean) => {
      if (tracks.length === 0) return;
      const next = Math.max(0, Math.min(tracks.length - 1, to));
      setCursor(next);
      wantFocus.current = true;
      virtualizer.scrollToIndex(next, { align: 'auto' });
      if (extend && selectable) {
        const base = anchor >= 0 ? anchor : next;
        if (anchor < 0) setAnchor(next);
        selectRange(base, next);
      } else if (!extend) {
        setAnchor(next);
      }
    },
    [anchor, selectRange, selectable, tracks.length, virtualizer],
  );

  // Focus follows the virtualiser: the row may only exist after the scroll lands.
  useEffect(() => {
    if (!wantFocus.current || cursor < 0) return;
    const node = rowNodes.current.get(cursor);
    if (node) {
      node.focus({ preventScroll: true });
      wantFocus.current = false;
    }
  }, [cursor, virtualItems]);

  useEffect(() => {
    endFiredFor.current = -1;
  }, [tracks.length]);

  useEffect(() => {
    if (!onEndReached || loading || tracks.length === 0) return;
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= tracks.length - 1 - END_THRESHOLD && endFiredFor.current !== tracks.length) {
      endFiredFor.current = tracks.length;
      onEndReached();
    }
  }, [loading, onEndReached, tracks.length, virtualItems]);

  const handleRowClick = useCallback(
    (i: number, e: React.MouseEvent) => {
      setCursor(i);
      if (!selectable) {
        setAnchor(i);
        return;
      }
      const track = tracks[i];
      if (!track) return;
      if (e.shiftKey && anchor >= 0) {
        selectRange(anchor, i);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(selected);
        if (next.has(track.uri)) next.delete(track.uri);
        else next.add(track.uri);
        setAnchor(i);
        commitSelection(next);
        return;
      }
      setAnchor(i);
      commitSelection(new Set([track.uri]));
    },
    [anchor, commitSelection, selectRange, selectable, selected, tracks],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // A row already handled Enter itself; don't play twice.
      if (e.defaultPrevented) return;
      const key = e.key;
      if (key === 'ArrowDown') {
        e.preventDefault();
        moveCursor(cursor < 0 ? 0 : cursor + 1, e.shiftKey);
      } else if (key === 'ArrowUp') {
        e.preventDefault();
        moveCursor(cursor < 0 ? 0 : cursor - 1, e.shiftKey);
      } else if (key === 'Home') {
        e.preventDefault();
        moveCursor(0, e.shiftKey);
      } else if (key === 'End') {
        e.preventDefault();
        moveCursor(tracks.length - 1, e.shiftKey);
      } else if (key === 'Enter') {
        if (cursor >= 0 && cursor < tracks.length) {
          e.preventDefault();
          onPlay(cursor);
        }
      } else if (key === ' ' || key === 'Spacebar') {
        if (!selectable || cursor < 0) return;
        const track = tracks[cursor];
        if (!track) return;
        e.preventDefault();
        const next = new Set(selected);
        if (next.has(track.uri)) next.delete(track.uri);
        else next.add(track.uri);
        commitSelection(next);
      } else if ((e.ctrlKey || e.metaKey) && (key === 'a' || key === 'A')) {
        if (!selectable) return;
        e.preventDefault();
        commitSelection(new Set(tracks.map((tr) => tr.uri)));
      } else if (key === 'Escape') {
        if (selected.size === 0) return;
        e.preventDefault();
        commitSelection(new Set());
      }
    },
    [commitSelection, cursor, moveCursor, onPlay, selectable, selected, tracks],
  );

  const showEmpty = tracks.length === 0 && !loading;

  return (
    <div className={clsx('flex min-h-0 min-w-0 flex-col', className)}>
      <div
        ref={scrollRef}
        role="grid"
        aria-rowcount={tracks.length}
        aria-multiselectable={selectable}
        onKeyDown={handleKeyDown}
        className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
      >
        <div
          role="row"
          className={clsx(
            'sticky top-0 z-10 grid h-8 min-w-0 items-center gap-3 border-b border-line bg-bg/95 px-3 backdrop-blur',
            grid,
          )}
        >
          {shape.hasIndex ? (
            <HeaderCell
              label="#"
              align="center"
              columnId="index"
              sortable={shape.sortableOf('index')}
              sort={sort}
              onSort={onSort}
            />
          ) : null}
          {variant !== 'compact' ? <div role="columnheader" /> : null}
          <HeaderCell
            label={t('library.tracks')}
            columnId="title"
            sortable={shape.sortableOf('title')}
            sort={sort}
            onSort={onSort}
          />
          {shape.showAlbum ? (
            <HeaderCell
              label={t('library.albums')}
              columnId="album"
              sortable={shape.sortableOf('album')}
              sort={sort}
              onSort={onSort}
            />
          ) : null}
          <div role="columnheader" />
          <div role="columnheader" />
          <HeaderCell
            icon={Clock}
            srLabel={t('library.sortDuration')}
            columnId="duration"
            align="end"
            sortable={shape.sortableOf('duration')}
            sort={sort}
            onSort={onSort}
          />
          <div role="columnheader" />
          {onRemoveTrack ? <div role="columnheader" /> : null}
        </div>

        <div
          role="rowgroup"
          className="relative min-w-0"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualItems.map((item) => {
            const track = tracks[item.index];
            if (!track) return null;
            const isCurrent = currentUri !== undefined && track.uri === currentUri;
            const pending = pendingRows?.get(track.uri);
            return (
              <div
                key={item.key}
                className="absolute left-0 top-0 w-full max-w-full"
                style={{ height, transform: `translateY(${item.start}px)` }}
              >
                <TrackRow
                  ref={(node) => {
                    if (node) rowNodes.current.set(item.index, node);
                    else rowNodes.current.delete(item.index);
                  }}
                  track={track}
                  index={shape.hasIndex ? item.index + 1 : undefined}
                  variant={variant}
                  active={isCurrent}
                  playing={isCurrent && playing}
                  liked={likedSet?.has(track.uri) ?? false}
                  offline={offlineSet?.has(track.uri) ?? false}
                  selected={selected.has(track.uri)}
                  hideAlbum={!shape.showAlbum}
                  onPlay={() => onPlay(item.index)}
                  {...(onToggleLike ? { onToggleLike: () => onToggleLike(track) } : {})}
                  onClick={(e) => handleRowClick(item.index, e)}
                  tabIndex={cursor === item.index || (cursor < 0 && item.index === 0) ? 0 : -1}
                  {...(menuItemsFor
                    ? {
                        menuItems: menuItemsFor(track, item.index),
                        // Right click opens the same list the row menu shows, so
                        // neither can quietly offer less than the other.
                        onContextMenu: (e: React.MouseEvent) =>
                          openContextMenu(e, menuItemsFor(track, item.index)),
                      }
                    : {})}
                  {...(onRemoveTrack
                    ? {
                        onRemove: () => onRemoveTrack(track, item.index),
                        removeLabel:
                          pending === 'remove' && restoreLabel !== undefined
                            ? restoreLabel
                            : removeLabel,
                      }
                    : {})}
                  {...(pending === undefined
                    ? {}
                    : { pending, ...(pendingLabels ? { pendingLabel: pendingLabels[pending] } : {}) })}
                />
              </div>
            );
          })}
        </div>

        {loading ? (
          <div aria-live="polite" aria-busy="true" aria-label={t('common.loading')}>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <div
                key={i}
                className={clsx('grid min-w-0 items-center gap-3 border-b border-line/50 px-3', grid)}
                style={{ height }}
              >
                {shape.hasIndex ? <Skeleton className="h-3 w-4" rounded="sm" /> : null}
                {variant !== 'compact' ? <Skeleton className="h-10 w-10" rounded="sm" /> : null}
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
                {shape.showAlbum ? <Skeleton className="h-3 w-2/5" /> : null}
                <div />
                <div />
                <Skeleton className="h-3 w-8" />
                <div />
                {onRemoveTrack ? <div /> : null}
              </div>
            ))}
          </div>
        ) : null}

        {showEmpty ? <div className="py-10">{emptyState}</div> : null}
      </div>
    </div>
  );
}

const HEADER_CELL =
  'mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-faint';

interface HeaderCellProps {
  label?: string;
  /** Used instead of a label where the column is too narrow for words. */
  icon?: React.ComponentType<{ className?: string }>;
  srLabel?: string;
  columnId: TrackTableColumn['id'];
  sortable: boolean;
  align?: 'start' | 'center' | 'end';
  sort?: { column: TrackTableColumn['id']; dir: 'asc' | 'desc' };
  onSort?: (column: TrackTableColumn['id']) => void;
}

function HeaderCell({ label, icon: Icon, srLabel, columnId, sortable, align = 'start', sort, onSort }: HeaderCellProps) {
  const activeSort = sort?.column === columnId ? sort.dir : undefined;
  const justify = align === 'end' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  const content = (
    <>
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
      {label !== undefined ? (
        <span
          aria-hidden={srLabel !== undefined ? 'true' : undefined}
          className="min-w-0 truncate"
        >
          {label}
        </span>
      ) : null}
      {srLabel !== undefined ? <span className="sr-only">{srLabel}</span> : null}
      {activeSort ? (
        activeSort === 'asc' ? (
          <ChevronUp className="h-3 w-3 shrink-0 text-accent" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-accent" />
        )
      ) : null}
    </>
  );

  if (!sortable || !onSort) {
    return (
      <div
        role="columnheader"
        className={clsx('flex min-w-0 items-center gap-1 overflow-hidden', HEADER_CELL, justify)}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      role="columnheader"
      aria-sort={activeSort === 'asc' ? 'ascending' : activeSort === 'desc' ? 'descending' : 'none'}
      className={clsx('flex min-w-0 items-center overflow-hidden', justify)}
    >
      <button
        type="button"
        onClick={() => onSort(columnId)}
        className={clsx(
          'flex min-w-0 max-w-full items-center gap-1 rounded-xs outline-none transition-colors hover:text-text',
          'focus-visible:ring-2 focus-visible:ring-accent',
          HEADER_CELL,
          activeSort && 'text-text',
        )}
      >
        {content}
      </button>
    </div>
  );
}
