import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'], // Vite uses the automatic runtime — no React-in-scope needed
  reactHooks.configs['recommended-latest'],
  jsxA11y.flatConfigs.recommended,

  {
    files: ['**/*.{js,jsx}'], // without this, flat-config v9 lints only *.js and silently skips every .jsx
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/prop-types': 'off', // shapes are documented via JSDoc typedefs (lib/contracts.js) + checkJs
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }], // intentional swallow on storage/JSON guards
      'no-undef': 'error',
    },
  },

  // Test files: allow node + vitest-style globals (tests import from 'vitest' explicitly,
  // but keep this lenient so helpers don't trip no-undef).
  {
    files: ['**/*.{test,spec}.{js,jsx}', 'src/test/**'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },

  prettier, // MUST be last — turns off stylistic rules that would fight Prettier
];
