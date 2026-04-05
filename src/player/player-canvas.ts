// Player view canvas: render loop, pan/zoom, fog overlay, tool interaction.
//
// Caching strategy (two layers):
//
// 1. FULL MAP CACHE (expensive, built once on session init behind loading screen)
//    Pre-renders the entire map with ALL cells visible (secrets as walls, labels
//    stripped).  Textures, blending, lighting, props — everything baked in.
//    Only rebuilt on structural changes: session init, dungeon update, door/stair
//    open, texture/catalog load.
//
// 2. FOG OVERLAY (cheap, rebuilt on every fog reveal/conceal)
//    Opaque black canvas with transparent holes for revealed cells, plus
//    hatching/shading drawn at fog boundaries.  The shading functions are fast
//    (Path2D geometry + stroke) compared to the full render pipeline.
//
// Each frame = three drawImage calls: full map → fog overlay → tool overlay.

import { renderCells, renderLabels, invalidateGeometryCache, invalidateFluidCache, invalidateVisibilityCache, invalidatePropsRenderLayer, invalidateAllCaches, invalidateLightmapCaches, renderLightmap, extractFillLights, MapCache, drawHatching, drawRockShading, drawOuterShading, renderTimings, patchBlendForDirtyRegion, patchFluidForDirtyRegion } from '../render/index.js';
import { buildPlayerCells, filterStairsForPlayer, filterBridgesForPlayer, filterPropsForPlayer, classifyAllTrimFog } from './fog.js';
import playerState from './player-state.js';
import { cellKey, displayGridSize as _dgs } from '../util/index.js';
import type { Cell, CellGrid, Theme, RenderTransform, VisibleBounds, OverlayProp } from '../types.js';

const CELL_SIZE = 40; // pixels per cell at zoom=1
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5.0;
const LERP_SPEED = 6; // higher = faster interpolation (units/sec style, used as factor per frame)
const ANIM_INTERVAL_MS = 50; // 20fps — matches editor animation rate

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let animFrameId: number | null = null;
let lastFrameTime: number = 0;
let _animClock: number = 0;
let _animLoopId: ReturnType<typeof setTimeout> | null = null;

// ── Diagnostics overlay (toggle with 'D' key) ──────────────────────────────
let _diagEnabled: boolean = false;
let _fpsFrames: number = 0;
let _fpsLastTime: number = 0;
let _fpsValue: number = 0;
let _lastFrameEnd: number = 0;
let _frameGapMs: number = 0;
let _lastFogRebuildMs: number = 0;
let _lastCacheBuildMs: number = 0;
let _cacheBuildCount: number = 0;
let _lastBuildType: string = 'none';       // 'full' | 'partial' | 'composite' | 'none'
let _lastBuildTimings: Record<string, number> = {};
let _fogRebuildCount: number = 0;
let _lastRevealMs: number = 0;
let _lastRevealCellCount: number = 0;

// Pan tracking
let isPanning: boolean = false;
let panStartX: number = 0, panStartY: number = 0;
let panStartPanX: number = 0, panStartPanY: number = 0;

// Touch tracking
let touchMode: 'pan' | 'tool' | 'pinch' | null = null;
let lastPinchDist: number = 0;
let pinchMidX: number = 0, pinchMidY: number = 0;

interface ToolLike {
  onActivate?(): void;
  onDeactivate?(): void;
  renderOverlay?(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number): void;
  onMouseDown(row: number, col: number, edge: unknown, e: Event, pos: { x: number; y: number }): void;
  onMouseMove(row: number, col: number, edge: unknown, e: Event, pos: { x: number; y: number }): void;
  onMouseUp(row: number, col: number, edge: unknown, e: Event, pos: { x: number; y: number }): void;
}

/**
 * For an open diagonal cell (diagonal wall, no trimCorner), determine which
 * half(s) should be fogged based on whether neighbors on each side are revealed.
 * Returns null if both sides revealed, or the half name ('ne','sw','nw','se') to fog.
 */
function _openDiagFogHalf(cell: Record<string, unknown>, r: number, c: number, revealedCells: Set<string>): string | null {
  const hasNWSE = !!cell['nw-se'];
  const hasNESW = !!cell['ne-sw'];
  if (!hasNWSE && !hasNESW) return null;

  // For nw-se diagonal: halves are 'ne' (upper-right) and 'sw' (lower-left)
  // For ne-sw diagonal: halves are 'nw' (upper-left) and 'se' (lower-right)
  let sideA: string, sideB: string, aDirs: [number, number][], bDirs: [number, number][];
  if (hasNWSE) {
    sideA = 'ne'; sideB = 'sw';
    aDirs = [[-1, 0], [0, 1]]; // neighbors on the NE side
    bDirs = [[1, 0], [0, -1]]; // neighbors on the SW side
  } else {
    sideA = 'nw'; sideB = 'se';
    aDirs = [[-1, 0], [0, -1]]; // neighbors on the NW side
    bDirs = [[1, 0], [0, 1]];   // neighbors on the SE side
  }

  const aRevealed = aDirs.some(([dr, dc]) => revealedCells.has(cellKey(r + dr, c + dc)));
  const bRevealed = bDirs.some(([dr, dc]) => revealedCells.has(cellKey(r + dr, c + dc)));

  if (aRevealed && bRevealed) return null;    // both sides revealed
  if (!aRevealed && !bRevealed) return null;  // neither — full cell fogged anyway
  return aRevealed ? sideB : sideA;           // fog the unrevealed half
}

/**
 * Trace the void triangle of a diagonal trim cell onto a canvas context.
 * The void corner determines which triangle to draw:
 *   nw → tl, tr, bl;  ne → tl, tr, br;  sw → tl, bl, br;  se → tr, bl, br
 */
function _traceDiagVoidTriangle(ctx: CanvasRenderingContext2D, voidCorner: string, px: number, py: number, size: number): void {
  const tl_x = px,        tl_y = py;
  const tr_x = px + size,  tr_y = py;
  const bl_x = px,        bl_y = py + size;
  const br_x = px + size,  br_y = py + size;
  switch (voidCorner) {
    case 'nw': ctx.moveTo(tl_x, tl_y); ctx.lineTo(tr_x, tr_y); ctx.lineTo(bl_x, bl_y); break;
    case 'ne': ctx.moveTo(tl_x, tl_y); ctx.lineTo(tr_x, tr_y); ctx.lineTo(br_x, br_y); break;
    case 'sw': ctx.moveTo(tl_x, tl_y); ctx.lineTo(bl_x, bl_y); ctx.lineTo(br_x, br_y); break;
    case 'se': ctx.moveTo(tr_x, tr_y); ctx.lineTo(bl_x, bl_y); ctx.lineTo(br_x, br_y); break;
  }
  ctx.closePath();
}

// Active tool (e.g., range detector)
let activeTool: ToolLike | null = null;
let toolDragging: boolean = false; // true when the tool has an active drag

// Cache for background image HTMLImageElement — avoids recreating every frame
let _bgImgCache: { dataUrl: string | null; el: HTMLImageElement | null } = { dataUrl: null, el: null };
function getCachedBgImage(dataUrl: string): HTMLImageElement | null {
  if (_bgImgCache.dataUrl !== dataUrl) {
    const img = new Image();
    img.onload = () => { invalidateFullMapCache(); requestRender(); };
    img.src = dataUrl;
    _bgImgCache = { dataUrl, el: img };
  }
  return _bgImgCache.el;
}

// ── Offscreen caches ────────────────────────────────────────────────────────
//
// Layer 1 — MAP CACHE (shared MapCache): entire map rendered with all cells
//   visible.  Built once on session init (behind loading screen).  Only
//   invalidated by structural changes (dungeon update, door/stair open).
//   Uses the same cache infrastructure as the editor — partial redraws,
//   content version tracking, cells + composite layers.
//
// Layer 2 — FOG OVERLAY: black fog mask with transparent holes.
//   Rebuilt on every fog reveal/conceal.  Cheap: just rect fills.
//   Does NOT touch the map cache.

// Use the DM's render quality (sent via session:init). Defaults to 20 (matches editor default).
function getMapPxPerFoot(): number { return playerState.renderQuality || 20; }

let _mapCache: MapCache | null = null;
function getMapCache(): MapCache {
  if (!_mapCache) _mapCache = new MapCache({ pxPerFoot: getMapPxPerFoot() });
  return _mapCache;
}
let _playerContentVersion: number = 0;
let _playerLightingVersion: number = 0;
let _cacheBuiltVersion: number = -1;
let _cacheBuiltLightingVersion: number = -1;
let _pendingDirtyRegion: VisibleBounds | null = null;
let _pendingStructuralChange: boolean = false;
let _pendingPreserveCells: boolean = false;
let _cachedFullCells: CellGrid | null = null;

interface OffscreenLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cacheW: number;
  cacheH: number;
}

interface ShadingLayer extends OffscreenLayer {
  sig: string;
}

interface HatchLayer extends OffscreenLayer {
  hatchSig: string;
}

let _fogOverlay: OffscreenLayer | null = null;
let _fogVersion: number = 0;
let _fogBuiltVersion: number = -1;

// ── Shading + hatching layers (build-once caches + fog-edge mask composites)
let _shadingLayer: ShadingLayer | null = null;
let _shadingComposite: OffscreenLayer | null = null;
let _hatchLayer: HatchLayer | null = null;
let _hatchComposite: OffscreenLayer | null = null;
let _fogEdgeMaskVersion: number = 0;
let _fogEdgeMaskDirty: number = 0;

