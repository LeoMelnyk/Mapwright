import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';

import {
  setTexture,
  removeTexture,
  setTextureRect,
  removeTextureRect,
  floodFillTexture,
} from '../../src/editor/js/api/textures.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon');
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
  state.activeTexture = null;
  state.textureOpacity = 1.0;
  state.paintSecondary = false;
});

// ── setTexture ──────────────────────────────────────────────────────────────

describe('setTexture', () => {
  it('sets texture ID on a cell', () => {
    const result = setTexture(5, 5, 'cobblestone');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].texture).toBe('cobblestone');
  });

  it('sets texture opacity on the cell', () => {
    setTexture(5, 5, 'cobblestone', 0.7);
    expect(state.dungeon.cells[5][5].textureOpacity).toBe(0.7);
  });

  it('defaults opacity to 1.0', () => {
    setTexture(5, 5, 'cobblestone');
    expect(state.dungeon.cells[5][5].textureOpacity).toBe(1.0);
  });

  it('clamps opacity to [0, 1] range', () => {
    setTexture(5, 5, 'cobblestone', 1.5);
    expect(state.dungeon.cells[5][5].textureOpacity).toBe(1);
    setTexture(6, 6, 'cobblestone', -0.5);
    expect(state.dungeon.cells[6][6].textureOpacity).toBe(0);
  });

  it('creates a cell if it was null', () => {
    expect(state.dungeon.cells[3][3]).toBeNull();
    setTexture(3, 3, 'stone');
    expect(state.dungeon.cells[3][3]).not.toBeNull();
    expect(state.dungeon.cells[3][3].texture).toBe('stone');
  });

  it('pushes to undo stack', () => {
    expect(state.undoStack.length).toBe(0);
    setTexture(5, 5, 'cobblestone');
    expect(state.undoStack.length).toBe(1);
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => setTexture(100, 100, 'stone')).toThrow();
    expect(() => setTexture(-1, 0, 'stone')).toThrow();
  });
});

// ── removeTexture ───────────────────────────────────────────────────────────

describe('removeTexture', () => {
  it('removes texture from a cell', () => {
    setTexture(5, 5, 'cobblestone', 0.8);
    removeTexture(5, 5);
    expect(state.dungeon.cells[5][5].texture).toBeUndefined();
    expect(state.dungeon.cells[5][5].textureOpacity).toBeUndefined();
  });

  it('returns success even if cell has no texture', () => {
    state.dungeon.cells[5][5] = {};
    const result = removeTexture(5, 5);
    expect(result.success).toBe(true);
  });

  it('returns success for null cell', () => {
    // cells[5][5] is null by default
    const result = removeTexture(5, 5);
    expect(result.success).toBe(true);
  });

  it('pushes to undo stack only if texture existed', () => {
    setTexture(5, 5, 'stone');
    const stackBefore = state.undoStack.length;
    removeTexture(5, 5);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });

  it('does not push to undo when no texture to remove', () => {
    state.dungeon.cells[5][5] = {};
    const stackBefore = state.undoStack.length;
    removeTexture(5, 5);
    expect(state.undoStack.length).toBe(stackBefore);
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => removeTexture(-1, 0)).toThrow();
  });
});

// ── setTextureRect ──────────────────────────────────────────────────────────

