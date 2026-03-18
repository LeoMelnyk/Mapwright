import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';

import {
  setStairs,
  addStairs,
  removeStairs,
  linkStairs,
  addBridge,
  removeBridge,
  getBridges,
} from '../../src/editor/js/api/stairs-bridges.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon');
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
  // Ensure cells exist where stairs will be placed
  // The mocked getOccupiedCells returns cells in the rectangle [minR, maxR) x [minC, maxC)
  // For addStairs(2,2, 2,4, 4,4), vertices are [2,2],[2,4],[4,4]
  // minR=2, maxR=4, minC=2, maxC=4 => cells (2,2),(2,3),(3,2),(3,3)
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      state.dungeon.cells[r][c] = {};
    }
  }
});

// ── addStairs ───────────────────────────────────────────────────────────────

describe('addStairs', () => {
  it('creates a stair and returns its ID', () => {
    const result = addStairs(2, 2, 2, 4, 4, 4);
    expect(result.success).toBe(true);
    expect(typeof result.id).toBe('number');
  });

  it('adds stair definition to metadata.stairs', () => {
    addStairs(2, 2, 2, 4, 4, 4);
    expect(state.dungeon.metadata.stairs.length).toBe(1);
    expect(state.dungeon.metadata.stairs[0].points).toEqual([[2, 2], [2, 4], [4, 4]]);
    expect(state.dungeon.metadata.stairs[0].link).toBeNull();
  });

  it('sets stair-id on occupied cells', () => {
    const { id } = addStairs(2, 2, 2, 4, 4, 4);
    // Mocked getOccupiedCells returns rectangle cells: (2,2),(2,3),(3,2),(3,3)
    expect(state.dungeon.cells[2][2].center?.['stair-id']).toBe(id);
    expect(state.dungeon.cells[2][3].center?.['stair-id']).toBe(id);
    expect(state.dungeon.cells[3][2].center?.['stair-id']).toBe(id);
    expect(state.dungeon.cells[3][3].center?.['stair-id']).toBe(id);
  });

  it('assigns sequential IDs', () => {
    const r1 = addStairs(2, 2, 2, 4, 4, 4);
    // Place second stair in different location
    const r2 = addStairs(5, 5, 5, 7, 7, 7);
    expect(r2.id).toBe(r1.id + 1);
  });

  it('throws if stair overlaps existing stair', () => {
    addStairs(2, 2, 2, 4, 4, 4);
    expect(() => addStairs(2, 2, 2, 4, 4, 4)).toThrow('Overlap');
  });

  it('pushes to undo stack', () => {
    const stackBefore = state.undoStack.length;
    addStairs(2, 2, 2, 4, 4, 4);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });
});

// ── removeStairs ────────────────────────────────────────────────────────────

describe('removeStairs', () => {
  it('removes stair metadata and cell references', () => {
    const { id } = addStairs(2, 2, 2, 4, 4, 4);
    const result = removeStairs(2, 2);
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.stairs.length).toBe(0);
    // Cell references should be cleared
    expect(state.dungeon.cells[2][2].center?.['stair-id']).toBeUndefined();
    expect(state.dungeon.cells[2][3].center?.['stair-id']).toBeUndefined();
  });

  it('returns success when cell has no stair', () => {
    const result = removeStairs(5, 5);
    expect(result.success).toBe(true);
  });

  it('unlinks partner when removing a linked stair', () => {
    const { id: id1 } = addStairs(2, 2, 2, 4, 4, 4);
    const { id: id2 } = addStairs(5, 5, 5, 7, 7, 7);
    linkStairs(2, 2, 5, 5);
    // Both should be linked now
    expect(state.dungeon.metadata.stairs.find(s => s.id === id1).link).toBeTruthy();
    expect(state.dungeon.metadata.stairs.find(s => s.id === id2).link).toBeTruthy();
    // Remove the first stair
    removeStairs(2, 2);
    // Partner should be unlinked
    const partner = state.dungeon.metadata.stairs.find(s => s.id === id2);
    expect(partner.link).toBeNull();
  });

  it('handles legacy stairs-up/stairs-down format', () => {
    state.dungeon.cells[8][8] = { center: { 'stairs-up': true, 'stairs-link': 'A' } };
    const result = removeStairs(8, 8);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[8][8].center?.['stairs-up']).toBeUndefined();
    expect(state.dungeon.cells[8][8].center?.['stairs-link']).toBeUndefined();
  });

  it('pushes to undo stack', () => {
    addStairs(2, 2, 2, 4, 4, 4);
    const stackBefore = state.undoStack.length;
    removeStairs(2, 2);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });
});

// ── linkStairs ──────────────────────────────────────────────────────────────

describe('linkStairs', () => {
  it('assigns matching link labels to both stairs', () => {
    addStairs(2, 2, 2, 4, 4, 4);
    addStairs(5, 5, 5, 7, 7, 7);
    const result = linkStairs(2, 2, 5, 5);
    expect(result.success).toBe(true);
    expect(result.label).toBe('A');
    const stairs = state.dungeon.metadata.stairs;
    expect(stairs[0].link).toBe('A');
    expect(stairs[1].link).toBe('A');
  });

  it('assigns next available label (skips used ones)', () => {
    addStairs(2, 2, 2, 4, 4, 4);
    addStairs(5, 5, 5, 7, 7, 7);
    linkStairs(2, 2, 5, 5);

    // Use non-overlapping regions: (7,7)-(7,9)-(9,9) and (0,7)-(0,9)-(2,9)
    addStairs(7, 7, 7, 9, 9, 9);
    addStairs(0, 7, 0, 9, 2, 9);
    const result = linkStairs(7, 7, 0, 7);
    expect(result.label).toBe('B');
  });

  it('throws when first cell has no stair', () => {
    addStairs(5, 5, 5, 7, 7, 7);
    expect(() => linkStairs(0, 0, 5, 5)).toThrow('has no stairs');
  });

  it('throws when second cell has no stair', () => {
    addStairs(2, 2, 2, 4, 4, 4);
    expect(() => linkStairs(2, 2, 0, 0)).toThrow('has no stairs');
  });

  it('throws when linking a stair to itself', () => {
    addStairs(2, 2, 2, 4, 4, 4);
    expect(() => linkStairs(2, 2, 2, 3)).toThrow('Cannot link a stair to itself');
  });

  it('pushes to undo stack', () => {
    addStairs(2, 2, 2, 4, 4, 4);
    addStairs(5, 5, 5, 7, 7, 7);
    const stackBefore = state.undoStack.length;
    linkStairs(2, 2, 5, 5);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });
});

