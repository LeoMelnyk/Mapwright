// Shared helpers, constants, and tool instances for the editor API modules.

import type { Cell, EdgeValue } from '../../../types.js';
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
import { calculateCanvasSize, renderDungeonToCanvas, invalidateAllCaches, captureBeforeState, smartInvalidate, patchBlendForDirtyRegion, accumulateDirtyRect } from '../../../render/index.js';
import { OPPOSITE, cellKey, parseCellKey, isInBounds, roomBoundsFromKeys, floodFillRoom, toInternalCoord, toDisplayCoord } from '../../../util/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const CARDINAL_DIRS: string[] = ['north', 'south', 'east', 'west'];
const ALL_DIRS: string[] = ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw'];
const OFFSETS: Record<string, [number, number]> = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };

// ─── Private tool instances ──────────────────────────────────────────────────

const roomTool = new RoomTool();
const trimTool = new TrimTool();
const paintTool = new PaintTool();

// ─── API reference holder ────────────────────────────────────────────────────
// Set once by the assembler after construction. Used by modules that need
// cross-method calls (e.g. convenience.js calling spatial.js methods).

let _api: Record<string, any> | null = null;

/**
 * Get the assembled editor API object for cross-module method calls.
 */
function getApi(): Record<string, any> {
  return _api!;
}

/**
 * Set the API reference (called once by the assembler after construction).
 */
function _setApi(api: Record<string, any>): void {
  _api = api;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Throw if (row, col) is outside the dungeon grid bounds.
 */
function validateBounds(row: number, col: number): void {
  const cells = state.dungeon.cells;
  if (!isInBounds(cells, row, col)) {
    throw new Error(`Cell (${row}, ${col}) out of bounds (${cells.length} rows, ${cells[0]?.length || 0} cols)`);
  }
}

/**
 * Ensure the cell at (row, col) exists (create empty object if null). Validates bounds.
 */
function ensureCell(row: number, col: number): Cell {
  validateBounds(row, col);
  if (!state.dungeon.cells[row][col]) {
    state.dungeon.cells[row][col] = {} as Cell;
  }
  return state.dungeon.cells[row][col]!;
}

/**
 * Set a wall/door value on the neighbor cell's reciprocal edge.
 */
function setReciprocal(row: number, col: number, direction: string, value: EdgeValue | null): void {
  if (!OPPOSITE[direction]) return;
  const [dr, dc] = OFFSETS[direction];
  const nr = row + dr, nc = col + dc;
  const cells = state.dungeon.cells;
  if (nr < 0 || nr >= cells.length || nc < 0 || nc >= (cells[0]?.length || 0)) return;
  if (!cells[nr][nc]) cells[nr][nc] = {} as Cell;
  if (value === null) {
    delete (cells[nr][nc] as any)[OPPOSITE[direction]];
  } else {
    (cells[nr][nc] as any)[OPPOSITE[direction]] = value;
  }
}

/**
 * Delete the reciprocal edge value on the neighbor cell.
 */
function deleteReciprocal(row: number, col: number, direction: string): void {
  setReciprocal(row, col, direction, null);
}

// ─── Resolution coordinate conversion ───────────────────────────────────────

/** Get the current resolution (defaults to 1 for legacy maps). */
function getResolution(): number {
  return state.dungeon?.metadata?.resolution || 1;
}

/** Convert a display coordinate (0, 0.5, 1, …) to internal grid index. */
function toInt(displayCoord: number): number {
  return toInternalCoord(displayCoord, getResolution());
}

/** Convert an internal grid index to a display coordinate. */
function toDisp(internalCoord: number): number {
  return toDisplayCoord(internalCoord, getResolution());
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
  captureBeforeState, smartInvalidate, patchBlendForDirtyRegion, accumulateDirtyRect,

  // Grid utils
  OPPOSITE, cellKey, parseCellKey, isInBounds, roomBoundsFromKeys, floodFillRoom,

  // Resolution helpers
  getResolution, toInt, toDisp,
};
