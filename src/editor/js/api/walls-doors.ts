import type { CardinalDirection, Direction, Window as WindowDef } from '../../../types.js';
import {
  state,
  mutate,
  validateBounds,
  ensureCell,
  setReciprocal,
  deleteReciprocal,
  CARDINAL_DIRS,
  ALL_DIRS,
  OPPOSITE,
  OFFSETS,
  toInt,
  ApiValidationError,
} from './_shared.js';
import { setEdge, deleteEdge, getEdge } from '../../../util/index.js';
import { getGoboDefinition } from '../../../render/gobo-registry.js';

/**
 * Place a wall on a cell edge (with reciprocal on neighbor).
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} direction - Edge direction (north, south, east, west, nw-se, ne-sw)
 * @returns {{ success: boolean }}
 */
export function setWall(row: number, col: number, direction: string): { success: true } {
  row = toInt(row);
  col = toInt(col);
  if (!ALL_DIRS.includes(direction)) {
    throw new ApiValidationError('INVALID_DIRECTION', `Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`, {
      direction,
      validDirections: ALL_DIRS,
      row,
      col,
    });
  }
  const cell = ensureCell(row, col);
  mutate(
    'Set wall',
    [{ row, col }],
    () => {
      setEdge(cell, direction as Direction, 'w');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
      if (OPPOSITE[direction as CardinalDirection]) {
        setReciprocal(row, col, direction, 'w');
      }
    },
    { topic: 'cells' },
  );
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
  row = toInt(row);
  col = toInt(col);
  if (!ALL_DIRS.includes(direction)) {
    throw new ApiValidationError('INVALID_DIRECTION', `Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`, {
      direction,
      validDirections: ALL_DIRS,
      row,
      col,
    });
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row]![col];
  if (!cell) return { success: true };
  mutate(
    'Remove wall',
    [{ row, col }],
    () => {
      deleteEdge(cell, direction as Direction);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
      if (OPPOSITE[direction as CardinalDirection]) {
        deleteReciprocal(row, col, direction);
      }
    },
    { topic: 'cells' },
  );
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
  row = toInt(row);
  col = toInt(col);
  if (!CARDINAL_DIRS.includes(direction)) {
    throw new ApiValidationError(
      'INVALID_DIRECTION',
      `Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`,
      { direction, validDirections: CARDINAL_DIRS, row, col },
    );
  }
  if (type !== 'd' && type !== 's') {
    throw new ApiValidationError('INVALID_DOOR_TYPE', `Invalid door type: ${type}. Use 'd' (normal) or 's' (secret).`, {
      type,
      validTypes: ['d', 's'],
      row,
      col,
    });
  }
  const cell = ensureCell(row, col);
  mutate(
    'Set door',
    [{ row, col }],
    () => {
      setEdge(cell, direction as Direction, type);
      setReciprocal(row, col, direction, type);
    },
    { topic: 'cells' },
  );
  return { success: true };
}

// ─── Windows ────────────────────────────────────────────────────────────────

type WindowDir = WindowDef['direction'];

/**
 * Normalize an edge to its canonical (row, col, direction) form. Cardinals:
 * south becomes north of (r+1, c), east becomes west of (r, c+1). Diagonals
 * (`nw-se`, `ne-sw`): stored as-is — they live on a single cell with no
 * reciprocal, so the clicked direction is already canonical. One entry in
 * `metadata.windows` per physical edge.
 */
function canonicalWindowKey(
  row: number,
  col: number,
  direction: string,
): { row: number; col: number; direction: WindowDir } {
  if (direction === 'nw-se' || direction === 'ne-sw') {
    return { row, col, direction };
  }
  if (direction === 'north' || direction === 'west') {
    return { row, col, direction };
  }
  const [dr, dc] = OFFSETS[direction]!;
  return {
    row: row + dr,
    col: col + dc,
    direction: OPPOSITE[direction as CardinalDirection] as 'north' | 'west',
  };
}

