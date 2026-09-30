import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { formatDurationLong } from '@ritmo/core';
import type { Page, Track, Uri } from '@ritmo/core';

import {
  Button,
  DropdownMenu,
  EmptyState,
  ErrorBanner,
  IconButton,
  PlayButton,
  Skeleton,
  TrackTable,
} from '../components';
import type { MenuItemSpec, TrackTableColumn } from '../components';
import { useAsync, useQueue, useToast, useTranslation } from '../hooks';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';
import { Heart, MoreHorizontal, Search as SearchIcon } from '../icons';
import { useAddToPackItems } from '../shell/AddToPackMenu';
import { useAddToPlaylistItems } from '../shell/AddToPlaylistMenu';
import { useRemoveFromLibrary } from '../shell/RemoveFromLibrary';
import { useTrackDetails } from '../shell/TrackDetails';
import { useTrackDetailsEditor } from '../shell/TrackDetailsDialog';

const PAGE_SIZE = 200;
const CONTEXT_URI = 'ritmo:playlist:liked';
/** Long enough to read as an exit, short enough not to feel laggy. */
const EXIT_MS = 220;

const COLUMNS: TrackTableColumn[] = [
  { id: 'index', width: '3rem' },
  { id: 'title' },
  { id: 'album' },
  { id: 'added', width: '8rem' },
  { id: 'duration', width: '5rem' },
];

