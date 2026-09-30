/**
 * Canned Bazaar documents for `bazaar.test.ts`.
 *
 * A url mapped to a string is served as that body; mapped to a number it is
 * served as that HTTP status. `"<url>#content-length"` overrides the declared
 * length, which is how the "the server lies about its size" case is written.
 */

import type { HttpRequest, HttpResponse } from '../host/types';

export type HostRequests = string[];

export function serve(documents: Record<string, string | number>): {
  http: (req: HttpRequest) => Promise<HttpResponse>;
  requests: HostRequests;
} {
  const requests: HostRequests = [];
  return {
    requests,
    http: (req) => {
      requests.push(req.url);
      const found = documents[req.url];
      if (found === undefined) {
        return Promise.resolve({ status: 404, headers: {}, body: '', fromCache: false });
      }
      if (typeof found === 'number') {
        return Promise.resolve({ status: found, headers: {}, body: '', fromCache: false });
      }
      const declared = documents[`${req.url}#content-length`];
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'Content-Length': String(typeof declared === 'number' ? declared : found.length),
      };
      return Promise.resolve({ status: 200, headers, body: found, fromCache: false });
    },
  };
}

/** A `pack.json` with `tracks` filler entries. */
export function manifestDocument(id: string, name: string, tracks: number): string {
  return JSON.stringify({
    format: 'ritmopack',
    version: 1,
    id,
    name,
    description: '',
    author: 'someone',
    artwork: null,
    createdAt: 1,
    updatedAt: 1,
    tracks: Array.from({ length: tracks }, (_, i) => ({
      uri: `audius:track:${id}-${i}`,
      title: `Nothing Serves This ${i}`,
      artists: ['Ghost'],
      album: 'Mix',
      durationMs: 210_000,
      isrc: null,
    })),
  });
}
