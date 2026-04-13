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
import { createOverlayProp, resolveZIndex } from '../prop-overlay.js';
import { normalizeRect } from './_rect-utils.js';

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
            radius: preset.radius ?? 20,
            color: preset.color ?? '#ff9944',
            intensity: preset.intensity ?? 1.0,
            falloff: preset.falloff ?? 'smooth',
            presetId: lightEntry.preset,
            propRef: { row, col },
          };
          if (preset.dimRadius) light.dimRadius = preset.dimRadius;
          if (preset.animation?.type) light.animation = { ...preset.animation };
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
  mutate(
    'Rotate prop',
    [],
    () => {
      newFacing = ((((overlay.rotation || 0) + degrees) % 360) + 360) % 360;
      overlay.rotation = newFacing;
    },
    { metaOnly: true, invalidate: ['lighting:props', 'props'] },
  );
  return { success: true, facing: newFacing! };
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
      meta.props = meta.props!.filter((p: { x: number; y: number }) => {
        const pRow = Math.round(p.y / gridSize);
        const pCol = Math.round(p.x / gridSize);
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
): { success: true; placed: [number, number][]; skipped: Array<{ row: number; col: number; reason: string }> } {
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
  const skipped: Array<{ row: number; col: number; reason: string }> = [];
  if (!wallCells.length) return { success: true, placed, skipped };

  const cells = state.dungeon.cells;
  const stride = wall === 'north' || wall === 'south' ? spanCols + gap : spanRows + gap;

  let i = 0;
  while (i < wallCells.length) {
    const [wr, wc] = wallCells[i]!;

    if (skipDoors) {
      const cell = cells[wr]?.[wc];
      const edgeVal = cell ? getEdge(cell, wall as CardinalDirection) : undefined;
      if (edgeVal === 'd' || edgeVal === 's') {
        skipped.push({ row: wr, col: wc, reason: 'DOOR_HERE' });
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

    let reason: string | null = null;
    outer: for (let dr = 0; dr < spanRows; dr++) {
      for (let dc = 0; dc < spanCols; dc++) {
        if (!roomCells.has(cellKey(ar + dr, ac + dc))) {
          reason = 'OUT_OF_ROOM';
          break outer;
        }
        if (getApi()._isCellCoveredByProp(ar + dr, ac + dc)) {
          reason = 'OVERLAPS_PROP';
          break outer;
        }
      }
    }

    if (!reason) {
      try {
        getApi().placeProp(ar, ac, propType, facing);
        placed.push([ar, ac]);
        i += stride;
        continue;
      } catch (e) {
        reason = e instanceof Error ? `PLACE_FAILED: ${e.message}` : 'PLACE_FAILED';
      }
    }
    skipped.push({ row: ar, col: ac, reason });
    i++;
  }

  return { success: true, placed, skipped };
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
): { success: true; placed: [number, number][]; skipped: Array<{ row: number; col: number; reason: string }> } {
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
  const skipped: Array<{ row: number; col: number; reason: string }> = [];
  let r = startRow,
    c = startCol;

  for (let i = 0; i < count; i++) {
    let reason: string | null = null;
    outer: for (let pr = 0; pr < spanRows; pr++) {
      for (let pc = 0; pc < spanCols; pc++) {
        if (!roomCells.has(cellKey(r + pr, c + pc))) {
          reason = 'OUT_OF_ROOM';
          break outer;
        }
        if (getApi()._isCellCoveredByProp(r + pr, c + pc)) {
          reason = 'OVERLAPS_PROP';
          break outer;
        }
      }
    }

    if (!reason) {
      try {
        getApi().placeProp(r, c, propType, facing);
        placed.push([r, c]);
      } catch (e) {
        skipped.push({ row: r, col: c, reason: e instanceof Error ? `PLACE_FAILED: ${e.message}` : 'PLACE_FAILED' });
      }
    } else {
      skipped.push({ row: r, col: c, reason });
    }
    r += dr;
    c += dc;
  }

  return { success: true, placed, skipped };
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
  skipped: Array<{ row: number; col: number; reason: string }>;
  requested: number;
  available: number;
} {
  const facing = options.facing ?? 0;
  const placed: [number, number][] = [];
  const skipped: Array<{ row: number; col: number; reason: string }> = [];
  const result = getApi().getValidPropPositions(roomLabel, propType, facing);
  if (!result.success || !result.positions?.length) {
    return { success: true, placed, skipped, requested: count, available: 0 };
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

  // Fisher-Yates shuffle
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j]!, positions[i]!];
  }

  for (const [r, c] of positions) {
    if (placed.length >= count) break;
    if (getApi()._isCellCoveredByProp(r, c)) {
      skipped.push({ row: r, col: c, reason: 'OVERLAPS_PROP' });
      continue;
    }
    try {
      getApi().placeProp(r, c, propType, facing);
      placed.push([r, c]);
    } catch (e) {
      skipped.push({ row: r, col: c, reason: e instanceof Error ? `PLACE_FAILED: ${e.message}` : 'PLACE_FAILED' });
    }
  }

  return { success: true, placed, skipped, requested: count, available: availableBeforeFilter };
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

  for (const p of props) {
    const r = anchorRow + (p.dr || 0);
    const c = anchorCol + (p.dc || 0);
    const facing = p.facing ?? 0;
    try {
      getApi().placeProp(r, c, p.type, facing);
      placed.push({ type: p.type, row: r, col: c });
    } catch (e) {
      const entry: {
        type: string;
        row: number;
        col: number;
        reason: string;
        code?: string;
        context?: Record<string, unknown>;
      } = {
        type: p.type,
        row: r,
        col: c,
        reason: e instanceof Error ? e.message : String(e),
      };
      if (e instanceof ApiValidationError) {
        entry.code = e.code;
        entry.context = e.context;
      }
      skipped.push(entry);
    }
  }

  return { success: true, placed, skipped };
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
