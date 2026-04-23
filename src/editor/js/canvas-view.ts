// Canvas element management, pan/zoom, mouse event routing
// This is the orchestrator module — it wires together the sub-modules and
// re-exports the full public API so no other file needs import changes.

import type { Tool } from './tools/tool-base.js';
import type { Theme } from '../../types.js';
import state, { subscribe, getTheme, invalidateThemeCache } from './state.js';
import { initMinimap } from './minimap.js';
import {
  diffThemeBuckets,
  cloneTheme,
  invalidateFluidCache,
  invalidateBlendLayerCache,
  invalidateVisibilityCache,
} from '../../render/index.js';
import { invalidateDecorationCache } from './decoration-cache.js';

// ── Sub-module imports ──────────────────────────────────────────────────────
import { cvState, ANIM_INTERVAL_MS, isInteracting, getMapCache, getCachedBgImage } from './canvas-view-state.js';
import { requestRender, resizeCanvas, getTransform, setTickAnimLoopRef } from './canvas-view-render.js';
import { onMouseDown, onMouseMove, onMouseUp, onMouseLeave, onWheel, restoreToolCursor } from './canvas-view-input.js';
import { zoomToFit, panToLevel } from './canvas-view-viewport.js';

// ── Cache management ────────────────────────────────────────────────────────

/**
 * Force the offscreen map cache to rebuild on next frame.
 * @returns {void}
 */
export function invalidateMapCache(): void {
  getMapCache().invalidate();
}

/**
 * Invalidate only the grid layer of the map cache.
 * @returns {void}
 */
export function invalidateGridCache(): void {
  getMapCache().invalidateGrid();
}

/**
 * Deep-clone the current resolved theme so callers can diff against it after
 * a mutation. Pair with {@link applyThemeChange}.
 */
export function snapshotCurrentTheme(): Theme {
  return cloneTheme(getTheme());
}

/**
 * Apply a theme change by diffing the new theme against a prior snapshot and
 * invalidating only the caches affected by the property buckets that changed.
 *
 * Flow:
 *   1. Evict the normalized-theme cache so {@link getTheme} re-normalizes.
 *   2. Diff the new normalized theme against `prev`.
 *   3. Route each changed bucket to its dedicated invalidator.
 *
 * Routing table:
 *
 *   | Bucket        | Caches busted                     | MapCache path         |
 *   |---------------|-----------------------------------|------------------------|
 *   | floors        | (none)                            | full cells rebuild     |
 *   | blend         | blend layer                       | full cells rebuild     |
 *   | fluid         | fluid tile + clip caches          | composite-only         |
 *   | walls         | (none)                            | top-only rebuild       |
 *   | grid          | (none)                            | top-only rebuild       |
 *   | hatch         | (none — composite sublayer)       | composite rebuild      |
 *   | shading       | (none — composite sublayer)       | composite rebuild      |
 *   | labels        | (none)                            | composite rebuild      |
 *   | lava-light    | lighting visibility               | composite (via lights) |
 *   | decorations   | (none — drawn per-frame)          | none                   |
 *
 * `floors` / `blend` rebuild the base cells pass (floors / blending /
 * bridges); walls / grid / props rebuild ONLY the top cells pass. `fluid`
 * no longer touches cells at all — it lives in a dedicated composite
 * sublayer driven by `buildFluidComposite`.
 *
 * Pass `null` for `prev` to force a full invalidation (e.g. first load or
 * fallback when no snapshot is available).
 *
 * Theme changes apply to the whole map, so there is no dirty-region
 * bookkeeping — every bucket's invalidator operates map-wide.
 */
