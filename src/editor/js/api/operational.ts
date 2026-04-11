// operational.js — Operational, visualization, and AI helper methods.

import {
  getApi,
  state,
  undoFn,
  redoFn,
  requestRender,
  getThemeCatalog,
  getTextureCatalog,
  collectTextureIds,
  ensureTexturesLoaded,
  reloadAssets,
  calculateCanvasSize,
  renderDungeonToCanvas,
  cellKey,
  parseCellKey,
  roomBoundsFromKeys,
  toInt,
  toDisp,
  getContentVersion,
  getGeometryVersion,
  getLightingVersion,
  getPropsVersion,
  getDirtyRegion,
  renderTimings,
} from './_shared.js';

// ── Undo / Redo ──────────────────────────────────────────────────────────

/**
 * Undo the last action.
 * @returns {{ success: boolean }}
 */
export function undo(): { success: true } {
  undoFn();
  requestRender();
  return { success: true };
}

/**
 * Redo the last undone action.
 * @returns {{ success: boolean }}
 */
export function redo(): { success: true } {
  redoFn();
  requestRender();
  return { success: true };
}

// ── Visualization ────────────────────────────────────────────────────────

/**
 * Ensure all textures used in the current map have their images loaded,
 * then wait for them to finish. Call before getScreenshot() to guarantee
 * textures are rendered.
 * @param {number} [timeoutMs=8000] - Maximum wait time in milliseconds
 * @returns {Promise<{ success: boolean, count: number }>}
 */
export async function waitForTextures(timeoutMs: number = 8000): Promise<{ success: true; count: number }> {
  if (!state.textureCatalog?.textures) return { success: true, count: 0 };

  // Trigger loading for any map-used textures that haven't started yet
  const usedIds = collectTextureIds(state.dungeon.cells);

  // Also include textures referenced by overlay props
  if (state.propCatalog?.props && state.dungeon.metadata.props) {
    for (const op of state.dungeon.metadata.props) {
      const propDef = state.propCatalog.props[op.type];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
      if (propDef?.textures) {
        for (const id of propDef.textures) usedIds.add(id);
      }
    }
  }

  await ensureTexturesLoaded(usedIds);

  // Wait for all in-flight images (map-used + any previously triggered)
  const entries = Object.values(state.textureCatalog.textures);
  const pending = entries.filter(
    (e) => (e as { img?: HTMLImageElement }).img && !(e as { img?: HTMLImageElement }).img!.complete,
  );
  if (!pending.length) {
    requestRender();
    return { success: true, count: entries.length };
  }

  const deadline = Date.now() + timeoutMs;
  await Promise.all(
    pending.map(
      (e) =>
        new Promise<void>((resolve) => {
          const img = (e as { img?: HTMLImageElement }).img!;
          if (img.complete) return resolve();
          const done = () => {
            img.removeEventListener('load', done);
            img.removeEventListener('error', done);
            resolve();
          };
          img.addEventListener('load', done);
          img.addEventListener('error', done);
          const check = () => {
            if (img.complete || Date.now() >= deadline) resolve();
            else setTimeout(check, 100);
          };
          check();
        }),
    ),
  );

  requestRender();
  return { success: true, count: entries.length };
}

/**
 * Capture the current editor canvas as a PNG data URL.
 * @returns {Promise<string>} Base64 PNG data URL
 */
export async function getScreenshot(): Promise<string> {
  // Ensure map-used textures are loaded before capturing
  await getApi().waitForTextures();
  requestRender();
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const canvas = document.getElementById('editor-canvas')!;
      resolve((canvas as HTMLCanvasElement).toDataURL('image/png'));
    });
  });
}

/**
 * Export the map as a PNG using the compile pipeline (HQ lighting).
 * @returns {Promise<string>} Base64 PNG data URL
 */
export async function exportPng(): Promise<string> {
  await getApi().waitForTextures();
  const config = state.dungeon;
  const { width, height } = calculateCanvasSize(config);
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d');
  renderDungeonToCanvas(ctx!, config, width, height, state.propCatalog, state.textureCatalog);
  return offscreen.toDataURL('image/png');
}

