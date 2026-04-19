// Canvas rendering pipeline + overlay drawing helpers.
import type { CellGrid, Metadata, RenderTransform, TextureOptions, Theme } from '../../types.js';
import state, { getTheme, markDirty, notifyTimings } from './state.js';
import {
  renderCells,
  renderLabels,
  drawBorderOnMap,
  findCompassRosePositionOnMap,
  renderLightmap,
  renderCoverageHeatmap,
  extractFillLights,
  flushRenderWarnings,
  renderTimings,
  bumpTimingFrame,
  getContentVersion,
  getTopContentVersion,
  getGeometryVersion,
  getLightingVersion,
  getDirtyRegion,
  consumeDirtyRegion,
} from '../../render/index.js';
import { getCachedText, drawCachedText, getCachedCompass, setFont } from './decoration-cache.js';
import { showToast } from './toast.js';
import { toCanvas } from './utils.js';
import { displayGridSize as _dgs } from '../../util/index.js';
import { updateMinimap } from './minimap.js';
import { getEditorSettings } from './editor-settings.js';
import {
  cvState,
  CELL_SIZE,
  ANIM_INTERVAL_MS,
  getMapCache,
  getCachedBgImage,
  _shownWarnings,
  fpsState,
  rafProbe,
} from './canvas-view-state.js';

/**
 * Schedule a canvas repaint on the next animation frame.
 * @returns {void}
 */
export function requestRender(): void {
  if (cvState.animFrameId) return;
  cvState.animFrameId = requestAnimationFrame(render);
}

/**
 * Resize the canvas to match its parent container and update HiDPI scaling.
 * @returns {void}
 */
export function resizeCanvas(): void {
  const { canvas } = cvState;
  const rect = canvas!.parentElement!.getBoundingClientRect();
  const prevDpr = cvState._dpr;
  cvState._dpr = window.devicePixelRatio || 1;
  cvState._canvasW = rect.width;
  cvState._canvasH = rect.height;
  canvas!.width = Math.round(cvState._canvasW * cvState._dpr);
  canvas!.height = Math.round(cvState._canvasH * cvState._dpr);
  // CSS width:100%;height:100% handles layout sizing — don't override with inline styles
  if (cvState._dpr !== prevDpr) getMapCache().invalidate();
  markDirty();
  requestRender();
}

/**
 * Build the transform object that maps dungeon feet to canvas pixels.
 * @returns {{ offsetX: number, offsetY: number, scale: number }} The current pan/zoom transform.
 */
export function getTransform(): RenderTransform {
  const { gridSize, resolution } = state.dungeon.metadata;
  const scale = (CELL_SIZE * state.zoom) / _dgs(gridSize, resolution); // pixels per foot
  return {
    offsetX: state.panX,
    offsetY: state.panY,
    scale,
  };
}

/**
 * Main canvas render pass — draws the dungeon, overlays, and diagnostics.
 * @returns {void}
 */
