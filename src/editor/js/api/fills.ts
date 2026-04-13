import type { FillType } from '../../../types.js';
import { state, mutate, validateBounds, ensureCell, toInt, ApiValidationError } from './_shared.js';
import { normalizeRect } from './_rect-utils.js';

/**
 * Set a fill type (pit, water, lava) on a single cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} fillType - 'pit', 'water', or 'lava'
 * @param {number} [depth] - Depth level 1-3 (for water/lava)
 * @returns {{ success: boolean }}
 */
export function setFill(row: number, col: number, fillType: string, depth: number = 1): { success: true } {
  row = toInt(row);
  col = toInt(col);
  if (!['pit', 'water', 'lava'].includes(fillType)) {
    throw new ApiValidationError(
      'INVALID_FILL_TYPE',
      `Invalid fill type: ${fillType}. Use 'pit', 'water', or 'lava'. For hazard, use setHazard().`,
      { fillType },
    );
  }
  const cell = ensureCell(row, col);
  const coords: Array<{ row: number; col: number }> = [{ row, col }];
  mutate('setFill', coords, () => {
    cell.fill = fillType as FillType;
    const d = depth >= 1 && depth <= 3 ? depth : 1;
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
  });
  return { success: true };
}

/**
 * Remove any fill from a single cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeFill(row: number, col: number): { success: true } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row]![col];
  if (!cell?.fill) return { success: true };
  const coords: Array<{ row: number; col: number }> = [{ row, col }];
  mutate('removeFill', coords, () => {
    delete cell.fill;
  });
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
  row = toInt(row);
  col = toInt(col);
  const cell = ensureCell(row, col);
  const coords: Array<{ row: number; col: number }> = [{ row, col }];
  mutate('setHazard', coords, () => {
    if (enabled) {
      cell.hazard = true;
      if ((cell.fill as string) === 'difficult-terrain') delete cell.fill;
    } else {
      delete cell.hazard;
    }
  });
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
export function setFillRect(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  fillType: string,
  depth: number = 1,
): { success: true } {
  if (!['pit', 'water', 'lava'].includes(fillType)) {
    throw new ApiValidationError(
      'INVALID_FILL_TYPE',
      `Invalid fill type: "${fillType}" (expected: pit, water, lava). For hazard, use setHazardRect().`,
      { fillType },
    );
  }
  const { minR, maxR, minC, maxC } = normalizeRect(r1, c1, r2, c2);
  const coords: Array<{ row: number; col: number }> = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  mutate('setFillRect', coords, () => {
    const wd = depth >= 1 && depth <= 3 ? depth : 1;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell) {
          cell.fill = fillType as FillType;
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
  });
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
export function setHazardRect(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  enabled: boolean = true,
): { success: true } {
  const { minR, maxR, minC, maxC } = normalizeRect(r1, c1, r2, c2);
  const coords: Array<{ row: number; col: number }> = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  mutate('setHazardRect', coords, () => {
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell) {
          if (enabled) {
            cell.hazard = true;
            if ((cell.fill as string) === 'difficult-terrain') delete cell.fill;
          } else {
            delete cell.hazard;
          }
        }
      }
    }
  });
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
  const { minR, maxR, minC, maxC } = normalizeRect(r1, c1, r2, c2);
  const coords: Array<{ row: number; col: number }> = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  mutate('removeFillRect', coords, () => {
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell) delete cell.fill;
      }
    }
  });
  return { success: true };
}
