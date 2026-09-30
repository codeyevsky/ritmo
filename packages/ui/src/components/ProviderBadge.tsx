import clsx from 'clsx';
import type { ProviderId } from '@ritmo/core';
import { useTranslation } from '../hooks/useTranslation';

export interface ProviderBadgeProps {
  provider: ProviderId;
  size?: 'sm' | 'md';
  withLabel?: boolean;
  className?: string;
}

/** Outlined tags; tints stay inside the token palette so themes still apply. */
const TAG: Record<ProviderId, string> = {
  local: 'border-line text-text-faint',
  audius: 'border-accent/50 text-accent',
  jamendo: 'border-warn/50 text-warn',
  archive: 'border-line text-text-dim',
  radio: 'border-danger/50 text-danger',
};

const DOT: Record<ProviderId, string> = {
  local: 'bg-text-faint',
  audius: 'bg-accent',
  jamendo: 'bg-warn',
  archive: 'bg-text-dim',
  radio: 'bg-danger',
};

/** Brand names are proper nouns and identical in every language. */
const BRAND: Record<ProviderId, string | undefined> = {
  local: undefined,
  audius: 'Audius',
  jamendo: 'Jamendo',
  archive: 'Internet Archive',
  radio: undefined,
};

export function ProviderBadge({ provider, size = 'sm', withLabel = true, className }: ProviderBadgeProps) {
  const { t } = useTranslation();
  const label =
    BRAND[provider] ?? (provider === 'radio' ? t('nav.radio') : t('nav.local'));
  const described = t('common.providerBadge', { provider: label });

  if (!withLabel) {
    return (
      <span
        role="img"
        aria-label={described}
        title={described}
        className={clsx(
          'inline-block shrink-0 rounded-full',
          size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2',
          DOT[provider],
          className,
        )}
      />
    );
  }

  return (
    <span
      title={described}
      className={clsx(
        'mono inline-flex shrink-0 items-center gap-1.5 rounded-xs border uppercase tracking-[0.08em]',
        size === 'md' ? 'px-1.5 py-0.5 text-[11px]' : 'px-1 py-px text-[10px]',
        TAG[provider],
        className,
      )}
    >
      <span aria-hidden="true" className="h-1 w-1 rounded-full bg-current" />
      <span className="truncate">{label}</span>
    </span>
  );
}
