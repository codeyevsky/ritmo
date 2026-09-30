import clsx from 'clsx';
import { NavLink } from 'react-router-dom';

import { useTranslation } from '../hooks';
import { IconHeart, IconHome, IconLibrary, IconRadio, IconSearch } from '../icons';

export interface MobileTabBarProps {
  className?: string;
}

type IconComponent = React.ComponentType<{ className?: string }>;

export function MobileTabBar({ className }: MobileTabBarProps): JSX.Element {
  const { t } = useTranslation();

  const tabs: Array<{ to: string; icon: IconComponent; label: string }> = [
    { to: '/', icon: IconHome, label: t('nav.home') },
    { to: '/search', icon: IconSearch, label: t('nav.search') },
    { to: '/library', icon: IconLibrary, label: t('nav.library') },
    { to: '/liked', icon: IconHeart, label: t('nav.liked') },
    { to: '/radio', icon: IconRadio, label: t('nav.radio') },
  ];

  return (
    <nav
      aria-label={t('nav.primary')}
      className={clsx(
        'flex items-stretch justify-around border-t border-line/60 bg-surface pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      {tabs.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            clsx(
              'flex min-h-[56px] min-w-[56px] flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-[11px] outline-none transition-colors duration-150 ease-swift focus-visible:ring-2 focus-visible:ring-accent',
              isActive ? 'text-accent' : 'text-text-dim',
            )
          }
        >
          <Icon className="h-5 w-5" />
          <span className="max-w-full truncate">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