/**
 * Clear all caches (props, textures, themes, lights) and reload from server.
 * @returns {Promise<{ success: boolean }>}
 */
export async function clearCaches(): Promise<{ success: true }> {
  await reloadAssets();
  return { success: true };
}

/**
 * Trigger a canvas re-render.
 * @returns {{ success: boolean }}
 */
export function render(): { success: true } {
  requestRender();
  return { success: true };
}

/**
 * Wait for the editor to be fully initialized: all catalogs loaded,
 * canvas ready, and textures resolved. Useful as a first command in
 * Puppeteer scripts to ensure the editor is ready before interacting.
 * @param {number} [timeoutMs=15000] - Maximum wait time in milliseconds
 * @returns {Promise<{ success: boolean }>}
 */
export async function waitForEditor(timeoutMs: number = 15000): Promise<{ success: true }> {
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() >= deadline) return reject(new Error('waitForEditor timed out'));
      const ready = !!(document.getElementById('editor-canvas') && getThemeCatalog() !== null && state.propCatalog);
      if (ready) return resolve(undefined);
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
 * @param {string} code - JavaScript code to evaluate
 * @returns {Promise<{ success: boolean, result?: * }>}
 */
export async function eval_(
  code: string,
): Promise<{ success: boolean; result?: string | number | boolean | Record<string, unknown> | null }> {
  const fn = new Function('state', 'editorAPI', `return (async () => { ${code} })();`);
  const result = await fn(state, (window as unknown as Record<string, unknown>).editorAPI);
  if (result === undefined || result === null) return { success: true };
  if (typeof result === 'object' && result.success !== undefined) return result;
  return { success: true, result };
}

// ── Claude AI helpers ────────────────────────────────────────────────────

/**
 * Return current undo stack depth. Used by Claude chat to support "undo all" after a build.
 * @returns {{ success: boolean, depth: number }}
 */
export function getUndoDepth(): { success: true; depth: number } {
  return { success: true, depth: state.undoStack.length };
}

/**
 * Undo back to a previously recorded depth, reversing all changes made since then.
 * @param {number} targetDepth - Target undo stack depth
 * @returns {{ success: boolean, undid: number }}
 */
export function undoToDepth(targetDepth: number): { success: true; undid: number } {
  const depth = Math.max(0, targetDepth);
  let count = 0;
  while (state.undoStack.length > depth) {
    undoFn();
    count++;
  }
  return { success: true, undid: count };
}

/**
 * Return the contents of a labeled room: props, fills, doors, textures.
 * @param {string} label - Room label
 * @returns {{ label: string, bounds: Object, props: Array, fills: Array, doors: Array, textures: Array }}
 */
