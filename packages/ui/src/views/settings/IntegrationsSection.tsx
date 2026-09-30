import { useEffect, useState } from 'react';
import { LastfmClient } from '@ritmo/core';

import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Input } from '../../components/Input';
import { Toggle } from '../../components/Toggle';
import { ExternalLink } from '../../icons';
import { useServices } from '../../services';
import { GITHUB_DEFAULT_REPO, GITHUB_TOKEN_PAGE, useGithub } from '../../hooks/useGithub';
import { useSettings } from '../../hooks/useSettings';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingBlock, SettingGroup, SettingRow } from './SettingRow';

const KEY_KV = 'lastfm:apiKey';
const SECRET_KV = 'lastfm:apiSecret';

type Phase = 'idle' | 'authorizing' | 'awaiting' | 'completing';

/**
 * Publishing to GitHub Pages needs exactly one thing from the user: a token,
 * created once on github.com. Everything after that — the repository, the
 * upload, switching Pages on — happens inside Ritmo, so this pane's whole job
 * is taking the token, proving it works and remembering the repository name.
 */
function GithubGroup() {
  const { t } = useTranslation();
  const { host } = useServices();
  const github = useGithub();

  const [draft, setDraft] = useState('');
  const [repo, setRepo] = useState('');
  const [checking, setChecking] = useState(false);
  const [login, setLogin] = useState<string | undefined>(undefined);
  const [warning, setWarning] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Seeded once the stored values arrive; typing after that must not be
  // overwritten, hence the guard on `loaded`.
  useEffect(() => {
    if (!github.loaded) return;
    setDraft(github.token);
    setRepo(github.repo);
  }, [github.loaded, github.token, github.repo]);

  const check = () => {
    const candidate = draft.trim();
    if (candidate === '') return;
    setChecking(true);
    setError(undefined);
    setWarning(undefined);
    setLogin(undefined);
    void (async () => {
      try {
        const result = await github.check(candidate);
        setLogin(result.login);
        if (!result.scopesOk) setWarning(t('github.missingScope'));
        // Stored only once GitHub has accepted it, so a typo never becomes the
        // credential a later publish tries to use.
        await github.saveToken(candidate);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setChecking(false);
      }
    })();
  };

  return (
    <SettingGroup title={t('github.title')} description={t('github.description')}>
      <SettingBlock description={t('github.manualStep')}>
        <Button
          variant="outline"
          size="sm"
          trailing={ExternalLink}
          onClick={() => void host.openExternal(GITHUB_TOKEN_PAGE)}
        >
          {t('github.openGithub')}
        </Button>
      </SettingBlock>

      <SettingRow
        label={t('github.token')}
        description={t('github.tokenDesc')}
        htmlFor="setting-github-token"
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Input
              id="setting-github-token"
              className="w-full sm:w-64"
              size="sm"
              type="password"
              value={draft}
              placeholder={t('github.tokenPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setDraft(e.target.value);
                setLogin(undefined);
                setWarning(undefined);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              loading={checking}
              disabled={draft.trim() === ''}
              onClick={check}
            >
              {t('github.check')}
            </Button>
          </div>
        }
      />

      <SettingRow
        label={t('github.repo')}
        description={t('github.repoDesc')}
        htmlFor="setting-github-repo"
        control={
          <Input
            id="setting-github-repo"
            className="w-full sm:w-64"
            size="sm"
            value={repo}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setRepo(e.target.value)}
            onBlur={() => {
              const next = repo.trim() === '' ? GITHUB_DEFAULT_REPO : repo.trim();
              setRepo(next);
              void github.saveRepo(next);
            }}
          />
        }
      />

      <p aria-live="polite" className="min-h-5 pb-3 text-xs leading-5 text-text-dim">
        {login !== undefined ? t('github.checkedAs', { login }) : ''}
        {warning !== undefined ? ` · ${warning}` : ''}
      </p>

      {error !== undefined && (
        <div className="pb-3">
          <ErrorBanner
            title={t('github.checkFailed')}
            body={error}
            tone="danger"
            onRetry={check}
            onDismiss={() => setError(undefined)}
          />
        </div>
      )}
    </SettingGroup>
  );
}