export function render(): void {
  cvState.animFrameId = null;
  const { canvas, ctx } = cvState;
  if (!canvas || !ctx) return;
  const _currentFrame = bumpTimingFrame();
  const drawStart = performance.now();
  if (fpsState._lastFrameEnd > 0) fpsState._frameGapMs = drawStart - fpsState._lastFrameEnd;

  const { dungeon } = state;
  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize;
  const theme = getTheme();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!theme) return; // Theme catalog not loaded yet
  const transform = getTransform();
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  // Clear canvas (physical pixel dimensions)
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Apply DPR scaling — all subsequent drawing uses CSS/logical coordinates
  ctx.setTransform(cvState._dpr, 0, 0, cvState._dpr, 0, 0);

  // Draw background (entire canvas, logical dimensions)
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, cvState._canvasW, cvState._canvasH);

  const _skip: Record<string, boolean> =
    (typeof window !== 'undefined'
      ? ((window as unknown as Record<string, unknown>)._skipPhases as Record<string, boolean> | undefined)
      : undefined) ?? {};

  // Debug: skip ALL rendering (just background fill) to test compositor behavior
  if (_skip.all) {
    cvState.lastDrawMs = performance.now() - drawStart;
    fpsState._lastFrameEnd = performance.now();
    // still draw diagnostics below
    fpsState._fpsFrames++;
    const now = performance.now();
    if (now - fpsState._fpsLastTime >= 1000) {
      fpsState._fpsValue = fpsState._fpsFrames;
      fpsState._fpsFrames = 0;
      fpsState._fpsLastTime = now;
    }
    const editorSettings = getEditorSettings();
    if (editorSettings.fpsCounter === true) {
      const lines = [
        {
          text: `Draw: ${cvState.lastDrawMs.toFixed(1)}ms | ${fpsState._fpsValue} fps | gap: ${fpsState._frameGapMs.toFixed(0)}ms | rAF: ${rafProbe._rafProbeHz}Hz`,
          color: '#4f4',
        },
        { text: 'SKIP ALL — compositor test', color: '#f84' },
      ];
      setFont(ctx, '13px monospace');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(4, 4 + i * 17, ctx.measureText(lines[i]!.text).width + 8, 16);
        ctx.fillStyle = lines[i]!.color;
        ctx.fillText(lines[i]!.text, 8, 16 + i * 17);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }

  // Render the dungeon cells (WYSIWYG)
  const showGrid = metadata.features.showGrid;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const labelStyle = metadata.labelStyle || 'circled';
  const textureOptions = state.textureCatalog
    ? {
        catalog: state.textureCatalog,
        blendWidth: theme.textureBlendWidth ?? 0.35,
        texturesVersion: state.texturesVersion,
      }
    : { catalog: null, blendWidth: 0, texturesVersion: state.texturesVersion };
  const lightingEnabled = metadata.lightingEnabled;
  const showInvisible = state.activeTool === 'wall' || state.activeTool === 'door';
  const bgImgConfig = metadata.backgroundImage ?? null;
  const bgImageEl = bgImgConfig?.dataUrl ? getCachedBgImage(bgImgConfig.dataUrl) : null;

  // ── Offscreen map cache ───────────────────────────────────────────────────
  // Render the expensive cell pipeline + lighting to a cached bitmap.
  // Only re-render when map data changes (version bump). Pan/zoom just blits.
  // Cache resolution from editor settings (10=Low, 15=Medium, 20=High, 30=Ultra)
  const MAP_PX_PER_FOOT = (getEditorSettings().renderQuality as number) || 20;
  const mapCache = getMapCache();
  (mapCache as unknown as Record<string, unknown>).pxPerFoot = MAP_PX_PER_FOOT;
  const useCache = mapCache.canCache(numRows, numCols, gridSize) && !_skip.cells;

  const animClock = state.animClock;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const hasAnimLights = lightingEnabled && (metadata.lights || []).some((l) => l.animation?.type);

  if (useCache) {
    const _cacheStart = performance.now();
    const rebuilt = mapCache.update({
      contentVersion: getContentVersion(),
      topContentVersion: getTopContentVersion(),
      geometryVersion: getGeometryVersion(),
      lightingVersion: getLightingVersion(),
      texturesVersion: state.texturesVersion,
      cells,
      gridSize,
      theme,
      showGrid: showGrid && !_skip.grid,
      labelStyle,
      propCatalog: state.propCatalog,
      textureOptions: textureOptions as TextureOptions | null,
      metadata,
      showInvisible,
      bgImageEl,
      bgImgConfig: bgImgConfig as Record<string, string | number | boolean> | null,
      lightingEnabled,
      hasAnimLights,
      lights: metadata.lights,
      animClock,
      lightPxPerFoot: (getEditorSettings().lightQuality as number) || 10,
      ambientLight: metadata.ambientLight,
      ambientColor: metadata.ambientColor ?? '#ffffff',
      textureCatalog: state.textureCatalog,
      dirtyRegion: getDirtyRegion(),
      preRenderHook: _skip.dots
        ? null
        : (offCtx: CanvasRenderingContext2D, t: RenderTransform) =>
            drawEditorDots(offCtx, numRows, numCols, gridSize, theme, t),
      skipPhases: Object.keys(_skip).some((k) => _skip[k] && k !== 'all') ? _skip : null,
      skipLabels: lightingEnabled || _skip.labels,
    });

    if (rebuilt) {
      consumeDirtyRegion();
      renderTimings.cacheRebuild = { ms: performance.now() - _cacheStart, frame: _currentFrame };
    }

    // Blit cached map with pan/zoom transform — single drawImage, fast GPU op
    const _blitStart = performance.now();
    mapCache.blit(ctx, transform);
    renderTimings.blit = { ms: performance.now() - _blitStart, frame: _currentFrame };

    // ── Animated light overlay (screen-resolution, every frame) ──
    // When animated lights exist, lighting is NOT baked into the composite.
    // Instead, apply the full lightmap (static cached + animated) at screen
    // resolution every frame. This avoids the expensive 5000x5000 composite rebuild.
    if (hasAnimLights && !_skip.lighting) {
      const composite = mapCache.getComposite();
      if (composite) {
        const fillLights = extractFillLights(cells, gridSize, theme);
        const allLights = fillLights.length
          ? // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            [...(metadata.lights || []), ...fillLights]
          : // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            metadata.lights || [];
        const LIGHT_PX_PER_FOOT = (getEditorSettings().lightQuality as number) || 10;
        const sx = transform.scale / MAP_PX_PER_FOOT;
        const mapScreenW = composite.cacheW * sx;
        const mapScreenH = composite.cacheH * sx;
        renderLightmap(
          ctx,
          allLights,
          cells,
          gridSize,
          { scale: transform.scale, offsetX: 0, offsetY: 0 },
          Math.ceil(mapScreenW),
          Math.ceil(mapScreenH),
          metadata.ambientLight,
          state.textureCatalog,
          state.propCatalog,
          {
            ambientColor: metadata.ambientColor ?? '#ffffff',
            time: animClock,
            lightPxPerFoot: LIGHT_PX_PER_FOOT,
            destX: transform.offsetX,
            destY: transform.offsetY,
            destW: mapScreenW,
            destH: mapScreenH,
          },
          metadata,
        );
      }
    }
  } else {
    // Fallback: direct render (huge maps or skip mode)
    const _dotsStart = performance.now();
    if (!_skip.dots) drawEditorDots(ctx, numRows, numCols, gridSize, theme, transform);
    renderTimings.dots = { ms: performance.now() - _dotsStart, frame: _currentFrame };

    const cellPxSize = gridSize * transform.scale;
    const CULL_MARGIN = 2;
    const visibleBounds =
      cellPxSize > 0
        ? {
            minRow: Math.max(0, Math.floor(-transform.offsetY / cellPxSize) - CULL_MARGIN),
            maxRow: Math.min(numRows - 1, Math.ceil((canvas.height - transform.offsetY) / cellPxSize) + CULL_MARGIN),
            minCol: Math.max(0, Math.floor(-transform.offsetX / cellPxSize) - CULL_MARGIN),
            maxCol: Math.min(numCols - 1, Math.ceil((canvas.width - transform.offsetX) / cellPxSize) + CULL_MARGIN),
          }
        : null;

    if (!_skip.cells)
      renderCells(ctx, cells, gridSize, theme, transform, {
        showGrid: showGrid && !_skip.grid,
        labelStyle,
        propCatalog: _skip.props ? null : state.propCatalog,
        textureOptions: (_skip.textures ? null : textureOptions) as TextureOptions | null,
        metadata,
        skipLabels: lightingEnabled || _skip.labels,
        showInvisible,
        bgImageEl,
        bgImgConfig,
        visibleBounds,
      });

    if (lightingEnabled && !_skip.lighting) {
      const _lightStart = performance.now();
      const fillLights = extractFillLights(cells, gridSize, theme);
      const allLights = fillLights.length
        ? // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          [...(metadata.lights || []), ...fillLights]
        : // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          metadata.lights || [];
      renderLightmap(
        ctx,
        allLights,
        cells,
        gridSize,
        transform,
        cvState._canvasW,
        cvState._canvasH,
        metadata.ambientLight,
        state.textureCatalog,
        state.propCatalog,
        { ambientColor: metadata.ambientColor ?? '#ffffff', time: state.animClock },
        metadata,
      );
      renderTimings.lighting = { ms: performance.now() - _lightStart, frame: _currentFrame };
      renderLabels(ctx, cells, gridSize, theme, transform, labelStyle);
    }
  }

  // Auto-manage animation loop based on animated lights
  if (lightingEnabled) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const hasAnimLightsLocal = (metadata.lights || []).some((l) => l.animation?.type);
    if (hasAnimLightsLocal && !cvState.animLoopId) {
      cvState.animLoopId = setTimeout(_tickAnimLoopRef, ANIM_INTERVAL_MS);
    } else if (!hasAnimLightsLocal && cvState.animLoopId) {
      clearTimeout(cvState.animLoopId);
      cvState.animLoopId = null;
    }
    if (state.lightCoverageMode) {
      renderCoverageHeatmap(ctx, metadata.lights, cells, gridSize, transform);
    }
  } else if (cvState.animLoopId) {
    clearTimeout(cvState.animLoopId);
    cvState.animLoopId = null;
  }

  // Feature decorations (rendered in dungeon coordinate space — pan/zoom with the map)
  const _decoStart = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const features = metadata.features || {};
  if (features.border) {
    drawBorderOnMap(ctx, cells, gridSize, theme, transform);
  }
  if (features.compassRose) {
    const pos = findCompassRosePositionOnMap(cells, gridSize, transform);
    if (pos) {
      const entry = getCachedCompass(theme, pos.scale);
      ctx.drawImage(entry.canvas as CanvasImageSource, pos.x - entry.centerOffsetX, pos.y - entry.centerOffsetY);
    }
  }
  if (features.scale) {
    drawScaleIndicatorOnMapCached(ctx, cells, gridSize, theme, transform, metadata.resolution);
  }

  // Draw dungeon title (and per-level titles on multi-level maps)
  drawDungeonTitleOnMap(ctx, cells, gridSize, theme, transform, metadata);
  renderTimings.decorations = { ms: performance.now() - _decoStart, frame: _currentFrame };

  // Draw level separators
  drawLevelSeparators(ctx, metadata.levels, gridSize, transform, theme);

  // Editor overlays
  drawHoverHighlight(ctx, gridSize, transform);
  drawSelectionHighlight(ctx, gridSize, transform);
  drawLinkSourceHighlight(ctx, gridSize, transform);
  drawEdgeHighlight(ctx, gridSize, transform);

  // Tool overlay — suppressed while panning (right-drag or Alt+drag)
  if (cvState.activeTool?.renderOverlay && !cvState.isPanning && !cvState.rightDragged) {
    cvState.activeTool.renderOverlay(ctx, transform, gridSize);
  }

  // Debug: hitbox overlay — cyan = lighting hitbox, yellow = selection hitbox (when different)
  if (state.debugShowHitboxes && state.propCatalog && metadata.props?.length) {
    ctx.save();
    for (const prop of metadata.props) {
      const propDef = state.propCatalog.props[prop.type];
      if (!propDef?.hitbox) continue;
      const rotation = prop.rotation;
      const scl = prop.scale;
      const flipped = prop.flipped;
      const [fRows, fCols] = propDef.footprint;
      const r = ((rotation % 360) + 360) % 360;

      function hitboxToScreen(points: number[][]) {
        return points.map(([hx, hy]: number[]) => {
          let px = flipped ? fCols - hx! : hx!;
          let py = hy!;
          // Rotate around footprint center using general rotation math
          // Note: prop rotation is CCW in the data model (negative ctx.rotate),
          // so negate the angle to match visual rendering
          const cx = fCols / 2,
            cy = fRows / 2;
          if (r !== 0) {
            const rad = (-rotation * Math.PI) / 180;
            const cosA = Math.cos(rad),
              sinA = Math.sin(rad);
            const dx = px - cx,
              dy = py - cy;
            px = cx + dx * cosA - dy * sinA;
            py = cy + dx * sinA + dy * cosA;
          }
          // Scale from footprint center, then convert to world feet
          const wx = cx * gridSize + (px - cx) * gridSize * scl;
          const wy = cy * gridSize + (py - cy) * gridSize * scl;
          return {
            x: (prop.x + wx) * transform.scale + transform.offsetX,
            y: (prop.y + wy) * transform.scale + transform.offsetY,
          };
        });
      }

      function drawPoly(screenPts: { x: number; y: number }[], color: string) {
        ctx!.strokeStyle = color;
        ctx!.lineWidth = 1.5;
        ctx!.setLineDash([4, 3]);
        ctx!.beginPath();
        for (let i = 0; i < screenPts.length; i++) {
          if (i === 0) ctx!.moveTo(screenPts[i]!.x, screenPts[i]!.y);
          else ctx!.lineTo(screenPts[i]!.x, screenPts[i]!.y);
        }
        ctx!.closePath();
        ctx!.stroke();
      }

      // Draw lighting hitbox (cyan)
      drawPoly(hitboxToScreen(propDef.hitbox), '#00ffff');

      // Draw selection hitbox (yellow) if it differs from the lighting hitbox
      if (propDef.selectionHitbox) {
        drawPoly(hitboxToScreen(propDef.selectionHitbox), '#ffff00');
      }
    }
    ctx.restore();
  }

  // Debug: selection hitbox overlay — magenta polygon showing what `hitTestPropPixel`
  // actually tests against. Uses `selectionHitbox` if defined, else `autoHitbox`.
  if (state.debugShowSelectionBoxes && state.propCatalog && metadata.props?.length) {
    ctx.save();
    ctx.strokeStyle = '#ff00ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    for (const prop of metadata.props) {
      const propDef = state.propCatalog.props[prop.type];
      if (!propDef) continue;
      const selPolygon = propDef.selectionHitbox ?? propDef.autoHitbox;
      if (!selPolygon?.length) continue;
      const rotation = prop.rotation;
      const scl = prop.scale;
      const flipped = prop.flipped;
      const [fRows, fCols] = propDef.footprint;
      const r = ((rotation % 360) + 360) % 360;
      const cx = fCols / 2;
      const cy = fRows / 2;

      const screenPts = selPolygon.map(([hx, hy]: number[]) => {
        let px = flipped ? fCols - hx! : hx!;
        let py = hy!;
        if (r !== 0) {
          const rad = (-rotation * Math.PI) / 180;
          const cosA = Math.cos(rad);
          const sinA = Math.sin(rad);
          const dx = px - cx;
          const dy = py - cy;
          px = cx + dx * cosA - dy * sinA;
          py = cy + dx * sinA + dy * cosA;
        }
        const wx = cx * gridSize + (px - cx) * gridSize * scl;
        const wy = cy * gridSize + (py - cy) * gridSize * scl;
        return {
          x: (prop.x + wx) * transform.scale + transform.offsetX,
          y: (prop.y + wy) * transform.scale + transform.offsetY,
        };
      });

      ctx.beginPath();
      screenPts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  // Background cell measure overlay
  if (cvState._bgMeasureActive && cvState._bgMeasureStart && cvState._bgMeasureEnd) {
    const x0 = cvState._bgMeasureStart.x;
    const y0 = cvState._bgMeasureStart.y;
    const dx = cvState._bgMeasureEnd.x - x0;
    const dy = cvState._bgMeasureEnd.y - y0;
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx >= 0 ? x0 : x0 - size;
    const sy = dy >= 0 ? y0 : y0 - size;
    const bi = state.dungeon.metadata.backgroundImage;
    const cellPx = gridSize * transform.scale;
    const computed = Math.round((size * (bi?.pixelsPerCell ?? 70)) / cellPx);
    ctx.save();
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(sx, sy, size, size);
    ctx.fillStyle = 'rgba(0, 212, 255, 0.08)';
    ctx.fillRect(sx, sy, size, size);
    if (size > 20) {
      setFont(ctx, 'bold 11px monospace');
      ctx.fillStyle = '#00d4ff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${computed} px/cell`, sx + 4, sy + 4);
    }
    ctx.restore();
  }

  // DM fog overlay — semi-transparent tint over unrevealed cells (persists across panels)
  if (cvState.dmFogOverlayFn) cvState.dmFogOverlayFn(ctx, transform, gridSize);

  // Session tool overlays — rendered below door buttons.
  // sessionRangeTool is persistent so player range highlights render in any session sub-mode.
  if (state.sessionToolsActive) {
    if (cvState.sessionRangeTool?.renderOverlay) cvState.sessionRangeTool.renderOverlay(ctx, transform, gridSize);
    if (cvState.sessionTool?.renderOverlay) cvState.sessionTool.renderOverlay(ctx, transform, gridSize);
  }

  // Session overlay (door-open buttons — only when session tools active)
  if (state.sessionToolsActive && cvState.sessionOverlayFn) {
    cvState.sessionOverlayFn(ctx, transform, gridSize);
  }

  // Diagnostics overlay (topmost, fixed to canvas — not affected by pan/zoom)
  const _preDiagMs = performance.now() - drawStart; // draw time before diagnostics/minimap
  fpsState._fpsFrames++;
  const now = performance.now();
  if (now - fpsState._fpsLastTime >= 1000) {
    fpsState._fpsValue = fpsState._fpsFrames;
    fpsState._fpsFrames = 0;
    fpsState._fpsLastTime = now;
  }
  const editorSettings = getEditorSettings();
  if (editorSettings.fpsCounter === true) {
    const lines = [];
    const res = metadata.resolution || 1;
    const expanded = editorSettings.diagExpanded !== false;

    // ── Header (always shown) ──
    const hzColor = rafProbe._rafProbeHz >= 55 ? '#4f4' : rafProbe._rafProbeHz >= 30 ? '#ff4' : '#f44';
    lines.push({
      text: `${expanded ? '[-]' : '[+]'} ${rafProbe._rafProbeHz}Hz | ${_preDiagMs.toFixed(1)}ms draw | ${fpsState._frameGapMs.toFixed(0)}ms gap | ${fpsState._postFrameBusyMs.toFixed(0)}ms busy`,
      color: hzColor,
    });

    if (expanded) {
      // Show previous frame's total (includes diagnostics, minimap, warnings — all post-draw work)
      if (cvState.lastDrawMs > 0) {
        lines.push({
          text: `Frame total: ${cvState.lastDrawMs.toFixed(1)}ms`,
          color: cvState.lastDrawMs < 10 ? '#8f8' : cvState.lastDrawMs < 30 ? '#ff4' : '#f44',
        });
      }

      // ── Map Info ──
      lines.push({ text: '', color: '#666' }); // spacer
      lines.push({ text: '── Map ──', color: '#666' });
      const cellCount = numRows * numCols;
      const displayCells = res > 1 ? `${numRows / res}x${numCols / res} display` : '';
      lines.push({
        text: `Grid: ${numRows}x${numCols}${res > 1 ? ` (res=${res}, ${displayCells})` : ''}`,
        color: '#aaf',
      });
      const propCount = metadata.props?.length ?? 0;
      const lightCount = metadata.lights.length || 0;
      lines.push({ text: `Props: ${propCount} | Lights: ${lightCount} | Cells: ${cellCount}`, color: '#aaa' });

      // Helper to read timing value and detect staleness
      const _tf = _currentFrame;
      const _rt = (key: string) => {
        const t = renderTimings[key];
        if (typeof t === 'number') return { ms: t, stale: true }; // legacy format

        if (!t) return { ms: 0, stale: true };
        return { ms: t.ms, stale: t.frame !== _tf };
      };
      const _fmt = (ms: number, stale: boolean) => `${ms.toFixed(1)}ms${stale ? ' (stale)' : ''}`;
      const _col = (ms: number, stale: boolean) => (stale ? '#666' : ms < 2 ? '#8f8' : ms < 5 ? '#ff4' : '#f44');

      // ── Caches ──
      lines.push({ text: '', color: '#666' });
      lines.push({ text: '── Caches ──', color: '#666' });
      lines.push({
        text: `Map: ${getMapCache().stats.cacheW}x${getMapCache().stats.cacheH} | Rebuilds: ${getMapCache().stats.cellsRebuilds} cells, ${getMapCache().stats.compositeRebuilds} comp`,
        color: '#aaa',
      });
      const rebuild = _rt('cacheRebuild');
      lines.push({
        text: `Rebuild: ${_fmt(rebuild.ms, rebuild.stale)}`,
        color: _col(rebuild.ms, rebuild.stale),
      });

      // ── Render Phases ──
      lines.push({ text: '', color: '#666' });
      lines.push({ text: '── Render ──', color: '#666' });
      const phases = [
        ['mouseMove', 'Mouse'],
        ['dots', 'Dots'],
        ['roomCells', 'RoomCells'],
        ['shading', 'Shading'],
        ['floors', 'Floors'],
        ['arcs', 'Arcs'],
        ['blending', 'Blend'],
        ['fills', 'Fills'],
        ['walls', 'Walls'],
        ['bridges', 'Bridges'],
        ['grid', 'Grid'],
        ['props', 'Props'],
        ['hazard', 'Hazard'],
        ['lighting', 'Lighting'],
        ['decorations', 'Decor'],
      ];
      for (const [key, label] of phases) {
        const t = _rt(key!);
        lines.push({
          text: `${label}: ${_fmt(t.ms, t.stale)}`,
          color: _col(t.ms, t.stale),
        });
      }

      // ── Interaction ──
      lines.push({ text: '', color: '#666' });
      lines.push({ text: '── Undo ──', color: '#666' });
      if (state._lastPushUndoMs) {
        const u = state._lastPushUndoMs;
        lines.push({
          text: `Serialize: ${u.stringify.toFixed(1)}ms | Total: ${u.total.toFixed(1)}ms`,
          color: u.stringify < 5 ? '#8f8' : u.stringify < 15 ? '#ff4' : '#f44',
        });
      }
      lines.push({
        text: `Stack: ${state.undoStack.length || 0} undo, ${state.redoStack.length || 0} redo`,
        color: '#aaa',
      });

      // ── Notify (subscriber timings) ──
      if (notifyTimings.subscribers.length > 0) {
        lines.push({ text: '', color: '#666' });
        lines.push({ text: '── Notify ──', color: '#666' });
        const nt = notifyTimings;
        lines.push({
          text: `Total: ${nt.total.toFixed(1)}ms (${nt.subscribers.length} subs)`,
          color: nt.total < 2 ? '#8f8' : nt.total < 10 ? '#ff4' : '#f44',
        });
        // Show each subscriber sorted by cost descending
        const sorted = [...nt.subscribers].sort((a, b) => b.ms - a.ms);
        for (const s of sorted) {
          lines.push({
            text: `  ${s.label}: ${s.ms.toFixed(1)}ms`,
            color: s.ms < 0.5 ? '#666' : s.ms < 2 ? '#8f8' : s.ms < 5 ? '#ff4' : '#f44',
          });
        }
      }

      // ── Memory ──
      {
        lines.push({ text: '', color: '#666' });
        lines.push({ text: '── Memory ──', color: '#666' });
        const mem = (performance as unknown as Record<string, unknown>).memory as
          | { usedJSHeapSize: number; jsHeapSizeLimit: number }
          | undefined;
        if (mem) {
          const usedMB = (mem.usedJSHeapSize / 1048576).toFixed(1);
          const limitMB = (mem.jsHeapSizeLimit / 1048576).toFixed(0);
          const ratio = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
          lines.push({
            text: `Heap: ${usedMB} / ${limitMB} MB`,
            color: ratio < 0.5 ? '#4f4' : ratio < 0.8 ? '#ff4' : '#f44',
          });
        } else {
          lines.push({ text: 'Heap: unavailable', color: '#888' });
        }
      }
    }

    ctx.save();
    setFont(ctx, 'bold 12px monospace');
    const pad = 5;
    const lineH = 18;
    // Filter out spacer lines for width calculation but keep them for layout
    const textLines = lines.filter((l) => l.text.length > 0);
    const boxW = Math.max(...textLines.map((l) => ctx.measureText(l.text).width)) + pad * 2;
    const boxH = lines.length * lineH + pad;
    const bx = 10,
      by = 10;

    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => {
      ctx.fillStyle = line.color;
      ctx.fillText(line.text, bx + pad, by + pad / 2 + lineH * i + lineH / 2);
    });
    ctx.restore();
  }

  // Minimap overlay (rendered after main canvas, references main canvas dimensions)
  updateMinimap();

  if (state.dirty) {
    state.dirty = false;
  }

  // Flush render warnings to toasts (deduplicated with 30s cooldown)
  const renderWarnings = flushRenderWarnings();
  for (const msg of renderWarnings.slice(0, 3)) {
    if (!_shownWarnings.has(msg)) {
      _shownWarnings.add(msg);
      showToast(msg, 6000);
      setTimeout(() => _shownWarnings.delete(msg), 30000);
    }
  }

  // Reset DPR transform
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // True end-of-frame timing (after ALL work including diagnostics, minimap, warnings)
  cvState.lastDrawMs = performance.now() - drawStart;
  fpsState._lastFrameEnd = performance.now();

  // Probe: measure how long the main thread stays busy after render() returns
  const _probeT = performance.now();
  setTimeout(() => {
    fpsState._postFrameBusyMs = performance.now() - _probeT;
  }, 0);
}

