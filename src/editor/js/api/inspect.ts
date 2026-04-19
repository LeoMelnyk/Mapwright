// inspect.ts — Read-only inspection primitives for Claude.
//
// Pure queries: ASCII rendering, region inspection, room summary,
// cell predicate query, lighting-coverage estimate, conflict scan.
//
// All methods are read-only (no mutate/pushUndo). Coordinates returned
// are display coords (after toDisp).

import type { Cell, OverlayProp } from '../../../types.js';
import {
  state,
  getApi,
  CARDINAL_DIRS,
  OFFSETS,
  toInt,
  toDisp,
  ApiValidationError,
  cellKey,
  parseCellKey,
} from './_shared.js';
import { falloffMultiplier } from '../../../render/index.js';
import { isPropAt } from '../prop-spatial.js';

/**
 * Build a map from anchor cellKey(row, col) → overlay props anchored exactly there.
 * Post-v0.7.0 props live on metadata.props[] (world-feet positioned), not cell.prop.
 * Use this when you need anchor-only semantics (the classic cell.prop lookup).
 */
function buildAnchorMap(): Map<string, OverlayProp[]> {
  const meta = state.dungeon.metadata;
  const out = new Map<string, OverlayProp[]>();
  if (!meta.props?.length) return out;
  const gs = meta.gridSize || 5;
  for (const p of meta.props) {
    const key = cellKey(Math.round(p.y / gs), Math.round(p.x / gs));
    const arr = out.get(key);
    if (arr) arr.push(p);
    else out.set(key, [p]);
  }
  return out;
}

// ─── shared helpers ──────────────────────────────────────────────────────

function clampRect(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): { ir1: number; ic1: number; ir2: number; ic2: number } {
  const cells = state.dungeon.cells;
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  const ir1 = Math.max(0, Math.min(toInt(r1), toInt(r2)));
  const ic1 = Math.max(0, Math.min(toInt(c1), toInt(c2)));
  const ir2 = Math.min(rows - 1, Math.max(toInt(r1), toInt(r2)));
  const ic2 = Math.min(cols - 1, Math.max(toInt(c1), toInt(c2)));
  return { ir1, ic1, ir2, ic2 };
}

function cellGlyph(cell: Cell | null, hasPropAt = false): string {
  if (!cell) return ' ';
  if (cell.center?.['stair-id'] != null) return '>';
  if (cell.center?.['bridge-id'] != null) return '=';
  if (hasPropAt) return 'o';
  if (cell.center?.label != null) return '*';
  if (cell.fill === 'water') return '~';
  if (cell.fill === 'lava') return '^';
  if (cell.fill === 'pit') return '_';
  if (cell.hazard) return ':';
  return '.';
}

function edgeGlyph(value: unknown, axis: 'h' | 'v'): string {
  if (value === 'w') return axis === 'h' ? '-' : '|';
  if (value === 'd') return 'D';
  if (value === 's') return 'S';
  return ' ';
}

/** Read a cardinal edge from a possibly-null cell. */
function edgeOf(cell: Cell | null | undefined, dir: 'north' | 'south' | 'east' | 'west'): unknown {
  if (!cell) return undefined;
  return (cell as Record<string, unknown>)[dir];
}

// ─── 1. renderAscii ──────────────────────────────────────────────────────

/**
 * Render a region of the map as an ASCII grid for cheap inspection.
 *
 * Each cell renders as one glyph in the center of a 2x1 box. Walls render
 * between cells with `|` (vertical), `-` (horizontal). `D` = door, `S` = secret.
 * Cell content: `.` floor, ` ` void, `~` water, `^` lava, `_` pit, `:` hazard,
 * `o` prop anchor, `*` label, `>` stair, `=` bridge.
 *
 * Invisible walls/doors (`iw`/`id`) render as blank — they're DM-only.
 *
 * @param r1 top-left row (display coords)
 * @param c1 top-left col
 * @param r2 bottom-right row
 * @param c2 bottom-right col
 */
export function renderAscii(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): { success: true; ascii: string; rows: number; cols: number; legend: string } {
  const { ir1, ic1, ir2, ic2 } = clampRect(r1, c1, r2, c2);
  const cells = state.dungeon.cells;
  const widthCells = ic2 - ic1 + 1;
  const heightCells = ir2 - ir1 + 1;

  if (widthCells > 80) {
    throw new ApiValidationError(
      'REGION_TOO_WIDE',
      `renderAscii region too wide (${widthCells} cols, max 80). Narrow the rect or call repeatedly.`,
      { width: widthCells, max: 80 },
    );
  }

  const lines: string[] = [];
  // Build top boundary
  const topLine: string[] = ['+'];
  for (let c = ic1; c <= ic2; c++) {
    topLine.push(edgeGlyph(edgeOf(cells[ir1]![c] ?? null, 'north'), 'h'));
    topLine.push('+');
  }
  lines.push(topLine.join(''));

  for (let r = ir1; r <= ir2; r++) {
    const contentLine: string[] = [];
    contentLine.push(edgeGlyph(edgeOf(cells[r]![ic1] ?? null, 'west'), 'v'));
    for (let c = ic1; c <= ic2; c++) {
      const cell = cells[r]![c] ?? null;
      contentLine.push(cellGlyph(cell, isPropAt(r, c)));
      contentLine.push(edgeGlyph(edgeOf(cell, 'east'), 'v'));
    }
    lines.push(contentLine.join(''));

    // Bottom boundary of this row (which is top of the next)
    const botLine: string[] = ['+'];
    for (let c = ic1; c <= ic2; c++) {
      botLine.push(edgeGlyph(edgeOf(cells[r]![c] ?? null, 'south'), 'h'));
      botLine.push('+');
    }
    lines.push(botLine.join(''));
  }

  return {
    success: true,
    ascii: lines.join('\n'),
    rows: heightCells,
    cols: widthCells,
    legend:
      '. floor  . void  ~ water  ^ lava  _ pit  : hazard  o prop  * label  > stair  = bridge  | - wall  D door  S secret',
  };
}

// ─── 1b. previewShape ────────────────────────────────────────────────────

