/**
 * Cover Art Archive.
 *
 * CAA answers 404 for the overwhelming majority of MBIDs — that is the normal
 * "this release has no art" reply, not an error, so nothing in here throws.
 */

import type { Artwork, ArtworkSource } from '../types';
import type { HostBridge } from '../host/types';

const CAA = 'https://coverartarchive.org';
const WEEK_SEC = 604800;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** CAA names the same three renditions both numerically and by word. */
const THUMB_KEYS: Array<{ keys: string[]; size: number }> = [
  { keys: ['250', 'small'], size: 250 },
  { keys: ['500', 'medium'], size: 500 },
  { keys: ['1200', 'large'], size: 1200 },
];

function artworkFrom(payload: unknown): Artwork | undefined {
  if (!isRecord(payload)) return undefined;

  const images = asArray(payload['images']).filter(isRecord);
  if (images.length === 0) return undefined;

  const front = images.find((img) => img['front'] === true) ?? images[0];
  if (front === undefined) return undefined;

  const thumbnails = isRecord(front['thumbnails']) ? front['thumbnails'] : {};
  const sources: ArtworkSource[] = [];
  for (const { keys, size } of THUMB_KEYS) {
    for (const key of keys) {
      const url = asString(thumbnails[key]);
      if (url !== undefined) {
        sources.push({ url, size });
        break;
      }
    }
  }

  // The original upload has no declared dimensions; treat it as the largest
  // rendition only when no 1200px thumbnail was generated.
  const original = asString(front['image']);
  if (original !== undefined && !sources.some((s) => s.size >= 1200)) {
    sources.push({ url: original, size: 1200 });
  }

  if (sources.length === 0) return undefined;
  sources.sort((a, b) => a.size - b.size);
  return { sources };
}

async function fetchCover(host: HostBridge, path: string): Promise<Artwork | undefined> {
  try {
    const res = await host.http.request({
      url: `${CAA}/${path}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      cacheTtlSec: WEEK_SEC,
      timeoutMs: 15000,
    });
    if (res.status === 404 || res.status === 400) return undefined;
    if (res.status < 200 || res.status >= 300) return undefined;
    return artworkFrom(JSON.parse(res.body) as unknown);
  } catch {
    return undefined;
  }
}

export async function coverForRelease(host: HostBridge, mbid: string): Promise<Artwork | undefined> {
  if (!UUID_RE.test(mbid)) return undefined;
  return fetchCover(host, `release/${mbid}`);
}

export async function coverForReleaseGroup(
  host: HostBridge,
  mbid: string,
): Promise<Artwork | undefined> {
  if (!UUID_RE.test(mbid)) return undefined;
  return fetchCover(host, `release-group/${mbid}`);
}
