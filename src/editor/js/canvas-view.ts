// Canvas element management, pan/zoom, mouse event routing
// This is the orchestrator module — it wires together the sub-modules and
// re-exports the full public API so no other file needs import changes.

import type { Tool } from './tools/tool-base.js';
import state, { subscribe } from './state.js';
import { initMinimap } from './minimap.js';

// ── Sub-module imports ──────────────────────────────────────────────────────
import { cvState, ANIM_INTERVAL_MS, getMapCache, getCachedBgImage } from './canvas-view-state.js';
import { requestRender, resizeCanvas, getTransform, setTickAnimLoopRef } from './canvas-view-render.js';
import { onMouseDown, onMouseMove, onMouseUp, onMouseLeave, onWheel, restoreToolCursor } from './canvas-view-input.js';
import { zoomToFit, panToLevel } from './canvas-view-viewport.js';

// ── Cache management ────────────────────────────────────────────────────────

/**
 * Force the offscreen map cache to rebuild on next frame.
 * @returns {void}
 */
export function invalidateMapCache(): void { getMapCache().invalidate(); }

/**
 * Invalidate only the grid layer of the map cache.
 * @returns {void}
 */
export function invalidateGridCache(): void { getMapCache().invalidateGrid(); }

export { getCachedBgImage };

// ── Background cell measure ─────────────────────────────────────────────────

/**
 * Enter background cell measure mode — user drags to calibrate grid pixel size.
 * @param {Function} callback - Called with the computed pixels-per-cell value.
 * @returns {void}
 */
export function activateBgCellMeasure(callback: (newPixelsPerCell: number) => void): void {
  cvState._bgMeasureActive = true;
  cvState._bgMeasureCallback = callback;
  cvState._bgMeasureStart = null;
  cvState._bgMeasureEnd = null;
  if (cvState.canvas) cvState.canvas.style.cursor = 'crosshair';
}

// ── Animation loop ──────────────────────────────────────────────────────────

function tickAnimLoop() {
  cvState.animLoopId = null;
  const { metadata } = state.dungeon;
  if (!metadata.lightingEnabled) return;
  state.animClock = performance.now() / 1000;
  requestRender();
  cvState.animLoopId = setTimeout(tickAnimLoop, ANIM_INTERVAL_MS);
}

// Wire the render module's tickAnimLoop reference so it can schedule animation frames
setTickAnimLoopRef(tickAnimLoop);

/**
 * Start the continuous animation loop for animated lights.
 * @returns {void}
 */
export function startAnimLoop(): void {
  if (cvState.animLoopId) return;
  cvState.animLoopId = setTimeout(tickAnimLoop, ANIM_INTERVAL_MS);
}

/**
 * Stop the continuous animation loop.
 * @returns {void}
 */
export function stopAnimLoop(): void {
  if (cvState.animLoopId) {
    clearTimeout(cvState.animLoopId);
    cvState.animLoopId = null;
  }
}

// ── Public API setters ──────────────────────────────────────────────────────

/**
 * Set the session overlay render and click handler functions.
 * @param {Function|null} renderFn - Render callback for session overlay (doors/stairs buttons).
 * @param {Function|null} clickFn - Click handler for session overlay hit testing.
 * @returns {void}
 */
export function setSessionOverlay(renderFn: ((...args: unknown[]) => void) | null, clickFn: ((...args: unknown[]) => boolean) | null): void {
  cvState.sessionOverlayFn = renderFn;
  cvState.sessionClickFn = clickFn;
}

/**
 * Set the DM fog overlay render callback.
 * @param {Function|null} fn - Render callback that tints unrevealed cells.
 * @returns {void}
 */
export function setDmFogOverlay(fn: ((...args: unknown[]) => void) | null): void {
  cvState.dmFogOverlayFn = fn;
}

/**
 * Set the active session tool (e.g. range detector, fog reveal).
 * @param {Object|null} tool - The session tool instance, or null to deactivate.
 * @returns {void}
 */
export function setSessionTool(tool: Tool | null): void {
  if (cvState.sessionTool?.onDeactivate) cvState.sessionTool.onDeactivate();
  cvState.sessionTool = tool;
  if (cvState.sessionTool?.onActivate) cvState.sessionTool.onActivate();
}

/**
 * Set the persistent range tool reference for rendering remote range highlights.
 * @param {Object|null} tool - The range tool instance.
 * @returns {void}
 */
export function setSessionRangeTool(tool: Tool | null): void {
  cvState.sessionRangeTool = tool;
}

/**
 * Set the active editor tool instance for canvas event routing.
 * @param {Object|null} tool - The tool instance.
 * @returns {void}
 */
export function setActiveTool(tool: Tool | null): void {
  cvState.activeTool = tool;
}

// ── DPR change watcher ──────────────────────────────────────────────────────

/** Watch for devicePixelRatio changes (e.g. window moved to a different-DPI monitor). */
function _watchDpr() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener('change', () => { resizeCanvas(); _watchDpr(); }, { once: true });
}

// ── Init ────────────────────────────────────────────────────────────────────

/**
 * Initialize the canvas view — binds events, sets up rendering, and starts the minimap.
 * @param {HTMLCanvasElement} canvasEl - The main editor canvas element.
 * @returns {void}
 */
export function init(canvasEl: HTMLCanvasElement): void {
  cvState.canvas = canvasEl;
  cvState.ctx = canvasEl.getContext('2d', { alpha: false, desynchronized: true });

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  // Re-render on DPR change (e.g. moving window between monitors with different scaling)
  _watchDpr();
  initMinimap(canvasEl);

  // Re-render when state changes (theme, features, metadata, etc.)
  subscribe(() => {
    // Always re-render on dirty flag (edits) or texturesVersion change (async texture loads)
    requestRender();
  }, 'canvas-view');

  canvasEl.addEventListener('mousedown', onMouseDown);
  canvasEl.addEventListener('mousemove', onMouseMove);
  canvasEl.addEventListener('mouseup', onMouseUp);
  canvasEl.addEventListener('mouseleave', onMouseLeave);
  canvasEl.addEventListener('mouseenter', restoreToolCursor);
  canvasEl.addEventListener('wheel', onWheel, { passive: false });
  canvasEl.addEventListener('contextmenu', e => e.preventDefault());

  requestRender();
}

// ── Utility exports ─────────────────────────────────────────────────────────

/**
 * Set the canvas cursor style.
 * @param {string} cursor - CSS cursor value (e.g. 'crosshair', 'default').
 * @returns {void}
 */
export function setCursor(cursor: string): void {
  if (cvState.canvas) cvState.canvas.style.cursor = cursor;
}

/**
 * Get the current logical (CSS) canvas dimensions.
 * @returns {{ width: number, height: number }} Canvas width and height in CSS pixels.
 */
export function getCanvasSize(): { width: number; height: number } {
  return { width: cvState._canvasW || (cvState.canvas?.width ?? 0), height: cvState._canvasH || (cvState.canvas?.height ?? 0) };
}

// ── Re-exports ──────────────────────────────────────────────────────────────
// Every function that was previously exported from this file is re-exported here
// so that no other file in the codebase needs import path changes.

export { requestRender, resizeCanvas, getTransform };
export { zoomToFit, panToLevel };
