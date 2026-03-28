import { describe, it, expect, beforeEach, vi } from 'vitest';
import state, { pushUndo, markDirty, notify } from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';

// Import the module under test
// Note: cells.js does not use getApi(), so no need to import the assembler.
import {
  getCellInfo,
  paintCell,
  paintRect,
  eraseCell,
  eraseRect,
  createRoom,
  createPolygonRoom,
} from '../../src/editor/js/api/cells.js';

// ---------------------------------------------------------------------------
// Helper: create a fresh 20x30 dungeon before each test
// ---------------------------------------------------------------------------

function freshDungeon(rows = 20, cols = 30) {
  state.dungeon = createEmptyDungeon('Test', rows, cols, 5, 'stone-dungeon', 1);
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
  state.listeners = [];
  state.dirty = false;
  state.unsavedChanges = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// getCellInfo
// ═══════════════════════════════════════════════════════════════════════════

describe('getCellInfo', () => {
  beforeEach(() => freshDungeon());

  it('returns null cell for a void (empty) cell', () => {
    const result = getCellInfo(0, 0);
    expect(result.success).toBe(true);
    expect(result.cell).toBeNull();
  });

  it('returns cell data for a painted cell', () => {
    state.dungeon.cells[5][5] = { north: 'w', south: 'w' };
    const result = getCellInfo(5, 5);
    expect(result.success).toBe(true);
    expect(result.cell).toEqual({ north: 'w', south: 'w' });
  });

  it('returns a deep copy — mutations do not affect state', () => {
    state.dungeon.cells[3][3] = { east: 'd' };
    const result = getCellInfo(3, 3);
    result.cell.east = 'w';
    expect(state.dungeon.cells[3][3].east).toBe('d');
  });

  it('throws for out-of-bounds row', () => {
    expect(() => getCellInfo(99, 0)).toThrow(/out of bounds/i);
  });

  it('throws for out-of-bounds col', () => {
    expect(() => getCellInfo(0, 99)).toThrow(/out of bounds/i);
  });

  it('throws for negative coordinates', () => {
    expect(() => getCellInfo(-1, 0)).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// paintCell
// ═══════════════════════════════════════════════════════════════════════════

describe('paintCell', () => {
  beforeEach(() => freshDungeon());

  it('converts a void cell to an empty object', () => {
    expect(state.dungeon.cells[2][3]).toBeNull();
    const result = paintCell(2, 3);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[2][3]).toEqual({});
  });

  it('pushes undo when painting a void cell', () => {
    paintCell(2, 3);
    expect(state.undoStack.length).toBe(1);
  });

  it('does NOT push undo for already-painted cell', () => {
    state.dungeon.cells[2][3] = {};
    paintCell(2, 3);
    expect(state.undoStack.length).toBe(0);
  });

  it('marks dirty after painting', () => {
    state.dirty = false;
    paintCell(2, 3);
    expect(state.dirty).toBe(true);
  });

  it('is idempotent on non-null cell', () => {
    state.dungeon.cells[2][3] = { north: 'w' };
    paintCell(2, 3);
    expect(state.dungeon.cells[2][3]).toEqual({ north: 'w' });
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => paintCell(100, 0)).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// paintRect
// ═══════════════════════════════════════════════════════════════════════════

describe('paintRect', () => {
  beforeEach(() => freshDungeon());

  it('paints a 3x3 rectangle of void cells', () => {
    const result = paintRect(2, 3, 4, 5);
    expect(result.success).toBe(true);
    for (let r = 2; r <= 4; r++) {
      for (let c = 3; c <= 5; c++) {
        expect(state.dungeon.cells[r][c]).toEqual({});
      }
    }
  });

  it('handles reversed corners (r2 < r1)', () => {
    paintRect(4, 5, 2, 3);
    for (let r = 2; r <= 4; r++) {
      for (let c = 3; c <= 5; c++) {
        expect(state.dungeon.cells[r][c]).toEqual({});
      }
    }
  });

  it('does not overwrite existing cell data', () => {
    state.dungeon.cells[3][4] = { north: 'w' };
    paintRect(2, 3, 4, 5);
    expect(state.dungeon.cells[3][4]).toEqual({ north: 'w' });
  });

  it('pushes exactly one undo entry', () => {
    paintRect(0, 0, 2, 2);
    expect(state.undoStack.length).toBe(1);
  });

  it('throws when rectangle extends out of bounds', () => {
    expect(() => paintRect(0, 0, 99, 99)).toThrow(/out of bounds/i);
  });

  it('single-cell rect works (r1==r2, c1==c2)', () => {
    paintRect(5, 5, 5, 5);
    expect(state.dungeon.cells[5][5]).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// eraseCell
// ═══════════════════════════════════════════════════════════════════════════

describe('eraseCell', () => {
  beforeEach(() => freshDungeon());

  it('sets a painted cell back to null', () => {
    state.dungeon.cells[4][4] = { east: 'w' };
    const result = eraseCell(4, 4);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[4][4]).toBeNull();
  });

  it('pushes undo when erasing a non-null cell', () => {
    state.dungeon.cells[4][4] = {};
    eraseCell(4, 4);
    expect(state.undoStack.length).toBe(1);
  });

  it('does NOT push undo for already-void cell', () => {
    eraseCell(0, 0); // already null
    expect(state.undoStack.length).toBe(0);
  });

  it('marks dirty after erasing', () => {
    state.dungeon.cells[1][1] = {};
    state.dirty = false;
    eraseCell(1, 1);
    expect(state.dirty).toBe(true);
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => eraseCell(-1, -1)).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// eraseRect
// ═══════════════════════════════════════════════════════════════════════════

describe('eraseRect', () => {
  beforeEach(() => freshDungeon());

  it('sets all cells in range to null', () => {
    // Pre-paint cells
    for (let r = 2; r <= 4; r++) {
      for (let c = 3; c <= 5; c++) {
        state.dungeon.cells[r][c] = {};
      }
    }
    const result = eraseRect(2, 3, 4, 5);
    expect(result.success).toBe(true);
    for (let r = 2; r <= 4; r++) {
      for (let c = 3; c <= 5; c++) {
        expect(state.dungeon.cells[r][c]).toBeNull();
      }
    }
  });

  it('handles reversed corners', () => {
    state.dungeon.cells[3][3] = {};
    eraseRect(4, 5, 2, 3);
    expect(state.dungeon.cells[3][3]).toBeNull();
  });

  it('pushes exactly one undo entry', () => {
    eraseRect(0, 0, 2, 2);
    expect(state.undoStack.length).toBe(1);
  });

  it('throws when rectangle extends out of bounds', () => {
    expect(() => eraseRect(0, 0, 99, 99)).toThrow(/out of bounds/i);
  });

  it('is safe to erase already-void cells', () => {
    // All cells are null by default — should not throw
    const result = eraseRect(0, 0, 1, 1);
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createRoom
// ═══════════════════════════════════════════════════════════════════════════

describe('createRoom', () => {
  beforeEach(() => freshDungeon());

  it('creates cells and returns success', () => {
    // createRoom delegates to roomTool._applyWalls() which is a real
    // RoomTool instance.  It paints cells + places perimeter walls.
    const result = createRoom(2, 3, 4, 5);
    expect(result.success).toBe(true);
  });

  it('normalizes reversed corners before delegating', () => {
    // createRoom normalizes r1<->r2, c1<->c2 before calling _applyWalls
    const result = createRoom(7, 7, 5, 5);
    expect(result.success).toBe(true);
  });

  it('sets roomMode to requested mode and restores it', () => {
    state.roomMode = 'room';
    createRoom(2, 2, 4, 4, 'merge');
    // After call, original roomMode should be restored
    expect(state.roomMode).toBe('room');
  });

  it('accepts merge mode without throwing', () => {
    const result = createRoom(2, 2, 4, 4, 'merge');
    expect(result.success).toBe(true);
  });

  it('defaults to room mode when no mode specified', () => {
    const result = createRoom(2, 2, 4, 4);
    expect(result.success).toBe(true);
  });

  it('throws on invalid mode', () => {
    expect(() => createRoom(0, 0, 2, 2, 'invalid')).toThrow(/invalid room mode/i);
  });

  it('throws when coordinates are out of bounds', () => {
    expect(() => createRoom(0, 0, 99, 99)).toThrow(/out of bounds/i);
  });

  it('restores state.roomMode after call', () => {
    state.roomMode = 'merge';
    createRoom(2, 2, 4, 4, 'room');
    expect(state.roomMode).toBe('merge');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createPolygonRoom
// ═══════════════════════════════════════════════════════════════════════════

describe('createPolygonRoom', () => {
  beforeEach(() => freshDungeon());

  it('creates cells for all specified coordinates', () => {
    const cells = [[2, 3], [2, 4], [3, 3]];
    const result = createPolygonRoom(cells);
    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(state.dungeon.cells[2][3]).not.toBeNull();
    expect(state.dungeon.cells[2][4]).not.toBeNull();
    expect(state.dungeon.cells[3][3]).not.toBeNull();
  });

  it('creates L-shaped room with correct wall placement', () => {
    // L-shape:
    //  [2,2] [2,3] [2,4]
    //  [3,2]
    //  [4,2]
    const cellList = [[2, 2], [2, 3], [2, 4], [3, 2], [4, 2]];
    createPolygonRoom(cellList, 'room');
    const d = state.dungeon.cells;

    // Top-left corner: walls on north and west
    expect(d[2][2].north).toBe('w');
    expect(d[2][2].west).toBe('w');

    // [2,2] east to [2,3] — interior, no wall
    expect(d[2][2].east).toBeUndefined();
    expect(d[2][3].west).toBeUndefined();

    // [2,2] south to [3,2] — interior, no wall
    expect(d[2][2].south).toBeUndefined();
    expect(d[3][2].north).toBeUndefined();

    // [2,4] — east and north should be walls (perimeter)
    expect(d[2][4].north).toBe('w');
    expect(d[2][4].east).toBe('w');
    // [2,4] south faces void — should be wall
    expect(d[2][4].south).toBe('w');

    // Bottom-left [4,2] — south and west walls, east wall (nothing there)
    expect(d[4][2].south).toBe('w');
    expect(d[4][2].west).toBe('w');
    expect(d[4][2].east).toBe('w');
  });

  it('merge mode only walls void edges', () => {
    // Place existing cell at [2,5]
    state.dungeon.cells[2][5] = { west: 'w' };
    // Now merge a room adjacent to it
    const cellList = [[2, 3], [2, 4]];
    createPolygonRoom(cellList, 'merge');
    const d = state.dungeon.cells;

    // [2,4] east faces existing cell [2,5] — merge clears the wall
    expect(d[2][4].east).toBeUndefined();
    // [2,3] west faces void — gets wall
    expect(d[2][3].west).toBe('w');
  });

  it('preserves existing doors during room creation', () => {
    // Pre-place a door
    state.dungeon.cells[2][3] = { east: 'd' };
    state.dungeon.cells[2][4] = { west: 'd' };
    const cellList = [[2, 3], [2, 4]];
    createPolygonRoom(cellList, 'room');
    const d = state.dungeon.cells;
    // Door should be preserved
    expect(d[2][3].east).toBe('d');
    expect(d[2][4].west).toBe('d');
  });

  it('preserves existing secret doors', () => {
    state.dungeon.cells[2][3] = { east: 's' };
    state.dungeon.cells[2][4] = { west: 's' };
    const cellList = [[2, 3], [2, 4]];
    createPolygonRoom(cellList, 'room');
    expect(state.dungeon.cells[2][3].east).toBe('s');
    expect(state.dungeon.cells[2][4].west).toBe('s');
  });

  it('pushes exactly one undo entry', () => {
    createPolygonRoom([[2, 3], [2, 4]]);
    expect(state.undoStack.length).toBe(1);
  });

  it('throws on empty cellList', () => {
    expect(() => createPolygonRoom([])).toThrow(/non-empty/i);
  });

  it('throws on non-array argument', () => {
    expect(() => createPolygonRoom('not array')).toThrow(/non-empty array/i);
  });

  it('throws if any coordinate is out of bounds', () => {
    expect(() => createPolygonRoom([[0, 0], [99, 99]])).toThrow(/out of bounds/i);
  });
});
