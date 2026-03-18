import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js'; // Initialize getApi()

import {
  placeProp,
  removeProp,
  rotateProp,
  listProps,
  getPropsForRoomType,
  removePropAt,
  removePropsInRect,
} from '../../src/editor/js/api/props.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon');
  state.dungeon.metadata.lights = [];
  state.dungeon.metadata.nextLightId = 1;
  state.undoStack = [];
  state.redoStack = [];
  state.propCatalog = {
    categories: ['furniture', 'decoration'],
    props: {
      'chair': { name: 'Chair', category: 'furniture', footprint: [1, 1], facing: true, placement: 'center', roomTypes: ['any'] },
      'table': { name: 'Table', category: 'furniture', footprint: [2, 2], facing: false, placement: 'center', roomTypes: ['tavern'] },
      'bookshelf': { name: 'Bookshelf', category: 'furniture', footprint: [1, 3], facing: true, placement: 'wall', roomTypes: ['library'] },
      'candle': { name: 'Candle', category: 'decoration', footprint: [1, 1], facing: false, placement: 'center', roomTypes: ['any'], lights: [{ preset: 'torch', x: 0.5, y: 0.5 }] },
      'statue': { name: 'Statue', category: 'decoration', footprint: [1, 1], facing: false, placement: 'center', roomTypes: ['temple', 'any'] },
    },
  };
});

/**
 * Paint a region of cells so they're non-null (required for prop placement).
 */
function paintCells(r1, c1, r2, c2) {
  const cells = state.dungeon.cells;
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      if (cells[r][c] === null) cells[r][c] = {};
    }
  }
}

// ── placeProp ────────────────────────────────────────────────────────────────

describe('placeProp', () => {
  it('places a 1x1 prop on a valid cell', () => {
    paintCells(5, 5, 5, 5);
    const result = placeProp(5, 5, 'chair', 0);
    expect(result.success).toBe(true);
    const cell = state.dungeon.cells[5][5];
    expect(cell.prop).toBeDefined();
    expect(cell.prop.type).toBe('chair');
    expect(cell.prop.facing).toBe(0);
    expect(cell.prop.span).toEqual([1, 1]);
  });

  it('places a 2x2 prop occupying multiple cells', () => {
    paintCells(5, 5, 6, 6);
    const result = placeProp(5, 5, 'table', 0);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].prop.span).toEqual([2, 2]);
  });

  it('throws for unknown prop type', () => {
    paintCells(5, 5, 5, 5);
    expect(() => placeProp(5, 5, 'nonexistent', 0)).toThrow('Unknown prop type');
  });

  it('throws for invalid facing', () => {
    paintCells(5, 5, 5, 5);
    expect(() => placeProp(5, 5, 'chair', 45)).toThrow('Invalid facing');
  });

  it('throws for out-of-bounds placement', () => {
    expect(() => placeProp(99, 99, 'chair', 0)).toThrow('out of bounds');
  });

  it('throws when placing on a void (null) cell', () => {
    // Cell at (5,5) is null by default
    expect(() => placeProp(5, 5, 'chair', 0)).toThrow('void');
  });

  it('throws when cell is already occupied by a prop', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    expect(() => placeProp(5, 5, 'statue', 0)).toThrow('already occupied');
  });

  it('throws when cell is covered by a multi-cell prop', () => {
    paintCells(5, 5, 7, 7);
    placeProp(5, 5, 'table', 0); // covers 5,5 - 6,6
    expect(() => placeProp(6, 6, 'chair', 0)).toThrow('already covered');
  });

  it('rotates footprint for 90-degree facing', () => {
    paintCells(5, 5, 7, 7);
    // bookshelf is 1x3 — at 90 degrees should become 3x1
    const result = placeProp(5, 5, 'bookshelf', 90);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].prop.span).toEqual([3, 1]);
  });

  it('creates linked lights from prop definition', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'candle', 0);
    const lights = state.dungeon.metadata.lights;
    expect(lights.length).toBe(1);
    expect(lights[0].propRef).toEqual({ row: 5, col: 5 });
    expect(lights[0].presetId).toBe('torch');
  });

  it('does not create lights for props without light definitions', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    expect(state.dungeon.metadata.lights.length).toBe(0);
  });

  it('validates all cells in multi-cell footprint are in bounds', () => {
    // Place near the edge where 2x2 would go out of bounds
    const rows = state.dungeon.cells.length;
    const cols = state.dungeon.cells[0].length;
    paintCells(rows - 1, cols - 1, rows - 1, cols - 1);
    expect(() => placeProp(rows - 1, cols - 1, 'table', 0)).toThrow('out of bounds');
  });
});

