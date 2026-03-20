import {
  getApi,
  CARDINAL_DIRS,
  state, pushUndo, markDirty, notify, invalidateLightmap,
  validateBounds,
  getLightCatalog,
  cellKey, roomBoundsFromKeys,
} from './_shared.js';
import { lookupPropAt, markPropSpatialDirty } from '../prop-spatial.js';
import { createOverlayProp, resolveZIndex } from '../prop-overlay.js';

// ── Overlay Helpers ─────────────────────────────────────────────────────

/** Ensure metadata.props[] array exists. */
function ensurePropsArray() {
  const meta = state.dungeon.metadata;
  if (!meta.props) meta.props = [];
  if (!meta.nextPropId) meta.nextPropId = 1;
  return meta;
}

/** Find the overlay prop at the given grid position (uses spatial hash for freeform compat). */
function findPropAtGrid(row, col) {
  const entry = lookupPropAt(row, col);
  if (!entry) return null;
  const meta = state.dungeon.metadata;
  return meta?.props?.find(p => p.id === entry.propId) ?? null;
}

/** Remove the overlay prop at the given grid position. Returns true if found. */
function removePropAtGrid(row, col) {
  const entry = lookupPropAt(row, col);
  if (!entry) return false;
  const meta = state.dungeon.metadata;
  if (!meta?.props) return false;
  const idx = meta.props.findIndex(p => p.id === entry.propId);
  if (idx >= 0) { meta.props.splice(idx, 1); return true; }
  return false;
}

// ── Prop Operations ─────────────────────────────────────────────────────

export function placeProp(row, col, propType, facing = 0, options = {}) {
  validateBounds(row, col);
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    throw new Error(`Unknown prop type: ${propType}. Available: ${Object.keys(catalog?.props || {}).join(', ')}`);
  }
  facing = ((facing % 360) + 360) % 360; // normalize to 0-359
  const scale = Math.max(0.25, Math.min(4.0, options.scale ?? 1.0));
  const allowOverlap = !!options.allowOverlap;
  const def = catalog.props[propType];
  const r90 = ((facing % 360) + 360) % 360;
  const span = (r90 === 90 || r90 === 270)
    ? [def.footprint[1], def.footprint[0]]
    : [...def.footprint];

  // Validate all cells in span
  const warnings = [];
  const cells = state.dungeon.cells;
  for (let r = row; r < row + span[0]; r++) {
    for (let c = col; c < col + span[1]; c++) {
      validateBounds(r, c);
      if (cells[r][c] === null) throw new Error(`Cell (${r}, ${c}) is void — cannot place prop`);
      // O(1) spatial hash check for overlap
      const covered = lookupPropAt(r, c);
      if (covered) {
        if (allowOverlap) {
          warnings.push(`overlaps with ${covered.propType} (${covered.propId || 'unknown'}) at (${covered.anchorRow}, ${covered.anchorCol})`);
        } else {
          throw new Error(`Cell (${r}, ${c}) is already covered by prop "${covered.propType}" anchored at (${covered.anchorRow}, ${covered.anchorCol})`);
        }
      }
    }
  }

  const meta = ensurePropsArray();
  const gridSize = meta.gridSize || 5;

  pushUndo();

  // Write to overlay — use exact world-feet coords if provided, otherwise snap to grid
  const entry = createOverlayProp(meta, propType, row, col, gridSize, {
    rotation: facing,
    scale,
    ...(options.zIndex != null && { zIndex: options.zIndex }),
  });
  // Freeform placement: override position with exact world-feet coordinates
  if (options.x != null) entry.x = options.x;
  if (options.y != null) entry.y = options.y;
  meta.props.push(entry);

  // Create linked lights from propDef.lights
  if (def.lights?.length) {
    if (!meta.lights) meta.lights = [];
    if (!meta.nextLightId) meta.nextLightId = 1;
    const lightCatalog = getLightCatalog();
    const [origRows, origCols] = def.footprint;

    for (const lightEntry of def.lights) {
      let nx = lightEntry.x ?? 0.5;
      let ny = lightEntry.y ?? 0.5;
      if (facing === 90)  { [nx, ny] = [origRows - ny, nx]; }
      else if (facing === 180) { [nx, ny] = [origCols - nx, origRows - ny]; }
      else if (facing === 270) { [nx, ny] = [ny, origCols - nx]; }

      const preset = lightCatalog?.lights?.[lightEntry.preset] || {};
      const light = {
        id: meta.nextLightId++,
        x: (col + nx) * gridSize,
        y: (row + ny) * gridSize,
        type: preset.type || 'point',
        radius: preset.radius ?? 20,
        color: preset.color || '#ff9944',
        intensity: preset.intensity ?? 1.0,
        falloff: preset.falloff || 'smooth',
        presetId: lightEntry.preset,
        propRef: { row, col },
      };
      if (preset.dimRadius) light.dimRadius = preset.dimRadius;
      if (preset.animation?.type) light.animation = { ...preset.animation };
      meta.lights.push(light);
    }
  }

  markPropSpatialDirty();
  invalidateLightmap();
  markDirty();
  notify();
  return warnings.length ? { success: true, warnings } : { success: true };
}

