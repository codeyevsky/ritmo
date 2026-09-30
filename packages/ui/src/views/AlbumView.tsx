import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import clsx from 'clsx';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ProviderError,
  formatDurationLong,
  formatReleaseYear,
  uriProvider,
} from '@ritmo/core';
import type { Album, Track, Uri } from '@ritmo/core';

import {
  Button,
  EmptyState,
  ErrorBanner,
  EntityHero,
  Input,
  Modal,
  Skeleton,
  TrackTable,
} from '../components';
import type { MenuItemSpec, TrackRowPending, TrackTableColumn } from '../components';
import {
  useAsync,
  useIsLiked,
  useLibrary,
  useQueue,
  useToast,
  useTranslation,
  useUnsavedGuard,
} from '../hooks';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';
import { Check, Music, Plus, Trash } from '../icons';
import { entityPath } from '../routes';
import { useAddToPackItems } from '../shell/AddToPackMenu';
import { useAddToPlaylistItems } from '../shell/AddToPlaylistMenu';
import { useDeleteAlbum } from '../shell/DeleteAlbum';
import { useRemoveFromLibrary } from '../shell/RemoveFromLibrary';
import { AlbumDetails, useTrackDetails } from '../shell/TrackDetails';
import { useTrackDetailsEditor } from '../shell/TrackDetailsDialog';

const COLUMNS: TrackTableColumn[] = [
  { id: 'index', width: '3rem' },
  { id: 'title' },
  { id: 'duration', width: '5rem' },
];

/** One screenful of candidates; the search box is how a bigger library is narrowed. */
const PICKER_PAGE = 200;

/**
 * Track list edits the user has made but not written.
 *
 * They are held here rather than sent straight to the repo so that removing
 * three tracks and thinking better of it costs nothing: only Save turns any of
 * this into a write.
 */
interface StagedEdits {
  /** Tracks taken off the album, still listed and struck through. */
  removed: Set<Uri>;
  /** Tracks picked in the dialog, listed after the album's own. */
  added: Track[];
}

function noEdits(): StagedEdits {
  return { removed: new Set(), added: [] };
}

function errorBody(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ProviderError && error.code === 'not_found';
}

export function EntityHeroSkeleton({ round }: { round?: boolean }): ReactElement {
  return (
    <div className="flex flex-col gap-5 px-6 pb-6 pt-10 md:flex-row md:items-end md:gap-6" aria-hidden>
      <Skeleton className="h-44 w-44 shrink-0 md:h-[200px] md:w-[200px]" rounded={round ? 'full' : 'sm'} />
      <div className="flex min-w-0 flex-1 flex-col gap-4 border-l-2 border-accent pl-4 md:pl-5">
        <Skeleton className="h-3 w-24" rounded="sm" />
        <Skeleton className="h-9 w-2/3" rounded="sm" />
        <Skeleton className="h-3 w-1/3" rounded="sm" />
        <div className="flex gap-2">
          <Skeleton className="h-14 w-14" rounded="md" />
          <Skeleton className="h-11 w-11" rounded="md" />
        </div>
      </div>
    </div>
  );
}

export function TrackListSkeleton({ rows = 8 }: { rows?: number }): ReactElement {
  return (
    <div className="flex flex-col gap-px px-6" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" rounded="sm" />
      ))}
    </div>
  );
}

interface DiscGroup {
  disc: number;
  offset: number;
  tracks: Track[];
}

/** Returns disc groups only when the album genuinely spans more than one disc. */
function groupByDisc(tracks: Track[]): DiscGroup[] | undefined {
  const numbers = new Set(tracks.map((track) => track.discNumber ?? 1));
  if (numbers.size <= 1) return undefined;
  const groups: DiscGroup[] = [];
  let offset = 0;
  for (const track of tracks) {
    const disc = track.discNumber ?? 1;
    const last = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (last && last.disc === disc) {
      last.tracks.push(track);
    } else {
      groups.push({ disc, offset, tracks: [track] });
    }
    offset += 1;
  }
  return groups;
}

/**
 * The picker behind "Add tracks".
 *
 * It only ever lists the user's own local tracks: an album stored here is made
 * of rows Ritmo holds, and a provider's catalogue is not ours to reshape. It
 * writes nothing itself — what it hands back is staged with the rest.
 */
