// Canvas element management, pan/zoom, mouse event routing
import state, { getTheme, markDirty, notify, subscribe, notifyTimings } from './state.js';
import { renderCells, renderLabels, drawBorderOnMap, drawScaleIndicatorOnMap, findCompassRosePositionOnMap, drawCompassRoseScaled, renderLightmap, renderCoverageHeatmap, extractFillLights, flushRenderWarnings, renderTimings, bumpTimingFrame, getTimingFrame, getContentVersion, getLightingVersion, getDirtyRegion, consumeDirtyRegion, MapCache } from '../../render/index.js';
import { showToast } from './toast.js';
import { toCanvas, pixelToCell, nearestEdge, nearestCorner } from './utils.js';
import { displayGridSize as _dgs } from '../../util/index.js';
import { initMinimap, updateMinimap } from './minimap.js';
import { getEditorSettings, setEditorSetting } from './editor-settings.js';

const CELL_SIZE = 40; // pixels per cell at zoom=1
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5.0;

let canvas, ctx;
let animFrameId = null;
let animLoopId = null;  // separate handle for the continuous animation loop

// HiDPI / devicePixelRatio support
let _dpr = 1;       // window.devicePixelRatio (updated on resize)
let _canvasW = 0;   // CSS/logical canvas width
let _canvasH = 0;   // CSS/logical canvas height
const _shownWarnings = new Set(); // dedup render warnings with 30s cooldown

// FPS tracking
let _fpsFrames = 0;
let _fpsLastTime = 0;
let _fpsValue = 0;
let _lastFrameEnd = 0;
let _frameGapMs = 0;
let _postFrameBusyMs = 0; // time main thread stays busy after render() returns


// Raw rAF rate counter (independent of render calls)
let _rafProbeCount = 0;
let _rafProbeStart = 0;
let _rafProbeHz = 0;
if (typeof requestAnimationFrame === 'function') {
  (function probeRAF() {
    _rafProbeCount++;
    const now = performance.now();
    if (!_rafProbeStart) _rafProbeStart = now;
    if (now - _rafProbeStart >= 1000) {
      _rafProbeHz = _rafProbeCount;
      _rafProbeCount = 0;
      _rafProbeStart = now;
    }
    requestAnimationFrame(probeRAF);
  })();
}

// ── Offscreen map cache ─────────────────────────────────────────────────────
// renderCells is expensive (thousands of GPU commands). We render it once to an
// offscreen canvas when the map data changes, then blit the cached image on every
// frame. Pan/zoom becomes a single drawImage instead of re-rendering all cells.
let _mapCache = null; // created lazily on first use (avoids module init order issues)
let _lastHoveredCell = null;  // tracks hovered cell to avoid redundant renders on mouse-move

function getMapCache() {
  if (!_mapCache) _mapCache = new MapCache({ pxPerFoot: 20, maxCacheDim: 16384 });
  return _mapCache;
}

/** Force the offscreen map cache to rebuild on next frame. Call after theme/texture/feature changes. */
export function invalidateMapCache() { getMapCache().invalidate(); }

// Cache for background image HTMLImageElement — avoids recreating every frame
let _bgImgCache = { dataUrl: null, el: null };
export function getCachedBgImage(dataUrl) {
  if (_bgImgCache.dataUrl !== dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    _bgImgCache = { dataUrl, el: img };
  }
  return _bgImgCache.el;
}

// Background cell measure drag state
let _bgMeasureActive = false;
let _bgMeasureCallback = null; // (newPixelsPerCell: number) => void
let _bgMeasureStart = null;    // { x, y } canvas coords
let _bgMeasureEnd = null;      // { x, y } canvas coords

export function activateBgCellMeasure(callback) {
  _bgMeasureActive = true;
  _bgMeasureCallback = callback;
  _bgMeasureStart = null;
  _bgMeasureEnd = null;
  if (canvas) canvas.style.cursor = 'crosshair';
}

function _cancelBgMeasure() {
  _bgMeasureActive = false;
  _bgMeasureCallback = null;
  _bgMeasureStart = null;
  _bgMeasureEnd = null;
}

const ANIM_INTERVAL_MS = 50; // 20fps — sufficient for fire/pulse, avoids 60fps render spam

function tickAnimLoop() {
  animLoopId = null;
  const { metadata } = state.dungeon;
  if (!metadata.lightingEnabled) return;
  if (!(metadata.lights || []).some(l => l.animation?.type)) return;
  state.animClock = performance.now() / 1000;
  requestRender();
  animLoopId = setTimeout(tickAnimLoop, ANIM_INTERVAL_MS);
}

export function startAnimLoop() {
  if (animLoopId) return;
  animLoopId = setTimeout(tickAnimLoop, ANIM_INTERVAL_MS);
}

export function stopAnimLoop() {
  if (animLoopId) {
    clearTimeout(animLoopId);
    animLoopId = null;
  }
}

let isPanning = false;
let panStartX = 0, panStartY = 0;
let panStartPanX = 0, panStartPanY = 0;

// Right-click: pan if dragged, erase if just clicked
let rightDown = false;
let rightStartX = 0, rightStartY = 0;
let rightStartPanX = 0, rightStartPanY = 0;
let rightDragged = false;
const PAN_THRESHOLD = 5; // pixels before a right-click becomes a pan

