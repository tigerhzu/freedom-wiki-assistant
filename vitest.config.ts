import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Release staging may contain other projects with different test runners.
    include: ['tests/**/*.test.ts'],
  },
});
