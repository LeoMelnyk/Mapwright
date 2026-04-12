// furnish.ts — proposeFurnishing / commitFurnishing + back-compat autofurnish.
//
// Plan-then-commit furnishing replaces the previous black-box autofurnish.
// proposeFurnishing returns a structured plan (one entry per intended
// placement) without touching the map; commitFurnishing executes it.
// Callers can inspect/mutate the plan between phases.
//
// Design heuristics applied during proposal:
//  - Primary → secondary → scatter layering (DESIGN.md Rule #5)
//  - clustersWith metadata informs secondary selection
//  - Symmetric mode flanks primary along room centerline
//  - Light-emitting-prop count capped to avoid blow-out
//  - Door approach cells are excluded from candidate positions

import { state, getApi, ApiValidationError, parseCellKey, cellKey, OFFSETS, toDisp } from './_shared.js';

type Density = 'sparse' | 'normal' | 'dense';
type PlanRole = 'primary' | 'secondary' | 'flank' | 'scatter' | 'lit-fixture';

interface PlanEntry {
  role: PlanRole;
  prop: string;
  row: number;
  col: number;
  facing: number;
  reasoning: string;
}

interface RejectedEntry {
  prop: string;
  reason: string;
}

interface FurnishPlan {
  success: true;
  label: string;
  roomType: string;
  density: Density;
  plan: PlanEntry[];
  rejected: RejectedEntry[];
}

interface PropMeta {
  name: string;
  category: string;
  footprint: [number, number];
  facing: boolean;
  placement: string | null;
  roomTypes: string[];
  typicalCount: string | null;
  clustersWith: string[];
  notes: string | null;
  lights?: unknown[];
}

const DENSITY_BUDGET: Record<Density, { secondaries: number; scatter: number; flanks: boolean }> = {
  sparse: { secondaries: 1, scatter: 1, flanks: false },
  normal: { secondaries: 3, scatter: 2, flanks: true },
  dense: { secondaries: 5, scatter: 4, flanks: true },
};

function pickRandom<T>(arr: T[], rng: () => number = Math.random): T | undefined {
  if (!arr.length) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

/** Return cells inside the room that are not within 1 cell of any door. */
function nonDoorApproachCells(roomCells: Set<string>): Set<string> {
  const cells = state.dungeon.cells;
  const blocked = new Set<string>();
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const dir of ['north', 'south', 'east', 'west'] as const) {
      const v = (cell as Record<string, unknown>)[dir];
      if (v === 'd' || v === 's' || v === 'id') {
        blocked.add(key);
        const [dr, dc] = OFFSETS[dir];
        blocked.add(cellKey(r + dr, c + dc));
      }
    }
  }
  return new Set([...roomCells].filter((k) => !blocked.has(k)));
}

/** Find the cell closest to the centroid of the cell set. */
function centroidCell(roomCells: Set<string>): [number, number] {
  let sumR = 0,
    sumC = 0;
  const all: Array<[number, number]> = [];
  for (const k of roomCells) {
    const [r, c] = parseCellKey(k);
    sumR += r;
    sumC += c;
    all.push([r, c]);
  }
  const cR = sumR / all.length;
  const cC = sumC / all.length;
  let best = all[0];
  let bestDist = Infinity;
  for (const [r, c] of all) {
    const d = (r - cR) ** 2 + (c - cC) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = [r, c];
    }
  }
  return best;
}

/**
 * Compute a furnishing plan for a labeled room without touching the map.
 *
 * Returns one entry per intended placement with role, prop, position,
 * facing, and reasoning. Inspect or mutate the plan, then call
 * commitFurnishing(plan) to execute.
 *
 * Heuristics:
 *  - Primary feature anchored at room centroid
 *  - Secondary props biased toward the primary's clustersWith list
 *  - Optional symmetric flanks for formal rooms
 *  - Scatter props on remaining floor (door-approach cells excluded)
 *  - Light-emitting prop count capped to avoid intensity blow-out
 *
 * @param label Room label
 * @param roomType Semantic type (e.g. "throne-room", "library", "any")
 * @param options.density 'sparse' | 'normal' | 'dense'
 * @param options.symmetric Force symmetric secondary placement (default: auto)
 * @param options.lightCap Max light-emitting props (default 2)
 */
