#!/usr/bin/env node
/**
 * Mapwright MCP Installer
 *
 * Usage:
 *   node install.js [--scope project|global]
 *
 * Installs the mapwright MCP server into your Claude Code configuration.
 *
 * --scope global   (default) Adds to ~/.claude.json (available in all projects)
 * --scope project  Adds to .mcp.json in the current working directory
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPWRIGHT_DIR = path.resolve(__dirname, '..');
const MCP_SERVER = path.join(__dirname, 'server.js');

// Parse args
const args = process.argv.slice(2);
const scopeIdx = args.indexOf('--scope');
const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : 'global';
if (!['global', 'project'].includes(scope)) {
  console.error(`Unknown scope "${scope}". Use --scope global or --scope project.`);
  process.exit(1);
}

const configPath =
  scope === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.mcp.json');

console.log('=== Mapwright MCP Installer ===\n');
console.log(`Mapwright directory : ${MAPWRIGHT_DIR}`);
console.log(`MCP server          : ${MCP_SERVER}`);
console.log(`Config scope        : ${scope}`);
console.log(`Config file         : ${configPath}`);
console.log('');

// Step 1: Install npm dependencies
console.log('Step 1/2: Installing MCP dependencies...');
try {
  execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
  console.log('');
} catch (err) {
  console.error('\nERROR: npm install failed. Make sure Node.js and npm are installed.');
  process.exit(1);
}

// Step 2: Write MCP config
console.log('Step 2/2: Registering MCP server with Claude Code...');

let config = {};
if (existsSync(configPath)) {
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    console.warn(`  Warning: ${configPath} exists but could not be parsed — it will be overwritten.`);
    config = {};
  }
}

if (!config.mcpServers) config.mcpServers = {};

config.mcpServers.mapwright = {
  type: 'stdio',
  command: process.execPath,  // absolute path to current node binary
  args: [MCP_SERVER],
  env: {
    MAPWRIGHT_DIR,
  },
};

// For project-scope .mcp.json, ensure parent dir exists
if (scope === 'project') {
  await mkdir(path.dirname(configPath), { recursive: true });
}

await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
console.log(`  Written to ${configPath}\n`);

console.log('=== Installation complete! ===\n');
console.log('The "mapwright" MCP server is now registered with Claude Code.\n');
console.log('Available tools:');
console.log('  execute_commands  — Run editor API commands via Puppeteer bridge');
console.log('                      (requires: cd mapwright && npm start)');
console.log('  render_json       — Render a dungeon .json to PNG  (no server needed)');
console.log('  check_server      — Check if the editor server is running\n');
console.log('Available resources:');
console.log('  mapwright://editor-api     — Full ~70-method API reference');
console.log('  mapwright://workflow       — AI dungeon generation workflow guide');
console.log('  mapwright://domain-routing — Codebase architecture & domain guide\n');
console.log('To start the editor server (required for execute_commands):');
console.log(`  cd "${MAPWRIGHT_DIR}" && npm start\n`);
if (scope === 'global') {
  console.log('Restart Claude Code (or open a new terminal session) for the MCP server to appear.\n');
} else {
  console.log(`The .mcp.json was written to your project root. Commit it to share with your team.\n`);
}
