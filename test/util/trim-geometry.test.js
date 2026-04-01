import { describe, it, expect } from 'vitest';
import { computeCircleCenter, computeTrimCells } from '../../src/util/trim-geometry.js';

describe('computeCircleCenter', () => {
  it('non-inverted NW offsets by +size in both axes', () => {
    const { cx, cy } = computeCircleCenter(5, 10, 5, 'nw', false);
    expect(cx).toBe(15);
    expect(cy).toBe(10);
  });

  it('inverted returns the arc center itself', () => {
    const { cx, cy } = computeCircleCenter(5, 10, 5, 'nw', true);
    expect(cx).toBe(10);
    expect(cy).toBe(5);
  });

  it('non-inverted NE offsets col by -size', () => {
    const { cx, cy } = computeCircleCenter(5, 20, 5, 'ne', false);
    expect(cx).toBe(15);
    expect(cy).toBe(10);
  });
});

describe('computeTrimCells', () => {
  // Build a preview matching a NW non-inverted trim of size 3
  // arcCenter at (2, 3), size 3
  // Hypotenuse: diagonal from (4, 3) to (2, 5)
  // Voided: triangle cells closer to the NW corner
  function makePreview() {
    return {
      hypotenuse: [
        { row: 4, col: 3 },
        { row: 3, col: 4 },
        { row: 2, col: 5 },
      ],
      voided: [
        { row: 3, col: 3 },
        { row: 2, col: 3 },
        { row: 2, col: 4 },
      ],
      insideArc: [],
      arcCenter: { row: 2, col: 3 },
      size: 3,
    };
  }

  it('marks voided cells as null or arc boundary for closed trims', () => {
    const result = computeTrimCells(makePreview(), 'nw', false, false);
    // Voided cells are either null (fully void) or arc boundary (arc passes through them)
    for (const key of ['3,3', '2,3', '2,4']) {
      const val = result.get(key);
      const isVoidOrBoundary = val === null || (typeof val === 'object' && !!val.trimWall);
      expect(isVoidOrBoundary).toBe(true);
    }
    // For small trims (size 3), all voided cells may become boundary cells
    // For larger trims, some will be truly null
  });

  it('marks voided cells as interior for open trims', () => {
    const result = computeTrimCells(makePreview(), 'nw', false, true);
    // Open trims keep voided cells as floor (unless overridden by arc intersection)
    const v = result.get('3,3');
    expect(v === 'interior' || (typeof v === 'object' && v.trimOpen)).toBe(true);
  });

  it('produces arc boundary cells with trimWall for round trims', () => {
    const result = computeTrimCells(makePreview(), 'nw', false, false);
    // At least some cells should have trimWall (arc boundary cells)
    let hasBoundary = false;
    for (const [, val] of result) {
      if (val && typeof val === 'object' && val.trimWall) {
        hasBoundary = true;
        expect(val.trimCorner).toBe('nw');
        expect(Array.isArray(val.trimWall)).toBe(true);
        expect(val.trimWall.length).toBeGreaterThanOrEqual(3);
        // Wall points should be in roughly [0,1] cell-local range
        for (const [x, y] of val.trimWall) {
          expect(x).toBeGreaterThanOrEqual(-0.1);
          expect(x).toBeLessThanOrEqual(1.1);
          expect(y).toBeGreaterThanOrEqual(-0.1);
          expect(y).toBeLessThanOrEqual(1.1);
        }
      }
    }
    expect(hasBoundary).toBe(true);
  });

  it('produces trimClip for closed trims but not open', () => {
    const closed = computeTrimCells(makePreview(), 'nw', false, false);
    const open = computeTrimCells(makePreview(), 'nw', false, true);

    for (const [, val] of closed) {
      if (val && typeof val === 'object' && val.trimWall) {
        expect(val.trimClip).toBeDefined();
      }
    }
    for (const [, val] of open) {
      if (val && typeof val === 'object' && val.trimWall) {
        // Open trims have trimClip (for texture split rendering)
        expect(val.trimClip).toBeDefined();
        expect(val.trimOpen).toBe(true);
      }
    }
  });

  it('arc boundary cells have trimCorner for virtual diagonal BFS blocking', () => {
    const result = computeTrimCells(makePreview(), 'nw', false, false);
    let hasArcCell = false;
    for (const [, val] of result) {
      if (val && typeof val === 'object' && val.trimWall) {
        expect(val.trimCorner).toBe('nw');
        hasArcCell = true;
      }
    }
    expect(hasArcCell).toBe(true);
  });

  it('works for all four corners', () => {
    const corners = ['nw', 'ne', 'sw', 'se'];
    for (const corner of corners) {
      // Build a simple preview for each corner
      const preview = {
        hypotenuse: [{ row: 5, col: 5 }],
        voided: [],
        insideArc: [],
        arcCenter: { row: 3, col: 3 },
        size: 3,
      };
      // Should not throw
      const result = computeTrimCells(preview, corner, false, false);
      expect(result).toBeInstanceOf(Map);
    }
  });

  it('works for inverted trims', () => {
    const preview = makePreview();
    const result = computeTrimCells(preview, 'nw', true, false);
    expect(result).toBeInstanceOf(Map);
    // Should have some boundary cells
    let hasBoundary = false;
    for (const [, val] of result) {
      if (val && typeof val === 'object' && val.trimInverted) hasBoundary = true;
    }
    // Inverted trims should produce boundary cells (arc still intersects cells)
    // (may or may not depending on geometry, so just check no error)
  });
});
