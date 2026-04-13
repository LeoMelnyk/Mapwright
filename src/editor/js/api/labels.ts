import { mutate, validateBounds, ensureCell, toInt, state } from './_shared.js';

/**
 * Set a room label on a cell, optionally at a specific world-feet position.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} text - Label text (e.g. "A1")
 * @param {number} [worldX] - World-feet X override for label position
 * @param {number} [worldY] - World-feet Y override for label position
 * @returns {{ success: boolean }}
 */
export function setLabel(
  row: number,
  col: number,
  text: string | number,
  worldX?: number,
  worldY?: number,
): { success: true } {
  row = toInt(row);
  col = toInt(col);
  const cell = ensureCell(row, col);
  const coords: Array<{ row: number; col: number }> = [{ row, col }];
  mutate('setLabel', coords, () => {
    cell.center ??= {};
    cell.center.label = String(text);
    // Store world-feet position if provided, otherwise clear any existing override
    if (worldX != null && worldY != null) {
      cell.center.labelX = worldX;
      cell.center.labelY = worldY;
    } else {
      delete cell.center.labelX;
      delete cell.center.labelY;
    }
  });
  return { success: true };
}

/**
 * Remove the label from a cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeLabel(row: number, col: number): { success: true } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row]![col];
  if (!cell?.center?.label) return { success: true };
  const coords: Array<{ row: number; col: number }> = [{ row, col }];
  mutate('removeLabel', coords, () => {
    delete cell.center!.label;
    delete cell.center!.labelX;
    delete cell.center!.labelY;
    if (Object.keys(cell.center!).length === 0) delete cell.center;
  });
  return { success: true };
}
