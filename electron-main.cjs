// Electron entry point for Mapwright.
// Uses CommonJS (.cjs) to avoid ESM/Electron-builder compatibility issues.
// Dynamically imports server.js (ESM) to start the Express server, then
// opens a BrowserWindow pointing at http://localhost:3000/editor/.
//
// For AI automation: server still listens on port 3000, so puppeteer-bridge.js
// works unchanged against a running Mapwright instance.

'use strict';

const { app, BrowserWindow, shell, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// Force GPU compositing. Without these, Electron on Windows can silently fall
// back to software compositing (visible as "FPS N/A / LAT N/A" in the HUD),
// causing severe canvas perf degradation even when the GPU appears active.
app.commandLine.appendSwitch('disk-cache-size', '0');           // disable disk cache (served locally, no benefit)
app.commandLine.appendSwitch('ignore-gpu-blocklist');           // bypass driver blocklist
app.commandLine.appendSwitch('disable-software-rasterizer');   // no CPU fallback
app.commandLine.appendSwitch('enable-accelerated-2d-canvas', 'true');
app.commandLine.appendSwitch('enable-gpu-rasterization', 'true');
app.commandLine.appendSwitch('use-angle', 'gl');               // OpenGL directly, skips ANGLE's DirectX layer

Menu.setApplicationMenu(null);

const PORT = 3000;
let mainWindow = null;

async function startServer() {
  // Dynamic import loads server.js as ESM, which starts Express + WebSockets
  // as a side effect. Port defaults to 3000 via process.argv fallback in server.js.
  await import('./server.js');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Mapwright',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}/editor/`);

  // Allow opening the downloader from the editor toolbar button.
  // All other window.open() calls go to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes(`localhost:${PORT}`) && url.includes('/downloader/')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 520,
          resizable: false,
          title: 'Mapwright — Download Textures',
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Allow window close and reload even when the page has a beforeunload guard.
  // In Electron, confirm() is disabled so beforeunload silently blocks forever.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Returns true if the user has already downloaded textures to userData.
function hasTextures(userDataPath) {
  const dir = path.join(userDataPath, 'textures', 'polyhaven');
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.texture'));
  } catch {
    return false;
  }
}

// Opens the texture downloader as a non-modal window so the editor stays usable.
function openDownloaderWindow() {
  const dlWin = new BrowserWindow({
    width: 520,
    height: 520,
    resizable: false,
    title: 'Mapwright — Download Textures',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  dlWin.loadURL(`http://localhost:${PORT}/downloader/`);
}

app.whenReady().then(async () => {
  // Set texture path BEFORE starting the server so server.js picks it up
  const userDataPath = app.getPath('userData');
  process.env.MAPWRIGHT_TEXTURE_PATH = path.join(userDataPath, 'textures');

  await startServer();
  createWindow();

  // After the editor window starts loading, check if textures are available.
  // If not, open the downloader modal automatically.
  setTimeout(() => {
    if (!hasTextures(userDataPath)) openDownloaderWindow();
  }, 1500);

  globalShortcut.register('CommandOrControl+R', () => {
    BrowserWindow.getFocusedWindow()?.webContents.reload();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.exit(0);
});
