import { useEffect } from 'react';

import { useServices } from '../services';

/**
 * Transport commands are *not* handled here.
 *
 * `PlaybackController.init` already subscribes to `host.mediaSession` and owns
 * play / pause / toggle / next / previous / stop / seek / setVolume; handling
 * them again in the UI would double every MPRIS or headset button press.
 *
 * What the controller has no opinion about are the window-level commands the
 * desktop tray pushes through the same channel — they are outside
 * `MediaSessionCommand`'s union and so are read structurally.
 */
export function useMediaCommands(): void {
  const { host, controller } = useServices();

  useEffect(() => {
    const session = host.mediaSession;
    if (!session) return;

    return session.onCommand((cmd) => {
      const type: string = cmd.type;
      if (type === 'raise') {
        void host.window?.show().catch(() => {});
        return;
      }
      if (type === 'quit') {
        // Flush the audio path before the shell goes away so the session is
        // persisted at a sane position instead of mid-track.
        void controller.pause().catch(() => {});
        void host.window?.hide().catch(() => {});
      }
    });
  }, [host, controller]);
}
