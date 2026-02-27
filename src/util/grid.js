// Shared grid traversal primitives used by the editor tools and renderer.

export const CARDINAL_DIRS = [
  { dir: 'north', dr: -1, dc:  0 },
  { dir: 'south', dr:  1, dc:  0 },
  { dir: 'east',  dr:  0, dc:  1 },
  { dir: 'west',  dr:  0, dc: -1 },
];

export const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** Create a "row,col" string key for Set/Map lookups. */
export function cellKey(r, c) { return `${r},${c}`; }

/** Parse a "row,col" string key back into [row, col] integers. */
export function parseCellKey(key) { return key.split(',').map(Number); }

/** Check if (row, col) is within the grid bounds. */
export function isInBounds(cells, r, c) {
  return r >= 0 && r < cells.length && c >= 0 && c < (cells[0]?.length || 0);
}

/**
 * Constrain a drag endpoint to form a square from the start point.
 * Returns { row, col } clamped to grid bounds.
 */
export function snapToSquare(row, col, startRow, startCol, cells) {
  const dr = row - startRow;
  const dc = col - startCol;
  const size = Math.max(Math.abs(dr), Math.abs(dc));
  return {
    row: Math.max(0, Math.min(cells.length - 1, startRow + (dr >= 0 ? size : -size))),
    col: Math.max(0, Math.min((cells[0]?.length || 1) - 1, startCol + (dc >= 0 ? size : -size))),
  };
}

/**
 * Normalize two corner coordinates into a top-left / bottom-right bounding box.
 */
export function normalizeBounds(r1, c1, r2, c2) {
  return {
    r1: Math.min(r1, r2), c1: Math.min(c1, c2),
    r2: Math.max(r1, r2), c2: Math.max(c1, c2),
  };
}

/**
 * Check if the edge between two adjacent cells is completely open
 * (no wall, door, or secret door on either side).
 */
export function isEdgeOpen(cell, neighbor, dir) {
  return !cell?.[dir] && !neighbor?.[OPPOSITE[dir]];
}

/**
 * Check if the edge between two adjacent cells is passable
 * (walls block, but doors and secret doors are allowed).
 */
export function isEdgePassable(cell, neighbor, dir) {
  return cell?.[dir] !== 'w' && neighbor?.[OPPOSITE[dir]] !== 'w';
}

// ── Room bounds from cell key set ──────────────────────────────────────────

/**
 * Given a Set of "row,col" cell keys, compute the bounding box and center.
 * Returns { r1, c1, r2, c2, centerRow, centerCol } or null if empty.
 */
export function roomBoundsFromKeys(cellKeySet) {
  if (!cellKeySet || cellKeySet.size === 0) return null;
  let r1 = Infinity, c1 = Infinity, r2 = -Infinity, c2 = -Infinity;
  for (const key of cellKeySet) {
    const [r, c] = parseCellKey(key);
    if (r < r1) r1 = r;
    if (c < c1) c1 = c;
    if (r > r2) r2 = r;
    if (c > c2) c2 = c;
  }
  return { r1, c1, r2, c2, centerRow: Math.floor((r1 + r2) / 2), centerCol: Math.floor((c1 + c2) / 2) };
}

// ── Edge reciprocal helpers ─────────────────────────────────────────────────

const DIR_OFFSET = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };

/**
 * Set `cells[row][col][direction] = value` and the reciprocal on the neighbor.
 * Only applies to cardinal directions (diagonal walls have no neighbor reciprocal).
 * Creates the neighbor cell if it doesn't exist but is in bounds.
 */
export function setEdgeReciprocal(cells, row, col, direction, value) {
  cells[row][col][direction] = value;
  if (!DIR_OFFSET[direction]) return; // diagonal — no reciprocal
  const [dr, dc] = DIR_OFFSET[direction];
  const nr = row + dr, nc = col + dc;
  if (isInBounds(cells, nr, nc) && cells[nr][nc]) {
    cells[nr][nc][OPPOSITE[direction]] = value;
  }
}

/**
 * Delete `cells[row][col][direction]` and the reciprocal on the neighbor.
 */
export function deleteEdgeReciprocal(cells, row, col, direction) {
  delete cells[row][col][direction];
  if (!DIR_OFFSET[direction]) return; // diagonal — no reciprocal
  const [dr, dc] = DIR_OFFSET[direction];
  const nr = row + dr, nc = col + dc;
  if (isInBounds(cells, nr, nc) && cells[nr][nc]) {
    delete cells[nr][nc][OPPOSITE[direction]];
  }
}

// ── Diagonal-aware BFS helpers ──────────────────────────────────────────────

/**
 * Returns a Set of exit directions blocked by a diagonal wall, given the entry direction.
 * nw-se diagonal separates {north,east} from {south,west}.
 * ne-sw diagonal separates {north,west} from {south,east}.
 */