export function proposeFurnishing(
  label: string,
  roomType: string,
  options: { density?: Density; symmetric?: boolean; lightCap?: number } = {},
): FurnishPlan {
  const density = options.density ?? 'normal';
  if (!(density in DENSITY_BUDGET)) {
    throw new ApiValidationError('INVALID_DENSITY', `density must be sparse|normal|dense`, { density });
  }
  const lightCap = options.lightCap ?? 2;

  const api = getApi() as unknown as {
    _collectRoomCells: (l: string) => Set<string> | null;
    getPropsForRoomType: (rt: string) => { success: boolean; props: PropMeta[] };
    getValidPropPositions: (l: string, t: string, f?: number) => { success: boolean; positions: [number, number][] };
    getRoomBounds: (l: string) => { success: boolean; r1: number; c1: number; r2: number; c2: number };
  };

  const roomCells = api._collectRoomCells(label);
  if (!roomCells?.size) {
    throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${label}" not found`, { label });
  }

  const catalog = state.propCatalog;
  if (!catalog) {
    throw new ApiValidationError('NO_PROP_CATALOG', 'Prop catalog not loaded', {});
  }

  const propResult = api.getPropsForRoomType(roomType);
  const candidates: PropMeta[] = propResult.success ? propResult.props : [];
  const plan: PlanEntry[] = [];
  const rejected: RejectedEntry[] = [];

  // getPropsForRoomType strips fields like `lights` from its summary output —
  // look up the full def from the catalog when we need to check for lights.
  const isLitProp = (name: string): boolean => {
    const def = catalog.props[name] as { lights?: unknown[] } | undefined;
    return !!def?.lights?.length;
  };

  if (!candidates.length) {
    rejected.push({ prop: '*', reason: `No props tagged for roomType "${roomType}"` });
    return { success: true, label, roomType, density, plan, rejected };
  }

  // Group candidates by placement slot
  const bySlot = { wall: [], corner: [], center: [], floor: [], any: [] } as Record<string, PropMeta[]>;
  for (const p of candidates) {
    const slot = (p.placement ?? 'any').toLowerCase();
    (bySlot[slot] ?? bySlot.any).push(p);
  }

  // Track placements to avoid overlap and to enforce light cap
  const usedCells = new Set<string>(); // cellKey for occupied cells in the plan
  let lightBudget = lightCap;

  // ── 1. Primary (centerpiece) ─────────────────────────────────
  let primaryProp: PropMeta | undefined;
  let primaryRow: number | undefined;
  let primaryCol: number | undefined;
  if (bySlot.center.length) {
    primaryProp = pickRandom(bySlot.center);
    if (primaryProp) {
      const [pr, pc] = centroidCell(roomCells);
      primaryRow = pr;
      primaryCol = pc;
      usedCells.add(cellKey(pr, pc));
      const isLit = isLitProp(primaryProp.name);
      if (isLit) lightBudget--;
      plan.push({
        role: 'primary',
        prop: primaryProp.name,
        row: toDisp(pr),
        col: toDisp(pc),
        facing: 0,
        reasoning: `centerpiece for ${roomType}; placed at room centroid`,
      });
    }
  } else {
    rejected.push({ prop: '*', reason: 'no center-placement candidates' });
  }

  // ── 2. Symmetric flanks (if room has bilateral feel) ─────────
  // Flank with structural props (pillar, brazier, candelabra, statue)
  const wantsFlanks = options.symmetric ?? DENSITY_BUDGET[density].flanks;
  if (wantsFlanks && primaryProp && primaryRow != null && primaryCol != null) {
    const flankCandidates = candidates.filter(
      (p) =>
        p.name !== primaryProp.name &&
        (p.clustersWith.includes(primaryProp.name) ||
          ['pillar', 'brazier', 'candelabra', 'statue', 'torch-sconce'].includes(p.name)),
    );
    const flank = pickRandom(flankCandidates);
    if (flank) {
      const bounds = api.getRoomBounds(label);
      if (bounds.success) {
        // Mirror across vertical centerline
        const offset = 2;
        const lCol = primaryCol - offset;
        const rCol = primaryCol + offset;
        const flankFacing = flank.facing ? 90 : 0; // facing east on left, west on right (handled later)
        const isLit = isLitProp(flank.name);
        for (const [side, c, f] of [
          ['west', lCol, flank.facing ? 90 : 0],
          ['east', rCol, flank.facing ? 270 : 0],
        ] as Array<[string, number, number]>) {
          const k = cellKey(primaryRow, c);
          if (!roomCells.has(k) || usedCells.has(k)) {
            rejected.push({ prop: flank.name, reason: `flank ${side} out of room or occupied` });
            continue;
          }
          if (isLit && lightBudget <= 0) {
            rejected.push({ prop: flank.name, reason: 'light cap reached' });
            continue;
          }
          plan.push({
            role: 'flank',
            prop: flank.name,
            row: toDisp(primaryRow),
            col: toDisp(c),
            facing: f,
            reasoning: `symmetric flank ${side} of ${primaryProp.name}`,
          });
          usedCells.add(k);
          if (isLit) lightBudget--;
        }
        // Suppress unused warning
        void flankFacing;
      }
    }
  }

  // ── 3. Secondaries (clustersWith biased) ─────────────────────
  const secondaryBudget = DENSITY_BUDGET[density].secondaries;
  const secondaryPool = candidates.filter(
    (p) =>
      p.name !== primaryProp?.name && (p.placement === 'wall' || p.placement === 'corner' || p.placement === 'floor'),
  );
  // Sort: clustersWith primary first
  secondaryPool.sort((a, b) => {
    const aClust = primaryProp && a.clustersWith.includes(primaryProp.name) ? 0 : 1;
    const bClust = primaryProp && b.clustersWith.includes(primaryProp.name) ? 0 : 1;
    return aClust - bClust;
  });
  let added = 0;
  for (const sec of secondaryPool) {
    if (added >= secondaryBudget) break;
    const isLit = isLitProp(sec.name);
    if (isLit && lightBudget <= 0) continue;
    const positions = api.getValidPropPositions(label, sec.name, 0);
    if (!positions.success || !positions.positions.length) continue;
    // Filter out already-used cells and door approaches
    const safe = nonDoorApproachCells(roomCells);
    const valid = positions.positions.filter(([r, c]) => safe.has(cellKey(r, c)) && !usedCells.has(cellKey(r, c)));
    const pick = pickRandom(valid);
    if (!pick) continue;
    const [pr, pc] = pick;
    plan.push({
      role: isLit ? 'lit-fixture' : 'secondary',
      prop: sec.name,
      row: toDisp(pr),
      col: toDisp(pc),
      facing: 0,
      reasoning:
        primaryProp && sec.clustersWith.includes(primaryProp.name)
          ? `secondary clustersWith ${primaryProp.name}`
          : `secondary for ${roomType}`,
    });
    usedCells.add(cellKey(pr, pc));
    if (isLit) lightBudget--;
    added++;
  }

  // ── 4. Scatter ───────────────────────────────────────────────
  const scatterBudget = DENSITY_BUDGET[density].scatter;
  const scatterPool = candidates.filter((p) => p.placement === 'floor' || p.placement === 'any');
  let scattered = 0;
  for (let attempt = 0; attempt < scatterBudget * 4 && scattered < scatterBudget; attempt++) {
    const sc = pickRandom(scatterPool);
    if (!sc) break;
    const positions = api.getValidPropPositions(label, sc.name, 0);
    if (!positions.success) continue;
    const safe = nonDoorApproachCells(roomCells);
    const valid = positions.positions.filter(([r, c]) => safe.has(cellKey(r, c)) && !usedCells.has(cellKey(r, c)));
    const pick = pickRandom(valid);
    if (!pick) continue;
    const [pr, pc] = pick;
    plan.push({
      role: 'scatter',
      prop: sc.name,
      row: toDisp(pr),
      col: toDisp(pc),
      facing: 0,
      reasoning: 'scatter — adds life',
    });
    usedCells.add(cellKey(pr, pc));
    scattered++;
  }

  return { success: true, label, roomType, density, plan, rejected };
}

