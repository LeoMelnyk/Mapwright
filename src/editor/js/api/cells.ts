import {
  state, pushUndo, markDirty, notify,
  validateBounds,
  cellKey, isInBounds, OPPOSITE, OFFSETS,
  roomTool,
  toInt,
  captureBeforeState, smartInvalidate,
} from './_shared.js';

/**
 * Get a deep copy of the cell data at the given position.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean, cell: Object|null }} Cell data or null if void
 */
export function getCellInfo(row: number, col: number): { success: true; cell: any } {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  return { success: true, cell: cell ? JSON.parse(JSON.stringify(cell)) : null };
}

/**
 * Paint a single cell (make it non-void).
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function paintCell(row: number, col: number): { success: true } {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  if (state.dungeon.cells[row][col] !== null) return { success: true };
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  state.dungeon.cells[row][col] = {};
  smartInvalidate(before, state.dungeon.cells, { forceGeometry: true });
  markDirty();
  notify();
  return { success: true };
}

/**
 * Paint all cells in a rectangular region.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @returns {{ success: boolean }}
 */
export function paintRect(r1: number, c1: number, r2: number, c2: number): { success: true } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const coords = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  const before = captureBeforeState(state.dungeon.cells, coords);
  pushUndo();
  const cells = state.dungeon.cells;
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (cells[r][c] === null) cells[r][c] = {};
    }
  }
  smartInvalidate(before, cells, { forceGeometry: true });
  markDirty();
  notify();
  return { success: true };
}

/**
 * Erase (void) a single cell.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function eraseCell(row: number, col: number): { success: true } {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  if (state.dungeon.cells[row][col] === null) return { success: true };
  const before = captureBeforeState(state.dungeon.cells, [{ row, col }]);
  pushUndo();
  state.dungeon.cells[row][col] = null;
  smartInvalidate(before, state.dungeon.cells, { forceGeometry: true });
  markDirty();
  notify();
  return { success: true };
}

/**
 * Erase (void) all cells in a rectangular region.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @returns {{ success: boolean }}
 */
export function eraseRect(r1: number, c1: number, r2: number, c2: number): { success: true } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const coords = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });
  const before = captureBeforeState(state.dungeon.cells, coords);
  pushUndo();
  const cells = state.dungeon.cells;
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      cells[r][c] = null;
    }
  }
  smartInvalidate(before, cells, { forceGeometry: true });
  markDirty();
  notify();
  return { success: true };
}

/**
 * Create a walled room from a rectangular region using the RoomTool.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @param {string} [mode='room'] - 'room' (walls on all edges) or 'merge' (walls only facing void)
 * @returns {{ success: boolean }}
 */
export function createRoom(r1: number, c1: number, r2: number, c2: number, mode: string = 'room'): { success: true } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);

  if (mode !== 'room' && mode !== 'merge') {
    throw new Error(`Invalid room mode: ${mode}. Use 'room' or 'merge'.`);
  }

  const selection = new Set();
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      selection.add(cellKey(r, c));
    }
  }

  const prevMode = state.roomMode;
  state.roomMode = mode;
  roomTool.dragStart = { row: minR, col: minC };
  roomTool.dragEnd = { row: maxR, col: maxC };
  roomTool._applyWalls();
  roomTool.dragStart = null;
  roomTool.dragEnd = null;
  state.roomMode = prevMode;

  notify();
  return { success: true };
}

/**
 * Create a walled room from an arbitrary list of cells (non-rectangular shapes).
 * @param {Array<[number, number]>} cellList - Array of [row, col] pairs
 * @param {string} [mode='room'] - 'room' or 'merge'
 * @returns {{ success: boolean, count: number }}
 */
export function createPolygonRoom(cellList: [number, number][], mode: string = 'room'): { success: true; count: number } {
  if (!Array.isArray(cellList) || cellList.length === 0) {
    throw new Error('cellList must be a non-empty array of [row, col] pairs');
  }
  cellList = cellList.map(([r, c]) => [toInt(r), toInt(c)]);
  for (const [r, c] of cellList) validateBounds(r, c);

  const cellSet = new Set(cellList.map(([r, c]) => cellKey(r, c)));
  const cells = state.dungeon.cells;
  const mergeMode = mode === 'merge';

  const coords = cellList.map(([r, c]) => ({ row: r, col: c }));
  const before = captureBeforeState(cells, coords);
  pushUndo();

  for (const [r, c] of cellList) {
    if (!cells[r][c]) cells[r][c] = {};
    const cell = cells[r][c];

    for (const dir of ['north', 'south', 'east', 'west']) {
      const [dr, dc] = OFFSETS[dir];
      const nr = r + dr, nc = c + dc;
      const inBounds_ = isInBounds(cells, nr, nc);
      const neighborCell = inBounds_ ? cells[nr][nc] : null;
      const reciprocal = (OPPOSITE as any)[dir];
      const neighborInRoom = cellSet.has(cellKey(nr, nc));

      if (mergeMode) {
        if (!inBounds_ || !neighborCell) {
          if ((cell as any)[dir] !== 'd' && (cell as any)[dir] !== 's') (cell as any)[dir] = 'w';
        } else {
          if ((cell as any)[dir] !== 'd' && (cell as any)[dir] !== 's') delete (cell as any)[dir];
          if ((neighborCell as any)[reciprocal] !== 'd' && (neighborCell as any)[reciprocal] !== 's') delete (neighborCell as any)[reciprocal];
        }
      } else {
        if (neighborInRoom) {
          if ((cell as any)[dir] !== 'd' && (cell as any)[dir] !== 's') delete (cell as any)[dir];
          if (neighborCell && (neighborCell as any)[reciprocal] !== 'd' && (neighborCell as any)[reciprocal] !== 's') delete (neighborCell as any)[reciprocal];
        } else {
          if ((cell as any)[dir] !== 'd' && (cell as any)[dir] !== 's') (cell as any)[dir] = 'w';
          if (neighborCell && (neighborCell as any)[reciprocal] !== 'd' && (neighborCell as any)[reciprocal] !== 's') (neighborCell as any)[reciprocal] = 'w';
        }
      }
    }
  }

  smartInvalidate(before, cells, { forceGeometry: true });
  markDirty();
  notify();
  return { success: true, count: cellList.length };
}
