import type { Settings } from '@ritmo/core';
import { LANGS } from '@ritmo/core';
import clsx from 'clsx';

import { Select } from '../../components/Select';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useSettings } from '../../hooks/useSettings';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingBlock, SettingGroup, SettingRow } from './SettingRow';

type Theme = Settings['theme'];
type Density = Settings['density'];

interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  text: string;
  dim: string;
}

/**
 * A theme tile has to paint the palette it is *offering*, not the one currently
 * applied, so it cannot read the `--c-*` variables — they always describe the
 * active theme. These triplets therefore mirror `styles/globals.css` by hand;
 * they are preview data, not component styling.
 */
const PALETTES: Record<'dark' | 'light' | 'oled', Palette> = {
  dark: {
    bg: 'rgb(10 11 13)',
    surface: 'rgb(20 22 26)',
    surface2: 'rgb(28 31 36)',
    line: 'rgb(44 48 55)',
    text: 'rgb(244 245 247)',
    dim: 'rgb(161 167 176)',
  },
  light: {
    bg: 'rgb(255 255 255)',
    surface: 'rgb(246 247 249)',
    surface2: 'rgb(238 240 244)',
    line: 'rgb(221 224 230)',
    text: 'rgb(16 18 22)',
    dim: 'rgb(94 100 110)',
  },
  oled: {
    bg: 'rgb(0 0 0)',
    surface: 'rgb(9 9 11)',
    surface2: 'rgb(17 17 20)',
    line: 'rgb(32 32 36)',
    text: 'rgb(244 245 247)',
    dim: 'rgb(161 167 176)',
  },
};

const ACCENT_PRESETS = [
  '#1793d1', // Arch blue — the default
  '#4fb8e8',
  '#5e81ac',
  '#8b5cf6',
  '#e06c9f',
  '#ef4444',
  '#f59e0b',
  '#12b886',
] as const;

const THEME_LABEL_KEYS = {
  dark: 'settings.themeDark',
  light: 'settings.themeLight',
  oled: 'settings.themeOled',
} as const;

const THEME_ORDER: readonly Theme[] = ['dark', 'light', 'oled'];

