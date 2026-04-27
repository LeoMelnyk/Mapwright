// Tests for src/util/traverse.ts — Phase 1 of the segments refactor.
// Block flags, callbacks, bounds, both start forms.
//
// The worked-example fixtures from the plan (two-diagonals adjacency,
// trim-arc trimCrossing) live in `traverse-worked-examples.test.ts` so
// they can be referenced individually in code review.

import { describe, it, expect, vi } from 'vitest';
import type { Cell, CellGrid } from '../../src/types.js';
import { traverse } from '../../src/util/traverse.js';
import { setDiagonalEdge } from '../../src/util/grid.js';

function diagCell(diag: 'nw-se' | 'ne-sw'): Cell {
  const cell: Cell = {};
  setDiagonalEdge(cell, diag, 'w');
  return cell;
}

// Tiny grid helper: build a (rows × cols) grid of plain unsplit cells; pass a
// `mut(row, col, cell)` callback to set fields on specific cells.
function grid(rows: number, cols: number, mut?: (r: number, c: number, cell: Cell) => void): CellGrid {
  const g: CellGrid = [];
  for (let r = 0; r < rows; r++) {
    const row: (Cell | null)[] = [];
    for (let c = 0; c < cols; c++) {
      const cell: Cell = {};
      mut?.(r, c, cell);
      row.push(cell);
    }
    g.push(row);
  }
  return g;
}

describe('traverse — basic connectivity', () => {
  it('walks every cell in an open rectangular room', () => {
    const cells = grid(2, 3);
    const { visited, bounds } = traverse(cells, { row: 0, col: 0 });
    expect(visited.size).toBe(6);
    expect(visited.has('0,0,0')).toBe(true);
    expect(visited.has('1,2,0')).toBe(true);
    expect(bounds).toEqual({ r1: 0, c1: 0, r2: 1, c2: 2 });
  });

  it('returns an empty set when the start cell is null/void', () => {
    const cells: CellGrid = [
      [null, null],
      [null, null],
    ];
    const { visited, bounds } = traverse(cells, { row: 0, col: 0 });
    expect(visited.size).toBe(0);
    expect(bounds).toBeNull();
  });

  it('does not cross cardinal walls', () => {
    // 1×3 row with a wall between (0,0) and (0,1).
    const cells = grid(1, 3, (_r, c, cell) => {
      if (c === 0) cell.east = 'w';
      if (c === 1) cell.west = 'w';
    });
    const { visited } = traverse(cells, { row: 0, col: 0 });
    expect(visited.size).toBe(1);
    expect(visited.has('0,0,0')).toBe(true);
  });
});

describe('traverse — block flags', () => {
  it('blocks doors by default', () => {
    const cells = grid(1, 2, (_r, c, cell) => {
      if (c === 0) cell.east = 'd';
      if (c === 1) cell.west = 'd';
    });
    expect(traverse(cells, { row: 0, col: 0 }).visited.size).toBe(1);
  });

  it('passes through doors when doorsBlock is false', () => {
    const cells = grid(1, 2, (_r, c, cell) => {
      if (c === 0) cell.east = 'd';
      if (c === 1) cell.west = 'd';
    });
    expect(traverse(cells, { row: 0, col: 0 }, { doorsBlock: false }).visited.size).toBe(2);
  });

  it('blocks invisible walls iw by default and unblocks when invisibleWallsBlock is false', () => {
    const cells = grid(1, 2, (_r, c, cell) => {
      if (c === 0) cell.east = 'iw';
      if (c === 1) cell.west = 'iw';
    });
    expect(traverse(cells, { row: 0, col: 0 }).visited.size).toBe(1);
    expect(traverse(cells, { row: 0, col: 0 }, { invisibleWallsBlock: false }).visited.size).toBe(2);
  });

  it('blocks windows by default and unblocks when windowsBlock is false', () => {
    const cells = grid(1, 2, (_r, c, cell) => {
      if (c === 0) cell.east = 'win';
      if (c === 1) cell.west = 'win';
    });
    expect(traverse(cells, { row: 0, col: 0 }).visited.size).toBe(1);
    expect(traverse(cells, { row: 0, col: 0 }, { windowsBlock: false }).visited.size).toBe(2);
  });

  it('does not block on fluid fill by default; blocks when fillBlocks is true', () => {
    const cells = grid(1, 3, (_r, c, cell) => {
      if (c === 1) cell.fill = 'water';
    });
    expect(traverse(cells, { row: 0, col: 0 }).visited.size).toBe(3);
    // fillBlocks: true → can't enter (1,) but can stay on (0,)
    expect(traverse(cells, { row: 0, col: 0 }, { fillBlocks: true }).visited.size).toBe(1);
  });

  it('blocks voided segments by default', () => {
    const cells = grid(1, 2, (_r, c, cell) => {
      if (c === 1)
        cell.segments = [
          {
            id: 's0',
            polygon: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            voided: true,
          },
        ];
    });
    expect(traverse(cells, { row: 0, col: 0 }).visited.size).toBe(1);
    expect(traverse(cells, { row: 0, col: 0 }, { voidedSegmentsBlock: false }).visited.size).toBe(2);
  });

  it('refuses to seed on a voided segment when voids block', () => {
    const cells: CellGrid = [
      [
        {
          segments: [
            {
              id: 's0',
              polygon: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
              voided: true,
            },
          ],
        },
      ],
    ];
    expect(traverse(cells, { row: 0, col: 0 }).visited.size).toBe(0);
  });
});

