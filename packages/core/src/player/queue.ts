import type { QueueItem, QueueSnapshot, RepeatMode, Track, Uri } from '../types';
import { Emitter } from '../util/emitter';
import { normalizeKey } from '../util/text';
import { mulberry32, seedFrom, shuffledSpaced } from './shuffle';

export type QueueEvent =
  | { type: 'changed'; snapshot: QueueSnapshot }
  | { type: 'exhausted' };

/**
 * Where an upcoming entry came from, which is what gives the three blocks of
 * `upcoming` their order: `next` (Play next) → `tail` (Add to queue) → `context`.
 * `QueueItem.userQueued` collapses the first two for the UI; the queue itself
 * needs to tell them apart so "Play next" can land ahead of the tail.
 */
type Origin = 'next' | 'tail' | 'context';

interface Entry {
  item: QueueItem;
  origin: Origin;
}

const HISTORY_LIMIT = 200;
const SHUFFLE_GAP = 3;
const SERIAL_VERSION = 1;

interface SerialEntry {
  id: string;
  track: Track;
  userQueued: boolean;
  contextUri?: Uri;
  origin: Origin;
}

/** Wire shape of {@link QueueEngine.serialize}. */
export interface SerializedQueue {
  v: number;
  counter: number;
  seed: number;
  shuffle: boolean;
  repeat: RepeatMode;
  contextUri?: Uri;
  contextName?: string;
  lastContextId?: string;
  /** Entry pool, deduplicated by id; the arrays below hold ids only. */
  entries: SerialEntry[];
  history: string[];
  current?: string;
  upcoming: string[];
  contextOrder: string[];
}

export interface QueueEngineOptions {
  /** Fixed PRNG seed, for reproducible shuffles in tests. */
  seed?: number;
}

/**
 * Owns all ordering. The engine below it plays exactly one track and knows
 * nothing about what comes next.
 *
 * The pristine context order is kept in `contextTemplate` for the whole pass,
 * so toggling shuffle off restores the real album order instead of an
 * approximation, and `repeat: 'all'` can start a genuinely new pass.
 */
export class QueueEngine {
  readonly events = new Emitter<QueueEvent>();

  private counter = 0;
  private seed: number;
  private historyEntries: Entry[] = [];
  private currentEntry: Entry | undefined;
  private upcomingEntries: Entry[] = [];
  private contextTemplate: Entry[] = [];
  private contextUri: Uri | undefined;
  private contextName: string | undefined;
  /** Last context entry that was current — the anchor for un-shuffling. */
  private lastContextId: string | undefined;
  private shuffleOn = false;
  private repeatMode: RepeatMode = 'off';

  constructor(opts?: QueueEngineOptions) {
    this.seed = opts?.seed !== undefined ? opts.seed >>> 0 : seedFrom(`ritmo:${Date.now()}`);
  }

  setContext(tracks: Track[], startIndex: number, context?: { uri?: Uri; name?: string }): void {
    this.historyEntries = [];
    this.upcomingEntries = [];
    this.currentEntry = undefined;
    this.lastContextId = undefined;
    this.contextUri = context?.uri;
    this.contextName = context?.name;
    this.contextTemplate = tracks.map((t) => this.mkEntry(t, 'context', context?.uri));

    if (this.contextTemplate.length > 0) {
      // `Math.trunc(NaN)` stays NaN and every comparison with it is false, so a
      // non-finite index would otherwise index past the array and leave a
      // non-empty context with nothing playing.
      const wanted = Math.trunc(startIndex);
      const idx = Number.isFinite(wanted)
        ? Math.min(Math.max(wanted, 0), this.contextTemplate.length - 1)
        : 0;
      this.setCurrent(this.contextTemplate[idx]);
      this.upcomingEntries = this.shuffleOn
        ? this.shuffleEntries(this.contextTemplate.filter((_, i) => i !== idx))
        : this.contextTemplate.slice(idx + 1);
    }

    this.changed();
  }

  /** Explicit "Play next" — inserts ahead of the context but behind earlier user-queued items. */
  addNext(tracks: Track[]): void {
    if (tracks.length === 0) return;
    const entries = tracks.map((t) => this.mkEntry(t, 'next'));
    let at = 0;
    while (at < this.upcomingEntries.length && this.upcomingEntries[at]?.origin === 'next') at++;
    this.upcomingEntries.splice(at, 0, ...entries);
    this.changed();
  }