// ── Walls overlay (walls + doors rendered above fog on revealed cells) ─────
// Persistent canvas — only walls from revealed cells are drawn. Updated
// incrementally when new cells are revealed; full rebuild on conceal.
let _wallsLayer: OffscreenLayer | null = null;
let _wallsCells: CellGrid | null = null;

/**
 * Force the map cache to rebuild.
 * @param dirtyRegion
 *   If provided, only the affected region is redrawn (partial rebuild).
 *   If null, the entire cache is rebuilt.
 * @param options.structural - true when walls/geometry changed
 */
export function invalidateFullMapCache(
  dirtyRegion: VisibleBounds | null = null,
  { structural = false }: { structural?: boolean } = {}
): void {
  _playerContentVersion++;
  _playerLightingVersion++;
  _fogVersion++;
  if (structural) _pendingStructuralChange = true;
  if (!dirtyRegion) _cachedFullCells = null;
  // Clear stale composites immediately so they don't render during the
  // deferred cache rebuild (e.g., after fog reset with empty revealedCells)
  _shadingComposite = null;
  _hatchComposite = null;
  if (dirtyRegion && _pendingDirtyRegion) {
    // Merge with any already-pending region
    _pendingDirtyRegion = {
      minRow: Math.min(_pendingDirtyRegion.minRow, dirtyRegion.minRow),
      maxRow: Math.max(_pendingDirtyRegion.maxRow, dirtyRegion.maxRow),
      minCol: Math.min(_pendingDirtyRegion.minCol, dirtyRegion.minCol),
      maxCol: Math.max(_pendingDirtyRegion.maxCol, dirtyRegion.maxCol),
    };
  } else if (dirtyRegion && !_pendingDirtyRegion) {
    _pendingDirtyRegion = { ...dirtyRegion };
  } else {
    // null region = full rebuild; wipes any pending partial
    _pendingDirtyRegion = null;
  }
}

/** Theme-only change — full map rebuild but skip fog and texture loading. */
export function invalidateThemeChange(): void {
  _playerContentVersion++;
  _playerLightingVersion++;
  _cachedFullCells = null;
  _shadingComposite = null;
  _hatchComposite = null;
  _pendingDirtyRegion = null; // full rebuild
}

/** Props-only change — cells rebuild needed (for props layer) but preserve cached cells/fluid. */
export function invalidatePropsChange(): void {
  _playerContentVersion++;
  _playerLightingVersion++;
  _pendingPreserveCells = true;
  // Don't clear _cachedFullCells — props don't change cell data, only metadata.props
}

/** Lighting-only change — composite rebuild only (cells layer stays cached). */
export function invalidateLightingOnly(): void {
  _playerLightingVersion++;
  // MapCache detects lightingVersion change → composite-only rebuild (no cells rebuild)
}

/**
 * Patch a secret door → normal door in the cached player cells.
 * In the cached cells, unopened secrets were converted to 'w' by buildPlayerCells.
 * We verify against the raw dungeon cells to confirm it was actually a secret door.
 * Call this BEFORE invalidateFullMapCache so the partial rebuild picks up the change.
 */
export function patchOpenedDoor(row: number, col: number, dir: string): void {
  if (!_cachedFullCells || !playerState.dungeon) return;
  const rawCells = playerState.dungeon.cells;
  const OPPOSITE: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
  const OFFSETS: Record<string, [number, number]> = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
  const cell = _cachedFullCells[row]?.[col] as Record<string, unknown> | null;
  if (cell && (rawCells[row]?.[col] as Record<string, unknown> | null)?.[dir] === 's') cell[dir] = 'd';
  const [dr, dc] = OFFSETS[dir] || [0, 0];
  const nr = row + dr, nc = col + dc;
  const opp = OPPOSITE[dir];
  const neighbor = _cachedFullCells[nr]?.[nc] as Record<string, unknown> | null;
  if (neighbor && (rawCells[nr]?.[nc] as Record<string, unknown> | null)?.[opp] === 's') neighbor[opp] = 'd';
}

/**
 * Clear all caches and the canvas. Called when the DM ends the session.
 */
export function clearAll(): void {
  // Flush all shared render-pipeline caches (geometry, fluid, blend, visibility, props, lightmap)
  invalidateAllCaches();
  invalidateLightmapCaches();
  invalidatePropsRenderLayer();
  getMapCache().dispose();
  _cachedFullCells = null;
  _playerContentVersion = 0;
  _playerLightingVersion = 0;
  _cacheBuiltVersion = -1;
  _cacheBuiltLightingVersion = -1;
  _pendingDirtyRegion = null;
  _pendingStructuralChange = false;
  _pendingPreserveCells = false;
  _fogOverlay = null;
  _fogVersion = 0;
  _fogBuiltVersion = -1;
  _fogEdgeMaskVersion = 0;
  _fogEdgeMaskDirty = 0;
  _shadingLayer = null;
  _hatchLayer = null;
  _shadingComposite = null;
  _hatchComposite = null;
  _wallsLayer = null;
  _wallsCells = null;
  _cacheBuilding = false;
  if (canvas && ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/** Rebuild only the fog overlay (fog reveal/conceal — no map cache rebuild). */
export function invalidateFogOverlay(): void { _fogVersion++; }

/**
 * Reset all fog-related layers without rebuilding the map cache.
 * Used on fog reset — clears fog overlay, composites, and walls layer.
 */
export function resetFogLayers(): void {
  _shadingComposite = null;
  _hatchComposite = null;
  _fogVersion++;           // triggers fog overlay rebuild (solid, no holes)
  _fogEdgeMaskDirty++;     // triggers composite rebuild (will no-op with empty revealedCells)
  rebuildWallsLayer();
}

/**
 * Incrementally update the fog overlay for newly revealed cells.
 * Avoids a full rebuild — just punches transparent holes in the existing mask.
 */
export function revealFogCells(cellKeys: string[]): void {
  const _t0 = performance.now();
  if (!_fogOverlay || !playerState.dungeon) return;
  const { cells, metadata } = playerState.dungeon;
  const gridSize = metadata.gridSize;
  const cellPx = gridSize * getMapPxPerFoot();
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const fCtx = _fogOverlay.ctx;
  const theme = resolveTheme();
  const fogColor = theme?.background || '#000000';

  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number);
    fCtx.clearRect(c * cellPx, r * cellPx, cellPx, cellPx);
  }

  // Refresh fog masks on neighboring open diagonal cells whose revealed state changed.
  // When both sides become revealed, the fog triangle is cleared; if still one-sided,
  // repaint the correct half.
  const refreshed = new Set<string>();
  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number);
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
      const nk = cellKey(nr, nc);
      if (refreshed.has(nk) || !playerState.revealedCells.has(nk)) continue;
      const cell = cells[nr]?.[nc] as Record<string, unknown> | null;
      if (!cell || cell.trimCorner || cell.trimClip) continue;
      if (!cell['nw-se'] && !cell['ne-sw']) continue;
      refreshed.add(nk);
      const px = nc * cellPx, py = nr * cellPx;
      // Reclear the whole cell, then re-fog the unrevealed half if needed
      fCtx.clearRect(px, py, cellPx, cellPx);
      const fogHalf = _openDiagFogHalf(cell, nr, nc, playerState.revealedCells);
      if (fogHalf) {
        fCtx.fillStyle = fogColor;
        fCtx.beginPath();
        _traceDiagVoidTriangle(fCtx, fogHalf, px, py, cellPx);
        fCtx.fill();
      }
    }
  }

  _fogBuiltVersion = _fogVersion;
  _fogEdgeMaskDirty++;
  revealWallsCells(cellKeys);
  _lastRevealMs = performance.now() - _t0;
  _lastRevealCellCount = cellKeys.length;
}

/**
 * Incrementally update the fog overlay for newly concealed cells.
 * Paints black back over the cells without a full rebuild.
 */
export function concealFogCells(cellKeys: string[]): void {
  if (!_fogOverlay || !playerState.dungeon) return;
  const gridSize = playerState.dungeon.metadata.gridSize;
  const cellPx = gridSize * getMapPxPerFoot();
  const fCtx = _fogOverlay.ctx;
  const theme = resolveTheme();
  fCtx.fillStyle = theme?.background || '#000000';
  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number);
    fCtx.fillRect(c * cellPx, r * cellPx, cellPx, cellPx);
  }
  _fogBuiltVersion = _fogVersion;
  _fogEdgeMaskDirty++;
  rebuildWallsLayer();
}

// ── Asset readiness gate ────────────────────────────────────────────────────
// The initial cache build waits until all async assets (prop catalog, texture
// catalog, and texture images) are loaded so the first render is complete.
let _assetsReady: boolean = false;
let _assetReadyCallbacks: (() => void)[] = [];

/** Called by player-main.js once all catalogs and textures are loaded. */
export function markAssetsReady(): void {
  _assetsReady = true;
  // Flush any pending cache build that was waiting
  for (const cb of _assetReadyCallbacks) cb();
  _assetReadyCallbacks = [];
}

// ── Loading overlay ─────────────────────────────────────────────────────────
let _loadingEl: HTMLElement | null = null;
let _cacheBuilding: boolean = false;  // true while an async cache build is in flight

function showLoadingOverlay(): void {
  if (!_loadingEl) _loadingEl = document.getElementById('loading-overlay');
  if (_loadingEl) _loadingEl.classList.remove('hidden');
}

function hideLoadingOverlay(): void {
  if (!_loadingEl) _loadingEl = document.getElementById('loading-overlay');
  if (_loadingEl) _loadingEl.classList.add('hidden');
}