export function removeProp(row, col) {
  validateBounds(row, col);
  const overlay = findPropAtGrid(row, col);
  if (!overlay) return { success: true };
  pushUndo();
  removePropAtGrid(row, col);
  // Remove linked lights
  const meta = state.dungeon.metadata;
  if (meta.lights?.length) {
    meta.lights = meta.lights.filter(l => !(l.propRef?.row === row && l.propRef?.col === col));
  }
  markPropSpatialDirty();
  invalidateLightmap();
  markDirty();
  notify();
  return { success: true };
}

export function setLightName(id, name) {
  const meta = state.dungeon.metadata;
  const light = (meta.lights || []).find(l => l.id === id);
  if (!light) throw new Error(`No light with id ${id}`);
  if (name) light.name = name;
  else delete light.name;
  markDirty();
  notify();
  return { success: true };
}

export function rotateProp(row, col, degrees = 90) {
  validateBounds(row, col);
  const overlay = findPropAtGrid(row, col);
  if (!overlay) throw new Error(`No prop at (${row}, ${col})`);
  pushUndo();
  const newFacing = (((overlay.rotation || 0) + degrees) % 360 + 360) % 360;
  overlay.rotation = newFacing;
  markPropSpatialDirty();
  markDirty();
  notify();
  return { success: true, facing: newFacing };
}

export function listProps() {
  const catalog = state.propCatalog;
  if (!catalog) return { success: true, categories: [], props: {} };
  return {
    success: true,
    categories: catalog.categories,
    props: Object.fromEntries(
      Object.entries(catalog.props).map(([k, v]) => [k, {
        name: v.name,
        category: v.category,
        footprint: v.footprint,
        facing: v.facing,
        placement: v.placement || null,
        roomTypes: v.roomTypes || [],
        typicalCount: v.typicalCount || null,
        clustersWith: v.clustersWith || [],
        notes: v.notes || null,
      }])
    ),
  };
}

/**
 * Return all props that belong in a specific room type.
 * Returns { props: [{ name, category, footprint, facing, placement, ... }] }
 */
export function getPropsForRoomType(roomType) {
  const catalog = state.propCatalog;
  if (!catalog) return { success: false, props: [] };
  const results = [];
  for (const [key, v] of Object.entries(catalog.props)) {
    if (v.roomTypes?.includes(roomType) || v.roomTypes?.includes('any')) {
      results.push({
        name: key,
        displayName: v.name,
        category: v.category,
        footprint: v.footprint,
        facing: v.facing,
        placement: v.placement || null,
        typicalCount: v.typicalCount || null,
        clustersWith: v.clustersWith || [],
        notes: v.notes || null,
      });
    }
  }
  return { success: true, props: results };
}

