import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js'; // Initialize getApi()

import {
  mergeRooms,
  shiftCells,
  setDoorBetween,
  placeLightInRoom,
  normalizeMargin,
  createCorridor,
} from '../../src/editor/js/api/convenience.js';

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

function setupTwoAdjacentRooms() {
  buildRoom(2, 2, 4, 4, 'A1', 3, 3);
  buildRoom(2, 5, 4, 7, 'A2', 3, 6);
  const cells = state.dungeon.cells;
  for (let r = 2; r <= 4; r++) {
    cells[r][4].east = 'w';
    cells[r][5].west = 'w';
  }
}

function setupVerticallyAdjacentRooms() {
  buildRoom(2, 2, 4, 4, 'V1', 3, 3);
  buildRoom(5, 2, 7, 4, 'V2', 6, 3);
  const cells = state.dungeon.cells;
  for (let c = 2; c <= 4; c++) {
    cells[4][c].south = 'w';
    cells[5][c].north = 'w';
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  state.dungeon.metadata.lights = [];
  state.dungeon.metadata.nextLightId = 1;
  state.undoStack = [];
  state.redoStack = [];
});

// ── mergeRooms ───────────────────────────────────────────────────────────────

describe('mergeRooms', () => {
  it('removes shared walls between two horizontally adjacent rooms', () => {
    setupTwoAdjacentRooms();
    const cells = state.dungeon.cells;
    // Before merge: walls exist on shared boundary
    expect(cells[3][4].east).toBe('w');
    expect(cells[3][5].west).toBe('w');

    const result = mergeRooms('A1', 'A2');
    expect(result.success).toBe(true);
    expect(result.removed).toBe(3); // 3 cells on the shared boundary

    // After merge: walls removed
    for (let r = 2; r <= 4; r++) {
      expect(cells[r][4].east).toBeUndefined();
      expect(cells[r][5].west).toBeUndefined();
    }
  });

  it('removes shared walls between two vertically adjacent rooms', () => {
    setupVerticallyAdjacentRooms();
    const cells = state.dungeon.cells;

    const result = mergeRooms('V1', 'V2');
    expect(result.success).toBe(true);
    expect(result.removed).toBe(3);

    for (let c = 2; c <= 4; c++) {
      expect(cells[4][c].south).toBeUndefined();
      expect(cells[5][c].north).toBeUndefined();
    }
  });

  it('throws when rooms are not adjacent', () => {
    buildRoom(2, 2, 4, 4, 'X1', 3, 3);
    buildRoom(2, 8, 4, 10, 'X2', 3, 9);
    expect(() => mergeRooms('X1', 'X2')).toThrow('No shared boundary');
  });

  it('throws when a label does not exist', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    expect(() => mergeRooms('A1', 'NonExistent')).toThrow('No shared boundary');
  });

  it('preserves outer walls of both rooms', () => {
    setupTwoAdjacentRooms();
    mergeRooms('A1', 'A2');
    const cells = state.dungeon.cells;
    // A1 outer walls should still exist
    expect(cells[2][2].north).toBe('w');
    expect(cells[3][2].west).toBe('w');
    // A2 outer walls should still exist
    expect(cells[2][7].east).toBe('w');
    expect(cells[4][6].south).toBe('w');
  });
});

// ── shiftCells ───────────────────────────────────────────────────────────────

describe('shiftCells', () => {
  it('shifts cells down and right', () => {
    const cells = state.dungeon.cells;
    cells[2][3] = { center: { label: 'S1' } };
    const origRows = cells.length;
    const origCols = cells[0].length;

    const result = shiftCells(2, 3);
    expect(result.success).toBe(true);
    expect(result.newRows).toBe(origRows + 2);
    expect(result.newCols).toBe(origCols + 3);

    // Original cell should now be at (4, 6)
    const newCells = state.dungeon.cells;
    expect(newCells[4][6]?.center?.label).toBe('S1');
    // Original position should be null
    expect(newCells[2][3]).toBeNull();
  });

  it('shifts cells up and left (grid grows, content stays in place)', () => {
    const cells = state.dungeon.cells;
    cells[5][5] = { center: { label: 'S2' } };

    const result = shiftCells(-3, -2);
    expect(result.success).toBe(true);
    // With negative shift, content stays at same position (offset = max(0, dr) = 0)
    const newCells = state.dungeon.cells;
    expect(newCells[5][5]?.center?.label).toBe('S2');
  });

  it('throws when shift would exceed 200x200 limit', () => {
    expect(() => shiftCells(190, 0)).toThrow('exceed maximum grid size');
  });

  it('updates level startRow values when shifting vertically', () => {
    state.dungeon.metadata.levels = [{ name: 'Level 1', startRow: 0, numRows: 20 }];
    shiftCells(5, 0);
    expect(state.dungeon.metadata.levels[0].startRow).toBe(5);
  });

  it('does not update level startRow for horizontal-only shift', () => {
    state.dungeon.metadata.levels = [{ name: 'Level 1', startRow: 0, numRows: 20 }];
    shiftCells(0, 5);
    expect(state.dungeon.metadata.levels[0].startRow).toBe(0);
  });

  it('shifts stair points when they exist', () => {
    state.dungeon.metadata.stairs = [{ points: [[3, 4], [5, 6]] }];
    shiftCells(2, 3);
    expect(state.dungeon.metadata.stairs[0].points[0]).toEqual([5, 7]);
    expect(state.dungeon.metadata.stairs[0].points[1]).toEqual([7, 9]);
  });

  it('preserves content of all cells during shift', () => {
    const cells = state.dungeon.cells;
    cells[1][1] = { north: 'w', center: { label: 'A' } };
    cells[1][2] = { east: 'd' };
    shiftCells(1, 1);
    const newCells = state.dungeon.cells;
    expect(newCells[2][2].north).toBe('w');
    expect(newCells[2][2].center.label).toBe('A');
    expect(newCells[2][3].east).toBe('d');
  });
});

