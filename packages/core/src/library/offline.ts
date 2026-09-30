/**
 * Offline downloads.
 *
 * The bytes are the host's problem (`host.files.download` streams them and
 * reports progress); this file owns the bookkeeping in `offline_audio` and the
 * LRU budget. `last_used_at` is bumped on every playback lookup, so pruning
 * evicts what the user stopped listening to rather than what they downloaded
 * first.
 */

import type { StreamRef, Track, Uri } from '../types';
import type { HostBridge } from '../host/types';
import type { LibraryErrorSink, Repo } from './repo';
import {
  IN_CHUNK, LibraryError, SafeDb, asString, chunk, dedupe, intOr, nonEmpty,
  parseTrackSnapshot, placeholders, rowToTrack,
} from './repo';

const MAX_PARALLEL_DOWNLOADS = 3;

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/aacp': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/webm': 'webm',
  'audio/x-ms-wma': 'wma',
};

const OFFLINE_UPSERT = `INSERT INTO offline_audio (track_uri, path, bytes, mime, downloaded_at, last_used_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(track_uri) DO UPDATE SET
  path          = excluded.path,
  bytes         = excluded.bytes,
  mime          = COALESCE(excluded.mime, offline_audio.mime),
  downloaded_at = excluded.downloaded_at,
  last_used_at  = excluded.last_used_at`;

export class Offline {
  private readonly db: SafeDb;
  private readonly inflight = new Set<Uri>();

  constructor(private readonly host: HostBridge, private readonly repo: Repo) {
    this.db = new SafeDb(host);
  }

  get onError(): LibraryErrorSink | undefined {
    return this.db.onError;
  }

  set onError(fn: LibraryErrorSink | undefined) {
    this.db.onError = fn;
  }

  /**
   * Unlike the database calls in this layer, a failed transfer rejects: the
   * download UI has to distinguish "saved" from "the CDN hung up".
   */
  async download(
    track: Track,
    stream: StreamRef,
    onProgress?: (r: number, t?: number) => void,
  ): Promise<void> {
    if (track.uri.length === 0) return;
    if (!this.host.capabilities.offlineDownloads) {
      throw new LibraryError('offline downloads are not supported on this platform');
    }
    if (this.inflight.has(track.uri)) return;
    if (await this.isStored(track.uri)) return;

    const url = nonEmpty(stream.url);
    if (url === undefined) {
      throw new LibraryError(`no stream url to download for ${track.uri}`);
    }

    const destRelative = `${safeSegment(track.provider)}/${hashUri(track.uri)}.${extFor(stream.mimeType)}`;
    this.inflight.add(track.uri);
    try {
      const result = await this.host.files.download({
        id: track.uri,
        url,
        headers: stream.headers,
        destRelative,
        onProgress,
      });
      const now = Date.now();
      await this.repo.upsertTracks([track]);
      await this.db.execute(OFFLINE_UPSERT, [
        track.uri,
        result.path,
        Math.max(0, intOr(result.bytes, 0)),
        nonEmpty(stream.mimeType) ?? null,
        now,
        now,
      ]);
    } finally {
      this.inflight.delete(track.uri);
    }
  }

  async cancel(trackUri: Uri): Promise<void> {
    this.inflight.delete(trackUri);
    try {
      await this.host.files.cancelDownload(trackUri);
    } catch (err) {
      this.onError?.(err);
    }
  }

  async remove(trackUri: Uri): Promise<void> {
    const path = await this.db.text('SELECT path FROM offline_audio WHERE track_uri = ?', [trackUri]);
    if (path !== undefined) {
      try {
        await this.host.files.remove(path);
      } catch (err) {
        // A file already gone by other means must still drop its row.
        this.onError?.(err);
      }
    }
    await this.db.execute('DELETE FROM offline_audio WHERE track_uri = ?', [trackUri]);
  }

  async isOffline(trackUri: Uri): Promise<boolean> {
    return this.isStored(trackUri);
  }

  async offlineSet(uris: Uri[]): Promise<Set<Uri>> {
    const out = new Set<Uri>();
    const wanted = dedupe(uris);
    if (wanted.length === 0) return out;
    for (const group of chunk(wanted, IN_CHUNK)) {
      const rows = await this.db.query(
        `SELECT track_uri FROM offline_audio WHERE track_uri IN (${placeholders(group.length)})`,
        group,
      );
      for (const row of rows) {
        const uri = nonEmpty(asString(row.track_uri));
        if (uri !== undefined) out.add(uri);
      }
    }
    return out;
  }