/**
 * Schedule a full-map cache rebuild.  Only shows the loading overlay for the
 * very first build (no existing cache yet).  The initial build waits for all
 * assets (catalogs + textures) before running.  Subsequent rebuilds happen
 * silently — the existing cache displays while the new one builds.
 */
function scheduleCacheBuild(): void {
  if (_cacheBuilding) return;   // already queued
  _cacheBuilding = true;

  const isInitialBuild = !getMapCache().getComposite() || _cacheBuiltVersion === -1;
  if (isInitialBuild) showLoadingOverlay();

  // For the initial build, wait until assets are ready before doing the heavy work
  if (isInitialBuild && !_assetsReady) {
    _assetReadyCallbacks.push(() => {
      // Double-rAF so the overlay has time to paint
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          buildFullMapCache();
          _cacheBuilding = false;
          hideLoadingOverlay();
          requestRender();
        });
      });
    });
    return;
  }

  // Double-rAF: first rAF lets the overlay paint; second runs the heavy work
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      buildFullMapCache();
      _cacheBuilding = false;
      if (isInitialBuild) hideLoadingOverlay();
      requestRender();
    });
  });
}

export function setActiveTool(tool: ToolLike): void {
  if (activeTool?.onDeactivate) activeTool.onDeactivate();
  activeTool = tool;
  if (activeTool?.onActivate) activeTool.onActivate();
}

export function init(canvasEl: HTMLCanvasElement): void {
  canvas = canvasEl;
  ctx = canvas.getContext('2d')!;
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Toggle diagnostics overlay with 'D' key
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'd' || e.key === 'D') {
      _diagEnabled = !_diagEnabled;
      requestRender();
    }
  });

  // Mouse events for player pan/zoom + tool interaction
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());

  // Touch events for mobile/tablet support
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('touchcancel', onTouchEnd);

  requestRender();
}

function resizeCanvas(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  requestRender();
}

export function requestRender(): void {
  if (animFrameId) return;
  animFrameId = requestAnimationFrame(render);
}

function _hasAnimatedLights(): boolean {
  const lights = playerState.dungeon?.metadata?.lights;
  if (!lights) return false;
  // @ts-expect-error — strict-mode migration
  return lights.some((l: Record<string, unknown>) => (l.animation as Record<string, unknown>)?.type);
}

function _tickAnimLoop(): void {
  _animLoopId = null;
  const meta = playerState.dungeon?.metadata;
  if (!meta?.lightingEnabled) return;
  if (!_hasAnimatedLights()) return;
  _animClock = performance.now() / 1000;
  requestRender();
  _animLoopId = setTimeout(_tickAnimLoop, ANIM_INTERVAL_MS);
}

function _startAnimLoop(): void {
  if (_animLoopId) return;
  _animLoopId = setTimeout(_tickAnimLoop, ANIM_INTERVAL_MS);
}

function _stopAnimLoop(): void {
  if (_animLoopId) {
    clearTimeout(_animLoopId);
    _animLoopId = null;
  }
}

export function getTransform(): RenderTransform {
  if (!playerState.dungeon) return { offsetX: 0, offsetY: 0, scale: 1 };
  const { gridSize, resolution } = playerState.dungeon.metadata;
  const scale = CELL_SIZE * playerState.zoom / _dgs(gridSize, resolution);
  return { offsetX: playerState.panX, offsetY: playerState.panY, scale };
}

function pixelToCell(px: number, py: number, transform: RenderTransform, gridSize: number): { row: number; col: number } {
  const x = (px - transform.offsetX) / transform.scale;
  const y = (py - transform.offsetY) / transform.scale;
  return { row: Math.floor(y / gridSize), col: Math.floor(x / gridSize) };
}

function resolveTheme(): Theme | null {
  // Use the resolved theme sent by the DM (avoids empty THEMES lookup)
  if (playerState.resolvedTheme) return playerState.resolvedTheme;
  // Fallback: if dungeon metadata has an inline theme object
  const t = playerState.dungeon?.metadata?.theme;
  if (typeof t === 'object' && t !== null) return t as unknown as Theme;
  return null;
}

// ── Full-map cache builder ──────────────────────────────────────────────────
// Renders the entire map with ALL cells visible (secrets → walls, labels
// stripped) using the shared MapCache infrastructure.  Built once on session
// init.  Only rebuilt on structural changes (dungeon update, door/stair open).

function buildFullMapCache(): void {
  const _t0 = performance.now();
  const { dungeon } = playerState;
  if (!dungeon) return;
  const theme = resolveTheme();
  if (!theme) return;

  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  getMapCache().pxPerFoot = getMapPxPerFoot();
  if (!getMapCache().canCache(numRows, numCols, gridSize)) return;

  const isPartial = !!_pendingDirtyRegion;

  // For partial rebuilds, reuse the cached fullCells so reference-based caches
  // (fluid, geometry, blend) stay valid. Patch only the dirty cells in-place.
  if (isPartial && _cachedFullCells && _cachedFullCells.length === numRows) {
    const dr = _pendingDirtyRegion!;
    const PAD = 3;
    const rMin = Math.max(0, dr.minRow - PAD), rMax = Math.min(numRows - 1, dr.maxRow + PAD);
    const cMin = Math.max(0, dr.minCol - PAD), cMax = Math.min(numCols - 1, dr.maxCol + PAD);
    // Build opened-door lookup for secret door conversion
    const _OPP: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
    const _OFF: Record<string, [number, number]> = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
    const openedSet = new Set<string>();
    for (const d of playerState.openedDoors) {
      openedSet.add(`${d.row},${d.col},${d.dir}`);
      if (_OFF[d.dir]) {
        const [ddr, ddc] = _OFF[d.dir];
        openedSet.add(`${d.row + ddr},${d.col + ddc},${_OPP[d.dir]}`);
      }
    }

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const src = cells[r]?.[c];
        if (!src) { _cachedFullCells[r][c] = null; continue; }
        const pc: Record<string, unknown> = JSON.parse(JSON.stringify(src));
        // Apply same filtering as buildPlayerCells: secret doors, invisible walls
        for (const dir of ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw']) {
          if (pc[dir] === 's') {
            pc[dir] = openedSet.has(`${r},${c},${dir}`) ? 'd' : 'w';
          } else if (pc[dir] === 'iw' || pc[dir] === 'id') {
            delete pc[dir];
          }
        }
        // Strip labels (same as buildPlayerCells)
        const center = pc.center as Record<string, unknown> | undefined;
        if (center?.label) delete center.label;
        if (center?.dmLabel) delete center.dmLabel;
        delete center?.labelX; delete center?.labelY;
        delete center?.dmLabelX; delete center?.dmLabelY;
        if (center && Object.keys(center).length === 0) delete pc.center;
        _cachedFullCells[r][c] = pc as unknown as Cell;
      }
    }
  } else if (_pendingPreserveCells && _cachedFullCells && _cachedFullCells.length === numRows) {
    // Props/lighting-only change — reuse cached cells, skip geometry/fluid invalidation
  } else {
    // Full rebuild — create new cells array
    const allKeys = new Set<string>();
    for (let r = 0; r < numRows; r++)
      for (let c = 0; c < numCols; c++)
        allKeys.add(cellKey(r, c));
    _cachedFullCells = buildPlayerCells(dungeon, allKeys, playerState.openedDoors);
    invalidateGeometryCache();
    invalidateFluidCache();
  }
  const fullCells = _cachedFullCells!;

  // Always invalidate props + lighting caches (cheap flag resets — actual rebuild is lazy)
  invalidatePropsRenderLayer();
  // @ts-expect-error — strict-mode migration
  invalidateVisibilityCache('props');

  if (isPartial) {
    // Patch render caches for dirty region (avoids full rebuild)
    const textureOptions = playerState.textureCatalog
      ? { catalog: playerState.textureCatalog, blendWidth: (theme as Record<string, unknown>).textureBlendWidth ?? 0.35, texturesVersion: playerState.texturesVersion ?? 0 }
      : null;
    if (textureOptions) {
      patchBlendForDirtyRegion(_pendingDirtyRegion, fullCells, gridSize, textureOptions);
    }
    patchFluidForDirtyRegion(_pendingDirtyRegion, fullCells, gridSize, theme);
    // Structural changes (room placement, wall edits) need full lighting + geometry invalidation
    if (_pendingStructuralChange) {
      invalidateGeometryCache();
      invalidateVisibilityCache();
    }
  }

  // Build all-keys set for filter functions (all cells revealed in full map pre-render)
  const allKeys2 = new Set<string>();
  for (let r = 0; r < numRows; r++)
    for (let c = 0; c < numCols; c++)
      allKeys2.add(cellKey(r, c));

  // Include all stairs/bridges/props (everything visible)
  const fullStairs = filterStairsForPlayer(metadata.stairs, allKeys2, playerState.openedStairs);
  const fullBridges = filterBridgesForPlayer(metadata.bridges, allKeys2);
  const fullProps = filterPropsForPlayer((metadata as Record<string, unknown>).props as OverlayProp[] | undefined, allKeys2, gridSize, playerState.propCatalog);
  const fullMetadata = {
    ...metadata,
    stairs: fullStairs, bridges: fullBridges, props: fullProps,
    features: { ...metadata.features, showSubGrid: false },
  };

  const textureOptions = playerState.textureCatalog
    ? { catalog: playerState.textureCatalog, blendWidth: (theme as Record<string, unknown>).textureBlendWidth ?? 0.35, texturesVersion: playerState.texturesVersion ?? 0 }
    : null;

  const bgImgConfig = metadata.backgroundImage ?? null;
  const bgImageEl = bgImgConfig?.dataUrl ? getCachedBgImage(bgImgConfig.dataUrl) : null;

  const lightingEnabled = !!(fullMetadata.lightingEnabled && fullMetadata.lights?.length > 0);

  const _tCache0 = performance.now();
  getMapCache().update({
    contentVersion: _playerContentVersion,
    lightingVersion: _playerLightingVersion,
    texturesVersion: playerState.texturesVersion ?? 0,
    cells: fullCells,
    gridSize,
    theme,
    showGrid: metadata.features?.showGrid !== false,
    labelStyle: metadata.labelStyle || 'circled',
    propCatalog: playerState.propCatalog,
    textureOptions,
    metadata: fullMetadata,
    showInvisible: false,
    bgImageEl, bgImgConfig,
    lightingEnabled,
    hasAnimLights: lightingEnabled && _hasAnimatedLights(),
    lights: fullMetadata.lights,
    animClock: _animClock,
    lightPxPerFoot: 10,
    ambientLight: fullMetadata.ambientLight ?? 0.15,
    ambientColor: null,
    textureCatalog: playerState.textureCatalog,
    dirtyRegion: _pendingDirtyRegion,
    preRenderHook: null,
    skipPhases: { hatching: true, outerShading: true },
    skipLabels: lightingEnabled,
  });
  const _tCache1 = performance.now();

  _cacheBuiltVersion = _playerContentVersion;
  _cacheBuiltLightingVersion = _playerLightingVersion;
  const wasStructural = _pendingStructuralChange;
  const wasPreserveCells = _pendingPreserveCells;
  _pendingDirtyRegion = null;
  _pendingStructuralChange = false;
  _pendingPreserveCells = false;
  _cacheBuildCount++;

  const timings: Record<string, number> = { mapCache: _tCache1 - _tCache0 };
  _lastBuildType = isPartial ? 'partial' : wasPreserveCells ? 'props' : 'full';

  if (!isPartial && !wasPreserveCells) {
    let _t: number;
    _t = performance.now(); buildShadingLayer(fullCells, gridSize, theme);   timings.shading = performance.now() - _t;
    _t = performance.now(); buildHatchingLayer(fullCells, gridSize, theme);   timings.hatching = performance.now() - _t;
    _fogVersion++;
    _t = performance.now(); initWallsLayer();                                 timings.walls = performance.now() - _t;
  } else if (wasStructural) {
    // Structural partial change (room/wall edit) — rebuild walls overlay
    const _t = performance.now();
    initWallsLayer();
    timings.walls = performance.now() - _t;
  }

  timings.total = performance.now() - _t0;
  _lastCacheBuildMs = timings.total;
  _lastBuildTimings = timings;
}

