import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ProviderError, formatDurationLong } from '@ritmo/core';
import type { Artwork, Playlist, Track, Uri } from '@ritmo/core';

import {
  Artwork as ArtworkImage,
  Button,
  DropdownMenu,
  EmptyState,
  EntityHero,
  ErrorBanner,
  Input,
  Modal,
  TrackRow,
  TrackTable,
} from '../components';
import type { MenuItemSpec, TrackTableColumn } from '../components';
import { useAsync, useLibrary, useQueue, useToast, useTranslation } from '../hooks';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';
import { GripVertical, Search as SearchIcon } from '../icons';
import { entityPath } from '../routes';
import { useAddToPackItems } from '../shell/AddToPackMenu';
import { useAddToPlaylistItems } from '../shell/AddToPlaylistMenu';
import { useRemoveFromLibrary } from '../shell/RemoveFromLibrary';
import { useTrackDetails } from '../shell/TrackDetails';
import { useTrackDetailsEditor } from '../shell/TrackDetailsDialog';
import { EntityHeroSkeleton, TrackListSkeleton } from './AlbumView';

/** `TrackRow variant="queue"` is the only variant that renders a grip. */
const ROW_HEIGHT = 44;

const COLUMNS: TrackTableColumn[] = [
  { id: 'index', width: '3rem' },
  { id: 'title', sortable: false },
  { id: 'album' },
  { id: 'added', width: '8rem' },
  { id: 'duration', width: '5rem' },
];

function errorBody(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ProviderError && error.code === 'not_found';
}

function artworkKey(artwork: Artwork): string {
  return artwork.sources[0]?.url ?? '';
}

// ── drag reorder ────────────────────────────────────────────────────────────

interface ReorderListProps {
  tracks: Track[];
  currentUri?: Uri;
  playing: boolean;
  likedUris: Set<Uri>;
  offlineUris: Set<Uri>;
  onMove: (from: number, to: number) => void;
  onPlay: (index: number) => void;
  onToggleLike: (track: Track) => void;
  menuItemsFor: (track: Track, index: number) => MenuItemSpec[];
  dragLabel: string;
}

/**
 * Pointer-event reorder: no dnd library, no HTML5 drag-and-drop (which cannot
 * be styled and does not work under a Tauri WebView on every platform).
 */
