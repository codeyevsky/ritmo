import type {
  Album, Artist, ArtistRef, Artwork, Page, Playlist, SearchQuery, SearchResults,
  Shelf, ShelfItem, StreamRef, Track, Uri,
} from '../types';
import { emptySearchResults, makeUri, parseUri } from '../types';
import type { MusicProvider, ProviderCapabilities, ProviderContext } from './types';
import { ProviderError } from './types';

type Quality = 'low' | 'medium' | 'high' | 'lossless';

const SEARCH_BASE = 'https://archive.org/advancedsearch.php';
const METADATA_BASE = 'https://archive.org/metadata';
const DOWNLOAD_BASE = 'https://archive.org/download';
const IMG_BASE = 'https://archive.org/services/img';

const SEARCH_TTL_SEC = 600;
/** The home shelves query fixed collections sorted by all-time downloads —
 *  effectively static rankings, so they get a much longer lease than a search. */
const SHELF_TTL_SEC = 21600;
/** Item metadata never changes once an item is reviewed, and the payloads are
 *  megabyte-sized, so they are worth a full day on disk. */
const METADATA_TTL_SEC = 86400;

const SEARCH_FIELDS = [
  'identifier', 'title', 'creator', 'year', 'downloads', 'subject', 'collection',
] as const;

const DOWNLOADS_SORT = 'downloads desc';
const YEAR_SORT = 'year desc';

const GENRE_LIMIT = 8;
const SHELF_ROWS = 20;
const ARTIST_ALBUM_ROWS = 50;
const ARTIST_PROFILE_ROWS = 12;
/** Search hits are items (= albums); expanding a few of them into real tracks
 *  makes archive results directly playable without blowing the request budget. */
const TRACK_EXPANSION_ITEMS = 3;
const TRACK_EXPANSION_CAP = 30;
const TOP_TRACK_ITEMS = 3;
const TOP_TRACK_PER_ITEM = 4;
const TOP_TRACK_CAP = 10;

const AUDIO_FORMATS = new Set([
  'VBR MP3', 'MP3', 'Ogg Vorbis', 'Flac', '24bit Flac', 'AIFF', 'WAVE',
]);

const LOSSLESS_PREFERENCE = [
  '24bit Flac', 'Flac', 'WAVE', 'AIFF', 'VBR MP3', 'MP3', 'Ogg Vorbis',
];
const LOSSY_PREFERENCE = [
  'VBR MP3', 'MP3', 'Ogg Vorbis', 'Flac', '24bit Flac', 'AIFF', 'WAVE',
];

const FORMAT_MIME: Record<string, string> = {
  'VBR MP3': 'audio/mpeg',
  'MP3': 'audio/mpeg',
  'Ogg Vorbis': 'audio/ogg',
  'Flac': 'audio/flac',
  '24bit Flac': 'audio/flac',
  'AIFF': 'audio/aiff',
  'WAVE': 'audio/wav',
};

const EXTENSION_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  aifc: 'audio/aiff',
  wav: 'audio/wav',
  wave: 'audio/wav',
  m4a: 'audio/mp4',
};

type MaybeMulti = string | string[] | number | number[] | undefined | null;

interface ArchiveSearchDoc {
  identifier?: MaybeMulti;
  title?: MaybeMulti;
  creator?: MaybeMulti;
  year?: MaybeMulti;
  downloads?: MaybeMulti;
  subject?: MaybeMulti;
  collection?: MaybeMulti;
}

interface ArchiveSearchResponse {
  response?: {
    numFound?: number;
    start?: number;
    docs?: ArchiveSearchDoc[];
  };
}

interface ArchiveFile {
  name?: MaybeMulti;
  format?: MaybeMulti;
  title?: MaybeMulti;
  artist?: MaybeMulti;
  creator?: MaybeMulti;
  album?: MaybeMulti;
  track?: MaybeMulti;
  length?: MaybeMulti;
  size?: MaybeMulti;
  original?: MaybeMulti;
}

