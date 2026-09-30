import { useEffect, useState } from 'react';
import type { AudioEngine } from '@ritmo/core';

import { Select } from '../../components/Select';
import { Slider } from '../../components/Slider';
import { Toggle } from '../../components/Toggle';
import { useServices } from '../../services';
import { useSettings } from '../../hooks/useSettings';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingGroup, SettingRow } from './SettingRow';

const DEVICE_KV_KEY = 'audio:outputDevice';
const DEFAULT_DEVICE = '';

interface AudioDevice {
  id: string;
  name: string;
}

/**
 * Output-device switching is not part of the frozen `AudioEngine` contract, so
 * it is feature-detected rather than assumed: the row appears only on an engine
 * build that actually implements both halves, and stays hidden otherwise
 * instead of offering a control that silently does nothing.
 */
interface DeviceCapable {
  listAudioDevices(): Promise<AudioDevice[]>;
  setAudioDevice(id: string): Promise<void>;
}

function deviceCapable(engine: AudioEngine): (AudioEngine & DeviceCapable) | undefined {
  const candidate = engine as AudioEngine & Partial<DeviceCapable>;
  return typeof candidate.listAudioDevices === 'function' &&
    typeof candidate.setAudioDevice === 'function'
    ? (candidate as AudioEngine & DeviceCapable)
    : undefined;
}

function secondsLabel(t: (k: 'settings.secondsValue', p?: Record<string, string | number>) => string, seconds: number): string {
  return t('settings.secondsValue', { n: seconds % 1 === 0 ? seconds : seconds.toFixed(1) });
}

function ValueLabel({ children }: { children: string }) {
  return (
    <span className="w-24 shrink-0 text-right font-num text-xs tabular-nums text-text-dim">
      {children}
    </span>
  );
}

export function PlaybackSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();
  const { engine, host } = useServices();

  const devices = deviceCapable(engine);
  const [deviceList, setDeviceList] = useState<AudioDevice[] | undefined>(undefined);
  const [deviceId, setDeviceId] = useState<string>(DEFAULT_DEVICE);
  const [deviceError, setDeviceError] = useState(false);

  useEffect(() => {
    if (devices === undefined || engine.kind !== 'rust') return;
    let alive = true;
    void (async () => {
      try {
        const [list, stored] = await Promise.all([
          devices.listAudioDevices(),
          host.kv.get(DEVICE_KV_KEY),
        ]);
        if (!alive) return;
        setDeviceList(list);
        setDeviceId(stored ?? DEFAULT_DEVICE);
        setDeviceError(false);
      } catch {
        if (alive) {
          setDeviceList([]);
          setDeviceError(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [devices, engine.kind, host]);

  const crossfadeSeconds = settings.crossfadeMs / 1000;
  const skipSeconds = Math.round(settings.skipShorterThanMs / 1000);
  const gaplessBlocked = !engine.supportsGapless;

  const selectDevice = (id: string) => {
    setDeviceId(id);
    void (async () => {
      try {
        if (devices !== undefined) await devices.setAudioDevice(id);
        await host.kv.set(DEVICE_KV_KEY, id);
        setDeviceError(false);
      } catch {
        setDeviceError(true);
      }
    })();
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup title={t('settings.transitions')}>
        <SettingRow
          label={t('settings.crossfade')}
          description={t('settings.crossfadeDesc')}
          control={
            <div className="flex w-full items-center gap-3 sm:w-64">
              <Slider
                className="flex-1"
                label={t('settings.crossfade')}
                value={crossfadeSeconds}
                min={0}
                max={12}
                step={0.5}
                onChange={(v) => patch({ crossfadeMs: Math.round(v * 1000) })}
              />
              <ValueLabel>
                {settings.crossfadeMs === 0
                  ? t('settings.crossfadeOff')
                  : secondsLabel(t, crossfadeSeconds)}
              </ValueLabel>
            </div>
          }
        />
        <SettingRow
          label={t('settings.gapless')}
          description={
            gaplessBlocked ? t('settings.gaplessUnsupported') : t('settings.gaplessDesc')
          }
          htmlFor="setting-gapless"
          control={
            <Toggle
              id="setting-gapless"
              label={t('settings.gapless')}
              // The HTML engine cannot pre-decode, so leaving this on would
              // promise a seam-free transition it can never deliver.
              checked={settings.gapless && !gaplessBlocked}
              disabled={gaplessBlocked}
              onChange={(gapless) => patch({ gapless })}
            />
          }
        />
        <SettingRow
          label={t('settings.skipShort')}
          description={t('settings.skipShortDesc')}
          control={
            <div className="flex w-full items-center gap-3 sm:w-64">
              <Slider
                className="flex-1"
                label={t('settings.skipShort')}
                value={skipSeconds}
                min={0}
                max={30}
                step={1}
                onChange={(v) => patch({ skipShorterThanMs: Math.round(v) * 1000 })}
              />
              <ValueLabel>
                {skipSeconds === 0 ? t('settings.skipShortOff') : secondsLabel(t, skipSeconds)}
              </ValueLabel>
            </div>
          }
        />
      </SettingGroup>

      <SettingGroup title={t('settings.loudness')}>
        <SettingRow
          label={t('settings.normalizeVolume')}
          description={t('settings.normalizeVolumeDesc')}
          htmlFor="setting-normalize"
          control={
            <Toggle
              id="setting-normalize"
              label={t('settings.normalizeVolume')}
              checked={settings.normalizeVolume}
              disabled={!engine.supportsReplayGain}
              onChange={(normalizeVolume) => patch({ normalizeVolume })}
            />
          }
        />
        {settings.normalizeVolume && engine.supportsReplayGain && (
          <SettingRow
            label={t('settings.preamp')}
            description={t('settings.preampDesc')}
            control={
              <div className="flex w-full items-center gap-3 sm:w-64">
                <Slider
                  className="flex-1"
                  label={t('settings.preamp')}
                  value={settings.preampDb}
                  min={-12}
                  max={12}
                  step={0.5}
                  onChange={(preampDb) => patch({ preampDb })}
                />
                <ValueLabel>
                  {t('settings.decibelValue', {
                    n: `${settings.preampDb > 0 ? '+' : ''}${settings.preampDb.toFixed(1)}`,
                  })}
                </ValueLabel>
              </div>
            }
          />
        )}
        <SettingRow
          label={t('settings.monoDownmix')}
          description={t('settings.monoDownmixDesc')}
          htmlFor="setting-mono"
          control={
            <Toggle
              id="setting-mono"
              label={t('settings.monoDownmix')}
              checked={settings.monoDownmix}
              onChange={(monoDownmix) => patch({ monoDownmix })}
            />
          }
        />
      </SettingGroup>

      {engine.kind === 'rust' && devices !== undefined && (
        <SettingGroup title={t('settings.output')}>
          <SettingRow
            label={t('settings.audioDevice')}
            description={t('settings.audioDeviceDesc')}
            control={
              <div className="w-full sm:w-64">
                <Select
                  value={deviceId}
                  label={t('settings.audioDevice')}
                  options={[
                    { value: DEFAULT_DEVICE, label: t('settings.audioDeviceDefault') },
                    ...(deviceList ?? []).map((d) => ({ value: d.id, label: d.name })),
                  ]}
                  onChange={selectDevice}
                />
              </div>
            }
          />
          <p aria-live="polite" className="pb-3 text-xs leading-5 text-text-dim">
            {deviceError
              ? t('settings.audioDeviceFailed')
              : deviceList === undefined
                ? t('settings.audioDeviceLoading')
                : ''}
          </p>
        </SettingGroup>
      )}
    </div>
  );
}
