// Bridge geometry utilities
//
// Bridges are always rectangular: P1→P2 defines the entrance width,
// and P3 defines the depth direction. The rectangle corners are computed
// by projecting the (P3-P2) vector onto the perpendicular of the P1→P2 base.
//
// All coordinates in grid-corner space (row, col) where integers = grid intersections.
// One unit = one cell. Corner (r, c) → world feet (c * gridSize, r * gridSize).

import { getOccupiedCells } from './stair-geometry.js';

/**
 * Check if a bridge definition is degenerate (zero depth after perpendicular projection).
 * @param {number[]} p1 - [row, col]
 * @param {number[]} p2 - [row, col]
 * @param {number[]} p3 - [row, col]
 * @returns {boolean}
 */
export function isBridgeDegenerate(p1, p2, p3) {
  if (p1[0] === p2[0] && p1[1] === p2[1]) return true;

  const bR = p2[0] - p1[0], bC = p2[1] - p1[1];
  const bLen2 = bR * bR + bC * bC;
  if (bLen2 < 0.001) return true;

  // Project (P3 - P2) onto perpendicular of base
  const relR = p3[0] - p2[0], relC = p3[1] - p2[1];
  const dotPar = (relR * bR + relC * bC) / bLen2;
  const perpR = relR - dotPar * bR;
  const perpC = relC - dotPar * bC;

  return (perpR * perpR + perpC * perpC) < 0.01;
}

/**
 * Compute the 4 corners of the bridge rectangle.
 * P1→P2 is the entrance width. P3 defines the depth direction.
 * Returns [A, B, C, D] = [P1, P2, P2+perpVec, P1+perpVec].
 *
 * @param {number[]} p1 - [row, col]
 * @param {number[]} p2 - [row, col]
 * @param {number[]} p3 - [row, col]
 * @returns {number[][]} 4 corner points in grid-corner coordinates
 */
export function getBridgeCorners(p1, p2, p3) {
  const bR = p2[0] - p1[0], bC = p2[1] - p1[1];
  const bLen2 = bR * bR + bC * bC;
  if (bLen2 < 0.001) return [p1, p2, p2, p1];

  // Extract perpendicular component of (P3 - P2) relative to base
  const relR = p3[0] - p2[0], relC = p3[1] - p2[1];
  const dotPar = (relR * bR + relC * bC) / bLen2;
  const perpR = relR - dotPar * bR;
  const perpC = relC - dotPar * bC;

  const c3 = [p2[0] + perpR, p2[1] + perpC];
  const c4 = [p1[0] + perpR, p1[1] + perpC];
  return [p1, p2, c3, c4];
}

/**
 * Get all grid cells covered by a bridge (for hit detection and cell marking).
 * @param {number[]} p1
 * @param {number[]} p2
 * @param {number[]} p3
 * @returns {{ row: number, col: number }[]}
 */
export function getBridgeOccupiedCells(p1, p2, p3) {
  const corners = getBridgeCorners(p1, p2, p3);
  return getOccupiedCells(corners);
}
