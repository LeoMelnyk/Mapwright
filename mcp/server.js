#!/usr/bin/env node
/**
 * Mapwright MCP Server
 *
 * Exposes the Mapwright dungeon editor API to Claude and other MCP clients.
 *
 * Prerequisites:
 *   - Node.js 18+
 *   - mapwright server running: cd <mapwright-dir> && npm start
 *     (required only for execute_commands tool)
 *
 * Environment:
 *   MAPWRIGHT_DIR  — absolute path to the mapwright project root
 *                    (defaults to the parent of this file's directory)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { get as httpGet } from 'http';
import path from 'path';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPWRIGHT_DIR = process.env.MAPWRIGHT_DIR
  ? path.resolve(process.env.MAPWRIGHT_DIR)
  : path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether the mapwright editor server is listening on `port`. */
function isServerRunning(port = 3000) {
  return new Promise((resolve) => {
    const req = httpGet(`http://localhost:${port}/`, (res) => {
      resolve(true);
      res.destroy();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Validate that a file path is within allowed directories.
 */
function validateFilePath(filePath, allowedDirs) {
  const resolved = path.resolve(filePath);
  const isAllowed = allowedDirs.some((dir) => {
    const resolvedDir = path.resolve(dir);
    const rel = path.relative(resolvedDir, resolved);
    // path.relative returns a string starting with '..' if resolved is outside dir
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!isAllowed) {
    throw new Error(`File path "${resolved}" is outside allowed directories: ${allowedDirs.join(', ')}`);
  }
  return resolved;
}

/**
 * Spawn a subprocess and capture stdout + stderr, with hard buffer caps so a
 * runaway child can't OOM the MCP server. If a stream exceeds MAX_BUFFER, we
 * append a truncation marker, stop appending, and kill the child.
 */
const PROCESS_MAX_BUFFER = 8 * 1024 * 1024; // 8 MB per stream
function runProcess(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const append = (which, chunk) => {
      const cur = which === 'out' ? stdout : stderr;
      if (cur.length >= PROCESS_MAX_BUFFER) return;
      const remaining = PROCESS_MAX_BUFFER - cur.length;
      const text = chunk.toString();
      if (text.length <= remaining) {
        if (which === 'out') stdout += text;
        else stderr += text;
      } else {
        const truncated = text.slice(0, remaining) + '\n…[truncated: stream exceeded MCP buffer cap]';
        if (which === 'out') stdout += truncated;
        else stderr += truncated;
        if (!killed) {
          killed = true;
          try {
            child.kill();
          } catch {
            /* best effort */
          }
        }
      }
    };
    child.stdout.on('data', (d) => append('out', d));
    child.stderr.on('data', (d) => append('err', d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message }));
  });
}

/** Run commands through the puppeteer bridge, returning { isError, text }. */
async function runBridge(bridgeArgs) {
  const result = await runProcess(
    process.execPath, // node binary
    [`${MAPWRIGHT_DIR}/tools/puppeteer-bridge.js`, ...bridgeArgs],
    MAPWRIGHT_DIR,
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { isError: result.code !== 0, text: output || '(no output)' };
}

// ---------------------------------------------------------------------------
// Daemon manager — singleton long-running puppeteer-bridge process.
//
// Lazy-spawned on first request. Reused across calls so the browser stays
// open between MCP tool invocations. Idle timeout (default 10 min) kills the
// daemon to free resources; next call respawns it.
// ---------------------------------------------------------------------------

const DAEMON_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

class BridgeDaemon {
  constructor(port) {
    this.port = port;
    this.proc = null;
    this.readyPromise = null;
    this.pending = new Map(); // id -> {resolve, reject}
    this.nextId = 1;
    this.buffer = '';
    this.idleTimer = null;
  }

  async start(visible = false) {
    if (this.proc) return this.readyPromise;
    const args = [`${MAPWRIGHT_DIR}/tools/puppeteer-bridge.js`, '--daemon', '--port', String(this.port)];
    if (visible) args.push('--visible');
    this.proc = spawn(process.execPath, args, { cwd: MAPWRIGHT_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    this.readyPromise = new Promise((resolve, reject) => {
      const onData = (chunk) => {
        this.buffer += chunk.toString();
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.ready) {
            resolve();
            continue;
          }
          if (msg.id != null && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            // Progress event — forward to the per-request callback if registered
            if (msg.type === 'progress') {
              if (entry.onProgress) {
                try {
                  entry.onProgress(msg);
                } catch {
                  /* swallow — caller's progress handler must not break the daemon */
                }
              }
              continue;
            }
            // Result (or any non-progress message) — resolve and remove
            this.pending.delete(msg.id);
            entry.resolve(msg);
          }
        }
      };
      this.proc.stdout.on('data', onData);
      this.proc.stderr.on('data', () => {}); // discard daemon stderr (puppeteer noise)
      this.proc.on('exit', (code) => {
        // Reject any in-flight requests
        for (const { reject: rj } of this.pending.values()) rj(new Error(`bridge daemon exited (code=${code})`));
        this.pending.clear();
        this.proc = null;
        this.readyPromise = null;
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
      });
      this.proc.on('error', (err) => reject(err));
      // Hard timeout for ready
      setTimeout(() => reject(new Error('bridge daemon ready timeout (30s)')), 30000);
    });
    await this.readyPromise;
    this.bumpIdle();
    return this.readyPromise;
  }

  bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.shutdown().catch(() => {});
    }, DAEMON_IDLE_TIMEOUT_MS);
  }

  async execute(req, onProgress) {
    if (!this.proc) await this.start(req.visible);
    const id = this.nextId++;
    const stream = typeof onProgress === 'function';
    const payload = { id, op: 'execute', stream, ...req };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try {
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        this.pending.delete(id);
        reject(e);
        return;
      }
      this.bumpIdle();
    });
  }

  async shutdown() {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ id: 0, op: 'shutdown' }) + '\n');
    } catch {}
    // Give the daemon ~2s to clean up
    await new Promise((r) => setTimeout(r, 2000));
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
    }
  }
}

