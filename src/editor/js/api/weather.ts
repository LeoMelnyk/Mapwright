// Weather API — programmatic CRUD for weather groups and per-cell assignment.
//
// Mirrors the operations the Weather panel and tool perform: create / list /
// update / delete groups, assign or clear cells (single, rect, flood-fill).
// Cache invalidation matches the panel — `markWeatherFullRebuild()` after group
// edits, `markWeatherCellDirty()` after per-cell changes, `invalidateLightmap()`
// when active lightning toggles. Half-cell awareness (split cells via diagonal
// walls or arc trims) is delegated to `setCellWeatherHalf` / `getCellHalves`.

import type { CellHalfKey, WeatherGroup, WeatherType } from '../../../types.js';
import { state, mutate, validateBounds, toInt, ApiValidationError } from './_shared.js';
import { invalidateLightmap } from '../state.js';
import { markWeatherFullRebuild, markWeatherCellDirty, hasActiveWeatherLightning } from '../../../render/index.js';
import {
  cellHasGroup,
  forEachCellWeatherAssignment,
  getCellHalves,
  getCellWeatherHalf,
  getSegments,
  setCellWeatherHalf,
  spliceSegments,
  traverse,
  halfKeyToSegmentIndex,
} from '../../../util/index.js';

// ── Constants ──────────────────────────────────────────────────────────────

const WEATHER_TYPES: readonly WeatherType[] = ['rain', 'snow', 'ash', 'embers', 'sandstorm', 'fog', 'leaves', 'cloudy'];

const VALID_HALF_KEYS: readonly CellHalfKey[] = ['full', 'ne', 'sw', 'nw', 'se', 'interior', 'exterior'];

const HEX_COLOR_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

// ── Internal helpers ───────────────────────────────────────────────────────

function getGroups(): WeatherGroup[] {
  const meta = state.dungeon.metadata;
  meta.weatherGroups ??= [];
  return meta.weatherGroups;
}

function findGroup(id: string): WeatherGroup | null {
  return getGroups().find((g) => g.id === id) ?? null;
}

function requireGroup(id: string): WeatherGroup {
  const g = findGroup(id);
  if (!g) {
    throw new ApiValidationError('WEATHER_GROUP_NOT_FOUND', `Weather group "${id}" not found`, {
      id,
      existingGroupIds: getGroups().map((x) => x.id),
    });
  }
  return g;
}

function generateId(): string {
  return 'wg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function nextColorIndex(): number {
  const groups = getGroups();
  const used = new Set(groups.map((g) => g.colorIndex));
  for (let i = 0; i < 8; i++) if (!used.has(i)) return i;
  return groups.length % 8;
}

function validateUnit(name: string, v: unknown, context: Record<string, unknown> = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new ApiValidationError(
      'INVALID_WEATHER_VALUE',
      `${name} must be a finite number between 0 and 1 (got ${String(v)})`,
      { ...context, field: name, value: v },
    );
  }
  return v;
}

function validateColor(name: string, v: unknown, context: Record<string, unknown> = {}): string {
  if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) {
    throw new ApiValidationError(
      'INVALID_WEATHER_COLOR',
      `${name} must be a hex color like "#a1b2c3" or "#abc" (got ${String(v)})`,
      { ...context, field: name, value: v },
    );
  }
  return v;
}

/** Validate `wind.direction` and normalise into [0, 360). */
function validateWindDirection(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ApiValidationError('INVALID_WEATHER_VALUE', `wind.direction must be a finite number (got ${String(v)})`, {
      field: 'wind.direction',
      value: v,
    });
  }
  return ((v % 360) + 360) % 360;
}

function validateType(v: unknown): WeatherType {
  if (typeof v !== 'string' || !WEATHER_TYPES.includes(v as WeatherType)) {
    throw new ApiValidationError('INVALID_WEATHER_TYPE', `Unknown weather type "${String(v)}"`, {
      type: v,
      validTypes: [...WEATHER_TYPES],
    });
  }
  return v as WeatherType;
}

