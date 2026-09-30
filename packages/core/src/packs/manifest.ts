/**
 * `pack.json` / `index.json` parsing.
 *
 * Every function here treats its input as a document written by a stranger:
 * nothing is trusted, unknown fields are dropped, and every string that
 * survives has been stripped of control characters and truncated to a length
 * the UI can render. Structure only — the network-facing rules (scheme,
 * origin, size, count) belong to `bazaar.ts`, which is the one place that
 * fetches.
 */

import { BAZAAR_FORMAT, PACK_FORMAT, PACK_VERSION } from './types';
import type { PackEntry, PackManifest } from './types';
import type { Track } from '../types';

export type PackErrorCode = 'format' | 'too_large' | 'too_many' | 'unsafe_url' | 'network';

export class PackError extends Error {
  constructor(
    readonly code: PackErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PackError';
  }
}

/** Display caps. A remote document may not push a 4 MB "name" into a row. */
const ID_MAX = 64;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;
const AUTHOR_MAX = 80;
const TITLE_MAX = 300;
const ARTIST_MAX = 200;
const ARTISTS_PER_ENTRY = 16;
const URL_MAX = 2048;

/** C0/C1 controls. A pack has no use for any of them, and they are what
 *  smuggles line breaks and terminal escapes into a one-line row. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Anything outside this is refused as a filename component and as an id. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/u;

export function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(CONTROL, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** UTF-8 length without a TextEncoder: core has to run in three runtimes. */
export function utf8Size(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Surrogate pair: one 4-byte code point, and the low half is consumed here.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Monotonic within a process; with the wall clock it cannot collide. */
let idCounter = 0;

export function newPackId(): string {
  idCounter = (idCounter + 1) % 0x1000;
  const stamp = Date.now().toString(36).slice(-6);
  const seq = idCounter.toString(36).padStart(3, '0');
  return `p_${stamp}${seq}`;
}

export function packUri(id: string): string {
  return `pack:${id}`;
}

export function packIdOf(uri: string): string {
  return uri.startsWith('pack:') ? uri.slice('pack:'.length) : uri;
}

/** Safe as a path component and as a JSON key. Falls back to a fresh id. */
export function safeId(raw: string | undefined): string {
  const candidate = raw === undefined ? '' : raw.slice(0, ID_MAX);
  return candidate.length > 0 && SAFE_ID.test(candidate) ? candidate : newPackId();
}

export function entryFromTrack(track: Track): PackEntry {
  const entry: PackEntry = {
    uri: track.uri,
    title: track.title,
    artists: track.artists.map((a) => a.name).filter((n) => n.length > 0),
    durationMs: Math.max(0, Math.trunc(track.durationMs)),
  };
  if (track.album !== undefined) entry.album = track.album.name;
  const isrc = text(track.meta?.isrc, ID_MAX);
  if (isrc !== undefined) entry.isrc = isrc;
  return entry;
}

function parseEntry(value: unknown): PackEntry | undefined {
  if (!isRecord(value)) return undefined;
  // `title` and `artists` are required even when `uri` is set: the uri is a
  // hint, and the pack has to stay resolvable after the provider that minted
  // it is gone.
  const title = text(value.title, TITLE_MAX);
  if (title === undefined) return undefined;

  const artists: string[] = [];
  if (Array.isArray(value.artists)) {
    for (const raw of value.artists) {
      const name = text(raw, ARTIST_MAX);
      if (name !== undefined) artists.push(name);
      if (artists.length >= ARTISTS_PER_ENTRY) break;
    }
  } else {
    const single = text(value.artists, ARTIST_MAX);
    if (single !== undefined) artists.push(single);
  }

  const entry: PackEntry = { title, artists, durationMs: nonNegativeInt(value.durationMs) };
  const uri = text(value.uri, URL_MAX);
  if (uri !== undefined) entry.uri = uri;
  const album = text(value.album, NAME_MAX);
  if (album !== undefined) entry.album = album;
  const isrc = text(value.isrc, ID_MAX);
  if (isrc !== undefined) entry.isrc = isrc;
  return entry;
}

export interface ParseManifestOptions {
  /** Entries beyond this make the document invalid rather than truncated. */
  maxTracks?: number;
}

export function parseManifest(value: unknown, opts: ParseManifestOptions = {}): PackManifest {
  if (!isRecord(value)) throw new PackError('format', 'a pack must be a JSON object');
  if (value.format !== PACK_FORMAT) {
    throw new PackError('format', `not a ${PACK_FORMAT} document`);
  }
  const rawTracks = value.tracks;
  if (!Array.isArray(rawTracks)) throw new PackError('format', 'a pack must carry a tracks array');
  const maxTracks = opts.maxTracks;
  if (maxTracks !== undefined && rawTracks.length > maxTracks) {
    throw new PackError('too_many', `a pack may not carry more than ${maxTracks} tracks`);
  }

  const tracks: PackEntry[] = [];
  for (const raw of rawTracks) {
    const entry = parseEntry(raw);
    if (entry !== undefined) tracks.push(entry);
  }

  const now = Date.now();
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    version: nonNegativeInt(value.version) || PACK_VERSION,
    id: safeId(text(value.id, ID_MAX)),
    name: text(value.name, NAME_MAX) ?? 'Untitled pack',
    createdAt: nonNegativeInt(value.createdAt) || now,
    updatedAt: nonNegativeInt(value.updatedAt) || now,
    tracks,
  };
  const description = text(value.description, DESCRIPTION_MAX);
  if (description !== undefined) manifest.description = description;
  const author = text(value.author, AUTHOR_MAX);
  if (author !== undefined) manifest.author = author;
  const artwork = text(value.artwork, URL_MAX);
  if (artwork !== undefined) manifest.artwork = artwork;
  return manifest;
}