interface ArchiveMetadataFields {
  identifier?: MaybeMulti;
  title?: MaybeMulti;
  creator?: MaybeMulti;
  date?: MaybeMulti;
  year?: MaybeMulti;
  subject?: MaybeMulti;
  collection?: MaybeMulti;
  mediatype?: MaybeMulti;
}

interface ArchiveMetadata {
  metadata?: ArchiveMetadataFields;
  files?: ArchiveFile[];
}

interface SearchPage {
  docs: ArchiveSearchDoc[];
  total?: number;
}

interface ShelfSpec {
  id: string;
  titleKey: string;
  /** English fallback for `titleKey`; this module has no locale of its own. */
  title: string;
  subtitleKey: string;
  subtitle: string;
  query: string;
}

const SHELF_SPECS: ShelfSpec[] = [
  {
    id: 'archive-music',
    titleKey: 'shelf.archiveMusicTitle',
    title: 'Picks from the Archive',
    subtitleKey: 'shelf.archiveMusicSubtitle',
    subtitle: 'The most-downloaded music recordings',
    query: 'mediatype:(audio) AND collection:(audio_music)',
  },
  {
    id: 'archive-live',
    titleKey: 'shelf.archiveLiveTitle',
    title: 'Live recordings',
    subtitleKey: 'shelf.archiveLiveSubtitle',
    subtitle: 'Concert tapes from the Live Music Archive',
    query: 'mediatype:(audio) AND collection:(etree)',
  },
  {
    id: 'archive-78rpm',
    titleKey: 'shelf.archive78Title',
    title: '78 rpm records',
    subtitleKey: 'shelf.archive78Subtitle',
    subtitle: 'Digitised shellac from the 78rpm collection',
    query: 'mediatype:(audio) AND collection:(78rpm)',
  },
];

export class ArchiveProvider implements MusicProvider {
  readonly id = 'archive' as const;
  readonly displayName = 'Internet Archive';
  readonly capabilities: ProviderCapabilities = {
    search: true,
    albums: true,
    artists: true,
    playlists: false,
    stations: false,
    related: false,
    shelves: true,
    downloadable: true,
    needsNetwork: true,
  };

  constructor(private readonly ctx: ProviderContext) {}

  async search(query: SearchQuery): Promise<SearchResults> {
    const results = emptySearchResults();
    const text = query.text.trim();
    if (!text) return results;

    const kinds = query.kinds;
    const wantAlbums = !kinds || kinds.includes('album');
    const wantArtists = !kinds || kinds.includes('artist');
    const wantTracks = !kinds || kinds.includes('track');
    if (!wantAlbums && !wantArtists && !wantTracks) return results;

    const rows = clampRows(query.limit ?? 24);
    const page = pageFromOffset(query.offset, rows);
    const { docs } = await this.advancedSearch(
      `${AUDIO_SCOPE} AND (${escapeLucene(text)})`,
      rows,
      page,
      [DOWNLOADS_SORT],
    );

    const ranked = musicFirst(docs);
    const albums = albumsFromDocs(ranked);
    if (wantAlbums) results.albums = albums;
    if (wantArtists) results.artists = artistsFromDocs(ranked);
    if (wantTracks) results.tracks = await this.expandTracks(albums);
    return results;
  }

  async getTrack(uri: Uri): Promise<Track> {
    const { identifier, fileName } = splitTrackId(uri);
    const doc = await this.loadMetadata(identifier);
    const ordered = selectTracks(identifier, doc, this.ctx.quality());
    const known = ordered.find((t) => t.uri === uri);
    if (known) return known;

    // The requested encoding may have lost the per-recording format election;
    // it is still a real, playable file, so serve it verbatim.
    const files = Array.isArray(doc.files) ? doc.files : [];
    const raw = files.find((f) => firstOf(f.name) === fileName && isAudioFile(f));
    if (!raw) {
      throw new ProviderError(
        'not_found',
        `archive.org item ${identifier} has no audio file named ${fileName}`,
        'archive',
      );
    }
    return trackFromFile(identifier, doc, raw, undefined);
  }

