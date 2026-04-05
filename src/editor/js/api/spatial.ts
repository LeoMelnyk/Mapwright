import {
  getApi,
  CARDINAL_DIRS, OFFSETS,
  state, pushUndo, markDirty, notify, setReciprocal,
  cellKey, parseCellKey, floodFillRoom, roomBoundsFromKeys,
  toInt, toDisp,
} from './_shared.js';
import { isPropAt } from '../prop-spatial.js';

// ── Spatial Queries ───────────────────────────────────────────────────────

/**
 * Find the cell that holds a room's label marker. Read-only.
 * @param {string} label - Room label to search for
 * @returns {{ success: boolean, row?: number, col?: number, error?: string }}
 */
export function findCellByLabel(label: string): { success: boolean; row?: number; col?: number; error?: string } {
  const cells = state.dungeon.cells;
  const target = String(label);
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (cells[r][c]?.center?.label === target) return { success: true, row: toDisp(r), col: toDisp(c) };
    }
  }
  return { success: false, error: `Label "${label}" not found` };
}

/**
 * BFS from a label cell, stopping at walls, doors, secret doors, and diagonal walls.
 * @param {string} label - Room label
 * @returns {Set<string>|null} Set of "row,col" cell keys, or null if label not found
 */
export function _collectRoomCells(label: string): Set<string> | null {
  const start = getApi().findCellByLabel(label);
  if (!start.success) return null;
  return floodFillRoom(state.dungeon.cells, start.row, start.col);
}

/**
 * Return ordered wall cells along a specific side of a room.
 * @param {Set<string>} roomCellSet - Set of "row,col" cell keys for the room
 * @param {string} wall - 'north', 'south', 'east', or 'west'
 * @returns {Array<[number, number]>} Sorted [[row, col], ...] along the wall axis
 */
export function _getWallCells(roomCellSet: Set<string>, wall: string): [number, number][] {
  if (!CARDINAL_DIRS.includes(wall)) throw new Error(`wall must be one of: ${CARDINAL_DIRS.join(', ')}`);
  const result = [];
  const [dr, dc] = OFFSETS[wall];
  for (const key of roomCellSet) {
    const [r, c] = parseCellKey(key);
    if (!roomCellSet.has(cellKey(r + dr, c + dc))) {
      result.push([r, c]);
    }
  }
  if (wall === 'north' || wall === 'south') {
    result.sort((a, b) => a[1] - b[1]);
  } else {
    result.sort((a, b) => a[0] - b[0]);
  }
  return result;
}

/**
 * Check whether cell (r, c) is covered by any existing prop (anchor or spanned).
 * @param {number} r - Row index
 * @param {number} c - Column index
 * @returns {boolean} True if the cell is covered by a prop
 */
export function _isCellCoveredByProp(r: number, c: number): boolean {
  return isPropAt(r, c);
}

/**
 * BFS from the label cell through open edges to find the full room extent.
 * @param {string} label - Room label
 * @returns {{ r1: number, c1: number, r2: number, c2: number, centerRow: number, centerCol: number }|null}
 */
export function getRoomBounds(label: string): { r1: number; c1: number; r2: number; c2: number; centerRow: number; centerCol: number } | null {
  const roomCells = getApi()._collectRoomCells(label);
  const bounds = roomBoundsFromKeys(roomCells);
  if (!bounds) return null;
  return {
    r1: toDisp(bounds.r1), c1: toDisp(bounds.c1),
    r2: toDisp(bounds.r2), c2: toDisp(bounds.c2),
    centerRow: toDisp(bounds.centerRow), centerCol: toDisp(bounds.centerCol),
  };
}

/**
 * Find all wall/door positions on the shared boundary between two labeled rooms.
 * @param {string} label1 - First room label
 * @param {string} label2 - Second room label
 * @returns {Array<{ row: number, col: number, direction: string, type: string }>|null}
 */
export function findWallBetween(label1: string, label2: string): Array<{ row: number; col: number; direction: string; type: string }> | null {
  const room1Cells = getApi()._collectRoomCells(label1);
  const room2Cells = getApi()._collectRoomCells(label2);
  if (!room1Cells || !room2Cells) return null;

  const cells = state.dungeon.cells;
  const results = [];

  for (const key of room1Cells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const dir of CARDINAL_DIRS) {
      const [dr, dc] = OFFSETS[dir];
      const nr = r + dr, nc = c + dc;
      if (!room2Cells.has(cellKey(nr, nc))) continue;
      results.push({ row: toDisp(r), col: toDisp(c), direction: dir, type: cell[dir] || 'w' });
    }
  }

  return results.length > 0 ? results : null;
}

/**
 * Add an internal wall partition across a room.
 * direction: 'horizontal' (wall across rows) or 'vertical' (wall across cols).
 * position: the absolute row (horizontal) or col (vertical) where the wall goes.
 * wallType: 'w' (wall) or 'iw' (invisible wall). Default 'w'.
 * @param {string} roomLabel - Room label
 * @param {string} direction - 'horizontal' or 'vertical'
 * @param {number} position - Row (horizontal) or column (vertical) for the partition
 * @param {string} [wallType='w'] - 'w' (wall) or 'iw' (invisible wall)
 * @param {Object} [options] - { doorAt: number } to place a door at a specific position
 * @returns {{ success: boolean, wallsPlaced: number }}
 */
export function partitionRoom(roomLabel: string, direction: string, position: number, wallType: string = 'w', options: Record<string, any> = {}): { success: true; wallsPlaced: number } {
  if (!['horizontal', 'vertical'].includes(direction)) {
    throw new Error('direction must be "horizontal" or "vertical"');
  }
  if (!['w', 'iw'].includes(wallType)) {
    throw new Error('wallType must be "w" or "iw"');
  }
  position = toInt(position);
  const doorAt = options.doorAt != null ? toInt(options.doorAt) : undefined;

  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new Error(`Room "${roomLabel}" not found`);

  pushUndo();
  const cells = state.dungeon.cells;
  let count = 0;

  if (direction === 'horizontal') {
    for (const key of roomCells) {
      const [r, c] = parseCellKey(key);
      if (r !== position) continue;
      if (!roomCells.has(cellKey(r + 1, c))) continue;
      const val = (doorAt === c) ? 'd' : wallType;
      cells[r][c].south = val;
      setReciprocal(r, c, 'south', val);
      count++;
    }
  } else {
    for (const key of roomCells) {
      const [r, c] = parseCellKey(key);
      if (c !== position) continue;
      if (!roomCells.has(cellKey(r, c + 1))) continue;
      const val = (doorAt === r) ? 'd' : wallType;
      cells[r][c].east = val;
      setReciprocal(r, c, 'east', val);
      count++;
    }
  }

  if (count === 0) throw new Error(`No cells at ${direction} position ${position} in room "${roomLabel}"`);

  markDirty();
  notify();
  return { success: true, wallsPlaced: count };
}