// ── Fog overlay builder ─────────────────────────────────────────────────────
// Simple black mask with transparent holes for revealed cells.

function rebuildFogOverlay(): void {
  const _t0 = performance.now();
  const composite = getMapCache().getComposite();
  if (!playerState.dungeon || !composite) return;

  const gridSize = playerState.dungeon.metadata.gridSize;
  const cacheW = composite.cacheW;
  const cacheH = composite.cacheH;

  // Create / resize fog overlay canvas
  if (!_fogOverlay || _fogOverlay.cacheW !== cacheW || _fogOverlay.cacheH !== cacheH) {
    const offscreen = document.createElement('canvas');
    offscreen.width = cacheW;
    offscreen.height = cacheH;
    _fogOverlay = { canvas: offscreen, ctx: offscreen.getContext('2d')!, cacheW, cacheH };
  }

  const fCtx = _fogOverlay.ctx;

  // Theme-colored mask with transparent holes — instant to rebuild.
  // Hatching is handled by a separate layer that rebuilds asynchronously.
  const theme = resolveTheme();
  const fogColor = theme?.background || '#000000';
  fCtx.globalCompositeOperation = 'source-over';
  fCtx.fillStyle = fogColor;
  fCtx.fillRect(0, 0, cacheW, cacheH);

  const cellPx = gridSize * getMapPxPerFoot();
  const cells = playerState.dungeon.cells;

  // Step 1: Clear full rects for ALL revealed cells (no gaps at cell boundaries)
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number);
    fCtx.clearRect(c * cellPx, r * cellPx, cellPx, cellPx);
  }

  // Step 2: Paint fog color BACK over the unrevealed side of trim cells.
  // 2a: Arc trims (trimClip cells)
  const trimSides = classifyAllTrimFog(playerState.revealedCells, cells);
  for (const [key, side] of trimSides) {
    // @ts-expect-error — strict-mode migration
    if (side === 'both' || side === 'neither') continue;
    const [r, c] = key.split(',').map(Number);
    const cell = cells[r]?.[c] as Record<string, unknown> | null;
    const clip = (cell as Record<string, unknown>)?.trimClip as [number, number][];
    const px = c * cellPx, py = r * cellPx;
    fCtx.save();
    fCtx.fillStyle = fogColor;
    if (side === 'roomOnly') {
      // Paint fog over the exterior (cell rect minus trimClip via evenodd)
      fCtx.beginPath();
      fCtx.rect(px, py, cellPx, cellPx);
      fCtx.moveTo(px + clip[0][0] * cellPx, py + clip[0][1] * cellPx);
      for (let i = 1; i < clip.length; i++) {
        fCtx.lineTo(px + clip[i][0] * cellPx, py + clip[i][1] * cellPx);
      }
      fCtx.closePath();
      fCtx.fill('evenodd');
    } else {
      // exteriorOnly: paint fog over the room side (trimClip polygon)
      fCtx.beginPath();
      fCtx.moveTo(px + clip[0][0] * cellPx, py + clip[0][1] * cellPx);
      for (let i = 1; i < clip.length; i++) {
        fCtx.lineTo(px + clip[i][0] * cellPx, py + clip[i][1] * cellPx);
      }
      fCtx.closePath();
      fCtx.fill();
    }
    fCtx.restore();
  }

  // 2b: Diagonal trims (trimCorner without trimClip) — always fog the void triangle
  fCtx.fillStyle = fogColor;
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number);
    const cell = cells[r]?.[c] as Record<string, unknown> | null;
    if (!(cell as Record<string, unknown>)?.trimCorner || (cell as Record<string, unknown>)?.trimClip) continue;
    const px = c * cellPx, py = r * cellPx;
    fCtx.beginPath();
    _traceDiagVoidTriangle(fCtx, (cell as Record<string, unknown>).trimCorner as string, px, py, cellPx);
    fCtx.fill();
  }

  // 2c: Open diagonal trims (diagonal wall, no trimCorner) — fog the unrevealed half
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number);
    const cell = cells[r]?.[c] as Record<string, unknown> | null;
    if (!cell || cell.trimCorner || cell.trimClip) continue;
    const fogHalf = _openDiagFogHalf(cell, r, c, playerState.revealedCells);
    if (!fogHalf) continue;
    const px = c * cellPx, py = r * cellPx;
    fCtx.beginPath();
    _traceDiagVoidTriangle(fCtx, fogHalf, px, py, cellPx);
    fCtx.fill();
  }

  _fogBuiltVersion = _fogVersion;
  _lastFogRebuildMs = performance.now() - _t0;
  _fogRebuildCount++;
}

// ── Shading layer (build-once) ──────────────────────────────────────────────
// Renders the outer-shading halo for the entire map onto an offscreen canvas.
// Uses all-true roomCells so shading covers everywhere; the fog-edge mask
// controls visibility.  Only rebuilt if theme shading params change.

function shadingSig(theme: Theme, cacheW: number, cacheH: number): string {
  const s = (theme as Record<string, unknown>).outerShading as Record<string, unknown> | undefined;
  return `${cacheW},${cacheH},${s?.color},${s?.size},${s?.roughness}`;
}

function buildShadingLayer(fullCells: CellGrid, gridSize: number, theme: Theme): void {
  const composite = getMapCache().getComposite();
  const outerShading = (theme as Record<string, unknown>).outerShading as Record<string, unknown> | undefined;
  if (!composite || !outerShading?.color || !((outerShading?.size as number) > 0)) {
    _shadingLayer = null;
    return;
  }

  const { cacheW, cacheH } = composite;
  const sig = shadingSig(theme, cacheW, cacheH);
  if (_shadingLayer?.sig === sig) return;

  const offscreen = document.createElement('canvas');
  offscreen.width = cacheW;
  offscreen.height = cacheH;
  const sCtx = offscreen.getContext('2d')!;

  const cacheTransform: RenderTransform = { scale: getMapPxPerFoot(), offsetX: 0, offsetY: 0 };
  const numRows = fullCells.length;
  const numCols = fullCells[0]?.length || 0;
  const allRoom: boolean[][] = Array.from({ length: numRows }, () => Array(numCols).fill(true));
  drawOuterShading(sCtx, fullCells, allRoom, gridSize, theme, cacheTransform);

  _shadingLayer = { canvas: offscreen, ctx: sCtx, cacheW, cacheH, sig };
  _fogEdgeMaskVersion = -1;
}

// ── Hatching layer (build-once) ─────────────────────────────────────────────
// Renders hatching for the entire map onto an offscreen canvas. Only rebuilt
// if the theme's hatching-relevant values change (effectively once per session).

