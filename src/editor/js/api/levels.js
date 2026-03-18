import {
  state, pushUndo, markDirty, notify,
  invalidateAllCaches,
} from './_shared.js';

export function getLevels() {
  const levels = state.dungeon.metadata.levels || [];
  return {
    success: true,
    levels: levels.map((l, i) => ({
      index: i,
      name: l.name,
      startRow: l.startRow,
      numRows: l.numRows,
    })),
  };
}

export function renameLevel(levelIndex, newName) {
  const levels = state.dungeon.metadata.levels;
  if (!levels || levelIndex < 0 || levelIndex >= levels.length) {
    throw new Error(`Level index ${levelIndex} out of range (${levels?.length || 0} levels)`);
  }
  if (!newName || typeof newName !== 'string') {
    throw new Error('Level name must be a non-empty string');
  }
  pushUndo();
  levels[levelIndex].name = newName.trim();
  markDirty();
  notify();
  return { success: true };
}

export function resizeLevel(levelIndex, newRows) {
  const levels = state.dungeon.metadata.levels;
  if (!levels || levelIndex < 0 || levelIndex >= levels.length) {
    throw new Error(`Level index ${levelIndex} out of range (${levels?.length || 0} levels)`);
  }
  if (!Number.isInteger(newRows) || newRows < 1) {
    throw new Error('Row count must be a positive integer');
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

export function addLevel(name, numRows = 15) {
  if (!name || typeof name !== 'string') {
    throw new Error('Level name must be a non-empty string');
  }
  if (!Number.isInteger(numRows) || numRows < 1) {
    throw new Error('Row count must be a positive integer');
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

  if (!state.dungeon.metadata.levels) state.dungeon.metadata.levels = [];
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

export function defineLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error('levels must be a non-empty array of { name, startRow, numRows }');
  }
  const maxRow = state.dungeon.cells.length;
  for (const lvl of levels) {
    if (!lvl.name || typeof lvl.name !== 'string') throw new Error('Each level needs a name string');
    if (!Number.isInteger(lvl.startRow) || lvl.startRow < 0) throw new Error(`Invalid startRow: ${lvl.startRow}`);
    if (!Number.isInteger(lvl.numRows) || lvl.numRows < 1) throw new Error(`Invalid numRows: ${lvl.numRows}`);
    if (lvl.startRow + lvl.numRows > maxRow) {
      throw new Error(`Level "${lvl.name}" exceeds grid: startRow=${lvl.startRow} + numRows=${lvl.numRows} > ${maxRow} total rows`);
    }
  }
  pushUndo();
  state.dungeon.metadata.levels = levels.map(l => ({
    name: l.name.trim(),
    startRow: l.startRow,
    numRows: l.numRows,
  }));
  markDirty();
  notify();
  return { success: true };
}
