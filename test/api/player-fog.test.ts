import { describe, it, expect } from 'vitest';
import { buildPlayerCells, filterPropsForPlayer, filterBridgesForPlayer, filterStairsForPlayer } from '../../src/player/fog.js';
import { cellKey } from '../../src/util/grid.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a minimal dungeon with the given cell grid. */
function makeDungeon(cells) {
  return { cells, metadata: { gridSize: 5 } };
}

/** Create a simple 3x3 grid of empty cells. */
function make3x3() {
  const cells = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) row.push({});
    cells.push(row);
  }
  return cells;
}

/** Reveal specific [r,c] pairs. */
function revealSet(...pairs) {
  return new Set(pairs.map(([r, c]) => cellKey(r, c)));
}

// ── buildPlayerCells ─────────────────────────────────────────────────────────

describe('buildPlayerCells', () => {
  it('returns null for unrevealed cells', () => {
    const cells = make3x3();
    const revealed = revealSet([0, 0], [1, 1]);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    expect(result[0][0]).not.toBeNull();
    expect(result[0][1]).toBeNull();
    expect(result[1][1]).not.toBeNull();
    expect(result[2][2]).toBeNull();
  });

  it('converts secret doors to walls when not opened', () => {
    const cells = make3x3();
    cells[1][1] = { north: 's', east: 's' };
    const revealed = revealSet([1, 1]);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    expect(result[1][1].north).toBe('w');
    expect(result[1][1].east).toBe('w');
  });

  it('converts opened secret doors to normal doors', () => {
    const cells = make3x3();
    cells[1][1] = { north: 's', east: 's' };
    const revealed = revealSet([1, 1]);
    const openedDoors = [{ row: 1, col: 1, dir: 'north' }];
    const result = buildPlayerCells(makeDungeon(cells), revealed, openedDoors);

    expect(result[1][1].north).toBe('d');
    expect(result[1][1].east).toBe('w'); // not opened
  });

  it('strips invisible walls and doors', () => {
    const cells = make3x3();
    cells[1][1] = { north: 'iw', south: 'id', east: 'w' };
    const revealed = revealSet([1, 1]);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    expect(result[1][1].north).toBeUndefined();
    expect(result[1][1].south).toBeUndefined();
    expect(result[1][1].east).toBe('w');
  });

  it('strips room labels', () => {
    const cells = make3x3();
    cells[0][0] = { center: { label: 'Throne Room' } };
    const revealed = revealSet([0, 0]);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    expect(result[0][0].center).toBeUndefined();
  });
});

// ── filterPropsForPlayer ─────────────────────────────────────────────────────

describe('filterPropsForPlayer', () => {
  const gridSize = 5;
  const propCatalog = {
    props: {
      'table': { footprint: [1, 2] },
      'bed': { footprint: [2, 1] },
      'chair': { footprint: [1, 1] },
    },
  };

  it('returns empty array for null/empty input', () => {
    expect(filterPropsForPlayer(null, new Set(), gridSize, propCatalog)).toEqual([]);
    expect(filterPropsForPlayer([], new Set(), gridSize, propCatalog)).toEqual([]);
  });

  it('hides props on unrevealed cells', () => {
    const props = [
      { id: 1, type: 'chair', x: 10, y: 10 }, // cell (2,2) — unrevealed
    ];
    const revealed = revealSet([0, 0]);
    const result = filterPropsForPlayer(props, revealed, gridSize, propCatalog);
    expect(result).toHaveLength(0);
  });

  it('shows props on revealed cells', () => {
    const props = [
      { id: 1, type: 'chair', x: 10, y: 10 }, // cell (2,2)
    ];
    const revealed = revealSet([2, 2]);
    const result = filterPropsForPlayer(props, revealed, gridSize, propCatalog);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('shows multi-cell prop when any occupied cell is revealed', () => {
    // table is 1x2 at position (5,5) → cells (1,1) and (1,2)
    const props = [
      { id: 1, type: 'table', x: 5, y: 5 },
    ];
    // Only reveal (1,2) — second cell of the table
    const revealed = revealSet([1, 2]);
    const result = filterPropsForPlayer(props, revealed, gridSize, propCatalog);
    expect(result).toHaveLength(1);
  });

  it('hides multi-cell prop when no occupied cell is revealed', () => {
    const props = [
      { id: 1, type: 'table', x: 5, y: 5 }, // cells (1,1) and (1,2)
    ];
    const revealed = revealSet([0, 0], [2, 2]);
    const result = filterPropsForPlayer(props, revealed, gridSize, propCatalog);
    expect(result).toHaveLength(0);
  });

  it('handles rotated props (90° swaps footprint)', () => {
    // bed is 2x1, rotated 90° becomes 1x2 → cells (1,1) and (1,2)
    const props = [
      { id: 1, type: 'bed', x: 5, y: 5, rotation: 90 },
    ];
    const revealed = revealSet([1, 2]); // second column of rotated bed
    const result = filterPropsForPlayer(props, revealed, gridSize, propCatalog);
    expect(result).toHaveLength(1);
  });

  it('handles 270° rotation', () => {
    // bed is 2x1, rotated 270° becomes 1x2
    const props = [
      { id: 1, type: 'bed', x: 5, y: 5, rotation: 270 },
    ];
    const revealed = revealSet([1, 2]);
    const result = filterPropsForPlayer(props, revealed, gridSize, propCatalog);
    expect(result).toHaveLength(1);
  });

  it('excludes props with unknown types', () => {
    const props = [
      { id: 1, type: 'nonexistent', x: 0, y: 0 },
    ];
    const revealed = revealSet([0, 0]);
    const result = filterPropsForPlayer(props, revealed, gridSize, propCatalog);
    expect(result).toHaveLength(0);
  });

  it('excludes props when propCatalog is null', () => {
    const props = [
      { id: 1, type: 'chair', x: 0, y: 0 },
    ];
    const revealed = revealSet([0, 0]);
    const result = filterPropsForPlayer(props, revealed, gridSize, null);
    expect(result).toHaveLength(0);
  });

  it('filters a mix of revealed and unrevealed props', () => {
    const props = [
      { id: 1, type: 'chair', x: 0, y: 0 },   // cell (0,0) — revealed
      { id: 2, type: 'chair', x: 10, y: 10 },  // cell (2,2) — unrevealed
      { id: 3, type: 'table', x: 5, y: 0 },    // cells (0,1)+(0,2) — (0,1) revealed
    ];
    const revealed = revealSet([0, 0], [0, 1]);
    const result = filterPropsForPlayer(props, revealed, gridSize, propCatalog);
    expect(result).toHaveLength(2);
    expect(result.map(p => p.id)).toEqual([1, 3]);
  });
});

// ── filterBridgesForPlayer ───────────────────────────────────────────────────

describe('filterBridgesForPlayer', () => {
  it('returns empty for null/empty', () => {
    expect(filterBridgesForPlayer(null, new Set())).toEqual([]);
    expect(filterBridgesForPlayer([], new Set())).toEqual([]);
  });

  it('keeps bridges with revealed control points', () => {
    const bridges = [{ id: 1, points: [[1, 1], [1, 3], [3, 3]] }];
    const revealed = revealSet([1, 1]);
    expect(filterBridgesForPlayer(bridges, revealed)).toHaveLength(1);
  });

  it('hides bridges with no revealed control points', () => {
    const bridges = [{ id: 1, points: [[1, 1], [1, 3], [3, 3]] }];
    const revealed = revealSet([0, 0]);
    expect(filterBridgesForPlayer(bridges, revealed)).toHaveLength(0);
  });
});
