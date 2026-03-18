import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';

import {
  getLevels,
  renameLevel,
  resizeLevel,
  addLevel,
  defineLevels,
} from '../../src/editor/js/api/levels.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function freshDungeon(rows = 20, cols = 30) {
  state.dungeon = createEmptyDungeon('Test', rows, cols, 5, 'stone-dungeon');
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
  state.listeners = [];
  state.dirty = false;
  state.unsavedChanges = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// getLevels
// ═══════════════════════════════════════════════════════════════════════════

describe('getLevels', () => {
  beforeEach(() => freshDungeon());

  it('returns the default single level', () => {
    const result = getLevels();
    expect(result.success).toBe(true);
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0]).toEqual({
      index: 0,
      name: 'Level 1',
      startRow: 0,
      numRows: 20,
    });
  });

  it('returns multiple levels after adding', () => {
    addLevel('Level 2', 10);
    const result = getLevels();
    expect(result.levels).toHaveLength(2);
    expect(result.levels[1].name).toBe('Level 2');
    expect(result.levels[1].index).toBe(1);
  });

  it('returns empty array if levels metadata is missing', () => {
    state.dungeon.metadata.levels = undefined;
    const result = getLevels();
    expect(result.success).toBe(true);
    expect(result.levels).toEqual([]);
  });

  it('includes correct startRow and numRows', () => {
    const result = getLevels();
    const lvl = result.levels[0];
    expect(lvl.startRow).toBe(0);
    expect(lvl.numRows).toBe(20);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renameLevel
// ═══════════════════════════════════════════════════════════════════════════

describe('renameLevel', () => {
  beforeEach(() => freshDungeon());

  it('renames a level', () => {
    const result = renameLevel(0, 'Ground Floor');
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.levels[0].name).toBe('Ground Floor');
  });

  it('trims whitespace from name', () => {
    renameLevel(0, '  Basement  ');
    expect(state.dungeon.metadata.levels[0].name).toBe('Basement');
  });

  it('pushes undo', () => {
    renameLevel(0, 'New Name');
    expect(state.undoStack.length).toBe(1);
  });

  it('marks dirty', () => {
    state.dirty = false;
    renameLevel(0, 'New Name');
    expect(state.dirty).toBe(true);
  });

  it('throws for invalid level index (negative)', () => {
    expect(() => renameLevel(-1, 'Bad')).toThrow(/out of range/i);
  });

  it('throws for invalid level index (too large)', () => {
    expect(() => renameLevel(5, 'Bad')).toThrow(/out of range/i);
  });

  it('throws for empty name', () => {
    expect(() => renameLevel(0, '')).toThrow(/non-empty string/i);
  });

  it('throws for non-string name', () => {
    expect(() => renameLevel(0, null)).toThrow(/non-empty string/i);
  });

  it('throws for numeric name', () => {
    expect(() => renameLevel(0, 42)).toThrow(/non-empty string/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resizeLevel
// ═══════════════════════════════════════════════════════════════════════════

describe('resizeLevel', () => {
  beforeEach(() => freshDungeon());

  it('grows a level by adding rows', () => {
    const oldTotalRows = state.dungeon.cells.length;
    const result = resizeLevel(0, 25);
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.levels[0].numRows).toBe(25);
    expect(state.dungeon.cells.length).toBe(oldTotalRows + 5);
  });

  it('shrinks a level by removing rows', () => {
    const oldTotalRows = state.dungeon.cells.length;
    resizeLevel(0, 15);
    expect(state.dungeon.metadata.levels[0].numRows).toBe(15);
    expect(state.dungeon.cells.length).toBe(oldTotalRows - 5);
  });

  it('is a no-op when size is unchanged', () => {
    const result = resizeLevel(0, 20);
    expect(result.success).toBe(true);
    expect(state.undoStack.length).toBe(0); // no undo push for no change
  });

  it('shifts subsequent levels when growing', () => {
    // Add a second level
    addLevel('Level 2', 10);
    const lvl2StartBefore = state.dungeon.metadata.levels[1].startRow;
    // Reset undo from addLevel
    state.undoStack = [];

    resizeLevel(0, 25); // grow by 5
    expect(state.dungeon.metadata.levels[1].startRow).toBe(lvl2StartBefore + 5);
  });

  it('shifts subsequent levels when shrinking', () => {
    addLevel('Level 2', 10);
    const lvl2StartBefore = state.dungeon.metadata.levels[1].startRow;
    state.undoStack = [];

    resizeLevel(0, 15); // shrink by 5
    expect(state.dungeon.metadata.levels[1].startRow).toBe(lvl2StartBefore - 5);
  });

  it('new rows are null-filled', () => {
    resizeLevel(0, 22); // add 2 rows
    // The last 2 rows of level 0 should be null
    const cells = state.dungeon.cells;
    expect(cells[20][0]).toBeNull();
    expect(cells[21][0]).toBeNull();
  });

  it('new rows have correct column count', () => {
    resizeLevel(0, 22);
    expect(state.dungeon.cells[20].length).toBe(30);
    expect(state.dungeon.cells[21].length).toBe(30);
  });

  it('pushes undo when resizing', () => {
    resizeLevel(0, 25);
    expect(state.undoStack.length).toBe(1);
  });

  it('throws for invalid level index', () => {
    expect(() => resizeLevel(99, 10)).toThrow(/out of range/i);
  });

  it('throws for zero rows', () => {
    expect(() => resizeLevel(0, 0)).toThrow(/positive integer/i);
  });

  it('throws for negative rows', () => {
    expect(() => resizeLevel(0, -5)).toThrow(/positive integer/i);
  });

  it('throws for non-integer rows', () => {
    expect(() => resizeLevel(0, 3.5)).toThrow(/positive integer/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// addLevel
// ═══════════════════════════════════════════════════════════════════════════

describe('addLevel', () => {
  beforeEach(() => freshDungeon());

  it('appends a new level', () => {
    const result = addLevel('Level 2', 10);
    expect(result.success).toBe(true);
    expect(result.levelIndex).toBe(1);
    const levels = state.dungeon.metadata.levels;
    expect(levels).toHaveLength(2);
    expect(levels[1].name).toBe('Level 2');
    expect(levels[1].numRows).toBe(10);
  });

  it('adds separator row + level rows to grid', () => {
    const oldRows = state.dungeon.cells.length;
    addLevel('Level 2', 10);
    // Should add 1 separator + 10 level rows = 11 rows
    expect(state.dungeon.cells.length).toBe(oldRows + 11);
  });

  it('startRow accounts for separator', () => {
    const oldRows = state.dungeon.cells.length;
    addLevel('Level 2', 10);
    // startRow should be oldRows + 1 (after separator)
    expect(state.dungeon.metadata.levels[1].startRow).toBe(oldRows + 1);
  });

  it('sets currentLevel to the new level', () => {
    addLevel('Level 2', 10);
    expect(state.currentLevel).toBe(1);
  });

  it('trims whitespace from name', () => {
    addLevel('  Underground  ', 5);
    expect(state.dungeon.metadata.levels[1].name).toBe('Underground');
  });

  it('defaults to 15 rows', () => {
    addLevel('Level 2');
    expect(state.dungeon.metadata.levels[1].numRows).toBe(15);
  });

  it('pushes undo', () => {
    addLevel('Level 2', 10);
    expect(state.undoStack.length).toBe(1);
  });

  it('marks dirty', () => {
    state.dirty = false;
    addLevel('Level 2', 10);
    expect(state.dirty).toBe(true);
  });

  it('throws for empty name', () => {
    expect(() => addLevel('', 10)).toThrow(/non-empty string/i);
  });

  it('throws for non-string name', () => {
    expect(() => addLevel(null, 10)).toThrow(/non-empty string/i);
  });

  it('throws for zero rows', () => {
    expect(() => addLevel('Bad', 0)).toThrow(/positive integer/i);
  });

  it('throws for non-integer rows', () => {
    expect(() => addLevel('Bad', 3.5)).toThrow(/positive integer/i);
  });

  it('can add multiple levels sequentially', () => {
    addLevel('Level 2', 10);
    addLevel('Level 3', 8);
    const levels = state.dungeon.metadata.levels;
    expect(levels).toHaveLength(3);
    expect(levels[2].name).toBe('Level 3');
    expect(state.currentLevel).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// defineLevels
// ═══════════════════════════════════════════════════════════════════════════

describe('defineLevels', () => {
  beforeEach(() => freshDungeon());

  it('replaces existing levels with new definitions', () => {
    const result = defineLevels([
      { name: 'Ground', startRow: 0, numRows: 10 },
      { name: 'Basement', startRow: 10, numRows: 10 },
    ]);
    expect(result.success).toBe(true);
    const levels = state.dungeon.metadata.levels;
    expect(levels).toHaveLength(2);
    expect(levels[0].name).toBe('Ground');
    expect(levels[1].name).toBe('Basement');
  });

  it('trims whitespace from names', () => {
    defineLevels([{ name: '  Floor 1  ', startRow: 0, numRows: 20 }]);
    expect(state.dungeon.metadata.levels[0].name).toBe('Floor 1');
  });

  it('pushes undo', () => {
    defineLevels([{ name: 'Level 1', startRow: 0, numRows: 20 }]);
    expect(state.undoStack.length).toBe(1);
  });

  it('marks dirty', () => {
    state.dirty = false;
    defineLevels([{ name: 'Level 1', startRow: 0, numRows: 20 }]);
    expect(state.dirty).toBe(true);
  });

  it('throws for empty array', () => {
    expect(() => defineLevels([])).toThrow(/non-empty array/i);
  });

  it('throws for non-array', () => {
    expect(() => defineLevels('bad')).toThrow(/non-empty array/i);
  });

  it('throws for level without name', () => {
    expect(() => defineLevels([{ startRow: 0, numRows: 10 }])).toThrow(/name string/i);
  });

  it('throws for negative startRow', () => {
    expect(() => defineLevels([{ name: 'Bad', startRow: -1, numRows: 10 }])).toThrow(/invalid startRow/i);
  });

  it('throws for zero numRows', () => {
    expect(() => defineLevels([{ name: 'Bad', startRow: 0, numRows: 0 }])).toThrow(/invalid numRows/i);
  });

  it('throws when level exceeds grid rows', () => {
    // Grid has 20 rows, try to define a level that goes beyond
    expect(() => defineLevels([
      { name: 'Too Big', startRow: 0, numRows: 99 },
    ])).toThrow(/exceeds grid/i);
  });

  it('accepts levels that exactly fill the grid', () => {
    const result = defineLevels([
      { name: 'Full', startRow: 0, numRows: 20 },
    ]);
    expect(result.success).toBe(true);
  });

  it('validates all levels before applying changes', () => {
    // Second level is invalid — first should also not be applied
    expect(() => defineLevels([
      { name: 'Good', startRow: 0, numRows: 10 },
      { name: 'Bad', startRow: 10, numRows: 99 },
    ])).toThrow(/exceeds grid/i);
    // Original level should still be present
    expect(state.dungeon.metadata.levels[0].name).toBe('Level 1');
  });
});
