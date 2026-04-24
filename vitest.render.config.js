import { defineConfig } from 'vitest/config';

export default defineConfig({
  // See vitest.config.js for why configFile must be off.
  configFile: false,
  test: {
    environment: 'node',
    include: ['test/render/**/*.test.{js,ts}'],
    setupFiles: ['./test/render/setup-render.js'],
    testTimeout: 120000,
    pool: 'forks',
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
});