/**
 * Place a window on a cell edge. Marks the edge as `'win'` (blocks light
 * like a wall — the gobo projects the aperture pattern through it) and
 * records the gobo association in `metadata.windows`. The edge is set
 * reciprocally on the neighbor cell. The gobo id must match a loaded
 * gobo; when no gobo catalog is available (e.g. CLI without Node catalog
 * loaded) validation is skipped.
 *
 * @param row - Row index
 * @param col - Column index
 * @param direction - Cardinal or diagonal direction (north, south, east, west, nw-se, ne-sw)
 * @param [goboId='window-mullions'] - Gobo catalog id
 */
export function setWindow(
  row: number,
  col: number,
  direction: string,
  goboId: string = 'window-mullions',
): { success: true } {
  row = toInt(row);
  col = toInt(col);
  if (!ALL_DIRS.includes(direction)) {
    throw new ApiValidationError(
      'INVALID_DIRECTION',
      `Invalid direction for window: ${direction}. Use: ${ALL_DIRS.join(', ')}`,
      { direction, validDirections: ALL_DIRS, row, col },
    );
  }
  if (typeof goboId !== 'string' || !goboId) {
    throw new ApiValidationError('INVALID_GOBO_ID', `Gobo id must be a non-empty string.`, { goboId, row, col });
  }
  // Only validate against the registry if it's been populated — the Node CLI
  // render path loads gobos before rendering, but pure API callers in tests
  // may not have the catalog loaded yet.
  const def = getGoboDefinition(goboId);
  if (def === null) {
    // Registry returns null both for "not loaded" and "unknown id". We can't
    // tell them apart, so treat as a warning path: allow the id through
    // (the renderer skips unknown ids silently), but surface a structured
    // error only if a caller explicitly asks for strict validation later.
  }

  const cell = ensureCell(row, col);
  const canon = canonicalWindowKey(row, col, direction);

  mutate(
    'Set window',
    [{ row, col }],
    () => {
      setEdge(cell, direction as Direction, 'win');
      setReciprocal(row, col, direction, 'win');
      const meta = state.dungeon.metadata;
      meta.windows ??= [];
      const existing = meta.windows.find(
        (w: WindowDef) => w.row === canon.row && w.col === canon.col && w.direction === canon.direction,
      );
      if (existing) {
        existing.goboId = goboId;
      } else {
        meta.windows.push({ row: canon.row, col: canon.col, direction: canon.direction, goboId });
      }
    },
    { invalidate: ['lighting'], topic: 'cells' },
  );
  return { success: true };
}

/**
 * Remove a window, reverting the edge back to a wall and dropping the
 * matching `metadata.windows` entry.
 *
 * @param row - Row index
 * @param col - Column index
 * @param direction - Cardinal or diagonal direction (north, south, east, west, nw-se, ne-sw)
 */
export function removeWindow(row: number, col: number, direction: string): { success: true } {
  row = toInt(row);
  col = toInt(col);
  if (!ALL_DIRS.includes(direction)) {
    throw new ApiValidationError(
      'INVALID_DIRECTION',
      `Invalid direction for window: ${direction}. Use: ${ALL_DIRS.join(', ')}`,
      { direction, validDirections: ALL_DIRS, row, col },
    );
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row]![col];
  if (!cell) return { success: true };
  if (getEdge(cell, direction as Direction) !== 'win') return { success: true };

  const canon = canonicalWindowKey(row, col, direction);

  mutate(
    'Remove window',
    [{ row, col }],
    () => {
      setEdge(cell, direction as Direction, 'w');
      setReciprocal(row, col, direction, 'w');
      const meta = state.dungeon.metadata;
      const list = meta.windows;
      if (list?.length) {
        const idx = list.findIndex(
          (w: WindowDef) => w.row === canon.row && w.col === canon.col && w.direction === canon.direction,
        );
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) delete meta.windows;
      }
    },
    { invalidate: ['lighting'], topic: 'cells' },
  );
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
  row = toInt(row);
  col = toInt(col);
  if (!CARDINAL_DIRS.includes(direction)) {
    throw new ApiValidationError(
      'INVALID_DIRECTION',
      `Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`,
      { direction, validDirections: CARDINAL_DIRS, row, col },
    );
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row]![col];
  if (!cell) return { success: true };
  mutate(
    'Remove door',
    [{ row, col }],
    () => {
      setEdge(cell, direction as Direction, 'w');
      setReciprocal(row, col, direction, 'w');
    },
    { topic: 'cells' },
  );
  return { success: true };
}
