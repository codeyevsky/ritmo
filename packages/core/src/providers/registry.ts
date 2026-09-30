/**
 * Owns the lifetime of every provider instance.
 *
 * Two invariants the rest of the app leans on:
 *   1. every provider call that escapes this class has already been normalised
 *      to a {@link ProviderError}, so no caller has to handle raw throwables;
 *   2. aggregate calls (`shelves`, unified search) never reject — a dead
 *      provider is reported through {@link ProviderRegistry.lastErrors} and
 *      shown as a dismissible banner instead of taking the screen down.
 */

import { uriProvider } from '../types';
import type { HostBridge } from '../host/types';
import type { ProviderId, Settings, Shelf, StreamRef, Track, Uri } from '../types';
import { ProviderError } from './types';
import type { MusicProvider, ProviderContext, ProviderErrorCode } from './types';
import { LocalProvider } from './local';
import { AudiusProvider } from './audius';
import { JamendoProvider } from './jamendo';
import { ArchiveProvider } from './archive';
import { RadioProvider } from './radio';

/**
 * Ranking used everywhere two providers offer the same thing: a copy the user
 * already owns always wins, then the licensed catalogues, then the archives,
 * then live radio (which can't be a "duplicate" of a finite track in practice).
 */
export const PROVIDER_PRIORITY: readonly ProviderId[] = ['local', 'jamendo', 'audius', 'archive', 'radio'];

export function providerRank(id: ProviderId): number {
  const i = PROVIDER_PRIORITY.indexOf(id);
  return i < 0 ? PROVIDER_PRIORITY.length : i;
}

export interface ShelvesOptions {
  /** Called after each provider resolves, with every row gathered so far. */
  onPartial?: (shelves: Shelf[]) => void;
}

type ProviderFactory = (ctx: ProviderContext) => MusicProvider;

const FACTORIES: Record<ProviderId, ProviderFactory> = {
  local: (ctx) => new LocalProvider(ctx),
  audius: (ctx) => new AudiusProvider(ctx),
  jamendo: (ctx) => new JamendoProvider(ctx),
  archive: (ctx) => new ArchiveProvider(ctx),
  radio: (ctx) => new RadioProvider(ctx),
};

export class ProviderRegistry {
  /** Exposed so recommendation/search helpers can read the library database
   *  without a second bridge being threaded through every call site. */
  readonly host: HostBridge;

  private settings: Settings;
  private readonly providers = new Map<ProviderId, MusicProvider>();
  private readonly errors = new Map<ProviderId, ProviderError>();
  /** Memoised `isReady` probes, keyed by provider. Cleared by {@link reconcile}. */
  private readonly readiness = new Map<ProviderId, Promise<boolean>>();

  constructor(host: HostBridge, settings: Settings) {
    this.host = host;
    this.settings = settings;
  }