// ── setStairs (legacy) ──────────────────────────────────────────────────────

describe('setStairs', () => {
  it('delegates to addStairs for "up" direction', () => {
    const result = setStairs(2, 2, 'up');
    expect(result.success).toBe(true);
    expect(typeof result.id).toBe('number');
  });

  it('delegates to addStairs for "down" direction', () => {
    const result = setStairs(5, 5, 'down');
    expect(result.success).toBe(true);
  });

  it('throws for invalid direction', () => {
    expect(() => setStairs(2, 2, 'left')).toThrow('Invalid stairs direction');
  });
});

// ── addBridge ───────────────────────────────────────────────────────────────

describe('addBridge', () => {
  it('creates a bridge and returns its ID', () => {
    const result = addBridge('wood', 0, 0, 0, 2, 1, 0);
    expect(result.success).toBe(true);
    expect(typeof result.id).toBe('number');
  });

  it('adds bridge to metadata.bridges', () => {
    addBridge('stone', 0, 0, 0, 2, 1, 0);
    expect(state.dungeon.metadata.bridges.length).toBe(1);
    expect(state.dungeon.metadata.bridges[0].type).toBe('stone');
    expect(state.dungeon.metadata.bridges[0].points).toEqual([[0, 0], [0, 2], [1, 0]]);
  });

  it('sets bridge-id on occupied cells', () => {
    // Mocked getBridgeOccupiedCells returns [{row:0, col:0}]
    const { id } = addBridge('wood', 0, 0, 0, 2, 1, 0);
    expect(state.dungeon.cells[0][0].center?.['bridge-id']).toBe(id);
  });

  it('validates bridge type', () => {
    expect(() => addBridge('invalid', 0, 0, 0, 2, 1, 0)).toThrow('Invalid bridge type');
  });

  it('accepts all valid types', () => {
    for (const type of ['wood', 'stone', 'rope', 'dock']) {
      // Reset state for each
      state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon');
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          state.dungeon.cells[r][c] = {};
        }
      }
      const result = addBridge(type, 0, 0, 0, 2, 1, 0);
      expect(result.success).toBe(true);
    }
  });

  it('assigns sequential IDs', () => {
    const r1 = addBridge('wood', 0, 0, 0, 2, 1, 0);
    // Need to clear the bridge-id from cell (0,0) first
    delete state.dungeon.cells[0][0].center['bridge-id'];
    const r2 = addBridge('stone', 0, 0, 0, 2, 1, 0);
    expect(r2.id).toBe(r1.id + 1);
  });

  it('pushes to undo stack', () => {
    const stackBefore = state.undoStack.length;
    addBridge('wood', 0, 0, 0, 2, 1, 0);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });
});

// ── removeBridge ────────────────────────────────────────────────────────────

describe('removeBridge', () => {
  it('removes bridge metadata and cell references', () => {
    const { id } = addBridge('wood', 0, 0, 0, 2, 1, 0);
    const result = removeBridge(0, 0);
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.bridges.length).toBe(0);
    expect(state.dungeon.cells[0][0].center?.['bridge-id']).toBeUndefined();
  });

  it('throws when cell has no bridge', () => {
    expect(() => removeBridge(5, 5)).toThrow('has no bridge');
  });

  it('throws when bridge ID not in metadata', () => {
    state.dungeon.cells[5][5] = { center: { 'bridge-id': 999 } };
    expect(() => removeBridge(5, 5)).toThrow('not found in metadata');
  });

  it('pushes to undo stack', () => {
    addBridge('wood', 0, 0, 0, 2, 1, 0);
    const stackBefore = state.undoStack.length;
    removeBridge(0, 0);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });

  it('cleans up center object when bridge-id was the only property', () => {
    addBridge('wood', 0, 0, 0, 2, 1, 0);
    removeBridge(0, 0);
    // center should be deleted if empty
    expect(state.dungeon.cells[0][0].center).toBeUndefined();
  });
});

// ── getBridges ──────────────────────────────────────────────────────────────

describe('getBridges', () => {
  it('returns empty array when no bridges exist', () => {
    const result = getBridges();
    expect(result.success).toBe(true);
    expect(result.bridges).toEqual([]);
  });

  it('returns all bridges from metadata', () => {
    addBridge('wood', 0, 0, 0, 2, 1, 0);
    const result = getBridges();
    expect(result.bridges.length).toBe(1);
    expect(result.bridges[0].type).toBe('wood');
  });

  it('includes bridge ID and points', () => {
    const { id } = addBridge('stone', 0, 0, 0, 2, 1, 0);
    const result = getBridges();
    expect(result.bridges[0].id).toBe(id);
    expect(result.bridges[0].points).toEqual([[0, 0], [0, 2], [1, 0]]);
  });
});
