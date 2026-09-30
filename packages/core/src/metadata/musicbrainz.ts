/**
 * MusicBrainz lookups + Wikidata/Wikipedia artist biographies.
 *
 * Every request carries a long `cacheTtlSec`: MusicBrainz allows one request per
 * second per client and the Rust HTTP layer enforces that by queueing, so a cache
 * miss is not just slow for this caller — it delays every other MB request behind
 * it. Enrichment data is effectively immutable, so a week of caching is free.
 */

import type { HostBridge } from '../host/types';

const MB_WS = 'https://musicbrainz.org/ws/2';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

/** MusicBrainz requires a contact-bearing UA and rejects generic ones. */
const USER_AGENT = 'Ritmo/0.1.0 ( https://github.com/codeyevsky/ritmo )';

const WEEK_SEC = 604800;

/** Below this the candidate is discarded: a wrong match poisons the library. */
const MIN_CONFIDENCE = 0.6;

/** A duration this close counts as the same recording. */
const DURATION_TOLERANCE_MS = 5000;

export interface MbRecording {
  mbid: string;
  title: string;
  artistCredit: string;
  releaseMbid?: string;
  releaseGroupMbid?: string;
  length?: number;
  isrcs: string[];
}

export interface MbArtist {
  mbid: string;
  name: string;
  country?: string;
  type?: string;
  beginDate?: string;
  endDate?: string;
  tags: string[];
  urls: Array<{ type: string; url: string }>;
}

/** Release-group detail, used to fill in a release date and genres. */
export interface MbReleaseGroup {
  mbid: string;
  title: string;
  firstReleaseDate?: string;
  primaryType?: string;
  genres: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMbid(value: string): boolean {
  return UUID_RE.test(value);
}

async function getJson(host: HostBridge, url: string, ttlSec: number): Promise<unknown> {
  const res = await host.http.request({
    url,
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    cacheTtlSec: ttlSec,
    timeoutMs: 15000,
  });
  if (res.status < 200 || res.status >= 300) return undefined;
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    return undefined;
  }
}

/** Lucene needs these neutralised or a stray quote turns the query into a syntax error. */
function escapeLucene(text: string): string {
  return text.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[([](?:feat|ft|featuring|with|prod)\b[^)\]]*[)\]]/g, ' ')
    .replace(/\b(?:remaster(?:ed)?|remastered version|official (?:audio|video)|lyrics?|hd|hq)\b/g, ' ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/** 0..1 similarity of two already-normalised strings. */
function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  const edit = 1 - levenshtein(a, b) / longest;
  // Containment rescues "Song" vs "Song - Radio Edit", which edit distance punishes hard.
  const contains = a.includes(b) || b.includes(a)
    ? Math.min(a.length, b.length) / longest
    : 0;
  return Math.max(edit, contains * 0.95);
}

function artistCreditOf(value: unknown): string {
  const credits = asArray(value);
  let out = '';
  for (const entry of credits) {
    if (!isRecord(entry)) continue;
    const artist = isRecord(entry['artist']) ? entry['artist'] : undefined;
    const name = asString(entry['name']) ?? (artist ? asString(artist['name']) : undefined);
    if (!name) continue;
    out += name + (asString(entry['joinphrase']) ?? '');
  }
  return out.trim();
}

interface ScoredCandidate {
  recording: MbRecording;
  confidence: number;
}