export function blockedByDiagonal(cell, entryDir) {
  const blocked = new Set();
  if (entryDir === null) return blocked;

  if (cell['nw-se']) {
    if (entryDir === 'north' || entryDir === 'east') {
      blocked.add('south'); blocked.add('west');
    } else {
      blocked.add('north'); blocked.add('east');
    }
  }
  if (cell['ne-sw']) {
    if (entryDir === 'south' || entryDir === 'east') {
      blocked.add('north'); blocked.add('west');
    } else {
      blocked.add('south'); blocked.add('east');
    }
  }
  return blocked;
}

/**
 * When a diagonal cell is first reached from one half, pre-mark all entry directions
 * belonging to the OTHER half as visited so the BFS cannot cross the diagonal wall.
 */
export function lockDiagonalHalf(visited, r, c, entryDir, cell) {
  if (!entryDir) return;
  if (cell['nw-se']) {
    const others = (entryDir === 'north' || entryDir === 'east')
      ? ['south', 'west'] : ['north', 'east'];
    others.forEach(e => visited.add(`${r},${c},${e}`));
  } else if (cell['ne-sw']) {
    const others = (entryDir === 'north' || entryDir === 'west')
      ? ['south', 'east'] : ['north', 'west'];
    others.forEach(e => visited.add(`${r},${c},${e}`));
  }
}

// For each trimCorner, the cardinal directions that point toward the room interior.
// Used by the arc post-pass to distinguish interior-seeded fills from exterior-seeded fills.
// NW void corner → interior is SE half (south + east exits from the hypotenuse cell)
// NE void corner → interior is SW half (south + west exits)
// SW void corner → interior is NE half (north + east exits)
// SE void corner → interior is NW half (north + west exits)
const ARC_INTERIOR_DIRS = {
  nw: new Set(['south', 'east']),
  ne: new Set(['south', 'west']),
  sw: new Set(['north', 'east']),
  se: new Set(['north', 'west']),
};

/**
 * Diagonal-aware BFS that floods a connected room region.
 * Returns a Set of "row,col" cell keys for the room.
 *
 * @param {Array} cells - The dungeon cells grid (2D: cells[row][col]).
 * @param {number} startRow
 * @param {number} startCol
 * @param {Object} [options]
 * @param {boolean} [options.traverseDoors=false] - When false, stops at walls, doors,
 *   and secret doors. When true, only walls block (doors/secret doors are passable).
 * @param {string|null} [options.startEntryDir=null] - Entry direction for the start cell.
 *   Restricts traversal to one half of a diagonal cell. Used for diagonal door reveals.
 * @param {number} [options.rowMin] - Minimum row (inclusive). Defaults to 0.
 * @param {number} [options.rowMax] - Maximum row (inclusive). Defaults to cells.length - 1.
 */
