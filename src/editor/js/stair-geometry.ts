// Stair geometry utilities — shape classification, occupied cells, hatch lines, bounding box
// All coordinates are in grid-corner space: (row, col) where integers represent grid intersections.
// One unit = one cell. Corner (r, c) maps to world feet (c * gridSize, r * gridSize).

/**
 * Classify the stair shape from 3 corner points.
 * P1→P2 = base edge (hatching lines are parallel to this).
 * P3 = depth target.
 *
 * Rectangle: (P3−P2) is perpendicular to base (P2−P1), OR (P3−P1) is perpendicular to base.
 *   → Vertices ordered: [P1, P2, adjacent-to-P2, adjacent-to-P1]
 *
 * Triangle/Trapezoid: P3 is not perpendicular to base from either endpoint.
 *   → vertices = [P1, P2, P3]
 *
 * @param {number[]} p1 - [row, col] first click (base start)
 * @param {number[]} p2 - [row, col] second click (base end)
 * @param {number[]} p3 - [row, col] third click (depth target)
 * @returns {{ type: 'rectangle'|'triangle', vertices: [number, number][] }}
 */
export function classifyStairShape(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
): { type: 'rectangle' | 'trapezoid' | 'triangle'; vertices: [number, number][] } {
  const baseR = p2[0] - p1[0],
    baseC = p2[1] - p1[1];
  const baseLen = Math.hypot(baseR, baseC);
  if (baseLen < 0.01) return { type: 'triangle', vertices: [p1, p2, p3] };
  const baseUnitR = baseR / baseLen,
    baseUnitC = baseC / baseLen;

  // Decompose P3-P2 into base-parallel (inward) and base-perpendicular (depth)
  const relR = p3[0] - p2[0],
    relC = p3[1] - p2[1];
  const inward = -(relR * baseUnitR + relC * baseUnitC);
  const depthR = relR + inward * baseUnitR;
  const depthC = relC + inward * baseUnitC;

  const narrowLen = baseLen - 2 * inward;
  const midR = (p1[0] + p2[0]) / 2,
    midC = (p1[1] + p2[1]) / 2;
  const narrowCenterR = midR + depthR,
    narrowCenterC = midC + depthC;

  if (narrowLen > 0.05) {
    const halfNarrow = narrowLen / 2;
    const ns: [number, number] = [narrowCenterR - halfNarrow * baseUnitR, narrowCenterC - halfNarrow * baseUnitC];
    const ne: [number, number] = [narrowCenterR + halfNarrow * baseUnitR, narrowCenterC + halfNarrow * baseUnitC];
    const type = Math.abs(narrowLen - baseLen) < 0.05 ? 'rectangle' : 'trapezoid';
    return { type, vertices: [p1, p2, ne, ns] };
  }
  // Converges to a point
  return { type: 'triangle', vertices: [p1, p2, [narrowCenterR, narrowCenterC]] };
}

/**
 * Check if a stair shape is degenerate (zero area).
 * @param {number[]} p1
 * @param {number[]} p2
 * @param {number[]} p3
 * @returns {boolean} true if degenerate
 */
