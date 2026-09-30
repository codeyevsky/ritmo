import clsx from 'clsx';
import { NavLink } from 'react-router-dom';

import { Tooltip } from '../components';

type IconComponent = React.ComponentType<{ className?: string }>;

export interface NavItemProps {
  to: string;
  icon: IconComponent;
  activeIcon?: IconComponent;
  label: string;
  collapsed?: boolean;
  badge?: number;
  /** Keyboard chord printed at the row's right edge; dropped when collapsed. */
  hint?: string;
  className?: string;
}

export function NavItem({
  to,
  icon: Icon,
  activeIcon: ActiveIcon,
  label,
  collapsed = false,
  badge,
  hint,
  className,
}: NavItemProps): JSX.Element {
  const link = (
    <NavLink
      to={to}
      end={to === '/'}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        clsx(
          'group relative flex h-9 items-center gap-3 rounded-sm text-sm outline-none transition-colors duration-150 ease-swift',
          'focus-visible:ring-2 focus-visible:ring-accent',
          collapsed ? 'w-10 justify-center px-0' : 'pl-3 pr-2',
          // An editor-gutter bar rather than a filled pill.
          isActive
            ? 'gutter-mark font-medium text-text'
            : 'text-text-dim hover:bg-surface-2 hover:text-text',
          className,
        )
      }
    >
      {({ isActive }) => {
        const Glyph = isActive && ActiveIcon ? ActiveIcon : Icon;
        return (
          <>
            <Glyph className={clsx('h-[18px] w-[18px] shrink-0', isActive && 'text-accent')} />
            {collapsed ? null : <span className="min-w-0 flex-1 truncate">{label}</span>}
            {!collapsed && badge !== undefined && badge > 0 ? (
              <span className="mono shrink-0 text-[10px] text-text-dim">{badge}</span>
            ) : null}
            {!collapsed && hint ? (
              <span
                aria-hidden="true"
                className="mono shrink-0 text-[10px] text-text-faint transition-colors group-hover:text-text-dim"
              >
                {hint}
              </span>
            ) : null}
          </>
        );
      }}
    </NavLink>
  );

  if (!collapsed) return link;
  return (
    <Tooltip content={label} side="right">
      {link}
    </Tooltip>
  );
}