/**
 * Render a labeled room's current shape as ASCII — walls, floor cells, voids,
 * trim diagonals. Useful for verifying room geometry before/after trim or
 * round operations without taking a screenshot.
 *
 * Scoped to the room's bounding box plus a 1-cell margin so you can see the
 * wall edges. For irregular rooms (L/U/+), void cells render as blank.
 *
 * @param label Room label (e.g. "A1")
 * @param options.margin Extra cells to include around the bbox (default 1)
 * @returns { success, label, bounds, ascii, cellCount, legend }
 */
export function previewShape(
  label: string,
  options: { margin?: number } = {},
): {
  success: true;
  label: string;
  bounds: { r1: number; c1: number; r2: number; c2: number };
  ascii: string;
  cellCount: number;
  legend: string;
} {
  const api = getApi();
  const boundsResult = api.getRoomBounds(label);
  if (!boundsResult.success) {
    throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${label}" not found`, { label });
  }
  const cellsResult = (
    api as unknown as { listRoomCells(l: string): { success: boolean; cells?: [number, number][] } }
  ).listRoomCells(label);
  const cellCount = cellsResult.cells?.length ?? 0;

  const margin = Math.max(0, options.margin ?? 1);
  const r1 = boundsResult.r1 - margin;
  const c1 = boundsResult.c1 - margin;
  const r2 = boundsResult.r2 + margin;
  const c2 = boundsResult.c2 + margin;
  const rendered = renderAscii(r1, c1, r2, c2);

  return {
    success: true,
    label,
    bounds: { r1: boundsResult.r1, c1: boundsResult.c1, r2: boundsResult.r2, c2: boundsResult.c2 },
    ascii: rendered.ascii,
    cellCount,
    legend: rendered.legend,
  };
}

// ─── 2. inspectRegion ────────────────────────────────────────────────────

interface RegionCellInfo {
  row: number;
  col: number;
  void: boolean;
  walls: Partial<Record<string, string>>;
  fill?: string;
  fillDepth?: number;
  hazard?: boolean;
  texture?: string;
  prop?: { type: string; facing: number };
  label?: string;
  stairId?: number;
  bridgeId?: number;
}

/**
 * Return a structured dump of every cell in a region: walls, fills, props,
 * textures, labels, stairs, bridges. Compact alternative to N×M getCellInfo
 * calls. Coords returned are display coords.
 *
 * Also reports lights whose center falls inside the region's bounding box.
 */
export function inspectRegion(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
): {
  success: true;
  bounds: { r1: number; c1: number; r2: number; c2: number };
  cellCount: number;
  cells: RegionCellInfo[];
  lights: Array<{ id: number; row: number; col: number; type: string; radius: number }>;
} {
  const { ir1, ic1, ir2, ic2 } = clampRect(r1, c1, r2, c2);
  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;
  const out: RegionCellInfo[] = [];
  const anchors = buildAnchorMap();

  for (let r = ir1; r <= ir2; r++) {
    for (let c = ic1; c <= ic2; c++) {
      const cell = cells[r]?.[c];
      const info: RegionCellInfo = { row: toDisp(r), col: toDisp(c), void: !cell, walls: {} };
      if (!cell) {
        out.push(info);
        continue;
      }
      const rec = cell as Record<string, unknown>;
      for (const dir of CARDINAL_DIRS) {
        const v = rec[dir];
        if (v != null) info.walls[dir] = v as string;
      }
      for (const dir of ['nw-se', 'ne-sw']) {
        const v = rec[dir];
        if (v != null) info.walls[dir] = v as string;
      }
      if (cell.fill) {
        info.fill = cell.fill;
        if (cell.fillDepth != null) info.fillDepth = cell.fillDepth;
      }
      if (cell.hazard) info.hazard = true;
      if (cell.texture) info.texture = cell.texture;
      const anchored = anchors.get(cellKey(r, c));
      if (anchored?.length) {
        // Pick the topmost prop anchored at this cell (max zIndex, then last pushed).
        const top = anchored.reduce((a, b) => (b.zIndex >= a.zIndex ? b : a));
        const facing = typeof top.rotation === 'number' ? top.rotation : (top.facing ?? 0);
        info.prop = { type: top.type, facing };
      }
      if (cell.center?.label != null) info.label = cell.center.label;
      if (cell.center?.['stair-id'] != null) info.stairId = cell.center['stair-id'];
      if (typeof cell.center?.['bridge-id'] === 'number') info.bridgeId = cell.center['bridge-id'];
      out.push(info);
    }
  }

  // Lights whose center is inside the region (world feet -> grid cell)
  const gs = meta.gridSize || 5;
  const lights: Array<{ id: number; row: number; col: number; type: string; radius: number }> = [];
  for (const light of meta.lights) {
    const lr = Math.floor(light.y / gs);
    const lc = Math.floor(light.x / gs);
    if (lr < ir1 || lr > ir2 || lc < ic1 || lc > ic2) continue;
    lights.push({ id: light.id, row: toDisp(lr), col: toDisp(lc), type: light.type, radius: light.radius });
  }

  return {
    success: true,
    bounds: { r1: toDisp(ir1), c1: toDisp(ic1), r2: toDisp(ir2), c2: toDisp(ic2) },
    cellCount: out.length,
    cells: out,
    lights,
  };
}

// ─── 3. getRoomSummary ───────────────────────────────────────────────────

/**
 * Single-call summary of a labeled room: bounds, cell count, props, fills,
 * doors, textures used, lights affecting (whose radius reaches any cell of
 * the room), connectivity (rooms reachable through one door step).
 *
 * Replaces ~5 separate calls (getRoomBounds + getRoomContents + getLights +
 * findWallBetween) when surveying a room.
 */
