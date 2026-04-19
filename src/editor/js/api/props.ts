import type {
  CardinalDirection,
  LightPreset,
  Metadata,
  OverlayProp,
  PlacePropOptions,
  FillWallOptions,
  LinePropsOptions,
  ScatterPropsOptions,
  SuggestPropPositionOptions,
} from '../../../types.js';
import {
  getApi,
  CARDINAL_DIRS,
  state,
  mutate,
  markDirty,
  notify,
  validateBounds,
  getLightCatalog,
  cellKey,
  roomBoundsFromKeys,
  toInt,
  ApiValidationError,
} from './_shared.js';
import { getEdge } from '../../../util/index.js';
import { lookupPropAt } from '../prop-spatial.js';
import { createOverlayProp, refreshLinkedLights, resolveZIndex, visibleAnchorOf } from '../prop-overlay.js';
import { ensurePropTextures, ensurePropHitbox } from '../prop-catalog.js';
import { normalizeRect } from './_rect-utils.js';

// ── Bulk-op shared shapes ──────────────────────────────────────────────────

/**
 * Structured reasons a bulk prop-placement call may skip a position. Keep
 * this list aligned with the docs in `src/editor/CLAUDE.md`.
 */
export type BulkSkipCode =
  | 'OVERLAPS_PROP'
  | 'OUT_OF_ROOM'
  | 'DOOR_HERE'
  | 'DOOR_APPROACH'
  | 'CELL_VOID'
  | 'PLACE_FAILED';

/**
 * Standard skipped-position entry returned by every bulk prop op. `reason` is
 * preserved for backward compatibility with callers that do
 * `.filter(s => s.reason === 'DOOR_HERE')` — for new code, branch on `code`
 * and surface `context` for structured diagnostics.
 */
export interface BulkSkipEntry {
  row: number;
  col: number;
  code: BulkSkipCode | string;
  reason: string;
  context?: Record<string, unknown>;
}

/**
 * Flattened light-addition entry returned by bulk ops. Each prop placed can
 * auto-attach one or more lights (torch-sconce, brazier, chandelier, etc.);
 * bulk results aggregate every such light plus attribution so the caller can
 * find which prop produced it without re-querying by propRef.
 */
export interface BulkLightAdded {
  id: number;
  preset: string;
  propRow: number;
  propCol: number;
  propType: string;
}

