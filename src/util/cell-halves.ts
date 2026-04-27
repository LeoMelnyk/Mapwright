// Half-cell geometry and weather-assignment helpers.
//
// A cell's "halves" are an alias on top of segments: every segment in a
// split cell maps to a stable half-key (`'ne'`/`'sw'`/`'nw'`/`'se'` for
// diagonals, `'interior'`/`'exterior'` for arc trims). The half-key
// vocabulary is preserved so the editor API surface that targets halves
// (weather assignments, hit-testing during paint) keeps the same shape;
// internally everything routes through `getSegments` / `spliceSegments`.
//
// Storage rule: per-segment `weatherGroupId` lives on `cell.segments[i]`.
// There is no `cell.weatherGroupId` or `cell.weatherHalves` anymore.
//
// Coordinate conventions:
//   - hitTestHalf uses cell-local [0..1] coords: (lx=col-axis, ly=row-axis).
//   - All polygons are stored as [x, y] = [col-axis, row-axis], both in [0..1].

import type { Cell, CellHalfKey } from '../types.js';
import {
  getInteriorEdges,
  getSegmentIndexAt,
  getSegments,
  halfKeyToSegmentIndex,
  isChordEdge,
  segmentIndexToHalfKey,
  spliceSegments,
  traceSegment,
} from './cell-segments.js';

const EPS = 1e-9;

/** Detect whether an interior-edge polyline is a diagonal chord and which one. */
function diagonalDirOfEdge(verts: number[][]): 'nw-se' | 'ne-sw' | null {
  if (verts.length < 2) return null;
  const a = verts[0]!;
  const b = verts[verts.length - 1]!;
  const matchPair = (p: number[], q: number[], px: number, py: number, qx: number, qy: number): boolean =>
    Math.abs(p[0]! - px) < EPS &&
    Math.abs(p[1]! - py) < EPS &&
    Math.abs(q[0]! - qx) < EPS &&
    Math.abs(q[1]! - qy) < EPS;
  if (matchPair(a, b, 0, 0, 1, 1) || matchPair(b, a, 0, 0, 1, 1)) return 'nw-se';
  if (matchPair(a, b, 1, 0, 0, 1) || matchPair(b, a, 1, 0, 0, 1)) return 'ne-sw';
  return null;
}

/** Returns the ordered list of half-keys that exist for this cell. */
export function getCellHalves(cell: Cell | null | undefined): CellHalfKey[] {
  if (!cell) return [];
  const edges = getInteriorEdges(cell);
  if (edges.length === 0) return ['full'];
  const ie = edges[0]!;
  const diag = diagonalDirOfEdge(ie.vertices);
  if (diag === 'nw-se') return ['ne', 'sw'];
  if (diag === 'ne-sw') return ['nw', 'se'];
  // Chord/arc trim — anything that isn't a recognized straight diagonal.
  if (isChordEdge(ie)) return ['interior', 'exterior'];
  return ['full'];
}

/**
 * Classify a point in cell-local coords (lx, ly ∈ [0..1]) to the half it
 * falls in. For unsplit cells always returns 'full'.
 */
export function hitTestHalf(cell: Cell | null | undefined, lx: number, ly: number): CellHalfKey {
  if (!cell) return 'full';
  const segIdx = getSegmentIndexAt(cell, lx, ly);
  if (segIdx < 0) return 'full';
  return segmentIndexToHalfKey(cell, segIdx);
}

/**
 * Appends the clip path for a single half onto `ctx`'s current path and
 * returns the fill rule that should be used by the caller's `fill()` / `clip()`.
 *
 * The caller is responsible for `ctx.beginPath()` before and
 * `ctx.clip(rule)` / `ctx.fill(rule)` after. When unioning multiple halves,
 * the caller should pick `'evenodd'` if any contributing half returned it.
 */
export function halfClip(
  ctx: CanvasRenderingContext2D,
  cell: Cell,
  halfKey: CellHalfKey,
  px: number,
  py: number,
  cellPx: number,
): 'nonzero' | 'evenodd' {
  if (halfKey === 'full') {
    // Unsplit cell — draw the full square.
    ctx.rect(px, py, cellPx, cellPx);
    return 'nonzero';
  }
  const segments = getSegments(cell);
  const idx = halfKeyToSegmentIndex(cell, halfKey);
  const seg = segments[idx];
  if (!seg) {
    // Half-key didn't apply — fall through to a full-cell rect so the caller
    // doesn't end up with an empty path that produces unexpected fills.
    ctx.rect(px, py, cellPx, cellPx);
    return 'nonzero';
  }
  traceSegment(ctx, seg, px, py, cellPx);
  return 'nonzero';
}

/**
 * Traces a right-triangle path whose three vertices include the named
 * corner (plus the two adjacent cell corners along the diagonal). Passing
 * `'ne'` draws the NE triangle (top-left, top-right, bottom-right) — the
 * half of a nw-se-split cell that contains the NE corner.
 *
 * Same geometry as `_traceDiagVoidTriangle` in
 * `player/player-canvas-fog.ts` — duplicated here (20 lines of pure math)
 * to keep `src/util/` free of any `src/player/` dependency. The "void"
 * naming there reflects fog's use (paint the unrevealed side); here we
 * use it to paint the solid half of a weather-split cell. Geometry is
 * identical.
 */
