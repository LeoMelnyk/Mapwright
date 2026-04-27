// Polygon-based cell sub-region model. `cell.segments` is the
// authoritative storage for floor partitions (diagonal walls, trim arcs,
// per-half textures); legacy single-cell texture / diagonal / trim fields
// are converted on load by `migrateCellsToSegments` in `migrate-segments.ts`
// and never appear on a runtime cell.
//
// Coordinate convention:
//   - All polygons are in cell-local [0..1] coordinates as [x, y] pairs,
//     where x is the col-axis and y is the row-axis. Same convention as
//     legacy `trimClip`. (0,0) is the cell's NW corner; (1,1) is the SE
//     corner. The four cardinal sides:
//       - north  (top)    : y = 0, x ∈ [0..1]
//       - south  (bottom) : y = 1, x ∈ [0..1]
//       - west   (left)   : x = 0, y ∈ [0..1]
//       - east   (right)  : x = 1, y ∈ [0..1]
//   - hitTest accepts (lx, ly) ∈ [0..1] in the same convention.
//   - The PIP algorithm in `polygon.ts` is orientation-symmetric, so we can
//     pass `[x, y]` polygons directly with `(lx, ly)` as the test point.

import type { Cell, CellHalfKey, EdgeValue, InteriorEdge, Segment } from '../types.js';
import { pointInPolygon } from './polygon.js';
import { tracePolygon } from './cell-halves.js';

// ── Constants ──────────────────────────────────────────────────────────────

const EPS = 1e-9;

/** Polygon for the implicit full-cell segment. CCW from NW. */
const FULL_POLYGON: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

// ── Public read API ────────────────────────────────────────────────────────

/**
 * Always returns ≥ 1 segment for a non-null cell. Returns the cell's
 * authoritative `segments` array when present; otherwise synthesizes a
 * single implicit full-cell segment.
 *
 * Note: legacy cells (pre-segment shape) are converted to authoritative
 * segments at load time by `migrateCellsToSegments`. Code reading cells
 * from `state.dungeon.cells` always sees segment-shape data.
 */
export function getSegments(cell: Cell | null | undefined): Segment[] {
  if (!cell) return [];
  if (cell.segments && cell.segments.length > 0) return cell.segments;
  return [{ id: 's0', polygon: cloneFullPolygon() }];
}

/**
 * Returns the cell's interior-edge list. Empty when the cell is unsplit.
 * Boundaries between sibling segments only — cardinal walls live on
 * `cell.north` / etc.
 */
export function getInteriorEdges(cell: Cell | null | undefined): InteriorEdge[] {
  if (!cell) return [];
  if (cell.interiorEdges && cell.interiorEdges.length > 0) return cell.interiorEdges;
  return [];
}

export function isCellSplit(cell: Cell | null | undefined): boolean {
  if (!cell) return false;
  return !!cell.segments && cell.segments.length > 1;
}

/**
 * True if this interior edge represents a chord/arc boundary that should be
 * rendered by stroking its `vertices` polyline directly.
 *
 * Derived geometrically: a straight corner-to-corner diagonal is exactly
 * 2 vertices at opposite unit-square corners (`(0,0)↔(1,1)` or `(1,0)↔(0,1)`).
 * Anything else — denser polylines, chord endpoints landing mid-side — is
 * a chord. This avoids load-bearing dependence on the optional `arc`
 * metadata field, which only carries smooth-curve geometric hints
 * (centerR/radius/corner) when those happen to be known.
 */
export function isChordEdge(ie: InteriorEdge): boolean {
  if (ie.vertices.length !== 2) return true;
  const a = ie.vertices[0]!;
  const b = ie.vertices[1]!;
  const isCorner = (x: number, y: number): boolean =>
    (Math.abs(x) < EPS || Math.abs(x - 1) < EPS) && (Math.abs(y) < EPS || Math.abs(y - 1) < EPS);
  if (!isCorner(a[0]!, a[1]!) || !isCorner(b[0]!, b[1]!)) return true;
  // Both endpoints at corners — straight diagonal only if opposite corners
  // (sharing neither x nor y). Adjacent-corner edges (along a cell border)
  // shouldn't exist as interior edges, but treat them as chord-shaped to be safe.
  const sameX = Math.abs(a[0]! - b[0]!) < EPS;
  const sameY = Math.abs(a[1]! - b[1]!) < EPS;
  return sameX || sameY;
}

/**
 * True if the cell has a chord/arc interior edge (its first interior edge
 * is a chord, not a straight corner-to-corner diagonal). This is the
 * "is this a trim cell?" discriminator most consumers want.
 */
export function cellHasChordEdge(cell: Cell | null | undefined): boolean {
  if (!cell) return false;
  const ie = getInteriorEdges(cell)[0];
  return ie != null && isChordEdge(ie);
}