/** Remove the prop at the given grid position. */
export function removePropAt(row, col) {
  validateBounds(row, col);
  if (!findPropAtGrid(row, col)) return { success: false, error: 'no prop at that cell' };
  pushUndo();
  removePropAtGrid(row, col);
  markPropSpatialDirty();
  markDirty();
  notify();
  return { success: true };
}

/** Remove all props with anchor positions in the given rectangle. */
export function removePropsInRect(r1, c1, r2, c2) {
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  const meta = state.dungeon.metadata;
  if (!meta?.props) return { success: true, removed: 0 };

  const gridSize = meta.gridSize || 5;
  pushUndo();

  const before = meta.props.length;
  meta.props = meta.props.filter(p => {
    const pRow = Math.round(p.y / gridSize);
    const pCol = Math.round(p.x / gridSize);
    return pRow < minR || pRow > maxR || pCol < minC || pCol > maxC;
  });
  const removed = before - meta.props.length;

  markPropSpatialDirty();
  markDirty();
  notify();
  return { success: true, removed };
}

// ── Bulk Prop Placement ─────────────────────────────────────────────────

/**
 * Fill a wall of a room with repeated copies of a prop.
 * wall: 'north', 'south', 'east', 'west'.
 * options: { facing, gap, inset, skipDoors }
 *   facing: prop rotation (0/90/180/270). Default 0.
 *   gap: cells between each prop along the wall. Default 0.
 *   inset: cells inward from the wall edge. Default 0.
 *   skipDoors: skip cells adjacent to doors. Default true.
 */
export function fillWallWithProps(roomLabel, propType, wall, options = {}) {
  if (!CARDINAL_DIRS.includes(wall)) throw new Error(`wall must be one of: ${CARDINAL_DIRS.join(', ')}`);

  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) throw new Error(`Unknown prop type: ${propType}`);

  const def = catalog.props[propType];

  // Auto-compute facing for wall-mounted props: front faces south at rotation 0,
  // so north wall -> 0, south -> 180, east -> 270, west -> 90
  const WALL_FACINGS = { north: 0, south: 180, east: 270, west: 90 };
  const autoFacing = (def.facing && (def.placement === 'wall' || def.placement === 'corner'))
    ? WALL_FACINGS[wall]
    : 0;
  const facing = options.facing ?? autoFacing;
  const gap = options.gap ?? 0;
  const inset = options.inset ?? 0;
  const skipDoors = options.skipDoors !== false;

  if (![0, 90, 180, 270].includes(facing)) throw new Error(`Invalid facing: ${facing}`);

  const [spanRows, spanCols] = (facing === 90 || facing === 270)
    ? [def.footprint[1], def.footprint[0]]
    : [...def.footprint];

  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new Error(`Room "${roomLabel}" not found`);

  const wallCells = getApi()._getWallCells(roomCells, wall);
  if (!wallCells.length) return { success: true, placed: [] };

  const cells = state.dungeon.cells;
  const stride = (wall === 'north' || wall === 'south') ? spanCols + gap : spanRows + gap;

  const placed = [];
  let i = 0;
  while (i < wallCells.length) {
    const [wr, wc] = wallCells[i];

    if (skipDoors) {
      const cell = cells[wr]?.[wc];
      if (cell?.[wall] === 'd' || cell?.[wall] === 's') { i++; continue; }
    }

    let ar, ac;
    if (wall === 'north')      { ar = wr + inset; ac = wc; }
    else if (wall === 'south') { ar = wr - inset - spanRows + 1; ac = wc; }
    else if (wall === 'west')  { ar = wr; ac = wc + inset; }
    else                       { ar = wr; ac = wc - inset - spanCols + 1; }

    let canPlace = true;
    for (let dr = 0; dr < spanRows && canPlace; dr++) {
      for (let dc = 0; dc < spanCols && canPlace; dc++) {
        if (!roomCells.has(cellKey(ar + dr, ac + dc))) canPlace = false;
        else if (getApi()._isCellCoveredByProp(ar + dr, ac + dc)) canPlace = false;
      }
    }

    if (canPlace) {
      try {
        getApi().placeProp(ar, ac, propType, facing);
        placed.push([ar, ac]);
        i += stride;
      } catch { i++; }
    } else {
      i++;
    }
  }

  return { success: true, placed };
}

