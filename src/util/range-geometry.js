// Pure geometry functions for range/area-of-effect measurement.
// No DOM or canvas dependencies — shared by DM and player views.

/**
 * Euclidean distance between two cell centers, in feet.
 * Rounded to nearest gridSize increment.
 */
function cellDistance(r1, c1, r2, c2, gridSize) {
  const dx = (c2 - c1) * gridSize;
  const dy = (r2 - r1) * gridSize;
  const raw = Math.sqrt(dx * dx + dy * dy);
  return Math.round(raw / gridSize) * gridSize;
}

/** Clamp a cell to grid bounds. */
function inBounds(row, col, numRows, numCols) {
  return row >= 0 && row < numRows && col >= 0 && col < numCols;
}

/**
 * Compute a line area of effect from start cell to end cell using grid-traversal (DDA).
 * @param {number} startRow - Origin row
 * @param {number} startCol - Origin column
 * @param {number} endRow - Target row
 * @param {number} endCol - Target column
 * @param {number} gridSize - Grid cell size in feet
 * @param {number} numRows - Total grid rows
 * @param {number} numCols - Total grid columns
 * @returns {{ cells: Array<{ row: number, col: number }>, distanceFt: number }}
 */
export function computeLine(startRow, startCol, endRow, endCol, gridSize, numRows, numCols) {
  const distanceFt = cellDistance(startRow, startCol, endRow, endCol, gridSize);
  if (startRow === endRow && startCol === endCol) {
    return { cells: [{ row: startRow, col: startCol }], distanceFt: 0 };
  }

  // Ray from center of start cell to center of end cell (in cell-unit space)
  const x0 = startCol + 0.5;
  const y0 = startRow + 0.5;
  const x1 = endCol + 0.5;
  const y1 = endRow + 0.5;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));

  const seen = new Set();
  const cells = [];

  // Walk along the ray in small increments
  const numSteps = Math.ceil(steps * 4); // 4 sub-steps per cell for accuracy
  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    const col = Math.floor(x);
    const row = Math.floor(y);
    if (inBounds(row, col, numRows, numCols)) {
      const key = `${row},${col}`;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push({ row, col });
      }
    }
  }

  return { cells, distanceFt };
}

/**
 * Compute a 90-degree cone area of effect (5e PHB rules) from start toward end.
 * @param {number} startRow - Origin row
 * @param {number} startCol - Origin column
 * @param {number} endRow - Target row
 * @param {number} endCol - Target column
 * @param {number} gridSize - Grid cell size in feet
 * @param {number} numRows - Total grid rows
 * @param {number} numCols - Total grid columns
 * @returns {{ cells: Array<{ row: number, col: number }>, distanceFt: number }}
 */
export function computeCone(startRow, startCol, endRow, endCol, gridSize, numRows, numCols) {
  const dr = endRow - startRow;
  const dc = endCol - startCol;
  // Exact center-to-center distance in cells (no rounding) for geometry
  const rawCells = Math.sqrt(dr * dr + dc * dc);
  // Rounded distance for display
  const distanceFt = Math.round(rawCells) * gridSize;
  if (rawCells < 0.01) {
    return { cells: [{ row: startRow, col: startCol }], distanceFt: 0 };
  }

  // Direction angle from start to end
  const angle = Math.atan2(dr, dc);
  const halfAngle = Math.PI / 4; // 45 degrees each side = 90 degree cone

  // Triangle vertices in cell-unit space (relative to origin center).
  // The far edge is perpendicular to the cone direction and passes through the
  // target cell center. Tips are pushed out by 1/cos(halfAngle) so the far edge
  // midpoint sits at exactly rawCells distance from the origin.
  const t0x = 0, t0y = 0; // origin
  const leftAngle = angle - halfAngle;
  const rightAngle = angle + halfAngle;
  const tipDist = rawCells / Math.cos(halfAngle);
  const t1x = Math.cos(leftAngle) * tipDist;
  const t1y = Math.sin(leftAngle) * tipDist;
  const t2x = Math.cos(rightAngle) * tipDist;
  const t2y = Math.sin(rightAngle) * tipDist;

  const cells = [];
  const search = Math.ceil(tipDist) + 1;

  for (let dr = -search; dr <= search; dr++) {
    for (let dc = -search; dc <= search; dc++) {
      const r = startRow + dr;
      const c = startCol + dc;
      if (!inBounds(r, c, numRows, numCols)) continue;
      if (dr === 0 && dc === 0) { cells.push({ row: r, col: c }); continue; } // origin

      // Cell AABB shrunk by a margin so corner-grazing doesn't count
      const m = 0.1; // 10% inset from each edge
      if (triangleOverlapsAABB(
        t0x, t0y, t1x, t1y, t2x, t2y,
        dc - 0.5 + m, dr - 0.5 + m, dc + 0.5 - m, dr + 0.5 - m
      )) {
        cells.push({ row: r, col: c });
      }
    }
  }

  return { cells, distanceFt };
}

/** Cross product of 2D vectors (p→a) × (p→b). */
function cross2D(px, py, ax, ay, bx, by) {
  return (ax - px) * (by - py) - (ay - py) * (bx - px);
}