/** A `packs[]` entry with its `url`/`artwork` still unresolved. */
export interface RawIndexEntry {
  id: string;
  name: string;
  description?: string;
  author?: string;
  trackCount: number;
  artwork?: string;
  url: string;
  updatedAt: number;
}

export interface RawIndex {
  name?: string;
  description?: string;
  updatedAt: number;
  packs: RawIndexEntry[];
}

export interface ParseIndexOptions {
  /** Packs beyond this make the document invalid rather than truncated. */
  maxPacks?: number;
}

export function parseIndex(value: unknown, opts: ParseIndexOptions = {}): RawIndex {
  if (!isRecord(value)) throw new PackError('format', 'an index must be a JSON object');
  if (value.format !== BAZAAR_FORMAT) {
    throw new PackError('format', `not a ${BAZAAR_FORMAT} document`);
  }
  const rawPacks = value.packs;
  if (!Array.isArray(rawPacks)) throw new PackError('format', 'an index must carry a packs array');
  const maxPacks = opts.maxPacks;
  if (maxPacks !== undefined && rawPacks.length > maxPacks) {
    throw new PackError('too_many', `an index may not list more than ${maxPacks} packs`);
  }

  const packs: RawIndexEntry[] = [];
  for (const raw of rawPacks) {
    if (!isRecord(raw)) continue;
    const url = text(raw.url, URL_MAX);
    const name = text(raw.name, NAME_MAX);
    if (url === undefined || name === undefined) continue;
    const entry: RawIndexEntry = {
      id: safeId(text(raw.id, ID_MAX)),
      name,
      trackCount: nonNegativeInt(raw.trackCount),
      url,
      updatedAt: nonNegativeInt(raw.updatedAt),
    };
    const description = text(raw.description, DESCRIPTION_MAX);
    if (description !== undefined) entry.description = description;
    const author = text(raw.author, AUTHOR_MAX);
    if (author !== undefined) entry.author = author;
    const artwork = text(raw.artwork, URL_MAX);
    if (artwork !== undefined) entry.artwork = artwork;
    packs.push(entry);
  }

  const index: RawIndex = { updatedAt: nonNegativeInt(value.updatedAt), packs };
  const name = text(value.name, NAME_MAX);
  if (name !== undefined) index.name = name;
  const description = text(value.description, DESCRIPTION_MAX);
  if (description !== undefined) index.description = description;
  return index;
}

/**
 * `pack.json`, pretty-printed. Written out field by field in the order
 * `docs/packs.md` documents, with the optional fields present as `""`/`null`
 * rather than missing, so a published file looks like the contract's sample.
 */
export function manifestToJson(manifest: PackManifest): string {
  const document = {
    format: PACK_FORMAT,
    version: manifest.version,
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    author: manifest.author ?? '',
    artwork: manifest.artwork ?? null,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    tracks: manifest.tracks.map((entry) => ({
      uri: entry.uri ?? null,
      title: entry.title,
      artists: entry.artists,
      album: entry.album ?? null,
      durationMs: entry.durationMs,
      isrc: entry.isrc ?? null,
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new PackError('format', 'the document is not valid JSON', err);
  }
}