/**
 * For a chord interior edge whose endpoints lie on two different cell
 * borders, return which corner the chord cuts off (`'nw' | 'ne' | 'sw' | 'se'`).
 * Returns null when the chord doesn't run between two distinct borders
 * (e.g. both endpoints on the same side, or a non-corner chord).
 *
 * Used by the player fog classifier so it doesn't have to depend on the
 * optional `arc.corner` metadata field — same answer derived from the
 * polyline geometry the migration always populates.
 *
 * Border identity:
 *   y ≈ 0 → north,  y ≈ 1 → south
 *   x ≈ 0 → west,   x ≈ 1 → east
 *
 * The corner is the one bounded by the two touched sides.
 */
export function getChordCorner(ie: InteriorEdge): 'nw' | 'ne' | 'sw' | 'se' | null {
  const verts = ie.vertices;
  if (verts.length < 2) return null;
  const a = verts[0]!;
  const b = verts[verts.length - 1]!;
  const sideOf = (x: number, y: number): 'n' | 's' | 'w' | 'e' | null => {
    if (Math.abs(y) < EPS) return 'n';
    if (Math.abs(y - 1) < EPS) return 's';
    if (Math.abs(x) < EPS) return 'w';
    if (Math.abs(x - 1) < EPS) return 'e';
    return null;
  };
  const sa = sideOf(a[0]!, a[1]!);
  const sb = sideOf(b[0]!, b[1]!);
  if (!sa || !sb || sa === sb) return null;
  const ns = sa === 'n' || sb === 'n' ? 'n' : sa === 's' || sb === 's' ? 's' : null;
  const we = sa === 'w' || sb === 'w' ? 'w' : sa === 'e' || sb === 'e' ? 'e' : null;
  if (!ns || !we) return null;
  return `${ns}${we}`;
}

/**
 * Hit-test cell-local coords (lx, ly) ∈ [0..1] to a segment. Returns the
 * first segment whose polygon contains the point. For an unsplit cell
 * always returns the implicit full segment (never null when cell is set).
 * Returns null only when the point falls in a gap (forbidden in P3
 * authoritative shape, but possible in malformed Phase-1 data).
 */
export function getSegmentAt(cell: Cell | null | undefined, lx: number, ly: number): Segment | null {
  if (!cell) return null;
  const segments = getSegments(cell);
  for (const seg of segments) {
    if (pointInPolygon(lx, ly, seg.polygon)) return seg;
  }
  return null;
}

/**
 * Same as {@link getSegmentAt} but returns the index. -1 when in a gap.
 * For an unsplit cell always returns 0.
 */
export function getSegmentIndexAt(cell: Cell | null | undefined, lx: number, ly: number): number {
  if (!cell) return -1;
  const segments = getSegments(cell);
  for (let i = 0; i < segments.length; i++) {
    if (pointInPolygon(lx, ly, segments[i]!.polygon)) return i;
  }
  return -1;
}

/**
 * Returns the index of the segment whose polygon has an edge on the given
 * cardinal side of the cell. For unsplit cells this is always 0. For
 * diagonal cells this picks the half that actually borders that side
 * (NE for `nw-se` north/east, SW for `nw-se` south/west, etc.).
 *
 * Used by the texture-blend topology so neighbors on each cardinal edge
 * see the texture of the segment that actually faces them — without this,
 * a diagonal cell would bleed its primary half's texture across the
 * diagonal wall to neighbors that only border the secondary half.
 */
export function segmentIndexOnBorder(cell: Cell | null | undefined, side: 'north' | 'south' | 'east' | 'west'): number {
  const segments = getSegments(cell);
  if (segments.length <= 1) return 0;
  for (let i = 0; i < segments.length; i++) {
    const poly = segments[i]!.polygon;
    const n = poly.length;
    for (let j = 0; j < n; j++) {
      const a = poly[j]!;
      const b = poly[(j + 1) % n]!;
      if (polygonEdgeLiesOnSide(a, b, side)) return i;
    }
  }
  return 0;
}

function polygonEdgeLiesOnSide(a: number[], b: number[], side: 'north' | 'south' | 'east' | 'west'): boolean {
  switch (side) {
    case 'north':
      return Math.abs(a[1]!) < EPS && Math.abs(b[1]!) < EPS;
    case 'south':
      return Math.abs(a[1]! - 1) < EPS && Math.abs(b[1]! - 1) < EPS;
    case 'west':
      return Math.abs(a[0]!) < EPS && Math.abs(b[0]!) < EPS;
    case 'east':
      return Math.abs(a[0]! - 1) < EPS && Math.abs(b[0]! - 1) < EPS;
  }
}

/**
 * Returns the index of the segment containing the given cell corner, or
 * `null` when the corner lies on an interior edge endpoint (i.e., on the
 * boundary between two segments). Diagonals connect opposite corners, so
 * those two corners come back ambiguous; chord/arc trims end mid-side, so
 * none of the corners are ambiguous.
 *
 * Used by texture-corner blending: a corner-fan should pick the texture of
 * the segment that owns that corner, and skip when the corner sits exactly
 * between two segments.
 */
