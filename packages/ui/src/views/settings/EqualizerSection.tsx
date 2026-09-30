import { useMemo } from 'react';
import { EQ_BANDS, EQ_PRESETS } from '@ritmo/core';
import type { EqualizerSettings } from '@ritmo/core';
import clsx from 'clsx';

import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { Slider } from '../../components/Slider';
import { Toggle } from '../../components/Toggle';
import { useServices } from '../../services';
import { useSettings } from '../../hooks/useSettings';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingBlock, SettingGroup, SettingRow } from './SettingRow';

/** Sentinel preset name for "the user moved a band by hand". */
const CUSTOM = 'custom';
const MAX_DB = 12;
const FLAT: number[] = EQ_PRESETS['Flat'] ?? EQ_BANDS.map(() => 0);

// Curve geometry, in viewBox units. The SVG stretches to the container width,
// so these are proportions rather than pixels.
const W = 600;
const H = 180;
const PAD_Y = 16;
const AXIS_MIN = 20;
const AXIS_MAX = 20_000;
const LOG_MIN = Math.log10(AXIS_MIN);
const LOG_SPAN = Math.log10(AXIS_MAX) - LOG_MIN;

const DB_GRID = [12, 6, 0, -6, -12] as const;

type Point = readonly [number, number];

function xForFreq(freq: number): number {
  return ((Math.log10(freq) - LOG_MIN) / LOG_SPAN) * W;
}

function yForDb(db: number): number {
  const span = (H - PAD_Y * 2) / 2;
  return H / 2 - (db / MAX_DB) * span;
}

function formatBand(freq: number): string {
  return freq >= 1000 ? `${freq / 1000}k` : String(freq);
}

function formatDb(db: number): string {
  const rounded = Math.round(db * 10) / 10;
  const body = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return rounded > 0 ? `+${body}` : body;
}

/**
 * Catmull-Rom through every band, converted to cubic béziers. A polyline would
 * show ten kinks where a real analyser shows one continuous response, and a
 * plain quadratic smoothing would not pass through the band values at all.
 */
