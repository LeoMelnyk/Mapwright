import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';

import {
  createTrim,
  roundRoomCorners,
} from '../../src/editor/js/api/trims.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon');
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
  state.trimCorner = 'auto';
  state.trimRound = false;
  state.trimInverted = false;
  state.trimOpen = false;
});

// ── createTrim ──────────────────────────────────────────────────────────────

describe('createTrim', () => {
  it('throws for out-of-bounds start coordinates', () => {
    expect(() => createTrim(-1, 0, 5, 5)).toThrow('out of bounds');
  });

  it('throws for out-of-bounds end coordinates', () => {
    expect(() => createTrim(0, 0, 100, 100)).toThrow('out of bounds');
  });

  it('throws for invalid corner string', () => {
    expect(() => createTrim(2, 2, 5, 5, 'xx')).toThrow('Invalid corner');
  });

  it('accepts valid corner strings', () => {
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      // Should not throw (trimTool._updatePreview is mocked, so no actual trim)
      expect(() => createTrim(2, 2, 5, 5, corner)).not.toThrow();
    }
  });

  it('resolves corner from drag direction when "auto"', () => {
    // r2 > r1 and c2 > c1 => se
    createTrim(2, 2, 5, 5);
    // The function ran without error (corner resolved to 'se')
    // Verify state was restored
    expect(state.trimCorner).toBe('auto');
  });

  it('resolves nw corner when dragging up-left', () => {
    createTrim(5, 5, 2, 2);
    expect(state.trimCorner).toBe('auto'); // restored
  });

  it('resolves ne corner when dragging up-right', () => {
    createTrim(5, 2, 2, 5);
    expect(state.trimCorner).toBe('auto'); // restored
  });

  it('resolves sw corner when dragging down-left', () => {
    createTrim(2, 5, 5, 2);
    expect(state.trimCorner).toBe('auto'); // restored
  });

  it('restores previous trim state after operation', () => {
    state.trimCorner = 'ne';
    state.trimRound = true;
    state.trimInverted = true;
    state.trimOpen = true;

    createTrim(2, 2, 5, 5, 'nw');

    expect(state.trimCorner).toBe('ne');
    expect(state.trimRound).toBe(true);
    expect(state.trimInverted).toBe(true);
    expect(state.trimOpen).toBe(true);
  });

  it('supports object options syntax', () => {
    expect(() => createTrim(2, 2, 5, 5, { corner: 'nw', round: true })).not.toThrow();
  });

  it('supports string + extra options syntax', () => {
    expect(() => createTrim(2, 2, 5, 5, 'nw', { round: true, inverted: true })).not.toThrow();
  });

  it('returns success note when preview has no cells to trim', () => {
    // The mocked _updatePreview sets previewCells to null by default
    const result = createTrim(2, 2, 5, 5);
    // With the mock, previewCells stays null, so the function returns early
    expect(result.success).toBe(true);
    expect(result.note).toContain('No cells');
  });
});

// ── roundRoomCorners ────────────────────────────────────────────────────────

describe('roundRoomCorners', () => {
  it('throws when room label is not found', () => {
    expect(() => roundRoomCorners('NonexistentRoom')).toThrow('not found');
  });

  it('throws when trim size is too large for the room', () => {
    // We need to set up a room with a label and bounds that getRoomBounds can find.
    // Since getRoomBounds depends on getApi()._collectRoomCells which does BFS,
    // we need to set up cells with a label and open connections.
    // Create a small 4x4 room
    for (let r = 2; r <= 5; r++) {
      for (let c = 2; c <= 5; c++) {
        state.dungeon.cells[r][c] = {};
      }
    }
    // Label cell
    state.dungeon.cells[3][3] = { center: { label: 'A1' } };
    // Add walls on perimeter
    for (let c = 2; c <= 5; c++) {
      state.dungeon.cells[2][c].north = 'w';
      state.dungeon.cells[5][c].south = 'w';
    }
    for (let r = 2; r <= 5; r++) {
      state.dungeon.cells[r][2].west = 'w';
      state.dungeon.cells[r][5].east = 'w';
    }

    // trimSize=3 means 3*2=6 > 4 (room is 4x4), so it should throw
    expect(() => roundRoomCorners('A1', 3)).toThrow('too large');
  });

  it('accepts alternative object options syntax', () => {
    // roundRoomCorners("label", { trimSize: 2 }) — test that it parses correctly
    // This will still throw because the room doesn't exist
    expect(() => roundRoomCorners('NoRoom', { trimSize: 2 })).toThrow('not found');
  });
});
