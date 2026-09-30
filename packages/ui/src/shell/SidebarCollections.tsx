import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

import type { Pack, Playlist, Track, Uri } from '@ritmo/core';

import type { MenuItemSpec } from '../components';
import { Artwork, Button, DropdownMenu, IconButton, Input, Modal } from '../components';
import { useContextMenu, usePacks, useQueue, useToast, useTranslation } from '../hooks';
import {
  IconCopy,
  IconDownload,
  IconEdit,
  IconFilter,
  IconGrip,
  IconHeartFilled,
  IconMusic,
  IconPackage,
  IconPlay,
  IconPlus,
  IconQueue,
  IconTrash,
} from '../icons';
import { entityPath, packPath } from '../routes';
import { useServices } from '../services';
import { useLibraryStore } from '../store';

export interface SidebarCollectionsProps {
  collapsed?: boolean;
  className?: string;
}

/** The filter box only earns its space once the list stops fitting at a glance. */
const FILTER_THRESHOLD = 8;
/** The same synthetic context uri `LikedSongsView` plays under. */
const LIKED_URI = 'ritmo:playlist:liked';
/** One page is enough to play or queue from the sidebar. */
const LIKED_LIMIT = 200;

/** Shared by every row in the list, pinned or not, playlist or pack. */
const ROW_CLASS =
  'flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-sm pr-2 text-sm outline-none transition-colors duration-150 ease-swift focus-visible:ring-2 focus-visible:ring-accent';

type EditMode = 'rename' | 'description';
interface EditState {
  playlist: Playlist;
  mode: EditMode;
  value: string;
}

interface DragState {
  uri: Uri;
  from: number;
  /** Pointer delta in px, applied as a transform to the lifted row. */
  dy: number;
  to: number;
}

function insertIndexFor(clientY: number, rects: DOMRect[]): number {
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    if (rect && clientY < rect.top + rect.height / 2) return i;
  }
  return rects.length;
}

function fold(text: string): string {
  return text.trim().toLocaleLowerCase('tr');
}

/**
 * One list of everything the listener owns: liked songs pinned first, then
 * playlists, then packs. They were three sidebar sections and that read as
 * three libraries, so they share a heading, a filter and a create menu now.
 */
