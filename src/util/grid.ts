// Shared grid traversal primitives used by the editor tools and renderer.

import type {
  Cell,
  CellGrid,
  CardinalDirection,
  CellHalfKey,
  Direction,
  EdgeValue,
  RenderTransform,
} from '../types.js';
import {
  diagonalSegments,
  getInteriorEdges,
  getSegments,
  primaryTextureSegmentIndex,
  spliceSegments,
} from './cell-segments.js';

// ── Diagonal-edge helpers ──────────────────────────────────────────────────
// Diagonal walls live on `cell.interiorEdges` (with no `arc` hint), not on
// any cardinal field. These helpers read/write the diagonal wall through
// the segments model so callers can use the same getEdge/setEdge API for
// cardinals AND diagonals.

const EPS = 1e-9;
const FULL_POLY: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** True when a polyline runs from (0,0)→(1,1) — the nw-se diagonal. */
function isNwSeChord(verts: number[][]): boolean {
  if (verts.length < 2) return false;
  const a = verts[0]!;
  const b = verts[verts.length - 1]!;
  return (
    (Math.abs(a[0]!) < EPS && Math.abs(a[1]!) < EPS && Math.abs(b[0]! - 1) < EPS && Math.abs(b[1]! - 1) < EPS) ||
    (Math.abs(b[0]!) < EPS && Math.abs(b[1]!) < EPS && Math.abs(a[0]! - 1) < EPS && Math.abs(a[1]! - 1) < EPS)
  );
}

/** True when a polyline runs from (1,0)→(0,1) — the ne-sw diagonal. */
function isNeSwChord(verts: number[][]): boolean {
  if (verts.length < 2) return false;
  const a = verts[0]!;
  const b = verts[verts.length - 1]!;
  return (
    (Math.abs(a[0]! - 1) < EPS && Math.abs(a[1]!) < EPS && Math.abs(b[0]!) < EPS && Math.abs(b[1]! - 1) < EPS) ||
    (Math.abs(b[0]! - 1) < EPS && Math.abs(b[1]!) < EPS && Math.abs(a[0]!) < EPS && Math.abs(a[1]! - 1) < EPS)
  );
}

/**
 * Read the wall on a cell's diagonal interior edge, if any. Returns the
 * canonical edge value (`'w'`, `'iw'`, `null`, etc.) or `undefined` when
 * the cell is unsplit / has no matching diagonal.
 *
 * Skips arc-trim partitions: arcs aren't diagonals, even though they also
 * sit on `interiorEdges`. The `arc` hint distinguishes them.
 */
export function getDiagonalEdge(cell: Cell | null | undefined, diag: 'nw-se' | 'ne-sw'): EdgeValue {
  if (!cell) return undefined;
  for (const ie of getInteriorEdges(cell)) {
    // `isNwSeChord` / `isNeSwChord` already reject anything but a 2-vertex
    // corner-to-corner edge, so chord/arc interior edges naturally don't match.
    if (diag === 'nw-se' && isNwSeChord(ie.vertices)) return ie.wall;
    if (diag === 'ne-sw' && isNeSwChord(ie.vertices)) return ie.wall;
  }
  return undefined;
}

/**
 * Write a diagonal wall on a cell, replacing any prior partition. Routes
 * through `spliceSegments` so the tile / no-overlap invariants hold.
 *
 * Pass `value = null` for a passable diagonal (rare; mostly used by the
 * trim tool's `open` mode); pass `'w'` / `'iw'` for the standard cases.
 *
 * Texture preservation: if the cell already had a texture (single segment
 * with a `texture` field, the common case), that texture is carried over
 * onto BOTH new segments so the user sees the floor unchanged on both
 * sides of the new diagonal. The inverse — collapsing a diagonal back to
 * a single segment — is handled by `deleteDiagonalEdge`, which coalesces.
 */
export function setDiagonalEdge(cell: Cell, diag: 'nw-se' | 'ne-sw', value: EdgeValue): void {
  // Snapshot the primary texture before the partition lands. For an
  // unsplit cell `primaryTextureSegmentIndex` is 0; for a cell already
  // split (re-partition with a different diagonal) it picks the canonical
  // "primary" half. Either way we get the user-visible floor texture.
  const segsBefore = getSegments(cell);
  const primaryIdxBefore = primaryTextureSegmentIndex(cell);
  const preservedTexture = segsBefore[primaryIdxBefore]?.texture;
  const preservedOpacity = segsBefore[primaryIdxBefore]?.textureOpacity;

  const { segments, interiorEdge } = diagonalSegments(diag);
  spliceSegments(cell, {
    kind: 'replacePartition',
    segments: segments.map((s) => ({
      ...s,
      polygon: s.polygon.map((p) => [p[0]!, p[1]!]),
      ...(preservedTexture !== undefined ? { texture: preservedTexture } : {}),
      ...(preservedOpacity !== undefined ? { textureOpacity: preservedOpacity } : {}),
    })),
    interiorEdges: [
      {
        vertices: interiorEdge.vertices.map((v) => [v[0]!, v[1]!]),
        wall: value ?? null,
        between: [interiorEdge.between[0], interiorEdge.between[1]],
      },
    ],
  });
}