/** Build a skipped entry from a thrown ApiValidationError during a bulk placeProp call. */
function placeErrorToSkip(row: number, col: number, err: unknown, extra: Record<string, unknown> = {}): BulkSkipEntry {
  if (err instanceof ApiValidationError) {
    return {
      row,
      col,
      code: err.code,
      reason: err.code,
      context: { ...extra, message: err.message, ...err.context },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    row,
    col,
    code: 'PLACE_FAILED',
    reason: 'PLACE_FAILED',
    context: { ...extra, message },
  };
}

/** Flatten a placeProp result's lightsAdded into bulk-op attributed entries. */
function attributeLights(
  result: { lightsAdded?: Array<{ id: number; preset: string }> },
  propRow: number,
  propCol: number,
  propType: string,
): BulkLightAdded[] {
  if (!result.lightsAdded?.length) return [];
  return result.lightsAdded.map((l) => ({
    id: l.id,
    preset: l.preset,
    propRow,
    propCol,
    propType,
  }));
}

// ── Overlay Helpers ─────────────────────────────────────────────────────

/** Ensure metadata.props[] array exists. */
function ensurePropsArray(): Metadata {
  const meta = state.dungeon.metadata;
  meta.props ??= [];
  meta.nextPropId ??= 1;
  return meta;
}

/** Find the overlay prop at the given grid position (uses spatial hash for freeform compat). */
function findPropAtGrid(row: number, col: number): OverlayProp | null {
  const entry = lookupPropAt(row, col);
  if (!entry) return null;
  const meta = state.dungeon.metadata;
  return meta.props?.find((p: { id: string | number }) => p.id === entry.propId) ?? null;
}

/** Remove the overlay prop at the given grid position. Returns true if found. */
function removePropAtGrid(row: number, col: number): boolean {
  const entry = lookupPropAt(row, col);
  if (!entry) return false;
  const meta = state.dungeon.metadata;
  if (!meta.props) return false;
  const idx = meta.props.findIndex((p: { id: string | number }) => p.id === entry.propId);
  if (idx >= 0) {
    meta.props.splice(idx, 1);
    return true;
  }
  return false;
}

// ── Prop Operations ─────────────────────────────────────────────────────

/**
 * Place a prop from the catalog at the given grid position.
 * @param {number} row - Anchor row
 * @param {number} col - Anchor column
 * @param {string} propType - Prop catalog key
 * @param {number} [facing=0] - Rotation in degrees (0, 90, 180, 270)
 * @param {Object} [options] - Additional options (scale, allowOverlap, x, y, zIndex)
 * @returns {{ success: boolean, warnings?: Array<string> }}
 */
export function placeProp(
  row: number,
  col: number,
  propType: string,
  facing: number = 0,
  options: PlacePropOptions = {},
): { success: true; warnings?: string[]; lightsAdded?: Array<{ id: number; preset: string }> } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    throw new ApiValidationError(
      'UNKNOWN_PROP',
      `Unknown prop type: ${propType}. Available: ${Object.keys(catalog?.props ?? {}).join(', ')}`,
      { propType, available: Object.keys(catalog?.props ?? {}) },
    );
  }
  facing = ((facing % 360) + 360) % 360; // normalize to 0-359
  const scale = Math.max(0.25, Math.min(4.0, options.scale ?? 1.0));
  const allowOverlap = !!options.allowOverlap;
  const def = catalog.props[propType];
  const r90 = ((facing % 360) + 360) % 360;
  const span = r90 === 90 || r90 === 270 ? [def.footprint[1], def.footprint[0]] : [...def.footprint];

  // Validate all cells in span
  const warnings = [];
  const cells = state.dungeon.cells;
  for (let r = row; r < row + span[0]!; r++) {
    for (let c = col; c < col + span[1]!; c++) {
      validateBounds(r, c);
      if (cells[r]![c] === null)
        throw new ApiValidationError('CELL_VOID', `Cell (${r}, ${c}) is void — cannot place prop`, { row: r, col: c });
      // O(1) spatial hash check for overlap
      const covered = lookupPropAt(r, c);
      if (covered) {
        if (allowOverlap) {
          warnings.push(
            `overlaps with ${covered.propType} (${covered.propId || 'unknown'}) at (${covered.anchorRow}, ${covered.anchorCol})`,
          );
        } else {
          throw new ApiValidationError(
            'PROP_OVERLAP',
            `Cell (${r}, ${c}) is already covered by prop "${covered.propType}" anchored at (${covered.anchorRow}, ${covered.anchorCol})`,
            { row: r, col: c, existingProp: covered.propType, existingAnchor: [covered.anchorRow, covered.anchorCol] },
          );
        }
      }
    }
  }

  const meta = ensurePropsArray();
  const gridSize = meta.gridSize || 5;
  const lightsAdded: Array<{ id: number; preset: string }> = [];

  ensurePropHitbox(propType);
  ensurePropTextures(propType);

  mutate(
    'Place prop',
    [],
    () => {
      // Write to overlay — use exact world-feet coords if provided, otherwise snap to grid
      const entry = createOverlayProp(meta, propType, row, col, gridSize, {
        rotation: facing,
        scale,
        ...(options.zIndex != null && { zIndex: options.zIndex }),
      });
      // Caller passes the effective (rotated) top-left cell, but the renderer rotates
      // around the base-footprint center (Option A). Shift the stored anchor so the
      // visible prop lands on the requested cell for non-square props at 90°/270°.
      const [fRowsShift, fColsShift] = def.footprint;
      const isR90Shift = r90 === 90 || r90 === 270;
      const eRowsShift = isR90Shift ? fColsShift : fRowsShift;
      const eColsShift = isR90Shift ? fRowsShift : fColsShift;
      entry.x -= ((fColsShift - eColsShift) / 2) * gridSize;
      entry.y -= ((fRowsShift - eRowsShift) / 2) * gridSize;
      // Freeform placement: override position with exact world-feet coordinates
      if (options.x != null) entry.x = options.x;
      if (options.y != null) entry.y = options.y;
      meta.props!.push(entry);

      // Create linked lights from propDef.lights
      if (def.lights?.length) {
        if (!meta.nextLightId) meta.nextLightId = 1;
        const lightCatalog = getLightCatalog();
        const [origRows, origCols] = def.footprint;

        for (const lightEntry of def.lights) {
          let nx = lightEntry.x;
          let ny = lightEntry.y;
          if (facing === 90) {
            [nx, ny] = [origRows - ny, nx];
          } else if (facing === 180) {
            [nx, ny] = [origCols - nx, origRows - ny];
          } else if (facing === 270) {
            [nx, ny] = [ny, origCols - nx];
          }

          const preset = lightCatalog?.lights[lightEntry.preset] ?? ({} as Partial<LightPreset>);
          const lightId = meta.nextLightId++;
          const light: Record<string, unknown> = {
            id: lightId,
            x: (col + nx) * gridSize,
            y: (row + ny) * gridSize,
            type: preset.type ?? 'point',
            radius: lightEntry.radius ?? preset.radius ?? 20,
            color: lightEntry.color ?? preset.color ?? '#ff9944',
            intensity: lightEntry.intensity ?? preset.intensity ?? 1.0,
            falloff: lightEntry.falloff ?? preset.falloff ?? 'smooth',
            presetId: lightEntry.preset,
            propRef: { row, col },
          };
          const dim = lightEntry.dimRadius ?? preset.dimRadius;
          if (dim) light.dimRadius = dim;
          if (lightEntry.angle != null) light.angle = lightEntry.angle;
          if (lightEntry.spread != null) light.spread = lightEntry.spread;
          if (preset.animation?.type) light.animation = { ...preset.animation };
          // Cookie inheritance: per-light entry beats preset. The prop file
          // can declare its own cookie inline (e.g. a stained-glass window
          // overriding any preset default) without going through a preset.
          const cookie = lightEntry.cookie ?? (preset as { cookie?: unknown }).cookie;
          if (cookie) light.cookie = cookie;
          meta.lights.push(light as unknown as (typeof meta.lights)[number]);
          lightsAdded.push({ id: lightId, preset: lightEntry.preset });
        }
      }
    },
    { metaOnly: true, invalidate: ['lighting:props', 'props'] },
  );

  const result: { success: true; warnings?: string[]; lightsAdded?: Array<{ id: number; preset: string }> } = {
    success: true,
  };
  if (warnings.length) result.warnings = warnings;
  if (lightsAdded.length) result.lightsAdded = lightsAdded;
  return result;
}

/**
 * List all props in the catalog that auto-emit light when placed.
 *
 * Use this to know which props you should NOT also call `placeLight` for —
 * they bring their own light source via the `lights:` field in the prop file.
 *
 * @returns `{ count, props: [{ name, lights: [{preset, x, y}] }] }`
 */