function ReorderList({
  tracks,
  currentUri,
  playing,
  likedUris,
  offlineUris,
  onMove,
  onPlay,
  onToggleLike,
  menuItemsFor,
  dragLabel,
}: ReorderListProps): ReactElement {
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number } | null>(null);

  const begin = useCallback(
    (index: number, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      dragRef.current = { from: index, to: index };
      setDrag({ from: index, to: index, dy: 0 });

      const onMoveEvent = (e: PointerEvent) => {
        const dy = e.clientY - startY;
        const to = Math.min(tracks.length - 1, Math.max(0, index + Math.round(dy / ROW_HEIGHT)));
        dragRef.current = { from: index, to };
        setDrag({ from: index, to, dy });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMoveEvent);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        const finished = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (finished && finished.to !== finished.from) onMove(finished.from, finished.to);
      };
      window.addEventListener('pointermove', onMoveEvent);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [tracks.length, onMove],
  );

  return (
    <div className="relative" role="list">
      {drag !== null ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-accent"
          style={{ transform: `translateY(${drag.to * ROW_HEIGHT}px)` }}
        />
      ) : null}
      {tracks.map((track, index) => {
        const isDragging = drag?.from === index;
        return (
          <div
            key={`${track.uri}-${index}`}
            role="listitem"
            className={isDragging ? 'relative z-20 opacity-90 ring-1 ring-accent' : 'relative'}
            style={{
              height: `${ROW_HEIGHT}px`,
              transform: isDragging && drag ? `translateY(${drag.dy}px)` : undefined,
            }}
          >
            <TrackRow
              track={track}
              variant="queue"
              active={currentUri === track.uri}
              playing={playing && currentUri === track.uri}
              liked={likedUris.has(track.uri)}
              offline={offlineUris.has(track.uri)}
              onPlay={() => onPlay(index)}
              onToggleLike={() => onToggleLike(track)}
              menuItems={menuItemsFor(track, index)}
              dragHandleProps={{
                'aria-label': dragLabel,
                tabIndex: 0,
                onPointerDown: (e) => begin(index, e),
                onKeyDown: (e) => {
                  if (e.key === 'ArrowUp' && index > 0) {
                    e.preventDefault();
                    onMove(index, index - 1);
                  } else if (e.key === 'ArrowDown' && index < tracks.length - 1) {
                    e.preventDefault();
                    onMove(index, index + 1);
                  }
                },
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── edit modal ──────────────────────────────────────────────────────────────

interface EditModalProps {
  open: boolean;
  playlist: Playlist;
  tracks: Track[];
  onClose: () => void;
  onSave: (next: { name: string; description: string; artwork: Artwork | undefined }) => Promise<void>;
}

function EditModal({ open, playlist, tracks, onClose, onSave }: EditModalProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(playlist.name);
  const [description, setDescription] = useState(playlist.description ?? '');
  const [artwork, setArtwork] = useState<Artwork | undefined>(playlist.artwork);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    if (!open) return;
    setName(playlist.name);
    setDescription(playlist.description ?? '');
    setArtwork(playlist.artwork);
    setError(undefined);
  }, [open, playlist]);

  const choices = useMemo(() => {
    const seen = new Map<string, Artwork>();
    for (const track of tracks) {
      const candidate = track.artwork;
      if (!candidate) continue;
      const key = artworkKey(candidate);
      if (key !== '' && !seen.has(key)) seen.set(key, candidate);
      if (seen.size >= 12) break;
    }
    return [...seen.entries()];
  }, [tracks]);

  const save = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setBusy(true);
    setError(undefined);
    void onSave({ name: trimmed, description: description.trim(), artwork })
      .then(onClose)
      .catch((e: unknown) => setError(e))
      .finally(() => setBusy(false));
  }, [name, description, artwork, onSave, onClose]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('playlist.editTitle')}
      size="md"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} loading={busy} disabled={name.trim() === ''}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-dim">{t('playlist.name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-dim">{t('playlist.description')}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="selectable w-full resize-none rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>

        {choices.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text-dim">{t('playlist.artwork')}</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setArtwork(undefined)}
                aria-pressed={artwork === undefined}
                className={
                  artwork === undefined
                    ? 'flex h-16 w-16 items-center justify-center rounded-md bg-surface-3 text-[11px] text-text ring-2 ring-accent'
                    : 'flex h-16 w-16 items-center justify-center rounded-md bg-surface-3 text-[11px] text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                }
              >
                {t('common.none')}
              </button>
              {choices.map(([key, candidate]) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setArtwork(candidate)}
                  aria-pressed={artwork !== undefined && artworkKey(artwork) === key}
                  aria-label={t('playlist.artwork')}
                  className={
                    artwork !== undefined && artworkKey(artwork) === key
                      ? 'rounded-md ring-2 ring-accent'
                      : 'rounded-md ring-1 ring-line hover:ring-text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                  }
                >
                  <ArtworkImage artwork={candidate} size={64} rounded="md" />
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {error !== undefined ? (
          <ErrorBanner title={t('errors.saveFailed')} body={errorBody(error)} onDismiss={() => setError(undefined)} />
        ) : null}
      </div>
    </Modal>
  );
}

// ── view ────────────────────────────────────────────────────────────────────

export function PlaylistView(): ReactElement {
  const params = useParams<{ uri: string }>();
  const uri = params.uri === undefined ? '' : decodeURIComponent(params.uri);
  const { library, registry, controller, host } = useServices();
  const { t, lang } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queue = useQueue();
  const { refresh } = useLibrary();

  const likedUris = useLibraryStore((s) => s.likedUris);
  const offlineUris = useLibraryStore((s) => s.offlineUris);
  const currentUri = usePlayerStore((s) => s.current?.uri);
  const isPlaying = usePlayerStore((s) => s.status === 'playing');
  const contextUri = usePlayerStore((s) => s.queue.contextUri);

  const [selection, setSelection] = useState<Set<Uri>>(new Set());
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [order, setOrder] = useState<Track[] | undefined>(undefined);

  const fetchPlaylist = useCallback(async (): Promise<Playlist> => {
    if (uri === '') throw new ProviderError('not_found', 'empty uri');
    const own = await library.playlists.get(uri, true);
    if (own) return own;
    const provider = registry.forUri(uri);
    if (!provider) throw new ProviderError('not_found', uri);
    return provider.getPlaylist(uri);
  }, [uri, library, registry]);

  const playlist = useAsync(fetchPlaylist, [fetchPlaylist], { keepPrevious: true });
  const data = playlist.data;
  const fetched = useMemo(() => data?.tracks ?? [], [data]);
  const { itemsFor: editItems, applyEdits, dialog: editDialog } = useTrackDetailsEditor();
  const { itemsFor: detailsItems, dialog: detailsDialog } = useTrackDetails();
  const {
    itemsFor: removeItems,
    request: requestRemoval,
    filterRemoved,
    dialog: removeDialog,
  } = useRemoveFromLibrary();
  const tracks = useMemo(
    () => filterRemoved(applyEdits(order ?? fetched)),
    [applyEdits, filterRemoved, order, fetched],
  );
  const editable = data?.editable === true;

  // A refetch is the source of truth again; drop the optimistic order.
  useEffect(() => {
    setOrder(undefined);
    setSelection(new Set());
  }, [fetched]);

  useEffect(() => {
    if (data) document.title = `${data.name} · Ritmo`;
  }, [data]);

  const selectedTracks = useMemo(
    () => tracks.filter((track) => selection.has(track.uri)),
    [tracks, selection],
  );
  const addToPlaylistAll = useAddToPlaylistItems(tracks);
  const addToPack = useAddToPackItems(tracks);
  const addToPlaylistSelected = useAddToPlaylistItems(selectedTracks);

  const totalMs = useMemo(() => tracks.reduce((sum, track) => sum + track.durationMs, 0), [tracks]);

  const play = useCallback(
    (index: number) => {
      if (!data || tracks.length === 0) return;
      void controller.playContext(tracks, index, { uri: data.uri, name: data.name });
    },
    [controller, data, tracks],
  );

  const shuffle = useCallback(() => {
    if (!data || tracks.length === 0) return;
    void (async () => {
      await controller.setShuffle(true);
      await controller.playContext(tracks, Math.floor(Math.random() * tracks.length), {
        uri: data.uri,
        name: data.name,
      });
    })();
  }, [controller, data, tracks]);

  const move = useCallback(
    (from: number, to: number) => {
      if (!data) return;
      setOrder((prev) => {
        const base = prev ?? fetched;
        const next = [...base];
        const [moved] = next.splice(from, 1);
        if (!moved) return prev;
        next.splice(to, 0, moved);
        return next;
      });
      void library.playlists
        .move(data.uri, from, to)
        .catch((e: unknown) => {
          setOrder(undefined);
          toast.toast({ title: t('errors.saveFailed'), body: errorBody(e), tone: 'danger' });
        });
    },
    [data, fetched, library, toast, t],
  );

  const removeSelected = useCallback(() => {
    if (!data) return;
    const positions = tracks.reduce<number[]>((acc, track, index) => {
      if (selection.has(track.uri)) acc.push(index);
      return acc;
    }, []);
    if (positions.length === 0) return;
    void library.playlists
      .removeTracks(data.uri, positions)
      .then(() => {
        setSelection(new Set());
        void refresh();
        playlist.reload();
      })
      .catch((e: unknown) => toast.toast({ title: t('errors.saveFailed'), body: errorBody(e), tone: 'danger' }));
  }, [data, tracks, selection, library, refresh, playlist, toast, t]);

  const downloadTracks = useCallback(
    (targets: Track[]) => {
      if (targets.length === 0) return;
      // Re-pushing one id keeps a single toast that reports progress in place.
      const id = `download:${uri}`;
      const title = t('playlist.downloading', { count: targets.length });
      void (async () => {
        toast.toast({ id, title, progress: 0, durationMs: 0 });
        let done = 0;
        let failed = 0;
        for (const track of targets) {
          try {
            const stream = await registry.resolveStream(track);
            await library.offline.download(track, stream);
          } catch {
            failed += 1;
          }
          done += 1;
          toast.toast({ id, title, progress: done / targets.length, durationMs: 0 });
        }
        toast.toast({
          id,
          title: failed === 0 ? t('common.downloaded') : t('errors.downloadPartial', { count: failed }),
          tone: failed === 0 ? 'success' : 'warn',
          progress: 1,
        });
        void refresh();
      })();
    },
    [uri, toast, t, registry, library, refresh],
  );

  const downloadAll = useCallback(() => {
    if (!data) return;
    if (!editable) {
      downloadTracks(tracks);
      return;
    }
    const id = `download:${data.uri}`;
    const title = t('playlist.downloading', { count: tracks.length });
    toast.toast({ id, title, progress: 0, durationMs: 0 });
    void library.offline
      .downloadPlaylist(
        data.uri,
        (track) => registry.resolveStream(track),
        (done, total) =>
          toast.toast({ id, title, progress: total > 0 ? done / total : 0, durationMs: 0 }),
      )
      .then(() => {
        toast.toast({ id, title: t('common.downloaded'), tone: 'success', progress: 1 });
        void refresh();
      })
      .catch((e: unknown) =>
        toast.toast({
          id,
          title: t('errors.downloadFailed'),
          body: errorBody(e),
          tone: 'danger',
          durationMs: 6000,
        }),
      );
  }, [data, editable, tracks, downloadTracks, toast, t, library, registry, refresh]);

  const exportFile = useCallback(
    (kind: 'm3u' | 'json') => {
      if (!data) return;
      void (async () => {
        try {
          const contents =
            kind === 'm3u'
              ? await library.playlists.exportM3u(data.uri)
              : await library.playlists.exportJson(data.uri);
          if (host.capabilities.localFiles) {
            const folder = await host.files.pickFolder();
            if (folder === undefined) return;
            const separator = folder.includes('\\') ? '\\' : '/';
            const safe = data.name.replace(/[\\/:*?"<>|]+/g, '_');
            await host.files.writeText(`${folder}${separator}${safe}.${kind}`, contents);
            toast.toast({ title: t('playlist.exported'), tone: 'success' });
          } else {
            await navigator.clipboard.writeText(contents);
            toast.toast({ title: t('common.copied'), tone: 'success' });
          }
        } catch (e: unknown) {
          toast.toast({ title: t('errors.exportFailed'), body: errorBody(e), tone: 'danger' });
        }
      })();
    },
    [data, library, host, toast, t],
  );

  const duplicate = useCallback(() => {
    if (!data) return;
    void (async () => {
      try {
        const copy = editable
          ? await library.playlists.duplicate(data.uri)
          : await library.playlists.create(t('playlist.copyOf', { name: data.name }), { tracks });
        void refresh();
        navigate(entityPath(copy.uri));
      } catch (e: unknown) {
        toast.toast({ title: t('errors.saveFailed'), body: errorBody(e), tone: 'danger' });
      }
    })();
  }, [data, editable, library, tracks, refresh, navigate, toast, t]);

  const remove = useCallback(() => {
    if (!data) return;
    void library.playlists
      .remove(data.uri)
      .then(() => {
        setConfirmDelete(false);
        void refresh();
        navigate('/library/playlists');
      })
      .catch((e: unknown) => toast.toast({ title: t('errors.saveFailed'), body: errorBody(e), tone: 'danger' }));
  }, [data, library, refresh, navigate, toast, t]);

  const saveEdits = useCallback(
    async (next: { name: string; description: string; artwork: Artwork | undefined }) => {
      if (!data) return;
      if (next.name !== data.name) await library.playlists.rename(data.uri, next.name);
      if (next.description !== (data.description ?? '')) {
        await library.playlists.setDescription(data.uri, next.description);
      }
      if (artworkKey(next.artwork ?? { sources: [] }) !== artworkKey(data.artwork ?? { sources: [] })) {
        await library.playlists.setArtwork(data.uri, next.artwork);
      }
      void refresh();
      playlist.reload();
    },
    [data, library, refresh, playlist],
  );

  const copyLink = useCallback(() => {
    if (!data) return;
    void navigator.clipboard
      .writeText(data.uri)
      .then(() => toast.toast({ title: t('common.copied'), tone: 'success' }))
      .catch(() => toast.toast({ title: t('errors.copyFailed'), tone: 'danger' }));
  }, [data, toast, t]);

  const menuItems = useMemo<MenuItemSpec[]>(() => {
    if (!data) return [];
    const items: MenuItemSpec[] = [
      { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue(tracks) },
      { id: 'add', label: t('playlist.addTo'), items: addToPlaylistAll },
      { id: 'duplicate', label: t('playlist.duplicate'), onSelect: duplicate, separatorBefore: true },
      { id: 'm3u', label: t('playlist.exportM3u'), onSelect: () => exportFile('m3u') },
      { id: 'json', label: t('playlist.exportJson'), onSelect: () => exportFile('json') },
      { id: 'copy', label: t('common.copyLink'), onSelect: copyLink },
    ];
    if (host.capabilities.offlineDownloads) {
      items.push({
        id: 'download',
        label: t('playlist.downloadAll'),
        onSelect: downloadAll,
        separatorBefore: true,
      });
    }
    if (editable) {
      items.push({ id: 'edit', label: t('playlist.edit'), onSelect: () => setEditing(true), separatorBefore: true });
      items.push({
        id: 'reorder',
        label: t('playlist.reorder'),
        checked: reordering,
        onSelect: () => setReordering((v) => !v),
      });
      items.push({
        id: 'delete',
        label: t('playlist.delete'),
        danger: true,
        separatorBefore: true,
        onSelect: () => setConfirmDelete(true),
      });
    }
    return items;
  }, [
    data,
    t,
    queue,
    tracks,
    addToPlaylistAll,
    duplicate,
    exportFile,
    copyLink,
    host,
    downloadAll,
    editable,
    reordering,
  ]);

  const rowMenuItems = useCallback(
    (track: Track, index: number): MenuItemSpec[] => {
      const items: MenuItemSpec[] = [
        { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue([track]) },
        { id: 'next', label: t('queue.playNext'), onSelect: () => queue.addNext([track]) },
        { id: 'add', label: t('playlist.addTo'), items: addToPlaylistAll, separatorBefore: true },
        { id: 'add-pack', label: t('pack.addTo'), items: addToPack },
      ];
      if (editable && data) {
        items.push({
          id: 'remove',
          label: t('playlist.removeFromPlaylist'),
          danger: true,
          separatorBefore: true,
          onSelect: () => {
            void library.playlists
              .removeTracks(data.uri, [index])
              .then(() => {
                void refresh();
                playlist.reload();
              })
              .catch((e: unknown) =>
                toast.toast({ title: t('errors.saveFailed'), body: errorBody(e), tone: 'danger' }),
              );
          },
        });
      }
      items.push(...detailsItems(track), ...editItems(track), ...removeItems(track));
      return items;
    },
    [
      t,
      queue,
      addToPlaylistAll,
      addToPack,
      editable,
      data,
      library,
      refresh,
      playlist,
      toast,
      detailsItems,
      editItems,
      removeItems,
    ],
  );

  const toggleLike = useCallback(
    (track: Track) => {
      void useLibraryStore.getState().toggleLike(track);
    },
    [library],
  );

  if (playlist.loading && data === undefined) {
    return (
      <div className="flex flex-col gap-6 pb-12">
        <EntityHeroSkeleton />
        <TrackListSkeleton />
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="p-6">
        <ErrorBanner
          title={isNotFound(playlist.error) ? t('errors.notFound') : t('errors.loadFailed')}
          body={errorBody(playlist.error)}
          onRetry={playlist.reload}
        />
      </div>
    );
  }

  const playingThis = isPlaying && contextUri === data.uri;
  const meta = [
    data.owner !== undefined && data.owner !== '' ? data.owner : undefined,
    t('playlist.trackCount', { count: tracks.length }),
    totalMs > 0 ? formatDurationLong(totalMs, lang) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  return (
    <div className="flex flex-col gap-6 pb-12">
      <EntityHero
        kind="playlist"
        eyebrow={t('playlist.playlist')}
        title={data.name}
        subtitle={
          data.description !== undefined && data.description !== '' ? (
            <span className="selectable">{data.description}</span>
          ) : undefined
        }
        meta={meta}
        artwork={data.artwork}
        playing={playingThis}
        onPlay={() => (playingThis ? void controller.toggle() : play(0))}
        onShuffle={shuffle}
        menuItems={menuItems}
        editable={editable}
        onEdit={editable ? () => setEditing(true) : undefined}
      />

      <div className="flex flex-col gap-3 px-6">
        {editable ? (
          <div className="flex items-center gap-2">
            <Button
              variant={reordering ? 'primary' : 'outline'}
              size="sm"
              leading={GripVertical}
              onClick={() => setReordering((v) => !v)}
              aria-pressed={reordering}
            >
              {t('playlist.reorder')}
            </Button>
            {reordering ? (
              <span className="text-xs text-text-dim" aria-live="polite">
                {t('playlist.reorderHint')}
              </span>
            ) : null}
          </div>
        ) : null}

        {tracks.length === 0 ? (
          <EmptyState
            icon={SearchIcon}
            title={t('playlist.empty')}
            body={t('playlist.emptyBody')}
            action={{ label: t('nav.search'), onClick: () => navigate('/search') }}
          />
        ) : reordering && editable ? (
          <ReorderList
            tracks={tracks}
            currentUri={currentUri}
            playing={isPlaying}
            likedUris={likedUris}
            offlineUris={offlineUris}
            onMove={move}
            onPlay={play}
            onToggleLike={toggleLike}
            menuItemsFor={rowMenuItems}
            dragLabel={t('playlist.dragHandle')}
          />
        ) : (
          <TrackTable
            tracks={tracks}
            columns={COLUMNS}
            selectable
            onSelectionChange={setSelection}
            currentUri={currentUri}
            playing={isPlaying}
            likedSet={likedUris}
            offlineSet={offlineUris}
            onPlay={play}
            onToggleLike={toggleLike}
            menuItemsFor={rowMenuItems}
          />
        )}
        {editDialog}
        {removeDialog}
      </div>

      {selection.size > 0 ? (
        <div className="sticky bottom-4 z-20 mx-6 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2/95 px-4 py-3 backdrop-blur animate-slide-up">
          <span className="text-sm font-medium text-text" aria-live="polite">
            {t('common.selected', { count: selection.size })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="subtle" size="sm" onClick={() => queue.addToQueue(selectedTracks)}>
              {t('queue.addToQueue')}
            </Button>
            {host.capabilities.offlineDownloads ? (
              <Button variant="subtle" size="sm" onClick={() => downloadTracks(selectedTracks)}>
                {t('common.download')}
              </Button>
            ) : null}
            <DropdownMenu items={addToPlaylistSelected} side="top" align="end">
              <Button variant="subtle" size="sm" disabled={addToPlaylistSelected.length === 0}>
                {t('playlist.addTo')}
              </Button>
            </DropdownMenu>
            {editable ? (
              <Button variant="danger" size="sm" onClick={removeSelected}>
                {t('playlist.removeSelected')}
              </Button>
            ) : null}
            {/* Outline, not danger: the playlist removal next to it is the one
                this page is about, and two red buttons side by side read as one
                mistake waiting to happen. The confirmation carries the weight. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => requestRemoval(selectedTracks)}
              disabled={selectedTracks.length === 0}
            >
              {t('track.removeFromLibrary')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelection(new Set())}>
              {t('common.clear')}
            </Button>
          </div>
        </div>
      ) : null}

      {editable ? (
        <EditModal
          open={editing}
          playlist={data}
          tracks={tracks}
          onClose={() => setEditing(false)}
          onSave={saveEdits}
        />
      ) : null}

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('playlist.deleteConfirm')}
        description={t('playlist.deleteConfirmBody', { name: data.name })}
        size="sm"
        dismissible={false}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={remove}>
              {t('common.delete')}
            </Button>
          </>
        }
      />
    </div>
  );
}

export default PlaylistView;
