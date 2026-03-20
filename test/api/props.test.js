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
  setPropZIndex,
  bringForward,
  sendBackward,
  suggestPropPosition,
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

/** Find overlay prop at grid position. */
function findOverlay(row, col) {
  const meta = state.dungeon.metadata;
  if (!meta?.props) return null;
  const gs = meta.gridSize || 5;
  const x = col * gs, y = row * gs;
  return meta.props.find(p => Math.abs(p.x - x) < 0.01 && Math.abs(p.y - y) < 0.01) ?? null;
}

// ── placeProp ────────────────────────────────────────────────────────────────

describe('placeProp', () => {
  it('places a 1x1 prop on a valid cell', () => {
    paintCells(5, 5, 5, 5);
    const result = placeProp(5, 5, 'chair', 0);
    expect(result.success).toBe(true);
    const overlay = findOverlay(5, 5);
    expect(overlay).not.toBeNull();
    expect(overlay.type).toBe('chair');
    expect(overlay.rotation).toBe(0);
  });

  it('places a 2x2 prop occupying multiple cells', () => {
    paintCells(5, 5, 6, 6);
    const result = placeProp(5, 5, 'table', 0);
    expect(result.success).toBe(true);
    const overlay = findOverlay(5, 5);
    expect(overlay).not.toBeNull();
    expect(overlay.type).toBe('table');
  });

  it('throws for unknown prop type', () => {
    paintCells(5, 5, 5, 5);
    expect(() => placeProp(5, 5, 'nonexistent', 0)).toThrow('Unknown prop type');
  });

  it('accepts arbitrary rotation angles', () => {
    paintCells(5, 5, 5, 5);
    const result = placeProp(5, 5, 'chair', 45);
    expect(result.success).toBe(true);
    const overlay = findOverlay(5, 5);
    expect(overlay.rotation).toBe(45);
  });

  it('accepts scale and zIndex options', () => {
    paintCells(5, 5, 5, 5);
    const result = placeProp(5, 5, 'chair', 0, { scale: 2.0, zIndex: 'tall' });
    expect(result.success).toBe(true);
    const overlay = findOverlay(5, 5);
    expect(overlay.scale).toBe(2.0);
    expect(overlay.zIndex).toBe(20); // 'tall' preset
  });

  it('clamps scale to valid range', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0, { scale: 10.0 });
    expect(findOverlay(5, 5).scale).toBe(4.0);
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
    expect(() => placeProp(5, 5, 'statue', 0)).toThrow('already covered');
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
    const overlay = findOverlay(5, 5);
    expect(overlay).not.toBeNull();
    expect(overlay.rotation).toBe(90);
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
  it('removes a prop from the overlay', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    expect(findOverlay(5, 5)).not.toBeNull();
    const result = removeProp(5, 5);
    expect(result.success).toBe(true);
    expect(findOverlay(5, 5)).toBeNull();
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
    expect(findOverlay(5, 5).rotation).toBe(90);
  });

  it('wraps from 270 back to 0', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 270);
    const result = rotateProp(5, 5);
    expect(result.facing).toBe(0);
  });

  it('updates overlay rotation on rotate', () => {
    paintCells(5, 5, 5, 7);
    placeProp(5, 5, 'bookshelf', 0); // 1x3
    expect(findOverlay(5, 5).rotation).toBe(0);
    rotateProp(5, 5);
    expect(findOverlay(5, 5).rotation).toBe(90);
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

  it('removes prop by any covered cell (not just anchor)', () => {
    paintCells(5, 5, 6, 6);
    placeProp(5, 5, 'table', 0); // 2x2
    // Removing from (6,6) which is covered by the 2x2 table — should succeed
    const result = removePropAt(6, 6);
    expect(result.success).toBe(true);
    expect(findOverlay(5, 5)).toBeNull(); // prop is gone
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
    expect(findOverlay(3, 3)).not.toBeNull(); // table still there
  });

  it('throws for out-of-bounds coordinates', () => {
    expect(() => removePropsInRect(-1, -1, 5, 5)).toThrow('out of bounds');
    expect(() => removePropsInRect(0, 0, 99, 99)).toThrow('out of bounds');
  });
});

// ── Dual-Write Consistency ──────────────────────────────────────────────────

