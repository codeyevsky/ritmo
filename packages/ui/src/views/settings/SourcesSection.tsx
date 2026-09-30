import { useCallback, useEffect, useState } from 'react';
import type { ProviderId } from '@ritmo/core';
import { JAMENDO_SIGNUP_URL } from '@ritmo/core';
import clsx from 'clsx';

import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { ProviderBadge } from '../../components/ProviderBadge';
import { Toggle } from '../../components/Toggle';
import { useServices } from '../../services';
import { useSettings } from '../../hooks/useSettings';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingGroup } from './SettingRow';

const ALL_PROVIDERS: readonly ProviderId[] = ['local', 'audius', 'jamendo', 'archive', 'radio'];

/** Where `ProviderContext.config` reads the key from — see `providers/jamendo.ts`. */
const JAMENDO_KEY = 'provider:jamendo:clientId';

const NAME_KEYS = {
  local: 'settings.sourceLocalName',
  audius: 'settings.sourceAudiusName',
  jamendo: 'settings.sourceJamendoName',
  archive: 'settings.sourceArchiveName',
  radio: 'settings.sourceRadioName',
} as const;

const DESC_KEYS = {
  local: 'settings.sourceLocalDesc',
  audius: 'settings.sourceAudiusDesc',
  jamendo: 'settings.sourceJamendoDesc',
  archive: 'settings.sourceArchiveDesc',
  radio: 'settings.sourceRadioDesc',
} as const;

type Status = 'ok' | 'auth' | 'disabled' | 'failing';

const STATUS_KEYS = {
  ok: 'settings.statusOk',
  auth: 'settings.statusAuth',
  disabled: 'settings.statusDisabled',
  failing: 'settings.statusFailing',
} as const;

const STATUS_DOT: Record<Status, string> = {
  ok: 'bg-accent',
  auth: 'bg-warn',
  disabled: 'bg-text-faint',
  failing: 'bg-danger',
};

export function SourcesSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();
  const { host, registry } = useServices();

  // lastErrors() is a snapshot, so it is re-read whenever the enabled set
  // changes and on demand from the refresh button.
  const [nonce, setNonce] = useState(0);
  const [errors, setErrors] = useState<ReadonlyArray<{ provider: ProviderId; code: string }>>([]);

  useEffect(() => {
    setErrors(registry.lastErrors().map((e) => ({ provider: e.provider, code: e.error.code })));
  }, [registry, nonce, settings.enabledProviders]);

  const [clientId, setClientId] = useState('');
  const [clientIdSaved, setClientIdSaved] = useState<string>('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    let alive = true;
    void host.kv
      .get(JAMENDO_KEY)
      .then((value) => {
        if (!alive) return;
        setClientId(value ?? '');
        setClientIdSaved(value ?? '');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [host]);

  const statusOf = useCallback(
    (id: ProviderId): Status => {
      if (!settings.enabledProviders.includes(id)) return 'disabled';
      const failure = errors.find((e) => e.provider === id);
      if (failure === undefined) return 'ok';
      return failure.code === 'auth' ? 'auth' : 'failing';
    },
    [errors, settings.enabledProviders],
  );

  const toggleProvider = (id: ProviderId, on: boolean) => {
    const next = on
      ? [...settings.enabledProviders.filter((p) => p !== id), id]
      : settings.enabledProviders.filter((p) => p !== id);
    // Preserve the declared order so the list never reshuffles as it is edited.
    patch({ enabledProviders: ALL_PROVIDERS.filter((p) => next.includes(p)) });
    setNonce((n) => n + 1);
  };

  const saveClientId = () => {
    setSavingKey(true);
    setKeyStatus('idle');
    void (async () => {
      try {
        const trimmed = clientId.trim();
        if (trimmed === '') {
          await host.kv.remove(JAMENDO_KEY);
        } else {
          await host.kv.set(JAMENDO_KEY, trimmed);
        }
        // The provider caches the id after its first init, so the registry has
        // to be nudged before the new key is used for anything.
        await registry.updateSettings(settings);
        setClientIdSaved(trimmed);
        setKeyStatus('saved');
        setNonce((n) => n + 1);
      } catch {
        setKeyStatus('failed');
      } finally {
        setSavingKey(false);
      }
    })();
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-6 text-text-dim">{t('settings.sourcesBody')}</p>

      <div className="flex flex-col gap-3">
        {ALL_PROVIDERS.map((id) => {
          const status = statusOf(id);
          const enabled = settings.enabledProviders.includes(id);
          const name = t(NAME_KEYS[id]);
          return (
            <div key={id} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-text">{name}</span>
                    <ProviderBadge provider={id} size="sm" withLabel={false} />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-text-dim">{t(DESC_KEYS[id])}</p>
                  <p className="mt-2 flex items-center gap-2 text-xs text-text-dim" aria-live="polite">
                    <span
                      aria-hidden="true"
                      className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])}
                    />
                    {t(STATUS_KEYS[status])}
                  </p>
                </div>
                <Toggle
                  label={t('settings.enableSourceOf', { name })}
                  checked={enabled}
                  onChange={(on) => toggleProvider(id, on)}
                />
              </div>

              {id === 'jamendo' && (
                <div className="mt-4 border-t border-line pt-4">
                  <label
                    htmlFor="setting-jamendo-key"
                    className="block text-xs font-medium text-text"
                  >
                    {t('settings.jamendoClientId')}
                  </label>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      id="setting-jamendo-key"
                      className="min-w-0 flex-1"
                      size="sm"
                      value={clientId}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={t('settings.jamendoClientIdPlaceholder')}
                      invalid={keyStatus === 'failed'}
                      clearable
                      onClear={() => setClientId('')}
                      onChange={(e) => {
                        setClientId(e.target.value);
                        setKeyStatus('idle');
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      loading={savingKey}
                      disabled={savingKey || clientId.trim() === clientIdSaved}
                      onClick={saveClientId}
                    >
                      {t('settings.save')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void host.openExternal(JAMENDO_SIGNUP_URL)}
                    >
                      {t('settings.jamendoSignup')}
                    </Button>
                  </div>
                  <p aria-live="polite" className="mt-2 text-xs leading-5 text-text-dim">
                    {keyStatus === 'saved'
                      ? t('settings.jamendoSaved')
                      : keyStatus === 'failed'
                        ? t('settings.jamendoSaveFailed')
                        : t('settings.jamendoKeyHelp')}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <SettingGroup title={t('settings.sourcesStatus')}>
        <div className="flex items-center justify-between py-3">
          <p className="text-xs leading-5 text-text-dim">{t('settings.sourcesRefreshDesc')}</p>
          <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}>
            {t('settings.sourcesRefresh')}
          </Button>
        </div>
      </SettingGroup>
    </div>
  );
}
