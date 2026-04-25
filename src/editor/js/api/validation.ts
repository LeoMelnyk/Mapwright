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
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
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
        const [dr, dc] = OFFSETS[dir]!;
        const nr = r + dr,
          nc = c + dc;
        if (nr >= 0 && nr < cells.length && nc >= 0 && nc < (cells[nr]?.length ?? 0)) {
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
  const queue: [number, number][] = [[startR, startC]];
  visited.add(cellKey(startR, startC));

  while (queue.length) {
    const [r, c] = queue.shift()!;
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const dir of CARDINAL_DIRS) {
      const edge = (cell as Record<string, unknown>)[dir];
      if (edge === 'w' || edge === 'iw') continue;
      const [dr, dc] = OFFSETS[dir]!;
      const nr = r + dr,
        nc = c + dc;
      const key = cellKey(nr, nc);
      if (visited.has(key)) continue;
      if (nr < 0 || nr >= cells.length || nc < 0 || nc >= (cells[nr]?.length ?? 0)) continue;
      if (!cells[nr]?.[nc]) continue;
      visited.add(key);
      queue.push([nr, nc]);
    }
  }

  const reachable = [];
  const unreachable = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
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

// ── critiqueMap ──────────────────────────────────────────────────────────

interface CritiqueFinding {
  lens: 'completeness' | 'lighting' | 'spatial' | 'composition';
  severity: 'error' | 'warning' | 'info';
  message: string;
  room?: string;
  row?: number;
  col?: number;
  context?: Record<string, unknown>;
}

/**
 * Run design heuristics against the current map and report findings.
 *
 * Lenses:
 *  - `completeness`: rooms with no props (likely unfinished); rooms with no
 *    centerpiece near centroid (reads as storage)
 *  - `lighting`: orphan light-emitting props with no light at their cell;
 *    rooms with summed light intensity above blow-out threshold; rooms
 *    with structural lighting prop placed but `lights:` not auto-added
 *  - `spatial`: door-clearance issues (delegates to validateDoorClearance);
 *    rooms with prop density outside reasonable bounds
 *  - `composition`: rooms with only one prop type (homogeneous = boring)
 *
 * Findings are sorted error → warning → info. Pass `{lenses: [...]}` to
 * restrict the run to specific lenses.
 *
 * @param options.lenses Subset of lenses to run. Default: all.
 * @param options.intensitySumThreshold Lighting blow-out threshold (default 2.5)
 */