export function applyThemeChange(prev: Theme | null): void {
  invalidateThemeCache();
  const next = getTheme();
  // Theme color changes feed into cached decoration bitmaps (title, compass,
  // scale indicator); blow them away so the next frame re-bakes with the new
  // colors. Cheap — it's just clearing a map + nulling a field.
  invalidateDecorationCache();

  if (prev === null) {
    const cache = getMapCache();
    cache.invalidate();
    invalidateFluidCache();
    invalidateBlendLayerCache();
    invalidateVisibilityCache('lights');
    return;
  }

  const buckets = diffThemeBuckets(prev, next);
  if (buckets.size === 0) return;

  // Targeted auxiliary cache busts — each bucket owns exactly one cache,
  // so a non-fluid edit never busts the fluid cache, etc. Note: the fluid
  // tile cache is keyed on color signature, so it auto-rebuilds on next
  // lookup — we only need to flag the MapCache composite as dirty.
  if (buckets.has('blend')) invalidateBlendLayerCache();
  if (buckets.has('lava-light')) invalidateVisibilityCache('lights');

  const cache = getMapCache();

  // Base phases (floors / blending / bridges) are rasterized into the
  // cells-base canvas, so a change here requires a full cells rebuild.
  const needsCellsRebuild: boolean = buckets.has('floors') || buckets.has('blend');

  // Top phases (walls / grid / props / hazard) live in the cells-top
  // canvas, which can be repainted without touching base or fluid.
  const needsTopPhasesRebuild: boolean = !needsCellsRebuild && (buckets.has('walls') || buckets.has('grid'));

  // Everything else (hatch / shading / labels / lava-light) only touches
  // sublayers composited on top of the cells canvas — composite-only.
  // `fluid` routes here now: its tile cache was invalidated above, and the
  // fluid composite rebuilds inside `_buildComposite` via its signature.
  const needsCompositeRebuild: boolean =
    !needsCellsRebuild &&
    !needsTopPhasesRebuild &&
    (buckets.has('hatch') ||
      buckets.has('shading') ||
      buckets.has('labels') ||
      buckets.has('lava-light') ||
      buckets.has('fluid'));

  if (needsCellsRebuild) {
    cache.invalidate();
  } else if (needsTopPhasesRebuild) {
    cache.invalidateGrid();
  } else if (needsCompositeRebuild) {
    cache.invalidateComposite();
  }
  // `decorations` bucket alone → no cache work; a render tick repaints
  // the border/compass on top of the existing cache.
}

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
  // Suspend animation while the user is mid-zoom or mid-pan. During interaction,
  // every rAF hits the lightmap cache short-circuit (one cheap drawImage),
  // keeping the viewport responsive on maps with many animated lights. Visual
  // masking hides the paused flicker — the brain doesn't notice. Animation
  // resumes within INTERACTION_QUIET_MS of the user stopping.
  if (!isInteracting()) {
    state.animClock = performance.now() / 1000;
    requestRender();
  }
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

// Stop the animation loop on page unload so the timer (which captures
// `state` and the render functions in its closure) doesn't keep the editor
// context alive in memory after the tab is closed. Also pause it on
// visibilitychange — backgrounded tabs don't need light flicker animation
// and the wakeups thrash CPU on laptops.
//
// Guarded against the Node test harness which exposes `window` and `document`
// as plain objects without addEventListener.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', () => {
    stopAnimLoop();
  });
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopAnimLoop();
    } else if (state.dungeon.metadata.lightingEnabled) {
      startAnimLoop();
    }
  });
}

// ── Public API setters ──────────────────────────────────────────────────────

/**
 * Set the session overlay render and click handler functions.
 * @param {Function|null} renderFn - Render callback for session overlay (doors/stairs buttons).
 * @param {Function|null} clickFn - Click handler for session overlay hit testing.
 * @returns {void}
 */
export function setSessionOverlay(
  renderFn: ((...args: unknown[]) => void) | null,
  clickFn: ((...args: unknown[]) => boolean) | null,
): void {
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
 * Set the weather-group overlay render callback. Rendered above floors, below
 * walls — shows which cells belong to which weather group (editor only).
 */
export function setWeatherOverlay(fn: ((...args: unknown[]) => void) | null): void {
  cvState.weatherOverlayFn = fn;
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
  mq.addEventListener(
    'change',
    () => {
      resizeCanvas();
      _watchDpr();
    },
    { once: true },
  );
}

// ── Init ────────────────────────────────────────────────────────────────────

/**
 * Initialize the canvas view — binds events, sets up rendering, and starts the minimap.
 * @param {HTMLCanvasElement} canvasEl - The main editor canvas element.
 * @returns {void}
 */
export function init(canvasEl: HTMLCanvasElement): void {
  cvState.canvas = canvasEl;
  // `desynchronized: true` was meant to cut input latency, but on some GPU
  // drivers (notably Windows + NVIDIA) it causes cross-queue stalls when
  // drawing from large offscreen canvases — every frame pays a multi-hundred-ms
  // GPU wait. `alpha: false` alone is still a meaningful perf win.
  cvState.ctx = canvasEl.getContext('2d', { alpha: false });

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
  canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());

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
  return {
    width: cvState._canvasW || (cvState.canvas?.width ?? 0),
    height: cvState._canvasH || (cvState.canvas?.height ?? 0),
  };
}

// ── Re-exports ──────────────────────────────────────────────────────────────
// Every function that was previously exported from this file is re-exported here
// so that no other file in the codebase needs import path changes.

export { requestRender, resizeCanvas, getTransform };
export { zoomToFit, panToLevel };
