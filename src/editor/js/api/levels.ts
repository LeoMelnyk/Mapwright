import {
  state,
  pushUndo,
  markDirty,
  notify,
  invalidateAllCaches,
  toInt,
  toDisp,
  ApiValidationError,
} from './_shared.js';

/**
 * Get all level definitions with display coordinates.
 * @returns {{ success: boolean, levels: Array<Object> }}
 */
export function getLevels(): {
  success: true;
  levels: { index: number; name: string | null; startRow: number; numRows: number }[];
} {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
  const levels = state.dungeon.metadata.levels || [];
  return {
    success: true,
    levels: levels.map((l, i) => ({
      index: i,
      name: l.name,
      startRow: toDisp(l.startRow),
      numRows: toDisp(l.numRows),
    })),
  };
}

/**
 * Rename a level by index.
 * @param {number} levelIndex - Zero-based level index
 * @param {string} newName - New name for the level
 * @returns {{ success: boolean }}
 */
export function renameLevel(levelIndex: number, newName: string): { success: true } {
  const levels = state.dungeon.metadata.levels;
  if (levelIndex < 0 || levelIndex >= levels.length) {
    throw new ApiValidationError(
      'LEVEL_OUT_OF_RANGE',
      `Level index ${levelIndex} out of range (${levels.length} levels)`,
      { levelIndex, totalLevels: levels.length },
    );
  }
  if (!newName || typeof newName !== 'string') {
    throw new ApiValidationError('INVALID_LEVEL_NAME', 'Level name must be a non-empty string', {
      received: newName,
      type: typeof newName,
    });
  }
  pushUndo();
  levels[levelIndex].name = newName.trim();
  markDirty();
  notify();
  return { success: true };
}

/**
 * Resize a level to a new row count (adds or removes rows at the end).
 * @param {number} levelIndex - Zero-based level index
 * @param {number} newRows - New number of rows for the level
 * @returns {{ success: boolean }}
 */
export function resizeLevel(levelIndex: number, newRows: number): { success: true } {
  newRows = toInt(newRows);
  const levels = state.dungeon.metadata.levels;
  if (levelIndex < 0 || levelIndex >= levels.length) {
    throw new ApiValidationError(
      'LEVEL_OUT_OF_RANGE',
      `Level index ${levelIndex} out of range (${levels.length} levels)`,
      { levelIndex, totalLevels: levels.length },
    );
  }
  if (newRows < 1) {
    throw new ApiValidationError('INVALID_ROW_COUNT', 'Row count must be a positive integer', { received: newRows });
  }

  const level = levels[levelIndex];
  if (newRows === level.numRows) return { success: true };

  pushUndo();

  const cells = state.dungeon.cells;
  const numCols = cells[0]?.length || 30;
  const delta = newRows - level.numRows;
  const levelEnd = level.startRow + level.numRows;

  if (delta > 0) {
    const newCellRows = [];
    for (let i = 0; i < delta; i++) {
      const row = [];
      for (let c = 0; c < numCols; c++) row.push(null);
      newCellRows.push(row);
    }
    cells.splice(levelEnd, 0, ...newCellRows);
  } else {
    cells.splice(levelEnd + delta, -delta);
  }

  level.numRows = newRows;

  for (let i = levelIndex + 1; i < levels.length; i++) {
    levels[i].startRow += delta;
  }

  invalidateAllCaches();
  markDirty();
  notify();
  return { success: true };
}

/**
 * Add a new level below the current ones with a void separator row.
 * @param {string} name - Level name
 * @param {number} [numRows=15] - Number of rows for the new level
 * @returns {{ success: boolean, levelIndex: number }}
 */
export function addLevel(name: string, numRows: number = 15): { success: true; levelIndex: number } {
  numRows = toInt(numRows);
  if (!name || typeof name !== 'string') {
    throw new ApiValidationError('INVALID_LEVEL_NAME', 'Level name must be a non-empty string', {
      received: name,
      type: typeof name,
    });
  }
  if (numRows < 1) {
    throw new ApiValidationError('INVALID_ROW_COUNT', 'Row count must be a positive integer', { received: numRows });
  }

  pushUndo();

  const cells = state.dungeon.cells;
  const currentRows = cells.length;
  const numCols = cells[0]?.length || 30;

  for (let r = 0; r < 1 + numRows; r++) {
    const row = [];
    for (let c = 0; c < numCols; c++) row.push(null);
    cells.push(row);
  }

  state.dungeon.metadata.levels.push({
    name: name.trim(),
    startRow: currentRows + 1,
    numRows,
  });

  state.currentLevel = state.dungeon.metadata.levels.length - 1;
  invalidateAllCaches();
  markDirty();
  notify();
  return { success: true, levelIndex: state.currentLevel };
}

/**
 * Replace all level definitions with a new set (must fit within the existing grid).
 * @param {Array<{ name: string, startRow: number, numRows: number }>} levels - Level definitions
 * @returns {{ success: boolean }}
 */
export function defineLevels(levels: Array<{ name: string; startRow: number; numRows: number }>): { success: true } {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new ApiValidationError('INVALID_LEVELS', 'levels must be a non-empty array of { name, startRow, numRows }', {
      received: levels,
    });
  }
  const maxRow = state.dungeon.cells.length;
  for (const lvl of levels) {
    if (!lvl.name || typeof lvl.name !== 'string')
      throw new ApiValidationError('INVALID_LEVEL_NAME', 'Each level needs a name string', { level: lvl });
    const sr = toInt(lvl.startRow);
    const nr = toInt(lvl.numRows);
    if (sr < 0)
      throw new ApiValidationError('INVALID_START_ROW', `Invalid startRow: ${lvl.startRow}`, {
        level: lvl,
        startRow: lvl.startRow,
      });
    if (nr < 1)
      throw new ApiValidationError('INVALID_ROW_COUNT', `Invalid numRows: ${lvl.numRows}`, {
        level: lvl,
        numRows: lvl.numRows,
      });
    if (sr + nr > maxRow) {
      throw new ApiValidationError(
        'LEVEL_EXCEEDS_GRID',
        `Level "${lvl.name}" exceeds grid: startRow=${lvl.startRow} + numRows=${lvl.numRows} > ${toDisp(maxRow)} total rows`,
        { level: lvl.name, startRow: lvl.startRow, numRows: lvl.numRows, maxRows: toDisp(maxRow) },
      );
    }
  }
  pushUndo();
  state.dungeon.metadata.levels = levels.map((l) => ({
    name: l.name.trim(),
    startRow: toInt(l.startRow),
    numRows: toInt(l.numRows),
  }));
  markDirty();
  notify();
  return { success: true };
}