function validateHalfKey(v: unknown): CellHalfKey {
  if (typeof v !== 'string' || !VALID_HALF_KEYS.includes(v as CellHalfKey)) {
    throw new ApiValidationError('INVALID_HALF_KEY', `Unknown cell half "${String(v)}"`, {
      halfKey: v,
      validHalfKeys: [...VALID_HALF_KEYS],
    });
  }
  return v as CellHalfKey;
}

/** Count cells (not halves) that have any assignment to the given group. */
function countGroupCells(groupId: string): number {
  let n = 0;
  for (const row of state.dungeon.cells) {
    for (const cell of row) {
      if (cell && cellHasGroup(cell, groupId)) n++;
    }
  }
  return n;
}

// ── Group config ───────────────────────────────────────────────────────────

interface WeatherGroupInit {
  name?: string;
  type?: WeatherType;
  intensity?: number;
  hazeDensity?: number;
  wind?: { direction?: number; intensity?: number };
  lightning?: { enabled?: boolean; intensity?: number; frequency?: number; color?: string };
  particleColor?: string | null;
}

/**
 * Create a new weather group on `metadata.weatherGroups`. All fields are
 * optional and fall back to the same defaults the Weather panel uses.
 *
 * @param init Optional partial config (name, type, intensity, wind, lightning, etc.)
 * @returns `{ success, id, group }` — `group` is a clone, not a live reference
 */
export function createWeatherGroup(init: WeatherGroupInit = {}): {
  success: true;
  id: string;
  group: WeatherGroup;
} {
  // Validate inputs before the mutation so a bad payload throws cleanly.
  const validated: WeatherGroup = {
    id: generateId(),
    name: typeof init.name === 'string' && init.name.trim() ? init.name.trim() : `Group ${getGroups().length + 1}`,
    colorIndex: nextColorIndex(),
    type: init.type === undefined ? 'rain' : validateType(init.type),
    intensity: init.intensity === undefined ? 0.5 : validateUnit('intensity', init.intensity),
    hazeDensity: init.hazeDensity === undefined ? 0 : validateUnit('hazeDensity', init.hazeDensity),
    wind: {
      direction: 0,
      intensity: 0,
    },
    lightning: {
      enabled: false,
      intensity: 0.7,
      frequency: 0.15,
      color: '#c4d8ff',
    },
  };

  if (init.wind) {
    if (init.wind.direction !== undefined) {
      validated.wind.direction = validateWindDirection(init.wind.direction);
    }
    if (init.wind.intensity !== undefined) {
      validated.wind.intensity = validateUnit('wind.intensity', init.wind.intensity);
    }
  }

  if (init.lightning) {
    if (init.lightning.enabled !== undefined) validated.lightning.enabled = init.lightning.enabled;
    if (init.lightning.intensity !== undefined) {
      validated.lightning.intensity = validateUnit('lightning.intensity', init.lightning.intensity);
    }
    if (init.lightning.frequency !== undefined) {
      validated.lightning.frequency = validateUnit('lightning.frequency', init.lightning.frequency);
    }
    if (init.lightning.color !== undefined) {
      validated.lightning.color = validateColor('lightning.color', init.lightning.color);
    }
  }

  if (init.particleColor !== undefined && init.particleColor !== null) {
    validated.particleColor = validateColor('particleColor', init.particleColor);
  }

  const beforeActive = hasActiveWeatherLightning(state.dungeon.metadata);
  mutate(
    'Add weather group',
    [],
    () => {
      getGroups().push(validated);
    },
    { metaOnly: true, topic: 'metadata' },
  );
  markWeatherFullRebuild();
  if (beforeActive !== hasActiveWeatherLightning(state.dungeon.metadata)) {
    invalidateLightmap();
  }

  // Return a clone so callers can't mutate the live group via the result.
  return { success: true, id: validated.id, group: JSON.parse(JSON.stringify(validated)) as WeatherGroup };
}

