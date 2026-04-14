'use strict';

// Bundles server.js + its TypeScript imports into a single CommonJS file so
// the packaged Electron app doesn't need `node` on PATH or `tsx` at runtime.
// All npm dependencies stay external (resolved from the shipped node_modules).

const path = require('path');
const esbuild = require('esbuild');

const outfile = path.join(__dirname, '..', 'dist-electron', 'server.mjs');

esbuild
  .build({
    entryPoints: [path.join(__dirname, '..', 'server.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    packages: 'external',
    sourcemap: 'linked',
    logLevel: 'info',
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
