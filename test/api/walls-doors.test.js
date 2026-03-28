import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';

import {
  setWall,
  removeWall,
  setDoor,
  removeDoor,
} from '../../src/editor/js/api/walls-doors.js';

// ---------------------------------------------------------------------------
// Helper
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
// setWall
// ═══════════════════════════════════════════════════════════════════════════

describe('setWall', () => {
  beforeEach(() => freshDungeon());

  it('places a wall on a void cell (auto-creates the cell)', () => {
    expect(state.dungeon.cells[5][5]).toBeNull();
    const result = setWall(5, 5, 'north');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5]).not.toBeNull();
    expect(state.dungeon.cells[5][5].north).toBe('w');
  });

  it('places reciprocal wall on the neighbor (cardinal)', () => {
    // Paint both cells first so reciprocal works
    state.dungeon.cells[5][5] = {};
    state.dungeon.cells[4][5] = {};
    setWall(5, 5, 'north');
    expect(state.dungeon.cells[5][5].north).toBe('w');
    expect(state.dungeon.cells[4][5].south).toBe('w');
  });

  it('places reciprocal east/west', () => {
    state.dungeon.cells[5][5] = {};
    state.dungeon.cells[5][6] = {};
    setWall(5, 5, 'east');
    expect(state.dungeon.cells[5][5].east).toBe('w');
    expect(state.dungeon.cells[5][6].west).toBe('w');
  });

  it('places reciprocal south/north', () => {
    state.dungeon.cells[5][5] = {};
    state.dungeon.cells[6][5] = {};
    setWall(5, 5, 'south');
    expect(state.dungeon.cells[5][5].south).toBe('w');
    expect(state.dungeon.cells[6][5].north).toBe('w');
  });

  it('places reciprocal west/east', () => {
    state.dungeon.cells[5][5] = {};
    state.dungeon.cells[5][4] = {};
    setWall(5, 5, 'west');
    expect(state.dungeon.cells[5][5].west).toBe('w');
    expect(state.dungeon.cells[5][4].east).toBe('w');
  });

  it('supports diagonal nw-se (no reciprocal expected)', () => {
    const result = setWall(5, 5, 'nw-se');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5]['nw-se']).toBe('w');
  });

  it('supports diagonal ne-sw (no reciprocal expected)', () => {
    const result = setWall(5, 5, 'ne-sw');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5]['ne-sw']).toBe('w');
  });

  it('pushes undo when placing a wall', () => {
    setWall(5, 5, 'north');
    expect(state.undoStack.length).toBe(1);
  });

  it('marks dirty after placing a wall', () => {
    state.dirty = false;
    setWall(5, 5, 'east');
    expect(state.dirty).toBe(true);
  });

  it('handles edge of grid (no neighbor to set reciprocal)', () => {
    // Row 0, north — no neighbor above
    const result = setWall(0, 0, 'north');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[0][0].north).toBe('w');
  });

  it('throws for invalid direction', () => {
    expect(() => setWall(5, 5, 'up')).toThrow(/invalid direction/i);
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => setWall(99, 0, 'north')).toThrow(/out of bounds/i);
  });

  it('overwrites existing wall value', () => {
    state.dungeon.cells[5][5] = { north: 'd' };
    setWall(5, 5, 'north');
    expect(state.dungeon.cells[5][5].north).toBe('w');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// removeWall
// ═══════════════════════════════════════════════════════════════════════════

describe('removeWall', () => {
  beforeEach(() => freshDungeon());

  it('removes a wall from a cell', () => {
    state.dungeon.cells[5][5] = { north: 'w' };
    const result = removeWall(5, 5, 'north');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].north).toBeUndefined();
  });

  it('removes the reciprocal wall on the neighbor', () => {
    state.dungeon.cells[5][5] = { north: 'w' };
    state.dungeon.cells[4][5] = { south: 'w' };
    removeWall(5, 5, 'north');
    expect(state.dungeon.cells[5][5].north).toBeUndefined();
    expect(state.dungeon.cells[4][5].south).toBeUndefined();
  });

  it('removes reciprocal for east/west', () => {
    state.dungeon.cells[5][5] = { east: 'w' };
    state.dungeon.cells[5][6] = { west: 'w' };
    removeWall(5, 5, 'east');
    expect(state.dungeon.cells[5][5].east).toBeUndefined();
    expect(state.dungeon.cells[5][6].west).toBeUndefined();
  });

  it('is a no-op on a null cell', () => {
    const result = removeWall(5, 5, 'north');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5]).toBeNull();
  });

  it('pushes undo when removing from a non-null cell', () => {
    state.dungeon.cells[5][5] = { north: 'w' };
    removeWall(5, 5, 'north');
    expect(state.undoStack.length).toBe(1);
  });

  it('does NOT push undo for a null cell', () => {
    removeWall(5, 5, 'north');
    expect(state.undoStack.length).toBe(0);
  });

  it('supports diagonal removal', () => {
    state.dungeon.cells[5][5] = { 'nw-se': 'w' };
    removeWall(5, 5, 'nw-se');
    expect(state.dungeon.cells[5][5]['nw-se']).toBeUndefined();
  });

  it('throws for invalid direction', () => {
    expect(() => removeWall(5, 5, 'up')).toThrow(/invalid direction/i);
  });

  it('throws for out-of-bounds', () => {
    expect(() => removeWall(-1, 0, 'north')).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// setDoor
// ═══════════════════════════════════════════════════════════════════════════

describe('setDoor', () => {
  beforeEach(() => freshDungeon());

  it('places a normal door on a cell', () => {
    const result = setDoor(5, 5, 'north');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].north).toBe('d');
  });

  it('places a secret door when type is "s"', () => {
    setDoor(5, 5, 'east', 's');
    expect(state.dungeon.cells[5][5].east).toBe('s');
  });

  it('places reciprocal door on neighbor', () => {
    state.dungeon.cells[5][5] = {};
    state.dungeon.cells[4][5] = {};
    setDoor(5, 5, 'north', 'd');
    expect(state.dungeon.cells[5][5].north).toBe('d');
    expect(state.dungeon.cells[4][5].south).toBe('d');
  });

  it('places reciprocal secret door on neighbor', () => {
    state.dungeon.cells[5][5] = {};
    state.dungeon.cells[5][6] = {};
    setDoor(5, 5, 'east', 's');
    expect(state.dungeon.cells[5][6].west).toBe('s');
  });

  it('pushes undo when placing a door', () => {
    setDoor(5, 5, 'south');
    expect(state.undoStack.length).toBe(1);
  });

  it('marks dirty after placing a door', () => {
    state.dirty = false;
    setDoor(5, 5, 'west');
    expect(state.dirty).toBe(true);
  });

  it('throws for diagonal direction', () => {
    expect(() => setDoor(5, 5, 'nw-se')).toThrow(/invalid direction for door/i);
  });

  it('throws for invalid door type', () => {
    expect(() => setDoor(5, 5, 'north', 'x')).toThrow(/invalid door type/i);
  });

  it('throws for out-of-bounds', () => {
    expect(() => setDoor(99, 99, 'north')).toThrow(/out of bounds/i);
  });

  it('auto-creates the cell if null', () => {
    expect(state.dungeon.cells[3][3]).toBeNull();
    setDoor(3, 3, 'north');
    expect(state.dungeon.cells[3][3]).not.toBeNull();
    expect(state.dungeon.cells[3][3].north).toBe('d');
  });

  it('overwrites existing wall with door', () => {
    state.dungeon.cells[5][5] = { north: 'w' };
    setDoor(5, 5, 'north');
    expect(state.dungeon.cells[5][5].north).toBe('d');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// removeDoor
// ═══════════════════════════════════════════════════════════════════════════

describe('removeDoor', () => {
  beforeEach(() => freshDungeon());

  it('reverts a door to a wall', () => {
    state.dungeon.cells[5][5] = { north: 'd' };
    const result = removeDoor(5, 5, 'north');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].north).toBe('w');
  });

  it('sets reciprocal back to wall', () => {
    state.dungeon.cells[5][5] = { north: 'd' };
    state.dungeon.cells[4][5] = { south: 'd' };
    removeDoor(5, 5, 'north');
    expect(state.dungeon.cells[5][5].north).toBe('w');
    expect(state.dungeon.cells[4][5].south).toBe('w');
  });

  it('reverts a secret door to a wall', () => {
    state.dungeon.cells[5][5] = { east: 's' };
    state.dungeon.cells[5][6] = { west: 's' };
    removeDoor(5, 5, 'east');
    expect(state.dungeon.cells[5][5].east).toBe('w');
    expect(state.dungeon.cells[5][6].west).toBe('w');
  });

  it('is a no-op on null cell', () => {
    const result = removeDoor(5, 5, 'north');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5]).toBeNull();
  });

  it('pushes undo when operating on non-null cell', () => {
    state.dungeon.cells[5][5] = { north: 'd' };
    removeDoor(5, 5, 'north');
    expect(state.undoStack.length).toBe(1);
  });

  it('does NOT push undo on null cell', () => {
    removeDoor(5, 5, 'north');
    expect(state.undoStack.length).toBe(0);
  });

  it('throws for diagonal direction', () => {
    expect(() => removeDoor(5, 5, 'ne-sw')).toThrow(/invalid direction for door/i);
  });

  it('throws for invalid direction', () => {
    expect(() => removeDoor(5, 5, 'up')).toThrow(/invalid direction for door/i);
  });

  it('throws for out-of-bounds', () => {
    expect(() => removeDoor(-1, 0, 'north')).toThrow(/out of bounds/i);
  });
});
