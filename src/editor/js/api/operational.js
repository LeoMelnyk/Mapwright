// operational.js — Operational, visualization, and AI helper methods.

import {
  getApi,
  state, undoFn, redoFn,
  requestRender,
  getThemeCatalog, getTextureCatalog, collectTextureIds, ensureTexturesLoaded,
  reloadAssets,
  calculateCanvasSize, renderDungeonToCanvas,
  cellKey, parseCellKey, roomBoundsFromKeys,
} from './_shared.js';

// ── Undo / Redo ──────────────────────────────────────────────────────────

export function undo() {
  undoFn();
  requestRender();
  return { success: true };
}

export function redo() {
  redoFn();
  requestRender();
  return { success: true };
}

// ── Visualization ────────────────────────────────────────────────────────

/**
 * Ensure all textures used in the current map have their images loaded,
 * then wait for them to finish. Call before getScreenshot() to guarantee
 * textures are rendered. Returns { success, count } when all images ready.
 */
export async function waitForTextures(timeoutMs = 8000) {
  if (!state.textureCatalog?.textures) return { success: true, count: 0 };

  // Trigger loading for any map-used textures that haven't started yet
  const usedIds = collectTextureIds(state.dungeon.cells);

  // Also include textures referenced by overlay props
  if (state.propCatalog?.props && state.dungeon.metadata?.props) {
    for (const op of state.dungeon.metadata.props) {
      const propDef = state.propCatalog.props[op.type];
      if (propDef?.textures) {
        for (const id of propDef.textures) usedIds.add(id);
      }
    }
  }

  await ensureTexturesLoaded(usedIds);

  // Wait for all in-flight images (map-used + any previously triggered)
  const entries = Object.values(state.textureCatalog.textures);
  const pending = entries.filter(e => e.img && !e.img.complete);
  if (!pending.length) { requestRender(); return { success: true, count: entries.length }; }

  const deadline = Date.now() + timeoutMs;
  await Promise.all(pending.map(e => new Promise((resolve) => {
    if (e.img.complete) return resolve();
    const done = () => {
      e.img.removeEventListener('load', done);
      e.img.removeEventListener('error', done);
      resolve();
    };
    e.img.addEventListener('load', done);
    e.img.addEventListener('error', done);
    const check = () => { if (e.img.complete || Date.now() >= deadline) resolve(); else setTimeout(check, 100); };
    check();
  })));

  requestRender();
  return { success: true, count: entries.length };
}

export async function getScreenshot() {
  // Ensure map-used textures are loaded before capturing
  await getApi().waitForTextures();
  requestRender();
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const canvas = document.getElementById('editor-canvas');
      resolve(canvas.toDataURL('image/png'));
    });
  });
}

/** Export the map as a PNG using the compile pipeline (HQ lighting). Returns data URL. */
export async function exportPng() {
  await getApi().waitForTextures();
  const config = state.dungeon;
  const { width, height } = calculateCanvasSize(config);
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d');
  renderDungeonToCanvas(ctx, config, width, height, state.propCatalog, state.textureCatalog);
  return offscreen.toDataURL('image/png');
}

/**
 * Clear all caches (props, textures, themes, lights) and reload from server.
 */
export async function clearCaches() {
  await reloadAssets();
  return { success: true };
}

export function render() {
  requestRender();
  return { success: true };
}

/**
 * Wait for the editor to be fully initialized: all catalogs loaded,
 * canvas ready, and textures resolved. Useful as a first command in
 * Puppeteer scripts to ensure the editor is ready before interacting.
 */
export async function waitForEditor(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() >= deadline) return reject(new Error('waitForEditor timed out'));
      const ready = !!(
        document.getElementById('editor-canvas') &&
        state.dungeon &&
        getThemeCatalog() !== null &&
        state.propCatalog
      );
      if (ready) return resolve();
      setTimeout(check, 100);
    };
    check();
  });
  return { success: true };
}

/**
 * Evaluate arbitrary JS in the editor context.
 * The code string is wrapped in an async function with access to `state`, `editorAPI`, and `document`.
 * Use `return <value>` to send a result back.
 * Example: editorAPI.eval('return document.querySelector(".menu-trigger").textContent')
 */
export async function eval_(code) {
  const fn = new Function('state', 'editorAPI', `return (async () => { ${code} })();`);
  const result = await fn(state, window.editorAPI);
  if (result === undefined || result === null) return { success: true };
  if (typeof result === 'object' && result.success !== undefined) return result;
  return { success: true, result };
}

