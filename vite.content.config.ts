import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Content script build pass. MV3 content scripts cannot be ES modules,
 * so the whole content bundle is emitted as a single IIFE file.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'FreedomWikiAssistant',
      fileName: () => 'content.js',
    },
  },
});
