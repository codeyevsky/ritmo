import { useId } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface SettingRowProps {
  label: string;
  description?: string;
  control: ReactNode;
  htmlFor?: string;
  danger?: boolean;
  className?: string;
}

/**
 * One label/description ↔ control pair. Rows stack on narrow widths instead of
 * squeezing the control, because sliders and selects become unusable below
 * roughly 180px.
 */
export function SettingRow({
  label,
  description,
  control,
  htmlFor,
  danger = false,
  className,
}: SettingRowProps) {
  const labelClass = clsx(
    'block text-sm font-medium leading-5',
    danger ? 'text-danger' : 'text-text',
  );

  return (
    <div
      className={clsx(
        'flex min-h-12 flex-col gap-2 border-b border-line py-3 last:border-b-0',
        'sm:flex-row sm:items-center sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {htmlFor === undefined ? (
          <span className={labelClass}>{label}</span>
        ) : (
          <label className={clsx(labelClass, 'cursor-pointer')} htmlFor={htmlFor}>
            {label}
          </label>
        )}
        {description !== undefined && (
          <p className="mt-0.5 text-xs leading-5 text-text-dim">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-start sm:justify-end">{control}</div>
    </div>
  );
}

export interface SettingGroupProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/** A titled card. Sections are built out of these, never out of bare rows. */
export function SettingGroup({ title, description, children, className }: SettingGroupProps) {
  const headingId = useId();

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={clsx('rounded-lg border border-line bg-surface', className)}
    >
      <div className="px-4 pt-4">
        <h3 id={headingId} className="text-sm font-semibold text-text">
          {title}
        </h3>
        {description !== undefined && (
          <p className="mt-1 text-xs leading-5 text-text-dim">{description}</p>
        )}
      </div>
      <div className="px-4 pb-2">{children}</div>
    </div>
  );
}

/**
 * A control too wide for a row (the EQ bank, the folder list). Kept here so
 * every section shares the same vertical rhythm as `SettingRow`.
 */
export interface SettingBlockProps {
  label?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function SettingBlock({ label, description, children, className }: SettingBlockProps) {
  return (
    <div className={clsx('border-b border-line py-3 last:border-b-0', className)}>
      {label !== undefined && (
        <span className="block text-sm font-medium leading-5 text-text">{label}</span>
      )}
      {description !== undefined && (
        <p className="mt-0.5 text-xs leading-5 text-text-dim">{description}</p>
      )}
      <div className={clsx(label !== undefined || description !== undefined ? 'mt-3' : undefined)}>
        {children}
      </div>
    </div>
  );
}
