// Main render() loop, requestRender, animation loop management, fallback renderer,
// diagnostics overlay rendering.

import {
  renderCells,
  renderLabels,
  invalidateGeometryCache,
  renderLightmap,
  extractFillLights,
  renderTimings,
  buildFluidComposite,
  invalidateFluidCache,
  FLUID_BASE_SKIP,
  FLUID_TOP_SKIP,
} from '../render/index.js';
import { getCachedRoomCells } from '../render/render-cache.js';
import { buildPlayerCells, filterStairsForPlayer, filterBridgesForPlayer, filterPropsForPlayer } from './fog.js';
import playerState from './player-state.js';
import {
  S,
  ANIM_INTERVAL_MS,
  getMapCache,
  getMapPxPerFoot,
  getTransform,
  resolveTheme,
  getCachedBgImage,
} from './player-canvas-state.js';
import { rebuildFogOverlay } from './player-canvas-fog.js';
import { rebuildFogEdgeComposites } from './player-canvas-layers.js';
import { scheduleCacheBuild } from './player-canvas-cache.js';
import { tickViewportLerp } from './player-canvas-viewport.js';
import type { Metadata, TextureCatalog, Theme, RenderTransform, OverlayProp } from '../types.js';

function _hasAnimatedLights(): boolean {
  const lights = playerState.dungeon?.metadata.lights;
  if (!lights) return false;
  return lights.some((l) => l.animation?.type);
}

function _tickAnimLoop(): void {
  S._animLoopId = null;
  const meta = playerState.dungeon?.metadata;
  if (!meta?.lightingEnabled) return;
  if (!_hasAnimatedLights()) return;
  S._animClock = performance.now() / 1000;
  requestRender();
  S._animLoopId = setTimeout(_tickAnimLoop, ANIM_INTERVAL_MS);
}

function _startAnimLoop(): void {
  if (S._animLoopId) return;
  S._animLoopId = setTimeout(_tickAnimLoop, ANIM_INTERVAL_MS);
}

function _stopAnimLoop(): void {
  if (S._animLoopId) {
    clearTimeout(S._animLoopId);
    S._animLoopId = null;
  }
}

export function requestRender(): void {
  if (S.animFrameId) return;
  S.animFrameId = requestAnimationFrame(render);
}

// ── Render loop ─────────────────────────────────────────────────────────────

