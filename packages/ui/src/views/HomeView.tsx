import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { parseUri, stationToTrack } from '@ritmo/core';
import type {
  Artwork as ArtworkData,
  Library,
  ProviderRegistry,
  ShelfItem,
  Track,
  Uri,
} from '@ritmo/core';

import { Artwork, EmptyState, ErrorBanner, PlayButton, ShelfRow, ShelfSkeleton, Skeleton } from '../components';
import { useAsync, useShelves, useTranslation } from '../hooks';
import { useServices } from '../services';
import { usePlayerStore, useSettingsStore } from '../store';
import { entityPath } from '../routes';
import { Music } from '../icons';

const MAX_TILES = 8;
const SKELETON_SHELVES = 3;

interface JumpTile {
  key: string;
  name: string;
  artwork?: ArtworkData;
  /** The album/artist page the tile opens; absent for a track with neither. */
  openUri?: Uri;
  track: Track;
}

export function HomeView(): ReactElement {
  const { host, library, registry, controller } = useServices();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const shelves = useShelves();
  const musicFolders = useSettingsStore((s) => s.settings.musicFolders);
  const patch = useSettingsStore((s) => s.patch);
  const currentUri = usePlayerStore((s) => s.current?.uri);
  const isPlaying = usePlayerStore((s) => s.status === 'playing');

  // Re-reading the history when the current track changes keeps the grid in
  // step with what was just played, without a manual refresh path.
  const recent = useAsync(
    () => library.history.recentlyPlayed(MAX_TILES),
    [library, currentUri],
    { keepPrevious: true },
  );

  const [dismissed, setDismissed] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);

  // Pinned at mount: re-deriving the hour every render would let the heading
  // change under the reader mid-session.
  const [greetingKey] = useState(() => greetingFor(new Date().getHours()));

  const rows = shelves.data;
  const reloadShelves = shelves.reload;
  const reloadRecent = recent.reload;
  const failures = shelves.providerErrors;
  const failureKey = failures.map((f) => `${f.provider}:${f.error.code}`).join('|');

  useEffect(() => {
    document.title = `${t('nav.home')} • Ritmo`;
  }, [t]);

  useEffect(() => {
    setDismissed(false);
  }, [failureKey]);

  const tiles = useMemo(() => buildTiles(recent.data ?? []), [recent.data]);

  const playTile = useCallback(
    (tile: JumpTile) => {
      if (tile.track.uri === currentUri) {
        void controller.toggle();
        return;
      }
      void controller.playTrack(tile.track, 'user').catch(() => setActionFailed(true));
    },
    [controller, currentUri],
  );

  const openItem = useCallback(
    (item: ShelfItem) => {
      // A track has no page of its own, so its album (then its artist) is the
      // context a click should land on.
      const target =
        item.type === 'track'
          ? item.track.album?.uri ?? item.track.artists[0]?.uri
          : shelfItemUri(item);
      if (target) navigate(entityPath(target));
    },
    [navigate],
  );

  const playItem = useCallback(
    (item: ShelfItem) => {
      void (async () => {
        try {
          if (item.type === 'track') {
            await controller.playTrack(item.track, 'user');
            return;
          }
          if (item.type === 'station') {
            await controller.playTrack(stationToTrack(item.station), 'user');
            return;
          }
          const uri = shelfItemUri(item);
          const tracks = await entityTracks(registry, library, uri);
          if (!tracks.length) {
            setActionFailed(true);
            return;
          }
          await controller.playContext(tracks, 0, { uri, name: shelfItemName(item) });
        } catch {
          setActionFailed(true);
        }
      })();
    },
    [controller, library, registry],
  );

  const addFolder = useCallback(() => {
    void (async () => {
      try {
        const folder = await host.files.pickFolder();
        if (!folder) return;
        const folders = musicFolders.includes(folder) ? musicFolders : [...musicFolders, folder];
        patch({ musicFolders: folders });
        await host.localLibrary?.scan(folders);
        reloadRecent();
        reloadShelves();
      } catch {
        setActionFailed(true);
      }
    })();
  }, [host, musicFolders, patch, reloadRecent, reloadShelves]);

  const failureBanner = useMemo(() => {
    // A source the user never configured is a choice, not a fault: nagging about
    // it on every launch is noise. Search still reports it, where the user is
    // actively looking for results and the chip links to Settings.
    const real = failures.filter((f) => f.error.code !== 'auth');
    if (!real.length) return undefined;
    return {
      title: t('errors.network'),
      body: real.map((f) => registry.get(f.provider)?.displayName ?? f.provider).join(' · '),
    };
  }, [failures, registry, t]);

  const tilesLoading = recent.loading && recent.data === undefined;
  const showEmpty =
    !shelves.loading && rows.length === 0 && !tilesLoading && tiles.length === 0;

  return (
    // No artwork-derived tint behind the header: the page ground stays flat.
    <div className="min-h-full bg-bg">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-10 px-4 pb-16 pt-6 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-text">{t(greetingKey)}</h1>

        {failureBanner && !dismissed && (
          <ErrorBanner
            tone="warn"
            title={failureBanner.title}
            body={failureBanner.body}
            onRetry={() => shelves.reload()}
            onDismiss={() => setDismissed(true)}
          />
        )}

        {shelves.error && rows.length === 0 && (
          <ErrorBanner
            title={t('errors.loadFailed')}
            onRetry={() => shelves.reload()}
          />
        )}

        {actionFailed && (
          <ErrorBanner
            tone="warn"
            title={t('errors.unknown')}
            onDismiss={() => setActionFailed(false)}
          />
        )}

        {(tilesLoading || tiles.length > 0) && (
          <section aria-labelledby="home-jump-back-in" className="flex flex-col gap-3">
            <h2 id="home-jump-back-in" className="rule-label">
              {t('home.jumpBackIn')}
            </h2>
            <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {tilesLoading
                ? Array.from({ length: 4 }, (_, i) => (
                    <li key={`tile-skeleton-${i}`} aria-hidden="true">
                      <Skeleton className="h-16 w-full" rounded="sm" />
                    </li>
                  ))
                : tiles.map((tile) => (
                    <JumpBackInTile
                      key={tile.key}
                      tile={tile}
                      playing={isPlaying && tile.track.uri === currentUri}
                      onOpen={() => tile.openUri && navigate(entityPath(tile.openUri))}
                      onPlay={() => playTile(tile)}
                    />
                  ))}
            </ul>
          </section>
        )}

        <p role="status" aria-live="polite" className="sr-only">
          {shelves.loading || shelves.refreshing ? t('common.loading') : ''}
        </p>

        <div aria-busy={shelves.loading || shelves.refreshing} className="flex flex-col gap-10">
          {rows.map((shelf) => (
            <ShelfRow
              key={shelf.id}
              shelf={shelf}
              onOpenItem={openItem}
              onPlayItem={playItem}
              currentUri={currentUri}
            />
          ))}
          {/* Skeletons are for a genuinely cold screen only. A cached or
              already-loaded list revalidates in place: rows appear as each
              provider lands, and a placeholder under them would flicker on
              every visit for no information. */}
          {shelves.loading &&
            Array.from({ length: SKELETON_SHELVES }, (_, i) => (
              <ShelfSkeleton key={`shelf-skeleton-${i}`} />
            ))}
        </div>

        {showEmpty && (
          <EmptyState
            icon={Music}
            title={t('home.emptyTitle')}
            body={t('home.emptyBody')}
            action={{ label: t('home.addFolderCta'), onClick: addFolder }}
            secondaryAction={{ label: t('nav.radio'), onClick: () => navigate('/radio') }}
          />
        )}
      </div>
    </div>
  );
}

