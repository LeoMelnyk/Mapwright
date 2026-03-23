// Electron entry point for Mapwright.
// Uses CommonJS (.cjs) to avoid ESM/Electron-builder compatibility issues.
// Dynamically imports server.js (ESM) to start the Express server, then
// opens a BrowserWindow pointing at http://localhost:3000/editor/.
//
// For AI automation: server still listens on port 3000, so puppeteer-bridge.js
// works unchanged against a running Mapwright instance.

'use strict';

const { app, BrowserWindow, shell, Menu, globalShortcut, dialog } = require('electron');
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

app.setAppUserModelId('com.mapwright.editor');
Menu.setApplicationMenu(null);

const PORT = 3000;
let mainWindow = null;

// ── File association: open .mapwright files ──────────────────────────────────

function getFileFromArgs(argv) {
  return argv.find(arg =>
    !arg.startsWith('-') &&
    (arg.endsWith('.mapwright') || arg.endsWith('.json')) &&
    arg !== process.execPath &&
    !arg.includes('electron')
  );
}

let pendingFile = getFileFromArgs(process.argv);

// Single-instance lock: if a second instance is launched (e.g., double-clicking
// another .mapwright file), focus the existing window and load the new file.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const file = getFileFromArgs(argv);
    if (file && mainWindow) {
      mainWindow.loadURL(`http://localhost:${PORT}/editor/?open=${encodeURIComponent(path.resolve(file))}`);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS: open-file event fires when a .mapwright file is opened via Finder
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow) {
      mainWindow.loadURL(`http://localhost:${PORT}/editor/?open=${encodeURIComponent(filePath)}`);
    } else {
      pendingFile = filePath;
    }
  });
}

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
    icon: path.join(__dirname, 'src', 'MapwrightIcon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      devTools: true,
    },
  });

  const editorUrl = pendingFile
    ? `http://localhost:${PORT}/editor/?open=${encodeURIComponent(path.resolve(pendingFile))}`
    : `http://localhost:${PORT}/editor/`;
  pendingFile = null;
  mainWindow.loadURL(editorUrl);

  // F12 opens devtools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

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

  // ── Auto-update (NSIS installs only) ────────────────────────────────────
  // Portable builds set PORTABLE_EXECUTABLE_DIR; skip auto-updater for those.
  if (!process.env.PORTABLE_EXECUTABLE_DIR) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      // Tell the renderer that native auto-update is active
      process.env.MAPWRIGHT_AUTO_UPDATE = 'true';

      autoUpdater.on('update-available', (info) => {
        if (!mainWindow) return;
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Update Available',
          message: `Mapwright v${info.version} is available. Would you like to download and install it?`,
          buttons: ['Download', 'Later'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) autoUpdater.downloadUpdate();
        });
      });

      autoUpdater.on('update-downloaded', () => {
        if (!mainWindow) return;
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Update Ready',
          message: 'The update has been downloaded. Restart now to install?',
          buttons: ['Restart', 'Later'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
        });
      });

      autoUpdater.on('error', (err) => {
        console.log('Auto-updater error:', err.message);
      });

      autoUpdater.checkForUpdatesAndNotify();
    } catch (err) {
      console.log('Auto-updater not available:', err.message);
    }
  }

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