function render(timestamp: number): void {
  S.animFrameId = null;
  if (!S.canvas || !playerState.dungeon) return;
  const theme = resolveTheme();
  if (!theme) return;

  // Tick viewport interpolation
  const dt = S.lastFrameTime ? Math.min((timestamp - S.lastFrameTime) / 1000, 0.1) : 0.016;
  S.lastFrameTime = timestamp;
  const viewportAnimating = tickViewportLerp(dt);

  const { dungeon } = playerState;
  const { metadata } = dungeon;
  const gridSize = metadata.gridSize;
  const transform = getTransform();

  const ctx = S.ctx!;

  // Clear to theme background (fog color)
  ctx.clearRect(0, 0, S.canvas.width, S.canvas.height);
  ctx.fillStyle = theme.background || '#000000';
  ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);

  // Ensure the full-map cache is up to date (expensive — loading screen on first build)
  if (S._cacheBuiltVersion !== S._playerContentVersion || S._cacheBuiltLightingVersion !== S._playerLightingVersion) {
    scheduleCacheBuild();
    // If we don't have an existing cache yet (initial build), bail — loading overlay is showing
    const composite = getMapCache().getComposite();
    if (!composite || S._cacheBuiltVersion === -1) {
      if (viewportAnimating) requestRender();
      return;
    }
    // Otherwise keep drawing from the existing (stale but valid) cache while rebuilding
  }

  // Ensure the fog overlay is up to date (cheap — no loading screen)
  if (S._fogBuiltVersion !== S._fogVersion) {
    rebuildFogOverlay();
  }

  // Ensure the fog-edge composites (shading + hatching) are up to date
  if ((S._shadingLayer || S._hatchLayer) && S._fogEdgeMaskVersion !== S._fogEdgeMaskDirty) {
    rebuildFogEdgeComposites();
  }

  const composite = getMapCache().getComposite();
  if (composite && S._fogOverlay) {
    // ── Cached path: two drawImage calls (map + fog) ──
    getMapCache().blit(ctx, transform);

    // ── Animated light overlay (screen-resolution, every frame) ──
    const fullMetadata = playerState.dungeon.metadata;
    if (fullMetadata.lightingEnabled && _hasAnimatedLights()) {
      const fullCells = playerState.dungeon.cells;
      const fillLights = extractFillLights(fullCells, gridSize, theme);
      const allLights = fillLights.length ? [...fullMetadata.lights, ...fillLights] : fullMetadata.lights;
      const sx2 = transform.scale / getMapPxPerFoot();
      const mapScreenW = composite.cacheW * sx2;
      const mapScreenH = composite.cacheH * sx2;
      renderLightmap(
        ctx,
        allLights,
        fullCells,
        gridSize,
        { scale: transform.scale, offsetX: 0, offsetY: 0 },
        Math.ceil(mapScreenW),
        Math.ceil(mapScreenH),
        fullMetadata.ambientLight,
        playerState.textureCatalog,
        playerState.propCatalog,
        {
          ambientColor: ((fullMetadata as Record<string, unknown>).ambientColor as string) || '#ffffff',
          time: S._animClock,
          lightPxPerFoot: 10,
          destX: transform.offsetX,
          destY: transform.offsetY,
          destW: mapScreenW,
          destH: mapScreenH,
        },
        fullMetadata,
      );
    }

    // Fog mask (opaque black with transparent holes for revealed cells)
    const sx = transform.scale / getMapPxPerFoot();
    const dw = composite.cacheW * sx;
    const dh = composite.cacheH * sx;
    ctx.drawImage(S._fogOverlay.canvas, transform.offsetX, transform.offsetY, dw, dh);

    // Shading layer (above fog, below hatching)
    if (S._shadingComposite) {
      ctx.drawImage(S._shadingComposite.canvas, transform.offsetX, transform.offsetY, dw, dh);
    }

    // Hatching layer (above shading, below walls overlay)
    if (S._hatchComposite) {
      ctx.drawImage(S._hatchComposite.canvas, transform.offsetX, transform.offsetY, dw, dh);
    }

    // Walls + doors overlay (only contains walls from revealed cells)
    if (S._wallsLayer) {
      ctx.drawImage(S._wallsLayer.canvas, transform.offsetX, transform.offsetY, dw, dh);
    }
  } else if (!composite) {
    // ── Fallback: direct render for huge maps that exceed GPU texture limits ──
    renderFallback(theme, gridSize, transform);
  }

  // Tool overlay (range detector highlights) — always on top
  if (S.activeTool?.renderOverlay) {
    S.activeTool.renderOverlay(ctx, transform, gridSize);
  }

  // ── Diagnostics overlay (press 'D' to toggle) ──
  const drawEnd = performance.now();
  if (S._lastFrameEnd > 0) S._frameGapMs = drawEnd - S._lastFrameEnd;
  S._lastFrameEnd = drawEnd;
  S._fpsFrames++;
  const now = performance.now();
  if (now - S._fpsLastTime >= 1000) {
    S._fpsValue = S._fpsFrames;
    S._fpsFrames = 0;
    S._fpsLastTime = now;
  }

  if (S._diagEnabled) {
    drawDiagnostics(gridSize);
  }

  // Auto-manage animation loop based on animated lights
  const meta = playerState.dungeon.metadata;
  if (meta.lightingEnabled && _hasAnimatedLights()) {
    if (!S._animLoopId) _startAnimLoop();
  } else if (S._animLoopId) {
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
  if (!dungeon || !S.canvas) return;
  const { metadata } = dungeon;

  const ctx = S.ctx!;
  const playerCells = buildPlayerCells(dungeon, playerState.revealedCells, playerState.openedDoors);
  invalidateGeometryCache();

  const filteredStairs = filterStairsForPlayer(metadata.stairs, playerState.revealedCells, playerState.openedStairs);
  const filteredBridges = filterBridgesForPlayer(metadata.bridges, playerState.revealedCells);
  const filteredProps = filterPropsForPlayer(
    (metadata as Record<string, unknown>).props as OverlayProp[] | undefined,
    playerState.revealedCells,
    gridSize,
    playerState.propCatalog,
  );
  const playerMetadata = {
    ...metadata,
    stairs: filteredStairs,
    bridges: filteredBridges,
    props: filteredProps,
    features: { ...metadata.features, showSubGrid: false },
  };

  const textureOptions = playerState.textureCatalog
    ? {
        catalog: playerState.textureCatalog,
        blendWidth: (theme as Record<string, unknown>).textureBlendWidth ?? 0.35,
        texturesVersion: playerState.texturesVersion,
      }
    : null;
  const bgImgConfig = metadata.backgroundImage ?? null;
  const bgImageEl = bgImgConfig?.dataUrl
    ? getCachedBgImage(bgImgConfig.dataUrl, () => {
        requestRender();
      })
    : null;
  const lightingEnabled = playerMetadata.lightingEnabled && playerMetadata.lights.length > 0;

  // Pass 1: BASE phases (floors + blending) — fluid sits above this.
  renderCells(ctx, playerCells, gridSize, theme, transform, {
    showGrid: metadata.features.showGrid,
    labelStyle: metadata.labelStyle,
    propCatalog: null,
    textureOptions: textureOptions as { catalog: TextureCatalog; blendWidth: number } | null,
    metadata: playerMetadata as Metadata,
    skipLabels: true,
    bgImageEl: bgImageEl,
    bgImgConfig: bgImgConfig as Record<string, string | number | boolean> | null,
    skipPhases: { ...FLUID_BASE_SKIP },
  });

  // Fluid composite (water / lava / pit) between base and top phases —
  // mirrors the MapCache z-order so huge-map fallback renders fluids
  // correctly too.
  invalidateFluidCache();
  const numRows = playerCells.length;
  const numCols = playerCells[0]?.length ?? 0;
  if (numRows && numCols) {
    const fluidCacheW = Math.ceil(numCols * gridSize * transform.scale);
    const fluidCacheH = Math.ceil(numRows * gridSize * transform.scale);
    const roomCells = getCachedRoomCells(playerCells);
    const fluidComposite = buildFluidComposite(
      playerCells,
      roomCells,
      gridSize,
      theme,
      transform.scale,
      fluidCacheW,
      fluidCacheH,
      null,
    );
    if (fluidComposite) {
      ctx.drawImage(fluidComposite, transform.offsetX, transform.offsetY);
    }
  }

  // Pass 2: TOP phases (bridges + walls + grid + props + hazard).
  renderCells(ctx, playerCells, gridSize, theme, transform, {
    showGrid: metadata.features.showGrid,
    labelStyle: metadata.labelStyle,
    propCatalog: playerState.propCatalog,
    textureOptions: textureOptions as { catalog: TextureCatalog; blendWidth: number } | null,
    metadata: playerMetadata as Metadata,
    skipLabels: lightingEnabled,
    bgImageEl: null,
    bgImgConfig: null,
    skipPhases: { ...FLUID_TOP_SKIP },
  });

  if (lightingEnabled) {
    renderLightmap(
      ctx,
      playerMetadata.lights,
      playerCells,
      gridSize,
      transform,
      S.canvas.width,
      S.canvas.height,
      playerMetadata.ambientLight,
      playerState.textureCatalog,
      playerState.propCatalog,
      { time: S._animClock },
      playerMetadata,
    );
    renderLabels(ctx, playerCells, gridSize, theme, transform, metadata.labelStyle);
  }
}

