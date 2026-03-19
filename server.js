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
import { loadTextureCatalogMetadata, ensureTexturesForConfig, clearCatalogCache } from './src/render/texture-catalog-node.js';

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

// Electron sets this to app.getPath('userData')/textures so downloaded textures
// are stored outside the bundle. Unset in standalone Node.js mode.
const userTexturePath = process.env.MAPWRIGHT_TEXTURE_PATH || null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function toTitleCase(str) {
  return str.split(/[\s_-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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
    } catch { /* skip unreadable files */ }
  }

  function scanDir(dir, ext) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith(ext)) scanFile(path.join(dir, file));
      }
    } catch { /* ignore missing dirs */ }
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

// Writes manifest.json to the textures directory (parent of destDir/polyhaven/)
// by scanning all .texture files present. Called after every download session
// so the editor and server-side renderer know what's available.
function writeManifest(destDir) {
  try {
    const ids = fs.readdirSync(destDir)
      .filter(f => f.endsWith('.texture'))
      .map(f => `polyhaven/${path.basename(f, '.texture')}`)
      .sort();
    fs.writeFileSync(
      path.join(path.dirname(destDir), 'manifest.json'),
      JSON.stringify(ids, null, 2)
    );
  } catch { /* ignore — dir may not exist yet */ }
}

// ── Load asset catalogs at startup ──────────────────────────────────────────

const propCatalog = loadPropCatalogSync();
let textureCatalog = loadTextureCatalogMetadata();

// Load themes
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

// Serve textures from Electron userData first (user-downloaded in packaged app),
// then fall through to bundled src/ for dev mode.
if (userTexturePath) {
  app.use('/textures', express.static(userTexturePath));
}

// Static files from src/ (same root as old `npx serve src`)
app.use(express.static(path.join(__dirname, 'src')));

// Serve example maps and their preview images
app.use('/examples', express.static(path.join(__dirname, 'examples')));

// List available example maps (name + thumbnail URL)
app.get('/api/examples', (_req, res) => {
  const dir = path.join(__dirname, 'examples');
  try {
    const files = fs.readdirSync(dir);
    const maps = files
      .filter(f => f.endsWith('.mapwright') || f.endsWith('.json'))
      .map(f => {
        const base = f.replace(/\.(mapwright|json)$/, '');
        const png = files.find(p => p === `${base}.png`);
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

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const json = JSON.parse(content);
    if (!json.metadata || !json.cells) {
      return res.status(400).json({ error: 'Invalid dungeon file: missing metadata or cells' });
    }
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── Version endpoint ─────────────────────────────────────────────────────

const { version: APP_VERSION } = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8'));

app.get('/api/version', (_req, res) => {
  res.json({ version: APP_VERSION });
});

app.get('/api/changelog', (_req, res) => {
  try {
    const raw = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'CHANGELOG.md'), 'utf-8');
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
      headers: { 'User-Agent': 'Mapwright-App' }
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
// Each new chat message resets the file (reset:true), preventing unbounded growth.

const AI_LOG_PATH = path.join(__dirname, 'ai-session.log');

app.post('/api/ai-log', (req, res) => {
  const { line = '', reset = false } = req.body;
  try {
    if (reset) {
      fs.writeFileSync(AI_LOG_PATH, line ? line + '\n' : '');
    } else {
      fs.appendFileSync(AI_LOG_PATH, line + '\n');
    }
  } catch { /* ignore write errors */ }
  res.json({ ok: true });
});

// ── Ollama AI proxy endpoint ─────────────────────────────────────────────────
// Translates Anthropic-format requests (from the editor) to OpenAI format for
// local Ollama inference, then converts the response back to Anthropic format.
// No API key required — Ollama runs locally.

function convertToolsToOpenAI(tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function convertMessagesToOpenAI(messages, system) {
  const result = [];
  if (system) result.push({ role: 'system', content: system });
  for (const { role, content } of messages) {
    if (typeof content === 'string') { result.push({ role, content }); continue; }
    if (!Array.isArray(content)) continue;
    // Tool results → one role:'tool' message per result block
    if (content.every(b => b.type === 'tool_result')) {
      for (const b of content)
        result.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
      continue;
    }
    // Assistant turn with tool calls
    if (content.some(b => b.type === 'tool_use')) {
      const tool_calls = content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function',
        function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input) },
      }));
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('') || null;
      result.push({ role: 'assistant', content: text, tool_calls });
      continue;
    }
    // Plain text (assistant or user)
    result.push({ role, content: content.filter(b => b.type === 'text').map(b => b.text).join('') });
  }
  return result;
}

// Strip Qwen3 <think>...</think> reasoning blocks from response text.
// These are internal chain-of-thought tokens that should not appear in the chat UI.
function stripThinkingBlocks(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>\n?/g, '').trim();
}

function convertResponseToAnthropic(data) {
  const msg = data.choices[0].message;
  const content = [];
  const text = stripThinkingBlocks(msg.content);
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls ?? []) {
    content.push({
      type: 'tool_use', id: tc.id, name: tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return tc.function.arguments; } })(),
    });
  }
  // Derive stop_reason from content rather than finish_reason — some models
  // report 'stop' even when they emitted tool calls.
  return {
    content,
    stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
  };
}

app.get('/api/ollama-status', async (req, res) => {
  const base = req.query.base || 'http://localhost:11434';
  try {
    const r = await fetch(`${base}/api/tags`);
    if (!r.ok) return res.json({ running: false, models: [] });
    const data = await r.json();
    res.json({ running: true, models: (data.models ?? []).map(m => m.name) });
  } catch {
    res.json({ running: false, models: [] });
  }
});