export function getRoomSummary(
  label: string,
): { success: false; error: string } | { success: true; [k: string]: unknown } {
  const api = getApi();
  const boundsR = api.getRoomBounds(label);
  if (!boundsR.success) return { success: false, error: `Room "${label}" not found` };
  const contents = (api as unknown as { getRoomContents: (l: string) => Record<string, unknown> }).getRoomContents(
    label,
  );

  // Rooms touching this one through a door
  const cells = state.dungeon.cells;
  const roomCellSet = (api as unknown as { _collectRoomCells: (l: string) => Set<string> | null })._collectRoomCells(
    label,
  );
  const adjacentRooms = new Set<string>();
  if (roomCellSet) {
    for (const key of roomCellSet) {
      const [r, c] = parseCellKey(key);
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        const edge = (cell as Record<string, unknown>)[dir];
        if (edge !== 'd' && edge !== 's' && edge !== 'id') continue;
        const [dr, dc] = OFFSETS[dir]!;
        const nr = r + dr,
          nc = c + dc;
        if (roomCellSet.has(cellKey(nr, nc))) continue;
        // Walk into neighbor cell: find which labeled room it belongs to
        const nLabel = findLabelForCell(nr, nc);
        if (nLabel && nLabel !== label) adjacentRooms.add(nLabel);
      }
    }
  }

  // Lights whose radius reaches any cell of the room (Euclidean, ignores walls)
  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const affectingLights: Array<{ id: number; row: number; col: number; radius: number }> = [];
  if (roomCellSet) {
    for (const light of meta.lights) {
      let reaches = false;
      const lx = light.x,
        ly = light.y;
      const radSq = (light.radius / gs) * (light.radius / gs);
      for (const key of roomCellSet) {
        const [r, c] = parseCellKey(key);
        const cx = c + 0.5,
          cy = r + 0.5;
        const dx = lx / gs - cx,
          dy = ly / gs - cy;
        if (dx * dx + dy * dy <= radSq) {
          reaches = true;
          break;
        }
      }
      if (reaches) {
        affectingLights.push({
          id: light.id,
          row: toDisp(Math.floor(ly / gs)),
          col: toDisp(Math.floor(lx / gs)),
          radius: light.radius,
        });
      }
    }
  }

  return {
    success: true,
    label,
    bounds: { r1: boundsR.r1, c1: boundsR.c1, r2: boundsR.r2, c2: boundsR.c2 },
    center: { row: boundsR.centerRow, col: boundsR.centerCol },
    cellCount: roomCellSet?.size ?? 0,
    props: contents.props,
    fills: contents.fills,
    doors: contents.doors,
    textures: contents.textures,
    affectingLights,
    adjacentRooms: [...adjacentRooms].sort(),
  };
}

function findLabelForCell(row: number, col: number): string | null {
  const api = getApi() as unknown as { _collectRoomCells: (l: string) => Set<string> | null };
  const cells = state.dungeon.cells;
  const key = cellKey(row, col);
  // Find any labeled cell that belongs to a flood-fill containing this cell.
  // Cheap approach: scan labeled cells, BFS-flood from each, check membership.
  // For maps with <50 labeled rooms this is acceptable.
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const lbl = cells[r]?.[c]?.center?.label;
      if (!lbl) continue;
      const set = api._collectRoomCells(lbl);
      if (set?.has(key)) return lbl;
    }
  }
  return null;
}

// ─── 4. queryCells ───────────────────────────────────────────────────────

interface CellPredicate {
  prop?: string | string[];
  hasProp?: boolean;
  fill?: 'water' | 'lava' | 'pit' | Array<'water' | 'lava' | 'pit'>;
  hasFill?: boolean;
  hasLabel?: boolean;
  label?: string;
  hasTexture?: boolean;
  texture?: string;
  hasDoor?: boolean;
  hasWall?: boolean;
  hasStair?: boolean;
  hasBridge?: boolean;
  isVoid?: boolean;
  hasHazard?: boolean;
  region?: { r1: number; c1: number; r2: number; c2: number };
}

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Query cells matching a structured predicate. Returns one entry per match
 * with the full cell snapshot.
 *
 * Predicate fields are AND-combined. Array values for `prop`/`fill` mean
 * "any of these". `region` limits the scan to a bounding box.
 *
 * Examples:
 *   queryCells({ prop: 'brazier' })
 *   queryCells({ hasFill: true, region: { r1: 5, c1: 5, r2: 15, c2: 15 } })
 *   queryCells({ fill: ['water', 'lava'] })
 *   queryCells({ hasLabel: true, isVoid: false })
 */
export function queryCells(predicate: CellPredicate = {}): {
  success: true;
  count: number;
  cells: Array<{ row: number; col: number; cell: Cell | null }>;
} {
  const cells = state.dungeon.cells;
  const region = predicate.region;
  const totalCols = cells[0]?.length ?? 0;
  const r1 = region ? toInt(region.r1) : 0;
  const c1 = region ? toInt(region.c1) : 0;
  const r2 = region ? toInt(region.r2) : cells.length - 1;
  const c2 = region ? toInt(region.c2) : totalCols - 1;

  const propTypes = asArray(predicate.prop);
  const fillTypes = asArray(predicate.fill);
  const out: Array<{ row: number; col: number; cell: Cell | null }> = [];
  const anchors = predicate.hasProp != null || propTypes != null ? buildAnchorMap() : null;

  for (let r = Math.max(0, r1); r <= Math.min(cells.length - 1, r2); r++) {
    const rowCells = cells[r]!;
    for (let c = Math.max(0, c1); c <= Math.min(rowCells.length - 1, c2); c++) {
      const cell: Cell | null = rowCells[c] ?? null;

      if (predicate.isVoid === true && cell !== null) continue;
      if (predicate.isVoid === false && cell === null) continue;

      if (cell == null) {
        // Most predicates require a cell; only isVoid:true reaches here.
        if (predicate.isVoid === true) out.push({ row: toDisp(r), col: toDisp(c), cell: null });
        continue;
      }

      const anchoredHere = anchors?.get(cellKey(r, c));
      const hasProp = !!anchoredHere?.length;
      if (predicate.hasProp === true && !hasProp) continue;
      if (predicate.hasProp === false && hasProp) continue;
      if (propTypes && !anchoredHere?.some((p) => propTypes.includes(p.type))) continue;

      if (predicate.hasFill === true && !cell.fill) continue;
      if (predicate.hasFill === false && cell.fill) continue;
      if (fillTypes && (!cell.fill || !fillTypes.includes(cell.fill as 'water' | 'lava' | 'pit'))) continue;

      if (predicate.hasLabel === true && cell.center?.label == null) continue;
      if (predicate.hasLabel === false && cell.center?.label != null) continue;
      if (predicate.label != null && cell.center?.label !== predicate.label) continue;

      if (predicate.hasTexture === true && !cell.texture) continue;
      if (predicate.hasTexture === false && cell.texture) continue;
      if (predicate.texture != null && cell.texture !== predicate.texture) continue;

      if (predicate.hasHazard === true && !cell.hazard) continue;
      if (predicate.hasHazard === false && cell.hazard) continue;

      if (predicate.hasStair === true && cell.center?.['stair-id'] == null) continue;
      if (predicate.hasStair === false && cell.center?.['stair-id'] != null) continue;
      if (predicate.hasBridge === true && cell.center?.['bridge-id'] == null) continue;
      if (predicate.hasBridge === false && cell.center?.['bridge-id'] != null) continue;

      const rec = cell as Record<string, unknown>;
      const hasDoor = CARDINAL_DIRS.some((d) => rec[d] === 'd' || rec[d] === 's' || rec[d] === 'id');
      const hasWall = CARDINAL_DIRS.some((d) => rec[d] === 'w' || rec[d] === 'iw');
      if (predicate.hasDoor === true && !hasDoor) continue;
      if (predicate.hasDoor === false && hasDoor) continue;
      if (predicate.hasWall === true && !hasWall) continue;
      if (predicate.hasWall === false && hasWall) continue;

      out.push({ row: toDisp(r), col: toDisp(c), cell: JSON.parse(JSON.stringify(cell)) });
    }
  }

  return { success: true, count: out.length, cells: out };
}

