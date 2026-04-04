import {
  getApi,
  CARDINAL_DIRS, OFFSETS, OPPOSITE,
  state,
  cellKey,
  toInt, toDisp,
} from './_shared.js';

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Check for props blocking door cells or their approach cells.
 * @returns {{ success: boolean, clear: boolean, issues: Array<Object> }}
 */
export function validateDoorClearance() {
  const cells = state.dungeon.cells;
  const issues = [];

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        if (cell[dir] !== 'd' && cell[dir] !== 's') continue;
        if (getApi()._isCellCoveredByProp(r, c)) {
          issues.push({ row: toDisp(r), col: toDisp(c), direction: dir, doorType: cell[dir], problem: 'prop blocking door cell' });
        }
        const [dr, dc] = OFFSETS[dir];
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < cells.length && nc >= 0 && nc < (cells[nr]?.length || 0)) {
          if (getApi()._isCellCoveredByProp(nr, nc)) {
            issues.push({ row: toDisp(nr), col: toDisp(nc), direction: OPPOSITE[dir], doorType: cell[dir], problem: 'prop blocking door approach' });
          }
        }
      }
    }
  }

  return { success: true, clear: issues.length === 0, issues };
}

/**
 * BFS from entranceLabel through open edges and doors to verify all labeled rooms are reachable.
 * @param {string} entranceLabel - Room label to start BFS from
 * @returns {{ success: boolean, connected: boolean, reachable: Array<string>, unreachable: Array<string>, totalRooms: number, visitedCells: number }}
 */
export function validateConnectivity(entranceLabel) {
  const start = getApi().findCellByLabel(entranceLabel);
  if (!start.success) throw new Error(`Room "${entranceLabel}" not found`);

  const cells = state.dungeon.cells;
  const visited = new Set();
  // findCellByLabel returns display coords — convert to internal
  const startR = toInt(start.row), startC = toInt(start.col);
  const queue = [[startR, startC]];
  visited.add(cellKey(startR, startC));

  while (queue.length) {
    const [r, c] = queue.shift();
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const dir of CARDINAL_DIRS) {
      const edge = cell[dir];
      if (edge === 'w' || edge === 'iw') continue;
      const [dr, dc] = OFFSETS[dir];
      const nr = r + dr, nc = c + dc;
      const key = cellKey(nr, nc);
      if (visited.has(key)) continue;
      if (nr < 0 || nr >= cells.length || nc < 0 || nc >= (cells[nr]?.length || 0)) continue;
      if (!cells[nr]?.[nc]) continue;
      visited.add(key);
      queue.push([nr, nc]);
    }
  }

  const reachable = [];
  const unreachable = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const label = cells[r]?.[c]?.center?.label;
      if (label == null) continue;
      const labelStr = String(label);
      if (visited.has(cellKey(r, c))) reachable.push(labelStr);
      else unreachable.push(labelStr);
    }
  }

  return {
    success: true,
    connected: unreachable.length === 0,
    reachable,
    unreachable,
    totalRooms: reachable.length + unreachable.length,
    visitedCells: visited.size,
  };
}
