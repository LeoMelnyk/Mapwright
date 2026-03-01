// Canvas element management, pan/zoom, mouse event routing
import state, { getTheme, markDirty, notify, subscribe } from './state.js';
import { renderCells, renderLabels, drawBorderOnMap, drawScaleIndicatorOnMap, findCompassRosePositionOnMap, drawCompassRoseScaled, renderLightmap } from '../../render/index.js';
import { toCanvas, pixelToCell, nearestEdge, nearestCorner } from './utils.js';
import { initMinimap, updateMinimap } from './minimap.js';
import { getEditorSettings } from './editor-settings.js';

const CELL_SIZE = 40; // pixels per cell at zoom=1
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5.0;

let canvas, ctx;
let animFrameId = null;
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

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  initMinimap(canvas);

  // Re-render when state changes (theme, features, metadata, etc.)
  subscribe(() => { if (state.dirty) requestRender(); });

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
  canvas.width = rect.width;
  canvas.height = rect.height;
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
  const gridSize = state.dungeon.metadata.gridSize;
  const scale = CELL_SIZE * state.zoom / gridSize; // pixels per foot
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

  const drawStart = performance.now();

  const { dungeon } = state;
  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize;
  const theme = getTheme();
  if (!theme) return; // Theme catalog not loaded yet
  const transform = getTransform();
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw background (entire canvas)
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw editor corner dots over the full grid area (editor-only, void cells only appear after floor fills cover them)
  drawEditorDots(ctx, numRows, numCols, gridSize, theme, transform);

  // Render the dungeon cells (WYSIWYG)
  const showGrid = metadata.features?.showGrid !== false;
  const labelStyle = metadata.labelStyle || 'circled';
  const textureOptions = state.textureCatalog
    ? { catalog: state.textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35, texturesVersion: state.texturesVersion ?? 0 }
    : null;
  const lightingEnabled = !!metadata.lightingEnabled;
  const showInvisible = state.activeTool === 'wall' || state.activeTool === 'door';
  renderCells(ctx, cells, gridSize, theme, transform, {
    showGrid, labelStyle, propCatalog: state.propCatalog, textureOptions, metadata,
    skipLabels: lightingEnabled, showInvisible,
  });

  // Lighting overlay (after cells, before decorations so borders stay visible)
  if (lightingEnabled) {
    renderLightmap(ctx, metadata.lights, cells, gridSize, transform,
      canvas.width, canvas.height, metadata.ambientLight ?? 0.15,
      state.textureCatalog, state.propCatalog);
    // Draw labels after lightmap so they are unaffected by the multiply overlay
    renderLabels(ctx, cells, gridSize, theme, transform, labelStyle);
  }

  // Feature decorations (rendered in dungeon coordinate space — pan/zoom with the map)
  const features = metadata.features || {};
  if (features.border !== false) {
    drawBorderOnMap(ctx, cells, gridSize, theme, transform);
  }
  if (features.compassRose !== false) {
    const pos = findCompassRosePositionOnMap(cells, gridSize, transform);
    if (pos) drawCompassRoseScaled(ctx, pos.x, pos.y, theme, pos.scale);
  }
  if (features.scale !== false) {
    drawScaleIndicatorOnMap(ctx, cells, gridSize, theme, transform);
  }

  // Draw dungeon title (and per-level titles on multi-level maps)
  drawDungeonTitleOnMap(ctx, cells, gridSize, theme, transform, metadata);

  // Draw level separators
  if (metadata.levels && metadata.levels.length > 1) {
    drawLevelSeparators(ctx, metadata.levels, gridSize, transform, theme);
  }

  // Editor overlays
  drawHoverHighlight(ctx, gridSize, transform);
  drawSelectionHighlight(ctx, gridSize, transform);
  drawLinkSourceHighlight(ctx, gridSize, transform);
  drawEdgeHighlight(ctx, gridSize, transform);

  // Tool overlay
  if (activeTool?.renderOverlay) {
    activeTool.renderOverlay(ctx, transform, gridSize);
  }

  // DM fog overlay — semi-transparent tint over unrevealed cells (persists across panels)
  if (dmFogOverlayFn) dmFogOverlayFn(ctx, transform, gridSize);

  // Session tool overlay (range highlights — rendered below door buttons)
  // Uses persistent sessionRangeTool so player highlights render in any session sub-mode (doors, range, etc.)
  if (state.sessionToolsActive && sessionRangeTool?.renderOverlay) {
    sessionRangeTool.renderOverlay(ctx, transform, gridSize);
  }

  // Session overlay (door-open buttons — only when session tools active)
  if (state.sessionToolsActive && sessionOverlayFn) {
    sessionOverlayFn(ctx, transform, gridSize);
  }

  // Diagnostics overlay (topmost, fixed to canvas — not affected by pan/zoom)
  lastDrawMs = performance.now() - drawStart;
  const editorSettings = getEditorSettings();
  if (editorSettings.fpsCounter === true || editorSettings.memoryUsage === true) {
    const lines = [];
    if (editorSettings.fpsCounter === true) {
      lines.push({
        text: `Draw: ${lastDrawMs.toFixed(1)}ms`,
        color: lastDrawMs < 8 ? '#4f4' : lastDrawMs < 16 ? '#ff4' : '#f44',
      });
    }
    if (editorSettings.memoryUsage === true) {
      const mem = performance.memory;
      if (mem) {
        const usedMB = (mem.usedJSHeapSize / 1048576).toFixed(1);
        const limitMB = (mem.jsHeapSizeLimit / 1048576).toFixed(0);
        const ratio = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
        lines.push({
          text: `Mem: ${usedMB} / ${limitMB} MB`,
          color: ratio < 0.5 ? '#4f4' : ratio < 0.8 ? '#ff4' : '#f44',
        });
      } else {
        lines.push({ text: 'Mem: unavailable', color: '#888' });
      }
    }

    ctx.save();
    ctx.font = 'bold 12px monospace';
    const pad = 5;
    const lineH = 18;
    const boxW = Math.max(...lines.map(l => ctx.measureText(l.text).width)) + pad * 2;
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
}

