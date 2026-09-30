import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatCount } from '@ritmo/core';
import type { Album, Artist, Artwork, Page, Track, Uri } from '@ritmo/core';

import {
  Artwork as ArtworkImage,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  IconButton,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  Spinner,
  Tabs,
  TrackTable,
} from '../components';
import type { MenuItemSpec, TrackTableColumn } from '../components';
import { useAsync, useQueue, useToast, useTranslation } from '../hooks';
import { useServices } from '../services';
import {
  useLibraryStore,
  usePacksStore,
  usePlayerStore,
  useSettingsStore,
  useUiStore,
} from '../store';
import { Disc, FolderPlus, Music, Plus, Users } from '../icons';
import type { IconComponent } from '../icons';
import { entityPath } from '../routes';
import { useAddMusic } from '../shell/AddMusic';
import { useAddToPackItems } from '../shell/AddToPackMenu';
import { useAddToPlaylistItems } from '../shell/AddToPlaylistMenu';
import { useRemoveFromLibrary } from '../shell/RemoveFromLibrary';
import { useTrackDetailsEditor } from '../shell/TrackDetailsDialog';
import { LibraryCollections } from './LibraryCollections';

type LibraryTab = 'songs' | 'albums' | 'artists' | 'playlists';
type SortKey = 'title' | 'artist' | 'album' | 'added' | 'duration' | 'plays';
type SortDir = 'asc' | 'desc';

const TAB_IDS: readonly LibraryTab[] = ['songs', 'albums', 'artists', 'playlists'];
const SORT_KEYS: readonly SortKey[] = ['title', 'artist', 'album', 'added', 'duration', 'plays'];
const PAGE_SIZE = 120;
const GRID_CLASS =
  'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6';

function isLibraryTab(value: string | undefined): value is LibraryTab {
  return value !== undefined && (TAB_IDS as readonly string[]).includes(value);
}

function isSortKey(value: string | undefined): value is SortKey {
  return value !== undefined && (SORT_KEYS as readonly string[]).includes(value);
}

function isSortDir(value: string | undefined): value is SortDir {
  return value === 'asc' || value === 'desc';
}

function errorBody(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

const TRACK_COLUMNS: TrackTableColumn[] = [
  { id: 'index', width: '3rem' },
  { id: 'title', sortable: true },
  { id: 'album', sortable: true },
  { id: 'added', sortable: true, width: '8rem' },
  { id: 'duration', sortable: true, width: '5rem' },
];

/** Table column ids and `ListOpts.sort` keys overlap but are not identical. */
function columnToSort(column: TrackTableColumn['id']): SortKey | undefined {
  switch (column) {
    case 'title':
      return 'title';
    case 'album':
      return 'album';
    case 'added':
      return 'added';
    case 'duration':
      return 'duration';
    case 'plays':
      return 'plays';
    default:
      return undefined;
  }
}

interface Paged<T> {
  items: T[];
  loading: boolean;
  error: unknown;
  appendError: unknown;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Keyset paging on top of `useAsync`: the first page keeps the shared
 * loading/error/retry behaviour, later pages are appended locally so a
 * refetch of page one (new filter or sort) discards them.
 */
function usePaged<T>(load: (cursor?: string) => Promise<Page<T>>): Paged<T> {
  const first = useAsync(() => load(undefined), [load], { keepPrevious: true });
  const [extra, setExtra] = useState<Array<Page<T>>>([]);
  const [busy, setBusy] = useState(false);
  const [appendError, setAppendError] = useState<unknown>(undefined);
  const firstPage = first.data;

  useEffect(() => {
    setExtra([]);
    setAppendError(undefined);
  }, [firstPage]);

  const lastExtra = extra.length > 0 ? extra[extra.length - 1] : undefined;
  const cursor = lastExtra ? lastExtra.cursor : firstPage?.cursor;

  const items = useMemo(
    () => [...(firstPage?.items ?? []), ...extra.flatMap((page) => page.items)],
    [firstPage, extra],
  );

  const loadMore = useCallback(() => {
    if (busy || cursor === undefined) return;
    setBusy(true);
    setAppendError(undefined);
    load(cursor)
      .then((page) => setExtra((prev) => [...prev, page]))
      .catch((e: unknown) => setAppendError(e))
      .finally(() => setBusy(false));
  }, [busy, cursor, load]);

  return {
    items,
    loading: first.loading,
    error: first.error,
    appendError,
    hasMore: cursor !== undefined,
    loadMore,
    reload: first.reload,
  };
}

function EndSentinel({ enabled, onReach }: { enabled: boolean; onReach: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReach();
      },
      { rootMargin: '480px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, onReach]);

  return <div ref={ref} aria-hidden className="h-6 w-full" />;
}

function GridSkeleton({ round }: { round?: boolean }): ReactElement {
  return (
    <div className={GRID_CLASS} aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="aspect-square w-full" rounded={round ? 'full' : 'sm'} />
          <Skeleton className="h-3 w-3/4" rounded="sm" />
          <Skeleton className="h-3 w-1/2" rounded="sm" />
        </div>
      ))}
    </div>
  );
}