/**
 * Delete a weather group and clear every cell that referenced it.
 * Returns the number of cells whose assignment was cleared.
 */
export function removeWeatherGroup(id: string): { success: true; removed: { cells: number } } {
  if (typeof id !== 'string') {
    throw new ApiValidationError('INVALID_WEATHER_GROUP_ID', `id must be a string (got ${typeof id})`, { id });
  }
  requireGroup(id);

  const cells = state.dungeon.cells;
  const coords: { row: number; col: number }[] = [];
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r]!;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell && cellHasGroup(cell, id)) coords.push({ row: r, col: c });
    }
  }

  const beforeActive = hasActiveWeatherLightning(state.dungeon.metadata);
  mutate(
    'Delete weather group',
    coords,
    () => {
      const groups = getGroups();
      const idx = groups.findIndex((g) => g.id === id);
      if (idx >= 0) groups.splice(idx, 1);
      for (const { row, col } of coords) {
        const cell = cells[row]?.[col];
        if (!cell) continue;
        for (const hk of getCellHalves(cell)) {
          if (getCellWeatherHalf(cell, hk) === id) setCellWeatherHalf(cell, hk, null);
        }
      }
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
  markWeatherFullRebuild();
  if (beforeActive !== hasActiveWeatherLightning(state.dungeon.metadata)) {
    invalidateLightmap();
  }

  return { success: true, removed: { cells: coords.length } };
}

/**
 * List every weather group with a `cellCount` field summarizing how many
 * cells carry any assignment to it. Returned groups are deep clones.
 */
export function listWeatherGroups(): {
  success: true;
  groups: Array<WeatherGroup & { cellCount: number }>;
} {
  const groups = getGroups().map((g) => ({
    ...JSON.parse(JSON.stringify(g)),
    cellCount: countGroupCells(g.id),
  })) as Array<WeatherGroup & { cellCount: number }>;
  return { success: true, groups };
}

/**
 * Fetch a single weather group by id. Returns `success: false` (no throw)
 * for missing ids so callers can probe without try/catch.
 */
export function getWeatherGroup(
  id: string,
): { success: true; group: WeatherGroup & { cellCount: number } } | { success: false; error: string } {
  const g = findGroup(id);
  if (!g) return { success: false, error: `Weather group "${id}" not found` };
  return {
    success: true,
    group: { ...(JSON.parse(JSON.stringify(g)) as WeatherGroup), cellCount: countGroupCells(g.id) },
  };
}

/**
 * Patch fields on an existing weather group. Only the supplied fields are
 * touched — anything omitted keeps its current value. Re-runs lightmap
 * invalidation if the active-lightning state flips as a result.
 */
export function setWeatherGroup(id: string, patch: Partial<WeatherGroupInit>): { success: true; group: WeatherGroup } {
  const g = requireGroup(id);

  // Validate everything before applying any mutation.
  const next: Partial<WeatherGroup> = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) {
      throw new ApiValidationError('INVALID_WEATHER_VALUE', 'name must be a non-empty string', {
        field: 'name',
        value: patch.name,
      });
    }
    next.name = patch.name.trim();
  }
  if (patch.type !== undefined) next.type = validateType(patch.type);
  if (patch.intensity !== undefined) next.intensity = validateUnit('intensity', patch.intensity);
  if (patch.hazeDensity !== undefined) next.hazeDensity = validateUnit('hazeDensity', patch.hazeDensity);

  let nextWind: WeatherGroup['wind'] | undefined;
  if (patch.wind) {
    nextWind = { direction: g.wind.direction, intensity: g.wind.intensity };
    if (patch.wind.direction !== undefined) {
      nextWind.direction = validateWindDirection(patch.wind.direction);
    }
    if (patch.wind.intensity !== undefined) {
      nextWind.intensity = validateUnit('wind.intensity', patch.wind.intensity);
    }
  }

  let nextLightning: WeatherGroup['lightning'] | undefined;
  if (patch.lightning) {
    nextLightning = {
      enabled: g.lightning.enabled,
      intensity: g.lightning.intensity,
      frequency: g.lightning.frequency,
      color: g.lightning.color,
    };
    if (patch.lightning.enabled !== undefined) nextLightning.enabled = patch.lightning.enabled;
    if (patch.lightning.intensity !== undefined) {
      nextLightning.intensity = validateUnit('lightning.intensity', patch.lightning.intensity);
    }
    if (patch.lightning.frequency !== undefined) {
      nextLightning.frequency = validateUnit('lightning.frequency', patch.lightning.frequency);
    }
    if (patch.lightning.color !== undefined) {
      nextLightning.color = validateColor('lightning.color', patch.lightning.color);
    }
  }

  // particleColor: explicit null clears the override; undefined leaves it alone.
  let particleColorOp: { kind: 'set'; value: string } | { kind: 'clear' } | null = null;
  if (patch.particleColor !== undefined) {
    if (patch.particleColor === null) particleColorOp = { kind: 'clear' };
    else particleColorOp = { kind: 'set', value: validateColor('particleColor', patch.particleColor) };
  }

  const beforeActive = hasActiveWeatherLightning(state.dungeon.metadata);
  mutate(
    'Edit weather group',
    [],
    () => {
      if (next.name !== undefined) g.name = next.name;
      if (next.type !== undefined) g.type = next.type;
      if (next.intensity !== undefined) g.intensity = next.intensity;
      if (next.hazeDensity !== undefined) g.hazeDensity = next.hazeDensity;
      if (nextWind) g.wind = nextWind;
      if (nextLightning) g.lightning = nextLightning;
      if (particleColorOp?.kind === 'set') g.particleColor = particleColorOp.value;
      if (particleColorOp?.kind === 'clear') delete g.particleColor;
    },
    { metaOnly: true, topic: 'metadata' },
  );
  markWeatherFullRebuild();
  if (beforeActive !== hasActiveWeatherLightning(state.dungeon.metadata)) {
    invalidateLightmap();
  }
  return { success: true, group: JSON.parse(JSON.stringify(g)) as WeatherGroup };
}