// ── Claude AI helpers ────────────────────────────────────────────────────

/** Return current undo stack depth. Used by Claude chat to support "undo all" after a build. */
export function getUndoDepth() {
  return { success: true, depth: state.undoStack.length };
}

/** Undo back to a previously recorded depth, reversing all changes made since then. */
export function undoToDepth(targetDepth) {
  const depth = Math.max(0, targetDepth);
  let count = 0;
  while (state.undoStack.length > depth) {
    undoFn();
    count++;
  }
  return { success: true, undid: count };
}

/** Return the contents of a labeled room: props, fills, doors, textures. */
export function getRoomContents(label) {
  const bounds = getApi().getRoomBounds(label);
  if (!bounds) return { success: false, error: `Room "${label}" not found` };
  const result = { label, bounds, props: [], fills: [], doors: [], textures: [] };
  const gs = state.dungeon.metadata?.gridSize || 5;
  for (let r = bounds.r1; r <= bounds.r2; r++) {
    for (let c = bounds.c1; c <= bounds.c2; c++) {
      const cell = state.dungeon.cells[r]?.[c];
      if (!cell) continue;
      if (cell.fill) result.fills.push({ row: r, col: c, type: cell.fill, depth: cell.fillDepth ?? 1 });
      if (cell.texture) result.textures.push({ row: r, col: c, id: cell.texture, opacity: cell.textureOpacity ?? 1 });
      for (const dir of ['north', 'south', 'east', 'west']) {
        if (cell[dir] === 'd' || cell[dir] === 's')
          result.doors.push({ row: r, col: c, direction: dir, type: cell[dir] });
      }
    }
  }
  // Collect props from metadata.props[] that fall within room bounds
  if (state.dungeon.metadata?.props) {
    for (const op of state.dungeon.metadata.props) {
      const propRow = Math.round(op.y / gs);
      const propCol = Math.round(op.x / gs);
      if (propRow >= bounds.r1 && propRow <= bounds.r2 && propCol >= bounds.c1 && propCol <= bounds.c2) {
        result.props.push({ row: propRow, col: propCol, type: op.type, facing: op.rotation ?? 0 });
      }
    }
  }
  return result;
}

/**
 * Find a free rectangular area of the given size, optionally adjacent to an existing room.
 * Returns { r1, c1, r2, c2 } of the suggested placement, or { error } if no space found.
 */
export function suggestPlacement(rows, cols, adjacentTo = null) {
  const info = getApi().getMapInfo();
  if (!info) return { success: false, error: 'Map not available' };
  const { rows: gridRows, cols: gridCols } = info;
  const margin = 1;

  const isFree = (r1, c1, r2, c2) => {
    if (r1 < margin || c1 < margin) return false;
    if (r2 > gridRows - 1 - margin || c2 > gridCols - 1 - margin) return false;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell !== null && cell !== undefined) return false;
      }
    }
    return true;
  };

  // Try positions adjacent to a reference room first
  if (adjacentTo) {
    const b = getApi().getRoomBounds(adjacentTo);
    if (b) {
      const hc = b.centerCol - Math.floor(cols / 2);
      const hr = b.centerRow - Math.floor(rows / 2);
      for (const [r, c] of [
        [b.r2 + 2, hc],           // south
        [b.r1 - rows - 1, hc],    // north
        [hr, b.c2 + 2],            // east
        [hr, b.c1 - cols - 1],     // west
      ]) {
        if (isFree(r, c, r + rows - 1, c + cols - 1))
          return { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 };
      }
    }
  }

  // Systematic left-to-right, top-to-bottom scan
  for (let r = margin; r <= gridRows - rows - margin; r++) {
    for (let c = margin; c <= gridCols - cols - margin; c++) {
      if (isFree(r, c, r + rows - 1, c + cols - 1))
        return { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 };
    }
  }
  return { success: false, error: `No space found for a ${rows}×${cols} room. Map may be full.` };
}

// ── Catalog queries ──────────────────────────────────────────────────────

export function listTextures() {
  const catalog = getTextureCatalog();
  if (!catalog) return { success: true, textures: [] };
  return {
    success: true,
    textures: Object.values(catalog.textures).map(t => ({
      id: t.id,
      displayName: t.displayName,
      category: t.category,
    })),
  };
}