/** True if point (px, py) is inside or on the triangle (t0, t1, t2). */
function pointInTriangle(px, py, t0x, t0y, t1x, t1y, t2x, t2y) {
  const d1 = cross2D(px, py, t0x, t0y, t1x, t1y);
  const d2 = cross2D(px, py, t1x, t1y, t2x, t2y);
  const d3 = cross2D(px, py, t2x, t2y, t0x, t0y);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

/** True if segments (a→b) and (c→d) intersect (proper crossing). */
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross2D(cx, cy, dx, dy, ax, ay);
  const d2 = cross2D(cx, cy, dx, dy, bx, by);
  const d3 = cross2D(ax, ay, bx, by, cx, cy);
  const d4 = cross2D(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Collinear touching — include if endpoint lies on other segment
  if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

/** True if point (px, py) lies on segment (ax, ay)→(bx, by) (assumes collinear). */
function onSegment(ax, ay, bx, by, px, py) {
  return px >= Math.min(ax, bx) && px <= Math.max(ax, bx) &&
         py >= Math.min(ay, by) && py <= Math.max(ay, by);
}

/**
 * True if triangle (t0, t1, t2) overlaps axis-aligned box [minX, minY, maxX, maxY].
 * Uses: vertex-in-shape tests + edge intersection tests.
 */
function triangleOverlapsAABB(t0x, t0y, t1x, t1y, t2x, t2y, minX, minY, maxX, maxY) {
  // 1. Any triangle vertex inside the AABB?
  if (t0x >= minX && t0x <= maxX && t0y >= minY && t0y <= maxY) return true;
  if (t1x >= minX && t1x <= maxX && t1y >= minY && t1y <= maxY) return true;
  if (t2x >= minX && t2x <= maxX && t2y >= minY && t2y <= maxY) return true;

  // 2. Any AABB corner inside the triangle?
  if (pointInTriangle(minX, minY, t0x, t0y, t1x, t1y, t2x, t2y)) return true;
  if (pointInTriangle(maxX, minY, t0x, t0y, t1x, t1y, t2x, t2y)) return true;
  if (pointInTriangle(minX, maxY, t0x, t0y, t1x, t1y, t2x, t2y)) return true;
  if (pointInTriangle(maxX, maxY, t0x, t0y, t1x, t1y, t2x, t2y)) return true;

  // 3. Any triangle edge crosses any AABB edge?
  const triE = [[t0x,t0y,t1x,t1y],[t1x,t1y,t2x,t2y],[t2x,t2y,t0x,t0y]];
  const boxE = [
    [minX,minY,maxX,minY], [maxX,minY,maxX,maxY],
    [maxX,maxY,minX,maxY], [minX,maxY,minX,minY],
  ];
  for (const [ax,ay,bx,by] of triE) {
    for (const [cx,cy,dx,dy] of boxE) {
      if (segmentsIntersect(ax,ay,bx,by,cx,cy,dx,dy)) return true;
    }
  }

  return false;
}

/**
 * Compute a circle area of effect -- all cells within radius of the start cell center.
 * @param {number} startRow - Origin row
 * @param {number} startCol - Origin column
 * @param {number} endRow - Edge row (determines radius)
 * @param {number} endCol - Edge column (determines radius)
 * @param {number} gridSize - Grid cell size in feet
 * @param {number} numRows - Total grid rows
 * @param {number} numCols - Total grid columns
 * @returns {{ cells: Array<{ row: number, col: number }>, distanceFt: number }}
 */
export function computeCircle(startRow, startCol, endRow, endCol, gridSize, numRows, numCols) {
  const distanceFt = cellDistance(startRow, startCol, endRow, endCol, gridSize);
  if (distanceFt === 0) {
    return { cells: [{ row: startRow, col: startCol }], distanceFt: 0 };
  }

  const radiusCells = distanceFt / gridSize;
  const cells = [];
  const search = Math.ceil(radiusCells) + 1;

  for (let dr = -search; dr <= search; dr++) {
    for (let dc = -search; dc <= search; dc++) {
      const r = startRow + dr;
      const c = startCol + dc;
      if (!inBounds(r, c, numRows, numCols)) continue;

      const dist = Math.sqrt(dr * dr + dc * dc);
      if (dist <= radiusCells + 0.5) { // +0.5 so cells whose center is within radius are included
        cells.push({ row: r, col: c });
      }
    }
  }

  return { cells, distanceFt };
}

/**
 * Compute a cube area of effect -- origin as one corner, extending toward the target.
 * @param {number} startRow - Origin row
 * @param {number} startCol - Origin column
 * @param {number} endRow - Target row (determines side length)
 * @param {number} endCol - Target column (determines side length)
 * @param {number} gridSize - Grid cell size in feet
 * @param {number} numRows - Total grid rows
 * @param {number} numCols - Total grid columns
 * @returns {{ cells: Array<{ row: number, col: number }>, distanceFt: number }}
 */
export function computeCube(startRow, startCol, endRow, endCol, gridSize, numRows, numCols) {
  const dr = endRow - startRow;
  const dc = endCol - startCol;
  const side = Math.max(Math.abs(dr), Math.abs(dc)) + 1;
  const distanceFt = side * gridSize;

  // Direction: extend from start toward end
  const rowDir = dr >= 0 ? 1 : -1;
  const colDir = dc >= 0 ? 1 : -1;

  const cells = [];
  for (let ri = 0; ri < side; ri++) {
    for (let ci = 0; ci < side; ci++) {
      const r = startRow + ri * rowDir;
      const c = startCol + ci * colDir;
      if (inBounds(r, c, numRows, numCols)) {
        cells.push({ row: r, col: c });
      }
    }
  }

  return { cells, distanceFt };
}