// ── Cell assignment ────────────────────────────────────────────────────────

/**
 * Assign or clear weather on a single cell. Pass `groupId = null` to clear.
 *
 * For unsplit cells, `halfKey` is ignored — the assignment writes to the
 * cell as a whole. For cells split by a diagonal wall (`'ne'`/`'sw'` or
 * `'nw'`/`'se'`) or an arc trim (`'interior'`/`'exterior'`), `halfKey`
 * selects which half is touched. Default `'full'` writes only on unsplit
 * cells; on split cells without an explicit `halfKey` an error is thrown.
 */
export function setWeatherCell(
  row: number,
  col: number,
  groupId: string | null,
  halfKey: CellHalfKey = 'full',
): { success: true } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const hk = validateHalfKey(halfKey);
  if (groupId !== null) {
    if (typeof groupId !== 'string') {
      throw new ApiValidationError(
        'INVALID_WEATHER_GROUP_ID',
        `groupId must be a string or null (got ${typeof groupId})`,
        {
          groupId,
        },
      );
    }
    requireGroup(groupId);
  }

  const cell = state.dungeon.cells[row]?.[col];
  if (!cell) {
    throw new ApiValidationError(
      'CELL_VOID',
      `Cell (${row}, ${col}) is void — paint or create the cell before assigning weather`,
      {
        row,
        col,
      },
    );
  }
  const halves = getCellHalves(cell);
  const isSplit = halves[0] !== 'full';

  if (isSplit && hk === 'full') {
    throw new ApiValidationError(
      'WEATHER_HALF_REQUIRED',
      `Cell (${row}, ${col}) is split by a diagonal wall or arc trim — pass halfKey ${JSON.stringify(halves)}`,
      { row, col, validHalfKeys: halves },
    );
  }
  if (!isSplit && hk !== 'full') {
    throw new ApiValidationError(
      'WEATHER_HALF_NOT_APPLICABLE',
      `Cell (${row}, ${col}) is not split — halfKey must be omitted or "full"`,
      { row, col, halfKey: hk },
    );
  }
  if (isSplit && !halves.includes(hk)) {
    throw new ApiValidationError(
      'INVALID_HALF_KEY',
      `Cell (${row}, ${col}) does not have half "${hk}" — valid halves are ${JSON.stringify(halves)}`,
      { row, col, halfKey: hk, validHalfKeys: halves },
    );
  }

  // Skip if already in the desired state — preserves clean undo stack.
  if (getCellWeatherHalf(cell, hk) === (groupId ?? undefined)) return { success: true };

  mutate(
    'Set weather cell',
    [{ row, col }],
    () => {
      setCellWeatherHalf(cell, hk, groupId);
    },
    { topic: 'cells' },
  );
  markWeatherCellDirty(row, col);
  return { success: true };
}

