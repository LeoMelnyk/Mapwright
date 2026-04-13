// Full-map cache builder, scheduleCacheBuild, all invalidation functions,
// patchOpenedDoor, clearAll, markAssetsReady, resetFogLayers.

import {
  invalidateGeometryCache,
  invalidateFluidCache,
  invalidateVisibilityCache,
  invalidatePropsRenderLayer,
  invalidateAllCaches,
  invalidateLightmapCaches,
  patchBlendForDirtyRegion,
  patchFluidForDirtyRegion,
} from '../render/index.js';
import { buildPlayerCells, filterStairsForPlayer, filterBridgesForPlayer, filterPropsForPlayer } from './fog.js';
import playerState from './player-state.js';
import { cellKey, CARDINAL_OFFSETS } from '../util/index.js';
import { S, getMapCache, getMapPxPerFoot, resolveTheme, getCachedBgImage } from './player-canvas-state.js';
import { buildShadingLayer, buildHatchingLayer, initWallsLayer, rebuildWallsLayer } from './player-canvas-layers.js';
import type { Cell, TextureCatalog, VisibleBounds, OverlayProp } from '../types.js';

// ── Invalidation functions ──────────────────────────────────────────────────

/**
 * Force the map cache to rebuild.
 * @param dirtyRegion
 *   If provided, only the affected region is redrawn (partial rebuild).
 *   If null, the entire cache is rebuilt.
 * @param options.structural - true when walls/geometry changed
 */
export function invalidateFullMapCache(
  dirtyRegion: VisibleBounds | null = null,
  { structural = false }: { structural?: boolean } = {},
): void {
  S._playerContentVersion++;
  S._playerLightingVersion++;
  S._fogVersion++;
  if (structural) S._pendingStructuralChange = true;
  if (!dirtyRegion) S._cachedFullCells = null;
  // Clear stale composites immediately so they don't render during the
  // deferred cache rebuild (e.g., after fog reset with empty revealedCells)
  S._shadingComposite = null;
  S._hatchComposite = null;
  if (dirtyRegion && S._pendingDirtyRegion) {
    // Merge with any already-pending region
    S._pendingDirtyRegion = {
      minRow: Math.min(S._pendingDirtyRegion.minRow, dirtyRegion.minRow),
      maxRow: Math.max(S._pendingDirtyRegion.maxRow, dirtyRegion.maxRow),
      minCol: Math.min(S._pendingDirtyRegion.minCol, dirtyRegion.minCol),
      maxCol: Math.max(S._pendingDirtyRegion.maxCol, dirtyRegion.maxCol),
    };
  } else if (dirtyRegion && !S._pendingDirtyRegion) {
    S._pendingDirtyRegion = { ...dirtyRegion };
  } else {
    // null region = full rebuild; wipes any pending partial
    S._pendingDirtyRegion = null;
  }
}

/** Theme-only change — full map rebuild but skip fog and texture loading. */
export function invalidateThemeChange(): void {
  S._playerContentVersion++;
  S._playerLightingVersion++;
  S._cachedFullCells = null;
  S._shadingComposite = null;
  S._hatchComposite = null;
  S._pendingDirtyRegion = null; // full rebuild
}

/** Props-only change — cells rebuild needed (for props layer) but preserve cached cells/fluid. */
export function invalidatePropsChange(): void {
  S._playerContentVersion++;
  S._playerLightingVersion++;
  S._pendingPreserveCells = true;
  // Don't clear _cachedFullCells — props don't change cell data, only metadata.props
}

/** Lighting-only change — composite rebuild only (cells layer stays cached). */
export function invalidateLightingOnly(): void {
  S._playerLightingVersion++;
  // MapCache detects lightingVersion change → composite-only rebuild (no cells rebuild)
}

/**
 * Patch a secret door → normal door in the cached player cells.
 * In the cached cells, unopened secrets were converted to 'w' by buildPlayerCells.
 * We verify against the raw dungeon cells to confirm it was actually a secret door.
 * Call this BEFORE invalidateFullMapCache so the partial rebuild picks up the change.
 */
