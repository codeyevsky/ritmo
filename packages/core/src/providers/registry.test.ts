import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../types';
import type { HostBridge } from '../host/types';
import type { ProviderId, Settings, Shelf } from '../types';
import { ProviderError } from './types';
import type { MusicProvider, ProviderCapabilities } from './types';
import { ProviderRegistry } from './registry';

// --- fixtures ---------------------------------------------------------------

const ALL_CAPS: ProviderCapabilities = {
  search: true,
  albums: true,
  artists: true,
  playlists: true,
  stations: true,
  related: true,
  shelves: true,
  downloadable: true,
  needsNetwork: true,
};

function shelf(id: string): Shelf {
  return {
    id,
    title: id,
    items: [{
      type: 'artist',
      artist: { uri: `local:artist:${id}`, provider: 'local', name: id },
    }],
  };
}

/** An empty row: `shelves()` must drop it rather than render a bare heading. */
function emptyShelf(id: string): Shelf {
  return { id, title: id, items: [] };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-settled promise and its continuations run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Stub {
  id: ProviderId;
  getShelves?: () => Promise<Shelf[]>;
  capabilities?: Partial<ProviderCapabilities>;
}

function stubProvider(stub: Stub): MusicProvider {
  return {
    id: stub.id,
    displayName: stub.id,
    capabilities: { ...ALL_CAPS, ...stub.capabilities },
    ...(stub.getShelves === undefined ? {} : { getShelves: stub.getShelves }),
  } as unknown as MusicProvider;
}

/**
 * The real registry with its provider set swapped out.
 *
 * Overriding `ready` and `require` — both public — keeps `run`, `noteError`
 * and `lastErrors` on the production path, so the error bookkeeping under test
 * is the real one rather than a second implementation of it.
 */
class TestRegistry extends ProviderRegistry {
  constructor(private readonly stubs: MusicProvider[], settings: Settings = defaultSettings()) {
    super({} as unknown as HostBridge, settings);
  }

  override ready(): Promise<MusicProvider[]> {
    return Promise.resolve(this.stubs);
  }

  override require(id: ProviderId): MusicProvider {
    const found = this.stubs.find((p) => p.id === id);
    if (!found) throw new ProviderError('unsupported', `provider is not enabled: ${id}`, id);
    return found;
  }
}

// --- shelves ----------------------------------------------------------------

describe('ProviderRegistry.shelves', () => {
  it('emits onPartial once per provider, with the set growing each time', async () => {
    const slow = deferred<Shelf[]>();
    const middle = deferred<Shelf[]>();
    const fast = deferred<Shelf[]>();

    const registry = new TestRegistry([
      stubProvider({ id: 'local', getShelves: () => slow.promise }),
      stubProvider({ id: 'jamendo', getShelves: () => middle.promise }),
      stubProvider({ id: 'audius', getShelves: () => fast.promise }),
    ]);

    const emits: string[][] = [];
    const pending = registry.shelves({ onPartial: (s) => emits.push(s.map((row) => row.id)) });

    fast.resolve([shelf('audius-row')]);
    await flush();
    expect(emits).toEqual([['audius-row']]);

    middle.resolve([shelf('jamendo-row')]);
    await flush();
    expect(emits).toEqual([['audius-row'], ['jamendo-row', 'audius-row']]);

    slow.resolve([shelf('local-row')]);
    await flush();
    expect(emits).toHaveLength(3);

    // Assembled order is provider priority, not the order they answered in.
    expect(emits[2]).toEqual(['local-row', 'jamendo-row', 'audius-row']);
    expect((await pending).map((row) => row.id)).toEqual(['local-row', 'jamendo-row', 'audius-row']);
  });

  it('paints the quick providers without waiting for a hung one', async () => {
    const hung = deferred<Shelf[]>();

    const registry = new TestRegistry([
      stubProvider({ id: 'local', getShelves: () => hung.promise }),
      stubProvider({ id: 'jamendo', getShelves: () => Promise.resolve([shelf('jamendo-row')]) }),
      stubProvider({ id: 'audius', getShelves: () => Promise.resolve([shelf('audius-row')]) }),
    ]);

    const emits: string[][] = [];
    const pending = registry.shelves({ onPartial: (s) => emits.push(s.map((row) => row.id)) });
    await flush();

    expect(emits).toHaveLength(2);
    expect(emits[1]).toEqual(['jamendo-row', 'audius-row']);

    // The aggregate is still open; the two fast rows are already on screen.
    const sentinel = Symbol('pending');
    expect(await Promise.race([pending, Promise.resolve(sentinel)])).toBe(sentinel);

    hung.resolve([]);
    expect((await pending).map((row) => row.id)).toEqual(['jamendo-row', 'audius-row']);
  });

  it('records a failing provider and reports it as no rows', async () => {
    const registry = new TestRegistry([
      stubProvider({ id: 'local', getShelves: () => Promise.resolve([shelf('local-row')]) }),
      stubProvider({
        id: 'audius',
        getShelves: () => Promise.reject(new ProviderError('network', 'down', 'audius')),
      }),
    ]);

    const rows = await registry.shelves();
    expect(rows.map((row) => row.id)).toEqual(['local-row']);
    expect(registry.lastErrors().map((e) => [e.provider, e.error.code])).toEqual([['audius', 'network']]);
  });

  it('skips providers that do not offer shelves at all', async () => {
    const registry = new TestRegistry([
      stubProvider({ id: 'local', capabilities: { shelves: false }, getShelves: () => Promise.resolve([shelf('nope')]) }),
      // Capability set but no implementation: must not be called or counted.
      stubProvider({ id: 'jamendo' }),
      stubProvider({ id: 'audius', getShelves: () => Promise.resolve([shelf('yes')]) }),
    ]);

    const emits: number[] = [];
    const rows = await registry.shelves({ onPartial: (s) => emits.push(s.length) });
    expect(rows.map((row) => row.id)).toEqual(['yes']);
    expect(emits).toEqual([1]);
  });

  it('drops empty rows from both the partials and the result', async () => {
    const registry = new TestRegistry([
      stubProvider({ id: 'local', getShelves: () => Promise.resolve([emptyShelf('bare')]) }),
      stubProvider({ id: 'audius', getShelves: () => Promise.resolve([shelf('full'), emptyShelf('bare2')]) }),
    ]);

    const emits: string[][] = [];
    const rows = await registry.shelves({ onPartial: (s) => emits.push(s.map((row) => row.id)) });
    expect(rows.map((row) => row.id)).toEqual(['full']);
    expect(emits).toEqual([[], ['full']]);
  });

  it('returns the same list with no options passed', async () => {
    const registry = new TestRegistry([
      stubProvider({ id: 'local', getShelves: () => Promise.resolve([shelf('a')]) }),
      stubProvider({ id: 'audius', getShelves: () => Promise.resolve([shelf('b')]) }),
    ]);
    expect((await registry.shelves()).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('clears the previous attempt\'s errors on each call', async () => {
    let fail = true;
    const registry = new TestRegistry([
      stubProvider({
        id: 'audius',
        getShelves: () => fail
          ? Promise.reject(new ProviderError('network', 'down', 'audius'))
          : Promise.resolve([shelf('back')]),
      }),
    ]);

    await registry.shelves();
    expect(registry.lastErrors()).toHaveLength(1);

    fail = false;
    await registry.shelves();
    expect(registry.lastErrors()).toHaveLength(0);
  });
});
