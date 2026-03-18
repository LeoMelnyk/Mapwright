import {
  state, pushUndo, markDirty, notify,
  validateBounds, ensureCell,
  loadTextureImages, paintTool,
} from './_shared.js';

export function setTexture(row, col, textureId, opacity = 1.0) {
  const cell = ensureCell(row, col);
  pushUndo();
  loadTextureImages(textureId);
  cell.texture = textureId;
  cell.textureOpacity = Math.max(0, Math.min(1, opacity));
  markDirty();
  notify();
  return { success: true };
}

export function removeTexture(row, col) {
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell?.texture) return { success: true };
  pushUndo();
  delete cell.texture;
  delete cell.textureOpacity;
  markDirty();
  notify();
  return { success: true };
}

export function setTextureRect(r1, c1, r2, c2, textureId, opacity = 1.0) {
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const clampedOpacity = Math.max(0, Math.min(1, opacity));
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
  markDirty();
  notify();
  return { success: true };
}

export function removeTextureRect(r1, c1, r2, c2) {
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
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
  markDirty();
  notify();
  return { success: true };
}

export function floodFillTexture(row, col, textureId, opacity = 1.0) {
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