// ── tickAnimLoop reference ──────────────────────────────────────────────────
// The render function needs to schedule tickAnimLoop, but tickAnimLoop lives in
// the orchestrator (canvas-view.js). We use a settable reference to avoid circular imports.
let _tickAnimLoopRef = () => {};
/**
 * Set the tickAnimLoop function reference to avoid circular imports.
 * @param {Function} fn - The animation loop tick function from canvas-view.js.
 * @returns {void}
 */
export function setTickAnimLoopRef(fn: () => void): void {
  _tickAnimLoopRef = fn;
}

// ── Overlay drawing helpers ─────────────────────────────────────────────────

function drawEditorDots(
  ctx: CanvasRenderingContext2D,
  numRows: number,
  numCols: number,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
) {
  const DOT_RADIUS = 1.5;
  const resolution = state.dungeon.metadata.resolution || 1;

  // Only draw dots at display-cell boundaries (every `resolution` internal cells)
  const step = resolution;

  // Viewport culling: compute visible cell range
  const cellPx = gridSize * transform.scale;
  const minRow = cellPx > 0 ? Math.max(0, Math.floor(-transform.offsetY / cellPx) - 1) : 0;
  const maxRow =
    cellPx > 0 ? Math.min(numRows, Math.ceil((ctx.canvas.height - transform.offsetY) / cellPx) + 1) : numRows;
  const minCol = cellPx > 0 ? Math.max(0, Math.floor(-transform.offsetX / cellPx) - 1) : 0;
  const maxCol =
    cellPx > 0 ? Math.min(numCols, Math.ceil((ctx.canvas.width - transform.offsetX) / cellPx) + 1) : numCols;

  // Snap to display-cell boundaries
  const startRow = Math.floor(minRow / step) * step;
  const startCol = Math.floor(minCol / step) * step;

  ctx.save();
  ctx.fillStyle = theme.gridLine ?? '#888';
  ctx.globalAlpha = 0.5;
  ctx.beginPath();

  for (let row = startRow; row <= maxRow; row += step) {
    for (let col = startCol; col <= maxCol; col += step) {
      const p = toCanvas(col * gridSize, row * gridSize, transform);
      ctx.moveTo(p.x + DOT_RADIUS, p.y);
      ctx.arc(p.x, p.y, DOT_RADIUS, 0, Math.PI * 2);
    }
  }

  ctx.fill();
  ctx.restore();
}