const daemons = new Map(); // key = `${port}:${visible}` -> BridgeDaemon

function getDaemon(port, visible) {
  const key = `${port}:${visible ? 'v' : 'h'}`;
  let d = daemons.get(key);
  if (!d) {
    d = new BridgeDaemon(port);
    daemons.set(key, d);
  }
  return d;
}

// On MCP shutdown, terminate all daemons
process.on('SIGINT', async () => {
  for (const d of daemons.values()) await d.shutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  for (const d of daemons.values()) await d.shutdown();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server({ name: 'mapwright', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });

// ---- Tools -----------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'execute_commands',
      description:
        'Execute Mapwright editor API commands via the Puppeteer automation bridge. ' +
        'The mapwright server must be running on port 3000 (run `npm start` in the mapwright directory). ' +
        'Commands are a JSON array of [methodName, ...args] tuples — e.g. ' +
        '[["newMap","My Dungeon",25,35],["createRoom",2,2,10,12],["setDoor",5,12,"east"]]. ' +
        'See the mapwright://editor-api resource for the full API reference (250+ methods, searchable via `apiSearch`). ' +
        'TIP: pass visible=true + slow_mo=200 to keep the browser open across calls (Chrome remote debugging persists ' +
        'between invocations) — combine with the `pauseForReview` API method for interactive multi-phase builds.',
      inputSchema: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            description: 'Array of [methodName, ...args] command tuples',
            items: { type: 'array' },
          },
          load_file: {
            type: 'string',
            description: 'Absolute path to a .mapwright (or .json) map file to load before running commands',
          },
          save_file: {
            type: 'string',
            description: 'Absolute path to save the resulting .mapwright map after commands',
          },
          screenshot_file: {
            type: 'string',
            description: 'Absolute path to save an editor viewport screenshot (.png) after commands',
          },
          export_png: {
            type: 'string',
            description:
              'Absolute path to save a high-quality exported .png (full HQ lighting pipeline). ' +
              'Prefer this over screenshot_file for final output.',
          },
          dry_run: {
            type: 'boolean',
            description: 'Execute commands but skip all file I/O (screenshot, save, export). Useful for validation.',
            default: false,
          },
          continue_on_error: {
            type: 'boolean',
            description: 'Continue executing commands even if one fails (still exits 1 if any failed)',
            default: false,
          },
          port: {
            type: 'number',
            description: 'Editor server port (default: 3000)',
            default: 3000,
          },
          visible: {
            type: 'boolean',
            description:
              'Show the browser window while commands execute (headed mode). Use for live debugging so the user can watch changes happen in real time.',
            default: false,
          },
          slow_mo: {
            type: 'number',
            description:
              'Delay in milliseconds between commands when visible=true (default: 0). Use e.g. 300 to make each command visibly animate.',
            default: 0,
          },
          use_daemon: {
            type: 'boolean',
            description:
              'Use the long-running bridge daemon (browser persists between MCP calls — fast). Default true. Set false to spawn a fresh bridge subprocess per call (legacy one-shot mode).',
            default: true,
          },
          inline_images: {
            type: 'boolean',
            description:
              'Surface high-resolution export_png output as an inline image content block in addition to writing the file. Off by default for export (images are large). Screenshots and prop thumbnails are always surfaced inline.',
            default: false,
          },
        },
        required: ['commands'],
      },
    },
    {
      name: 'render_json',
      description:
        'Render a compiled dungeon .mapwright file to PNG using the standalone pipeline (no editor server needed). ' +
        'Output PNG is saved next to the .mapwright file.',
      inputSchema: {
        type: 'object',
        properties: {
          json_file: {
            type: 'string',
            description: 'Absolute path to the dungeon .mapwright (or .json) file',
          },
        },
        required: ['json_file'],
      },
    },
    {
      name: 'check_server',
      description: 'Check whether the mapwright editor server is running on the given port.',
      inputSchema: {
        type: 'object',
        properties: {
          port: {
            type: 'number',
            description: 'Port to check (default: 3000)',
            default: 3000,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  // MCP progress notifications: client sends a progressToken in _meta,
  // server emits notifications/progress with that token while the call runs.
  const progressToken = request.params._meta?.progressToken;
  const sendProgress =
    progressToken != null && extra?.sendNotification
      ? async (progress, total, message) => {
          try {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress, total, message },
            });
          } catch {
            /* notification failures should never break the tool */
          }
        }
      : null;

  // ---- execute_commands ----------------------------------------------------
  if (name === 'execute_commands') {
    const port = args.port ?? 3000;
    const running = await isServerRunning(port);
    if (!running) {
      return {
        content: [
          {
            type: 'text',
            text:
              `ERROR: Mapwright server is not running on port ${port}.\n\n` +
              `Start it with:\n  cd "${MAPWRIGHT_DIR}" && npm start\n\n` +
              `Then retry. The execute_commands tool requires the editor server.`,
          },
        ],
        isError: true,
      };
    }

    // Validate file paths against allowed directories
    const allowedDirs = [MAPWRIGHT_DIR, os.tmpdir(), os.homedir()];
    try {
      if (args.load_file) validateFilePath(args.load_file, allowedDirs);
      if (args.save_file) validateFilePath(args.save_file, allowedDirs);
      if (args.screenshot_file) validateFilePath(args.screenshot_file, allowedDirs);
      if (args.export_png) validateFilePath(args.export_png, allowedDirs);
    } catch (err) {
      return { content: [{ type: 'text', text: `Path validation error: ${err.message}` }], isError: true };
    }

    // ── Daemon path (default) ─────────────────────────────────────
    const useDaemon = args.use_daemon !== false;
    if (useDaemon) {
      const daemon = getDaemon(port, !!args.visible);
      try {
        const req = {
          commands: args.commands,
          load: args.load_file,
          save: args.save_file,
          screenshot: args.screenshot_file,
          exportPng: args.export_png,
          dryRun: !!args.dry_run,
          continueOnError: !!args.continue_on_error,
          slowMo: args.slow_mo || 0,
          visible: !!args.visible,
          inlineImages: args.inline_images,
        };
        // If client sent a progressToken, stream per-command progress events
        const onProgress = sendProgress
          ? (msg) => {
              if (msg.index != null) {
                void sendProgress(msg.index, msg.total ?? null, msg.line);
              }
            }
          : undefined;
        const resp = await daemon.execute(req, onProgress);
        const content = [{ type: 'text', text: resp.output || '(no output)' }];
        // Surface extracted image dataUrls as image content blocks so vision-capable
        // MCP clients (Claude, etc.) can actually see prop thumbnails, screenshots,
        // and shape previews instead of parsing walls of base64 text.
        if (Array.isArray(resp.images)) {
          for (const img of resp.images) {
            if (!img || typeof img.dataUrl !== 'string') continue;
            const commaIdx = img.dataUrl.indexOf(',');
            if (commaIdx < 0) continue;
            const data = img.dataUrl.slice(commaIdx + 1);
            const mimeType = img.mimeType || 'image/png';
            if (img.label) content.push({ type: 'text', text: `[image: ${img.label}]` });
            content.push({ type: 'image', data, mimeType });
          }
        }
        return { content, isError: !resp.ok };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Bridge daemon error: ${err.message}` }],
          isError: true,
        };
      }
    }

    // ── Legacy one-shot subprocess path ──────────────────────────
    // Write commands to a temp file to avoid shell arg-length limits
    const tmpFile = path.join(os.tmpdir(), `mapwright-cmds-${Date.now()}.json`);
    await writeFile(tmpFile, JSON.stringify(args.commands));

    const bridgeArgs = ['--commands-file', tmpFile];
    if (args.load_file) bridgeArgs.push('--load', args.load_file);
    if (args.save_file) bridgeArgs.push('--save', args.save_file);
    if (args.screenshot_file) bridgeArgs.push('--screenshot', args.screenshot_file);
    if (args.export_png) bridgeArgs.push('--export-png', args.export_png);
    if (args.dry_run) bridgeArgs.push('--dry-run');
    if (args.continue_on_error) bridgeArgs.push('--continue-on-error');
    if (args.port) bridgeArgs.push('--port', String(args.port));
    if (args.visible) bridgeArgs.push('--visible');
    if (args.slow_mo) bridgeArgs.push('--slow-mo', String(args.slow_mo));

    let isError, text;
    try {
      ({ isError, text } = await runBridge(bridgeArgs));
    } finally {
      await unlink(tmpFile).catch(() => {});
    }

    return { content: [{ type: 'text', text }], isError };
  }

  // ---- render_json ---------------------------------------------------------
  if (name === 'render_json') {
    const allowedRenderDirs = [MAPWRIGHT_DIR, os.tmpdir(), os.homedir()];
    let jsonFile;
    try {
      jsonFile = validateFilePath(args.json_file, allowedRenderDirs);
    } catch (err) {
      return { content: [{ type: 'text', text: `Path validation error: ${err.message}` }], isError: true };
    }
    const result = await runProcess(
      process.execPath,
      [`${MAPWRIGHT_DIR}/tools/generate_dungeon.js`, jsonFile],
      MAPWRIGHT_DIR,
    );
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    return { content: [{ type: 'text', text: text || '(no output)' }], isError: result.code !== 0 };
  }

  // ---- check_server --------------------------------------------------------
  if (name === 'check_server') {
    const port = args.port ?? 3000;
    const running = await isServerRunning(port);
    return {
      content: [
        {
          type: 'text',
          text: running
            ? `Mapwright server is running on port ${port}.`
            : `Mapwright server is NOT running on port ${port}.\n\nStart it with:\n  cd "${MAPWRIGHT_DIR}" && npm start`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ---- Resources -------------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'mapwright://editor-api',
      name: 'Editor API Reference',
      description:
        'Complete reference for all ~70 editor API methods available via the Puppeteer bridge — ' +
        'rooms, walls, doors, stairs, props, lighting, textures, fills, levels, AI helpers, and more.',
      mimeType: 'text/markdown',
    },
    {
      uri: 'mapwright://workflow',
      name: 'AI Workflow Guide',
      description:
        'Recommended 3-step dungeon generation workflow for AI agents using Mapwright: ' +
        'planBrief → dry-run → execute.',
      mimeType: 'text/markdown',
    },
    {
      uri: 'mapwright://domain-routing',
      name: 'Domain Routing & Codebase Guide',
      description:
        'Codebase architecture, domain routing table, barrel import rules, debugging strategy, ' +
        'and feature addition checklist for working on the Mapwright source code.',
      mimeType: 'text/markdown',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'mapwright://editor-api') {
    const text = await readFile(path.join(MAPWRIGHT_DIR, 'src/editor/CLAUDE.md'), 'utf-8');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }

  if (uri === 'mapwright://workflow') {
    const full = await readFile(path.join(MAPWRIGHT_DIR, 'src/editor/CLAUDE.md'), 'utf-8');
    const start = full.indexOf('## Claude Workflow: Recommended Dungeon Generation Process');
    const end = full.indexOf('\n---\n', start + 1);
    const text = start >= 0 ? full.slice(start, end > start ? end : undefined) : full;
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }

  if (uri === 'mapwright://domain-routing') {
    const text = await readFile(path.join(MAPWRIGHT_DIR, 'CLAUDE.md'), 'utf-8');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Mapwright MCP server ready (MAPWRIGHT_DIR=${MAPWRIGHT_DIR})`);
