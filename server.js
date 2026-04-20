// Express static server + WebSocket relay for DM ↔ Player communication.
// Also provides server-side PNG export via @napi-rs/canvas.
//
// Usage: node server.js [port]  (default 3000)

import crypto from 'crypto';
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
import { loadGoboCatalogSync } from './src/render/gobo-catalog-node.js';
import {
  loadTextureCatalogMetadata,
  ensureTexturesForConfig,
  clearCatalogCache,
} from './src/render/texture-catalog-node.js';
import { buildDd2vtt } from './src/render/export-dd2vtt.js';

// ── Browser API polyfills (needed by render pipeline in Node.js) ─────────────

if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = Path2D;
if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = ImageData;

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) {
      this._canvas = createCanvas(w, h);
    }
    get width() {
      return this._canvas.width;
    }
    set width(v) {
      this._canvas.width = v;
    }
    get height() {
      return this._canvas.height;
    }
    set height(v) {
      this._canvas.height = v;
    }
    getContext(type, options) {
      return this._canvas.getContext(type, options);
    }
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

const __dirname = (() => {
  const d = path.dirname(fileURLToPath(import.meta.url));
  // In bundled mode (dist-electron/server.mjs), step up one level to project root.
  return path.basename(d) === 'dist-electron' ? path.dirname(d) : d;
})();
const PORT = parseInt(process.argv[2]) || 3000;

// Electron sets these to app.getPath('userData')/{dir} so user data
// is stored outside the bundle. Unset in standalone Node.js mode.
const userTexturePath = process.env.MAPWRIGHT_TEXTURE_PATH || null;
const userThemePath = process.env.MAPWRIGHT_THEME_PATH || path.join(__dirname, 'user-themes');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toTitleCase(str) {
  return str
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Dynamically scans props, bridges, and example maps to build the full set of
// polyhaven texture IDs referenced by the project (e.g. "polyhaven/stone_floor").
// Adding new .prop files or example maps automatically updates this list at runtime.
function getRequiredTextureIds() {
  const ids = new Set();
  // Matches "polyhaven/<id>" in any text — stops at whitespace, quotes, or JSON punctuation
  const re = /polyhaven\/([^\s"',})\]]+)/g;

  function scanFile(filePath) {
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      for (const [match] of text.matchAll(re)) ids.add(match);
    } catch {
      /* skip unreadable files */
    }
  }

  function scanDir(dir, ext) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith(ext)) scanFile(path.join(dir, file));
      }
    } catch {
      /* ignore missing dirs */
    }
  }

  // 1. .prop files (use "texfill polyhaven/<id>")
  scanDir(path.join(__dirname, 'src', 'props'), '.prop');

  // 2. Bridge renderer (contains hardcoded TEXTURE_IDS for each bridge type)
  scanFile(path.join(__dirname, 'src', 'render', 'bridges.js'));

  // 3. Example maps (.mapwright and .json compiled format)
  const examplesDir = path.join(__dirname, 'examples');
  scanDir(examplesDir, '.mapwright');
  scanDir(examplesDir, '.json');

  return [...ids];
}

// Writes manifest.json AND bundle.json to the textures directory by scanning
// all .texture files present in destDir. Called after every download session
// so the editor and server-side renderer see new textures immediately.
//
// manifest.json — flat array of ids (used for the per-file fallback path).
// bundle.json   — { version, textures: { id: parsedMetadata } } for one-shot
//                 client load. Binary PNGs stay per-file (browser lazy-loads
//                 them via Image.src); only the small .texture metadata files
//                 get bundled.
function writeManifest(destDir) {
  try {
    const texturesDir = path.dirname(destDir);
    const files = fs
      .readdirSync(destDir)
      .filter((f) => f.endsWith('.texture'))
      .sort();

    const ids = files.map((f) => `polyhaven/${path.basename(f, '.texture')}`);
    fs.writeFileSync(path.join(texturesDir, 'manifest.json'), JSON.stringify(ids, null, 2));

    const textures = {};
    const hasher = crypto.createHash('sha256');
    for (const file of files) {
      const id = `polyhaven/${path.basename(file, '.texture')}`;
      try {
        const text = fs.readFileSync(path.join(destDir, file), 'utf-8');
        const data = JSON.parse(text);
        textures[id] = data;
        hasher.update(id);
        hasher.update('\0');
        hasher.update(text);
        hasher.update('\0');
      } catch {
        /* skip unreadable or malformed .texture files */
      }
    }
    const version = hasher.digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(texturesDir, 'bundle.json'), JSON.stringify({ version, textures }));
  } catch {
    /* ignore — dir may not exist yet */
  }
}

// ── Load asset catalogs at startup ──────────────────────────────────────────

const propCatalog = loadPropCatalogSync();
loadGoboCatalogSync();
let textureCatalog = loadTextureCatalogMetadata();

