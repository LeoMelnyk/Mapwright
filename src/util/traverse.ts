// Unified BFS for the cell/segment graph. The single replacement for every
// flood-fill / connectivity-walk in the codebase. See plan
// `C:\Users\leonk\.claude\plans\i-want-to-a-sleepy-breeze.md` for the
// motivation and full migration map.
//
// Graph model:
//   - Nodes are (row, col, segmentIndex) tuples — segments, not cells.
//   - Edges between two segments come in two flavors:
//       * INTRA-CELL: two segments of the same cell share an interior edge.
//         The wall flag lives on `cell.interiorEdges[i].wall`.
//       * INTER-CELL: a segment polygon edge runs along a cell border (one
//         of x=0/x=1/y=0/y=1). The neighbor cell across that border has
//         segments; those whose polygons touch the same border with an
//         overlapping interval are candidate neighbors. The wall flag is
//         the cardinal `cell.north`/`south`/`east`/`west`.
//
// Block decisions are configured by `TraverseOptions`. Default behavior
// matches legacy `floodFillRoom` (walls and doors block; windows block;
// invisible walls block; voided segments block; fill does not block).
//
// Phase 1: works on legacy cells via `getSegments()`/`getInteriorEdges()`
// synthesis. Phase 3 reads from authoritative `cell.segments`/`interiorEdges`.

import type { Cell, CellGrid, EdgeValue, Segment } from '../types.js';
import { classifyPolygonEdge, getInteriorEdges, getSegmentIndexAt, getSegments, isChordEdge } from './cell-segments.js';
import { recordFloodStart, recordFloodCell, recordFloodEnd } from './flood-debug.js';

// ── Public types ───────────────────────────────────────────────────────────

export interface TraverseOptions {
  /** Treat doors (`'d'`, `'s'`, `'id'`) as walls. Default true. */
  doorsBlock?: boolean;
  /** Treat windows (`'win'`) as walls. Default true. */
  windowsBlock?: boolean;
  /** Treat invisible walls (`'iw'`) as walls. Default true. */
  invisibleWallsBlock?: boolean;
  /** Treat fluid fill (water/lava/pit) as a barrier. Default false. */
  fillBlocks?: boolean;
  /** Treat voided segments as a barrier. Default true. */
  voidedSegmentsBlock?: boolean;
  /**
   * Skip wall/door/window edge checks entirely — every cell-to-cell border is
   * treated as open regardless of its edge flag. Used by fill-region walks
   * (lava pools, pit clusters) where connectivity is purely cell-adjacency
   * based and walls are irrelevant. Default false.
   */
  ignoreWalls?: boolean;

  rowMin?: number;
  rowMax?: number;
  colMin?: number;
  colMax?: number;

  /**
   * Fired once per visited segment in BFS order.
   * Return `false` to stop traversal early. Any other return continues.
   */
  visit?: (ctx: VisitContext) => void | boolean;

  /**
   * Fired before queuing a candidate neighbor. Return `false` to skip it
   * (without marking visited). Use for caller-defined edge filters beyond
   * the boolean blocks above.
   */
  acceptNeighbor?: (ctx: NeighborContext) => boolean;
}

export interface VisitContext {
  row: number;
  col: number;
  cell: Cell;
  segment: Segment;
  segmentIndex: number;
  /** Source of this visit; null only for the seed segment. */
  enteredVia: {
    fromRow: number;
    fromCol: number;
    fromSegmentIndex: number;
    /** Wall flag on the boundary just crossed (null = open). */
    wall: EdgeValue;
  } | null;
}

export type NeighborContext = VisitContext;

export interface TraverseResult {
  /** Set of `"row,col,segmentIndex"` keys visited, in BFS order of insertion. */
  visited: Set<string>;
  /** Tight bounding box over visited cells, or null if nothing was visited. */
  bounds: { r1: number; c1: number; r2: number; c2: number } | null;
}

export type TraverseStart =
  | { row: number; col: number; segmentIndex?: number }
  | { row: number; col: number; lx: number; ly: number };

// ── Constants ──────────────────────────────────────────────────────────────

const INTERVAL_EPS = 1e-6;
/**
 * Tolerance for matching chord polyline endpoints across cells (in cell-width
 * units). At typical render scales (1 cell ≈ 50 px) this is ~2.5 px — the
 * "couple of pixels off" the user spec calls out. Endpoints within this
 * distance are treated as a single wall continuation joint.
 */
const CHORD_JOINT_EPS = 0.05;

const OPPOSITE_SIDE = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
} as const satisfies Record<Side, Side>;

const SIDE_OFFSETS: Record<Side, [number, number]> = {
  north: [-1, 0],
  south: [1, 0],
  east: [0, 1],
  west: [0, -1],
};

type Side = 'north' | 'south' | 'east' | 'west';

