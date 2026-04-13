// Regression tests for the withRollback helper used by multi-step API
// mutations (shiftCells, normalizeMargin). On exception, the dungeon must
// be restored to its pre-mutation state AND the just-pushed undo entry
// must be popped so the user can't accidentally undo to a half-mutated
// state.

import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import { shiftCells } from '../../src/editor/js/api/convenience.js';

function freshState() {
  state.dungeon = createEmptyDungeon('Test', 10, 10, 5, 'stone-dungeon', 1);
  state.currentLevel = 0;
  state.undoStack = [];
  state.redoStack = [];
  state.listeners = [];
  state.dirty = false;
  state.unsavedChanges = false;
}

describe('withRollback (via shiftCells)', () => {
  beforeEach(() => freshState());

  it('successfully shifts cells and pushes one undo entry', () => {
    state.dungeon.cells[0][0] = {};
    const beforeDepth = state.undoStack.length;
    const result = shiftCells(2, 0);
    expect(result.success).toBe(true);
    expect(state.undoStack.length).toBe(beforeDepth + 1);
    // The cell that was at (0,0) should now be at (2,0)
    expect(state.dungeon.cells[2]?.[0]).not.toBeNull();
    expect(state.dungeon.cells[0]?.[0]).toBeNull();
  });

  it('rejects shifts that would exceed the 200x200 max grid', () => {
    state.dungeon = createEmptyDungeon('Test', 199, 199, 5, 'stone-dungeon', 1);
    const beforeDepth = state.undoStack.length;
    const beforeRows = state.dungeon.cells.length;
    expect(() => shiftCells(50, 0)).toThrow(/exceed maximum grid size/);
    // No rollback needed (the throw happens before pushUndo), but verify the
    // grid is unchanged.
    expect(state.dungeon.cells.length).toBe(beforeRows);
    expect(state.undoStack.length).toBe(beforeDepth);
  });
});
