/**
 * Deciding whether a candidate track *is* the recording a manifest entry asked
 * for.
 *
 * There are already three matchers in this codebase — `dedupeTracks`'
 * title+artist+duration collapse, `similarity`'s token-set ratio and
 * `normalizeKey`'s folding. This file adds no fourth one: it composes those,
 * including borrowing `dedupeTracks` itself as the oracle for how close two
 * durations have to be, so the pack layer can never drift from what search
 * considers the same recording.
 */

import { dedupeTracks } from '../search';
import { normalizeKey, similarity, stripFeat } from '../util/text';
import type { ProviderId, Track } from '../types';
import type { PackEntry } from './types';

/** Below this the titles are different songs, whatever the artist says. */
const TITLE_MIN = 0.82;
/** Artists are credited inconsistently ("feat.", "&", "and"), so this is loose. */
const ARTIST_MIN = 0.62;

function probe(provider: ProviderId, durationMs: number): Track {
  return {
    uri: `${provider}:track:__probe`,
    provider,
    title: 'probe',
    artists: [{ uri: `${provider}:artist:__probe`, name: 'probe' }],
    durationMs,
  };
}

/**
 * Whether two durations are close enough to be the same recording.
 *
 * Asked of `dedupeTracks` rather than restating its tolerance: two probes that
 * already agree on title and artist collapse into one row exactly when their
 * durations are within the slack the search layer allows.
 */
export function durationsMatch(a: number, b: number): boolean {
  return dedupeTracks([probe('local', a), probe('audius', b)]).length === 1;
}

/** A synthetic Track for the entry, so `dedupeTracks` can judge it directly. */
function entryAsTrack(entry: PackEntry): Track {
  return {
    uri: 'local:track:__entry',
    provider: 'local',
    title: entry.title,
    artists: entry.artists.map((name) => ({ uri: `local:artist:${normalizeKey(name)}`, name })),
    durationMs: entry.durationMs,
  };
}

function isrcOf(track: Track): string | undefined {
  const raw = track.meta?.isrc;
  return typeof raw === 'string' && raw.length > 0 ? raw.toUpperCase() : undefined;
}

/**
 * `0` means "not the same recording"; anything above is a confidence, so a
 * caller with several candidates can take the best one.
 */
export function matchScore(entry: PackEntry, candidate: Track): number {
  const isrc = entry.isrc?.toUpperCase();
  // An ISRC identifies the recording itself, so it outranks every heuristic.
  if (isrc !== undefined && isrcOf(candidate) === isrc) return 1;

  // The exact case: same normalised title + primary artist and a compatible
  // duration is precisely what `dedupeTracks` collapses.
  if (dedupeTracks([entryAsTrack(entry), candidate]).length === 1) return 0.97;

  if (!durationsMatch(entry.durationMs, candidate.durationMs)) return 0;

  const title = similarity(entry.title, candidate.title);
  if (title < TITLE_MIN) return 0;

  const wanted = entry.artists.join(' ');
  const offered = candidate.artists.map((a) => a.name).join(' ');
  // A pack written without artist credits can only be matched on title.
  if (wanted.length === 0 || offered.length === 0) return title * 0.7;

  const artist = similarity(wanted, offered);
  if (artist < ARTIST_MIN) return 0;
  return 0.6 * title + 0.4 * artist;
}

/** The best candidate, or `undefined` when none of them is the same recording. */
export function bestMatch(entry: PackEntry, candidates: readonly Track[]): Track | undefined {
  let best: Track | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = matchScore(entry, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** The entry's title without a featuring credit — the most portable probe. */
export function titleProbe(entry: PackEntry): string {
  return stripFeat(entry.title);
}

/** Search text for an entry: what a person would have typed to find it. */
export function searchTextFor(entry: PackEntry): string {
  const artist = entry.artists[0];
  const title = titleProbe(entry);
  return artist === undefined ? title : `${title} ${stripFeat(artist)}`;
}

/**
 * Probes to try in order. The title alone comes first because FTS5 ANDs its
 * tokens: a credit the library does not carry ("feat. Nobody") would make the
 * whole query miss, and `bestMatch` is what discriminates anyway.
 */
export function probesFor(entry: PackEntry): string[] {
  const title = titleProbe(entry);
  const withArtist = searchTextFor(entry);
  return title === withArtist ? [title] : [title, withArtist];
}
