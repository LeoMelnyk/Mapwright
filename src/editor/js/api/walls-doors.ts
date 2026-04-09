import type { CardinalDirection, Direction } from '../../../types.js';
import {
  state, mutate,
  validateBounds, ensureCell, setReciprocal, deleteReciprocal,
  CARDINAL_DIRS, ALL_DIRS, OPPOSITE,
  toInt,
  ApiValidationError,
} from './_shared.js';
import { setEdge, deleteEdge } from '../../../util/index.js';

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
    throw new ApiValidationError('INVALID_DIRECTION', `Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`, { direction, validDirections: ALL_DIRS, row, col });
  }
  const cell = ensureCell(row, col);
  mutate('Set wall', [{ row, col }], () => {
    setEdge(cell, direction as Direction, 'w');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    if (OPPOSITE[direction as CardinalDirection]) {
      setReciprocal(row, col, direction, 'w');
    }
  }, { topic: 'cells' });
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
    throw new ApiValidationError('INVALID_DIRECTION', `Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`, { direction, validDirections: ALL_DIRS, row, col });
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell) return { success: true };
  mutate('Remove wall', [{ row, col }], () => {
    deleteEdge(cell, direction as Direction);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
    if (OPPOSITE[direction as CardinalDirection]) {
      deleteReciprocal(row, col, direction);
    }
  }, { topic: 'cells' });
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
    throw new ApiValidationError('INVALID_DIRECTION', `Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`, { direction, validDirections: CARDINAL_DIRS, row, col });
  }
  if (type !== 'd' && type !== 's') {
    throw new Error(`Invalid door type: ${type}. Use 'd' (normal) or 's' (secret).`);
  }
  const cell = ensureCell(row, col);
  mutate('Set door', [{ row, col }], () => {
    setEdge(cell, direction as Direction, type);
    setReciprocal(row, col, direction, type);
  }, { topic: 'cells' });
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
    throw new ApiValidationError('INVALID_DIRECTION', `Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`, { direction, validDirections: CARDINAL_DIRS, row, col });
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell) return { success: true };
  mutate('Remove door', [{ row, col }], () => {
    setEdge(cell, direction as Direction, 'w');
    setReciprocal(row, col, direction, 'w');
  }, { topic: 'cells' });
  return { success: true };
}
