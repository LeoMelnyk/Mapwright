// Worked-example fixtures from the segments-refactor plan
// (i-want-to-a-sleepy-breeze.md, §Design — Inter-cell adjacency / trimCrossing).
//
// These are the load-bearing examples: the diagonals example proves the
// inter-cell border-interval matching is correct, and the trim-arc example
// proves that `trimCrossing`-style routing is fully expressible via segment
// polygons + a single interior wall — the basis for deleting `correctArcCells`
// in Phase 3.
//
// The trim-arc example uses HAND-CONSTRUCTED authoritative segments rather
// than P1's full-unit-square exterior approximation, so the test reflects
// what P3 migration will produce. The diagonals example uses the legacy
// `'nw-se'`/`'ne-sw'` shape because synthesis already produces exact triangles.

import { describe, it, expect } from 'vitest';
import type { Cell, CellGrid, Segment, InteriorEdge } from '../../src/types.js';
import { traverse } from '../../src/util/traverse.js';
import { setDiagonalEdge } from '../../src/util/grid.js';

function diagCell(diag: 'nw-se' | 'ne-sw'): Cell {
  const cell: Cell = {};
  setDiagonalEdge(cell, diag, 'w');
  return cell;
}

describe('worked example: two adjacent diagonal-split cells', () => {
  // Cell A (col 0): split by nw-se → s0=SW triangle, s1=NE triangle.
  // Cell B (col 1): split by ne-sw → s0=SE triangle, s1=NW triangle.
  // No cardinal wall on the A.east / B.west border.
  //
  // Geometric truth:
  //   - A1 (NE) owns the entire east border [0..1].
  //   - B1 (NW) owns the entire west border [0..1].
  //   - A0 (SW) does NOT touch east at all.
  //   - B0 (SE) does NOT touch west at all.
  // So the ONLY cross-cell connection is A1 ↔ B1.
  // A0 and B0 are unreachable from each other across this border.
  const cells: CellGrid = [[diagCell('nw-se'), diagCell('ne-sw')]];

  it('A1 (NE of cell A) connects to B1 (NW of cell B) across the shared east-west border', () => {
    const { visited } = traverse(cells, { row: 0, col: 0, segmentIndex: 1 });
    expect(visited.has('0,0,1')).toBe(true); // A1
    expect(visited.has('0,1,1')).toBe(true); // B1
    expect(visited.size).toBe(2);
  });

  it('A0 (SW of cell A) is isolated — diagonals miss each other', () => {
    const { visited } = traverse(cells, { row: 0, col: 0, segmentIndex: 0 });
    // Cannot cross interior diagonal wall to A1.
    // Cannot reach B at all because A0 doesn't touch the east border.
    expect(visited.size).toBe(1);
    expect(visited.has('0,0,0')).toBe(true);
  });

  it('B0 (SE of cell B) is isolated for the same reason', () => {
    const { visited } = traverse(cells, { row: 0, col: 1, segmentIndex: 0 });
    expect(visited.size).toBe(1);
    expect(visited.has('0,1,0')).toBe(true);
  });

  it('removing the diagonal walls fully connects all four segments', () => {
    // With wall set to null on both interior edges, intra-cell traversal
    // works in both cells — every segment becomes reachable from any start.
    const open: CellGrid = [
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
            }, // SW
            {
              id: 's1',
              polygon: [
                [0, 0],
                [1, 0],
                [1, 1],
              ],
            }, // NE
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
        {
          segments: [
            {
              id: 's0',
              polygon: [
                [1, 0],
                [1, 1],
                [0, 1],
              ],
            }, // SE
            {
              id: 's1',
              polygon: [
                [0, 0],
                [1, 0],
                [0, 1],
              ],
            }, // NW
          ],
          interiorEdges: [
            {
              vertices: [
                [1, 0],
                [0, 1],
              ],
              wall: null,
              between: [0, 1],
            },
          ],
        },
      ],
    ];
    const { visited } = traverse(open, { row: 0, col: 0, segmentIndex: 0 });
    expect(visited.size).toBe(4);
  });
});