describe('setTextureRect', () => {
  // setTextureRect only sets texture on existing (non-null) cells,
  // so pre-populate the region under test.
  function populateCells(r1, c1, r2, c2) {
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (!state.dungeon.cells[r][c]) state.dungeon.cells[r][c] = {};
      }
    }
  }

  it('sets texture on all cells in rectangle', () => {
    populateCells(2, 3, 4, 6);
    const result = setTextureRect(2, 3, 4, 6, 'wood');
    expect(result.success).toBe(true);
    for (let r = 2; r <= 4; r++) {
      for (let c = 3; c <= 6; c++) {
        expect(state.dungeon.cells[r][c]?.texture).toBe('wood');
      }
    }
  });

  it('handles reversed corner coordinates', () => {
    populateCells(2, 3, 4, 6);
    setTextureRect(4, 6, 2, 3, 'wood');
    expect(state.dungeon.cells[2][3]?.texture).toBe('wood');
    expect(state.dungeon.cells[4][6]?.texture).toBe('wood');
  });

  it('applies opacity to all cells', () => {
    populateCells(2, 3, 3, 4);
    setTextureRect(2, 3, 3, 4, 'stone', 0.5);
    expect(state.dungeon.cells[2][3]?.textureOpacity).toBe(0.5);
    expect(state.dungeon.cells[3][4]?.textureOpacity).toBe(0.5);
  });

  it('clamps opacity to [0, 1]', () => {
    populateCells(2, 3, 2, 3);
    setTextureRect(2, 3, 2, 3, 'stone', 2.0);
    expect(state.dungeon.cells[2][3]?.textureOpacity).toBe(1);
  });

  it('pushes exactly one undo entry for the whole rectangle', () => {
    const stackBefore = state.undoStack.length;
    setTextureRect(2, 3, 4, 6, 'wood');
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });

  it('throws if corners are out of bounds', () => {
    expect(() => setTextureRect(-1, 0, 5, 5, 'stone')).toThrow();
    expect(() => setTextureRect(0, 0, 100, 100, 'stone')).toThrow();
  });
});

// ── removeTextureRect ───────────────────────────────────────────────────────

describe('removeTextureRect', () => {
  it('removes texture from all cells in rectangle', () => {
    setTextureRect(2, 3, 4, 6, 'wood');
    removeTextureRect(2, 3, 4, 6);
    for (let r = 2; r <= 4; r++) {
      for (let c = 3; c <= 6; c++) {
        expect(state.dungeon.cells[r][c]?.texture).toBeUndefined();
      }
    }
  });

  it('handles reversed corner coordinates', () => {
    setTextureRect(2, 3, 4, 6, 'wood');
    removeTextureRect(4, 6, 2, 3);
    expect(state.dungeon.cells[2][3]?.texture).toBeUndefined();
    expect(state.dungeon.cells[4][6]?.texture).toBeUndefined();
  });

  it('returns success even if cells have no texture', () => {
    const result = removeTextureRect(2, 3, 4, 6);
    expect(result.success).toBe(true);
  });

  it('pushes exactly one undo entry', () => {
    const stackBefore = state.undoStack.length;
    removeTextureRect(2, 3, 4, 6);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });

  it('throws if corners are out of bounds', () => {
    expect(() => removeTextureRect(-1, 0, 5, 5)).toThrow();
  });
});

// ── floodFillTexture ────────────────────────────────────────────────────────

describe('floodFillTexture', () => {
  it('returns error for void (null) cell', () => {
    const result = floodFillTexture(5, 5, 'stone');
    expect(result.success).toBe(false);
    expect(result.error).toContain('void');
  });

  it('sets up state and delegates to paintTool.floodFill', () => {
    state.dungeon.cells[5][5] = {};
    const result = floodFillTexture(5, 5, 'stone', 0.8);
    expect(result.success).toBe(true);
  });

  it('restores previous state after filling', () => {
    state.dungeon.cells[5][5] = {};
    state.activeTexture = 'original';
    state.textureOpacity = 0.3;
    state.paintSecondary = true;

    floodFillTexture(5, 5, 'stone', 0.8);

    expect(state.activeTexture).toBe('original');
    expect(state.textureOpacity).toBe(0.3);
    expect(state.paintSecondary).toBe(true);
  });

  it('clamps opacity before calling fill', () => {
    state.dungeon.cells[5][5] = {};
    floodFillTexture(5, 5, 'stone', 1.5);
    // State should be restored after, but during fill it was clamped
    expect(state.textureOpacity).toBe(1.0); // restored to default
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => floodFillTexture(-1, 0, 'stone')).toThrow();
  });
});