export function patchOpenedDoor(row: number, col: number, dir: string): void {
  if (!S._cachedFullCells || !playerState.dungeon) return;
  const rawCells = playerState.dungeon.cells;
  const OPPOSITE: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
  const cell = S._cachedFullCells[row]?.[col] as Record<string, unknown> | null;
  if (cell && (rawCells[row]?.[col] as Record<string, unknown> | null)?.[dir] === 's') cell[dir] = 'd';
  const offset = (CARDINAL_OFFSETS as Record<string, readonly [number, number] | undefined>)[dir];
  const [dr, dc] = offset ?? [0, 0];
  const nr = row + dr,
    nc = col + dc;
  const opp = OPPOSITE[dir];
  const neighbor = S._cachedFullCells[nr]?.[nc] as Record<string, unknown> | null;
  if (opp && neighbor && (rawCells[nr]?.[nc] as Record<string, unknown> | null)?.[opp] === 's') neighbor[opp] = 'd';
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
  S._cachedFullCells = null;
  S._playerContentVersion = 0;
  S._playerLightingVersion = 0;
  S._cacheBuiltVersion = -1;
  S._cacheBuiltLightingVersion = -1;
  S._pendingDirtyRegion = null;
  S._pendingStructuralChange = false;
  S._pendingPreserveCells = false;
  S._fogOverlay = null;
  S._fogVersion = 0;
  S._fogBuiltVersion = -1;
  S._fogEdgeMaskVersion = 0;
  S._fogEdgeMaskDirty = 0;
  S._shadingLayer = null;
  S._hatchLayer = null;
  S._shadingComposite = null;
  S._hatchComposite = null;
  S._wallsLayer = null;
  S._wallsCells = null;
  S._cacheBuilding = false;
  if (S.canvas) {
    S.ctx!.clearRect(0, 0, S.canvas.width, S.canvas.height);
  }
}

/** Rebuild only the fog overlay (fog reveal/conceal — no map cache rebuild). */
export function invalidateFogOverlay(): void {
  S._fogVersion++;
}

/**
 * Reset all fog-related layers without rebuilding the map cache.
 * Used on fog reset — clears fog overlay, composites, and walls layer.
 */
export function resetFogLayers(): void {
  S._shadingComposite = null;
  S._hatchComposite = null;
  S._fogVersion++; // triggers fog overlay rebuild (solid, no holes)
  S._fogEdgeMaskDirty++; // triggers composite rebuild (will no-op with empty revealedCells)
  rebuildWallsLayer();
}

/** Called by player-main.js once all catalogs and textures are loaded. */
export function markAssetsReady(): void {
  S._assetsReady = true;
  // Flush any pending cache build that was waiting
  for (const cb of S._assetReadyCallbacks) cb();
  S._assetReadyCallbacks = [];
}

// ── Loading overlay ─────────────────────────────────────────────────────────

function showLoadingOverlay(): void {
  S._loadingEl ??= document.getElementById('loading-overlay')!;
  S._loadingEl.classList.remove('hidden');
}

function hideLoadingOverlay(): void {
  S._loadingEl ??= document.getElementById('loading-overlay')!;
  S._loadingEl.classList.add('hidden');
}

// Forward declaration — set by player-canvas.ts barrel to break circular dep
let _requestRender: () => void = () => {};
export function setRequestRender(fn: () => void): void {
  _requestRender = fn;
}

/**
 * Schedule a full-map cache rebuild.  Only shows the loading overlay for the
 * very first build (no existing cache yet).  The initial build waits for all
 * assets (catalogs + textures) before running.  Subsequent rebuilds happen
 * silently — the existing cache displays while the new one builds.
 */
export function scheduleCacheBuild(): void {
  if (S._cacheBuilding) return; // already queued
  S._cacheBuilding = true;

  const isInitialBuild = !getMapCache().getComposite() || S._cacheBuiltVersion === -1;
  if (isInitialBuild) showLoadingOverlay();

  // For the initial build, wait until assets are ready before doing the heavy work
  if (isInitialBuild && !S._assetsReady) {
    S._assetReadyCallbacks.push(() => {
      // Double-rAF so the overlay has time to paint
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          buildFullMapCache();
          S._cacheBuilding = false;
          hideLoadingOverlay();
          _requestRender();
        });
      });
    });
    return;
  }

  // Double-rAF: first rAF lets the overlay paint; second runs the heavy work
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      buildFullMapCache();
      S._cacheBuilding = false;
      if (isInitialBuild) hideLoadingOverlay();
      _requestRender();
    });
  });
}

