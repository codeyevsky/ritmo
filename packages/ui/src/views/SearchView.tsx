import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { makeUri, normalizeKey, parseUri, similarity, stationToTrack } from '@ritmo/core';
import type {
  Album,
  Artist,
  Artwork as ArtworkData,
  EntityKind,
  Library,
  Playlist,
  ProviderRegistry,
  SearchResults,
  Station,
  Track,
  Uri,
} from '@ritmo/core';

import {
  Artwork,
  Card,
  Chip,
  EmptyState,
  ErrorBanner,
  Input,
  PlayButton,
  SegmentedControl,
  Shelf,
  Skeleton,
  TrackRow,
  TrackTable,
} from '../components';
import type { TrackTableColumn } from '../components';
import { useSearch, useTranslation, SEARCH_INPUT_ATTR } from '../hooks';
import { useServices } from '../services';
import type { SearchFilter } from '../store';
import { usePlayerStore } from '../store';
import { entityPath, searchPath } from '../routes';
import { Search } from '../icons';

const TOP_TRACKS_IN_ALL = 4;
const SHELF_ITEMS = 10;

/** Search rows carry no position, so the index column is left out entirely. */
const SEARCH_COLUMNS: TrackTableColumn[] = [{ id: 'title' }, { id: 'album' }, { id: 'duration' }];

/** Nudges the hero towards the kind people usually mean by a bare name. */
const KIND_BONUS = {
  artist: 0.14,
  album: 0.08,
  track: 0.06,
  playlist: 0.03,
  station: 0,
} as const satisfies Record<EntityKind, number>;

const KIND_LABEL = {
  track: 'common.track',
  album: 'common.album',
  artist: 'common.artist',
  playlist: 'common.playlist',
  station: 'common.station',
} as const satisfies Record<EntityKind, string>;

const GRID_CLASS = 'flex flex-wrap gap-4';

interface TopResult {
  kind: EntityKind;
  uri: Uri;
  title: string;
  subtitle: string;
  artwork?: ArtworkData;
  /** Set when the entity is playable without an extra provider round-trip. */
  track?: Track;
}