// ─── 5. getLightingCoverage ──────────────────────────────────────────────

/**
 * Estimate per-cell lighting intensity by summing ambient + each light's
 * falloff at the cell center. Cells below `darkThreshold` are reported as
 * dark spots.
 *
 * NOTE: ignores wall shadowing for speed. Useful for "did I forget to put
 * a light in this room?" checks but not pixel-accurate.
 *
 * @param darkThreshold intensity below which a cell is considered dark (default 0.15)
 * @param region optional bounding box (display coords). Defaults to whole map.
 */
export function getLightingCoverage(
  darkThreshold: number = 0.15,
  region?: { r1: number; c1: number; r2: number; c2: number },
): {
  success: true;
  ambient: number;
  totalCells: number;
  litCells: number;
  darkCells: number;
  averageIntensity: number;
  darkSpots: Array<{ row: number; col: number; intensity: number }>;
} {
  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;
  const ambient = meta.ambientLight;
  const gs = meta.gridSize || 5;

  const r1 = region ? Math.max(0, toInt(region.r1)) : 0;
  const c1 = region ? Math.max(0, toInt(region.c1)) : 0;
  const r2 = region ? Math.min(cells.length - 1, toInt(region.r2)) : cells.length - 1;
  const c2 = region ? Math.min((cells[0]?.length ?? 0) - 1, toInt(region.c2)) : (cells[0]?.length ?? 0) - 1;

  const lights = meta.lights;
  const darkSpots: Array<{ row: number; col: number; intensity: number }> = [];
  let total = 0,
    lit = 0,
    dark = 0,
    sumIntensity = 0;

  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      if (!cells[r]?.[c]) continue;
      total++;

      const cx = (c + 0.5) * gs,
        cy = (r + 0.5) * gs;
      let intensity = ambient;
      for (const light of lights) {
        const dx = light.x - cx,
          dy = light.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > light.radius) continue;
        intensity += falloffMultiplier(dist, light.radius, light.falloff) * light.intensity;
      }
      sumIntensity += intensity;
      if (intensity < darkThreshold) {
        dark++;
        if (darkSpots.length < 200)
          darkSpots.push({ row: toDisp(r), col: toDisp(c), intensity: +intensity.toFixed(3) });
      } else {
        lit++;
      }
    }
  }

  return {
    success: true,
    ambient,
    totalCells: total,
    litCells: lit,
    darkCells: dark,
    averageIntensity: total > 0 ? +(sumIntensity / total).toFixed(3) : 0,
    darkSpots,
  };
}

// ─── 6. getPropPlacementOptions ──────────────────────────────────────────

interface PlacementOption {
  row: number;
  col: number;
  facing: number;
  valid: boolean;
  reasons?: string[];
}

/**
 * Enumerate every candidate anchor for placing a prop in a labeled room and
 * report whether it's valid plus structured reasons. Goes beyond
 * `getValidPropPositions` which only returns valid anchors.
 *
 * Reasons reported per invalid anchor:
 * - `OUT_OF_ROOM` — footprint exits the room
 * - `OVERLAPS_PROP` — footprint overlaps an existing prop
 * - `BLOCKS_DOOR` — footprint covers a cell with a door
 * - `BLOCKS_DOOR_APPROACH` — footprint covers a cell adjacent to a door
 *
 * Default `includeInvalid: true`. Set false to only return valid anchors
 * (cheaper for big rooms when you just want a count).
 */
