import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer, stopServer } from './helpers/server.js';
import { runBridge } from './helpers/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

let port;

beforeAll(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  port = await startServer();
});

afterAll(async () => {
  await stopServer();
});

/**
 * Parse saved map JSON — bridge saves as { success, dungeon: { metadata, cells } }.
 */
function loadSavedMap(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return raw.dungeon || raw;
}

/**
 * Normalize saved map so --load can read it (unwrap { success, dungeon }).
 */
function normalizeSavedMap(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const dungeon = raw.dungeon || raw;
  fs.writeFileSync(filePath, JSON.stringify(dungeon));
}

/**
 * Extract JSON from stdout that may contain log lines before the JSON.
 * Handles multi-line pretty-printed JSON.
 */
function extractJson(stdout) {
  const text = stdout.trim();
  // Find the first '{' and parse from there to the end
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) throw new Error(`No JSON found in stdout: ${text}`);
  return JSON.parse(text.substring(jsonStart));
}

describe('Full Pipeline E2E', () => {
  it('creates a map with rooms, doors, and props, then saves and screenshots', async () => {
    const commands = JSON.stringify([
      ['newMap', 'E2E Test', 20, 30],
      ['createRoom', 2, 2, 8, 12],
      ['setLabel', 5, 7, 'A1'],
      ['setDoor', 5, 12, 'east'],
      ['createRoom', 2, 14, 8, 22],
      ['setLabel', 5, 18, 'A2'],
      ['placeProp', 3, 3, 'pillar'],
      ['placeProp', 3, 10, 'pillar'],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-basic.json');
    const pngPath = path.join(OUTPUT_DIR, 'e2e-basic.png');

    const result = await runBridge([
      '--commands', commands,
      '--save', savePath,
      '--screenshot', pngPath,
    ], port);

    expect(result.code).toBe(0);
    expect(fs.existsSync(savePath)).toBe(true);
    expect(fs.existsSync(pngPath)).toBe(true);

    const saved = loadSavedMap(savePath);
    expect(saved.metadata.dungeonName).toBe('E2E Test');
    const res = saved.metadata.resolution || 1;
    const gs = saved.metadata.gridSize || 5;
    // API display coords (3,3) → internal (3*res, 3*res) → world feet (3*res*gs, 3*res*gs)
    const expectedX = 3 * res * gs;
    const expectedY = 3 * res * gs;
    const pillar = saved.metadata.props?.find(p => p.x === expectedX && p.y === expectedY);
    expect(pillar).toBeDefined();
    expect(pillar.type).toBe('pillar');
    // Door at display (5,12) → internal (5*res, 12*res)
    expect(saved.cells[5 * res][12 * res].east).toBe('d');

    // Normalize so --load can read it
    normalizeSavedMap(savePath);
  });

  it('loads and modifies an existing map', async () => {
    const loadPath = path.join(OUTPUT_DIR, 'e2e-basic.json');
    const savePath = path.join(OUTPUT_DIR, 'e2e-modified.json');

    const commands = JSON.stringify([
      ['createRoom', 10, 5, 15, 10, 'merge'],
      ['setLabel', 12, 7, 'A3'],
    ]);

    const result = await runBridge([
      '--load', loadPath,
      '--commands', commands,
      '--save', savePath,
    ], port);

    expect(result.code).toBe(0);
    expect(fs.existsSync(savePath)).toBe(true);

    const saved = loadSavedMap(savePath);
    const res2 = saved.metadata.resolution || 1;
    expect(saved.cells[5 * res2][7 * res2]?.center?.label).toBe('A1');
    expect(saved.cells[12 * res2][7 * res2]?.center?.label).toBe('A3');
  });

  it('reports map info via --info', async () => {
    const loadPath = path.join(OUTPUT_DIR, 'e2e-basic.json');

    const result = await runBridge([
      '--load', loadPath,
      '--info',
    ], port);

    expect(result.code).toBe(0);
    const info = extractJson(result.stdout);
    expect(info.name).toBe('E2E Test');
    expect(info.propCount).toBeGreaterThanOrEqual(2);
    expect(info.labelCount).toBeGreaterThanOrEqual(2);
  });
});