export function isDegenerate(p1: [number, number], p2: [number, number], p3: [number, number]): boolean {
  // Same point check
  if (p1[0] === p2[0] && p1[1] === p2[1]) return true;
  if (p2[0] === p3[0] && p2[1] === p3[1]) return true;
  if (p1[0] === p3[0] && p1[1] === p3[1]) return true;

  // Collinear check via cross product
  const cross = (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
  return cross === 0;
}

/**
 * Compute the bounding box of a stair's points (in corner coordinates).
 * @param {number[][]} points - Array of [row, col] corner points (3 for triangle, or raw 3 points)
 * @returns {{ minRow: number, minCol: number, maxRow: number, maxCol: number }}
 */
export function stairBoundingBox(points: [number, number][]): {
  minRow: number;
  minCol: number;
  maxRow: number;
  maxCol: number;
} {
  const shape = classifyStairShape(points[0]!, points[1]!, points[2]!);
  const verts = shape.vertices;
  let minRow = Infinity,
    minCol = Infinity,
    maxRow = -Infinity,
    maxCol = -Infinity;
  for (const [r, c] of verts) {
    if (r < minRow) minRow = r;
    if (c < minCol) minCol = c;
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }
  return { minRow, minCol, maxRow, maxCol };
}

// Polygon point-tests sourced from src/util/polygon.ts (single source of truth
// shared with the render pipeline). The local wrappers below were duplicates.
import { pointInPolygon, pointOnPolygonEdge } from '../../util/index.js';

/**
 * Get all cells occupied by a stair polygon.
 * A cell at grid position (row, col) is occupied if its center (row+0.5, col+0.5)
 * falls inside or on the edge of the polygon defined by the stair vertices.
 *
 * @param {number[][]} vertices - Polygon vertices in corner coords [row, col]
 * @returns {{ row: number, col: number }[]}
 */
export function getOccupiedCells(vertices: [number, number][]): { row: number; col: number }[] {
  let minRow = Infinity,
    minCol = Infinity,
    maxRow = -Infinity,
    maxCol = -Infinity;
  for (const [r, c] of vertices) {
    if (r < minRow) minRow = r;
    if (c < minCol) minCol = c;
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }

  // Cell rows go from minRow to maxRow-1, cols from minCol to maxCol-1
  const startR = Math.floor(minRow),
    startC = Math.floor(minCol);
  const endR = Math.ceil(maxRow),
    endC = Math.ceil(maxCol);
  const cells = [];
  for (let r = startR; r < endR; r++) {
    for (let c = startC; c < endC; c++) {
      const cy = r + 0.5;
      const cx = c + 0.5;
      if (pointInPolygon(cy, cx, vertices) || pointOnPolygonEdge(cy, cx, vertices)) {
        cells.push({ row: r, col: c });
      }
    }
  }
  return cells;
}

/**
 * Compute hatching lines for a stair shape.
 *
 * Unified algorithm: decompose P3 relative to P2 into depth (perpendicular to base)
 * and inward shift (parallel to base toward P1). narrowLen = baseLen - 2 * inward.
 * This naturally handles rectangles (inward=0), trapezoids, and triangles.
 *
 * @param {number[][]} points - The 3 defining points [P1, P2, P3]
 * @param {number} [lineSpacing=0.2] - Spacing between lines in grid units
 * @returns {{ r1: number, c1: number, r2: number, c2: number }[]}
 */
export function computeHatchLines(
  points: [number, number][],
  lineSpacing: number = 0.2,
): { r1: number; c1: number; r2: number; c2: number }[] {
  const [p1, p2, p3] = points as [[number, number], [number, number], [number, number]];

  // Base vector and length
  const baseR = p2[0] - p1[0];
  const baseC = p2[1] - p1[1];
  const baseLen = Math.hypot(baseR, baseC);
  if (baseLen < 0.01) return [];
  const baseUnitR = baseR / baseLen;
  const baseUnitC = baseC / baseLen;

  // Decompose P3-P2 into base-parallel (inward) and base-perpendicular (depth)
  const relR = p3[0] - p2[0];
  const relC = p3[1] - p2[1];
  const inward = -(relR * baseUnitR + relC * baseUnitC);
  const depthR = relR + inward * baseUnitR;
  const depthC = relC + inward * baseUnitC;
  const depth = Math.hypot(depthR, depthC);
  if (depth < 0.01) return [];

  // Narrow end: centered on the depth midline
  const narrowLen = baseLen - 2 * inward;
  const midR = (p1[0] + p2[0]) / 2;
  const midC = (p1[1] + p2[1]) / 2;
  const narrowCenterR = midR + depthR;
  const narrowCenterC = midC + depthC;

  let narrowStart: [number, number], narrowEnd: [number, number];
  if (narrowLen > 0.05) {
    const halfNarrow = narrowLen / 2;
    narrowStart = [narrowCenterR - halfNarrow * baseUnitR, narrowCenterC - halfNarrow * baseUnitC];
    narrowEnd = [narrowCenterR + halfNarrow * baseUnitR, narrowCenterC + halfNarrow * baseUnitC];
  } else {
    // Converge to point at narrow center
    narrowStart = [narrowCenterR, narrowCenterC];
    narrowEnd = [narrowCenterR, narrowCenterC];
  }

  const numLines = Math.max(1, Math.round(depth / lineSpacing));
  const lines = [];
  const margin = 0.08;

  for (let i = 0; i <= numLines; i++) {
    const t = margin + (i / numLines) * (1 - 2 * margin);
    const r1 = p1[0] + t * (narrowStart[0] - p1[0]);
    const c1 = p1[1] + t * (narrowStart[1] - p1[1]);
    const r2 = p2[0] + t * (narrowEnd[0] - p2[0]);
    const c2 = p2[1] + t * (narrowEnd[1] - p2[1]);

    const lineLen = Math.hypot(r2 - r1, c2 - c1);
    if (lineLen < 0.05) continue;

    lines.push({ r1, c1, r2, c2 });
  }

  return lines;
}
