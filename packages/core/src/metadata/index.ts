/**
 * Metadata enrichment facade.
 *
 * The UI calls into this from render paths, so every method is best-effort: on
 * any failure the input comes back untouched, identical requests share one
 * in-flight promise, and recent empty answers are remembered for a while so a
 * scrolling list cannot turn into a request storm.
 */

import type { Artist, Artwork, Lyrics, Track } from '../types';
import type { HostBridge } from '../host/types';
import { coverForRelease, coverForReleaseGroup } from './coverart';
import { fetchArtistBio, lookupArtist, lookupRecording, lookupReleaseGroup } from './musicbrainz';
import { fetchLyrics } from './lyrics';

/** How long an unsuccessful enrichment is remembered, in memory only. */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const MAX_NEGATIVE_ENTRIES = 512;
const MAX_GENRES = 5;

export class MetadataService {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly misses = new Map<string, number>();

  constructor(private readonly host: HostBridge) {}

  /**
   * Fills in missing artwork, genres and release date from MusicBrainz and the
   * Cover Art Archive. Provider-supplied values are never overwritten.
   */
  async enrichTrack(track: Track): Promise<Track> {
    // Radio has no discography to look up and its titles change mid-stream.
    if (track.provider === 'radio' || track.isLive === true) return track;

    const needsArtwork = (track.artwork?.sources.length ?? 0) === 0;
    const needsGenres = (track.genres?.length ?? 0) === 0;
    const needsDate = track.releaseDate === undefined;
    if (!needsArtwork && !needsGenres && !needsDate) return track;

    const artist = track.artists[0]?.name;
    if (artist === undefined || track.title.trim().length === 0) return track;

    const key = `track:${track.uri}`;
    if (this.missedRecently(key)) return track;

    return this.dedupe(key, async () => {
      try {
        const recording = await lookupRecording(this.host, {
          title: track.title,
          artist,
          album: track.album?.name,
          durationMs: track.durationMs,
        });
        if (recording === undefined) {
          this.remember(key);
          return track;
        }

        const group = needsGenres || needsDate
          ? recording.releaseGroupMbid !== undefined
            ? await lookupReleaseGroup(this.host, recording.releaseGroupMbid)
            : undefined
          : undefined;

        let artwork: Artwork | undefined;
        if (needsArtwork) {
          if (recording.releaseMbid !== undefined) {
            artwork = await coverForRelease(this.host, recording.releaseMbid);
          }
          if (artwork === undefined && recording.releaseGroupMbid !== undefined) {
            artwork = await coverForReleaseGroup(this.host, recording.releaseGroupMbid);
          }
        }

        const genres = needsGenres && group !== undefined && group.genres.length > 0
          ? group.genres.slice(0, MAX_GENRES)
          : undefined;
        const releaseDate = needsDate ? group?.firstReleaseDate : undefined;

        if (artwork === undefined && genres === undefined && releaseDate === undefined) {
          this.remember(key);
          return track;
        }

        const enriched: Track = { ...track };
        if (artwork !== undefined) enriched.artwork = artwork;
        if (genres !== undefined) enriched.genres = genres;
        if (releaseDate !== undefined) enriched.releaseDate = releaseDate;
        enriched.meta = {
          ...track.meta,
          musicbrainz: {
            recordingMbid: recording.mbid,
            releaseMbid: recording.releaseMbid,
            releaseGroupMbid: recording.releaseGroupMbid,
            isrcs: recording.isrcs,
          },
        };
        return enriched;
      } catch {
        this.remember(key);
        return track;
      }
    });
  }

  /** Adds a Wikipedia-sourced biography and MusicBrainz tags as genres. */
  async enrichArtist(artist: Artist, lang: 'tr' | 'en' = 'tr'): Promise<Artist> {
    const needsBio = artist.bio === undefined || artist.bio.trim().length === 0;
    const needsGenres = (artist.genres?.length ?? 0) === 0;
    if (!needsBio && !needsGenres) return artist;
    if (artist.name.trim().length === 0) return artist;

    const key = `artist:${artist.uri}:${lang}`;
    if (this.missedRecently(key)) return artist;

    return this.dedupe(key, async () => {
      try {
        const mb = await lookupArtist(this.host, artist.name);
        if (mb === undefined) {
          this.remember(key);
          return artist;
        }

        const bio = needsBio ? await fetchArtistBio(this.host, mb, lang) : undefined;
        const genres = needsGenres && mb.tags.length > 0 ? mb.tags.slice(0, MAX_GENRES) : undefined;

        if (bio === undefined && genres === undefined) {
          this.remember(key);
          return artist;
        }

        const enriched: Artist = { ...artist };
        if (bio !== undefined) enriched.bio = bio;
        if (genres !== undefined) enriched.genres = genres;
        return enriched;
      } catch {
        this.remember(key);
        return artist;
      }
    });
  }

  async lyrics(track: Track): Promise<Lyrics | undefined> {
    const key = `lyrics:${track.uri}`;
    return this.dedupe(key, async () => {
      try {
        return await fetchLyrics(this.host, track);
      } catch {
        return undefined;
      }
    });
  }

  private dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    const promise = run().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private missedRecently(key: string): boolean {
    const at = this.misses.get(key);
    if (at === undefined) return false;
    if (Date.now() - at < NEGATIVE_TTL_MS) return true;
    this.misses.delete(key);
    return false;
  }

  private remember(key: string): void {
    if (this.misses.size >= MAX_NEGATIVE_ENTRIES) {
      const oldest = this.misses.keys().next();
      if (oldest.done !== true) this.misses.delete(oldest.value);
    }
    this.misses.set(key, Date.now());
  }
}

export * from './musicbrainz';
export * from './coverart';
export * from './lyrics';
export * from './lastfm';
