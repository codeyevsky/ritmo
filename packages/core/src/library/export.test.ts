import { describe, expect, it } from 'vitest';

import { GITHUB_TOKEN_KEY } from '../host/secrets';
import type { Settings } from '../types';
import { Library } from './index';
import { createFakeHost, track } from './testing';

/** Not shaped like a real credential, so no scanner reads this file as a leak. */
const TOKEN = 'not-a-real-credential-0123456789';

describe('Library.exportAll', () => {
  it('carries the user state', async () => {
    const host = createFakeHost();
    const library = new Library(host);
    await library.playlists.create('Drive', { tracks: [track('a')] });

    const payload = JSON.parse(await library.exportAll()) as Record<string, unknown>;

    expect(payload.format).toBe('ritmo.library');
    expect(Array.isArray(payload.playlists)).toBe(true);
    expect(payload.settings).toBeTypeOf('object');
  });

  it('omits the GitHub token, wherever it is stored', async () => {
    const host = createFakeHost();
    const library = new Library(host);

    // Where the token actually lives: the kv store, which the export never
    // reads.
    await host.kv.set(GITHUB_TOKEN_KEY, TOKEN);
    // And where a future build might wrongly put it: the Settings blob, which
    // the export does read. The guard has to strip it there too.
    const settings = await host.getSettings();
    await host.saveSettings({
      ...settings,
      [GITHUB_TOKEN_KEY]: TOKEN,
    } as unknown as Settings);

    const json = await library.exportAll();

    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(GITHUB_TOKEN_KEY);
    // The rest of the settings survive the redaction.
    const payload = JSON.parse(json) as { settings: Record<string, unknown> };
    expect(payload.settings.theme).toBe(settings.theme);
  });
});