// ── removeProp ───────────────────────────────────────────────────────────────

describe('removeProp', () => {
  it('removes a prop from a cell', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    expect(state.dungeon.cells[5][5].prop).toBeDefined();
    const result = removeProp(5, 5);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].prop).toBeUndefined();
  });

  it('succeeds silently when no prop at cell', () => {
    paintCells(5, 5, 5, 5);
    const result = removeProp(5, 5);
    expect(result.success).toBe(true);
  });

  it('removes linked lights when removing a prop', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'candle', 0);
    expect(state.dungeon.metadata.lights.length).toBe(1);
    removeProp(5, 5);
    expect(state.dungeon.metadata.lights.length).toBe(0);
  });

  it('only removes lights linked to the specific prop', () => {
    paintCells(5, 5, 5, 8);
    placeProp(5, 5, 'candle', 0);
    placeProp(5, 7, 'candle', 0);
    expect(state.dungeon.metadata.lights.length).toBe(2);
    removeProp(5, 5);
    expect(state.dungeon.metadata.lights.length).toBe(1);
    expect(state.dungeon.metadata.lights[0].propRef).toEqual({ row: 5, col: 7 });
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => removeProp(-1, -1)).toThrow('out of bounds');
  });
});

// ── rotateProp ───────────────────────────────────────────────────────────────

describe('rotateProp', () => {
  it('cycles facing by 90 degrees', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    const result = rotateProp(5, 5);
    expect(result.success).toBe(true);
    expect(result.facing).toBe(90);
    expect(state.dungeon.cells[5][5].prop.facing).toBe(90);
  });

  it('wraps from 270 back to 0', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 270);
    const result = rotateProp(5, 5);
    expect(result.facing).toBe(0);
  });

  it('swaps span dimensions on rotate', () => {
    paintCells(5, 5, 5, 7);
    placeProp(5, 5, 'bookshelf', 0); // 1x3
    expect(state.dungeon.cells[5][5].prop.span).toEqual([1, 3]);
    rotateProp(5, 5);
    expect(state.dungeon.cells[5][5].prop.span).toEqual([3, 1]);
  });

  it('throws when no prop at the cell', () => {
    paintCells(5, 5, 5, 5);
    expect(() => rotateProp(5, 5)).toThrow('No prop at');
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => rotateProp(-1, -1)).toThrow('out of bounds');
  });
});

// ── listProps ────────────────────────────────────────────────────────────────

describe('listProps', () => {
  it('returns categories and prop summaries', () => {
    const result = listProps();
    expect(result.success).toBe(true);
    expect(result.categories).toEqual(['furniture', 'decoration']);
    expect(Object.keys(result.props)).toContain('chair');
    expect(Object.keys(result.props)).toContain('table');
    expect(result.props.chair.name).toBe('Chair');
    expect(result.props.chair.footprint).toEqual([1, 1]);
  });

  it('returns empty when no catalog is loaded', () => {
    state.propCatalog = null;
    const result = listProps();
    expect(result.success).toBe(true);
    expect(result.categories).toEqual([]);
    expect(result.props).toEqual({});
  });

  it('includes placement info in prop entries', () => {
    const result = listProps();
    expect(result.props.bookshelf.placement).toBe('wall');
    expect(result.props.chair.placement).toBe('center');
  });

  it('includes roomTypes in prop entries', () => {
    const result = listProps();
    expect(result.props.table.roomTypes).toEqual(['tavern']);
    expect(result.props.chair.roomTypes).toEqual(['any']);
  });
});

// ── getPropsForRoomType ──────────────────────────────────────────────────────

