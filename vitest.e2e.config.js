import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.js'],
    testTimeout: 60000,
    pool: 'forks',
    maxConcurrency: 1, // serial — shared server
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
});