export function critiqueMap(
  options: {
    lenses?: Array<'completeness' | 'lighting' | 'spatial' | 'composition'>;
    intensitySumThreshold?: number;
  } = {},
): { success: true; findingCount: number; findings: CritiqueFinding[] } {
  const lensesActive = new Set(options.lenses ?? ['completeness', 'lighting', 'spatial', 'composition']);
  const intensityThreshold = options.intensitySumThreshold ?? 2.5;
  const findings: CritiqueFinding[] = [];

  const api = getApi();

  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const propCatalog = state.propCatalog;

  // Build cell-to-room-label map and per-room prop bag
  const rooms = api.listRooms().rooms;
  const roomCellSets = new Map<string, Set<string>>();
  for (const room of rooms) {
    const set = api._collectRoomCells(room.label);
    if (set) roomCellSets.set(room.label, set);
  }

  // Per-room props (overlay props anchored within room)
  const roomProps = new Map<string, Array<{ type: string; row: number; col: number }>>();
  for (const [label] of roomCellSets) roomProps.set(label, []);
  for (const p of meta.props ?? []) {
    const pr = Math.floor(p.y / gs);
    const pc = Math.floor(p.x / gs);
    const key = cellKey(pr, pc);
    for (const [label, set] of roomCellSets) {
      if (set.has(key)) {
        roomProps.get(label)!.push({ type: p.type, row: pr, col: pc });
        break;
      }
    }
  }

  // ── Completeness lens ───────────────────────────────────────────────
  if (lensesActive.has('completeness')) {
    for (const [label, set] of roomCellSets) {
      const props = roomProps.get(label) ?? [];
      if (props.length === 0 && set.size >= 6) {
        findings.push({
          lens: 'completeness',
          severity: 'warning',
          message: `Room "${label}" has no props (${set.size} cells) — likely unfinished or reads as empty space`,
          room: label,
        });
      }
      // Centerpiece: any prop within 2 cells of the centroid?
      if (props.length > 0) {
        let sumR = 0,
          sumC = 0;
        for (const k of set) {
          const [r, c] = k.split(',').map(Number) as [number, number];
          sumR += r;
          sumC += c;
        }
        const cR = sumR / set.size;
        const cC = sumC / set.size;
        const hasCenter = props.some((p) => Math.hypot(p.row - cR, p.col - cC) <= 2);
        if (!hasCenter && set.size >= 12) {
          findings.push({
            lens: 'completeness',
            severity: 'info',
            message: `Room "${label}" has no centerpiece prop near centroid — may read as storage rather than purposeful space`,
            room: label,
            context: { centroid: { row: toDisp(Math.round(cR)), col: toDisp(Math.round(cC)) } },
          });
        }
      }
    }
  }

  // ── Lighting lens ───────────────────────────────────────────────────
  if (lensesActive.has('lighting')) {
    // Build light-emitting prop set
    const litPropTypes = new Set<string>();
    if (propCatalog) {
      for (const [name, def] of Object.entries(propCatalog.props)) {
        const lights = (def as { lights?: unknown[] }).lights;
        if (lights?.length) litPropTypes.add(name);
      }
    }

    // Per-room: sum of light intensity, count of lit-fixture props, count of lights
    for (const [label, set] of roomCellSets) {
      const props = roomProps.get(label) ?? [];
      let intensitySum = 0;
      let lightCount = 0;
      for (const light of meta.lights) {
        const lr = Math.floor(light.y / gs);
        const lc = Math.floor(light.x / gs);
        if (set.has(cellKey(lr, lc))) {
          intensitySum += light.intensity || 1.0;
          lightCount++;
        }
      }
      if (intensitySum > intensityThreshold) {
        findings.push({
          lens: 'lighting',
          severity: 'warning',
          message: `Room "${label}" has summed light intensity ${intensitySum.toFixed(2)} (>${intensityThreshold}) — likely blown out, reduce intensity or remove a source`,
          room: label,
          context: { intensitySum, lightCount },
        });
      }
      const litPropCount = props.filter((p) => litPropTypes.has(p.type)).length;
      if (litPropCount > 0 && lightCount === 0) {
        findings.push({
          lens: 'lighting',
          severity: 'error',
          message: `Room "${label}" has ${litPropCount} light-emitting prop(s) but zero lights — placement likely failed to add the linked light. Re-place the props.`,
          room: label,
          context: { litPropCount },
        });
      }
      if (litPropCount === 0 && set.size >= 12 && lightCount === 0) {
        findings.push({
          lens: 'lighting',
          severity: 'warning',
          message: `Room "${label}" has no lights and no light-emitting props — will be dark. Add a torch-sconce, brazier, or call placeLightInRoom.`,
          room: label,
        });
      }
    }
  }

  // ── Spatial lens ────────────────────────────────────────────────────
  if (lensesActive.has('spatial')) {
    const dc = api.validateDoorClearance();
    for (const issue of dc.issues) {
      findings.push({
        lens: 'spatial',
        severity: 'warning',
        message: `Door at (${issue.row},${issue.col}) ${issue.direction}: ${issue.problem}`,
        row: issue.row,
        col: issue.col,
      });
    }
    for (const [label, set] of roomCellSets) {
      const props = roomProps.get(label) ?? [];
      const density = props.length / Math.max(1, set.size);
      if (density > 0.5) {
        findings.push({
          lens: 'spatial',
          severity: 'warning',
          message: `Room "${label}" prop density ${(density * 100).toFixed(0)}% — overcrowded, consider thinning`,
          room: label,
          context: { props: props.length, cells: set.size },
        });
      }
    }
  }

  // ── Composition lens ────────────────────────────────────────────────
  if (lensesActive.has('composition')) {
    for (const [label, set] of roomCellSets) {
      const props = roomProps.get(label) ?? [];
      if (props.length < 3) continue;
      const types = new Set(props.map((p) => p.type));
      if (types.size === 1) {
        findings.push({
          lens: 'composition',
          severity: 'info',
          message: `Room "${label}" only contains "${[...types][0]}" props — homogeneous, consider mixing in supporting props per Rule #5 (primary/secondary/scatter)`,
          room: label,
          context: { propCount: props.length, roomCells: set.size },
        });
      }
    }
  }

  // Sort: error > warning > info
  const sevOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => sevOrder[a.severity]! - sevOrder[b.severity]!);

  return { success: true, findingCount: findings.length, findings };
}