  async getAlbum(uri: Uri): Promise<Album> {
    return this.loadAlbum(parseUri(uri).id);
  }

  async getArtist(uri: Uri): Promise<Artist> {
    const name = decodeArtistId(parseUri(uri).id);
    const { docs } = await this.advancedSearch(
      creatorQuery(name), ARTIST_PROFILE_ROWS, 1, [DOWNLOADS_SORT],
    );
    if (!docs.length) {
      throw new ProviderError('not_found', `archive.org has no items by ${name}`, 'archive');
    }

    const genres: string[] = [];
    let artwork: Artwork | undefined;
    for (const doc of docs) {
      const identifier = firstOf(doc.identifier);
      if (!artwork && identifier) artwork = artworkFor(identifier);
      for (const genre of listOf(doc.subject)) {
        if (genres.length >= GENRE_LIMIT) break;
        if (!genres.includes(genre)) genres.push(genre);
      }
    }

    return { uri, provider: 'archive', name, artwork, genres };
  }

  async getArtistAlbums(uri: Uri, cursor?: string): Promise<Page<Album>> {
    const name = decodeArtistId(parseUri(uri).id);
    const page = parsePage(cursor);
    const { docs, total } = await this.advancedSearch(
      creatorQuery(name), ARTIST_ALBUM_ROWS, page, [YEAR_SORT, DOWNLOADS_SORT],
    );
    const items = albumsFromDocs(docs);
    const consumed = page * ARTIST_ALBUM_ROWS;
    const exhausted = docs.length < ARTIST_ALBUM_ROWS
      || (total !== undefined && consumed >= total);
    return { items, cursor: exhausted ? undefined : String(page + 1), total };
  }

