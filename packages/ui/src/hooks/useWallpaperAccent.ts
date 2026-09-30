import { useCallback, useEffect, useState } from 'react';
import { ARCH_BLUE } from '@ritmo/core';

import { useServices } from '../services';

/**
 * The accent for `settings.accent === 'wallpaper'`: the representative colour
 * of the desktop wallpaper, read from the host.
 *
 * Re-read whenever the window regains focus, because that is exactly when the
 * user comes back from changing their wallpaper — there is no change signal to
 * subscribe to, and polling a disk decode would be worse than free.
 *
 * Never resolves to `undefined` while enabled: a host without the capability
 * (web, mobile), a session with no wallpaper and an unreadable file all land on
 * the default accent, so the app is never left without one.
 */
export function useWallpaperAccent(enabled: boolean): string | undefined {
  const { host } = useServices();
  const [hex, setHex] = useState<string | undefined>(undefined);

  const read = useCallback(async (): Promise<string> => {
    const found = await host.systemAccent?.();
    return found?.hex ?? ARCH_BLUE;
  }, [host]);

  useEffect(() => {
    if (!enabled) {
      setHex(undefined);
      return;
    }

    let alive = true;
    const refresh = (): void => {
      void read()
        .then((found) => {
          if (alive) setHex(found);
        })
        .catch(() => {
          if (alive) setHex(ARCH_BLUE);
        });
    };

    refresh();
    const view = typeof window === 'undefined' ? undefined : window;
    view?.addEventListener('focus', refresh);
    return () => {
      alive = false;
      view?.removeEventListener('focus', refresh);
    };
  }, [enabled, read]);

  return hex;
}
