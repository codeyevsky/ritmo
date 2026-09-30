import { useEffect, useRef } from 'react';
import clsx from 'clsx';

export interface VisualizerProps {
  /** 0..1 magnitudes, refreshed by the caller. */
  getSpectrum: (bins: number) => Float32Array | undefined;
  bins?: number;
  active: boolean;
  className?: string;
}

/** Re-reading the accent every frame would cost a style recalc per frame. */
const ACCENT_REFRESH_FRAMES = 30;

export function Visualizer({ getSpectrum, bins = 48, active, className }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let running = false;
    let onScreen = true;
    let width = 0;
    let height = 0;
    let frames = 0;
    let accent = 'rgb(18 226 154)';
    const levels = new Float32Array(bins);

    const readAccent = () => {
      const triplet = getComputedStyle(canvas).getPropertyValue('--c-accent').trim();
      if (triplet !== '') accent = `rgb(${triplet})`;
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readAccent();
    };

    const draw = (now: number) => {
      if (frames % ACCENT_REFRESH_FRAMES === 0) readAccent();
      frames += 1;

      const spectrum = getSpectrum(bins);
      for (let i = 0; i < bins; i += 1) {
        const raw = spectrum?.[i];
        const target =
          raw === undefined
            ? // Idle: a slow travelling swell so the panel never looks broken.
              0.08 + 0.1 * (0.5 + 0.5 * Math.sin(now / 620 + i * 0.38))
            : Math.max(0, Math.min(1, raw));
        const prev = levels[i] ?? 0;
        // Asymmetric smoothing: snap up to transients, fall away gently.
        levels[i] = target > prev ? prev + (target - prev) * 0.55 : prev + (target - prev) * 0.16;
      }

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = accent;
      const slot = width / bins;
      const barW = Math.max(1, slot * 0.62);
      const radius = Math.min(barW / 2, 3);
      for (let i = 0; i < bins; i += 1) {
        const level = levels[i] ?? 0;
        const h = Math.max(2, level * height);
        const x = i * slot + (slot - barW) / 2;
        const y = height - h;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, radius);
        ctx.fill();
      }
    };

    const sync = () => {
      const should = active && onScreen && !document.hidden;
      if (should && !running) {
        running = true;
        raf = requestAnimationFrame(frame);
      } else if (!should && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    function frame(now: number) {
      if (!running) return;
      draw(now);
      raf = requestAnimationFrame(frame);
    }

    const ro = new ResizeObserver(() => {
      resize();
      if (!running) draw(performance.now());
    });
    ro.observe(canvas);

    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      sync();
    });
    io.observe(canvas);

    document.addEventListener('visibilitychange', sync);

    resize();
    draw(performance.now());
    sync();

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [active, bins, getSpectrum]);

  return <canvas ref={canvasRef} aria-hidden="true" className={clsx('block h-full w-full', className)} />;
}
