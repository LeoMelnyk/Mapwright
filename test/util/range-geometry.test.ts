import { describe, it, expect } from 'vitest';
import {
  computeLine,
  computeCone,
  computeCircle,
  computeCube,
} from '../../src/util/range-geometry.js';

// Helper: check that a cell list contains a specific {row, col}
function hasCell(cells, row, col) {
  return cells.some(c => c.row === row && c.col === col);
}

// ── computeLine ─────────────────────────────────────────────────────────────

describe('computeLine', () => {
  const gridSize = 5;
  const numRows = 20;
  const numCols = 20;

  it('returns the start cell with distance 0 when start equals end', () => {
    const result = computeLine(5, 5, 5, 5, gridSize, numRows, numCols);
    expect(result.cells).toEqual([{ row: 5, col: 5 }]);
    expect(result.distanceFt).toBe(0);
  });

  it('computes a horizontal line', () => {
    const result = computeLine(5, 2, 5, 8, gridSize, numRows, numCols);
    // Should include start and end cells
    expect(hasCell(result.cells, 5, 2)).toBe(true);
    expect(hasCell(result.cells, 5, 8)).toBe(true);
    // Should include intermediate cells
    expect(hasCell(result.cells, 5, 5)).toBe(true);
    // Distance: 6 cells * 5ft = 30ft
    expect(result.distanceFt).toBe(30);
  });

  it('computes a vertical line', () => {
    const result = computeLine(2, 5, 8, 5, gridSize, numRows, numCols);
    expect(hasCell(result.cells, 2, 5)).toBe(true);
    expect(hasCell(result.cells, 8, 5)).toBe(true);
    expect(hasCell(result.cells, 5, 5)).toBe(true);
    expect(result.distanceFt).toBe(30);
  });

  it('computes a diagonal line', () => {
    const result = computeLine(0, 0, 4, 4, gridSize, numRows, numCols);
    expect(hasCell(result.cells, 0, 0)).toBe(true);
    expect(hasCell(result.cells, 4, 4)).toBe(true);
    // Diagonal distance: sqrt(4^2 + 4^2) * 5 ≈ 28.28, rounded to nearest 5 = 30
    expect(result.distanceFt).toBe(30);
  });

  it('returns cells in order from start to end', () => {
    const result = computeLine(5, 0, 5, 5, gridSize, numRows, numCols);
    expect(result.cells[0]).toEqual({ row: 5, col: 0 });
    expect(result.cells[result.cells.length - 1]).toEqual({ row: 5, col: 5 });
  });

  it('clips cells to grid bounds', () => {
    const result = computeLine(0, 0, 0, 25, gridSize, numRows, numCols);
    for (const cell of result.cells) {
      expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.row).toBeLessThan(numRows);
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(numCols);
    }
  });

  it('works with reversed direction (end before start)', () => {
    const result = computeLine(5, 8, 5, 2, gridSize, numRows, numCols);
    expect(hasCell(result.cells, 5, 2)).toBe(true);
    expect(hasCell(result.cells, 5, 8)).toBe(true);
    expect(result.distanceFt).toBe(30);
  });
});

// ── computeCone ─────────────────────────────────────────────────────────────

describe('computeCone', () => {
  const gridSize = 5;
  const numRows = 30;
  const numCols = 30;

  it('returns just the origin cell when start equals end', () => {
    const result = computeCone(10, 10, 10, 10, gridSize, numRows, numCols);
    expect(result.cells).toEqual([{ row: 10, col: 10 }]);
    expect(result.distanceFt).toBe(0);
  });

  it('includes the origin cell in the cone', () => {
    const result = computeCone(10, 10, 10, 15, gridSize, numRows, numCols);
    expect(hasCell(result.cells, 10, 10)).toBe(true);
  });

  it('produces a cone that fans out from origin toward target', () => {
    // Cone pointing east (right)
    const result = computeCone(15, 5, 15, 10, gridSize, numRows, numCols);
    expect(result.cells.length).toBeGreaterThan(1);
    // The cone should include cells to the east of origin
    const eastCells = result.cells.filter(c => c.col > 5);
    expect(eastCells.length).toBeGreaterThan(0);
  });

  it('does not include cells behind the origin', () => {
    // Cone pointing east — cells far to the west should not be included
    const result = computeCone(15, 10, 15, 15, gridSize, numRows, numCols);
    const farWestCells = result.cells.filter(c => c.col < 8);
    expect(farWestCells.length).toBe(0);
  });

  it('has a 90-degree spread', () => {
    // A cone pointing east from (15,5) to (15,10) — distance of 5 cells
    // At the far end (5 cells away), the cone width should be about 10 cells
    // (tan(45) * 5 * 2 ≈ 10, but adjusted for the straight-edge triangle)
    const result = computeCone(15, 5, 15, 10, gridSize, numRows, numCols);
    const farCells = result.cells.filter(c => c.col === 10);
    // The cone should have spread vertically
    expect(farCells.length).toBeGreaterThan(1);
  });

  it('clips to grid bounds', () => {
    const result = computeCone(0, 0, 0, 10, gridSize, numRows, numCols);
    for (const cell of result.cells) {
      expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.row).toBeLessThan(numRows);
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(numCols);
    }
  });
});

// ── computeCircle ───────────────────────────────────────────────────────────