function drawHoverHighlight(ctx: CanvasRenderingContext2D, gridSize: number, transform: RenderTransform) {
  if (!state.hoveredCell) return;
  const { row, col } = state.hoveredCell;
  const cells = state.dungeon.cells;
  if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length ?? 0)) return;

  const p = toCanvas(col * gridSize, row * gridSize, transform);
  const size = gridSize * transform.scale;

  ctx.fillStyle = 'rgba(100, 180, 255, 0.15)';
  ctx.fillRect(p.x, p.y, size, size);
}

function drawSelectionHighlight(ctx: CanvasRenderingContext2D, gridSize: number, transform: RenderTransform) {
  // The Select tool draws its own overlay when active — skip double-drawing
  if (state.activeTool === 'select') return;
  if (!state.selectedCells.length) return;
  ctx.strokeStyle = 'rgba(100, 180, 255, 0.8)';
  ctx.lineWidth = 2;
  for (const { row, col } of state.selectedCells) {
    const p = toCanvas(col * gridSize, row * gridSize, transform);
    const size = gridSize * transform.scale;
    ctx.strokeRect(p.x, p.y, size, size);
    ctx.fillStyle = 'rgba(100, 180, 255, 0.1)';
    ctx.fillRect(p.x, p.y, size, size);
  }
}

