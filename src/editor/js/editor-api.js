// Editor Automation API
// Loaded conditionally when ?api query param is present.
// Exposes window.editorAPI for programmatic control via Puppeteer.

import state, { pushUndo, markDirty, notify, undo, redo, invalidateLightmap } from './state.js';
import { createEmptyDungeon } from './utils.js';
import { requestRender } from './canvas-view.js';
import { RoomTool, TrimTool, PaintTool } from './tools/index.js';
import { getThemeCatalog } from './theme-catalog.js';
import { collectTextureIds, ensureTexturesLoaded, loadTextureImages, getTextureCatalog } from './texture-catalog.js';
import { getLightCatalog } from './light-catalog.js';
import { reloadAssets, migrateHalfTextures } from './io.js';
import { classifyStairShape, isDegenerate, getOccupiedCells } from './stair-geometry.js';
import { isBridgeDegenerate, getBridgeOccupiedCells } from './bridge-geometry.js';
import { calculateCanvasSize, renderDungeonToCanvas, invalidateAllCaches } from '../../render/index.js';
import { OPPOSITE, cellKey, parseCellKey, isInBounds, roomBoundsFromKeys, floodFillRoom } from '../../util/index.js';
import { exportDungeonToMapFormat } from './export-map.js';

const CARDINAL_DIRS = ['north', 'south', 'east', 'west'];
const ALL_DIRS = ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw'];
const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };

// Private tool instances for reusing internal logic
const roomTool = new RoomTool();
const trimTool = new TrimTool();
const paintTool = new PaintTool();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateBounds(row, col) {
  const cells = state.dungeon.cells;
  if (!isInBounds(cells, row, col)) {
    throw new Error(`Cell (${row}, ${col}) out of bounds (${cells.length} rows, ${cells[0]?.length || 0} cols)`);
  }
}

function ensureCell(row, col) {
  validateBounds(row, col);
  if (!state.dungeon.cells[row][col]) {
    state.dungeon.cells[row][col] = {};
  }
  return state.dungeon.cells[row][col];
}

function setReciprocal(row, col, direction, value) {
  if (!OPPOSITE[direction]) return;
  const [dr, dc] = OFFSETS[direction];
  const nr = row + dr, nc = col + dc;
  const cells = state.dungeon.cells;
  if (nr < 0 || nr >= cells.length || nc < 0 || nc >= (cells[0]?.length || 0)) return;
  if (!cells[nr][nc]) cells[nr][nc] = {};
  if (value === null) {
    delete cells[nr][nc][OPPOSITE[direction]];
  } else {
    cells[nr][nc][OPPOSITE[direction]] = value;
  }
}

function deleteReciprocal(row, col, direction) {
  setReciprocal(row, col, direction, null);
}

// ─── API ──────────────────────────────────────────────────────────────────────

