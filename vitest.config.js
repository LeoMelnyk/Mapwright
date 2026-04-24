import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest 4.x auto-merges the sibling vite.config.ts, whose `root: 'src'`
  // and path aliases poison the test runtime — top-level describe/beforeAll
  // fail with "Vitest failed to find the runner/current suite". Keep this
  // off in every vitest.*.config.js.
  configFile: false,
  test: {
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    include: ['test/**/*.test.{js,ts}'],
    exclude: ['test/render/**', 'test/e2e/**', 'test/server.test.js'],
    testTimeout: 10000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/*.d.ts'],
    },
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
});
