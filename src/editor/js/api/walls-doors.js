import {
  state, pushUndo, markDirty, notify,
  validateBounds, ensureCell, setReciprocal, deleteReciprocal,
  CARDINAL_DIRS, ALL_DIRS, OPPOSITE,
} from './_shared.js';

export function setWall(row, col, direction) {
  if (!ALL_DIRS.includes(direction)) {
    throw new Error(`Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`);
  }
  const cell = ensureCell(row, col);
  pushUndo();
  cell[direction] = 'w';
  if (OPPOSITE[direction]) {
    setReciprocal(row, col, direction, 'w');
  }
  markDirty();
  notify();
  return { success: true };
}

export function removeWall(row, col, direction) {
  if (!ALL_DIRS.includes(direction)) {
    throw new Error(`Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`);
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell) return { success: true };
  pushUndo();
  delete cell[direction];
  if (OPPOSITE[direction]) {
    deleteReciprocal(row, col, direction);
  }
  markDirty();
  notify();
  return { success: true };
}

export function setDoor(row, col, direction, type = 'd') {
  if (!CARDINAL_DIRS.includes(direction)) {
    throw new Error(`Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`);
  }
  if (type !== 'd' && type !== 's') {
    throw new Error(`Invalid door type: ${type}. Use 'd' (normal) or 's' (secret).`);
  }
  const cell = ensureCell(row, col);
  pushUndo();
  cell[direction] = type;
  setReciprocal(row, col, direction, type);
  markDirty();
  notify();
  return { success: true };
}

export function removeDoor(row, col, direction) {
  if (!CARDINAL_DIRS.includes(direction)) {
    throw new Error(`Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`);
  }
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell) return { success: true };
  pushUndo();
  cell[direction] = 'w';
  setReciprocal(row, col, direction, 'w');
  markDirty();
  notify();
  return { success: true };
}