const api = {

  // ── Map Management ────────────────────────────────────────────────────────

  newMap(name, rows, cols, gridSize = 5, theme = 'stone-dungeon') {
    pushUndo();
    state.dungeon = createEmptyDungeon(name, rows, cols, gridSize, theme);
    state.currentLevel = 0;
    state.selectedCells = [];
    markDirty();
    notify();
    return { success: true };
  },

  loadMap(json) {
    if (typeof json === 'string') json = JSON.parse(json);
    if (!json.metadata || !json.cells) {
      throw new Error('Invalid dungeon JSON: missing metadata or cells');
    }
    pushUndo();
    state.dungeon = json;
    migrateHalfTextures(json);
    state.currentLevel = 0;
    state.selectedCells = [];
    markDirty();
    notify();

    // Load images for textures used in the map
    const usedIds = collectTextureIds(json.cells);
    if (usedIds.size > 0) {
      ensureTexturesLoaded(usedIds).then(() => { requestRender(); });
    }

    return { success: true };
  },

  getMap() {
    return JSON.parse(JSON.stringify(state.dungeon));
  },

  getMapInfo() {
    const meta = state.dungeon.metadata;
    const cells = state.dungeon.cells;

    let propCount = 0, labelCount = 0;
    const textureIds = new Set();
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        const cell = cells[r]?.[c];
        if (!cell) continue;
        if (cell.prop) propCount++;
        if (cell.center?.label != null) labelCount++;
        if (cell.texture?.id) textureIds.add(cell.texture.id);
      }
    }

    return {
      name: meta.dungeonName,
      rows: cells.length,
      cols: cells[0]?.length || 0,
      gridSize: meta.gridSize,
      theme: typeof meta.theme === 'string' ? meta.theme : 'custom',
      labelStyle: meta.labelStyle || 'circled',
      features: { ...meta.features },
      levels: meta.levels ? [...meta.levels] : [],
      propCount,
      labelCount,
      textureIds: [...textureIds],
      lightCount: meta.lights?.length || 0,
      lightingEnabled: !!meta.lightingEnabled,
    };
  },

  setName(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('Name must be a non-empty string');
    }
    pushUndo();
    state.dungeon.metadata.dungeonName = name.trim();
    markDirty();
    notify();
    return { success: true };
  },

  setTheme(theme) {
    if (!theme || typeof theme !== 'string') {
      throw new Error('Theme must be a non-empty string');
    }
    pushUndo();
    state.dungeon.metadata.theme = theme;
    markDirty();
    notify();
    return { success: true };
  },

  setLabelStyle(style) {
    if (!['circled', 'plain', 'bold'].includes(style)) {
      throw new Error(`Invalid label style: ${style}. Use 'circled', 'plain', or 'bold'.`);
    }
    pushUndo();
    state.dungeon.metadata.labelStyle = style;
    markDirty();
    notify();
    return { success: true };
  },

  setFeature(feature, enabled) {
    const validFeatures = ['grid', 'compass', 'scale', 'border'];
    if (!validFeatures.includes(feature)) {
      throw new Error(`Invalid feature: ${feature}. Use: ${validFeatures.join(', ')}`);
    }
    pushUndo();
    if (!state.dungeon.metadata.features) state.dungeon.metadata.features = {};
    state.dungeon.metadata.features[feature] = !!enabled;
    markDirty();
    notify();
    return { success: true };
  },

  // ── Cell Operations ───────────────────────────────────────────────────────

  getCellInfo(row, col) {
    validateBounds(row, col);
    const cell = state.dungeon.cells[row][col];
    return cell ? JSON.parse(JSON.stringify(cell)) : null;
  },

  paintCell(row, col) {
    validateBounds(row, col);
    if (state.dungeon.cells[row][col] !== null) return { success: true };
    pushUndo();
    state.dungeon.cells[row][col] = {};
    markDirty();
    notify();
    return { success: true };
  },

  paintRect(r1, c1, r2, c2) {
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    validateBounds(minR, minC);
    validateBounds(maxR, maxC);
    pushUndo();
    const cells = state.dungeon.cells;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (cells[r][c] === null) cells[r][c] = {};
      }
    }
    markDirty();
    notify();
    return { success: true };
  },

  eraseCell(row, col) {
    validateBounds(row, col);
    if (state.dungeon.cells[row][col] === null) return { success: true };
    pushUndo();
    state.dungeon.cells[row][col] = null;
    markDirty();
    notify();
    return { success: true };
  },

  eraseRect(r1, c1, r2, c2) {
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    validateBounds(minR, minC);
    validateBounds(maxR, maxC);
    pushUndo();
    const cells = state.dungeon.cells;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        cells[r][c] = null;
      }
    }
    markDirty();
    notify();
    return { success: true };
  },

  // ── Room Creation (reuses RoomTool._applyWalls) ───────────────────────────

  createRoom(r1, c1, r2, c2, mode = 'room') {
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    validateBounds(minR, minC);
    validateBounds(maxR, maxC);

    if (mode !== 'room' && mode !== 'merge') {
      throw new Error(`Invalid room mode: ${mode}. Use 'room' or 'merge'.`);
    }

    // Build selection set
    const selection = new Set();
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        selection.add(cellKey(r, c));
      }
    }

    // Temporarily set room mode and invoke _applyWalls
    const prevMode = state.roomMode;
    state.roomMode = mode;
    roomTool.dragStart = { row: minR, col: minC };
    roomTool.dragEnd = { row: maxR, col: maxC };
    roomTool._applyWalls();
    roomTool.dragStart = null;
    roomTool.dragEnd = null;
    state.roomMode = prevMode;

    // _applyWalls calls pushUndo and markDirty internally
    notify();
    return { success: true };
  },

  // ── Wall Operations ───────────────────────────────────────────────────────

  setWall(row, col, direction) {
    if (!ALL_DIRS.includes(direction)) {
      throw new Error(`Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`);
    }
    const cell = ensureCell(row, col);
    pushUndo();
    cell[direction] = 'w';
    if (OPPOSITE[direction]) {
      setReciprocal(row, col, direction, 'w');
    }
    markDirty();
    notify();
    return { success: true };
  },

  removeWall(row, col, direction) {
    if (!ALL_DIRS.includes(direction)) {
      throw new Error(`Invalid direction: ${direction}. Use: ${ALL_DIRS.join(', ')}`);
    }
    validateBounds(row, col);
    const cell = state.dungeon.cells[row][col];
    if (!cell) return { success: true };
    pushUndo();
    delete cell[direction];
    if (OPPOSITE[direction]) {
      deleteReciprocal(row, col, direction);
    }
    markDirty();
    notify();
    return { success: true };
  },

  // ── Door Operations ───────────────────────────────────────────────────────

  setDoor(row, col, direction, type = 'd') {
    if (!CARDINAL_DIRS.includes(direction)) {
      throw new Error(`Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`);
    }
    if (type !== 'd' && type !== 's') {
      throw new Error(`Invalid door type: ${type}. Use 'd' (normal) or 's' (secret).`);
    }
    const cell = ensureCell(row, col);
    pushUndo();
    cell[direction] = type;
    setReciprocal(row, col, direction, type);
    markDirty();
    notify();
    return { success: true };
  },

  removeDoor(row, col, direction) {
    if (!CARDINAL_DIRS.includes(direction)) {
      throw new Error(`Invalid direction for door: ${direction}. Use: ${CARDINAL_DIRS.join(', ')}`);
    }
    validateBounds(row, col);
    const cell = state.dungeon.cells[row][col];
    if (!cell) return { success: true };
    pushUndo();
    // Revert to wall
    cell[direction] = 'w';
    setReciprocal(row, col, direction, 'w');
    markDirty();
    notify();
    return { success: true };
  },

  // ── Label Operations ──────────────────────────────────────────────────────

  setLabel(row, col, text) {
    const cell = ensureCell(row, col);
    pushUndo();
    if (!cell.center) cell.center = {};
    cell.center.label = String(text);
    markDirty();
    notify();
    return { success: true };
  },

  removeLabel(row, col) {
    validateBounds(row, col);
    const cell = state.dungeon.cells[row][col];
    if (!cell?.center?.label) return { success: true };
    pushUndo();
    delete cell.center.label;
    if (Object.keys(cell.center).length === 0) delete cell.center;
    markDirty();
    notify();
    return { success: true };
  },

  // ── Stairs Operations ─────────────────────────────────────────────────────

  /**
   * Legacy stair placement. Creates a 1×1 rectangle stair via addStairs().
   * @param {number} row - Cell row
   * @param {number} col - Cell col
   * @param {string} direction - 'up' or 'down' (ignored in new format, kept for compatibility)
   */
  setStairs(row, col, direction) {
    // Legacy compatibility: create a 1x1 rectangle
    if (direction === 'up' || direction === 'down') {
      return this.addStairs(row, col, row, col + 1, row + 1, col + 1);
    }
    throw new Error(`Invalid stairs direction: ${direction}. Use 'up' or 'down' for legacy, or use addStairs().`);
  },

  /**
   * Place stairs defined by 3 corner points in grid-corner coordinates.
   * P1→P2 = base edge (hatch lines parallel to this). P3 = depth target.
   *
   * The hatch pattern is determined by P3's position relative to P2:
   * - P3 straight across from P2 (inward=0) → rectangle (parallel lines)
   * - P3 shifted inward along base → trapezoid (narrowLen = baseLen - 2*inward)
   * - P3 shifted ≥ baseLen/2 inward → triangle (converges to point)
   *
   * @param {number} p1r - P1 row (base start)
   * @param {number} p1c - P1 col
   * @param {number} p2r - P2 row (base end)
   * @param {number} p2c - P2 col
   * @param {number} p3r - P3 row (depth target)
   * @param {number} p3c - P3 col
   * @returns {{ success: boolean, id: number }}
   */
  addStairs(p1r, p1c, p2r, p2c, p3r, p3c) {
    const p1 = [p1r, p1c], p2 = [p2r, p2c], p3 = [p3r, p3c];
    if (isDegenerate(p1, p2, p3)) {
      throw new Error('Degenerate stair shape (zero area)');
    }
    const shape = classifyStairShape(p1, p2, p3);
    const occupied = getOccupiedCells(shape.vertices);
    if (occupied.length === 0) {
      throw new Error('No cells covered by this stair shape');
    }
    const cells = state.dungeon.cells;
    for (const { row, col } of occupied) {
      if (!isInBounds(cells, row, col)) {
        throw new Error(`Stair extends out of bounds at (${row}, ${col})`);
      }
      if (cells[row]?.[col]?.center?.['stair-id'] != null) {
        throw new Error(`Overlap: cell (${row}, ${col}) already has a stair`);
      }
    }

    pushUndo();
    const meta = state.dungeon.metadata;
    if (!meta.stairs) meta.stairs = [];
    if (meta.nextStairId == null) meta.nextStairId = 0;
    const id = meta.nextStairId++;
    meta.stairs.push({ id, points: [p1, p2, p3], link: null });

    for (const { row, col } of occupied) {
      if (!cells[row][col]) cells[row][col] = {};
      if (!cells[row][col].center) cells[row][col].center = {};
      cells[row][col].center['stair-id'] = id;
    }

    markDirty();
    notify();
    return { success: true, id };
  },

  /**
   * Remove stairs at cell (row, col). Removes the entire stair object the cell belongs to.
   */
  removeStairs(row, col) {
    validateBounds(row, col);
    const cell = state.dungeon.cells[row][col];
    const id = cell?.center?.['stair-id'];

    // Legacy fallback: old format
    if (id == null) {
      if (cell?.center?.['stairs-up'] || cell?.center?.['stairs-down']) {
        pushUndo();
        delete cell.center['stairs-up'];
        delete cell.center['stairs-down'];
        delete cell.center['stairs-link'];
        if (Object.keys(cell.center).length === 0) delete cell.center;
        markDirty();
        notify();
      }
      return { success: true };
    }

    pushUndo();
    const meta = state.dungeon.metadata;
    const stairs = meta?.stairs || [];
    const idx = stairs.findIndex(s => s.id === id);

    if (idx !== -1) {
      const stairDef = stairs[idx];
      // Unlink partner
      if (stairDef.link) {
        const partner = stairs.find(s => s.link === stairDef.link && s.id !== id);
        if (partner) partner.link = null;
      }
      stairs.splice(idx, 1);
    }

    // Clear all cell references
    const cells = state.dungeon.cells;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        if (cells[r]?.[c]?.center?.['stair-id'] === id) {
          delete cells[r][c].center['stair-id'];
          if (Object.keys(cells[r][c].center).length === 0) delete cells[r][c].center;
        }
      }
    }

    markDirty();
    notify();
    return { success: true };
  },

  /**
   * Link two stair objects. Specify any cell of each stair.
   */
  linkStairs(r1, c1, r2, c2) {
    validateBounds(r1, c1);
    validateBounds(r2, c2);
    const id1 = state.dungeon.cells[r1]?.[c1]?.center?.['stair-id'];
    const id2 = state.dungeon.cells[r2]?.[c2]?.center?.['stair-id'];
    if (id1 == null) throw new Error(`Cell (${r1}, ${c1}) has no stairs to link`);
    if (id2 == null) throw new Error(`Cell (${r2}, ${c2}) has no stairs to link`);
    if (id1 === id2) throw new Error('Cannot link a stair to itself');

    const stairs = state.dungeon.metadata?.stairs || [];
    const s1 = stairs.find(s => s.id === id1);
    const s2 = stairs.find(s => s.id === id2);
    if (!s1 || !s2) throw new Error('Stair definition not found in metadata');

    // Find next available label
    const used = new Set(stairs.map(s => s.link).filter(Boolean));
    let label = null;
    for (let i = 0; i < 26; i++) {
      const ch = String.fromCharCode(65 + i);
      if (!used.has(ch)) { label = ch; break; }
    }
    if (!label) throw new Error('No available link labels (A-Z exhausted)');

    pushUndo();
    // Remove old links
    if (s1.link) { const old = stairs.find(s => s.link === s1.link && s.id !== id1); if (old) old.link = null; }
    if (s2.link) { const old = stairs.find(s => s.link === s2.link && s.id !== id2); if (old) old.link = null; }
    s1.link = label;
    s2.link = label;

    markDirty();
    notify();
    return { success: true, label };
  },

  // ── Bridge Operations ────────────────────────────────────────────────────

  /**
   * Place a bridge defined by 3 corner points in grid-corner coordinates.
   * P1→P2 = entrance width. P3 = depth direction. Always rectangular.
   * @param {string} type - 'wood' | 'stone' | 'rope' | 'dock'
   * @param {number} p1r @param {number} p1c - P1 row, col
   * @param {number} p2r @param {number} p2c - P2 row, col
   * @param {number} p3r @param {number} p3c - P3 row, col
   * @returns {{ success: boolean, id: number }}
   */
  addBridge(type, p1r, p1c, p2r, p2c, p3r, p3c) {
    const VALID_TYPES = ['wood', 'stone', 'rope', 'dock'];
    if (!VALID_TYPES.includes(type)) throw new Error(`Invalid bridge type: ${type}`);

    const p1 = [p1r, p1c], p2 = [p2r, p2c], p3 = [p3r, p3c];
    if (isBridgeDegenerate(p1, p2, p3)) throw new Error('Degenerate bridge (zero depth)');

    const occupied = getBridgeOccupiedCells(p1, p2, p3);
    if (occupied.length === 0) throw new Error('Bridge covers no cells');

    const cells = state.dungeon.cells;
    const numRows = cells.length, numCols = cells[0]?.length || 0;
    for (const { row, col } of occupied) {
      if (row < 0 || row >= numRows || col < 0 || col >= numCols) {
        throw new Error(`Bridge extends out of bounds at (${row}, ${col})`);
      }
    }

    pushUndo();

    const meta = state.dungeon.metadata;
    if (!meta.bridges) meta.bridges = [];
    if (meta.nextBridgeId == null) meta.nextBridgeId = 0;

    const id = meta.nextBridgeId++;
    meta.bridges.push({ id, type, points: [p1, p2, p3] });

    for (const { row, col } of occupied) {
      if (!cells[row][col]) cells[row][col] = {};
      if (!cells[row][col].center) cells[row][col].center = {};
      cells[row][col].center['bridge-id'] = id;
    }

    markDirty();
    notify();
    return { success: true, id };
  },

  /**
   * Remove the bridge that covers cell (row, col).
   */
  removeBridge(row, col) {
    const cell = state.dungeon.cells[row]?.[col];
    const id = cell?.center?.['bridge-id'];
    if (id == null) throw new Error(`Cell (${row}, ${col}) has no bridge`);

    const meta = state.dungeon.metadata;
    const idx = (meta?.bridges || []).findIndex(b => b.id === id);
    if (idx === -1) throw new Error(`Bridge id ${id} not found in metadata`);

    pushUndo();
    meta.bridges.splice(idx, 1);

    const cells = state.dungeon.cells;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        if (cells[r]?.[c]?.center?.['bridge-id'] === id) {
          delete cells[r][c].center['bridge-id'];
          if (Object.keys(cells[r][c].center).length === 0) delete cells[r][c].center;
        }
      }
    }

    markDirty();
    notify();
    return { success: true };
  },

  /**
   * Get all bridge definitions from the current dungeon.
   * @returns {object[]}
   */
  getBridges() {
    return state.dungeon.metadata?.bridges || [];
  },

  // ── Trim (reuses TrimTool._updatePreview + apply logic) ──────────────────

  createTrim(r1, c1, r2, c2, options = {}) {
    validateBounds(r1, c1);
    validateBounds(r2, c2);

    const corner = options.corner || 'auto';
    const round = !!options.round;
    const inverted = !!options.inverted;
    const open = !!options.open;

    // Resolve corner from drag direction if auto
    let resolvedCorner;
    if (corner === 'auto') {
      const dr = r2 - r1;
      const dc = c2 - c1;
      if (dr <= 0 && dc <= 0) resolvedCorner = 'nw';
      else if (dr <= 0 && dc >= 0) resolvedCorner = 'ne';
      else if (dr >= 0 && dc <= 0) resolvedCorner = 'sw';
      else resolvedCorner = 'se';
    } else {
      if (!['nw', 'ne', 'sw', 'se'].includes(corner)) {
        throw new Error(`Invalid corner: ${corner}. Use 'auto', 'nw', 'ne', 'sw', 'se'.`);
      }
      resolvedCorner = corner;
    }

    // Set up trim tool state for preview computation
    const prevCorner = state.trimCorner;
    const prevRound = state.trimRound;
    const prevInverted = state.trimInverted;
    const prevOpen = state.trimOpen;

    state.trimCorner = corner;
    state.trimRound = round;
    state.trimInverted = inverted;
    state.trimOpen = open;

    trimTool.dragStart = { row: r1, col: c1 };
    trimTool.dragEnd = { row: r2, col: c2 };
    trimTool.resolvedCorner = resolvedCorner;
    trimTool._updatePreview();

    const preview = trimTool.previewCells;
    if (!preview || preview.hypotenuse.length === 0) {
      state.trimCorner = prevCorner;
      state.trimRound = prevRound;
      state.trimInverted = prevInverted;
      state.trimOpen = prevOpen;
      trimTool.previewCells = null;
      return { success: true, note: 'No cells to trim' };
    }

    // Apply — same logic as TrimTool.onMouseUp
    pushUndo();
    const cells = state.dungeon.cells;
    const size = preview.hypotenuse.length;

    // Void interior (or clear walls in open mode)
    if (!open) {
      for (const { row, col } of preview.voided) {
        cells[row][col] = null;
      }
    } else {
      for (const { row: r, col: c } of preview.voided) {
        const cell = cells[r]?.[c];
        if (!cell) continue;
        for (const dir of CARDINAL_DIRS) {
          if (cell[dir]) {
            delete cell[dir];
            const [dr, dc] = OFFSETS[dir];
            const neighbor = cells[r + dr]?.[c + dc];
            if (neighbor) delete neighbor[OPPOSITE[dir]];
          }
        }
        delete cell['nw-se'];
        delete cell['ne-sw'];
        delete cell.trimCorner;
        delete cell.trimRound;
        delete cell.trimArcCenterRow;
        delete cell.trimArcCenterCol;
        delete cell.trimArcRadius;
        delete cell.trimArcInverted;
        delete cell.trimOpen;
      }
    }

    // Set hypotenuse cells
    for (const { row: r, col: c } of preview.hypotenuse) {
      if (!cells[r][c]) cells[r][c] = {};
      const cell = cells[r][c];

      cell.trimCorner = resolvedCorner;

      // Clear all cardinal walls + reciprocals
      for (const dir of CARDINAL_DIRS) {
        if (cell[dir]) {
          delete cell[dir];
          const [dr, dc] = OFFSETS[dir];
          const neighbor = cells[r + dr]?.[c + dc];
          if (neighbor) delete neighbor[OPPOSITE[dir]];
        }
      }
      delete cell['nw-se'];
      delete cell['ne-sw'];

      // Set diagonal border
      if (resolvedCorner === 'nw' || resolvedCorner === 'se') {
        cell['ne-sw'] = 'w';
      } else {
        cell['nw-se'] = 'w';
      }

      if (round) {
        cell.trimRound = true;
        cell.trimArcInverted = inverted;
        cell.trimArcCenterRow = preview.arcCenter.row;
        cell.trimArcCenterCol = preview.arcCenter.col;
        cell.trimArcRadius = size;
        if (open) cell.trimOpen = true;
        else delete cell.trimOpen;
      } else {
        delete cell.trimRound;
        delete cell.trimArcCenterRow;
        delete cell.trimArcCenterCol;
        delete cell.trimArcRadius;
        delete cell.trimArcInverted;
        if (open) cell.trimOpen = true;
        else delete cell.trimOpen;
      }
    }

    // Clear walls from insideArc cells and mark with metadata for BFS detection
    for (const { row: r, col: c } of (preview.insideArc || [])) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        if (cell[dir]) {
          delete cell[dir];
          const [dr, dc] = OFFSETS[dir];
          const neighbor = cells[r + dr]?.[c + dc];
          if (neighbor) delete neighbor[OPPOSITE[dir]];
        }
      }
      delete cell['nw-se'];
      delete cell['ne-sw'];
      delete cell.trimRound;
      cell.trimInsideArc = true;
      cell.trimCorner = resolvedCorner;
      cell.trimArcCenterRow = preview.arcCenter.row;
      cell.trimArcCenterCol = preview.arcCenter.col;
      cell.trimArcRadius = size;
      cell.trimArcInverted = inverted;
    }

    // Restore state
    state.trimCorner = prevCorner;
    state.trimRound = prevRound;
    state.trimInverted = prevInverted;
    state.trimOpen = prevOpen;
    trimTool.previewCells = null;

    markDirty();
    notify();
    return { success: true };
  },

  // ── Level Management ────────────────────────────────────────────────────

  getLevels() {
    const levels = state.dungeon.metadata.levels || [];
    return levels.map((l, i) => ({
      index: i,
      name: l.name,
      startRow: l.startRow,
      numRows: l.numRows,
    }));
  },

  renameLevel(levelIndex, newName) {
    const levels = state.dungeon.metadata.levels;
    if (!levels || levelIndex < 0 || levelIndex >= levels.length) {
      throw new Error(`Level index ${levelIndex} out of range (${levels?.length || 0} levels)`);
    }
    if (!newName || typeof newName !== 'string') {
      throw new Error('Level name must be a non-empty string');
    }
    pushUndo();
    levels[levelIndex].name = newName.trim();
    markDirty();
    notify();
    return { success: true };
  },

  resizeLevel(levelIndex, newRows) {
    const levels = state.dungeon.metadata.levels;
    if (!levels || levelIndex < 0 || levelIndex >= levels.length) {
      throw new Error(`Level index ${levelIndex} out of range (${levels?.length || 0} levels)`);
    }
    if (!Number.isInteger(newRows) || newRows < 1) {
      throw new Error('Row count must be a positive integer');
    }

    const level = levels[levelIndex];
    if (newRows === level.numRows) return { success: true };

    pushUndo();

    const cells = state.dungeon.cells;
    const numCols = cells[0]?.length || 30;
    const delta = newRows - level.numRows;
    const levelEnd = level.startRow + level.numRows;

    if (delta > 0) {
      // Insert void rows at the end of this level
      const newCellRows = [];
      for (let i = 0; i < delta; i++) {
        const row = [];
        for (let c = 0; c < numCols; c++) row.push(null);
        newCellRows.push(row);
      }
      cells.splice(levelEnd, 0, ...newCellRows);
    } else {
      // Remove rows from the end of this level
      cells.splice(levelEnd + delta, -delta);
    }

    level.numRows = newRows;

    // Shift startRow of subsequent levels
    for (let i = levelIndex + 1; i < levels.length; i++) {
      levels[i].startRow += delta;
    }

    invalidateAllCaches();
    markDirty();
    notify();
    return { success: true };
  },

  addLevel(name, numRows = 15) {
    if (!name || typeof name !== 'string') {
      throw new Error('Level name must be a non-empty string');
    }
    if (!Number.isInteger(numRows) || numRows < 1) {
      throw new Error('Row count must be a positive integer');
    }

    pushUndo();

    const cells = state.dungeon.cells;
    const currentRows = cells.length;
    const numCols = cells[0]?.length || 30;

    // Add a void separator row + new level rows
    for (let r = 0; r < 1 + numRows; r++) {
      const row = [];
      for (let c = 0; c < numCols; c++) row.push(null);
      cells.push(row);
    }

    if (!state.dungeon.metadata.levels) state.dungeon.metadata.levels = [];
    state.dungeon.metadata.levels.push({
      name: name.trim(),
      startRow: currentRows + 1,
      numRows,
    });

    state.currentLevel = state.dungeon.metadata.levels.length - 1;
    invalidateAllCaches();
    markDirty();
    notify();
    return { success: true, levelIndex: state.currentLevel };
  },

  // ── Fill Operations ─────────────────────────────────────────────────────

  setFill(row, col, fillType, depth) {
    if (!['pit', 'water', 'lava'].includes(fillType)) {
      throw new Error(`Invalid fill type: ${fillType}. Use 'pit', 'water', or 'lava'. For hazard, use setHazard().`);
    }
    const cell = ensureCell(row, col);
    pushUndo();
    cell.fill = fillType;
    const d = (depth >= 1 && depth <= 3) ? depth : 1;
    if (fillType === 'water') {
      cell.waterDepth = d;
      delete cell.lavaDepth;
    } else if (fillType === 'lava') {
      cell.lavaDepth = d;
      delete cell.waterDepth;
    } else {
      delete cell.waterDepth;
      delete cell.lavaDepth;
    }
    markDirty();
    notify();
    return { success: true };
  },

  removeFill(row, col) {
    validateBounds(row, col);
    const cell = state.dungeon.cells[row][col];
    if (!cell?.fill) return { success: true };
    pushUndo();
    delete cell.fill;
    markDirty();
    notify();
    return { success: true };
  },

  setHazard(row, col, enabled = true) {
    const cell = ensureCell(row, col);
    pushUndo();
    if (enabled) {
      cell.hazard = true;
      // Migrate legacy format
      if (cell.fill === 'difficult-terrain') delete cell.fill;
    } else {
      delete cell.hazard;
    }
    markDirty();
    notify();
    return { success: true };
  },

  // ── Prop Operations ─────────────────────────────────────────────────────

  placeProp(row, col, propType, facing = 0) {
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
    for (let r = row; r < row + span[0]; r++) {
      for (let c = col; c < col + span[1]; c++) {
        validateBounds(r, c);
        if (cells[r][c] === null) throw new Error(`Cell (${r}, ${c}) is void — cannot place prop`);
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
  },

  removeProp(row, col) {
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
  },

  setLightName(id, name) {
    const meta = state.dungeon.metadata;
    const light = (meta.lights || []).find(l => l.id === id);
    if (!light) throw new Error(`No light with id ${id}`);
    if (name) light.name = name;
    else delete light.name;
    markDirty();
    notify();
    return { success: true };
  },

  rotateProp(row, col) {
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
  },

  listProps() {
    const catalog = state.propCatalog;
    if (!catalog) return { categories: [], props: {} };
    return {
      categories: catalog.categories,
      props: Object.fromEntries(
        Object.entries(catalog.props).map(([k, v]) => [k, {
          name: v.name,
          category: v.category,
          footprint: v.footprint,
          facing: v.facing,
        }])
      ),
    };
  },

  /** Remove all props with anchor cells in the given rectangle. */
  removePropsInRect(r1, c1, r2, c2) {
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
  },

  // ── Catalog Queries ───────────────────────────────────────────────────────

  /** Return all available texture IDs with display names and categories. */
  listTextures() {
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
  },

  /** Return all available theme names. */
  listThemes() {
    const catalog = getThemeCatalog();
    if (!catalog) return { success: true, themes: [] };
    return { success: true, themes: catalog.names };
  },

  // ── Spatial Queries ───────────────────────────────────────────────────────

  /** Find the cell that holds a room's label marker. Returns { row, col } or null. Read-only. */
  findCellByLabel(label) {
    const cells = state.dungeon.cells;
    const target = String(label);
    for (let r = 0; r < cells.length; r++) {
      const row = cells[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (cells[r][c]?.center?.label === target) return { row: r, col: c };
      }
    }
    return null;
  },

  /**
   * BFS from a label cell, stopping at walls, doors, secret doors, and diagonal walls.
   * Returns a Set of "row,col" cell keys for the room, or null if label not found.
   */
  _collectRoomCells(label) {
    const start = this.findCellByLabel(label);
    if (!start) return null;
    return floodFillRoom(state.dungeon.cells, start.row, start.col);
  },

  /**
   * BFS from the label cell through open edges to find the full room extent.
   * Returns { r1, c1, r2, c2, centerRow, centerCol } or null if label not found.
   * Read-only.
   */
  getRoomBounds(label) {
    const roomCells = this._collectRoomCells(label);
    return roomBoundsFromKeys(roomCells);
  },

  /**
   * Find all wall/door positions on the shared boundary between two labeled rooms.
   * Returns [{ row, col, direction, type }] or null if no shared boundary found.
   * Read-only.
   */
  findWallBetween(label1, label2) {
    const room1Cells = this._collectRoomCells(label1);
    const room2Cells = this._collectRoomCells(label2);
    if (!room1Cells || !room2Cells) return null;

    const cells = state.dungeon.cells;
    const results = [];

    for (const key of room1Cells) {
      const [r, c] = parseCellKey(key);
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        const [dr, dc] = OFFSETS[dir];
        const nr = r + dr, nc = c + dc;
        if (!room2Cells.has(cellKey(nr, nc))) continue;
        results.push({ row: r, col: c, direction: dir, type: cell[dir] || 'w' });
      }
    }

    return results.length > 0 ? results : null;
  },

  // ── Bulk Fill ─────────────────────────────────────────────────────────────

  /** Set fill on every cell in a rectangle. One undo step. */
  setFillRect(r1, c1, r2, c2, fillType, depth) {
    if (!['pit', 'water', 'lava'].includes(fillType)) {
      throw new Error(`Invalid fill type: "${fillType}" (expected: pit, water, lava). For hazard, use setHazardRect().`);
    }
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    validateBounds(minR, minC);
    validateBounds(maxR, maxC);
    pushUndo();
    const wd = (depth >= 1 && depth <= 3) ? depth : 1;
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell) {
          cell.fill = fillType;
          if (fillType === 'water') {
            cell.waterDepth = wd;
            delete cell.lavaDepth;
          } else if (fillType === 'lava') {
            cell.lavaDepth = wd;
            delete cell.waterDepth;
          } else {
            delete cell.waterDepth;
            delete cell.lavaDepth;
          }
        }
      }
    }
    markDirty();
    notify();
    return { success: true };
  },

  /** Set or clear hazard on every cell in a rectangle. One undo step. */
  setHazardRect(r1, c1, r2, c2, enabled = true) {
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    validateBounds(minR, minC);
    validateBounds(maxR, maxC);
    pushUndo();
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell) {
          if (enabled) {
            cell.hazard = true;
            if (cell.fill === 'difficult-terrain') delete cell.fill;
          } else {
            delete cell.hazard;
          }
        }
      }
    }
    markDirty();
    notify();
    return { success: true };
  },

  /** Remove fill from every cell in a rectangle. One undo step. */
  removeFillRect(r1, c1, r2, c2) {
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    validateBounds(minR, minC);
    validateBounds(maxR, maxC);
    pushUndo();
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell) delete cell.fill;
      }
    }
    markDirty();
    notify();
    return { success: true };
  },

  // ── Texture Operations ────────────────────────────────────────────────────

  /** Set texture on a single cell. opacity defaults to 1.0. */
  setTexture(row, col, textureId, opacity = 1.0) {
    const cell = ensureCell(row, col);
    pushUndo();
    loadTextureImages(textureId);
    cell.texture = textureId;
    cell.textureOpacity = Math.max(0, Math.min(1, opacity));
    markDirty();
    notify();
    return { success: true };
  },

  /** Remove texture from a single cell. */
  removeTexture(row, col) {
    validateBounds(row, col);
    const cell = state.dungeon.cells[row][col];
    if (!cell?.texture) return { success: true };
    pushUndo();
    delete cell.texture;
    delete cell.textureOpacity;
    markDirty();
    notify();
    return { success: true };
  },

  /** Set texture on every cell in a rectangle. One undo step. */
  setTextureRect(r1, c1, r2, c2, textureId, opacity = 1.0) {
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    validateBounds(minR, minC);
    validateBounds(maxR, maxC);
    const clampedOpacity = Math.max(0, Math.min(1, opacity));
    loadTextureImages(textureId);
    pushUndo();
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell) {
          cell.texture = textureId;
          cell.textureOpacity = clampedOpacity;
        }
      }
    }
    markDirty();
    notify();
    return { success: true };
  },

  /** Remove texture from every cell in a rectangle. One undo step. */
  removeTextureRect(r1, c1, r2, c2) {
    const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
    validateBounds(minR, minC);
    validateBounds(maxR, maxC);
    pushUndo();
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (cell) {
          delete cell.texture;
          delete cell.textureOpacity;
        }
      }
    }
    markDirty();
    notify();
    return { success: true };
  },

  /**
   * Flood-fill texture from a starting cell using the same BFS as the paint
   * tool's Shift+click.  Delegates to PaintTool.floodFill.
   */
  floodFillTexture(row, col, textureId, opacity = 1.0) {
    validateBounds(row, col);
    if (!state.dungeon.cells[row]?.[col]) return { success: false, error: 'void cell' };
    const prevTexture = state.activeTexture;
    const prevOpacity = state.textureOpacity;
    const prevSecondary = state.paintSecondary;
    state.activeTexture = textureId;
    state.textureOpacity = Math.max(0, Math.min(1, opacity));
    state.paintSecondary = false;
    loadTextureImages(textureId);
    paintTool.floodFill(row, col, null);
    state.activeTexture = prevTexture;
    state.textureOpacity = prevOpacity;
    state.paintSecondary = prevSecondary;
    return { success: true };
  },

  // ── Convenience ───────────────────────────────────────────────────────────

  /**
   * Merge two adjacent rooms by removing all walls on their shared boundary.
   * Uses findWallBetween internally. One undo step.
   * Returns { success, removed } where removed is the count of walls cleared.
   */
  mergeRooms(label1, label2) {
    const walls = this.findWallBetween(label1, label2);
    if (!walls) {
      throw new Error(`No shared boundary found between '${label1}' and '${label2}'`);
    }
    pushUndo();
    for (const { row, col, direction } of walls) {
      const cell = state.dungeon.cells[row]?.[col];
      if (!cell) continue;
      delete cell[direction];
      setReciprocal(row, col, direction, null);
    }
    markDirty();
    notify();
    return { success: true, removed: walls.length };
  },

  /**
   * Shift all cells in the dungeon by (dr, dc).
   * The grid grows to accommodate the shift — no content is lost.
   * For multi-level maps, updates level startRow values when shifting vertically.
   * One undo step.
   */
  shiftCells(dr, dc) {
    const cells = state.dungeon.cells;
    const rows = cells.length;
    const cols = cells[0]?.length || 0;
    const newRows = rows + Math.abs(dr);
    const newCols = cols + Math.abs(dc);

    if (newRows > 200 || newCols > 200) {
      throw new Error(`Shift would exceed maximum grid size (200×200). Result: ${newRows}×${newCols}`);
    }

    // Row/col offset in the destination grid:
    // If dr > 0 (shift down), content starts at row dr; if dr < 0 (shift up), content starts at row 0.
    const rowOffset = Math.max(0, dr);
    const colOffset = Math.max(0, dc);

    pushUndo();

    const newCells = Array.from({ length: newRows }, () => Array(newCols).fill(null));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (cells[r]?.[c]) newCells[r + rowOffset][c + colOffset] = cells[r][c];
      }
    }
    state.dungeon.cells = newCells;

    // Update level startRow values (only affected by vertical shift)
    if (dr !== 0 && state.dungeon.metadata?.levels) {
      for (const level of state.dungeon.metadata.levels) {
        level.startRow += rowOffset;
      }
    }

    // Shift stair corner points
    if ((rowOffset || colOffset) && state.dungeon.metadata?.stairs) {
      for (const stair of state.dungeon.metadata.stairs) {
        for (const pt of stair.points) {
          pt[0] += rowOffset;
          pt[1] += colOffset;
        }
      }
    }

    markDirty();
    notify();
    return { success: true, newRows, newCols };
  },

  // ── Lighting Operations ─────────────────────────────────────────────────

  /** Place a light at world-feet coordinates. Config overrides defaults.
   *  Use config.preset (e.g. "torch") to apply a light preset; explicit fields override preset. */
  placeLight(x, y, config = {}) {
    if (config.preset) {
      const catalog = getLightCatalog();
      const p = catalog?.lights[config.preset];
      if (!p) throw new Error(`Unknown light preset: ${config.preset}. Call listLightPresets() for valid names.`);
      config = { ...p, ...config };
      delete config.preset;
      delete config.displayName;
      delete config.description;
      delete config.category;
      delete config.id;
    }

    const meta = state.dungeon.metadata;
    if (!meta.lights) meta.lights = [];
    if (!meta.nextLightId) meta.nextLightId = 1;

    const type = config.type || 'point';
    if (type !== 'point' && type !== 'directional') {
      throw new Error(`Invalid light type: ${type}. Use 'point' or 'directional'.`);
    }

    pushUndo();

    const light = {
      id: meta.nextLightId++,
      x, y, type,
      radius: config.radius ?? 30,
      color: config.color || '#ff9944',
      intensity: config.intensity ?? 1.0,
      falloff: config.falloff || 'smooth',
    };

    if (type === 'directional') {
      light.angle = config.angle ?? 0;
      light.spread = config.spread ?? 45;
    }

    meta.lights.push(light);
    if (!meta.lightingEnabled) meta.lightingEnabled = true;
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
    return { success: true, id: light.id };
  },

  /** Remove a light by ID. */
  removeLight(id) {
    const meta = state.dungeon.metadata;
    if (!meta.lights) return { success: true };
    const idx = meta.lights.findIndex(l => l.id === id);
    if (idx === -1) throw new Error(`Light with id ${id} not found`);

    pushUndo();
    meta.lights.splice(idx, 1);
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
    return { success: true };
  },

  /** Return all lights (deep copy). */
  getLights() {
    const lights = state.dungeon.metadata?.lights || [];
    return { success: true, lights: JSON.parse(JSON.stringify(lights)) };
  },

  /** Set ambient light level (0.0 = pitch black, 1.0 = fully lit). */
  setAmbientLight(level) {
    if (typeof level !== 'number' || level < 0 || level > 1) {
      throw new Error(`Ambient light must be a number between 0 and 1, got: ${level}`);
    }
    pushUndo();
    state.dungeon.metadata.ambientLight = level;
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
    return { success: true };
  },

  /** Enable or disable the lighting system. */
  setLightingEnabled(enabled) {
    pushUndo();
    state.dungeon.metadata.lightingEnabled = !!enabled;
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
    return { success: true };
  },

  /** Return all light presets with categories. */
  listLightPresets() {
    const catalog = getLightCatalog();
    if (!catalog) return { success: true, categories: [], presets: {} };
    return {
      success: true,
      categories: catalog.categoryOrder,
      presets: Object.fromEntries(
        Object.entries(catalog.lights).map(([k, v]) => [k, {
          displayName: v.displayName,
          category: v.category,
          type: v.type,
          color: v.color,
          radius: v.radius,
          intensity: v.intensity,
          falloff: v.falloff,
        }])
      ),
    };
  },

  // ── Export ────────────────────────────────────────────────────────────────

  /**
   * Export the current dungeon state as a .map format string.
   * Read-only — does not modify state or push undo.
   * Returns { success: true, mapText: string }.
   */
  exportToMapFormat() {
    return exportDungeonToMapFormat(state.dungeon);
  },

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  undo() {
    undo();
    requestRender();
    return { success: true };
  },

  redo() {
    redo();
    requestRender();
    return { success: true };
  },

  // ── Visualization ─────────────────────────────────────────────────────────

  /**
   * Ensure all textures used in the current map have their images loaded,
   * then wait for them to finish. Call before getScreenshot() to guarantee
   * textures are rendered. Returns { success, count } when all images ready.
   */
  async waitForTextures(timeoutMs = 8000) {
    if (!state.textureCatalog?.textures) return { success: true, count: 0 };

    // Trigger loading for any map-used textures that haven't started yet
    const usedIds = collectTextureIds(state.dungeon.cells);

    // Also include textures referenced by props placed on the map
    if (state.propCatalog?.props) {
      const cells = state.dungeon.cells;
      for (const row of cells) {
        if (!row) continue;
        for (const cell of row) {
          if (!cell?.prop) continue;
          const propDef = state.propCatalog.props[cell.prop.type];
          if (propDef?.textures) {
            for (const id of propDef.textures) usedIds.add(id);
          }
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
  },

  async getScreenshot() {
    // Ensure map-used textures are loaded before capturing
    await this.waitForTextures();
    requestRender();
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        const canvas = document.getElementById('editor-canvas');
        resolve(canvas.toDataURL('image/png'));
      });
    });
  },

  /** Export the map as a PNG using the compile pipeline (HQ lighting). Returns data URL. */
  async exportPng() {
    await this.waitForTextures();
    const config = state.dungeon;
    const { width, height } = calculateCanvasSize(config);
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d');
    renderDungeonToCanvas(ctx, config, width, height, state.propCatalog, state.textureCatalog);
    return offscreen.toDataURL('image/png');
  },

  /**
   * Clear all caches (props, textures, themes, lights) and reload from server.
   */
  async clearCaches() {
    await reloadAssets();
    return { success: true };
  },

  render() {
    requestRender();
    return { success: true };
  },

  /**
   * Wait for the editor to be fully initialized: all catalogs loaded,
   * canvas ready, and textures resolved. Useful as a first command in
   * Puppeteer scripts to ensure the editor is ready before interacting.
   */
  async waitForEditor(timeoutMs = 15000) {
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
  },

  /**
   * Evaluate arbitrary JS in the editor context.
   * The code string is wrapped in an async function with access to `state`, `editorAPI`, and `document`.
   * Use `return <value>` to send a result back.
   * Example: editorAPI.eval('return document.querySelector(".menu-trigger").textContent')
   */
  async eval(code) {
    const fn = new Function('state', 'editorAPI', `return (async () => { ${code} })();`);
    const result = await fn(state, window.editorAPI);
    if (result === undefined || result === null) return { success: true };
    if (typeof result === 'object' && result.success !== undefined) return result;
    return { success: true, result };
  },

  // ── Claude AI helpers ────────────────────────────────────────────────────

  /** Return current undo stack depth. Used by Claude chat to support "undo all" after a build. */
  getUndoDepth() {
    return state.undoStack.length;
  },

  /** Undo back to a previously recorded depth, reversing all changes made since then. */
  undoToDepth(targetDepth) {
    const depth = Math.max(0, targetDepth);
    let count = 0;
    while (state.undoStack.length > depth) {
      undo();
      count++;
    }
    return { success: true, undid: count };
  },

  /** Return the contents of a labeled room: props, fills, doors, textures. */
  getRoomContents(label) {
    const bounds = this.getRoomBounds(label);
    if (!bounds) return { error: `Room "${label}" not found` };
    const result = { label, bounds, props: [], fills: [], doors: [], textures: [] };
    for (let r = bounds.r1; r <= bounds.r2; r++) {
      for (let c = bounds.c1; c <= bounds.c2; c++) {
        const cell = state.dungeon.cells[r]?.[c];
        if (!cell) continue;
        if (cell.prop) result.props.push({ row: r, col: c, type: cell.prop.type, facing: cell.prop.facing });
        if (cell.fill) result.fills.push({ row: r, col: c, type: cell.fill, depth: cell.fillDepth ?? 1 });
        if (cell.texture) result.textures.push({ row: r, col: c, id: cell.texture, opacity: cell.textureOpacity ?? 1 });
        for (const dir of ['north', 'south', 'east', 'west']) {
          if (cell[dir] === 'd' || cell[dir] === 's')
            result.doors.push({ row: r, col: c, direction: dir, type: cell[dir] });
        }
      }
    }
    return result;
  },

  /**
   * Find a free rectangular area of the given size, optionally adjacent to an existing room.
   * Returns { r1, c1, r2, c2 } of the suggested placement, or { error } if no space found.
   */
  suggestPlacement(rows, cols, adjacentTo = null) {
    const info = this.getMapInfo();
    if (!info) return { error: 'Map not available' };
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
      const b = this.getRoomBounds(adjacentTo);
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
    return { error: `No space found for a ${rows}×${cols} room. Map may be full.` };
  },

  /**
   * Create a walled corridor connecting two labeled rooms. Rooms must be axis-aligned
   * with enough perpendicular overlap for the corridor width. Auto-assigns a room label
   * and places doors at both ends. Returns { corridorLabel, r1, c1, r2, c2 }.
   */
  createCorridor(label1, label2, width = 2) {
    const b1 = this.getRoomBounds(label1);
    const b2 = this.getRoomBounds(label2);
    if (!b1) return { error: `Room "${label1}" not found` };
    if (!b2) return { error: `Room "${label2}" not found` };

    let cr1, cc1, cr2, cc2;

    const vOverlap = Math.min(b1.c2, b2.c2) - Math.max(b1.c1, b2.c1) + 1;
    const hOverlap = Math.min(b1.r2, b2.r2) - Math.max(b1.r1, b2.r1) + 1;

    if (b1.c2 < b2.c1 && vOverlap >= width) {        // b1 left of b2
      cc1 = b1.c2 + 1; cc2 = b2.c1 - 1;
      const mid = Math.floor((Math.max(b1.r1, b2.r1) + Math.min(b1.r2, b2.r2)) / 2);
      cr1 = mid - Math.floor(width / 2); cr2 = cr1 + width - 1;
    } else if (b2.c2 < b1.c1 && vOverlap >= width) { // b2 left of b1
      cc1 = b2.c2 + 1; cc2 = b1.c1 - 1;
      const mid = Math.floor((Math.max(b1.r1, b2.r1) + Math.min(b1.r2, b2.r2)) / 2);
      cr1 = mid - Math.floor(width / 2); cr2 = cr1 + width - 1;
    } else if (b1.r2 < b2.r1 && hOverlap >= width) { // b1 above b2
      cr1 = b1.r2 + 1; cr2 = b2.r1 - 1;
      const mid = Math.floor((Math.max(b1.c1, b2.c1) + Math.min(b1.c2, b2.c2)) / 2);
      cc1 = mid - Math.floor(width / 2); cc2 = cc1 + width - 1;
    } else if (b2.r2 < b1.r1 && hOverlap >= width) { // b2 above b1
      cr1 = b2.r2 + 1; cr2 = b1.r1 - 1;
      const mid = Math.floor((Math.max(b1.c1, b2.c1) + Math.min(b1.c2, b2.c2)) / 2);
      cc1 = mid - Math.floor(width / 2); cc2 = cc1 + width - 1;
    } else {
      return { error: `Cannot auto-route a corridor between "${label1}" and "${label2}". Rooms must be axis-aligned with at least ${width} cells of shared overlap and a gap between them. Use createRoom manually for L-shaped paths.` };
    }

    if (cr2 < cr1 || cc2 < cc1)
      return { error: `"${label1}" and "${label2}" are already touching — use findWallBetween + setDoor to add a door directly.` };

    this.createRoom(cr1, cc1, cr2, cc2, 'merge');

    // Auto-assign next available room label
    const letter = state.dungeon.metadata.dungeonLetter || 'A';
    const pat = new RegExp(`^${letter}(\\d+)$`);
    const used = new Set();
    for (const row of state.dungeon.cells) {
      for (const cell of row) {
        const m = cell?.center?.label?.match(pat);
        if (m) used.add(parseInt(m[1]));
      }
    }
    let n = 1;
    while (used.has(n)) n++;
    const corridorLabel = letter + n;
    this.setLabel(Math.floor((cr1 + cr2) / 2), Math.floor((cc1 + cc2) / 2), corridorLabel);

    // Place doors at both connection points
    for (const roomLabel of [label1, label2]) {
      const walls = this.findWallBetween(roomLabel, corridorLabel);
      if (walls?.walls?.length) {
        const mid = walls.walls[Math.floor(walls.walls.length / 2)];
        this.setDoor(mid.row, mid.col, mid.direction, 'd');
      }
    }

    return { success: true, corridorLabel, r1: cr1, c1: cc1, r2: cr2, c2: cc2 };
  },
};

// Wait for the editor to fully initialize before exposing the API
function waitForReady() {
  return new Promise((resolve) => {
    // Require canvas, dungeon state, AND theme catalog to be loaded
    // (themes must be in THEMES registry so the first render doesn't crash)
    const check = () => {
      if (document.getElementById('editor-canvas') && state.dungeon && getThemeCatalog() !== null) {
        window.editorAPI = api;
        console.log('[editor-api] API ready — window.editorAPI available');
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', check);
    } else {
      check();
    }
  });
}

waitForReady();