function splinePath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const at = (i: number): Point => {
    const clamped = Math.min(Math.max(i, 0), points.length - 1);
    return points[clamped] ?? [0, H / 2];
  };
  const head = at(0);
  let d = `M ${head[0].toFixed(2)} ${head[1].toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d +=
      ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}` +
      ` ${c2x.toFixed(2)} ${c2y.toFixed(2)}` +
      ` ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

function ResponseCurve({ gains, muted, label }: { gains: number[]; muted: boolean; label: string }) {
  const { line, area, points } = useMemo(() => {
    const firstGain = gains[0] ?? 0;
    const lastGain = gains[EQ_BANDS.length - 1] ?? 0;
    // Flat tails past the outermost bands keep the curve spanning the full
    // axis, the way a hardware analyser draws 20Hz–20kHz.
    const inner: Point[] = EQ_BANDS.map((freq, i) => [xForFreq(freq), yForDb(gains[i] ?? 0)]);
    const all: Point[] = [[0, yForDb(firstGain)], ...inner, [W, yForDb(lastGain)]];
    const d = splinePath(all);
    const zero = yForDb(0).toFixed(2);
    return {
      line: d,
      area: d === '' ? '' : `${d} L ${W} ${zero} L 0 ${zero} Z`,
      points: inner,
    };
  }, [gains]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={clsx(
        'h-40 w-full rounded-md border border-line bg-bg transition-opacity duration-150 ease-swift',
        muted && 'opacity-40',
      )}
    >
      {DB_GRID.map((db) => (
        <g key={db}>
          <line
            x1={0}
            x2={W}
            y1={yForDb(db)}
            y2={yForDb(db)}
            className={db === 0 ? 'stroke-text-faint' : 'stroke-line'}
            strokeDasharray={db === 0 ? undefined : '3 5'}
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={6}
            y={yForDb(db) - 3}
            fontSize={9}
            className="fill-text-faint font-num"
          >
            {formatDb(db)}
          </text>
        </g>
      ))}
      {EQ_BANDS.map((freq) => (
        <line
          key={freq}
          x1={xForFreq(freq)}
          x2={xForFreq(freq)}
          y1={PAD_Y / 2}
          y2={H - PAD_Y / 2}
          className="stroke-line"
          strokeDasharray="2 6"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {area !== '' && <path d={area} className="fill-accent/15" />}
      {line !== '' && (
        <path
          d={line}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          className="stroke-accent"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {points.map(([cx, cy], i) => (
        <circle
          key={EQ_BANDS[i] ?? i}
          cx={cx}
          cy={cy}
          r={2.5}
          className="fill-accent"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

export function EqualizerSection() {
  const { t } = useTranslation();
  const { settings, patch } = useSettings();
  const { engine } = useServices();

  const eq = settings.equalizer;
  const supported = engine.supportsEqualizer;
  const active = eq.enabled && supported;
  const gains = eq.gains;

  const write = (next: Partial<EqualizerSettings>) => {
    patch({ equalizer: { ...eq, ...next } });
  };

  const setBand = (index: number, db: number) => {
    const next = EQ_BANDS.map((_, i) => (i === index ? db : gains[i] ?? 0));
    // Any hand move invalidates the named preset — silently keeping "Rock"
    // while the curve no longer matches it would be a lie.
    write({ gains: next, preset: CUSTOM });
  };

  const presetOptions = [
    ...Object.keys(EQ_PRESETS).map((name) => ({ value: name, label: name })),
    { value: CUSTOM, label: t('settings.eqPresetCustom') },
  ];

  const isFlat = gains.every((g, i) => g === (FLAT[i] ?? 0));

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup title={t('settings.equalizer')} description={t('settings.eqDesc')}>
        <SettingRow
          label={t('settings.eqEnabled')}
          description={supported ? t('settings.eqEnabledDesc') : t('settings.eqUnsupported')}
          htmlFor="setting-eq-enabled"
          control={
            <Toggle
              id="setting-eq-enabled"
              label={t('settings.eqEnabled')}
              checked={active}
              disabled={!supported}
              onChange={(enabled) => write({ enabled })}
            />
          }
        />
        <SettingRow
          label={t('settings.eqPreset')}
          description={t('settings.eqPresetDesc')}
          control={
            // `Select` has no `disabled` prop, and a disabled fieldset natively
            // takes every form control inside it out of the tab order.
            <fieldset disabled={!active} className="w-full sm:w-56">
              <Select
                value={presetOptions.some((o) => o.value === eq.preset) ? eq.preset : CUSTOM}
                label={t('settings.eqPreset')}
                options={presetOptions}
                className={clsx(!active && 'opacity-50')}
                onChange={(preset) => {
                  if (preset === CUSTOM) {
                    write({ preset: CUSTOM });
                    return;
                  }
                  write({ preset, gains: [...(EQ_PRESETS[preset] ?? FLAT)] });
                }}
              />
            </fieldset>
          }
        />

        <SettingBlock>
          <ResponseCurve gains={gains} muted={!active} label={t('settings.eqCurve')} />

          <div
            className={clsx(
              'mt-4 flex items-stretch justify-between gap-1 transition-opacity duration-150 ease-swift',
              !active && 'opacity-40',
            )}
          >
            {EQ_BANDS.map((freq, i) => {
              const value = gains[i] ?? 0;
              return (
                <div key={freq} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                  <span className="font-num text-[11px] tabular-nums text-text-dim">
                    {formatDb(value)}
                  </span>
                  <Slider
                    orientation="vertical"
                    className="h-32"
                    label={t('settings.eqBandLabel', { freq: formatBand(freq) })}
                    value={value}
                    min={-MAX_DB}
                    max={MAX_DB}
                    step={0.5}
                    disabled={!active}
                    onChange={(db) => setBand(i, db)}
                  />
                  <span className="font-num text-[11px] tabular-nums text-text-faint">
                    {formatBand(freq)}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-text-dim">{t('settings.eqHint')}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={!active || (isFlat && eq.preset === 'Flat')}
              onClick={() => write({ gains: [...FLAT], preset: 'Flat' })}
            >
              {t('settings.eqReset')}
            </Button>
          </div>
        </SettingBlock>
      </SettingGroup>
    </div>
  );
}
