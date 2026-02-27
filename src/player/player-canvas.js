// Player view canvas: render loop, pan/zoom, fog overlay, tool interaction.

import { renderCells, renderLabels, invalidateGeometryCache, invalidateFluidCache } from '../render/index.js';
import { renderLightmap } from '../render/index.js';
import { toCanvas } from '../render/index.js';
import { buildPlayerCells, filterStairsForPlayer } from './fog.js';
import playerState from './player-state.js';

const CELL_SIZE = 40; // pixels per cell at zoom=1
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5.0;
const LERP_SPEED = 6; // higher = faster interpolation (units/sec style, used as factor per frame)

let canvas, ctx;
let animFrameId = null;
let lastFrameTime = 0;

// Pan tracking
let isPanning = false;
let panStartX = 0, panStartY = 0;
let panStartPanX = 0, panStartPanY = 0;

// Touch tracking
let touchMode = null; // null | 'pan' | 'tool' | 'pinch'
let lastPinchDist = 0;
let pinchMidX = 0, pinchMidY = 0;

// Active tool (e.g., range detector)
let activeTool = null;
let toolDragging = false; // true when the tool has an active drag

// Memoized player cells — rebuilt only when fog/doors/source cells change
let _cachedPlayerCells = null;
let _lastSourceCells = null;
let _lastRevealedSize = -1;
let _lastOpenedDoorsLen = -1;

export function setActiveTool(tool) {
  if (activeTool?.onDeactivate) activeTool.onDeactivate();
  activeTool = tool;
  if (activeTool?.onActivate) activeTool.onActivate();
}

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Mouse events for player pan/zoom + tool interaction
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // Touch events for mobile/tablet support
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('touchcancel', onTouchEnd);

  requestRender();
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  requestRender();
}

export function requestRender() {
  if (animFrameId) return;
  animFrameId = requestAnimationFrame(render);
}

export function getTransform() {
  if (!playerState.dungeon) return { offsetX: 0, offsetY: 0, scale: 1 };
  const gridSize = playerState.dungeon.metadata.gridSize;
  const scale = CELL_SIZE * playerState.zoom / gridSize;
  return { offsetX: playerState.panX, offsetY: playerState.panY, scale };
}

function pixelToCell(px, py, transform, gridSize) {
  const x = (px - transform.offsetX) / transform.scale;
  const y = (py - transform.offsetY) / transform.scale;
  return { row: Math.floor(y / gridSize), col: Math.floor(x / gridSize) };
}

function resolveTheme() {
  // Use the resolved theme sent by the DM (avoids empty THEMES lookup)
  if (playerState.resolvedTheme) return playerState.resolvedTheme;
  // Fallback: if dungeon metadata has an inline theme object
  const t = playerState.dungeon?.metadata?.theme;
  if (typeof t === 'object' && t !== null) return t;
  return null;
}

function render(timestamp) {
  animFrameId = null;
  if (!canvas || !playerState.dungeon) return;
  const theme = resolveTheme();
  if (!theme) return; // Theme not yet received from DM

  // Tick viewport interpolation
  const dt = lastFrameTime ? Math.min((timestamp - lastFrameTime) / 1000, 0.1) : 0.016;
  lastFrameTime = timestamp;
  const viewportAnimating = tickViewportLerp(dt);

  const { dungeon } = playerState;
  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize;
  const transform = getTransform();

  // Clear to black (fog background)
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Build filtered cells for player view (memoized — only rebuilds when fog/doors/source cells change)
  const sourceCells = cells;
  const revSize = playerState.revealedCells.size;
  const doorsLen = playerState.openedDoors.length;

  if (sourceCells !== _lastSourceCells || revSize !== _lastRevealedSize || doorsLen !== _lastOpenedDoorsLen) {
    _cachedPlayerCells = buildPlayerCells(dungeon, playerState.revealedCells, playerState.openedDoors);
    if (sourceCells !== _lastSourceCells) {
      invalidateFluidCache(); // fills may have changed
    }
    invalidateGeometryCache(); // room topology, hatching, shading always need rebuild
    _lastSourceCells = sourceCells;
    _lastRevealedSize = revSize;
    _lastOpenedDoorsLen = doorsLen;
  }
  const playerCells = _cachedPlayerCells;

  // Filter stairs: hide unrevealed stairs entirely, hide labels for unopened stairs
  const filteredStairs = filterStairsForPlayer(
    metadata.stairs, playerState.revealedCells, playerState.openedStairs
  );
  const playerMetadata = { ...metadata, stairs: filteredStairs };

  // Render using existing pipeline
  const showGrid = metadata.features?.showGrid !== false;
  const labelStyle = metadata.labelStyle || 'circled';
  const textureOptions = playerState.textureCatalog
    ? { catalog: playerState.textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35, texturesVersion: playerState.texturesVersion ?? 0 }
    : null;

  const lightingEnabled = !!(playerMetadata.lightingEnabled && playerMetadata.lights?.length > 0);
  renderCells(ctx, playerCells, gridSize, theme, transform, showGrid, labelStyle,
    playerState.propCatalog, textureOptions, playerMetadata, lightingEnabled);

  // Lighting overlay
  if (lightingEnabled) {
    renderLightmap(ctx, playerMetadata.lights, playerCells, gridSize, transform,
      canvas.width, canvas.height, playerMetadata.ambientLight ?? 0.15,
      playerState.textureCatalog, playerState.propCatalog);
    // Draw labels after lightmap so they are unaffected by the multiply overlay
    renderLabels(ctx, playerCells, gridSize, theme, transform, labelStyle);
  }

  // Tool overlay (range detector highlights)
  if (activeTool?.renderOverlay) {
    activeTool.renderOverlay(ctx, transform, gridSize);
  }

  // Keep animating if viewport is interpolating
  if (viewportAnimating) requestRender();
}

// ── Viewport sync with smooth interpolation ─────────────────────────────────

// Target values the viewport is lerping toward
let targetPanX = 0, targetPanY = 0, targetZoom = 1;
let isLerping = false;

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Tick one frame of viewport interpolation. Returns true if still animating.
 */
function tickViewportLerp(dt) {
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

export function applyDMViewport(panX, panY, zoom, dmCanvasWidth, dmCanvasHeight) {
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
export function snapToDMViewport() {
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

export function resyncToDM() {
  targetPanX = playerState.dmPanX;
  targetPanY = playerState.dmPanY;
  targetZoom = playerState.dmZoom;
  isLerping = true;
  playerState.followDM = true;
  requestRender();
  updateResyncButton();
}

function updateResyncButton() {
  const btn = document.getElementById('resync-btn');
  if (btn) btn.classList.toggle('visible', !playerState.followDM);
}

// ── Mouse handlers (player pan/zoom + tool interaction) ──────────────────────

function onMouseDown(e) {
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

function onMouseMove(e) {
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

function onMouseUp(e) {
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

function onMouseLeave() {
  isPanning = false;
  toolDragging = false;
  canvas.style.cursor = '';
}

// ── Touch handlers (mobile/tablet pan, pinch-zoom, tool interaction) ─────────

function pinchDistance(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function onTouchStart(e) {
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

function onTouchMove(e) {
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

function onTouchEnd(e) {
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

function onWheel(e) {
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