/**
 * Remove a diagonal partition from a cell, restoring it to a single
 * unsplit segment. No-op when the cell has no matching diagonal partition.
 */
export function deleteDiagonalEdge(cell: Cell, diag: 'nw-se' | 'ne-sw'): void {
  // Detect a matching diagonal interior edge. Chord/arc edges naturally
  // don't match the corner-to-corner shape `isNwSeChord` / `isNeSwChord` test for.
  const edges = getInteriorEdges(cell);
  let found = false;
  for (const ie of edges) {
    if (diag === 'nw-se' && isNwSeChord(ie.vertices)) found = true;
    if (diag === 'ne-sw' && isNeSwChord(ie.vertices)) found = true;
  }
  if (!found) return;

  // Coalesce textures from the two segments — pick segment 1's texture
  // (the canonical "primary" half: NE for nw-se, NW for ne-sw) when set,
  // falling back to segment 0.
  const segs = getSegments(cell);
  const primary = segs[1]?.texture ?? segs[0]?.texture;
  const primaryOp = segs[1]?.textureOpacity ?? segs[0]?.textureOpacity;

  spliceSegments(cell, {
    kind: 'replacePartition',
    segments: [
      {
        id: 's0',
        polygon: FULL_POLY.map((p) => [p[0], p[1]]),
        ...(primary !== undefined ? { texture: primary } : {}),
        ...(primaryOp !== undefined ? { textureOpacity: primaryOp } : {}),
      },
    ],
    interiorEdges: [],
  });
}

// ── Coordinate transforms (shared between editor, render, and player) ─────

/**
 * Convert feet coordinates to canvas pixels using a pan/zoom transform.
 */
export function toCanvas(x: number, y: number, transform: RenderTransform): { x: number; y: number } {
  return {
    x: x * transform.scale + transform.offsetX,
    y: y * transform.scale + transform.offsetY,
  };
}

/**
 * Convert canvas pixel coordinates back to world feet using the inverse transform.
 */
export function fromCanvas(px: number, py: number, transform: RenderTransform): { x: number; y: number } {
  return {
    x: (px - transform.offsetX) / transform.scale,
    y: (py - transform.offsetY) / transform.scale,
  };
}

/**
 * Convert a canvas pixel position to grid `(row, col)` indices.
 */
export function pixelToCell(
  px: number,
  py: number,
  transform: RenderTransform,
  gridSize: number,
): { row: number; col: number } {
  const feet = fromCanvas(px, py, transform);
  return {
    row: Math.floor(feet.y / gridSize),
    col: Math.floor(feet.x / gridSize),
  };
}

// ── Typed Cell edge accessors ──────────────────────────────────────────────
// These centralise the dynamic property access needed for direction-based
// lookups. Cardinal directions read/write `cell.north`/etc. directly;
// diagonal directions (`'nw-se'` / `'ne-sw'`) route through the segments
// model via `getDiagonalEdge` / `setDiagonalEdge` so the cell type doesn't
// need to carry diagonal-edge fields at all.

/** Read an edge value from a cell by direction. */
export function getEdge(cell: Cell, dir: Direction): EdgeValue {
  if (dir === 'nw-se' || dir === 'ne-sw') return getDiagonalEdge(cell, dir);
  return cell[dir];
}

/**
 * Scan a cell grid and return the set of texture IDs referenced by any
 * segment of any populated cell. Used by the editor, the Node-side render
 * pipeline, and the player view to figure out which textures need to be
 * loaded for a given map.
 */
export function collectTextureIds(cells: CellGrid): Set<string> {
  const ids = new Set<string>();
  for (const row of cells) {
    for (const cell of row) {
      if (!cell) continue;
      for (const seg of getSegments(cell)) {
        if (seg.texture) ids.add(seg.texture);
      }
    }
  }
  return ids;
}

/** Write an edge value on a cell by direction. */
export function setEdge(cell: Cell, dir: Direction, value: EdgeValue): void {
  if (dir === 'nw-se' || dir === 'ne-sw') {
    setDiagonalEdge(cell, dir, value);
    return;
  }
  // The cast is narrow (only valid CardinalDirection keys, only EdgeValue values)
  // and lives in the implementation of the typed helper itself.
  // eslint-disable-next-line no-restricted-syntax
  (cell as Record<CardinalDirection, EdgeValue>)[dir] = value;
}