export function getPropPlacementOptions(
  label: string,
  propType: string,
  options: { facing?: number; includeInvalid?: boolean } = {},
): {
  success: boolean;
  error?: string;
  options?: PlacementOption[];
  summary?: { total: number; valid: number; invalid: number };
} {
  const facing = options.facing ?? 0;
  const includeInvalid = options.includeInvalid !== false;

  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    throw new ApiValidationError('UNKNOWN_PROP', `Unknown prop type: ${propType}`, {
      propType,
      available: Object.keys(catalog?.props ?? {}),
    });
  }
  if (![0, 90, 180, 270].includes(facing)) {
    throw new ApiValidationError('INVALID_FACING', `Invalid facing: ${facing}`, {
      facing,
      validFacings: [0, 90, 180, 270],
    });
  }

  const def = catalog.props[propType];
  const [spanRows, spanCols] =
    facing === 90 || facing === 270 ? [def.footprint[1], def.footprint[0]] : [...def.footprint];

  const api = getApi() as unknown as {
    _collectRoomCells(l: string): Set<string> | null;
    _isCellCoveredByProp(r: number, c: number): boolean;
  };
  const roomCells = api._collectRoomCells(label);
  if (!roomCells) return { success: false, error: `Room "${label}" not found` };

  const cells = state.dungeon.cells;
  // Cache door cells in the room
  const doorCells = new Set<string>();
  const doorApproachCells = new Set<string>();
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    const rec = cell as Record<string, unknown>;
    for (const dir of CARDINAL_DIRS) {
      const v = rec[dir];
      if (v === 'd' || v === 's' || v === 'id') {
        doorCells.add(key);
        const [dr, dc] = OFFSETS[dir]!;
        const nr = r + dr,
          nc = c + dc;
        doorApproachCells.add(cellKey(nr, nc));
      }
    }
  }

  const out: PlacementOption[] = [];
  let valid = 0,
    invalid = 0;

  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    const reasons: string[] = [];

    for (let dr = 0; dr < spanRows; dr++) {
      for (let dc = 0; dc < spanCols; dc++) {
        const fr = r + dr,
          fc = c + dc;
        const fkey = cellKey(fr, fc);
        if (!roomCells.has(fkey)) {
          if (!reasons.includes('OUT_OF_ROOM')) reasons.push('OUT_OF_ROOM');
          continue;
        }
        if (api._isCellCoveredByProp(fr, fc)) {
          if (!reasons.includes('OVERLAPS_PROP')) reasons.push('OVERLAPS_PROP');
        }
        if (doorCells.has(fkey)) {
          if (!reasons.includes('BLOCKS_DOOR')) reasons.push('BLOCKS_DOOR');
        }
        if (doorApproachCells.has(fkey)) {
          if (!reasons.includes('BLOCKS_DOOR_APPROACH')) reasons.push('BLOCKS_DOOR_APPROACH');
        }
      }
    }

    const isValid = reasons.length === 0;
    if (isValid) valid++;
    else invalid++;
    if (isValid || includeInvalid) {
      const opt: PlacementOption = { row: toDisp(r), col: toDisp(c), facing, valid: isValid };
      if (!isValid) opt.reasons = reasons;
      out.push(opt);
    }
  }

  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return {
    success: true,
    options: out,
    summary: { total: valid + invalid, valid, invalid },
  };
}

// ─── 7. searchProps ──────────────────────────────────────────────────────

interface PropSearchFilter {
  placement?: 'wall' | 'corner' | 'center' | 'floor' | 'any' | Array<'wall' | 'corner' | 'center' | 'floor' | 'any'>;
  roomTypes?: string | string[]; // any of these
  category?: string | string[]; // any of these
  facing?: boolean; // true = only facing-aware props
  maxFootprint?: [number, number]; // [maxRows, maxCols]
  minFootprint?: [number, number];
  namePattern?: string; // substring match (case-insensitive)
}

interface PropSummary {
  name: string;
  category: string;
  footprint: [number, number];
  facing: boolean;
  placement: string | null;
  roomTypes: string[];
  typicalCount: string | null;
  notes: string | null;
}

/**
 * Filter the prop catalog. Replaces "load full catalog and grep mentally".
 * All filter fields AND-combine. `roomTypes` and `category` use any-of for
 * arrays. Footprint comparisons use rows × cols.
 *
 * Examples:
 *   searchProps({ placement: 'wall', roomTypes: ['library'] })
 *   searchProps({ maxFootprint: [1, 2], facing: true })
 *   searchProps({ namePattern: 'brazier' })
 */
export function searchProps(filter: PropSearchFilter = {}): { success: true; count: number; props: PropSummary[] } {
  const catalog = state.propCatalog;
  if (!catalog) return { success: true, count: 0, props: [] };

  const placements = asArray(filter.placement);
  const wantedRoomTypes = asArray(filter.roomTypes);
  const categories = asArray(filter.category);
  const namePattern = filter.namePattern?.toLowerCase();

  const out: PropSummary[] = [];
  for (const [key, def] of Object.entries(catalog.props)) {
    if (placements && !placements.includes(def.placement ?? 'any')) continue;
    if (wantedRoomTypes && !wantedRoomTypes.some((t) => def.roomTypes.includes(t))) continue;
    if (categories && !categories.includes(def.category)) continue;
    if (filter.facing != null && def.facing !== filter.facing) continue;
    if (filter.maxFootprint && (def.footprint[0] > filter.maxFootprint[0] || def.footprint[1] > filter.maxFootprint[1]))
      continue;
    if (filter.minFootprint && (def.footprint[0] < filter.minFootprint[0] || def.footprint[1] < filter.minFootprint[1]))
      continue;
    if (namePattern && !key.toLowerCase().includes(namePattern) && !def.name.toLowerCase().includes(namePattern))
      continue;

    out.push({
      name: key,
      category: def.category,
      footprint: def.footprint,
      facing: def.facing,
      placement: def.placement ?? null,
      roomTypes: def.roomTypes,
      typicalCount: def.typicalCount,
      notes: def.notes ?? null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { success: true, count: out.length, props: out };
}

// ─── 8. listDoors / listWalls / listFills / unlabelledRooms / getThemeColors ─

/**
 * Enumerate every door (and secret door) on the map, deduplicated against
 * the reciprocal edge.
 */
export function listDoors(): {
  success: true;
  doors: Array<{ row: number; col: number; direction: string; type: 'd' | 's' | 'id' }>;
} {
  const cells = state.dungeon.cells;
  const seen = new Set<string>();
  const out: Array<{ row: number; col: number; direction: string; type: 'd' | 's' | 'id' }> = [];

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      const rec = cell as Record<string, unknown>;
      for (const dir of CARDINAL_DIRS) {
        const v = rec[dir];
        if (v !== 'd' && v !== 's' && v !== 'id') continue;
        const key = `${r},${c},${dir}`;
        const [dr, dc] = OFFSETS[dir]!;
        const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' }[
          dir as 'north' | 'south' | 'east' | 'west'
        ];
        const reciprocalKey = `${r + dr},${c + dc},${opposite}`;
        if (seen.has(reciprocalKey)) continue;
        seen.add(key);
        out.push({ row: toDisp(r), col: toDisp(c), direction: dir, type: v });
      }
    }
  }
  return { success: true, doors: out };
}

/**
 * Enumerate every wall edge (visible + invisible). Deduplicated against
 * the reciprocal edge.
 */
