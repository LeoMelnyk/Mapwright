// Polygon and bridge geometry utilities shared by both the editor and the
// render pipeline. The render module is forbidden from importing editor/js,
// so geometry helpers used by both layers must live here in src/util/.
//
// All coordinates are in grid-corner space: (row, col) where integers
// represent grid intersections. One unit = one cell.

/** A 2D point as [row, col]. */
export type Pt = [number, number] | number[];

/**
 * Point-in-polygon test using ray casting (even/odd rule).
 * @param py - test point y (row)
 * @param px - test point x (col)
 * @param polygon - vertices as [row, col] pairs
 */
export function pointInPolygon(py: number, px: number, polygon: Pt[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Check if a point lies on (or within `eps` of) any polygon edge.
 */
export function pointOnPolygonEdge(py: number, px: number, polygon: Pt[], eps = 0.01): boolean {
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / len2));
    const projX = xi + t * dx, projY = yi + t * dy;
    if (Math.hypot(px - projX, py - projY) < eps) return true;
  }
  return false;
}

/**
 * Compute the four corners of a bridge rectangle.
 * P1→P2 is the entrance width; P3 defines the depth direction. The corners
 * are P1, P2, P2+perp, P1+perp where perp = perpendicular component of (P3-P2)
 * relative to the base. Returns the original endpoints if the base is degenerate.
 */
export function getBridgeCorners(p1: Pt, p2: Pt, p3: Pt): [Pt, Pt, Pt, Pt] {
  const bR = p2[0] - p1[0], bC = p2[1] - p1[1];
  const bLen2 = bR * bR + bC * bC;
  if (bLen2 < 0.001) return [p1, p2, p2, p1];

  const relR = p3[0] - p2[0], relC = p3[1] - p2[1];
  const dotPar = (relR * bR + relC * bC) / bLen2;
  const perpR = relR - dotPar * bR;
  const perpC = relC - dotPar * bC;

  return [p1, p2, [p2[0] + perpR, p2[1] + perpC], [p1[0] + perpR, p1[1] + perpC]];
}
