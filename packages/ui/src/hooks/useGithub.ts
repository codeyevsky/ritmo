import { useCallback, useEffect, useState } from 'react';
import { GITHUB_TOKEN_KEY } from '@ritmo/core';
import type { GithubTokenCheck } from '@ritmo/core';

import { useServices } from '../services';
import { useTranslation } from './useTranslation';

/** Not a secret — just which repository the last publish used. */
const REPO_KEY = 'integration:github:repo';

export const GITHUB_DEFAULT_REPO = 'ritmo-packs';

/**
 * The token page with the one scope Ritmo needs already ticked, so the single
 * manual step is "press Generate, copy, paste".
 */
export const GITHUB_TOKEN_PAGE =
  'https://github.com/settings/tokens/new?scopes=public_repo&description=Ritmo';

export interface GithubAccount {
  /** The stored token, or `''` when none has been pasted yet. */
  token: string;
  repo: string;
  /** False until the stored values have been read back. */
  loaded: boolean;
  /** True where the host can talk to GitHub at all — the desktop app. */
  available: boolean;
  /** True when the host can publish *and* a token is stored. */
  canPublish: boolean;
  saveToken(token: string): Promise<void>;
  saveRepo(repo: string): Promise<void>;
  /** Resolves the account a token belongs to, without publishing anything. */
  check(token: string): Promise<GithubTokenCheck>;
  /**
   * Re-reads the stored values. Call it when a pane that may have been mounted
   * before the token was pasted becomes visible again.
   */
  reload(): void;
}

/**
 * Reads and writes the GitHub credentials both the Settings pane and the
 * publish dialog need.
 *
 * The token goes through `host.kv`, which on the desktop is a table in Ritmo's
 * own SQLite database — deliberately not the `Settings` blob, which is a file
 * the user copies between machines and which a library export contains.
 */
export function useGithub(): GithubAccount {
  const { host } = useServices();
  const { t } = useTranslation();
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState(GITHUB_DEFAULT_REPO);
  const [loaded, setLoaded] = useState(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let alive = true;
    void Promise.all([host.kv.get(GITHUB_TOKEN_KEY), host.kv.get(REPO_KEY)])
      .then(([stored, storedRepo]) => {
        if (!alive) return;
        setToken(stored ?? '');
        setRepo(storedRepo !== undefined && storedRepo !== '' ? storedRepo : GITHUB_DEFAULT_REPO);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [host, epoch]);

  const saveToken = useCallback(
    async (next: string) => {
      const trimmed = next.trim();
      setToken(trimmed);
      if (trimmed === '') await host.kv.remove(GITHUB_TOKEN_KEY);
      else await host.kv.set(GITHUB_TOKEN_KEY, trimmed);
    },
    [host],
  );

  const saveRepo = useCallback(
    async (next: string) => {
      const trimmed = next.trim();
      setRepo(trimmed);
      await host.kv.set(REPO_KEY, trimmed);
    },
    [host],
  );

  const check = useCallback(
    async (candidate: string): Promise<GithubTokenCheck> => {
      const ask = host.checkGithubToken;
      if (ask === undefined) throw new Error(t('pack.desktopOnly'));
      return ask.call(host, candidate.trim());
    },
    [host, t],
  );

  const reload = useCallback(() => setEpoch((n) => n + 1), []);
  const available = host.publishToGithub !== undefined && host.checkGithubToken !== undefined;

  return {
    token,
    repo,
    loaded,
    available,
    canPublish: available && token !== '',
    saveToken,
    saveRepo,
    check,
    reload,
  };
}
