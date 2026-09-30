import clsx from 'clsx';
import type { IconComponent } from '../icons';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: IconComponent;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-4 px-6 py-14 text-center',
        className,
      )}
    >
      {Icon ? (
        <span className="grid h-14 w-14 place-items-center rounded-full bg-surface-2 text-text-faint">
          <Icon className="h-7 w-7" />
        </span>
      ) : null}

      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-balance text-lg font-bold text-text">{title}</h2>
        {body ? <p className="text-balance text-sm leading-relaxed text-text-dim">{body}</p> : null}
      </div>

      {action || secondaryAction ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action ? (
            <Button variant="primary" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button variant="ghost" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
