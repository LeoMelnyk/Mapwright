import {
  getApi,
  CARDINAL_DIRS,
  state, pushUndo, markDirty, notify, invalidateLightmap,
  validateBounds, ensureCell,
  getLightCatalog,
  cellKey, roomBoundsFromKeys,
} from './_shared.js';

// ── Prop Operations ─────────────────────────────────────────────────────

export function placeProp(row, col, propType, facing = 0) {
  validateBounds(row, col);
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    throw new Error(`Unknown prop type: ${propType}. Available: ${Object.keys(catalog?.props || {}).join(', ')}`);
  }
  if (![0, 90, 180, 270].includes(facing)) {
    throw new Error(`Invalid facing: ${facing}. Use 0, 90, 180, or 270.`);
  }
  const def = catalog.props[propType];
  const span = (facing === 90 || facing === 270)
    ? [def.footprint[1], def.footprint[0]]
    : [...def.footprint];

  // Validate all cells in span
  const cells = state.dungeon.cells;
  const searchRadius = 4;
  for (let r = row; r < row + span[0]; r++) {
    for (let c = col; c < col + span[1]; c++) {
      validateBounds(r, c);
      if (cells[r][c] === null) throw new Error(`Cell (${r}, ${c}) is void — cannot place prop`);
      // Check if this cell is already occupied by another prop
      if (cells[r][c]?.prop) throw new Error(`Cell (${r}, ${c}) is already occupied by prop "${cells[r][c].prop.type}"`);
      for (let pr = Math.max(0, r - searchRadius); pr <= r; pr++) {
        for (let pc = Math.max(0, c - searchRadius); pc <= c; pc++) {
          const existing = cells[pr]?.[pc]?.prop;
          if (existing && pr + existing.span[0] > r && pc + existing.span[1] > c) {
            throw new Error(`Cell (${r}, ${c}) is already covered by prop "${existing.type}" anchored at (${pr}, ${pc})`);
          }
        }
      }
    }
  }

  const cell = ensureCell(row, col);
  pushUndo();
  cell.prop = { type: propType, span, facing };

  // Create linked lights from propDef.lights
  if (def.lights?.length) {
    const meta = state.dungeon.metadata;
    if (!meta.lights) meta.lights = [];
    if (!meta.nextLightId) meta.nextLightId = 1;
    const gridSize = meta.gridSize || 5;
    const lightCatalog = getLightCatalog();
    const [origRows, origCols] = def.footprint;

    for (const entry of def.lights) {
      let nx = entry.x ?? 0.5;
      let ny = entry.y ?? 0.5;
      if (facing === 90)  { [nx, ny] = [origRows - ny, nx]; }
      else if (facing === 180) { [nx, ny] = [origCols - nx, origRows - ny]; }
      else if (facing === 270) { [nx, ny] = [ny, origCols - nx]; }

      const preset = lightCatalog?.lights?.[entry.preset] || {};
      const light = {
        id: meta.nextLightId++,
        x: (col + nx) * gridSize,
        y: (row + ny) * gridSize,
        type: preset.type || 'point',
        radius: preset.radius ?? 20,
        color: preset.color || '#ff9944',
        intensity: preset.intensity ?? 1.0,
        falloff: preset.falloff || 'smooth',
        presetId: entry.preset,
        propRef: { row, col },
      };
      if (preset.dimRadius) light.dimRadius = preset.dimRadius;
      if (preset.animation?.type) light.animation = { ...preset.animation };
      meta.lights.push(light);
    }
    invalidateLightmap();
  }

  markDirty();
  notify();
  return { success: true };
}

export function removeProp(row, col) {
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell?.prop) return { success: true };
  pushUndo();
  delete cell.prop;
  // Remove linked lights
  const meta = state.dungeon.metadata;
  if (meta.lights?.length) {
    meta.lights = meta.lights.filter(l => !(l.propRef?.row === row && l.propRef?.col === col));
    invalidateLightmap();
  }
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

export function rotateProp(row, col) {
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  if (!cell?.prop) throw new Error(`No prop at (${row}, ${col})`);
  pushUndo();
  const newFacing = (cell.prop.facing + 90) % 360;
  cell.prop.facing = newFacing;
  cell.prop.span = [cell.prop.span[1], cell.prop.span[0]];
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

/** Remove the prop whose anchor cell is exactly (row, col). */
export function removePropAt(row, col) {
  validateBounds(row, col);
  const cell = state.dungeon.cells[row]?.[col];
  if (!cell?.prop) return { success: false, error: 'no prop at that cell' };
  pushUndo();
  delete cell.prop;
  markDirty();
  notify();
  return { success: true };
}

/** Remove all props with anchor cells in the given rectangle. */
export function removePropsInRect(r1, c1, r2, c2) {
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
  validateBounds(minR, minC);
  validateBounds(maxR, maxC);
  pushUndo();
  let removed = 0;
  const cells = state.dungeon.cells;
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (cells[r]?.[c]?.prop) {
        delete cells[r][c].prop;
        removed++;
      }
    }
  }
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
