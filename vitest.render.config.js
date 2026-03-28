import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/render/setup-render.js'],
    environment: 'node',
    include: ['test/render/**/*.test.js'],
    testTimeout: 120000,
    pool: 'forks',
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
});
