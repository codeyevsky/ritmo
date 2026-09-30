import clsx from 'clsx';
import { forwardRef, useState } from 'react';
import type { ChangeEvent, InputHTMLAttributes, ReactNode } from 'react';
import { Close } from '../icons';
import { useTranslation } from '../hooks';
import type { IconComponent } from '../icons';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leading?: IconComponent;
  trailing?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  invalid?: boolean;
  /** Renders a clear button when non-empty. */
  clearable?: boolean;
  onClear?: () => void;
}

const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-8 text-[13px]',
  md: 'h-10 text-sm',
  lg: 'h-12 text-[15px]',
};

const ICON: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-[18px] w-[18px]',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    leading: Leading,
    trailing,
    size = 'md',
    invalid = false,
    clearable = false,
    onClear,
    className,
    value,
    defaultValue,
    onChange,
    disabled,
    type = 'text',
    ...rest
  },
  ref,
) {
  const { t } = useTranslation();
  const controlled = value !== undefined;
  const [uncontrolledFilled, setUncontrolledFilled] = useState(
    () => String(defaultValue ?? '').length > 0,
  );
  const filled = controlled ? String(value ?? '').length > 0 : uncontrolledFilled;
  const showClear = clearable && filled && !disabled;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!controlled) setUncontrolledFilled(event.currentTarget.value.length > 0);
    onChange?.(event);
  };

  return (
    <div
      className={clsx(
        'group relative flex items-center gap-2 rounded-lg border bg-surface-2 px-3',
        'transition-[border-color,background-color] duration-150 ease-swift',
        'focus-within:border-accent/70 focus-within:ring-2 focus-within:ring-accent/40',
        invalid ? 'border-danger' : 'border-transparent hover:border-line',
        disabled && 'opacity-50',
        SIZE[size],
        className,
      )}
    >
      {Leading ? (
        <Leading className={clsx('shrink-0 text-text-faint', ICON[size])} />
      ) : null}

      <input
        {...rest}
        ref={ref}
        type={type}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        {...(controlled ? { value } : { defaultValue })}
        onChange={handleChange}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-text placeholder:text-text-faint focus:outline-none"
      />

      {showClear ? (
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={onClear}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-text-faint transition-colors hover:bg-surface-3 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Close className="h-3 w-3" />
        </button>
      ) : null}

      {trailing ? <span className="flex shrink-0 items-center text-text-faint">{trailing}</span> : null}
    </div>
  );
});
