import {
  state, pushUndo, markDirty, notify,
  validateBounds,
  cellKey, isInBounds, OPPOSITE, OFFSETS,
  roomTool,
  toInt,
  captureBeforeState, smartInvalidate,
} from './_shared.js';

export function getCellInfo(row, col) {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  return { success: true, cell: cell ? JSON.parse(JSON.stringify(cell)) : null };
}

export function paintCell(row, col) {
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

export function paintRect(r1, c1, r2, c2) {
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

export function eraseCell(row, col) {
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

export function eraseRect(r1, c1, r2, c2) {
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

export function createRoom(r1, c1, r2, c2, mode = 'room') {
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

export function createPolygonRoom(cellList, mode = 'room') {
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
      const reciprocal = OPPOSITE[dir];
      const neighborInRoom = cellSet.has(cellKey(nr, nc));

      if (mergeMode) {
        if (!inBounds_ || !neighborCell) {
          if (cell[dir] !== 'd' && cell[dir] !== 's') cell[dir] = 'w';
        } else {
          if (cell[dir] !== 'd' && cell[dir] !== 's') delete cell[dir];
          if (neighborCell[reciprocal] !== 'd' && neighborCell[reciprocal] !== 's') delete neighborCell[reciprocal];
        }
      } else {
        if (neighborInRoom) {
          if (cell[dir] !== 'd' && cell[dir] !== 's') delete cell[dir];
          if (neighborCell && neighborCell[reciprocal] !== 'd' && neighborCell[reciprocal] !== 's') delete neighborCell[reciprocal];
        } else {
          if (cell[dir] !== 'd' && cell[dir] !== 's') cell[dir] = 'w';
          if (neighborCell && neighborCell[reciprocal] !== 'd' && neighborCell[reciprocal] !== 's') neighborCell[reciprocal] = 'w';
        }
      }
    }
  }

  smartInvalidate(before, cells, { forceGeometry: true });
  markDirty();
  notify();
  return { success: true, count: cellList.length };
}
