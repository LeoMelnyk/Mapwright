// Shared grid traversal primitives used by the editor tools and renderer.

import type { Cell, CellGrid, CardinalDirection, Direction, EdgeValue } from '../types.js';

// ── Typed Cell edge accessors ──────────────────────────────────────────────
// These centralise the dynamic property access needed for direction-based lookups,
// avoiding `as Record<string, unknown>` casts scattered across the codebase.

/** Read an edge value from a cell by direction. */
export function getEdge(cell: Cell, dir: Direction): EdgeValue {
  return cell[dir];
}

/** Write an edge value on a cell by direction. */
export function setEdge(cell: Cell, dir: Direction, value: EdgeValue): void {
  (cell as Record<Direction, EdgeValue>)[dir] = value;
}

/** Delete an edge value from a cell by direction. */
export function deleteEdge(cell: Cell, dir: Direction): void {
  delete (cell as Record<Direction, EdgeValue | undefined>)[dir];
}

// ── Half-cell resolution helpers ────────────────────────────────────────────

/** Default resolution (1 = legacy full-cell grid, 2 = half-cell / quarter grid). */
export const RESOLUTION_DEFAULT: number = 2;

/**
 * Compute the user-facing grid size from internal gridSize and resolution.
 * @param gridSize - Internal grid size in feet
 * @param resolution - Resolution multiplier (1 or 2)
 * @returns Display grid size in feet
 */
export function displayGridSize(gridSize: number, resolution: number): number {
  return gridSize * (resolution || 1);
}

/**
 * Convert a display coordinate (0, 0.5, 1, 1.5...) to an internal integer index.
 * @param displayCoord - Display coordinate
 * @param resolution - Resolution multiplier
 * @returns Internal grid index
 */
export function toInternalCoord(displayCoord: number, resolution: number): number {
  return Math.round(displayCoord * (resolution || 1));
}

/**
 * Convert an internal integer index back to a display coordinate.
 * @param internalCoord - Internal grid index
 * @param resolution - Resolution multiplier
 * @returns Display coordinate
 */
export function toDisplayCoord(internalCoord: number, resolution: number): number {
  return internalCoord / (resolution || 1);
}

export const CARDINAL_DIRS: ReadonlyArray<{ dir: CardinalDirection; dr: number; dc: number }> = [
  { dir: 'north', dr: -1, dc:  0 },
  { dir: 'south', dr:  1, dc:  0 },
  { dir: 'east',  dr:  0, dc:  1 },
  { dir: 'west',  dr:  0, dc: -1 },
];

export const OPPOSITE: Record<CardinalDirection, CardinalDirection> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * Create a "row,col" string key for Set/Map lookups.
 * @param r - Row index
 * @param c - Column index
 * @returns Cell key string
 */
export function cellKey(r: number, c: number): string { return `${r},${c}`; }

/**
 * Parse a "row,col" string key back into [row, col] integers.
 * @param key - Cell key string
 * @returns [row, col]
 */
export function parseCellKey(key: string): number[] { return key.split(',').map(Number); }

/**
 * Check if (row, col) is within the grid bounds.
 * @param cells - 2D cells grid
 * @param r - Row index
 * @param c - Column index
 * @returns True if in bounds
 */
export function isInBounds(cells: CellGrid, r: number, c: number): boolean {
  return r >= 0 && r < cells.length && c >= 0 && c < (cells[0]?.length || 0);
}

/**
 * Constrain a drag endpoint to form a square from the start point.
 * @param row - Current drag row
 * @param col - Current drag column
 * @param startRow - Drag start row
 * @param startCol - Drag start column
 * @param cells - 2D cells grid (for bounds clamping)
 * @returns Clamped square endpoint
 */
