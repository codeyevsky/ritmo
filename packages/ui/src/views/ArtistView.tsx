import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ProviderError, dedupeTracks, formatCount, uriProvider } from '@ritmo/core';
import type { Album, Artist, Track } from '@ritmo/core';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  EntityHero,
  ErrorBanner,
  Skeleton,
  SegmentedControl,
  TrackTable,
} from '../components';
import type { MenuItemSpec, TrackTableColumn } from '../components';
import { useAsync, useIsLiked, useQueue, useToast, useTranslation } from '../hooks';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';
import { Disc, Info, Music } from '../icons';
import { entityPath } from '../routes';
import { useAddToPackItems } from '../shell/AddToPackMenu';
import { useAddToPlaylistItems } from '../shell/AddToPlaylistMenu';
import { useRemoveFromLibrary } from '../shell/RemoveFromLibrary';
import { useTrackDetails } from '../shell/TrackDetails';
import { useTrackDetailsEditor } from '../shell/TrackDetailsDialog';
import { EntityHeroSkeleton } from './AlbumView';

type DiscographyTab = 'albums' | 'singles' | 'compilations';

const COLUMNS: TrackTableColumn[] = [
  { id: 'index', width: '3rem' },
  { id: 'title' },
  { id: 'album' },
  { id: 'duration', width: '5rem' },
];

const GRID_CLASS =
  'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6';

function errorBody(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ProviderError && error.code === 'not_found';
}

function albumBucket(album: Album): DiscographyTab {
  switch ((album.albumType ?? 'album').toLowerCase()) {
    case 'single':
    case 'ep':
      return 'singles';
    case 'compilation':
      return 'compilations';
    default:
      return 'albums';
  }
}

