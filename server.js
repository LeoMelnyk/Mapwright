// Express static server + WebSocket relay for DM ↔ Player communication.
// Also provides server-side PNG export via @napi-rs/canvas.
//
// Usage: node server.js [port]  (default 3000)

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createCanvas, Path2D, ImageData } from '@napi-rs/canvas';
import { calculateCanvasSize, renderDungeonToCanvas } from './src/render/compile.js';
import { THEMES } from './src/render/themes.js';
import { loadPropCatalogSync } from './src/render/prop-catalog-node.js';
import { loadTextureCatalogMetadata, ensureTexturesForConfig } from './src/render/texture-catalog-node.js';

// ── Browser API polyfills (needed by render pipeline in Node.js) ─────────────

if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = Path2D;
if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = ImageData;

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) {
      this._canvas = createCanvas(w, h);
    }
    get width() { return this._canvas.width; }
    set width(v) { this._canvas.width = v; }
    get height() { return this._canvas.height; }
    set height(v) { this._canvas.height = v; }
    getContext(type, options) { return this._canvas.getContext(type, options); }
  };
}

// Polyfill document.createElement('canvas') used by the lighting pipeline
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvas(1, 1);
      throw new Error(`document.createElement('${tag}') not supported in Node`);
    },
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2]) || 3000;

// ── Load asset catalogs at startup ──────────────────────────────────────────

const propCatalog = loadPropCatalogSync();
const textureCatalog = loadTextureCatalogMetadata();

// Load themes (same as build_map.js)
const themesDir = path.join(__dirname, 'src', 'themes');
try {
  const keys = JSON.parse(fs.readFileSync(path.join(themesDir, 'manifest.json'), 'utf-8'));
  for (const key of keys) {
    try {
      const { displayName, ...themeProps } = JSON.parse(
        fs.readFileSync(path.join(themesDir, `${key}.theme`), 'utf-8')
      );
      THEMES[key] = themeProps;
    } catch { /* skip missing/malformed themes */ }
  }
} catch (e) {
  console.warn('Warning: could not load themes:', e.message);
}

// ── Express ─────────────────────────────────────────────────────────────────

const app = express();

// JSON body parser with generous limit for large dungeon configs
app.use('/api', express.json({ limit: '10mb' }));

// Static files from src/ (same root as old `npx serve src`)
app.use(express.static(path.join(__dirname, 'src')));

// Redirect / → /editor/ (matches old serve.json behavior)
app.get('/', (_req, res) => res.redirect('/editor/'));

// ── Export PNG endpoint ─────────────────────────────────────────────────────

app.post('/api/export-png', async (req, res) => {
  const start = performance.now();
  try {
    const config = req.body;
    if (!config?.metadata || !config?.cells) {
      return res.status(400).json({ error: 'Invalid dungeon config' });
    }

    // Load texture images for this map (cached after first load)
    await ensureTexturesForConfig(textureCatalog, config, propCatalog);

    const { width, height } = calculateCanvasSize(config);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    renderDungeonToCanvas(ctx, config, width, height, propCatalog, textureCatalog);

    const buffer = canvas.toBuffer('image/png');
    const elapsed = (performance.now() - start).toFixed(0);
    console.log(`[export] PNG ${width}x${height}, ${(buffer.length / 1024).toFixed(0)}KB in ${elapsed}ms`);

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', 'attachment; filename="dungeon.png"');
    res.send(buffer);
  } catch (err) {
    console.error('[export] Failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Local IP endpoint (for Player Session panel) ─────────────────────────

app.get('/api/local-ip', (_req, res) => {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        return res.json({ ip: info.address });
      }
    }
  }
  res.json({ ip: 'localhost' });
});

const server = createServer(app);

// ── WebSocket relay ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

let dmSocket = null;
const playerSockets = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'player';

  if (role === 'dm') {
    dmSocket = ws;
    // Notify DM of current player count
    ws.send(JSON.stringify({ type: 'player:count', count: playerSockets.size }));
  } else {
    playerSockets.add(ws);
    // Notify DM of updated player count
    if (dmSocket?.readyState === 1) {
      dmSocket.send(JSON.stringify({ type: 'player:count', count: playerSockets.size }));
    }
    // Ask DM to send init state to new player
    if (dmSocket?.readyState === 1) {
      dmSocket.send(JSON.stringify({ type: 'player:join' }));
    }
  }

  // Message types that players broadcast to ALL clients (DM + other players)
  const PLAYER_BROADCAST_TYPES = new Set(['range:highlight']);

  ws.on('message', (raw) => {
    const data = raw.toString();

    if (role === 'dm') {
      // Relay DM messages to all players
      for (const p of playerSockets) {
        if (p.readyState === 1) p.send(data);
      }
    } else if (role === 'player') {
      // Check if this message type should be broadcast to everyone
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = null; }

      if (parsed && PLAYER_BROADCAST_TYPES.has(parsed.type)) {
        // Broadcast to DM and all other players
        if (dmSocket?.readyState === 1) dmSocket.send(data);
        for (const p of playerSockets) {
          if (p !== ws && p.readyState === 1) p.send(data);
        }
      } else {
        // Standard: relay player messages to DM only
        if (dmSocket?.readyState === 1) {
          dmSocket.send(data);
        }
      }
    }
  });

  ws.on('close', () => {
    if (role === 'dm') {
      dmSocket = null;
    } else {
      playerSockets.delete(ws);
      // Notify DM of updated player count
      if (dmSocket?.readyState === 1) {
        dmSocket.send(JSON.stringify({ type: 'player:count', count: playerSockets.size }));
      }
    }
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Dungeon Editor:  http://localhost:${PORT}/editor/`);
  console.log(`Player View:     http://localhost:${PORT}/player/`);
  console.log(`WebSocket:       ws://localhost:${PORT}/ws`);
  console.log(`Export PNG:      POST http://localhost:${PORT}/api/export-png`);
});
