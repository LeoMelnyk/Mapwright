import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';

import {
  setFill,
  removeFill,
  setFillRect,
  removeFillRect,
  setHazard,
  setHazardRect,
} from '../../src/editor/js/api/fills.js';

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
// setFill
// ═══════════════════════════════════════════════════════════════════════════

describe('setFill', () => {
  beforeEach(() => freshDungeon());

  it('sets water fill on a cell', () => {
    const result = setFill(5, 5, 'water', 2);
    expect(result.success).toBe(true);
    const cell = state.dungeon.cells[5][5];
    expect(cell.fill).toBe('water');
    expect(cell.waterDepth).toBe(2);
  });

  it('sets pit fill on a cell', () => {
    setFill(5, 5, 'pit', 1);
    const cell = state.dungeon.cells[5][5];
    expect(cell.fill).toBe('pit');
    expect(cell.waterDepth).toBeUndefined();
    expect(cell.lavaDepth).toBeUndefined();
  });

  it('sets lava fill with depth', () => {
    setFill(5, 5, 'lava', 3);
    const cell = state.dungeon.cells[5][5];
    expect(cell.fill).toBe('lava');
    expect(cell.lavaDepth).toBe(3);
    expect(cell.waterDepth).toBeUndefined();
  });

  it('defaults depth to 1 for invalid depth', () => {
    setFill(5, 5, 'water', 0);
    expect(state.dungeon.cells[5][5].waterDepth).toBe(1);
  });

  it('defaults depth to 1 for out-of-range depth (>3)', () => {
    setFill(5, 5, 'water', 99);
    expect(state.dungeon.cells[5][5].waterDepth).toBe(1);
  });

  it('cleans up lavaDepth when switching to water', () => {
    state.dungeon.cells[5][5] = { fill: 'lava', lavaDepth: 3 };
    setFill(5, 5, 'water', 1);
    const cell = state.dungeon.cells[5][5];
    expect(cell.fill).toBe('water');
    expect(cell.waterDepth).toBe(1);
    expect(cell.lavaDepth).toBeUndefined();
  });

  it('cleans up waterDepth when switching to lava', () => {
    state.dungeon.cells[5][5] = { fill: 'water', waterDepth: 2 };
    setFill(5, 5, 'lava', 1);
    const cell = state.dungeon.cells[5][5];
    expect(cell.fill).toBe('lava');
    expect(cell.lavaDepth).toBe(1);
    expect(cell.waterDepth).toBeUndefined();
  });

  it('auto-creates cell if null', () => {
    expect(state.dungeon.cells[3][3]).toBeNull();
    setFill(3, 3, 'pit', 1);
    expect(state.dungeon.cells[3][3]).not.toBeNull();
    expect(state.dungeon.cells[3][3].fill).toBe('pit');
  });

  it('pushes undo', () => {
    setFill(5, 5, 'water', 1);
    expect(state.undoStack.length).toBe(1);
  });

  it('marks dirty', () => {
    state.dirty = false;
    setFill(5, 5, 'water', 1);
    expect(state.dirty).toBe(true);
  });

  it('throws for invalid fill type', () => {
    expect(() => setFill(5, 5, 'acid', 1)).toThrow(/invalid fill type/i);
  });

  it('throws for hazard as fill type (should use setHazard)', () => {
    expect(() => setFill(5, 5, 'difficult-terrain', 1)).toThrow(/invalid fill type/i);
  });

  it('throws for out-of-bounds', () => {
    expect(() => setFill(99, 99, 'water', 1)).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// removeFill
// ═══════════════════════════════════════════════════════════════════════════

describe('removeFill', () => {
  beforeEach(() => freshDungeon());

  it('removes a fill from a cell', () => {
    state.dungeon.cells[5][5] = { fill: 'water', waterDepth: 2 };
    const result = removeFill(5, 5);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].fill).toBeUndefined();
  });

  it('is a no-op on null cell', () => {
    const result = removeFill(5, 5);
    expect(result.success).toBe(true);
  });

  it('is a no-op on cell without fill', () => {
    state.dungeon.cells[5][5] = { north: 'w' };
    const result = removeFill(5, 5);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].north).toBe('w');
  });

  it('pushes undo when removing an existing fill', () => {
    state.dungeon.cells[5][5] = { fill: 'pit' };
    removeFill(5, 5);
    expect(state.undoStack.length).toBe(1);
  });

  it('does NOT push undo when no fill exists', () => {
    state.dungeon.cells[5][5] = {};
    removeFill(5, 5);
    expect(state.undoStack.length).toBe(0);
  });

  it('throws for out-of-bounds', () => {
    expect(() => removeFill(-1, 0)).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// setFillRect
// ═══════════════════════════════════════════════════════════════════════════

describe('setFillRect', () => {
  beforeEach(() => freshDungeon());

  it('fills a rectangle of existing cells with water', () => {
    // Pre-paint cells
    for (let r = 2; r <= 4; r++)
      for (let c = 3; c <= 5; c++)
        state.dungeon.cells[r][c] = {};

    const result = setFillRect(2, 3, 4, 5, 'water', 2);
    expect(result.success).toBe(true);
    for (let r = 2; r <= 4; r++) {
      for (let c = 3; c <= 5; c++) {
        expect(state.dungeon.cells[r][c].fill).toBe('water');
        expect(state.dungeon.cells[r][c].waterDepth).toBe(2);
      }
    }
  });

  it('fills a rectangle with lava', () => {
    state.dungeon.cells[2][3] = {};
    state.dungeon.cells[2][4] = {};
    setFillRect(2, 3, 2, 4, 'lava', 3);
    expect(state.dungeon.cells[2][3].fill).toBe('lava');
    expect(state.dungeon.cells[2][3].lavaDepth).toBe(3);
    expect(state.dungeon.cells[2][4].fill).toBe('lava');
  });

  it('fills a rectangle with pit', () => {
    state.dungeon.cells[2][3] = {};
    setFillRect(2, 3, 2, 3, 'pit', 1);
    expect(state.dungeon.cells[2][3].fill).toBe('pit');
    expect(state.dungeon.cells[2][3].waterDepth).toBeUndefined();
    expect(state.dungeon.cells[2][3].lavaDepth).toBeUndefined();
  });

  it('handles reversed corners', () => {
    state.dungeon.cells[4][5] = {};
    state.dungeon.cells[3][4] = {};
    setFillRect(4, 5, 3, 4, 'water', 1);
    expect(state.dungeon.cells[4][5].fill).toBe('water');
    expect(state.dungeon.cells[3][4].fill).toBe('water');
  });

  it('skips null cells in the rectangle', () => {
    // Only paint some cells
    state.dungeon.cells[2][3] = {};
    // cells[2][4] remains null
    setFillRect(2, 3, 2, 4, 'water', 1);
    expect(state.dungeon.cells[2][3].fill).toBe('water');
    expect(state.dungeon.cells[2][4]).toBeNull(); // still null
  });

  it('pushes exactly one undo entry', () => {
    setFillRect(0, 0, 2, 2, 'water', 1);
    expect(state.undoStack.length).toBe(1);
  });

  it('defaults depth to 1 for out-of-range', () => {
    state.dungeon.cells[2][3] = {};
    setFillRect(2, 3, 2, 3, 'water', 99);
    expect(state.dungeon.cells[2][3].waterDepth).toBe(1);
  });

  it('throws for invalid fill type', () => {
    expect(() => setFillRect(0, 0, 1, 1, 'acid', 1)).toThrow(/invalid fill type/i);
  });

  it('throws for out-of-bounds', () => {
    expect(() => setFillRect(0, 0, 99, 99, 'water', 1)).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// removeFillRect
// ═══════════════════════════════════════════════════════════════════════════

describe('removeFillRect', () => {
  beforeEach(() => freshDungeon());

  it('removes fill from all cells in a rectangle', () => {
    state.dungeon.cells[2][3] = { fill: 'water', waterDepth: 2 };
    state.dungeon.cells[2][4] = { fill: 'lava', lavaDepth: 1 };
    removeFillRect(2, 3, 2, 4);
    expect(state.dungeon.cells[2][3].fill).toBeUndefined();
    expect(state.dungeon.cells[2][4].fill).toBeUndefined();
  });

  it('skips null cells', () => {
    // cells[2][3] is null
    const result = removeFillRect(2, 3, 2, 3);
    expect(result.success).toBe(true);
  });

  it('pushes one undo entry', () => {
    removeFillRect(0, 0, 1, 1);
    expect(state.undoStack.length).toBe(1);
  });

  it('throws for out-of-bounds', () => {
    expect(() => removeFillRect(0, 0, 99, 99)).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// setHazard
// ═══════════════════════════════════════════════════════════════════════════

describe('setHazard', () => {
  beforeEach(() => freshDungeon());

  it('sets hazard flag on a cell', () => {
    const result = setHazard(5, 5, true);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].hazard).toBe(true);
  });

  it('removes hazard flag when disabled', () => {
    state.dungeon.cells[5][5] = { hazard: true };
    setHazard(5, 5, false);
    expect(state.dungeon.cells[5][5].hazard).toBeUndefined();
  });

  it('clears difficult-terrain fill when enabling hazard', () => {
    state.dungeon.cells[5][5] = { fill: 'difficult-terrain' };
    setHazard(5, 5, true);
    expect(state.dungeon.cells[5][5].hazard).toBe(true);
    expect(state.dungeon.cells[5][5].fill).toBeUndefined();
  });

  it('does not clear water/lava fill when enabling hazard', () => {
    state.dungeon.cells[5][5] = { fill: 'water', waterDepth: 1 };
    setHazard(5, 5, true);
    expect(state.dungeon.cells[5][5].hazard).toBe(true);
    expect(state.dungeon.cells[5][5].fill).toBe('water');
  });

  it('auto-creates cell if null', () => {
    setHazard(3, 3);
    expect(state.dungeon.cells[3][3]).not.toBeNull();
    expect(state.dungeon.cells[3][3].hazard).toBe(true);
  });

  it('defaults to enabled=true', () => {
    setHazard(5, 5);
    expect(state.dungeon.cells[5][5].hazard).toBe(true);
  });

  it('pushes undo', () => {
    setHazard(5, 5);
    expect(state.undoStack.length).toBe(1);
  });

  it('marks dirty', () => {
    state.dirty = false;
    setHazard(5, 5);
    expect(state.dirty).toBe(true);
  });

  it('throws for out-of-bounds', () => {
    expect(() => setHazard(99, 99)).toThrow(/out of bounds/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// setHazardRect
// ═══════════════════════════════════════════════════════════════════════════

describe('setHazardRect', () => {
  beforeEach(() => freshDungeon());

  it('enables hazard on all existing cells in a rectangle', () => {
    state.dungeon.cells[2][3] = {};
    state.dungeon.cells[2][4] = {};
    const result = setHazardRect(2, 3, 2, 4, true);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[2][3].hazard).toBe(true);
    expect(state.dungeon.cells[2][4].hazard).toBe(true);
  });

  it('disables hazard on all existing cells in a rectangle', () => {
    state.dungeon.cells[2][3] = { hazard: true };
    state.dungeon.cells[2][4] = { hazard: true };
    setHazardRect(2, 3, 2, 4, false);
    expect(state.dungeon.cells[2][3].hazard).toBeUndefined();
    expect(state.dungeon.cells[2][4].hazard).toBeUndefined();
  });

  it('skips null cells', () => {
    // cells[2][3] is null
    setHazardRect(2, 3, 2, 3, true);
    expect(state.dungeon.cells[2][3]).toBeNull();
  });

  it('handles reversed corners', () => {
    state.dungeon.cells[4][5] = {};
    setHazardRect(4, 5, 4, 5, true);
    expect(state.dungeon.cells[4][5].hazard).toBe(true);
  });

  it('pushes one undo entry', () => {
    setHazardRect(0, 0, 1, 1);
    expect(state.undoStack.length).toBe(1);
  });

  it('clears difficult-terrain fill when enabling hazard', () => {
    state.dungeon.cells[2][3] = { fill: 'difficult-terrain' };
    setHazardRect(2, 3, 2, 3, true);
    expect(state.dungeon.cells[2][3].fill).toBeUndefined();
    expect(state.dungeon.cells[2][3].hazard).toBe(true);
  });

  it('throws for out-of-bounds', () => {
    expect(() => setHazardRect(0, 0, 99, 99)).toThrow(/out of bounds/i);
  });
});