export function segmentIndexAtCorner(cell: Cell | null | undefined, corner: 'nw' | 'ne' | 'sw' | 'se'): number | null {
  if (!cell) return null;
  const segments = getSegments(cell);
  if (segments.length <= 1) return 0;

  const cx = corner === 'ne' || corner === 'se' ? 1 : 0;
  const cy = corner === 'sw' || corner === 'se' ? 1 : 0;

  // Ambiguous when the corner is an endpoint of any interior edge.
  // Diagonals: endpoints are opposite cell corners. Chords: endpoints are
  // mid-side, so this never fires.
  for (const ie of getInteriorEdges(cell)) {
    const verts = ie.vertices;
    if (verts.length < 2) continue;
    const first = verts[0]!;
    const last = verts[verts.length - 1]!;
    if (Math.abs(first[0]! - cx) < EPS && Math.abs(first[1]! - cy) < EPS) return null;
    if (Math.abs(last[0]! - cx) < EPS && Math.abs(last[1]! - cy) < EPS) return null;
  }

  // Hit-test slightly inside the corner to avoid vertex-on-vertex
  // ambiguity in the ray-cast PIP.
  const inset = 1e-3;
  const ix = corner === 'ne' || corner === 'se' ? 1 - inset : inset;
  const iy = corner === 'sw' || corner === 'se' ? 1 - inset : inset;
  for (let i = 0; i < segments.length; i++) {
    if (pointInPolygon(ix, iy, segments[i]!.polygon)) return i;
  }
  return null;
}

/**
 * Trace a segment's polygon path onto `ctx`. Caller handles
 * `ctx.beginPath()` before and `ctx.fill()`/`ctx.clip()` after.
 */
export function traceSegment(
  ctx: CanvasRenderingContext2D,
  segment: Segment,
  px: number,
  py: number,
  cellPx: number,
): void {
  tracePolygon(ctx, segment.polygon, px, py, cellPx);
}

/** Convenience: trace + clip the current path to a segment. */
export function clipToSegment(
  ctx: CanvasRenderingContext2D,
  segment: Segment,
  px: number,
  py: number,
  cellPx: number,
): void {
  ctx.beginPath();
  traceSegment(ctx, segment, px, py, cellPx);
  ctx.clip();
}

// ── Polygon builders ───────────────────────────────────────────────────────

/**
 * Canonical 2-segment partition for a diagonal-wall cell.
 *
 * `nw-se` diagonal runs from (0,0) → (1,1):
 *   - s0 = SW triangle [(0,0), (1,1), (0,1)].
 *   - s1 = NE triangle [(0,0), (1,0), (1,1)] — the "primary" half.
 *   - Interior edge along (0,0) → (1,1).
 *
 * `ne-sw` diagonal runs from (1,0) → (0,1):
 *   - s0 = SE triangle [(1,0), (1,1), (0,1)].
 *   - s1 = NW triangle [(0,0), (1,0), (0,1)] — the "primary" half.
 *   - Interior edge along (1,0) → (0,1).
 */