// Load themes
const themesDir = path.join(__dirname, 'src', 'themes');
try {
  const keys = JSON.parse(fs.readFileSync(path.join(themesDir, 'manifest.json'), 'utf-8'));
  for (const key of keys) {
    try {
      const { displayName, ...themeProps } = JSON.parse(fs.readFileSync(path.join(themesDir, `${key}.theme`), 'utf-8'));
      THEMES[key] = themeProps;
    } catch {
      /* skip missing/malformed themes */
    }
  }
} catch (e) {
  console.warn('Warning: could not load themes:', e.message);
}

// Load user-saved themes
try {
  fs.mkdirSync(userThemePath, { recursive: true });
  for (const file of fs.readdirSync(userThemePath)) {
    if (!file.endsWith('.theme')) continue;
    const key = `user:${path.basename(file, '.theme')}`;
    try {
      const { displayName, ...themeProps } = JSON.parse(fs.readFileSync(path.join(userThemePath, file), 'utf-8'));
      THEMES[key] = themeProps;
    } catch {
      /* skip malformed */
    }
  }
} catch {
  /* ignore — directory may not be writable */
}

// Sanitize error messages to avoid leaking internal paths or stack traces.
function sanitizeError(err) {
  const msg = err?.message || 'Internal server error';
  // Strip absolute file paths (Windows and Unix)
  return msg.replace(/[A-Z]:\\[^\s"',)]+/gi, '<path>').replace(/\/(?:home|Users|tmp|var)[^\s"',)]+/g, '<path>');
}

// ── Express ─────────────────────────────────────────────────────────────────

const app = express();

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* wss://localhost:* https://api.github.com",
  );
  next();
});

// JSON body parser with generous limit for large dungeon configs
app.use('/api', express.json({ limit: '10mb' }));

// Serve textures from Electron userData first (user-downloaded in packaged app),
// then fall through to bundled src/ for dev mode.
if (userTexturePath) {
  app.use('/textures', express.static(userTexturePath));
}

// Serve user-saved themes
app.use('/user-themes', express.static(userThemePath));

// Data assets (props, lights, themes, rooms) always served from src/ — they're not code
app.use('/props', express.static(path.join(__dirname, 'src', 'props')));
app.use('/lights', express.static(path.join(__dirname, 'src', 'lights')));
app.use('/gobos', express.static(path.join(__dirname, 'src', 'gobos')));
app.use('/themes', express.static(path.join(__dirname, 'src', 'themes')));
app.use('/rooms', express.static(path.join(__dirname, 'src', 'rooms')));

// Dynamic manifest for the room vocab library: scan src/rooms/**/*.room.json
// and return a flat index so clients know what specs exist without probing.
app.get('/api/rooms/manifest', (_req, res) => {
  const roomsDir = path.join(__dirname, 'src', 'rooms');
  const manifest = [];
  function scan(dir, relCategory) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full, entry.name);
      } else if (entry.name.endsWith('.room.json')) {
        try {
          const spec = JSON.parse(fs.readFileSync(full, 'utf-8'));
          manifest.push({
            name: spec.name || path.basename(entry.name, '.room.json'),
            category: spec.category || relCategory || 'misc',
            tags: spec.tags || [],
            summary: spec.summary || '',
            path: relCategory ? `${relCategory}/${entry.name}` : entry.name,
          });
        } catch {
          /* skip malformed spec */
        }
      }
    }
  }
  scan(roomsDir, '');
  manifest.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ count: manifest.length, rooms: manifest });
});

// Serve Vite build output (dist/) if it exists, otherwise fall back to src/
// In production/Electron, dist/ contains the compiled TS+SCSS assets.
// In dev, use `npm run dev` (Vite dev server) instead of `npm start`.
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
} else {
  app.use(express.static(path.join(__dirname, 'src')));
}

// Serve example maps and their preview images
app.use('/examples', express.static(path.join(__dirname, 'examples')));

// List available example maps (name + thumbnail URL)
app.get('/api/examples', (_req, res) => {
  const dir = path.join(__dirname, 'examples');
  try {
    const files = fs.readdirSync(dir);
    const maps = files
      .filter((f) => f.endsWith('.mapwright') || f.endsWith('.json'))
      .map((f) => {
        const base = f.replace(/\.(mapwright|json)$/, '');
        const png = files.find((p) => p === `${base}.png`);
        return {
          name: toTitleCase(base),
          file: f,
          url: `/examples/${f}`,
          thumbnail: png ? `/examples/${png}` : null,
        };
      });
    res.json(maps);
  } catch {
    res.json([]);
  }
});

// Redirect / → /editor/ (matches old serve.json behavior)
app.get('/', (_req, res) => res.redirect('/editor/'));

