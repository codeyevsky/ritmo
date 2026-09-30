import clsx from 'clsx';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { QueueItem } from '@ritmo/core';

import type { MenuItemSpec } from '../components';
import { Button, EmptyState, TrackRow } from '../components';
import { useQueue, useToast, useTranslation } from '../hooks';
import { IconQueue, IconTrash } from '../icons';
import { entityPath } from '../routes';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';

export interface QueuePanelProps {
  className?: string;
}

interface DragState {
  itemId: string;
  from: number;
  /** Pointer delta applied to the lifted row. */
  dy: number;
  /** Insertion index within `upcoming`. */
  to: number;
  /** Indicator offset in px, relative to the scrolling section wrapper. */
  indicator: number;
}

function insertIndexFor(clientY: number, rects: DOMRect[]): number {
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    if (rect && clientY < rect.top + rect.height / 2) return i;
  }
  return rects.length;
}

export function QueuePanel({ className }: QueuePanelProps): JSX.Element {
  const { t } = useTranslation();
  const services = useServices();
  const navigate = useNavigate();
  const queue = useQueue();
  const { show } = useToast();

  const snapshot = usePlayerStore((s) => s.queue);
  const status = usePlayerStore((s) => s.status);
  const likedSet = useLibraryStore((s) => s.likedUris);
  const offlineSet = useLibraryStore((s) => s.offlineUris);

  const [drag, setDrag] = useState<DragState | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const upcoming = snapshot.upcoming;
  const queued = useMemo(() => upcoming.filter((item) => item.userQueued), [upcoming]);
  const fromContext = useMemo(() => upcoming.filter((item) => !item.userQueued), [upcoming]);
  /** Gutter line numbers count through the whole queue, not each section. */
  const positions = useMemo(
    () => new Map(upcoming.map((item, index) => [item.id, index + 1])),
    [upcoming],
  );

  const onPlayItem = useCallback(
    (item: QueueItem) => {
      void services.controller.playTrack(item.track, 'user');
    },
    [services],
  );

  const onToggleLike = useCallback(
    (item: QueueItem) => {
      void useLibraryStore.getState().toggleLike(item.track);
    },
    [services],
  );

  const menuItemsFor = useCallback(
    (item: QueueItem): MenuItemSpec[] => {
      const items: MenuItemSpec[] = [
        {
          id: 'remove',
          label: t('queue.remove'),
          icon: IconTrash,
          onSelect: () => queue.remove(item.id),
        },
      ];
      if (item.track.album) {
        const album = item.track.album;
        items.push({
          id: 'album',
          label: t('queue.goToAlbum'),
          separatorBefore: true,
          onSelect: () => navigate(entityPath(album.uri)),
        });
      }
      const artist = item.track.artists[0];
      if (artist) {
        items.push({
          id: 'artist',
          label: t('queue.goToArtist'),
          onSelect: () => navigate(entityPath(artist.uri)),
        });
      }
      return items;
    },
    [navigate, queue, t],
  );

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, itemId: string) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const wrapper = wrapperRef.current;
      if (!wrapper) return;

      const ids = upcoming.map((item) => item.id);
      const from = ids.indexOf(itemId);
      if (from < 0) return;
      const elements = ids.map((id) => rowRefs.current.get(id));
      if (elements.some((el) => !el)) return;
      const rects = elements
        .filter((el): el is HTMLElement => Boolean(el))
        .map((el) => el.getBoundingClientRect());

      const wrapperTop = wrapper.getBoundingClientRect().top;
      const startY = event.clientY;
      let target = from;
      let cancelled = false;

      const indicatorFor = (index: number): number => {
        const rect = rects[index];
        if (rect) return rect.top - wrapperTop;
        const last = rects[rects.length - 1];
        return last ? last.bottom - wrapperTop : 0;
      };

      setDrag({ itemId, from, dy: 0, to: from, indicator: indicatorFor(from) });

      const onMove = (e: PointerEvent) => {
        target = insertIndexFor(e.clientY, rects);
        setDrag({
          itemId,
          from,
          dy: e.clientY - startY,
          to: target,
          indicator: indicatorFor(target),
        });
      };
      const detach = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('keydown', onKey);
        setDrag(null);
      };
      const onUp = () => {
        detach();
        if (cancelled) return;
        // `move` takes the destination index in the list *after* the item has
        // been lifted out, so a downward move loses one slot.
        const destination = target > from ? target - 1 : target;
        if (destination === from) return;
        queue.move(itemId, destination);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        cancelled = true;
        detach();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKey);
    },
    [queue, upcoming],
  );

  const renderRow = useCallback(
    (item: QueueItem) => {
      const dy = drag !== null && drag.itemId === item.id ? drag.dy : null;
      const position = positions.get(item.id);
      return (
        <li
          key={item.id}
          ref={(el) => {
            if (el) rowRefs.current.set(item.id, el);
            else rowRefs.current.delete(item.id);
          }}
          className={clsx(
            'group relative border-b border-line/40 last:border-b-0',
            dy !== null && 'z-20 shadow-pop',
          )}
          style={dy !== null ? { transform: `translateY(${dy}px)` } : undefined}
        >
          {/* A gutter line number that yields to the drag handle on hover. */}
          {position !== undefined ? (
            <span
              aria-hidden="true"
              className="mono pointer-events-none absolute left-3 top-0 flex h-full w-7 items-center justify-center text-[10px] text-text-faint transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
            >
              {position}
            </span>
          ) : null}
          <TrackRow
            track={item.track}
            variant="queue"
            liked={likedSet.has(item.track.uri)}
            offline={offlineSet.has(item.track.uri)}
            onPlay={() => onPlayItem(item)}
            onToggleLike={() => onToggleLike(item)}
            onRemove={() => queue.remove(item.id)}
            menuItems={menuItemsFor(item)}
            dragHandleProps={{
              onPointerDown: (e) => startDrag(e, item.id),
              role: 'button',
              tabIndex: -1,
              'aria-label': t('queue.reorder'),
              className: 'cursor-grab touch-none',
            }}
            className={clsx(dy !== null && 'bg-surface-3')}
          />
        </li>
      );
    },
    [drag, likedSet, menuItemsFor, offlineSet, onPlayItem, onToggleLike, positions, queue, startDrag, t],
  );

  const hasAnything = Boolean(snapshot.current) || upcoming.length > 0;

  return (
    <div className={clsx('flex min-h-0 min-w-0 flex-col', className)}>
      <div className="flex min-w-0 items-center justify-between gap-3 px-3 py-2">
        <h2 className="rule-label min-w-0 flex-1">
          <span className="min-w-0 truncate">{t('queue.title')}</span>
        </h2>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          disabled={upcoming.length === 0}
          onClick={() => {
            queue.clearUpcoming();
            show({ title: t('queue.cleared'), tone: 'neutral' });
          }}
        >
          {t('queue.clear')}
        </Button>
      </div>

      {!hasAnything ? (
        <EmptyState
          icon={IconQueue}
          title={t('queue.empty')}
          body={t('queue.emptyBody')}
          action={{ label: t('nav.home'), onClick: () => navigate('/') }}
          className="p-6"
        />
      ) : (
        <div ref={wrapperRef} className="relative min-h-0 min-w-0 flex-1 pb-4">
          {drag ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-0 right-0 z-10 h-[2px] bg-accent"
              style={{ transform: `translateY(${drag.indicator}px)` }}
            />
          ) : null}

          {snapshot.current ? (
            <section aria-labelledby="queue-now">
              <h3 id="queue-now" className="rule-label px-3 pb-1.5 pt-2">
                <span className="min-w-0 truncate">{t('queue.nowPlaying')}</span>
              </h3>
              {/* The gutter bar marks the playhead; no filled row. */}
              <div className="gutter-mark">
                <TrackRow
                  track={snapshot.current.track}
                  variant="queue"
                  active
                  playing={status === 'playing'}
                  liked={likedSet.has(snapshot.current.track.uri)}
                  offline={offlineSet.has(snapshot.current.track.uri)}
                  onPlay={() => void services.controller.toggle()}
                  onToggleLike={() => {
                    const item = snapshot.current;
                    if (item) onToggleLike(item);
                  }}
                />
              </div>
            </section>
          ) : null}

          {queued.length > 0 ? (
            <section aria-labelledby="queue-next">
              <h3 id="queue-next" className="rule-label px-3 pb-1.5 pt-4">
                <span className="min-w-0 truncate">{t('queue.nextInQueue')}</span>
              </h3>
              <ul className="border-t border-line/40">{queued.map(renderRow)}</ul>
            </section>
          ) : null}

          {fromContext.length > 0 ? (
            <section aria-labelledby="queue-context">
              <h3 id="queue-context" className="rule-label px-3 pb-1.5 pt-4">
                <span className="min-w-0 truncate">
                  {snapshot.contextName
                    ? t('queue.nextFrom', { name: snapshot.contextName })
                    : t('queue.nextUp')}
                </span>
              </h3>
              <ul className="border-t border-line/40">{fromContext.map(renderRow)}</ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