function scoreRecording(
  candidate: Record<string, unknown>,
  want: { title: string; artist: string; album?: string; durationMs?: number },
): ScoredCandidate | undefined {
  const mbid = asString(candidate['id']);
  const title = asString(candidate['title']);
  if (!mbid || !title) return undefined;

  const credit = artistCreditOf(candidate['artist-credit']);
  const titleScore = similarity(normalizeName(title), normalizeName(want.title));
  const artistScore = credit.length > 0
    ? similarity(normalizeName(credit), normalizeName(want.artist))
    : 0;

  const length = asNumber(candidate['length']);
  let durationScore = 0.5; // neutral when either side is unknown
  if (want.durationMs !== undefined && want.durationMs > 0 && length !== undefined) {
    const delta = Math.abs(length - want.durationMs);
    durationScore = delta <= DURATION_TOLERANCE_MS
      ? 1
      : Math.max(0, 1 - (delta - DURATION_TOLERANCE_MS) / 30000);
  }

  let releaseMbid: string | undefined;
  let releaseGroupMbid: string | undefined;
  let albumScore = 0;
  let bestAlbum = -1;
  for (const raw of asArray(candidate['releases'])) {
    if (!isRecord(raw)) continue;
    const id = asString(raw['id']);
    const name = asString(raw['title']);
    const group = isRecord(raw['release-group']) ? asString(raw['release-group']['id']) : undefined;
    const score = want.album && name
      ? similarity(normalizeName(name), normalizeName(want.album))
      : 0;
    if (score > bestAlbum) {
      bestAlbum = score;
      albumScore = score;
      releaseMbid = id;
      releaseGroupMbid = group;
    }
    if (releaseMbid === undefined && id !== undefined) releaseMbid = id;
    if (releaseGroupMbid === undefined && group !== undefined) releaseGroupMbid = group;
  }

  // Title and artist dominate; duration breaks ties between covers and originals.
  let confidence = titleScore * 0.45 + artistScore * 0.3 + durationScore * 0.25;
  if (want.album !== undefined && albumScore > 0.8) confidence = Math.min(1, confidence + 0.05);

  const isrcs = asArray(candidate['isrcs'])
    .map((v) => asString(v))
    .filter((v): v is string => v !== undefined);

  return {
    recording: { mbid, title, artistCredit: credit, releaseMbid, releaseGroupMbid, length, isrcs },
    confidence,
  };
}

/**
 * Best-effort recording match. Resolves `undefined` rather than throwing, and
 * rather than returning a low-confidence guess.
 */