interface CommitResult {
  success: true;
  placed: Array<{ role: PlanRole; prop: string; row: number; col: number; facing: number }>;
  failed: Array<{ role: PlanRole; prop: string; row: number; col: number; error: string }>;
}

/**
 * Execute a furnishing plan produced by proposeFurnishing. The plan can be
 * mutated freely (drop entries, swap props, change positions) before
 * committing — each entry is just a placeProp call.
 *
 * Per-entry failures are recorded but don't halt the batch; check the
 * returned `failed` array.
 */
export function commitFurnishing(plan: unknown): CommitResult {
  if (plan == null || typeof plan !== 'object') {
    throw new ApiValidationError('INVALID_PLAN', 'commitFurnishing expects an array of plan entries or {plan:[]}', {});
  }
  const entries = Array.isArray(plan) ? (plan as PlanEntry[]) : (plan as { plan: PlanEntry[] }).plan;
  if (!Array.isArray(entries)) {
    throw new ApiValidationError('INVALID_PLAN', 'commitFurnishing expects an array of plan entries or {plan:[]}', {});
  }
  const api = getApi() as unknown as { placeProp: (r: number, c: number, t: string, f: number) => unknown };
  const placed: CommitResult['placed'] = [];
  const failed: CommitResult['failed'] = [];
  for (const entry of entries) {
    try {
      api.placeProp(entry.row, entry.col, entry.prop, entry.facing);
      placed.push({ role: entry.role, prop: entry.prop, row: entry.row, col: entry.col, facing: entry.facing });
    } catch (e) {
      failed.push({
        role: entry.role,
        prop: entry.prop,
        row: entry.row,
        col: entry.col,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { success: true, placed, failed };
}

interface AutofurnishResult {
  success: true;
  label: string;
  roomType: string;
  density: Density;
  placed: Array<{ type: string; row: number; col: number; via: string }>;
  skipped: Array<{ type: string; via: string; reason: string }>;
}

/**
 * Back-compat: propose then commit in one call. Prefer
 * proposeFurnishing + commitFurnishing for new code so you can inspect
 * the plan before committing.
 */
export function autofurnish(
  label: string,
  roomType: string,
  options: { density?: Density; preferWall?: 'north' | 'south' | 'east' | 'west' } = {},
): AutofurnishResult {
  void options.preferWall; // legacy option; new propose/commit uses room-derived geometry
  const proposal = proposeFurnishing(label, roomType, { density: options.density });
  const commit = commitFurnishing(proposal.plan);
  // Map new role names back to the legacy `via` labels existing callers/tests expect.
  const roleToVia = (role: PlanRole): string => {
    if (role === 'primary') return 'centerpiece';
    if (role === 'flank' || role === 'secondary' || role === 'lit-fixture') return 'wall';
    return 'scatter';
  };
  return {
    success: true,
    label: proposal.label,
    roomType: proposal.roomType,
    density: proposal.density,
    placed: commit.placed.map((p) => ({ type: p.prop, row: p.row, col: p.col, via: roleToVia(p.role) })),
    skipped: [
      ...commit.failed.map((f) => ({ type: f.prop, via: roleToVia(f.role), reason: f.error })),
      ...proposal.rejected.map((r) => ({ type: r.prop, via: 'select', reason: r.reason })),
    ],
  };
}

interface BriefRoom {
  label: string;
  role: string;
  density?: Density;
}

/**
 * Apply autofurnish to many rooms in one call. Each entry: { label, role,
 * density? }. Returns one result per room plus aggregate counts. Failures
 * on individual rooms are reported in the room's own result.
 */
export function furnishBrief(brief: { rooms: BriefRoom[] }): {
  success: true;
  rooms: AutofurnishResult[];
  totals: { placed: number; skipped: number };
} {
  if (!brief.rooms.length) {
    throw new ApiValidationError('EMPTY_BRIEF', 'furnishBrief requires brief.rooms[]', { brief });
  }
  const results: AutofurnishResult[] = [];
  let totalPlaced = 0,
    totalSkipped = 0;
  for (const r of brief.rooms) {
    try {
      const res = autofurnish(r.label, r.role, { density: r.density });
      results.push(res);
      totalPlaced += res.placed.length;
      totalSkipped += res.skipped.length;
    } catch (e) {
      results.push({
        success: true,
        label: r.label,
        roomType: r.role,
        density: r.density ?? 'normal',
        placed: [],
        skipped: [{ type: '*', via: 'autofurnish', reason: e instanceof Error ? e.message : String(e) }],
      });
      totalSkipped++;
    }
  }
  return { success: true, rooms: results, totals: { placed: totalPlaced, skipped: totalSkipped } };
}
