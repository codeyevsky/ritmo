/**
 * Host selection.
 *
 * Detection is by runtime marker, not by build flag, so one bundle can be
 * loaded by the Tauri WebView, a Capacitor WebView or a plain browser and pick
 * the right bridge each time. Each implementation is behind a dynamic
 * `import()`, so only the one that matches is fetched and evaluated.
 */

import type { HostBridge } from './types';

interface CapacitorMarker {
  Capacitor?: {
    isNativePlatform?: () => boolean;
  };
}

function hasTauriMarker(scope: Window & typeof globalThis): boolean {
  return '__TAURI_INTERNALS__' in scope;
}

function isCapacitorNative(scope: Window & typeof globalThis): boolean {
  const capacitor = (scope as unknown as CapacitorMarker).Capacitor;
  if (typeof capacitor?.isNativePlatform !== 'function') return false;
  try {
    return capacitor.isNativePlatform() === true;
  } catch {
    // A partially initialised bridge must fall through to the browser host
    // rather than take the whole app down at startup.
    return false;
  }
}

export async function detectHost(): Promise<HostBridge> {
  if (typeof window !== 'undefined') {
    if (hasTauriMarker(window)) {
      const { TauriHost } = await import('./tauri');
      return new TauriHost();
    }
    if (isCapacitorNative(window)) {
      const { CapacitorHost } = await import('./capacitor');
      return new CapacitorHost();
    }
  }
  const { WebHost } = await import('./web');
  return new WebHost();
}

export { TauriHost } from './tauri';
export { WebHost } from './web';
export { CapacitorHost } from './capacitor';
export * from './secrets';
export * from './types';