describe('worked example: trim-arc trimCrossing equivalence', () => {
  // NW-corner trim arc cell. Hand-construct authoritative segments matching
  // what P3 migration will emit:
  //   - interior (s0): SE-side polygon, owns south + east + parts of north and west.
  //   - exterior (s1): NW-corner triangle, owns the corner-side parts of north and west.
  //   - interior edge: chord wall between them.
  //
  // Chord intersects the cell border at (0.4, 0) on north and (0, 0.4) on
  // west, with one curved interior vertex at (0.5, 0.5).
  const interior: Segment = {
    id: 's0',
    polygon: [
      [0.4, 0], // on north border
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0.4], // on west border
      [0.5, 0.5], // chord interior vertex
    ],
  };
  const exterior: Segment = {
    id: 's1',
    polygon: [
      [0, 0], // NW corner
      [0.4, 0], // on north border
      [0.5, 0.5], // chord interior vertex
      [0, 0.4], // on west border
    ],
  };
  const interiorEdge: InteriorEdge = {
    vertices: [
      [0, 0.4],
      [0.5, 0.5],
      [0.4, 0],
    ],
    wall: 'w',
    between: [0, 1],
  };

  it('the chord wall blocks direct intra-cell crossing in an isolated trim cell', () => {
    // Single cell, no neighbors → the only way between segments is across
    // the chord. With wall='w' that's blocked.
    const cells: CellGrid = [[{ segments: [interior, exterior], interiorEdges: [interiorEdge] }]];
    expect(traverse(cells, { row: 0, col: 0, segmentIndex: 0 }).visited.size).toBe(1);
    expect(traverse(cells, { row: 0, col: 0, segmentIndex: 1 }).visited.size).toBe(1);
  });

  it('interior is the only landing for an entry from south (corner-side excludes south)', () => {
    // Surround with unsplit neighbors; south neighbor's full south border
    // overlaps only with interior's south interval [0,1] (exterior doesn't
    // touch south at all). So crossing north from the south neighbor lands
    // in interior, never exterior.
    //
    // BUT: once interior is reached, the BFS continues globally. From
    // interior → north neighbor (via interior's north interval [0.4,1]),
    // then back south into the trim cell, the unsplit (0,1)'s south border
    // [0,1] overlaps BOTH interior's [0.4,1] AND exterior's [0, 0.4]. So
    // exterior IS reachable globally — the chord wall only blocks the
    // direct interior↔exterior step within the cell, not the wrap-around
    // through unsplit neighbors. This matches the legacy `trimCrossing`
    // model: the matrix only constrained intra-cell entry/exit, not the
    // global graph.
    const cells: CellGrid = [
      [{}, {}, {}],
      [{}, { segments: [interior, exterior], interiorEdges: [interiorEdge] }, {}],
      [{}, {}, {}],
    ];
    const fromSouth = traverse(cells, { row: 2, col: 1 });
    expect(fromSouth.visited.has('1,1,0')).toBe(true);
    // exterior IS reachable via wrap-around through the north neighbor.
    expect(fromSouth.visited.has('1,1,1')).toBe(true);
  });

  it('isolating exterior — pad only those neighbors that touch interior, not exterior', () => {
    // To verify exterior cannot be entered from the south neighbor directly,
    // place a neighbor only at south. Exterior doesn't touch south, so
    // entering from south can ONLY land in interior. Without the wrap-around
    // path through other neighbors, exterior stays unreachable.
    const cells: CellGrid = [
      [null, null, null],
      [null, { segments: [interior, exterior], interiorEdges: [interiorEdge] }, null],
      [null, {}, null],
    ];
    const { visited } = traverse(cells, { row: 2, col: 1 });
    expect(visited.has('1,1,0')).toBe(true); // interior reachable from south
    expect(visited.has('1,1,1')).toBe(false); // exterior isolated by wall + no alt path
  });

  it('exterior reaches its own corner-side neighbors (north and west) without crossing interior', () => {
    // Put neighbors only at north and west of the trim cell. Start in
    // exterior. Verify both reachable; interior unreachable (wall blocks
    // chord, and there's no path back from those unsplit neighbors that
    // routes around to interior since their other borders are null cells).
    const cells: CellGrid = [
      [null, {}, null],
      [{}, { segments: [interior, exterior], interiorEdges: [interiorEdge] }, null],
      [null, null, null],
    ];
    const { visited } = traverse(cells, { row: 1, col: 1, segmentIndex: 1 });
    expect(visited.has('1,1,1')).toBe(true); // exterior (start)
    expect(visited.has('0,1,0')).toBe(true); // north neighbor reached via exterior
    expect(visited.has('1,0,0')).toBe(true); // west neighbor reached via exterior
    // Wrap-around: north neighbor (0,1) south border [0,1] overlaps interior's
    // [0.4, 1] too — so interior IS reachable through that path. Wall only
    // blocks the direct intra-cell crossing.
    expect(visited.has('1,1,0')).toBe(true);
  });

  it('open trim (wall=null on interior edge) still blocks — chords are walls regardless of wall flag', () => {
    // Open vs closed trim differs only in whether the exterior segment is
    // voided; functionally the chord is always a wall. So `wall: null` on a
    // chord interior edge does NOT connect interior and exterior.
    const openCells: CellGrid = [
      [
        {
          segments: [interior, exterior],
          interiorEdges: [{ ...interiorEdge, wall: null }],
        },
      ],
    ];
    const { visited } = traverse(openCells, { row: 0, col: 0, segmentIndex: 0 });
    expect(visited.size).toBe(1);
  });

  it('voided exterior is unreachable from interior or its neighbors', () => {
    const voidedExterior: Cell = {
      segments: [interior, { ...exterior, voided: true }],
      interiorEdges: [interiorEdge],
    };
    const cells: CellGrid = [
      [{}, {}, {}],
      [{}, voidedExterior, {}],
      [{}, {}, {}],
    ];
    const { visited } = traverse(cells, { row: 2, col: 1 });
    // Interior reachable; exterior voided → never visited.
    expect(visited.has('1,1,0')).toBe(true);
    expect(visited.has('1,1,1')).toBe(false);
  });
});

