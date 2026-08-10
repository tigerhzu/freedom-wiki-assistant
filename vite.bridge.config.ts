import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Page bridge build pass. This script is injected into the page's main world
 * (via web_accessible_resources) so the extension can talk to editor instances
 * (CodeMirror / Monaco / Ace) that are not reachable from the isolated world.
 * It is bundled locally — no remote code is ever loaded.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/content/page-bridge.ts'),
      formats: ['iife'],
      name: 'FreedomWikiAssistantBridge',
      fileName: () => 'page-bridge.js',
    },
  },
});
