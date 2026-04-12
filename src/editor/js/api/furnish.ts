// furnish.ts — autofurnish + furnishBrief.
//
// Picks props from the catalog by `roomTypes` metadata and places them
// using the existing bulk methods (fillWallWithProps, scatterProps,
// placeProp). Returns a structured report of what was placed and what was
// skipped per source category.

import { state, getApi, ApiValidationError, parseCellKey, toDisp } from './_shared.js';

type Density = 'sparse' | 'normal' | 'dense';

interface AutofurnishResult {
  success: true;
  label: string;
  roomType: string;
  density: Density;
  placed: Array<{ type: string; row: number; col: number; via: string }>;
  skipped: Array<{ type: string; via: string; reason: string }>;
}

const DENSITY_BUDGET: Record<Density, { walls: number; floors: number; centerpiece: boolean }> = {
  sparse: { walls: 1, floors: 1, centerpiece: true },
  normal: { walls: 2, floors: 3, centerpiece: true },
  dense: { walls: 4, floors: 6, centerpiece: true },
};

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
}

function pickRandom<T>(arr: T[], rng: () => number = Math.random): T | undefined {
  if (!arr.length) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Auto-place a sensible set of props in a labeled room based on `roomType`.
 * Uses the catalog's per-prop `placement` (`wall`/`corner`/`center`/`floor`)
 * and `roomTypes` metadata.
 *
 * Density budgets:
 * - sparse: 1 wall prop, 1 floor prop, 1 centerpiece
 * - normal: 2 wall props, 3 floor props, 1 centerpiece
 * - dense:  4 wall props, 6 floor props, 1 centerpiece
 *
 * The room must be labeled. Wall placements pick a random wall per attempt.
 * Returns `{ placed, skipped }` per the bulk-placement convention.
 */
export function autofurnish(
  label: string,
  roomType: string,
  options: { density?: Density; preferWall?: 'north' | 'south' | 'east' | 'west' } = {},
): AutofurnishResult {
  const api = getApi() as unknown as {
    _collectRoomCells(l: string): Set<string> | null;
    getPropsForRoomType(roomType: string): { success: boolean; props: PropMeta[] };
    placeProp(row: number, col: number, type: string, facing?: number): { success: boolean };
    fillWallWithProps(
      label: string,
      type: string,
      wall: string,
      opts?: object,
    ): { success: boolean; placed: [number, number][]; skipped: Array<{ row: number; col: number; reason: string }> };
    scatterProps(
      label: string,
      type: string,
      count: number,
      opts?: object,
    ): {
      success: boolean;
      placed: [number, number][];
      skipped: Array<{ row: number; col: number; reason: string }>;
      available: number;
    };
  };

  const density = options.density ?? 'normal';
  if (!(density in DENSITY_BUDGET)) {
    throw new ApiValidationError('INVALID_DENSITY', `density must be one of: sparse, normal, dense`, { density });
  }

  const roomCells = api._collectRoomCells(label);
  if (!roomCells?.size) {
    throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${label}" not found`, { label });
  }

  const catalog = state.propCatalog;
  if (!catalog) {
    throw new ApiValidationError('NO_PROP_CATALOG', 'Prop catalog not loaded', {});
  }

  // Get candidate props for this room type (includes those tagged 'any')
  const propResult = api.getPropsForRoomType(roomType);
  const candidates: PropMeta[] = propResult.success ? propResult.props : [];
  if (!candidates.length) {
    return {
      success: true,
      label,
      roomType,
      density,
      placed: [],
      skipped: [{ type: '*', via: 'select', reason: `No props tagged for roomType "${roomType}"` }],
    };
  }

  // Group by placement
  const KNOWN_SLOTS = ['wall', 'corner', 'center', 'floor', 'any'] as const;
  type Slot = (typeof KNOWN_SLOTS)[number];
  const byPlacement: Record<Slot, PropMeta[]> = { wall: [], corner: [], center: [], floor: [], any: [] };
  const knownSet = new Set<string>(KNOWN_SLOTS);
  for (const p of candidates) {
    const raw = p.placement ?? 'any';
    const slot: Slot = knownSet.has(raw) ? (raw as Slot) : 'any';
    byPlacement[slot].push(p);
  }

  const placed: AutofurnishResult['placed'] = [];
  const skipped: AutofurnishResult['skipped'] = [];
  const budget = DENSITY_BUDGET[density];

  // 1. Centerpiece — find the actual interior cell closest to the room's
  //    cell-set centroid. Bbox center can land in void for L/U/+ shaped rooms,
  //    so we pick from the real cell set instead.
  if (budget.centerpiece && byPlacement.center.length) {
    const piece = pickRandom(byPlacement.center)!;
    let sumR = 0,
      sumC = 0;
    const allCells: Array<[number, number]> = [];
    for (const key of roomCells) {
      const [r, c] = parseCellKey(key);
      sumR += r;
      sumC += c;
      allCells.push([r, c]);
    }
    const cR = sumR / allCells.length,
      cC = sumC / allCells.length;
    let best = allCells[0];
    let bestDist = Infinity;
    for (const [r, c] of allCells) {
      const d = (r - cR) * (r - cR) + (c - cC) * (c - cC);
      if (d < bestDist) {
        bestDist = d;
        best = [r, c];
      }
    }
    const [pr, pc] = best;
    try {
      api.placeProp(toDisp(pr), toDisp(pc), piece.name);
      placed.push({ type: piece.name, row: toDisp(pr), col: toDisp(pc), via: 'centerpiece' });
    } catch (e) {
      skipped.push({ type: piece.name, via: 'centerpiece', reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // 2. Wall props (one per attempt against a random wall, capped by budget)
  const wallProps = byPlacement.wall.length ? byPlacement.wall : byPlacement.corner;
  const walls: Array<'north' | 'south' | 'east' | 'west'> = options.preferWall
    ? [options.preferWall]
    : ['north', 'east', 'south', 'west'];
  let wallBudget = budget.walls;
  for (const wall of walls) {
    if (wallBudget <= 0 || !wallProps.length) break;
    const piece = pickRandom(wallProps)!;
    const result = api.fillWallWithProps(label, piece.name, wall, { gap: 1 });
    for (const [r, c] of result.placed) placed.push({ type: piece.name, row: r, col: c, via: `wall:${wall}` });
    for (const s of result.skipped) skipped.push({ type: piece.name, via: `wall:${wall}`, reason: s.reason });
    if (result.placed.length > 0) wallBudget--;
  }

  // 3. Floor props (scatter)
  const floorProps = byPlacement.floor.length ? byPlacement.floor : byPlacement.any;
  if (floorProps.length && budget.floors > 0) {
    const piece = pickRandom(floorProps)!;
    const result = api.scatterProps(label, piece.name, budget.floors, { avoidWalls: 1 });
    for (const [r, c] of result.placed) placed.push({ type: piece.name, row: r, col: c, via: 'scatter' });
    for (const s of result.skipped) skipped.push({ type: piece.name, via: 'scatter', reason: s.reason });
  }

  return { success: true, label, roomType, density, placed, skipped };
}

interface BriefRoom {
  label: string;
  role: string;
  density?: Density;
}

/**
 * Apply `autofurnish` to many rooms in one call. Each entry: `{ label, role,
 * density? }`. Returns one result per room plus aggregate counts.
 *
 * Failures on individual rooms are reported in the room's own result; the
 * batch always returns success.
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
      // Room failed entirely — record an empty result with skipped reason
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
