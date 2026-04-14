'use strict';
// Launches Electron with a Vite watch process that auto-rebuilds dist/ on
// source file changes. No server restart needed — just refresh the page.
// Gets the Electron binary path via require('electron') to avoid .bin path
// issues (project path contains '&', as in "D&D").
const { spawn, spawnSync } = require('child_process');
const electron = require('electron');
const path = require('path');

// Build the server bundle once — electron-main.cjs forks dist-electron/server.mjs.
const bundle = spawnSync(process.execPath, [path.join(__dirname, 'tools/bundle-server.cjs')], {
  stdio: 'inherit',
  windowsHide: true,
});
if (bundle.status !== 0) process.exit(bundle.status || 1);

// Start vite build --watch in the background (rebuilds dist/ on every save)
const viteWatch = spawn(
  process.execPath,
  [path.join(__dirname, 'node_modules/vite/bin/vite.js'), 'build', '--watch', '--config', 'vite.config.ts'],
  { stdio: 'ignore', windowsHide: true },
);

// Launch Electron (blocks until the app closes)
const result = spawnSync(electron, ['.'], {
  stdio: 'inherit',
  windowsHide: false,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});

// Clean up the watcher when Electron exits
viteWatch.kill();
process.exit(result.status || 0);