export function getRoomContents(label: string): {
  success?: boolean;
  error?: string;
  label?: string;
  bounds?: { r1: number; c1: number; r2: number; c2: number };
  props: { row: number; col: number; type: string; facing: number }[];
  fills: { row: number; col: number; type: string; depth: number }[];
  doors: { row: number; col: number; direction: string; type: string }[];
  textures: { row: number; col: number; id: string; opacity: number }[];
} {
  const boundsResult = getApi().getRoomBounds(label);
  if (!boundsResult.success)
    return { success: false, error: `Room "${label}" not found`, props: [], fills: [], doors: [], textures: [] };
  const bounds = boundsResult;
  const result: {
    label: string;
    bounds: typeof bounds;
    props: { row: number; col: number; type: string; facing: number }[];
    fills: { row: number; col: number; type: string; depth: number }[];
    doors: { row: number; col: number; direction: string; type: string }[];
    textures: { row: number; col: number; id: string; opacity: number }[];
  } = { label, bounds, props: [], fills: [], doors: [], textures: [] };
  const gs = state.dungeon.metadata.gridSize || 5;
  // Convert display bounds to internal for iteration
  const ir1 = toInt(bounds.r1),
    ic1 = toInt(bounds.c1);
  const ir2 = toInt(bounds.r2),
    ic2 = toInt(bounds.c2);
  for (let r = ir1; r <= ir2; r++) {
    for (let c = ic1; c <= ic2; c++) {
      const cell = state.dungeon.cells[r]?.[c];
      if (!cell) continue;
      if (cell.fill)
        result.fills.push({ row: toDisp(r), col: toDisp(c), type: cell.fill as string, depth: cell.fillDepth ?? 1 });
      if (cell.texture)
        result.textures.push({ row: toDisp(r), col: toDisp(c), id: cell.texture, opacity: cell.textureOpacity ?? 1 });
      for (const dir of ['north', 'south', 'east', 'west']) {
        if ((cell as Record<string, unknown>)[dir] === 'd' || (cell as Record<string, unknown>)[dir] === 's')
          result.doors.push({
            row: toDisp(r),
            col: toDisp(c),
            direction: dir,
            type: (cell as Record<string, unknown>)[dir] as string,
          });
      }
    }
  }
  // Collect props from metadata.props[] that fall within room bounds
  if (state.dungeon.metadata.props) {
    for (const op of state.dungeon.metadata.props) {
      const propRow = Math.round(op.y / gs);
      const propCol = Math.round(op.x / gs);
      if (propRow >= ir1 && propRow <= ir2 && propCol >= ic1 && propCol <= ic2) {
        result.props.push({ row: toDisp(propRow), col: toDisp(propCol), type: op.type, facing: op.rotation });
      }
    }
  }
  return result;
}

/**
 * Find a free rectangular area of the given size, optionally adjacent to an existing room.
 * @param {number} rows - Desired room height in cells
 * @param {number} cols - Desired room width in cells
 * @param {string|null} [adjacentTo=null] - Room label to try placing adjacent to
 * @returns {{ r1: number, c1: number, r2: number, c2: number } | { success: boolean, error: string }}
 */
export function suggestPlacement(
  rows: number,
  cols: number,
  adjacentTo: string | null = null,
): { success?: boolean; error?: string; r1?: number; c1?: number; r2?: number; c2?: number } {
  const info = getApi().getMapInfo();
  if (!info) return { success: false, error: 'Map not available' };
  const { rows: gridRows, cols: gridCols } = info;
  const margin = 1;

  const isFree = (r1: number, c1: number, r2: number, c2: number) => {
    if (r1 < margin || c1 < margin) return false;
    if (r2 > gridRows - 1 - margin || c2 > gridCols - 1 - margin) return false;
    // Convert display coords to internal for cell access
    const ir1 = toInt(r1),
      ic1 = toInt(c1),
      ir2 = toInt(r2),
      ic2 = toInt(c2);
    for (let r = ir1; r <= ir2; r++) {
      for (let c = ic1; c <= ic2; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell !== null) return false;
      }
    }
    return true;
  };

  // Try positions adjacent to a reference room first
  if (adjacentTo) {
    const bResult = getApi().getRoomBounds(adjacentTo);
    if (bResult.success) {
      const b = bResult;
      const hc = b.centerCol - Math.floor(cols / 2);
      const hr = b.centerRow - Math.floor(rows / 2);
      for (const [r, c] of [
        [b.r2 + 2, hc], // south
        [b.r1 - rows - 1, hc], // north
        [hr, b.c2 + 2], // east
        [hr, b.c1 - cols - 1], // west
      ]) {
        if (isFree(r, c, r + rows - 1, c + cols - 1)) return { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 };
      }
    }
  }

  // Systematic left-to-right, top-to-bottom scan
  for (let r = margin; r <= gridRows - rows - margin; r++) {
    for (let c = margin; c <= gridCols - cols - margin; c++) {
      if (isFree(r, c, r + rows - 1, c + cols - 1)) return { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 };
    }
  }
  return { success: false, error: `No space found for a ${rows}×${cols} room. Map may be full.` };
}

