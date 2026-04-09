import type { TextureCatalog } from '../../../types.js';
import {
  state, pushUndo, markDirty, notify,
  validateBounds, ensureCell,
  loadTextureImages, paintTool,
  toInt,
  captureBeforeState, smartInvalidate,
  patchBlendForDirtyRegion,
} from './_shared.js';

function _blendPatch(minRow: number, minCol: number, maxRow: number, maxCol: number): void {
  const catalog = state.textureCatalog;
  if (!catalog) return;
  const theme = state.dungeon.metadata.theme;
  const themeObj = typeof theme === 'string' ? null : theme;
  const blendWidth = themeObj?.textureBlendWidth ?? 0.35;
  patchBlendForDirtyRegion(
    { minRow, maxRow, minCol, maxCol },
    state.dungeon.cells,
    state.dungeon.metadata.gridSize || 5,
    { catalog, blendWidth, texturesVersion: state.texturesVersion } as { catalog: TextureCatalog; blendWidth: number },
  );
}

/**
 * Apply a texture to a single cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} textureId - Texture catalog ID
 * @param {number} [opacity=1.0] - Texture opacity (0-1)
 * @returns {{ success: boolean }}
 */
export function setTexture(row: number, col: number, textureId: string, opacity: number = 1.0): { success: true } {
  row = toInt(row); col = toInt(col);
  const cell = ensureCell(row, col);
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  void loadTextureImages(textureId);
  cell.texture = textureId;
  cell.textureOpacity = Math.max(0, Math.min(1, opacity));
  smartInvalidate(before, state.dungeon.cells);
  _blendPatch(row, col, row, col);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Remove the texture from a single cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeTexture(row: number, col: number): { success: true } {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell?.texture) return { success: true };
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  delete cell.texture;
  delete cell.textureOpacity;
  smartInvalidate(before, state.dungeon.cells);
  _blendPatch(row, col, row, col);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Apply a texture to all cells in a rectangular region.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @param {string} textureId - Texture catalog ID
 * @param {number} [opacity=1.0] - Texture opacity (0-1)
 * @returns {{ success: boolean }}
 */
export function setTextureRect(r1: number, c1: number, r2: number, c2: number, textureId: string, opacity: number = 1.0): { success: true } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const clampedOpacity = Math.max(0, Math.min(1, opacity));
  const coords = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  const before = captureBeforeState(state.dungeon.cells, coords);
  void loadTextureImages(textureId);
  pushUndo();
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cell = state.dungeon.cells[r]?.[c];
      if (cell) {
        cell.texture = textureId;
        cell.textureOpacity = clampedOpacity;
      }
    }
  }
  smartInvalidate(before, state.dungeon.cells);
  _blendPatch(minR, minC, maxR, maxC);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Remove textures from all cells in a rectangular region.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @returns {{ success: boolean }}
 */
export function removeTextureRect(r1: number, c1: number, r2: number, c2: number): { success: true } {
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
        delete cell.texture;
        delete cell.textureOpacity;
      }
    }
  }
  smartInvalidate(before, state.dungeon.cells);
  _blendPatch(minR, minC, maxR, maxC);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Flood-fill a texture starting from a cell, spreading through the connected room.
 * @param {number} row - Starting row
 * @param {number} col - Starting column
 * @param {string} textureId - Texture catalog ID
 * @param {number} [opacity=1.0] - Texture opacity (0-1)
 * @returns {{ success: boolean }}
 */
export function floodFillTexture(row: number, col: number, textureId: string, opacity: number = 1.0): { success: boolean; error?: string } {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  if (!state.dungeon.cells[row]?.[col]) return { success: false, error: 'void cell' };
  const prevTexture = state.activeTexture;
  const prevOpacity = state.textureOpacity;
  const prevSecondary = state.paintSecondary;
  state.activeTexture = textureId;
  state.textureOpacity = Math.max(0, Math.min(1, opacity));
  state.paintSecondary = false;
  void loadTextureImages(textureId);
  paintTool.floodFill(row, col, null as unknown as MouseEvent);
  state.activeTexture = prevTexture;
  state.textureOpacity = prevOpacity;
  state.paintSecondary = prevSecondary;
  return { success: true };
}