// Active tool reference (set by main.js)
let activeTool = null;

// Session overlay callback (set by dm-session.js)
let sessionOverlayFn = null;
let sessionClickFn = null;

// DM fog overlay callback (always rendered when session active, regardless of active panel)
let dmFogOverlayFn = null;

// Session tool (e.g., range detector — receives full mouse events in session mode)
let sessionTool = null;
// Persistent range tool reference — always rendered when session is active so
// remote (player) range highlights are visible even in door mode.
let sessionRangeTool = null;

export function setSessionOverlay(renderFn, clickFn) {
  sessionOverlayFn = renderFn;
  sessionClickFn = clickFn;
}

export function setDmFogOverlay(fn) {
  dmFogOverlayFn = fn;
}

export function setSessionTool(tool) {
  if (sessionTool?.onDeactivate) sessionTool.onDeactivate();
  sessionTool = tool;
  if (sessionTool?.onActivate) sessionTool.onActivate();
}

export function setSessionRangeTool(tool) {
  sessionRangeTool = tool;
}

// Draw time tracking
let lastDrawMs = 0;

export function setActiveTool(tool) {
  activeTool = tool;
}

/** Watch for devicePixelRatio changes (e.g. window moved to a different-DPI monitor). */
function _watchDpr() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener('change', () => { resizeCanvas(); _watchDpr(); }, { once: true });
}

// Debug: skip specific render phases to isolate GPU bottleneck.
// Set via console: window._skipPhases = { shading: true, lighting: true }
if (typeof window !== 'undefined') window._skipPhases = {};

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  // Re-render on DPR change (e.g. moving window between monitors with different scaling)
  _watchDpr();
  initMinimap(canvas);

  // Re-render when state changes (theme, features, metadata, etc.)
  subscribe(() => {
    // Always re-render on dirty flag (edits) or texturesVersion change (async texture loads)
    requestRender();
  }, 'canvas-view');

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('mouseenter', restoreToolCursor);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  requestRender();
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const prevDpr = _dpr;
  _dpr = window.devicePixelRatio || 1;
  _canvasW = rect.width;
  _canvasH = rect.height;
  canvas.width = Math.round(_canvasW * _dpr);
  canvas.height = Math.round(_canvasH * _dpr);
  // CSS width:100%;height:100% handles layout sizing — don't override with inline styles
  if (_dpr !== prevDpr) invalidateMapCache();
  markDirty();
  requestRender();
}

function requestRender() {
  if (animFrameId) return;
  animFrameId = requestAnimationFrame(render);
}

/**
 * Build the transform object that maps dungeon feet → canvas pixels.
 * This mirrors the Node renderer's transform but uses our zoom/pan.
 */
function getTransform() {
  const { gridSize, resolution } = state.dungeon.metadata;
  const scale = CELL_SIZE * state.zoom / _dgs(gridSize, resolution); // pixels per foot
  return {
    offsetX: state.panX,
    offsetY: state.panY,
    scale,
  };
}

export { getTransform };