// ── Catalog queries ──────────────────────────────────────────────────────

/**
 * List all available floor textures from the catalog.
 * @returns {{ success: boolean, textures: Array<{ id: string, displayName: string, category: string }> }}
 */
export function listTextures(): {
  success: true;
  textures: Array<{ id: string; displayName: string; category: string }>;
} {
  const catalog = getTextureCatalog();
  if (!catalog) return { success: true, textures: [] };
  return {
    success: true,
    textures: Object.values(catalog.textures)
      .filter((t) => t != null)
      .map((t) => ({
        id: (t as Record<string, unknown>).id as string,
        displayName: t.displayName ?? '',
        category: (t as Record<string, unknown>).category as string,
      })),
  };
}

/**
 * Return all available theme names.
 * @returns {{ success: boolean, themes: Array<string> }}
 */
export function listThemes(): { success: true; themes: string[] } {
  const catalog = getThemeCatalog();
  if (!catalog) return { success: true, themes: [] };
  return { success: true, themes: catalog.names };
}

// ── Room queries ─────────────────────────────────────────────────────────

/**
 * Return all labeled rooms with bounding boxes and centers.
 * @returns {{ success: boolean, rooms: Array<Object> }}
 */
export function listRooms(): {
  success: true;
  rooms: { label: string; r1: number; c1: number; r2: number; c2: number; center: { row: number; col: number } }[];
} {
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
    if (!roomCells) continue;
    const b = roomBoundsFromKeys(roomCells);
    if (b)
      rooms.push({
        label,
        r1: toDisp(b.r1),
        c1: toDisp(b.c1),
        r2: toDisp(b.r2),
        c2: toDisp(b.c2),
        center: { row: toDisp(b.centerRow), col: toDisp(b.centerCol) },
      });
  }
  rooms.sort((a, b) => a.label.localeCompare(b.label));
  return { success: true, rooms };
}

/** Return all floor cells belonging to a labeled room as sorted [[row, col], ...]. */
/**
 * Return all floor cells belonging to a labeled room as sorted [[row, col], ...].
 * @param {string} label - Room label (e.g. "A1")
 * @returns {{ success: boolean, cells: Array<[number, number]> }}
 */
export function listRoomCells(label: string): { success: boolean; cells?: [number, number][]; error?: string } {
  const roomCells = getApi()._collectRoomCells(label);
  if (!roomCells?.size) return { success: false, error: `Room "${label}" not found or empty` };
  const cellList: [number, number][] = [];
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    cellList.push([toDisp(r), toDisp(c)]);
  }
  cellList.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { success: true, cells: cellList };
}

/**
 * Return the cells a prop occupies relative to its anchor at [0,0] for a given facing.
 * Footprint is R×C (rows × cols). At 90°/270° the dimensions swap.
 * Returns { success, spanRows, spanCols, cells: [[dr, dc], ...] }.
 */
