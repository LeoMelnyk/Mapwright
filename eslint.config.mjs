import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'tools/rock-patterns/*-output.js'],
  },
  // TypeScript-specific config (parser + recommended rules)
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['src/**/*.ts'],
    rules: {
      ...config.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  })),
  // Shared rules for JS and TS
  {
    files: ['src/**/*.{js,ts}', 'tools/**/*.js'],
    plugins: { 'unused-imports': unusedImports },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['error', {
        vars: 'all',
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-undef': 'off',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'warn',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
    },
  },
];
