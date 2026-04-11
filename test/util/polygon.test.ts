// Tests for the shared polygon helpers in src/util/polygon.ts.
// These were extracted from render/bridges.ts and editor/js/stair-geometry.ts
// to eliminate duplication between editor and render. The tests lock in the
// math so future refactors can't silently change behavior.

import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  pointOnPolygonEdge,
  getBridgeCorners,
} from '../../src/util/polygon.js';

describe('pointInPolygon', () => {
  // A 4-cell axis-aligned square polygon at rows 0..2, cols 0..2.
  const square = [[0, 0], [0, 2], [2, 2], [2, 0]] as [number, number][];

  it('returns true for a point clearly inside the polygon', () => {
    expect(pointInPolygon(1, 1, square)).toBe(true);
  });

  it('returns false for a point clearly outside the polygon', () => {
    expect(pointInPolygon(3, 3, square)).toBe(false);
    expect(pointInPolygon(-1, -1, square)).toBe(false);
  });

  it('handles a triangle correctly', () => {
    const tri = [[0, 0], [0, 4], [4, 0]] as [number, number][];
    expect(pointInPolygon(1, 1, tri)).toBe(true);     // inside
    expect(pointInPolygon(3, 3, tri)).toBe(false);    // outside the hypotenuse
  });
});

describe('pointOnPolygonEdge', () => {
  const square = [[0, 0], [0, 2], [2, 2], [2, 0]] as [number, number][];

  it('returns true for a point exactly on a horizontal edge', () => {
    expect(pointOnPolygonEdge(0, 1, square)).toBe(true);
  });

  it('returns true for a point exactly on a vertical edge', () => {
    expect(pointOnPolygonEdge(1, 2, square)).toBe(true);
  });

  it('returns false for a point clearly off any edge', () => {
    expect(pointOnPolygonEdge(1, 1, square)).toBe(false); // interior
    expect(pointOnPolygonEdge(5, 5, square)).toBe(false); // exterior
  });

  it('honors the eps tolerance', () => {
    // Point 0.005 away from the edge should be considered "on" with default eps=0.01
    expect(pointOnPolygonEdge(0.005, 1, square)).toBe(true);
    // But not with a tighter eps
    expect(pointOnPolygonEdge(0.005, 1, square, 0.001)).toBe(false);
  });
});

describe('getBridgeCorners', () => {
  it('returns 4 corners for a 1-wide horizontal bridge', () => {
    // Base P1=(0,0)→P2=(0,4); depth target P3=(2,4)
    const corners = getBridgeCorners([0, 0], [0, 4], [2, 4]);
    expect(corners).toHaveLength(4);
    expect(corners[0]).toEqual([0, 0]);   // P1
    expect(corners[1]).toEqual([0, 4]);   // P2
    expect(corners[2]).toEqual([2, 4]);   // P2 + perp
    expect(corners[3]).toEqual([2, 0]);   // P1 + perp
  });

  it('extracts the perpendicular component when P3 is not orthogonal to base', () => {
    // Base P1=(0,0)→P2=(0,4); depth target P3=(2,6) — has both inward and depth components
    const corners = getBridgeCorners([0, 0], [0, 4], [2, 6]);
    // perp = relP3-P2 minus its parallel component along base.
    // base = (0,4); relP3 = (2,2); parallel = (0, 2*4/16*4) = (0,2); perp = (2,0)
    expect(corners[2]).toEqual([2, 4]);   // P2 + perp(2,0)
    expect(corners[3]).toEqual([2, 0]);   // P1 + perp(2,0)
  });

  it('returns degenerate corners when base length is near zero', () => {
    const corners = getBridgeCorners([1, 1], [1, 1], [3, 3]);
    // Falls through to the degenerate path: [P1, P2, P2, P1]
    expect(corners).toEqual([[1, 1], [1, 1], [1, 1], [1, 1]]);
  });
});
