import { useMemo } from 'react';

import type { LyricLine, Lyrics, Track } from '@ritmo/core';

import { useServices } from '../services';
import { useAsync } from './useAsync';
import type { UseAsyncResult } from './useAsync';

/**
 * Keyed on the track uri, so a pause/resume or a metadata enrichment of the same
 * track does not re-hit the lyrics providers.
 */
export interface UseLyricsResult extends UseAsyncResult<Lyrics | undefined> {
  /** Synced lines, when the source had them. */
  lines: LyricLine[] | undefined;
  plain: string | undefined;
  source: string | undefined;
}

export function useLyrics(track: Track | undefined): UseLyricsResult {
  const { metadata } = useServices();
  const result = useAsync<Lyrics | undefined>(
    () => (track ? metadata.lyrics(track) : Promise.resolve(undefined)),
    [metadata, track?.uri],
    { enabled: track !== undefined },
  );

  // The panes want the three fields directly; spreading them here keeps every
  // consumer from repeating the same `result.data?.…` dance.
  return useMemo(
    () => ({
      ...result,
      lines: result.data?.synced,
      plain: result.data?.plain,
      source: result.data?.source,
    }),
    [result],
  );
}
