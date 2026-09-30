import { useCallback, useEffect } from 'react';
import type { ProviderError, ProviderId, Shelf } from '@ritmo/core';

import { useServices } from '../services';
import { useSettingsStore } from '../store/settings';
import { useShelvesStore } from '../store/shelves';

export interface ShelvesResult {
  /** Never undefined: an empty list is "nothing to show", not "not asked yet". */
  data: Shelf[];
  error: Error | undefined;
  /** Nothing on screen and work in flight — the only case worth a skeleton. */
  loading: boolean;
  /** A revalidation running behind rows that are already on screen. */
  refreshing: boolean;
  /** Providers that could not answer. `shelves()` never rejects for these. */
  providerErrors: Array<{ provider: ProviderId; error: ProviderError }>;
  /** Forces a re-fetch; the current rows stay on screen throughout. */
  reload(): void;
}

/**
 * Home's shelves, from the session store rather than a per-mount fetch.
 *
 * The fan-out runs once per provider signature per session, so leaving Home
 * and coming back is a re-render, not a reload. A persisted list for the same
 * signature paints on the first frame while the revalidation runs behind it.
 */
export function useShelves(): ShelvesResult {
  const { registry } = useServices();

  // Turning a provider off, going offline or switching quality changes what the
  // home screen should contain, so each combination is fetched and cached on
  // its own. Settings arrive asynchronously; fetching under the defaults first
  // would burn a fan-out and paint another signature's cached rows.
  const fingerprint = useSettingsStore((s) =>
    [s.settings.enabledProviders.join(','), String(s.settings.offlineMode), s.settings.preferredQuality].join('|'),
  );
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  const shelves = useShelvesStore((s) => s.shelves);
  const status = useShelvesStore((s) => s.status);
  const refreshing = useShelvesStore((s) => s.refreshing);
  const providerErrors = useShelvesStore((s) => s.providerErrors);
  const error = useShelvesStore((s) => s.error);
  const load = useShelvesStore((s) => s.load);
  const refresh = useShelvesStore((s) => s.refresh);

  useEffect(() => {
    if (!settingsLoaded) return;
    load(registry, fingerprint);
  }, [load, registry, fingerprint, settingsLoaded]);

  const reload = useCallback(() => {
    refresh(registry, fingerprint);
  }, [refresh, registry, fingerprint]);

  return {
    data: shelves,
    error,
    loading: status === 'idle' || status === 'loading',
    refreshing,
    providerErrors,
    reload,
  };
}
