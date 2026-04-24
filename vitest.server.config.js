import { defineConfig } from 'vitest/config';

export default defineConfig({
  // See vitest.config.js for why configFile must be off.
  configFile: false,
  test: {
    environment: 'node',
    include: ['test/server.test.js'],
    testTimeout: 30000,
    pool: 'forks',
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
});