describe('traverse — bounds', () => {
  it('respects rowMin/rowMax/colMin/colMax', () => {
    const cells = grid(3, 3);
    const { visited } = traverse(
      cells,
      { row: 1, col: 1 },
      {
        rowMin: 1,
        rowMax: 1,
        colMin: 0,
        colMax: 2,
      },
    );
    expect(visited.size).toBe(3);
    expect(visited.has('1,0,0')).toBe(true);
    expect(visited.has('1,2,0')).toBe(true);
    expect(visited.has('0,1,0')).toBe(false);
  });
});

describe('traverse — start forms', () => {
  it('accepts {row, col, segmentIndex}', () => {
    const cells: CellGrid = [[diagCell('nw-se')]];
    const { visited } = traverse(cells, { row: 0, col: 0, segmentIndex: 1 });
    expect(visited.has('0,0,1')).toBe(true);
    // The wall blocks crossing to segment 0 within the same cell.
    expect(visited.has('0,0,0')).toBe(false);
  });

  it('accepts {row, col, lx, ly} and resolves the segment by hit-test', () => {
    const cells: CellGrid = [[diagCell('nw-se')]];
    // (0.2, 0.8) is in the SW triangle (segment 0).
    const a = traverse(cells, { row: 0, col: 0, lx: 0.2, ly: 0.8 });
    expect(a.visited.has('0,0,0')).toBe(true);
    expect(a.visited.has('0,0,1')).toBe(false);
    // (0.8, 0.2) is in the NE triangle (segment 1).
    const b = traverse(cells, { row: 0, col: 0, lx: 0.8, ly: 0.2 });
    expect(b.visited.has('0,0,1')).toBe(true);
    expect(b.visited.has('0,0,0')).toBe(false);
  });

  it('returns empty when {lx, ly} falls in a gap', () => {
    // Construct a malformed cell with a single segment that doesn't tile.
    const cells: CellGrid = [
      [
        {
          segments: [
            {
              id: 's0',
              polygon: [
                [0, 0],
                [0.5, 0],
                [0.5, 0.5],
                [0, 0.5],
              ],
            },
          ],
        },
      ],
    ];
    const { visited } = traverse(cells, { row: 0, col: 0, lx: 0.9, ly: 0.9 });
    expect(visited.size).toBe(0);
  });
});

describe('traverse — callbacks', () => {
  it('invokes visit() for each visited segment in BFS order', () => {
    const cells = grid(1, 3);
    const order: string[] = [];
    traverse(
      cells,
      { row: 0, col: 0 },
      {
        visit: (ctx) => {
          order.push(`${ctx.row},${ctx.col}`);
        },
      },
    );
    expect(order).toEqual(['0,0', '0,1', '0,2']);
  });

  it('passes enteredVia: null for the seed segment', () => {
    const cells = grid(1, 2);
    const seen: Array<{ row: number; col: number; enteredVia: unknown }> = [];
    traverse(
      cells,
      { row: 0, col: 0 },
      {
        visit: (ctx) => {
          seen.push({ row: ctx.row, col: ctx.col, enteredVia: ctx.enteredVia });
        },
      },
    );
    expect(seen[0]!.enteredVia).toBeNull();
    expect(seen[1]!.enteredVia).toMatchObject({ fromRow: 0, fromCol: 0, fromSegmentIndex: 0 });
  });

  it('stops traversal early when visit() returns false', () => {
    const cells = grid(1, 5);
    const visited: number[] = [];
    traverse(
      cells,
      { row: 0, col: 0 },
      {
        visit: (ctx) => {
          visited.push(ctx.col);
          if (ctx.col === 2) return false;
        },
      },
    );
    expect(visited).toEqual([0, 1, 2]);
  });

  it('invokes acceptNeighbor() to gate enqueueing', () => {
    const cells = grid(1, 3);
    const accept = vi.fn().mockReturnValue(true);
    traverse(cells, { row: 0, col: 0 }, { acceptNeighbor: accept });
    // Two neighbors get the callback (1 from seed, 1 from second cell).
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it('skips a candidate when acceptNeighbor returns false', () => {
    const cells = grid(1, 3);
    const { visited } = traverse(
      cells,
      { row: 0, col: 0 },
      {
        acceptNeighbor: (ctx) => ctx.col < 2,
      },
    );
    expect(visited.size).toBe(2);
    expect(visited.has('0,2,0')).toBe(false);
  });
});

describe('traverse — within-cell adjacency', () => {
  it('connects two segments of an unsplit cell trivially (single segment)', () => {
    const cells: CellGrid = [[{}]];
    const { visited } = traverse(cells, { row: 0, col: 0 });
    expect(visited.size).toBe(1);
  });

  it('blocks intra-cell movement across an interior wall', () => {
    const cells: CellGrid = [[diagCell('nw-se')]]; // diagonal wall
    const { visited } = traverse(cells, { row: 0, col: 0, segmentIndex: 0 });
    // From SW segment we cannot cross the diagonal wall to NE.
    expect(visited.size).toBe(1);
  });

  it('passes through an open interior edge', () => {
    // Construct an explicit cell with an open interior edge between two segments.
    const cells: CellGrid = [
      [
        {
          segments: [
            {
              id: 's0',
              polygon: [
                [0, 0],
                [1, 1],
                [0, 1],
              ],
            },
            {
              id: 's1',
              polygon: [
                [0, 0],
                [1, 0],
                [1, 1],
              ],
            },
          ],
          interiorEdges: [
            {
              vertices: [
                [0, 0],
                [1, 1],
              ],
              wall: null,
              between: [0, 1],
            },
          ],
        },
      ],
    ];
    const { visited } = traverse(cells, { row: 0, col: 0, segmentIndex: 0 });
    expect(visited.size).toBe(2);
    expect(visited.has('0,0,1')).toBe(true);
  });
});