// ── Public API ─────────────────────────────────────────────────────────────

export function traverse(cells: CellGrid, start: TraverseStart, options: TraverseOptions = {}): TraverseResult {
  const visited = new Set<string>();
  let bounds: { r1: number; c1: number; r2: number; c2: number } | null = null;

  recordFloodStart();

  const startSeg = resolveStartSegment(cells, start);
  if (!startSeg) {
    recordFloodEnd();
    return { visited, bounds };
  }

  const { row: sr, col: sc, segmentIndex: si, cell: sCell, segment: sSegment } = startSeg;

  // Reject the start if it's voided and voids block.
  // Reject if the start cell is filled and fill blocks.
  // Reject if outside the row/col bounds.
  if (segmentBlocks(sSegment, options) || cellBlocks(sCell, options) || !inBounds(sr, sc, options)) {
    recordFloodEnd();
    return { visited, bounds };
  }

  const queue: Array<{
    row: number;
    col: number;
    segmentIndex: number;
    cell: Cell;
    segment: Segment;
    enteredVia: VisitContext['enteredVia'];
    depth: number;
  }> = [];

  const seedKey = key(sr, sc, si);
  visited.add(seedKey);
  bounds = { r1: sr, c1: sc, r2: sr, c2: sc };
  queue.push({
    row: sr,
    col: sc,
    segmentIndex: si,
    cell: sCell,
    segment: sSegment,
    enteredVia: null,
    depth: 0,
  });

  while (queue.length > 0) {
    const node = queue.shift()!;

    recordFloodCell(node.row, node.col, node.depth);

    // Fire visit callback.
    if (options.visit) {
      const ctx: VisitContext = {
        row: node.row,
        col: node.col,
        cell: node.cell,
        segment: node.segment,
        segmentIndex: node.segmentIndex,
        enteredVia: node.enteredVia,
      };
      const ret = options.visit(ctx);
      if (ret === false) break;
    }

    // Enumerate neighbors.
    const neighbors = enumerateNeighbors(cells, node.row, node.col, node.segmentIndex, node.cell);
    for (const cand of neighbors) {
      if (!inBounds(cand.row, cand.col, options)) continue;
      if (wallBlocks(cand.wall, options)) continue;
      if (segmentBlocks(cand.segment, options)) continue;
      if (cellBlocks(cand.cell, options)) continue;

      const k = key(cand.row, cand.col, cand.segmentIndex);
      if (visited.has(k)) continue;

      const enteredVia = {
        fromRow: node.row,
        fromCol: node.col,
        fromSegmentIndex: node.segmentIndex,
        wall: cand.wall,
      };

      if (options.acceptNeighbor) {
        const nctx: NeighborContext = {
          row: cand.row,
          col: cand.col,
          cell: cand.cell,
          segment: cand.segment,
          segmentIndex: cand.segmentIndex,
          enteredVia,
        };
        if (!options.acceptNeighbor(nctx)) continue;
      }

      visited.add(k);
      // bounds is non-null here — initialized from the seed before the loop.
      if (cand.row < bounds.r1) bounds.r1 = cand.row;
      if (cand.row > bounds.r2) bounds.r2 = cand.row;
      if (cand.col < bounds.c1) bounds.c1 = cand.col;
      if (cand.col > bounds.c2) bounds.c2 = cand.col;
      queue.push({
        row: cand.row,
        col: cand.col,
        segmentIndex: cand.segmentIndex,
        cell: cand.cell,
        segment: cand.segment,
        enteredVia,
        depth: node.depth + 1,
      });
    }
  }

  recordFloodEnd();
  return { visited, bounds };
}

// ── Internals ──────────────────────────────────────────────────────────────

function key(row: number, col: number, segmentIndex: number): string {
  return `${row},${col},${segmentIndex}`;
}

function resolveStartSegment(
  cells: CellGrid,
  start: TraverseStart,
): { row: number; col: number; segmentIndex: number; cell: Cell; segment: Segment } | null {
  const cell = cells[start.row]?.[start.col];
  if (!cell) return null;
  const segments = getSegments(cell);
  if (segments.length === 0) return null;

  let segmentIndex: number;
  if ('lx' in start) {
    segmentIndex = getSegmentIndexAt(cell, start.lx, start.ly);
    if (segmentIndex < 0) return null;
  } else {
    segmentIndex = start.segmentIndex ?? 0;
    if (segmentIndex < 0 || segmentIndex >= segments.length) return null;
  }
  return { row: start.row, col: start.col, segmentIndex, cell, segment: segments[segmentIndex]! };
}

function inBounds(row: number, col: number, options: TraverseOptions): boolean {
  if (options.rowMin !== undefined && row < options.rowMin) return false;
  if (options.rowMax !== undefined && row > options.rowMax) return false;
  if (options.colMin !== undefined && col < options.colMin) return false;
  if (options.colMax !== undefined && col > options.colMax) return false;
  return true;
}