interface JumpBackInTileProps {
  tile: JumpTile;
  playing: boolean;
  onOpen: () => void;
  onPlay: () => void;
}

/**
 * Two sibling buttons rather than a card with a nested one: the tile has two
 * distinct actions and a button inside a button is not valid markup.
 */
function JumpBackInTile({ tile, playing, onOpen, onPlay }: JumpBackInTileProps): ReactElement {
  return (
    <li className="tile group relative flex items-center overflow-hidden rounded-md">
      <button
        type="button"
        onClick={onOpen}
        disabled={!tile.openUri}
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-default"
      >
        <Artwork artwork={tile.artwork} name={tile.name} size={62} rounded="none" className="shrink-0" />
        <span className={clsx('truncate pr-2 text-sm', playing ? 'text-accent' : 'text-text')}>
          {tile.name}
        </span>
      </button>
      <span className="mr-3 shrink-0 opacity-0 transition-opacity duration-150 ease-swift group-hover:opacity-100 group-focus-within:opacity-100">
        <PlayButton playing={playing} size="sm" onToggle={onPlay} />
      </span>
    </li>
  );
}

function greetingFor(hour: number): 'home.goodMorning' | 'home.goodAfternoon' | 'home.goodEvening' {
  if (hour < 12) return 'home.goodMorning';
  if (hour < 18) return 'home.goodAfternoon';
  return 'home.goodEvening';
}

function buildTiles(tracks: Track[]): JumpTile[] {
  const tiles: JumpTile[] = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    const album = track.album;
    const artist = track.artists[0];
    const openUri = album?.uri ?? artist?.uri;
    const key = openUri ?? track.uri;
    if (seen.has(key)) continue;
    seen.add(key);
    tiles.push({
      key,
      name: album?.name ?? track.title,
      artwork: album?.artwork ?? track.artwork,
      openUri,
      track,
    });
    if (tiles.length >= MAX_TILES) break;
  }
  return tiles;
}

function shelfItemUri(item: ShelfItem): Uri {
  switch (item.type) {
    case 'track':
      return item.track.uri;
    case 'album':
      return item.album.uri;
    case 'artist':
      return item.artist.uri;
    case 'playlist':
      return item.playlist.uri;
    case 'station':
      return item.station.uri;
  }
}

function shelfItemName(item: ShelfItem): string {
  switch (item.type) {
    case 'track':
      return item.track.title;
    case 'album':
      return item.album.name;
    case 'artist':
      return item.artist.name;
    case 'playlist':
      return item.playlist.name;
    case 'station':
      return item.station.name;
  }
}

/**
 * `controller.playUri` resolves single tracks only, so a shelf card for an
 * album/playlist/artist has to be expanded first. The library answers before
 * the provider so an owned playlist or a cached album needs no network.
 */
async function entityTracks(
  registry: ProviderRegistry,
  library: Library,
  uri: Uri,
): Promise<Track[]> {
  const parsed = parseUri(uri);

  if (parsed.kind === 'playlist') {
    const owned = await library.playlists.get(uri, true);
    if (owned?.tracks?.length) return owned.tracks;
  }
  if (parsed.kind === 'album') {
    const cached = await library.repo.getAlbum(uri, true);
    if (cached?.tracks?.length) return cached.tracks;
  }

  const provider = registry.get(parsed.provider);
  if (!provider) return [];

  switch (parsed.kind) {
    case 'track':
      return [await provider.getTrack(uri)];
    case 'album':
      return (await provider.getAlbum(uri)).tracks ?? [];
    case 'playlist':
      return (await provider.getPlaylist(uri)).tracks ?? [];
    case 'artist':
      return provider.getArtistTopTracks(uri);
    case 'station':
      return provider.getStation ? [stationToTrack(await provider.getStation(uri))] : [];
  }
}