function drawLinkSourceHighlight(ctx: CanvasRenderingContext2D, gridSize: number, transform: RenderTransform) {
  if (state.linkSource == null) return;

  // New stair system: linkSource is a stair ID (number)
  if (typeof state.linkSource === 'number') {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const stairs = state.dungeon.metadata.stairs || [];
    const stairDef = stairs.find((s) => s.id === state.linkSource);
    if (!stairDef) return;
    // Highlight all cells belonging to this stair
    const cells = state.dungeon.cells;
    ctx.strokeStyle = 'rgba(255, 180, 50, 0.9)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 3]);
    ctx.fillStyle = 'rgba(255, 180, 50, 0.15)';
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
        if (cells[r]?.[c]?.center?.['stair-id'] === state.linkSource) {
          const p = toCanvas(c * gridSize, r * gridSize, transform);
          const size = gridSize * transform.scale;
          ctx.strokeRect(p.x, p.y, size, size);
          ctx.fillRect(p.x, p.y, size, size);
        }
      }
    }
    ctx.setLineDash([]);
    return;
  }

  // Legacy path: linkSource is { row, col, level }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof state.linkSource !== 'object' || state.linkSource === null) return;
  const legacySource = state.linkSource as { row: number; col: number; level: number };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (legacySource.level == null) return;
  if (legacySource.level !== state.currentLevel) return;
  const { row, col } = legacySource;
  const p = toCanvas(col * gridSize, row * gridSize, transform);
  const size = gridSize * transform.scale;

  ctx.strokeStyle = 'rgba(255, 180, 50, 0.9)';
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(p.x, p.y, size, size);
  ctx.fillStyle = 'rgba(255, 180, 50, 0.15)';
  ctx.fillRect(p.x, p.y, size, size);
  ctx.setLineDash([]);
}