export function diagonalSegments(diag: 'nw-se' | 'ne-sw'): {
  segments: [Segment, Segment];
  interiorEdge: InteriorEdge;
} {
  if (diag === 'nw-se') {
    const sw: Segment = {
      id: 's0',
      polygon: [
        [0, 0],
        [1, 1],
        [0, 1],
      ],
    };
    const ne: Segment = {
      id: 's1',
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    };
    const interiorEdge: InteriorEdge = {
      vertices: [
        [0, 0],
        [1, 1],
      ],
      wall: 'w',
      between: [0, 1],
    };
    return { segments: [sw, ne], interiorEdge };
  }
  // 'ne-sw'
  const se: Segment = {
    id: 's0',
    polygon: [
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  };
  const nw: Segment = {
    id: 's1',
    polygon: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
  };
  const interiorEdge: InteriorEdge = {
    vertices: [
      [1, 0],
      [0, 1],
    ],
    wall: 'w',
    between: [0, 1],
  };
  return { segments: [se, nw], interiorEdge };
}

/**
 * 2-segment partition for a trim-arc cell.
 *
 * - s0 = interior (the polygon defined by `trimClip`).
 * - s1 = exterior (the chord-cut piece on the opposite side of the trim arc).
 * - Interior edge runs along the chord/arc boundary; wall = 'w' for closed
 *   trims, null for open trims (`openExterior`).
 *
 * Both polygons are explicit chord-cut shapes that tile [0,1]^2. Computed
 * from the trimClip vertex order: trimClip lists the chord-end-A, walks the
 * cell perimeter through some corners to chord-end-B, then returns through
 * the chord interior. Exterior takes the complementary perimeter walk
 * through the corners trimClip skipped, plus the same chord interior.
 */
export function trimSegments(
  trimClip: number[][],
  openExterior: boolean,
  invisible: boolean = false,
): { segments: [Segment, Segment]; interiorEdge: InteriorEdge } {
  const { interior, exterior, chord } = computeTrimChordPartition(trimClip);
  return {
    segments: [
      { id: 's0', polygon: interior },
      { id: 's1', polygon: exterior },
    ],
    interiorEdge: {
      vertices: chord,
      wall: openExterior ? null : invisible ? 'iw' : 'w',
      between: [0, 1],
    },
  };
}

// ── Texture writes ────────────────────────────────────────────────────────

/**
 * Write a texture onto a specific segment of a cell. Routes through
 * `spliceSegments` so `cell.segments` is materialized lazily on first write
 * (via `ensureSegmentsForMutation`).
 *
 * Pass `textureId === null` to clear the segment's texture.
 */
export function writeSegmentTexture(
  cell: Cell,
  segmentIndex: number,
  textureId: string | null,
  opacity?: number,
): void {
  spliceSegments(cell, {
    kind: 'setSegmentTexture',
    segmentIndex: Math.max(0, segmentIndex),
    texture: textureId ?? undefined,
    textureOpacity: opacity,
  });
}

/**
 * Returns the cell's "primary" texture id — the texture on the segment most
 * users would think of as "the cell's main texture": the room-side segment
 * for trim arcs (interior), the NE/NW triangle for diagonal-walled cells,
 * or the full segment for unsplit cells.
 *
 * Used by render-pass code (blend topology, lighting normals) that needs
 * "the cell's texture" as a single string per cell.
 */
export function getCellPrimaryTexture(cell: Cell): string | undefined {
  const idx = primaryTextureSegmentIndex(cell);
  return getSegments(cell)[idx]?.texture;
}

/**
 * The segment index of the "primary" half — the natural target when a caller
 * says "set this cell's texture" without specifying a segment.
 *
 *   Unsplit / trim arc: 0 (full segment / interior segment).
 *   Diagonals (nw-se / ne-sw): 1 (NE / NW triangle).
 */
export function primaryTextureSegmentIndex(cell: Cell): number {
  const kind = detectSplitType(cell);
  if (kind === 'nw-se' || kind === 'ne-sw') return 1;
  return 0;
}

// ── Half-key ↔ segment index translation ──────────────────────────────────
//
// The half-key vocabulary (`'ne'`/`'sw'`/`'nw'`/`'se'`/`'interior'`/
// `'exterior'`) is preserved on the public API surface even though storage
// is now segment-indexed. These helpers translate between the two by
// inspecting the cell's interior edge.

/**
 * Inspect a cell's first interior edge to figure out what kind of split it
 * encodes: a diagonal (and which one) or a chord/arc trim. Returns `null`
 * for unsplit cells.
 *
 * Discrimination is purely geometric (matches `isChordEdge`): a 2-vertex
 * edge at opposite unit-square corners is a diagonal; anything else is a
 * chord. The optional `arc` metadata field is not consulted, so trim cells
 * migrated from legacy data without `trimRound`/`trimArc*` (e.g.
 * island.mapwright) still classify correctly as `'arc'`.
 */
function detectSplitType(cell: Cell | null | undefined): 'nw-se' | 'ne-sw' | 'arc' | null {
  if (!cell) return null;
  const edges = getInteriorEdges(cell);
  if (edges.length === 0) return null;
  const ie = edges[0]!;
  const verts = ie.vertices;
  if (verts.length < 2) return null;
  if (verts.length === 2) {
    const a = verts[0]!;
    const b = verts[1]!;
    const matchPair = (px: number, py: number, qx: number, qy: number): boolean =>
      (Math.abs(a[0]! - px) < EPS &&
        Math.abs(a[1]! - py) < EPS &&
        Math.abs(b[0]! - qx) < EPS &&
        Math.abs(b[1]! - qy) < EPS) ||
      (Math.abs(b[0]! - px) < EPS &&
        Math.abs(b[1]! - py) < EPS &&
        Math.abs(a[0]! - qx) < EPS &&
        Math.abs(a[1]! - qy) < EPS);
    if (matchPair(0, 0, 1, 1)) return 'nw-se';
    if (matchPair(1, 0, 0, 1)) return 'ne-sw';
  }
  return 'arc';
}

/**
 * Translate a segment index back to its canonical half-key (`'full'`,
 * `'ne'`, `'sw'`, `'nw'`, `'se'`, `'interior'`, `'exterior'`). Routes
 * through the cell's interior edge to determine split type.
 *
 * Used by callers (weather, paint, fog) that work in the half-key
 * vocabulary on top of segment-indexed storage.
 */
export function segmentIndexToHalfKey(cell: Cell | null | undefined, segmentIndex: number): CellHalfKey {
  const kind = detectSplitType(cell);
  if (kind === 'nw-se') return segmentIndex === 0 ? 'sw' : 'ne';
  if (kind === 'ne-sw') return segmentIndex === 0 ? 'se' : 'nw';
  if (kind === 'arc') return segmentIndex === 0 ? 'interior' : 'exterior';
  return 'full';
}

/**
 * Translate a half-key to its segment index for the cell. Returns 0 for
 * the canonical "primary" half (`'sw'` / `'se'` / `'interior'` / `'full'`),
 * 1 for the secondary. Returns 0 as a fallback when the key doesn't apply
 * to the cell's split type — callers should validate inputs upstream.
 */
export function halfKeyToSegmentIndex(cell: Cell | null | undefined, halfKey: CellHalfKey): number {
  const kind = detectSplitType(cell);
  if (kind === 'nw-se') return halfKey === 'ne' ? 1 : 0;
  if (kind === 'ne-sw') return halfKey === 'nw' ? 1 : 0;
  if (kind === 'arc') return halfKey === 'exterior' ? 1 : 0;
  return 0;
}

// ── Edge classification ────────────────────────────────────────────────────

export type EdgeClassification =
  | { kind: 'border'; side: 'north' | 'south' | 'east' | 'west'; interval: [number, number] }
  | { kind: 'interior'; otherSegmentIndex: number; interiorEdgeIndex: number };

/**
 * Classify a segment's polygon edge as either lying along a cell border (and
 * which side, with the [start,end] interval normalized to ascending order)
 * or as an interior boundary shared with another segment.
 *
 * Edge `i` is the polygon edge from `polygon[i]` to `polygon[(i+1) % n]`.
 *
 * Interior matching uses `cell.interiorEdges`, falling back to synthesized
 * legacy-shape edges via `getInteriorEdges()`. The match is a polyline-pair
 * comparison: an interior edge matches when its endpoints coincide with the
 * polygon edge's endpoints (within EPS, in either order).
 */
export function classifyPolygonEdge(cell: Cell, segIndex: number, edgeIndex: number): EdgeClassification {
  const segments = getSegments(cell);
  const seg = segments[segIndex];
  if (!seg) throw new Error(`classifyPolygonEdge: invalid segIndex ${segIndex}`);
  const n = seg.polygon.length;
  const a = seg.polygon[edgeIndex % n]!;
  const b = seg.polygon[(edgeIndex + 1) % n]!;
  const ax = a[0]!;
  const ay = a[1]!;
  const bx = b[0]!;
  const by = b[1]!;

  // Interior match FIRST. A chord polyline that ends at a cell corner has its
  // last segment lying on a cell border (e.g. (0.958, 0) → (1, 0) for a chord
  // ending at the NE corner). Border-first classification would mark that
  // segment as an open border edge and let BFS leak through the chord-end
  // sliver into an adjacent unsplit cell. Matching against the interior-edge
  // polyline first correctly identifies it as a chord segment.
  const interiorEdges = getInteriorEdges(cell);
  for (let i = 0; i < interiorEdges.length; i++) {
    const ie = interiorEdges[i]!;
    if (!ie.between.includes(segIndex)) continue;
    if (interiorEdgeMatches(ie, [ax, ay], [bx, by])) {
      const other = ie.between[0] === segIndex ? ie.between[1] : ie.between[0];
      return { kind: 'interior', otherSegmentIndex: other, interiorEdgeIndex: i };
    }
  }

  // Border check.
  if (Math.abs(ay) < EPS && Math.abs(by) < EPS) {
    return { kind: 'border', side: 'north', interval: orderInterval(ax, bx) };
  }
  if (Math.abs(ay - 1) < EPS && Math.abs(by - 1) < EPS) {
    return { kind: 'border', side: 'south', interval: orderInterval(ax, bx) };
  }
  if (Math.abs(ax) < EPS && Math.abs(bx) < EPS) {
    return { kind: 'border', side: 'west', interval: orderInterval(ay, by) };
  }
  if (Math.abs(ax - 1) < EPS && Math.abs(bx - 1) < EPS) {
    return { kind: 'border', side: 'east', interval: orderInterval(ay, by) };
  }

  // No matching interior edge and not on any cell border — treat as interior
  // with no neighbor (gap). Should never happen in tile-correct cells; signal
  // by returning an interior classification with `otherSegmentIndex = -1`.
  return { kind: 'interior', otherSegmentIndex: -1, interiorEdgeIndex: -1 };
}

// ── Splice — the only legal segment-mutation entry point ──────────────────

/**
 * A segment-mutation request.
 *
 * The current operations are the ones tools need to drive partition changes
 * end-to-end: replace the partition, set a single segment's voided flag,
 * set a segment's texture, set the wall on an interior edge. Each variant
 * goes through `spliceSegments` so the tile / no-overlap / `between`-index
 * invariants are asserted on every change.
 */
export type SegmentMutation =
  | {
      kind: 'replacePartition';
      segments: Segment[];
      interiorEdges: InteriorEdge[];
    }
  | { kind: 'setSegmentVoided'; segmentIndex: number; voided: boolean }
  | { kind: 'setSegmentTexture'; segmentIndex: number; texture?: string; textureOpacity?: number }
  | { kind: 'setSegmentWeatherGroup'; segmentIndex: number; weatherGroupId: string | null }
  | { kind: 'setInteriorEdgeWall'; interiorEdgeIndex: number; wall: EdgeValue };

/**
 * THE only legal entry point for mutating `cell.segments` /
 * `cell.interiorEdges`. Tools must NOT index into these arrays and write
 * directly — every change routes here so invariants stay enforced.
 *
 * Asserts on the result:
 *   - Every segment polygon has ≥3 vertices, all coords in [0..1].
 *   - Sum of segment polygon areas ≈ 1.0 (they tile the unit square).
 *   - Every `interiorEdge.between` references valid segment indices.
 *   - `interiorEdge.vertices` has ≥2 points.
 *
 * Throws `SpliceInvariantError` (subclass of Error with a `kind` discriminator)
 * on any violation so the calling tool can surface a precise diagnostic.
 */
export class SpliceInvariantError extends Error {
  constructor(
    public readonly invariant: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpliceInvariantError';
  }
}

export function spliceSegments(cell: Cell, mutation: SegmentMutation): void {
  switch (mutation.kind) {
    case 'replacePartition': {
      const { segments, interiorEdges } = mutation;
      assertPartitionInvariants(segments, interiorEdges);
      cell.segments = segments;
      cell.interiorEdges = interiorEdges.length > 0 ? interiorEdges : undefined;
      return;
    }
    case 'setSegmentVoided': {
      const segs = ensureSegmentsForMutation(cell);
      const seg = segs[mutation.segmentIndex];
      if (!seg) {
        throw new SpliceInvariantError(
          'invalidSegmentIndex',
          `setSegmentVoided: segmentIndex ${mutation.segmentIndex} out of range (have ${segs.length})`,
        );
      }
      if (mutation.voided) {
        seg.voided = true;
      } else {
        delete seg.voided;
      }
      return;
    }
    case 'setSegmentTexture': {
      const segs = ensureSegmentsForMutation(cell);
      const seg = segs[mutation.segmentIndex];
      if (!seg) {
        throw new SpliceInvariantError(
          'invalidSegmentIndex',
          `setSegmentTexture: segmentIndex ${mutation.segmentIndex} out of range (have ${segs.length})`,
        );
      }
      if (mutation.texture === undefined) {
        delete seg.texture;
        delete seg.textureOpacity;
      } else {
        seg.texture = mutation.texture;
        if (mutation.textureOpacity !== undefined) seg.textureOpacity = mutation.textureOpacity;
      }
      return;
    }
    case 'setSegmentWeatherGroup': {
      const segs = ensureSegmentsForMutation(cell);
      const seg = segs[mutation.segmentIndex];
      if (!seg) {
        throw new SpliceInvariantError(
          'invalidSegmentIndex',
          `setSegmentWeatherGroup: segmentIndex ${mutation.segmentIndex} out of range (have ${segs.length})`,
        );
      }
      if (mutation.weatherGroupId === null) {
        delete seg.weatherGroupId;
      } else {
        seg.weatherGroupId = mutation.weatherGroupId;
      }
      return;
    }
    case 'setInteriorEdgeWall': {
      if (!cell.interiorEdges?.[mutation.interiorEdgeIndex]) {
        throw new SpliceInvariantError(
          'invalidInteriorEdgeIndex',
          `setInteriorEdgeWall: interiorEdgeIndex ${mutation.interiorEdgeIndex} out of range`,
        );
      }
      cell.interiorEdges[mutation.interiorEdgeIndex]!.wall = mutation.wall;
      return;
    }
  }
}

/**
 * Materialize a writable segments array on the cell so mutations persist.
 * If the cell only had synthesized segments, the synthesis result is frozen
 * onto `cell.segments`.
 */
function ensureSegmentsForMutation(cell: Cell): Segment[] {
  if (cell.segments && cell.segments.length > 0) return cell.segments;
  const synthesized = getSegments(cell);
  // Deep-clone so writes don't surprise other readers that may have cached
  // the synthesized array.
  cell.segments = synthesized.map((s) => ({
    ...s,
    polygon: s.polygon.map((p) => [p[0]!, p[1]!]),
  }));
  return cell.segments;
}

const TILE_AREA_TOLERANCE = 1e-6;

function assertPartitionInvariants(segments: Segment[], interiorEdges: InteriorEdge[]): void {
  if (segments.length < 1) {
    throw new SpliceInvariantError('emptyPartition', 'replacePartition: segments must have at least one entry');
  }
  let totalArea = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!seg.id) {
      throw new SpliceInvariantError('missingId', `segments[${i}] has no id`);
    }
    if (!Array.isArray(seg.polygon) || seg.polygon.length < 3) {
      const len = Array.isArray(seg.polygon) ? seg.polygon.length : 0;
      throw new SpliceInvariantError(
        'malformedPolygon',
        `segments[${i}] (${seg.id}) polygon has ${len} verts; need ≥3`,
      );
    }
    for (let v = 0; v < seg.polygon.length; v++) {
      const pt = seg.polygon[v]!;
      const [x, y] = pt as [number, number];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new SpliceInvariantError('malformedPolygon', `segments[${i}].polygon[${v}] is non-finite`);
      }
      if (
        x < -TILE_AREA_TOLERANCE ||
        x > 1 + TILE_AREA_TOLERANCE ||
        y < -TILE_AREA_TOLERANCE ||
        y > 1 + TILE_AREA_TOLERANCE
      ) {
        throw new SpliceInvariantError(
          'polygonOutOfBounds',
          `segments[${i}].polygon[${v}] = (${x}, ${y}) outside [0..1]²`,
        );
      }
    }
    totalArea += polygonArea(seg.polygon);
  }
  if (Math.abs(totalArea - 1) > TILE_AREA_TOLERANCE) {
    throw new SpliceInvariantError(
      'tileSumMismatch',
      `segments must tile the unit square: total area ${totalArea.toFixed(6)} ≠ 1.0 ± ${TILE_AREA_TOLERANCE}`,
    );
  }

  for (let i = 0; i < interiorEdges.length; i++) {
    const ie = interiorEdges[i]!;
    if (!Array.isArray(ie.vertices) || ie.vertices.length < 2) {
      const len = Array.isArray(ie.vertices) ? ie.vertices.length : 0;
      throw new SpliceInvariantError('malformedInteriorEdge', `interiorEdges[${i}] vertices length ${len}; need ≥2`);
    }
    // ie.between is typed as [number, number] — length and presence are
    // guaranteed by the type system. We only need to validate ranges.
    if (
      ie.between[0] < 0 ||
      ie.between[0] >= segments.length ||
      ie.between[1] < 0 ||
      ie.between[1] >= segments.length ||
      ie.between[0] === ie.between[1]
    ) {
      throw new SpliceInvariantError(
        'invalidBetween',
        `interiorEdges[${i}].between = ${JSON.stringify(ie.between)} invalid (segments=${segments.length})`,
      );
    }
  }
}