app.post('/api/claude', async (req, res) => {
  const { messages, model, tools, system, ollamaBase, stream } = req.body;
  const base = ollamaBase || 'http://localhost:11434';
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
        temperature: 0.6,      // Qwen3 thinking mode needs higher temp for quality reasoning; 0.1 suppresses exploration
        max_tokens: 4096,
        stream: false,         // Always non-streaming from Ollama for reliability
        options: { num_ctx: 32768 }, // Qwen3.5 supports 32k+ context; 16384 was too tight
      }),
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      console.error('[ollama] error', ollamaRes.status, errText);
      return res.status(ollamaRes.status).json({ error: `Ollama error: ${errText}` });
    }

    const ollamaData = await ollamaRes.json();
    console.log('[ollama] finish_reason:', ollamaData.choices?.[0]?.finish_reason,
      '| content:', JSON.stringify(ollamaData.choices?.[0]?.message).slice(0, 200));

    const anthropicResponse = convertResponseToAnthropic(ollamaData);

    if (!useStream) {
      res.json(anthropicResponse);
      return;
    }

    // Re-emit as SSE so client streaming code works unchanged
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const textBlock = anthropicResponse.content.find(b => b.type === 'text');
    if (textBlock) {
      res.write(`data: ${JSON.stringify({ type: 'text_delta', text: textBlock.text })}\n\n`);
    }
    const toolBlocks = anthropicResponse.content.filter(b => b.type === 'tool_use');
    if (toolBlocks.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'tool_use', blocks: toolBlocks })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[ollama] request failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Ollama request failed' });
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
  { key: 'diff', apiKey: 'Diffuse' },  // overridden below with fallback logic
  { key: 'disp', apiKey: 'Displacement' },
  { key: 'nor',  apiKey: 'nor_gl' },
  { key: 'arm',  apiKey: 'arm' },
];

// Fetch the full Polyhaven catalog once in the background at startup.
// Stored in full so the download loop can use Polyhaven's own category names.
let _catalogCount = null;
let _assetCatalog = null; // { id: { categories: [...], ... } }
(async () => {
  try {
    const assets = await fetch(`${POLYHAVEN_API}/assets?type=textures`).then(r => r.json());
    _assetCatalog = assets;
    _catalogCount = Object.keys(assets).length;
  } catch { /* ignore — no network, stays null */ }
})();

// ── Download fan-out state ──────────────────────────────────────────────────
// The download runs as a server-side process independent of any SSE connection.
// Multiple downloader windows can observe the same download; closing a window
// does NOT cancel it (only an explicit POST /api/textures/cancel does).
let _downloadInProgress = false;
const _downloadSSEClients = new Set();
let _downloadSnapshot = null; // { total, index, name } — sent to late-joining clients
let _cancelDownload = null;   // call to request cancellation

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
    const count = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.texture')).length
      : 0;
    const requiredCount = getRequiredTextureIds().length;
    res.json({ available: count > 0, count, requiredCount, catalogCount: _catalogCount, downloadInProgress: _downloadInProgress, downloadSnapshot: _downloadSnapshot });
  } catch {
    res.json({ available: false, count: 0, requiredCount: 0, catalogCount: _catalogCount, downloadInProgress: _downloadInProgress, downloadSnapshot: _downloadSnapshot });
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
      const local = d => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(d)}\n\n`); };
      local({ type: 'start', total: _downloadSnapshot.total });
      if (_downloadSnapshot.index !== undefined) {
        // Fake a texture_done for the previous texture so the overall bar reflects progress.
        local({ type: 'texture_done', index: _downloadSnapshot.index - 1, total: _downloadSnapshot.total, status: 'skipped' });
        local({ type: 'texture_start', index: _downloadSnapshot.index, total: _downloadSnapshot.total, name: _downloadSnapshot.name });
      }
    }
    return; // This client will receive future _broadcastSSE calls
  }

  _downloadInProgress = true;
  _downloadSnapshot = null;
  let cancelled = false;
  _cancelDownload = () => { cancelled = true; };

  const send = _broadcastSSE;

  const destDir = userTexturePath
    ? path.join(userTexturePath, 'polyhaven')
    : path.join(__dirname, 'src', 'textures', 'polyhaven');

  try {
    fs.mkdirSync(destDir, { recursive: true });

    let ids;
    if (req.query.mode === 'required') {
      ids = getRequiredTextureIds().map(id => id.replace(/^polyhaven\//, ''));
      send({ type: 'start', total: ids.length, mode: 'required' });
    } else {
      send({ type: 'fetching_catalog' });
      const assets = await fetch(`${POLYHAVEN_API}/assets?type=textures`).then(r => r.json());
      _assetCatalog = assets; // keep in sync for category lookups
      _catalogCount = Object.keys(assets).length;
      ids = Object.keys(assets);
      send({ type: 'start', total: ids.length, mode: 'all' });
    }

    let downloaded = 0, skipped = 0, failed = 0;
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
        files = await fetch(`${POLYHAVEN_API}/files/${id}`).then(r => r.json());
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
        const fileInfo = keysToTry.map(k => files?.[k]?.['1k']?.png).find(f => f?.url);
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
            const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
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
        fs.writeFileSync(textureFile, JSON.stringify({
          displayName: name,
          category,
          file: mapPaths.diff,
          maps: {
            ...(mapPaths.disp && { disp: mapPaths.disp }),
            ...(mapPaths.nor  && { nor:  mapPaths.nor  }),
            ...(mapPaths.arm  && { arm:  mapPaths.arm  }),
          },
          scale: 2.0,
          credit: 'Polyhaven (CC0)',
        }, null, 2));
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
      failures.forEach(f => console.error(`  • ${f.name} (${f.id}): ${f.reason}`));
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