export function IntegrationsSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();
  const { host } = useServices();

  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [token, setToken] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void Promise.all([host.kv.get(KEY_KV), host.kv.get(SECRET_KV)])
      .then(([key, secret]) => {
        if (!alive) return;
        setApiKey(key ?? '');
        setApiSecret(secret ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [host]);

  const connected = settings.lastfm;
  const credentialsReady = apiKey.trim() !== '' && apiSecret.trim() !== '';

  const beginAuth = () => {
    setPhase('authorizing');
    setError(undefined);
    void (async () => {
      try {
        const key = apiKey.trim();
        const secret = apiSecret.trim();
        // Persisted before the round trip so the credentials survive the user
        // leaving the app for their browser.
        await host.kv.set(KEY_KV, key);
        await host.kv.set(SECRET_KV, secret);
        const client = new LastfmClient(host, key, secret);
        const auth = await client.getAuthUrl();
        setToken(auth.token);
        await host.openExternal(auth.url);
        setPhase('awaiting');
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('idle');
      }
    })();
  };

  const completeAuth = () => {
    if (token === undefined) return;
    setPhase('completing');
    setError(undefined);
    void (async () => {
      try {
        const client = new LastfmClient(host, apiKey.trim(), apiSecret.trim());
        const session = await client.completeAuth(token);
        patch({ lastfm: { username: session.username, sessionKey: session.sessionKey } });
        setToken(undefined);
        setPhase('idle');
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('awaiting');
      }
    })();
  };

  const disconnect = () => {
    patch({ lastfm: undefined });
    setToken(undefined);
    setPhase('idle');
    setError(undefined);
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup title={t('settings.lastfm')} description={t('settings.lastfmDesc')}>
        {connected === undefined ? (
          <>
            <SettingRow
              label={t('settings.lastfmApiKey')}
              description={t('settings.lastfmApiKeyDesc')}
              htmlFor="setting-lastfm-key"
              control={
                <Input
                  id="setting-lastfm-key"
                  className="w-full sm:w-64"
                  size="sm"
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              }
            />
            <SettingRow
              label={t('settings.lastfmApiSecret')}
              description={t('settings.lastfmApiSecretDesc')}
              htmlFor="setting-lastfm-secret"
              control={
                <Input
                  id="setting-lastfm-secret"
                  className="w-full sm:w-64"
                  size="sm"
                  type="password"
                  value={apiSecret}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setApiSecret(e.target.value)}
                />
              }
            />
            <SettingBlock>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={phase === 'authorizing'}
                  disabled={!credentialsReady || phase === 'authorizing'}
                  onClick={beginAuth}
                >
                  {t('settings.lastfmConnect')}
                </Button>
                {(phase === 'awaiting' || phase === 'completing') && (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={phase === 'completing'}
                    disabled={phase === 'completing'}
                    onClick={completeAuth}
                  >
                    {t('settings.lastfmComplete')}
                  </Button>
                )}
              </div>
              <p aria-live="polite" className="mt-2 min-h-5 text-xs leading-5 text-text-dim">
                {phase === 'awaiting'
                  ? t('settings.lastfmCompleteHint')
                  : phase === 'completing'
                    ? t('settings.lastfmCompleting')
                    : ''}
              </p>
            </SettingBlock>
          </>
        ) : (
          <SettingRow
            label={t('settings.lastfmConnectedAs', { username: connected.username })}
            description={t('settings.lastfmConnectedDesc')}
            control={
              <Button variant="outline" size="sm" onClick={disconnect}>
                {t('settings.lastfmDisconnect')}
              </Button>
            }
          />
        )}
        {error !== undefined && (
          <div className="pb-3">
            <ErrorBanner
              title={t('settings.lastfmFailed')}
              body={error}
              tone="danger"
              onRetry={token === undefined ? beginAuth : completeAuth}
              onDismiss={() => setError(undefined)}
            />
          </div>
        )}
      </SettingGroup>

      {/* Publishing needs native HTTP and a filesystem, so the group only
          exists where it can actually work. */}
      {host.publishToGithub !== undefined && <GithubGroup />}

      <SettingGroup title={t('settings.discord')}>
        <SettingRow
          label={t('settings.discordRichPresence')}
          // The core ships no Discord IPC client yet, so this only records the
          // preference; nothing reads it until that lands.
          description={t('settings.discordRichPresenceDesc')}
          htmlFor="setting-discord"
          control={
            <Toggle
              id="setting-discord"
              label={t('settings.discordRichPresence')}
              checked={settings.discordRichPresence}
              onChange={(discordRichPresence) => patch({ discordRichPresence })}
            />
          }
        />
      </SettingGroup>
    </div>
  );
}
