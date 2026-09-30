import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Skeleton } from '../../components/Skeleton';
import { useServices } from '../../services';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingBlock, SettingGroup, SettingRow } from './SettingRow';

interface Credit {
  name: string;
  url: string;
}

/** Proper nouns and their homepages — not translatable copy. */
const CREDITS: readonly Credit[] = [
  { name: 'Audius', url: 'https://audius.co' },
  { name: 'Jamendo', url: 'https://www.jamendo.com' },
  { name: 'Internet Archive', url: 'https://archive.org' },
  { name: 'Radio-Browser', url: 'https://www.radio-browser.info' },
  { name: 'MusicBrainz', url: 'https://musicbrainz.org' },
  { name: 'Cover Art Archive', url: 'https://coverartarchive.org' },
  { name: 'LRCLIB', url: 'https://lrclib.net' },
];

/** The app mark, inlined so About renders with no network and no asset import. */
function RitmoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" className={className}>
      <rect width="512" height="512" rx="116" className="fill-accent" />
      <g className="fill-on-accent">
        <rect x="112" y="214" width="42" height="84" rx="21" />
        <rect x="178" y="158" width="42" height="196" rx="21" />
        <rect x="244" y="110" width="42" height="292" rx="21" />
        <rect x="310" y="176" width="42" height="160" rx="21" />
        <rect x="376" y="236" width="42" height="40" rx="20" />
      </g>
    </svg>
  );
}

type Version = { app: string; platform: string; engine: string };
type State = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: Version };

export function AboutSection() {
  const { t } = useTranslation();
  const { host, engine } = useServices();
  const [version, setVersion] = useState<State>({ state: 'loading' });

  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setVersion({ state: 'loading' });
    void host
      .getVersion()
      .then((value) => {
        if (alive.current) setVersion({ state: 'ready', value });
      })
      .catch(() => {
        if (alive.current) setVersion({ state: 'error' });
      });
  }, [host]);

  useEffect(load, [load]);

  const value = version.state === 'ready' ? version.value : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4 rounded-lg border border-line bg-surface p-4">
        <RitmoMark className="h-16 w-16 shrink-0 rounded-lg" />
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-text">Ritmo</h3>
          <p className="mt-1 text-sm leading-6 text-text-dim">{t('settings.aboutTagline')}</p>
        </div>
      </div>

      {version.state === 'error' && (
        <ErrorBanner title={t('settings.aboutVersionFailed')} tone="warn" onRetry={load} />
      )}

      <SettingGroup title={t('settings.aboutBuild')}>
        <SettingRow
          label={t('settings.aboutVersion')}
          control={
            value === undefined ? (
              <Skeleton className="h-5 w-20" rounded="sm" />
            ) : (
              <span className="font-num text-sm tabular-nums text-text">{value.app}</span>
            )
          }
        />
        <SettingRow
          label={t('settings.aboutPlatform')}
          control={
            value === undefined ? (
              <Skeleton className="h-5 w-32" rounded="sm" />
            ) : (
              <span className="font-num text-sm text-text">{value.platform}</span>
            )
          }
        />
        <SettingRow
          label={t('settings.aboutEngine')}
          description={
            engine.kind === 'rust' ? t('settings.engineRustDesc') : t('settings.engineHtmlDesc')
          }
          control={
            value === undefined ? (
              <Skeleton className="h-5 w-24" rounded="sm" />
            ) : (
              <span className="font-num text-sm text-text">
                {t('settings.aboutEngineValue', { engine: value.engine, kind: engine.kind })}
              </span>
            )
          }
        />
      </SettingGroup>

      <SettingGroup
        title={t('settings.aboutCatalogues')}
        description={t('settings.aboutCataloguesBody')}
      >
        <SettingBlock>
          <ul className="flex flex-wrap gap-2">
            {CREDITS.map((credit) => (
              <li key={credit.url}>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('settings.openInBrowser', { name: credit.name })}
                  onClick={() => void host.openExternal(credit.url)}
                >
                  {credit.name}
                </Button>
              </li>
            ))}
          </ul>
        </SettingBlock>
        <SettingBlock>
          <p className="text-xs leading-5 text-text-dim">{t('settings.aboutLicence')}</p>
        </SettingBlock>
      </SettingGroup>
    </div>
  );
}
