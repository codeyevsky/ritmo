import { describe, expect, it } from 'vitest';

import { Bazaar, MAX_INDEX_BYTES, MAX_TRACKS_PER_PACK } from './bazaar';
import { Packs } from './packs';
import { Repo } from '../library/repo';
import { createFakeHost } from '../library/testing';
import { ProviderRegistry } from '../providers/registry';
import { defaultSettings } from '../types';
import type { HostRequests } from './bazaar.test.helpers';
import { manifestDocument, serve } from './bazaar.test.helpers';

const INDEX = 'https://packs.example/mine/index.json';
const OTHER = 'https://other.example/index.json';

function bazaarWith(documents: Record<string, string | number>): {
  bazaar: Bazaar;
  packs: Packs;
  requests: HostRequests;
} {
  const { http, requests } = serve(documents);
  const host = createFakeHost({ http });
  const registry = new ProviderRegistry(host, { ...defaultSettings(), enabledProviders: [] });
  const packs = new Packs(host, new Repo(host), registry);
  return { bazaar: new Bazaar(host, packs), packs, requests };
}

function indexDocument(packs: Array<Record<string, unknown>>, name = 'codeyevsky’s packs'): string {
  return JSON.stringify({
    format: 'ritmobazaar',
    version: 1,
    name,
    description: '',
    updatedAt: 1764500000000,
    packs,
  });
}

