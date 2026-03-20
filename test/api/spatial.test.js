import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js'; // Initialize getApi()

import {
  findCellByLabel,
  _collectRoomCells,
  _getWallCells,
  _isCellCoveredByProp,
  getRoomBounds,
  findWallBetween,
  partitionRoom,
} from '../../src/editor/js/api/spatial.js';
import { markPropSpatialDirty } from '../../src/editor/js/prop-spatial.js';

/** Place a prop via metadata.props[] (overlay) for test setup. */
function placeOverlayProp(row, col, type, span, facing = 0) {
  const meta = state.dungeon.metadata;
  if (!meta.props) meta.props = [];
  if (!meta.nextPropId) meta.nextPropId = 1;
  const gridSize = meta.gridSize || 5;
  meta.props.push({
    id: `prop_${meta.nextPropId++}`,
    type,
    x: col * gridSize,
    y: row * gridSize,
    rotation: facing,
    scale: 1.0,
    zIndex: 10,
    flipped: false,
  });
  markPropSpatialDirty();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a walled rectangular room in state.dungeon.cells.
 * Cells within (r1,c1)-(r2,c2) are painted and given boundary walls.
 */
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

/**
 * Build two adjacent rooms sharing a wall:
 *   A1: rows 2-4, cols 2-4
 *   A2: rows 2-4, cols 5-7
 * Shared boundary at col 4 east / col 5 west.
 */
function setupTwoAdjacentRooms() {
  buildRoom(2, 2, 4, 4, 'A1', 3, 3);
  buildRoom(2, 5, 4, 7, 'A2', 3, 6);
  // Ensure the shared boundary has walls on both sides
  const cells = state.dungeon.cells;
  for (let r = 2; r <= 4; r++) {
    cells[r][4].east = 'w';
    cells[r][5].west = 'w';
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon');
  state.undoStack = [];
  state.redoStack = [];
  state.propCatalog = {
    categories: ['furniture'],
    props: {
      'chair': { name: 'Chair', category: 'furniture', footprint: [1, 1], facing: true },
      'table': { name: 'Table', category: 'furniture', footprint: [2, 2], facing: false },
    },
  };
  markPropSpatialDirty();
});

// ── findCellByLabel ──────────────────────────────────────────────────────────

describe('findCellByLabel', () => {
  it('finds an existing label and returns its position', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    const result = findCellByLabel('A1');
    expect(result).toEqual({ success: true, row: 3, col: 3 });
  });

  it('returns failure for a non-existent label', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    const result = findCellByLabel('ZZ99');
    expect(result.success).toBe(false);
    expect(result.error).toContain('ZZ99');
  });

  it('coerces numeric labels to strings', () => {
    const cells = state.dungeon.cells;
    cells[5][5] = { center: { label: '42' } };
    expect(findCellByLabel(42)).toEqual({ success: true, row: 5, col: 5 });
  });

  it('searches all cells in the grid', () => {
    // Place label at an edge
    const cells = state.dungeon.cells;
    cells[0][0] = { center: { label: 'Edge' } };
    expect(findCellByLabel('Edge')).toEqual({ success: true, row: 0, col: 0 });
  });

  it('returns the first match when duplicate labels exist', () => {
    const cells = state.dungeon.cells;
    cells[1][1] = { center: { label: 'Dup' } };
    cells[5][5] = { center: { label: 'Dup' } };
    const result = findCellByLabel('Dup');
    expect(result.success).toBe(true);
    // Should find the earlier one (row 1)
    expect(result.row).toBe(1);
    expect(result.col).toBe(1);
  });
});

// ── _collectRoomCells ────────────────────────────────────────────────────────

