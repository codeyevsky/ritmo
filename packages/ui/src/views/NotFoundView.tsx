import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { EmptyState } from '../components';
import { useTranslation } from '../hooks';
import { Info } from '../icons';

export function NotFoundView(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = `${t('errors.notFoundTitle')} • Ritmo`;
  }, [t]);

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-16">
      <EmptyState
        icon={Info}
        title={t('errors.notFoundTitle')}
        body={t('errors.notFoundBody')}
        action={{ label: t('nav.home'), onClick: () => navigate('/') }}
        secondaryAction={{ label: t('nav.search'), onClick: () => navigate('/search') }}
      />
    </div>
  );
}