// ── setDoorBetween ───────────────────────────────────────────────────────────

describe('setDoorBetween', () => {
  it('places a normal door at the midpoint of a shared wall', () => {
    setupTwoAdjacentRooms();
    const result = setDoorBetween('A1', 'A2', 'd');
    expect(result.success).toBe(true);
    expect(result.direction).toBe('east');
    // The midpoint is determined by walls[Math.floor(walls.length / 2)]
    // For 3 wall cells, that's index 1 — the exact row depends on BFS order
    expect([2, 3, 4]).toContain(result.row);
    expect(result.col).toBe(4);
    // Check actual cell data at the returned position
    expect(state.dungeon.cells[result.row][result.col].east).toBe('d');
  });

  it('places a secret door when type is "s"', () => {
    setupTwoAdjacentRooms();
    const result = setDoorBetween('A1', 'A2', 's');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[result.row][result.col][result.direction]).toBe('s');
  });

  it('defaults to normal door type', () => {
    setupTwoAdjacentRooms();
    const result = setDoorBetween('A1', 'A2');
    expect(state.dungeon.cells[result.row][result.col][result.direction]).toBe('d');
  });

  it('throws when rooms have no shared wall', () => {
    buildRoom(2, 2, 4, 4, 'X1', 3, 3);
    buildRoom(2, 8, 4, 10, 'X2', 3, 9);
    expect(() => setDoorBetween('X1', 'X2')).toThrow('No shared wall');
  });

  it('works for vertically adjacent rooms', () => {
    setupVerticallyAdjacentRooms();
    const result = setDoorBetween('V1', 'V2', 'd');
    expect(result.success).toBe(true);
    expect(result.direction).toBe('south');
    expect(result.row).toBe(4);
  });

  it('sets reciprocal door on the neighbor cell', () => {
    setupTwoAdjacentRooms();
    const result = setDoorBetween('A1', 'A2', 'd');
    // Check that the reciprocal cell also has the door
    // setDoor sets the reciprocal, so col+1 (east neighbor) should have west='d'
    expect(state.dungeon.cells[result.row][5].west).toBe('d');
  });
});

// ── placeLightInRoom ─────────────────────────────────────────────────────────