export function getPropFootprint(
  propType: string,
  facing: number = 0,
): { success: boolean; spanRows?: number; spanCols?: number; cells?: [number, number][]; error?: string } {
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    return { success: false, error: `Unknown prop type: ${propType}` };
  }
  if (![0, 90, 180, 270].includes(facing)) {
    return { success: false, error: `Invalid facing: ${facing}. Use 0, 90, 180, or 270.` };
  }
  const def = catalog.props[propType];
  const [spanRows, spanCols] =
    facing === 90 || facing === 270 ? [def.footprint[1], def.footprint[0]] : [...def.footprint];
  const cells: [number, number][] = [];
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
export function getValidPropPositions(
  label: string,
  propType: string,
  facing: number = 0,
): { success: boolean; positions?: [number, number][]; error?: string } {
  const catalog = state.propCatalog;
  if (!catalog?.props[propType]) {
    throw new Error(`Unknown prop type: ${propType}. Available: ${Object.keys(catalog?.props ?? {}).join(', ')}`);
  }
  if (![0, 90, 180, 270].includes(facing)) {
    throw new Error(`Invalid facing: ${facing}. Use 0, 90, 180, or 270.`);
  }

  const def = catalog.props[propType];
  const [spanRows, spanCols] =
    facing === 90 || facing === 270 ? [def.footprint[1], def.footprint[0]] : [...def.footprint];

  const roomCellSet = getApi()._collectRoomCells(label);
  if (!roomCellSet?.size) return { success: false, error: `Room "${label}" not found` };

  const cells = state.dungeon.cells;
  const searchRadius = 4;

  // Helper: is cell (r, c) covered by any existing prop?
  const isCovered = (r: number, c: number) => {
    if (cells[r]?.[c]?.prop) return true;
    for (let pr = Math.max(0, r - searchRadius); pr <= r; pr++) {
      for (let pc = Math.max(0, c - searchRadius); pc <= c; pc++) {
        const existing = cells[pr]?.[pc]?.prop;
        if (existing && pr + existing.span[0] > r && pc + existing.span[1] > c) return true;
      }
    }
    return false;
  };

  const positions: [number, number][] = [];
  for (const key of roomCellSet) {
    const [r, c] = parseCellKey(key);
    let valid = true;
    outer: for (let dr = 0; dr < spanRows; dr++) {
      for (let dc = 0; dc < spanCols; dc++) {
        if (!roomCellSet.has(cellKey(r + dr, c + dc))) {
          valid = false;
          break outer;
        }
        if (isCovered(r + dr, c + dc)) {
          valid = false;
          break outer;
        }
      }
    }
    if (valid) positions.push([toDisp(r), toDisp(c)]);
  }

  positions.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { success: true, positions };
}

// ── Render Diagnostics ──────────────────────────────────────────────────

/**
 * Aggregate current render state into a diagnostic summary.
 * Useful for debugging render pipeline stalls and cache invalidation.
 * @returns Render version counters, dirty region, and per-phase timings.
 */
export function getRenderDiagnostics(): {
  success: true;
  contentVersion: number;
  geometryVersion: number;
  lightingVersion: number;
  propsVersion: number;
  dirtyRegion: { minRow: number; maxRow: number; minCol: number; maxCol: number } | null;
  timings: Record<string, number>;
} {
  const dirty = getDirtyRegion();
  const timings: Record<string, number> = {};
  for (const [key, entry] of Object.entries(renderTimings)) {
    timings[key] = entry.ms;
  }
  return {
    success: true,
    contentVersion: getContentVersion(),
    geometryVersion: getGeometryVersion(),
    lightingVersion: getLightingVersion(),
    propsVersion: getPropsVersion(),
    dirtyRegion: dirty
      ? { minRow: dirty.minRow, maxRow: dirty.maxRow, minCol: dirty.minCol, maxCol: dirty.maxCol }
      : null,
    timings,
  };
}

// ── State Digest ────────────────────────────────────────────────────────

/**
 * Return a lightweight summary of the current editor state.
 * Useful for verifying state after a batch of commands without serializing the full dungeon.
 */
export function getStateDigest(): {
  success: true;
  rooms: number;
  totalCells: number;
  props: number;
  lights: number;
  stairs: number;
  bridges: number;
  currentLevel: number;
  levels: number;
  undoDepth: number;
  dirty: boolean;
  unsavedChanges: boolean;
} {
  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;
  let totalCells = 0;
  const roomLabels = new Set<string>();

  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (cell !== null) {
        totalCells++;
        if (cell.center?.label) roomLabels.add(cell.center.label);
      }
    }
  }

  return {
    success: true,
    rooms: roomLabels.size,
    totalCells,
    props: meta.props?.length ?? 0,
    lights: meta.lights.length,
    stairs: meta.stairs.length,
    bridges: meta.bridges.length,
    currentLevel: state.currentLevel,
    levels: meta.levels.length,
    undoDepth: state.undoStack.length,
    dirty: state.dirty,
    unsavedChanges: state.unsavedChanges,
  };
}