  /** Explicit "Add to queue" — appends to the user-queued tail. */
  addToQueue(tracks: Track[]): void {
    if (tracks.length === 0) return;
    const entries = tracks.map((t) => this.mkEntry(t, 'tail'));
    let at = 0;
    while (at < this.upcomingEntries.length && this.upcomingEntries[at]?.origin !== 'context') at++;
    this.upcomingEntries.splice(at, 0, ...entries);
    this.changed();
  }

  /**
   * Extend the current context at its tail. Used by autoplay: the appended
   * tracks must behave like context (repeatable, shuffleable), not like
   * user-queued items that vanish once consumed.
   */
  appendContext(tracks: Track[]): void {
    if (tracks.length === 0) return;
    const entries = tracks.map((t) => this.mkEntry(t, 'context', this.contextUri));
    this.contextTemplate.push(...entries);
    this.upcomingEntries.push(...entries);
    this.changed();
  }

  remove(itemId: string): void {
    const i = this.upcomingEntries.findIndex((e) => e.item.id === itemId);
    if (i < 0) return;
    this.upcomingEntries.splice(i, 1);
    // Also drop it from the pristine order: un-shuffling or repeating must not
    // resurrect something the user explicitly removed.
    this.contextTemplate = this.contextTemplate.filter((e) => e.item.id !== itemId);
    this.changed();
  }

  /** Reorder within `upcoming` by item id; used by the drag-and-drop queue panel. */
  move(itemId: string, toIndex: number): void {
    const from = this.upcomingEntries.findIndex((e) => e.item.id === itemId);
    if (from < 0) return;
    const moved = this.upcomingEntries.splice(from, 1)[0];
    if (!moved) return;
    const to = Math.min(Math.max(Math.trunc(toIndex), 0), this.upcomingEntries.length);
    this.upcomingEntries.splice(to, 0, moved);
    this.changed();
  }

  clearUpcoming(): void {
    this.upcomingEntries = [];
    this.contextTemplate = this.currentEntry?.origin === 'context' ? [this.currentEntry] : [];
    this.changed();
  }

  clear(): void {
    this.historyEntries = [];
    this.upcomingEntries = [];
    this.contextTemplate = [];
    this.currentEntry = undefined;
    this.lastContextId = undefined;
    this.contextUri = undefined;
    this.contextName = undefined;
    this.changed();
  }

  current(): QueueItem | undefined {
    return this.currentEntry?.item;
  }

  peekNext(): QueueItem | undefined {
    if (this.repeatMode === 'one' && this.currentEntry) return this.currentEntry.item;
    const first = this.upcomingEntries[0];
    if (first) return first.item;
    if (this.repeatMode === 'all' && !this.shuffleOn) return this.contextTemplate[0]?.item;
    // A shuffled wrap is only decided at wrap time, so there is nothing honest
    // to report (and therefore nothing to preload).
    return undefined;
  }

  /** Advances. Returns undefined when the queue is exhausted (respecting repeat). */
  next(opts?: { userInitiated?: boolean }): QueueItem | undefined {
    const userInitiated = opts?.userInitiated === true;

    // Pressing Next must always move; only automatic advances honour repeat-one.
    if (this.repeatMode === 'one' && !userInitiated && this.currentEntry) {
      return this.currentEntry.item;
    }

    if (this.upcomingEntries.length === 0) {
      if (this.repeatMode === 'all' && this.contextTemplate.length > 0) {
        this.startNewContextPass();
      } else {
        this.events.emit({ type: 'exhausted' });
        return undefined;
      }
    }

    const nextEntry = this.upcomingEntries.shift();
    if (!nextEntry) {
      this.events.emit({ type: 'exhausted' });
      return undefined;
    }

    if (this.currentEntry) this.pushHistory(this.currentEntry);
    this.setCurrent(nextEntry);
    this.changed();
    return nextEntry.item;
  }

  /** Goes back in history; the caller decides whether to restart the current track instead. */
  previous(): QueueItem | undefined {
    const prev = this.historyEntries.pop();
    if (!prev) return undefined;
    if (this.currentEntry) this.upcomingEntries.unshift(this.currentEntry);
    this.setCurrent(prev);
    this.changed();
    return prev.item;
  }