export function listLightEmittingProps(): {
  success: true;
  count: number;
  props: Array<{ name: string; category: string; lights: Array<{ preset: string; x: number; y: number }> }>;
} {
  const catalog = state.propCatalog;
  if (!catalog) {
    throw new ApiValidationError('NO_PROP_CATALOG', 'Prop catalog not loaded', {});
  }
  const out: Array<{ name: string; category: string; lights: Array<{ preset: string; x: number; y: number }> }> = [];
  for (const [name, def] of Object.entries(catalog.props)) {
    const lights = (def as { lights?: Array<{ preset: string; x: number; y: number }> }).lights;
    if (lights?.length) {
      out.push({
        name,
        category: (def as { category?: string }).category ?? 'Misc',
        lights: lights.map((l) => ({ preset: l.preset, x: l.x, y: l.y })),
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { success: true, count: out.length, props: out };
}

/**
 * Remove the prop covering the given grid position.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeProp(row: number, col: number): { success: true } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const overlay = findPropAtGrid(row, col);
  if (!overlay) return { success: true };
  mutate(
    'Remove prop',
    [],
    () => {
      removePropAtGrid(row, col);
      // Remove linked lights
      const meta = state.dungeon.metadata;
      if (meta.lights.length) {
        meta.lights = meta.lights.filter((l) => !(l.propRef?.row === row && l.propRef.col === col));
      }
    },
    { metaOnly: true, invalidate: ['lighting:props', 'props'] },
  );
  return { success: true };
}

/**
 * Set or clear the display name of a light by ID.
 * @param {number} id - Light ID
 * @param {string|null} name - Display name, or falsy to remove
 * @returns {{ success: boolean }}
 */
export function setLightName(id: number, name: string | null): { success: true } {
  const meta = state.dungeon.metadata;
  const light = meta.lights.find((l) => l.id === id);
  if (!light) throw new ApiValidationError('LIGHT_NOT_FOUND', `No light with id ${id}`, { id });
  if (name) light.name = name;
  else delete light.name;
  markDirty();
  notify();
  return { success: true };
}

/**
 * Rotate the prop at the given position by the specified degrees.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {number} [degrees=90] - Degrees to rotate (added to current facing)
 * @returns {{ success: boolean, facing: number }}
 */
export function rotateProp(row: number, col: number, degrees: number = 90): { success: true; facing: number } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const overlay = findPropAtGrid(row, col);
  if (!overlay) throw new ApiValidationError('NO_PROP_AT_CELL', `No prop at (${row}, ${col})`, { row, col });
  let newFacing: number;
  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const propDef = state.propCatalog?.props[overlay.type];
  const oldVisible = visibleAnchorOf(overlay, propDef, gs);
  mutate(
    'Rotate prop',
    [],
    () => {
      newFacing = ((((overlay.rotation || 0) + degrees) % 360) + 360) % 360;
      overlay.rotation = newFacing;
      // Preserve the visible anchor across the rotation for non-square props:
      // placement applies a rotation-dependent shift so rotated visibles land
      // on whole cells. Without re-shifting, rotating in place drifts the
      // visible anchor by half the footprint-difference. Re-anchor so the
      // cell under (row, col) stays the same before/after.
      if (propDef) {
        const [fRows, fCols] = propDef.footprint;
        const isR90 = newFacing === 90 || newFacing === 270;
        const eRows = isR90 ? fCols : fRows;
        const eCols = isR90 ? fRows : fCols;
        const desiredShiftX = ((fCols - eCols) / 2) * gs;
        const desiredShiftY = ((fRows - eRows) / 2) * gs;
        const currentShiftX = oldVisible.col * gs - overlay.x;
        const currentShiftY = oldVisible.row * gs - overlay.y;
        overlay.x += currentShiftX - desiredShiftX;
        overlay.y += currentShiftY - desiredShiftY;
      }
      refreshLinkedLights(meta, overlay, propDef, oldVisible, 0, 0);
    },
    { metaOnly: true, invalidate: ['lighting:props', 'props'] },
  );
  return { success: true, facing: newFacing! };
}

/**
 * Set the prop's rotation to an absolute value (in degrees). Unlike
 * `rotateProp(row, col, delta)` which adds a delta, this snaps directly to
 * the requested angle. Preserves the visible anchor across the rotation so
 * the prop stays under (row, col) for non-square footprints.
 *
 * @param row - Visible-anchor row
 * @param col - Visible-anchor column
 * @param degrees - Absolute rotation (normalized to 0–359)
 */
export function setPropRotation(row: number, col: number, degrees: number): { success: true; rotation: number } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const overlay = findPropAtGrid(row, col);
  if (!overlay) throw new ApiValidationError('NO_PROP_AT_CELL', `No prop at (${row}, ${col})`, { row, col });
  const normalized = ((Math.round(degrees) % 360) + 360) % 360;
  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const propDef = state.propCatalog?.props[overlay.type];
  const oldVisible = visibleAnchorOf(overlay, propDef, gs);
  mutate(
    'Set prop rotation',
    [],
    () => {
      overlay.rotation = normalized;
      if (propDef) {
        const [fRows, fCols] = propDef.footprint;
        const isR90 = normalized === 90 || normalized === 270;
        const eRows = isR90 ? fCols : fRows;
        const eCols = isR90 ? fRows : fCols;
        const desiredShiftX = ((fCols - eCols) / 2) * gs;
        const desiredShiftY = ((fRows - eRows) / 2) * gs;
        const currentShiftX = oldVisible.col * gs - overlay.x;
        const currentShiftY = oldVisible.row * gs - overlay.y;
        overlay.x += currentShiftX - desiredShiftX;
        overlay.y += currentShiftY - desiredShiftY;
      }
      refreshLinkedLights(meta, overlay, propDef, oldVisible, 0, 0);
    },
    { metaOnly: true, invalidate: ['lighting:props', 'props'] },
  );
  return { success: true, rotation: normalized };
}

/**
 * Toggle the `flipped` flag of the prop at (row, col). Flipping mirrors the
 * prop's art without changing its footprint or anchor, so no cell-validity
 * checks are needed.
 */
export function flipProp(row: number, col: number): { success: true; flipped: boolean } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const overlay = findPropAtGrid(row, col);
  if (!overlay) throw new ApiValidationError('NO_PROP_AT_CELL', `No prop at (${row}, ${col})`, { row, col });
  let newFlipped = false;
  mutate(
    'Flip prop',
    [],
    () => {
      overlay.flipped = !overlay.flipped;
      newFlipped = overlay.flipped;
    },
    { metaOnly: true, invalidate: ['props'] },
  );
  return { success: true, flipped: newFlipped };
}

/**
 * Move the prop at (row, col) by a cell offset (dr, dc). Works on grid-aligned
 * props — sub-cell/freeform positions are preserved via stored world-feet
 * coordinates. Linked lights follow the prop.
 *
 * Throws `OUT_OF_BOUNDS` if the new visible anchor would land outside the
 * grid or on a void cell. Use `movePropTo` (not yet implemented) if you need
 * absolute-coordinate placement.
 */
export function movePropInCells(
  row: number,
  col: number,
  dr: number,
  dc: number,
): { success: true; row: number; col: number } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  const overlay = findPropAtGrid(row, col);
  if (!overlay) throw new ApiValidationError('NO_PROP_AT_CELL', `No prop at (${row}, ${col})`, { row, col });

  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const propDef = state.propCatalog?.props[overlay.type];
  const oldVisible = visibleAnchorOf(overlay, propDef, gs);
  const newRow = oldVisible.row + toInt(dr);
  const newCol = oldVisible.col + toInt(dc);

  // Validate the destination visible anchor is inside the grid.
  const cells = state.dungeon.cells;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  if (newRow < 0 || newRow >= numRows || newCol < 0 || newCol >= numCols) {
    throw new ApiValidationError(
      'OUT_OF_BOUNDS',
      `Moved anchor (${newRow}, ${newCol}) is outside the grid (${numRows} rows, ${numCols} cols)`,
      { row: newRow, col: newCol, maxRows: numRows, maxCols: numCols },
    );
  }
  if (cells[newRow]![newCol] === null) {
    throw new ApiValidationError(
      'CELL_VOID',
      `Moved anchor (${newRow}, ${newCol}) is a void cell — paint floor first`,
      { row: newRow, col: newCol },
    );
  }

  const dx = toInt(dc) * gs;
  const dy = toInt(dr) * gs;
  mutate(
    'Move prop',
    [],
    () => {
      overlay.x += dx;
      overlay.y += dy;
      refreshLinkedLights(meta, overlay, propDef, oldVisible, dx, dy);
    },
    { metaOnly: true, invalidate: ['lighting:props', 'props'] },
  );
  return { success: true, row: newRow, col: newCol };
}