describe('getPropsForRoomType', () => {
  it('returns props matching a specific room type', () => {
    const result = getPropsForRoomType('tavern');
    expect(result.success).toBe(true);
    const names = result.props.map(p => p.name);
    expect(names).toContain('table'); // roomTypes includes 'tavern'
    expect(names).toContain('chair'); // roomTypes includes 'any'
    expect(names).toContain('statue'); // roomTypes includes 'any'
  });

  it('includes "any" type props in all room types', () => {
    const result = getPropsForRoomType('library');
    const names = result.props.map(p => p.name);
    expect(names).toContain('chair'); // 'any' type
    expect(names).toContain('bookshelf'); // 'library' specific
  });

  it('returns empty for unknown room type (only "any" props)', () => {
    const result = getPropsForRoomType('spaceship');
    const names = result.props.map(p => p.name);
    // Should include props with 'any' in roomTypes
    expect(names).toContain('chair');
    expect(names).toContain('statue');
    // Should not include room-specific props
    expect(names).not.toContain('table'); // tavern only
    expect(names).not.toContain('bookshelf'); // library only
  });

  it('returns failure when catalog is null', () => {
    state.propCatalog = null;
    const result = getPropsForRoomType('tavern');
    expect(result.success).toBe(false);
    expect(result.props).toEqual([]);
  });

  it('includes prop metadata in returned entries', () => {
    const result = getPropsForRoomType('tavern');
    const table = result.props.find(p => p.name === 'table');
    expect(table.displayName).toBe('Table');
    expect(table.category).toBe('furniture');
    expect(table.footprint).toEqual([2, 2]);
  });
});

// ── removePropAt ─────────────────────────────────────────────────────────────

describe('removePropAt', () => {
  it('removes a prop at the exact anchor cell', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    const result = removePropAt(5, 5);
    expect(result.success).toBe(true);
    expect(state.dungeon.cells[5][5].prop).toBeUndefined();
  });

  it('returns failure when no prop at that cell', () => {
    paintCells(5, 5, 5, 5);
    const result = removePropAt(5, 5);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no prop');
  });

  it('does not remove props anchored at different cells', () => {
    paintCells(5, 5, 6, 6);
    placeProp(5, 5, 'table', 0); // 2x2
    // Try removing from (6,6) which is covered but not the anchor
    const result = removePropAt(6, 6);
    expect(result.success).toBe(false); // no prop anchored here
    expect(state.dungeon.cells[5][5].prop).toBeDefined(); // anchor still has prop
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => removePropAt(-1, -1)).toThrow('out of bounds');
  });

  it('works on a null cell without crashing', () => {
    // Cell is null
    const result = removePropAt(5, 5);
    expect(result.success).toBe(false);
  });
});

// ── removePropsInRect ────────────────────────────────────────────────────────

describe('removePropsInRect', () => {
  it('removes all props in a rectangular area', () => {
    paintCells(3, 3, 7, 7);
    placeProp(3, 3, 'chair', 0);
    placeProp(5, 5, 'chair', 0);
    placeProp(7, 7, 'chair', 0);
    const result = removePropsInRect(3, 3, 7, 7);
    expect(result.success).toBe(true);
    expect(result.removed).toBe(3);
  });

  it('handles reversed coordinates (auto-normalizes)', () => {
    paintCells(3, 3, 5, 5);
    placeProp(3, 3, 'chair', 0);
    placeProp(5, 5, 'chair', 0);
    const result = removePropsInRect(5, 5, 3, 3);
    expect(result.success).toBe(true);
    expect(result.removed).toBe(2);
  });

  it('returns removed count of 0 when no props in area', () => {
    paintCells(3, 3, 7, 7);
    const result = removePropsInRect(3, 3, 7, 7);
    expect(result.success).toBe(true);
    expect(result.removed).toBe(0);
  });

  it('only removes props whose anchors are in the rect', () => {
    paintCells(3, 3, 8, 8);
    placeProp(3, 3, 'table', 0); // anchor at (3,3), spans to (4,4)
    placeProp(6, 6, 'chair', 0); // anchor at (6,6)
    // Remove only the area around (6,6)
    const result = removePropsInRect(5, 5, 8, 8);
    expect(result.removed).toBe(1); // only the chair
    expect(state.dungeon.cells[3][3].prop).toBeDefined(); // table still there
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => removePropsInRect(-1, -1, 5, 5)).toThrow('out of bounds');
    expect(() => removePropsInRect(0, 0, 99, 99)).toThrow('out of bounds');
  });
});
