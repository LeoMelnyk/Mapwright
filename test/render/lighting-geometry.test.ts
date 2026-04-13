/**
 * Unit tests for lighting-geometry.ts — wall segment extraction and shadow zones.
 *
 * Tests the pure geometry functions extracted from the lighting module:
 * extractWallSegments, extractPropShadowZones, computePropShadowPolygon.
 */
import { describe, it, expect } from 'vitest';
import {
  extractWallSegments,
  extractPropShadowZones,
  computePropShadowPolygon,
  DEFAULT_LIGHT_Z,
} from '../../src/render/lighting-geometry.js';
import type { CellGrid } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helper to check if a specific segment exists in the result set.
// Segments are deduplicated with canonical keys, so we check both orderings.
// ---------------------------------------------------------------------------

function hasSegment(
  segments: { x1: number; y1: number; x2: number; y2: number }[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  return segments.some(
    (s) =>
      (s.x1 === x1 && s.y1 === y1 && s.x2 === x2 && s.y2 === y2) ||
      (s.x1 === x2 && s.y1 === y2 && s.x2 === x1 && s.y2 === y1),
  );
}

// ---------------------------------------------------------------------------
// extractWallSegments
// ---------------------------------------------------------------------------

describe('extractWallSegments', () => {
  it('empty grid produces no segments', () => {
    const cells: CellGrid = [];
    const segments = extractWallSegments(cells, 5, null);
    expect(segments).toHaveLength(0);
  });

  it('grid of all-null cells produces no segments', () => {
    const cells: CellGrid = [
      [null, null],
      [null, null],
    ];
    const segments = extractWallSegments(cells, 5, null);
    expect(segments).toHaveLength(0);
  });

  it('single cell with north wall produces a segment', () => {
    const cells: CellGrid = [[{ north: 'w' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // The north wall at row 0, col 0 spans from (0,0) to (10,0)
    expect(hasSegment(segments, 0, 0, 10, 0)).toBe(true);

    // All segments should have valid properties
    for (const seg of segments) {
      expect(typeof seg.x1).toBe('number');
      expect(typeof seg.y1).toBe('number');
      expect(typeof seg.x2).toBe('number');
      expect(typeof seg.y2).toBe('number');
    }
  });

  it('two adjacent cells with shared wall do not double-count', () => {
    // Cell [0][0] has south='w', cell [1][0] has north='w' — same border at y=5
    const cells: CellGrid = [[{ south: 'w' }], [{ north: 'w' }]];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // The shared border at y=5, x=[0,5] should appear exactly once
    const sharedSegments = segments.filter(
      (s) =>
        Math.min(s.y1, s.y2) === 5 &&
        Math.max(s.y1, s.y2) === 5 &&
        Math.min(s.x1, s.x2) === 0 &&
        Math.max(s.x1, s.x2) === 5,
    );
    expect(sharedSegments).toHaveLength(1);
  });

  it('two horizontally adjacent cells with shared wall do not double-count', () => {
    // Cell [0][0] has east='w', cell [0][1] has west='w' — same border at x=5
    const cells: CellGrid = [[{ east: 'w' }, { west: 'w' }]];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    const sharedSegments = segments.filter(
      (s) =>
        Math.min(s.x1, s.x2) === 5 &&
        Math.max(s.x1, s.x2) === 5 &&
        Math.min(s.y1, s.y2) === 0 &&
        Math.max(s.y1, s.y2) === 5,
    );
    expect(sharedSegments).toHaveLength(1);
  });

  it('cell with door ("d") produces a segment (doors cast shadows)', () => {
    // Doors (d) are treated as walls for lighting — they block light.
    // Only invisible doors (id) and invisible walls (iw) are excluded.
    const cells: CellGrid = [[{ north: 'd' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // The north door at (0,0)→(10,0) should produce a wall segment
    expect(hasSegment(segments, 0, 0, 10, 0)).toBe(true);
  });

  it('cell with secret door ("s") produces a segment', () => {
    const cells: CellGrid = [[{ north: 's' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);
    expect(hasSegment(segments, 0, 0, 10, 0)).toBe(true);
  });

  it('cell with invisible wall ("iw") does not produce a wall segment from that edge', () => {
    // An invisible wall should NOT contribute a wall segment.
    // However, void boundaries still add segments for edges adjacent to out-of-bounds.
    // Use a 2-cell grid so the shared edge has no void boundary.
    const cells: CellGrid = [[{ east: 'iw' }, { west: 'iw' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // The border at x=10 between the two cells should NOT be a segment.
    // Neither the explicit 'iw' nor a void boundary should add it
    // (both cells are non-null, so no void boundary at x=10).
    const middleSegments = segments.filter(
      (s) =>
        Math.min(s.x1, s.x2) === 10 &&
        Math.max(s.x1, s.x2) === 10 &&
        Math.min(s.y1, s.y2) === 0 &&
        Math.max(s.y1, s.y2) === 10,
    );
    expect(middleSegments).toHaveLength(0);
  });

  it('cell with invisible door ("id") does not produce a wall segment from that edge', () => {
    const cells: CellGrid = [[{ east: 'id' }, { west: 'id' }]];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    const middleSegments = segments.filter(
      (s) =>
        Math.min(s.x1, s.x2) === 5 &&
        Math.max(s.x1, s.x2) === 5 &&
        Math.min(s.y1, s.y2) === 0 &&
        Math.max(s.y1, s.y2) === 5,
    );
    expect(middleSegments).toHaveLength(0);
  });

  it('diagonal wall nw-se produces a diagonal segment', () => {
    const cells: CellGrid = [[{ 'nw-se': 'w' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // nw-se diagonal: from (0,0) to (10,10)
    expect(hasSegment(segments, 0, 0, 10, 10)).toBe(true);
  });

  it('diagonal wall ne-sw produces a diagonal segment', () => {
    const cells: CellGrid = [[{ 'ne-sw': 'w' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // ne-sw diagonal: from (10,0) to (0,10)
    expect(hasSegment(segments, 10, 0, 0, 10)).toBe(true);
  });

  it('invisible diagonal wall ("iw") does not produce a diagonal segment', () => {
    const cells: CellGrid = [[{ 'nw-se': 'iw' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // The diagonal should NOT be present
    expect(hasSegment(segments, 0, 0, 10, 10)).toBe(false);
  });

  it('diagonal wall is skipped when cell has trimWall polyline', () => {
    // When a cell has a trimWall array, diagonal walls are skipped
    // because the trimWall polyline provides the boundary instead.
    const cells: CellGrid = [
      [
        {
          'nw-se': 'w',
          trimWall: [
            [0, 0],
            [0.5, 0.5],
            [1, 1],
          ] as number[][],
        },
      ],
    ];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // The raw diagonal (0,0)→(10,10) should NOT appear because trimWall takes over.
    // Instead, trimWall polyline segments should appear.
    expect(hasSegment(segments, 0, 0, 10, 10)).toBe(false);

    // The trimWall polyline segments should be present:
    // (0,0)→(5,5) and (5,5)→(10,10)
    expect(hasSegment(segments, 0, 0, 5, 5)).toBe(true);
    expect(hasSegment(segments, 5, 5, 10, 10)).toBe(true);
  });

  it('void boundary adds segments between floor cell and out-of-bounds', () => {
    // A single cell surrounded by nothing should get void boundary segments
    // on all four sides.
    const cells: CellGrid = [[{}]];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // Void boundaries at all four edges
    expect(hasSegment(segments, 0, 0, 5, 0)).toBe(true); // north
    expect(hasSegment(segments, 0, 5, 5, 5)).toBe(true); // south
    expect(hasSegment(segments, 0, 0, 0, 5)).toBe(true); // west
    expect(hasSegment(segments, 5, 0, 5, 5)).toBe(true); // east
  });

  it('void boundary between floor cell and null neighbor', () => {
    const cells: CellGrid = [[{}, null]];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // East side of cell [0][0] borders a null cell → void boundary at x=5
    expect(hasSegment(segments, 5, 0, 5, 5)).toBe(true);
  });

  it('no void boundary between two adjacent floor cells', () => {
    // Two adjacent floor cells with no explicit walls between them
    // should not have a void boundary on their shared edge.
    const cells: CellGrid = [[{}, {}]];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // The shared edge at x=5 should NOT be a segment (no wall, no void boundary)
    const sharedEdge = segments.filter(
      (s) =>
        Math.min(s.x1, s.x2) === 5 &&
        Math.max(s.x1, s.x2) === 5 &&
        Math.min(s.y1, s.y2) === 0 &&
        Math.max(s.y1, s.y2) === 5,
    );
    expect(sharedEdge).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractPropShadowZones
// ---------------------------------------------------------------------------

describe('extractPropShadowZones', () => {
  it('returns empty for null catalog', () => {
    const result = extractPropShadowZones(null, null, 5);
    expect(result).toHaveLength(0);
  });

  it('returns empty when no props in metadata', () => {
    const catalog = { categories: [], props: {} };
    const metadata = { props: [] } as any;
    const result = extractPropShadowZones(catalog, metadata, 5);
    expect(result).toHaveLength(0);
  });

  it('returns empty for prop without blocksLight', () => {
    const catalog = {
      categories: ['furniture'],
      props: {
        table: {
          name: 'table',
          category: 'furniture',
          footprint: [1, 1] as [number, number],
          blocksLight: false,
          hitboxZones: [
            {
              polygon: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
              zBottom: 0,
              zTop: 3,
            },
          ],
          facing: false,
          shadow: false,
          padding: 0,
          height: null,
          commands: [],
          textures: [],
          lights: null,
          manualHitbox: null,
          manualSelection: null,
          placement: 'floor' as any,
          roomTypes: [],
          typicalCount: null,
          clustersWith: [],
          notes: null,
        },
      },
    };
    const metadata = {
      props: [{ id: 1, type: 'table', x: 0, y: 0, rotation: 0, scale: 1, flipped: false, zIndex: 0 }],
    } as any;
    const result = extractPropShadowZones(catalog, metadata, 5);
    expect(result).toHaveLength(0);
  });

  it('returns zones for blocksLight prop with finite-height hitbox', () => {
    const catalog = {
      categories: ['structure'],
      props: {
        pillar: {
          name: 'pillar',
          category: 'structure',
          footprint: [1, 1] as [number, number],
          blocksLight: true,
          hitboxZones: [
            {
              polygon: [
                [0.2, 0.2],
                [0.8, 0.2],
                [0.8, 0.8],
                [0.2, 0.8],
              ],
              zBottom: 0,
              zTop: 6,
            },
          ],
          facing: false,
          shadow: true,
          padding: 0,
          height: 6,
          commands: [],
          textures: [],
          lights: null,
          manualHitbox: null,
          manualSelection: null,
          placement: 'floor' as any,
          roomTypes: [],
          typicalCount: null,
          clustersWith: [],
          notes: null,
        },
      },
    };
    const metadata = {
      props: [{ id: 1, type: 'pillar', x: 10, y: 10, rotation: 0, scale: 1, flipped: false, zIndex: 0 }],
    } as any;
    const gridSize = 5;
    const result = extractPropShadowZones(catalog, metadata, gridSize);

    expect(result).toHaveLength(1);
    expect(result[0].propId).toBe(1);
    expect(result[0].zones).toHaveLength(1);

    const zone = result[0].zones[0];
    expect(zone.zBottom).toBe(0);
    expect(zone.zTop).toBe(6);
    expect(zone.worldPolygon.length).toBe(4);
    expect(typeof zone.centroidX).toBe('number');
    expect(typeof zone.centroidY).toBe('number');
  });

  it('skips props with only infinite-height zones', () => {
    const catalog = {
      categories: ['structure'],
      props: {
        'wall-segment': {
          name: 'wall-segment',
          category: 'structure',
          footprint: [1, 1] as [number, number],
          blocksLight: true,
          hitboxZones: [
            {
              polygon: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
              zBottom: 0,
              zTop: Infinity,
            },
          ],
          facing: false,
          shadow: true,
          padding: 0,
          height: null,
          commands: [],
          textures: [],
          lights: null,
          manualHitbox: null,
          manualSelection: null,
          placement: 'floor' as any,
          roomTypes: [],
          typicalCount: null,
          clustersWith: [],
          notes: null,
        },
      },
    };
    const metadata = {
      props: [{ id: 1, type: 'wall-segment', x: 0, y: 0, rotation: 0, scale: 1, flipped: false, zIndex: 0 }],
    } as any;
    const result = extractPropShadowZones(catalog, metadata, 5);
    expect(result).toHaveLength(0);
  });

  it('scales z-heights by prop scale factor', () => {
    const catalog = {
      categories: ['structure'],
      props: {
        pillar: {
          name: 'pillar',
          category: 'structure',
          footprint: [1, 1] as [number, number],
          blocksLight: true,
          hitboxZones: [
            {
              polygon: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
              zBottom: 0,
              zTop: 4,
            },
          ],
          facing: false,
          shadow: true,
          padding: 0,
          height: 4,
          commands: [],
          textures: [],
          lights: null,
          manualHitbox: null,
          manualSelection: null,
          placement: 'floor' as any,
          roomTypes: [],
          typicalCount: null,
          clustersWith: [],
          notes: null,
        },
      },
    };
    const metadata = {
      props: [{ id: 1, type: 'pillar', x: 0, y: 0, rotation: 0, scale: 2, flipped: false, zIndex: 0 }],
    } as any;
    const result = extractPropShadowZones(catalog, metadata, 5);

    expect(result).toHaveLength(1);
    // zTop should be 4 * 2 = 8 (scaled)
    expect(result[0].zones[0].zTop).toBe(8);
    expect(result[0].zones[0].zBottom).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computePropShadowPolygon
// ---------------------------------------------------------------------------

describe('computePropShadowPolygon', () => {
  // A simple square polygon for testing
  const square: number[][] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];

  it('returns null when light is below the prop (lz < zBottom)', () => {
    const result = computePropShadowPolygon(5, 5, 1, square, 3, 6, 50);
    expect(result).toBeNull();
  });

  it('returns a shadow polygon when light is above the prop', () => {
    // Light at (10, 1), z=10, well above the prop (zTop=4)
    const result = computePropShadowPolygon(10, 1, 10, square, 0, 4, 50);
    expect(result).not.toBeNull();
    expect(result!.shadowPoly.length).toBeGreaterThan(0);
    expect(result!.opacity).toBeGreaterThan(0);
    expect(result!.hard).toBe(false);
  });

  it('returns a shadow polygon when light is within the prop height range', () => {
    // Light at z=3, within zBottom=0 to zTop=6
    const result = computePropShadowPolygon(10, 1, 3, square, 0, 6, 50);
    expect(result).not.toBeNull();
    expect(result!.opacity).toBeGreaterThanOrEqual(0.7); // within zone → high opacity
  });

  it('returns null for degenerate polygon (fewer than 3 vertices)', () => {
    const line: number[][] = [
      [0, 0],
      [1, 1],
    ];
    const result = computePropShadowPolygon(5, 5, 10, line, 0, 4, 50);
    expect(result).toBeNull();
  });

  it('shadow projects away from the light source', () => {
    // Light to the left of the square, should project shadow to the right
    const result = computePropShadowPolygon(-10, 1, 10, square, 0, 4, 100);
    expect(result).not.toBeNull();

    // The far center should be further from the light than the near center
    const nearDist = Math.sqrt((result!.nearCenter[0] - -10) ** 2 + (result!.nearCenter[1] - 1) ** 2);
    const farDist = Math.sqrt((result!.farCenter[0] - -10) ** 2 + (result!.farCenter[1] - 1) ** 2);
    expect(farDist).toBeGreaterThan(nearDist);
  });

  it('DEFAULT_LIGHT_Z is a reasonable default', () => {
    expect(DEFAULT_LIGHT_Z).toBe(8);
    expect(typeof DEFAULT_LIGHT_Z).toBe('number');
  });
});
