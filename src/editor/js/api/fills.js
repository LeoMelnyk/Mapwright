import {
  state, pushUndo, markDirty, notify,
  validateBounds, ensureCell,
} from './_shared.js';

export function setFill(row, col, fillType, depth) {
  if (!['pit', 'water', 'lava'].includes(fillType)) {
    throw new Error(`Invalid fill type: ${fillType}. Use 'pit', 'water', or 'lava'. For hazard, use setHazard().`);
  }
  const cell = ensureCell(row, col);
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
  markDirty();
  notify();
  return { success: true };
}

export function removeFill(row, col) {
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell?.fill) return { success: true };
  pushUndo();
  delete cell.fill;
  markDirty();
  notify();
  return { success: true };
}

export function setHazard(row, col, enabled = true) {
  const cell = ensureCell(row, col);
  pushUndo();
  if (enabled) {
    cell.hazard = true;
    if (cell.fill === 'difficult-terrain') delete cell.fill;
  } else {
    delete cell.hazard;
  }
  markDirty();
  notify();
  return { success: true };
}

export function setFillRect(r1, c1, r2, c2, fillType, depth) {
  if (!['pit', 'water', 'lava'].includes(fillType)) {
    throw new Error(`Invalid fill type: "${fillType}" (expected: pit, water, lava). For hazard, use setHazardRect().`);
  }
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
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
  markDirty();
  notify();
  return { success: true };
}

export function setHazardRect(r1, c1, r2, c2, enabled = true) {
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
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
  markDirty();
  notify();
  return { success: true };
}

export function removeFillRect(r1, c1, r2, c2) {
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  pushUndo();
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const cell = state.dungeon.cells[r]?.[c];
      if (cell) delete cell.fill;
    }
  }
  markDirty();
  notify();
  return { success: true };
}
