import {
  state, pushUndo, markDirty, notify,
  validateBounds, ensureCell,
  toInt,
  captureBeforeState, smartInvalidate,
} from './_shared.js';

/**
 * Set a fill type (pit, water, lava) on a single cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} fillType - 'pit', 'water', or 'lava'
 * @param {number} [depth] - Depth level 1-3 (for water/lava)
 * @returns {{ success: boolean }}
 */
export function setFill(row: number, col: number, fillType: string, depth?: number): { success: true } {
  row = toInt(row); col = toInt(col);
  if (!['pit', 'water', 'lava'].includes(fillType)) {
    throw new Error(`Invalid fill type: ${fillType}. Use 'pit', 'water', or 'lava'. For hazard, use setHazard().`);
  }
  const cell = ensureCell(row, col);
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  cell.fill = fillType;
  const d = (depth >= 1 && depth <= 3) ? depth : 1;
  if (fillType === 'water') {
    cell.waterDepth = d;
    delete cell.lavaDepth;
  } else if (fillType === 'lava') {
    cell.lavaDepth = d;
    delete cell.waterDepth;
  } else {
    delete cell.waterDepth;
    delete cell.lavaDepth;
  }
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Remove any fill from a single cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeFill(row: number, col: number): { success: true } {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell?.fill) return { success: true };
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  delete cell.fill;
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Set or remove the hazard (difficult terrain) flag on a cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {boolean} [enabled=true] - Whether to enable or disable the hazard
 * @returns {{ success: boolean }}
 */
export function setHazard(row: number, col: number, enabled: boolean = true): { success: true } {
  row = toInt(row); col = toInt(col);
  const cell = ensureCell(row, col);
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  if (enabled) {
    cell.hazard = true;
    if (cell.fill === 'difficult-terrain') delete cell.fill;
  } else {
    delete cell.hazard;
  }
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Set a fill type on all cells in a rectangular region.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @param {string} fillType - 'pit', 'water', or 'lava'
 * @param {number} [depth] - Depth level 1-3 (for water/lava)
 * @returns {{ success: boolean }}
 */
export function setFillRect(r1: number, c1: number, r2: number, c2: number, fillType: string, depth?: number): { success: true } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  if (!['pit', 'water', 'lava'].includes(fillType)) {
    throw new Error(`Invalid fill type: "${fillType}" (expected: pit, water, lava). For hazard, use setHazardRect().`);
  }
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const coords = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  const before = captureBeforeState(state.dungeon.cells, coords);
  pushUndo();
  const wd = (depth >= 1 && depth <= 3) ? depth : 1;
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cell = state.dungeon.cells[r]?.[c];
      if (cell) {
        cell.fill = fillType;
        if (fillType === 'water') {
          cell.waterDepth = wd;
          delete cell.lavaDepth;
        } else if (fillType === 'lava') {
          cell.lavaDepth = wd;
          delete cell.waterDepth;
        } else {
          delete cell.waterDepth;
          delete cell.lavaDepth;
        }
      }
    }
  }
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Set or remove hazard flag on all cells in a rectangular region.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @param {boolean} [enabled=true] - Whether to enable or disable hazard
 * @returns {{ success: boolean }}
 */
export function setHazardRect(r1: number, c1: number, r2: number, c2: number, enabled: boolean = true): { success: true } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const coords = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  const before = captureBeforeState(state.dungeon.cells, coords);
  pushUndo();
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cell = state.dungeon.cells[r]?.[c];
      if (cell) {
        if (enabled) {
          cell.hazard = true;
          if (cell.fill === 'difficult-terrain') delete cell.fill;
        } else {
          delete cell.hazard;
        }
      }
    }
  }
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Remove fills from all cells in a rectangular region.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @returns {{ success: boolean }}
 */
export function removeFillRect(r1: number, c1: number, r2: number, c2: number): { success: true } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const coords = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  const before = captureBeforeState(state.dungeon.cells, coords);
  pushUndo();
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cell = state.dungeon.cells[r]?.[c];
      if (cell) delete cell.fill;
    }
  }
  smartInvalidate(before, state.dungeon.cells);
  markDirty();
  notify();
  return { success: true };
}
