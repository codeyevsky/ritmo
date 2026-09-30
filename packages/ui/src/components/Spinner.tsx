import clsx from 'clsx';
import { useTranslation } from '../hooks';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-3.5 w-3.5 border-[1.5px]',
  md: 'h-5 w-5 border-2',
  lg: 'h-8 w-8 border-[2.5px]',
};

export function Spinner({ size = 'md', className }: SpinnerProps) {
  const { t } = useTranslation();
  return (
    <span role="status" aria-label={t('common.loading')} className={clsx('inline-flex', className)}>
      <span
        aria-hidden="true"
        className={clsx(
          'inline-block animate-spin rounded-full border-current border-b-transparent border-l-transparent opacity-80',
          SIZE[size],
        )}
      />
    </span>
  );
}