/**
 * List all prop types from the catalog with metadata.
 * @returns {{ success: boolean, categories: Array<string>, props: Object }}
 */
export function listProps(): {
  success: true;
  categories: string[];
  props: Record<
    string,
    {
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
  >;
} {
  const catalog = state.propCatalog;
  if (!catalog) return { success: true, categories: [], props: {} };
  return {
    success: true,
    categories: catalog.categories,
    props: Object.fromEntries(
      Object.entries(catalog.props).map(([k, v]) => [
        k,
        {
          name: v.name,
          category: v.category,
          footprint: v.footprint,
          facing: v.facing,
          placement: v.placement ?? null,
          roomTypes: v.roomTypes,
          typicalCount: v.typicalCount,
          clustersWith: v.clustersWith,
          notes: v.notes ?? null,
        },
      ]),
    ),
  };
}

/**
 * Return all props that belong in a specific room type.
 * @param {string} roomType - Room type tag (e.g. 'tavern', 'library')
 * @returns {{ success: boolean, props: Array<Object> }}
 */
export function getPropsForRoomType(roomType: string): {
  success: boolean;
  error?: string;
  props: { name: string; category: string; footprint: [number, number] }[];
} {
  const catalog = state.propCatalog;
  if (!catalog) return { success: false, error: 'Prop catalog not loaded', props: [] };
  const results = [];
  for (const [key, v] of Object.entries(catalog.props)) {
    if (v.roomTypes.includes(roomType) || v.roomTypes.includes('any')) {
      results.push({
        name: key,
        displayName: v.name,
        category: v.category,
        footprint: v.footprint,
        facing: v.facing,
        placement: v.placement ?? null,
        typicalCount: v.typicalCount ?? null,
        clustersWith: v.clustersWith,
        notes: v.notes,
      });
    }
  }
  return { success: true, props: results };
}

/**
 * Remove the prop at the given grid position.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removePropAt(row: number, col: number): { success: boolean; error?: string } {
  row = toInt(row);
  col = toInt(col);
  validateBounds(row, col);
  if (!findPropAtGrid(row, col)) return { success: false, error: 'no prop at that cell' };
  mutate(
    'Remove prop',
    [],
    () => {
      removePropAtGrid(row, col);
      // Remove linked lights
      const meta = state.dungeon.metadata;
      if (meta.lights.length) {
        meta.lights = meta.lights.filter((l) => !(l.propRef?.row === row && l.propRef.col === col));
      }
    },
    { metaOnly: true, invalidate: ['lighting:props', 'props'] },
  );
  return { success: true };
}

/**
 * Remove all props with anchor positions in the given rectangle.
 * @param {number} r1 - First corner row
 * @param {number} c1 - First corner column
 * @param {number} r2 - Second corner row
 * @param {number} c2 - Second corner column
 * @returns {{ success: boolean, removed: number }}
 */
export function removePropsInRect(r1: number, c1: number, r2: number, c2: number): { success: true; removed: number } {
  const { minR, maxR, minC, maxC } = normalizeRect(r1, c1, r2, c2);
  const meta = state.dungeon.metadata;
  if (!meta.props) return { success: true, removed: 0 };

  const gridSize = meta.gridSize || 5;
  let removed: number;
  mutate(
    'Remove props in rect',
    [],
    () => {
      const before = meta.props!.length;
      meta.props = meta.props!.filter((p: OverlayProp) => {
        const def = state.propCatalog?.props[p.type];
        // Use the visible anchor so 90°/270° rotated non-square props test
        // against the cells they actually occupy, not their shifted data anchor.
        const { row: pRow, col: pCol } = visibleAnchorOf(p, def, gridSize);
        return pRow < minR || pRow > maxR || pCol < minC || pCol > maxC;
      });
      removed = before - meta.props.length;

      // Remove linked lights for deleted props
      if (removed > 0 && meta.lights.length) {
        meta.lights = meta.lights.filter((l) => {
          if (!l.propRef) return true;
          const { row, col } = l.propRef;
          return row < minR || row > maxR || col < minC || col > maxC;
        });
      }
    },
    { metaOnly: true, invalidate: ['lighting:props', 'props'] },
  );
  return { success: true, removed: removed! };
}

// ── Bulk Prop Placement ─────────────────────────────────────────────────

/**
 * Fill a wall of a room with repeated copies of a prop.
 * wall: 'north', 'south', 'east', 'west'.
 * @param {string} roomLabel - Room label
 * @param {string} propType - Prop catalog key
 * @param {string} wall - Wall side: 'north', 'south', 'east', or 'west'
 * @param {Object} [options] - { facing, gap, inset, skipDoors }
 * @returns {{ success: boolean, placed: Array<[number, number]> }}
 */
export function fillWallWithProps(
  roomLabel: string,
  propType: string,
  wall: string,
  options: FillWallOptions = {},
): {
  success: true;
  placed: [number, number][];
  skipped: BulkSkipEntry[];
  lightsAdded: BulkLightAdded[];
} {
  if (!CARDINAL_DIRS.includes(wall))
    throw new ApiValidationError('INVALID_WALL', `wall must be one of: ${CARDINAL_DIRS.join(', ')}`, { wall });

  const catalog = state.propCatalog;
  if (!catalog?.props[propType])
    throw new ApiValidationError('UNKNOWN_PROP', `Unknown prop type: ${propType}`, {
      propType,
      available: Object.keys(catalog?.props ?? {}),
    });

  const def = catalog.props[propType];

  // Auto-compute facing for wall-mounted props: front faces south at rotation 0,
  // so north wall -> 0, south -> 180, east -> 270, west -> 90
  const WALL_FACINGS = { north: 0, south: 180, east: 270, west: 90 };
  const autoFacing =
    def.facing && (def.placement === 'wall' || def.placement === 'corner')
      ? WALL_FACINGS[wall as keyof typeof WALL_FACINGS]
      : 0;
  const facing = options.facing ?? autoFacing;
  const gap = options.gap ?? 0;
  const inset = options.inset ?? 0;
  const skipDoors = options.skipDoors !== false;

  if (![0, 90, 180, 270].includes(facing))
    throw new ApiValidationError('INVALID_FACING', `Invalid facing: ${facing}. Use 0, 90, 180, or 270.`, {
      facing,
      validFacings: [0, 90, 180, 270],
    });

  const [spanRows, spanCols] =
    facing === 90 || facing === 270 ? [def.footprint[1], def.footprint[0]] : [...def.footprint];

  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${roomLabel}" not found`, { label: roomLabel });

  const wallCells = getApi()._getWallCells(roomCells, wall);
  const placed: [number, number][] = [];
  const skipped: BulkSkipEntry[] = [];
  const lightsAdded: BulkLightAdded[] = [];
  if (!wallCells.length) return { success: true, placed, skipped, lightsAdded };

  const cells = state.dungeon.cells;
  const stride = wall === 'north' || wall === 'south' ? spanCols + gap : spanRows + gap;

  let i = 0;
  while (i < wallCells.length) {
    const [wr, wc] = wallCells[i]!;

    if (skipDoors) {
      const cell = cells[wr]?.[wc];
      const edgeVal = cell ? getEdge(cell, wall as CardinalDirection) : undefined;
      if (edgeVal === 'd' || edgeVal === 's') {
        skipped.push({ row: wr, col: wc, code: 'DOOR_HERE', reason: 'DOOR_HERE' });
        i++;
        continue;
      }
    }

    let ar, ac;
    if (wall === 'north') {
      ar = wr + inset;
      ac = wc;
    } else if (wall === 'south') {
      ar = wr - inset - spanRows + 1;
      ac = wc;
    } else if (wall === 'west') {
      ar = wr;
      ac = wc + inset;
    } else {
      ar = wr;
      ac = wc - inset - spanCols + 1;
    }

    let preCode: 'OUT_OF_ROOM' | 'OVERLAPS_PROP' | null = null;
    outer: for (let dr = 0; dr < spanRows; dr++) {
      for (let dc = 0; dc < spanCols; dc++) {
        if (!roomCells.has(cellKey(ar + dr, ac + dc))) {
          preCode = 'OUT_OF_ROOM';
          break outer;
        }
        if (getApi()._isCellCoveredByProp(ar + dr, ac + dc)) {
          preCode = 'OVERLAPS_PROP';
          break outer;
        }
      }
    }

    if (!preCode) {
      try {
        const res = getApi().placeProp(ar, ac, propType, facing);
        placed.push([ar, ac]);
        lightsAdded.push(...attributeLights(res, ar, ac, propType));
        i += stride;
        continue;
      } catch (e) {
        skipped.push(placeErrorToSkip(ar, ac, e, { propType, facing }));
        i++;
        continue;
      }
    }
    skipped.push({ row: ar, col: ac, code: preCode, reason: preCode });
    i++;
  }

  return { success: true, placed, skipped, lightsAdded };
}

/**
 * Place props in a straight line starting at (startRow, startCol).
 * direction: 'east' or 'south' — axis to advance along.
 * count: max number of props to place.
 * @param {string} roomLabel - Room label
 * @param {string} propType - Prop catalog key
 * @param {number} startRow - Starting row
 * @param {number} startCol - Starting column
 * @param {string} direction - 'east' or 'south'
 * @param {number} count - Maximum number of props to place
 * @param {Object} [options] - { facing, gap }
 * @returns {{ success: boolean, placed: Array<[number, number]> }}
 */
export function lineProps(
  roomLabel: string,
  propType: string,
  startRow: number,
  startCol: number,
  direction: string,
  count: number,
  options: LinePropsOptions = {},
): {
  success: true;
  placed: [number, number][];
  skipped: BulkSkipEntry[];
  lightsAdded: BulkLightAdded[];
} {
  startRow = toInt(startRow);
  startCol = toInt(startCol);
  if (!['east', 'south'].includes(direction))
    throw new ApiValidationError('INVALID_LINE_DIRECTION', 'direction must be "east" or "south"', {
      direction,
      validDirections: ['east', 'south'],
    });

  const catalog = state.propCatalog;
  if (!catalog?.props[propType])
    throw new ApiValidationError('UNKNOWN_PROP', `Unknown prop type: ${propType}`, {
      propType,
      available: Object.keys(catalog?.props ?? {}),
    });

  const facing = options.facing ?? 0;
  const gap = options.gap ?? 0;
  if (![0, 90, 180, 270].includes(facing))
    throw new ApiValidationError('INVALID_FACING', `Invalid facing: ${facing}. Use 0, 90, 180, or 270.`, {
      facing,
      validFacings: [0, 90, 180, 270],
    });

  const def = catalog.props[propType];
  const [spanRows, spanCols] =
    facing === 90 || facing === 270 ? [def.footprint[1], def.footprint[0]] : [...def.footprint];

  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${roomLabel}" not found`, { label: roomLabel });

  const [dr, dc] = direction === 'south' ? [spanRows + gap, 0] : [0, spanCols + gap];

  const placed: [number, number][] = [];
  const skipped: BulkSkipEntry[] = [];
  const lightsAdded: BulkLightAdded[] = [];
  let r = startRow,
    c = startCol;

  for (let i = 0; i < count; i++) {
    let preCode: 'OUT_OF_ROOM' | 'OVERLAPS_PROP' | null = null;
    outer: for (let pr = 0; pr < spanRows; pr++) {
      for (let pc = 0; pc < spanCols; pc++) {
        if (!roomCells.has(cellKey(r + pr, c + pc))) {
          preCode = 'OUT_OF_ROOM';
          break outer;
        }
        if (getApi()._isCellCoveredByProp(r + pr, c + pc)) {
          preCode = 'OVERLAPS_PROP';
          break outer;
        }
      }
    }

    if (!preCode) {
      try {
        const res = getApi().placeProp(r, c, propType, facing);
        placed.push([r, c]);
        lightsAdded.push(...attributeLights(res, r, c, propType));
      } catch (e) {
        skipped.push(placeErrorToSkip(r, c, e, { propType, facing }));
      }
    } else {
      skipped.push({ row: r, col: c, code: preCode, reason: preCode });
    }
    r += dr;
    c += dc;
  }

  return { success: true, placed, skipped, lightsAdded };
}

/**
 * Scatter props at random valid positions within a room.
 * count: max number to place (may place fewer if not enough room).
 * @param {string} roomLabel - Room label
 * @param {string} propType - Prop catalog key
 * @param {number} count - Maximum number of props to place
 * @param {Object} [options] - { facing, avoidWalls }
 * @returns {{ success: boolean, placed: Array<[number, number]> }}
 */
export function scatterProps(
  roomLabel: string,
  propType: string,
  count: number,
  options: ScatterPropsOptions = {},
): {
  success: true;
  placed: [number, number][];
  skipped: BulkSkipEntry[];
  lightsAdded: BulkLightAdded[];
  requested: number;
  available: number;
} {
  const facing = options.facing ?? 0;
  // Scattering rubble / barrels / etc. across a doorway is almost always a
  // mistake. Default avoidDoors to true; callers who genuinely want to fill
  // door cells (traps, pressure plates) can opt out explicitly.
  const avoidDoors = options.avoidDoors !== false;
  const placed: [number, number][] = [];
  const skipped: BulkSkipEntry[] = [];
  const lightsAdded: BulkLightAdded[] = [];
  const result = getApi().getValidPropPositions(roomLabel, propType, facing);
  if (!result.success || !result.positions?.length) {
    return { success: true, placed, skipped, lightsAdded, requested: count, available: 0 };
  }

  let positions = [...result.positions];
  const availableBeforeFilter = positions.length;

  if (options.avoidWalls) {
    const roomCells = getApi()._collectRoomCells(roomLabel);
    const bounds = roomCells ? roomBoundsFromKeys(roomCells) : null;
    if (bounds) {
      const margin = typeof options.avoidWalls === 'number' ? options.avoidWalls : 1;
      positions = positions.filter(
        ([r, c]) =>
          r >= bounds.r1 + margin && r <= bounds.r2 - margin && c >= bounds.c1 + margin && c <= bounds.c2 - margin,
      );
    }
  }

  // Precompute door + door-approach cell sets so scattering doesn't blindly
  // drop props in front of doorways.
  let doorCells: Set<string> | null = null;
  let doorApproachCells: Set<string> | null = null;
  if (avoidDoors) {
    const roomCells = getApi()._collectRoomCells(roomLabel);
    if (roomCells) {
      doorCells = new Set();
      doorApproachCells = new Set();
      const cells = state.dungeon.cells;
      const offsets: Record<string, [number, number]> = {
        north: [-1, 0],
        south: [1, 0],
        east: [0, 1],
        west: [0, -1],
      };
      for (const key of roomCells) {
        const [dr, dc] = key.split(',').map(Number) as [number, number];
        const cell = cells[dr]?.[dc];
        if (!cell) continue;
        for (const dir of CARDINAL_DIRS) {
          const v = (cell as Record<string, unknown>)[dir];
          if (v === 'd' || v === 's' || v === 'id') {
            doorCells.add(key);
            const [odr, odc] = offsets[dir]!;
            doorApproachCells.add(cellKey(dr + odr, dc + odc));
          }
        }
      }
    }
  }

  // Fisher-Yates shuffle
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j]!, positions[i]!];
  }

  for (const [r, c] of positions) {
    if (placed.length >= count) break;
    const key = cellKey(r, c);
    if (doorCells?.has(key)) {
      skipped.push({ row: r, col: c, code: 'DOOR_HERE', reason: 'DOOR_HERE' });
      continue;
    }
    if (doorApproachCells?.has(key)) {
      skipped.push({ row: r, col: c, code: 'DOOR_APPROACH', reason: 'DOOR_APPROACH' });
      continue;
    }
    if (getApi()._isCellCoveredByProp(r, c)) {
      skipped.push({ row: r, col: c, code: 'OVERLAPS_PROP', reason: 'OVERLAPS_PROP' });
      continue;
    }
    try {
      const res = getApi().placeProp(r, c, propType, facing);
      placed.push([r, c]);
      lightsAdded.push(...attributeLights(res, r, c, propType));
    } catch (e) {
      skipped.push(placeErrorToSkip(r, c, e, { propType, facing }));
    }
  }

  return { success: true, placed, skipped, lightsAdded, requested: count, available: availableBeforeFilter };
}