function errorBody(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function LikedSongsView(): ReactElement {
  const { library, controller, registry, host } = useServices();
  const { t, lang } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queue = useQueue();

  const offlineUris = useLibraryStore((s) => s.offlineUris);
  const currentUri = usePlayerStore((s) => s.current?.uri);
  const isPlaying = usePlayerStore((s) => s.status === 'playing');
  const contextUri = usePlayerStore((s) => s.queue.contextUri);
  const playingThis = isPlaying && contextUri === CONTEXT_URI;

  const [extra, setExtra] = useState<Array<Page<Track>>>([]);
  const [appending, setAppending] = useState(false);
  const [appendError, setAppendError] = useState<unknown>(undefined);
  const [removing, setRemoving] = useState<Set<Uri>>(new Set());
  const [removed, setRemoved] = useState<Set<Uri>>(new Set());
  const timers = useRef<number[]>([]);

  const loadPage = useCallback(
    (cursor?: string) => library.likes.listTracks({ limit: PAGE_SIZE, cursor }),
    [library],
  );

  const first = useAsync(() => loadPage(undefined), [loadPage], { keepPrevious: true });
  const count = useAsync(() => library.likes.count('track'), [library], { keepPrevious: true });
  const firstPage = first.data;

  useEffect(() => {
    setExtra([]);
    setAppendError(undefined);
    setRemoved(new Set());
    setRemoving(new Set());
  }, [firstPage]);

  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
    },
    [],
  );

  useEffect(() => {
    document.title = `${t('library.likedSongs')} · Ritmo`;
  }, [t]);

  const lastExtra = extra.length > 0 ? extra[extra.length - 1] : undefined;
  const cursor = lastExtra ? lastExtra.cursor : firstPage?.cursor;

  const loaded = useMemo(
    () => [...(firstPage?.items ?? []), ...extra.flatMap((page) => page.items)],
    [firstPage, extra],
  );
  const { itemsFor: editItems, applyEdits, dialog: editDialog } = useTrackDetailsEditor();
  const { itemsFor: detailsItems, dialog: detailsDialog } = useTrackDetails();
  const {
    itemsFor: removeItems,
    filterRemoved,
    dialog: removeDialog,
  } = useRemoveFromLibrary();
  const tracks = useMemo(
    () => filterRemoved(applyEdits(loaded.filter((track) => !removed.has(track.uri)))),
    [applyEdits, filterRemoved, loaded, removed],
  );

  const loadMore = useCallback(() => {
    if (appending || cursor === undefined) return;
    setAppending(true);
    setAppendError(undefined);
    loadPage(cursor)
      .then((page) => setExtra((prev) => [...prev, page]))
      .catch((e: unknown) => setAppendError(e))
      .finally(() => setAppending(false));
  }, [appending, cursor, loadPage]);

  // Only rows fetched so far can be measured; the exact total is not exposed.
  const loadedMs = useMemo(() => tracks.reduce((sum, track) => sum + track.durationMs, 0), [tracks]);
  const total = count.data ?? tracks.length;
  const addToPlaylist = useAddToPlaylistItems(tracks);
  const addToPack = useAddToPackItems(tracks);

  /**
   * Un-liking keeps the row in place with an empty heart for a beat, then drops
   * it — the virtualiser owns the row element, so the fade lives on the list.
   */
  const unlike = useCallback(
    (track: Track) => {
      void useLibraryStore.getState().toggleEntityLike(track.uri, 'track', track);
      setRemoving((prev) => new Set(prev).add(track.uri));
      const id = window.setTimeout(() => {
        setRemoved((prev) => new Set(prev).add(track.uri));
        setRemoving((prev) => {
          const next = new Set(prev);
          next.delete(track.uri);
          return next;
        });
      }, EXIT_MS);
      timers.current.push(id);
    },
    [library],
  );

  const relike = useCallback(
    (track: Track) => {
      void useLibraryStore.getState().toggleEntityLike(track.uri, 'track', track);
      setRemoved((prev) => {
        const next = new Set(prev);
        next.delete(track.uri);
        return next;
      });
      setRemoving((prev) => {
        const next = new Set(prev);
        next.delete(track.uri);
        return next;
      });
    },
    [library],
  );

  const likedSet = useMemo(
    () => new Set(tracks.filter((track) => !removing.has(track.uri)).map((track) => track.uri)),
    [tracks, removing],
  );

  const play = useCallback(
    (index: number) => {
      if (tracks.length === 0) return;
      void controller.playContext(tracks, index, { uri: CONTEXT_URI, name: t('library.likedSongs') });
    },
    [controller, tracks, t],
  );

  const shuffle = useCallback(() => {
    if (tracks.length === 0) return;
    void (async () => {
      await controller.setShuffle(true);
      await controller.playContext(tracks, Math.floor(Math.random() * tracks.length), {
        uri: CONTEXT_URI,
        name: t('library.likedSongs'),
      });
    })();
  }, [controller, tracks, t]);

  const download = useCallback(() => {
    if (tracks.length === 0) return;
    // Re-pushing the same id updates one toast in place instead of stacking.
    const id = `download:${CONTEXT_URI}`;
    const title = t('playlist.downloading', { count: tracks.length });
    void (async () => {
      toast.toast({ id, title, progress: 0, durationMs: 0 });
      let done = 0;
      let failed = 0;
      for (const track of tracks) {
        try {
          const stream = await registry.resolveStream(track);
          await library.offline.download(track, stream);
        } catch {
          failed += 1;
        }
        done += 1;
        toast.toast({ id, title, progress: done / tracks.length, durationMs: 0 });
      }
      toast.toast({
        id,
        title: failed === 0 ? t('common.downloaded') : t('errors.downloadPartial', { count: failed }),
        tone: failed === 0 ? 'success' : 'warn',
        progress: 1,
      });
    })();
  }, [tracks, toast, t, registry, library]);

  const menuItems = useMemo<MenuItemSpec[]>(() => {
    const items: MenuItemSpec[] = [
      {
        id: 'queue',
        label: t('queue.addToQueue'),
        disabled: tracks.length === 0,
        onSelect: () => queue.addToQueue(tracks),
      },
      { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, disabled: tracks.length === 0 },
    ];
    if (host.capabilities.offlineDownloads) {
      items.push({
        id: 'download',
        label: t('playlist.downloadAll'),
        separatorBefore: true,
        disabled: tracks.length === 0,
        onSelect: download,
      });
    }
    return items;
  }, [t, tracks, queue, addToPlaylist, host, download]);

  const rowMenuItems = useCallback(
    (track: Track): MenuItemSpec[] => [
      { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue([track]) },
      { id: 'next', label: t('queue.playNext'), onSelect: () => queue.addNext([track]) },
      { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, separatorBefore: true },
      { id: 'add-pack', label: t('pack.addTo'), items: addToPack },
      {
        id: 'unlike',
        label: t('player.unlike'),
        separatorBefore: true,
        onSelect: () => unlike(track),
      },
      ...detailsItems(track),
      ...editItems(track),
      ...removeItems(track),
    ],
    [t, queue, addToPlaylist, addToPack, unlike, detailsItems, editItems, removeItems],
  );

  const meta = [
    t('playlist.trackCount', { count: total }),
    loadedMs > 0 ? formatDurationLong(loadedMs, lang) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  // Same shape as `EntityHero`: framed square, accent rule, then the text —
  // no colour wash standing in for missing artwork.
  const hero = (
    <header className="bg-bg">
      <div className="flex flex-col gap-5 px-6 pb-6 pt-10 md:flex-row md:items-end md:gap-6">
        <div className="grid h-44 w-44 shrink-0 place-items-center rounded-sm border border-line bg-surface md:h-[200px] md:w-[200px]">
          <Heart className="h-16 w-16 text-accent" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 border-l-2 border-accent pl-4 md:pl-5">
          <p className="rule-label">{t('playlist.playlist')}</p>
          <h1 className="truncate text-3xl font-semibold tracking-tight text-text md:text-4xl">
            {t('library.likedSongs')}
          </h1>
          <p className="mono truncate text-xs text-text-faint">{meta}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <PlayButton
              size="lg"
              playing={playingThis}
              label={playingThis ? t('player.pause') : t('player.play')}
              onToggle={() => (playingThis ? void controller.toggle() : play(0))}
            />
            <Button variant="outline" size="sm" onClick={shuffle} disabled={tracks.length === 0}>
              {t('player.shuffle')}
            </Button>
            <DropdownMenu items={menuItems} align="start">
              <IconButton icon={MoreHorizontal} label={t('common.more')} size="md" />
            </DropdownMenu>
          </div>
        </div>
      </div>
    </header>
  );

  if (first.loading && firstPage === undefined) {
    return (
      <div className="flex flex-col gap-6 pb-12">
        {hero}
        <div className="flex flex-col gap-px px-6" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" rounded="sm" />
          ))}
        </div>
      </div>
    );
  }

  if (firstPage === undefined) {
    return (
      <div className="flex flex-col gap-6 pb-12">
        {hero}
        <div className="px-6">
          <ErrorBanner title={t('errors.loadFailed')} body={errorBody(first.error)} onRetry={first.reload} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-12">
      {hero}
      <div className={clsx('flex flex-col gap-3 px-6', removing.size > 0 && 'animate-fade-in')}>
        {appendError !== undefined ? (
          <ErrorBanner
            tone="warn"
            title={t('errors.loadFailed')}
            body={errorBody(appendError)}
            onRetry={loadMore}
          />
        ) : null}
        <TrackTable
          tracks={tracks}
          columns={COLUMNS}
          currentUri={currentUri}
          playing={isPlaying}
          likedSet={likedSet}
          offlineSet={offlineUris}
          onPlay={play}
          onToggleLike={(track) => (likedSet.has(track.uri) ? unlike(track) : relike(track))}
          menuItemsFor={rowMenuItems}
          onEndReached={loadMore}
          emptyState={
            <EmptyState
              icon={SearchIcon}
              title={t('library.noLiked')}
              body={t('library.noLikedBody')}
              action={{ label: t('nav.search'), onClick: () => navigate('/search') }}
            />
          }
        />
        {editDialog}
        {removeDialog}
      </div>
    </div>
  );
}

export default LikedSongsView;