// ── Open file endpoint (for file association / auto-load) ────────────────────

app.get('/api/open-file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.mapwright' && ext !== '.json') {
    return res.status(403).json({ error: 'Only .mapwright and .json files allowed' });
  }

  // Resolve to absolute path and block path traversal outside known directories
  const resolved = path.resolve(filePath);
  const allowedRoots = [path.join(__dirname, 'examples'), os.homedir()];
  if (!allowedRoots.some((root) => resolved.startsWith(root + path.sep) || resolved === root)) {
    return res.status(403).json({ error: 'Access denied: path outside allowed directories' });
  }

  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    const json = JSON.parse(content);
    if (!json.metadata || !json.cells) {
      return res.status(400).json({ error: 'Invalid dungeon file: missing metadata or cells' });
    }
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

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
    res.status(500).json({ error: sanitizeError(err) });
  }
});

// ── Export dd2vtt (Universal VTT) endpoint ──────────────────────────────

app.post('/api/export-dd2vtt', async (req, res) => {
  const start = performance.now();
  try {
    const config = req.body;
    if (!config?.metadata || !config?.cells) {
      return res.status(400).json({ error: 'Invalid dungeon config' });
    }

    await ensureTexturesForConfig(textureCatalog, config, propCatalog);

    const { width, height } = calculateCanvasSize(config);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    renderDungeonToCanvas(ctx, config, width, height, propCatalog, textureCatalog);

    const pngBuffer = canvas.toBuffer('image/png');
    const dd2vtt = buildDd2vtt(pngBuffer, config, width, height);

    const elapsed = (performance.now() - start).toFixed(0);
    const jsonStr = JSON.stringify(dd2vtt);
    console.log(`[export] dd2vtt ${width}x${height}, ${(jsonStr.length / 1024).toFixed(0)}KB in ${elapsed}ms`);

    const filename = (config.metadata.dungeonName || 'dungeon').replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.dd2vtt';
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(jsonStr);
  } catch (err) {
    console.error('[export] dd2vtt failed:', err);
    res.status(500).json({ error: sanitizeError(err) });
  }
});

// ── Version endpoint ─────────────────────────────────────────────────────

const { version: APP_VERSION } = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

app.get('/api/version', (_req, res) => {
  res.json({ version: APP_VERSION });
});

// ── User-Saved Themes CRUD ────────────────────────────────────────────────

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'untitled'
  );
}