  setShuffle(on: boolean): void {
    if (on === this.shuffleOn) return;
    this.shuffleOn = on;

    const userPart = this.upcomingEntries.filter((e) => e.origin !== 'context');
    if (on) {
      const ctx = this.upcomingEntries.filter((e) => e.origin === 'context');
      this.upcomingEntries = [...userPart, ...this.shuffleEntries(ctx)];
    } else {
      const anchor = this.lastContextId;
      const at = anchor === undefined
        ? -1
        : this.contextTemplate.findIndex((e) => e.item.id === anchor);
      const ctx = at >= 0 ? this.contextTemplate.slice(at + 1) : this.contextTemplate.slice();
      this.upcomingEntries = [...userPart, ...ctx];
      // Un-shuffling can pull back entries the shuffled pass already played;
      // they must not exist twice, or drag-and-drop ids stop being unique.
      this.dropHistoryDuplicates();
    }

    this.changed();
  }

  isShuffled(): boolean {
    return this.shuffleOn;
  }

  setRepeat(mode: RepeatMode): void {
    if (mode === this.repeatMode) return;
    this.repeatMode = mode;
    this.changed();
  }

  repeat(): RepeatMode {
    return this.repeatMode;
  }

  snapshot(): QueueSnapshot {
    return {
      history: this.historyEntries.map((e) => e.item),
      current: this.currentEntry?.item,
      upcoming: this.upcomingEntries.map((e) => e.item),
      contextUri: this.contextUri,
      contextName: this.contextName,
    };
  }

  /** Serialise/restore across restarts. */
  serialize(): string {
    const payload: SerializedQueue = {
      v: SERIAL_VERSION,
      counter: this.counter,
      seed: this.seed,
      shuffle: this.shuffleOn,
      repeat: this.repeatMode,
      contextUri: this.contextUri,
      contextName: this.contextName,
      lastContextId: this.lastContextId,
      entries: this.allEntries().map((e) => ({
        id: e.item.id,
        track: e.item.track,
        userQueued: e.item.userQueued,
        contextUri: e.item.contextUri,
        origin: e.origin,
      })),
      history: this.historyEntries.map((e) => e.item.id),
      current: this.currentEntry?.item.id,
      upcoming: this.upcomingEntries.map((e) => e.item.id),
      contextOrder: this.contextTemplate.map((e) => e.item.id),
    };
    return JSON.stringify(payload);
  }

  restore(json: string): void {
    const data = parseSerialized(json);
    const pool = new Map<string, Entry>();
    for (const se of data.entries) {
      pool.set(se.id, {
        item: {
          id: se.id,
          track: se.track,
          userQueued: se.userQueued,
          contextUri: se.contextUri,
        },
        origin: se.origin,
      });
    }
    const pick = (ids: string[]): Entry[] =>
      ids.map((id) => pool.get(id)).filter((e): e is Entry => e !== undefined);

    this.counter = Math.max(0, Math.trunc(data.counter));
    this.seed = data.seed >>> 0;
    this.shuffleOn = data.shuffle;
    this.repeatMode = data.repeat;
    this.contextUri = data.contextUri;
    this.contextName = data.contextName;
    this.historyEntries = pick(data.history);
    this.currentEntry = data.current !== undefined ? pool.get(data.current) : undefined;
    this.upcomingEntries = pick(data.upcoming);
    this.contextTemplate = pick(data.contextOrder);
    this.lastContextId = data.lastContextId !== undefined && pool.has(data.lastContextId)
      ? data.lastContextId
      : this.currentEntry?.origin === 'context'
        ? this.currentEntry.item.id
        : undefined;

    this.changed();
  }

  private mkEntry(track: Track, origin: Origin, contextUri?: Uri): Entry {
    // Monotonic, never random: ids have to be stable and collision-free across
    // a restore so the queue panel's drag handles keep pointing at the same row.
    const id = `q${++this.counter}`;
    return {
      item: { id, track, userQueued: origin !== 'context', contextUri },
      origin,
    };
  }

  private setCurrent(entry: Entry | undefined): void {
    this.currentEntry = entry;
    if (entry?.origin === 'context') this.lastContextId = entry.item.id;
  }

  private pushHistory(entry: Entry): void {
    this.historyEntries.push(entry);
    if (this.historyEntries.length > HISTORY_LIMIT) {
      this.historyEntries.splice(0, this.historyEntries.length - HISTORY_LIMIT);
    }
  }

