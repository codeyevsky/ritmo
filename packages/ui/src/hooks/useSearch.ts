import { useEffect, useMemo } from 'react';
import type { ProviderError, ProviderId, SearchResults } from '@ritmo/core';

import { useServices } from '../services';
import { useSearchStore } from '../store/search';
import type { SearchFilter, SearchStatus } from '../store/search';

export interface SearchApi {
  query: string;
  results: SearchResults;
  status: SearchStatus;
  /** Providers that failed this round; rendered as dismissible chips, not a blank page. */
  providerErrors: Array<{ provider: ProviderId; error: ProviderError }>;
  error?: Error;
  recent: string[];
  filter: SearchFilter;
  /** Debounced 250 ms — call it from the input's onChange. */
  search(q: string): void;
  /** Immediate — Enter, a recent-search chip, the command palette. */
  submit(q: string): Promise<void>;
  retry(): void;
  setFilter(filter: SearchFilter): void;
  clear(): void;
  removeRecent(q: string): void;
  clearRecent(): void;
}

export function useSearch(): SearchApi {
  const { registry, host } = useServices();

  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const status = useSearchStore((s) => s.status);
  const providerErrors = useSearchStore((s) => s.providerErrors);
  const error = useSearchStore((s) => s.error);
  const recent = useSearchStore((s) => s.recent);
  const filter = useSearchStore((s) => s.filter);
  const setFilter = useSearchStore((s) => s.setFilter);
  const clear = useSearchStore((s) => s.clear);
  const removeRecent = useSearchStore((s) => s.removeRecent);
  const clearRecent = useSearchStore((s) => s.clearRecent);
  const bind = useSearchStore((s) => s.bind);

  useEffect(() => {
    bind(host);
  }, [bind, host]);

  const actions = useMemo(
    () => ({
      search: (q: string) => useSearchStore.getState().run(registry, q),
      submit: (q: string) => useSearchStore.getState().runNow(registry, q),
      retry: () => {
        void useSearchStore.getState().runNow(registry, useSearchStore.getState().query);
      },
    }),
    [registry],
  );

  return {
    query,
    results,
    status,
    providerErrors,
    error,
    recent,
    filter,
    setFilter,
    clear,
    removeRecent,
    clearRecent,
    ...actions,
  };
}