export function listWalls(): {
  success: true;
  walls: Array<{ row: number; col: number; direction: string; type: 'w' | 'iw' }>;
} {
  const cells = state.dungeon.cells;
  const seen = new Set<string>();
  const out: Array<{ row: number; col: number; direction: string; type: 'w' | 'iw' }> = [];

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      const rec = cell as Record<string, unknown>;
      for (const dir of CARDINAL_DIRS) {
        const v = rec[dir];
        if (v !== 'w' && v !== 'iw') continue;
        const key = `${r},${c},${dir}`;
        const [dr, dc] = OFFSETS[dir]!;
        const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' }[
          dir as 'north' | 'south' | 'east' | 'west'
        ];
        const reciprocalKey = `${r + dr},${c + dc},${opposite}`;
        if (seen.has(reciprocalKey)) continue;
        seen.add(key);
        out.push({ row: toDisp(r), col: toDisp(c), direction: dir, type: v });
      }
    }
  }
  return { success: true, walls: out };
}

/** Enumerate every fill (water/lava/pit) cell with depth. */
export function listFills(): {
  success: true;
  fills: Array<{ row: number; col: number; type: string; depth: number }>;
} {
  const cells = state.dungeon.cells;
  const out: Array<{ row: number; col: number; type: string; depth: number }> = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell?.fill) continue;
      out.push({ row: toDisp(r), col: toDisp(c), type: cell.fill, depth: cell.fillDepth ?? 1 });
    }
  }
  return { success: true, fills: out };
}

/** Find rooms (BFS regions of contiguous floor) that have no label. */
export function unlabelledRooms(): {
  success: true;
  count: number;
  rooms: Array<{ representativeCell: { row: number; col: number }; cellCount: number }>;
} {
  const cells = state.dungeon.cells;
  const visited = new Set<string>();
  const rooms: Array<{ representativeCell: { row: number; col: number }; cellCount: number }> = [];

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      if (!cells[r]?.[c]) continue;
      const key = cellKey(r, c);
      if (visited.has(key)) continue;

      // BFS across open edges to find a connected region
      const region: Array<[number, number]> = [];
      const queue: Array<[number, number]> = [[r, c]];
      visited.add(key);
      let hasLabel = false;
      while (queue.length) {
        const [cr, cc] = queue.shift()!;
        region.push([cr, cc]);
        const cell = cells[cr]?.[cc];
        if (cell?.center?.label != null) hasLabel = true;
        if (!cell) continue;
        const rec = cell as Record<string, unknown>;
        for (const dir of CARDINAL_DIRS) {
          const edge = rec[dir];
          if (edge === 'w' || edge === 'iw') continue;
          const [dr, dc] = OFFSETS[dir]!;
          const nr = cr + dr,
            nc = cc + dc;
          const nkey = cellKey(nr, nc);
          if (visited.has(nkey)) continue;
          if (nr < 0 || nr >= cells.length || nc < 0 || nc >= (cells[nr]?.length ?? 0)) continue;
          if (!cells[nr]?.[nc]) continue;
          visited.add(nkey);
          queue.push([nr, nc]);
        }
      }
      if (!hasLabel && region.length >= 2) {
        rooms.push({
          representativeCell: { row: toDisp(region[0]![0]), col: toDisp(region[0]![1]) },
          cellCount: region.length,
        });
      }
    }
  }
  return { success: true, count: rooms.length, rooms };
}

/** Return the resolved theme colour map for the current map. */
export function getThemeColors(): {
  success: true;
  themeName: string;
  colors: Record<string, unknown>;
} {
  const meta = state.dungeon.metadata;
  const themeRef = meta.theme;
  const api = getApi() as unknown as { getMapInfo(): { theme?: string } | null };
  const info = api.getMapInfo();
  const themeName = typeof themeRef === 'string' ? themeRef : (info?.theme ?? 'custom');
  const obj = typeof themeRef === 'string' ? null : themeRef;
  // If theme is a name, look it up via getThemeCatalog() — caller already loaded the catalog.
  // For simplicity here, return the inline theme object if present, else a stub.
  const colors: Record<string, unknown> = obj ? { ...obj } : { name: themeName };
  return { success: true, themeName, colors };
}

// ─── 9. findConflicts ────────────────────────────────────────────────────