/**
 * Place a cluster of props at relative offsets from an anchor point.
 * @param {string} roomLabel - Room label
 * @param {Array<{ type: string, dr: number, dc: number, facing?: number }>} props - Prop offsets relative to anchor
 * @param {number} anchorRow - Anchor row
 * @param {number} anchorCol - Anchor column
 * @returns {{ success: boolean, placed: Array<Object>, failed: Array<Object> }}
 */
export function clusterProps(
  roomLabel: string,
  props: Array<{ type: string; dr: number; dc: number; facing?: number }>,
  anchorRow: number,
  anchorCol: number,
): {
  success: true;
  placed: { type: string; row: number; col: number }[];
  lightsAdded: BulkLightAdded[];
  skipped: {
    type: string;
    row: number;
    col: number;
    reason: string;
    code?: string;
    context?: Record<string, unknown>;
  }[];
} {
  anchorRow = toInt(anchorRow);
  anchorCol = toInt(anchorCol);
  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${roomLabel}" not found`, { label: roomLabel });

  const placed: { type: string; row: number; col: number }[] = [];
  const skipped: {
    type: string;
    row: number;
    col: number;
    reason: string;
    code?: string;
    context?: Record<string, unknown>;
  }[] = [];
  const lightsAdded: BulkLightAdded[] = [];

  for (const p of props) {
    const r = anchorRow + (p.dr || 0);
    const c = anchorCol + (p.dc || 0);
    const facing = p.facing ?? 0;
    try {
      const res = getApi().placeProp(r, c, p.type, facing);
      placed.push({ type: p.type, row: r, col: c });
      lightsAdded.push(...attributeLights(res, r, c, p.type));
    } catch (e) {
      const base = placeErrorToSkip(r, c, e, { propType: p.type, facing });
      skipped.push({ type: p.type, ...base });
    }
  }

  return { success: true, placed, skipped, lightsAdded };
}

