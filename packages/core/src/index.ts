/**
 * `@ritmo/core` public surface.
 *
 * `packages/ui` and `apps/web` import from here and nowhere deeper, so this
 * file is the boundary that lets the internals be reorganised freely.
 *
 * Re-exports are explicit for the provider classes because their modules also
 * export row mappers that duplicate the library layer's — the library versions
 * are the public ones.
 */

export * from './types';

export * from './util';
export * from './i18n';

export * from './host';
export * from './engine';

export * from './providers/types';
export { LocalProvider } from './providers/local';
export { AudiusProvider } from './providers/audius';
export { JamendoProvider, JAMENDO_SIGNUP_URL } from './providers/jamendo';
export { ArchiveProvider } from './providers/archive';
export { RadioProvider, stationToTrack } from './providers/radio';
export * from './providers/registry';
export * from './providers/shelfCache';

export * from './search';
export * from './recommend';

export * from './library';
export * from './packs';
export * from './player';
export * from './metadata';
