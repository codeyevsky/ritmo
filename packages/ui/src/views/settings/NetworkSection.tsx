import type { Settings } from '@ritmo/core';

import { SegmentedControl } from '../../components/SegmentedControl';
import { Toggle } from '../../components/Toggle';
import { useSettings } from '../../hooks/useSettings';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingGroup, SettingRow } from './SettingRow';

type Quality = Settings['preferredQuality'];

export function NetworkSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();

  const qualityItems: Array<{ id: Quality; label: string }> = [
    { id: 'low', label: t('settings.qualityLow') },
    { id: 'medium', label: t('settings.qualityMedium') },
    { id: 'high', label: t('settings.qualityHigh') },
    { id: 'lossless', label: t('settings.qualityLossless') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup title={t('settings.network')}>
        <SettingRow
          label={t('settings.quality')}
          description={t('settings.qualityDesc')}
          control={
            <SegmentedControl
              items={qualityItems}
              value={settings.preferredQuality}
              onChange={(preferredQuality) => patch({ preferredQuality })}
            />
          }
        />
        <div className="border-b border-line pb-3 text-xs leading-5 text-text-dim">
          {t('settings.qualityNote')}
        </div>
        <SettingRow
          label={t('settings.offlineMode')}
          description={t('settings.offlineModeDesc')}
          htmlFor="setting-offline"
          control={
            <Toggle
              id="setting-offline"
              label={t('settings.offlineMode')}
              checked={settings.offlineMode}
              onChange={(offlineMode) => patch({ offlineMode })}
            />
          }
        />
        {settings.offlineMode && (
          <p
            aria-live="polite"
            className="pb-3 text-xs leading-5 text-warn"
          >
            {t('settings.offlineModeWarning')}
          </p>
        )}
      </SettingGroup>
    </div>
  );
}
