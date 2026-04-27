// Tests for src/util/cell-segments.ts — Phase 1 of the segments refactor.
// Polygon construction, hit-testing, edge classification, and legacy-shape
// synthesis. See plan i-want-to-a-sleepy-breeze.md.

import { describe, it, expect } from 'vitest';
import type { Cell } from '../../src/types.js';
import {
  classifyPolygonEdge,
  diagonalSegments,
  getInteriorEdges,
  getSegmentAt,
  getSegmentIndexAt,
  getSegments,
  isCellSplit,
  spliceSegments,
  trimSegments,
} from '../../src/util/cell-segments.js';
import { setDiagonalEdge } from '../../src/util/grid.js';

/** Helper: create a cell with the given diagonal-wall partition. */
function makeDiagonalCell(diag: 'nw-se' | 'ne-sw'): Cell {
  const cell: Cell = {};
  setDiagonalEdge(cell, diag, 'w');
  return cell;
}

/** Helper: create a cell with a trim-arc partition built from an explicit chord. */
function makeTrimCell(trimClip: number[][], openExterior = false): Cell {
  const cell: Cell = {};
  const { segments, interiorEdge } = trimSegments(trimClip, openExterior);
  spliceSegments(cell, {
    kind: 'replacePartition',
    segments: segments.map((s) => ({ ...s, polygon: s.polygon.map((p) => [p[0]!, p[1]!]) })),
    interiorEdges: [
      {
        vertices: interiorEdge.vertices.map((v) => [v[0]!, v[1]!]),
        wall: interiorEdge.wall,
        between: [interiorEdge.between[0], interiorEdge.between[1]],
      },
    ],
  });
  return cell;
}

describe('getSegments', () => {
  it('returns a single full segment for an unsplit empty cell', () => {
    const cell: Cell = {};
    const segs = getSegments(cell);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.id).toBe('s0');
    expect(segs[0]!.polygon).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(segs[0]!.texture).toBeUndefined();
  });

  it('returns authoritative segments when cell.segments is set', () => {
    const cell: Cell = {
      segments: [
        {
          id: 'custom-a',
          polygon: [
            [0, 0],
            [1, 0],
            [0.5, 1],
          ],
        },
      ],
    };
    const segs = getSegments(cell);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.id).toBe('custom-a');
  });

  it('returns empty array for null cell', () => {
    expect(getSegments(null)).toEqual([]);
    expect(getSegments(undefined)).toEqual([]);
  });
});