/**
 * Place props in a straight line starting at (startRow, startCol).
 * direction: 'east' or 'south' — axis to advance along.
 * count: max number of props to place.
 * options: { facing, gap }
 */
export function lineProps(roomLabel, propType, startRow, startCol, direction, count, options = {}) {
  if (!['east', 'south'].includes(direction)) throw new Error('direction must be "east" or "south"');

  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) throw new Error(`Unknown prop type: ${propType}`);

  const facing = options.facing ?? 0;
  const gap = options.gap ?? 0;
  if (![0, 90, 180, 270].includes(facing)) throw new Error(`Invalid facing: ${facing}`);

  const def = catalog.props[propType];
  const [spanRows, spanCols] = (facing === 90 || facing === 270)
    ? [def.footprint[1], def.footprint[0]]
    : [...def.footprint];

  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new Error(`Room "${roomLabel}" not found`);

  const [dr, dc] = direction === 'south' ? [spanRows + gap, 0] : [0, spanCols + gap];

  const placed = [];
  let r = startRow, c = startCol;

  for (let i = 0; i < count; i++) {
    let canPlace = true;
    for (let pr = 0; pr < spanRows && canPlace; pr++) {
      for (let pc = 0; pc < spanCols && canPlace; pc++) {
        if (!roomCells.has(cellKey(r + pr, c + pc))) canPlace = false;
        else if (getApi()._isCellCoveredByProp(r + pr, c + pc)) canPlace = false;
      }
    }

    if (canPlace) {
      try {
        getApi().placeProp(r, c, propType, facing);
        placed.push([r, c]);
      } catch { /* skip failed */ }
    }
    r += dr;
    c += dc;
  }

  return { success: true, placed };
}

/**
 * Scatter props at random valid positions within a room.
 * count: max number to place (may place fewer if not enough room).
 * options: { facing, avoidWalls (number of cells margin from walls, default 0) }
 */
export function scatterProps(roomLabel, propType, count, options = {}) {
  const facing = options.facing ?? 0;
  const result = getApi().getValidPropPositions(roomLabel, propType, facing);
  if (!result.success || !result.positions?.length) return { success: true, placed: [] };

  let positions = [...result.positions];

  if (options.avoidWalls) {
    const roomCells = getApi()._collectRoomCells(roomLabel);
    const bounds = roomBoundsFromKeys(roomCells);
    if (bounds) {
      const margin = typeof options.avoidWalls === 'number' ? options.avoidWalls : 1;
      positions = positions.filter(([r, c]) =>
        r >= bounds.r1 + margin && r <= bounds.r2 - margin &&
        c >= bounds.c1 + margin && c <= bounds.c2 - margin
      );
    }
  }

  // Fisher-Yates shuffle
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }

  const placed = [];
  for (const [r, c] of positions) {
    if (placed.length >= count) break;
    if (getApi()._isCellCoveredByProp(r, c)) continue;
    try {
      getApi().placeProp(r, c, propType, facing);
      placed.push([r, c]);
    } catch { continue; }
  }

  return { success: true, placed };
}

/**
 * Place a cluster of props at relative offsets from an anchor point.
 * props: [{ type, dr, dc, facing }] — offsets relative to (anchorRow, anchorCol).
 * Returns { placed, failed } arrays.
 */
export function clusterProps(roomLabel, props, anchorRow, anchorCol) {
  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new Error(`Room "${roomLabel}" not found`);

  const placed = [];
  const failed = [];

  for (const p of props) {
    const r = anchorRow + (p.dr || 0);
    const c = anchorCol + (p.dc || 0);
    const facing = p.facing || 0;
    try {
      getApi().placeProp(r, c, p.type, facing);
      placed.push({ type: p.type, row: r, col: c });
    } catch (e) {
      failed.push({ type: p.type, row: r, col: c, error: e.message });
    }
  }

  return { success: true, placed, failed };
}

