import {
  state, pushUndo, markDirty, notify,
  validateBounds, ensureCell,
  toInt,
} from './_shared.js';

export function setLabel(row, col, text) {
  row = toInt(row); col = toInt(col);
  const cell = ensureCell(row, col);
  pushUndo();
  if (!cell.center) cell.center = {};
  cell.center.label = String(text);
  markDirty();
  notify();
  return { success: true };
}

export function removeLabel(row, col) {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell?.center?.label) return { success: true };
  pushUndo();
  delete cell.center.label;
  if (Object.keys(cell.center).length === 0) delete cell.center;
  markDirty();
  notify();
  return { success: true };
}
