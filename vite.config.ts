import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Main build pass: background service worker (ES module) + settings page.
 * The content script and the page bridge need IIFE format and are built by
 * vite.content.config.ts / vite.bridge.config.ts in separate passes.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/service-worker.ts'),
        settings: resolve(__dirname, 'src/settings/settings.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
