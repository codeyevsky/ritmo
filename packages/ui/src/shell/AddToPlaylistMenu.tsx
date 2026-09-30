import { useEffect, useMemo, useState } from 'react';

import type { Track, Uri } from '@ritmo/core';

import type { MenuItemSpec } from '../components';
import { useToast, useTranslation } from '../hooks';
import { IconMusic, IconPlus } from '../icons';
import { useServices } from '../services';
import { useLibraryStore } from '../store';

/**
 * The "Add to playlist" branch of a context/dropdown menu, as data rather than
 * JSX so it can be spliced into any `MenuItemSpec[]`.
 */
export function useAddToPlaylistItems(tracks: Track[]): MenuItemSpec[] {
  const { t } = useTranslation();
  const services = useServices();
  const { show } = useToast();
  const playlists = useLibraryStore((s) => s.playlists);
  const [containing, setContaining] = useState<Set<Uri>>(() => new Set());

  // Keyed on the uri, not on `tracks[0]`, because the caller hands us a fresh
  // array on every render and the identity alone would refetch forever.
  const singleUri = tracks.length === 1 ? tracks[0]?.uri : undefined;

  useEffect(() => {
    if (!singleUri) {
      setContaining(new Set());
      return;
    }
    let alive = true;
    // `containing` is per-track; for a multi-selection the check marks would be
    // ambiguous anyway, so they are only shown for a single track.
    void services.library.playlists
      .containing(singleUri)
      .then((list) => {
        if (alive) setContaining(new Set(list.map((playlist) => playlist.uri)));
      })
      .catch(() => {
        if (alive) setContaining(new Set());
      });
    return () => {
      alive = false;
    };
  }, [services, singleUri]);

  return useMemo(() => {
    if (tracks.length === 0) return [];

    const add = async (uri: Uri, name: string) => {
      try {
        await services.library.playlists.addTracks(uri, tracks);
        const list = await services.library.playlists.list();
        useLibraryStore.setState({ playlists: list });
        show({
          title: t('playlist.addedToPlaylist', { name, count: tracks.length }),
          tone: 'success',
        });
      } catch {
        show({ title: t('errors.generic'), tone: 'danger' });
      }
    };

    const items: MenuItemSpec[] = [
      {
        id: 'new-playlist',
        label: t('playlist.newFromTracks'),
        icon: IconPlus,
        onSelect: () => {
          void (async () => {
            try {
              const created = await services.library.playlists.create(t('playlist.newName'), {
                tracks,
              });
              const list = await services.library.playlists.list();
              useLibraryStore.setState({ playlists: list });
              show({
                title: t('playlist.addedToPlaylist', { name: created.name, count: tracks.length }),
                tone: 'success',
              });
            } catch {
              show({ title: t('errors.playlistCreateFailed'), tone: 'danger' });
            }
          })();
        },
      },
    ];

    playlists.forEach((playlist, index) => {
      if (playlist.editable === false) return;
      items.push({
        id: `add-${playlist.uri}`,
        label: playlist.name,
        icon: IconMusic,
        checked: containing.has(playlist.uri),
        separatorBefore: index === 0,
        onSelect: () => void add(playlist.uri, playlist.name),
      });
    });

    return items;
  }, [containing, playlists, services, show, t, tracks]);
}
