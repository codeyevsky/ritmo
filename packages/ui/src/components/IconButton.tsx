import clsx from 'clsx';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import type { IconComponent } from '../icons';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconComponent;
  /** Required: becomes aria-label and the tooltip text. */
  label: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  active?: boolean;
  tooltip?: boolean;
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
}

const SIZE: Record<'xs' | 'sm' | 'md' | 'lg', string> = {
  xs: 'h-6 w-6 text-[14px]',
  sm: 'h-8 w-8 text-[16px]',
  md: 'h-9 w-9 text-[18px]',
  lg: 'h-11 w-11 text-[21px]',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon: Icon,
    label,
    size = 'md',
    active,
    tooltip = true,
    tooltipSide = 'top',
    className,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const button = (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={clsx(
        'relative grid shrink-0 place-items-center rounded-full transition-[color,background-color,transform] duration-150 ease-swift',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:pointer-events-none disabled:opacity-40',
        'hover:bg-surface-2 active:scale-[0.94]',
        active ? 'text-accent' : 'text-text-dim hover:text-text',
        SIZE[size],
        className,
      )}
    >
      <Icon className="h-[1em] w-[1em]" />
    </button>
  );

  if (!tooltip) return button;
  return (
    <Tooltip content={label} side={tooltipSide}>
      {button}
    </Tooltip>
  );
});