// Higher = more restrictive when two cells disagree about their shared border.
// `'w'` always wins; doors/windows beat null; among door variants the order is
// arbitrary because they all behave identically under default options.
const WALL_PRIORITY: Record<string, number> = {
  w: 6,
  iw: 5,
  win: 4,
  d: 3,
  s: 2,
  id: 1,
};

function mergeWalls(a: EdgeValue, b: EdgeValue): EdgeValue {
  if (a === undefined || a === null) return b;
  if (b === undefined || b === null) return a;
  return (WALL_PRIORITY[a] ?? 0) >= (WALL_PRIORITY[b] ?? 0) ? a : b;
}

function wallBlocks(wall: EdgeValue, options: TraverseOptions): boolean {
  if (options.ignoreWalls) return false;
  if (wall === undefined || wall === null) return false;
  if (wall === 'w') return true;
  if (wall === 'iw') return options.invisibleWallsBlock !== false;
  if (wall === 'd' || wall === 's' || wall === 'id') return options.doorsBlock !== false;
  // Only 'win' remains after the exhaustion above.
  return options.windowsBlock !== false;
}

function segmentBlocks(segment: Segment, options: TraverseOptions): boolean {
  if (!segment.voided) return false;
  return options.voidedSegmentsBlock !== false;
}

function cellBlocks(cell: Cell, options: TraverseOptions): boolean {
  if (!options.fillBlocks) return false;
  return cell.fill !== undefined;
}

interface NeighborCandidate {
  row: number;
  col: number;
  segmentIndex: number;
  cell: Cell;
  segment: Segment;
  /** Wall flag on the boundary just crossed (null = open). */
  wall: EdgeValue;
}

function enumerateNeighbors(
  cells: CellGrid,
  row: number,
  col: number,
  segmentIndex: number,
  cell: Cell,
): NeighborCandidate[] {
  const out: NeighborCandidate[] = [];
  const segments = getSegments(cell);
  const interiorEdges = getInteriorEdges(cell);

  // Intra-cell: walk every interior edge that touches this segment.
  // Chord interior edges always block traversal regardless of `wall` — the
  // chord's visual presence acts as a wall even when `wall === null` (open
  // trim) and even under `ignoreWalls: true`. Open vs closed trim differs
  // only in whether the exterior segment is voided. Straight diagonals keep
  // their explicit `wall` flag so doors/windows on diagonals still work.
  for (const ie of interiorEdges) {
    const [a, b] = ie.between;
    if (a !== segmentIndex && b !== segmentIndex) continue;
    if (isChordEdge(ie)) continue;
    const otherIndex = a === segmentIndex ? b : a;
    const otherSeg = segments[otherIndex];
    if (!otherSeg) continue;
    out.push({
      row,
      col,
      segmentIndex: otherIndex,
      cell,
      segment: otherSeg,
      wall: ie.wall,
    });
  }

  // Inter-cell: classify each polygon edge of this segment; for border edges,
  // find segments in the neighbor cell whose polygons touch the matching
  // opposite side with an overlapping interval.
  const seg = segments[segmentIndex];
  if (!seg) return out;
  const polyN = seg.polygon.length;
  for (let edgeIndex = 0; edgeIndex < polyN; edgeIndex++) {
    const cls = classifyPolygonEdge(cell, segmentIndex, edgeIndex);
    if (cls.kind !== 'border') continue;
    const { side, interval } = cls;
    // Chord-end sliver guard (source side): if both endpoints of this border
    // edge coincide (within CHORD_JOINT_EPS) with chord polyline endpoints —
    // either of this cell or any cell sharing the absolute corner — the edge
    // is the gap between two chord-wall continuation joints. Treat as wall.
    if (isChordEndSliver(cells, row, col, cell, seg.polygon[edgeIndex]!, seg.polygon[(edgeIndex + 1) % polyN]!)) {
      continue;
    }
    const [dr, dc] = SIDE_OFFSETS[side];
    const nr = row + dr;
    const nc = col + dc;
    const ncell = cells[nr]?.[nc];
    if (!ncell) continue;
    const oppSide = OPPOSITE_SIDE[side];
    // A wall on EITHER side of the shared border blocks the crossing — a
    // door painted only on the neighbor's west still stops a flood reaching
    // it from the east. Pick the more restrictive of the two flags.
    const cardinalWall = mergeWalls(cell[side], ncell[oppSide]);
    const nsegs = getSegments(ncell);
    for (let nsi = 0; nsi < nsegs.length; nsi++) {
      const nseg = nsegs[nsi]!;
      const npolyN = nseg.polygon.length;
      for (let nei = 0; nei < npolyN; nei++) {
        const ncls = classifyPolygonEdge(ncell, nsi, nei);
        if (ncls.kind !== 'border') continue;
        if (ncls.side !== oppSide) continue;
        if (!intervalsOverlap(interval, ncls.interval)) continue;
        // Chord-end sliver guard (neighbor side): the sliver may be on the
        // neighbor's polygon edge instead of the source's — common when the
        // source is an unsplit cell with a single full-border edge and the
        // neighbor is a chord cell whose chord ends near the shared corner.
        if (isChordEndSliver(cells, nr, nc, ncell, nseg.polygon[nei]!, nseg.polygon[(nei + 1) % npolyN]!)) {
          break;
        }
        out.push({
          row: nr,
          col: nc,
          segmentIndex: nsi,
          cell: ncell,
          segment: nseg,
          wall: cardinalWall,
        });
        break; // each neighbor segment counted once per shared border
      }
    }
  }

  return out;
}

