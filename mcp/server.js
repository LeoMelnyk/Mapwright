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
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

/** Spawn a subprocess and capture stdout + stderr. */
function runProcess(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Run commands through the puppeteer bridge, returning { isError, text }. */
async function runBridge(bridgeArgs) {
  const result = await runProcess(
    process.execPath,  // node binary
    [`${MAPWRIGHT_DIR}/tools/puppeteer-bridge.js`, ...bridgeArgs],
    MAPWRIGHT_DIR,
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { isError: result.code !== 0, text: output || '(no output)' };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'mapwright', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

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
        'See the mapwright://editor-api resource for the full ~70-method API reference.',
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
            description: 'Show the browser window while commands execute (headed mode). Use for live debugging so the user can watch changes happen in real time.',
            default: false,
          },
          slow_mo: {
            type: 'number',
            description: 'Delay in milliseconds between commands when visible=true (default: 0). Use e.g. 300 to make each command visibly animate.',
            default: 0,
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ---- execute_commands ----------------------------------------------------
  if (name === 'execute_commands') {
    const port = args.port ?? 3000;
    const running = await isServerRunning(port);
    if (!running) {
      return {
        content: [{
          type: 'text',
          text:
            `ERROR: Mapwright server is not running on port ${port}.\n\n` +
            `Start it with:\n  cd "${MAPWRIGHT_DIR}" && npm start\n\n` +
            `Then retry. The execute_commands tool requires the editor server.`,
        }],
        isError: true,
      };
    }

    // Write commands to a temp file to avoid shell arg-length limits
    const tmpFile = path.join(os.tmpdir(), `mapwright-cmds-${Date.now()}.json`);
    await writeFile(tmpFile, JSON.stringify(args.commands));

    const bridgeArgs = ['--commands-file', tmpFile];
    if (args.load_file)       bridgeArgs.push('--load',         args.load_file);
    if (args.save_file)       bridgeArgs.push('--save',         args.save_file);
    if (args.screenshot_file) bridgeArgs.push('--screenshot',   args.screenshot_file);
    if (args.export_png)      bridgeArgs.push('--export-png',   args.export_png);
    if (args.dry_run)         bridgeArgs.push('--dry-run');
    if (args.continue_on_error) bridgeArgs.push('--continue-on-error');
    if (args.port)            bridgeArgs.push('--port', String(args.port));
    if (args.visible)         bridgeArgs.push('--visible');
    if (args.slow_mo)         bridgeArgs.push('--slow-mo', String(args.slow_mo));

    const { isError, text } = await runBridge(bridgeArgs);
    await unlink(tmpFile).catch(() => {});

    return { content: [{ type: 'text', text }], isError };
  }

  // ---- render_json ---------------------------------------------------------
  if (name === 'render_json') {
    const jsonFile = path.resolve(args.json_file);
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
      content: [{
        type: 'text',
        text: running
          ? `Mapwright server is running on port ${port}.`
          : `Mapwright server is NOT running on port ${port}.\n\nStart it with:\n  cd "${MAPWRIGHT_DIR}" && npm start`,
      }],
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
    const end   = full.indexOf('\n---\n', start + 1);
    const text  = start >= 0 ? full.slice(start, end > start ? end : undefined) : full;
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