export function floodFillRoom(cells, startRow, startCol, options = {}) {
  const {
    traverseDoors = false,
    startEntryDir = null,
    rowMin = 0,
    rowMax = cells.length - 1,
  } = options;

  const filledCells = new Set();
  const startCell = cells[startRow]?.[startCol];
  if (!startCell) return filledCells;

  filledCells.add(cellKey(startRow, startCol));

  // Queue entries: [r, c, entryDir]
  const queue = [[startRow, startCol, startEntryDir]];
  const visitedTraversal = new Set([`${startRow},${startCol},${startEntryDir ?? ''}`]);
  lockDiagonalHalf(visitedTraversal, startRow, startCol, startEntryDir, startCell);

  while (queue.length > 0) {
    const [r, c, entryDir] = queue.shift();
    const cell = cells[r]?.[c];
    if (!cell) continue;

    const diagonalBlocked = blockedByDiagonal(cell, entryDir);
    for (const { dir, dr, dc } of CARDINAL_DIRS) {
      // Check exit edge on current cell
      const edge = cell[dir];
      if (edge === 'w') continue;                    // wall always blocks
      if (edge && !traverseDoors) continue;           // doors block unless traverseDoors
      if (diagonalBlocked.has(dir)) continue;         // diagonal wall blocks this exit

      const nr = r + dr, nc = c + dc;
      if (nr < rowMin || nr > rowMax) continue;       // row-range constraint
      const neighborEntryDir = OPPOSITE[dir];
      const tKey = `${nr},${nc},${neighborEntryDir}`;
      if (visitedTraversal.has(tKey)) continue;
      visitedTraversal.add(tKey);
      if (!isInBounds(cells, nr, nc)) continue;

      const neighbor = cells[nr]?.[nc];
      if (!neighbor) continue;

      // Check entry edge on neighbor cell
      const nEdge = neighbor[neighborEntryDir];
      if (nEdge === 'w') continue;                    // wall always blocks
      if (nEdge && !traverseDoors) continue;           // doors block unless traverseDoors
      // Open-trim arch floor cells are fog-of-war boundaries: visible from either side
      // but looking through an arch doesn't auto-reveal the room beyond it.
      if (neighbor.trimInsideArc && !traverseDoors) continue;

      lockDiagonalHalf(visitedTraversal, nr, nc, neighborEntryDir, neighbor);
      queue.push([nr, nc, neighborEntryDir]);
      filledCells.add(cellKey(nr, nc));
    }
  }

  // Arc post-pass: include trimRound cells adjacent to the filled region, and
  // trimInsideArc cells only when the adjacent trimRound cell was seeded from the
  // room-interior side of the arc.
  //
  // For open round trims, trimInsideArc cells are arch-floor cells that sit inside
  // the arc curve with all walls cleared. When the DM reveals exterior cells, those
  // exterior cells are wall-adjacent to trimInsideArc cells (the open trim cleared
  // the boundary walls). Without interior-gating, the post-pass would flood through
  // the arch into the room interior. We prevent this by checking which side of the
  // diagonal the fill originated from before including trimInsideArc cells.
  //
  // checkInterior: returns true if any interior-direction (non-trimRound) neighbor
  // of a trimRound cell is already in filledCells — meaning the fill came from
  // the room side of the arc, not the exterior.
  const checkInterior = (r, c, trimCorner) => {
    const dirs = ARC_INTERIOR_DIRS[trimCorner];
    if (!dirs) return false;
    for (const { dir, dr, dc } of CARDINAL_DIRS) {
      if (!dirs.has(dir)) continue;
      const nr = r + dr, nc = c + dc;
      const nCell = cells[nr]?.[nc];
      if (nCell && !nCell.trimRound && filledCells.has(cellKey(nr, nc))) return true;
    }
    return false;
  };

  // arcQueue entries: [r, c, interior]
  // arcVisited tracks cells added to the queue (prevents re-processing).
  // Key property: trimInsideArc cells are used as stepping stones for traversal
  // (to reach all connected trimRound cells), but are only added to filledCells
  // when interior=true. This ensures the complete circular arc wall is visible from
  // exterior reveals, while the arch-floor cells (trimInsideArc) remain hidden.
  const arcQueue = [];
  const arcVisited = new Set();

  // Snapshot the BFS fill so newly added arc cells don't re-enter the first scan.
  const filledSnapshot = new Set(filledCells);
  for (const k of filledSnapshot) {
    const [fr, fc] = parseCellKey(k);
    const fCell = cells[fr]?.[fc];
    if (fCell?.trimRound && !arcVisited.has(k)) {
      arcVisited.add(k);
      arcQueue.push([fr, fc, checkInterior(fr, fc, fCell.trimCorner)]);
    }
    for (const { dr, dc } of CARDINAL_DIRS) {
      const nr = fr + dr, nc = fc + dc;
      if (nr < rowMin || nr > rowMax) continue;
      const neighbor = cells[nr]?.[nc];
      if (!neighbor) continue;
      const nKey = cellKey(nr, nc);
      if (arcVisited.has(nKey)) continue;
      if (neighbor.trimRound) {
        arcVisited.add(nKey);
        filledCells.add(nKey);
        arcQueue.push([nr, nc, checkInterior(nr, nc, neighbor.trimCorner)]);
      }
      if (neighbor.trimInsideArc) {
        arcVisited.add(nKey);
        // Reveal immediately if interior-seeded; otherwise queue as stepping stone only.
        const fInterior = fCell?.trimInsideArc ||
          (fCell?.trimRound && checkInterior(fr, fc, fCell.trimCorner));
        if (fInterior) filledCells.add(nKey);
        arcQueue.push([nr, nc, fInterior]);
      }
    }
  }
  while (arcQueue.length > 0) {
    const [ar, ac, interior] = arcQueue.shift();
    for (const { dr, dc } of CARDINAL_DIRS) {
      const nr = ar + dr, nc = ac + dc;
      if (nr < rowMin || nr > rowMax) continue;
      const neighbor = cells[nr]?.[nc];
      if (!neighbor) continue;
      const nKey = cellKey(nr, nc);
      if (arcVisited.has(nKey)) continue;
      arcVisited.add(nKey);
      if (neighbor.trimRound) {
        // trimRound cells are always added — they form the visible arc wall.
        filledCells.add(nKey);
        const newInterior = checkInterior(nr, nc, neighbor.trimCorner);
        arcQueue.push([nr, nc, interior || newInterior]);
      } else if (neighbor.trimInsideArc) {
        // trimInsideArc: reveal only when interior; always traverse for wall continuity.
        if (interior) filledCells.add(nKey);
        arcQueue.push([nr, nc, interior]);
      }
    }
  }

  return filledCells;
}