export function SearchView(): ReactElement {
  const { controller, library, registry } = useServices();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams<{ query?: string }>();

  const {
    query,
    results,
    status,
    providerErrors,
    recent,
    filter,
    search,
    submit,
    retry,
    setFilter,
    clear,
    removeRecent,
    clearRecent,
  } = useSearch();

  const currentUri = usePlayerStore((s) => s.current?.uri);
  const isPlaying = usePlayerStore((s) => s.status === 'playing');

  const routeQuery = params.query ?? '';
  const trimmed = query.trim();
  const loading = status === 'loading';

  useEffect(() => {
    document.title = `${trimmed || t('nav.search')} • Ritmo`;
  }, [trimmed, t]);

  /**
   * URL ⇄ store, one effect so the two can never fight: whichever side moved
   * since the last commit is the one that wins. Typing replaces the entry so
   * Back leaves the search instead of unwinding every keystroke.
   */
  const prevRoute = useRef(routeQuery);
  const prevQuery = useRef(query);
  useEffect(() => {
    const routeChanged = prevRoute.current !== routeQuery;
    const queryChanged = prevQuery.current !== query;
    prevRoute.current = routeQuery;
    prevQuery.current = query;

    if (routeQuery === query) return;
    if (routeChanged) {
      void submit(routeQuery);
      return;
    }
    if (queryChanged || routeQuery === '') {
      navigate(searchPath(query), { replace: true });
      return;
    }
    void submit(routeQuery);
  }, [navigate, query, routeQuery, submit]);

  const stationTracks = useMemo(() => results.stations.map(stationToTrack), [results.stations]);

  /** Whatever is on screen in this tab is the context Next continues through. */
  const visibleTracks = useMemo(() => {
    if (filter === 'stations') return stationTracks;
    if (filter === 'tracks') return results.tracks;
    if (filter === 'all') return results.tracks.slice(0, TOP_TRACKS_IN_ALL);
    return [];
  }, [filter, results.tracks, stationTracks]);

  const playList = useCallback(
    (tracks: Track[], index: number, name: string) => {
      if (!tracks.length) return;
      void controller.playContext(tracks, index, { name }).catch(() => undefined);
    },
    [controller],
  );

  const playFrom = useCallback(
    (tracks: Track[], index: number) => playList(tracks, index, trimmed),
    [playList, trimmed],
  );

  const playEntity = useCallback(
    (uri: Uri, name: string) => {
      void (async () => {
        try {
          const tracks = await entityTracks(registry, library, uri);
          if (tracks.length) await controller.playContext(tracks, 0, { uri, name });
        } catch {
          // Results stay on screen; the failing provider is already named in
          // the chips under the header.
        }
      })();
    },
    [controller, library, registry],
  );

  const open = useCallback((uri: Uri) => navigate(entityPath(uri)), [navigate]);

  const playTop = useCallback(
    (result: TopResult) => {
      const seed = result.track;
      if (!seed) {
        playEntity(result.uri, result.title);
        return;
      }
      const index = results.tracks.findIndex((x) => x.uri === seed.uri);
      playFrom(index >= 0 ? results.tracks : [seed], index >= 0 ? index : 0);
    },
    [playEntity, playFrom, results.tracks],
  );

  const tabs = useMemo<Array<{ id: SearchFilter; label: string; count?: number }>>(
    () => [
      { id: 'all', label: t('search.all') },
      { id: 'tracks', label: t('search.tracks'), count: results.tracks.length },
      { id: 'albums', label: t('search.albums'), count: results.albums.length },
      { id: 'artists', label: t('search.artists'), count: results.artists.length },
      { id: 'playlists', label: t('search.playlists'), count: results.playlists.length },
      { id: 'stations', label: t('search.radio'), count: results.stations.length },
    ],
    [results, t],
  );

  const top = useMemo(() => topResult(results, trimmed), [results, trimmed]);
  const total =
    results.tracks.length +
    results.albums.length +
    results.artists.length +
    results.playlists.length +
    results.stations.length;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-6">
      <div className="flex flex-col gap-4">
        <Input
          value={query}
          onChange={(e) => search(e.target.value)}
          onClear={clear}
          leading={Search}
          size="lg"
          clearable
          autoFocus
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          {...{ [SEARCH_INPUT_ATTR]: '' }}
        />

        {trimmed.length > 0 && (
          <SegmentedControl items={tabs} value={filter} onChange={setFilter} />
        )}

        {trimmed.length > 0 && providerErrors.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {providerErrors.map((failure) => {
              const provider = registry.get(failure.provider)?.displayName ?? failure.provider;
              // A source that was never asked because it has no credentials is
              // a settings problem, not an outage — say so, and offer the fix.
              const needsSetup = failure.error.code === 'auth';
              return (
                <li key={failure.provider}>
                  <Chip onClick={needsSetup ? () => navigate('/settings/sources') : undefined}>
                    {needsSetup
                      ? t('errors.providerAuth', { provider })
                      : t('search.providerFailed', { provider })}
                  </Chip>
                </li>
              );
            })}
          </ul>
        )}

        {status === 'error' && (
          <ErrorBanner title={t('errors.network')} onRetry={retry} />
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {loading ? t('search.searching') : ''}
      </p>

      <div aria-busy={loading} className="flex flex-col gap-10">
        {trimmed.length === 0 ? (
          recent.length > 0 ? (
            <section aria-labelledby="search-recent" className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <h2 id="search-recent" className="rule-label min-w-0 flex-1">
                  {t('search.recent')}
                </h2>
                <button
                  type="button"
                  onClick={clearRecent}
                  className="mono shrink-0 rounded-xs text-[11px] uppercase tracking-[0.14em] text-text-faint outline-none transition-colors duration-150 ease-swift hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {t('search.clearRecent')}
                </button>
              </div>
              <ul className="flex flex-wrap gap-2">
                {recent.map((entry) => (
                  <li key={entry}>
                    <Chip onClick={() => void submit(entry)} onRemove={() => removeRecent(entry)}>
                      {entry}
                    </Chip>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            /* No history yet: a quiet line rather than a page of suggestions. */
            <EmptyState icon={Search} title={t('search.placeholder')} />
          )
        ) : loading && total === 0 ? (
          <ResultsSkeleton />
        ) : total === 0 ? (
          <EmptyState
            icon={Search}
            title={t('search.noResults')}
            body={t('search.noResultsBody')}
            action={{ label: t('nav.radio'), onClick: () => navigate('/radio') }}
            secondaryAction={{ label: t('nav.home'), onClick: () => navigate('/') }}
          />
        ) : filter === 'all' ? (
          <>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
              {top && (
                <section aria-labelledby="search-top-result" className="flex min-w-0 flex-col gap-3">
                  <h2 id="search-top-result" className="rule-label">
                    {t('search.topResult')}
                  </h2>
                  <TopResultCard
                    result={top}
                    playing={isPlaying && top.uri === currentUri}
                    kindLabel={t(KIND_LABEL[top.kind])}
                    onOpen={() => open(top.uri)}
                    onPlay={() => playTop(top)}
                  />
                </section>
              )}

              {results.tracks.length > 0 && (
                <section aria-labelledby="search-tracks" className="flex min-w-0 flex-col gap-3">
                  <h2 id="search-tracks" className="rule-label">
                    {t('search.tracks')}
                  </h2>
                  <ul className="flex min-w-0 flex-col">
                    {results.tracks.slice(0, TOP_TRACKS_IN_ALL).map((track, i) => (
                      <li key={track.uri} className="min-w-0">
                        <TrackRow
                          track={track}
                          variant="search"
                          active={track.uri === currentUri}
                          playing={isPlaying && track.uri === currentUri}
                          onPlay={() => playFrom(visibleTracks, i)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            {results.artists.length > 0 && (
              <Shelf title={t('search.artists')} onSeeAll={() => setFilter('artists')}>
                {results.artists.slice(0, SHELF_ITEMS).map((artist) => (
                  <ArtistCard key={artist.uri} artist={artist} onOpen={open} />
                ))}
              </Shelf>
            )}

            {results.albums.length > 0 && (
              <Shelf title={t('search.albums')} onSeeAll={() => setFilter('albums')}>
                {results.albums.slice(0, SHELF_ITEMS).map((album) => (
                  <AlbumCard
                    key={album.uri}
                    album={album}
                    onOpen={open}
                    onPlay={() => playEntity(album.uri, album.name)}
                  />
                ))}
              </Shelf>
            )}

            {results.playlists.length > 0 && (
              <Shelf title={t('search.playlists')} onSeeAll={() => setFilter('playlists')}>
                {results.playlists.slice(0, SHELF_ITEMS).map((playlist) => (
                  <PlaylistCard
                    key={playlist.uri}
                    playlist={playlist}
                    onOpen={open}
                    onPlay={() => playEntity(playlist.uri, playlist.name)}
                  />
                ))}
              </Shelf>
            )}

            {results.stations.length > 0 && (
              <Shelf title={t('search.radio')} onSeeAll={() => setFilter('stations')}>
                {results.stations.slice(0, SHELF_ITEMS).map((station, i) => (
                  <StationCard
                    key={station.uri}
                    station={station}
                    currentUri={currentUri}
                    playing={isPlaying}
                    onOpen={() => navigate('/radio')}
                    onPlay={() => playFrom(stationTracks, i)}
                  />
                ))}
              </Shelf>
            )}
          </>
        ) : filter === 'tracks' ? (
          <TrackTable
            tracks={results.tracks}
            columns={SEARCH_COLUMNS}
            currentUri={currentUri}
            playing={isPlaying}
            loading={loading}
            onPlay={(index) => playFrom(results.tracks, index)}
          />
        ) : filter === 'albums' ? (
          <div className={GRID_CLASS}>
            {results.albums.map((album) => (
              <AlbumCard
                key={album.uri}
                album={album}
                onOpen={open}
                onPlay={() => playEntity(album.uri, album.name)}
              />
            ))}
          </div>
        ) : filter === 'artists' ? (
          <div className={GRID_CLASS}>
            {results.artists.map((artist) => (
              <ArtistCard key={artist.uri} artist={artist} onOpen={open} />
            ))}
          </div>
        ) : filter === 'playlists' ? (
          <div className={GRID_CLASS}>
            {results.playlists.map((playlist) => (
              <PlaylistCard
                key={playlist.uri}
                playlist={playlist}
                onOpen={open}
                onPlay={() => playEntity(playlist.uri, playlist.name)}
              />
            ))}
          </div>
        ) : (
          <div className={GRID_CLASS}>
            {results.stations.map((station, i) => (
              <StationCard
                key={station.uri}
                station={station}
                currentUri={currentUri}
                playing={isPlaying}
                onOpen={() => navigate('/radio')}
                onPlay={() => playFrom(stationTracks, i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AlbumCard({
  album,
  onOpen,
  onPlay,
}: {
  album: Album;
  onOpen: (uri: Uri) => void;
  onPlay: () => void;
}): ReactElement {
  return (
    <Card
      kind="album"
      uri={album.uri}
      title={album.name}
      subtitle={album.artists.map((a) => a.name).join(', ')}
      artwork={album.artwork}
      onOpen={() => onOpen(album.uri)}
      onPlay={onPlay}
    />
  );
}

function ArtistCard({
  artist,
  onOpen,
}: {
  artist: Artist;
  onOpen: (uri: Uri) => void;
}): ReactElement {
  return (
    <Card
      kind="artist"
      uri={artist.uri}
      title={artist.name}
      subtitle={artist.genres?.[0]}
      artwork={artist.artwork}
      onOpen={() => onOpen(artist.uri)}
    />
  );
}

function PlaylistCard({
  playlist,
  onOpen,
  onPlay,
}: {
  playlist: Playlist;
  onOpen: (uri: Uri) => void;
  onPlay: () => void;
}): ReactElement {
  return (
    <Card
      kind="playlist"
      uri={playlist.uri}
      title={playlist.name}
      subtitle={playlist.owner ?? playlist.description}
      artwork={playlist.artwork}
      onOpen={() => onOpen(playlist.uri)}
      onPlay={onPlay}
    />
  );
}

function StationCard({
  station,
  currentUri,
  playing,
  onOpen,
  onPlay,
}: {
  station: Station;
  currentUri?: Uri;
  playing: boolean;
  onOpen: () => void;
  onPlay: () => void;
}): ReactElement {
  const liveUri = stationTrackUri(station.uri);
  return (
    <Card
      kind="station"
      uri={station.uri}
      title={station.name}
      subtitle={station.tags?.slice(0, 2).join(' · ')}
      artwork={station.artwork}
      playing={playing && currentUri === liveUri}
      onOpen={onOpen}
      onPlay={onPlay}
    />
  );
}

interface TopResultCardProps {
  result: TopResult;
  playing: boolean;
  kindLabel: string;
  onOpen: () => void;
  onPlay: () => void;
}

function TopResultCard({
  result,
  playing,
  kindLabel,
  onOpen,
  onPlay,
}: TopResultCardProps): ReactElement {
  return (
    <div className="tile group flex min-w-0 flex-col gap-4 overflow-hidden rounded-md p-5">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 flex-col items-start gap-4 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Artwork
          artwork={result.artwork}
          name={result.title}
          size={112}
          shape={result.kind === 'artist' ? 'circle' : 'square'}
          rounded="xs"
          eager
          className="shrink-0 border border-line"
        />
        {/* `items-start` sizes children to their content, so the text block has
            to claim the card's width itself or a long title escapes the card. */}
        <span className="flex w-full min-w-0 flex-col gap-1">
          <span className="line-clamp-2 break-words text-xl font-semibold tracking-tight text-text">
            {result.title}
          </span>
          <span className="mono truncate text-[11px] uppercase tracking-[0.12em] text-text-faint">
            {kindLabel}
            {result.subtitle ? ` · ${result.subtitle}` : ''}
          </span>
        </span>
      </button>
      {/* Its own row rather than a floating overlay: no title can run under it. */}
      <div className="mt-auto flex shrink-0 justify-end">
        <span className="opacity-0 transition-opacity duration-150 ease-swift group-hover:opacity-100 group-focus-within:opacity-100">
          <PlayButton playing={playing} size="md" onToggle={onPlay} />
        </span>
      </div>
    </div>
  );
}

function ResultsSkeleton(): ReactElement {
  return (
    <div className="flex flex-col gap-8" aria-hidden="true">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <Skeleton className="h-56 w-full" rounded="md" />
        <div className="flex flex-col gap-px">
          {Array.from({ length: TOP_TRACKS_IN_ALL }, (_, i) => (
            <Skeleton key={`row-skeleton-${i}`} className="h-14 w-full" rounded="sm" />
          ))}
        </div>
      </div>
      <div className={GRID_CLASS}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={`card-skeleton-${i}`} className="h-[250px] w-[204px]" rounded="md" />
        ))}
      </div>
    </div>
  );
}

/** Station and live-track Uris share the uuid; the queue only holds the track form. */
function stationTrackUri(stationUri: Uri): Uri {
  try {
    return makeUri('radio', 'track', parseUri(stationUri).id);
  } catch {
    return stationUri;
  }
}

function topResult(results: SearchResults, query: string): TopResult | undefined {
  const needle = normalizeKey(query);
  const candidates: TopResult[] = [];

  const artist = results.artists[0];
  if (artist) {
    candidates.push({
      kind: 'artist',
      uri: artist.uri,
      title: artist.name,
      subtitle: artist.genres?.[0] ?? '',
      artwork: artist.artwork,
    });
  }
  const album = results.albums[0];
  if (album) {
    candidates.push({
      kind: 'album',
      uri: album.uri,
      title: album.name,
      subtitle: album.artists.map((a) => a.name).join(', '),
      artwork: album.artwork,
    });
  }
  const track = results.tracks[0];
  if (track) {
    candidates.push({
      kind: 'track',
      uri: track.uri,
      title: track.title,
      subtitle: track.artists.map((a) => a.name).join(', '),
      artwork: track.artwork ?? track.album?.artwork,
      track,
    });
  }
  const playlist = results.playlists[0];
  if (playlist) {
    candidates.push({
      kind: 'playlist',
      uri: playlist.uri,
      title: playlist.name,
      subtitle: playlist.owner ?? '',
      artwork: playlist.artwork,
    });
  }
  const station = results.stations[0];
  if (station) {
    candidates.push({
      kind: 'station',
      uri: station.uri,
      title: station.name,
      subtitle: station.tags?.slice(0, 2).join(' · ') ?? '',
      artwork: station.artwork,
      track: stationToTrack(station),
    });
  }

  let best: TopResult | undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = similarity(normalizeKey(candidate.title), needle) + KIND_BONUS[candidate.kind];
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/**
 * Search results carry no track lists, so an album/playlist/artist has to be
 * expanded before it can play. The library answers first for anything already
 * known locally.
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