describe('_collectRoomCells', () => {
  it('BFS fills a 3x3 walled room', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    const roomCells = _collectRoomCells('A1');
    expect(roomCells).toBeInstanceOf(Set);
    expect(roomCells.size).toBe(9); // 3x3
    expect(roomCells.has('2,2')).toBe(true);
    expect(roomCells.has('4,4')).toBe(true);
    expect(roomCells.has('1,2')).toBe(false); // outside
  });

  it('returns null if label not found', () => {
    expect(_collectRoomCells('NonExistent')).toBeNull();
  });

  it('stops at walls between rooms', () => {
    setupTwoAdjacentRooms();
    const room1Cells = _collectRoomCells('A1');
    expect(room1Cells.size).toBe(9); // 3x3
    expect(room1Cells.has('3,5')).toBe(false); // in A2
  });

  it('stops at doors', () => {
    setupTwoAdjacentRooms();
    // Put a door in the shared wall
    const cells = state.dungeon.cells;
    cells[3][4].east = 'd';
    cells[3][5].west = 'd';
    const room1Cells = _collectRoomCells('A1');
    expect(room1Cells.size).toBe(9); // still 3x3, doors block flood fill
    expect(room1Cells.has('3,5')).toBe(false);
  });

  it('fills an L-shaped room', () => {
    const cells = state.dungeon.cells;
    // Horizontal bar: row 3, cols 3-5
    for (let c = 3; c <= 5; c++) {
      cells[3][c] = {};
      cells[3][c].north = 'w';
      cells[3][c].south = 'w';
    }
    cells[3][3].west = 'w';
    cells[3][5].east = 'w';
    // Vertical bar: rows 4-5, col 3
    for (let r = 4; r <= 5; r++) {
      cells[r][3] = {};
      cells[r][3].west = 'w';
      cells[r][3].east = 'w';
    }
    cells[5][3].south = 'w';
    // Remove wall between (3,3) south and (4,3) north
    delete cells[3][3].south;
    // Label in the horizontal bar
    cells[3][4].center = { label: 'L1' };

    const roomCells = _collectRoomCells('L1');
    expect(roomCells.size).toBe(5); // 3 in top bar + 2 in vertical bar
    expect(roomCells.has('3,3')).toBe(true);
    expect(roomCells.has('5,3')).toBe(true);
  });
});

// ── _getWallCells ────────────────────────────────────────────────────────────

describe('_getWallCells', () => {
  it('returns north wall cells sorted by column', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    const roomCells = _collectRoomCells('A1');
    const northWall = _getWallCells(roomCells, 'north');
    // Top row cells (r=2) have no neighbor at r=1 in the room set
    expect(northWall.length).toBe(3);
    expect(northWall.map(([, c]) => c)).toEqual([2, 3, 4]); // sorted by col
    expect(northWall[0][0]).toBe(2); // all in row 2
  });

  it('returns south wall cells sorted by column', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    const roomCells = _collectRoomCells('A1');
    const southWall = _getWallCells(roomCells, 'south');
    expect(southWall.length).toBe(3);
    expect(southWall[0][0]).toBe(4); // row 4
    expect(southWall.map(([, c]) => c)).toEqual([2, 3, 4]);
  });

  it('returns east wall cells sorted by row', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    const roomCells = _collectRoomCells('A1');
    const eastWall = _getWallCells(roomCells, 'east');
    expect(eastWall.length).toBe(3);
    expect(eastWall.map(([r]) => r)).toEqual([2, 3, 4]); // sorted by row
    expect(eastWall[0][1]).toBe(4); // all in col 4
  });

  it('returns west wall cells sorted by row', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    const roomCells = _collectRoomCells('A1');
    const westWall = _getWallCells(roomCells, 'west');
    expect(westWall.length).toBe(3);
    expect(westWall[0][1]).toBe(2); // all in col 2
  });

  it('throws for invalid wall direction', () => {
    const roomCells = new Set(['2,2']);
    expect(() => _getWallCells(roomCells, 'diagonal')).toThrow('wall must be one of');
  });

  it('returns empty array when no cells on that wall', () => {
    // Single cell room — no neighbor in any direction means all sides are walls
    const roomCells = new Set(['5,5']);
    const northWall = _getWallCells(roomCells, 'north');
    expect(northWall.length).toBe(1); // single cell is its own wall cell on every side
  });
});

// ── _isCellCoveredByProp ─────────────────────────────────────────────────────

