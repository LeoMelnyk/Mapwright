// Shared mutable state for the canvas-view module family.
// All canvas-view-*.js files import this object and mutate it directly.
import { MapCache } from '../../render/index.js';

export const CELL_SIZE = 40; // pixels per cell at zoom=1
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 5.0;
export const PAN_THRESHOLD = 5; // pixels before a right-click becomes a pan
export const ANIM_INTERVAL_MS = 50; // 20fps — sufficient for fire/pulse, avoids 60fps render spam

/**
 * Central mutable state object shared across canvas-view sub-modules.
 * Imported as `cvState` and mutated in place.
 */
export const cvState = {
  // Canvas / context
  canvas: null,
  ctx: null,

  // HiDPI / devicePixelRatio support
  _dpr: 1,       // window.devicePixelRatio (updated on resize)
  _canvasW: 0,   // CSS/logical canvas width
  _canvasH: 0,   // CSS/logical canvas height

  // Active tool reference (set by main.js)
  activeTool: null,

  // Session tool (e.g., range detector — receives full mouse events in session mode)
  sessionTool: null,
  // Persistent range tool reference — always rendered when session is active so
  // remote (player) range highlights are visible even in door mode.
  sessionRangeTool: null,

  // Session overlay callback (set by dm-session.js)
  sessionOverlayFn: null,
  sessionClickFn: null,

  // DM fog overlay callback (always rendered when session active, regardless of active panel)
  dmFogOverlayFn: null,

  // Pan state
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  panStartPanX: 0,
  panStartPanY: 0,

  // Right-click: pan if dragged, erase if just clicked
  rightDown: false,
  rightStartX: 0,
  rightStartY: 0,
  rightStartPanX: 0,
  rightStartPanY: 0,
  rightDragged: false,

  // Hover tracking
  _lastHoveredCell: null,  // tracks hovered cell to avoid redundant renders on mouse-move

  // Animation loop
  animFrameId: null,
  animLoopId: null,  // separate handle for the continuous animation loop

  // Background cell measure drag state
  _bgMeasureActive: false,
  _bgMeasureCallback: null, // (newPixelsPerCell: number) => void
  _bgMeasureStart: null,    // { x, y } canvas coords
  _bgMeasureEnd: null,      // { x, y } canvas coords

  // Render scheduling
  _renderScheduled: false,

  // Draw time tracking
  lastDrawMs: 0,
};

// ── Offscreen map cache ─────────────────────────────────────────────────────
// renderCells is expensive (thousands of GPU commands). We render it once to an
// offscreen canvas when the map data changes, then blit the cached image on every
// frame. Pan/zoom becomes a single drawImage instead of re-rendering all cells.
let _mapCache = null; // created lazily on first use (avoids module init order issues)

/**
 * Get or lazily create the offscreen map cache singleton.
 * @returns {MapCache} The shared map cache instance.
 */
export function getMapCache(): any {
  if (!_mapCache) _mapCache = new MapCache({ pxPerFoot: 20, maxCacheDim: 16384 });
  return _mapCache;
}

// Cache for background image HTMLImageElement — avoids recreating every frame
let _bgImgCache = { dataUrl: null, el: null };
/**
 * Get or create a cached HTMLImageElement for the background image data URL.
 * @param {string} dataUrl - The data URL of the background image.
 * @returns {HTMLImageElement} The cached image element.
 */
export function getCachedBgImage(dataUrl: string): HTMLImageElement {
  if (_bgImgCache.dataUrl !== dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    _bgImgCache = { dataUrl, el: img };
  }
  return _bgImgCache.el;
}

// Dedup render warnings with 30s cooldown
export const _shownWarnings = new Set();

// FPS tracking
export const fpsState = {
  _fpsFrames: 0,
  _fpsLastTime: 0,
  _fpsValue: 0,
  _lastFrameEnd: 0,
  _frameGapMs: 0,
  _postFrameBusyMs: 0, // time main thread stays busy after render() returns
};

// Raw rAF rate counter (independent of render calls)
export const rafProbe = {
  _rafProbeCount: 0,
  _rafProbeStart: 0,
  _rafProbeHz: 0,
};

if (typeof requestAnimationFrame === 'function') {
  (function probeRAF() {
    rafProbe._rafProbeCount++;
    const now = performance.now();
    if (!rafProbe._rafProbeStart) rafProbe._rafProbeStart = now;
    if (now - rafProbe._rafProbeStart >= 1000) {
      rafProbe._rafProbeHz = rafProbe._rafProbeCount;
      rafProbe._rafProbeCount = 0;
      rafProbe._rafProbeStart = now;
    }
    requestAnimationFrame(probeRAF);
  })();
}

// Debug: skip specific render phases to isolate GPU bottleneck.
// Set via console: window._skipPhases = { shading: true, lighting: true }
if (typeof window !== 'undefined') window._skipPhases = {};
