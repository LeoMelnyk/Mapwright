import {
  getApi,
  CARDINAL_DIRS,
  OFFSETS,
  OPPOSITE,
  state,
  cellKey,
  toInt,
  toDisp,
  ApiValidationError,
} from './_shared.js';

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Check for props blocking door cells or their approach cells.
 * @returns {{ success: boolean, clear: boolean, issues: Array<Object> }}
 */
export function validateDoorClearance(): {
  success: true;
  clear: boolean;
  issues: { row: number; col: number; direction: string; doorType: string; problem: string }[];
} {
  const cells = state.dungeon.cells;
  const issues = [];

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        if ((cell as Record<string, unknown>)[dir] !== 'd' && (cell as Record<string, unknown>)[dir] !== 's') continue;
        if (getApi()._isCellCoveredByProp(r, c)) {
          issues.push({
            row: toDisp(r),
            col: toDisp(c),
            direction: dir,
            doorType: (cell as Record<string, unknown>)[dir] as string,
            problem: 'prop blocking door cell',
          });
        }
        const [dr, dc] = OFFSETS[dir];
        const nr = r + dr,
          nc = c + dc;
        if (nr >= 0 && nr < cells.length && nc >= 0 && nc < (cells[nr]?.length || 0)) {
          if (getApi()._isCellCoveredByProp(nr, nc)) {
            issues.push({
              row: toDisp(nr),
              col: toDisp(nc),
              direction: OPPOSITE[dir as keyof typeof OPPOSITE],
              doorType: (cell as Record<string, unknown>)[dir] as string,
              problem: 'prop blocking door approach',
            });
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
export function validateConnectivity(entranceLabel: string): {
  success: true;
  connected: boolean;
  reachable: string[];
  unreachable: string[];
  totalRooms: number;
  visitedCells: number;
} {
  const start = getApi().findCellByLabel(entranceLabel);
  if (!start.success)
    throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${entranceLabel}" not found`, { label: entranceLabel });

  const cells = state.dungeon.cells;
  const visited = new Set();
  // findCellByLabel returns display coords — convert to internal
  const startR = toInt(start.row!),
    startC = toInt(start.col!);
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
      const nr = r + dr,
        nc = c + dc;
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

// ── Dry-Run Validation ────────────────────────────────────────────────
//
// `explainCommand` and `validateCommands` simulate execution against the
// real editor API by snapshotting state, dispatching, then restoring.
// This catches every error the live call would raise (including chained
// effects like prop-blocks-door for follow-up commands).

interface DryRunResult {
  index: number;
  method: string;
  ok: boolean;
  error?: string;
  code?: string;
  context?: Record<string, unknown>;
  result?: unknown;
}

function snapshot(): { dungeon: string; undoLen: number; redoLen: number } {
  return {
    dungeon: JSON.stringify(state.dungeon),
    undoLen: state.undoStack.length,
    redoLen: state.redoStack.length,
  };
}

function restore(snap: { dungeon: string; undoLen: number; redoLen: number }): void {
  state.dungeon = JSON.parse(snap.dungeon);
  state.undoStack.length = snap.undoLen;
  state.redoStack.length = snap.redoLen;
}

async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  const api = getApi() as unknown as Record<string, (...a: unknown[]) => unknown>;
  const fn = api[method];
  if (typeof fn !== 'function') {
    throw new ApiValidationError('UNKNOWN_METHOD', `unknown method: ${method}`, { method });
  }
  return await fn.apply(api, args);
}

/** Extract message/code/context from any thrown value into a partial DryRunResult. */
function errorFields(e: unknown): { error: string; code?: string; context?: Record<string, unknown> } {
  if (e instanceof ApiValidationError) {
    return { error: e.message, code: e.code, context: e.context };
  }
  if (e instanceof Error) {
    return { error: e.message };
  }
  return { error: String(e) };
}

/**
 * Dry-run a single command against the current state without mutating.
 * Returns what the command would do, or the structured error it would raise.
 *
 * Mutating commands are executed against a snapshot and rolled back; pure
 * read methods return their result directly.
 */
export async function explainCommand(method: string, ...args: unknown[]): Promise<DryRunResult> {
  const snap = snapshot();
  try {
    const result = await dispatch(method, args);
    restore(snap);
    return { index: 0, method, ok: true, result };
  } catch (e) {
    restore(snap);
    return { index: 0, method, ok: false, ...errorFields(e) };
  }
}

/**
 * Dry-run a batch of commands sequentially. Each command sees the cumulative
 * effect of previous commands in the batch. Full state is restored at the end.
 *
 * Returns one result per command. Use `stopOnError: true` to halt at the first
 * failure (default false — runs all and reports each independently).
 */
export async function validateCommands(
  commands: unknown[][],
  options: { stopOnError?: boolean } = {},
): Promise<{ success: true; allOk: boolean; results: DryRunResult[] }> {
  const stopOnError = options.stopOnError === true;
  const snap = snapshot();
  const results: DryRunResult[] = [];

  try {
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      if (!Array.isArray(cmd) || cmd.length === 0) {
        results.push({
          index: i,
          method: '',
          ok: false,
          error: 'Command must be a non-empty array',
          code: 'INVALID_COMMAND',
        });
        if (stopOnError) break;
        continue;
      }
      const [method, ...args] = cmd as [string, ...unknown[]];
      try {
        const result = await dispatch(method, args);
        results.push({ index: i, method, ok: true, result });
      } catch (e) {
        results.push({ index: i, method, ok: false, ...errorFields(e) });
        if (stopOnError) break;
      }
    }
  } finally {
    restore(snap);
  }

  return { success: true, allOk: results.every((r) => r.ok), results };
}