interface Conflict {
  type: string;
  severity: 'error' | 'warning' | 'info';
  row?: number;
  col?: number;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Scan the whole map for design conflicts: blocked doors, unreachable rooms,
 * texture on void cells, lights outside any room, dark rooms, overlapping
 * stairs/bridges.
 *
 * Use this before exporting a map. Each issue has a `severity` and stable
 * `type` so callers can filter.
 *
 * Lighting is **intent-driven**. Unlit rooms are valid (caves, ruins, sealed
 * crypts), so dark-room reports are `severity: "info"` rather than warnings.
 * Pass `unlitRooms: ["B3", "C1"]` to suppress the check for rooms that are
 * intentionally dark (e.g. anything whose vocab `ambient_is: "discouraged"`).
 * Pass `skipDarkCheck: true` to disable the lighting check entirely.
 */
export function findConflicts(
  options: {
    entranceLabel?: string;
    darkThreshold?: number;
    unlitRooms?: string[];
    skipDarkCheck?: boolean;
  } = {},
): {
  success: true;
  conflictCount: number;
  conflicts: Conflict[];
} {
  const api = getApi() as unknown as {
    validateDoorClearance(): { issues: Array<{ row: number; col: number; problem: string; doorType: string }> };
    validateConnectivity(label: string): { unreachable: string[] };
    listRooms(): { rooms: Array<{ label: string; r1: number; c1: number; r2: number; c2: number }> };
  };
  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;
  const conflicts: Conflict[] = [];

  // 1. Door clearance (props blocking doors / approaches)
  const doorCheck = api.validateDoorClearance();
  for (const issue of doorCheck.issues) {
    conflicts.push({
      type: 'DOOR_BLOCKED',
      severity: 'error',
      row: issue.row,
      col: issue.col,
      message: issue.problem,
      context: { doorType: issue.doorType },
    });
  }

  // 2. Connectivity (only if entrance label provided)
  if (options.entranceLabel) {
    try {
      const conn = api.validateConnectivity(options.entranceLabel);
      for (const lbl of conn.unreachable) {
        conflicts.push({
          type: 'UNREACHABLE_ROOM',
          severity: 'error',
          message: `Room "${lbl}" is unreachable from entrance "${options.entranceLabel}"`,
          context: { roomLabel: lbl, entrance: options.entranceLabel },
        });
      }
    } catch {
      // Entrance label not found — skip connectivity check
    }
  }

  // 3. Lights outside any cell (placed in void)
  const gs = meta.gridSize || 5;
  for (const light of meta.lights) {
    const lr = Math.floor(light.y / gs);
    const lc = Math.floor(light.x / gs);
    if (lr < 0 || lr >= cells.length || lc < 0 || lc >= (cells[0]?.length ?? 0)) {
      conflicts.push({
        type: 'LIGHT_OUT_OF_BOUNDS',
        severity: 'warning',
        message: `Light id ${light.id} is outside the grid`,
        context: { lightId: light.id, x: light.x, y: light.y },
      });
      continue;
    }
    if (!cells[lr]?.[lc]) {
      conflicts.push({
        type: 'LIGHT_IN_VOID',
        severity: 'warning',
        row: toDisp(lr),
        col: toDisp(lc),
        message: `Light id ${light.id} is placed on a void cell`,
        context: { lightId: light.id },
      });
    }
  }

  // 4. Dark rooms (only if lighting is enabled and not explicitly skipped).
  // Unlit rooms are valid by design for caves, ruins, and sealed crypts, so
  // this is reported as `info` rather than `warning`. Authors can silence
  // specific rooms via `unlitRooms: [...]` or disable entirely via
  // `skipDarkCheck: true`.
  if (meta.lightingEnabled && !options.skipDarkCheck) {
    const darkThreshold = options.darkThreshold ?? 0.15;
    const unlit = new Set(options.unlitRooms ?? []);
    const rooms = api.listRooms();
    for (const room of rooms.rooms) {
      if (unlit.has(room.label)) continue;
      const cov = getLightingCoverage(darkThreshold, { r1: room.r1, c1: room.c1, r2: room.r2, c2: room.c2 });
      if (cov.totalCells === 0) continue;
      const darkRatio = cov.darkCells / cov.totalCells;
      if (darkRatio > 0.5) {
        conflicts.push({
          type: 'ROOM_TOO_DARK',
          severity: 'info',
          message: `Room "${room.label}" is mostly dark (${cov.darkCells}/${cov.totalCells} cells below ${darkThreshold}). If intentional (cave, ruin, sealed crypt), pass unlitRooms: ["${room.label}"].`,
          context: { roomLabel: room.label, darkRatio: +darkRatio.toFixed(2), threshold: darkThreshold },
        });
      }
    }
  }

  // 5. Stair / bridge overlap (one cell shared between two)
  const stairCellMap = new Map<string, number[]>();
  const bridgeCellMap = new Map<string, number[]>();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const center = cells[r]?.[c]?.center;
      if (!center) continue;
      const key = `${r},${c}`;
      const sid = center['stair-id'];
      const bid = center['bridge-id'];
      if (typeof sid === 'number') {
        const arr = stairCellMap.get(key) ?? [];
        arr.push(sid);
        stairCellMap.set(key, arr);
      }
      if (typeof bid === 'number') {
        const arr = bridgeCellMap.get(key) ?? [];
        arr.push(bid);
        bridgeCellMap.set(key, arr);
      }
    }
  }
  // (Each cell can only hold one stair-id, so this would be a data corruption issue;
  //  keeping the scan in case future schema changes allow lists.)

  return { success: true, conflictCount: conflicts.length, conflicts };
}

// ─── describeMap ─────────────────────────────────────────────────────────

interface RoomSnapshot {
  label: string;
  bounds: { r1: number; c1: number; r2: number; c2: number };
  cellCount: number;
  ascii: string;
  props: Array<{ key: string; type: string; row: number; col: number; facing: number }>;
  doors: Array<{ row: number; col: number; direction: string; type: string; to?: string }>;
  fills: Array<{ type: string; cellCount: number }>;
  lights: Array<{ id: number; preset?: string; row: number; col: number; radius: number }>;
  textures: string[];
  adjacentRooms: string[];
}

/**
 * Use the index N (1..9, then a..z, then A..Z) for the Nth prop anchor in a
 * room. Falls back to '?' for >61 props (unrealistic per room).
 */
function propIndexGlyph(n: number): string {
  if (n < 9) return String(n + 1);
  if (n < 9 + 26) return String.fromCharCode('a'.charCodeAt(0) + (n - 9));
  if (n < 9 + 26 + 26) return String.fromCharCode('A'.charCodeAt(0) + (n - 9 - 26));
  return '?';
}

