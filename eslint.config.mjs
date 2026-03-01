import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'tools/rock-patterns/*-output.js'],
  },
  {
    files: ['src/**/*.js', 'tools/**/*.js'],
    plugins: { 'unused-imports': unusedImports },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['error', {
        vars: 'all', varsIgnorePattern: '^_',
        args: 'after-used', argsIgnorePattern: '^_',
      }],

      // Catches typos in variable/function names (e.g. `ctx` vs `context`, `rol` vs `col`)
      'no-undef': 'error',

      // Enforces === everywhere EXCEPT `== null` (which intentionally matches null|undefined)
      'eqeqeq': ['error', 'always', { null: 'ignore' }],

      // Flags `let` that is never reassigned — signals unintended mutation in geometry code
      'prefer-const': 'warn',

      // Two import lines from the same module should be merged into one
      'no-duplicate-imports': 'error',

      // Dead code after return/throw/break/continue
      'no-unreachable': 'error',

      // Switch fallthrough is almost always a bug in this codebase
      'no-fallthrough': 'error',
    },
  },
];
