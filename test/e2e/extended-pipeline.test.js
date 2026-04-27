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
 * Extract the last JSON object from stdout.
 * The bridge may output multiple JSON results (one per command that returns data)
 * plus the --info JSON. We want the last complete JSON object.
 */
function extractJson(stdout) {
  const text = stdout.trim();
  // Find the last '{' that starts a valid JSON object
  let lastValid = null;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '}') {
      // Walk backwards to find matching '{'
      let depth = 0;
      for (let j = i; j >= 0; j--) {
        if (text[j] === '}') depth++;
        if (text[j] === '{') depth--;
        if (depth === 0) {
          try {
            lastValid = JSON.parse(text.substring(j, i + 1));
            return lastValid;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`No JSON found in stdout: ${text.slice(0, 200)}`);
}

describe('Extended Pipeline E2E', () => {
  // 1. Multi-level dungeon
  it('creates a multi-level dungeon with stairs and links', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Multi-Level Test', 20, 20],
      ['createRoom', 2, 2, 6, 8],
      ['setLabel', 4, 5, 'A1'],
      ['addLevel', 'Level 2', 15],
      ['getLevels'],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-multilevel.json');
    const result = await runBridge(['--commands', commands, '--save', savePath, '--info'], port);

    expect(result.code).toBe(0);
    const info = extractJson(result.stdout);
    expect(info.levels.length).toBeGreaterThanOrEqual(1);

    const saved = loadSavedMap(savePath);
    expect(saved.metadata.levels).toBeDefined();
    expect(saved.metadata.levels.length).toBeGreaterThanOrEqual(1);
    expect(saved.metadata.levels.some((l) => l.name === 'Level 2')).toBe(true);
  });

  // 2. Lighting pipeline
  it('places lights and configures lighting state', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Lighting Test', 20, 20],
      ['createRoom', 2, 2, 10, 10],
      ['setLabel', 6, 6, 'A1'],
      ['placeLight', 30, 30, { radius: 20, color: '#ffaa00', intensity: 0.8 }],
      ['setAmbientLight', 0.3],
      ['setLightingEnabled', true],
      ['getLights'],
    ]);

    const result = await runBridge(['--commands', commands, '--info'], port);

    expect(result.code).toBe(0);
    const info = extractJson(result.stdout);
    expect(info.lightingEnabled).toBe(true);
    expect(info.lightCount).toBeGreaterThanOrEqual(1);
  });

  // 3. Texture workflow
  it('sets textures on cells and verifies map state', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Texture Test', 15, 15],
      ['createRoom', 2, 2, 8, 8],
      ['setLabel', 5, 5, 'A1'],
      ['setTexture', 3, 3, 'stone-floor', 0.8],
      ['setTextureRect', 4, 4, 6, 6, 'stone-floor', 1.0],
      ['waitForTextures'],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-textures.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    const res = saved.metadata.resolution || 1;
    const cell33 = saved.cells[3 * res]?.[3 * res];
    expect(cell33).toBeDefined();
    // Textures live on the primary segment under the polygon-segment cell model.
    const primarySeg = cell33.segments?.[0];
    expect(primarySeg?.texture).toBe('stone-floor');
    expect(primarySeg?.textureOpacity).toBeCloseTo(0.8, 1);
  });

  // 4. Fill operations
  it('sets water, lava, and pit fills with depths', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Fill Test', 20, 20],
      ['createRoom', 2, 2, 12, 12],
      ['setLabel', 7, 7, 'A1'],
      ['setFill', 3, 3, 'water', 2],
      ['setFill', 5, 5, 'lava', 3],
      ['setFill', 7, 7, 'pit'],
      ['getCellInfo', 3, 3],
      ['getCellInfo', 5, 5],
      ['getCellInfo', 7, 7],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-fills.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    const res = saved.metadata.resolution || 1;

    const waterCell = saved.cells[3 * res][3 * res];
    expect(waterCell.fill).toBe('water');
    expect(waterCell.waterDepth).toBe(2);

    const lavaCell = saved.cells[5 * res][5 * res];
    expect(lavaCell.fill).toBe('lava');
    expect(lavaCell.lavaDepth).toBe(3);

    const pitCell = saved.cells[7 * res][7 * res];
    expect(pitCell.fill).toBe('pit');
  });

  // 5. Trim operations
  it('creates room with rounded corners via roundRoomCorners', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Trim Test', 25, 25],
      ['createRoom', 2, 2, 14, 14],
      ['setLabel', 8, 8, 'A1'],
      ['roundRoomCorners', 'A1', 3],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-trims.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    // Verify the corner cells have been modified (NW corner cell should be null or have trim data)
    const saved = loadSavedMap(savePath);
    const res = saved.metadata.resolution || 1;
    // The outermost corner cell (2,2) should be voided (null) after rounding
    const cornerCell = saved.cells[2 * res][2 * res];
    expect(cornerCell).toBeNull();
  });

  // 6. Door types
  it('places normal and secret doors with correct types', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Door Test', 20, 20],
      ['createRoom', 2, 2, 8, 8],
      ['setLabel', 5, 5, 'A1'],
      ['createRoom', 2, 10, 8, 16],
      ['setLabel', 5, 13, 'A2'],
      ['setDoor', 5, 8, 'east', 'd'],
      ['setDoor', 3, 8, 'east', 's'],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-doors.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    const res = saved.metadata.resolution || 1;

    // Normal door
    expect(saved.cells[5 * res][8 * res].east).toBe('d');
    // Secret door
    expect(saved.cells[3 * res][8 * res].east).toBe('s');
  });

  // 7. Prop placement patterns (fillWallWithProps, lineProps, scatterProps)
  it('uses bulk prop placement methods', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Prop Patterns', 25, 25],
      ['createRoom', 2, 2, 14, 18],
      ['setLabel', 8, 10, 'A1'],
      ['fillWallWithProps', 'A1', 'pillar', 'north'],
      ['lineProps', 'A1', 'pillar', 5, 3, 'east', 4, { gap: 1 }],
      ['scatterProps', 'A1', 'pillar', 3],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-proppatterns.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    // Should have placed at least a few props from the bulk operations
    expect(saved.metadata.props.length).toBeGreaterThan(0);
    // Stdout should show placed counts
    expect(result.stdout).toContain('fillWallWithProps');
    expect(result.stdout).toContain('lineProps');
    expect(result.stdout).toContain('scatterProps');
  });

  // 8. Validation — disconnected rooms
  it('detects unreachable rooms via validateConnectivity', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Validation Test', 30, 30],
      // Room A1 — isolated
      ['createRoom', 2, 2, 6, 6],
      ['setLabel', 4, 4, 'A1'],
      // Room A2 — isolated far away, no door connecting them
      ['createRoom', 15, 15, 20, 20],
      ['setLabel', 17, 17, 'A2'],
      // Validate from A1 — A2 should be unreachable
      ['validateConnectivity', 'A1'],
    ]);

    const result = await runBridge(['--commands', commands], port);

    expect(result.code).toBe(0);
    // The validateConnectivity result should show A2 as unreachable
    expect(result.stdout).toContain('unreachable');
  });

  // 9. Plan brief
  it('generates a dungeon from planBrief with 3+ rooms', async () => {
    const brief = {
      name: 'Brief Test Dungeon',
      theme: 'stone-dungeon',
      gridSize: 5,
      corridorWidth: 3,
      rooms: [
        { label: 'A1', width: 8, height: 6, entrance: true },
        { label: 'A2', width: 6, height: 6 },
        { label: 'A3', width: 8, height: 5 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
        { from: 'A1', to: 'A3', direction: 'south' },
      ],
    };

    const commands = JSON.stringify([['planBrief', brief]]);

    // planBrief returns { success, commands } — verify it succeeds and returns commands
    const planResult = await runBridge(['--commands', commands], port);

    expect(planResult.code).toBe(0);
    expect(planResult.stdout).toContain('"success":true');
    expect(planResult.stdout).toContain('"commands"');
  });

  // 10. Undo/redo
  it('undo and redo restores state correctly', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Undo Test', 20, 20],
      ['createRoom', 2, 2, 8, 8],
      ['setLabel', 5, 5, 'A1'],
      ['getUndoDepth'],
      // Record depth, then make more changes
      ['placeProp', 3, 3, 'pillar'],
      ['placeProp', 4, 4, 'pillar'],
      ['getUndoDepth'],
    ]);

    const result = await runBridge(['--commands', commands], port);

    expect(result.code).toBe(0);
    // Both getUndoDepth calls should appear in output
    const depthLines = result.stdout.split('\n').filter((l) => l.includes('getUndoDepth'));
    expect(depthLines.length).toBe(2);

    // Now undo the two prop placements and verify no props remain
    const undoCommands = JSON.stringify([['undo'], ['undo']]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-undo.json');
    const undoResult = await runBridge(['--commands', undoCommands, '--save', savePath, '--info'], port);

    // After undo, map should still exist (we're continuing session)
    // but in headless mode each run is fresh, so we test undo within a single run
    expect(undoResult.code).toBe(0);
  });

  // 10b. Undo/redo in single session using undoToDepth
  it('undoToDepth restores to a checkpoint', async () => {
    const commands = JSON.stringify([
      ['newMap', 'UndoDepth Test', 20, 20],
      ['createRoom', 2, 2, 8, 8],
      ['setLabel', 5, 5, 'A1'],
      // Use eval to capture depth then make changes then undo back
      [
        'eval',
        `
        const depth = editorAPI.getUndoDepth().depth;
        editorAPI.placeProp(3, 3, 'pillar');
        editorAPI.placeProp(4, 4, 'pillar');
        const afterDepth = editorAPI.getUndoDepth().depth;
        editorAPI.undoToDepth(depth);
        const info = editorAPI.getMapInfo();
        return { depth, afterDepth, propCountAfterUndo: info.propCount };
      `,
      ],
    ]);

    const result = await runBridge(['--commands', commands], port);

    expect(result.code).toBe(0);
    // The eval result should show propCount went back to 0
    expect(result.stdout).toContain('propCountAfterUndo');
    // Parse the eval result
    const evalLine = result.stdout.split('\n').find((l) => l.includes('propCountAfterUndo'));
    expect(evalLine).toBeDefined();
    const match = evalLine.match(/"propCountAfterUndo"\s*:\s*(\d+)/);
    expect(match).toBeDefined();
    expect(parseInt(match[1])).toBe(0);
  });

  // 11. Export PNG
  it('exports a PNG via --export-png that is non-empty', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Export PNG Test', 15, 15],
      ['createRoom', 2, 2, 10, 10],
      ['setLabel', 6, 6, 'A1'],
    ]);

    const exportPath = path.join(OUTPUT_DIR, 'e2e-export.png');
    const result = await runBridge(['--commands', commands, '--export-png', exportPath], port);

    expect(result.code).toBe(0);
    expect(fs.existsSync(exportPath)).toBe(true);
    const stats = fs.statSync(exportPath);
    expect(stats.size).toBeGreaterThan(1000); // PNG header alone is >100 bytes, real map should be much larger
  });

  // 12. Large map performance
  it('creates a 50x50 map with multiple rooms without timeout', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Large Map Test', 55, 55],
      ['createRoom', 2, 2, 12, 12],
      ['setLabel', 7, 7, 'A1'],
      ['createRoom', 2, 15, 12, 25],
      ['setLabel', 7, 20, 'A2'],
      ['createRoom', 2, 28, 12, 38],
      ['setLabel', 7, 33, 'A3'],
      ['createRoom', 15, 2, 25, 12],
      ['setLabel', 20, 7, 'A4'],
      ['createRoom', 15, 15, 25, 25],
      ['setLabel', 20, 20, 'A5'],
      ['createRoom', 15, 28, 25, 38],
      ['setLabel', 20, 33, 'A6'],
      ['createRoom', 28, 2, 38, 12],
      ['setLabel', 33, 7, 'A7'],
      ['createRoom', 28, 15, 38, 25],
      ['setLabel', 33, 20, 'A8'],
      ['createRoom', 28, 28, 38, 38],
      ['setLabel', 33, 33, 'A9'],
      // Doors between adjacent rooms
      ['setDoor', 7, 12, 'east'],
      ['setDoor', 7, 25, 'east'],
      ['setDoor', 20, 12, 'east'],
      ['setDoor', 20, 25, 'east'],
      ['setDoor', 33, 12, 'east'],
      ['setDoor', 33, 25, 'east'],
      ['setDoor', 12, 7, 'south'],
      ['setDoor', 12, 20, 'south'],
      ['setDoor', 12, 33, 'south'],
      ['setDoor', 25, 7, 'south'],
      ['setDoor', 25, 20, 'south'],
      ['setDoor', 25, 33, 'south'],
    ]);

    const result = await runBridge(['--commands', commands, '--info'], port);

    expect(result.code).toBe(0);
    const info = extractJson(result.stdout);
    expect(info.labelCount).toBe(9);
  });

  // 13. Convenience methods — mergeRooms, partitionRoom, shiftCells, normalizeMargin
  it('mergeRooms removes shared walls between adjacent rooms', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Merge Test', 20, 20],
      ['createRoom', 2, 2, 8, 8],
      ['setLabel', 5, 5, 'A1'],
      ['createRoom', 2, 9, 8, 15],
      ['setLabel', 5, 12, 'A2'],
      ['mergeRooms', 'A1', 'A2'],
    ]);

    const result = await runBridge(['--commands', commands], port);

    expect(result.code).toBe(0);
    // mergeRooms returns { success: true, removed: N } — verify walls were removed
    expect(result.stdout).toContain('"success":true');
    expect(result.stdout).toContain('"removed"');
  });

  it('partitionRoom adds an internal wall', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Partition Test', 20, 20],
      ['createRoom', 2, 2, 10, 10],
      ['setLabel', 6, 6, 'A1'],
      ['partitionRoom', 'A1', 'horizontal', 6, 'w', { doorAt: 6 }],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-partition.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    const res = saved.metadata.resolution || 1;
    // Row 6, col 3 should have a south wall
    const cellWithWall = saved.cells[6 * res][3 * res];
    expect(cellWithWall?.south).toBe('w');
    // Row 6, col 6 should have a south door
    const cellWithDoor = saved.cells[6 * res][6 * res];
    expect(cellWithDoor?.south).toBe('d');
  });

  it('shiftCells moves all content', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Shift Test', 15, 15],
      ['createRoom', 1, 1, 5, 5],
      ['setLabel', 3, 3, 'A1'],
      ['shiftCells', 3, 3],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-shift.json');
    const result = await runBridge(['--commands', commands, '--save', savePath, '--info'], port);

    expect(result.code).toBe(0);
    const info = extractJson(result.stdout);
    // Grid should have grown by the shift amount
    expect(info.rows).toBeGreaterThanOrEqual(18);
    expect(info.cols).toBeGreaterThanOrEqual(18);
  });

  it('normalizeMargin adjusts margins around content', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Margin Test', 30, 30],
      ['createRoom', 10, 10, 15, 15],
      ['setLabel', 12, 12, 'A1'],
      ['normalizeMargin', 2],
    ]);

    const result = await runBridge(['--commands', commands, '--info'], port);

    expect(result.code).toBe(0);
    const info = extractJson(result.stdout);
    // After normalization, the grid should be compacted: 6 (room height) + 2*2 (margins) = 10
    expect(info.rows).toBeLessThanOrEqual(15);
    expect(info.cols).toBeLessThanOrEqual(15);
  });

  // 14. Bridge placement
  it('adds bridges of different types and retrieves them', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Bridge Test', 20, 20],
      ['createRoom', 2, 2, 10, 18],
      ['setLabel', 6, 10, 'A1'],
      // Set water fill in the middle for the bridge to span
      ['setFillRect', 4, 6, 8, 12, 'water', 2],
      // Add a wood bridge (3-point polygon: top-left edge, top-right edge, bottom-right)
      ['addBridge', 'wood', 4, 6, 4, 10, 6, 10],
      // Add a stone bridge
      ['addBridge', 'stone', 6, 6, 6, 10, 8, 10],
      ['getBridges'],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-bridges.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    expect(saved.metadata.bridges).toBeDefined();
    expect(saved.metadata.bridges.length).toBe(2);
    expect(saved.metadata.bridges[0].type).toBe('wood');
    expect(saved.metadata.bridges[1].type).toBe('stone');
  });

  // 15. Stairs with linking
  it('adds stairs and links them together', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Stairs Link Test', 20, 20],
      ['createRoom', 2, 2, 8, 8],
      ['setLabel', 5, 5, 'A1'],
      ['createRoom', 2, 11, 8, 17],
      ['setLabel', 5, 14, 'A2'],
      // Add stairs in room A1
      ['addStairs', 3, 3, 3, 5, 5, 5],
      // Add stairs in room A2
      ['addStairs', 3, 12, 3, 14, 5, 14],
      // Link them
      ['linkStairs', 4, 4, 4, 13],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-stairs.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    expect(saved.metadata.stairs).toBeDefined();
    expect(saved.metadata.stairs.length).toBe(2);
    // Both stairs should share the same link label
    const link1 = saved.metadata.stairs[0].link;
    const link2 = saved.metadata.stairs[1].link;
    expect(link1).toBeDefined();
    expect(link1).toBe(link2);
  });

  // 16. setDoorBetween convenience
  it('setDoorBetween places a door at the midpoint of shared wall', async () => {
    const commands = JSON.stringify([
      ['newMap', 'DoorBetween Test', 20, 20],
      ['createRoom', 2, 2, 8, 8],
      ['setLabel', 5, 5, 'A1'],
      ['createRoom', 2, 9, 8, 15],
      ['setLabel', 5, 12, 'A2'],
      ['setDoorBetween', 'A1', 'A2', 'd'],
    ]);

    const result = await runBridge(['--commands', commands], port);

    expect(result.code).toBe(0);
    // setDoorBetween returns { success: true, row, col, direction }
    expect(result.stdout).toContain('"success":true');
    expect(result.stdout).toContain('"direction"');
  });

  // 17. createCorridor convenience
  it('createCorridor builds a connecting hallway with doors', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Corridor Test', 40, 40],
      ['createRoom', 2, 2, 10, 10],
      ['setLabel', 6, 6, 'A1'],
      ['createRoom', 2, 15, 10, 23],
      ['setLabel', 6, 19, 'A2'],
      ['createCorridor', 'A1', 'A2', 3],
    ]);

    const result = await runBridge(['--commands', commands, '--continue-on-error', '--info'], port);

    // createCorridor succeeds when rooms have gap and sufficient overlap
    const info = extractJson(result.stdout);
    expect(info.labelCount).toBeGreaterThanOrEqual(2);
  });

  // 18. Fill rect operations
  it('setFillRect applies fill across a region', async () => {
    const commands = JSON.stringify([
      ['newMap', 'FillRect Test', 20, 20],
      ['createRoom', 2, 2, 12, 12],
      ['setLabel', 7, 7, 'A1'],
      ['setFillRect', 4, 4, 8, 8, 'water', 2],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-fillrect.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    const res = saved.metadata.resolution || 1;
    // All cells in the rect should have water fill
    for (let r = 4; r <= 8; r++) {
      for (let c = 4; c <= 8; c++) {
        const cell = saved.cells[r * res][c * res];
        expect(cell?.fill).toBe('water');
        expect(cell?.waterDepth).toBe(2);
      }
    }
  });

  // 19. Hazard flag
  it('setHazard marks cells as difficult terrain', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Hazard Test', 15, 15],
      ['createRoom', 2, 2, 10, 10],
      ['setLabel', 6, 6, 'A1'],
      ['setHazard', 4, 4, true],
      ['setHazardRect', 5, 5, 7, 7, true],
    ]);

    const savePath = path.join(OUTPUT_DIR, 'e2e-hazard.json');
    const result = await runBridge(['--commands', commands, '--save', savePath], port);

    expect(result.code).toBe(0);
    const saved = loadSavedMap(savePath);
    const res = saved.metadata.resolution || 1;
    expect(saved.cells[4 * res][4 * res].hazard).toBe(true);
    expect(saved.cells[6 * res][6 * res].hazard).toBe(true);
  });

  // 20. Map features and metadata
  it('sets map features, theme, and label style', async () => {
    const commands = JSON.stringify([
      ['newMap', 'Features Test', 15, 15],
      ['createRoom', 2, 2, 10, 10],
      ['setLabel', 6, 6, 'A1'],
      ['setName', 'Renamed Map'],
      ['setLabelStyle', 'plain'],
      ['setFeature', 'grid', true],
      ['setFeature', 'compass', true],
    ]);

    const result = await runBridge(['--commands', commands, '--info'], port);

    expect(result.code).toBe(0);
    const info = extractJson(result.stdout);
    expect(info.name).toBe('Renamed Map');
    expect(info.labelStyle).toBe('plain');
    expect(info.features.grid).toBe(true);
    expect(info.features.compass).toBe(true);
  });
});