export function SidebarCollections({
  collapsed = false,
  className,
}: SidebarCollectionsProps): JSX.Element {
  const { t } = useTranslation();
  const services = useServices();
  const navigate = useNavigate();
  const menu = useContextMenu();
  const { show, toast } = useToast();
  const queue = useQueue();

  const playlists = useLibraryStore((s) => s.playlists);
  const likedCount = useLibraryStore((s) => s.stats?.liked ?? 0);
  const { packs, create: createPack, remove: removePack, update: updatePack } = usePacks();

  const [filter, setFilter] = useState('');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Playlist | null>(null);
  const [renamingPack, setRenamingPack] = useState<Pack | null>(null);
  const [packName, setPackName] = useState('');
  const [pendingPackDelete, setPendingPackDelete] = useState<Pack | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<Uri | null>(null);

  const rowsRef = useRef(new Map<Uri, HTMLElement>());
  const listRef = useRef<HTMLUListElement | null>(null);

  const refresh = useCallback(async () => {
    const list = await services.library.playlists.list();
    useLibraryStore.setState({ playlists: list });
  }, [services]);

  const needle = fold(filter);

  const visible = useMemo(
    () => (!needle ? playlists : playlists.filter((p) => fold(p.name).includes(needle))),
    [needle, playlists],
  );

  const visiblePacks = useMemo(
    () => (!needle ? packs : packs.filter((p) => fold(p.name).includes(needle))),
    [needle, packs],
  );

  const likedName = t('nav.liked');

  // Liked songs is pinned to the top of the list: it is never reordered and
  // never deleted, so the filter is the only thing that can hide it.
  const likedVisible = !needle || fold(likedName).includes(needle);

  const likedTracks = useCallback(
    async () => (await services.library.likes.listTracks({ limit: LIKED_LIMIT })).items,
    [services],
  );

  const likedMenuItems = useMemo<MenuItemSpec[]>(() => {
    const items: MenuItemSpec[] = [
      {
        id: 'play',
        label: t('common.play'),
        icon: IconPlay,
        onSelect: () => {
          void (async () => {
            try {
              const tracks = await likedTracks();
              if (tracks.length === 0) return;
              await services.controller.playContext(tracks, 0, { uri: LIKED_URI, name: likedName });
            } catch {
              show({ title: t('errors.generic'), tone: 'danger' });
            }
          })();
        },
      },
      {
        id: 'queue',
        label: t('queue.addToQueue'),
        icon: IconQueue,
        onSelect: () => {
          void likedTracks()
            .then((tracks) => queue.addToQueue(tracks))
            .catch(() => show({ title: t('errors.generic'), tone: 'danger' }));
        },
      },
    ];
    if (!services.host.capabilities.offlineDownloads) return items;
    items.push({
      id: 'download',
      label: t('common.download'),
      icon: IconDownload,
      separatorBefore: true,
      onSelect: () => {
        // One id, re-pushed: the run reports its progress in a single toast.
        const id = `download:${LIKED_URI}`;
        void (async () => {
          const tracks = await likedTracks().catch(() => [] as Track[]);
          if (tracks.length === 0) return;
          const title = t('playlist.downloading', { count: tracks.length });
          toast({ id, title, progress: 0, durationMs: 0 });
          let failed = 0;
          for (const [index, track] of tracks.entries()) {
            try {
              const stream = await services.registry.resolveStream(track);
              await services.library.offline.download(track, stream);
            } catch {
              failed += 1;
            }
            toast({ id, title, progress: (index + 1) / tracks.length, durationMs: 0 });
          }
          toast({
            id,
            title:
              failed === 0 ? t('common.downloaded') : t('errors.downloadPartial', { count: failed }),
            tone: failed === 0 ? 'success' : 'warn',
            progress: 1,
          });
        })();
      },
    });
    return items;
  }, [likedName, likedTracks, queue, services, show, t, toast]);

  // ── create ───────────────────────────────────────────────────────────────
  const onCreatePlaylist = useCallback(async () => {
    try {
      const created = await services.library.playlists.create(t('playlist.newName'));
      await refresh();
      navigate(entityPath(created.uri));
    } catch {
      show({ title: t('errors.playlistCreateFailed'), tone: 'danger' });
    }
  }, [navigate, refresh, services, show, t]);

  const onCreatePack = useCallback(async () => {
    try {
      const created = await createPack(t('pack.newName'));
      navigate(packPath(created.uri));
    } catch {
      show({ title: t('pack.createFailed'), tone: 'danger' });
    }
  }, [createPack, navigate, show, t]);

  const createItems = useMemo<MenuItemSpec[]>(
    () => [
      {
        id: 'playlist',
        label: t('nav.createPlaylist'),
        icon: IconPlus,
        onSelect: () => void onCreatePlaylist(),
      },
      {
        id: 'pack',
        label: t('pack.create'),
        icon: IconPackage,
        onSelect: () => void onCreatePack(),
      },
    ],
    [onCreatePlaylist, onCreatePack, t],
  );

  // ── playlist actions ─────────────────────────────────────────────────────
  const onExport = useCallback(
    async (playlist: Playlist, format: 'm3u' | 'json') => {
      try {
        const folder = await services.host.files.pickFolder();
        if (!folder) return;
        const contents =
          format === 'm3u'
            ? await services.library.playlists.exportM3u(playlist.uri)
            : await services.library.playlists.exportJson(playlist.uri);
        const safe = playlist.name.replace(/[\\/:*?"<>|]/g, '_');
        const separator = folder.includes('\\') ? '\\' : '/';
        const path = `${folder}${separator}${safe}.${format}`;
        await services.host.files.writeText(path, contents);
        show({ title: t('playlist.exported'), body: path, tone: 'success' });
      } catch {
        show({ title: t('errors.exportFailed'), tone: 'danger' });
      }
    },
    [services, show, t],
  );

  const onDuplicate = useCallback(
    async (playlist: Playlist) => {
      try {
        await services.library.playlists.duplicate(playlist.uri);
        await refresh();
        show({ title: t('playlist.duplicated'), tone: 'success' });
      } catch {
        show({ title: t('errors.generic'), tone: 'danger' });
      }
    },
    [refresh, services, show, t],
  );

  const onConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await services.library.playlists.remove(pendingDelete.uri);
      await refresh();
      setPendingDelete(null);
      show({ title: t('playlist.deleted'), tone: 'neutral' });
    } catch {
      show({ title: t('errors.generic'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }, [pendingDelete, refresh, services, show, t]);

  const onSaveEdit = useCallback(async () => {
    if (!edit) return;
    const value = edit.value.trim();
    if (edit.mode === 'rename' && !value) return;
    setBusy(true);
    try {
      if (edit.mode === 'rename') await services.library.playlists.rename(edit.playlist.uri, value);
      else await services.library.playlists.setDescription(edit.playlist.uri, value);
      await refresh();
      setEdit(null);
    } catch {
      show({ title: t('errors.generic'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }, [edit, refresh, services, show, t]);

  const menuItemsFor = useCallback(
    (playlist: Playlist): MenuItemSpec[] => [
      {
        id: 'rename',
        label: t('playlist.rename'),
        icon: IconEdit,
        disabled: playlist.editable === false,
        onSelect: () => setEdit({ playlist, mode: 'rename', value: playlist.name }),
      },
      {
        id: 'description',
        label: t('playlist.editDescription'),
        icon: IconEdit,
        disabled: playlist.editable === false,
        onSelect: () => setEdit({ playlist, mode: 'description', value: playlist.description ?? '' }),
      },
      {
        id: 'duplicate',
        label: t('playlist.duplicate'),
        icon: IconCopy,
        onSelect: () => void onDuplicate(playlist),
      },
      {
        id: 'export-m3u',
        label: t('playlist.exportM3u'),
        icon: IconDownload,
        separatorBefore: true,
        onSelect: () => void onExport(playlist, 'm3u'),
      },
      {
        id: 'export-json',
        label: t('playlist.exportJson'),
        icon: IconDownload,
        onSelect: () => void onExport(playlist, 'json'),
      },
      {
        id: 'delete',
        label: t('playlist.delete'),
        icon: IconTrash,
        danger: true,
        separatorBefore: true,
        disabled: playlist.editable === false,
        onSelect: () => setPendingDelete(playlist),
      },
    ],
    [onDuplicate, onExport, t],
  );

  // ── pack actions ─────────────────────────────────────────────────────────
  const onRenamePack = useCallback(() => {
    if (renamingPack === null) return;
    const next = packName.trim();
    if (next === '') return;
    setBusy(true);
    void updatePack(renamingPack.uri, { name: next })
      .then(() => setRenamingPack(null))
      .catch(() => show({ title: t('errors.saveFailed'), tone: 'danger' }))
      .finally(() => setBusy(false));
  }, [renamingPack, packName, updatePack, show, t]);

  const onDeletePack = useCallback(() => {
    if (pendingPackDelete === null) return;
    setBusy(true);
    void removePack(pendingPackDelete.uri)
      .then(() => {
        setPendingPackDelete(null);
        show({ title: t('pack.deleted'), tone: 'neutral' });
      })
      .catch(() => show({ title: t('errors.generic'), tone: 'danger' }))
      .finally(() => setBusy(false));
  }, [pendingPackDelete, removePack, show, t]);

  const packMenuItemsFor = useCallback(
    (pack: Pack): MenuItemSpec[] => [
      {
        id: 'open',
        label: t('pack.edit'),
        icon: IconEdit,
        onSelect: () => navigate(packPath(pack.uri)),
      },
      {
        id: 'rename',
        label: t('playlist.rename'),
        icon: IconEdit,
        onSelect: () => {
          setPackName(pack.name);
          setRenamingPack(pack);
        },
      },
      {
        id: 'delete',
        label: t('pack.delete'),
        icon: IconTrash,
        danger: true,
        separatorBefore: true,
        onSelect: () => setPendingPackDelete(pack),
      },
    ],
    [navigate, t],
  );

  // ── pointer reorder ──────────────────────────────────────────────────────
  // Only playlists reorder: liked songs is pinned and packs keep their own
  // order, so the measured rows are the playlist rows alone.
  const startReorder = useCallback(
    (event: React.PointerEvent<HTMLElement>, uri: Uri, from: number) => {
      if (event.button !== 0 || filter.trim()) return;
      event.preventDefault();
      const order = visible.map((p) => p.uri);
      const rects = order
        .map((id) => rowsRef.current.get(id))
        .filter((el): el is HTMLElement => Boolean(el))
        .map((el) => el.getBoundingClientRect());
      if (rects.length !== order.length) return;

      const startY = event.clientY;
      let target = from;
      let cancelled = false;
      setDrag({ uri, from, dy: 0, to: from });

      const onMove = (e: PointerEvent) => {
        target = insertIndexFor(e.clientY, rects);
        setDrag({ uri, from, dy: e.clientY - startY, to: target });
      };
      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('keydown', onKey);
        setDrag(null);
      };
      const onUp = () => {
        finish();
        if (cancelled) return;
        const next = target > from ? target - 1 : target;
        if (next === from) return;
        const reordered = [...order];
        const [moved] = reordered.splice(from, 1);
        if (!moved) return;
        reordered.splice(next, 0, moved);
        const byUri = new Map(playlists.map((p) => [p.uri, p]));
        useLibraryStore.setState({
          playlists: reordered
            .map((id) => byUri.get(id))
            .filter((p): p is Playlist => Boolean(p)),
        });
        void services.library.playlists.setSortOrder(reordered).catch(() => {
          void refresh();
          show({ title: t('errors.generic'), tone: 'danger' });
        });
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        cancelled = true;
        finish();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKey);
    },
    [filter, playlists, refresh, services, show, t, visible],
  );

  // ── track drops ──────────────────────────────────────────────────────────
  const onDropTracks = useCallback(
    (event: React.DragEvent<HTMLElement>, playlist: Playlist) => {
      event.preventDefault();
      setDropTarget(null);
      const raw = event.dataTransfer.getData('text/ritmo-tracks');
      if (!raw) return;
      let tracks: Track[] = [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) tracks = parsed as Track[];
      } catch {
        return;
      }
      if (tracks.length === 0) return;
      void services.library.playlists
        .addTracks(playlist.uri, tracks)
        .then(async () => {
          await refresh();
          show({
            title: t('playlist.addedToPlaylist', { name: playlist.name, count: tracks.length }),
            tone: 'success',
          });
        })
        .catch(() => show({ title: t('errors.generic'), tone: 'danger' }));
    },
    [refresh, services, show, t],
  );

  useEffect(() => {
    // A shrinking list must not keep a stale element alive for measurement.
    const live = new Set(playlists.map((p) => p.uri));
    for (const key of [...rowsRef.current.keys()]) {
      if (!live.has(key)) rowsRef.current.delete(key);
    }
  }, [playlists]);

  const indicatorTop = useMemo(() => {
    if (!drag || !listRef.current) return null;
    const order = visible.map((p) => p.uri);
    const containerTop = listRef.current.getBoundingClientRect().top;
    const boundaryId = order[drag.to];
    if (boundaryId) {
      const el = rowsRef.current.get(boundaryId);
      return el ? el.getBoundingClientRect().top - containerTop : null;
    }
    const lastId = order[order.length - 1];
    const last = lastId ? rowsRef.current.get(lastId) : undefined;
    return last ? last.getBoundingClientRect().bottom - containerTop : null;
  }, [drag, visible]);

  const total = playlists.length + packs.length;
  const nothingVisible = !likedVisible && visible.length === 0 && visiblePacks.length === 0;

  return (
    <div className={clsx('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      {collapsed ? (
        <DropdownMenu items={createItems} align="start">
          <IconButton
            icon={IconPlus}
            label={t('nav.createCollection')}
            size="sm"
            tooltipSide="right"
            className="mx-auto"
          />
        </DropdownMenu>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1.5">
          <p className="rule-label min-w-0 flex-1">{t('nav.collections')}</p>
          <button
            type="button"
            onClick={() => navigate('/library/playlists')}
            className="mono shrink-0 rounded-xs text-[11px] uppercase tracking-[0.14em] text-text-faint outline-none transition-colors duration-150 ease-swift hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t('common.seeAll')}
          </button>
          <DropdownMenu items={createItems} align="end">
            <IconButton
              icon={IconPlus}
              label={t('nav.createCollection')}
              size="xs"
              className="shrink-0"
            />
          </DropdownMenu>
        </div>
      )}

      {!collapsed && total > FILTER_THRESHOLD ? (
        <div className="px-2 py-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            placeholder={t('nav.filterCollections')}
            aria-label={t('nav.filterCollections')}
            size="sm"
            leading={IconFilter}
            clearable
            onClear={() => setFilter('')}
          />
        </div>
      ) : null}

      <ul
        ref={listRef}
        className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        aria-label={t('nav.collections')}
      >
        {indicatorTop !== null ? (
          <li
            aria-hidden="true"
            className="pointer-events-none absolute left-0 right-0 z-10 h-[2px] bg-accent"
            style={{ transform: `translateY(${indicatorTop}px)` }}
          />
        ) : null}

        {likedVisible ? (
          <li className="relative border-b border-line/40 last:border-b-0">
            <div className="group flex min-w-0 items-center">
              {!collapsed ? (
                // A disabled handle in the same slot keeps the rows aligned and
                // tells a screen reader this one cannot be dragged.
                <button
                  type="button"
                  disabled
                  aria-label={t('playlist.notReorderable')}
                  className="flex h-9 w-4 shrink-0 items-center justify-center text-text-faint opacity-0"
                >
                  <IconGrip className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <NavLink
                to="/liked"
                aria-label={collapsed ? likedName : undefined}
                onContextMenu={(e) => menu(e, likedMenuItems)}
                className={({ isActive }) =>
                  clsx(
                    ROW_CLASS,
                    collapsed ? 'w-10 justify-center px-0' : 'pl-1',
                    isActive
                      ? 'gutter-mark text-text'
                      : 'text-text-dim hover:bg-surface-2 hover:text-text',
                  )
                }
              >
                {/* Liked songs has no artwork of its own; a bordered glyph
                    fills the same 20px slot the playlist rows use. */}
                <span className="tile flex h-5 w-5 shrink-0 items-center justify-center rounded-sm">
                  <IconHeartFilled className="h-3 w-3 text-accent" />
                </span>
                {collapsed ? null : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{likedName}</span>
                    <span className="mono shrink-0 text-[10px] text-text-faint">
                      <span className="sr-only">
                        {t('library.songCount', { count: likedCount })}
                      </span>
                      <span aria-hidden="true">{likedCount}</span>
                    </span>
                  </>
                )}
              </NavLink>
            </div>
          </li>
        ) : null}

        {visible.map((playlist, index) => {
          const dy = drag !== null && drag.uri === playlist.uri ? drag.dy : null;
          return (
            <li
              key={playlist.uri}
              ref={(el) => {
                if (el) rowsRef.current.set(playlist.uri, el);
                else rowsRef.current.delete(playlist.uri);
              }}
              className={clsx(
                'relative border-b border-line/40 last:border-b-0',
                dy !== null && 'z-20',
              )}
              style={dy !== null ? { transform: `translateY(${dy}px)` } : undefined}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('text/ritmo-tracks')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setDropTarget(playlist.uri);
              }}
              onDragLeave={() => setDropTarget((cur) => (cur === playlist.uri ? null : cur))}
              onDrop={(e) => onDropTracks(e, playlist)}
            >
              <div
                className={clsx(
                  'group flex min-w-0 items-center transition-colors duration-150 ease-swift',
                  dropTarget === playlist.uri && 'ring-1 ring-inset ring-accent',
                  dy !== null && 'bg-surface-3 shadow-pop',
                )}
              >
                {!collapsed ? (
                  <span
                    role="presentation"
                    onPointerDown={(e) => startReorder(e, playlist.uri, index)}
                    className="flex h-9 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-text-faint opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <IconGrip className="h-3.5 w-3.5" />
                  </span>
                ) : null}
                <NavLink
                  to={entityPath(playlist.uri)}
                  aria-label={collapsed ? playlist.name : undefined}
                  onContextMenu={(e) => menu(e, menuItemsFor(playlist))}
                  className={({ isActive }) =>
                    clsx(
                      ROW_CLASS,
                      collapsed ? 'w-10 justify-center px-0' : 'pl-1',
                      isActive
                        ? 'gutter-mark text-text'
                        : 'text-text-dim hover:bg-surface-2 hover:text-text',
                    )
                  }
                >
                  <Artwork
                    artwork={playlist.artwork}
                    size={20}
                    name={playlist.name}
                    rounded="sm"
                    className="shrink-0"
                  />
                  {collapsed ? null : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
                      {playlist.trackCount !== undefined ? (
                        <span className="mono shrink-0 text-[10px] text-text-faint">
                          <span className="sr-only">
                            {t('playlist.trackCount', { count: playlist.trackCount })}
                          </span>
                          <span aria-hidden="true">{playlist.trackCount}</span>
                        </span>
                      ) : null}
                    </>
                  )}
                </NavLink>
              </div>
            </li>
          );
        })}

        {visiblePacks.map((pack) => (
          <li key={pack.uri} className="relative border-b border-line/40 last:border-b-0">
            <div className="group flex min-w-0 items-center">
              {!collapsed ? (
                // An empty slot where the playlist rows keep their grip, so
                // every row's artwork sits on the same vertical line.
                <span aria-hidden="true" className="h-9 w-4 shrink-0" />
              ) : null}
              <NavLink
                to={packPath(pack.uri)}
                aria-label={collapsed ? pack.name : undefined}
                onContextMenu={(e) => menu(e, packMenuItemsFor(pack))}
                className={({ isActive }) =>
                  clsx(
                    ROW_CLASS,
                    collapsed ? 'w-10 justify-center px-0' : 'pl-1',
                    isActive
                      ? 'gutter-mark text-text'
                      : 'text-text-dim hover:bg-surface-2 hover:text-text',
                  )
                }
              >
                {pack.artwork ? (
                  <Artwork
                    artwork={pack.artwork}
                    size={20}
                    name={pack.name}
                    rounded="sm"
                    className="shrink-0"
                  />
                ) : (
                  <span className="tile flex h-5 w-5 shrink-0 items-center justify-center rounded-sm">
                    <IconPackage className="h-3 w-3 text-accent" />
                  </span>
                )}
                {collapsed ? null : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{pack.name}</span>
                    <span className="mono shrink-0 text-[10px] text-text-faint">
                      <span className="sr-only">
                        {t('pack.trackCount', { count: pack.trackCount })}
                      </span>
                      <span aria-hidden="true">{pack.trackCount}</span>
                    </span>
                  </>
                )}
              </NavLink>
            </div>
          </li>
        ))}

        {!collapsed && total === 0 ? (
          <li className="px-3 py-2 text-xs leading-relaxed text-text-faint">
            {t('nav.collectionsEmpty')}
          </li>
        ) : null}
        {!collapsed && total > 0 && nothingVisible ? (
          <li className="px-3 py-2 text-xs text-text-faint">{t('nav.noMatch')}</li>
        ) : null}
      </ul>

      <Modal
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={edit?.mode === 'description' ? t('playlist.editDescription') : t('playlist.rename')}
        size="sm"
        actions={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={edit?.mode === 'rename' && !edit.value.trim()}
              onClick={() => void onSaveEdit()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        {edit ? (
          <Input
            autoFocus
            value={edit.value}
            aria-label={edit.mode === 'description' ? t('playlist.description') : t('playlist.name')}
            placeholder={edit.mode === 'description' ? t('playlist.description') : t('playlist.name')}
            onChange={(e) => setEdit({ ...edit, value: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSaveEdit();
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        dismissible={false}
        size="sm"
        title={t('playlist.delete')}
        description={
          pendingDelete ? t('playlist.deleteConfirm', { name: pendingDelete.name }) : undefined
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              leading={IconTrash}
              loading={busy}
              onClick={() => void onConfirmDelete()}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="flex items-center gap-2 text-sm text-text-dim">
          <IconMusic className="h-4 w-4 shrink-0" />
          {t('playlist.deleteIrreversible')}
        </p>
      </Modal>

      <Modal
        open={renamingPack !== null}
        onClose={() => setRenamingPack(null)}
        title={t('playlist.rename')}
        size="sm"
        actions={
          <>
            <Button variant="ghost" onClick={() => setRenamingPack(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={packName.trim() === ''}
              onClick={onRenamePack}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={packName}
          aria-label={t('pack.name')}
          placeholder={t('pack.name')}
          onChange={(e) => setPackName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenamePack();
          }}
        />
      </Modal>

      <Modal
        open={pendingPackDelete !== null}
        onClose={() => setPendingPackDelete(null)}
        dismissible={false}
        size="sm"
        title={t('pack.delete')}
        description={
          pendingPackDelete ? t('pack.deleteConfirm', { name: pendingPackDelete.name }) : undefined
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setPendingPackDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" leading={IconTrash} loading={busy} onClick={onDeletePack}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-dim">{t('pack.deleteIrreversible')}</p>
      </Modal>
    </div>
  );
}