app.get('/api/user-themes', (_req, res) => {
  try {
    const results = [];
    if (fs.existsSync(userThemePath)) {
      for (const file of fs.readdirSync(userThemePath)) {
        if (!file.endsWith('.theme')) continue;
        const key = path.basename(file, '.theme');
        try {
          const data = JSON.parse(fs.readFileSync(path.join(userThemePath, file), 'utf-8'));
          results.push({ key, displayName: data.displayName || key, filename: file });
        } catch {
          results.push({ key, displayName: key, filename: file });
        }
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

app.post('/api/user-themes', (req, res) => {
  try {
    const { name, theme } = req.body;
    if (!name || !theme) return res.status(400).json({ error: 'name and theme are required' });
    const slug = slugify(name);
    const filePath = path.join(userThemePath, `${slug}.theme`);
    if (fs.existsSync(filePath)) return res.status(409).json({ error: `Theme "${name}" already exists` });
    fs.mkdirSync(userThemePath, { recursive: true });
    const data = { displayName: name, ...theme };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    const { displayName, ...themeProps } = data;
    THEMES[`user:${slug}`] = themeProps;
    res.json({ key: slug });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

app.put('/api/user-themes/:key', (req, res) => {
  try {
    const key = path.basename(req.params.key);
    const { name, theme } = req.body;
    if (!name && !theme) return res.status(400).json({ error: 'name or theme is required' });
    const oldPath = path.join(userThemePath, `${key}.theme`);
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Theme not found' });
    const data = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));

    // Content update (theme properties changed)
    if (theme) {
      const updated = { displayName: name || data.displayName, ...theme };
      fs.writeFileSync(oldPath, JSON.stringify(updated, null, 2));
      const { displayName: _dn, ...themeProps } = updated;
      THEMES[`user:${key}`] = themeProps;
      return res.json({ key });
    }

    // Rename only
    const newSlug = slugify(name);
    const newPath = path.join(userThemePath, `${newSlug}.theme`);
    if (newSlug !== key && fs.existsSync(newPath))
      return res.status(409).json({ error: `Theme "${name}" already exists` });
    data.displayName = name;
    if (newSlug !== key) {
      fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
      fs.unlinkSync(oldPath);
      const { displayName, ...themeProps } = data;
      delete THEMES[`user:${key}`];
      THEMES[`user:${newSlug}`] = themeProps;
    } else {
      fs.writeFileSync(oldPath, JSON.stringify(data, null, 2));
    }
    res.json({ key: newSlug });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

app.delete('/api/user-themes/:key', (req, res) => {
  try {
    const key = path.basename(req.params.key);
    const filePath = path.join(userThemePath, `${key}.theme`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    delete THEMES[`user:${key}`];
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err) });
  }
});

app.get('/api/changelog', (_req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf-8');
    // First section (before the first `\n---\n` separator) is the latest release
    const latest = raw.split(/\n---\n/)[0].trim();
    const versionMatch = latest.match(/^## (v[\d.]+)/m);
    const version = versionMatch ? versionMatch[1] : `v${APP_VERSION}`;
    // Strip everything up to and including the `## vX.X.X` heading line
    const notes = latest.replace(/^[\s\S]*?^## v[\d.]+\n+/m, '').trim();
    res.json({ version, notes });
  } catch {
    res.json({ version: `v${APP_VERSION}`, notes: '' });
  }
});

// ── Update check endpoint ─────────────────────────────────────────────────

function semverGt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

let _updateCache = null;
let _updateCacheTime = 0;

app.get('/api/check-update', async (_req, res) => {
  // NSIS installs handle updates natively via electron-updater dialogs
  if (process.env.MAPWRIGHT_AUTO_UPDATE === 'true') {
    return res.json({ hasUpdate: false, autoUpdate: true });
  }

  const CACHE_TTL = 60 * 60 * 1000; // 1 hour
  if (_updateCache && Date.now() - _updateCacheTime < CACHE_TTL) {
    return res.json(_updateCache);
  }
  try {
    const r = await fetch('https://api.github.com/repos/LeoMelnyk/Mapwright/releases/latest', {
      headers: { 'User-Agent': 'Mapwright-App' },
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const { tag_name, html_url } = await r.json();
    const latestVersion = tag_name.replace(/^v/, '');
    const hasUpdate = semverGt(latestVersion, APP_VERSION);
    _updateCache = { hasUpdate, latestVersion, url: html_url };
    _updateCacheTime = Date.now();
    res.json(_updateCache);
  } catch {
    res.json({ hasUpdate: false });
  }
});

// ── AI session log endpoint ─────────────────────────────────────────────────
// Renderer-side AI logs are written here so they can be read from disk.
// Each new chat message resets the file (reset:true). We also enforce a hard
// size cap so a misbehaving renderer or local attacker can't fill the disk.

const AI_LOG_PATH = path.join(__dirname, 'ai-session.log');
const AI_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const AI_LOG_MAX_LINE = 64 * 1024; // 64 KB per line

app.post('/api/ai-log', (req, res) => {
  let { line = '', reset = false } = req.body;
  if (typeof line !== 'string') line = String(line);
  if (line.length > AI_LOG_MAX_LINE) line = line.slice(0, AI_LOG_MAX_LINE) + '…[truncated]';
  try {
    if (reset) {
      fs.writeFileSync(AI_LOG_PATH, line ? line + '\n' : '');
    } else {
      // Truncate the file if it's grown past the cap. We rotate to a single
      // .old file so a recent tail is still inspectable, then start fresh.
      try {
        const stat = fs.statSync(AI_LOG_PATH);
        if (stat.size > AI_LOG_MAX_BYTES) {
          try {
            fs.renameSync(AI_LOG_PATH, AI_LOG_PATH + '.old');
          } catch {
            /* best effort */
          }
        }
      } catch {
        /* file may not exist yet */
      }
      fs.appendFileSync(AI_LOG_PATH, line + '\n');
    }
  } catch {
    /* ignore write errors */
  }
  res.json({ ok: true });
});

// ── Ollama AI proxy endpoint ─────────────────────────────────────────────────
// Translates Anthropic-format requests (from the editor) to OpenAI format for
// local Ollama inference, then converts the response back to Anthropic format.
// No API key required — Ollama runs locally.

function convertToolsToOpenAI(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function convertMessagesToOpenAI(messages, system) {
  const result = [];
  if (system) result.push({ role: 'system', content: system });
  for (const { role, content } of messages) {
    if (typeof content === 'string') {
      result.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    // Tool results → one role:'tool' message per result block
    if (content.every((b) => b.type === 'tool_result')) {
      for (const b of content) result.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
      continue;
    }
    // Assistant turn with tool calls
    if (content.some((b) => b.type === 'tool_use')) {
      const tool_calls = content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input) },
        }));
      const text =
        content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('') || null;
      result.push({ role: 'assistant', content: text, tool_calls });
      continue;
    }
    // Plain text (assistant or user)
    result.push({
      role,
      content: content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    });
  }
  return result;
}

// Strip Qwen3 <think>...</think> reasoning blocks from response text.
// These are internal chain-of-thought tokens that should not appear in the chat UI.
function stripThinkingBlocks(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>\n?/g, '').trim();
}

/** Validate that a URL points to localhost/loopback only (prevents SSRF). */
function validateLocalUrl(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname.toLowerCase();
    const allowed = ['localhost', '127.0.0.1', '::1', '[::1]'];
    if (!allowed.includes(host)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function convertResponseToAnthropic(data) {
  const msg = data.choices[0].message;
  const content = [];
  const text = stripThinkingBlocks(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: (() => {
        try {
          return JSON.parse(tc.function.arguments);
        } catch {
          return tc.function.arguments;
        }
      })(),
    });
  }
  // Derive stop_reason from content rather than finish_reason — some models
  // report 'stop' even when they emitted tool calls.
  return {
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
  };
}

app.get('/api/ollama-status', async (req, res) => {
  const base = validateLocalUrl(req.query.base || 'http://localhost:11434');
  if (!base) return res.status(400).json({ running: false, models: [], error: 'Invalid base URL: must be localhost' });
  try {
    const r = await fetch(`${base}/api/tags`);
    if (!r.ok) return res.json({ running: false, models: [] });
    const data = await r.json();
    res.json({ running: true, models: (data.models ?? []).map((m) => m.name) });
  } catch {
    res.json({ running: false, models: [] });
  }
});

app.post('/api/claude', async (req, res) => {
  const { messages, model, tools, system, ollamaBase, stream } = req.body;
  const base = validateLocalUrl(ollamaBase || 'http://localhost:11434');
  if (!base) return res.status(400).json({ error: 'Invalid base URL: must be localhost' });
  const useStream = stream === true;

  // Ollama's streaming mode is unreliable with tool-calling (silently falls back to
  // non-streaming JSON). Always request non-streaming from Ollama for reliability,
  // then re-emit as SSE to the client when it wants streaming.
  try {
    const ollamaRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'qwen3.5:9b',
        messages: convertMessagesToOpenAI(messages, system),
        tools: tools?.length ? convertToolsToOpenAI(tools) : undefined,
        temperature: 0.6, // Qwen3 thinking mode needs higher temp for quality reasoning; 0.1 suppresses exploration
        max_tokens: 4096,
        stream: false, // Always non-streaming from Ollama for reliability
        options: { num_ctx: 32768 }, // Qwen3.5 supports 32k+ context; 16384 was too tight
      }),
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      console.error('[ollama] error', ollamaRes.status, errText);
      return res.status(ollamaRes.status).json({ error: `Ollama error: ${errText}` });
    }

    const ollamaData = await ollamaRes.json();
    console.log(
      '[ollama] finish_reason:',
      ollamaData.choices?.[0]?.finish_reason,
      '| content:',
      JSON.stringify(ollamaData.choices?.[0]?.message).slice(0, 200),
    );

    const anthropicResponse = convertResponseToAnthropic(ollamaData);

    if (!useStream) {
      res.json(anthropicResponse);
      return;
    }

    // Re-emit as SSE so client streaming code works unchanged
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const textBlock = anthropicResponse.content.find((b) => b.type === 'text');
    if (textBlock) {
      res.write(`data: ${JSON.stringify({ type: 'text_delta', text: textBlock.text })}\n\n`);
    }
    const toolBlocks = anthropicResponse.content.filter((b) => b.type === 'tool_use');
    if (toolBlocks.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'tool_use', blocks: toolBlocks })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[ollama] request failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: sanitizeError(err) || 'Ollama request failed' });
    else res.end();
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

// ── Texture download endpoints ───────────────────────────────────────────────

const POLYHAVEN_API = 'https://api.polyhaven.com';
// Some textures (fabric, leather, patterns) use col_01/col1 instead of Diffuse.
const DIFF_API_KEYS = ['Diffuse', 'diff_png', 'col_01', 'col_1', 'col1', 'coll1', 'Color', 'Albedo'];
const POLYHAVEN_MAPS = [
  { key: 'diff', apiKey: 'Diffuse' }, // overridden below with fallback logic
  { key: 'disp', apiKey: 'Displacement' },
  { key: 'nor', apiKey: 'nor_gl' },
  { key: 'arm', apiKey: 'arm' },
];

// Fetch the full Polyhaven catalog once in the background at startup.
// Stored in full so the download loop can use Polyhaven's own category names.
let _catalogCount = null;
let _assetCatalog = null; // { id: { categories: [...], ... } }
(async () => {
  try {
    const assets = await fetch(`${POLYHAVEN_API}/assets?type=textures`).then((r) => r.json());
    _assetCatalog = assets;
    _catalogCount = Object.keys(assets).length;
  } catch {
    /* ignore — no network, stays null */
  }
})();

// ── Download fan-out state ──────────────────────────────────────────────────
// The download runs as a server-side process independent of any SSE connection.
// Multiple downloader windows can observe the same download; closing a window
// does NOT cancel it (only an explicit POST /api/textures/cancel does).
let _downloadInProgress = false;
const _downloadSSEClients = new Set();
let _downloadSnapshot = null; // { total, index, name } — sent to late-joining clients
let _cancelDownload = null; // call to request cancellation

function _broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of _downloadSSEClients) {
    if (!client.writableEnded) client.write(msg);
  }
  // Update snapshot so new clients can catch up
  if (data.type === 'start') {
    _downloadSnapshot = { total: data.total };
  } else if (data.type === 'texture_start') {
    if (_downloadSnapshot) Object.assign(_downloadSnapshot, { index: data.index, name: data.name });
  }
  // On terminal events, clean up all client connections
  if (data.type === 'complete' || data.type === 'error' || data.type === 'cancelled') {
    _downloadInProgress = false;
    _downloadSnapshot = null;
    _cancelDownload = null;
    for (const client of _downloadSSEClients) {
      if (!client.writableEnded) client.end();
    }
    _downloadSSEClients.clear();
  }
}

// Returns texture availability counts (downloaded, required, and full catalog size).
app.get('/api/textures/status', (_req, res) => {
  const dir = userTexturePath
    ? path.join(userTexturePath, 'polyhaven')
    : path.join(__dirname, 'src', 'textures', 'polyhaven');
  try {
    const count = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.texture')).length : 0;
    const requiredCount = getRequiredTextureIds().length;
    res.json({
      available: count > 0,
      count,
      requiredCount,
      catalogCount: _catalogCount,
      downloadInProgress: _downloadInProgress,
      downloadSnapshot: _downloadSnapshot,
    });
  } catch {
    res.json({
      available: false,
      count: 0,
      requiredCount: 0,
      catalogCount: _catalogCount,
      downloadInProgress: _downloadInProgress,
      downloadSnapshot: _downloadSnapshot,
    });
  }
});

// Cancel a running download. The download loop checks `cancelled` on each
// iteration; closing an SSE connection no longer cancels it.
app.post('/api/textures/cancel', (_req, res) => {
  if (_cancelDownload) _cancelDownload();
  res.json({ ok: true });
});

// SSE endpoint — streams download progress for Polyhaven textures.
// Supports fan-out: multiple downloader windows can observe the same download.
// Closing a window removes it as an observer but does NOT stop the download.
// ?mode=required  downloads only textures used by built-in props
// ?mode=all       downloads the full Polyhaven catalog [default]
app.get('/api/textures/download', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  _downloadSSEClients.add(res);
  req.on('close', () => _downloadSSEClients.delete(res));

  if (_downloadInProgress) {
    // Catch-up: send current progress snapshot so the UI starts in the right state.
    if (_downloadSnapshot) {
      const local = (d) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`);
      };
      local({ type: 'start', total: _downloadSnapshot.total });
      if (_downloadSnapshot.index !== undefined) {
        // Fake a texture_done for the previous texture so the overall bar reflects progress.
        local({
          type: 'texture_done',
          index: _downloadSnapshot.index - 1,
          total: _downloadSnapshot.total,
          status: 'skipped',
        });
        local({
          type: 'texture_start',
          index: _downloadSnapshot.index,
          total: _downloadSnapshot.total,
          name: _downloadSnapshot.name,
        });
      }
    }
    return; // This client will receive future _broadcastSSE calls
  }

  _downloadInProgress = true;
  _downloadSnapshot = null;
  let cancelled = false;
  _cancelDownload = () => {
    cancelled = true;
  };

  const send = _broadcastSSE;

  const destDir = userTexturePath
    ? path.join(userTexturePath, 'polyhaven')
    : path.join(__dirname, 'src', 'textures', 'polyhaven');

  try {
    fs.mkdirSync(destDir, { recursive: true });

    let ids;
    if (req.query.mode === 'required') {
      ids = getRequiredTextureIds().map((id) => id.replace(/^polyhaven\//, ''));
      send({ type: 'start', total: ids.length, mode: 'required' });
    } else {
      send({ type: 'fetching_catalog' });
      const assets = await fetch(`${POLYHAVEN_API}/assets?type=textures`).then((r) => r.json());
      _assetCatalog = assets; // keep in sync for category lookups
      _catalogCount = Object.keys(assets).length;
      ids = Object.keys(assets);
      send({ type: 'start', total: ids.length, mode: 'all' });
    }

    let downloaded = 0,
      skipped = 0,
      failed = 0;
    const failures = [];

    for (let i = 0; i < ids.length; i++) {
      if (cancelled) break;

      const id = ids[i];
      const name = toTitleCase(id);

      send({ type: 'texture_start', index: i, total: ids.length, id, name });

      const textureFile = path.join(destDir, `${id}.texture`);
      if (fs.existsSync(textureFile)) {
        skipped++;
        send({ type: 'texture_done', index: i, total: ids.length, status: 'skipped' });
        continue;
      }

      let files;
      try {
        await sleep(300);
        files = await fetch(`${POLYHAVEN_API}/files/${id}`).then((r) => r.json());
      } catch (e) {
        failed++;
        failures.push({ id, name, reason: `API error: ${e.message}` });
        send({ type: 'texture_done', index: i, total: ids.length, status: 'failed', error: e.message });
        continue;
      }

      const mapPaths = {};

      for (const { key, apiKey } of POLYHAVEN_MAPS) {
        if (cancelled) break;

        // For diff, try multiple Polyhaven key names (varies by texture category).
        const keysToTry = key === 'diff' ? DIFF_API_KEYS : [apiKey];
        const fileInfo = keysToTry.map((k) => files?.[k]?.['1k']?.png).find((f) => f?.url);
        if (!fileInfo?.url) {
          send({ type: 'file_done', file: key, status: 'unavailable' });
          continue;
        }

        const filename = fileInfo.url.split('/').pop();
        const localPath = path.join(destDir, filename);

        if (fs.existsSync(localPath)) {
          const { size } = fs.statSync(localPath);
          if (size >= 1024) {
            mapPaths[key] = `polyhaven/${filename}`;
            send({ type: 'file_done', file: key, status: 'exists', totalBytes: size });
            continue;
          }
          fs.unlinkSync(localPath);
        }

        send({ type: 'file_start', file: key, filename });

        try {
          await sleep(300);
          const response = await fetch(fileInfo.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
          let bytesReceived = 0;
          const chunks = [];

          for await (const chunk of response.body) {
            if (cancelled) break;
            chunks.push(chunk);
            bytesReceived += chunk.byteLength;
            send({ type: 'file_progress', file: key, bytesReceived, totalBytes });
          }

          if (!cancelled) {
            const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
            fs.writeFileSync(localPath, buffer);
            mapPaths[key] = `polyhaven/${filename}`;
            send({ type: 'file_done', file: key, status: 'downloaded', totalBytes: buffer.length });
          }
        } catch (e) {
          send({ type: 'file_done', file: key, status: 'failed', error: e.message });
        }
      }

      if (mapPaths.diff) {
        // Use Polyhaven's own primary category (e.g. "Ground", "Architectural", "Nature").
        const rawCat = _assetCatalog?.[id]?.categories?.[0];
        const category = rawCat ? toTitleCase(rawCat) : 'Uncategorized';
        fs.writeFileSync(
          textureFile,
          JSON.stringify(
            {
              displayName: name,
              category,
              file: mapPaths.diff,
              maps: {
                ...(mapPaths.disp && { disp: mapPaths.disp }),
                ...(mapPaths.nor && { nor: mapPaths.nor }),
                ...(mapPaths.arm && { arm: mapPaths.arm }),
              },
              scale: 2.0,
              credit: 'Polyhaven (CC0)',
            },
            null,
            2,
          ),
        );
        downloaded++;
        send({ type: 'texture_done', index: i, total: ids.length, status: 'downloaded' });
      } else {
        failed++;
        failures.push({ id, name, reason: 'No diffuse map downloaded' });
        send({ type: 'texture_done', index: i, total: ids.length, status: 'failed' });
      }
    }

    if (failures.length) {
      console.error(`[Textures] ${failures.length} texture(s) failed:`);
      failures.forEach((f) => console.error(`  • ${f.name} (${f.id}): ${f.reason}`));
    }

    writeManifest(destDir);
    clearCatalogCache();
    textureCatalog = loadTextureCatalogMetadata();

    if (cancelled) {
      send({ type: 'cancelled' });
    } else {
      send({ type: 'complete', downloaded, skipped, failed, failures });
    }
  } catch (e) {
    send({ type: 'error', error: e.message });
  }
  // _broadcastSSE ends all client connections on complete/error/cancelled
});

const server = createServer(app);

// ── Session auth (LAN authentication) ──────────────────────────────────────

let sessionToken = null; // DM-only auth token (auto-generated, never shared with players)
let sessionPasswordHash = null; // Optional player password hash (scrypt)
let sessionPasswordSalt = null; // Salt for password hash
let playerToken = null; // Player auth token (issued after password validation)
let sessionTokenExpiry = null; // Token expiration timestamp (1 hour TTL)

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Simple per-IP rate limiter for auth endpoints (no external dependency)
const authAttempts = new Map(); // ip → { count, resetTime }
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 20; // max attempts per window

function isRateLimited(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetTime) {
    authAttempts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const derived = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(derived, hash);
}

app.post('/api/session/start', (req, res) => {
  sessionToken = crypto.randomBytes(16).toString('hex');
  sessionTokenExpiry = Date.now() + TOKEN_TTL_MS;
  const password = req.body?.password;
  if (typeof password === 'string' && password.length > 0) {
    const { hash, salt } = hashPassword(password);
    sessionPasswordHash = hash;
    sessionPasswordSalt = salt;
    playerToken = crypto.randomBytes(16).toString('hex');
  } else {
    sessionPasswordHash = null;
    sessionPasswordSalt = null;
    playerToken = null;
  }
  res.json({ token: sessionToken });
});

app.post('/api/session/end', (_req, res) => {
  sessionToken = null;
  sessionPasswordHash = null;
  sessionPasswordSalt = null;
  playerToken = null;
  sessionTokenExpiry = null;
  res.json({ ok: true });
});

app.get('/api/session/status', (_req, res) => {
  // Auto-expire session tokens after TTL
  if (sessionToken && sessionTokenExpiry && Date.now() > sessionTokenExpiry) {
    sessionToken = null;
    sessionPasswordHash = null;
    sessionPasswordSalt = null;
    playerToken = null;
    sessionTokenExpiry = null;
  }
  res.json({
    active: sessionToken !== null,
    passwordRequired: sessionPasswordHash !== null,
  });
});

app.post('/api/session/auth', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many attempts, try again later' });
  if (!sessionToken) return res.status(400).json({ error: 'No active session' });
  if (!sessionPasswordHash) return res.status(400).json({ error: 'No password required' });
  const password = req.body?.password;
  if (typeof password !== 'string' || !verifyPassword(password, sessionPasswordHash, sessionPasswordSalt)) {
    return res.status(403).json({ error: 'Incorrect password' });
  }
  res.json({ token: playerToken });
});

// ── WebSocket relay ─────────────────────────────────────────────────────────

// Hard limit on relay payload size. Real DM messages (full dungeon snapshots
// with props/lights) can run a few hundred KB; 2 MB gives generous headroom
// while still preventing a malicious client from OOMing the relay or peers.
const WS_MAX_PAYLOAD = 2 * 1024 * 1024;

// Player → server message type allowlist. Anything outside this set is dropped
// rather than relayed. Keep this in sync with the player client's outbound
// message types in src/player/.
const PLAYER_ALLOWED_TYPES = new Set(['range:highlight']);

// Player message types that fan out to other clients (DM + other players)
// instead of going only to the DM.
const PLAYER_BROADCAST_TYPES = new Set(['range:highlight']);

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: WS_MAX_PAYLOAD,
  // Avoid permessage-deflate context takeover, which would let a single client
  // pin large dictionaries in memory across messages.
  perMessageDeflate: {
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  },
});

let dmSocket = null;
const playerSockets = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'player';

  // Authentication: DM must provide the session token; players must provide
  // the player token (if a password was set) or connect freely (if no password).
  if (sessionToken !== null) {
    // Check token expiry
    if (sessionTokenExpiry && Date.now() > sessionTokenExpiry) {
      ws.close(4003, 'Session expired');
      return;
    }
    const token = url.searchParams.get('token');
    if (role === 'dm') {
      if (token !== sessionToken) {
        ws.close(4001, 'Invalid DM token');
        return;
      }
    } else if (sessionPasswordHash !== null) {
      // Password-protected session — players need the player token
      if (token !== playerToken) {
        ws.close(4002, 'Player authentication required');
        return;
      }
    }
    // No password set — players connect freely
  }

  if (role === 'dm') {
    // Close any previous DM socket to prevent orphaned connections
    if (dmSocket && dmSocket.readyState <= 1) {
      try {
        dmSocket.close(4004, 'Replaced by new DM connection');
      } catch {}
    }
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

  ws.on('message', (raw) => {
    // ws enforces maxPayload above, but double-guard against absurdly large
    // strings produced by toString() on multi-byte buffers.
    if (raw.length > WS_MAX_PAYLOAD) return;
    const data = raw.toString();

    if (role === 'dm') {
      // DM is trusted (token-authenticated above). Relay to all players.
      for (const p of playerSockets) {
        if (p.readyState === 1) p.send(data);
      }
      return;
    }

    if (role !== 'player') return;

    // Player messages are untrusted. Require parseable JSON with a known
    // type, and drop everything else rather than relay it to the DM.
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return;
    if (!PLAYER_ALLOWED_TYPES.has(parsed.type)) return;

    if (PLAYER_BROADCAST_TYPES.has(parsed.type)) {
      // Broadcast to DM and all other players
      if (dmSocket?.readyState === 1) dmSocket.send(data);
      for (const p of playerSockets) {
        if (p !== ws && p.readyState === 1) p.send(data);
      }
    } else if (dmSocket?.readyState === 1) {
      dmSocket.send(data);
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
