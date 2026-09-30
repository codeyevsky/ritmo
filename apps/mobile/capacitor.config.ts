import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The mobile shell wraps the very same bundle the desktop app does — Vite
 * output from `apps/web` — so there is one UI to maintain. Platform differences
 * are resolved at runtime by `detectHost()` picking `CapacitorHost` and
 * `createAudioEngine()` picking `HtmlAudioEngine`.
 */
const config: CapacitorConfig = {
  appId: 'dev.ritmo.app',
  appName: 'Ritmo',
  webDir: '../web/dist',
  // A real scheme (rather than file://) is required for IndexedDB, the
  // MediaSession API and range requests on <audio> to behave.
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: true,
  },
  ios: {
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: true,
  },
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#0a0b0d',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    CapacitorSQLite: {
      // Same file format as the desktop database, so a library can be copied
      // between devices verbatim.
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      androidIsEncryption: false,
    },
  },
};

export default config;