function drawEditorDots(ctx, numRows, numCols, gridSize, theme, transform) {
  const DOT_RADIUS = 1.5;

  ctx.save();
  ctx.fillStyle = theme.gridLine || '#888';
  ctx.globalAlpha = 0.5;
  ctx.beginPath();

  for (let row = 0; row <= numRows; row++) {
    for (let col = 0; col <= numCols; col++) {
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
  const pos = getMousePos(e);

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

  requestRender();
  notify(); // update status bar
}

function restoreToolCursor() {
  if (canvas) canvas.style.cursor = activeTool?.getCursor() || '';
}

function onMouseUp(e) {
  if (isPanning) {
    isPanning = false;
    restoreToolCursor();
    return;
  }

  // Right-click release: contextual action if click (not a drag)
  if (e.button === 2 && rightDown) {
    rightDown = false;
    restoreToolCursor();
    if (!rightDragged) {
      // Quick click — delegate to active tool's contextual right-click
      const pos = getMousePos(e);
      const transform = getTransform();
      const gridSize = state.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
      if (activeTool?.onRightClick) {
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
  state.hoveredCell = null;
  state.hoveredEdge = null;
  isPanning = false;
  rightDown = false;
  canvas.style.cursor = '';
  requestRender();
  notify();
}

function onWheel(e) {
  e.preventDefault();
  const pos = getMousePos(e);
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
  const gridSize = state.dungeon.metadata.gridSize;
  const scale = CELL_SIZE * state.zoom / gridSize;
  const numRows = state.dungeon.cells.length;
  const numCols = state.dungeon.cells[0]?.length || 0;
  const mapPxW = numCols * gridSize * scale;
  const mapPxH = numRows * gridSize * scale;
  const vw = canvas.width;
  const vh = canvas.height;
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
  const gridSize = state.dungeon.metadata.gridSize;
  const numCols = state.dungeon.cells[0]?.length || 0;
  const margin = 40; // px padding around the level

  // World-space bounds of the level (in feet)
  const worldW = numCols * gridSize;
  const worldH = numRows * gridSize;

  // Canvas pixel size
  const cw = canvas ? canvas.width : 800;
  const ch = canvas ? canvas.height : 600;

  // Zoom to fit: pick the smaller axis ratio so the whole level fits
  const zoomX = (cw - margin * 2) / (worldW * (CELL_SIZE / gridSize));
  const zoomY = (ch - margin * 2) / (worldH * (CELL_SIZE / gridSize));
  state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zoomX, zoomY)));

  // Recompute scale with new zoom
  const scale = CELL_SIZE * state.zoom / gridSize;

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
  return { width: canvas?.width || 0, height: canvas?.height || 0 };
}

export { requestRender, resizeCanvas };