describe('_isCellCoveredByProp', () => {
  it('returns true for a cell with a prop directly on it', () => {
    state.dungeon.cells[5][5] = {};
    placeOverlayProp(5, 5, 'chair', [1, 1]);
    expect(_isCellCoveredByProp(5, 5)).toBe(true);
  });

  it('returns false for an empty cell', () => {
    state.dungeon.cells[5][5] = {};
    expect(_isCellCoveredByProp(5, 5)).toBe(false);
  });

  it('returns false for a null cell', () => {
    expect(_isCellCoveredByProp(5, 5)).toBe(false);
  });

  it('detects coverage by a multi-cell prop anchored elsewhere', () => {
    const cells = state.dungeon.cells;
    cells[5][5] = {};
    cells[5][6] = {};
    cells[6][5] = {};
    cells[6][6] = {};
    // Place a 2x2 prop at (5,5)
    placeOverlayProp(5, 5, 'table', [2, 2]);
    // (6,6) should be covered by the 2x2 prop at (5,5)
    expect(_isCellCoveredByProp(6, 6)).toBe(true);
    // (5,6) should be covered too
    expect(_isCellCoveredByProp(5, 6)).toBe(true);
    // (6,5) should be covered
    expect(_isCellCoveredByProp(6, 5)).toBe(true);
  });

  it('does not false-positive for cells outside prop span', () => {
    const cells = state.dungeon.cells;
    cells[5][5] = {};
    cells[5][7] = {};
    cells[7][5] = {};
    placeOverlayProp(5, 5, 'table', [2, 2]);
    expect(_isCellCoveredByProp(5, 7)).toBe(false);
    expect(_isCellCoveredByProp(7, 5)).toBe(false);
  });
});

// ── getRoomBounds ────────────────────────────────────────────────────────────

describe('getRoomBounds', () => {
  it('computes bounding box for a 3x3 room', () => {
    buildRoom(2, 3, 4, 5, 'B1', 3, 4);
    const bounds = getRoomBounds('B1');
    expect(bounds).toEqual({
      r1: 2, c1: 3, r2: 4, c2: 5,
      centerRow: 3, centerCol: 4,
    });
  });

  it('returns null for a non-existent room', () => {
    expect(getRoomBounds('NonExistent')).toBeNull();
  });

  it('computes bounds for a single-cell room', () => {
    const cells = state.dungeon.cells;
    cells[5][5] = { center: { label: 'Tiny' }, north: 'w', south: 'w', east: 'w', west: 'w' };
    const bounds = getRoomBounds('Tiny');
    expect(bounds).toEqual({ r1: 5, c1: 5, r2: 5, c2: 5, centerRow: 5, centerCol: 5 });
  });

  it('computes bounds for a wide room', () => {
    buildRoom(3, 1, 3, 10, 'Wide', 3, 5);
    const bounds = getRoomBounds('Wide');
    expect(bounds.r1).toBe(3);
    expect(bounds.r2).toBe(3);
    expect(bounds.c1).toBe(1);
    expect(bounds.c2).toBe(10);
  });

  it('computes center as floor of midpoints', () => {
    buildRoom(2, 2, 5, 7, 'Rect', 3, 4);
    const bounds = getRoomBounds('Rect');
    expect(bounds.centerRow).toBe(Math.floor((2 + 5) / 2));
    expect(bounds.centerCol).toBe(Math.floor((2 + 7) / 2));
  });
});

// ── findWallBetween ──────────────────────────────────────────────────────────

