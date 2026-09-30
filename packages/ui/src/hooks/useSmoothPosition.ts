import { useEffect, useRef, useState } from 'react';

import { usePlayerStore } from '../store/player';

function query(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return window.matchMedia('(prefers-reduced-motion: reduce)');
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = (): void => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

/**
 * Interpolates the engine's ~4 Hz progress events up to display rate.
 *
 * Nothing is written back to the store on purpose: a 60 Hz store write would
 * re-render every selector in the shell, so only the component drawing the
 * playhead pays for the animation.
 */
export function useSmoothPosition(): number {
  const positionMs = usePlayerStore((s) => s.positionMs);
  const durationMs = usePlayerStore((s) => s.durationMs);
  const status = usePlayerStore((s) => s.status);
  const scrubbing = usePlayerStore((s) => s.scrubbing);
  const reduced = usePrefersReducedMotion();

  const [smooth, setSmooth] = useState(positionMs);
  /** Wall-clock anchor for the last authoritative position we were given. */
  const anchor = useRef({ at: 0, positionMs });

  useEffect(() => {
    anchor.current = { at: performance.now(), positionMs };
    setSmooth(positionMs);
  }, [positionMs]);

  useEffect(() => {
    if (reduced || scrubbing || status !== 'playing') return;

    let frame = 0;
    const tick = (): void => {
      const elapsed = performance.now() - anchor.current.at;
      const next = anchor.current.positionMs + elapsed;
      setSmooth(durationMs > 0 ? Math.min(next, durationMs) : next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced, scrubbing, status, durationMs]);

  // While dragging, the store value is frozen at the drag start and is exactly
  // what the seek bar wants to render behind its own thumb.
  if (reduced || scrubbing || status !== 'playing') return positionMs;
  return durationMs > 0 ? Math.min(smooth, durationMs) : smooth;
}
