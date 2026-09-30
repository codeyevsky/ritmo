/**
 * The pack layer, assembled. `docs/packs.md` is the contract for both wire
 * formats; nothing outside this directory parses either of them.
 */

export * from './types';
export {
  PackError,
  manifestToJson,
  newPackId,
  packIdOf,
  packUri,
  parseIndex,
  parseJson,
  parseManifest,
  safeId,
  utf8Size,
} from './manifest';
export type {
  PackErrorCode,
  ParseIndexOptions,
  ParseManifestOptions,
  RawIndex,
  RawIndexEntry,
} from './manifest';
export { bestMatch, durationsMatch, matchScore, probesFor, searchTextFor, titleProbe } from './match';
export { Packs } from './packs';
export type { PackCreateOptions, PackOrigin, PackPatch } from './packs';
export {
  Bazaar,
  MAX_INDEX_BYTES,
  MAX_PACKS_PER_INDEX,
  MAX_PACK_BYTES,
  MAX_TRACKS_PER_PACK,
  requireSameOrigin,
  requireWebUrl,
} from './bazaar';
