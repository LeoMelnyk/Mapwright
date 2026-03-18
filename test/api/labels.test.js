import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';

import {
  setLabel,
  removeLabel,
} from '../../src/editor/js/api/labels.js';

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
// setLabel
// ═══════════════════════════════════════════════════════════════════════════

describe('setLabel', () => {
  beforeEach(() => freshDungeon());

  it('creates a label on a void cell (auto-creates cell)', () => {
    expect(state.dungeon.cells[5][5]).toBeNull();
    const result = setLabel(5, 5, 'A');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5]).not.toBeNull();
    expect(state.dungeon.cells[5][5].center.label).toBe('A');
  });

  it('creates the center object if missing', () => {
    state.dungeon.cells[3][3] = {};
    setLabel(3, 3, '1');
    expect(state.dungeon.cells[3][3].center).toBeDefined();
    expect(state.dungeon.cells[3][3].center.label).toBe('1');
  });

  it('overwrites an existing label', () => {
    state.dungeon.cells[3][3] = { center: { label: 'old' } };
    setLabel(3, 3, 'new');
    expect(state.dungeon.cells[3][3].center.label).toBe('new');
  });

  it('preserves other center properties', () => {
    state.dungeon.cells[3][3] = { center: { label: 'X', someOther: true } };
    setLabel(3, 3, 'Y');
    expect(state.dungeon.cells[3][3].center.label).toBe('Y');
    expect(state.dungeon.cells[3][3].center.someOther).toBe(true);
  });

  it('converts numeric input to string', () => {
    setLabel(5, 5, 42);
    expect(state.dungeon.cells[5][5].center.label).toBe('42');
  });

  it('pushes undo', () => {
    setLabel(5, 5, 'A');
    expect(state.undoStack.length).toBe(1);
  });

  it('marks dirty', () => {
    state.dirty = false;
    setLabel(5, 5, 'A');
    expect(state.dirty).toBe(true);
  });

  it('throws for out-of-bounds', () => {
    expect(() => setLabel(99, 99, 'A')).toThrow(/out of bounds/i);
  });

  it('accepts empty string as a label', () => {
    setLabel(5, 5, '');
    expect(state.dungeon.cells[5][5].center.label).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// removeLabel
// ═══════════════════════════════════════════════════════════════════════════

describe('removeLabel', () => {
  beforeEach(() => freshDungeon());

  it('removes a label from a cell', () => {
    state.dungeon.cells[5][5] = { center: { label: 'A' } };
    const result = removeLabel(5, 5);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].center).toBeUndefined();
  });

  it('cleans up empty center object after removal', () => {
    state.dungeon.cells[5][5] = { center: { label: 'A' } };
    removeLabel(5, 5);
    // center had only label — should be deleted entirely
    expect(state.dungeon.cells[5][5].center).toBeUndefined();
  });

  it('preserves center if it has other properties', () => {
    state.dungeon.cells[5][5] = { center: { label: 'A', icon: 'star' } };
    removeLabel(5, 5);
    expect(state.dungeon.cells[5][5].center.label).toBeUndefined();
    expect(state.dungeon.cells[5][5].center.icon).toBe('star');
  });

  it('is a no-op on null cell', () => {
    const result = removeLabel(5, 5);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5]).toBeNull();
  });

  it('is a no-op on cell without center', () => {
    state.dungeon.cells[5][5] = { north: 'w' };
    const result = removeLabel(5, 5);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].center).toBeUndefined();
  });

  it('is a no-op on cell with center but no label', () => {
    state.dungeon.cells[5][5] = { center: { icon: 'star' } };
    const result = removeLabel(5, 5);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].center.icon).toBe('star');
  });

  it('pushes undo when removing an existing label', () => {
    state.dungeon.cells[5][5] = { center: { label: 'A' } };
    removeLabel(5, 5);
    expect(state.undoStack.length).toBe(1);
  });

  it('does NOT push undo when no label exists', () => {
    state.dungeon.cells[5][5] = {};
    removeLabel(5, 5);
    expect(state.undoStack.length).toBe(0);
  });

  it('marks dirty after removal', () => {
    state.dungeon.cells[5][5] = { center: { label: 'A' } };
    state.dirty = false;
    removeLabel(5, 5);
    expect(state.dirty).toBe(true);
  });

  it('throws for out-of-bounds', () => {
    expect(() => removeLabel(-1, 0)).toThrow(/out of bounds/i);
  });
});
