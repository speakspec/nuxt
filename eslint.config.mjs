// Flat ESLint config for @speakspec/nuxt.
//
// We hand-roll instead of @nuxt/eslint-config/flat because that preset's
// transitive dep eslint-flat-config-utils@3.2 calls Object.groupBy
// (Node 21+ only), and the workspace currently runs on Node 20.20.
// Once Node bumps to 22 LTS, switch back to createConfigForNuxt({...}).

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.nuxt/**',
      '**/.nuxt/**',
      '**/.output/**',
      'playground/.nuxt/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Module options struct documents fields that aren't yet used at
      // runtime (Step 3.0 is scaffold). Don't fail on "unused" until
      // 3.1+ wires them.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
)