// ── Overlay Prop Methods (metadata.props[] direct) ──────────────────────

/**
 * Set the z-index of an overlay prop by ID or preset name.
 * @param {string} propId - overlay prop ID (e.g. "prop_1")
 * @param {string|number} zOrPreset - "floor", "furniture", "tall", "hanging", or a raw number
 */
export function setPropZIndex(propId: string, zOrPreset: string | number): { success: true; zIndex: number } {
  const meta = state.dungeon.metadata;
  if (!meta.props) throw new ApiValidationError('NO_OVERLAY_PROPS', 'No overlay props on this map', {});
  const prop = meta.props.find((p: { id: string | number }) => p.id === propId);
  if (!prop) throw new ApiValidationError('PROP_ID_NOT_FOUND', `No prop with id "${propId}"`, { propId });

  mutate(
    'Set prop z-index',
    [],
    () => {
      prop.zIndex = resolveZIndex(zOrPreset);
    },
    { metaOnly: true, invalidate: ['props'] },
  );
  return { success: true, zIndex: prop.zIndex };
}

/**
 * Move a prop forward one z-index step (swap with the next higher prop).
 */
export function bringForward(propId: string): { success: true; zIndex: number } {
  const meta = state.dungeon.metadata;
  if (!meta.props) throw new ApiValidationError('NO_OVERLAY_PROPS', 'No overlay props on this map', {});
  const prop = meta.props.find((p) => p.id === propId);
  if (!prop) throw new ApiValidationError('PROP_ID_NOT_FOUND', `No prop with id "${propId}"`, { propId });

  // Find the next prop with a higher z-index
  const sorted = [...meta.props].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex((p) => p.id === propId);
  if (idx < sorted.length - 1) {
    mutate(
      'Bring prop forward',
      [],
      () => {
        const nextZ = sorted[idx + 1]!.zIndex;
        prop.zIndex = nextZ === prop.zIndex ? prop.zIndex + 1 : nextZ;
      },
      { metaOnly: true, invalidate: ['props'] },
    );
  }
  return { success: true, zIndex: prop.zIndex };
}