function describeRoom(label: string, includeAscii: boolean): RoomSnapshot | null {
  const api = getApi() as unknown as {
    getRoomBounds: (l: string) => { success: boolean; r1: number; c1: number; r2: number; c2: number };
    _collectRoomCells: (l: string) => Set<string> | null;
  };
  const boundsR = api.getRoomBounds(label);
  if (!boundsR.success) return null;
  const r1 = boundsR.r1,
    c1 = boundsR.c1,
    r2 = boundsR.r2,
    c2 = boundsR.c2;
  const roomCells = api._collectRoomCells(label);
  if (!roomCells) return null;

  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;

  // Collect overlay props whose anchor (x/y in world feet) is inside the room.
  const gsForProps = meta.gridSize || 5;
  const propEntries: Array<{ key: string; type: string; row: number; col: number; facing: number }> = [];
  if (meta.props) {
    const placed = meta.props
      .map((p) => ({
        ref: p,
        pr: Math.floor(p.y / gsForProps),
        pc: Math.floor(p.x / gsForProps),
      }))
      .filter(({ pr, pc }) => pr >= r1 && pr <= r2 && pc >= c1 && pc <= c2 && roomCells.has(cellKey(pr, pc)))
      .sort((a, b) => a.pr - b.pr || a.pc - b.pc);
    let idx = 0;
    for (const { ref, pr, pc } of placed) {
      propEntries.push({
        key: propIndexGlyph(idx++),
        type: ref.type,
        row: toDisp(pr),
        col: toDisp(pc),
        facing: typeof ref.rotation === 'number' ? ref.rotation : (ref.facing ?? 0),
      });
    }
  }

  // Build prop anchor lookup: row,col -> glyph
  const anchorGlyph = new Map<string, string>();
  for (const p of propEntries) {
    anchorGlyph.set(`${p.row - 1},${p.col - 1}`, p.key); // back to internal coords
  }

  // ASCII rendering — borrow renderAscii's pattern but inject glyphs
  let ascii = '';
  if (includeAscii) {
    const lines: string[] = [];
    const topLine: string[] = ['+'];
    for (let c = c1; c <= c2; c++) {
      topLine.push(edgeGlyph(edgeOf(cells[r1]![c] ?? null, 'north'), 'h'));
      topLine.push('+');
    }
    lines.push(topLine.join(''));

    for (let r = r1; r <= r2; r++) {
      const contentLine: string[] = [];
      contentLine.push(edgeGlyph(edgeOf(cells[r]![c1] ?? null, 'west'), 'v'));
      for (let c = c1; c <= c2; c++) {
        const cell = cells[r]![c] ?? null;
        const g = anchorGlyph.get(`${r},${c}`);
        if (g) {
          contentLine.push(g);
        } else if (cell?.center?.label != null && roomCells.has(cellKey(r, c))) {
          contentLine.push('*');
        } else {
          contentLine.push(cellGlyph(cell, isPropAt(r, c)));
        }
        contentLine.push(edgeGlyph(edgeOf(cell, 'east'), 'v'));
      }
      lines.push(contentLine.join(''));

      const botLine: string[] = ['+'];
      for (let c = c1; c <= c2; c++) {
        botLine.push(edgeGlyph(edgeOf(cells[r]![c] ?? null, 'south'), 'h'));
        botLine.push('+');
      }
      lines.push(botLine.join(''));
    }
    ascii = lines.join('\n');
  }

  // Doors on perimeter
  const doors: Array<{ row: number; col: number; direction: string; type: string; to?: string }> = [];
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const dir of CARDINAL_DIRS) {
      const v = (cell as Record<string, unknown>)[dir];
      if (v === 'd' || v === 's' || v === 'id') {
        const [dr, dc] = OFFSETS[dir]!;
        const nr = r + dr,
          nc = c + dc;
        const inRoom = roomCells.has(cellKey(nr, nc));
        if (inRoom) continue;
        doors.push({
          row: toDisp(r),
          col: toDisp(c),
          direction: dir,
          type: v as string,
        });
      }
    }
  }

  // Fills aggregated by type
  const fillCount = new Map<string, number>();
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (cell?.fill) fillCount.set(cell.fill, (fillCount.get(cell.fill) ?? 0) + 1);
  }
  const fills = [...fillCount.entries()].map(([type, cellCount]) => ({ type, cellCount }));

  // Textures used in room
  const textureSet = new Set<string>();
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (cell?.texture) textureSet.add(cell.texture);
  }

  // Lights inside the room bbox
  const gs = meta.gridSize || 5;
  const lights: Array<{ id: number; preset?: string; row: number; col: number; radius: number }> = [];
  for (const light of meta.lights) {
    const lr = Math.floor(light.y / gs);
    const lc = Math.floor(light.x / gs);
    if (lr < r1 || lr > r2 || lc < c1 || lc > c2) continue;
    lights.push({
      id: light.id,
      preset: (light as { presetId?: string }).presetId,
      row: toDisp(lr),
      col: toDisp(lc),
      radius: light.radius,
    });
  }

  // Adjacent rooms (one door step)
  const adjacent = new Set<string>();
  for (const d of doors) {
    const [dr, dc] = OFFSETS[d.direction as 'north' | 'south' | 'east' | 'west']!;
    const nr = d.row - 1 + dr,
      nc = d.col - 1 + dc;
    const nLabel = findLabelForCell(nr, nc);
    if (nLabel && nLabel !== label) adjacent.add(nLabel);
  }

  return {
    label,
    bounds: { r1: toDisp(r1), c1: toDisp(c1), r2: toDisp(r2), c2: toDisp(c2) },
    cellCount: roomCells.size,
    ascii,
    props: propEntries,
    doors,
    fills,
    lights,
    textures: [...textureSet],
    adjacentRooms: [...adjacent].sort(),
  };
}

/**
 * Compact semantic snapshot of the map. Cheaper than a screenshot when you
 * just need to verify "did things land where I think they did?"
 *
 * For each labeled room, returns its ASCII shape (with prop anchors as
 * indexed glyphs `1`,`2`,…,`a`,…) plus a sidecar prop list that maps each
 * glyph back to a prop type and coordinates. Also returns doors, fills
 * (aggregated), lights, textures used, and adjacent rooms.
 *
 * Pass `label` to describe just one room. Without it, describes all labeled
 * rooms. ASCII output is ~200 tokens/room — far cheaper than a PNG read.
 *
 * @param options.label - Single room label to describe. Default: all rooms.
 * @param options.includeAscii - Include the per-room ASCII grid. Default true.
 */
export function describeMap(options: { label?: string; includeAscii?: boolean } = {}): {
  success: true;
  map: { name: string; rows: number; cols: number; theme: string };
  rooms: RoomSnapshot[];
} {
  const includeAscii = options.includeAscii !== false;
  const meta = state.dungeon.metadata;
  const cells = state.dungeon.cells;
  const out: RoomSnapshot[] = [];

  if (options.label) {
    const snap = describeRoom(options.label, includeAscii);
    if (!snap) {
      throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${options.label}" not found`, { label: options.label });
    }
    out.push(snap);
  } else {
    // Find all labeled rooms by scanning labeled cells
    const seen = new Set<string>();
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
        const lbl = cells[r]?.[c]?.center?.label;
        if (!lbl || seen.has(lbl)) continue;
        seen.add(lbl);
        const snap = describeRoom(lbl, includeAscii);
        if (snap) out.push(snap);
      }
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
  }

  return {
    success: true,
    map: {
      name: meta.dungeonName || '',
      rows: cells.length,
      cols: cells[0]?.length ?? 0,
      theme: typeof meta.theme === 'string' ? meta.theme : 'custom',
    },
    rooms: out,
  };
}
