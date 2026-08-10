import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The page bridge talks to arbitrary editor APIs in the page's main world.
    files: ['src/content/page-bridge.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
