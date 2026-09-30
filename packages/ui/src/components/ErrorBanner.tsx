import clsx from 'clsx';
import { Close, Refresh, Warning } from '../icons';
import { useTranslation } from '../hooks';
import { Button } from './Button';
import { IconButton } from './IconButton';

export interface ErrorBannerProps {
  title: string;
  body?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  tone?: 'warn' | 'danger';
  className?: string;
}

export function ErrorBanner({
  title,
  body,
  onRetry,
  onDismiss,
  tone = 'danger',
  className,
}: ErrorBannerProps) {
  const { t } = useTranslation();
  const danger = tone === 'danger';

  return (
    <div
      role="alert"
      aria-live="polite"
      className={clsx(
        'flex items-start gap-3 rounded-lg border px-4 py-3',
        danger ? 'border-danger/35 bg-danger/10' : 'border-warn/35 bg-warn/10',
        className,
      )}
    >
      <Warning className={clsx('mt-0.5 h-[18px] w-[18px] shrink-0', danger ? 'text-danger' : 'text-warn')} />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-semibold text-text">{title}</p>
        {body ? <p className="text-[13px] leading-relaxed text-text-dim">{body}</p> : null}
      </div>

      {onRetry ? (
        <Button size="sm" variant="outline" leading={Refresh} onClick={onRetry} className="shrink-0">
          {t('common.retry')}
        </Button>
      ) : null}

      {onDismiss ? (
        <IconButton
          icon={Close}
          label={t('errors.dismiss')}
          size="sm"
          onClick={onDismiss}
          className="shrink-0"
        />
      ) : null}
    </div>
  );
}