function hatchSig(theme: Theme, cacheW: number, cacheH: number): string {
  const t = theme as Record<string, unknown>;
  return `${cacheW},${cacheH},${t.hatchOpacity},${t.hatchSize},${t.hatchDistance},${t.hatchStyle},${t.hatchColor}`;
}

function buildHatchingLayer(fullCells: CellGrid, gridSize: number, theme: Theme): void {
  const composite = getMapCache().getComposite();
  if (!composite || !(theme as Record<string, unknown>).hatchOpacity) {
    _hatchLayer = null;
    return;
  }

  const { cacheW, cacheH } = composite;
  const sig = hatchSig(theme, cacheW, cacheH);
  if (_hatchLayer?.hatchSig === sig) return;

  const offscreen = document.createElement('canvas');
  offscreen.width = cacheW;
  offscreen.height = cacheH;
  const hCtx = offscreen.getContext('2d')!;

  // Transparent background — the shading layer below provides the backdrop
  const cacheTransform: RenderTransform = { scale: getMapPxPerFoot(), offsetX: 0, offsetY: 0 };
  const numRows = fullCells.length;
  const numCols = fullCells[0]?.length || 0;
  const allRoom: boolean[][] = Array.from({ length: numRows }, () => Array(numCols).fill(true));
  drawHatching(hCtx, fullCells, allRoom, gridSize, theme, cacheTransform);
  drawRockShading(hCtx, fullCells, allRoom, gridSize, theme, cacheTransform);

  _hatchLayer = { canvas: offscreen, ctx: hCtx, cacheW, cacheH, hatchSig: sig };
  _fogEdgeMaskVersion = -1;
}

// ── Walls overlay (incremental) ─────────────────────────────────────────────
// Persistent transparent canvas containing only walls/doors from revealed cells.
// Updated incrementally on reveal; full rebuild on conceal or structure change.

const _BORDER_DIRS: string[] = ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw'];
const _OPPOSITE: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
const _OFFSETS: Record<string, [number, number]> = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };

/** Clone a cell for the walls overlay, converting secret doors to walls/doors
 *  and stripping walls on the unrevealed side of open diagonal trims. */
function _wallsCellForPlayer(cell: Cell | null, r: number, c: number): Cell | null {
  if (!cell) return null;
  const pc: Record<string, unknown> = JSON.parse(JSON.stringify(cell));
  const openedSet = _wallsOpenedSet();
  for (const dir of _BORDER_DIRS) {
    if (pc[dir] === 's') {
      pc[dir] = openedSet.has(`${r},${c},${dir}`) ? 'd' : 'w';
    } else if (pc[dir] === 'iw' || pc[dir] === 'id') {
      delete pc[dir];
    }
  }

  // Open diagonal trims: strip walls on the unrevealed side
  const hasNWSE = !!pc['nw-se'];
  const hasNESW = !!pc['ne-sw'];
  if ((hasNWSE || hasNESW) && !pc.trimCorner && !pc.trimClip) {
    const revealed = playerState.revealedCells;
    let sideARevealed: boolean, sideBRevealed: boolean;
    if (hasNWSE) {
      sideARevealed = revealed.has(cellKey(r - 1, c)) || revealed.has(cellKey(r, c + 1));
      sideBRevealed = revealed.has(cellKey(r + 1, c)) || revealed.has(cellKey(r, c - 1));
    } else {
      sideARevealed = revealed.has(cellKey(r - 1, c)) || revealed.has(cellKey(r, c - 1));
      sideBRevealed = revealed.has(cellKey(r + 1, c)) || revealed.has(cellKey(r, c + 1));
    }
    if (sideARevealed !== sideBRevealed) {
      if (hasNWSE) {
        if (!sideARevealed) { delete pc.north; delete pc.east; }
        else                { delete pc.south; delete pc.west; }
      } else {
        if (!sideARevealed) { delete pc.north; delete pc.west; }
        else                { delete pc.south; delete pc.east; }
      }
    }
  }

  return pc as unknown as Cell;
}

/** Build the opened-door lookup set (cached per content version). */
let _wallsOpenedVersion: number = -1;
let _wallsOpenedCache: Set<string> = new Set();
function _wallsOpenedSet(): Set<string> {
  if (_wallsOpenedVersion === _playerContentVersion) return _wallsOpenedCache;
  _wallsOpenedCache = new Set();
  for (const d of playerState.openedDoors) {
    _wallsOpenedCache.add(`${d.row},${d.col},${d.dir}`);
    if (_OFFSETS[d.dir]) {
      const [dr, dc] = _OFFSETS[d.dir];
      _wallsOpenedCache.add(`${d.row + dr},${d.col + dc},${_OPPOSITE[d.dir]}`);
    }
  }
  _wallsOpenedVersion = _playerContentVersion;
  return _wallsOpenedCache;
}

const _wallsSkipPhases: Record<string, boolean> = {
  shading: true, hatching: true, floors: true, blending: true,
  fills: true, bridges: true, grid: true, props: true, hazard: true,
};

function initWallsLayer(): void {
  const composite = getMapCache().getComposite();
  if (!composite) { _wallsLayer = null; _wallsCells = null; return; }

  const { cacheW, cacheH } = composite;
  const { dungeon } = playerState;
  if (!dungeon) return;
  const { cells, metadata } = dungeon;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Create canvas + empty filtered cells grid
  const offscreen = document.createElement('canvas');
  offscreen.width = cacheW;
  offscreen.height = cacheH;
  _wallsLayer = { canvas: offscreen, ctx: offscreen.getContext('2d')!, cacheW, cacheH };
  _wallsCells = Array.from({ length: numRows }, () => Array(numCols).fill(null)) as CellGrid;

  // Populate with currently revealed cells and do an initial render
  if (playerState.revealedCells.size > 0) {
    for (const key of playerState.revealedCells) {
      const [r, c] = key.split(',').map(Number);
      if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
        _wallsCells[r][c] = _wallsCellForPlayer(cells[r][c], r, c);
      }
    }
    const theme = resolveTheme();
    if (theme) {
      const cacheTransform: RenderTransform = { scale: getMapPxPerFoot(), offsetX: 0, offsetY: 0 };
      renderCells(_wallsLayer.ctx, _wallsCells, metadata.gridSize, theme, cacheTransform, {
        metadata, skipPhases: _wallsSkipPhases, skipLabels: true,
      });
    }
  }
}

/** Incrementally add walls for newly revealed cells. */
function revealWallsCells(cellKeys: string[]): void {
  if (!_wallsLayer || !_wallsCells || !playerState.dungeon) return;
  const { cells, metadata } = playerState.dungeon;
  const gridSize = metadata.gridSize;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const theme = resolveTheme();
  if (!theme) return;

  // Update filtered cells and compute dirty bounding box
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number);
    if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
      _wallsCells[r][c] = _wallsCellForPlayer(cells[r][c], r, c);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }
  if (minR > maxR) return;

  // Re-process neighboring open diagonal cells whose revealed state may have changed
  // (e.g. walls need restoring now that both sides are revealed)
  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number);
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
      if (!_wallsCells[nr]?.[nc]) continue;
      const src = cells[nr]?.[nc];
      if (!src) continue;
      const srcAny = src as Record<string, unknown>;
      if ((srcAny['nw-se'] || srcAny['ne-sw']) && !srcAny.trimCorner && !srcAny.trimClip) {
        _wallsCells[nr][nc] = _wallsCellForPlayer(src, nr, nc);
      }
    }
  }

  // Render walls for dirty region (padded by 1 cell for wall strokes)
  const bounds: VisibleBounds = {
    minRow: Math.max(0, minR - 1),
    maxRow: Math.min(numRows - 1, maxR + 1),
    minCol: Math.max(0, minC - 1),
    maxCol: Math.min(numCols - 1, maxC + 1),
  };
  const cellPx = gridSize * getMapPxPerFoot();
  const wCtx = _wallsLayer.ctx;
  wCtx.save();
  wCtx.beginPath();
  wCtx.rect(bounds.minCol * cellPx, bounds.minRow * cellPx,
    (bounds.maxCol - bounds.minCol + 1) * cellPx,
    (bounds.maxRow - bounds.minRow + 1) * cellPx);
  wCtx.clip();
  wCtx.clearRect(0, 0, _wallsLayer.cacheW, _wallsLayer.cacheH);

  const cacheTransform: RenderTransform = { scale: getMapPxPerFoot(), offsetX: 0, offsetY: 0 };
  renderCells(wCtx, _wallsCells, gridSize, theme, cacheTransform, {
    metadata, skipPhases: _wallsSkipPhases, skipLabels: true,
    visibleBounds: bounds,
  });
  wCtx.restore();
}

/** Full rebuild — used on conceal or structure change. */
function rebuildWallsLayer(): void {
  _wallsLayer = null;
  _wallsCells = null;
  initWallsLayer();
}

// ── Fog-edge composites (shading + hatching) ───────────────────────────────
// Both layers share the same rounded Minkowski-sum mask around revealed cells.
// Rebuilt when fog changes.  The mask is built once per rebuild and applied to
// each layer canvas that has content.

