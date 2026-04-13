import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js'; // Initialize getApi()

import {
  validateDoorClearance,
  validateConnectivity,
  explainCommand,
  validateCommands,
} from '../../src/editor/js/api/validation.js';
import { markPropSpatialDirty } from '../../src/editor/js/prop-spatial.js';

/** Place a prop via metadata.props[] (overlay) for test setup. */
function placeOverlayProp(row, col, type) {
  const meta = state.dungeon.metadata;
  if (!meta.props) meta.props = [];
  if (!meta.nextPropId) meta.nextPropId = 1;
  const gridSize = meta.gridSize || 5;
  meta.props.push({
    id: `prop_${meta.nextPropId++}`,
    type,
    x: col * gridSize,
    y: row * gridSize,
    rotation: 0,
    scale: 1.0,
    zIndex: 10,
    flipped: false,
  });
  markPropSpatialDirty();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRoom(r1, c1, r2, c2, label, labelRow, labelCol) {
  const cells = state.dungeon.cells;
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      cells[r][c] = {};
      if (r === r1) cells[r][c].north = 'w';
      if (r === r2) cells[r][c].south = 'w';
      if (c === c1) cells[r][c].west = 'w';
      if (c === c2) cells[r][c].east = 'w';
    }
  }
  if (label) {
    const lr = labelRow ?? Math.floor((r1 + r2) / 2);
    const lc = labelCol ?? Math.floor((c1 + c2) / 2);
    if (!cells[lr][lc]) cells[lr][lc] = {};
    cells[lr][lc].center = { label };
  }
}

function addDoorBetween(r, c, direction) {
  const cells = state.dungeon.cells;
  const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
  const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
  cells[r][c][direction] = 'd';
  const [dr, dc] = OFFSETS[direction];
  const nr = r + dr,
    nc = c + dc;
  if (cells[nr]?.[nc]) {
    cells[nr][nc][OPPOSITE[direction]] = 'd';
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  state.undoStack = [];
  state.redoStack = [];
  state.propCatalog = {
    categories: ['furniture'],
    props: {
      chair: { name: 'Chair', category: 'furniture', footprint: [1, 1], facing: true },
    },
  };
  markPropSpatialDirty();
});

// ── validateDoorClearance ────────────────────────────────────────────────────

describe('validateDoorClearance', () => {
  it('reports clear when no doors or props exist', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    const result = validateDoorClearance();
    expect(result.success).toBe(true);
    expect(result.clear).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reports clear when doors have no blocking props', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    buildRoom(2, 5, 4, 7, 'A2', 3, 6);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    addDoorBetween(3, 4, 'east');
    const result = validateDoorClearance();
    expect(result.clear).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  it('detects a prop blocking a door cell', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    buildRoom(2, 5, 4, 7, 'A2', 3, 6);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    addDoorBetween(3, 4, 'east');
    // Place prop directly on the door cell
    placeOverlayProp(3, 4, 'chair');

    const result = validateDoorClearance();
    expect(result.clear).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    const blocking = result.issues.find((i) => i.row === 3 && i.col === 4);
    expect(blocking).toBeDefined();
    expect(blocking.problem).toContain('blocking door cell');
  });

  it('detects a prop blocking a door approach cell', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    buildRoom(2, 5, 4, 7, 'A2', 3, 6);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    addDoorBetween(3, 4, 'east');
    // Place prop on the approach cell (the cell on the other side of the door)
    placeOverlayProp(3, 5, 'chair');

    const result = validateDoorClearance();
    expect(result.clear).toBe(false);
    const approach = result.issues.find((i) => i.problem.includes('approach'));
    expect(approach).toBeDefined();
  });

  it('checks all doors in the dungeon', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    buildRoom(2, 5, 4, 7, 'A2', 3, 6);
    buildRoom(5, 2, 7, 4, 'B1', 6, 3);
    const cells = state.dungeon.cells;
    // Shared wall A1-A2
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    // Shared wall A1-B1
    for (let c = 2; c <= 4; c++) {
      cells[4][c].south = 'w';
      cells[5][c].north = 'w';
    }
    addDoorBetween(3, 4, 'east');
    addDoorBetween(4, 3, 'south');

    // Block both doors
    placeOverlayProp(3, 4, 'chair');
    placeOverlayProp(4, 3, 'chair');

    const result = validateDoorClearance();
    expect(result.clear).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('detects secret doors blocked by props', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    buildRoom(2, 5, 4, 7, 'A2', 3, 6);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    // Secret door
    cells[3][4].east = 's';
    cells[3][5].west = 's';
    placeOverlayProp(3, 4, 'chair');

    const result = validateDoorClearance();
    expect(result.clear).toBe(false);
    const issue = result.issues.find((i) => i.doorType === 's');
    expect(issue).toBeDefined();
  });
});