  async getArtistTopTracks(uri: Uri): Promise<Track[]> {
    const name = decodeArtistId(parseUri(uri).id);
    const { docs } = await this.advancedSearch(
      creatorQuery(name), TOP_TRACK_ITEMS, 1, [DOWNLOADS_SORT],
    );
    const identifiers: string[] = [];
    for (const doc of docs) {
      const identifier = firstOf(doc.identifier);
      if (identifier && !identifiers.includes(identifier)) identifiers.push(identifier);
    }

    const settled = await Promise.allSettled(identifiers.map((id) => this.loadAlbum(id)));
    const out: Track[] = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      const tracks = result.value.tracks ?? [];
      for (const track of tracks.slice(0, TOP_TRACK_PER_ITEM)) {
        out.push(track);
        if (out.length >= TOP_TRACK_CAP) return out;
      }
    }
    return out;
  }

  async getPlaylist(_uri: Uri): Promise<Playlist> {
    throw ProviderError.unsupported('archive', 'getPlaylist');
  }

  async getStream(track: Track): Promise<StreamRef> {
    const fromMeta = metaString(track.meta, 'streamUrl');
    const format = metaString(track.meta, 'format');
    if (fromMeta) {
      return {
        url: fromMeta,
        kind: 'progressive',
        mimeType: (format ? FORMAT_MIME[format] : undefined) ?? mimeFromExtension(fromMeta),
      };
    }

    // Archive download URLs are deterministic, so a bare Uri is enough — no
    // round trip needed just to start playback.
    const { identifier, fileName } = splitTrackId(track.uri);
    return {
      url: downloadUrl(identifier, fileName),
      kind: 'progressive',
      mimeType: mimeFromExtension(fileName),
    };
  }

  async getShelves(): Promise<Shelf[]> {
    const settled = await Promise.allSettled(
      SHELF_SPECS.map((spec) =>
        this.advancedSearch(spec.query, SHELF_ROWS, 1, [DOWNLOADS_SORT], SHELF_TTL_SEC)),
    );

    const shelves: Shelf[] = [];
    for (let i = 0; i < SHELF_SPECS.length; i++) {
      const spec = SHELF_SPECS[i];
      const result = settled[i];
      if (!spec || !result || result.status !== 'fulfilled') continue;
      const items: ShelfItem[] = albumsFromDocs(result.value.docs)
        .map((album) => ({ type: 'album' as const, album }));
      if (items.length) {
        shelves.push({
          id: spec.id,
          titleKey: spec.titleKey,
          title: spec.title,
          subtitleKey: spec.subtitleKey,
          subtitle: spec.subtitle,
          items,
        });
      }
    }
    return shelves;
  }

  private async expandTracks(albums: Album[]): Promise<Track[]> {
    const heads = albums.slice(0, TRACK_EXPANSION_ITEMS);
    if (!heads.length) return [];
    const settled = await Promise.allSettled(heads.map((album) => this.getAlbum(album.uri)));
    const out: Track[] = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const track of result.value.tracks ?? []) {
        out.push(track);
        if (out.length >= TRACK_EXPANSION_CAP) return out;
      }
    }
    return out;
  }

  private async loadAlbum(identifier: string): Promise<Album> {
    const doc = await this.loadMetadata(identifier);
    const md = doc.metadata;
    if (!md) {
      throw new ProviderError('not_found', `archive.org item ${identifier} not found`, 'archive');
    }
    const tracks = selectTracks(identifier, doc, this.ctx.quality());
    const creator = firstOf(md.creator);
    return {
      uri: makeUri('archive', 'album', identifier),
      provider: 'archive',
      name: firstOf(md.title) ?? identifier,
      artists: creator ? [artistRef(creator)] : [],
      artwork: artworkFor(identifier),
      releaseDate: firstOf(md.date) ?? firstOf(md.year),
      albumType: albumTypeOf(listOf(md.collection)),
      totalTracks: tracks.length,
      genres: listOf(md.subject).slice(0, GENRE_LIMIT),
      tracks,
    };
  }

  private async loadMetadata(identifier: string): Promise<ArchiveMetadata> {
    if (!identifier) {
      throw new ProviderError('not_found', 'empty archive.org identifier', 'archive');
    }
    const body = await this.get<ArchiveMetadata>(
      `${METADATA_BASE}/${encodeURIComponent(identifier)}`,
      METADATA_TTL_SEC,
    );
    if (typeof body !== 'object' || body === null) {
      throw new ProviderError(
        'parse', `archive.org metadata for ${identifier} was not an object`, 'archive',
      );
    }
    return body;
  }

  private async advancedSearch(
    query: string, rows: number, page: number, sorts: string[],
    cacheTtlSec: number = SEARCH_TTL_SEC,
  ): Promise<SearchPage> {
    const body = await this.get<ArchiveSearchResponse>(
      buildSearchUrl(query, rows, page, sorts),
      cacheTtlSec,
    );
    const docs = body.response?.docs;
    if (!Array.isArray(docs)) {
      throw new ProviderError('parse', 'archive.org search response had no docs array', 'archive');
    }
    const total = body.response?.numFound;
    return { docs, total: typeof total === 'number' && total >= 0 ? total : undefined };
  }

  private async get<T>(url: string, cacheTtlSec: number): Promise<T> {
    if (this.ctx.offline()) {
      throw new ProviderError('offline', 'Internet Archive requires a network connection', 'archive');
    }
    try {
      return await this.ctx.host.http.json<T>({ url, method: 'GET', cacheTtlSec });
    } catch (err) {
      throw wrapError(err, url);
    }
  }
}

function buildSearchUrl(query: string, rows: number, page: number, sorts: string[]): string {
  const params = new URLSearchParams();
  params.set('q', query);
  for (const field of SEARCH_FIELDS) params.append('fl[]', field);
  params.set('rows', String(rows));
  params.set('page', String(page));
  params.set('output', 'json');
  for (const sort of sorts) params.append('sort[]', sort);
  return `${SEARCH_BASE}?${params.toString()}`;
}