function drawEdgeHighlight(ctx: CanvasRenderingContext2D, gridSize: number, transform: RenderTransform) {
  if ((state.activeTool !== 'wall' && state.activeTool !== 'door') || !state.hoveredEdge) return;
  const { direction, row, col } = state.hoveredEdge;

  ctx.strokeStyle = 'rgba(255, 200, 50, 0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();

  const x = col * gridSize,
    y = row * gridSize;

  if (direction === 'north') {
    const p1 = toCanvas(x, y, transform),
      p2 = toCanvas(x + gridSize, y, transform);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'south') {
    const p1 = toCanvas(x, y + gridSize, transform),
      p2 = toCanvas(x + gridSize, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'east') {
    const p1 = toCanvas(x + gridSize, y, transform),
      p2 = toCanvas(x + gridSize, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'west') {
    const p1 = toCanvas(x, y, transform),
      p2 = toCanvas(x, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'nw-se') {
    const p1 = toCanvas(x, y, transform),
      p2 = toCanvas(x + gridSize, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'ne-sw') {
    const p1 = toCanvas(x + gridSize, y, transform),
      p2 = toCanvas(x, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
}

// Cached replacement for `drawScaleIndicatorOnMap` — same output but the
// text (fixed font + gridSize/resolution-dependent label) is rendered once
// to an OffscreenCanvas and blitted each frame.
function drawScaleIndicatorOnMapCached(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  resolution: number,
): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const s = transform.scale / 10;
  const centerXf = (numCols * gridSize) / 2;
  const bottomYf = numRows * gridSize + 10;
  const p = toCanvas(centerXf, bottomYf, transform);

  const fontSize = Math.max(8, Math.round(12 * s));
  const font = `bold ${fontSize}px serif`;
  const color = theme.textColor ?? '#000';
  const label = `1 square = ${_dgs(gridSize, resolution)} feet`;
  const entry = getCachedText(label, font, color);
  drawCachedText(ctx, entry, p.x, p.y, 'center', 'top');
}

function drawDungeonTitleOnMap(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  metadata: Metadata,
) {
  const dungeonName = metadata.dungeonName;
  if (!dungeonName) return;

  const numCols = cells[0]?.length ?? 0;
  const centerWorldX = (numCols * gridSize) / 2;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const hasSubtitles = metadata.levels && metadata.levels.length > 1;

  const textColor = theme.textColor ?? '#000';

  // Main title — bold, above the dungeon. Cached per (text, font, color) so
  // the font parse + glyph rasterization only runs when one of those changes.
  const titleFontSize = Math.max(10, Math.round((32 * transform.scale) / 10));
  const titleFont = `bold ${titleFontSize}px Georgia, "Times New Roman", serif`;
  const titleEntry = getCachedText(dungeonName, titleFont, textColor);
  const titleWorldY = hasSubtitles ? -gridSize * 1.0 : -gridSize * 0.5;
  const titleP = toCanvas(centerWorldX, titleWorldY, transform);
  // Original used textBaseline = 'bottom' anchored at titleP.y — alphabetic
  // placement with the glyph descender just above that line looks the same
  // visually and is what 'bottom' effectively did for this font.
  drawCachedText(ctx, titleEntry, titleP.x, titleP.y, 'center', 'bottom');

  // Level subtitles — italic, above each level's startRow (including level 0)
  if (hasSubtitles) {
    const subtitleFontSize = Math.max(8, Math.round((18 * transform.scale) / 10));
    const subtitleFont = `italic ${subtitleFontSize}px Georgia, "Times New Roman", serif`;
    for (const level of metadata.levels) {
      if (!level.name) continue;
      const p = toCanvas(centerWorldX, level.startRow * gridSize, transform);
      const entry = getCachedText(level.name, subtitleFont, textColor);
      drawCachedText(ctx, entry, p.x, p.y - 10, 'center', 'bottom');
    }
  }
}

function drawLevelSeparators(
  ctx: CanvasRenderingContext2D,
  levels: { startRow: number; numRows: number; name: string | null }[],
  gridSize: number,
  transform: RenderTransform,
  theme: Theme,
) {
  ctx.strokeStyle = theme.textColor ?? '#888';
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 4]);

  const numCols = state.dungeon.cells[0]?.length ?? 0;

  for (const level of levels) {
    if (level.startRow === 0) continue;
    const p = toCanvas(0, level.startRow * gridSize, transform);
    const p2 = toCanvas(numCols * gridSize, level.startRow * gridSize, transform);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
