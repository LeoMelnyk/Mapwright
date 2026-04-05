import {
  state, pushUndo, markDirty, notify,
  validateBounds, ensureCell, setReciprocal, deleteReciprocal,
  CARDINAL_DIRS, ALL_DIRS, OPPOSITE,
  toInt,
  captureBeforeState, smartInvalidate,
} from './_shared.js';

/**
 * Place a wall on a cell edge (with reciprocal on neighbor).
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} direction - Edge direction (north, south, east, west, nw-se, ne-sw)
 * @returns {{ success: boolean }}
 */
export function setWall(row: number, col: number, direction: string): { success: true } {
  row = toInt(row); col = toInt(col);
  if (!ALL_DIRS.includes(direction)) {
    throw new Error(`Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`);
  }
  const cell = ensureCell(row, col);
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  cell[direction] = 'w';
  if (OPPOSITE[direction]) {
    setReciprocal(row, col, direction, 'w');
  }
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Remove a wall from a cell edge (and its reciprocal).
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} direction - Edge direction
 * @returns {{ success: boolean }}
 */
export function removeWall(row: number, col: number, direction: string): { success: true } {
  row = toInt(row); col = toInt(col);
  if (!ALL_DIRS.includes(direction)) {
    throw new Error(`Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`);
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell) return { success: true };
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  delete cell[direction];
  if (OPPOSITE[direction]) {
    deleteReciprocal(row, col, direction);
  }
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Place a door on a cell edge (with reciprocal on neighbor).
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} direction - Cardinal direction (north, south, east, west)
 * @param {string} [type='d'] - Door type: 'd' (normal) or 's' (secret)
 * @returns {{ success: boolean }}
 */
export function setDoor(row: number, col: number, direction: string, type: string = 'd'): { success: true } {
  row = toInt(row); col = toInt(col);
  if (!CARDINAL_DIRS.includes(direction)) {
    throw new Error(`Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`);
  }
  if (type !== 'd' && type !== 's') {
    throw new Error(`Invalid door type: ${type}. Use 'd' (normal) or 's' (secret).`);
  }
  const cell = ensureCell(row, col);
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  cell[direction] = type;
  setReciprocal(row, col, direction, type);
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Remove a door, reverting the edge back to a wall.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} direction - Cardinal direction (north, south, east, west)
 * @returns {{ success: boolean }}
 */
export function removeDoor(row: number, col: number, direction: string): { success: true } {
  row = toInt(row); col = toInt(col);
  if (!CARDINAL_DIRS.includes(direction)) {
    throw new Error(`Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`);
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell) return { success: true };
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  cell[direction] = 'w';
  setReciprocal(row, col, direction, 'w');
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}
