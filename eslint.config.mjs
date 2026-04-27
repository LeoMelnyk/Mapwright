import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'tools/rock-patterns/*-output.js'],
  },
  // TypeScript-specific config (parser + recommended rules)
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['src/**/*.ts'],
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        project: './tsconfig.json',
      },
    },
    rules: {
      ...config.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: true,
          fixStyle: 'separate-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/no-unnecessary-type-constraint': 'error',
      '@typescript-eslint/no-confusing-non-null-assertion': 'error',
      '@typescript-eslint/no-shadow': 'error',
      // Type-checked rules (require parserOptions.project)
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': 'error',
      '@typescript-eslint/no-misused-spread': 'error',
      '@typescript-eslint/prefer-find': 'error',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-regexp-exec': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // Ban writing or deleting Cell-like objects through `as Record<string, unknown>`
      // casts. Such casts bypass the type system and have produced silent-failure
      // bugs (paint tool writing dead `cell.texture` fields after the segments
      // storage flip). Use a typed helper (`setEdge` / `deleteEdge` from
      // `util/grid.ts`, `writeCellTexture` etc) or extend the proper type.
      //
      // The rule matches the assertion subject by identifier name (`cell`,
      // `neighborCell`, `nb`, `c`, `prev`, etc.) — heuristic, but precisely
      // targets the bug class without forcing churn on legitimate dynamic-dict
      // writes elsewhere (theme editor, light editor, debug panels). If you
      // hit a false positive on a non-Cell variable, either rename the local
      // or add `// eslint-disable-next-line no-restricted-syntax` with a
      // justification.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.type='TSAsExpression'][left.object.expression.type='Identifier'][left.object.expression.name=/^(cell|neighborCell|neighbor|nb|prev|c|cc)$/][left.object.typeAnnotation.type='TSTypeReference'][left.object.typeAnnotation.typeName.name='Record']",
          message:
            'Do not write Cell-like objects through `as Record<string, unknown>` casts. Use a typed helper (setEdge/deleteEdge from util/grid.ts, writeCellTexture from util/cell-segments.ts) or extend the Cell type.',
        },
        {
          selector:
            "UnaryExpression[operator='delete'][argument.type='MemberExpression'][argument.object.type='TSAsExpression'][argument.object.expression.type='Identifier'][argument.object.expression.name=/^(cell|neighborCell|neighbor|nb|prev|c|cc)$/][argument.object.typeAnnotation.type='TSTypeReference'][argument.object.typeAnnotation.typeName.name='Record']",
          message:
            'Do not delete from Cell-like objects through `as Record<string, unknown>` casts. Use a typed helper (deleteEdge from util/grid.ts) or extend the Cell type.',
        },
      ],
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
      'unused-imports/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-undef': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-throw-literal': 'error',
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-constant-binary-expression': 'error',
      'no-return-assign': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
    },
  },
];
