import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface BadgeProps {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger';
  className?: string;
}

/** Outlined, not filled: badges are annotations in the margin, not buttons. */
const TONE: Record<'neutral' | 'accent' | 'warn' | 'danger', string> = {
  neutral: 'border-line text-text-faint',
  accent: 'border-accent/50 text-accent',
  warn: 'border-warn/50 text-warn',
  danger: 'border-danger/50 text-danger',
};

export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'mono inline-flex h-[18px] items-center gap-1 rounded-xs border px-1 text-[10px] font-semibold uppercase tracking-[0.1em]',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
