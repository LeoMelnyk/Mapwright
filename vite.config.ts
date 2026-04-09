import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => ({
  root: 'src',

  resolve: {
    alias: {
      '@render': resolve(__dirname, 'src/render'),
      '@util': resolve(__dirname, 'src/util'),
      '@editor': resolve(__dirname, 'src/editor/js'),
      '@player': resolve(__dirname, 'src/player'),
    },
  },

  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        editor: resolve(__dirname, 'src/editor/index.html'),
        player: resolve(__dirname, 'src/player/index.html'),
        downloader: resolve(__dirname, 'src/downloader/index.html'),
      },
      external: [
        '@napi-rs/canvas',
        /^@napi-rs\/canvas/,
      ],
    },
    assetsDir: 'assets',
    sourcemap: !process.env.CI,
  },

  optimizeDeps: {
    exclude: ['@napi-rs/canvas'],
  },

  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/textures': 'http://localhost:3000',
      '/user-themes': 'http://localhost:3000',
      '/examples': 'http://localhost:3000',
      '/props': 'http://localhost:3000',
      '/lights': 'http://localhost:3000',
      '/favicon.svg': 'http://localhost:3000',
    },
  },
}));