// ── Overlay Prop Methods (metadata.props[] direct) ──────────────────────

/**
 * Set the z-index of an overlay prop by ID or preset name.
 * @param {string} propId - overlay prop ID (e.g. "prop_1")
 * @param {string|number} zOrPreset - "floor", "furniture", "tall", "hanging", or a raw number
 */
export function setPropZIndex(propId, zOrPreset) {
  const meta = state.dungeon.metadata;
  if (!meta?.props) throw new Error('No overlay props');
  const prop = meta.props.find(p => p.id === propId);
  if (!prop) throw new Error(`No prop with id "${propId}"`);

  pushUndo();
  prop.zIndex = resolveZIndex(zOrPreset);
  markDirty();
  notify();
  return { success: true, zIndex: prop.zIndex };
}

/**
 * Move a prop forward one z-index step (swap with the next higher prop).
 */
export function bringForward(propId) {
  const meta = state.dungeon.metadata;
  if (!meta?.props) throw new Error('No overlay props');
  const prop = meta.props.find(p => p.id === propId);
  if (!prop) throw new Error(`No prop with id "${propId}"`);

  // Find the next prop with a higher z-index
  const sorted = [...meta.props].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex(p => p.id === propId);
  if (idx < sorted.length - 1) {
    pushUndo();
    const nextZ = sorted[idx + 1].zIndex;
    prop.zIndex = nextZ === prop.zIndex ? prop.zIndex + 1 : nextZ;
    markDirty();
    notify();
  }
  return { success: true, zIndex: prop.zIndex };
}

/**
 * Move a prop backward one z-index step (swap with the next lower prop).
 */
export function sendBackward(propId) {
  const meta = state.dungeon.metadata;
  if (!meta?.props) throw new Error('No overlay props');
  const prop = meta.props.find(p => p.id === propId);
  if (!prop) throw new Error(`No prop with id "${propId}"`);

  const sorted = [...meta.props].sort((a, b) => a.zIndex - b.zIndex);
  const idx = sorted.findIndex(p => p.id === propId);
  if (idx > 0) {
    pushUndo();
    const prevZ = sorted[idx - 1].zIndex;
    prop.zIndex = prevZ === prop.zIndex ? Math.max(0, prop.zIndex - 1) : prevZ;
    markDirty();
    notify();
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
export function suggestPropPosition(roomLabel, propType, options = {}) {
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) throw new Error(`Unknown prop type: ${propType}`);

  const def = catalog.props[propType];
  const placement = def.placement || 'center';
  const meta = state.dungeon.metadata;
  const gridSize = meta.gridSize || 5;

  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new Error(`Room "${roomLabel}" not found`);
  const bounds = roomBoundsFromKeys(roomCells);
  if (!bounds) throw new Error(`Room "${roomLabel}" has no cells`);

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
      const wall = options.preferWall || 'north';
      const WALL_FACINGS = { north: 0, south: 180, east: 270, west: 90 };
      rotation = WALL_FACINGS[wall] ?? 0;

      if (wall === 'north')      { row = bounds.r1; col = centerCol; }
      else if (wall === 'south') { row = bounds.r2; col = centerCol; }
      else if (wall === 'west')  { row = centerRow; col = bounds.c1; }
      else                       { row = centerRow; col = bounds.c2; }
      break;
    }
    case 'corner': {
      row = bounds.r1;
      col = bounds.c1;
      rotation = 0;
      break;
    }
    default: { // 'floor', 'any'
      row = centerRow;
      col = centerCol;
      rotation = 0;
      break;
    }
  }

  return {
    success: true,
    row, col,
    x: col * gridSize,
    y: row * gridSize,
    rotation,
  };
}
