import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Close } from '../icons';
import { useTranslation } from '../hooks';

export interface ChipProps {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  className?: string;
}

export function Chip({ children, selected = false, onClick, onRemove, className }: ChipProps) {
  const { t } = useTranslation();

  // A compact bordered control rather than a pill: the same family as a
  // toolbar toggle in a desktop app.
  const tone = selected
    ? 'border-accent bg-accent/12 text-accent'
    : 'border-line bg-transparent text-text-dim hover:border-accent/50 hover:text-text';

  const shell =
    'inline-flex h-7 max-w-full items-center gap-1.5 rounded-sm border pl-2 text-[12px] transition-colors duration-150 ease-swift';

  const body = <span className="truncate">{children}</span>;

  return (
    <span className={clsx(shell, tone, onRemove ? 'pr-0.5' : 'pr-2', className)}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={selected}
          className="min-w-0 truncate rounded-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {body}
        </button>
      ) : (
        body
      )}

      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('common.close')}
          className={clsx(
            'grid h-5 w-5 shrink-0 place-items-center rounded-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            selected ? 'hover:bg-accent/20' : 'hover:bg-surface-3',
          )}
        >
          <Close className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}