describe('the trust boundary', () => {
  it('refuses a source that is not http or https', async () => {
    const { bazaar } = bazaarWith({});
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:application/json,{}',
      'ftp://packs.example/index.json',
      'not a url at all',
    ]) {
      await expect(bazaar.addSource(bad)).rejects.toMatchObject({ code: 'unsafe_url' });
    }
    expect(await bazaar.sources()).toEqual([]);
  });

  it('drops a pack url that points off the index’s origin, and keeps its neighbour', async () => {
    const { bazaar } = bazaarWith({
      [INDEX]: indexDocument([
        { id: 'p_good', name: 'Good', trackCount: 1, url: 'packs/p_good.json', updatedAt: 1 },
        { id: 'p_evil', name: 'Evil', trackCount: 1, url: 'https://evil.example/p.json', updatedAt: 1 },
        { id: 'p_abs', name: 'Absolute but same origin', trackCount: 1, url: 'https://packs.example/mine/packs/p_abs.json', updatedAt: 1 },
      ]),
    });

    await bazaar.addSource(INDEX);
    const catalogue = await bazaar.catalogue();

    expect(catalogue.map((entry) => entry.id)).toEqual(['p_good', 'p_abs']);
    // A relative url resolves against the index, which is what lets a
    // publisher move their whole tree.
    expect(catalogue[0]?.url).toBe('https://packs.example/mine/packs/p_good.json');
  });

  it('drops a cross-origin cover without losing the pack', async () => {
    const { bazaar } = bazaarWith({
      [INDEX]: indexDocument([
        { id: 'p_1', name: 'A', trackCount: 1, url: 'packs/p_1.json', artwork: 'https://cdn.evil/a.jpg', updatedAt: 1 },
        { id: 'p_2', name: 'B', trackCount: 1, url: 'packs/p_2.json', artwork: 'covers/p_2.jpg', updatedAt: 1 },
      ]),
    });

    await bazaar.addSource(INDEX);
    const catalogue = await bazaar.catalogue();

    expect(catalogue).toHaveLength(2);
    expect(catalogue[0]?.artwork).toBeUndefined();
    expect(catalogue[1]?.artwork).toBe('https://packs.example/mine/covers/p_2.jpg');
  });

  it('disables a source whose index is over the size cap', async () => {
    const { bazaar } = bazaarWith({
      // A document that parses perfectly but is simply too expensive to hold.
      [INDEX]: indexDocument([
        {
          id: 'p_1',
          name: 'A',
          description: 'x'.repeat(MAX_INDEX_BYTES + 1),
          trackCount: 1,
          url: 'packs/p_1.json',
          updatedAt: 1,
        },
      ]),
    });

    await bazaar.addSource(INDEX);

    const [source] = await bazaar.sources();
    expect(source?.ok).toBe(false);
    expect(source?.error).toMatch(/over the/);
    expect(await bazaar.catalogue()).toEqual([]);
  });

  it('disables a source that declares a huge Content-Length', async () => {
    const { bazaar } = bazaarWith({
      [INDEX]: indexDocument([]),
      // A hostile server is free to lie in either direction, so the declared
      // length is checked as well as what arrived.
      [`${INDEX}#content-length`]: MAX_INDEX_BYTES * 4,
    });

    await bazaar.addSource(INDEX);
    const [source] = await bazaar.sources();
    expect(source?.ok).toBe(false);
    expect(source?.error).toMatch(/declares/);
  });

  it('refuses a pack that carries more tracks than the cap allows', async () => {
    const tracks = Array.from({ length: MAX_TRACKS_PER_PACK + 1 }, (_, i) => ({
      uri: null,
      title: `Track ${i}`,
      artists: ['Someone'],
      durationMs: 1000,
    }));
    const { bazaar } = bazaarWith({
      [INDEX]: indexDocument([
        { id: 'p_big', name: 'Too big', trackCount: tracks.length, url: 'packs/p_big.json', updatedAt: 1 },
      ]),
      'https://packs.example/mine/packs/p_big.json': JSON.stringify({
        format: 'ritmopack',
        version: 1,
        id: 'p_big',
        name: 'Too big',
        createdAt: 1,
        updatedAt: 1,
        tracks,
      }),
    });

    await bazaar.addSource(INDEX);
    const [entry] = await bazaar.catalogue();
    expect(entry).toBeDefined();
    await expect(bazaar.installFromBazaar(entry!)).rejects.toMatchObject({ code: 'too_many' });
  });

  it('refuses a pack document that is over the byte cap', async () => {
    const { bazaar } = bazaarWith({
      [INDEX]: indexDocument([
        { id: 'p_1', name: 'A', trackCount: 1, url: 'packs/p_1.json', updatedAt: 1 },
      ]),
      'https://packs.example/mine/packs/p_1.json': manifestDocument('p_1', 'A', 20_000),
    });

    await bazaar.addSource(INDEX);
    const [entry] = await bazaar.catalogue();
    await expect(bazaar.installFromBazaar(entry!)).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('sources are isolated', () => {
  it('one broken source leaves the other one working', async () => {
    const { bazaar } = bazaarWith({
      [INDEX]: indexDocument([
        { id: 'p_1', name: 'Mine', trackCount: 1, url: 'packs/p_1.json', updatedAt: 1 },
      ]),
      [OTHER]: 'this is not json at all',
    });

    await bazaar.addSource(INDEX);
    await bazaar.addSource(OTHER);
    await bazaar.refresh();

    const sources = await bazaar.sources();
    const good = sources.find((s) => s.url === INDEX);
    const bad = sources.find((s) => s.url === OTHER);
    expect(good?.ok).toBe(true);
    expect(good?.name).toBe('codeyevsky’s packs');
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toMatch(/JSON/i);

    // The catalogue still carries everything the healthy source offers.
    expect((await bazaar.catalogue()).map((e) => e.id)).toEqual(['p_1']);
  });

  it('a source that answers 404 is disabled with its status, not thrown', async () => {
    const { bazaar } = bazaarWith({ [INDEX]: 404 });
    await expect(bazaar.addSource(INDEX)).resolves.toMatchObject({ url: INDEX });

    const [source] = await bazaar.sources();
    expect(source?.ok).toBe(false);
    expect(source?.error).toMatch(/404/);
  });

  it('removing a source forgets its catalogue', async () => {
    const { bazaar } = bazaarWith({
      [INDEX]: indexDocument([
        { id: 'p_1', name: 'Mine', trackCount: 1, url: 'packs/p_1.json', updatedAt: 1 },
      ]),
    });
    await bazaar.addSource(INDEX);
    expect(await bazaar.catalogue()).toHaveLength(1);

    await bazaar.removeSource(INDEX);
    expect(await bazaar.sources()).toEqual([]);
    expect(await bazaar.catalogue()).toEqual([]);
  });
});

describe('installing', () => {
  it('records the origin and keeps unresolved entries', async () => {
    const { bazaar, packs, requests } = bazaarWith({
      [INDEX]: indexDocument([
        { id: 'p_1', name: 'Late Night Drive', trackCount: 2, url: 'packs/p_1.json', artwork: 'covers/p_1.jpg', updatedAt: 5 },
      ]),
      'https://packs.example/mine/packs/p_1.json': manifestDocument('p_1', 'Late Night Drive', 2),
    });

    await bazaar.addSource(INDEX);
    const [entry] = await bazaar.catalogue();
    const installed = await bazaar.installFromBazaar(entry!);

    expect(installed.source).toBe('remote');
    expect(installed.sourceUrl).toBe(INDEX);
    expect(installed.packUrl).toBe('https://packs.example/mine/packs/p_1.json');
    // Nothing in this library resolves them, and nothing was dropped.
    expect(installed.trackCount).toBe(2);
    expect(installed.unavailableCount).toBe(2);

    const listed = await packs.list();
    expect(listed.map((p) => p.uri)).toEqual([installed.uri]);
    // Browsing costs one request for the index; the pack itself is only
    // fetched when the user asks for it.
    expect(requests).toEqual([INDEX, 'https://packs.example/mine/packs/p_1.json']);
  });

  it('resolves a relative cover inside the pack against the pack url', async () => {
    const { bazaar } = bazaarWith({
      [INDEX]: indexDocument([
        { id: 'p_1', name: 'A', trackCount: 1, url: 'packs/p_1.json', updatedAt: 1 },
      ]),
      'https://packs.example/mine/packs/p_1.json': JSON.stringify({
        format: 'ritmopack',
        version: 1,
        id: 'p_1',
        name: 'A',
        artwork: '../covers/p_1.jpg',
        createdAt: 1,
        updatedAt: 1,
        tracks: [],
      }),
    });

    await bazaar.addSource(INDEX);
    const [entry] = await bazaar.catalogue();
    const manifest = await bazaar.preview(entry!);
    expect(manifest.artwork).toBe('https://packs.example/mine/covers/p_1.jpg');
  });
});