describe('findWallBetween', () => {
  it('finds the shared wall between two adjacent rooms', () => {
    setupTwoAdjacentRooms();
    const walls = findWallBetween('A1', 'A2');
    expect(walls).not.toBeNull();
    expect(walls.length).toBe(3); // 3 cells share the boundary
    // All walls should be in the east direction from A1
    for (const w of walls) {
      expect(w.direction).toBe('east');
      expect(w.col).toBe(4);
      expect(w.type).toBe('w');
    }
  });

  it('returns null when rooms are not adjacent', () => {
    buildRoom(2, 2, 4, 4, 'X1', 3, 3);
    buildRoom(2, 8, 4, 10, 'X2', 3, 9);
    expect(findWallBetween('X1', 'X2')).toBeNull();
  });

  it('returns null if either label does not exist', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    expect(findWallBetween('A1', 'NonExistent')).toBeNull();
    expect(findWallBetween('NonExistent', 'A1')).toBeNull();
  });

  it('detects door types on shared boundaries', () => {
    setupTwoAdjacentRooms();
    // Replace the middle wall with a door
    const cells = state.dungeon.cells;
    cells[3][4].east = 'd';
    cells[3][5].west = 'd';
    const walls = findWallBetween('A1', 'A2');
    expect(walls).not.toBeNull();
    const doorEntry = walls.find(w => w.row === 3);
    expect(doorEntry.type).toBe('d');
  });

  it('finds walls in reverse order too (A2 -> A1)', () => {
    setupTwoAdjacentRooms();
    const walls = findWallBetween('A2', 'A1');
    expect(walls).not.toBeNull();
    expect(walls.length).toBe(3);
    // From A2 perspective, the wall is on the west side
    for (const w of walls) {
      expect(w.direction).toBe('west');
      expect(w.col).toBe(5);
    }
  });
});

// ── partitionRoom ────────────────────────────────────────────────────────────

describe('partitionRoom', () => {
  it('adds a horizontal wall across a room', () => {
    buildRoom(2, 2, 6, 6, 'P1', 4, 4);
    const result = partitionRoom('P1', 'horizontal', 4);
    expect(result.success).toBe(true);
    expect(result.wallsPlaced).toBeGreaterThan(0);
    // Check that row 4 now has south walls
    const cells = state.dungeon.cells;
    for (let c = 2; c <= 6; c++) {
      if (cells[4][c] && cells[5]?.[c]) {
        // If there's a cell below in the room, should have wall
        expect(cells[4][c].south).toBe('w');
      }
    }
  });

  it('adds a vertical wall across a room', () => {
    buildRoom(2, 2, 6, 6, 'P2', 4, 4);
    const result = partitionRoom('P2', 'vertical', 4);
    expect(result.success).toBe(true);
    expect(result.wallsPlaced).toBeGreaterThan(0);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 6; r++) {
      if (cells[r][4] && cells[r][5]) {
        expect(cells[r][4].east).toBe('w');
      }
    }
  });

  it('places a door at the specified position', () => {
    buildRoom(2, 2, 6, 6, 'P3', 4, 4);
    partitionRoom('P3', 'horizontal', 4, 'w', { doorAt: 4 });
    const cells = state.dungeon.cells;
    expect(cells[4][4].south).toBe('d');
    // Other cells in the partition should be walls
    expect(cells[4][3].south).toBe('w');
  });

  it('throws for invalid direction', () => {
    buildRoom(2, 2, 4, 4, 'P4', 3, 3);
    expect(() => partitionRoom('P4', 'diagonal', 3)).toThrow('direction must be');
  });

  it('throws for invalid wall type', () => {
    buildRoom(2, 2, 4, 4, 'P5', 3, 3);
    expect(() => partitionRoom('P5', 'horizontal', 3, 'x')).toThrow('wallType must be');
  });

  it('throws if room label not found', () => {
    expect(() => partitionRoom('ZZZ', 'horizontal', 3)).toThrow('not found');
  });

  it('throws if position has no cells in the room', () => {
    buildRoom(2, 2, 4, 4, 'P6', 3, 3);
    expect(() => partitionRoom('P6', 'horizontal', 10)).toThrow('No cells at');
  });

  it('supports invisible wall type', () => {
    buildRoom(2, 2, 6, 6, 'P7', 4, 4);
    partitionRoom('P7', 'horizontal', 4, 'iw');
    const cells = state.dungeon.cells;
    // Check that the partition uses 'iw'
    expect(cells[4][3].south).toBe('iw');
  });

  it('sets reciprocal walls on the other side', () => {
    buildRoom(2, 2, 6, 6, 'P8', 4, 4);
    partitionRoom('P8', 'horizontal', 4);
    const cells = state.dungeon.cells;
    // Row 5 should have north walls (reciprocal of row 4 south)
    expect(cells[5][3].north).toBe('w');
  });
});