function intervalsOverlap(a: [number, number], b: [number, number]): boolean {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return hi - lo > INTERVAL_EPS;
}

/**
 * Returns true iff the polygon edge from `a` to `b` (both in cell-local coords
 * of the cell at `row, col`) is a "chord-end sliver": a stretch of cell border
 * where both endpoints are chord polyline endpoints — either of this cell or
 * any cell sharing the absolute corner. Such slivers are the gap left between
 * two chord walls that line up across cells (within `CHORD_JOINT_EPS`); per
 * the user spec they should act as a continuous wall.
 *
 * A "normal" border edge has at most one chord-touched endpoint (e.g. the
 * full-width border edge of a chord-cut corner cell, where the chord ends at
 * one cell corner but the opposite corner is unrelated to any chord). Those
 * stay passable.
 */
function isChordEndSliver(cells: CellGrid, row: number, col: number, cell: Cell, a: number[], b: number[]): boolean {
  return (
    isChordTouchedAbs(cells, col + a[0]!, row + a[1]!, row, col, cell) &&
    isChordTouchedAbs(cells, col + b[0]!, row + b[1]!, row, col, cell)
  );
}

/**
 * True iff the absolute-coords point `(absX, absY)` is within
 * `CHORD_JOINT_EPS` of any chord polyline endpoint of any cell that contains
 * the point on its boundary. Each cell-corner is shared by up to 4 cells; a
 * point on a cell edge is shared by up to 2.
 */
function isChordTouchedAbs(
  cells: CellGrid,
  absX: number,
  absY: number,
  hintRow: number,
  hintCol: number,
  hintCell: Cell,
): boolean {
  // Always check the hint cell first to avoid recomputing what the caller knows.
  if (cellHasChordEndpointAt(hintCell, absX - hintCol, absY - hintRow)) return true;
  // Check the up-to-4 cells whose closure contains (absX, absY): the cells
  // whose (col, row) is in {floor(absX), floor(absX)-1} × {floor(absY), floor(absY)-1}
  // — but only those for which (absX, absY) actually lies in [col..col+1] × [row..row+1].
  const colFloor = Math.floor(absX);
  const rowFloor = Math.floor(absY);
  for (const c of [colFloor, colFloor - 1]) {
    for (const r of [rowFloor, rowFloor - 1]) {
      if (r === hintRow && c === hintCol) continue;
      if (r < 0 || c < 0) continue;
      const lx = absX - c;
      const ly = absY - r;
      if (lx < -INTERVAL_EPS || lx > 1 + INTERVAL_EPS) continue;
      if (ly < -INTERVAL_EPS || ly > 1 + INTERVAL_EPS) continue;
      const ncell = cells[r]?.[c];
      if (!ncell) continue;
      if (cellHasChordEndpointAt(ncell, lx, ly)) return true;
    }
  }
  return false;
}

/**
 * True iff the cell has any interior-edge polyline endpoint within
 * `CHORD_JOINT_EPS` of the cell-local point `(lx, ly)`. Only the *endpoints*
 * of the polyline (vertices[0] and vertices[len-1]) count — those are where a
 * chord wall terminates and might want to continue into another cell. Interior
 * polyline vertices are part of the chord wall itself, not its terminations.
 */
function cellHasChordEndpointAt(cell: Cell | null | undefined, lx: number, ly: number): boolean {
  if (!cell) return false;
  const ies = cell.interiorEdges;
  if (!ies) return false;
  for (const ie of ies) {
    const verts = ie.vertices;
    if (verts.length === 0) continue;
    const first = verts[0]!;
    const last = verts[verts.length - 1]!;
    if (Math.abs(first[0]! - lx) < CHORD_JOINT_EPS && Math.abs(first[1]! - ly) < CHORD_JOINT_EPS) return true;
    if (Math.abs(last[0]! - lx) < CHORD_JOINT_EPS && Math.abs(last[1]! - ly) < CHORD_JOINT_EPS) return true;
  }
  return false;
}
