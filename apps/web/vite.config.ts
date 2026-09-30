import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri drives the dev server on a fixed port and needs a literal host so the
// WebView can reach it; `TAURI_DEV_HOST` is injected by `tauri dev`.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5274 } : undefined,
    // node_modules churn would otherwise wake the watcher on every cargo build.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    // WebKitGTK on Linux and the Android WebView both handle ES2022 fine.
    target: 'es2022',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: 'dist',
    emptyOutDir: true,
    // The bundle is loaded from disk inside the WebView, so one large chunk is
    // cheaper than a request waterfall — the default 500 kB warning does not
    // apply to a packaged desktop app.
    chunkSizeWarningLimit: 1200,
  },
});
