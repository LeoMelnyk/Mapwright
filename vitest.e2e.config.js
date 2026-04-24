import { defineConfig } from 'vitest/config';

export default defineConfig({
  // See vitest.config.js for why configFile must be off.
  configFile: false,
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.js'],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'forks',
    maxConcurrency: 1, // serial — shared server
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
});
