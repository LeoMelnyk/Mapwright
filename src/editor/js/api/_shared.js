// Shared helpers, constants, and tool instances for the editor API modules.

import state, { pushUndo, markDirty, notify, undo as undoFn, redo as redoFn, invalidateLightmap } from '../state.js';
import { createEmptyDungeon } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import { RoomTool, TrimTool, PaintTool } from '../tools/index.js';
import { getThemeCatalog } from '../theme-catalog.js';
import { collectTextureIds, ensureTexturesLoaded, loadTextureImages, getTextureCatalog } from '../texture-catalog.js';
import { getLightCatalog } from '../light-catalog.js';
import { reloadAssets, migrateHalfTextures } from '../io.js';
import { migrateToLatest } from '../migrations.js';
import { classifyStairShape, isDegenerate, getOccupiedCells } from '../stair-geometry.js';
import { isBridgeDegenerate, getBridgeOccupiedCells } from '../bridge-geometry.js';
import { calculateCanvasSize, renderDungeonToCanvas, invalidateAllCaches } from '../../../render/index.js';
import { OPPOSITE, cellKey, parseCellKey, isInBounds, roomBoundsFromKeys, floodFillRoom } from '../../../util/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const CARDINAL_DIRS = ['north', 'south', 'east', 'west'];
const ALL_DIRS = ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw'];
const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };

// ─── Private tool instances ──────────────────────────────────────────────────

const roomTool = new RoomTool();
const trimTool = new TrimTool();
const paintTool = new PaintTool();

// ─── API reference holder ────────────────────────────────────────────────────
// Set once by the assembler after construction. Used by modules that need
// cross-method calls (e.g. convenience.js calling spatial.js methods).

let _api = null;

function getApi() {
  return _api;
}

function _setApi(api) {
  _api = api;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Re-exports ──────────────────────────────────────────────────────────────
// Grouped by source so each API module can import exactly what it needs.

export {
  // API ref
  getApi, _setApi,

  // Constants
  CARDINAL_DIRS, ALL_DIRS, OFFSETS,

  // Helpers
  validateBounds, ensureCell, setReciprocal, deleteReciprocal,

  // Tool instances
  roomTool, trimTool, paintTool,

  // State
  state, pushUndo, markDirty, notify, undoFn, redoFn, invalidateLightmap,

  // Utils
  createEmptyDungeon, requestRender,

  // Catalogs
  getThemeCatalog, collectTextureIds, ensureTexturesLoaded, loadTextureImages, getTextureCatalog,
  getLightCatalog, reloadAssets, migrateHalfTextures, migrateToLatest,

  // Geometry
  classifyStairShape, isDegenerate, getOccupiedCells,
  isBridgeDegenerate, getBridgeOccupiedCells,

  // Render
  calculateCanvasSize, renderDungeonToCanvas, invalidateAllCaches,

  // Grid utils
  OPPOSITE, cellKey, parseCellKey, isInBounds, roomBoundsFromKeys, floodFillRoom,
};