  /** In-flight provider warm-up from the last reconcile. */
  private warming: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    this.errors.clear();
    await this.reconcile();
  }

  get(id: ProviderId): MusicProvider | undefined {
    return this.providers.get(id);
  }

  require(id: ProviderId): MusicProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ProviderError('unsupported', `provider is not enabled: ${id}`, id);
    }
    return provider;
  }

  /** Every initialised provider, in priority order. */
  enabled(): MusicProvider[] {
    return [...this.providers.values()].sort((a, b) => providerRank(a.id) - providerRank(b.id));
  }

  /** {@link enabled} minus the ones that cannot work right now (offline mode). */
  available(): MusicProvider[] {
    if (!this.settings.offlineMode) return this.enabled();
    return this.enabled().filter((p) => !p.capabilities.needsNetwork);
  }

  /**
   * {@link available} minus the providers that report themselves unconfigured.
   *
   * Each one skipped is recorded through {@link noteError} as an `auth` error,
   * so the UI can send the user to Settings rather than claim the source timed
   * out. Callers that reset the error list must do so *before* calling this.
   */
  async ready(): Promise<MusicProvider[]> {
    await this.warmed();
    const checked = await Promise.all(
      this.available().map(async (p) => [p, await this.probeReady(p)] as const),
    );
    const out: MusicProvider[] = [];
    for (const [provider, isReady] of checked) {
      if (isReady) {
        out.push(provider);
        continue;
      }
      this.noteError(
        provider.id,
        new ProviderError('auth', `${provider.displayName} is not configured`, provider.id),
        'isReady',
      );
    }
    return out;
  }

  forUri(uri: Uri): MusicProvider | undefined {
    return this.providers.get(uriProvider(uri));
  }

  async updateSettings(settings: Settings): Promise<void> {
    this.settings = settings;
    await this.reconcile();
  }

  async resolveTrack(uri: Uri): Promise<Track> {
    return this.run(uriProvider(uri), 'getTrack', (p) => p.getTrack(uri));
  }

  async resolveStream(track: Track): Promise<StreamRef> {
    const id = track.provider ?? uriProvider(track.uri);
    return this.run(id, 'getStream', (p) => p.getStream(track));
  }

  /**
   * Rows for the Home screen, gathered from every provider that offers them.
   *
   * Nothing waits for the slowest source: {@link ShelvesOptions.onPartial} is
   * called with everything gathered so far each time a provider lands, so the
   * first answer paints immediately and the rest fill in behind it.
   */
  async shelves(opts: ShelvesOptions = {}): Promise<Shelf[]> {
    this.resetErrors();
    const { onPartial } = opts;
    const targets = (await this.ready()).filter((p) => p.capabilities.shelves && p.getShelves !== undefined);

    // One pre-allocated slot per provider rather than push-on-arrival: the
    // assembled order has to stay provider-priority, not race order, or a
    // partial emit would reshuffle rows the reader is already looking at.
    const slots: Shelf[][] = targets.map(() => []);
    await Promise.all(targets.map(async (provider, index) => {
      slots[index] = await this.shelvesOne(provider);
      onPartial?.(flattenShelves(slots));
    }));

    return flattenShelves(slots);
  }

  /** Per-provider errors from the last aggregate call, for a non-blocking UI banner. */
  lastErrors(): Array<{ provider: ProviderId; error: ProviderError }> {
    return [...this.errors.entries()]
      .map(([provider, error]) => ({ provider, error }))
      .sort((a, b) => providerRank(a.provider) - providerRank(b.provider));
  }

  /** Called at the start of an aggregate operation so the banner only ever
   *  reflects the current attempt. */
  resetErrors(): void {
    this.errors.clear();
  }

  /** Records `error` against `provider` and returns it as a ProviderError. */
  noteError(provider: ProviderId, error: unknown, op?: string): ProviderError {
    const normalised = toProviderError(error, provider, op);
    this.errors.set(provider, normalised);
    return normalised;
  }

  /**
   * Single funnel for provider calls: resolves the instance, normalises any
   * throwable to a ProviderError and records it for {@link lastErrors}.
   */
  async run<T>(id: ProviderId, op: string, fn: (provider: MusicProvider) => Promise<T>): Promise<T> {
    await this.warmed();
    let provider: MusicProvider;
    try {
      provider = this.require(id);
    } catch (err) {
      throw this.noteError(id, err, op);
    }
    try {
      return await fn(provider);
    } catch (err) {
      throw this.noteError(id, err, op);
    }
  }

  /** One provider's rows; a failure is recorded and reported as no rows. */
  private async shelvesOne(provider: MusicProvider): Promise<Shelf[]> {
    try {
      return await this.run(provider.id, 'getShelves', (p) => p.getShelves?.() ?? Promise.resolve([]));
    } catch {
      return [];
    }
  }

  /** A probe that throws is treated as ready: let the real call report why. */
  private probeReady(provider: MusicProvider): Promise<boolean> {
    const probe = provider.isReady;
    if (probe === undefined) return Promise.resolve(true);
    const cached = this.readiness.get(provider.id);
    if (cached !== undefined) return cached;
    const pending = probe.call(provider).catch(() => true);
    this.readiness.set(provider.id, pending);
    return pending;
  }

  private desired(): ProviderId[] {
    const seen = new Set<ProviderId>();
    for (const id of this.settings.enabledProviders) {
      if (!Object.prototype.hasOwnProperty.call(FACTORIES, id)) continue;
      seen.add(id);
    }
    return [...seen].sort((a, b) => providerRank(a) - providerRank(b));
  }

  /** Brings `providers` in line with the current settings; already-constructed
   *  instances are kept so toggling one provider never restarts the others. */
  private async reconcile(): Promise<void> {
    // Anything that reaches reconcile — init, or `updateSettings` after a key
    // was entered — may have changed what a provider needs to be ready.
    this.readiness.clear();
    const want = this.desired();
    for (const id of [...this.providers.keys()]) {
      if (!want.includes(id)) this.providers.delete(id);
    }

    const fresh: MusicProvider[] = [];
    for (const id of want) {
      if (this.providers.has(id)) continue;
      try {
        const provider = FACTORIES[id](this.context(id));
        this.providers.set(id, provider);
        fresh.push(provider);
      } catch (err) {
        this.noteError(id, err, 'construct');
      }
    }

    // Constructing providers is synchronous; only `init` touches the network
    // (Audius discovers a node, Radio Browser picks a mirror). Awaiting that
    // here put two round trips in front of the first frame, so warm-up is
    // tracked instead and awaited at the point of use.
    this.warming = Promise.all(fresh.map(async (provider) => {
      if (provider.init === undefined) return;
      try {
        await provider.init();
      } catch (err) {
        // A provider that failed to warm up stays registered: most of them can
        // still serve cached data, and the next call reports the real error.
        this.noteError(provider.id, err, 'init');
      }
    })).then(() => undefined);
  }

  /** Resolves once every provider constructed by the last reconcile has warmed up. */
  private async warmed(): Promise<void> {
    try {
      await this.warming;
    } catch {
      // `reconcile` already recorded the per-provider failure.
    }
  }

  private context(id: ProviderId): ProviderContext {
    const prefix = `provider:${id}:`;
    return {
      host: this.host,
      quality: () => this.settings.preferredQuality,
      offline: () => this.settings.offlineMode,
      config: {
        get: (key: string) => this.host.kv.get(prefix + key),
        set: (key: string, value: string) => this.host.kv.set(prefix + key, value),
      },
    };
  }
}

/** Flattens the per-provider slots, dropping rows with nothing to show. */
function flattenShelves(slots: readonly Shelf[][]): Shelf[] {
  return slots.flat().filter((shelf) => shelf.items.length > 0);
}

function toProviderError(error: unknown, provider?: ProviderId, op?: string): ProviderError {
  if (error instanceof ProviderError) return error;
  // Duck-typed check as well: a ProviderError that crossed a bundle boundary
  // fails `instanceof` but must not be downgraded to 'unknown'.
  if (isErrorLike(error) && error.name === 'ProviderError' && typeof error.code === 'string') {
    return new ProviderError(error.code as ProviderErrorCode, error.message ?? 'provider error', provider, error);
  }
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : 'unknown error';
  const where = op !== undefined ? `${provider ?? '?'}.${op}: ` : '';
  return new ProviderError('unknown', `${where}${detail}`, provider, error);
}

function isErrorLike(v: unknown): v is { name?: string; message?: string; code?: unknown } {
  return typeof v === 'object' && v !== null;
}