export function ArtistView(): ReactElement {
  const params = useParams<{ uri: string }>();
  const uri = params.uri === undefined ? '' : decodeURIComponent(params.uri);
  const { registry, library, controller, metadata, host } = useServices();
  const { t, lang } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queue = useQueue();

  const likedUris = useLibraryStore((s) => s.likedUris);
  const offlineUris = useLibraryStore((s) => s.offlineUris);
  const currentUri = usePlayerStore((s) => s.current?.uri);
  const isPlaying = usePlayerStore((s) => s.status === 'playing');
  const contextUri = usePlayerStore((s) => s.queue.contextUri);
  const liked = useIsLiked(uri);

  const [expandedTop, setExpandedTop] = useState(false);
  const [discTab, setDiscTab] = useState<DiscographyTab>('albums');
  const [bioExpanded, setBioExpanded] = useState(false);

  const fetchArtist = useCallback(async (): Promise<Artist> => {
    if (uri === '') throw new ProviderError('not_found', 'empty uri');
    if (uriProvider(uri) === 'local') {
      const local = await library.repo.getArtist(uri);
      if (local) return local;
    }
    const provider = registry.forUri(uri);
    if (!provider) throw new ProviderError('not_found', uri);
    return provider.getArtist(uri);
  }, [uri, library, registry]);

  const artist = useAsync(fetchArtist, [fetchArtist], { keepPrevious: true });
  const data = artist.data;

  const fetchTop = useCallback(async (): Promise<Track[]> => {
    if (uri === '') return [];
    if (uriProvider(uri) === 'local') return library.repo.getArtistTracks(uri, 10);
    const provider = registry.forUri(uri);
    if (!provider) return [];
    try {
      return await provider.getArtistTopTracks(uri);
    } catch (e: unknown) {
      if (e instanceof ProviderError && e.code === 'unsupported') return library.repo.getArtistTracks(uri, 10);
      throw e;
    }
  }, [uri, library, registry]);

  const top = useAsync(fetchTop, [fetchTop], { keepPrevious: true });
  const { itemsFor: editItems, applyEdits, dialog: editDialog } = useTrackDetailsEditor();
  const { itemsFor: detailsItems, dialog: detailsDialog } = useTrackDetails();
  const {
    itemsFor: removeItems,
    filterRemoved,
    dialog: removeDialog,
  } = useRemoveFromLibrary();
  /**
   * A top-tracks list can hold the same recording twice: Audius serves a
   * re-upload as a second track id with the same title and duration, and
   * `/users/{id}/tracks` returns both. The queue makes one entry per position,
   * so an un-deduplicated list showed the same track twice in the panel.
   */
  const topTracks = useMemo(
    () => filterRemoved(dedupeTracks(applyEdits(top.data ?? []))),
    [applyEdits, filterRemoved, top.data],
  );
  /**
   * A remote artist's top tracks come from the provider and may not be stored
   * at all, so forgetting one only makes sense for a local artist.
   */
  const stored = uri !== '' && uriProvider(uri) === 'local';

  const fetchAlbums = useCallback(async (): Promise<Album[]> => {
    if (uri === '') return [];
    if (uriProvider(uri) === 'local') return library.repo.getArtistAlbums(uri);
    const provider = registry.forUri(uri);
    if (!provider || !provider.capabilities.albums) return [];
    const page = await provider.getArtistAlbums(uri);
    return page.items;
  }, [uri, library, registry]);

  const albums = useAsync(fetchAlbums, [fetchAlbums], { keepPrevious: true });

  /** Audius, Radio Browser and friends simply have no album concept. */
  const hasDiscography =
    uri !== '' &&
    (uriProvider(uri) === 'local' || (registry.forUri(uri)?.capabilities.albums ?? false));

  const fetchBio = useCallback(async (): Promise<Artist | undefined> => {
    if (!data) return undefined;
    return metadata.enrichArtist(data, lang);
  }, [data, metadata, lang]);

  const enriched = useAsync(fetchBio, [fetchBio], { keepPrevious: true });

  const addToPlaylist = useAddToPlaylistItems(topTracks);
  const addToPack = useAddToPackItems(topTracks);

  useEffect(() => {
    if (data) document.title = `${data.name} · Ritmo`;
  }, [data]);

  const visibleTop = useMemo(
    () => topTracks.slice(0, expandedTop ? 10 : 5),
    [topTracks, expandedTop],
  );

  const buckets = useMemo(() => {
    const all = albums.data ?? [];
    return {
      albums: all.filter((album) => albumBucket(album) === 'albums'),
      singles: all.filter((album) => albumBucket(album) === 'singles'),
      compilations: all.filter((album) => albumBucket(album) === 'compilations'),
    };
  }, [albums.data]);

  const play = useCallback(
    (index: number) => {
      if (!data || topTracks.length === 0) return;
      void controller.playContext(topTracks, index, { uri: data.uri, name: data.name });
    },
    [controller, data, topTracks],
  );

  const shuffle = useCallback(() => {
    if (!data || topTracks.length === 0) return;
    void (async () => {
      await controller.setShuffle(true);
      await controller.playContext(topTracks, Math.floor(Math.random() * topTracks.length), {
        uri: data.uri,
        name: data.name,
      });
    })();
  }, [controller, data, topTracks]);

  const toggleLike = useCallback(() => {
    if (!data) return;
    void useLibraryStore.getState().toggleEntityLike(data.uri, 'artist', data);
  }, [liked, library, data]);

  const copyLink = useCallback(() => {
    if (!data) return;
    void navigator.clipboard
      .writeText(data.uri)
      .then(() => toast.toast({ title: t('common.copied'), tone: 'success' }))
      .catch(() => toast.toast({ title: t('errors.copyFailed'), tone: 'danger' }));
  }, [data, toast, t]);

  const menuItems = useMemo<MenuItemSpec[]>(() => {
    const seed = topTracks[0];
    return [
      {
        id: 'radio',
        label: t('artist.startRadio'),
        disabled: seed === undefined,
        onSelect: () => {
          if (seed) void controller.startRadio(seed);
        },
      },
      {
        id: 'queue',
        label: t('queue.addToQueue'),
        disabled: topTracks.length === 0,
        onSelect: () => queue.addToQueue(topTracks),
      },
      { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, disabled: topTracks.length === 0 },
      { id: 'copy', label: t('common.copyLink'), onSelect: copyLink, separatorBefore: true },
    ];
  }, [topTracks, t, controller, queue, addToPlaylist, copyLink]);

  if (artist.loading && data === undefined) {
    return (
      <div className="flex flex-col gap-6 pb-12">
        <EntityHeroSkeleton round />
        <div className="flex flex-col gap-2 px-6" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" rounded="sm" />
          ))}
        </div>
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="p-6">
        <ErrorBanner
          title={isNotFound(artist.error) ? t('errors.notFound') : t('errors.loadFailed')}
          body={errorBody(artist.error)}
          onRetry={artist.reload}
        />
      </div>
    );
  }

  const bio = enriched.data?.bio ?? data.bio;
  const genres = enriched.data?.genres ?? data.genres ?? [];
  const playingThis = isPlaying && contextUri === data.uri;
  const discItems = [
    { id: 'albums' as const, label: t('artist.albums'), count: buckets.albums.length },
    { id: 'singles' as const, label: t('artist.singles'), count: buckets.singles.length },
    { id: 'compilations' as const, label: t('artist.compilations'), count: buckets.compilations.length },
  ];
  const shown = buckets[discTab];

  return (
    // Flat ground: the blown-up cover behind the header was the other half of
    // the streaming-app signature.
    <div className="flex flex-col gap-10 bg-bg pb-12">
      <EntityHero
        round
        kind="artist"
        title={data.name}
        subtitle={
          data.followers === undefined
            ? undefined
            : t('artist.followers', { count: formatCount(data.followers, lang) })
        }
        artwork={data.artwork}
        playing={playingThis}
        onPlay={() => (playingThis ? void controller.toggle() : play(0))}
        onShuffle={shuffle}
        liked={liked}
        onToggleLike={toggleLike}
        menuItems={menuItems}
      />

      <section className="flex flex-col gap-3 px-6">
        <h2 className="rule-label">{t('artist.popular')}</h2>
        {top.error !== undefined && topTracks.length === 0 ? (
          <ErrorBanner
            tone="warn"
            title={t('errors.loadFailed')}
            body={errorBody(top.error)}
            onRetry={top.reload}
          />
        ) : topTracks.length === 0 && !top.loading ? (
          <EmptyState icon={Music} title={t('artist.noTracks')} body={t('artist.noTracksBody')} />
        ) : (
          <>
            <TrackTable
              tracks={visibleTop}
              columns={COLUMNS}
              loading={top.loading && topTracks.length === 0}
              currentUri={currentUri}
              playing={isPlaying}
              likedSet={likedUris}
              offlineSet={offlineUris}
              onPlay={play}
              onToggleLike={(track) => void useLibraryStore.getState().toggleLike(track)}
              menuItemsFor={(track) => [
                { id: 'queue', label: t('queue.addToQueue'), onSelect: () => queue.addToQueue([track]) },
                { id: 'next', label: t('queue.playNext'), onSelect: () => queue.addNext([track]) },
                { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, separatorBefore: true },
                { id: 'add-pack', label: t('pack.addTo'), items: addToPack },
                ...detailsItems(track),
                ...editItems(track),
                ...(stored ? removeItems(track) : []),
              ]}
            />
            {topTracks.length > 5 ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setExpandedTop((v) => !v)}
                aria-expanded={expandedTop}
              >
                {expandedTop ? t('common.showLess') : t('common.showMore')}
              </Button>
            ) : null}
          </>
        )}
        {detailsDialog}
        {editDialog}
        {removeDialog}
      </section>

      <section className={clsx('flex-col gap-4 px-6', hasDiscography ? 'flex' : 'hidden')}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="rule-label min-w-0 flex-1">{t('artist.discography')}</h2>
          <SegmentedControl
            items={discItems}
            value={discTab}
            onChange={(id) => setDiscTab(id)}
            className="shrink-0"
          />
        </div>
        {albums.error !== undefined && (albums.data ?? []).length === 0 ? (
          <ErrorBanner
            tone="warn"
            title={t('errors.loadFailed')}
            body={errorBody(albums.error)}
            onRetry={albums.reload}
          />
        ) : albums.loading && albums.data === undefined ? (
          <div className={GRID_CLASS} aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-3">
                <Skeleton className="aspect-square w-full" rounded="sm" />
                <Skeleton className="h-3 w-3/4" rounded="sm" />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState icon={Disc} title={t('artist.noAlbums')} body={t('artist.noAlbumsBody')} />
        ) : (
          <div className={GRID_CLASS}>
            {shown.map((album) => (
              <Card
                key={album.uri}
                kind="album"
                uri={album.uri}
                title={album.name}
                subtitle={album.releaseDate ?? album.artists.map((a) => a.name).join(', ')}
                artwork={album.artwork}
                onOpen={() => navigate(entityPath(album.uri))}
              />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 px-6">
        <h2 className="rule-label">{t('artist.about')}</h2>
        {enriched.loading && bio === undefined ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-3 w-full" rounded="sm" />
            <Skeleton className="h-3 w-5/6" rounded="sm" />
            <Skeleton className="h-3 w-2/3" rounded="sm" />
          </div>
        ) : bio === undefined || bio.trim() === '' ? (
          <EmptyState icon={Info} title={t('artist.noBio')} body={t('artist.noBioBody')} />
        ) : (
          <>
            <div
              className={
                bioExpanded
                  ? 'flex max-w-3xl flex-col gap-3'
                  : 'flex max-w-3xl flex-col gap-3 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)] max-h-32'
              }
            >
              {bio
                .split(/\n{2,}/)
                .map((paragraph) => paragraph.trim())
                .filter((paragraph) => paragraph !== '')
                .map((paragraph, i) => (
                  <p key={i} className="selectable text-sm leading-relaxed text-text-dim">
                    {paragraph}
                  </p>
                ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setBioExpanded((v) => !v)}
              aria-expanded={bioExpanded}
            >
              {bioExpanded ? t('common.showLess') : t('common.showMore')}
            </Button>
          </>
        )}

        {genres.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {genres.slice(0, 8).map((genre) => (
              <Chip key={genre}>{genre}</Chip>
            ))}
          </div>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            void host.openExternal(
              `https://musicbrainz.org/search?type=artist&query=${encodeURIComponent(data.name)}`,
            );
          }}
        >
          {t('artist.openMusicbrainz')}
        </Button>
      </section>
    </div>
  );
}

export default ArtistView;