describe('computeCircle', () => {
  const gridSize = 5;
  const numRows = 30;
  const numCols = 30;

  it('returns just the center cell when start equals end', () => {
    const result = computeCircle(10, 10, 10, 10, gridSize, numRows, numCols);
    expect(result.cells).toEqual([{ row: 10, col: 10 }]);
    expect(result.distanceFt).toBe(0);
  });

  it('includes cells within the radius', () => {
    // Radius = distance from (10,10) to (10,12) = 2 cells = 10ft
    const result = computeCircle(10, 10, 10, 12, gridSize, numRows, numCols);
    expect(hasCell(result.cells, 10, 10)).toBe(true); // center
    expect(hasCell(result.cells, 10, 11)).toBe(true); // 1 cell away
    expect(hasCell(result.cells, 10, 12)).toBe(true); // on radius
    expect(result.distanceFt).toBe(10);
  });

  it('is roughly symmetrical', () => {
    const result = computeCircle(15, 15, 15, 18, gridSize, numRows, numCols);
    // If (15,18) is in the circle, (15,12) should be too (symmetric)
    expect(hasCell(result.cells, 15, 18)).toBe(true);
    expect(hasCell(result.cells, 15, 12)).toBe(true);
    // Top and bottom
    expect(hasCell(result.cells, 12, 15)).toBe(true);
    expect(hasCell(result.cells, 18, 15)).toBe(true);
  });

  it('excludes cells far outside the radius', () => {
    // Radius = 2 cells (10ft). Cells 5+ away should not be included.
    const result = computeCircle(10, 10, 10, 12, gridSize, numRows, numCols);
    expect(hasCell(result.cells, 10, 16)).toBe(false);
    expect(hasCell(result.cells, 16, 10)).toBe(false);
  });

  it('clips to grid bounds', () => {
    const result = computeCircle(1, 1, 1, 5, gridSize, numRows, numCols);
    for (const cell of result.cells) {
      expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.row).toBeLessThan(numRows);
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(numCols);
    }
  });

  it('produces a circular shape (no cells at far corners)', () => {
    // Radius 3 cells. The corner cell at (10+3, 10+3) = sqrt(18) ≈ 4.24 cells away
    // That's > 3.5 (radius + 0.5), so it should NOT be included
    const result = computeCircle(10, 10, 10, 13, gridSize, numRows, numCols);
    // Far diagonal corners should be excluded
    expect(hasCell(result.cells, 14, 14)).toBe(false);
    expect(hasCell(result.cells, 6, 6)).toBe(false);
  });

  it('handles large distances', () => {
    const result = computeCircle(15, 15, 15, 25, gridSize, 50, 50);
    expect(result.distanceFt).toBe(50); // 10 cells * 5ft
    expect(result.cells.length).toBeGreaterThan(100); // large circle
  });
});

// ── computeCube ─────────────────────────────────────────────────────────────

describe('computeCube', () => {
  const gridSize = 5;
  const numRows = 30;
  const numCols = 30;

  it('returns a 1x1 area when start equals end', () => {
    const result = computeCube(10, 10, 10, 10, gridSize, numRows, numCols);
    expect(result.cells).toEqual([{ row: 10, col: 10 }]);
    expect(result.distanceFt).toBe(5); // side=1 cell * 5ft
  });

  it('computes a square extending toward the end cell', () => {
    // From (5,5) to (7,8): max(|2|,|3|)+1 = 4 cells per side
    const result = computeCube(5, 5, 7, 8, gridSize, numRows, numCols);
    expect(result.cells.length).toBe(16); // 4x4
    expect(result.distanceFt).toBe(20);   // 4 * 5ft
  });

  it('extends in the correct direction (southeast)', () => {
    const result = computeCube(5, 5, 7, 7, gridSize, numRows, numCols);
    // Side = max(2,2)+1 = 3, extending south-east from (5,5)
    expect(hasCell(result.cells, 5, 5)).toBe(true);
    expect(hasCell(result.cells, 7, 7)).toBe(true);
    expect(result.cells.length).toBe(9); // 3x3
  });

  it('extends in the correct direction (northwest)', () => {
    const result = computeCube(10, 10, 8, 8, gridSize, numRows, numCols);
    // Side = max(2,2)+1 = 3, extending north-west from (10,10)
    expect(hasCell(result.cells, 10, 10)).toBe(true);
    expect(hasCell(result.cells, 8, 8)).toBe(true);
    expect(result.cells.length).toBe(9); // 3x3
  });

  it('clips to grid bounds when extending beyond edge', () => {
    const result = computeCube(0, 0, 0, 5, gridSize, numRows, numCols);
    for (const cell of result.cells) {
      expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.row).toBeLessThan(numRows);
      expect(cell.col).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(numCols);
    }
  });

  it('handles negative direction (extending northwest from origin)', () => {
    // From (10,10) to (5,5): max(5,5)+1 = 6 cells per side
    const result = computeCube(10, 10, 5, 5, gridSize, numRows, numCols);
    expect(result.distanceFt).toBe(30); // 6 * 5ft
    expect(result.cells.length).toBe(36); // 6x6
    // Should include the start and the cells extending northwest
    expect(hasCell(result.cells, 10, 10)).toBe(true);
    expect(hasCell(result.cells, 5, 5)).toBe(true);
  });

  it('always produces a square (not rectangle)', () => {
    // Asymmetric input: 2 rows, 5 cols difference
    const result = computeCube(10, 10, 12, 15, gridSize, numRows, numCols);
    // Side = max(2,5)+1 = 6, so 6x6
    const rows = new Set(result.cells.map(c => c.row));
    const cols = new Set(result.cells.map(c => c.col));
    expect(rows.size).toBe(6);
    expect(cols.size).toBe(6);
  });
});