/**
 * Assign or clear every cell in a rectangle. Skips void cells (they have no
 * surface to weather). Returns the number of cells actually mutated.
 */
export function setWeatherRect(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  groupId: string | null,
): { success: true; count: number } {
  r1 = toInt(r1);
  c1 = toInt(c1);
  r2 = toInt(r2);
  c2 = toInt(c2);
  if (groupId !== null) {
    if (typeof groupId !== 'string') {
      throw new ApiValidationError(
        'INVALID_WEATHER_GROUP_ID',
        `groupId must be a string or null (got ${typeof groupId})`,
        {
          groupId,
        },
      );
    }
    requireGroup(groupId);
  }
  const rowMin = Math.min(r1, r2);
  const rowMax = Math.max(r1, r2);
  const colMin = Math.min(c1, c2);
  const colMax = Math.max(c1, c2);

  const cells = state.dungeon.cells;
  const coords: { row: number; col: number }[] = [];
  for (let r = rowMin; r <= rowMax; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = colMin; c <= colMax; c++) {
      const cell = row[c];
      if (!cell) continue;
      // Skip cells already in the desired state across every half.
      const halves = getCellHalves(cell);
      let needsChange = false;
      for (const hk of halves) {
        if (getCellWeatherHalf(cell, hk) !== (groupId ?? undefined)) {
          needsChange = true;
          break;
        }
      }
      if (needsChange) coords.push({ row: r, col: c });
    }
  }
  if (coords.length === 0) return { success: true, count: 0 };

  mutate(
    'Set weather rect',
    coords,
    () => {
      for (const { row, col } of coords) {
        const cell = cells[row]?.[col];
        if (!cell) continue;
        for (const hk of getCellHalves(cell)) setCellWeatherHalf(cell, hk, groupId);
      }
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
  return { success: true, count: coords.length };
}

/**
 * Flood-fill weather assignment from a starting cell, respecting the same
 * room/half adjacency rules as the Paint tool's flood-fill.
 *
 * `groupId = null` clears assignments rather than setting them. Pass
 * `halfKey` for split cells (default `'full'` works for any unsplit
 * starting cell). Returns the number of cells touched.
 */
export function floodFillWeather(
  row: number,
  col: number,
  groupId: string | null,
  halfKey: CellHalfKey = 'full',
): { success: true; count: number } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const hk = validateHalfKey(halfKey);
  if (groupId !== null) {
    if (typeof groupId !== 'string') {
      throw new ApiValidationError(
        'INVALID_WEATHER_GROUP_ID',
        `groupId must be a string or null (got ${typeof groupId})`,
        {
          groupId,
        },
      );
    }
    requireGroup(groupId);
  }

  const cells = state.dungeon.cells;
  const startCell = cells[row]?.[col];
  if (!startCell) {
    throw new ApiValidationError('CELL_VOID', `Cell (${row}, ${col}) is void — flood-fill needs a floor cell`, {
      row,
      col,
    });
  }
  const startHalves = getCellHalves(startCell);
  const startIsSplit = startHalves[0] !== 'full';
  if (startIsSplit && hk === 'full') {
    throw new ApiValidationError(
      'WEATHER_HALF_REQUIRED',
      `Start cell (${row}, ${col}) is split — pass halfKey ${JSON.stringify(startHalves)}`,
      { row, col, validHalfKeys: startHalves },
    );
  }
  if (!startIsSplit && hk !== 'full') {
    throw new ApiValidationError(
      'WEATHER_HALF_NOT_APPLICABLE',
      `Start cell (${row}, ${col}) is not split — halfKey must be omitted or "full"`,
      { row, col, halfKey: hk },
    );
  }
  if (startIsSplit && !startHalves.includes(hk)) {
    throw new ApiValidationError(
      'INVALID_HALF_KEY',
      `Start cell (${row}, ${col}) does not have half "${hk}" — valid halves are ${JSON.stringify(startHalves)}`,
      { row, col, halfKey: hk, validHalfKeys: startHalves },
    );
  }

  // Drive the flood through the unified `traverse()` BFS and write each
  // visited segment's `weatherGroupId` directly via `spliceSegments`. No
  // halfKey round-trip — segments are the storage, BFS already gives us the
  // exact segment indices to write.
  const startSegmentIndex = halfKeyToSegmentIndex(startCell, hk);
  const traverseResult = traverse(cells, { row, col, segmentIndex: startSegmentIndex });

  const writesByCell = new Map<string, { row: number; col: number; segIndices: number[] }>();
  for (const visited of traverseResult.visited) {
    const parts = visited.split(',');
    const r = Number(parts[0]);
    const c = Number(parts[1]);
    const segIdx = Number(parts[2]);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    const seg = getSegments(cell)[segIdx];
    if (!seg) continue;
    if (seg.weatherGroupId === (groupId ?? undefined)) continue;
    const k = `${r},${c}`;
    let entry = writesByCell.get(k);
    if (!entry) {
      entry = { row: r, col: c, segIndices: [] };
      writesByCell.set(k, entry);
    }
    entry.segIndices.push(segIdx);
  }
  if (writesByCell.size === 0) return { success: true, count: 0 };

  const coords = Array.from(writesByCell.values()).map(({ row: r, col: c }) => ({ row: r, col: c }));
  mutate(
    groupId === null ? 'Flood-clear weather' : 'Flood-fill weather',
    coords,
    () => {
      for (const entry of writesByCell.values()) {
        const cell = cells[entry.row]?.[entry.col];
        if (!cell) continue;
        for (const segIdx of entry.segIndices) {
          spliceSegments(cell, { kind: 'setSegmentWeatherGroup', segmentIndex: segIdx, weatherGroupId: groupId });
        }
      }
    },
    { topic: 'cells' },
  );
  for (const { row: r, col: c } of coords) markWeatherCellDirty(r, c);
  return { success: true, count: coords.length };
}

/**
 * Read the weather assignment(s) on a cell. Returns `assignments` as an
 * array of `{ halfKey, groupId }` so split cells with different groups in
 * each half are reported faithfully. Empty array means "no weather here."
 */
export function getWeatherCell(
  row: number,
  col: number,
): { success: true; assignments: Array<{ halfKey: CellHalfKey; groupId: string }>; isSplit: boolean } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row]?.[col];
  const assignments: Array<{ halfKey: CellHalfKey; groupId: string }> = [];
  forEachCellWeatherAssignment(cell, (halfKey, groupId) => {
    assignments.push({ halfKey, groupId });
  });
  const halves = getCellHalves(cell);
  return { success: true, assignments, isSplit: halves[0] !== 'full' };
}