// ── Full-map cache builder ──────────────────────────────────────────────────
// Renders the entire map with ALL cells visible (secrets → walls, labels
// stripped) using the shared MapCache infrastructure.  Built once on session
// init.  Only rebuilt on structural changes (dungeon update, door/stair open).

function _hasAnimatedLights(): boolean {
  const lights = playerState.dungeon?.metadata.lights;
  if (!lights) return false;
  return lights.some((l) => l.animation?.type);
}

export function buildFullMapCache(): void {
  const _t0 = performance.now();
  const { dungeon } = playerState;
  if (!dungeon) return;
  const theme = resolveTheme();
  if (!theme) return;

  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  getMapCache().pxPerFoot = getMapPxPerFoot();
  if (!getMapCache().canCache(numRows, numCols, gridSize)) return;

  const isPartial = !!S._pendingDirtyRegion;

  // For partial rebuilds, reuse the cached fullCells so reference-based caches
  // (fluid, geometry, blend) stay valid. Patch only the dirty cells in-place.
  if (isPartial && S._cachedFullCells?.length === numRows) {
    const dr = S._pendingDirtyRegion!;
    const PAD = 3;
    const rMin = Math.max(0, dr.minRow - PAD),
      rMax = Math.min(numRows - 1, dr.maxRow + PAD);
    const cMin = Math.max(0, dr.minCol - PAD),
      cMax = Math.min(numCols - 1, dr.maxCol + PAD);
    // Build opened-door lookup for secret door conversion
    const _OPP: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
    const openedSet = new Set<string>();
    for (const d of playerState.openedDoors) {
      openedSet.add(`${d.row},${d.col},${d.dir}`);
      const _off = (CARDINAL_OFFSETS as Record<string, readonly [number, number] | undefined>)[d.dir];
      if (_off) {
        const [ddr, ddc] = _off;
        openedSet.add(`${d.row + ddr},${d.col + ddc},${_OPP[d.dir]}`);
      }
    }

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const src = cells[r]?.[c];
        if (!src) {
          S._cachedFullCells[r]![c] = null;
          continue;
        }
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
        delete center?.labelX;
        delete center?.labelY;
        delete center?.dmLabelX;
        delete center?.dmLabelY;
        if (center && Object.keys(center).length === 0) delete pc.center;
        S._cachedFullCells[r]![c] = pc as unknown as Cell;
      }
    }
  } else if (S._pendingPreserveCells && S._cachedFullCells?.length === numRows) {
    // Props/lighting-only change — reuse cached cells, skip geometry/fluid invalidation
  } else {
    // Full rebuild — create new cells array
    const allKeys = new Set<string>();
    for (let r = 0; r < numRows; r++) for (let c = 0; c < numCols; c++) allKeys.add(cellKey(r, c));
    S._cachedFullCells = buildPlayerCells(dungeon, allKeys, playerState.openedDoors);
    invalidateGeometryCache();
    invalidateFluidCache();
  }
  const fullCells = S._cachedFullCells;

  // Always invalidate props + lighting caches (cheap flag resets — actual rebuild is lazy)
  invalidatePropsRenderLayer();
  invalidateVisibilityCache('props');

  if (isPartial) {
    // Patch render caches for dirty region (avoids full rebuild)
    const textureOptions = playerState.textureCatalog
      ? {
          catalog: playerState.textureCatalog,
          blendWidth: ((theme as Record<string, unknown>).textureBlendWidth as number | undefined) ?? 0.35,
          texturesVersion: playerState.texturesVersion,
        }
      : null;
    if (textureOptions) {
      patchBlendForDirtyRegion(S._pendingDirtyRegion!, fullCells, gridSize, textureOptions);
    }
    patchFluidForDirtyRegion(S._pendingDirtyRegion!, fullCells, gridSize, theme);
    // Structural changes (room placement, wall edits) need full lighting + geometry invalidation
    if (S._pendingStructuralChange) {
      invalidateGeometryCache();
      invalidateVisibilityCache();
    }
  }

  // Build all-keys set for filter functions (all cells revealed in full map pre-render)
  const allKeys2 = new Set<string>();
  for (let r = 0; r < numRows; r++) for (let c = 0; c < numCols; c++) allKeys2.add(cellKey(r, c));

  // Include all stairs/bridges/props (everything visible)
  const fullStairs = filterStairsForPlayer(metadata.stairs, allKeys2, playerState.openedStairs);
  const fullBridges = filterBridgesForPlayer(metadata.bridges, allKeys2);
  const fullProps = filterPropsForPlayer(
    (metadata as Record<string, unknown>).props as OverlayProp[] | undefined,
    allKeys2,
    gridSize,
    playerState.propCatalog,
  );
  const fullMetadata = {
    ...metadata,
    stairs: fullStairs,
    bridges: fullBridges,
    props: fullProps,
    features: { ...metadata.features, showSubGrid: false },
  };

  const textureOptions = playerState.textureCatalog
    ? {
        catalog: playerState.textureCatalog,
        blendWidth: ((theme as Record<string, unknown>).textureBlendWidth as number | undefined) ?? 0.35,
        texturesVersion: playerState.texturesVersion,
      }
    : null;

  const bgImgConfig = metadata.backgroundImage ?? null;
  const bgImageEl = bgImgConfig?.dataUrl
    ? getCachedBgImage(bgImgConfig.dataUrl, () => {
        invalidateFullMapCache();
        _requestRender();
      })
    : null;

  const lightingEnabled = fullMetadata.lightingEnabled && fullMetadata.lights.length > 0;

  const _tCache0 = performance.now();
  getMapCache().update({
    contentVersion: S._playerContentVersion,
    lightingVersion: S._playerLightingVersion,
    texturesVersion: playerState.texturesVersion,
    cells: fullCells,
    gridSize,
    theme,
    showGrid: metadata.features.showGrid,
    labelStyle: metadata.labelStyle,
    propCatalog: playerState.propCatalog,
    textureOptions: textureOptions as { catalog: TextureCatalog; blendWidth: number; texturesVersion?: number } | null,
    metadata: fullMetadata,
    showInvisible: false,
    bgImageEl: bgImageEl,
    bgImgConfig: bgImgConfig as Record<string, string | number | boolean> | null,
    lightingEnabled,
    hasAnimLights: lightingEnabled && _hasAnimatedLights(),
    lights: fullMetadata.lights,
    animClock: S._animClock,
    lightPxPerFoot: 10,
    ambientLight: fullMetadata.ambientLight,
    ambientColor: null,
    textureCatalog: playerState.textureCatalog,
    dirtyRegion: S._pendingDirtyRegion,
    preRenderHook: null,
    skipPhases: { hatching: true, outerShading: true },
    skipLabels: lightingEnabled,
  });
  const _tCache1 = performance.now();

  S._cacheBuiltVersion = S._playerContentVersion;
  S._cacheBuiltLightingVersion = S._playerLightingVersion;
  const wasStructural = S._pendingStructuralChange;
  const wasPreserveCells = S._pendingPreserveCells;
  S._pendingDirtyRegion = null;
  S._pendingStructuralChange = false;
  S._pendingPreserveCells = false;
  S._cacheBuildCount++;

  const timings: Record<string, number> = { mapCache: _tCache1 - _tCache0 };
  S._lastBuildType = isPartial ? 'partial' : wasPreserveCells ? 'props' : 'full';

  if (!isPartial && !wasPreserveCells) {
    let _t: number;
    _t = performance.now();
    buildShadingLayer(fullCells, gridSize, theme);
    timings.shading = performance.now() - _t;
    _t = performance.now();
    buildHatchingLayer(fullCells, gridSize, theme);
    timings.hatching = performance.now() - _t;
    S._fogVersion++;
    _t = performance.now();
    initWallsLayer();
    timings.walls = performance.now() - _t;
  } else if (wasStructural) {
    // Structural partial change (room/wall edit) — rebuild walls overlay
    const _t = performance.now();
    initWallsLayer();
    timings.walls = performance.now() - _t;
  }

  timings.total = performance.now() - _t0;
  S._lastCacheBuildMs = timings.total;
  S._lastBuildTimings = timings;
}
