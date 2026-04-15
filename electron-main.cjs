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
app.commandLine.appendSwitch('disk-cache-size', '0'); // disable disk cache (served locally, no benefit)
app.commandLine.appendSwitch('ignore-gpu-blocklist'); // bypass driver blocklist
app.commandLine.appendSwitch('disable-software-rasterizer'); // no CPU fallback
app.commandLine.appendSwitch('enable-accelerated-2d-canvas', 'true');
app.commandLine.appendSwitch('enable-gpu-rasterization', 'true');
app.commandLine.appendSwitch('use-angle', 'gl'); // OpenGL directly, skips ANGLE's DirectX layer

app.setAppUserModelId('com.mapwright.editor');
Menu.setApplicationMenu(null);

const PORT = 3000;
let mainWindow = null;

// ── File association: open .mapwright files ──────────────────────────────────

function getFileFromArgs(argv) {
  return argv.find(
    (arg) =>
      !arg.startsWith('-') &&
      (arg.endsWith('.mapwright') || arg.endsWith('.json')) &&
      arg !== process.execPath &&
      !arg.includes('electron'),
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

// Log file for packaged builds where stdout is invisible. Path:
//   macOS: ~/Library/Logs/Mapwright/main.log
//   Windows: %APPDATA%\Mapwright\logs\main.log
function getLogStream() {
  if (app._logStream) return app._logStream;
  const logDir = app.getPath('logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    /* best effort */
  }
  const logPath = path.join(logDir, 'main.log');
  app._logPath = logPath;
  app._logStream = fs.createWriteStream(logPath, { flags: 'a' });
  app._logStream.write(`\n=== Mapwright startup ${new Date().toISOString()} ===\n`);
  app._logStream.write(`execPath: ${process.execPath}\n`);
  app._logStream.write(`__dirname: ${__dirname}\n`);
  return app._logStream;
}

function logLine(prefix, msg) {
  const line = `[${new Date().toISOString()}] [${prefix}] ${msg}\n`;
  try {
    getLogStream().write(line);
  } catch {
    /* best effort */
  }
  console.log(line.trimEnd());
}

async function startServer() {
  // server.js + its .ts imports are bundled to dist-electron/server.mjs by
  // tools/bundle-server.cjs at build time. We import the bundle directly into
  // the Electron main process (rather than forking it) so that Electron's asar
  // fs integration is available — ELECTRON_RUN_AS_NODE child processes lose
  // asar support, which breaks express.static() against paths inside app.asar.
  const serverPath = path.join(__dirname, 'dist-electron', 'server.mjs');
  logLine('server', `importing: ${serverPath}`);
  logLine('server', `exists: ${fs.existsSync(serverPath)}`);

  process.env.MAPWRIGHT_TEXTURE_PATH =
    process.env.MAPWRIGHT_TEXTURE_PATH || path.join(app.getPath('userData'), 'textures');
  process.env.MAPWRIGHT_THEME_PATH = process.env.MAPWRIGHT_THEME_PATH || path.join(app.getPath('userData'), 'themes');

  // server.mjs reads PORT from process.argv[2]; inject it before import.
  process.argv[2] = String(PORT);

  const TIMEOUT_MS = 15000;
  const started = Date.now();
  const http = require('http');

  try {
    // Convert Windows path to a file:// URL so dynamic import works reliably on
    // both platforms. Node accepts `file:///C:/...` but not raw `C:\...`.
    const serverUrl = require('url').pathToFileURL(serverPath).href;
    await import(serverUrl);
  } catch (err) {
    logLine('server:error', err.stack || String(err));
    dialog.showErrorBox(
      'Mapwright failed to start',
      `Server import failed.\n\nReason: ${err.message}\n\nLog: ${app._logPath || '(unavailable)'}`,
    );
    return;
  }

  // server.js's app.listen() is async — poll until it responds.
  const ready = await new Promise((resolve) => {
    const check = () => {
      if (Date.now() - started > TIMEOUT_MS) {
        resolve({ ok: false, reason: `timed out after ${TIMEOUT_MS}ms waiting for http://localhost:${PORT}/` });
        return;
      }
      const req = http.get(`http://localhost:${PORT}/`, () => resolve({ ok: true }));
      req.on('error', () => setTimeout(check, 200));
      req.end();
    };
    check();
  });

  if (!ready.ok) {
    logLine('server', `FAILED: ${ready.reason}`);
    dialog.showErrorBox(
      'Mapwright failed to start',
      `The local server did not respond.\n\nReason: ${ready.reason}\n\nLog: ${app._logPath || '(unavailable)'}`,
    );
    return;
  }
  logLine('server', `ready in ${Date.now() - started}ms`);
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
      sandbox: true,
      backgroundThrottling: false,
      devTools: true,
    },
  });

  // Block any navigation away from the local editor — if a renderer is
  // compromised it shouldn't be able to swap the window to a phishing page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://localhost:${PORT}/`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  const editorUrl = pendingFile
    ? `http://localhost:${PORT}/editor/?open=${encodeURIComponent(path.resolve(pendingFile))}`
    : `http://localhost:${PORT}/editor/`;
  pendingFile = null;
  mainWindow.loadURL(editorUrl);

  // Forward renderer console messages to terminal with source location
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
    // Strip the origin prefix to show just the asset path
    const source = sourceId.replace(/^https?:\/\/[^/]+\//, '');
    console.log(`[${tag}] ${message}  (${source}:${line})`);
  });

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
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.texture'));
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
  // Set asset paths BEFORE starting the server so server.js picks them up
  const userDataPath = app.getPath('userData');
  process.env.MAPWRIGHT_TEXTURE_PATH = path.join(userDataPath, 'textures');
  process.env.MAPWRIGHT_THEME_PATH = path.join(userDataPath, 'themes');

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
        dialog
          .showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Available',
            message: `Mapwright v${info.version} is available. Would you like to download and install it?`,
            buttons: ['Download', 'Later'],
            defaultId: 0,
          })
          .then(({ response }) => {
            if (response === 0) autoUpdater.downloadUpdate();
          });
      });

      autoUpdater.on('update-downloaded', () => {
        if (!mainWindow) return;
        dialog
          .showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Ready',
            message: 'The update has been downloaded. Restart now to install?',
            buttons: ['Restart', 'Later'],
            defaultId: 0,
          })
          .then(({ response }) => {
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

// Server runs in-process, so quitting the main process stops it automatically.
// No explicit child cleanup needed.