export function traceCornerTriangle(
  ctx: CanvasRenderingContext2D,
  cornerKey: string,
  px: number,
  py: number,
  size: number,
): void {
  const tl_x = px,
    tl_y = py;
  const tr_x = px + size,
    tr_y = py;
  const bl_x = px,
    bl_y = py + size;
  const br_x = px + size,
    br_y = py + size;
  switch (cornerKey) {
    case 'nw':
      ctx.moveTo(tl_x, tl_y);
      ctx.lineTo(tr_x, tr_y);
      ctx.lineTo(bl_x, bl_y);
      break;
    case 'ne':
      ctx.moveTo(tl_x, tl_y);
      ctx.lineTo(tr_x, tr_y);
      ctx.lineTo(br_x, br_y);
      break;
    case 'sw':
      ctx.moveTo(tl_x, tl_y);
      ctx.lineTo(bl_x, bl_y);
      ctx.lineTo(br_x, br_y);
      break;
    case 'se':
      ctx.moveTo(tr_x, tr_y);
      ctx.lineTo(bl_x, bl_y);
      ctx.lineTo(br_x, br_y);
      break;
    default:
      return;
  }
  ctx.closePath();
}

export function tracePolygon(
  ctx: CanvasRenderingContext2D,
  poly: number[][],
  px: number,
  py: number,
  cellPx: number,
): void {
  ctx.moveTo(px + poly[0]![0]! * cellPx, py + poly[0]![1]! * cellPx);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(px + poly[i]![0]! * cellPx, py + poly[i]![1]! * cellPx);
  }
  ctx.closePath();
}

// ── Weather assignment read/write ──────────────────────────────────────────

/**
 * Reads the weather group assigned to a specific half of a cell. Returns
 * `undefined` when no group is assigned. Routes through segments —
 * `weatherGroupId` lives on `cell.segments[i]`.
 */
export function getCellWeatherHalf(cell: Cell | null | undefined, halfKey: CellHalfKey): string | undefined {
  if (!cell) return undefined;
  const segs = getSegments(cell);
  if (halfKey === 'full') {
    // For unsplit cells we report segment 0's group. For split cells the
    // 'full' key isn't a valid storage target — return undefined.
    if (segs.length === 1) return segs[0]?.weatherGroupId;
    return undefined;
  }
  const idx = halfKeyToSegmentIndex(cell, halfKey);
  return segs[idx]?.weatherGroupId;
}

/**
 * Writes the weather group for a specific half. Pass `null` to clear.
 *
 * Storage rule: stores `weatherGroupId` on the matching `cell.segments[i]`
 * via `spliceSegments`. Unsplit cells write to segment 0; split cells map
 * the half-key to its segment index. Writes to `'full'` on a split cell
 * are dropped (no canonical storage location).
 */
export function setCellWeatherHalf(cell: Cell, halfKey: CellHalfKey, groupId: string | null): void {
  const halves = getCellHalves(cell);
  const isSplit = halves[0] !== 'full';

  if (!isSplit) {
    spliceSegments(cell, { kind: 'setSegmentWeatherGroup', segmentIndex: 0, weatherGroupId: groupId });
    return;
  }

  // Split cell. Drop writes to 'full' or to a half-key that doesn't exist.
  if (halfKey === 'full' || !halves.includes(halfKey)) return;

  const idx = halfKeyToSegmentIndex(cell, halfKey);
  spliceSegments(cell, { kind: 'setSegmentWeatherGroup', segmentIndex: idx, weatherGroupId: groupId });
}

/**
 * Iterate over every weather assignment on a cell. Yields the half-key (for
 * callers that work in halfKey vocabulary), the group id, AND the segment
 * index — the segment index is the authoritative identifier for downstream
 * clipping / drawing. Callers should prefer the segment index for any path
 * that round-trips back to a polygon, to avoid `halfKey → segIdx`
 * translation drops on ambiguous split-types.
 */
export function forEachCellWeatherAssignment(
  cell: Cell | null | undefined,
  fn: (halfKey: CellHalfKey, groupId: string, segmentIndex: number) => void,
): void {
  if (!cell) return;
  const segs = getSegments(cell);
  for (let i = 0; i < segs.length; i++) {
    const gid = segs[i]?.weatherGroupId;
    if (!gid) continue;
    fn(segmentIndexToHalfKey(cell, i), gid, i);
  }
}

/**
 * True if the cell has any segment assigned to `groupId`. Used by lightning
 * strike eligibility and similar "is this cell in the group at all" checks.
 */
export function cellHasGroup(cell: Cell | null | undefined, groupId: string): boolean {
  if (!cell) return false;
  for (const seg of getSegments(cell)) {
    if (seg.weatherGroupId === groupId) return true;
  }
  return false;
}
