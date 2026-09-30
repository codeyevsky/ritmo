import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Close } from '../icons';
import { useTranslation } from '../hooks/useTranslation';

export interface ToastSpec {
  id: string;
  title: string;
  body?: string;
  tone?: 'neutral' | 'success' | 'warn' | 'danger';
  /** ms; 0 keeps it until dismissed, unless `progress` reports the work done. */
  durationMs?: number;
  action?: { label: string; onClick: () => void };
  /** 0..1 — renders a progress bar, used by the library scan and downloads. */
  progress?: number;
}

export interface ToastProps {
  toast: ToastSpec;
  onDismiss: (id: string) => void;
  className?: string;
}

export const TOAST_DEFAULT_DURATION_MS = 4000;

const TONE_BAR: Record<NonNullable<ToastSpec['tone']>, string> = {
  neutral: 'bg-text-faint',
  success: 'bg-accent',
  warn: 'bg-warn',
  danger: 'bg-danger',
};

/**
 * The countdown line is a lifetime, not a measurement, so it reads fainter than
 * the determinate progress bar above it and never shares its accent fill.
 */
const TONE_COUNTDOWN: Record<NonNullable<ToastSpec['tone']>, string> = {
  neutral: 'bg-text-faint/50',
  success: 'bg-accent/50',
  warn: 'bg-warn/50',
  danger: 'bg-danger/50',
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function Toast({ toast, onDismiss, className }: ToastProps) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(false);

  const tone = toast.tone ?? 'neutral';
  const progress = toast.progress === undefined ? undefined : clamp(toast.progress, 0, 1);
  const percent = progress === undefined ? 0 : Math.round(progress * 100);

  // Every long operation pushes its toast sticky and re-pushes it as the work
  // advances, so a sticky toast reporting full progress is a finished one: it
  // starts the normal countdown here rather than at a dozen call sites. A
  // sticky toast with no progress at all is asking for attention and stays.
  const declared = toast.durationMs ?? TOAST_DEFAULT_DURATION_MS;
  const duration = declared <= 0 && progress === 1 ? TOAST_DEFAULT_DURATION_MS : declared;
  const remaining = useRef(duration);

  // A re-push with the same id updates in place; only a changed lifetime should
  // restart the countdown, so live progress updates never extend it.
  useEffect(() => {
    remaining.current = duration;
  }, [toast.id, duration]);

  useEffect(() => {
    if (duration <= 0 || paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [duration, paused, toast.id, onDismiss]);

  return (
    <div
      role={tone === 'danger' || tone === 'warn' ? 'alert' : 'status'}
      aria-live={tone === 'danger' || tone === 'warn' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={clsx(
        'pointer-events-auto relative w-full animate-slide-up overflow-hidden rounded-lg border border-line bg-surface-2 pl-3 shadow-pop',
        className,
      )}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span aria-hidden="true" className={clsx('absolute inset-y-0 left-0 w-0.5', TONE_BAR[tone])} />

      <div className="flex items-start gap-2 px-2 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-text">{toast.title}</p>
          {toast.body !== undefined && (
            <p className="mt-0.5 text-[12px] leading-snug text-text-dim">{toast.body}</p>
          )}
          {progress !== undefined && (
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label={toast.title}
              className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-3"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200 ease-swift"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>

        {toast.action && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </Button>
        )}

        <IconButton
          icon={Close}
          label={t('common.close')}
          size="xs"
          className="shrink-0"
          onClick={() => onDismiss(toast.id)}
        />
      </div>

      {duration > 0 ? (
        <span
          // Keyed on the lifetime so a re-push that grants new time restarts the
          // line together with the timer; a progress update leaves both alone.
          key={`${toast.id}:${duration}`}
          aria-hidden="true"
          className={clsx(
            'toast-countdown absolute bottom-0 left-0.5 right-0 h-0.5',
            TONE_COUNTDOWN[tone],
          )}
          style={{
            animationDuration: `${duration}ms`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
        />
      ) : null}
    </div>
  );
}