// ── validateConnectivity ─────────────────────────────────────────────────────

describe('validateConnectivity', () => {
  it('reports all rooms connected when linked by open edges', () => {
    // Two rooms merged (no wall between them)
    buildRoom(2, 2, 4, 4, 'C1', 3, 3);
    buildRoom(2, 5, 4, 7, 'C2', 3, 6);
    const cells = state.dungeon.cells;
    // Remove shared wall to connect rooms
    for (let r = 2; r <= 4; r++) {
      delete cells[r][4].east;
      delete cells[r][5].west;
    }

    const result = validateConnectivity('C1');
    expect(result.success).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.reachable).toContain('C1');
    expect(result.reachable).toContain('C2');
    expect(result.unreachable).toEqual([]);
    expect(result.totalRooms).toBe(2);
  });

  it('reports rooms connected through doors', () => {
    buildRoom(2, 2, 4, 4, 'C1', 3, 3);
    buildRoom(2, 5, 4, 7, 'C2', 3, 6);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    // Put a door between them
    addDoorBetween(3, 4, 'east');

    const result = validateConnectivity('C1');
    expect(result.connected).toBe(true);
    expect(result.reachable).toContain('C2');
  });

  it('detects unreachable rooms separated by walls', () => {
    buildRoom(2, 2, 4, 4, 'C1', 3, 3);
    buildRoom(2, 5, 4, 7, 'C2', 3, 6);
    const cells = state.dungeon.cells;
    // Ensure walls are solid between them
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }

    const result = validateConnectivity('C1');
    expect(result.connected).toBe(false);
    expect(result.reachable).toContain('C1');
    expect(result.unreachable).toContain('C2');
    expect(result.totalRooms).toBe(2);
  });

  it('detects unreachable room in a chain of three rooms', () => {
    buildRoom(2, 2, 4, 4, 'C1', 3, 3);
    buildRoom(2, 5, 4, 7, 'C2', 3, 6);
    buildRoom(2, 8, 4, 10, 'C3', 3, 9);
    const cells = state.dungeon.cells;
    // Wall between C1 and C2
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    // Door between C1 and C2
    addDoorBetween(3, 4, 'east');
    // Wall between C2 and C3 (no door)
    for (let r = 2; r <= 4; r++) {
      cells[r][7].east = 'w';
      cells[r][8].west = 'w';
    }

    const result = validateConnectivity('C1');
    expect(result.connected).toBe(false);
    expect(result.reachable).toContain('C1');
    expect(result.reachable).toContain('C2');
    expect(result.unreachable).toContain('C3');
  });

  it('traverses through secret doors', () => {
    buildRoom(2, 2, 4, 4, 'C1', 3, 3);
    buildRoom(2, 5, 4, 7, 'C2', 3, 6);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    // Secret door
    cells[3][4].east = 's';
    cells[3][5].west = 's';

    const result = validateConnectivity('C1');
    expect(result.connected).toBe(true);
    expect(result.reachable).toContain('C2');
  });

  it('stops at walls and invisible walls', () => {
    buildRoom(2, 2, 4, 4, 'C1', 3, 3);
    buildRoom(2, 5, 4, 7, 'C2', 3, 6);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'iw';
      cells[r][5].west = 'iw';
    }

    const result = validateConnectivity('C1');
    expect(result.connected).toBe(false);
    expect(result.unreachable).toContain('C2');
  });

  it('throws for non-existent entrance label', () => {
    expect(() => validateConnectivity('NonExistent')).toThrow('not found');
  });

  it('counts total visited cells', () => {
    buildRoom(2, 2, 4, 4, 'C1', 3, 3);
    const result = validateConnectivity('C1');
    expect(result.visitedCells).toBe(9); // 3x3 room
  });

  it('handles a single room correctly', () => {
    buildRoom(2, 2, 4, 4, 'Solo', 3, 3);
    const result = validateConnectivity('Solo');
    expect(result.connected).toBe(true);
    expect(result.reachable).toEqual(['Solo']);
    expect(result.unreachable).toEqual([]);
    expect(result.totalRooms).toBe(1);
  });
});

