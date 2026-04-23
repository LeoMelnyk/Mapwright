// Shared mutable state for the canvas-view module family.
// All canvas-view-*.js files import this object and mutate it directly.
import type { Tool } from './tools/tool-base.js';
import { MapCache } from '../../render/index.js';

export const CELL_SIZE = 40; // pixels per cell at zoom=1
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 5.0;
export const PAN_THRESHOLD = 5; // pixels before a right-click becomes a pan
// Animation tick rate. Each tick triggers a lightmap rebuild for animated
// lights, so this directly trades CPU/GPU cost against animation smoothness.
// 50ms (20fps) is enough headroom for fast strobes/sweeps; the heavier per-
// rebuild cost is mitigated by `INTERACTION_QUIET_MS` below — animation is
// suspended while the user is actively zooming/panning.
export const ANIM_INTERVAL_MS = 50;

/**
 * How long after the last zoom event before animation resumes ticking.
 * During zoom, every rAF hits the lightmap cache short-circuit (one cheap
 * drawImage with multiply at the new dest rect) instead of rebuilding the
 * animated overlay — keeping the wheel-zoom responsive on maps with many
 * animated lights. 150ms is below the perceptual threshold for "is the
 * flame frozen?" — the brain reads the resumed flicker as continuous.
 *
 * Pan does NOT throttle animation: pan keeps the destination rect size
 * constant, the multiply-blend GPU framebuffer can be reused across frames,
 * and there's no measurable pan-time perf hit even with full animation.
 */
export const INTERACTION_QUIET_MS = 150;

/**
 * Central mutable state object shared across canvas-view sub-modules.
 * Imported as `cvState` and mutated in place.
 */
export const cvState: {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  _dpr: number;
  _canvasW: number;
  _canvasH: number;
  activeTool: Tool | null;
  sessionTool: Tool | null;
  sessionRangeTool: Tool | null;
  sessionOverlayFn: ((ctx: CanvasRenderingContext2D, ...args: unknown[]) => void) | null;
  sessionClickFn: ((px: number, py: number, transform: unknown, gridSize: number) => boolean) | null;
  dmFogOverlayFn: ((ctx: CanvasRenderingContext2D, ...args: unknown[]) => void) | null;
  weatherOverlayFn: ((ctx: CanvasRenderingContext2D, ...args: unknown[]) => void) | null;
  isPanning: boolean;
  panStartX: number;
  panStartY: number;
  panStartPanX: number;
  panStartPanY: number;
  rightDown: boolean;
  rightStartX: number;
  rightStartY: number;
  rightStartPanX: number;
  rightStartPanY: number;
  rightDragged: boolean;
  _lastHoveredCell: { row: number; col: number } | null;
  animFrameId: number | null;
  animLoopId: ReturnType<typeof setInterval> | null;
  _bgMeasureActive: boolean;
  _bgMeasureCallback: ((newPixelsPerCell: number) => void) | null;
  _bgMeasureStart: { x: number; y: number } | null;
  _bgMeasureEnd: { x: number; y: number } | null;
  _renderScheduled: boolean;
  lastDrawMs: number;

  // Zoom-only short-circuit tracking (Fix 1)
  _lastRenderSig: {
    contentVersion: number;
    topContentVersion: number;
    geometryVersion: number;
    lightingVersion: number;
    propsVersion: number;
    texturesVersion: number;
    canvasW: number;
    canvasH: number;
    ambientLight: number;
    ambientColor: string;
  } | null;

  // Cached animated lightmap bitmap (Fix 3). Rendered at map-cache resolution;
  // reused across frames when only the viewport transform changes.
  _animLm: {
    canvas: HTMLCanvasElement | OffscreenCanvas | null;
    sig: string;
    cacheW: number;
    cacheH: number;
  };

  // Coalesced wheel input (Fix 2). Accumulated inside onWheel, flushed in rAF.
  _pendingWheel: { deltaY: number; posX: number; posY: number } | null;

  /**
   * Monotonic timestamp (ms, performance.now()) of the most recent zoom
   * event. Animation tick is suppressed while
   * `now - _lastInteractionAt < INTERACTION_QUIET_MS`, keeping zoom snappy
   * on maps with many animated lights. Pan deliberately does NOT bump this
   * — pan has no measurable perf hit and pausing animation during pan would
   * just be needlessly jarring.
   */
  _lastInteractionAt: number;
} = {
  // Canvas / context
  canvas: null,
  ctx: null,

  // HiDPI / devicePixelRatio support
  _dpr: 1, // window.devicePixelRatio (updated on resize)
  _canvasW: 0, // CSS/logical canvas width
  _canvasH: 0, // CSS/logical canvas height

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

  // Weather group overlay callback (renders colored tint over cells assigned to weather groups)
  weatherOverlayFn: null,

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
  _lastHoveredCell: null, // tracks hovered cell to avoid redundant renders on mouse-move

  // Animation loop
  animFrameId: null,
  animLoopId: null, // separate handle for the continuous animation loop

  // Background cell measure drag state
  _bgMeasureActive: false,
  _bgMeasureCallback: null, // (newPixelsPerCell: number) => void
  _bgMeasureStart: null, // { x, y } canvas coords
  _bgMeasureEnd: null, // { x, y } canvas coords

  // Render scheduling
  _renderScheduled: false,

  // Draw time tracking
  lastDrawMs: 0,

  // Zoom-only short-circuit tracking (Fix 1)
  _lastRenderSig: null,

  // Cached animated lightmap bitmap (Fix 3)
  _animLm: { canvas: null, sig: '', cacheW: 0, cacheH: 0 },

  // Coalesced wheel input (Fix 2)
  _pendingWheel: null,

  // Interaction throttle (Fix 4). Set to performance.now() by wheel/pan
  // handlers; checked by tickAnimLoop to suspend animation during interaction.
  _lastInteractionAt: 0,
};

/** Mark a zoom event as having just happened. Called from `onWheel`. */
export function noteInteraction(): void {
  cvState._lastInteractionAt = performance.now();
}

/** True when the user is mid-zoom (wheel event within the quiet window). */
export function isInteracting(): boolean {
  return performance.now() - cvState._lastInteractionAt < INTERACTION_QUIET_MS;
}

// ── Offscreen map cache ─────────────────────────────────────────────────────
// renderCells is expensive (thousands of GPU commands). We render it once to an
// offscreen canvas when the map data changes, then blit the cached image on every
// frame. Pan/zoom becomes a single drawImage instead of re-rendering all cells.
let _mapCache: MapCache | null = null; // created lazily on first use (avoids module init order issues)

/**
 * Get or lazily create the offscreen map cache singleton.
 * @returns {MapCache} The shared map cache instance.
 */
export function getMapCache(): MapCache {
  _mapCache ??= new MapCache({ pxPerFoot: 20, maxCacheDim: 16384 });
  return _mapCache;
}

// Cache for background image HTMLImageElement — avoids recreating every frame
let _bgImgCache: { dataUrl: string | null; el: HTMLImageElement | null } = { dataUrl: null, el: null };
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
  return _bgImgCache.el!;
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
if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>)._skipPhases = {};