function applyFogEdgeMask(ctx: CanvasRenderingContext2D, sourceCanvas: HTMLCanvasElement, cacheW: number, cacheH: number, cellPx: number, ballRadius: number): void {
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, cacheW, cacheH);
  ctx.drawImage(sourceCanvas, 0, 0);

  // Keep content only inside the rounded expanded region (Minkowski sum)
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number);
    const cx = (c + 0.5) * cellPx;
    const cy = (r + 0.5) * cellPx;
    ctx.moveTo(cx + ballRadius, cy);
    ctx.arc(cx, cy, ballRadius, 0, Math.PI * 2);
  }
  ctx.fill('nonzero');

  // Cut out revealed cells for a clean inner edge
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number);
    ctx.rect(c * cellPx, r * cellPx, cellPx, cellPx);
  }
  ctx.fill();

  // Paint hatching/shading BACK over the unrevealed side of trim cells
  const cells = playerState.dungeon?.cells;
  ctx.globalCompositeOperation = 'source-over';
  // Arc trims (trimClip cells)
  const trimSides = classifyAllTrimFog(playerState.revealedCells, cells!);
  for (const [key, side] of trimSides) {
    // @ts-expect-error — strict-mode migration
    if (side === 'both' || side === 'neither') continue;
    const [r, c] = key.split(',').map(Number);
    const cell = cells?.[r]?.[c] as Record<string, unknown> | null;
    const clip = cell?.trimClip as [number, number][];
    const px = c * cellPx, py = r * cellPx;
    if (side === 'roomOnly') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, cellPx, cellPx);
      ctx.moveTo(px + clip[0][0] * cellPx, py + clip[0][1] * cellPx);
      for (let i = 1; i < clip.length; i++) {
        ctx.lineTo(px + clip[i][0] * cellPx, py + clip[i][1] * cellPx);
      }
      ctx.closePath();
      ctx.clip('evenodd');
      ctx.drawImage(sourceCanvas, px, py, cellPx, cellPx, px, py, cellPx, cellPx);
      ctx.restore();
    } else {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(px + clip[0][0] * cellPx, py + clip[0][1] * cellPx);
      for (let i = 1; i < clip.length; i++) {
        ctx.lineTo(px + clip[i][0] * cellPx, py + clip[i][1] * cellPx);
      }
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(sourceCanvas, px, py, cellPx, cellPx, px, py, cellPx, cellPx);
      ctx.restore();
    }
  }

  // Diagonal trims (trimCorner without trimClip) — paint shading back over void triangle
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number);
    const cell = cells?.[r]?.[c] as Record<string, unknown> | null;
    if (!cell?.trimCorner || cell.trimClip) continue;
    const px = c * cellPx, py = r * cellPx;
    ctx.save();
    ctx.beginPath();
    _traceDiagVoidTriangle(ctx, cell.trimCorner as string, px, py, cellPx);
    ctx.clip();
    ctx.drawImage(sourceCanvas, px, py, cellPx, cellPx, px, py, cellPx, cellPx);
    ctx.restore();
  }

  // Open diagonal trims — paint shading back over the unrevealed half
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number);
    const cell = cells?.[r]?.[c] as Record<string, unknown> | null;
    if (!cell || cell.trimCorner || cell.trimClip) continue;
    const fogHalf = _openDiagFogHalf(cell, r, c, playerState.revealedCells);
    if (!fogHalf) continue;
    const px = c * cellPx, py = r * cellPx;
    ctx.save();
    ctx.beginPath();
    _traceDiagVoidTriangle(ctx, fogHalf, px, py, cellPx);
    ctx.clip();
    ctx.drawImage(sourceCanvas, px, py, cellPx, cellPx, px, py, cellPx, cellPx);
    ctx.restore();
  }
}

function ensureComposite(existing: OffscreenLayer | null, cacheW: number, cacheH: number): OffscreenLayer {
  if (existing?.cacheW === cacheW && existing?.cacheH === cacheH) return existing;
  const offscreen = document.createElement('canvas');
  offscreen.width = cacheW;
  offscreen.height = cacheH;
  return { canvas: offscreen, ctx: offscreen.getContext('2d')!, cacheW, cacheH };
}

function rebuildFogEdgeComposites(): void {
  const hasShading = !!_shadingLayer;
  const hasHatching = !!_hatchLayer;
  if (!hasShading && !hasHatching || !playerState.dungeon || playerState.revealedCells.size === 0) {
    _shadingComposite = null;
    _hatchComposite = null;
    _fogEdgeMaskVersion = _fogEdgeMaskDirty;
    return;
  }

  const theme = resolveTheme();
  if (!theme) {
    _fogEdgeMaskVersion = _fogEdgeMaskDirty;
    return;
  }

  const ref = _hatchLayer || _shadingLayer!;
  const { cacheW, cacheH } = ref;
  const gridSize = playerState.dungeon.metadata.gridSize;
  const cellPx = gridSize * getMapPxPerFoot();
  const MAX_DIST = Math.round(((theme as Record<string, unknown>).hatchDistance as number ?? 1) * 2);
  const ballRadius = cellPx * (0.5 + MAX_DIST);

  // Shading composite (below hatching)
  if (hasShading) {
    _shadingComposite = ensureComposite(_shadingComposite, cacheW, cacheH);
    applyFogEdgeMask(_shadingComposite.ctx, _shadingLayer!.canvas, cacheW, cacheH, cellPx, ballRadius);
  } else {
    _shadingComposite = null;
  }

  // Hatching composite (above shading)
  if (hasHatching && (theme as Record<string, unknown>).hatchOpacity) {
    _hatchComposite = ensureComposite(_hatchComposite, cacheW, cacheH);
    applyFogEdgeMask(_hatchComposite.ctx, _hatchLayer!.canvas, cacheW, cacheH, cellPx, ballRadius);
  } else {
    _hatchComposite = null;
  }

  _fogEdgeMaskVersion = _fogEdgeMaskDirty;
}

// ── Render loop ─────────────────────────────────────────────────────────────

function render(timestamp: number): void {
  animFrameId = null;
  if (!canvas || !playerState.dungeon) return;
  const theme = resolveTheme();
  if (!theme) return;

  // Tick viewport interpolation
  const dt = lastFrameTime ? Math.min((timestamp - lastFrameTime) / 1000, 0.1) : 0.016;
  lastFrameTime = timestamp;
  const viewportAnimating = tickViewportLerp(dt);

  const { dungeon } = playerState;
  const { metadata } = dungeon;
  const gridSize = metadata.gridSize;
  const transform = getTransform();

  // Clear to theme background (fog color)
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = theme.background || '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Ensure the full-map cache is up to date (expensive — loading screen on first build)
  if (_cacheBuiltVersion !== _playerContentVersion || _cacheBuiltLightingVersion !== _playerLightingVersion) {
    scheduleCacheBuild();
    // If we don't have an existing cache yet (initial build), bail — loading overlay is showing
    const composite = getMapCache().getComposite();
    if (!composite || _cacheBuiltVersion === -1) {
      if (viewportAnimating) requestRender();
      return;
    }
    // Otherwise keep drawing from the existing (stale but valid) cache while rebuilding
  }

  // Ensure the fog overlay is up to date (cheap — no loading screen)
  if (_fogBuiltVersion !== _fogVersion) {
    rebuildFogOverlay();
  }

  // Ensure the fog-edge composites (shading + hatching) are up to date
  if ((_shadingLayer || _hatchLayer) && _fogEdgeMaskVersion !== _fogEdgeMaskDirty) {
    rebuildFogEdgeComposites();
  }

  const composite = getMapCache().getComposite();
  if (composite && _fogOverlay) {
    // ── Cached path: two drawImage calls (map + fog) ──
    getMapCache().blit(ctx, transform);

    // ── Animated light overlay (screen-resolution, every frame) ──
    const fullMetadata = playerState.dungeon.metadata;
    if (fullMetadata.lightingEnabled && _hasAnimatedLights()) {
      const fullCells = playerState.dungeon.cells;
      const fillLights = extractFillLights(fullCells, gridSize, theme);
      const allLights = fillLights.length
        ? [...(fullMetadata.lights || []), ...fillLights]
        : (fullMetadata.lights || []);
      const sx2 = transform.scale / getMapPxPerFoot();
      const mapScreenW = composite.cacheW * sx2;
      const mapScreenH = composite.cacheH * sx2;
      renderLightmap(ctx, allLights, fullCells, gridSize,
        { scale: transform.scale, offsetX: 0, offsetY: 0 },
        Math.ceil(mapScreenW), Math.ceil(mapScreenH), fullMetadata.ambientLight ?? 0.15,
        playerState.textureCatalog, playerState.propCatalog,
        {
          ambientColor: (fullMetadata as Record<string, unknown>).ambientColor as string || '#ffffff', time: _animClock,
          lightPxPerFoot: 10,
          destX: transform.offsetX, destY: transform.offsetY,
          destW: mapScreenW, destH: mapScreenH,
        },
        fullMetadata);
    }

    // Fog mask (opaque black with transparent holes for revealed cells)
    const sx = transform.scale / getMapPxPerFoot();
    const dw = composite.cacheW * sx;
    const dh = composite.cacheH * sx;
    ctx.drawImage(_fogOverlay.canvas,
      transform.offsetX, transform.offsetY, dw, dh);

    // Shading layer (above fog, below hatching)
    if (_shadingComposite) {
      ctx.drawImage(_shadingComposite.canvas,
        transform.offsetX, transform.offsetY, dw, dh);
    }

    // Hatching layer (above shading, below walls overlay)
    if (_hatchComposite) {
      ctx.drawImage(_hatchComposite.canvas,
        transform.offsetX, transform.offsetY, dw, dh);
    }

    // Walls + doors overlay (only contains walls from revealed cells)
    if (_wallsLayer) {
      ctx.drawImage(_wallsLayer.canvas,
        transform.offsetX, transform.offsetY, dw, dh);
    }
  } else if (!composite) {
    // ── Fallback: direct render for huge maps that exceed GPU texture limits ──
    renderFallback(theme, gridSize, transform);
  }

  // Tool overlay (range detector highlights) — always on top
  if (activeTool?.renderOverlay) {
    activeTool.renderOverlay(ctx, transform, gridSize);
  }

  // ── Diagnostics overlay (press 'D' to toggle) ──
  const drawEnd = performance.now();
  if (_lastFrameEnd > 0) _frameGapMs = drawEnd - _lastFrameEnd;
  _lastFrameEnd = drawEnd;
  _fpsFrames++;
  const now = performance.now();
  if (now - _fpsLastTime >= 1000) {
    _fpsValue = _fpsFrames;
    _fpsFrames = 0;
    _fpsLastTime = now;
  }

  if (_diagEnabled) {
    drawDiagnostics(gridSize);
  }

  // Auto-manage animation loop based on animated lights
  const meta = playerState.dungeon?.metadata;
  if (meta?.lightingEnabled && _hasAnimatedLights()) {
    if (!_animLoopId) _startAnimLoop();
  } else if (_animLoopId) {
    _stopAnimLoop();
  }

  // Keep animating if viewport is interpolating
  if (viewportAnimating) requestRender();
}