// ── explainCommand ────────────────────────────────────────────────────────────

describe('explainCommand', () => {
  it('returns ok=true for a valid mutation without modifying state', async () => {
    const before = JSON.stringify(state.dungeon);
    const result = await explainCommand('paintCell', 5, 5);
    expect(result.ok).toBe(true);
    expect(result.method).toBe('paintCell');
    expect(JSON.stringify(state.dungeon)).toBe(before);
  });

  it('returns ok=false with code+context for a failing command', async () => {
    const result = await explainCommand('paintCell', 999, 999);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('OUT_OF_BOUNDS');
    expect(result.context).toMatchObject({ row: 999, col: 999 });
  });

  it('returns the result of read methods', async () => {
    state.dungeon.cells[3][3] = { north: 'w' };
    const result = await explainCommand('getCellInfo', 3, 3);
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ success: true, cell: { north: 'w' } });
  });

  it('reports UNKNOWN_METHOD for an unrecognized command', async () => {
    const result = await explainCommand('floopTheCells', 1, 2);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNKNOWN_METHOD');
  });

  it('rolls back on error so subsequent calls see clean state', async () => {
    const before = JSON.stringify(state.dungeon);
    await explainCommand('setDoor', 5, 5, 'badDirection');
    expect(JSON.stringify(state.dungeon)).toBe(before);
  });
});

// ── validateCommands ──────────────────────────────────────────────────────────

describe('validateCommands', () => {
  it('returns one result per command in order', async () => {
    const result = await validateCommands([
      ['paintCell', 1, 1],
      ['paintCell', 2, 2],
      ['paintCell', 999, 999],
    ]);
    expect(result.success).toBe(true);
    expect(result.allOk).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(true);
    expect(result.results[2].ok).toBe(false);
    expect(result.results[2].code).toBe('OUT_OF_BOUNDS');
  });

  it('does not mutate state', async () => {
    const before = JSON.stringify(state.dungeon);
    await validateCommands([
      ['createRoom', 2, 2, 5, 5],
      ['setLabel', 3, 3, 'X'],
      ['setDoor', 3, 5, 'east'],
    ]);
    expect(JSON.stringify(state.dungeon)).toBe(before);
  });

  it('cumulates effects within the batch (later commands see earlier mutations)', async () => {
    // The second command depends on the room created by the first.
    const result = await validateCommands([
      ['createRoom', 2, 2, 5, 5],
      ['setLabel', 3, 3, 'X'],
      ['placeLightInRoom', 'X', 'torch'],
    ]);
    expect(result.allOk).toBe(true);
  });

  it('stopOnError halts at the first failure', async () => {
    const result = await validateCommands(
      [
        ['paintCell', 1, 1],
        ['paintCell', 999, 999],
        ['paintCell', 2, 2],
      ],
      { stopOnError: true },
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[1].ok).toBe(false);
  });

  it('reports INVALID_COMMAND for malformed entries', async () => {
    const result = await validateCommands([['paintCell', 1, 1], []]);
    expect(result.results[1].ok).toBe(false);
    expect(result.results[1].code).toBe('INVALID_COMMAND');
  });
});