export async function lookupRecording(
  host: HostBridge,
  opts: { title: string; artist: string; album?: string; durationMs?: number },
): Promise<MbRecording | undefined> {
  const title = escapeLucene(opts.title);
  const artist = escapeLucene(opts.artist);
  if (title.length === 0) return undefined;

  const terms = [`recording:"${title}"`];
  if (artist.length > 0) terms.push(`artist:"${artist}"`);
  const album = opts.album ? escapeLucene(opts.album) : '';
  if (album.length > 0) terms.push(`release:"${album}"`);

  const url = `${MB_WS}/recording?query=${encodeURIComponent(terms.join(' AND '))}&fmt=json&limit=5`;
  let payload: unknown;
  try {
    payload = await getJson(host, url, WEEK_SEC);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  let best: ScoredCandidate | undefined;
  for (const raw of asArray(payload['recordings'])) {
    if (!isRecord(raw)) continue;
    const scored = scoreRecording(raw, opts);
    if (scored && (best === undefined || scored.confidence > best.confidence)) best = scored;
  }
  if (!best || best.confidence < MIN_CONFIDENCE) return undefined;

  // The search index omits ISRCs and often the release group, so top the match up.
  const detailed = await lookupRecordingById(host, best.recording.mbid);
  if (!detailed) return best.recording;
  return {
    ...detailed,
    releaseMbid: detailed.releaseMbid ?? best.recording.releaseMbid,
    releaseGroupMbid: detailed.releaseGroupMbid ?? best.recording.releaseGroupMbid,
    length: detailed.length ?? best.recording.length,
    artistCredit: detailed.artistCredit.length > 0 ? detailed.artistCredit : best.recording.artistCredit,
  };
}

/** Direct recording lookup by MBID, with releases, release groups and ISRCs. */
export async function lookupRecordingById(
  host: HostBridge,
  mbid: string,
): Promise<MbRecording | undefined> {
  if (!isMbid(mbid)) return undefined;
  const url = `${MB_WS}/recording/${mbid}?inc=artist-credits+releases+release-groups+isrcs&fmt=json`;
  let payload: unknown;
  try {
    payload = await getJson(host, url, WEEK_SEC);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  const title = asString(payload['title']);
  if (!title) return undefined;

  let releaseMbid: string | undefined;
  let releaseGroupMbid: string | undefined;
  for (const raw of asArray(payload['releases'])) {
    if (!isRecord(raw)) continue;
    releaseMbid = releaseMbid ?? asString(raw['id']);
    const group = isRecord(raw['release-group']) ? asString(raw['release-group']['id']) : undefined;
    releaseGroupMbid = releaseGroupMbid ?? group;
    if (releaseMbid !== undefined && releaseGroupMbid !== undefined) break;
  }

  return {
    mbid,
    title,
    artistCredit: artistCreditOf(payload['artist-credit']),
    releaseMbid,
    releaseGroupMbid,
    length: asNumber(payload['length']),
    isrcs: asArray(payload['isrcs'])
      .map((v) => asString(v))
      .filter((v): v is string => v !== undefined),
  };
}

export async function lookupReleaseGroup(
  host: HostBridge,
  mbid: string,
): Promise<MbReleaseGroup | undefined> {
  if (!isMbid(mbid)) return undefined;
  let payload: unknown;
  try {
    payload = await getJson(host, `${MB_WS}/release-group/${mbid}?inc=genres+tags&fmt=json`, WEEK_SEC);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  const title = asString(payload['title']);
  if (!title) return undefined;

  const genres = rankedNames(payload['genres']);
  const tags = genres.length > 0 ? genres : rankedNames(payload['tags']);

  return {
    mbid,
    title,
    firstReleaseDate: asString(payload['first-release-date']),
    primaryType: asString(payload['primary-type']),
    genres: tags,
  };
}

/** MB tag/genre lists carry vote counts; order by them and drop the noise. */
function rankedNames(value: unknown): string[] {
  const entries: Array<{ name: string; count: number }> = [];
  for (const raw of asArray(value)) {
    if (!isRecord(raw)) continue;
    const name = asString(raw['name']);
    if (!name) continue;
    entries.push({ name, count: asNumber(raw['count']) ?? 0 });
  }
  entries.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return entries.map((e) => e.name);
}

export async function lookupArtist(host: HostBridge, name: string): Promise<MbArtist | undefined> {
  const escaped = escapeLucene(name);
  if (escaped.length === 0) return undefined;

  const searchUrl = `${MB_WS}/artist?query=${encodeURIComponent(`artist:"${escaped}"`)}&fmt=json&limit=5`;
  let payload: unknown;
  try {
    payload = await getJson(host, searchUrl, WEEK_SEC);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  const wanted = normalizeName(name);
  let bestId: string | undefined;
  let bestScore = 0;
  for (const raw of asArray(payload['artists'])) {
    if (!isRecord(raw)) continue;
    const id = asString(raw['id']);
    const candidateName = asString(raw['name']);
    if (!id || !candidateName) continue;
    const nameScore = similarity(normalizeName(candidateName), wanted);
    const aliasScore = bestAliasScore(raw['aliases'], wanted);
    // MB's own relevance score is a useful tiebreaker but a poor primary signal.
    const relevance = (asNumber(raw['score']) ?? 0) / 100;
    const score = Math.max(nameScore, aliasScore) * 0.85 + relevance * 0.15;
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  if (bestId === undefined || bestScore < MIN_CONFIDENCE) return undefined;

  let detail: unknown;
  try {
    detail = await getJson(host, `${MB_WS}/artist/${bestId}?inc=url-rels+tags&fmt=json`, WEEK_SEC);
  } catch {
    return undefined;
  }
  if (!isRecord(detail)) return undefined;

  const resolvedName = asString(detail['name']);
  if (!resolvedName) return undefined;

  const lifeSpan = isRecord(detail['life-span']) ? detail['life-span'] : undefined;
  const urls: Array<{ type: string; url: string }> = [];
  for (const raw of asArray(detail['relations'])) {
    if (!isRecord(raw)) continue;
    const type = asString(raw['type']);
    const target = isRecord(raw['url']) ? asString(raw['url']['resource']) : undefined;
    if (type && target) urls.push({ type, url: target });
  }

  return {
    mbid: bestId,
    name: resolvedName,
    country: asString(detail['country']),
    type: asString(detail['type']),
    beginDate: lifeSpan ? asString(lifeSpan['begin']) : undefined,
    endDate: lifeSpan ? asString(lifeSpan['end']) : undefined,
    tags: rankedNames(detail['tags']),
    urls,
  };
}

function bestAliasScore(value: unknown, wanted: string): number {
  let best = 0;
  for (const raw of asArray(value)) {
    if (!isRecord(raw)) continue;
    const alias = asString(raw['name']) ?? asString(raw['sort-name']);
    if (!alias) continue;
    best = Math.max(best, similarity(normalizeName(alias), wanted));
  }
  return best;
}

function wikidataIdFrom(urls: Array<{ type: string; url: string }>): string | undefined {
  for (const rel of urls) {
    if (rel.type !== 'wikidata') continue;
    const match = /\/(Q\d+)(?:[/?#]|$)/.exec(rel.url);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** `https://tr.wikipedia.org/wiki/Sezen_Aksu` → `{ lang: 'tr', title: 'Sezen_Aksu' }`. */
function wikipediaRelation(
  urls: Array<{ type: string; url: string }>,
): { lang: string; title: string } | undefined {
  for (const rel of urls) {
    if (rel.type !== 'wikipedia') continue;
    const match = /^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/.exec(rel.url);
    const lang = match?.[1];
    const title = match?.[2];
    if (lang && title) return { lang, title: decodeURIComponent(title) };
  }
  return undefined;
}

async function wikidataSitelink(
  host: HostBridge,
  entity: string,
  wikis: string[],
): Promise<{ lang: string; title: string } | undefined> {
  const url =
    `${WIKIDATA_API}?action=wbgetentities&format=json&formatversion=2` +
    `&props=sitelinks&ids=${encodeURIComponent(entity)}&sitefilter=${encodeURIComponent(wikis.join('|'))}`;
  let payload: unknown;
  try {
    payload = await getJson(host, url, WEEK_SEC);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  const entities = isRecord(payload['entities']) ? payload['entities'] : undefined;
  const found = entities && isRecord(entities[entity]) ? entities[entity] : undefined;
  const sitelinks = found && isRecord(found['sitelinks']) ? found['sitelinks'] : undefined;
  if (!sitelinks) return undefined;

  for (const wiki of wikis) {
    const link = isRecord(sitelinks[wiki]) ? sitelinks[wiki] : undefined;
    const title = link ? asString(link['title']) : undefined;
    if (title) return { lang: wiki.replace(/wiki$/, ''), title };
  }
  return undefined;
}

async function wikipediaExtract(
  host: HostBridge,
  lang: string,
  title: string,
): Promise<string | undefined> {
  const slug = encodeURIComponent(title.replace(/ /g, '_'));
  let payload: unknown;
  try {
    payload = await getJson(host, `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slug}`, WEEK_SEC);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  const extract = asString(payload['extract']);
  return extract !== undefined && extract.trim().length > 0 ? extract.trim() : undefined;
}

/**
 * Lead section of the artist's Wikipedia article, reached through the Wikidata
 * entity MusicBrainz links to (the `wikipedia` relation itself is deprecated
 * upstream and frequently absent, so it is only a fallback here).
 */
export async function fetchArtistBio(
  host: HostBridge,
  artist: MbArtist,
  lang: 'tr' | 'en' = 'tr',
): Promise<string | undefined> {
  const order = lang === 'tr' ? ['trwiki', 'enwiki'] : ['enwiki', 'trwiki'];
  const entity = wikidataIdFrom(artist.urls);

  if (entity !== undefined) {
    const link = await wikidataSitelink(host, entity, order);
    if (link) {
      const extract = await wikipediaExtract(host, link.lang, link.title);
      if (extract !== undefined) return extract;
    }
  }

  const direct = wikipediaRelation(artist.urls);
  if (direct) return wikipediaExtract(host, direct.lang, direct.title);
  return undefined;
}