function EntityRow({
  title,
  subtitle,
  artwork,
  round,
  onOpen,
}: {
  title: string;
  subtitle?: string;
  artwork?: Artwork;
  round?: boolean;
  onOpen: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-b border-line/50 px-2 py-2 text-left transition-colors ease-swift hover:bg-surface-2/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      <ArtworkImage
        artwork={artwork}
        size={44}
        name={title}
        shape={round ? 'circle' : 'square'}
        rounded="xs"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text">{title}</span>
        {subtitle !== undefined && subtitle !== '' ? (
          <span className="block truncate text-xs text-text-dim">{subtitle}</span>
        ) : null}
      </span>
    </button>
  );
}

/** One labelled "add music" action: the button plus what it will actually do. */
function AddTile({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <div className="tile flex min-w-0 flex-col gap-2 rounded-sm p-3">
      <Button
        variant="outline"
        size="sm"
        leading={icon}
        className="self-start"
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </Button>
      <p className="min-w-0 text-xs leading-5 text-text-dim">{hint}</p>
    </div>
  );
}

/**
 * Everything that puts music in the library, behind the header's `+`. Local
 * files are not a place of their own: whatever lands here shows up in Songs and
 * Albums like the rest.
 */
function AddMusicDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}): ReactElement {
  const { host } = useServices();
  const { t } = useTranslation();
  const scanning = useLibraryStore((s) => s.scanning);
  const startScan = useLibraryStore((s) => s.startScan);
  const folders = useSettingsStore((s) => s.settings.musicFolders);
  const patch = useSettingsStore((s) => s.patch);
  const add = useAddMusic({ onAdded });

  const addFolder = useCallback(() => {
    void (async () => {
      const picked = await host.files.pickFolder().catch(() => undefined);
      if (picked === undefined || folders.includes(picked)) return;
      patch({ musicFolders: [...folders, picked] });
      // The shell watches the scan and owns its progress and result toasts.
      void startScan([picked]);
    })();
  }, [host, folders, patch, startScan]);

  /** Each action hands off to a native picker, so the dialog steps aside first. */
  const run = useCallback(
    (action: () => void) => {
      onClose();
      action();
    },
    [onClose],
  );

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('library.addMusic')}
        size="md"
        actions={
          <Button variant="subtle" onClick={onClose}>
            {t('common.close')}
          </Button>
        }
      >
        {/* Three separate things, because the consequences differ: loose files do
            not turn their folder into a scanned root, an album folder and a
            library root do. */}
        <div className="flex min-w-0 flex-col gap-3">
          {add.canAddSingle ? (
            <AddTile
              icon={Music}
              label={t('library.addSingle')}
              hint={t('library.addSingleHint')}
              disabled={add.busy}
              onClick={() => run(add.addSingle)}
            />
          ) : null}
          {add.canAddAlbum ? (
            <AddTile
              icon={Disc}
              label={t('library.addAlbum')}
              hint={t('library.addAlbumHint')}
              disabled={add.busy || scanning}
              onClick={() => run(add.addAlbum)}
            />
          ) : null}
          <AddTile
            icon={FolderPlus}
            label={t('library.addFolder')}
            hint={t('library.addFolderHint')}
            disabled={add.busy || scanning}
            onClick={() => run(addFolder)}
          />
        </div>
      </Modal>
      {add.errorsDialog}
    </>
  );
}

