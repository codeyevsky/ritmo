import { useEffect, useMemo, useState } from 'react';

import type { Track, Uri } from '@ritmo/core';

import type { MenuItemSpec } from '../components';
import { usePacks, useToast, useTranslation } from '../hooks';
import { IconPackage, IconPlus } from '../icons';
import { useServices } from '../services';

/**
 * The "Add to pack" branch of a context/dropdown menu, as data rather than JSX
 * so it can be spliced into any `MenuItemSpec[]` — the same shape
 * `useAddToPlaylistItems` has.
 */
export function useAddToPackItems(tracks: Track[]): MenuItemSpec[] {
  const { t } = useTranslation();
  const { packs: service } = useServices();
  const { packs, create, addTracks } = usePacks();
  const { show } = useToast();
  const [containing, setContaining] = useState<Set<Uri>>(() => new Set());

  // Keyed on the uri rather than on `tracks[0]`: the caller hands us a fresh
  // array every render, so the identity alone would refetch forever.
  const singleUri = tracks.length === 1 ? tracks[0]?.uri : undefined;

  useEffect(() => {
    if (singleUri === undefined) {
      setContaining(new Set());
      return;
    }
    let alive = true;
    // Check marks only make sense for a single track; for a selection they
    // would be ambiguous.
    void service
      .containing(singleUri)
      .then((list) => {
        if (alive) setContaining(new Set(list.map((pack) => pack.uri)));
      })
      .catch(() => {
        if (alive) setContaining(new Set());
      });
    return () => {
      alive = false;
    };
  }, [service, singleUri]);

  return useMemo(() => {
    if (tracks.length === 0) return [];

    const items: MenuItemSpec[] = [
      {
        id: 'new-pack',
        label: t('pack.newFromTracks'),
        icon: IconPlus,
        onSelect: () => {
          void create(t('pack.newName'), { tracks })
            .then((created) =>
              show({
                title: t('pack.addedToPack', { count: tracks.length, name: created.name }),
                tone: 'success',
              }),
            )
            .catch(() => show({ title: t('pack.createFailed'), tone: 'danger' }));
        },
      },
    ];

    packs.forEach((pack, index) => {
      items.push({
        id: `add-${pack.uri}`,
        label: pack.name,
        icon: IconPackage,
        checked: containing.has(pack.uri),
        separatorBefore: index === 0,
        onSelect: () => {
          void addTracks(pack.uri, tracks)
            .then(() =>
              show({
                title: t('pack.addedToPack', { count: tracks.length, name: pack.name }),
                tone: 'success',
              }),
            )
            .catch(() => show({ title: t('errors.generic'), tone: 'danger' }));
        },
      });
    });

    return items;
  }, [addTracks, containing, create, packs, show, t, tracks]);
}