/**
 * Move a prop backward one z-index step (swap with the next lower prop).
 */
export function sendBackward(propId: string): { success: true; zIndex: number } {
  const meta = state.dungeon.metadata;
  if (!meta.props) throw new ApiValidationError('NO_OVERLAY_PROPS', 'No overlay props on this map', {});
  const prop = meta.props.find((p) => p.id === propId);
  if (!prop) throw new ApiValidationError('PROP_ID_NOT_FOUND', `No prop with id "${propId}"`, { propId });

  const sorted = [...meta.props].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex((p) => p.id === propId);
  if (idx > 0) {
    mutate(
      'Send prop backward',
      [],
      () => {
        const prevZ = sorted[idx - 1]!.zIndex;
        prop.zIndex = prevZ === prop.zIndex ? Math.max(0, prop.zIndex - 1) : prevZ;
      },
      { metaOnly: true, invalidate: ['props'] },
    );
  }
  return { success: true, zIndex: prop.zIndex };
}

/**
 * Suggest a good position for a prop in a room based on its placement metadata.
 * Uses the prop's placement field (wall/center/corner/floor) to compute a
 * semantically correct position and rotation.
 *
 * @param {string} roomLabel - room label to place the prop in
 * @param {string} propType - prop catalog key
 * @param {object} [options] - { preferWall: 'north'|'south'|'east'|'west' }
 * @returns {{ success, x, y, rotation, row, col }}
 */