  async localPathFor(trackUri: Uri): Promise<string | undefined> {
    const path = await this.db.text('SELECT path FROM offline_audio WHERE track_uri = ?', [trackUri]);
    if (path === undefined) return undefined;
    let present = true;
    try {
      present = await this.host.files.exists(path);
    } catch {
      // No way to verify — assume it is there and let playback report the truth.
      present = true;
    }
    if (!present) {
      await this.db.execute('DELETE FROM offline_audio WHERE track_uri = ?', [trackUri]);
      return undefined;
    }
    await this.db.execute('UPDATE offline_audio SET last_used_at = ? WHERE track_uri = ?', [
      Date.now(), trackUri,
    ]);
    return path;
  }

  async list(): Promise<Array<{ track: Track; bytes: number; downloadedAt: number }>> {
    const rows = await this.db.query(
      `SELECT t.*, o.bytes AS offline_bytes, o.downloaded_at AS offline_downloaded_at
         FROM offline_audio o JOIN tracks t ON t.uri = o.track_uri
        ORDER BY o.downloaded_at DESC`,
    );
    return rows.map((row) => ({
      track: rowToTrack(row),
      bytes: intOr(row.offline_bytes, 0),
      downloadedAt: intOr(row.offline_downloaded_at, 0),
    }));
  }

  async totalBytes(): Promise<number> {
    return this.db.number('SELECT COALESCE(SUM(bytes), 0) AS n FROM offline_audio');
  }

  /** Evicts least-recently-used downloads until the store fits. Returns bytes freed. */
  async pruneTo(maxBytes: number): Promise<number> {
    const budget = Number.isFinite(maxBytes) ? Math.max(0, Math.trunc(maxBytes)) : 0;
    const total = await this.totalBytes();
    if (total <= budget) return 0;

    const rows = await this.db.query(
      'SELECT track_uri, path, bytes FROM offline_audio ORDER BY last_used_at ASC, downloaded_at ASC',
    );
    let freed = 0;
    for (const row of rows) {
      if (total - freed <= budget) break;
      const uri = nonEmpty(asString(row.track_uri));
      if (uri === undefined) continue;
      const bytes = intOr(row.bytes, 0);
      const path = nonEmpty(asString(row.path));
      if (path !== undefined) {
        try {
          await this.host.files.remove(path);
        } catch (err) {
          this.onError?.(err);
        }
      }
      await this.db.execute('DELETE FROM offline_audio WHERE track_uri = ?', [uri]);
      freed += bytes;
    }
    return freed;
  }

  async downloadPlaylist(
    uri: Uri,
    resolveStream: (t: Track) => Promise<StreamRef>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const rows = await this.db.query(
      'SELECT track_json FROM playlist_items WHERE playlist_uri = ? ORDER BY position ASC',
      [uri],
    );
    const tracks: Track[] = [];
    const seen = new Set<Uri>();
    for (const row of rows) {
      const track = parseTrackSnapshot(row.track_json);
      if (track === undefined || seen.has(track.uri)) continue;
      seen.add(track.uri);
      tracks.push(track);
    }

    const stored = await this.offlineSet(tracks.map((t) => t.uri));
    const pending = tracks.filter((t) => !stored.has(t.uri));
    const total = pending.length;
    if (total === 0) {
      onProgress?.(0, 0);
      return;
    }

    let done = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const track = pending[index];
        if (track === undefined) return;
        try {
          const stream = await resolveStream(track);
          await this.download(track, stream);
        } catch (err) {
          // One dead track must not abort a 200-song download.
          this.onError?.(err);
        }
        done += 1;
        onProgress?.(done, total);
      }
    };

    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < Math.min(MAX_PARALLEL_DOWNLOADS, total); i += 1) workers.push(worker());
    await Promise.all(workers);
  }

  private async isStored(trackUri: Uri): Promise<boolean> {
    const row = await this.db.one('SELECT 1 AS hit FROM offline_audio WHERE track_uri = ?', [
      trackUri,
    ]);
    return row !== undefined;
  }
}

/** 64 bits of FNV-1a-style mixing — enough to keep cache filenames distinct, and
 *  available without a crypto API in every host this runs in. */
export function hashUri(uri: Uri): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < uri.length; i += 1) {
    const c = uri.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function extFor(mimeType: string | undefined): string {
  if (mimeType === undefined) return 'bin';
  const base = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return EXT_BY_MIME[base] ?? 'bin';
}

function safeSegment(value: string): string {
  const clean = value.replace(/[^a-z0-9._-]/gi, '_');
  return clean.length > 0 ? clean : 'other';
}