describe('overlay dual-write', () => {
  it('placeProp creates matching overlay entry', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 90);

    const overlay = state.dungeon.metadata.props;
    expect(overlay).toBeDefined();
    expect(overlay.length).toBe(1);
    expect(overlay[0].type).toBe('chair');
    expect(overlay[0].x).toBe(25); // col 5 * gridSize 5
    expect(overlay[0].y).toBe(25); // row 5 * gridSize 5
    expect(overlay[0].rotation).toBe(90);
    expect(overlay[0].scale).toBe(1.0);
    expect(overlay[0].id).toMatch(/^prop_/);
  });

  it('removeProp removes the overlay entry', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    expect(state.dungeon.metadata.props.length).toBe(1);

    removeProp(5, 5);
    expect(state.dungeon.metadata.props.length).toBe(0);
  });

  it('rotateProp updates overlay rotation', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    rotateProp(5, 5);

    const overlay = findOverlay(5, 5);
    expect(overlay.rotation).toBe(90);
  });

  it('removePropsInRect removes overlay entries', () => {
    paintCells(3, 3, 7, 7);
    placeProp(3, 3, 'chair', 0);
    placeProp(6, 6, 'chair', 0);
    expect(state.dungeon.metadata.props.length).toBe(2);

    removePropsInRect(5, 5, 8, 8);
    expect(state.dungeon.metadata.props.length).toBe(1);
    expect(state.dungeon.metadata.props[0].x).toBe(15); // col 3 * 5
  });

  it('multiple placements get unique IDs', () => {
    paintCells(3, 3, 7, 7);
    placeProp(3, 3, 'chair', 0);
    placeProp(4, 4, 'chair', 0);
    placeProp(5, 5, 'chair', 0);

    const ids = state.dungeon.metadata.props.map(p => p.id);
    expect(new Set(ids).size).toBe(3);
  });
});

// ── Z-Index API ─────────────────────────────────────────────────────────────

describe('setPropZIndex', () => {
  it('sets z-index by preset name', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    const propId = state.dungeon.metadata.props[0].id;

    const result = setPropZIndex(propId, 'floor');
    expect(result.success).toBe(true);
    expect(result.zIndex).toBe(0);
    expect(state.dungeon.metadata.props[0].zIndex).toBe(0);
  });

  it('sets z-index by raw number', () => {
    paintCells(5, 5, 5, 5);
    placeProp(5, 5, 'chair', 0);
    const propId = state.dungeon.metadata.props[0].id;

    setPropZIndex(propId, 25);
    expect(state.dungeon.metadata.props[0].zIndex).toBe(25);
  });

  it('throws for unknown prop ID', () => {
    expect(() => setPropZIndex('nonexistent', 'floor')).toThrow();
  });
});

describe('bringForward / sendBackward', () => {
  it('moves prop forward in z-order', () => {
    paintCells(3, 3, 7, 7);
    placeProp(3, 3, 'chair', 0);
    placeProp(4, 4, 'chair', 0);
    const props = state.dungeon.metadata.props;
    // Both start at z=10 (furniture default)
    props[0].zIndex = 5;
    props[1].zIndex = 15;

    bringForward(props[0].id);
    expect(props[0].zIndex).toBe(15);
  });

  it('moves prop backward in z-order', () => {
    paintCells(3, 3, 7, 7);
    placeProp(3, 3, 'chair', 0);
    placeProp(4, 4, 'chair', 0);
    const props = state.dungeon.metadata.props;
    props[0].zIndex = 5;
    props[1].zIndex = 15;

    sendBackward(props[1].id);
    expect(props[1].zIndex).toBe(5);
  });
});

// ── suggestPropPosition ─────────────────────────────────────────────────────

describe('suggestPropPosition', () => {
  beforeEach(() => {
    // Create a labeled room for testing
    paintCells(2, 2, 8, 10);
    const cells = state.dungeon.cells;
    // Set walls and label
    cells[5][6] = { ...(cells[5][6] || {}), center: { label: 'A1' } };
  });

  it('suggests center position for center-placement props', () => {
    const result = suggestPropPosition('A1', 'chair');
    expect(result.success).toBe(true);
    expect(result.row).toBeDefined();
    expect(result.col).toBeDefined();
    expect(result.x).toBe(result.col * 5);
    expect(result.y).toBe(result.row * 5);
  });

  it('suggests wall position for wall-placement props', () => {
    const result = suggestPropPosition('A1', 'bookshelf', { preferWall: 'north' });
    expect(result.success).toBe(true);
    expect(result.rotation).toBe(0); // north wall → 0° rotation
  });

  it('throws for unknown prop type', () => {
    expect(() => suggestPropPosition('A1', 'nonexistent')).toThrow('Unknown prop type');
  });

  it('throws for unknown room', () => {
    expect(() => suggestPropPosition('BOGUS', 'chair')).toThrow('not found');
  });
});
