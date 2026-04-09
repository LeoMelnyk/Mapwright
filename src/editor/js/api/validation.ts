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
export function validateDoorClearance(): { success: true; clear: boolean; issues: { row: number; col: number; direction: string; doorType: string; problem: string }[] } {
  const cells = state.dungeon.cells;
  const issues = [];

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        if ((cell as Record<string, unknown>)[dir] !== 'd' && (cell as Record<string, unknown>)[dir] !== 's') continue;
        if (getApi()._isCellCoveredByProp(r, c)) {
          issues.push({ row: toDisp(r), col: toDisp(c), direction: dir, doorType: (cell as Record<string, unknown>)[dir] as string, problem: 'prop blocking door cell' });
        }
        const [dr, dc] = OFFSETS[dir];
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < cells.length && nc >= 0 && nc < (cells[nr]?.length || 0)) {
          if (getApi()._isCellCoveredByProp(nr, nc)) {
            issues.push({ row: toDisp(nr), col: toDisp(nc), direction: OPPOSITE[dir as keyof typeof OPPOSITE], doorType: (cell as Record<string, unknown>)[dir] as string, problem: 'prop blocking door approach' });
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
export function validateConnectivity(entranceLabel: string): { success: true; connected: boolean; reachable: string[]; unreachable: string[]; totalRooms: number; visitedCells: number } {
  const start = getApi().findCellByLabel(entranceLabel);
  if (!start.success) throw new Error(`Room "${entranceLabel}" not found`);

  const cells = state.dungeon.cells;
  const visited = new Set();
  // findCellByLabel returns display coords — convert to internal
  const startR = toInt(start.row!), startC = toInt(start.col!);
  const queue = [[startR, startC]];
  visited.add(cellKey(startR, startC));

  while (queue.length) {
    const [r, c] = queue.shift()!;
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const dir of CARDINAL_DIRS) {
      const edge = (cell as Record<string, unknown>)[dir];
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
      const labelStr = label;
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

// ── Batch Validation ──────────────────────────────────────────────────

const VALID_DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'nw-se', 'ne-sw']);
const VALID_CARDINAL = new Set(['north', 'south', 'east', 'west']);

/**
 * Validate a batch of commands against current state without mutating.
 * Performs input-level checks (bounds, direction validity, prop existence)
 * but does NOT simulate state changes between commands.
 */
export function validateBatch(commands: unknown[][]): {
  success: true;
  results: { index: number; valid: boolean; error?: string }[];
} {
  const cells = state.dungeon.cells;
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  const results: { index: number; valid: boolean; error?: string }[] = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (!Array.isArray(cmd) || cmd.length === 0) {
      results.push({ index: i, valid: false, error: 'Command must be a non-empty array' });
      continue;
    }
    const [method, ...args] = cmd;
    try {
      validateSingleCommand(method as string, args, rows, cols);
      results.push({ index: i, valid: true });
    } catch (e) {
      results.push({ index: i, valid: false, error: (e as Error).message });
    }
  }

  return { success: true, results };
}

function validateSingleCommand(method: string, args: unknown[], rows: number, cols: number): void {
  switch (method) {
    case 'paintCell':
    case 'eraseCell':
    case 'getCellInfo':
      checkBounds(args[0] as number, args[1] as number, rows, cols);
      break;
    case 'createRoom':
    case 'paintRect':
    case 'eraseRect':
      checkBounds(args[0] as number, args[1] as number, rows, cols);
      checkBounds(args[2] as number, args[3] as number, rows, cols);
      break;
    case 'setWall':
    case 'removeWall':
      checkBounds(args[0] as number, args[1] as number, rows, cols);
      if (!VALID_DIRECTIONS.has(args[2] as string)) throw new Error(`Invalid direction: ${String(args[2])}`);
      break;
    case 'setDoor':
    case 'removeDoor':
      checkBounds(args[0] as number, args[1] as number, rows, cols);
      if (!VALID_CARDINAL.has(args[2] as string)) throw new Error(`Invalid cardinal direction: ${String(args[2])}`);
      break;
    case 'placeProp': {
      checkBounds(args[0] as number, args[1] as number, rows, cols);
      const propType = args[2] as string;
      if (!state.propCatalog?.props[propType]) throw new Error(`Unknown prop type: ${propType}`);
      break;
    }
    case 'setFill':
    case 'setFillRect':
      // Fill type validated at runtime by the API
      break;
    case 'placeLight':
    case 'removeLight':
    case 'setAmbientLight':
    case 'setLightingEnabled':
    case 'setLabel':
    case 'removeLabel':
    case 'setTheme':
    case 'setName':
    case 'newMap':
    case 'undo':
    case 'redo':
      // These don't need pre-validation
      break;
    default:
      // Unknown methods pass validation — they'll fail at execution time
      break;
  }
}

function checkBounds(row: number, col: number, rows: number, cols: number): void {
  if (typeof row !== 'number' || typeof col !== 'number') throw new Error(`Row/col must be numbers, got ${typeof row}/${typeof col}`);
  if (row < 0 || row >= rows || col < 0 || col >= cols) throw new Error(`Cell (${row}, ${col}) out of bounds (${rows}x${cols})`);
}
