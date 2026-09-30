/**
 * Packs and the Bazaar — domain model.
 *
 * `docs/packs.md` is the frozen contract for the two wire documents
 * (`pack.json`, `index.json`); everything here mirrors it. A pack carries
 * *track identity*, never audio: a manifest entry stays in the pack even when
 * nothing resolves it today, which is what lets the same pack work for a
 * subscriber who has different sources enabled.
 */

import type { Artwork, Track, Uri } from '../types';

export const PACK_FORMAT = 'ritmopack';
export const BAZAAR_FORMAT = 'ritmobazaar';
export const PACK_VERSION = 1;

/** One `tracks[]` entry of a `pack.json`, exactly as written. */
export interface PackEntry {
  /** Preferred resolution key; absent in a hand-written pack. */
  uri?: Uri;
  title: string;
  artists: string[];
  album?: string;
  /** `0` when unknown. Used by the fuzzy matcher. */
  durationMs: number;
  /** Strongest match key when the publisher had one. */
  isrc?: string;
}

/** A `pack.json` document. */
export interface PackManifest {
  format: typeof PACK_FORMAT;
  version: number;
  /** Stable across edits and re-exports. */
  id: string;
  name: string;
  description?: string;
  author?: string;
  /** Path relative to the manifest, an absolute URL, or absent. */
  artwork?: string;
  createdAt: number;
  updatedAt: number;
  tracks: PackEntry[];
}

/** One stored `pack_items` row. */
export interface PackItem {
  /** Dense, 0-based. */
  position: number;
  /** The manifest entry as written — the pack's memory of what it wanted. */
  entry: PackEntry;
  /** Resolved snapshot; absent means "not available from your sources". */
  track?: Track;
  addedAt: number;
}

export interface Pack {
  /** `pack:<id>`. */
  uri: Uri;
  id: string;
  name: string;
  description?: string;
  author?: string;
  artwork?: Artwork;
  /** `local` for one the user built, `remote` for one installed from a source. */
  source: 'local' | 'remote';
  sourceUrl?: string;
  packUrl?: string;
  remoteId?: string;
  createdAt: number;
  updatedAt: number;
  /** Every entry, resolved or not. */
  trackCount: number;
  /** How many entries currently resolve to nothing. */
  unavailableCount: number;
  /** Present only when asked for with tracks. */
  items?: PackItem[];
  /** The resolved subset of {@link items}, in pack order. */
  tracks?: Track[];
}

/** A subscribed `index.json`. */
export interface BazaarSource {
  url: string;
  name?: string;
  addedAt: number;
  lastFetchAt?: number;
  /** False after a malformed, oversized or unreachable document. */
  ok: boolean;
  /** Why it is not ok — shown verbatim next to the source. */
  error?: string;
  /** Packs the last good fetch offered. */
  packCount?: number;
}

/** One `packs[]` entry of an `index.json`, after validation. */
export interface BazaarEntry {
  /** Index this came from. */
  sourceUrl: string;
  sourceName?: string;
  id: string;
  name: string;
  description?: string;
  author?: string;
  trackCount: number;
  /** Absolute, same-origin-checked URL. */
  artwork?: string;
  /** Absolute, same-origin-checked `pack.json` URL. */
  url: string;
  updatedAt: number;
}

/** What {@link Packs.install} reports back about an import. */
export interface InstallReport {
  resolved: number;
  unavailable: number;
}
