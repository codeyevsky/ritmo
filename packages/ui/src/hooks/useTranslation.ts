import { useMemo } from 'react';
import { createT } from '@ritmo/core';
import type { Lang } from '@ritmo/core';

import { useSettingsStore } from '../store/settings';

export type TFunction = ReturnType<typeof createT>;

export interface Translation {
  t: TFunction;
  lang: Lang;
}

/**
 * The single source of user-visible copy. Memoised on the language so the `t`
 * identity is stable — components hold it in dependency arrays.
 */
export function useTranslation(): Translation {
  const lang = useSettingsStore((s) => s.settings.language);
  return useMemo<Translation>(() => ({ t: createT(lang), lang }), [lang]);
}
