import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';

import type { Uri } from '@ritmo/core';
import { parseUri } from '@ritmo/core';

import { HomeView } from './views/HomeView';

/**
 * Only Home is in the entry chunk. Everything else is a separate chunk fetched
 * on first navigation: the whole view layer was being parsed before the first
 * frame even though a launch only ever lands on Home, and the bundle was the
 * largest single cost in startup.
 */
const AlbumView = lazy(async () => ({ default: (await import('./views/AlbumView')).AlbumView }));
const ArtistView = lazy(async () => ({ default: (await import('./views/ArtistView')).ArtistView }));
const BazaarView = lazy(async () => ({ default: (await import('./views/BazaarView')).BazaarView }));
const LibraryView = lazy(async () => ({ default: (await import('./views/LibraryView')).LibraryView }));
const LikedSongsView = lazy(async () => ({ default: (await import('./views/LikedSongsView')).LikedSongsView }));
const NotFoundView = lazy(async () => ({ default: (await import('./views/NotFoundView')).NotFoundView }));
const PackView = lazy(async () => ({ default: (await import('./views/PackView')).PackView }));
const PlaylistView = lazy(async () => ({ default: (await import('./views/PlaylistView')).PlaylistView }));
const QueueView = lazy(async () => ({ default: (await import('./views/QueueView')).QueueView }));
const RadioView = lazy(async () => ({ default: (await import('./views/RadioView')).RadioView }));
const SearchView = lazy(async () => ({ default: (await import('./views/SearchView')).SearchView }));
const SettingsView = lazy(async () => ({ default: (await import('./views/SettingsView')).SettingsView }));

/**
 * A Uri contains `:` and provider ids may contain `/`-unsafe characters, so it
 * is always carried through the URL encoded. Every navigation goes through this
 * function and every view decodes with {@link decodeEntityUri}, which is the
 * only way the two halves stay in agreement.
 */
export function entityPath(uri: Uri): string {
  const encoded = encodeURIComponent(uri);
  let kind: ReturnType<typeof parseUri>['kind'];
  try {
    kind = parseUri(uri).kind;
  } catch {
    return '/';
  }
  switch (kind) {
    case 'album':
      return `/album/${encoded}`;
    case 'artist':
      return `/artist/${encoded}`;
    case 'playlist':
      return `/playlist/${encoded}`;
    case 'station':
      // Stations have no detail page of their own; the radio directory is where
      // they are found and played from.
      return '/radio';
    case 'track':
      // Likewise there is no standalone track page — the queue is where a
      // single track is inspectable.
      return '/queue';
    default:
      return '/';
  }
}

/**
 * A pack uri is `pack:<id>` — two segments, not the three `parseUri` expects —
 * so packs get their own path helper rather than going through
 * {@link entityPath}.
 */
export function packPath(uri: Uri): string {
  return `/packs/${encodeURIComponent(uri)}`;
}

export function searchPath(query: string): string {
  const trimmed = query.trim();
  return trimmed ? `/search/${encodeURIComponent(trimmed)}` : '/search';
}

export function decodeEntityUri(param: string | undefined): Uri | undefined {
  if (!param) return undefined;
  try {
    return decodeURIComponent(param);
  } catch {
    // A hand-edited, malformed escape sequence should render NotFound rather
    // than throw out of the router.
    return undefined;
  }
}

export function AppRoutes(): JSX.Element {
  return (
    // A chunk loads from disk in a few milliseconds, so a spinner would flash
    // rather than inform; the shell stays put and the region is simply empty.
    <Suspense fallback={<div className="min-h-[50vh]" aria-busy="true" />}>
      <Routes>
      <Route path="/" element={<HomeView />} />
      <Route path="/search" element={<SearchView />} />
      <Route path="/search/:query" element={<SearchView />} />
      <Route path="/library" element={<LibraryView />} />
      {/* `/library/playlists` is the canonical path for the collections page:
          the tab it selects renders it, so the sidebar's "See all" and the tab
          are one destination. */}
      <Route path="/library/:tab" element={<LibraryView />} />
      <Route path="/album/:uri" element={<AlbumView />} />
      <Route path="/artist/:uri" element={<ArtistView />} />
      <Route path="/playlist/:uri" element={<PlaylistView />} />
      <Route path="/packs/:uri" element={<PackView />} />
      <Route path="/bazaar" element={<BazaarView />} />
      <Route path="/liked" element={<LikedSongsView />} />
      <Route path="/radio" element={<RadioView />} />
      <Route path="/queue" element={<QueueView />} />
      <Route path="/settings" element={<SettingsView />} />
      <Route path="/settings/:section" element={<SettingsView />} />
        <Route path="*" element={<NotFoundView />} />
      </Routes>
    </Suspense>
  );
}