// ── Diagnostics overlay ─────────────────────────────────────────────────────

function drawDiagnostics(gridSize: number): void {
  const ctx = S.ctx!;
  const lines: { text: string; color: string }[] = [];
  const _col = (ms: number): string => (ms < 2 ? '#8f8' : ms < 10 ? '#ff4' : '#f44');

  // Header
  lines.push({
    text: `${S._fpsValue} fps | gap: ${S._frameGapMs.toFixed(0)}ms`,
    color: S._fpsValue >= 55 ? '#4f4' : S._fpsValue >= 30 ? '#ff4' : '#f44',
  });

  // Map info
  const { cells, metadata } = playerState.dungeon!;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  lines.push({ text: '', color: '#666' });
  lines.push({ text: '── Map ──', color: '#666' });
  lines.push({ text: `Grid: ${numRows}x${numCols} (${gridSize}ft)`, color: '#aaf' });
  lines.push({
    text: `Props: ${metadata.props ? metadata.props.length : 0} | Lights: ${metadata.lights.length}`,
    color: '#aaa',
  });
  lines.push({ text: `Revealed: ${playerState.revealedCells.size} / ${numRows * numCols} cells`, color: '#aaa' });

  // Caches
  lines.push({ text: '', color: '#666' });
  lines.push({ text: '── Caches ──', color: '#666' });
  const cacheStats = getMapCache().stats;
  if (cacheStats.cacheW) {
    lines.push({ text: `Map cache: ${cacheStats.cacheW}x${cacheStats.cacheH}px`, color: '#aaa' });
  }
  lines.push({
    text: `Builds: ${S._cacheBuildCount} (${cacheStats.cellsRebuilds} cells, ${cacheStats.compositeRebuilds} comp)`,
    color: '#aaa',
  });
  const typeColor: Record<string, string> = {
    full: '#f44',
    partial: '#ff4',
    composite: '#8f8',
    grid: '#8f8',
    none: '#666',
  };
  lines.push({
    text: `Last: ${S._lastBuildType} ${S._lastCacheBuildMs.toFixed(0)}ms`,
    color: typeColor[S._lastBuildType] ?? '#aaa',
  });
  if (cacheStats.lastRebuildType !== 'none') {
    lines.push({
      text: `  MapCache: ${cacheStats.lastRebuildType} ${cacheStats.lastRebuildMs.toFixed(0)}ms`,
      color: typeColor[cacheStats.lastRebuildType] ?? '#aaa',
    });
  }
  const t = S._lastBuildTimings;
  if (t.mapCache != null) {
    lines.push({ text: `  MapCache: ${t.mapCache.toFixed(0)}ms`, color: _col(t.mapCache) });
  }
  if (t.shading != null) lines.push({ text: `  shading layer: ${t.shading.toFixed(0)}ms`, color: _col(t.shading) });
  if (t.hatching != null) lines.push({ text: `  hatching layer: ${t.hatching.toFixed(0)}ms`, color: _col(t.hatching) });
  if (t.walls != null) lines.push({ text: `  walls layer: ${t.walls.toFixed(0)}ms`, color: _col(t.walls) });

  // Per-phase renderCells breakdown (from render pipeline timings)
  const phases = ['roomCells', 'shading', 'floors', 'blending', 'fills', 'bridges', 'grid', 'walls', 'props', 'hazard'];
  const hasPhaseData = phases.some(
    (p) => ((renderTimings as Record<string, { ms?: number } | undefined>)[p]?.ms ?? 0) > 0,
  );
  if (hasPhaseData) {
    lines.push({ text: '', color: '#666' });
    lines.push({ text: '── renderCells ──', color: '#666' });
    for (const phase of phases) {
      const pt = (renderTimings as Record<string, { ms?: number } | undefined>)[phase];
      if (!pt) continue;
      const ms = pt.ms ?? 0;
      lines.push({ text: `  ${phase}: ${ms.toFixed(ms < 1 ? 1 : 0)}ms`, color: _col(ms) });
    }
  }

  // Fog overlay
  lines.push({ text: '', color: '#666' });
  lines.push({ text: '── Fog ──', color: '#666' });
  lines.push({ text: `Fog rebuilds: ${S._fogRebuildCount}`, color: '#aaa' });
  lines.push({ text: `Last fog rebuild: ${S._lastFogRebuildMs.toFixed(1)}ms`, color: _col(S._lastFogRebuildMs) });
  if (S._lastRevealCellCount > 0) {
    lines.push({
      text: `Last reveal: ${S._lastRevealCellCount} cells in ${S._lastRevealMs.toFixed(1)}ms`,
      color: _col(S._lastRevealMs),
    });
  }

  // WebSocket
  lines.push({ text: '', color: '#666' });
  lines.push({ text: '── Connection ──', color: '#666' });
  lines.push({
    text: `WS: ${playerState.connected ? 'connected' : 'disconnected'}`,
    color: playerState.connected ? '#8f8' : '#f44',
  });
  lines.push({ text: `Follow DM: ${playerState.followDM ? 'yes' : 'no'}`, color: '#aaa' });

  // Memory
  const perfMemory = (performance as unknown as Record<string, unknown>).memory as
    | { usedJSHeapSize: number; jsHeapSizeLimit: number }
    | undefined;
  if (perfMemory) {
    lines.push({ text: '', color: '#666' });
    lines.push({ text: '── Memory ──', color: '#666' });
    const mb = (b: number): string => (b / 1048576).toFixed(0);
    lines.push({
      text: `Heap: ${mb(perfMemory.usedJSHeapSize)}MB / ${mb(perfMemory.jsHeapSizeLimit)}MB`,
      color: '#aaa',
    });
  }

  // Render the overlay
  ctx.font = '12px monospace';
  const lineH = 15;
  const pad = 8;
  const x = pad;
  let y = pad;

  for (const line of lines) {
    if (line.text === '') {
      y += 4;
      continue;
    }
    const tw = ctx.measureText(line.text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x - 2, y - 1, tw + 6, lineH);
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, x, y + 11);
    y += lineH;
  }
}
