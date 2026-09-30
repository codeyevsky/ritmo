import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { normalizeKey } from '@ritmo/core';
import type { Pack, Playlist } from '@ritmo/core';

import { Button, Card, EmptyState, Input, Modal } from '../components';
import { useLibrary, usePacks, useToast, useTranslation } from '../hooks';
import { Filter, Package, Plus } from '../icons';
import { entityPath, packPath } from '../routes';
import { useServices } from '../services';
import { useLibraryStore } from '../store';

/** The same synthetic context uri `LikedSongsView` plays its rows under. */
const LIKED_URI = 'ritmo:playlist:liked';
/** One page is enough to start playback from a card. */
const LIKED_LIMIT = 200;

/** Fixed-width cards wrap instead of sharing a grid cell, so nothing overflows. */
const GALLERY_CLASS = 'flex min-w-0 flex-wrap gap-4';

type CreateKind = 'playlist' | 'pack';

function errorBody(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export interface LibraryCollectionsProps {
  /** The library filter box, matched against collection names. */
  filter?: string;
}

/**
 * Everything the listener built themselves: liked songs first, then playlists,
 * then packs. The library's Playlists tab renders this, and `/library/playlists`
 * resolves to that tab, so the sidebar's "See all" and the tab are one page.
 */
export function LibraryCollections({ filter = '' }: LibraryCollectionsProps): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { library, controller } = useServices();
  const { toast } = useToast();
  const { refreshPlaylists } = useLibrary();
  const { packs, create: createPack } = usePacks();
  const playlists = useLibraryStore((s) => s.playlists);
  const likedCount = useLibraryStore((s) => s.stats?.liked ?? 0);

  const [creating, setCreating] = useState<CreateKind | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const needle = normalizeKey(filter);
  const likedName = t('library.likedSongs');
  const likedVisible = needle === '' || normalizeKey(likedName).includes(needle);

  const visiblePlaylists = useMemo(
    () =>
      needle === ''
        ? playlists
        : playlists.filter((playlist) => normalizeKey(playlist.name).includes(needle)),
    [playlists, needle],
  );

  const visiblePacks = useMemo(
    () => (needle === '' ? packs : packs.filter((pack) => normalizeKey(pack.name).includes(needle))),
    [packs, needle],
  );

  const openCreate = useCallback((kind: CreateKind) => {
    setName('');
    setCreating(kind);
  }, []);

  const submitCreate = useCallback(() => {
    const trimmed = name.trim();
    if (creating === null || trimmed === '') return;
    const kind = creating;
    setBusy(true);
    // Both kinds resolve to the path of the thing that was just made, so the
    // one dialog can open either of them.
    const created =
      kind === 'playlist'
        ? library.playlists.create(trimmed).then(async (playlist) => {
            await refreshPlaylists();
            return entityPath(playlist.uri);
          })
        : createPack(trimmed).then((pack) => packPath(pack.uri));

    void created
      .then((path) => {
        setCreating(null);
        setName('');
        navigate(path);
      })
      .catch((e: unknown) => {
        toast({
          title: kind === 'playlist' ? t('errors.playlistCreateFailed') : t('pack.createFailed'),
          body: errorBody(e),
          tone: 'danger',
        });
      })
      .finally(() => setBusy(false));
  }, [creating, name, library, refreshPlaylists, createPack, navigate, toast, t]);

  const playLiked = useCallback(() => {
    void (async () => {
      try {
        const page = await library.likes.listTracks({ limit: LIKED_LIMIT });
        if (page.items.length === 0) return;
        await controller.playContext(page.items, 0, { uri: LIKED_URI, name: likedName });
      } catch (e: unknown) {
        toast({ title: t('errors.generic'), body: errorBody(e), tone: 'danger' });
      }
    })();
  }, [library, controller, likedName, toast, t]);

  const playPlaylist = useCallback(
    (playlist: Playlist) => {
      void (async () => {
        try {
          const full = await library.playlists.get(playlist.uri, true);
          const tracks = full?.tracks ?? [];
          if (tracks.length === 0) return;
          await controller.playContext(tracks, 0, { uri: playlist.uri, name: playlist.name });
        } catch (e: unknown) {
          toast({ title: t('errors.generic'), body: errorBody(e), tone: 'danger' });
        }
      })();
    },
    [library, controller, toast, t],
  );

  const playlistSubtitle = (playlist: Playlist): string | undefined =>
    playlist.trackCount === undefined
      ? playlist.description
      : t('playlist.trackCount', { count: playlist.trackCount });

  const packSubtitle = (pack: Pack): string => t('pack.trackCount', { count: pack.trackCount });

  const nothingMatches =
    needle !== '' && !likedVisible && visiblePlaylists.length === 0 && visiblePacks.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      {nothingMatches ? (
        <EmptyState icon={Filter} title={t('nav.noMatch')} />
      ) : (
        <>
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="rule-label min-w-0 flex-1">{t('library.playlists')}</h2>
              <Button
                variant="outline"
                size="sm"
                leading={Plus}
                className="shrink-0"
                onClick={() => openCreate('playlist')}
              >
                {t('playlist.create')}
              </Button>
            </div>

            <div className={GALLERY_CLASS}>
              {/* Liked songs is pinned first here as it is in the sidebar. */}
              {likedVisible ? (
                <Card
                  kind="playlist"
                  uri={LIKED_URI}
                  title={likedName}
                  subtitle={t('library.songCount', { count: likedCount })}
                  onOpen={() => navigate('/liked')}
                  onPlay={playLiked}
                />
              ) : null}
              {visiblePlaylists.map((playlist) => (
                <Card
                  key={playlist.uri}
                  kind="playlist"
                  uri={playlist.uri}
                  title={playlist.name}
                  subtitle={playlistSubtitle(playlist)}
                  artwork={playlist.artwork}
                  onOpen={() => navigate(entityPath(playlist.uri))}
                  onPlay={() => playPlaylist(playlist)}
                />
              ))}
            </div>

            {playlists.length === 0 ? (
              <p className="text-sm text-text-dim">{t('playlist.noneYet')}</p>
            ) : null}
          </section>

          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="rule-label min-w-0 flex-1">{t('pack.packs')}</h2>
              <Button
                variant="outline"
                size="sm"
                leading={Package}
                className="shrink-0"
                onClick={() => openCreate('pack')}
              >
                {t('pack.create')}
              </Button>
            </div>

            <div className={GALLERY_CLASS}>
              {visiblePacks.map((pack) => (
                <Card
                  key={pack.uri}
                  kind="playlist"
                  uri={pack.uri}
                  title={pack.name}
                  subtitle={packSubtitle(pack)}
                  artwork={pack.artwork}
                  onOpen={() => navigate(packPath(pack.uri))}
                />
              ))}
            </div>

            {packs.length === 0 ? <p className="text-sm text-text-dim">{t('pack.noneYet')}</p> : null}
          </section>
        </>
      )}

      <Modal
        open={creating !== null}
        onClose={() => setCreating(null)}
        title={creating === 'pack' ? t('pack.create') : t('playlist.create')}
        size="sm"
        actions={
          <>
            <Button variant="ghost" onClick={() => setCreating(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={submitCreate}
              loading={busy}
              disabled={name.trim() === ''}
            >
              {t('common.create')}
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder={creating === 'pack' ? t('pack.name') : t('playlist.name')}
          aria-label={creating === 'pack' ? t('pack.name') : t('playlist.name')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitCreate();
          }}
        />
      </Modal>
    </div>
  );
}

export default LibraryCollections;
