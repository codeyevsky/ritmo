import { useCallback, useEffect, useMemo } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { QueueItem } from '@ritmo/core';

import {
  Button,
  DropdownMenu,
  EmptyState,
  LikeButton,
  NowPlayingArt,
  PlayButton,
  TrackRow,
} from '../components';
import type { MenuItemSpec } from '../components';
import { useIsLiked, useQueue, useTranslation } from '../hooks';
import { useServices } from '../services';
import { useLibraryStore, usePlayerStore } from '../store';
import { Queue as QueueIcon, Search as SearchIcon } from '../icons';
import { entityPath } from '../routes';
import { useAddToPlaylistItems } from '../shell/AddToPlaylistMenu';

export function QueueView(): ReactElement {
  const { controller, library } = useServices();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queue = useQueue();

  const status = usePlayerStore((s) => s.status);
  const currentTrack = usePlayerStore((s) => s.current);
  const isPlaying = status === 'playing';
  const currentUri = currentTrack?.uri ?? '';
  const liked = useIsLiked(currentUri);

  const { upcoming, userQueued, fromContext } = queue;
  const upcomingTracks = useMemo(() => upcoming.map((item) => item.track), [upcoming]);
  const addToPlaylist = useAddToPlaylistItems(upcomingTracks);

  useEffect(() => {
    document.title = `${t('queue.title')} · Ritmo`;
  }, [t]);

  const rowMenuItems = useCallback(
    (item: QueueItem, removable: boolean): MenuItemSpec[] => {
      const items: MenuItemSpec[] = [
        {
          id: 'radio',
          label: t('artist.startRadio'),
          onSelect: () => {
            void controller.startRadio(item.track);
          },
        },
      ];
      if (removable && queue.editable) {
        items.unshift({
          id: 'remove',
          label: t('queue.remove'),
          danger: true,
          separatorBefore: false,
          onSelect: () => queue.remove(item.id),
        });
      }
      return items;
    },
    [t, queue, controller],
  );

  const headerMenu = useMemo<MenuItemSpec[]>(
    () => [
      { id: 'add', label: t('playlist.addTo'), items: addToPlaylist, disabled: upcomingTracks.length === 0 },
      {
        id: 'clear',
        label: t('queue.clear'),
        danger: true,
        separatorBefore: true,
        disabled: upcoming.length === 0 || !queue.editable,
        onSelect: () => queue.clearUpcoming(),
      },
    ],
    [t, addToPlaylist, upcomingTracks.length, upcoming.length, queue],
  );

  const section = (title: string, items: QueueItem[], removable: boolean, extra?: ReactElement) => (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-text-faint">{title}</h2>
        {extra}
      </div>
      <div className="flex flex-col">
        {items.map((item) => (
          <div key={item.id} className="h-11">
            <TrackRow
              track={item.track}
              variant="queue"
              active={currentUri === item.track.uri}
              playing={isPlaying && currentUri === item.track.uri}
              onPlay={() => queue.playItem(item)}
              menuItems={rowMenuItems(item, removable)}
            />
          </div>
        ))}
      </div>
    </section>
  );

  if (currentTrack === undefined && upcoming.length === 0) {
    return (
      <div className="p-6">
        <h1 className="mb-6 text-3xl font-bold tracking-tight text-text">{t('queue.title')}</h1>
        <EmptyState
          icon={QueueIcon}
          title={t('queue.empty')}
          body={t('queue.emptyBody')}
          action={{ label: t('nav.home'), onClick: () => navigate('/') }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 px-6 pb-12 pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-text">{t('queue.title')}</h1>
        <DropdownMenu items={headerMenu} align="start">
          <Button variant="outline" size="sm" disabled={upcoming.length === 0}>
            {t('common.more')}
          </Button>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-10 lg:flex-row lg:items-start">
        <div className="flex shrink-0 flex-col gap-4 lg:sticky lg:top-6 lg:w-[22rem]">
          <NowPlayingArt track={currentTrack} size={352} glow className="max-w-full" />
          {currentTrack ? (
            <div className="flex flex-col gap-2">
              <h2 className="truncate text-xl font-bold tracking-tight text-text">{currentTrack.title}</h2>
              <p className="flex flex-wrap items-center gap-1 text-sm text-text-dim">
                {currentTrack.artists.map((artist, i) => (
                  <span key={artist.uri} className="flex items-center gap-1">
                    {i > 0 ? <span aria-hidden>·</span> : null}
                    <Link
                      to={entityPath(artist.uri)}
                      className="hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {artist.name}
                    </Link>
                  </span>
                ))}
              </p>
              {currentTrack.album ? (
                <Link
                  to={entityPath(currentTrack.album.uri)}
                  className="truncate text-xs text-text-faint hover:text-text-dim hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {currentTrack.album.name}
                </Link>
              ) : null}
              <div className="mt-2 flex items-center gap-3">
                <PlayButton
                  size="lg"
                  playing={isPlaying}
                  loading={status === 'loading'}
                  label={isPlaying ? t('player.pause') : t('player.play')}
                  onToggle={() => void controller.toggle()}
                />
                <LikeButton
                  liked={liked}
                  onToggle={() => {
                    void useLibraryStore.getState().toggleLike(currentTrack);
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-8">
          {queue.current ? section(t('queue.nowPlaying'), [queue.current], false) : null}

          {userQueued.length > 0
            ? section(
                t('queue.nextUp'),
                userQueued,
                true,
                queue.editable ? (
                  <Button variant="ghost" size="sm" onClick={() => queue.clearUpcoming()} className="ml-auto">
                    {t('queue.clear')}
                  </Button>
                ) : undefined,
              )
            : null}

          {fromContext.length > 0
            ? section(
                queue.contextName === undefined
                  ? t('queue.nextUp')
                  : t('queue.nextFrom', { context: queue.contextName }),
                fromContext,
                false,
              )
            : null}

          {upcoming.length === 0 ? (
            <EmptyState
              icon={SearchIcon}
              title={t('queue.empty')}
              body={t('queue.emptyBody')}
              action={{ label: t('nav.search'), onClick: () => navigate('/search') }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default QueueView;
