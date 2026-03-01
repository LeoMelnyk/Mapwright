'use strict';
// Launches Electron without relying on node_modules/.bin (which breaks when
// the project path contains '&', as in "D&D"). Gets the binary path via
// require('electron') and spawns it directly.
const { spawnSync } = require('child_process');
const electron = require('electron');
const result = spawnSync(electron, ['.'], { stdio: 'inherit', windowsHide: false, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
process.exit(result.status || 0);
