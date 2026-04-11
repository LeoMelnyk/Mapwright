import { defineConfig } from 'vitest/config';

export default defineConfig({
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
