import { defineConfig } from 'vitest/config';

export default defineConfig({
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