function polygonArea(polygon: number[][]): number {
  // Shoelace formula. Result is unsigned (works for any winding order).
  let a = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i]!;
    const [x1, y1] = polygon[(i + 1) % polygon.length]!;
    a += x0! * y1! - x1! * y0!;
  }
  return Math.abs(a) / 2;
}

// ── Internals ──────────────────────────────────────────────────────────────

function cloneFullPolygon(): number[][] {
  return FULL_POLYGON.map((p) => [p[0], p[1]]);
}

function orderInterval(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

function interiorEdgeMatches(ie: InteriorEdge, a: [number, number], b: [number, number]): boolean {
  const verts = ie.vertices;
  if (verts.length < 2) return false;
  // The polyline is composed of (verts.length - 1) segments. Polygon edges
  // are short straight runs that line up with one of those polyline segments,
  // not with the polyline endpoints. Match any segment in either direction.
  for (let i = 0; i < verts.length - 1; i++) {
    const u = verts[i] as [number, number];
    const v = verts[i + 1] as [number, number];
    if (pointsEqual(u, a) && pointsEqual(v, b)) return true;
    if (pointsEqual(u, b) && pointsEqual(v, a)) return true;
  }
  return false;
}

function pointsEqual(p: [number, number], q: [number, number]): boolean {
  return Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;
}

function isOnUnitBorder(x: number, y: number): boolean {
  return Math.abs(x) < EPS || Math.abs(x - 1) < EPS || Math.abs(y) < EPS || Math.abs(y - 1) < EPS;
}

/**
 * Convert a point on the unit-square border to a perimeter parameter t ∈ [0, 4):
 *   - north side (y=0): t = x          ∈ [0, 1)
 *   - east  side (x=1): t = 1 + y      ∈ [1, 2)
 *   - south side (y=1): t = 3 - x      ∈ [2, 3)
 *   - west  side (x=0): t = 4 - y      ∈ [3, 4)
 *
 * Corners take integer values: NW=0, NE=1, SE=2, SW=3.
 *
 * Walking CW around the perimeter increases t (mod 4). Walking CCW decreases.
 */
function paramT(x: number, y: number): number {
  if (Math.abs(y) < EPS) return x;
  if (Math.abs(x - 1) < EPS) return 1 + y;
  if (Math.abs(y - 1) < EPS) return 3 - x;
  return 4 - y;
}

/**
 * Compute interior + exterior + chord polylines from a `trimClip` polygon.
 *
 * trimClip vertex order:
 *   [chord_end_A, ...border_walk_corners..., chord_end_B, ...chord_interior_verts...]
 * with the polygon closing implicitly back to chord_end_A.
 *
 * Algorithm:
 *   1. Detect direction trimClip walks (CW or CCW) by comparing perimeter
 *      parameters of trimClip[0] and trimClip[1].
 *   2. Exterior walks the OPPOSITE direction from A to B around the cell
 *      perimeter, picking up the corners trimClip skipped.
 *   3. Both polygons share the same chord interior vertices (in opposite
 *      orders so each polygon traces a closed boundary).
 */
function computeTrimChordPartition(trimClip: number[][]): {
  interior: number[][];
  exterior: number[][];
  chord: number[][];
} {
  const n = trimClip.length;
  const onBorder = trimClip.map((p) => isOnUnitBorder(p[0]!, p[1]!));
  const firstInterior = onBorder.findIndex((b) => !b);

  // Degenerate case — no chord interior vertices. Return trimClip as
  // interior, full square as exterior, two-point chord between endpoints.
  if (firstInterior < 0 || n < 3) {
    return {
      interior: trimClip.map((p) => [p[0]!, p[1]!]),
      exterior: cloneFullPolygon(),
      chord:
        trimClip.length >= 2
          ? [
              [trimClip[0]![0]!, trimClip[0]![1]!],
              [trimClip[n - 1]![0]!, trimClip[n - 1]![1]!],
            ]
          : [],
    };
  }

  const A: [number, number] = [trimClip[0]![0]!, trimClip[0]![1]!];
  const bIdx = (firstInterior - 1 + n) % n;
  const B: [number, number] = [trimClip[bIdx]![0]!, trimClip[bIdx]![1]!];

  const chordInterior: number[][] = [];
  for (let i = firstInterior; i < n; i++) {
    chordInterior.push([trimClip[i]![0]!, trimClip[i]![1]!]);
  }
  // Chord polyline B → ...interior... → A.
  const chord: number[][] = [[B[0], B[1]], ...chordInterior, [A[0], A[1]]];

  const tA = paramT(A[0], A[1]);
  const tB = paramT(B[0], B[1]);

  // Detect trimClip's perimeter direction. Compare the CW span (A → B going
  // forward) against where trimClip[1] sits.
  const tNext = onBorder[1] ? paramT(trimClip[1]![0]!, trimClip[1]![1]!) : tA;
  const spanCW = (tB - tA + 4) % 4;
  const offsetCW = (tNext - tA + 4) % 4;
  const trimClipGoesCW = offsetCW > 0 && offsetCW < spanCW;

  // Build the four cell corners in CW order (NW, NE, SE, SW at t = 0, 1, 2, 3).
  const corners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  // Exterior walks the opposite direction. Collect corners between A and B
  // along that arc.
  const exteriorCorners: Array<[number, number]> = [];
  if (!trimClipGoesCW) {
    // Exterior walks CW: from A's t, increase t (mod 4) until we hit B.
    let t = tA;
    for (let safety = 0; safety < 8; safety++) {
      const nextCornerT = Math.floor(t + 1 + EPS) % 4; // next integer t > t
      // Compute progress along CW arc.
      const dist = (nextCornerT - tA + 4) % 4;
      const distToB = (tB - tA + 4) % 4;
      if (dist >= distToB) break;
      exteriorCorners.push([corners[nextCornerT]![0], corners[nextCornerT]![1]]);
      t = nextCornerT;
    }
  } else {
    // Exterior walks CCW: from A's t, decrease t (mod 4) until we hit B.
    let t = tA;
    for (let safety = 0; safety < 8; safety++) {
      // Next integer t strictly less than t.
      let nextCornerT = Math.ceil(t - 1 - EPS);
      if (nextCornerT < 0) nextCornerT += 4;
      nextCornerT = ((nextCornerT % 4) + 4) % 4;
      const dist = (tA - nextCornerT + 4) % 4;
      const distToB = (tA - tB + 4) % 4;
      if (dist >= distToB) break;
      exteriorCorners.push([corners[nextCornerT]![0], corners[nextCornerT]![1]]);
      t = nextCornerT;
    }
  }

  const interior: number[][] = trimClip.map((p) => [p[0]!, p[1]!]);
  const exterior: number[][] = [
    [A[0], A[1]],
    ...exteriorCorners.map((c) => [c[0], c[1]]),
    [B[0], B[1]],
    // Chord interior in original order (near-B → near-A). The exterior
    // polygon walks the opposite border path from interior (NW/SW vs NE/SE)
    // but traverses the chord arc in the SAME direction — the chord segments
    // form the shared boundary between the two polygons. Reversing here
    // would make the polygon jump from B to a vertex near A and close back
    // across the cell, producing a self-intersection. (The original test
    // for this routine only had a single chord-interior vertex, so reverse
    // was a silent no-op and the bug stayed latent until a real multi-point
    // arc trim was attempted.)
    ...chordInterior.map((p) => [p[0]!, p[1]!]),
  ];
  return { interior, exterior, chord };
}
