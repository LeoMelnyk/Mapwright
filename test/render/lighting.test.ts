/**
 * Unit tests for lighting.ts — wall segment extraction and visibility computation.
 *
 * These test the core raycasting functions used by the dungeon lighting system.
 */
import { describe, it, expect } from 'vitest';
import { extractWallSegments, computeVisibility } from '../../src/render/lighting.js';

// ---------------------------------------------------------------------------
// extractWallSegments
// ---------------------------------------------------------------------------

describe('extractWallSegments', () => {
  it('extracts wall segments from a simple 2x2 grid with perimeter walls', () => {
    const cells = [
      [
        { north: 'w', west: 'w' },
        { north: 'w', east: 'w' },
      ],
      [
        { south: 'w', west: 'w' },
        { south: 'w', east: 'w' },
      ],
    ];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);
    // Should have segments for the outer walls + void boundary segments
    expect(segments.length).toBeGreaterThan(0);
    // All segments should have x1, y1, x2, y2
    for (const seg of segments) {
      expect(seg).toHaveProperty('x1');
      expect(seg).toHaveProperty('y1');
      expect(seg).toHaveProperty('x2');
      expect(seg).toHaveProperty('y2');
    }
  });

  it('extracts correct segments for a 1x1 cell with all walls', () => {
    const cells = [
      [{ north: 'w', south: 'w', east: 'w', west: 'w' }],
    ];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);
    // A single cell with all four walls, plus void boundaries on all sides
    // Dedup means void boundaries and explicit walls merge where they overlap
    expect(segments.length).toBeGreaterThan(0);

    // Verify the four cardinal wall segments exist
    const hasNorth = segments.some(s => s.y1 === 0 && s.y2 === 0 && s.x1 === 0 && s.x2 === 10);
    const hasSouth = segments.some(s => s.y1 === 10 && s.y2 === 10 && s.x1 === 0 && s.x2 === 10);
    const hasWest = segments.some(s => s.x1 === 0 && s.x2 === 0 && s.y1 === 0 && s.y2 === 10);
    const hasEast = segments.some(s => s.x1 === 10 && s.x2 === 10 && s.y1 === 0 && s.y2 === 10);
    expect(hasNorth).toBe(true);
    expect(hasSouth).toBe(true);
    expect(hasWest).toBe(true);
    expect(hasEast).toBe(true);
  });

  it('invisible walls (iw) are excluded from segments', () => {
    const cells = [
      [{ north: 'iw', south: 'w', east: 'w', west: 'iw' }],
    ];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // The 'iw' borders should not produce wall segments from the explicit wall check.
    // However, void boundaries will still add segments on edges adjacent to out-of-bounds.
    // The explicit north='iw' should not add a duplicate — the void boundary already adds it.
    // Count segments at y=0 (north edge): should come from void boundary only
    const northSegments = segments.filter(s =>
      s.y1 === 0 && s.y2 === 0 && Math.min(s.x1, s.x2) === 0 && Math.max(s.x1, s.x2) === 10
    );
    // Exactly one (from the void boundary, not from explicit 'iw')
    expect(northSegments).toHaveLength(1);
  });

  it('invisible doors (id) are excluded from segments', () => {
    // Two cells side by side with an invisible door between them
    const cells = [
      [{ east: 'id' }, { west: 'id' }],
    ];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // The border at x=5 between the two cells should NOT appear as a wall segment
    // (both cells have non-null neighbors, so no void boundary either)
    const middleWall = segments.filter(s =>
      s.x1 === 5 && s.x2 === 5 && Math.min(s.y1, s.y2) === 0 && Math.max(s.y1, s.y2) === 5
    );
    expect(middleWall).toHaveLength(0);
  });

  it('null cells produce void boundary segments for adjacent non-null cells', () => {
    const cells = [
      [null, { north: 'w', south: 'w', east: 'w', west: 'w' }],
    ];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // The non-null cell at [0][1] should have void boundaries on all sides
    // except where it has explicit walls (which overlap with void boundaries)
    expect(segments.length).toBeGreaterThan(0);
  });

  it('diagonal walls produce segments', () => {
    const cells = [
      [{ 'nw-se': 'w' }],
    ];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // Should include a diagonal segment from (0,0) to (10,10)
    const hasDiagonal = segments.some(s =>
      (s.x1 === 0 && s.y1 === 0 && s.x2 === 10 && s.y2 === 10) ||
      (s.x1 === 10 && s.y1 === 10 && s.x2 === 0 && s.y2 === 0)
    );
    expect(hasDiagonal).toBe(true);
  });

  it('deduplicates shared wall segments between adjacent cells', () => {
    const cells = [
      [{ south: 'w' }, null],
      [{ north: 'w' }, null],
    ];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // The shared border at y=5 between [0][0] and [1][0] should appear only once
    const sharedBorder = segments.filter(s =>
      Math.min(s.y1, s.y2) === 5 && Math.max(s.y1, s.y2) === 5 &&
      Math.min(s.x1, s.x2) === 0 && Math.max(s.x1, s.x2) === 5
    );
    expect(sharedBorder).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// computeVisibility
// ---------------------------------------------------------------------------

describe('computeVisibility', () => {
  it('returns a polygon array with {x, y} points', () => {
    // Simple box of wall segments around the light
    const segments = [
      { x1: 0, y1: 0, x2: 20, y2: 0 },
      { x1: 20, y1: 0, x2: 20, y2: 20 },
      { x1: 20, y1: 20, x2: 0, y2: 20 },
      { x1: 0, y1: 20, x2: 0, y2: 0 },
    ];
    const polygon = computeVisibility(10, 10, 15, segments);
    expect(Array.isArray(polygon)).toBe(true);
    expect(polygon.length).toBeGreaterThan(0);
    for (const pt of polygon) {
      expect(pt).toHaveProperty('x');
      expect(pt).toHaveProperty('y');
      expect(typeof pt.x).toBe('number');
      expect(typeof pt.y).toBe('number');
    }
  });

  it('visibility polygon stays within bounding radius', () => {
    const segments = [
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { x1: 100, y1: 0, x2: 100, y2: 100 },
      { x1: 100, y1: 100, x2: 0, y2: 100 },
      { x1: 0, y1: 100, x2: 0, y2: 0 },
    ];
    const lx = 50, ly = 50, radius = 30;
    const polygon = computeVisibility(lx, ly, radius, segments);

    // The function adds a square bounding box at radius+1, so corner points
    // can be up to sqrt(2) * (radius+1) from center
    const maxDist = Math.SQRT2 * (radius + 1) + 1; // bounding box diagonal + tolerance
    for (const pt of polygon) {
      const dist = Math.sqrt((pt.x - lx) ** 2 + (pt.y - ly) ** 2);
      expect(dist).toBeLessThanOrEqual(maxDist);
    }
  });

  it('returns polygon even with no nearby wall segments', () => {
    // No segments at all — the function adds its own bounding box
    const polygon = computeVisibility(50, 50, 20, []);
    expect(Array.isArray(polygon)).toBe(true);
    expect(polygon.length).toBeGreaterThan(0);
  });

  it('wall segment occludes area behind it', () => {
    // Place a wall between the light and a far corner
    const segments = [
      // Vertical wall at x=15, from y=5 to y=15
      { x1: 15, y1: 5, x2: 15, y2: 15 },
    ];
    const lx = 10, ly = 10, radius = 20;
    const polygon = computeVisibility(lx, ly, radius, segments);

    // The polygon should exist and have reasonable structure
    expect(polygon.length).toBeGreaterThan(3);

    // Points far to the right of the wall (x > 20) and within the wall's
    // y-range should be occluded — check that no polygon point extends far right
    // in the shadow zone (roughly y=7..13, x>20)
    const shadowZonePoints = polygon.filter(pt =>
      pt.x > 25 && pt.y > 7 && pt.y < 13
    );
    expect(shadowZonePoints).toHaveLength(0);
  });
});
