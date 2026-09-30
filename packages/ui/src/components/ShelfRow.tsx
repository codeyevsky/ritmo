import clsx from 'clsx';
import type { Artwork as ArtworkData, Shelf as ShelfData, ShelfItem, TKey, Uri } from '@ritmo/core';
import { useTranslation } from '../hooks/useTranslation';
import type { TFunction } from '../hooks/useTranslation';
import { Card } from './Card';
import type { CardProps } from './Card';
import { Shelf } from './Shelf';

/**
 * Providers are locale-agnostic, so a shelf ships a `titleKey` plus an English
 * literal. Resolve the key when there is one; a key the dictionary has lost
 * falls back to the literal rather than showing `shelf.somethingTitle`.
 */
export function shelfTitle(shelf: ShelfData, t: TFunction): string {
  return resolve(shelf.titleKey, shelf.title, t);
}

export function shelfSubtitle(shelf: ShelfData, t: TFunction): string | undefined {
  if (shelf.subtitleKey === undefined) return shelf.subtitle;
  return resolve(shelf.subtitleKey, shelf.subtitle, t);
}

function resolve(key: string | undefined, fallback: string | undefined, t: TFunction): string {
  if (key === undefined) return fallback ?? '';
  // `t()` returns the key itself when it is missing from every dictionary.
  const translated = t(key as TKey);
  return translated === key ? (fallback ?? key) : translated;
}

export interface ShelfRowProps {
  shelf: ShelfData;
  onOpenItem: (item: ShelfItem) => void;
  onPlayItem: (item: ShelfItem) => void;
  currentUri?: Uri;
  onSeeAll?: () => void;
  className?: string;
}

interface Derived {
  kind: CardProps['kind'];
  uri: Uri;
  title: string;
  subtitle: string;
  artwork?: ArtworkData;
}

function joinArtists(artists: Array<{ name: string }>): string {
  return artists.map((a) => a.name).join(', ');
}

function derive(item: ShelfItem, artistsLabel: string): Derived {
  switch (item.type) {
    case 'track':
      return {
        kind: 'album',
        uri: item.track.uri,
        title: item.track.title,
        subtitle: joinArtists(item.track.artists),
        artwork: item.track.artwork ?? item.track.album?.artwork,
      };
    case 'album':
      return {
        kind: 'album',
        uri: item.album.uri,
        title: item.album.name,
        subtitle: joinArtists(item.album.artists),
        artwork: item.album.artwork,
      };
    case 'artist':
      return {
        kind: 'artist',
        uri: item.artist.uri,
        title: item.artist.name,
        subtitle: artistsLabel,
        artwork: item.artist.artwork,
      };
    case 'playlist':
      return {
        kind: 'playlist',
        uri: item.playlist.uri,
        title: item.playlist.name,
        subtitle: item.playlist.owner ?? '',
        artwork: item.playlist.artwork,
      };
    case 'station':
      return {
        kind: 'station',
        uri: item.station.uri,
        title: item.station.name,
        subtitle: item.station.country ?? '',
        artwork: item.station.artwork,
      };
  }
}

export function ShelfRow({ shelf, onOpenItem, onPlayItem, currentUri, onSeeAll, className }: ShelfRowProps) {
  const { t } = useTranslation();
  const artistsLabel = t('library.artists');
  const subtitle = shelfSubtitle(shelf, t);

  return (
    <Shelf
      title={shelfTitle(shelf, t)}
      {...(subtitle !== undefined ? { subtitle } : {})}
      {...(onSeeAll ? { onSeeAll } : {})}
      className={clsx(className)}
    >
      {shelf.items.map((item) => {
        const d = derive(item, artistsLabel);
        return (
          <Card
            key={d.uri}
            kind={d.kind}
            uri={d.uri}
            title={d.title}
            subtitle={d.subtitle}
            {...(d.artwork ? { artwork: d.artwork } : {})}
            playing={currentUri !== undefined && d.uri === currentUri}
            onOpen={() => onOpenItem(item)}
            onPlay={() => onPlayItem(item)}
          />
        );
      })}
    </Shelf>
  );
}
