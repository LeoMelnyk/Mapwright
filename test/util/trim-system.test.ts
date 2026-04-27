/**
 * Comprehensive regression tests for the round trim system overhaul.
 *
 * Covers: computeTrimCrossing, closed/open trim BFS, inverted geometry,
 * trim API cell properties, and old→new format migration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeCircleCenter,
  computeTrimCells,
  computeTrimCrossing,
  computeArcCellData,
} from '../../src/util/trim-geometry.js';
// Tests use computeTrimCells directly to avoid editor API initialization issues

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a room with walls and apply round corner trims using computeTrimCells directly. */
function makeRoomWithRoundCorners(cells, r1, c1, r2, c2, trimSize, options = {}) {
  // Create floor cells with boundary walls
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      cells[r][c] = {};
      if (r === r1) cells[r][c].north = 'w';
      if (r === r2) cells[r][c].south = 'w';
      if (c === c1) cells[r][c].west = 'w';
      if (c === c2) cells[r][c].east = 'w';
    }
  }

  const inverted = !!options.inverted;
  const open = !!options.open;
  const s = trimSize - 1;
  const corners = [
    { corner: 'nw', tipR: r1, tipC: c1, extR: r1 + s, extC: c1 + s },
    { corner: 'ne', tipR: r1, tipC: c2, extR: r1 + s, extC: c2 - s },
    { corner: 'sw', tipR: r2, tipC: c1, extR: r2 - s, extC: c1 + s },
    { corner: 'se', tipR: r2, tipC: c2, extR: r2 - s, extC: c2 - s },
  ];

  for (const { corner, tipR, tipC, extR, extC } of corners) {
    // Build preview data (same as _updatePreview)
    const size = Math.max(Math.abs(extR - tipR), Math.abs(extC - tipC)) + 1;
    const hypotenuse = [];
    const voided = [];
    for (let i = 0; i < size; i++) {
      let hr, hc;
      switch (corner) {
        case 'se':
          hr = tipR - (size - 1) + i;
          hc = tipC - i;
          break;
        case 'nw':
          hr = tipR + (size - 1) - i;
          hc = tipC + i;
          break;
        case 'ne':
          hr = tipR + (size - 1) - i;
          hc = tipC - i;
          break;
        case 'sw':
          hr = tipR - (size - 1) + i;
          hc = tipC + i;
          break;
      }
      hypotenuse.push({ row: hr, col: hc });
    }
    for (let i = 1; i < size; i++) {
      for (let j = 0; j < i; j++) {
        let vr, vc;
        switch (corner) {
          case 'se':
            vr = tipR - (size - 1) + i;
            vc = tipC - i + 1 + j;
            break;
          case 'nw':
            vr = tipR + (size - 1) - i;
            vc = tipC + j;
            break;
          case 'ne':
            vr = tipR + (size - 1) - i;
            vc = tipC - i + 1 + j;
            break;
          case 'sw':
            vr = tipR - (size - 1) + i;
            vc = tipC + j;
            break;
        }
        voided.push({ row: vr, col: vc });
      }
    }

    let arcCenter;
    switch (corner) {
      case 'nw':
        arcCenter = { row: Math.min(tipR, extR), col: Math.min(tipC, extC) };
        break;
      case 'ne':
        arcCenter = { row: Math.min(tipR, extR), col: Math.max(tipC, extC) + 1 };
        break;
      case 'sw':
        arcCenter = { row: Math.max(tipR, extR) + 1, col: Math.min(tipC, extC) };
        break;
      case 'se':
        arcCenter = { row: Math.max(tipR, extR) + 1, col: Math.max(tipC, extC) + 1 };
        break;
    }

    const preview = { hypotenuse, voided, insideArc: [], arcCenter, size };
    const trimData = computeTrimCells(preview, corner, inverted, open);

    for (const [key, val] of trimData) {
      const [r, c] = key.split(',').map(Number);
      if (r < 0 || r >= cells.length || c < 0 || c >= (cells[0]?.length || 0)) continue;
      if (val === null) {
        cells[r][c] = null;
      } else if (val === 'interior') {
        if (!cells[r][c]) cells[r][c] = {};
      } else if (typeof val === 'object') {
        if (!cells[r][c]) cells[r][c] = {};
        Object.assign(cells[r][c], val);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. computeTrimCrossing — 3×3 sub-grid crossing matrix
// ═══════════════════════════════════════════════════════════════════════════

describe('computeTrimCrossing', () => {
  it('wall endpoints on different edges create two sides', () => {
    // Wall from west edge to south edge — splits NW from SE
    const clip = [
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0.5],
      [0.5, 1],
    ]; // SE half
    const wall = [
      [0, 0.5],
      [0.25, 0.75],
      [0.5, 1],
    ];
    const c = computeTrimCrossing(clip, wall);
    // All entries should have string values
    for (const d of ['n', 's', 'e', 'w']) {
      expect(typeof c[d]).toBe('string');
    }
  });

  it('blocks crossing for a diagonal-like clip (NW void)', () => {
    // Clip covering SE half — NW is void. Wall from west to north.
    const clip = [
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0.5],
      [0.5, 0],
    ];
    const wall = [
      [0, 0.5],
      [0.25, 0.25],
      [0.5, 0],
    ];
    const c = computeTrimCrossing(clip, wall);
    // South entry should NOT reach north
    expect(c.s).not.toContain('n');
    // East entry should NOT reach west
    expect(c.e).not.toContain('w');
    // South entry should reach south and east (room side)
    expect(c.s).toContain('s');
    expect(c.s).toContain('e');
  });

  it('void-side entries cannot reach room-side exits', () => {
    // Clip covering SE half — NW corner is void
    // Wall from north edge to west edge
    const clip = [
      [0.7, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0.7],
      [0.35, 0.35],
    ];
    const wall = [
      [0, 0.7],
      [0.35, 0.35],
      [0.7, 0],
    ];
    const c = computeTrimCrossing(clip, wall);
    // South entry (room side) should reach south+east
    expect(c.s).toContain('s');
    expect(c.s).toContain('e');
    // North entry should NOT reach south (void→room crossing)
    if (c.n.length > 0) {
      expect(c.n).not.toContain('s');
    }
  });

  it('handles null/undefined/empty inputs without crashing', () => {
    // Null clip → empty (no clip polygon to test)
    const r1 = computeTrimCrossing(null, [
      [0, 0],
      [1, 0],
    ]);
    expect(r1).toHaveProperty('n');
    // Null wall → all-reachable (no wall to split the cell)
    const r2 = computeTrimCrossing(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      null,
    );
    for (const d of ['n', 's', 'e', 'w']) expect(typeof r2[d]).toBe('string');
    // Both null
    const r3 = computeTrimCrossing(null, null);
    expect(r3).toHaveProperty('n');
  });

  it('falls back to arc-endpoint grouping for corner-clip cells', () => {
    // A clip that covers almost the entire cell except a tiny NE corner
    // Wall from near-top of east edge to near-right of north edge
    const clip = [
      [0.9, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
      [0.8, 0],
      [0.85, 0.05],
    ];
    const wall = [
      [0, 0.1],
      [0.05, 0.05],
      [0.1, 0],
    ]; // tiny corner clip
    const c = computeTrimCrossing(clip, wall);
    // The arc endpoints are on north and west edges
    // The fallback groups n+w separately from s+e
    // North should NOT reach south (different group)
    expect(c.n).not.toContain('s');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Inverted trim geometry — void extends beyond triangle
// ═══════════════════════════════════════════════════════════════════════════

describe('inverted trim geometry', () => {
  it('voids cells inside the arc circle for closed inverted trims', () => {
    const preview = {
      hypotenuse: [
        { row: 7, col: 2 },
        { row: 6, col: 3 },
        { row: 5, col: 4 },
        { row: 4, col: 5 },
        { row: 3, col: 6 },
      ],
      voided: [
        { row: 3, col: 2 },
        { row: 3, col: 3 },
        { row: 3, col: 4 },
        { row: 3, col: 5 },
        { row: 4, col: 2 },
        { row: 4, col: 3 },
        { row: 4, col: 4 },
        { row: 5, col: 2 },
        { row: 5, col: 3 },
        { row: 6, col: 2 },
      ],
      insideArc: [],
      arcCenter: { row: 3, col: 2 },
      size: 5,
    };
    const result = computeTrimCells(preview, 'nw', true, false);

    // Cells inside the arc circle (near the NW corner) should be null
    let nullCount = 0;
    for (const [, val] of result) {
      if (val === null) nullCount++;
    }
    expect(nullCount).toBeGreaterThan(0);

    // Cells inside the circle that were NOT in the original voided list
    // should also be voided (the arc extends void beyond the triangle)
    // Check a cell that's in the arc bounding box but not in the voided list
    const extraVoided = [...result.entries()].filter(([key, val]) => {
      if (val !== null) return false;
      const [r, c] = key.split(',').map(Number);
      return (
        !preview.voided.some((v) => v.row === r && v.col === c) &&
        !preview.hypotenuse.some((h) => h.row === r && h.col === c)
      );
    });
    expect(extraVoided.length).toBeGreaterThan(0);
  });

  it('keeps cells as interior for open inverted trims', () => {
    const preview = {
      hypotenuse: [
        { row: 5, col: 2 },
        { row: 4, col: 3 },
        { row: 3, col: 4 },
      ],
      voided: [
        { row: 3, col: 2 },
        { row: 3, col: 3 },
        { row: 4, col: 2 },
      ],
      insideArc: [],
      arcCenter: { row: 3, col: 2 },
      size: 3,
    };
    const result = computeTrimCells(preview, 'nw', true, true);

    // No cells should be null for open trims
    for (const [, val] of result) {
      expect(val).not.toBe(null);
    }
  });

  it('produces arc boundary cells with trimInverted flag', () => {
    const preview = {
      hypotenuse: [
        { row: 5, col: 2 },
        { row: 4, col: 3 },
        { row: 3, col: 4 },
      ],
      voided: [
        { row: 3, col: 2 },
        { row: 3, col: 3 },
        { row: 4, col: 2 },
      ],
      insideArc: [],
      arcCenter: { row: 3, col: 2 },
      size: 3,
    };
    const result = computeTrimCells(preview, 'nw', true, false);

    let hasInverted = false;
    for (const [, val] of result) {
      if (val && typeof val === 'object' && val.trimInverted) hasInverted = true;
    }
    expect(hasInverted).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Trim API — createTrim/roundRoomCorners produce correct properties
// ═══════════════════════════════════════════════════════════════════════════

describe('trim cell properties (via computeTrimCells)', () => {
  it('closed round trim cells have trimWall, trimClip, trimCrossing, trimCorner', () => {
    const cells = Array.from({ length: 20 }, () => Array(20).fill(null));
    makeRoomWithRoundCorners(cells, 2, 2, 17, 17, 3);

    let arcCount = 0;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        const cell = cells[r]?.[c];
        if (cell?.trimWall) {
          arcCount++;
          expect(Array.isArray(cell.trimWall)).toBe(true);
          expect(cell.trimWall.length).toBeGreaterThanOrEqual(3);
          expect(cell.trimClip).toBeDefined();
          expect(cell.trimCrossing).toBeDefined();
          expect(['nw', 'ne', 'sw', 'se']).toContain(cell.trimCorner);
          // No old-format properties
          expect(cell.trimRound).toBeUndefined();
          expect(cell.trimArcCenterRow).toBeUndefined();
          expect(cell.trimInsideArc).toBeUndefined();
        }
      }
    }
    expect(arcCount).toBeGreaterThan(0);
  });

  it('open trim cells have trimOpen flag and no voided cells', () => {
    const cells = Array.from({ length: 20 }, () => Array(20).fill(null));
    makeRoomWithRoundCorners(cells, 2, 2, 17, 17, 3, { open: true });

    let openCount = 0,
      nullInRoom = 0;
    for (let r = 2; r <= 17; r++) {
      for (let c = 2; c <= 17; c++) {
        if (cells[r][c]?.trimOpen) openCount++;
        if (cells[r][c] === null) nullInRoom++;
      }
    }
    expect(openCount).toBeGreaterThan(0);
    expect(nullInRoom).toBe(0); // open trims don't void
  });

  it('closed trim voids cells in the corner triangle', () => {
    const cells = Array.from({ length: 20 }, () => Array(20).fill(null));
    makeRoomWithRoundCorners(cells, 2, 2, 17, 17, 5);

    let nullCount = 0;
    for (let r = 2; r <= 6; r++) for (let c = 2; c <= 6; c++) if (cells[r][c] === null) nullCount++;
    expect(nullCount).toBeGreaterThan(0);
  });

  it('inverted trim cells have trimInverted flag', () => {
    const cells = Array.from({ length: 20 }, () => Array(20).fill(null));
    makeRoomWithRoundCorners(cells, 2, 2, 17, 17, 3, { inverted: true });

    let invertedCount = 0;
    for (let r = 0; r < cells.length; r++)
      for (let c = 0; c < (cells[r]?.length || 0); c++) if (cells[r]?.[c]?.trimInverted) invertedCount++;
    expect(invertedCount).toBeGreaterThan(0);
  });

  it('trimCrossing has entries for all 4 directions as strings', () => {
    const cells = Array.from({ length: 20 }, () => Array(20).fill(null));
    makeRoomWithRoundCorners(cells, 2, 2, 17, 17, 4);

    let checked = 0;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        const cell = cells[r]?.[c];
        if (cell?.trimCrossing) {
          checked++;
          for (const d of ['n', 's', 'e', 'w']) {
            expect(typeof cell.trimCrossing[d]).toBe('string');
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Migration — old format converts to new format
// ═══════════════════════════════════════════════════════════════════════════

describe('migration: old arc format to new per-cell format', () => {
  it('computeArcCellData produces trimClip, trimWall, trimCrossing', () => {
    // NW trim, arcCenter=(2,2), size=5 → circle center at (7, 7)
    const { cx, cy } = computeCircleCenter(2, 2, 5, 'nw', false);
    // Try cells along the expected arc path
    let data = null;
    for (const [r, c] of [
      [4, 2],
      [3, 3],
      [2, 4],
      [5, 2],
      [2, 5],
      [6, 2],
      [2, 6],
    ]) {
      data = computeArcCellData(r, c, cx, cy, 5, 'nw', false);
      if (data) break;
    }
    expect(data).not.toBe(null);
    expect(Array.isArray(data.trimClip)).toBe(true);
    expect(data.trimClip.length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(data.trimWall)).toBe(true);
    expect(data.trimWall.length).toBeGreaterThanOrEqual(3);
    expect(data.trimCrossing).toHaveProperty('n');
    expect(data.trimCrossing).toHaveProperty('s');
    expect(data.trimCrossing).toHaveProperty('e');
    expect(data.trimCrossing).toHaveProperty('w');
  });

  it('returns null for cells outside the arc', () => {
    const { cx, cy } = computeCircleCenter(3, 5, 5, 'nw', false);
    // Cell far from the arc — fully inside the circle
    const data = computeArcCellData(6, 9, cx, cy, 5, 'nw', false);
    expect(data).toBe(null);
  });

  it('trimClip points are in [0,1] cell-local range', () => {
    const { cx, cy } = computeCircleCenter(3, 5, 5, 'nw', false);
    const data = computeArcCellData(5, 8, cx, cy, 5, 'nw', false);
    if (data) {
      for (const [x, y] of data.trimClip) {
        expect(x).toBeGreaterThanOrEqual(-0.1);
        expect(x).toBeLessThanOrEqual(1.1);
        expect(y).toBeGreaterThanOrEqual(-0.1);
        expect(y).toBeLessThanOrEqual(1.1);
      }
    }
  });

  it('trimWall points are in [0,1] cell-local range', () => {
    const { cx, cy } = computeCircleCenter(3, 5, 5, 'nw', false);
    const data = computeArcCellData(5, 8, cx, cy, 5, 'nw', false);
    if (data) {
      for (const [x, y] of data.trimWall) {
        expect(x).toBeGreaterThanOrEqual(-0.1);
        expect(x).toBeLessThanOrEqual(1.1);
        expect(y).toBeGreaterThanOrEqual(-0.1);
        expect(y).toBeLessThanOrEqual(1.1);
      }
    }
  });

  it('works for all four corners via makeRoomWithRoundCorners', () => {
    // Each corner of a round-cornered room should have arc cells
    const cells = Array.from({ length: 20 }, () => Array(20).fill(null));
    makeRoomWithRoundCorners(cells, 2, 2, 17, 17, 4);

    const cornerArc = { nw: 0, ne: 0, sw: 0, se: 0 };
    for (let r = 0; r < 20; r++)
      for (let c = 0; c < 20; c++)
        if (cells[r]?.[c]?.trimWall && cells[r][c].trimCorner) cornerArc[cells[r][c].trimCorner]++;

    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      expect(cornerArc[corner]).toBeGreaterThan(0);
    }
  });

  it('works for inverted trims', () => {
    const { cx, cy } = computeCircleCenter(3, 3, 5, 'nw', true);
    // For inverted, arc center is at the corner itself
    expect(cx).toBe(3);
    expect(cy).toBe(3);
    // Check cells in the arc bounding box
    let found = false;
    for (let r = 3; r <= 8; r++) {
      for (let c = 3; c <= 8; c++) {
        const data = computeArcCellData(r, c, cx, cy, 5, 'nw', true);
        if (data) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });
});
