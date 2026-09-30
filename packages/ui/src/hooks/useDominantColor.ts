import { useEffect, useState } from 'react';
import { dominantColor } from '@ritmo/core';
import type { Artwork, HostBridge } from '@ritmo/core';

import { useServices } from '../services';

/**
 * Per-URL results, kept for the lifetime of the session: extracting a colour
 * costs a decode plus a canvas read, and the same art comes back on every
 * revisit. `null` records "already computed, no colour" so a miss is not retried
 * on every mount.
 */
const cache = new Map<string, string | null>();

function smallestSource(artwork: Artwork | undefined): string | undefined {
  // `sources` is sorted ascending; the smallest one is plenty for an average
  // colour and is usually already in the image cache from a list row.
  return artwork?.sources[0]?.url;
}

function playableUrl(host: HostBridge, url: string): string {
  // `local:` artwork is an absolute filesystem path, which the WebView cannot
  // load as-is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return host.files.toPlayableUrl(url);
}

export function useDominantColor(artwork?: Artwork): string | undefined {
  const { host } = useServices();
  const source = smallestSource(artwork);
  const url = source ? playableUrl(host, source) : undefined;
  const provided = artwork?.accent;

  const [color, setColor] = useState<string | undefined>(() => {
    if (provided) return provided;
    if (!url) return undefined;
    return cache.get(url) ?? undefined;
  });

  useEffect(() => {
    if (provided) {
      setColor(provided);
      return;
    }
    if (!url) {
      setColor(undefined);
      return;
    }

    const hit = cache.get(url);
    if (hit !== undefined) {
      setColor(hit ?? undefined);
      return;
    }

    let alive = true;
    void dominantColor(url)
      .then((found) => {
        cache.set(url, found ?? null);
        if (alive) setColor(found);
      })
      .catch(() => {
        cache.set(url, null);
        if (alive) setColor(undefined);
      });

    return () => {
      alive = false;
    };
  }, [url, provided]);

  return color;
}
