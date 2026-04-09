import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    include: ['test/**/*.test.{js,ts}'],
    exclude: ['test/render/**', 'test/e2e/**', 'test/server.test.js'],
    testTimeout: 10000,
    pool: 'forks',
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
});