function AddTracksDialog({
  album,
  excluded,
  onClose,
  onPick,
}: {
  album: { uri: Uri; name: string };
  excluded: ReadonlySet<Uri>;
  onClose: () => void;
  onPick: (tracks: Track[]) => void;
}): ReactElement {
  const { library } = useServices();
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  // The whole track is kept, not just its uri: a pick has to survive the search
  // being narrowed, and the staged row needs something to render.
  const [chosen, setChosen] = useState<Map<Uri, Track>>(() => new Map());

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(input.trim()), 200);
    return () => window.clearTimeout(id);
  }, [input]);

  const repo = library.repo;
  const albumUri = album.uri;
  const load = useCallback(
    () =>
      repo.listTracks({
        provider: 'local',
        sort: 'title',
        dir: 'asc',
        limit: PICKER_PAGE,
        search: search === '' ? undefined : search,
      }),
    [repo, search],
  );
  const page = useAsync(load, [load], { keepPrevious: true });

  // A track already on this album, or already staged for it, has nothing to
  // gain from being added again.
  const candidates = useMemo(
    () =>
      (page.data?.items ?? []).filter(
        (track) => track.album?.uri !== albumUri && !excluded.has(track.uri),
      ),
    [page.data, albumUri, excluded],
  );

  const toggle = useCallback((track: Track) => {
    setChosen((prev) => {
      const next = new Map(prev);
      if (next.has(track.uri)) next.delete(track.uri);
      else next.set(track.uri, track);
      return next;
    });
  }, []);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('album.addTracksTitle', { name: album.name })}
      description={t('album.addTracksHint')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => onPick([...chosen.values()])}
            disabled={chosen.size === 0}
          >
            {t('album.addTracksAction')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('album.addTracksSearch')}
          aria-label={t('album.addTracksSearch')}
          size="sm"
          clearable
          onClear={() => setInput('')}
          autoFocus
        />

        <div
          role="group"
          aria-label={t('album.addTracks')}
          className="scrollbar-thin max-h-80 min-w-0 overflow-y-auto"
        >
          {page.loading && candidates.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-text-dim">{t('common.loading')}</p>
          ) : candidates.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-text-dim">
              {search === '' ? t('album.addTracksNone') : t('album.addTracksEmpty')}
            </p>
          ) : (
            candidates.map((track) => {
              const picked = chosen.has(track.uri);
              return (
                <button
                  key={track.uri}
                  type="button"
                  aria-pressed={picked}
                  onClick={() => toggle(track)}
                  className={clsx(
                    'flex w-full min-w-0 items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors ease-swift',
                    'hover:bg-surface-2/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    picked && 'bg-surface-2',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'grid h-4 w-4 shrink-0 place-items-center rounded-xs border',
                      picked ? 'border-accent text-accent' : 'border-line',
                    )}
                  >
                    {picked ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{track.title}</span>
                    <span className="block truncate text-xs text-text-dim">
                      {track.artists.map((artist) => artist.name).join(', ')}
                    </span>
                  </span>
                  {track.album !== undefined && track.album.name !== '' ? (
                    <span className="mono max-w-[9rem] shrink-0 truncate text-[11px] text-text-faint">
                      {track.album.name}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}

export function AlbumView(): ReactElement {
  const params = useParams<{ uri: string }>();
  const uri = params.uri === undefined ? '' : decodeURIComponent(params.uri);
  const { registry, library, controller, host } = useServices();
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
  const liked = useIsLiked(uri);

  const fetchAlbum = useCallback(async (): Promise<Album> => {
    if (uri === '') throw new ProviderError('not_found', 'empty uri');
    // Local albums live only in the repo; remote ones may still have a cached
    // copy there, but the provider is authoritative for their track list.
    if (uriProvider(uri) === 'local') {
      const local = await library.repo.getAlbum(uri, true);
      if (local) return local;
    }
    const provider = registry.forUri(uri);
    if (!provider) throw new ProviderError('not_found', uri);
    return provider.getAlbum(uri);
  }, [uri, library, registry]);

  const album = useAsync(fetchAlbum, [fetchAlbum], { keepPrevious: true });
  const data = album.data;
  const { itemsFor: editItems, applyEdits, dialog: editDialog } = useTrackDetailsEditor();
  const { itemsFor: detailsItems, dialog: detailsDialog } = useTrackDetails();
  const {
    itemsFor: removeItems,
    filterRemoved,
    dialog: removeDialog,
  } = useRemoveFromLibrary();

  /**
   * Only a local album's track list is ours to change. A remote one is the
   * provider's, and an edit here would be discarded by its next fetch, so the
   * actions are not offered at all rather than offered and quietly lost.
   */
  const editable = uri !== '' && uriProvider(uri) === 'local';
  const [picking, setPicking] = useState(false);
  const [staged, setStaged] = useState<StagedEdits>(noEdits);
  const [saving, setSaving] = useState(false);

  // Another album is another track list; nothing staged here applies to it.
  useEffect(() => {
    setStaged(noEdits());
  }, [uri]);

  const stored = useMemo(
    () => filterRemoved(applyEdits(data?.tracks ?? [])),
    [applyEdits, filterRemoved, data],
  );

  const tracks = useMemo(() => {
    if (staged.added.length === 0) return stored;
    const present = new Set(stored.map((track) => track.uri));
    return [...stored, ...staged.added.filter((track) => !present.has(track.uri))];
  }, [stored, staged.added]);

  const pendingRows = useMemo(() => {
    const rows = new Map<Uri, TrackRowPending>();
    for (const trackUri of staged.removed) rows.set(trackUri, 'remove');
    for (const track of staged.added) rows.set(track.uri, 'add');
    return rows;
  }, [staged]);

  const pendingLabels = useMemo(
    () => ({ add: t('album.pendingAddition'), remove: t('album.pendingRemoval') }),
    [t],
  );

  /** Already staged for this album, so the picker must not offer them again. */
  const stagedUris = useMemo(
    () => new Set(staged.added.map((track) => track.uri)),
    [staged.added],
  );

  const pendingCount = staged.removed.size + staged.added.length;
  const guard = useUnsavedGuard(pendingCount > 0);

  const addToPlaylist = useAddToPlaylistItems(tracks);
  const addToPack = useAddToPackItems(tracks);

  useEffect(() => {
    if (data) document.title = `${data.name} · Ritmo`;
  }, [data]);

  const totalMs = useMemo(
    () => tracks.reduce((sum, track) => sum + track.durationMs, 0),
    [tracks],
  );

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

  const toggleLike = useCallback(() => {
    if (!data) return;
    void useLibraryStore.getState().toggleEntityLike(data.uri, 'album', data);
  }, [liked, library, data]);

  const download = useCallback(() => {
    if (!data || tracks.length === 0) return;
    // One toast id, re-pushed: the host updates a toast in place when the id
    // repeats, which is how progress is reported without stacking toasts.
    const id = `download:${data.uri}`;
    void (async () => {
      toast.toast({
        id,
        title: t('album.downloading', { count: tracks.length }),
        progress: 0,
        durationMs: 0,
      });
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
        toast.toast({
          id,
          title: t('album.downloading', { count: tracks.length }),
          progress: done / tracks.length,
          durationMs: 0,
        });
      }
      toast.toast({
        id,
        title: failed === 0 ? t('common.downloaded') : t('errors.downloadPartial', { count: failed }),
        tone: failed === 0 ? 'success' : 'warn',
        progress: 1,
      });
      void refresh();
    })();
  }, [data, tracks, toast, t, registry, library, refresh]);

  /**
   * A track the user took off the album, or put back. A row staged as an
   * addition is dropped outright: there is nothing to write either way.
   */
  const toggleRemoval = useCallback((track: Track) => {
    setStaged((prev) => {
      if (prev.added.some((staged) => staged.uri === track.uri)) {
        return { removed: prev.removed, added: prev.added.filter((s) => s.uri !== track.uri) };
      }
      const removed = new Set(prev.removed);
      if (removed.has(track.uri)) removed.delete(track.uri);
      else removed.add(track.uri);
      return { removed, added: prev.added };
    });
  }, []);

  const onTracksPicked = useCallback((picked: Track[]) => {
    setPicking(false);
    setStaged((prev) => {
      const known = new Set(prev.added.map((track) => track.uri));
      const fresh = picked.filter((track) => !known.has(track.uri));
      if (fresh.length === 0) return prev;
      const removed = new Set(prev.removed);
      for (const track of fresh) removed.delete(track.uri);
      return { removed, added: [...prev.added, ...fresh] };
    });
  }, []);

  const discard = useCallback(() => setStaged(noEdits()), []);

  /** Where the page goes once the album it was showing no longer exists. */
  const leaveAlbum = useCallback(() => {
    navigate('/library/albums', { replace: true });
  }, [navigate]);

  const save = useCallback(() => {
    if (!data || saving || pendingCount === 0) return;
    const target = { uri: data.uri, name: data.name };
    const removals = [...staged.removed];
    const additions = staged.added.map((track) => track.uri);
    setSaving(true);
    void (async () => {
      try {
        for (const trackUri of removals) await library.repo.setTrackAlbum(trackUri, undefined);
        for (const trackUri of additions) await library.repo.setTrackAlbum(trackUri, target);
        // Emptying an album leaves its row behind holding nothing, which is what
        // kept the Library counting an album the user had already cleared out.
        await library.repo.vacuumOrphans();
        setStaged(noEdits());
        toast.toast({ title: t('album.changesSaved'), tone: 'success' });
        void refresh();
        // Removing the last track deletes the album with it, and re-reading a
        // row that is gone would leave the old list on screen.
        if ((await library.repo.getAlbum(target.uri)) === undefined) leaveAlbum();
        else album.reload();
      } catch (e: unknown) {
        toast.toast({
          title: t('album.changesFailed'),
          body: errorBody(e),
          tone: 'danger',
          durationMs: 6000,
        });
      } finally {
        setSaving(false);
      }
    })();
  }, [album, data, leaveAlbum, library, pendingCount, refresh, saving, staged, t, toast]);

  const { request: requestDelete, dialog: deleteDialog } = useDeleteAlbum(leaveAlbum);

  const rowMenuItems = useCallback(
    (track: Track): MenuItemSpec[] => {
      const items: MenuItemSpec[] = [
        { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue([track]) },
        { id: 'next', label: t('queue.playNext'), onSelect: () => queue.addNext([track]) },
        { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, separatorBefore: true },
        { id: 'add-pack', label: t('pack.addTo'), items: addToPack },
      ];
      if (editable) {
        const undoes = pendingRows.get(track.uri) === 'remove';
        items.push({
          id: 'remove-from-album',
          label: undoes ? t('album.keepInAlbum') : t('album.removeFromAlbum'),
          danger: !undoes,
          separatorBefore: true,
          onSelect: () => toggleRemoval(track),
        });
      }
      items.push(...detailsItems(track), ...editItems(track));
      // A remote album's rows come from the provider and may not be stored at
      // all, so forgetting one only makes sense on a local album.
      if (editable) items.push(...removeItems(track));
      return items;
    },
    [
      addToPack,
      addToPlaylist,
      detailsItems,
      editItems,
      editable,
      pendingRows,
      queue,
      removeItems,
      t,
      toggleRemoval,
    ],
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
    const firstArtist = data.artists[0];
    const items: MenuItemSpec[] = [];
    if (editable) {
      items.push({
        id: 'add-tracks',
        label: t('album.addTracks'),
        icon: Plus,
        onSelect: () => setPicking(true),
      });
    }
    items.push(
      { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue(tracks), separatorBefore: editable },
      { id: 'add', label: t('playlist.addTo'), items: addToPlaylist },
    );
    if (host.capabilities.offlineDownloads) {
      items.push({ id: 'download', label: t('common.download'), onSelect: download, separatorBefore: true });
    }
    items.push({
      id: 'artist',
      label: t('album.goToArtist'),
      separatorBefore: true,
      disabled: firstArtist === undefined,
      onSelect: () => {
        if (firstArtist) navigate(entityPath(firstArtist.uri));
      },
    });
    items.push({ id: 'copy', label: t('common.copyLink'), onSelect: copyLink });
    if (editable) {
      items.push({
        id: 'delete-album',
        label: t('album.deleteAlbum'),
        icon: Trash,
        danger: true,
        separatorBefore: true,
        // The stored track list, not the staged one: what is on disk in the
        // database is what the delete has to account for.
        onSelect: () => requestDelete({ uri: data.uri, name: data.name }, stored),
      });
    }
    return items;
  }, [
    data,
    t,
    queue,
    tracks,
    stored,
    addToPlaylist,
    host,
    download,
    navigate,
    copyLink,
    editable,
    requestDelete,
  ]);

  const eyebrow = useMemo(() => {
    switch ((data?.albumType ?? 'album').toLowerCase()) {
      case 'single':
        return t('album.single');
      case 'ep':
        return t('album.ep');
      case 'compilation':
        return t('album.compilation');
      default:
        return t('album.album');
    }
  }, [data, t]);

  if (album.loading && data === undefined) {
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
          title={isNotFound(album.error) ? t('errors.notFound') : t('errors.loadFailed')}
          body={errorBody(album.error)}
          onRetry={album.reload}
        />
      </div>
    );
  }

  const discs = groupByDisc(tracks);
  const providerName = registry.get(data.provider)?.displayName ?? data.provider;
  const year = formatReleaseYear(data.releaseDate);
  const playingThis = isPlaying && contextUri === data.uri;

  const subtitle = (
    <span className="flex flex-wrap items-center gap-1">
      {data.artists.map((artist, i) => (
        <span key={artist.uri} className="flex items-center gap-1">
          {i > 0 ? <span aria-hidden className="text-text-faint">·</span> : null}
          <Link
            to={entityPath(artist.uri)}
            className="font-medium text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {artist.name}
          </Link>
        </span>
      ))}
    </span>
  );

  const meta = [
    year !== '' ? year : undefined,
    t('album.trackCount', { count: tracks.length || (data.totalTracks ?? 0) }),
    totalMs > 0 ? formatDurationLong(totalMs, lang) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  const tableProps = {
    columns: COLUMNS,
    hideAlbum: true,
    currentUri,
    playing: isPlaying,
    likedSet: likedUris,
    offlineSet: offlineUris,
    menuItemsFor: rowMenuItems,
    onToggleLike: (track: Track) => void useLibraryStore.getState().toggleLike(track),
    ...(editable
      ? {
          onRemoveTrack: toggleRemoval,
          removeLabel: t('album.removeFromAlbum'),
          restoreLabel: t('album.keepInAlbum'),
          pendingRows,
          pendingLabels,
        }
      : {}),
  };

  return (
    <div className="flex flex-col gap-8 pb-12">
      <EntityHero
        kind="album"
        eyebrow={eyebrow}
        title={data.name}
        subtitle={subtitle}
        meta={meta}
        artwork={data.artwork}
        playing={playingThis}
        onPlay={() => (playingThis ? void controller.toggle() : play(0))}
        onShuffle={shuffle}
        liked={liked}
        onToggleLike={toggleLike}
        menuItems={menuItems}
      />

      <div className="flex flex-col gap-8 px-6">
        {editable ? (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="rule-label min-w-0 flex-1 truncate">{t('album.tracks')}</h2>
              <Button
                variant="outline"
                size="sm"
                leading={Plus}
                className="shrink-0"
                onClick={() => setPicking(true)}
              >
                {t('album.addTracks')}
              </Button>
            </div>

            {pendingCount > 0 ? (
              <div className="tile flex min-w-0 items-center gap-3 rounded-md px-3 py-2">
                <p className="mono min-w-0 flex-1 truncate text-[12px] text-text-dim">
                  {pendingCount === 1
                    ? t('album.pendingChange')
                    : t('album.pendingChanges', { count: pendingCount })}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
                    {t('album.discardChanges')}
                  </Button>
                  <Button variant="primary" size="sm" loading={saving} onClick={save}>
                    {t('album.saveChanges')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {tracks.length === 0 ? (
          <EmptyState
            icon={Music}
            title={editable ? t('album.emptyLocalTracks') : t('album.emptyTracks')}
            body={editable ? t('album.emptyLocalTracksBody') : t('album.emptyTracksBody')}
            action={
              editable ? { label: t('album.addTracks'), onClick: () => setPicking(true) } : undefined
            }
          />
        ) : discs === undefined ? (
          <TrackTable tracks={tracks} onPlay={play} {...tableProps} />
        ) : (
          discs.map((group) => (
            <section key={`${group.disc}-${group.offset}`} className="flex flex-col gap-2">
              <h2 className="rule-label">{t('album.disc', { number: group.disc })}</h2>
              <TrackTable
                tracks={group.tracks}
                onPlay={(index) => play(group.offset + index)}
                {...tableProps}
              />
            </section>
          ))
        )}

        {detailsDialog}
        {editDialog}
        {removeDialog}
        {deleteDialog}
        {picking ? (
          <AddTracksDialog
            album={{ uri: data.uri, name: data.name }}
            excluded={stagedUris}
            onClose={() => setPicking(false)}
            onPick={onTracksPicked}
          />
        ) : null}

        <Modal
          open={guard.asking}
          onClose={guard.stay}
          size="sm"
          title={t('album.leaveTitle')}
          description={t('album.leaveBody')}
          actions={
            <>
              <Button variant="ghost" onClick={guard.stay}>
                {t('album.stayAction')}
              </Button>
              <Button variant="danger" onClick={guard.leave}>
                {t('album.leaveAction')}
              </Button>
            </>
          }
        />

        {editable ? <AlbumDetails tracks={stored} /> : null}

        <p className="mono text-[11px] leading-relaxed text-text-faint">
          {t('album.providerLine', { provider: providerName })}
          {year !== '' ? ` · ${t('album.releasedIn', { year })}` : ''}
        </p>
      </div>
    </div>
  );
}

export default AlbumView;
