import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    environment: 'node',
    include: ['test/**/*.test.js'],
    testTimeout: 10000,
    pool: 'forks',
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
});
