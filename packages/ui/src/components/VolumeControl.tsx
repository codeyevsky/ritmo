import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { Slider } from './Slider';
import { IconButton } from './IconButton';
import { VolumeHigh, VolumeLow, VolumeMute } from '../icons';
import { useTranslation } from '../hooks/useTranslation';

export interface VolumeControlProps {
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  className?: string;
}

const STEP = 0.05;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function quantize(v: number): number {
  return clamp(Math.round(v / STEP) * STEP, 0, 1);
}

export function VolumeControl({ volume, muted, onVolume, onToggleMute, className }: VolumeControlProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  const level = muted ? 0 : clamp(volume, 0, 1);
  const Icon = level === 0 ? VolumeMute : level < 0.5 ? VolumeLow : VolumeHigh;

  const live = useRef({ level, muted, onVolume, onToggleMute });
  live.current = { level, muted, onVolume, onToggleMute };

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // The Slider handles the wheel over its own box; only pick up the rest of
      // the control (the icon button and the gap).
      if (event.defaultPrevented) return;
      const primary = event.deltaX !== 0 ? event.deltaX : -event.deltaY;
      if (primary === 0) return;
      event.preventDefault();
      const current = live.current;
      const next = quantize(current.level + Math.sign(primary) * STEP);
      if (next === current.level) return;
      if (current.muted && next > 0) current.onToggleMute();
      current.onVolume(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleCommit = (value: number) => {
    const next = quantize(value);
    if (muted && next > 0) onToggleMute();
    onVolume(next);
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t('player.volume')}
      className={clsx('flex items-center gap-2', className)}
    >
      <IconButton
        icon={Icon}
        label={t('player.mute')}
        size="sm"
        active={muted}
        onClick={onToggleMute}
      />
      <Slider
        className="w-24"
        value={level}
        min={0}
        max={1}
        step={STEP}
        label={t('player.volume')}
        valueText={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => onVolume(quantize(v))}
        onCommit={handleCommit}
      />
    </div>
  );
}
