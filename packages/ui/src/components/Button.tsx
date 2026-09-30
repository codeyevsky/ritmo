import clsx from 'clsx';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import type { IconComponent } from '../icons';
import { Spinner } from './Spinner';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'outline' | 'subtle' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  leading?: IconComponent;
  trailing?: IconComponent;
  full?: boolean;
}

const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-[15px]',
};

const GAP: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'gap-1.5',
  md: 'gap-2',
  lg: 'gap-2.5',
};

const ICON_BOX: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-4 w-4',
  md: 'h-[18px] w-[18px]',
  lg: 'h-5 w-5',
};

const VARIANT: Record<'primary' | 'ghost' | 'outline' | 'subtle' | 'danger', string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover hover:scale-[1.03] active:scale-[0.98]',
  ghost: 'bg-transparent text-text-dim hover:bg-surface-2 hover:text-text active:scale-[0.98]',
  outline:
    'border border-line bg-transparent text-text hover:border-text-faint hover:bg-surface-2/60 active:scale-[0.98]',
  subtle: 'bg-surface-2 text-text hover:bg-surface-3 active:scale-[0.98]',
  danger: 'bg-danger text-white hover:brightness-110 active:scale-[0.98]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'subtle',
    size = 'md',
    loading = false,
    leading: Leading,
    trailing: Trailing,
    full = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  // With a leading icon the spinner takes its slot; without one it overlays the
  // (still laid out) label, so the button never changes width while loading.
  const overlay = loading && !Leading;

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
        'transition-[transform,background-color,border-color,color,opacity,filter] duration-150 ease-swift',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        SIZE[size],
        VARIANT[variant],
        full && 'w-full',
        className,
      )}
    >
      {overlay ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={size === 'lg' ? 'md' : 'sm'} />
        </span>
      ) : null}

      <span className={clsx('inline-flex min-w-0 items-center', GAP[size], overlay && 'invisible')}>
        {Leading || loading ? (
          <span className={clsx('grid shrink-0 place-items-center', ICON_BOX[size])}>
            {loading ? (
              <Spinner size="sm" />
            ) : Leading ? (
              <Leading className="h-full w-full" />
            ) : null}
          </span>
        ) : null}

        {children !== undefined && children !== null && children !== false ? (
          <span className="truncate">{children}</span>
        ) : null}

        {Trailing ? (
          <span className={clsx('grid shrink-0 place-items-center', ICON_BOX[size])}>
            <Trailing className="h-full w-full" />
          </span>
        ) : null}
      </span>
    </button>
  );
});