/**
 * Fallback renderer for maps too large for the offscreen cache.
 * Uses the old per-frame buildPlayerCells + renderCells approach.
 */
function renderFallback(theme: Theme, gridSize: number, transform: RenderTransform): void {
  const { dungeon } = playerState;
  if (!dungeon) return;
  const { metadata } = dungeon;

  const playerCells = buildPlayerCells(dungeon, playerState.revealedCells, playerState.openedDoors);
  invalidateGeometryCache();

  const filteredStairs = filterStairsForPlayer(metadata.stairs, playerState.revealedCells, playerState.openedStairs);
  const filteredBridges = filterBridgesForPlayer(metadata.bridges, playerState.revealedCells);
  const filteredProps = filterPropsForPlayer((metadata as Record<string, unknown>).props as OverlayProp[] | undefined, playerState.revealedCells, gridSize, playerState.propCatalog);
  const playerMetadata = {
    ...metadata,
    stairs: filteredStairs, bridges: filteredBridges, props: filteredProps,
    features: { ...metadata.features, showSubGrid: false },
  };

  const textureOptions = playerState.textureCatalog
    ? { catalog: playerState.textureCatalog, blendWidth: (theme as Record<string, unknown>).textureBlendWidth ?? 0.35, texturesVersion: playerState.texturesVersion ?? 0 }
    : null;
  const bgImgConfig = metadata.backgroundImage ?? null;
  const bgImageEl = bgImgConfig?.dataUrl ? getCachedBgImage(bgImgConfig.dataUrl) : null;
  const lightingEnabled = !!(playerMetadata.lightingEnabled && playerMetadata.lights?.length > 0);

  renderCells(ctx, playerCells, gridSize, theme, transform, {
    showGrid: metadata.features?.showGrid !== false,
    labelStyle: metadata.labelStyle || 'circled',
    propCatalog: playerState.propCatalog, textureOptions,
    metadata: playerMetadata, skipLabels: lightingEnabled,
    bgImageEl, bgImgConfig,
  });

  if (lightingEnabled) {
    renderLightmap(ctx, playerMetadata.lights, playerCells, gridSize, transform,
      canvas.width, canvas.height, playerMetadata.ambientLight ?? 0.15,
      playerState.textureCatalog, playerState.propCatalog,
      { time: _animClock }, playerMetadata);
    renderLabels(ctx, playerCells, gridSize, theme, transform, metadata.labelStyle || 'circled');
  }
}

// ── Diagnostics overlay ─────────────────────────────────────────────────────

function drawDiagnostics(gridSize: number): void {
  const lines: { text: string; color: string }[] = [];
  const _col = (ms: number): string => ms < 2 ? '#8f8' : ms < 10 ? '#ff4' : '#f44';

  // Header
  lines.push({ text: `${_fpsValue} fps | gap: ${_frameGapMs.toFixed(0)}ms`, color: _fpsValue >= 55 ? '#4f4' : _fpsValue >= 30 ? '#ff4' : '#f44' });

  // Map info
  const { cells, metadata } = playerState.dungeon!;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  lines.push({ text: '', color: '#666' });
  lines.push({ text: '── Map ──', color: '#666' });
  lines.push({ text: `Grid: ${numRows}x${numCols} (${gridSize}ft)`, color: '#aaf' });
  lines.push({ text: `Props: ${(metadata as Record<string, unknown>).props ? ((metadata as Record<string, unknown>).props as unknown[]).length : 0} | Lights: ${metadata.lights?.length || 0}`, color: '#aaa' });
  lines.push({ text: `Revealed: ${playerState.revealedCells.size} / ${numRows * numCols} cells`, color: '#aaa' });

  // Caches
  lines.push({ text: '', color: '#666' });
  lines.push({ text: '── Caches ──', color: '#666' });
  const cacheStats = getMapCache().stats;
  if (cacheStats.cacheW) {
    lines.push({ text: `Map cache: ${cacheStats.cacheW}x${cacheStats.cacheH}px`, color: '#aaa' });
  }
  lines.push({ text: `Builds: ${_cacheBuildCount} (${cacheStats.cellsRebuilds} cells, ${cacheStats.compositeRebuilds} comp)`, color: '#aaa' });
  const typeColor: Record<string, string> = { full: '#f44', partial: '#ff4', composite: '#8f8', grid: '#8f8', none: '#666' };
  lines.push({ text: `Last: ${_lastBuildType} ${_lastCacheBuildMs.toFixed(0)}ms`, color: typeColor[_lastBuildType] || '#aaa' });
  if (cacheStats.lastRebuildType !== 'none') {
    lines.push({ text: `  MapCache: ${cacheStats.lastRebuildType} ${cacheStats.lastRebuildMs.toFixed(0)}ms`, color: typeColor[cacheStats.lastRebuildType] || '#aaa' });
  }
  const t = _lastBuildTimings;
  if (t.mapCache != null) {
    lines.push({ text: `  MapCache: ${t.mapCache.toFixed(0)}ms`, color: _col(t.mapCache) });
  }
  if (t.shading != null) lines.push({ text: `  shading layer: ${t.shading.toFixed(0)}ms`, color: _col(t.shading) });
  if (t.hatching != null) lines.push({ text: `  hatching layer: ${t.hatching.toFixed(0)}ms`, color: _col(t.hatching) });
  if (t.walls != null) lines.push({ text: `  walls layer: ${t.walls.toFixed(0)}ms`, color: _col(t.walls) });

  // Per-phase renderCells breakdown (from render pipeline timings)
  const phases = ['roomCells', 'shading', 'floors', 'blending', 'fills', 'bridges', 'grid', 'walls', 'props', 'hazard'];
  const hasPhaseData = phases.some(p => ((renderTimings as Record<string, { ms?: number }>)[p]?.ms ?? 0) > 0);
  if (hasPhaseData) {
    lines.push({ text: '', color: '#666' });
    lines.push({ text: '── renderCells ──', color: '#666' });
    for (const phase of phases) {
      const pt = (renderTimings as Record<string, { ms?: number }>)[phase];
      if (!pt) continue;
      const ms = pt.ms!;
      lines.push({ text: `  ${phase}: ${ms.toFixed(ms < 1 ? 1 : 0)}ms`, color: _col(ms) });
    }
  }

  // Fog overlay
  lines.push({ text: '', color: '#666' });
  lines.push({ text: '── Fog ──', color: '#666' });
  lines.push({ text: `Fog rebuilds: ${_fogRebuildCount}`, color: '#aaa' });
  lines.push({ text: `Last fog rebuild: ${_lastFogRebuildMs.toFixed(1)}ms`, color: _col(_lastFogRebuildMs) });
  if (_lastRevealCellCount > 0) {
    lines.push({ text: `Last reveal: ${_lastRevealCellCount} cells in ${_lastRevealMs.toFixed(1)}ms`, color: _col(_lastRevealMs) });
  }

  // WebSocket
  lines.push({ text: '', color: '#666' });
  lines.push({ text: '── Connection ──', color: '#666' });
  lines.push({ text: `WS: ${playerState.connected ? 'connected' : 'disconnected'}`, color: playerState.connected ? '#8f8' : '#f44' });
  lines.push({ text: `Follow DM: ${playerState.followDM ? 'yes' : 'no'}`, color: '#aaa' });

  // Memory
  const perfMemory = (performance as unknown as Record<string, unknown>).memory as { usedJSHeapSize: number; jsHeapSizeLimit: number } | undefined;
  if (perfMemory) {
    lines.push({ text: '', color: '#666' });
    lines.push({ text: '── Memory ──', color: '#666' });
    const mb = (b: number): string => (b / 1048576).toFixed(0);
    lines.push({ text: `Heap: ${mb(perfMemory.usedJSHeapSize)}MB / ${mb(perfMemory.jsHeapSizeLimit)}MB`, color: '#aaa' });
  }

  // Render the overlay
  ctx.font = '12px monospace';
  const lineH = 15;
  const pad = 8;
  const x = pad;
  let y = pad;

  for (const line of lines) {
    if (line.text === '') { y += 4; continue; }
    const tw = ctx.measureText(line.text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x - 2, y - 1, tw + 6, lineH);
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, x, y + 11);
    y += lineH;
  }
}

// ── Viewport sync with smooth interpolation ─────────────────────────────────

