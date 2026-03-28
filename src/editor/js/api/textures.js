import {
  state, pushUndo, markDirty, notify,
  validateBounds, ensureCell,
  loadTextureImages, paintTool,
  toInt,
  captureBeforeState, smartInvalidate,
  patchBlendForDirtyRegion,
} from './_shared.js';

function _blendPatch(minRow, minCol, maxRow, maxCol) {
  const catalog = state.textureCatalog;
  if (!catalog) return;
  const theme = state.dungeon.metadata.theme;
  const themeObj = typeof theme === 'string' ? null : theme;
  const blendWidth = themeObj?.textureBlendWidth ?? 0.35;
  patchBlendForDirtyRegion(
    { minRow, maxRow, minCol, maxCol },
    state.dungeon.cells,
    state.dungeon.metadata.gridSize || 5,
    { catalog, blendWidth, texturesVersion: state.texturesVersion ?? 0 },
  );
}

export function setTexture(row, col, textureId, opacity = 1.0) {
  row = toInt(row); col = toInt(col);
  const cell = ensureCell(row, col);
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  loadTextureImages(textureId);
  cell.texture = textureId;
  cell.textureOpacity = Math.max(0, Math.min(1, opacity));
  smartInvalidate(before, state.dungeon.cells);
  _blendPatch(row, col, row, col);
  markDirty();
  notify();
  return { success: true };
}

export function removeTexture(row, col) {
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

export function setTextureRect(r1, c1, r2, c2, textureId, opacity = 1.0) {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const clampedOpacity = Math.max(0, Math.min(1, opacity));
  const coords = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  const before = captureBeforeState(state.dungeon.cells, coords);
  loadTextureImages(textureId);
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

export function removeTextureRect(r1, c1, r2, c2) {
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

export function floodFillTexture(row, col, textureId, opacity = 1.0) {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  if (!state.dungeon.cells[row]?.[col]) return { success: false, error: 'void cell' };
  const prevTexture = state.activeTexture;
  const prevOpacity = state.textureOpacity;
  const prevSecondary = state.paintSecondary;
  state.activeTexture = textureId;
  state.textureOpacity = Math.max(0, Math.min(1, opacity));
  state.paintSecondary = false;
  loadTextureImages(textureId);
  paintTool.floodFill(row, col, null);
  state.activeTexture = prevTexture;
  state.textureOpacity = prevOpacity;
  state.paintSecondary = prevSecondary;
  return { success: true };
}
