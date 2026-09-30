/**
 * Credentials the user pastes into Ritmo.
 *
 * They live in the key–value store, never in the `Settings` blob: `kv` is a
 * table in the app's own SQLite database, while `settings.json` is a file the
 * user is invited to copy between machines and which `Library.exportAll()`
 * writes into a backup. A secret must not travel in either.
 *
 * The keys are named here rather than at each call site so the export guard and
 * the Settings pane that writes them cannot drift apart.
 */

/** Personal access token for publishing packs to GitHub Pages. */
export const GITHUB_TOKEN_KEY = 'integration:github:token';

/**
 * Keys whose values are secrets. `Library.exportAll()` refuses to emit any of
 * these, so moving one into the exported blob later fails a test instead of
 * shipping a credential inside a backup file.
 */
export const SECRET_KEYS: readonly string[] = [GITHUB_TOKEN_KEY];

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.includes(key);
}
