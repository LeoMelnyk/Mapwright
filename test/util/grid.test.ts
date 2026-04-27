import { describe, it, expect } from 'vitest';
import {
  cellKey,
  parseCellKey,
  isInBounds,
  snapToSquare,
  normalizeBounds,
  isEdgeOpen,
  roomBoundsFromKeys,
  setEdgeReciprocal,
  deleteEdgeReciprocal,
  getEdge,
  OPPOSITE,
} from '../../src/util/grid.js';

// ── Helper: create a grid of null cells ──────────────────────────────────────

function makeGrid(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(null));
}

function makeCell(props = {}) {
  return { ...props };
}

// ── cellKey / parseCellKey ────────────────────────────────────────────────────

describe('cellKey', () => {
  it('produces "row,col" string', () => {
    expect(cellKey(3, 7)).toBe('3,7');
    expect(cellKey(0, 0)).toBe('0,0');
  });
});

describe('parseCellKey', () => {
  it('parses "row,col" string back to integers', () => {
    expect(parseCellKey('3,7')).toEqual([3, 7]);
    expect(parseCellKey('0,0')).toEqual([0, 0]);
  });
});

// ── isInBounds ───────────────────────────────────────────────────────────────

describe('isInBounds', () => {
  const grid = makeGrid(10, 15);

  it('returns true for valid coordinates', () => {
    expect(isInBounds(grid, 0, 0)).toBe(true);
    expect(isInBounds(grid, 9, 14)).toBe(true);
    expect(isInBounds(grid, 5, 7)).toBe(true);
  });

  it('returns false for negative coordinates', () => {
    expect(isInBounds(grid, -1, 0)).toBe(false);
    expect(isInBounds(grid, 0, -1)).toBe(false);
  });

  it('returns false for out-of-range coordinates', () => {
    expect(isInBounds(grid, 10, 0)).toBe(false);
    expect(isInBounds(grid, 0, 15)).toBe(false);
  });
});

// ── snapToSquare ─────────────────────────────────────────────────────────────

describe('snapToSquare', () => {
  const grid = makeGrid(20, 20);

  it('constrains drag to a square from start point', () => {
    const result = snapToSquare(8, 12, 5, 5, grid);
    // max(|8-5|, |12-5|) = 7, so endpoint = (5+7, 5+7) = (12, 12)
    expect(result.row).toBe(12);
    expect(result.col).toBe(12);
  });

  it('handles negative direction', () => {
    const result = snapToSquare(2, 3, 5, 5, grid);
    // max(|2-5|, |3-5|) = 3, directions are negative
    expect(result.row).toBe(2);
    expect(result.col).toBe(2);
  });

  it('clamps to grid bounds', () => {
    const result = snapToSquare(25, 25, 5, 5, grid);
    expect(result.row).toBeLessThan(20);
    expect(result.col).toBeLessThan(20);
  });
});

// ── normalizeBounds ──────────────────────────────────────────────────────────

describe('normalizeBounds', () => {
  it('normalizes already-ordered bounds', () => {
    expect(normalizeBounds(2, 3, 5, 7)).toEqual({ r1: 2, c1: 3, r2: 5, c2: 7 });
  });

  it('swaps reversed bounds', () => {
    expect(normalizeBounds(5, 7, 2, 3)).toEqual({ r1: 2, c1: 3, r2: 5, c2: 7 });
  });

  it('handles mixed ordering', () => {
    expect(normalizeBounds(5, 3, 2, 7)).toEqual({ r1: 2, c1: 3, r2: 5, c2: 7 });
  });
});

// ── isEdgeOpen ───────────────────────────────────────────────────────────────

describe('isEdgeOpen', () => {
  it('returns true when neither side has an edge', () => {
    expect(isEdgeOpen({}, {}, 'north')).toBe(true);
  });

  it('returns false when cell has a wall', () => {
    expect(isEdgeOpen({ north: 'w' }, {}, 'north')).toBe(false);
  });

  it('returns false when neighbor has reciprocal wall', () => {
    expect(isEdgeOpen({}, { south: 'w' }, 'north')).toBe(false);
  });

  it('returns false for doors', () => {
    expect(isEdgeOpen({ north: 'd' }, {}, 'north')).toBe(false);
  });
});

// ── roomBoundsFromKeys ───────────────────────────────────────────────────────

describe('roomBoundsFromKeys', () => {
  it('computes bounding box from cell keys', () => {
    const keys = new Set(['2,3', '2,4', '3,3', '3,4', '4,3', '4,4']);
    const bounds = roomBoundsFromKeys(keys);
    expect(bounds).toEqual({
      r1: 2,
      c1: 3,
      r2: 4,
      c2: 4,
      centerRow: 3,
      centerCol: 3,
    });
  });

  it('returns null for empty set', () => {
    expect(roomBoundsFromKeys(new Set())).toBeNull();
    expect(roomBoundsFromKeys(null)).toBeNull();
  });

  it('handles single cell', () => {
    const bounds = roomBoundsFromKeys(new Set(['5,5']));
    expect(bounds).toEqual({ r1: 5, c1: 5, r2: 5, c2: 5, centerRow: 5, centerCol: 5 });
  });
});

// ── setEdgeReciprocal / deleteEdgeReciprocal ─────────────────────────────────

describe('setEdgeReciprocal', () => {
  it('sets wall on cell and reciprocal on neighbor', () => {
    const grid = makeGrid(5, 5);
    grid[2][3] = makeCell();
    grid[2][4] = makeCell();
    setEdgeReciprocal(grid, 2, 3, 'east', 'w');
    expect(grid[2][3].east).toBe('w');
    expect(grid[2][4].west).toBe('w');
  });

  it('does not set reciprocal for diagonal directions', () => {
    const grid = makeGrid(5, 5);
    grid[2][3] = makeCell();
    setEdgeReciprocal(grid, 2, 3, 'nw-se', 'w');
    // Diagonal walls live on cell.interiorEdges; getEdge routes through
    // segments to read the diagonal-edge wall back.
    expect(getEdge(grid[2][3], 'nw-se')).toBe('w');
    // No neighbor should be affected
  });

  it('skips reciprocal if neighbor is null', () => {
    const grid = makeGrid(5, 5);
    grid[2][3] = makeCell();
    // grid[2][4] is null
    setEdgeReciprocal(grid, 2, 3, 'east', 'w');
    expect(grid[2][3].east).toBe('w');
    expect(grid[2][4]).toBeNull(); // unchanged
  });
});

describe('deleteEdgeReciprocal', () => {
  it('deletes wall on cell and reciprocal on neighbor', () => {
    const grid = makeGrid(5, 5);
    grid[2][3] = makeCell({ east: 'w' });
    grid[2][4] = makeCell({ west: 'w' });
    deleteEdgeReciprocal(grid, 2, 3, 'east');
    expect(grid[2][3].east).toBeUndefined();
    expect(grid[2][4].west).toBeUndefined();
  });
});

// ── OPPOSITE ─────────────────────────────────────────────────────────────────

describe('OPPOSITE', () => {
  it('maps cardinal directions to their opposites', () => {
    expect(OPPOSITE.north).toBe('south');
    expect(OPPOSITE.south).toBe('north');
    expect(OPPOSITE.east).toBe('west');
    expect(OPPOSITE.west).toBe('east');
  });
});