/**
 * Lucene reserves a fistful of punctuation; an unescaped `:` or `-` in a user
 * query turns a plain search into a malformed field expression and archive.org
 * answers with a 400.
 */
function escapeLucene(input: string): string {
  return input
    .replace(/&&/g, '\\&\\&')
    .replace(/\|\|/g, '\\|\\|')
    .replace(/([+\-!(){}[\]^"~*?:\\/])/g, '\\$1')
    .trim();
}

/**
 * `mediatype:audio` on archive.org is far broader than music: audiobooks,
 * sermons, lectures, news and personal voice memos all live there. A search for
 * an obscure name would happily return twenty minutes of someone talking.
 *
 * Two filters together, because neither works alone: the collections below are
 * unambiguously spoken word and are excluded outright, while community uploads
 * (`opensource_audio`) hold both real music and untagged talk, so they are kept
 * but ranked under anything from a curated music collection.
 */
const SPOKEN_COLLECTIONS = [
  'audio_bookspoetry',
  'librivox',
  'audio_religion',
  'audio_news',
  'audio_podcast',
  'radioprograms',
  'audio_tech',
  'oralhistory',
  'audio_courses',
  'samples_only',
] as const;

const MUSIC_COLLECTIONS = new Set(['audio_music', 'etree', '78rpm']);

const AUDIO_SCOPE =
  `mediatype:(audio) AND NOT collection:(${SPOKEN_COLLECTIONS.join(' OR ')})`;

/** Curated music first; community uploads keep their relative order after it. */
function musicFirst(docs: ArchiveSearchDoc[]): ArchiveSearchDoc[] {
  const scored = docs.map((doc, index) => ({
    doc,
    index,
    curated: listOf(doc.collection).some((c) => MUSIC_COLLECTIONS.has(c)) ? 0 : 1,
  }));
  scored.sort((a, b) => a.curated - b.curated || a.index - b.index);
  return scored.map((s) => s.doc);
}

function creatorQuery(name: string): string {
  const quoted = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${AUDIO_SCOPE} AND creator:"${quoted}"`;
}

function albumsFromDocs(docs: ArchiveSearchDoc[]): Album[] {
  const out: Album[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const album = albumFromDoc(doc);
    if (!album || seen.has(album.uri)) continue;
    seen.add(album.uri);
    out.push(album);
  }
  return out;
}

function albumFromDoc(doc: ArchiveSearchDoc): Album | undefined {
  const identifier = firstOf(doc.identifier);
  if (!identifier) return undefined;
  const creator = firstOf(doc.creator);
  return {
    uri: makeUri('archive', 'album', identifier),
    provider: 'archive',
    name: firstOf(doc.title) ?? identifier,
    artists: creator ? [artistRef(creator)] : [],
    artwork: artworkFor(identifier),
    releaseDate: firstOf(doc.year),
    albumType: albumTypeOf(listOf(doc.collection)),
    genres: listOf(doc.subject).slice(0, GENRE_LIMIT),
  };
}

function artistsFromDocs(docs: ArchiveSearchDoc[]): Artist[] {
  const out: Artist[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const creator = firstOf(doc.creator);
    if (!creator) continue;
    const ref = artistRef(creator);
    if (seen.has(ref.uri)) continue;
    seen.add(ref.uri);
    const identifier = firstOf(doc.identifier);
    out.push({
      uri: ref.uri,
      provider: 'archive',
      name: ref.name,
      artwork: identifier ? artworkFor(identifier) : undefined,
      genres: listOf(doc.subject).slice(0, GENRE_LIMIT),
    });
  }
  return out;
}

function artistRef(name: string): ArtistRef {
  return { uri: makeUri('archive', 'artist', encodeURIComponent(name)), name };
}

function decodeArtistId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function albumTypeOf(collections: string[]): string {
  const lower = collections.map((c) => c.toLowerCase());
  if (lower.includes('etree')) return 'live';
  if (lower.includes('78rpm') || lower.includes('georgeblood')) return 'single';
  if (lower.includes('opensource_audio')) return 'compilation';
  return 'album';
}

/** Single-size endpoint: archive.org derives one thumbnail per item. */
function artworkFor(identifier: string): Artwork {
  return { sources: [{ url: `${IMG_BASE}/${encodeURIComponent(identifier)}`, size: 512 }] };
}

function downloadUrl(identifier: string, fileName: string): string {
  return `${DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${encodePath(fileName)}`;
}

function encodePath(fileName: string): string {
  return fileName.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function splitTrackId(uri: Uri): { identifier: string; fileName: string } {
  const { id } = parseUri(uri);
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    throw new ProviderError('not_found', `malformed archive track uri: ${uri}`, 'archive');
  }
  return { identifier: id.slice(0, slash), fileName: id.slice(slash + 1) };
}

function selectTracks(identifier: string, doc: ArchiveMetadata, quality: Quality): Track[] {
  const files = Array.isArray(doc.files) ? doc.files : [];
  const groups = new Map<string, ArchiveFile[]>();
  for (const file of files) {
    if (!isAudioFile(file)) continue;
    const key = recordingKey(file);
    const bucket = groups.get(key);
    if (bucket) bucket.push(file);
    else groups.set(key, [file]);
  }

  const preference = quality === 'lossless' ? LOSSLESS_PREFERENCE : LOSSY_PREFERENCE;
  const chosen: ArchiveFile[] = [];
  for (const bucket of groups.values()) {
    let best = bucket[0];
    if (!best) continue;
    let bestRank = formatRank(best, preference);
    for (let i = 1; i < bucket.length; i++) {
      const candidate = bucket[i];
      if (!candidate) continue;
      const rank = formatRank(candidate, preference);
      if (rank < bestRank) {
        best = candidate;
        bestRank = rank;
      }
    }
    chosen.push(best);
  }

  chosen.sort(compareFiles);
  return chosen.map((file, index) => trackFromFile(identifier, doc, file, index + 1));
}

function isAudioFile(file: ArchiveFile): boolean {
  const name = firstOf(file.name);
  const format = firstOf(file.format);
  return !!name && !!format && AUDIO_FORMATS.has(format);
}

/**
 * Derivatives point at their master through `original`, so collapsing on that
 * (falling back to the extension-less name) folds the MP3/Ogg/Flac copies of
 * one recording into a single group.
 */
function recordingKey(file: ArchiveFile): string {
  const base = firstOf(file.original) ?? firstOf(file.name) ?? '';
  return stripExtension(base).toLowerCase();
}

function formatRank(file: ArchiveFile, preference: string[]): number {
  const format = firstOf(file.format);
  if (!format) return preference.length;
  const index = preference.indexOf(format);
  return index < 0 ? preference.length : index;
}

function compareFiles(a: ArchiveFile, b: ArchiveFile): number {
  const na = parseTrackNumber(a.track);
  const nb = parseTrackNumber(b.track);
  if (na !== undefined && nb !== undefined && na !== nb) return na - nb;
  if (na !== undefined && nb === undefined) return -1;
  if (na === undefined && nb !== undefined) return 1;
  return naturalCompare(firstOf(a.name) ?? '', firstOf(b.name) ?? '');
}

function trackFromFile(
  identifier: string,
  doc: ArchiveMetadata,
  file: ArchiveFile,
  fallbackNumber: number | undefined,
): Track {
  const md = doc.metadata ?? {};
  const name = firstOf(file.name) ?? '';
  const artwork = artworkFor(identifier);
  const albumUri = makeUri('archive', 'album', identifier);
  const albumName = firstOf(file.album) ?? firstOf(md.title) ?? identifier;
  const creator = firstOf(file.artist) ?? firstOf(file.creator) ?? firstOf(md.creator);
  const format = firstOf(file.format);
  const url = downloadUrl(identifier, name);

  return {
    uri: makeUri('archive', 'track', `${identifier}/${name}`),
    provider: 'archive',
    title: firstOf(file.title) ?? titleFromFileName(name),
    artists: creator ? [artistRef(creator)] : [],
    album: { uri: albumUri, name: albumName, artwork },
    durationMs: parseLengthMs(file.length),
    trackNumber: parseTrackNumber(file.track) ?? fallbackNumber,
    releaseDate: firstOf(md.date) ?? firstOf(md.year),
    genres: listOf(md.subject).slice(0, GENRE_LIMIT),
    artwork,
    meta: {
      identifier,
      fileName: name,
      format,
      streamUrl: url,
      size: firstOf(file.size),
    },
  };
}

function titleFromFileName(name: string): string {
  const base = stripExtension(name.slice(name.lastIndexOf('/') + 1));
  const cleaned = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || name || 'Unknown recording';
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  const slash = name.lastIndexOf('/');
  return dot > slash + 1 ? name.slice(0, dot) : name;
}

/** Archive writes the position as either `"3"` or `"3/12"`. */
function parseTrackNumber(value: MaybeMulti): number | undefined {
  const raw = firstOf(value);
  if (!raw) return undefined;
  const match = /^(\d{1,4})/.exec(raw.replace(/^[^\d]*/, ''));
  if (!match || !match[1]) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `length` arrives as `"MM:SS"`, `"HH:MM:SS"` or bare seconds like `"123.45"`. */
function parseLengthMs(value: MaybeMulti): number {
  const raw = firstOf(value);
  if (!raw) return 0;
  if (raw.includes(':')) {
    const parts = raw.split(':');
    let seconds = 0;
    for (const part of parts) {
      const n = Number.parseFloat(part);
      if (!Number.isFinite(n)) return 0;
      seconds = seconds * 60 + n;
    }
    return seconds > 0 ? Math.round(seconds * 1000) : 0;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

function mimeFromExtension(pathOrUrl: string): string | undefined {
  const withoutQuery = pathOrUrl.split('?')[0] ?? pathOrUrl;
  const dot = withoutQuery.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSION_MIME[withoutQuery.slice(dot + 1).toLowerCase()];
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function firstOf(value: MaybeMulti): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item).trim();
      if (text) return text;
    }
    return undefined;
  }
  const text = String(value).trim();
  return text ? text : undefined;
}

function listOf(value: MaybeMulti): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    for (const part of String(item).split(';')) {
      const text = part.trim();
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!meta) return undefined;
  const value = meta[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function clampRows(limit: number): number {
  if (!Number.isFinite(limit)) return 24;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function pageFromOffset(offset: number | undefined, rows: number): number {
  if (offset === undefined || !Number.isFinite(offset) || offset <= 0) return 1;
  return Math.floor(offset / rows) + 1;
}

function parsePage(cursor: string | undefined): number {
  if (!cursor) return 1;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function wrapError(err: unknown, context: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const status = statusFrom(message);
  if (status === 404 || status === 410) {
    return new ProviderError('not_found', `${context}: ${message}`, 'archive', err);
  }
  if (status === 429) {
    return new ProviderError('rate_limited', `${context}: ${message}`, 'archive', err);
  }
  if (status === 400 || status === 422) {
    return new ProviderError('parse', `${context}: ${message}`, 'archive', err);
  }
  return new ProviderError('network', `${context}: ${message}`, 'archive', err);
}

function statusFrom(message: string): number | undefined {
  const match = /\b([1-5]\d{2})\b/.exec(message);
  if (!match || !match[1]) return undefined;
  return Number.parseInt(match[1], 10);
}