function render() {
  animFrameId = null;
  if (!canvas) return;
  const _currentFrame = bumpTimingFrame();
  const drawStart = performance.now();
  if (_lastFrameEnd > 0) _frameGapMs = drawStart - _lastFrameEnd;

  const { dungeon } = state;
  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize;
  const theme = getTheme();
  if (!theme) return; // Theme catalog not loaded yet
  const transform = getTransform();
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Clear canvas (physical pixel dimensions)
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Apply DPR scaling — all subsequent drawing uses CSS/logical coordinates
  ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);

  // Draw background (entire canvas, logical dimensions)
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, _canvasW, _canvasH);

  const _skip = (typeof window !== 'undefined' && window._skipPhases) || {};

  // Debug: skip ALL rendering (just background fill) to test compositor behavior
  if (_skip.all) {
    lastDrawMs = performance.now() - drawStart;
    _lastFrameEnd = performance.now();
    // still draw diagnostics below
    _fpsFrames++;
    const now = performance.now();
    if (now - _fpsLastTime >= 1000) { _fpsValue = _fpsFrames; _fpsFrames = 0; _fpsLastTime = now; }
    const editorSettings = getEditorSettings();
    if (editorSettings.fpsCounter === true) {
      const lines = [{ text: `Draw: ${lastDrawMs.toFixed(1)}ms | ${_fpsValue} fps | gap: ${_frameGapMs.toFixed(0)}ms | rAF: ${_rafProbeHz}Hz`, color: '#4f4' },
        { text: 'SKIP ALL — compositor test', color: '#f84' }];
      ctx.font = '13px monospace';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(4, 4 + i * 17, ctx.measureText(lines[i].text).width + 8, 16);
        ctx.fillStyle = lines[i].color;
        ctx.fillText(lines[i].text, 8, 16 + i * 17);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }

  // Render the dungeon cells (WYSIWYG)
  const showGrid = metadata.features?.showGrid !== false;
  const labelStyle = metadata.labelStyle || 'circled';
  const textureOptions = state.textureCatalog
    ? { catalog: state.textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35, texturesVersion: state.texturesVersion ?? 0 }
    : { catalog: null, blendWidth: 0, texturesVersion: state.texturesVersion ?? 0 };
  const lightingEnabled = !!metadata.lightingEnabled;
  const showInvisible = state.activeTool === 'wall' || state.activeTool === 'door';
  const bgImgConfig = metadata.backgroundImage ?? null;
  const bgImageEl = bgImgConfig?.dataUrl ? getCachedBgImage(bgImgConfig.dataUrl) : null;

  // ── Offscreen map cache ───────────────────────────────────────────────────
  // Render the expensive cell pipeline + lighting to a cached bitmap.
  // Only re-render when map data changes (version bump). Pan/zoom just blits.
  // Cache resolution from editor settings (10=Low, 15=Medium, 20=High, 30=Ultra)
  const MAP_PX_PER_FOOT = getEditorSettings().renderQuality || 20;
  const mapCache = getMapCache();
  mapCache.pxPerFoot = MAP_PX_PER_FOOT;
  const useCache = mapCache.canCache(numRows, numCols, gridSize) && !_skip.cells;

  const animClock = state.animClock ?? 0;
  const hasAnimLights = lightingEnabled && (metadata.lights || []).some(l => l.animation?.type);

  if (useCache) {
    const _cacheStart = performance.now();
    const rebuilt = mapCache.update({
      contentVersion: getContentVersion(),
      lightingVersion: getLightingVersion(),
      texturesVersion: state.texturesVersion ?? 0,
      cells, gridSize, theme,
      showGrid: showGrid && !_skip.grid,
      labelStyle,
      propCatalog: state.propCatalog,
      textureOptions,
      metadata,
      showInvisible,
      bgImageEl, bgImgConfig,
      lightingEnabled,
      hasAnimLights,
      lights: metadata.lights,
      animClock,
      lightPxPerFoot: getEditorSettings().lightQuality || 10,
      ambientLight: metadata.ambientLight ?? 0.15,
      ambientColor: metadata.ambientColor || '#ffffff',
      textureCatalog: state.textureCatalog,
      dirtyRegion: getDirtyRegion(),
      preRenderHook: _skip.dots ? null : (offCtx, t) => drawEditorDots(offCtx, numRows, numCols, gridSize, theme, t),
      skipPhases: Object.keys(_skip).some(k => _skip[k] && k !== 'all') ? _skip : null,
      skipLabels: lightingEnabled || !!_skip.labels,
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
          ? [...(metadata.lights || []), ...fillLights]
          : (metadata.lights || []);
        const LIGHT_PX_PER_FOOT = getEditorSettings().lightQuality || 10;
        const sx = transform.scale / MAP_PX_PER_FOOT;
        const mapScreenW = composite.cacheW * sx;
        const mapScreenH = composite.cacheH * sx;
        renderLightmap(ctx, allLights, cells, gridSize,
          { scale: transform.scale, offsetX: 0, offsetY: 0 },
          Math.ceil(mapScreenW), Math.ceil(mapScreenH), metadata.ambientLight ?? 0.15,
          state.textureCatalog, state.propCatalog,
          {
            ambientColor: metadata.ambientColor || '#ffffff', time: animClock,
            lightPxPerFoot: LIGHT_PX_PER_FOOT,
            destX: transform.offsetX, destY: transform.offsetY,
            destW: mapScreenW, destH: mapScreenH,
          },
          metadata);
      }
    }

  } else {
    // Fallback: direct render (huge maps or skip mode)
    const _dotsStart = performance.now();
    if (!_skip.dots) drawEditorDots(ctx, numRows, numCols, gridSize, theme, transform);
    renderTimings.dots = { ms: performance.now() - _dotsStart, frame: _currentFrame };

    const cellPxSize = gridSize * transform.scale;
    const CULL_MARGIN = 2;
    const visibleBounds = cellPxSize > 0 ? {
      minRow: Math.max(0, Math.floor(-transform.offsetY / cellPxSize) - CULL_MARGIN),
      maxRow: Math.min(numRows - 1, Math.ceil((canvas.height - transform.offsetY) / cellPxSize) + CULL_MARGIN),
      minCol: Math.max(0, Math.floor(-transform.offsetX / cellPxSize) - CULL_MARGIN),
      maxCol: Math.min(numCols - 1, Math.ceil((canvas.width - transform.offsetX) / cellPxSize) + CULL_MARGIN),
    } : null;

    if (!_skip.cells) renderCells(ctx, cells, gridSize, theme, transform, {
      showGrid: showGrid && !_skip.grid, labelStyle, propCatalog: _skip.props ? null : state.propCatalog, textureOptions: _skip.textures ? null : textureOptions, metadata,
      skipLabels: lightingEnabled || _skip.labels, showInvisible,
      bgImageEl, bgImgConfig,
      visibleBounds,
    });

    if (lightingEnabled && !_skip.lighting) {
      const _lightStart = performance.now();
      const fillLights = extractFillLights(cells, gridSize, theme);
      const allLights = fillLights.length
        ? [...(metadata.lights || []), ...fillLights]
        : (metadata.lights || []);
      renderLightmap(ctx, allLights, cells, gridSize, transform,
        _canvasW, _canvasH, metadata.ambientLight ?? 0.15,
        state.textureCatalog, state.propCatalog,
        { ambientColor: metadata.ambientColor || '#ffffff', time: state.animClock ?? 0 },
        metadata);
      renderTimings.lighting = { ms: performance.now() - _lightStart, frame: _currentFrame };
      renderLabels(ctx, cells, gridSize, theme, transform, labelStyle);
    }
  }

  // Auto-manage animation loop based on animated lights
  if (lightingEnabled) {
    const hasAnimLights = (metadata.lights || []).some(l => l.animation?.type);
    if (hasAnimLights && !animLoopId) {
      animLoopId = setTimeout(tickAnimLoop, ANIM_INTERVAL_MS);
    } else if (!hasAnimLights && animLoopId) {
      clearTimeout(animLoopId);
      animLoopId = null;
    }
    if (state.lightCoverageMode) {
      renderCoverageHeatmap(ctx, metadata.lights, cells, gridSize, transform);
    }
  } else if (animLoopId) {
    clearTimeout(animLoopId);
    animLoopId = null;
  }

  // Feature decorations (rendered in dungeon coordinate space — pan/zoom with the map)
  const _decoStart = performance.now();
  const features = metadata.features || {};
  if (features.border !== false) {
    drawBorderOnMap(ctx, cells, gridSize, theme, transform);
  }
  if (features.compassRose !== false) {
    const pos = findCompassRosePositionOnMap(cells, gridSize, transform);
    if (pos) drawCompassRoseScaled(ctx, pos.x, pos.y, theme, pos.scale);
  }
  if (features.scale !== false) {
    drawScaleIndicatorOnMap(ctx, cells, gridSize, theme, transform, metadata.resolution);
  }

  // Draw dungeon title (and per-level titles on multi-level maps)
  drawDungeonTitleOnMap(ctx, cells, gridSize, theme, transform, metadata);
  renderTimings.decorations = { ms: performance.now() - _decoStart, frame: _currentFrame };

  // Draw level separators
  if (metadata.levels && metadata.levels.length > 1) {
    drawLevelSeparators(ctx, metadata.levels, gridSize, transform, theme);
  }

  // Editor overlays
  drawHoverHighlight(ctx, gridSize, transform);
  drawSelectionHighlight(ctx, gridSize, transform);
  drawLinkSourceHighlight(ctx, gridSize, transform);
  drawEdgeHighlight(ctx, gridSize, transform);

  // Tool overlay — suppressed while panning (right-drag or Alt+drag)
  if (activeTool?.renderOverlay && !isPanning && !rightDragged) {
    activeTool.renderOverlay(ctx, transform, gridSize);
  }

  // Debug: hitbox overlay — cyan = lighting hitbox, yellow = selection hitbox (when different)
  if (state.debugShowHitboxes && state.propCatalog && metadata.props?.length) {
    ctx.save();
    for (const prop of metadata.props) {
      const propDef = state.propCatalog.props[prop.type];
      if (!propDef?.hitbox) continue;
      const rotation = prop.rotation ?? 0;
      const scl = prop.scale ?? 1.0;
      const flipped = prop.flipped ?? false;
      const [fRows, fCols] = propDef.footprint;
      const r = ((rotation % 360) + 360) % 360;

      function hitboxToScreen(points) {
        return points.map(([hx, hy]) => {
          let px = flipped ? fCols - hx : hx;
          let py = hy;
          // Rotate around footprint center using general rotation math
          // Note: prop rotation is CCW in the data model (negative ctx.rotate),
          // so negate the angle to match visual rendering
          const cx = fCols / 2, cy = fRows / 2;
          if (r !== 0) {
            const rad = (-rotation * Math.PI) / 180;
            const cosA = Math.cos(rad), sinA = Math.sin(rad);
            const dx = px - cx, dy = py - cy;
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

      function drawPoly(screenPts, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        for (let i = 0; i < screenPts.length; i++) {
          if (i === 0) ctx.moveTo(screenPts[i].x, screenPts[i].y);
          else ctx.lineTo(screenPts[i].x, screenPts[i].y);
        }
        ctx.closePath();
        ctx.stroke();
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

  // Background cell measure overlay
  if (_bgMeasureActive && _bgMeasureStart && _bgMeasureEnd) {
    const x0 = _bgMeasureStart.x;
    const y0 = _bgMeasureStart.y;
    const dx = _bgMeasureEnd.x - x0;
    const dy = _bgMeasureEnd.y - y0;
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx >= 0 ? x0 : x0 - size;
    const sy = dy >= 0 ? y0 : y0 - size;
    const bi = state.dungeon.metadata.backgroundImage;
    const cellPx = gridSize * transform.scale;
    const computed = Math.round(size * (bi?.pixelsPerCell ?? 70) / cellPx);
    ctx.save();
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(sx, sy, size, size);
    ctx.fillStyle = 'rgba(0, 212, 255, 0.08)';
    ctx.fillRect(sx, sy, size, size);
    if (size > 20) {
      ctx.font = 'bold 11px monospace';
      ctx.fillStyle = '#00d4ff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${computed} px/cell`, sx + 4, sy + 4);
    }
    ctx.restore();
  }

  // DM fog overlay — semi-transparent tint over unrevealed cells (persists across panels)
  if (dmFogOverlayFn) dmFogOverlayFn(ctx, transform, gridSize);

  // Session tool overlays — rendered below door buttons.
  // sessionRangeTool is persistent so player range highlights render in any session sub-mode.
  if (state.sessionToolsActive) {
    if (sessionRangeTool?.renderOverlay) sessionRangeTool.renderOverlay(ctx, transform, gridSize);
    if (sessionTool?.renderOverlay) sessionTool.renderOverlay(ctx, transform, gridSize);
  }

  // Session overlay (door-open buttons — only when session tools active)
  if (state.sessionToolsActive && sessionOverlayFn) {
    sessionOverlayFn(ctx, transform, gridSize);
  }

  // Diagnostics overlay (topmost, fixed to canvas — not affected by pan/zoom)
  const _preDiagMs = performance.now() - drawStart; // draw time before diagnostics/minimap
  _fpsFrames++;
  const now = performance.now();
  if (now - _fpsLastTime >= 1000) {
    _fpsValue = _fpsFrames;
    _fpsFrames = 0;
    _fpsLastTime = now;
  }
  const editorSettings = getEditorSettings();
  if (editorSettings.fpsCounter === true) {
    const lines = [];
    const res = metadata.resolution || 1;
    const expanded = editorSettings.diagExpanded !== false;

    // ── Header (always shown) ──
    const hzColor = _rafProbeHz >= 55 ? '#4f4' : _rafProbeHz >= 30 ? '#ff4' : '#f44';
    lines.push({
      text: `${expanded ? '[-]' : '[+]'} ${_rafProbeHz}Hz | ${_preDiagMs.toFixed(1)}ms draw | ${_frameGapMs.toFixed(0)}ms gap | ${_postFrameBusyMs.toFixed(0)}ms busy`,
      color: hzColor,
    });

    if (expanded) {
      // Show previous frame's total (includes diagnostics, minimap, warnings — all post-draw work)
      if (lastDrawMs > 0) {
        lines.push({
          text: `Frame total: ${lastDrawMs.toFixed(1)}ms`,
          color: lastDrawMs < 10 ? '#8f8' : lastDrawMs < 30 ? '#ff4' : '#f44',
        });
      }

      // ── Map Info ──
      lines.push({ text: '', color: '#666' }); // spacer
      lines.push({ text: '── Map ──', color: '#666' });
      const cellCount = numRows * numCols;
      const displayCells = res > 1 ? `${numRows / res}x${numCols / res} display` : '';
      lines.push({ text: `Grid: ${numRows}x${numCols}${res > 1 ? ` (res=${res}, ${displayCells})` : ''}`, color: '#aaf' });
      const propCount = metadata.props?.length || 0;
      const lightCount = metadata.lights?.length || 0;
      lines.push({ text: `Props: ${propCount} | Lights: ${lightCount} | Cells: ${cellCount}`, color: '#aaa' });

      // Helper to read timing value and detect staleness
      const _tf = _currentFrame;
      const _rt = (key) => {
        const t = renderTimings[key];
        if (!t) return { ms: 0, stale: true };
        if (typeof t === 'number') return { ms: t, stale: true }; // legacy format
        return { ms: t.ms, stale: t.frame !== _tf };
      };
      const _fmt = (ms, stale) => `${ms.toFixed(1)}ms${stale ? ' (stale)' : ''}`;
      const _col = (ms, stale) => stale ? '#666' : ms < 2 ? '#8f8' : ms < 5 ? '#ff4' : '#f44';

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
        ['mouseMove', 'Mouse'], ['dots', 'Dots'], ['roomCells', 'RoomCells'],
        ['shading', 'Shading'], ['floors', 'Floors'], ['arcs', 'Arcs'],
        ['blending', 'Blend'], ['fills', 'Fills'], ['walls', 'Walls'],
        ['bridges', 'Bridges'], ['grid', 'Grid'], ['props', 'Props'],
        ['hazard', 'Hazard'], ['lighting', 'Lighting'], ['decorations', 'Decor'],
      ];
      for (const [key, label] of phases) {
        const t = _rt(key);
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
      lines.push({ text: `Stack: ${state.undoStack?.length || 0} undo, ${state.redoStack?.length || 0} redo`, color: '#aaa' });

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
        const mem = performance.memory;
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
    ctx.font = 'bold 12px monospace';
    const pad = 5;
    const lineH = 18;
    // Filter out spacer lines for width calculation but keep them for layout
    const textLines = lines.filter(l => l.text.length > 0);
    const boxW = Math.max(...textLines.map(l => ctx.measureText(l.text).width)) + pad * 2;
    const boxH = lines.length * lineH + pad;
    const bx = 10, by = 10;

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
  lastDrawMs = performance.now() - drawStart;
  _lastFrameEnd = performance.now();

  // Probe: measure how long the main thread stays busy after render() returns
  const _probeT = performance.now();
  setTimeout(() => { _postFrameBusyMs = performance.now() - _probeT; }, 0);
}

function drawEditorDots(ctx, numRows, numCols, gridSize, theme, transform) {
  const DOT_RADIUS = 1.5;
  const resolution = state.dungeon?.metadata?.resolution || 1;

  // Only draw dots at display-cell boundaries (every `resolution` internal cells)
  const step = resolution;

  // Viewport culling: compute visible cell range
  const cellPx = gridSize * transform.scale;
  const minRow = cellPx > 0 ? Math.max(0, Math.floor(-transform.offsetY / cellPx) - 1) : 0;
  const maxRow = cellPx > 0 ? Math.min(numRows, Math.ceil((ctx.canvas.height - transform.offsetY) / cellPx) + 1) : numRows;
  const minCol = cellPx > 0 ? Math.max(0, Math.floor(-transform.offsetX / cellPx) - 1) : 0;
  const maxCol = cellPx > 0 ? Math.min(numCols, Math.ceil((ctx.canvas.width - transform.offsetX) / cellPx) + 1) : numCols;

  // Snap to display-cell boundaries
  const startRow = Math.floor(minRow / step) * step;
  const startCol = Math.floor(minCol / step) * step;

  ctx.save();
  ctx.fillStyle = theme.gridLine || '#888';
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

function drawHoverHighlight(ctx, gridSize, transform) {
  if (!state.hoveredCell) return;
  const { row, col } = state.hoveredCell;
  const cells = state.dungeon.cells;
  if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;

  const p = toCanvas(col * gridSize, row * gridSize, transform);
  const size = gridSize * transform.scale;

  ctx.fillStyle = 'rgba(100, 180, 255, 0.15)';
  ctx.fillRect(p.x, p.y, size, size);
}

function drawSelectionHighlight(ctx, gridSize, transform) {
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

function drawLinkSourceHighlight(ctx, gridSize, transform) {
  if (state.linkSource == null) return;

  // New stair system: linkSource is a stair ID (number)
  if (typeof state.linkSource === 'number') {
    const stairs = state.dungeon.metadata?.stairs || [];
    const stairDef = stairs.find(s => s.id === state.linkSource);
    if (!stairDef) return;
    // Highlight all cells belonging to this stair
    const cells = state.dungeon.cells;
    ctx.strokeStyle = 'rgba(255, 180, 50, 0.9)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 3]);
    ctx.fillStyle = 'rgba(255, 180, 50, 0.15)';
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
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
  if (!state.linkSource.level && state.linkSource.level !== 0) return;
  if (state.linkSource.level !== state.currentLevel) return;
  const { row, col } = state.linkSource;
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

function drawEdgeHighlight(ctx, gridSize, transform) {
  if ((state.activeTool !== 'wall' && state.activeTool !== 'door') || !state.hoveredEdge) return;
  const { direction, row, col } = state.hoveredEdge;

  ctx.strokeStyle = 'rgba(255, 200, 50, 0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();

  const x = col * gridSize, y = row * gridSize;

  if (direction === 'north') {
    const p1 = toCanvas(x, y, transform), p2 = toCanvas(x + gridSize, y, transform);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'south') {
    const p1 = toCanvas(x, y + gridSize, transform), p2 = toCanvas(x + gridSize, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'east') {
    const p1 = toCanvas(x + gridSize, y, transform), p2 = toCanvas(x + gridSize, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'west') {
    const p1 = toCanvas(x, y, transform), p2 = toCanvas(x, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'nw-se') {
    const p1 = toCanvas(x, y, transform), p2 = toCanvas(x + gridSize, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  } else if (direction === 'ne-sw') {
    const p1 = toCanvas(x + gridSize, y, transform), p2 = toCanvas(x, y + gridSize, transform);
    ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
}

function drawDungeonTitleOnMap(ctx, cells, gridSize, theme, transform, metadata) {
  const dungeonName = metadata.dungeonName;
  if (!dungeonName) return;

  const numCols = cells[0]?.length || 0;
  const centerWorldX = (numCols * gridSize) / 2;
  const hasSubtitles = metadata.levels && metadata.levels.length > 1;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.textColor || '#000';

  // Main title — bold, above the dungeon. Give extra headroom when subtitles follow.
  const titleFontSize = Math.max(10, Math.round(32 * transform.scale / 10));
  ctx.font = `bold ${titleFontSize}px Georgia, "Times New Roman", serif`;
  ctx.textBaseline = 'bottom';
  const titleWorldY = hasSubtitles ? -gridSize * 1.0 : -gridSize * 0.5;
  const titleP = toCanvas(centerWorldX, titleWorldY, transform);
  ctx.fillText(dungeonName, titleP.x, titleP.y);

  // Level subtitles — italic, above each level's startRow (including level 0)
  if (hasSubtitles) {
    const subtitleFontSize = Math.max(8, Math.round(18 * transform.scale / 10));
    ctx.font = `italic ${subtitleFontSize}px Georgia, "Times New Roman", serif`;
    for (const level of metadata.levels) {
      if (!level.name) continue;
      const p = toCanvas(centerWorldX, level.startRow * gridSize, transform);
      ctx.fillText(level.name, p.x, p.y - 10);
    }
  }

  ctx.restore();
}

function drawLevelSeparators(ctx, levels, gridSize, transform, theme) {
  ctx.strokeStyle = theme.textColor || '#888';
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 4]);

  const numCols = state.dungeon.cells[0]?.length || 0;

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

// ─── Mouse event handlers ───────────────────────────────────────────────────

function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onMouseDown(e) {
  const pos = getMousePos(e);

  // Diagnostics overlay click — toggle expand/collapse
  const es = getEditorSettings();
  if (es.fpsCounter && e.button === 0 && pos.x < 300 && pos.y < 30) {
    setEditorSetting('diagExpanded', !es.diagExpanded);
    requestRender();
    return;
  }

  // Background cell measure mode — intercept left click before normal tool routing
  if (_bgMeasureActive && e.button === 0) {
    _bgMeasureStart = pos;
    _bgMeasureEnd = pos;
    e.preventDefault();
    requestRender();
    return;
  }

  // Alt+click: pan (unless the active tool handles Alt itself, e.g. paint syringe)
  if (e.button === 0 && e.altKey && state.activeTool !== 'paint') {
    isPanning = true;
    panStartX = pos.x;
    panStartY = pos.y;
    panStartPanX = state.panX;
    panStartPanY = state.panY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  // Right-click: start tracking — will become pan (drag) or erase (click)
  if (e.button === 2) {
    // If tool has an active drag, cancel it immediately
    if (activeTool?.onCancel && activeTool.onCancel()) {
      requestRender();
      return;
    }
    rightDown = true;
    rightDragged = false;
    rightStartX = pos.x;
    rightStartY = pos.y;
    rightStartPanX = state.panX;
    rightStartPanY = state.panY;
    e.preventDefault();
    return;
  }

  if (e.button === 0) {
    // Session tools mode
    if (state.sessionToolsActive) {
      const transform = getTransform();
      const gridSize = state.dungeon.metadata.gridSize;

      // If a session tool (e.g., range detector) is active, route full mouse events to it
      if (sessionTool) {
        const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
        const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
        sessionTool.onMouseDown(cell.row, cell.col, edge, e, pos);
        requestRender();
        return;
      }

      // Fall through to click-based session handlers (doors, stairs)
      if (sessionClickFn) {
        sessionClickFn(pos.x, pos.y, transform, gridSize);
      }
      requestRender();
      return;
    }

    if (activeTool) {
      const transform = getTransform();
      const gridSize = state.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
      activeTool.onMouseDown(cell.row, cell.col, edge, e, pos);
      requestRender();
    }
  }
}

function onMouseMove(e) {
  const _moveStart = performance.now();
  const pos = getMousePos(e);

  // Background cell measure mode — update drag end and skip normal routing
  if (_bgMeasureActive && _bgMeasureStart) {
    _bgMeasureEnd = pos;
    requestRender();
    return;
  }

  if (isPanning) {
    state.panX = panStartPanX + (pos.x - panStartX);
    state.panY = panStartPanY + (pos.y - panStartY);
    clampPan();
    markDirty();
    requestRender();
    return;
  }

  // Right-click drag → pan
  if (rightDown) {
    const dx = pos.x - rightStartX;
    const dy = pos.y - rightStartY;
    if (!rightDragged && Math.sqrt(dx * dx + dy * dy) >= PAN_THRESHOLD) {
      rightDragged = true;
      canvas.style.cursor = 'grabbing';
    }
    if (rightDragged) {
      state.panX = rightStartPanX + dx;
      state.panY = rightStartPanY + dy;
      clampPan();
      markDirty();
      requestRender();
      return;
    }
  }

  const transform = getTransform();
  const gridSize = state.dungeon.metadata.gridSize;
  const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
  state.hoveredCell = cell;

  // Session tool mouse move (e.g., range detector drag)
  if (state.sessionToolsActive && sessionTool?.onMouseMove) {
    const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
    sessionTool.onMouseMove(cell.row, cell.col, edge, e, pos);
    requestRender();
    notify();
    return;
  }

  if (state.activeTool === 'wall' || state.activeTool === 'door') {
    // During a wall drag, the tool sets hoveredEdge itself (axis-locked preview)
    if (!activeTool?.dragging) {
      state.hoveredEdge = nearestEdge(pos.x, pos.y, transform, gridSize);
    }
  } else {
    state.hoveredEdge = null;
  }

  if (state.activeTool === 'stairs' || state.activeTool === 'bridge') {
    state.hoveredCorner = nearestCorner(pos.x, pos.y, transform, gridSize);
  } else {
    state.hoveredCorner = null;
  }

  if (activeTool?.onMouseMove) {
    const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
    activeTool.onMouseMove(cell.row, cell.col, edge, e, pos);
  }

  // Only re-render if hovered cell changed (for hover highlight, edge highlight, etc.)
  // Tools that need per-pixel cursor tracking (e.g. placement preview) call
  // requestRender() from their own onMouseMove handler.
  const prevHover = _lastHoveredCell;
  const curHover = state.hoveredCell;
  if (!prevHover || !curHover || prevHover.row !== curHover.row || prevHover.col !== curHover.col) {
    requestRender();
  }
  _lastHoveredCell = curHover ? { row: curHover.row, col: curHover.col } : null;
  notify(); // update status bar
  renderTimings.mouseMove = { ms: performance.now() - _moveStart, frame: getTimingFrame() };
}

function restoreToolCursor() {
  if (canvas) canvas.style.cursor = activeTool?.getCursor() || '';
}

function onMouseUp(e) {
  // Background cell measure mode — compute cell size and apply callback
  if (_bgMeasureActive && e.button === 0 && _bgMeasureStart && _bgMeasureEnd) {
    const dx = Math.abs(_bgMeasureEnd.x - _bgMeasureStart.x);
    const dy = Math.abs(_bgMeasureEnd.y - _bgMeasureStart.y);
    const d = Math.max(dx, dy);
    if (d > 4) {
      const { gridSize } = state.dungeon.metadata;
      const bi = state.dungeon.metadata.backgroundImage;
      const transform = getTransform();
      const cellPx = gridSize * transform.scale;
      const newPixelsPerCell = Math.round(d * (bi?.pixelsPerCell ?? 70) / cellPx);
      if (_bgMeasureCallback) _bgMeasureCallback(Math.max(1, newPixelsPerCell));
    }
    _cancelBgMeasure();
    restoreToolCursor();
    requestRender();
    return;
  }

  if (isPanning) {
    isPanning = false;
    restoreToolCursor();
    return;
  }

  // Right-click release: contextual action if click (not a drag)
  if (e.button === 2 && rightDown) {
    const wasDragged = rightDragged;
    rightDown = false;
    rightDragged = false;
    restoreToolCursor();
    if (!wasDragged) {
      // Quick click — delegate to session tool or active tool's contextual right-click
      const pos = getMousePos(e);
      const transform = getTransform();
      const gridSize = state.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
      if (state.sessionToolsActive && sessionTool?.onRightClick) {
        sessionTool.onRightClick(cell.row, cell.col, edge, e);
      } else if (activeTool?.onRightClick) {
        activeTool.onRightClick(cell.row, cell.col, edge, e);
      }
      requestRender();
    }
    return;
  }

  // Session tool mouse up (e.g., range detector drag end)
  if (state.sessionToolsActive && sessionTool?.onMouseUp) {
    const pos = getMousePos(e);
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
    sessionTool.onMouseUp(cell.row, cell.col, edge, e, pos);
    requestRender();
    return;
  }

  if (activeTool?.onMouseUp) {
    const pos = getMousePos(e);
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
    activeTool.onMouseUp(cell.row, cell.col, edge, e, pos);
    requestRender();
  }
}

function onMouseLeave() {
  if (_bgMeasureActive) {
    _cancelBgMeasure();
    restoreToolCursor();
  }
  state.hoveredCell = null;
  state.hoveredEdge = null;
  isPanning = false;
  rightDown = false;
  rightDragged = false;
  canvas.style.cursor = '';
  requestRender();
  notify();
}

function onWheel(e) {
  e.preventDefault();
  const pos = getMousePos(e);

  // Alt+wheel → dispatch to active tool (rotation/scale)
  if (e.altKey && activeTool?.onWheel) {
    const { gridSize, resolution } = state.dungeon.metadata;
    const transform = { scale: CELL_SIZE * state.zoom / _dgs(gridSize, resolution), offsetX: state.panX, offsetY: state.panY };
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    activeTool.onWheel(cell.row, cell.col, e.deltaY, e);
    return;
  }

  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoom * delta));

  // Zoom toward cursor
  const scale = newZoom / state.zoom;
  state.panX = pos.x - scale * (pos.x - state.panX);
  state.panY = pos.y - scale * (pos.y - state.panY);
  state.zoom = newZoom;

  markDirty();
  requestRender();
  notify();
}

/**
 * Clamp pan so the map can't be scrolled more than ~0.5 viewport widths off screen.
 */
function clampPan() {
  if (!canvas) return;
  const { gridSize, resolution } = state.dungeon.metadata;
  const scale = CELL_SIZE * state.zoom / _dgs(gridSize, resolution);
  const numRows = state.dungeon.cells.length;
  const numCols = state.dungeon.cells[0]?.length || 0;
  const mapPxW = numCols * gridSize * scale;
  const mapPxH = numRows * gridSize * scale;
  const vw = _canvasW || canvas.width;
  const vh = _canvasH || canvas.height;
  const leewayX = vw * 0.5;
  const leewayY = vh * 0.5;
  state.panX = Math.max(-(mapPxW + leewayX), Math.min(vw + leewayX, state.panX));
  state.panY = Math.max(-(mapPxH + leewayY), Math.min(vh + leewayY, state.panY));
}

/**
 * Zoom to fit the current level in view (H key shortcut).
 */
export function zoomToFit() {
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
 * Falls back to panning Y only if canvas isn't available yet.
 */
export function panToLevel(startRow, numRows) {
  const { gridSize, resolution } = state.dungeon.metadata;
  const dgs = _dgs(gridSize, resolution);
  const numCols = state.dungeon.cells[0]?.length || 0;
  const margin = 40; // px padding around the level

  // World-space bounds of the level (in feet)
  const worldW = numCols * gridSize;
  const worldH = numRows * gridSize;

  // Canvas logical pixel size
  const cw = _canvasW || (canvas ? canvas.width : 800);
  const ch = _canvasH || (canvas ? canvas.height : 600);

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

export function setCursor(cursor) {
  if (canvas) canvas.style.cursor = cursor;
}

export function getCanvasSize() {
  return { width: _canvasW || canvas?.width || 0, height: _canvasH || canvas?.height || 0 };
}

export { requestRender, resizeCanvas };