describe('chord-end sliver across cell-corner joints', () => {
  // Regression test for the curve-circle leak: two trim cells whose chord
  // polylines line up at a shared cell corner (within CHORD_JOINT_EPS) but
  // not exactly. The polygon for the cell whose chord starts inside the
  // border has a tiny sliver of border between corner and chord-start. BFS
  // would leak through this sliver into the unsplit cell above without the
  // chord-end sliver guard.
  //
  // Layout: row 1 has two horizontally-adjacent trim cells. Row 0 is unsplit
  // floor (outside the conceptual circle). Each trim's interior segment
  // (s0) sits at the bottom of its cell.
  //
  //   col:    0          1
  //   r=0  [unsplit ] [unsplit ]
  //   r=1  [chord  ↘] [↗ chord ]      chord ends at NE corner of (1,0),
  //                                   resumes at (0.04, 0) of (1,1)
  //
  // Without the fix: BFS from (1,0).s0 reaches (0,1) via (1,1).s0's tiny
  // [0, 0.04] north sliver. With the fix: that sliver is treated as wall.
  it('blocks BFS through the sliver between two cells whose chord ends meet at a corner', () => {
    // (1,0): chord from (0, 0.5) on west to (1, 0) at NE corner.
    //   s0 (interior, SE-of-chord): big region — full S, full E, partial W.
    //   s1 (NE corner cut-off): tiny — full N, partial W.
    const leftCell: Cell = {
      segments: [
        {
          id: 's0',
          polygon: [
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0.5],
            [1, 0], // chord direct to NE corner
          ],
        },
        {
          id: 's1',
          polygon: [
            [1, 0],
            [0, 0],
            [0, 0.5],
            [1, 0],
          ],
        },
      ],
      interiorEdges: [
        {
          vertices: [
            [0, 0.5],
            [1, 0],
          ],
          wall: null,
          between: [0, 1],
        },
      ],
    };
    // (1,1): chord from (0.04, 0) on near-NW north to (1, 0.5) on east.
    //   s0 (interior, SE-of-chord): big region — full S, full W, partial E.
    //   s1 (NW corner cut-off): tiny — sliver of N [0, 0.04], chord starts at 0.04.
    const rightCell: Cell = {
      segments: [
        {
          id: 's0',
          polygon: [
            [1, 0.5],
            [1, 1],
            [0, 1],
            [0, 0],
            [0.04, 0],
            [1, 0.5],
          ],
        },
        {
          id: 's1',
          polygon: [
            [1, 0.5],
            [1, 0],
            [0.04, 0],
            [1, 0.5],
          ],
        },
      ],
      interiorEdges: [
        {
          vertices: [
            [0.04, 0],
            [1, 0.5],
          ],
          wall: null,
          between: [0, 1],
        },
      ],
    };
    const cells: CellGrid = [
      [{}, {}],
      [leftCell, rightCell],
    ];

    // Start in the right cell's interior (s0) — the inside of the conceptual
    // circle. BFS must NOT reach the unsplit cells above (0,0)/(0,1), and
    // must NOT reach either cell's s1.
    const { visited } = traverse(cells, { row: 1, col: 1, segmentIndex: 0 });
    expect(visited.has('1,1,0')).toBe(true);
    expect(visited.has('1,0,0')).toBe(true); // can reach via shared east-west border (s0 ↔ s0)
    expect(visited.has('1,1,1')).toBe(false); // chord wall blocks intra-cell
    expect(visited.has('1,0,1')).toBe(false); // chord wall blocks intra-cell
    expect(visited.has('0,0,0')).toBe(false); // sliver guard blocks leak
    expect(visited.has('0,1,0')).toBe(false); // sliver guard blocks leak
  });
});