/** Return all available theme names. */
export function listThemes() {
  const catalog = getThemeCatalog();
  if (!catalog) return { success: true, themes: [] };
  return { success: true, themes: catalog.names };
}

// ── Room queries ─────────────────────────────────────────────────────────

/** Return all labeled rooms with bounding boxes and centers. */
export function listRooms() {
  const cells = state.dungeon.cells;
  const labels = new Map();
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const lbl = cells[r]?.[c]?.center?.label;
      if (lbl) labels.set(lbl, { row: r, col: c });
    }
  }
  const rooms = [];
  for (const [label] of labels) {
    const roomCells = getApi()._collectRoomCells(label);
    const b = roomBoundsFromKeys(roomCells);
    if (b) rooms.push({ label, r1: b.r1, c1: b.c1, r2: b.r2, c2: b.c2, center: { row: b.centerRow, col: b.centerCol } });
  }
  rooms.sort((a, b) => a.label.localeCompare(b.label));
  return { success: true, rooms };
}

/** Return all floor cells belonging to a labeled room as sorted [[row, col], ...]. */
export function listRoomCells(label) {
  const roomCells = getApi()._collectRoomCells(label);
  if (!roomCells.size) return { success: false, error: `Room "${label}" not found or empty` };
  const cells = [];
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    cells.push([r, c]);
  }
  cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { success: true, cells };
}

/**
 * Return the cells a prop occupies relative to its anchor at [0,0] for a given facing.
 * Footprint is R×C (rows × cols). At 90°/270° the dimensions swap.
 * Returns { success, spanRows, spanCols, cells: [[dr, dc], ...] }.
 */
export function getPropFootprint(propType, facing = 0) {
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    return { success: false, error: `Unknown prop type: ${propType}` };
  }
  if (![0, 90, 180, 270].includes(facing)) {
    return { success: false, error: `Invalid facing: ${facing}. Use 0, 90, 180, or 270.` };
  }
  const def = catalog.props[propType];
  const [spanRows, spanCols] = (facing === 90 || facing === 270)
    ? [def.footprint[1], def.footprint[0]]
    : [...def.footprint];
  const cells = [];
  for (let r = 0; r < spanRows; r++) {
    for (let c = 0; c < spanCols; c++) cells.push([r, c]);
  }
  return { success: true, spanRows, spanCols, cells };
}

/**
 * Return all valid anchor positions where propType can be placed in a labeled room.
 * Checks that the full footprint fits within the room and doesn't overlap existing props.
 * Returns { success, positions: [[row, col], ...] }.
 */
export function getValidPropPositions(label, propType, facing = 0) {
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    throw new Error(`Unknown prop type: ${propType}. Available: ${Object.keys(catalog?.props || {}).join(', ')}`);
  }
  if (![0, 90, 180, 270].includes(facing)) {
    throw new Error(`Invalid facing: ${facing}. Use 0, 90, 180, or 270.`);
  }

  const def = catalog.props[propType];
  const [spanRows, spanCols] = (facing === 90 || facing === 270)
    ? [def.footprint[1], def.footprint[0]]
    : [...def.footprint];

  const roomCellSet = getApi()._collectRoomCells(label);
  if (!roomCellSet.size) return { success: false, error: `Room "${label}" not found` };

  const cells = state.dungeon.cells;
  const searchRadius = 4;

  // Helper: is cell (r, c) covered by any existing prop?
  const isCovered = (r, c) => {
    if (cells[r]?.[c]?.prop) return true;
    for (let pr = Math.max(0, r - searchRadius); pr <= r; pr++) {
      for (let pc = Math.max(0, c - searchRadius); pc <= c; pc++) {
        const existing = cells[pr]?.[pc]?.prop;
        if (existing && pr + existing.span[0] > r && pc + existing.span[1] > c) return true;
      }
    }
    return false;
  };

  const positions = [];
  for (const key of roomCellSet) {
    const [r, c] = parseCellKey(key);
    let valid = true;
    outer:
    for (let dr = 0; dr < spanRows; dr++) {
      for (let dc = 0; dc < spanCols; dc++) {
        if (!roomCellSet.has(cellKey(r + dr, c + dc))) { valid = false; break outer; }
        if (isCovered(r + dr, c + dc)) { valid = false; break outer; }
      }
    }
    if (valid) positions.push([r, c]);
  }

  positions.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { success: true, positions };
}
