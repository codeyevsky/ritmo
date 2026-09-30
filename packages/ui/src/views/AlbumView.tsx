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
import type { MenuItemSpec, TrackTableColumn } from '../components';
import { useAsync, useIsLiked, useLibrary, useQueue, useToast, useTranslation } from '../hooks';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';
import { Check, Music, Plus } from '../icons';
import { entityPath } from '../routes';
import { useAddToPackItems } from '../shell/AddToPackMenu';
import { useAddToPlaylistItems } from '../shell/AddToPlaylistMenu';
import { useRemoveFromLibrary } from '../shell/RemoveFromLibrary';
import { useTrackDetailsEditor } from '../shell/TrackDetailsDialog';

const COLUMNS: TrackTableColumn[] = [
  { id: 'index', width: '3rem' },
  { id: 'title' },
  { id: 'duration', width: '5rem' },
];

/** One screenful of candidates; the search box is how a bigger library is narrowed. */
const PICKER_PAGE = 200;

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
 * of rows Ritmo holds, and a provider's catalogue is not ours to reshape.
 */
function AddTracksDialog({
  album,
  onClose,
  onAdded,
}: {
  album: { uri: Uri; name: string };
  onClose: () => void;
  onAdded: (count: number) => void;
}): ReactElement {
  const { library } = useServices();
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<Set<Uri>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);

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

  // A track already on this album has nothing to gain from being added again.
  const candidates = useMemo(
    () => (page.data?.items ?? []).filter((track) => track.album?.uri !== albumUri),
    [page.data, albumUri],
  );

  const toggle = useCallback((trackUri: Uri) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(trackUri)) next.delete(trackUri);
      else next.add(trackUri);
      return next;
    });
  }, []);

  const save = useCallback(() => {
    if (chosen.size === 0 || saving) return;
    setSaving(true);
    setFailed(undefined);
    const picked = [...chosen];
    void (async () => {
      try {
        for (const trackUri of picked) {
          await repo.setTrackAlbum(trackUri, { uri: albumUri, name: album.name });
        }
        onAdded(picked.length);
      } catch (e: unknown) {
        setFailed(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    })();
  }, [album.name, albumUri, chosen, onAdded, repo, saving]);

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      title={t('album.addTracksTitle', { name: album.name })}
      description={t('album.addTracksHint')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={save}
            loading={saving}
            disabled={chosen.size === 0}
          >
            {t('album.addTracksAction')}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {failed !== undefined ? (
          <ErrorBanner
            title={t('album.addTracksFailed')}
            body={failed}
            tone="danger"
            onDismiss={() => setFailed(undefined)}
          />
        ) : null}

        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('album.addTracksSearch')}
          aria-label={t('album.addTracksSearch')}
          size="sm"
          clearable
          onClear={() => setInput('')}
          autoFocus
          disabled={saving}
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
                  disabled={saving}
                  onClick={() => toggle(track.uri)}
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
  const {
    itemsFor: removeItems,
    filterRemoved,
    dialog: removeDialog,
  } = useRemoveFromLibrary();
  const tracks = useMemo(
    () => filterRemoved(applyEdits(data?.tracks ?? [])),
    [applyEdits, filterRemoved, data],
  );
  const addToPlaylist = useAddToPlaylistItems(tracks);
  const addToPack = useAddToPackItems(tracks);

  /**
   * Only a local album's track list is ours to change. A remote one is the
   * provider's, and an edit here would be discarded by its next fetch, so the
   * actions are not offered at all rather than offered and quietly lost.
   */
  const editable = uri !== '' && uriProvider(uri) === 'local';
  const [picking, setPicking] = useState(false);

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
        durationMs: 5000,
        progress: 1,
      });
      void refresh();
    })();
  }, [data, tracks, toast, t, registry, library, refresh]);

  /** Both album edits change what the page and the album lists should show. */
  const afterAlbumEdit = useCallback(() => {
    album.reload();
    void refresh();
  }, [album, refresh]);

  const removeFromAlbum = useCallback(
    (track: Track) => {
      void (async () => {
        try {
          await library.repo.setTrackAlbum(track.uri, undefined);
          toast.toast({ title: t('album.removedFromAlbum'), tone: 'success' });
          afterAlbumEdit();
        } catch (e: unknown) {
          toast.toast({
            title: t('album.removeFromAlbumFailed'),
            body: errorBody(e),
            tone: 'danger',
            durationMs: 6000,
          });
        }
      })();
    },
    [afterAlbumEdit, library, t, toast],
  );

  const onTracksAdded = useCallback(
    (count: number) => {
      setPicking(false);
      toast.toast({ title: t('album.addTracksDone', { count }), tone: 'success' });
      afterAlbumEdit();
    },
    [afterAlbumEdit, t, toast],
  );

  const rowMenuItems = useCallback(
    (track: Track): MenuItemSpec[] => {
      const items: MenuItemSpec[] = [
        { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue([track]) },
        { id: 'next', label: t('queue.playNext'), onSelect: () => queue.addNext([track]) },
        { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, separatorBefore: true },
        { id: 'add-pack', label: t('pack.addTo'), items: addToPack },
      ];
      if (editable) {
        items.push({
          id: 'remove-from-album',
          label: t('album.removeFromAlbum'),
          danger: true,
          separatorBefore: true,
          onSelect: () => removeFromAlbum(track),
        });
      }
      items.push(...editItems(track));
      // A remote album's rows come from the provider and may not be stored at
      // all, so forgetting one only makes sense on a local album.
      if (editable) items.push(...removeItems(track));
      return items;
    },
    [addToPack, addToPlaylist, editItems, editable, queue, removeFromAlbum, removeItems, t],
  );

  const copyLink = useCallback(() => {
    if (!data) return;
    void navigator.clipboard
      .writeText(data.uri)
      .then(() => toast.toast({ title: t('common.copied'), durationMs: 2000, tone: 'success' }))
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
    return items;
  }, [data, t, queue, tracks, addToPlaylist, host, download, navigate, copyLink, editable]);

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
        ) : null}

        {tracks.length === 0 ? (
          <EmptyState
            icon={Music}
            title={t('album.emptyTracks')}
            body={t('album.emptyTracksBody')}
            action={
              editable ? { label: t('album.addTracks'), onClick: () => setPicking(true) } : undefined
            }
          />
        ) : discs === undefined ? (
          <TrackTable
            tracks={tracks}
            columns={COLUMNS}
            hideAlbum
            currentUri={currentUri}
            playing={isPlaying}
            likedSet={likedUris}
            offlineSet={offlineUris}
            onPlay={play}
            onToggleLike={(track) => void useLibraryStore.getState().toggleLike(track)}
            menuItemsFor={rowMenuItems}
            {...(editable
              ? { onRemoveTrack: removeFromAlbum, removeLabel: t('album.removeFromAlbum') }
              : {})}
          />
        ) : (
          discs.map((group) => (
            <section key={`${group.disc}-${group.offset}`} className="flex flex-col gap-2">
              <h2 className="rule-label">{t('album.disc', { number: group.disc })}</h2>
              <TrackTable
                tracks={group.tracks}
                columns={COLUMNS}
                hideAlbum
                currentUri={currentUri}
                playing={isPlaying}
                likedSet={likedUris}
                offlineSet={offlineUris}
                onPlay={(index) => play(group.offset + index)}
                onToggleLike={(track) => void useLibraryStore.getState().toggleLike(track)}
                menuItemsFor={rowMenuItems}
                {...(editable
                  ? { onRemoveTrack: removeFromAlbum, removeLabel: t('album.removeFromAlbum') }
                  : {})}
              />
            </section>
          ))
        )}

        {editDialog}
        {removeDialog}
        {picking ? (
          <AddTracksDialog
            album={{ uri: data.uri, name: data.name }}
            onClose={() => setPicking(false)}
            onAdded={onTracksAdded}
          />
        ) : null}

        <p className="mono text-[11px] leading-relaxed text-text-faint">
          {t('album.providerLine', { provider: providerName })}
          {year !== '' ? ` · ${t('album.releasedIn', { year })}` : ''}
        </p>
      </div>
    </div>
  );
}

export default AlbumView;
