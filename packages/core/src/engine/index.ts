import type { HostBridge } from '../host/types';
import { HtmlAudioEngine } from './html';
import type { AudioEngine } from './types';

/**
 * Picks the engine the host can actually drive and hands it back initialised.
 *
 * `./tauri` is imported dynamically so a Capacitor or browser bundle never
 * has to resolve `@tauri-apps/api`.
 */
export async function createAudioEngine(host: HostBridge): Promise<AudioEngine> {
  if (host.capabilities.nativeAudio) {
    const { TauriAudioEngine } = await import('./tauri');
    const engine = new TauriAudioEngine();
    await engine.init();
    return engine;
  }
  const engine = new HtmlAudioEngine();
  await engine.init();
  return engine;
}

export { HtmlAudioEngine } from './html';
export { TauriAudioEngine } from './tauri';
export * from './types';
