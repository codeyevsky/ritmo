import clsx from 'clsx';
import { useId } from 'react';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
  className?: string;
}

export function Toggle({ checked, onChange, disabled = false, label, id, className }: ToggleProps) {
  const autoId = useId();
  const switchId = id ?? `toggle-${autoId}`;
  const labelId = `${switchId}-label`;

  const control = (
    <button
      type="button"
      id={switchId}
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? labelId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent',
        'transition-colors duration-200 ease-swift',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'disabled:pointer-events-none disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-surface-3',
        !label && className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none ml-0.5 h-5 w-5 rounded-full bg-bg shadow-card transition-transform duration-200 ease-swift',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );

  if (!label) return control;

  return (
    <span className={clsx('inline-flex items-center gap-3', className)}>
      {control}
      <label
        id={labelId}
        htmlFor={switchId}
        className={clsx('cursor-pointer select-none text-sm', disabled ? 'text-text-faint' : 'text-text')}
      >
        {label}
      </label>
    </span>
  );
}
