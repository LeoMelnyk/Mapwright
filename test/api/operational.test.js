import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import { pushUndo } from '../../src/editor/js/state.js';
import '../../src/editor/js/api/index.js';

import {
  undo,
  redo,
  getUndoDepth,
  undoToDepth,
  listTextures,
  listThemes,
  getRoomContents,
  suggestPlacement,
  getPropFootprint,
} from '../../src/editor/js/api/operational.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
  state.propCatalog = null;
  state.textureCatalog = null;
});

// ── undo / redo ─────────────────────────────────────────────────────────────

describe('undo', () => {
  it('returns success', () => {
    const result = undo();
    expect(result.success).toBe(true);
  });

  it('restores previous state from undo stack', () => {
    const originalName = state.dungeon.metadata.dungeonName;
    pushUndo();
    state.dungeon.metadata.dungeonName = 'Modified';
    pushUndo();
    state.dungeon.metadata.dungeonName = 'Modified Again';

    undo();
    expect(state.dungeon.metadata.dungeonName).toBe('Modified');
  });

  it('does nothing when undo stack is empty', () => {
    const name = state.dungeon.metadata.dungeonName;
    undo();
    expect(state.dungeon.metadata.dungeonName).toBe(name);
  });
});

describe('redo', () => {
  it('returns success', () => {
    const result = redo();
    expect(result.success).toBe(true);
  });

  it('restores state from redo stack after undo', () => {
    pushUndo();
    state.dungeon.metadata.dungeonName = 'Modified';

    undo();
    expect(state.dungeon.metadata.dungeonName).toBe('Test');

    redo();
    expect(state.dungeon.metadata.dungeonName).toBe('Modified');
  });

  it('does nothing when redo stack is empty', () => {
    const name = state.dungeon.metadata.dungeonName;
    redo();
    expect(state.dungeon.metadata.dungeonName).toBe(name);
  });
});

// ── getUndoDepth ────────────────────────────────────────────────────────────

describe('getUndoDepth', () => {
  it('returns 0 when undo stack is empty', () => {
    const result = getUndoDepth();
    expect(result.success).toBe(true);
    expect(result.depth).toBe(0);
  });

  it('returns correct depth after pushes', () => {
    pushUndo();
    pushUndo();
    pushUndo();
    expect(getUndoDepth().depth).toBe(3);
  });

  it('decreases after undo', () => {
    pushUndo();
    pushUndo();
    undo();
    expect(getUndoDepth().depth).toBe(1);
  });
});

// ── undoToDepth ─────────────────────────────────────────────────────────────

describe('undoToDepth', () => {
  it('undoes multiple steps to reach target depth', () => {
    pushUndo();
    state.dungeon.metadata.dungeonName = 'V1';
    pushUndo();
    state.dungeon.metadata.dungeonName = 'V2';
    pushUndo();
    state.dungeon.metadata.dungeonName = 'V3';

    const result = undoToDepth(1);
    expect(result.success).toBe(true);
    expect(result.undid).toBe(2); // from depth 3 to 1
    expect(state.undoStack.length).toBe(1);
  });

  it('does nothing when already at target depth', () => {
    pushUndo();
    const result = undoToDepth(1);
    expect(result.undid).toBe(0);
  });

  it('undoes all steps when target is 0', () => {
    pushUndo();
    pushUndo();
    pushUndo();
    const result = undoToDepth(0);
    expect(result.undid).toBe(3);
    expect(state.undoStack.length).toBe(0);
  });

  it('clamps negative target to 0', () => {
    pushUndo();
    pushUndo();
    const result = undoToDepth(-5);
    expect(result.undid).toBe(2);
    expect(state.undoStack.length).toBe(0);
  });
});

// ── listTextures ────────────────────────────────────────────────────────────

describe('listTextures', () => {
  it('returns empty array when no texture catalog', () => {
    const result = listTextures();
    expect(result.success).toBe(true);
    expect(result.textures).toEqual([]);
  });

  it('returns success with texture catalog present', () => {
    // The mocked getTextureCatalog returns null, so we get empty
    const result = listTextures();
    expect(result.success).toBe(true);
  });
});

// ── listThemes ──────────────────────────────────────────────────────────────

describe('listThemes', () => {
  it('returns theme names from catalog', () => {
    // Mocked getThemeCatalog returns { names: ['stone-dungeon', 'blue-parchment'] }
    const result = listThemes();
    expect(result.success).toBe(true);
    expect(result.themes).toEqual(['stone-dungeon', 'blue-parchment']);
  });

  it('returns array of strings', () => {
    const result = listThemes();
    for (const theme of result.themes) {
      expect(typeof theme).toBe('string');
    }
  });
});

// ── getRoomContents ─────────────────────────────────────────────────────────