export function snapToSquare(row: number, col: number, startRow: number, startCol: number, cells: CellGrid): { row: number; col: number } {
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
 * @param r1 - First corner row
 * @param c1 - First corner column
 * @param r2 - Second corner row
 * @param c2 - Second corner column
 */
export function normalizeBounds(r1: number, c1: number, r2: number, c2: number): { r1: number; c1: number; r2: number; c2: number } {
  return {
    r1: Math.min(r1, r2), c1: Math.min(c1, c2),
    r2: Math.max(r1, r2), c2: Math.max(c1, c2),
  };
}

/**
 * Check if the edge between two adjacent cells is completely open.
 * @param cell - Source cell object
 * @param neighbor - Adjacent cell object
 * @param dir - Cardinal direction from cell to neighbor
 * @returns True if no wall, door, or secret door on either side
 */
export function isEdgeOpen(cell: Cell | null, neighbor: Cell | null, dir: CardinalDirection): boolean {
  return !cell?.[dir] && !neighbor?.[OPPOSITE[dir]];
}

/**
 * Check if the edge between two adjacent cells is passable (doors allowed, walls block).
 * @param cell - Source cell object
 * @param neighbor - Adjacent cell object
 * @param dir - Cardinal direction from cell to neighbor
 * @returns True if passable
 */
export function isEdgePassable(cell: Cell | null, neighbor: Cell | null, dir: CardinalDirection): boolean {
  const a = cell?.[dir], b = neighbor?.[OPPOSITE[dir]];
  return a !== 'w' && a !== 'iw' && b !== 'w' && b !== 'iw';
}

// ── Room bounds from cell key set ──────────────────────────────────────────

/**
 * Given a Set of "row,col" cell keys, compute the bounding box and center.
 * @param cellKeySet - Set of cell key strings
 */
export function roomBoundsFromKeys(cellKeySet: Set<string> | null | undefined): { r1: number; c1: number; r2: number; c2: number; centerRow: number; centerCol: number } | null {
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

/**
 * Canonical cardinal direction → [row, col] offset map.
 *
 * Single source of truth — do NOT redefine this in other files. Imported by
 * editor tools, panels, dm-session, player canvas, fog, render, and import
 * adapters via the util barrel.
 */
export const CARDINAL_OFFSETS: Readonly<Record<'north' | 'south' | 'east' | 'west', readonly [number, number]>> = {
  north: [-1, 0],
  south: [1,  0],
  east:  [0,  1],
  west:  [0, -1],
} as const;

const DIR_OFFSET = CARDINAL_OFFSETS as unknown as Record<string, [number, number]>;

/**
 * Set a wall/door value on a cell edge and its reciprocal on the neighbor.
 * @param cells - 2D cells grid
 * @param row - Row index
 * @param col - Column index
 * @param direction - Edge direction
 * @param value - Edge value ('w', 'd', 's', 'iw', etc.)
 */
export function setEdgeReciprocal(cells: CellGrid, row: number, col: number, direction: string, value: EdgeValue): void {
  (cells[row][col] as Record<string, unknown>)[direction] = value;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
  if (!DIR_OFFSET[direction]) return; // diagonal — no reciprocal
  const [dr, dc] = DIR_OFFSET[direction];
  const nr = row + dr, nc = col + dc;
  if (isInBounds(cells, nr, nc) && cells[nr][nc]) {
    (cells[nr][nc] as Record<string, unknown>)[OPPOSITE[direction as CardinalDirection]] = value;
  }
}

/**
 * Delete a cell edge value and its reciprocal on the neighbor.
 * @param cells - 2D cells grid
 * @param row - Row index
 * @param col - Column index
 * @param direction - Edge direction
 */
export function deleteEdgeReciprocal(cells: CellGrid, row: number, col: number, direction: string): void {
  delete (cells[row][col] as Record<string, unknown>)[direction];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
  if (!DIR_OFFSET[direction]) return; // diagonal — no reciprocal
  const [dr, dc] = DIR_OFFSET[direction];
  const nr = row + dr, nc = col + dc;
  if (isInBounds(cells, nr, nc) && cells[nr][nc]) {
    delete (cells[nr][nc] as Record<string, unknown>)[OPPOSITE[direction as CardinalDirection]];
  }
}

// ── Diagonal-aware BFS helpers ──────────────────────────────────────────────

/**
 * Returns a Set of exit directions blocked by a diagonal wall, given the entry direction.
 * @param cell - Cell object with potential 'nw-se' or 'ne-sw' diagonal walls
 * @param entryDir - Direction the cell was entered from
 * @returns Blocked exit directions
 */
export function blockedByDiagonal(cell: Cell, entryDir: CardinalDirection | null): Set<string> {
  const blocked = new Set<string>();
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
 * When a diagonal cell is first reached from one half, lock the other half as visited.
 * @param visited - BFS visited set (mutated)
 * @param r - Row index
 * @param c - Column index
 * @param entryDir - Direction the cell was entered from
 * @param cell - Cell object
 */
export function lockDiagonalHalf(visited: Set<string>, r: number, c: number, entryDir: string | null, cell: Cell): void {
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

/**
 * Diagonal-aware BFS that floods a connected room region.
 * Returns a Set of "row,col" cell keys for the room.
 *
 * @param cells - The dungeon cells grid (2D: cells[row][col]).
 * @param startRow
 * @param startCol
 * @param options
 */
export function floodFillRoom(cells: CellGrid, startRow: number, startCol: number, options: {
  traverseDoors?: boolean;
  startEntryDir?: string | null;
  rowMin?: number;
  rowMax?: number;
} = {}): Set<string> {
  const {
    traverseDoors = false,
    startEntryDir = null,
    rowMin = 0,
    rowMax = cells.length - 1,
  } = options;

  const filledCells = new Set<string>();
  const startCell = cells[startRow]?.[startCol];
  if (!startCell) return filledCells;

  filledCells.add(cellKey(startRow, startCol));

  // Queue entries: [r, c, entryDir]
  const queue: [number, number, string | null][] = [[startRow, startCol, startEntryDir]];
  const visitedTraversal = new Set<string>([`${startRow},${startCol},${startEntryDir ?? ''}`]);
  lockDiagonalHalf(visitedTraversal, startRow, startCol, startEntryDir, startCell);

  while (queue.length > 0) {
    const [r, c, entryDir] = queue.shift()!;
    const cell = cells[r]?.[c];
    if (!cell) continue;

    const diagonalBlocked = blockedByDiagonal(cell, entryDir as CardinalDirection | null);

    // Arc wall exit blocking: 3×3 sub-grid crossing matrix determines which
    // exits are reachable from the entry direction without crossing the arc.
    let arcExits: string | null = null;
    if (cell.trimCrossing) {
      arcExits = (cell.trimCrossing as Record<string, string>)[entryDir?.[0] ?? ''] ?? '';
    }

    for (const { dir, dr, dc } of CARDINAL_DIRS) {
      // Check exit edge on current cell
      const edge = cell[dir];
      if (edge === 'w' || edge === 'iw') continue;   // wall and invisible wall always block
      if (edge && !traverseDoors) continue;           // doors (including 'id') block unless traverseDoors
      if (diagonalBlocked.has(dir)) continue;         // diagonal wall blocks this exit
      if (arcExits !== null && !arcExits.includes(dir[0])) continue; // arc wall blocks this exit

      const nr = r + dr, nc = c + dc;
      if (nr < rowMin || nr > rowMax) continue;       // row-range constraint
      const neighborEntryDir: CardinalDirection = OPPOSITE[dir];
      const tKey = `${nr},${nc},${neighborEntryDir}`;
      if (visitedTraversal.has(tKey)) continue;
      visitedTraversal.add(tKey);
      if (!isInBounds(cells, nr, nc)) continue;

      const neighbor = cells[nr]?.[nc];
      if (!neighbor) continue;

      // Check entry edge on neighbor cell
      const nEdge = neighbor[neighborEntryDir];
      if (nEdge === 'w' || nEdge === 'iw') continue;  // wall and invisible wall always block
      if (nEdge && !traverseDoors) continue;           // doors (including 'id') block unless traverseDoors

      // Lock arc cell to the side it's first reached from (like lockDiagonalHalf).
      // Uses crossing matrix: lock entry directions whose reachable set differs.
      if (neighbor.trimCrossing) {
        const tc = neighbor.trimCrossing;
        const myExits: string = (tc as Record<string, string>)[neighborEntryDir[0]] ?? '';
        for (const ld of ['north', 'south', 'east', 'west']) {
          if (ld === neighborEntryDir) continue;
          const otherExits: string = (tc as Record<string, string>)[ld[0]] ?? '';
          if (otherExits !== myExits) visitedTraversal.add(`${nr},${nc},${ld}`);
        }
      }
      lockDiagonalHalf(visitedTraversal, nr, nc, neighborEntryDir, neighbor);
      queue.push([nr, nc, neighborEntryDir]);

      // Skip trimWall cells in the main BFS — the arc post-pass handles them.
      // The main BFS still traverses THROUGH arc cells (they're in the queue)
      // so non-arc cells on the far side are reachable, but arc cells themselves
      // are claimed by adjacency in the post-pass to avoid corner-clip misses.
      if (neighbor.trimWall) continue;

      filledCells.add(cellKey(nr, nc));
    }
  }

  // Arc post-pass: claim all trimWall cells adjacent to any filled cell,
  // then propagate through connected trimWall cells. Mirrors the paint tool's
  // arc post-pass (tool-paint.js lines 517-608).
  {
    const arcVisited = new Set<string>();
    const arcQueue: [number, number][] = [];

    // Seed: non-arc filled cells adjacent to arc cells.
    // Skip cells sandwiched between arc cells (gap between circles).
    for (const k of filledCells) {
      const [fr, fc] = k.split(',').map(Number);
      const fCell = cells[fr]?.[fc];
      if (fCell?.trimWall) continue;
      const hasArcN = !!cells[fr - 1]?.[fc]?.trimWall;
      const hasArcS = !!cells[fr + 1]?.[fc]?.trimWall;
      const hasArcE = !!cells[fr]?.[fc + 1]?.trimWall;
      const hasArcW = !!cells[fr]?.[fc - 1]?.trimWall;
      if ((hasArcN && hasArcS) || (hasArcE && hasArcW)) continue;
      for (const { dr, dc } of CARDINAL_DIRS) {
        const nr = fr + dr, nc = fc + dc;
        if (!cells[nr]?.[nc]?.trimWall) continue;
        const nKey = cellKey(nr, nc);
        if (arcVisited.has(nKey)) continue;
        arcVisited.add(nKey);
        filledCells.add(nKey);
        arcQueue.push([nr, nc]);
      }
    }

    // Propagate through connected arc cells.
    while (arcQueue.length > 0) {
      const [ar, ac] = arcQueue.shift()!;
      for (const { dr, dc } of CARDINAL_DIRS) {
        const nr = ar + dr, nc = ac + dc;
        if (!cells[nr]?.[nc]?.trimWall) continue;
        const nKey = cellKey(nr, nc);
        if (arcVisited.has(nKey)) continue;
        arcVisited.add(nKey);
        filledCells.add(nKey);
        arcQueue.push([nr, nc]);
      }
    }
  }

  return filledCells;
}