describe('placeLightInRoom', () => {
  it('places a light at the center of a room', () => {
    buildRoom(2, 2, 4, 4, 'L1', 3, 3);
    const result = placeLightInRoom('L1', 'torch');
    expect(result.success).toBe(true);
    expect(result.id).toBeDefined();
    const lights = state.dungeon.metadata.lights;
    expect(lights.length).toBe(1);
    // Center of room (2,2)-(4,4) is (3,3), world position = 3*5 + 2.5 = 17.5
    expect(lights[0].x).toBe(3 * 5 + 2.5);
    expect(lights[0].y).toBe(3 * 5 + 2.5);
  });

  it('returns failure for a non-existent room', () => {
    const result = placeLightInRoom('NonExistent', 'torch');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('passes config options to the light', () => {
    buildRoom(2, 2, 4, 4, 'L2', 3, 3);
    const result = placeLightInRoom('L2', null, { type: 'point', radius: 50, color: '#ff0000' });
    expect(result.success).toBe(true);
    const light = state.dungeon.metadata.lights[0];
    expect(light.radius).toBe(50);
    expect(light.color).toBe('#ff0000');
  });

  it('places light at correct center for non-square room', () => {
    buildRoom(2, 2, 4, 8, 'L3', 3, 5);
    placeLightInRoom('L3', 'torch');
    const light = state.dungeon.metadata.lights[0];
    // Center = (3, 5), world coords = 3*5+2.5, 5*5+2.5
    expect(light.y).toBe(3 * 5 + 2.5);
    expect(light.x).toBe(5 * 5 + 2.5);
  });
});

// ── normalizeMargin ──────────────────────────────────────────────────────────

describe('normalizeMargin', () => {
  it('normalizes margin around content', () => {
    buildRoom(5, 5, 7, 7, 'N1', 6, 6);
    const result = normalizeMargin(2);
    expect(result.success).toBe(true);
    expect(result.targetMargin).toBe(2);
    // After normalization, content should have exactly 2 cells of margin
    const newCells = state.dungeon.cells;
    // The content is 3x3 room. With margin 2, total = 2+3+2 = 7 cols/rows
    expect(result.after.rows).toBeGreaterThanOrEqual(7);
    expect(result.after.cols).toBeGreaterThanOrEqual(7);
  });

  it('returns message for empty dungeon', () => {
    const result = normalizeMargin(2);
    expect(result.success).toBe(true);
    expect(result.message).toContain('No structural content');
  });

  it('throws for negative margin', () => {
    expect(() => normalizeMargin(-1)).toThrow('non-negative integer');
  });

  it('accepts float margin (rounds via resolution)', () => {
    // With resolution=1, toInt(1.5) rounds to 2 — valid
    // Just verify it doesn't throw
    buildRoom(5, 5, 7, 7, 'N2', 6, 6);
    const result = normalizeMargin(1.5);
    expect(result.success).toBe(true);
  });

  it('handles margin of 0', () => {
    buildRoom(5, 5, 7, 7, 'N2', 6, 6);
    const result = normalizeMargin(0);
    expect(result.success).toBe(true);
    // With 0 margin, grid should be exactly the content size
    expect(result.after.cols).toBe(3); // 0 + 3 + 0
  });

  it('shifts lights when normalizing margin', () => {
    buildRoom(5, 5, 7, 7, 'N3', 6, 6);
    const gs = state.dungeon.metadata.gridSize || 5;
    state.dungeon.metadata.lights = [{ x: 6 * gs + 2.5, y: 6 * gs + 2.5, radius: 20 }];
    const before = { x: state.dungeon.metadata.lights[0].x, y: state.dungeon.metadata.lights[0].y };
    const result = normalizeMargin(1);
    expect(result.success).toBe(true);
    // Light coordinates should have shifted
    const light = state.dungeon.metadata.lights[0];
    // The content was at row/col 5-7, target margin is 1, so content shifts to row/col 1-3
    expect(light.x).not.toBe(before.x);
  });

  it('returns before and after dimensions', () => {
    buildRoom(5, 5, 7, 7, 'N4', 6, 6);
    const result = normalizeMargin(2);
    expect(result.before).toBeDefined();
    expect(result.before.rows).toBeDefined();
    expect(result.before.cols).toBeDefined();
    expect(result.after).toBeDefined();
    expect(result.after.rows).toBeDefined();
    expect(result.after.cols).toBeDefined();
  });

  it('returns adjustments info', () => {
    buildRoom(5, 5, 7, 7, 'N5', 6, 6);
    const result = normalizeMargin(2);
    expect(result.adjustments).toBeDefined();
    expect(result.adjustments.colShift).toBeDefined();
    expect(Array.isArray(result.adjustments.levels)).toBe(true);
  });
});

// ── createCorridor ──────────────────────────────────────────────────────────

// createCorridor calls createRoom internally which depends on RoomTool._applyWalls
// (mocked as no-op in tests). Only error paths that run before room creation are testable.
describe('createCorridor', () => {
  it('returns error for a nonexistent first room', () => {
    buildRoom(2, 2, 4, 4, 'X1', 3, 3);
    const result = createCorridor('Missing', 'X1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for a nonexistent second room', () => {
    buildRoom(2, 2, 4, 4, 'X1', 3, 3);
    const result = createCorridor('X1', 'Missing');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error when rooms have no perpendicular overlap', () => {
    buildRoom(2, 2, 4, 4, 'O1', 3, 3);
    buildRoom(8, 8, 10, 10, 'O2', 9, 9);
    const result = createCorridor('O1', 'O2');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot auto-route');
  });

  it('returns error when rooms are directly adjacent (no gap)', () => {
    setupTwoAdjacentRooms();
    const result = createCorridor('A1', 'A2');
    expect(result.success).toBe(false);
    // Adjacent rooms with no gap between them cannot have a corridor routed
    expect(result.error).toBeDefined();
  });
});

// ── placeLightInRoom additional ─────────────────────────────────────────────

describe('placeLightInRoom additional', () => {
  it('increments light id for multiple lights', () => {
    buildRoom(2, 2, 4, 4, 'ML1', 3, 3);
    const r1 = placeLightInRoom('ML1', 'torch');
    const r2 = placeLightInRoom('ML1', 'torch');
    expect(r1.id).not.toBe(r2.id);
    expect(state.dungeon.metadata.lights.length).toBe(2);
  });

  it('uses preset from light catalog', () => {
    buildRoom(2, 2, 4, 4, 'PL1', 3, 3);
    const result = placeLightInRoom('PL1', 'torch');
    expect(result.success).toBe(true);
    const light = state.dungeon.metadata.lights[0];
    // Light catalog mock provides torch with color '#ff8833'
    expect(light.color).toBe('#ff8833');
  });
});

// ── setDoorBetween additional ───────────────────────────────────────────────

describe('setDoorBetween additional', () => {
  it('throws for nonexistent first room', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    expect(() => setDoorBetween('Missing', 'A1')).toThrow('No shared wall');
  });

  it('throws for nonexistent second room', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    expect(() => setDoorBetween('A1', 'Missing')).toThrow('No shared wall');
  });
});