export function suggestPropPosition(
  roomLabel: string,
  propType: string,
  options: SuggestPropPositionOptions = {},
): { success: boolean; row?: number; col?: number; x?: number; y?: number; rotation?: number; error?: string } {
  const catalog = state.propCatalog;
  if (!catalog?.props[propType])
    throw new ApiValidationError('UNKNOWN_PROP', `Unknown prop type: ${propType}`, {
      propType,
      available: Object.keys(catalog?.props ?? {}),
    });

  const def = catalog.props[propType];
  const placement = def.placement ?? 'center';
  const meta = state.dungeon.metadata;
  const gridSize = meta.gridSize || 5;

  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${roomLabel}" not found`, { label: roomLabel });
  const bounds = roomBoundsFromKeys(roomCells);
  if (!bounds) throw new ApiValidationError('ROOM_EMPTY', `Room "${roomLabel}" has no cells`, { label: roomLabel });

  const centerRow = Math.floor((bounds.r1 + bounds.r2) / 2);
  const centerCol = Math.floor((bounds.c1 + bounds.c2) / 2);

  let row, col, rotation;

  switch (placement) {
    case 'center': {
      row = centerRow;
      col = centerCol;
      rotation = 0;
      break;
    }
    case 'wall': {
      // Pick a wall edge, prefer options.preferWall or default to north
      const wall = options.preferWall ?? 'north';
      const WALL_FACINGS = { north: 0, south: 180, east: 270, west: 90 };
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
      rotation = WALL_FACINGS[wall as keyof typeof WALL_FACINGS] ?? 0;

      if (wall === 'north') {
        row = bounds.r1;
        col = centerCol;
      } else if (wall === 'south') {
        row = bounds.r2;
        col = centerCol;
      } else if (wall === 'west') {
        row = centerRow;
        col = bounds.c1;
      } else {
        row = centerRow;
        col = bounds.c2;
      }
      break;
    }
    case 'corner': {
      row = bounds.r1;
      col = bounds.c1;
      rotation = 0;
      break;
    }
    case 'floor':
    case 'any':
    default: {
      row = centerRow;
      col = centerCol;
      rotation = 0;
      break;
    }
  }

  return {
    success: true,
    row,
    col,
    x: col * gridSize,
    y: row * gridSize,
    rotation,
  };
}
