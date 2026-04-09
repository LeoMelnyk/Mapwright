// Shared helpers, constants, and tool instances for the editor API modules.

import type { CardinalDirection, Cell, EdgeValue, PlaceLightConfig } from '../../../types.js';
import state, { pushUndo, markDirty, notify, undo as undoFn, redo as redoFn, invalidateLightmap, mutate } from '../state.js';
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

/** Subset of editor API methods accessed via cross-module getApi() calls. */
interface EditorApiMap {
  _collectRoomCells(label: string): Set<string> | null;
  _getWallCells(roomCellSet: Set<string>, wall: string): [number, number][];
  _isCellCoveredByProp(r: number, c: number): boolean;
  addStairs(p1r: number, p1c: number, p2r: number, p2c: number, p3r: number, p3c: number): { success: true; id: number };
  createRoom(r1: number, c1: number, r2: number, c2: number, mode?: string): { success: boolean };
  createTrim(r1: number, c1: number, r2: number, c2: number, cornerOrOptions?: string | Record<string, unknown>, extraOptions?: Record<string, unknown>): { success: boolean };
  findCellByLabel(label: string): { success: boolean; row?: number; col?: number; error?: string };
  findWallBetween(label1: string, label2: string): { row: number; col: number; direction: string; type: string }[] | null;
  getMapInfo(): { rows: number; cols: number; gridSize: number; theme: string; name: string; [k: string]: unknown } | null;
  getRoomBounds(label: string): { r1: number; c1: number; r2: number; c2: number; centerRow: number; centerCol: number } | null;
  getValidPropPositions(label: string, propType: string, facing: number): { success: boolean; positions?: [number, number][] };
  placeLight(x: number, y: number, config?: PlaceLightConfig): { success: boolean; id: number };
  placeProp(row: number, col: number, propType: string, facing?: number): { success: boolean };
  setDoor(row: number, col: number, direction: string, type?: string): { success: boolean };
  setLabel(row: number, col: number, text: string): { success: boolean };
  waitForTextures(timeoutMs?: number): Promise<{ success: boolean }>;
}

let _api: EditorApiMap | null = null;

/**
 * Get the assembled editor API object for cross-module method calls.
 */
function getApi(): EditorApiMap {
  return _api!;
}

/**
 * Set the API reference (called once by the assembler after construction).
 */
function _setApi(api: EditorApiMap): void {
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
  state.dungeon.cells[row][col] ??= {} as Cell;
  return state.dungeon.cells[row][col];
}

/**
 * Set a wall/door value on the neighbor cell's reciprocal edge.
 */
function setReciprocal(row: number, col: number, direction: string, value: EdgeValue | null): void {
  const dir = direction as CardinalDirection;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Record type lies; runtime keys can be missing
  if (!OPPOSITE[dir]) return;
  const [dr, dc] = OFFSETS[dir];
  const nr = row + dr, nc = col + dc;
  const cells = state.dungeon.cells;
  if (nr < 0 || nr >= cells.length || nc < 0 || nc >= (cells[0]?.length || 0)) return;
  cells[nr][nc] ??= {} as Cell;
  if (value === null) {
    delete (cells[nr][nc] as Record<string, unknown>)[OPPOSITE[dir]];
  } else {
    (cells[nr][nc] as Record<string, unknown>)[OPPOSITE[dir]] = value;
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
  return state.dungeon.metadata.resolution || 1;
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
  state, pushUndo, markDirty, notify, undoFn, redoFn, invalidateLightmap, mutate,

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