export function LibraryView(): ReactElement {
  const params = useParams<{ tab: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { host } = useServices();
  const rawTab = params.tab === undefined ? undefined : decodeURIComponent(params.tab);
  const tab: LibraryTab = isLibraryTab(rawTab) ? rawTab : 'songs';

  const stats = useLibraryStore((s) => s.stats);
  const playlists = useLibraryStore((s) => s.playlists);
  const packCount = usePacksStore((s) => s.packs.length);
  const view = useUiStore((s) => s.libraryView);
  const setView = useUiStore((s) => s.setLibraryView);

  const canAddMusic = host.capabilities.localFiles;
  const [adding, setAdding] = useState(false);
  /**
   * Bumped once an import lands. It keys the tab below, and remounting it is
   * what re-runs the first page query the new tracks belong in.
   */
  const [revision, setRevision] = useState(0);

  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('added');
  const [dir, setDir] = useState<SortDir>('desc');

  useEffect(() => {
    const id = window.setTimeout(() => setFilter(filterInput.trim()), 200);
    return () => window.clearTimeout(id);
  }, [filterInput]);

  useEffect(() => {
    document.title = `${t('library.title')} · Ritmo`;
  }, [t]);

  const tabItems = useMemo(
    () => [
      { id: 'songs' as const, label: t('library.songs'), count: stats?.tracks },
      { id: 'albums' as const, label: t('library.albums'), count: stats?.albums },
      { id: 'artists' as const, label: t('library.artists'), count: stats?.artists },
      // The playlists tab carries the packs too, so its count covers both.
      {
        id: 'playlists' as const,
        label: t('library.playlists'),
        count: playlists.length + packCount,
      },
    ],
    [t, stats, playlists.length, packCount],
  );

  /**
   * Field and direction are one control: a separate direction toggle said
   * nothing the option label cannot say, and the trigger now reads the whole
   * sort at a glance.
   */
  const sortOptions = useMemo(() => {
    const fields: Array<{ key: SortKey; label: string }> = [
      { key: 'title', label: t('library.sortTitle') },
      { key: 'artist', label: t('library.sortArtist') },
      { key: 'album', label: t('library.sortAlbum') },
      { key: 'added', label: t('library.sortAdded') },
      { key: 'duration', label: t('library.sortDuration') },
      { key: 'plays', label: t('library.sortPlays') },
    ];
    return fields.flatMap(({ key, label }) =>
      (['asc', 'desc'] as const).map((direction) => ({
        value: `${key}:${direction}`,
        label: `${label} · ${
          direction === 'asc' ? t('library.sortAscending') : t('library.sortDescending')
        }`,
      })),
    );
  }, [t]);

  const sortControl = useMemo<SortControl>(() => ({ sort, dir, setSort, setDir }), [sort, dir]);
  const showViewToggle = tab === 'albums' || tab === 'artists';
  const showSort = tab !== 'playlists';
  const openAddMusic = useCallback(() => setAdding(true), []);

  return (
    <div className="flex min-h-full flex-col gap-6 px-6 pb-12 pt-6">
      <header className="flex flex-col gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight text-text">
            {t('library.title')}
          </h1>
          {canAddMusic ? (
            <IconButton
              icon={Plus}
              label={t('library.addMusic')}
              className="shrink-0"
              onClick={openAddMusic}
            />
          ) : null}
        </div>
        <Tabs
          items={tabItems}
          value={tab}
          onChange={(id) => navigate(`/library/${id}`)}
        />
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded-sm border border-line px-3 py-2">
        <Input
          value={filterInput}
          onChange={(e) => setFilterInput(e.target.value)}
          placeholder={t('library.filter')}
          aria-label={t('library.filter')}
          size="sm"
          clearable
          onClear={() => setFilterInput('')}
          className="w-full max-w-xs"
        />
        {showSort ? (
          <Select
            value={`${sort}:${dir}`}
            options={sortOptions}
            onChange={(value) => {
              const [nextSort, nextDir] = value.split(':');
              if (!isSortKey(nextSort) || !isSortDir(nextDir)) return;
              setSort(nextSort);
              setDir(nextDir);
            }}
            label={t('library.sort')}
            size="sm"
            className="shrink-0"
          />
        ) : null}
        {showViewToggle ? (
          <SegmentedControl
            items={[
              { id: 'grid' as const, label: t('common.grid') },
              { id: 'list' as const, label: t('common.list') },
            ]}
            value={view}
            onChange={(id) => setView(id)}
            className="ml-auto"
          />
        ) : null}
      </div>

      {tab === 'songs' ? (
        <SongsTab
          key={revision}
          filter={filter}
          control={sortControl}
          onAddMusic={canAddMusic ? openAddMusic : undefined}
        />
      ) : null}
      {tab === 'albums' ? (
        <AlbumsTab
          key={revision}
          filter={filter}
          sort={sort}
          dir={dir}
          view={view}
          onAddMusic={canAddMusic ? openAddMusic : undefined}
        />
      ) : null}
      {tab === 'artists' ? (
        <ArtistsTab
          key={revision}
          filter={filter}
          sort={sort}
          dir={dir}
          view={view}
          onAddMusic={canAddMusic ? openAddMusic : undefined}
        />
      ) : null}
      {tab === 'playlists' ? <LibraryCollections filter={filter} /> : null}

      {canAddMusic ? (
        <AddMusicDialog
          open={adding}
          onClose={() => setAdding(false)}
          onAdded={() => setRevision((n) => n + 1)}
        />
      ) : null}
    </div>
  );
}

// ── shared track-table plumbing ─────────────────────────────────────────────

function useTrackTableBits(input: Track[], contextName: string) {
  const { controller, library, registry, host } = useServices();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queue = useQueue();
  const toast = useToast();
  const likedUris = useLibraryStore((s) => s.likedUris);
  const offlineUris = useLibraryStore((s) => s.offlineUris);
  const currentUri = usePlayerStore((s) => s.current?.uri);
  const playing = usePlayerStore((s) => s.status === 'playing');

  // Destructured so the memo below keeps a stable dependency: the editor object
  // itself is rebuilt every render, its callbacks are not.
  const { itemsFor: editItems, applyEdits, dialog: editDialog } = useTrackDetailsEditor();
  const {
    itemsFor: removeItems,
    filterRemoved,
    dialog: removeDialog,
  } = useRemoveFromLibrary();
  const tracks = useMemo(
    () => filterRemoved(applyEdits(input)),
    [applyEdits, filterRemoved, input],
  );
  const addToPlaylist = useAddToPlaylistItems(tracks);
  const addToPack = useAddToPackItems(tracks);

  const onPlay = useCallback(
    (index: number) => {
      void controller.playContext(tracks, index, { name: contextName });
    },
    [controller, tracks, contextName],
  );

  const onToggleLike = useCallback(
    (track: Track) => {
      void useLibraryStore.getState().toggleLike(track);
    },
    [library],
  );

  const menuItemsFor = useCallback(
    (track: Track): MenuItemSpec[] => {
      const items: MenuItemSpec[] = [
        { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue([track]) },
        { id: 'next', label: t('queue.playNext'), onSelect: () => queue.addNext([track]) },
        { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, separatorBefore: true },
        { id: 'add-pack', label: t('pack.addTo'), items: addToPack },
        {
          id: 'radio',
          label: t('artist.startRadio'),
          onSelect: () => {
            void controller.startRadio(track);
          },
        },
      ];
      if (track.album) {
        const album = track.album;
        items.push({
          id: 'album',
          label: t('album.goToAlbum'),
          separatorBefore: true,
          onSelect: () => navigate(entityPath(album.uri)),
        });
      }
      if (host.capabilities.offlineDownloads && !offlineUris.has(track.uri)) {
        items.push({
          id: 'download',
          label: t('common.download'),
          separatorBefore: true,
          onSelect: () => {
            // One id re-pushed keeps a single toast that reports live progress.
            const id = `download:${track.uri}`;
            void (async () => {
              toast.toast({ id, title: t('common.download'), progress: 0, durationMs: 0 });
              try {
                const stream = await registry.resolveStream(track);
                await library.offline.download(track, stream, (received, total) => {
                  if (total !== undefined && total > 0) {
                    toast.toast({
                      id,
                      title: t('common.download'),
                      progress: received / total,
                      durationMs: 0,
                    });
                  }
                });
                toast.toast({
                  id,
                  title: t('common.downloaded'),
                  progress: 1,
                  durationMs: 3000,
                  tone: 'success',
                });
              } catch (e: unknown) {
                toast.toast({
                  id,
                  title: t('errors.downloadFailed'),
                  body: errorBody(e),
                  tone: 'danger',
                  durationMs: 6000,
                });
              }
            })();
          },
        });
      }
      items.push(...editItems(track), ...removeItems(track));
      return items;
    },
    [
      t,
      navigate,
      queue,
      addToPlaylist,
      addToPack,
      controller,
      host,
      offlineUris,
      toast,
      registry,
      library,
      editItems,
      removeItems,
    ],
  );

  return {
    tracks,
    editDialog,
    removeDialog,
    likedUris,
    offlineUris,
    currentUri,
    playing,
    onPlay,
    onToggleLike,
    menuItemsFor,
  };
}

interface SortControl {
  sort: SortKey;
  dir: SortDir;
  setSort: (sort: SortKey) => void;
  setDir: (dir: SortDir) => void;
}

/** Bridges the table's column ids to the `ListOpts` sort keys. */
function useTableSort(control: SortControl): {
  sort: { column: TrackTableColumn['id']; dir: SortDir };
  onSort: (id: TrackTableColumn['id']) => void;
} {
  const { sort, dir, setSort, setDir } = control;
  const column: TrackTableColumn['id'] = sort === 'artist' ? 'title' : sort;
  const onSort = useCallback(
    (id: TrackTableColumn['id']) => {
      const next = columnToSort(id);
      if (next === undefined) return;
      if (next === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
      else setSort(next);
    },
    [sort, dir, setSort, setDir],
  );
  return { sort: { column, dir }, onSort };
}

// ── songs ───────────────────────────────────────────────────────────────────

function SongsTab({
  filter,
  control,
  onAddMusic,
}: {
  filter: string;
  control: SortControl;
  onAddMusic?: () => void;
}): ReactElement {
  const { library } = useServices();
  const { t } = useTranslation();
  const repo = library.repo;
  const { sort, dir } = control;
  const table = useTableSort(control);

  const load = useCallback(
    (cursor?: string) =>
      repo.listTracks({ sort, dir, limit: PAGE_SIZE, cursor, search: filter === '' ? undefined : filter }),
    [repo, sort, dir, filter],
  );
  const page = usePaged<Track>(load);
  const bits = useTrackTableBits(page.items, t('library.songs'));

  if (page.error !== undefined && page.items.length === 0) {
    return (
      <ErrorBanner
        title={t('errors.loadFailed')}
        body={errorBody(page.error)}
        onRetry={page.reload}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {page.appendError !== undefined ? (
        <ErrorBanner
          tone="warn"
          title={t('errors.loadFailed')}
          body={errorBody(page.appendError)}
          onRetry={page.loadMore}
        />
      ) : null}
      <TrackTable
        tracks={bits.tracks}
        columns={TRACK_COLUMNS}
        loading={page.loading}
        currentUri={bits.currentUri}
        playing={bits.playing}
        likedSet={bits.likedUris}
        offlineSet={bits.offlineUris}
        onPlay={bits.onPlay}
        onToggleLike={bits.onToggleLike}
        menuItemsFor={bits.menuItemsFor}
        onEndReached={page.loadMore}
        sort={table.sort}
        onSort={table.onSort}
        emptyState={
          <EmptyState
            icon={Music}
            title={t('library.empty')}
            body={t('library.emptyBody')}
            action={onAddMusic ? { label: t('library.addMusic'), onClick: onAddMusic } : undefined}
          />
        }
      />
      {bits.editDialog}
      {bits.removeDialog}
    </div>
  );
}

// ── albums ──────────────────────────────────────────────────────────────────

function AlbumsTab({
  filter,
  sort,
  dir,
  view,
  onAddMusic,
}: {
  filter: string;
  sort: SortKey;
  dir: SortDir;
  view: 'grid' | 'list';
  onAddMusic?: () => void;
}): ReactElement {
  const { library, registry, controller } = useServices();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queue = useQueue();
  const currentUri = usePlayerStore((s) => s.current?.album?.uri);
  const repo = library.repo;

  const load = useCallback(
    (cursor?: string) =>
      repo.listAlbums({ sort, dir, limit: PAGE_SIZE, cursor, search: filter === '' ? undefined : filter }),
    [repo, sort, dir, filter],
  );
  const page = usePaged<Album>(load);

  const albumTracks = useCallback(
    async (uri: Uri): Promise<Track[]> => {
      const local = await repo.getAlbum(uri, true);
      if (local?.tracks && local.tracks.length > 0) return local.tracks;
      const provider = registry.forUri(uri);
      if (!provider) return [];
      const remote = await provider.getAlbum(uri);
      return remote.tracks ?? [];
    },
    [repo, registry],
  );

  const playAlbum = useCallback(
    (album: Album) => {
      void (async () => {
        const tracks = await albumTracks(album.uri);
        if (tracks.length > 0) {
          await controller.playContext(tracks, 0, { uri: album.uri, name: album.name });
        }
      })();
    },
    [albumTracks, controller],
  );

  const menuFor = useCallback(
    (album: Album): MenuItemSpec[] => [
      {
        id: 'queue',
        label: t('queue.addToQueue'),
        onSelect: () => {
          void albumTracks(album.uri).then((tracks) => queue.addToQueue(tracks));
        },
      },
      {
        id: 'artist',
        label: t('album.goToArtist'),
        disabled: album.artists.length === 0,
        onSelect: () => {
          const artist = album.artists[0];
          if (artist) navigate(entityPath(artist.uri));
        },
      },
    ],
    [t, albumTracks, queue, navigate],
  );

  if (page.error !== undefined && page.items.length === 0) {
    return <ErrorBanner title={t('errors.loadFailed')} body={errorBody(page.error)} onRetry={page.reload} />;
  }
  if (page.loading && page.items.length === 0) return <GridSkeleton />;
  if (page.items.length === 0) {
    return (
      <EmptyState
        icon={Disc}
        title={t('library.empty')}
        body={t('library.emptyBody')}
        action={onAddMusic ? { label: t('library.addMusic'), onClick: onAddMusic } : undefined}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {view === 'grid' ? (
        <div className={GRID_CLASS}>
          {page.items.map((album) => (
            <Card
              key={album.uri}
              kind="album"
              uri={album.uri}
              title={album.name}
              subtitle={album.artists.map((a) => a.name).join(', ')}
              artwork={album.artwork}
              playing={currentUri === album.uri}
              onOpen={() => navigate(entityPath(album.uri))}
              onPlay={() => playAlbum(album)}
              menuItems={menuFor(album)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col">
          {page.items.map((album) => (
            <EntityRow
              key={album.uri}
              title={album.name}
              subtitle={album.artists.map((a) => a.name).join(', ')}
              artwork={album.artwork}
              onOpen={() => navigate(entityPath(album.uri))}
            />
          ))}
        </div>
      )}
      <EndSentinel enabled={page.hasMore} onReach={page.loadMore} />
      {page.hasMore ? <Spinner className="mx-auto" /> : null}
    </div>
  );
}

// ── artists ─────────────────────────────────────────────────────────────────

function ArtistsTab({
  filter,
  sort,
  dir,
  view,
  onAddMusic,
}: {
  filter: string;
  sort: SortKey;
  dir: SortDir;
  view: 'grid' | 'list';
  onAddMusic?: () => void;
}): ReactElement {
  const { library } = useServices();
  const { t, lang } = useTranslation();
  const navigate = useNavigate();
  const repo = library.repo;

  const load = useCallback(
    (cursor?: string) =>
      repo.listArtists({ sort, dir, limit: PAGE_SIZE, cursor, search: filter === '' ? undefined : filter }),
    [repo, sort, dir, filter],
  );
  const page = usePaged<Artist>(load);

  if (page.error !== undefined && page.items.length === 0) {
    return <ErrorBanner title={t('errors.loadFailed')} body={errorBody(page.error)} onRetry={page.reload} />;
  }
  if (page.loading && page.items.length === 0) return <GridSkeleton round />;
  if (page.items.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={t('library.empty')}
        body={t('library.emptyBody')}
        action={onAddMusic ? { label: t('library.addMusic'), onClick: onAddMusic } : undefined}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {view === 'grid' ? (
        <div className={GRID_CLASS}>
          {page.items.map((artist) => (
            <Card
              key={artist.uri}
              kind="artist"
              uri={artist.uri}
              title={artist.name}
              subtitle={
                artist.followers === undefined
                  ? undefined
                  : t('artist.followers', { count: formatCount(artist.followers, lang) })
              }
              artwork={artist.artwork}
              onOpen={() => navigate(entityPath(artist.uri))}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col">
          {page.items.map((artist) => (
            <EntityRow
              key={artist.uri}
              round
              title={artist.name}
              subtitle={artist.genres?.join(', ')}
              artwork={artist.artwork}
              onOpen={() => navigate(entityPath(artist.uri))}
            />
          ))}
        </div>
      )}
      <EndSentinel enabled={page.hasMore} onReach={page.loadMore} />
      {page.hasMore ? <Spinner className="mx-auto" /> : null}
    </div>
  );
}

export default LibraryView;