describe('isCellSplit', () => {
  it('returns false for unsplit cells', () => {
    expect(isCellSplit({})).toBe(false);
  });
  it('returns true for diagonal-split cells', () => {
    expect(isCellSplit(makeDiagonalCell('nw-se'))).toBe(true);
    expect(isCellSplit(makeDiagonalCell('ne-sw'))).toBe(true);
  });
  it('returns true for trim-arc cells', () => {
    // Realistic arc trimClip with a chord interior vertex.
    const trimClip = [
      [1, 0.4],
      [1, 1],
      [0, 1],
      [0, 0.4],
      [0.5, 0.6],
    ];
    expect(isCellSplit(makeTrimCell(trimClip))).toBe(true);
  });
  it('returns true when authoritative segments has >1 entry', () => {
    expect(
      isCellSplit({
        segments: [
          {
            id: 's0',
            polygon: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
          },
          {
            id: 's1',
            polygon: [
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe('getSegmentAt / getSegmentIndexAt', () => {
  it('returns the only segment for an unsplit cell from any point', () => {
    const cell: Cell = {};
    expect(getSegmentIndexAt(cell, 0.5, 0.5)).toBe(0);
    expect(getSegmentIndexAt(cell, 0.01, 0.99)).toBe(0);
  });

  it('classifies points on an nw-se diagonal cell', () => {
    const cell = makeDiagonalCell('nw-se');
    // s0 = SW triangle [(0,0),(1,1),(0,1)] — contains the SW corner area.
    expect(getSegmentIndexAt(cell, 0.2, 0.8)).toBe(0); // close to SW corner
    // s1 = NE triangle [(0,0),(1,0),(1,1)] — contains the NE corner area.
    expect(getSegmentIndexAt(cell, 0.8, 0.2)).toBe(1); // close to NE corner
  });

  it('classifies points on an ne-sw diagonal cell', () => {
    const cell = makeDiagonalCell('ne-sw');
    // s0 = SE triangle [(1,0),(1,1),(0,1)] — contains the SE corner area.
    expect(getSegmentIndexAt(cell, 0.8, 0.8)).toBe(0); // close to SE corner
    // s1 = NW triangle [(0,0),(1,0),(0,1)] — contains the NW corner area.
    expect(getSegmentIndexAt(cell, 0.2, 0.2)).toBe(1); // close to NW corner
  });

  it('returns the segment object via getSegmentAt', () => {
    const cell = makeDiagonalCell('nw-se');
    cell.segments![0]!.texture = 'b';
    cell.segments![1]!.texture = 'a';
    expect(getSegmentAt(cell, 0.2, 0.8)?.texture).toBe('b'); // SW segment 0
    expect(getSegmentAt(cell, 0.8, 0.2)?.texture).toBe('a'); // NE segment 1
  });
});

describe('diagonalSegments — polygon builders', () => {
  it('returns SW + NE triangles plus the (0,0)→(1,1) interior edge for nw-se', () => {
    const { segments, interiorEdge } = diagonalSegments('nw-se');
    expect(segments[0].id).toBe('s0');
    expect(segments[1].id).toBe('s1');
    expect(interiorEdge.vertices).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(interiorEdge.between).toEqual([0, 1]);
    expect(interiorEdge.wall).toBe('w');
  });

  it('returns SE + NW triangles plus the (1,0)→(0,1) interior edge for ne-sw', () => {
    const { segments, interiorEdge } = diagonalSegments('ne-sw');
    expect(segments[0].polygon).toEqual([
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(segments[1].polygon).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(interiorEdge.vertices).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});

describe('trimSegments — polygon builders', () => {
  it('builds interior + exterior segments and an interior edge along the chord', () => {
    // Trim cell with a chord running from the east border to the west border
    // through the cell's middle. trimClip walks: chord-end-A on east → SE → SW →
    // chord-end-B on west → chord interior. So interior is the BOTTOM half;
    // exterior is the TOP half (the chord cuts off the upper portion).
    const trimClip = [
      [1, 0.4], // chord-end-A on east border
      [1, 1], // SE corner
      [0, 1], // SW corner
      [0, 0.4], // chord-end-B on west border
      [0.5, 0.6], // chord interior vertex
    ];
    const { segments, interiorEdge } = trimSegments(trimClip, false);
    expect(segments[0].id).toBe('s0');
    expect(segments[0].polygon).toEqual(trimClip);
    expect(segments[1].id).toBe('s1');
    // Exterior is the chord-cut polygon on the OPPOSITE side: walks A → NE →
    // NW → B → chord interior (reversed). Tiles the unit square together
    // with interior, no overlap, no gap.
    expect(segments[1].polygon).toEqual([
      [1, 0.4],
      [1, 0],
      [0, 0],
      [0, 0.4],
      [0.5, 0.6],
    ]);
    expect(interiorEdge.between).toEqual([0, 1]);
    expect(interiorEdge.wall).toBe('w');
    // Chord polyline includes the interior vertex.
    expect(interiorEdge.vertices.some((v) => v[0] === 0.5 && v[1] === 0.6)).toBe(true);
  });

  it('emits a passable interior edge when openExterior is true', () => {
    const trimClip = [
      [1, 0.4],
      [1, 1],
      [0, 1],
      [0, 0.4],
      [0.5, 0.6],
    ];
    const { interiorEdge } = trimSegments(trimClip, true);
    expect(interiorEdge.wall).toBeNull();
  });

  it('produces interior + exterior polygons that tile the unit square (multi-vertex chord)', () => {
    // Regression: a real arc trim produces a chord polyline with many
    // interior vertices (~25 for a quarter-circle sampled densely). The
    // exterior polygon must walk the chord in the SAME direction as the
    // interior polygon does in trimClip, not reversed — reversing makes the
    // exterior jump from chord-end-B to a vertex near chord-end-A and trace
    // the arc backwards, producing a self-intersecting polygon whose
    // shoelace area combined with the interior overshoots 1.0.
    //
    // Input is the actual trimClip captured from `createTrim(2,2,4,4,"nw",
    // {round:true,open:true})` for the corner-tip arc cell of an NW-corner
    // 3-cell open round trim.
    const trimClip = [
      [0.417, 0],
      [1, 0],
      [1, 1],
      [0.101, 1],
      [0.11, 0.957],
      [0.119, 0.914],
      [0.129, 0.872],
      [0.139, 0.829],
      [0.149, 0.787],
      [0.16, 0.744],
      [0.171, 0.702],
      [0.183, 0.66],
      [0.195, 0.617],
      [0.207, 0.575],
      [0.22, 0.533],
      [0.233, 0.492],
      [0.246, 0.45],
      [0.26, 0.408],
      [0.274, 0.367],
      [0.289, 0.326],
      [0.304, 0.284],
      [0.319, 0.243],
      [0.334, 0.202],
      [0.35, 0.162],
      [0.366, 0.121],
      [0.383, 0.081],
      [0.4, 0.04],
    ];
    const { segments } = trimSegments(trimClip, true);
    const polygonArea = (poly: number[][]): number => {
      let s = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!,
          b = poly[(i + 1) % poly.length]!;
        s += a[0]! * b[1]! - b[0]! * a[1]!;
      }
      return Math.abs(s) / 2;
    };
    const a0 = polygonArea(segments[0].polygon);
    const a1 = polygonArea(segments[1].polygon);
    expect(a0 + a1).toBeCloseTo(1.0, 5);
  });
});

describe('classifyPolygonEdge', () => {
  it('classifies the three edges of a SW triangle on an nw-se diagonal cell', () => {
    const cell: Cell = makeDiagonalCell('nw-se');
    // Segment 0 polygon: [(0,0), (1,1), (0,1)]. Edges:
    //   0: (0,0)→(1,1) — interior (the diagonal)
    //   1: (1,1)→(0,1) — runs along south (y=1) with interval [0,1]
    //   2: (0,1)→(0,0) — runs along west (x=0) with interval [0,1]
    expect(classifyPolygonEdge(cell, 0, 0)).toEqual({
      kind: 'interior',
      otherSegmentIndex: 1,
      interiorEdgeIndex: 0,
    });
    expect(classifyPolygonEdge(cell, 0, 1)).toEqual({
      kind: 'border',
      side: 'south',
      interval: [0, 1],
    });
    expect(classifyPolygonEdge(cell, 0, 2)).toEqual({
      kind: 'border',
      side: 'west',
      interval: [0, 1],
    });
  });

  it('classifies the three edges of the NE triangle of an nw-se diagonal cell', () => {
    const cell: Cell = makeDiagonalCell('nw-se');
    // Segment 1 polygon: [(0,0), (1,0), (1,1)]. Edges:
    //   0: (0,0)→(1,0) — north
    //   1: (1,0)→(1,1) — east
    //   2: (1,1)→(0,0) — interior
    expect(classifyPolygonEdge(cell, 1, 0)).toEqual({
      kind: 'border',
      side: 'north',
      interval: [0, 1],
    });
    expect(classifyPolygonEdge(cell, 1, 1)).toEqual({
      kind: 'border',
      side: 'east',
      interval: [0, 1],
    });
    expect(classifyPolygonEdge(cell, 1, 2)).toMatchObject({
      kind: 'interior',
      otherSegmentIndex: 0,
    });
  });

  it('classifies all four borders of an unsplit cell', () => {
    const cell: Cell = {};
    // Segment 0 polygon: [(0,0), (1,0), (1,1), (0,1)]. Edges in order:
    //   0: (0,0)→(1,0) north
    //   1: (1,0)→(1,1) east
    //   2: (1,1)→(0,1) south
    //   3: (0,1)→(0,0) west
    expect(classifyPolygonEdge(cell, 0, 0)).toMatchObject({ kind: 'border', side: 'north' });
    expect(classifyPolygonEdge(cell, 0, 1)).toMatchObject({ kind: 'border', side: 'east' });
    expect(classifyPolygonEdge(cell, 0, 2)).toMatchObject({ kind: 'border', side: 'south' });
    expect(classifyPolygonEdge(cell, 0, 3)).toMatchObject({ kind: 'border', side: 'west' });
  });
});

describe('getInteriorEdges', () => {
  it('returns no interior edges for an unsplit cell', () => {
    expect(getInteriorEdges({})).toEqual([]);
  });

  it('returns a single interior edge for a diagonal cell', () => {
    const ies = getInteriorEdges(makeDiagonalCell('nw-se'));
    expect(ies).toHaveLength(1);
    expect(ies[0]!.between).toEqual([0, 1]);
  });

  it('returns authoritative edges when cell.interiorEdges is set', () => {
    const cell: Cell = {
      segments: [
        {
          id: 's0',
          polygon: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
        },
        {
          id: 's1',
          polygon: [
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        },
      ],
      interiorEdges: [
        {
          vertices: [
            [1, 0],
            [0, 1],
          ],
          wall: 'd',
          between: [0, 1],
        },
      ],
    };
    const ies = getInteriorEdges(cell);
    expect(ies).toHaveLength(1);
    expect(ies[0]!.wall).toBe('d');
  });
});

describe('spliceSegments — partition mutations', () => {
  const SQUARE = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const SW = [
    [0, 0],
    [1, 1],
    [0, 1],
  ];
  const NE = [
    [0, 0],
    [1, 0],
    [1, 1],
  ];

  it('replacePartition stores the new segments and interiorEdges atomically', () => {
    const cell: Cell = {};
    spliceSegments(cell, {
      kind: 'replacePartition',
      segments: [
        { id: 's0', polygon: SW, texture: 'a' },
        { id: 's1', polygon: NE, texture: 'b' },
      ],
      interiorEdges: [
        {
          vertices: [
            [0, 0],
            [1, 1],
          ],
          wall: 'w',
          between: [0, 1],
        },
      ],
    });
    expect(cell.segments).toHaveLength(2);
    expect(cell.segments![0]!.texture).toBe('a');
    expect(cell.interiorEdges).toHaveLength(1);
    expect(cell.interiorEdges![0]!.wall).toBe('w');
  });

  it('replacePartition rejects non-tiling segments (sum of areas ≠ 1)', () => {
    expect(() =>
      spliceSegments(
        {},
        {
          kind: 'replacePartition',
          segments: [
            { id: 's0', polygon: SW }, // half a square = 0.5
          ],
          interiorEdges: [],
        },
      ),
    ).toThrow(/tile.*total area/i);
  });

  it('replacePartition rejects out-of-range polygon coords', () => {
    expect(() =>
      spliceSegments(
        {},
        {
          kind: 'replacePartition',
          segments: [
            {
              id: 's0',
              polygon: [
                [0, 0],
                [2, 0],
                [2, 1],
                [0, 1],
              ],
            },
          ],
          interiorEdges: [],
        },
      ),
    ).toThrow(/outside/i);
  });

  it('replacePartition rejects invalid `between` indices', () => {
    expect(() =>
      spliceSegments(
        {},
        {
          kind: 'replacePartition',
          segments: [{ id: 's0', polygon: SQUARE }],
          interiorEdges: [
            {
              vertices: [
                [0, 0],
                [1, 1],
              ],
              wall: 'w',
              between: [0, 5],
            },
          ],
        },
      ),
    ).toThrow(/between.*invalid/i);
  });

  it('replacePartition removes interiorEdges entry when empty array passed', () => {
    const cell: Cell = {
      segments: [{ id: 's0', polygon: SQUARE }],
      interiorEdges: [
        {
          vertices: [
            [0, 0],
            [1, 1],
          ],
          wall: 'w',
          between: [0, 1],
        },
      ],
    };
    spliceSegments(cell, {
      kind: 'replacePartition',
      segments: [{ id: 's0', polygon: SQUARE }],
      interiorEdges: [],
    });
    expect(cell.interiorEdges).toBeUndefined();
  });

  it('setSegmentVoided toggles the voided flag', () => {
    const cell: Cell = {};
    spliceSegments(cell, {
      kind: 'replacePartition',
      segments: [
        { id: 's0', polygon: SW, texture: 'a' },
        { id: 's1', polygon: NE, texture: 'b' },
      ],
      interiorEdges: [
        {
          vertices: [
            [0, 0],
            [1, 1],
          ],
          wall: 'w',
          between: [0, 1],
        },
      ],
    });
    spliceSegments(cell, { kind: 'setSegmentVoided', segmentIndex: 1, voided: true });
    expect(cell.segments![1]!.voided).toBe(true);
    spliceSegments(cell, { kind: 'setSegmentVoided', segmentIndex: 1, voided: false });
    expect(cell.segments![1]!.voided).toBeUndefined();
  });

  it('setSegmentTexture writes through to a synthesized cell (lazy materialize)', () => {
    // Cell starts with legacy texture only; spliceSegments materializes
    // segments on first write so the change persists.
    const cell: Cell = { texture: 'old' };
    spliceSegments(cell, { kind: 'setSegmentTexture', segmentIndex: 0, texture: 'new', textureOpacity: 0.5 });
    expect(cell.segments).toBeDefined();
    expect(cell.segments![0]!.texture).toBe('new');
    expect(cell.segments![0]!.textureOpacity).toBe(0.5);
  });

  it('setSegmentTexture(undefined) clears texture + opacity', () => {
    const cell: Cell = { segments: [{ id: 's0', polygon: SQUARE, texture: 'foo', textureOpacity: 0.7 }] };
    spliceSegments(cell, { kind: 'setSegmentTexture', segmentIndex: 0, texture: undefined });
    expect(cell.segments![0]!.texture).toBeUndefined();
    expect(cell.segments![0]!.textureOpacity).toBeUndefined();
  });

  it('setSegmentTexture rejects out-of-range segment index', () => {
    const cell: Cell = { segments: [{ id: 's0', polygon: SQUARE }] };
    expect(() => spliceSegments(cell, { kind: 'setSegmentTexture', segmentIndex: 5, texture: 'x' })).toThrow(
      /out of range/i,
    );
  });

  it('setInteriorEdgeWall changes the wall flag', () => {
    const cell: Cell = {
      segments: [
        { id: 's0', polygon: SW },
        { id: 's1', polygon: NE },
      ],
      interiorEdges: [
        {
          vertices: [
            [0, 0],
            [1, 1],
          ],
          wall: 'w',
          between: [0, 1],
        },
      ],
    };
    spliceSegments(cell, { kind: 'setInteriorEdgeWall', interiorEdgeIndex: 0, wall: 'd' });
    expect(cell.interiorEdges![0]!.wall).toBe('d');
    spliceSegments(cell, { kind: 'setInteriorEdgeWall', interiorEdgeIndex: 0, wall: null });
    expect(cell.interiorEdges![0]!.wall).toBeNull();
  });

  it('setInteriorEdgeWall rejects out-of-range edge index', () => {
    const cell: Cell = { segments: [{ id: 's0', polygon: SQUARE }] };
    expect(() => spliceSegments(cell, { kind: 'setInteriorEdgeWall', interiorEdgeIndex: 0, wall: 'w' })).toThrow(
      /out of range/i,
    );
  });
});