/** Delete an edge value from a cell by direction. */
export function deleteEdge(cell: Cell, dir: Direction): void {
  if (dir === 'nw-se' || dir === 'ne-sw') {
    deleteDiagonalEdge(cell, dir);
    return;
  }
  // Same justification as setEdge — narrow cast inside the helper itself.
  // eslint-disable-next-line no-restricted-syntax
  delete (cell as Record<CardinalDirection, EdgeValue | undefined>)[dir];
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
  { dir: 'north', dr: -1, dc: 0 },
  { dir: 'south', dr: 1, dc: 0 },
  { dir: 'east', dr: 0, dc: 1 },
  { dir: 'west', dr: 0, dc: -1 },
];

export const OPPOSITE: Record<CardinalDirection, CardinalDirection> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
};

/**
 * Create a "row,col" string key for Set/Map lookups.
 * @param r - Row index
 * @param c - Column index
 * @returns Cell key string
 */
export function cellKey(r: number, c: number): string {
  return `${r},${c}`;
}

/**
 * Parse a "row,col" string key back into [row, col] integers.
 * @param key - Cell key string
 * @returns [row, col]
 */
export function parseCellKey(key: string): [number, number] {
  const parts = key.split(',');
  return [Number(parts[0]), Number(parts[1])];
}

/**
 * Format a "row,col,halfKey" string key for half-cell lookups.
 */
export function cellHalfKey(r: number, c: number, halfKey: CellHalfKey): string {
  return `${r},${c},${halfKey}`;
}

/**
 * Parse a "row,col,halfKey" string key back into {row, col, halfKey}.
 */
export function parseCellHalfKey(key: string): { row: number; col: number; halfKey: CellHalfKey } {
  const parts = key.split(',');
  return {
    row: Number(parts[0]),
    col: Number(parts[1]),
    halfKey: (parts[2] ?? 'full') as CellHalfKey,
  };
}

/**
 * Check if (row, col) is within the grid bounds.
 * @param cells - 2D cells grid
 * @param r - Row index
 * @param c - Column index
 * @returns True if in bounds
 */
export function isInBounds(cells: CellGrid, r: number, c: number): boolean {
  return r >= 0 && r < cells.length && c >= 0 && c < (cells[0]?.length ?? 0);
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
export function snapToSquare(
  row: number,
  col: number,
  startRow: number,
  startCol: number,
  cells: CellGrid,
): { row: number; col: number } {
  const dr = row - startRow;
  const dc = col - startCol;
  const size = Math.max(Math.abs(dr), Math.abs(dc));
  return {
    row: Math.max(0, Math.min(cells.length - 1, startRow + (dr >= 0 ? size : -size))),
    col: Math.max(0, Math.min((cells[0]?.length ?? 1) - 1, startCol + (dc >= 0 ? size : -size))),
  };
}

/**
 * Normalize two corner coordinates into a top-left / bottom-right bounding box.
 * @param r1 - First corner row
 * @param c1 - First corner column
 * @param r2 - Second corner row
 * @param c2 - Second corner column
 */
export function normalizeBounds(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): { r1: number; c1: number; r2: number; c2: number } {
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
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

// ── Room bounds from cell key set ──────────────────────────────────────────

/**
 * Given a Set of "row,col" cell keys, compute the bounding box and center.
 * @param cellKeySet - Set of cell key strings
 */
export function roomBoundsFromKeys(
  cellKeySet: Set<string> | null | undefined,
): { r1: number; c1: number; r2: number; c2: number; centerRow: number; centerCol: number } | null {
  if (!cellKeySet || cellKeySet.size === 0) return null;
  let r1 = Infinity,
    c1 = Infinity,
    r2 = -Infinity,
    c2 = -Infinity;
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
  south: [1, 0],
  east: [0, 1],
  west: [0, -1],
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
export function setEdgeReciprocal(
  cells: CellGrid,
  row: number,
  col: number,
  direction: string,
  value: EdgeValue,
): void {
  const cell = cells[row]![col];
  if (!cell) return;
  setEdge(cell, direction as Direction, value);

  if (!DIR_OFFSET[direction]) return; // diagonal — no reciprocal
  const [dr, dc] = DIR_OFFSET[direction];
  const nr = row + dr,
    nc = col + dc;
  if (isInBounds(cells, nr, nc) && cells[nr]![nc]) {
    setEdge(cells[nr]![nc], OPPOSITE[direction as CardinalDirection], value);
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
  const cell = cells[row]![col];
  if (!cell) return;
  deleteEdge(cell, direction as Direction);

  if (!DIR_OFFSET[direction]) return; // diagonal — no reciprocal
  const [dr, dc] = DIR_OFFSET[direction];
  const nr = row + dr,
    nc = col + dc;
  if (isInBounds(cells, nr, nc) && cells[nr]![nc]) {
    deleteEdge(cells[nr]![nc], OPPOSITE[direction as CardinalDirection]);
  }
}
