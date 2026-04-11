// Mouse handlers (pan/zoom/tool dispatch), touch handlers (pan/pinch), wheel zoom.

import playerState from './player-state.js';
import { S, MIN_ZOOM, MAX_ZOOM, getTransform, pixelToCell } from './player-canvas-state.js';
import { updateResyncButton } from './player-canvas-viewport.js';

// Forward declaration — set by player-canvas.ts barrel to break circular dep
let _requestRender: () => void = () => {};
export function setRequestRender(fn: () => void): void {
  _requestRender = fn;
}

// ── Mouse handlers (player pan/zoom + tool interaction) ──────────────────────

function onMouseDown(e: MouseEvent): void {
  // Right-click or Alt+left-click: always pan
  if (e.button === 2 || (e.button === 0 && e.altKey)) {
    S.isPanning = true;
    S.panStartX = e.clientX;
    S.panStartY = e.clientY;
    S.panStartPanX = playerState.panX;
    S.panStartPanY = playerState.panY;
    S.canvas!.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  // Left-click: route to active tool if available, otherwise pan
  if (e.button === 0) {
    if (S.activeTool && playerState.dungeon) {
      const pos = { x: e.clientX, y: e.clientY };
      const transform = getTransform();
      const gridSize = playerState.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      S.activeTool.onMouseDown(cell.row, cell.col, null, e, pos);
      S.toolDragging = true;
      S.canvas!.style.cursor = 'crosshair';
      e.preventDefault();
      _requestRender();
      return;
    }

    // No tool — pan with left-click (legacy behavior)
    S.isPanning = true;
    S.panStartX = e.clientX;
    S.panStartY = e.clientY;
    S.panStartPanX = playerState.panX;
    S.panStartPanY = playerState.panY;
    S.canvas!.style.cursor = 'grabbing';
    e.preventDefault();
  }
}

function onMouseMove(e: MouseEvent): void {
  // Tool drag
  if (S.toolDragging && S.activeTool && playerState.dungeon) {
    const pos = { x: e.clientX, y: e.clientY };
    const transform = getTransform();
    const gridSize = playerState.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    S.activeTool.onMouseMove(cell.row, cell.col, null, e, pos);
    _requestRender();
    return;
  }

  if (!S.isPanning) return;
  playerState.panX = S.panStartPanX + (e.clientX - S.panStartX);
  playerState.panY = S.panStartPanY + (e.clientY - S.panStartY);
  playerState.followDM = false;
  updateResyncButton();
  _requestRender();
}

function onMouseUp(e: MouseEvent): void {
  // Tool drag end
  if (S.toolDragging && S.activeTool && playerState.dungeon) {
    const pos = { x: e.clientX, y: e.clientY };
    const transform = getTransform();
    const gridSize = playerState.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    S.activeTool.onMouseUp(cell.row, cell.col, null, e, pos);
    S.toolDragging = false;
    S.canvas!.style.cursor = '';
    _requestRender();
    return;
  }

  if (S.isPanning) {
    S.isPanning = false;
    S.canvas!.style.cursor = '';
  }
}

function onMouseLeave(): void {
  S.isPanning = false;
  S.toolDragging = false;
  S.canvas!.style.cursor = '';
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
    if (S.touchMode === 'tool' && S.activeTool?.onMouseUp) {
      S.activeTool.onMouseUp(0, 0, null, e, { x: 0, y: 0 });
      S.toolDragging = false;
    }
    S.touchMode = 'pinch';
    S.lastPinchDist = pinchDistance(touches[0], touches[1]);
    S.pinchMidX = (touches[0].clientX + touches[1].clientX) / 2;
    S.pinchMidY = (touches[0].clientY + touches[1].clientY) / 2;
    S.panStartX = S.pinchMidX;
    S.panStartY = S.pinchMidY;
    S.panStartPanX = playerState.panX;
    S.panStartPanY = playerState.panY;
    return;
  }

  if (touches.length === 1) {
    const t = touches[0];

    // If a tool is active, route single finger to tool
    if (S.activeTool && playerState.dungeon) {
      S.touchMode = 'tool';
      const pos = { x: t.clientX, y: t.clientY };
      const transform = getTransform();
      const gridSize = playerState.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      S.activeTool.onMouseDown(cell.row, cell.col, null, e, pos);
      S.toolDragging = true;
      _requestRender();
      return;
    }

    // No tool — single finger pan
    S.touchMode = 'pan';
    S.panStartX = t.clientX;
    S.panStartY = t.clientY;
    S.panStartPanX = playerState.panX;
    S.panStartPanY = playerState.panY;
  }
}

function onTouchMove(e: TouchEvent): void {
  e.preventDefault();
  const touches = e.touches;

  if (S.touchMode === 'pinch' && touches.length >= 2) {
    const newDist = pinchDistance(touches[0], touches[1]);
    const midX = (touches[0].clientX + touches[1].clientX) / 2;
    const midY = (touches[0].clientY + touches[1].clientY) / 2;

    // Zoom
    const scale = newDist / S.lastPinchDist;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, playerState.zoom * scale));
    const zoomScale = newZoom / playerState.zoom;
    playerState.panX = midX - zoomScale * (midX - playerState.panX);
    playerState.panY = midY - zoomScale * (midY - playerState.panY);
    playerState.zoom = newZoom;
    S.lastPinchDist = newDist;

    // Simultaneous pan
    const dx = midX - S.panStartX;
    const dy = midY - S.panStartY;
    playerState.panX += dx;
    playerState.panY += dy;
    S.panStartX = midX;
    S.panStartY = midY;

    playerState.followDM = false;
    updateResyncButton();
    _requestRender();
    return;
  }

  if (S.touchMode === 'tool' && touches.length === 1 && S.activeTool && playerState.dungeon) {
    const t = touches[0];
    const pos = { x: t.clientX, y: t.clientY };
    const transform = getTransform();
    const gridSize = playerState.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    S.activeTool.onMouseMove(cell.row, cell.col, null, e, pos);
    _requestRender();
    return;
  }

  if (S.touchMode === 'pan' && touches.length === 1) {
    const t = touches[0];
    playerState.panX = S.panStartPanX + (t.clientX - S.panStartX);
    playerState.panY = S.panStartPanY + (t.clientY - S.panStartY);
    playerState.followDM = false;
    updateResyncButton();
    _requestRender();
  }
}

function onTouchEnd(e: TouchEvent): void {
  // Tool drag end
  if (S.touchMode === 'tool' && S.activeTool && playerState.dungeon) {
    // Use last known position (changedTouches has the lifted finger)
    const t = e.changedTouches[0];
    const pos = { x: t.clientX, y: t.clientY };
    const transform = getTransform();
    const gridSize = playerState.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    S.activeTool.onMouseUp(cell.row, cell.col, null, e, pos);
    S.toolDragging = false;
    S.touchMode = null;
    _requestRender();
    return;
  }

  // If we were pinching and now have 1 finger left, switch to pan
  if (S.touchMode === 'pinch' && e.touches.length === 1) {
    S.touchMode = 'pan';
    const t = e.touches[0];
    S.panStartX = t.clientX;
    S.panStartY = t.clientY;
    S.panStartPanX = playerState.panX;
    S.panStartPanY = playerState.panY;
    return;
  }

  // All fingers lifted
  if (e.touches.length === 0) {
    S.touchMode = null;
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
  _requestRender();
}

export { onMouseDown, onMouseMove, onMouseUp, onMouseLeave, onTouchStart, onTouchMove, onTouchEnd, onWheel };
