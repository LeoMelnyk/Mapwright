// Pan/zoom control functions for canvas-view.
import state, { markDirty, notify } from './state.js';
import { displayGridSize as _dgs } from '../../util/index.js';
import { cvState, CELL_SIZE, MIN_ZOOM, MAX_ZOOM } from './canvas-view-state.js';
import { requestRender } from './canvas-view-render.js';

/**
 * Clamp pan so the map can't be scrolled more than ~0.5 viewport widths off screen.
 * @returns {void}
 */
export function clampPan(): void {
  const { canvas } = cvState;
  if (!canvas) return;
  const { gridSize, resolution } = state.dungeon.metadata;
  const scale = CELL_SIZE * state.zoom / _dgs(gridSize, resolution);
  const numRows = state.dungeon.cells.length;
  const numCols = state.dungeon.cells[0]?.length || 0;
  const mapPxW = numCols * gridSize * scale;
  const mapPxH = numRows * gridSize * scale;
  const vw = cvState._canvasW || (canvas as any).width;
  const vh = cvState._canvasH || (canvas as any).height;
  const leewayX = vw * 0.5;
  const leewayY = vh * 0.5;
  state.panX = Math.max(-(mapPxW + leewayX), Math.min(vw + leewayX, state.panX));
  state.panY = Math.max(-(mapPxH + leewayY), Math.min(vh + leewayY, state.panY));
}

/**
 * Zoom to fit the current level in view (H key shortcut).
 * @returns {void}
 */
export function zoomToFit(): void {
  const levels = state.dungeon.metadata.levels;
  if (levels?.length) {
    const level = levels[state.currentLevel] || levels[0];
    panToLevel(level.startRow, level.numRows);
  } else {
    // Single-level map: fit all rows
    panToLevel(0, state.dungeon.cells.length);
  }
}

/**
 * Pan and zoom the viewport to fit a level (startRow..startRow+numRows) in view.
 * @param {number} startRow - First row of the level.
 * @param {number} numRows - Number of rows in the level.
 * @returns {void}
 */
export function panToLevel(startRow: number, numRows: number): void {
  const { canvas } = cvState;
  const { gridSize, resolution } = state.dungeon.metadata;
  const dgs = _dgs(gridSize, resolution);
  const numCols = state.dungeon.cells[0]?.length || 0;
  const margin = 40; // px padding around the level

  // World-space bounds of the level (in feet)
  const worldW = numCols * gridSize;
  const worldH = numRows * gridSize;

  // Canvas logical pixel size
  const cw = cvState._canvasW || (canvas ? (canvas as any).width : 800);
  const ch = cvState._canvasH || (canvas ? (canvas as any).height : 600);

  // Zoom to fit: pick the smaller axis ratio so the whole level fits
  const zoomX = (cw - margin * 2) / (worldW * (CELL_SIZE / dgs));
  const zoomY = (ch - margin * 2) / (worldH * (CELL_SIZE / dgs));
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zoomX, zoomY)));

  // Recompute scale with new zoom
  const scale = CELL_SIZE * state.zoom / dgs;

  // Center the level in the viewport
  const levelPixelW = worldW * scale;
  const levelPixelH = worldH * scale;
  state.panX = (cw - levelPixelW) / 2;
  state.panY = (ch - levelPixelH) / 2 - startRow * gridSize * scale;

  markDirty();
  requestRender();
  notify();
}