  private dropHistoryDuplicates(): void {
    const live = new Set(this.upcomingEntries.map((e) => e.item.id));
    const curId = this.currentEntry?.item.id;
    if (curId !== undefined) live.add(curId);
    this.historyEntries = this.historyEntries.filter((e) => !live.has(e.item.id));
  }

  /**
   * A new pass over the same tracks with fresh instance ids, so the previous
   * pass can stay in `history` without two entries sharing an id.
   */
  private startNewContextPass(): void {
    const tracks = this.contextTemplate.map((e) => e.item.track);
    this.contextTemplate = tracks.map((t) => this.mkEntry(t, 'context', this.contextUri));
    this.lastContextId = undefined;
    this.upcomingEntries = this.shuffleOn
      ? this.shuffleEntries(this.contextTemplate)
      : this.contextTemplate.slice();
  }

  private shuffleEntries(entries: Entry[]): Entry[] {
    const rand = mulberry32(this.nextSeed());
    return shuffledSpaced(entries, entryKey, SHUFFLE_GAP, rand);
  }

  /** Advancing the seed per shuffle is what makes a repeat-all second pass differ. */
  private nextSeed(): number {
    this.seed = (this.seed + 0x9e3779b1) >>> 0;
    return this.seed;
  }

  private allEntries(): Entry[] {
    const seen = new Set<string>();
    const out: Entry[] = [];
    const add = (e: Entry): void => {
      if (seen.has(e.item.id)) return;
      seen.add(e.item.id);
      out.push(e);
    };
    for (const e of this.historyEntries) add(e);
    if (this.currentEntry) add(this.currentEntry);
    for (const e of this.upcomingEntries) add(e);
    for (const e of this.contextTemplate) add(e);
    return out;
  }

  private changed(): void {
    this.events.emit({ type: 'changed', snapshot: this.snapshot() });
  }
}

/** Spacing key: keep the same artist from clumping up in a shuffled context. */
function entryKey(entry: Entry): string {
  const track = entry.item.track;
  const primary = track.artists[0];
  return normalizeKey(primary ? primary.uri : track.uri);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isRepeatMode(v: unknown): v is RepeatMode {
  return v === 'off' || v === 'all' || v === 'one';
}

function isOrigin(v: unknown): v is Origin {
  return v === 'next' || v === 'tail' || v === 'context';
}

function asTrack(v: unknown): Track | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.uri !== 'string' || typeof v.title !== 'string') return undefined;
  if (!Array.isArray(v.artists) || typeof v.durationMs !== 'number') return undefined;
  return v as unknown as Track;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function parseSerialized(json: string): SerializedQueue {
  const raw: unknown = JSON.parse(json);
  if (!isRecord(raw)) throw new Error('queue restore: not an object');
  if (raw.v !== SERIAL_VERSION) throw new Error(`queue restore: unsupported version ${String(raw.v)}`);
  if (typeof raw.counter !== 'number' || typeof raw.seed !== 'number') {
    throw new Error('queue restore: missing counter/seed');
  }
  if (typeof raw.shuffle !== 'boolean' || !isRepeatMode(raw.repeat)) {
    throw new Error('queue restore: bad shuffle/repeat');
  }
  if (!Array.isArray(raw.entries) || !isStringArray(raw.history) ||
      !isStringArray(raw.upcoming) || !isStringArray(raw.contextOrder)) {
    throw new Error('queue restore: bad entry lists');
  }

  const entries: SerialEntry[] = [];
  for (const candidate of raw.entries) {
    if (!isRecord(candidate)) continue;
    const track = asTrack(candidate.track);
    if (typeof candidate.id !== 'string' || !track || !isOrigin(candidate.origin)) continue;
    entries.push({
      id: candidate.id,
      track,
      userQueued: candidate.userQueued === true,
      contextUri: optionalString(candidate.contextUri),
      origin: candidate.origin,
    });
  }

  return {
    v: SERIAL_VERSION,
    counter: raw.counter,
    seed: raw.seed,
    shuffle: raw.shuffle,
    repeat: raw.repeat,
    contextUri: optionalString(raw.contextUri),
    contextName: optionalString(raw.contextName),
    lastContextId: optionalString(raw.lastContextId),
    entries,
    history: raw.history,
    current: optionalString(raw.current),
    upcoming: raw.upcoming,
    contextOrder: raw.contextOrder,
  };
}