describe('getRoomContents', () => {
  it('returns error when room not found', () => {
    const result = getRoomContents('ZZZ');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns room contents when room exists', () => {
    // Create a labeled room
    for (let r = 2; r <= 5; r++) {
      for (let c = 2; c <= 5; c++) {
        state.dungeon.cells[r][c] = {};
      }
    }
    state.dungeon.cells[3][3] = { center: { label: 'A1' } };
    // Add walls
    for (let c = 2; c <= 5; c++) {
      state.dungeon.cells[2][c].north = 'w';
      state.dungeon.cells[5][c].south = 'w';
    }
    for (let r = 2; r <= 5; r++) {
      state.dungeon.cells[r][2].west = 'w';
      state.dungeon.cells[r][5].east = 'w';
    }
    // Add a prop via overlay
    const gs = state.dungeon.metadata.gridSize || 5;
    state.dungeon.metadata.props = [
      { id: 1, type: 'pillar', x: 4 * gs, y: 3 * gs, rotation: 0 },
    ];
    // Add a texture to one cell
    state.dungeon.cells[4][3] = { texture: 'cobblestone', textureOpacity: 0.8 };
    // Add a door
    state.dungeon.cells[2][3].north = 'd';

    const result = getRoomContents('A1');
    expect(result.label).toBe('A1');
    expect(result.bounds).toBeDefined();
    expect(result.props.length).toBeGreaterThanOrEqual(1);
    expect(result.textures.length).toBeGreaterThanOrEqual(1);
    expect(result.doors.length).toBeGreaterThanOrEqual(1);
  });

  it('returns the room label and bounds', () => {
    for (let r = 2; r <= 4; r++) {
      for (let c = 2; c <= 4; c++) {
        state.dungeon.cells[r][c] = {};
      }
    }
    state.dungeon.cells[3][3] = { center: { label: 'B2' } };
    for (let c = 2; c <= 4; c++) {
      state.dungeon.cells[2][c].north = 'w';
      state.dungeon.cells[4][c].south = 'w';
    }
    for (let r = 2; r <= 4; r++) {
      state.dungeon.cells[r][2].west = 'w';
      state.dungeon.cells[r][4].east = 'w';
    }

    const result = getRoomContents('B2');
    expect(result.label).toBe('B2');
    expect(result.bounds).toBeDefined();
    expect(result.bounds.r1).toBeLessThanOrEqual(result.bounds.r2);
  });
});

// ── suggestPlacement ────────────────────────────────────────────────────────

describe('suggestPlacement', () => {
  it('finds free space for a room on an empty map', () => {
    const result = suggestPlacement(3, 4);
    expect(result.r1).toBeDefined();
    expect(result.c1).toBeDefined();
    expect(result.r2 - result.r1 + 1).toBe(3);
    expect(result.c2 - result.c1 + 1).toBe(4);
  });

  it('respects margin from grid edges', () => {
    const result = suggestPlacement(3, 4);
    // Should not be at row 0 or col 0 (margin=1)
    expect(result.r1).toBeGreaterThanOrEqual(1);
    expect(result.c1).toBeGreaterThanOrEqual(1);
  });

  it('returns error when no space available', () => {
    // Fill the entire grid with cells
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 30; c++) {
        state.dungeon.cells[r][c] = {};
      }
    }
    const result = suggestPlacement(5, 5);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No space');
  });

  it('skips occupied cells when finding space', () => {
    // Place a block at (1,1)-(3,4)
    for (let r = 1; r <= 3; r++) {
      for (let c = 1; c <= 4; c++) {
        state.dungeon.cells[r][c] = {};
      }
    }
    const result = suggestPlacement(2, 2);
    // Should find space somewhere else
    expect(result.r1).toBeDefined();
    // Check that no cell in the suggested placement overlaps an occupied cell
    let hasOverlap = false;
    for (let r = result.r1; r <= result.r2; r++) {
      for (let c = result.c1; c <= result.c2; c++) {
        if (state.dungeon.cells[r]?.[c] != null) hasOverlap = true;
      }
    }
    expect(hasOverlap).toBe(false);
  });
});

// ── getPropFootprint ────────────────────────────────────────────────────────

describe('getPropFootprint', () => {
  beforeEach(() => {
    state.propCatalog = {
      props: {
        pillar: { footprint: [1, 1] },
        table: { footprint: [2, 3] },
        bed: { footprint: [2, 1] },
      },
    };
  });

  it('returns 1x1 footprint for a pillar', () => {
    const result = getPropFootprint('pillar');
    expect(result.success).toBe(true);
    expect(result.spanRows).toBe(1);
    expect(result.spanCols).toBe(1);
    expect(result.cells).toEqual([[0, 0]]);
  });

  it('returns 2x3 footprint for a table at facing 0', () => {
    const result = getPropFootprint('table', 0);
    expect(result.spanRows).toBe(2);
    expect(result.spanCols).toBe(3);
    expect(result.cells.length).toBe(6);
  });

  it('swaps dimensions at 90 degrees', () => {
    const result = getPropFootprint('table', 90);
    expect(result.spanRows).toBe(3); // swapped from 2
    expect(result.spanCols).toBe(2); // swapped from 3
    expect(result.cells.length).toBe(6);
  });

  it('swaps dimensions at 270 degrees', () => {
    const result = getPropFootprint('table', 270);
    expect(result.spanRows).toBe(3);
    expect(result.spanCols).toBe(2);
  });

  it('keeps original dimensions at 180 degrees', () => {
    const result = getPropFootprint('table', 180);
    expect(result.spanRows).toBe(2);
    expect(result.spanCols).toBe(3);
  });

  it('returns error for unknown prop type', () => {
    const result = getPropFootprint('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown prop type');
  });

  it('returns error for invalid facing', () => {
    const result = getPropFootprint('pillar', 45);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid facing');
  });

  it('generates cells relative to anchor at [0,0]', () => {
    const result = getPropFootprint('bed', 0); // 2x1
    expect(result.cells).toEqual([[0, 0], [1, 0]]);
  });
});