// Target values the viewport is lerping toward
let targetPanX: number = 0, targetPanY: number = 0, targetZoom: number = 1;
let isLerping: boolean = false;

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/**
 * Tick one frame of viewport interpolation. Returns true if still animating.
 */
function tickViewportLerp(dt: number): boolean {
  if (!isLerping) return false;

  const t = Math.min(1, LERP_SPEED * dt); // fraction to close this frame
  playerState.panX = lerp(playerState.panX, targetPanX, t);
  playerState.panY = lerp(playerState.panY, targetPanY, t);
  playerState.zoom = lerp(playerState.zoom, targetZoom, t);

  // Snap when close enough
  const dx = Math.abs(playerState.panX - targetPanX);
  const dy = Math.abs(playerState.panY - targetPanY);
  const dz = Math.abs(playerState.zoom - targetZoom);
  if (dx < 0.5 && dy < 0.5 && dz < 0.001) {
    playerState.panX = targetPanX;
    playerState.panY = targetPanY;
    playerState.zoom = targetZoom;
    isLerping = false;
    return false;
  }
  return true;
}

export function applyDMViewport(panX: number, panY: number, zoom: number, dmCanvasWidth: number, dmCanvasHeight: number): void {
  // Adjust pan so the same world-center on the DM's canvas is centered on ours
  const dmW = dmCanvasWidth || canvas.width;
  const dmH = dmCanvasHeight || canvas.height;
  const adjustedPanX = panX + (canvas.width - dmW) / 2;
  const adjustedPanY = panY + (canvas.height - dmH) / 2;

  playerState.dmPanX = adjustedPanX;
  playerState.dmPanY = adjustedPanY;
  playerState.dmZoom = zoom;

  if (playerState.followDM) {
    targetPanX = adjustedPanX;
    targetPanY = adjustedPanY;
    targetZoom = zoom;
    isLerping = true;
    requestRender();
  }
}

/**
 * Snap viewport directly (no interpolation) — used for initial sync.
 */
export function snapToDMViewport(): void {
  const px = playerState.dmPanX;
  const py = playerState.dmPanY;
  const z = playerState.dmZoom;
  playerState.panX = px;
  playerState.panY = py;
  playerState.zoom = z;
  targetPanX = px;
  targetPanY = py;
  targetZoom = z;
  isLerping = false;
  playerState.followDM = true;
  requestRender();
  updateResyncButton();
}

export function resyncToDM(): void {
  targetPanX = playerState.dmPanX;
  targetPanY = playerState.dmPanY;
  targetZoom = playerState.dmZoom;
  isLerping = true;
  playerState.followDM = true;
  requestRender();
  updateResyncButton();
}

function updateResyncButton(): void {
  const btn = document.getElementById('resync-btn');
  if (btn) btn.classList.toggle('visible', !playerState.followDM);
}

// ── Mouse handlers (player pan/zoom + tool interaction) ──────────────────────

function onMouseDown(e: MouseEvent): void {
  // Right-click or Alt+left-click: always pan
  if (e.button === 2 || (e.button === 0 && e.altKey)) {
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartPanX = playerState.panX;
    panStartPanY = playerState.panY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  // Left-click: route to active tool if available, otherwise pan
  if (e.button === 0) {
    if (activeTool && playerState.dungeon) {
      const pos = { x: e.clientX, y: e.clientY };
      const transform = getTransform();
      const gridSize = playerState.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      activeTool.onMouseDown(cell.row, cell.col, null, e, pos);
      toolDragging = true;
      canvas.style.cursor = 'crosshair';
      e.preventDefault();
      requestRender();
      return;
    }

    // No tool — pan with left-click (legacy behavior)
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartPanX = playerState.panX;
    panStartPanY = playerState.panY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  }
}

function onMouseMove(e: MouseEvent): void {
  // Tool drag
  if (toolDragging && activeTool && playerState.dungeon) {
    const pos = { x: e.clientX, y: e.clientY };
    const transform = getTransform();
    const gridSize = playerState.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    activeTool.onMouseMove(cell.row, cell.col, null, e, pos);
    requestRender();
    return;
  }

  if (!isPanning) return;
  playerState.panX = panStartPanX + (e.clientX - panStartX);
  playerState.panY = panStartPanY + (e.clientY - panStartY);
  playerState.followDM = false;
  updateResyncButton();
  requestRender();
}

function onMouseUp(e: MouseEvent): void {
  // Tool drag end
  if (toolDragging && activeTool && playerState.dungeon) {
    const pos = { x: e.clientX, y: e.clientY };
    const transform = getTransform();
    const gridSize = playerState.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    activeTool.onMouseUp(cell.row, cell.col, null, e, pos);
    toolDragging = false;
    canvas.style.cursor = '';
    requestRender();
    return;
  }

  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = '';
  }
}

function onMouseLeave(): void {
  isPanning = false;
  toolDragging = false;
  canvas.style.cursor = '';
}

// ── Touch handlers (mobile/tablet pan, pinch-zoom, tool interaction) ─────────

function pinchDistance(t1: Touch, t2: Touch): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function onTouchStart(e: TouchEvent): void {
  e.preventDefault();
  const touches = e.touches;

  if (touches.length === 2) {
    // Switch to pinch-zoom (abort any in-progress tool drag)
    if (touchMode === 'tool' && activeTool?.onMouseUp) {
      activeTool.onMouseUp(0, 0, null, e, { x: 0, y: 0 });
      toolDragging = false;
    }
    touchMode = 'pinch';
    lastPinchDist = pinchDistance(touches[0], touches[1]);
    pinchMidX = (touches[0].clientX + touches[1].clientX) / 2;
    pinchMidY = (touches[0].clientY + touches[1].clientY) / 2;
    panStartX = pinchMidX;
    panStartY = pinchMidY;
    panStartPanX = playerState.panX;
    panStartPanY = playerState.panY;
    return;
  }

  if (touches.length === 1) {
    const t = touches[0];

    // If a tool is active, route single finger to tool
    if (activeTool && playerState.dungeon) {
      touchMode = 'tool';
      const pos = { x: t.clientX, y: t.clientY };
      const transform = getTransform();
      const gridSize = playerState.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      activeTool.onMouseDown(cell.row, cell.col, null, e, pos);
      toolDragging = true;
      requestRender();
      return;
    }

    // No tool — single finger pan
    touchMode = 'pan';
    panStartX = t.clientX;
    panStartY = t.clientY;
    panStartPanX = playerState.panX;
    panStartPanY = playerState.panY;
  }
}

function onTouchMove(e: TouchEvent): void {
  e.preventDefault();
  const touches = e.touches;

  if (touchMode === 'pinch' && touches.length >= 2) {
    const newDist = pinchDistance(touches[0], touches[1]);
    const midX = (touches[0].clientX + touches[1].clientX) / 2;
    const midY = (touches[0].clientY + touches[1].clientY) / 2;

    // Zoom
    const scale = newDist / lastPinchDist;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, playerState.zoom * scale));
    const zoomScale = newZoom / playerState.zoom;
    playerState.panX = midX - zoomScale * (midX - playerState.panX);
    playerState.panY = midY - zoomScale * (midY - playerState.panY);
    playerState.zoom = newZoom;
    lastPinchDist = newDist;

    // Simultaneous pan
    const dx = midX - panStartX;
    const dy = midY - panStartY;
    playerState.panX += dx;
    playerState.panY += dy;
    panStartX = midX;
    panStartY = midY;

    playerState.followDM = false;
    updateResyncButton();
    requestRender();
    return;
  }

  if (touchMode === 'tool' && touches.length === 1 && activeTool && playerState.dungeon) {
    const t = touches[0];
    const pos = { x: t.clientX, y: t.clientY };
    const transform = getTransform();
    const gridSize = playerState.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    activeTool.onMouseMove(cell.row, cell.col, null, e, pos);
    requestRender();
    return;
  }

  if (touchMode === 'pan' && touches.length === 1) {
    const t = touches[0];
    playerState.panX = panStartPanX + (t.clientX - panStartX);
    playerState.panY = panStartPanY + (t.clientY - panStartY);
    playerState.followDM = false;
    updateResyncButton();
    requestRender();
  }
}

function onTouchEnd(e: TouchEvent): void {
  // Tool drag end
  if (touchMode === 'tool' && activeTool && playerState.dungeon) {
    // Use last known position (changedTouches has the lifted finger)
    const t = e.changedTouches[0];
    if (t) {
      const pos = { x: t.clientX, y: t.clientY };
      const transform = getTransform();
      const gridSize = playerState.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      activeTool.onMouseUp(cell.row, cell.col, null, e, pos);
    }
    toolDragging = false;
    touchMode = null;
    requestRender();
    return;
  }

  // If we were pinching and now have 1 finger left, switch to pan
  if (touchMode === 'pinch' && e.touches.length === 1) {
    touchMode = 'pan';
    const t = e.touches[0];
    panStartX = t.clientX;
    panStartY = t.clientY;
    panStartPanX = playerState.panX;
    panStartPanY = playerState.panY;
    return;
  }

  // All fingers lifted
  if (e.touches.length === 0) {
    touchMode = null;
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, playerState.zoom * delta));

  // Zoom toward cursor
  const scale = newZoom / playerState.zoom;
  playerState.panX = e.clientX - scale * (e.clientX - playerState.panX);
  playerState.panY = e.clientY - scale * (e.clientY - playerState.panY);
  playerState.zoom = newZoom;
  playerState.followDM = false;

  updateResyncButton();
  requestRender();
}