/** The miniature app: sidebar, a shelf of cards, a track list and the player bar. */
function Mock({ palette, className }: { palette: Palette; className?: string }) {
  return (
    <div
      className={clsx('flex h-full w-full flex-col', className)}
      style={{ backgroundColor: palette.bg }}
    >
      <div className="flex min-h-0 flex-1">
        <div
          className="flex w-1/4 flex-col gap-[3px] p-[4px]"
          style={{ backgroundColor: palette.surface }}
        >
          <div className="h-[3px] w-3/4 rounded-full" style={{ backgroundColor: palette.text }} />
          <div className="h-[3px] w-full rounded-full" style={{ backgroundColor: palette.dim }} />
          <div className="h-[3px] w-2/3 rounded-full" style={{ backgroundColor: palette.dim }} />
          <div className="h-[3px] w-5/6 rounded-full" style={{ backgroundColor: palette.line }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[4px] p-[5px]">
          <div className="h-[4px] w-1/2 rounded-full" style={{ backgroundColor: palette.text }} />
          <div className="flex gap-[4px]">
            <div className="h-[14px] flex-1 rounded-[2px]" style={{ backgroundColor: palette.surface2 }} />
            <div className="h-[14px] flex-1 rounded-[2px]" style={{ backgroundColor: palette.surface2 }} />
            <div className="h-[14px] flex-1 rounded-[2px]" style={{ backgroundColor: palette.surface2 }} />
          </div>
          <div className="flex flex-col gap-[3px]">
            <div className="h-[3px] w-full rounded-full" style={{ backgroundColor: palette.line }} />
            <div className="h-[3px] w-5/6 rounded-full" style={{ backgroundColor: palette.line }} />
            <div className="h-[3px] w-2/3 rounded-full" style={{ backgroundColor: palette.line }} />
          </div>
        </div>
      </div>
      <div
        className="flex items-center gap-[4px] px-[5px] py-[4px]"
        style={{ backgroundColor: palette.surface, borderTop: `1px solid ${palette.line}` }}
      >
        <div className="h-[8px] w-[8px] rounded-[2px]" style={{ backgroundColor: palette.surface2 }} />
        <div className="h-[3px] flex-1 rounded-full bg-accent" />
        <div className="h-[6px] w-[6px] rounded-full bg-accent" />
      </div>
    </div>
  );
}

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();

  const densityItems: Array<{ id: Density; label: string }> = [
    { id: 'comfortable', label: t('settings.densityComfortable') },
    { id: 'compact', label: t('settings.densityCompact') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup title={t('settings.theme')} description={t('settings.themeDesc')}>
        <SettingBlock>
          <div
            role="radiogroup"
            aria-label={t('settings.theme')}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3"
          >
            {THEME_ORDER.map((theme) => {
              const active = settings.theme === theme;
              return (
                <label key={theme} className="group cursor-pointer">
                  <input
                    type="radio"
                    name="ritmo-theme"
                    className="peer sr-only"
                    value={theme}
                    checked={active}
                    onChange={() => patch({ theme })}
                  />
                  <span
                    className={clsx(
                      'block aspect-[4/3] overflow-hidden rounded-md border transition-colors duration-150 ease-swift',
                      'peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface',
                      active ? 'border-accent ring-2 ring-accent' : 'border-line group-hover:border-text-faint',
                    )}
                  >
                    <Mock palette={PALETTES[theme]} />
                  </span>
                  <span
                    className={clsx(
                      'mt-2 block text-center text-xs font-medium',
                      active ? 'text-text' : 'text-text-dim',
                    )}
                  >
                    {t(THEME_LABEL_KEYS[theme])}
                  </span>
                </label>
              );
            })}
          </div>
        </SettingBlock>
      </SettingGroup>

      <SettingGroup title={t('settings.accent')} description={t('settings.accentDesc')}>
        <SettingBlock>
          <div
            role="radiogroup"
            aria-label={t('settings.accent')}
            className="flex flex-wrap items-center gap-3"
          >
            <label className="cursor-pointer">
              <input
                type="radio"
                name="ritmo-accent"
                className="peer sr-only"
                value="wallpaper"
                checked={settings.accent === 'wallpaper'}
                onChange={() => patch({ accent: 'wallpaper' })}
              />
              <span
                className={clsx(
                  'flex h-9 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-swift',
                  'peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
                  settings.accent === 'wallpaper'
                    ? 'border-accent bg-accent/10 text-text ring-2 ring-accent'
                    : 'border-line text-text-dim hover:border-text-faint',
                )}
              >
                {t('settings.accentWallpaper')}
              </span>
            </label>
            {ACCENT_PRESETS.map((hex) => {
              const active = settings.accent.toLowerCase() === hex;
              return (
                <label key={hex} className="cursor-pointer">
                  <input
                    type="radio"
                    name="ritmo-accent"
                    className="peer sr-only"
                    value={hex}
                    checked={active}
                    onChange={() => patch({ accent: hex })}
                  />
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'block h-9 w-9 rounded-full border transition-transform duration-150 ease-swift',
                      'peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface',
                      active
                        ? 'border-text scale-105 ring-2 ring-text ring-offset-2 ring-offset-surface'
                        : 'border-line hover:scale-105',
                    )}
                    style={{ backgroundColor: hex }}
                  />
                  <span className="sr-only">{hex}</span>
                </label>
              );
            })}
          </div>
        </SettingBlock>
      </SettingGroup>

      <SettingGroup title={t('settings.interface')}>
        <SettingRow
          label={t('settings.language')}
          description={t('settings.languageDesc')}
          control={
            <Select
              value={settings.language}
              label={t('settings.language')}
              options={LANGS.map((l) => ({ value: l.id, label: l.label }))}
              onChange={(language) => patch({ language })}
            />
          }
        />
        <SettingRow
          label={t('settings.density')}
          description={t('settings.densityDesc')}
          control={
            <SegmentedControl
              items={densityItems}
              value={settings.density}
              onChange={(density) => patch({ density })}
            />
          }
        />
      </SettingGroup>
    </div>
  );
}
