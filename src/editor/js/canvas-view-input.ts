// Mouse/wheel event handlers for canvas-view.
import state, { markDirty, notify } from './state.js';
import { pixelToCell, nearestEdge, nearestCorner } from './utils.js';
import { displayGridSize as _dgs } from '../../util/index.js';
import { renderTimings, getTimingFrame } from '../../render/index.js';
import { getEditorSettings, setEditorSetting } from './editor-settings.js';
import { cvState, CELL_SIZE, MIN_ZOOM, MAX_ZOOM, PAN_THRESHOLD } from './canvas-view-state.js';
import { requestRender, getTransform } from './canvas-view-render.js';
import { clampPan } from './canvas-view-viewport.js';

// ─── Mouse event handlers ───────────────────────────────────────────────────

/**
 * Get the mouse position relative to the canvas element.
 * @param {MouseEvent} e - The mouse event.
 * @returns {{ x: number, y: number }} Canvas-relative pixel coordinates.
 */
export function getMousePos(e: MouseEvent): { x: number; y: number } {
  const rect = cvState.canvas!.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/**
 * Handle mousedown on the canvas — routes to pan, tool, or session handlers.
 * @param {MouseEvent} e - The mouse event.
 * @returns {void}
 */
export function onMouseDown(e: MouseEvent): void {
  const pos = getMousePos(e);

  // Diagnostics overlay click — toggle expand/collapse
  const es = getEditorSettings();
  if (es.fpsCounter && e.button === 0 && pos.x < 300 && pos.y < 30) {
    setEditorSetting('diagExpanded', !es.diagExpanded);
    requestRender();
    return;
  }

  // Background cell measure mode — intercept left click before normal tool routing
  if (cvState._bgMeasureActive && e.button === 0) {
    cvState._bgMeasureStart = pos;
    cvState._bgMeasureEnd = pos;
    e.preventDefault();
    requestRender();
    return;
  }

  // Alt+click: pan (unless the active tool handles Alt itself, e.g. paint/prop syringe)
  if (e.button === 0 && e.altKey && state.activeTool !== 'paint' && state.activeTool !== 'prop') {
    cvState.isPanning = true;
    cvState.panStartX = pos.x;
    cvState.panStartY = pos.y;
    cvState.panStartPanX = state.panX;
    cvState.panStartPanY = state.panY;
    cvState.canvas!.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  // Right-click: start tracking — will become pan (drag) or erase (click)
  if (e.button === 2) {
    // If tool has an active drag, cancel it immediately
    if (cvState.activeTool?.onCancel()) {
      requestRender();
      return;
    }
    cvState.rightDown = true;
    cvState.rightDragged = false;
    cvState.rightStartX = pos.x;
    cvState.rightStartY = pos.y;
    cvState.rightStartPanX = state.panX;
    cvState.rightStartPanY = state.panY;
    e.preventDefault();
    return;
  }

  if (e.button === 0) {
    // Session tools mode
    if (state.sessionToolsActive) {
      const transform = getTransform();
      const gridSize = state.dungeon.metadata.gridSize;

      // If a session tool (e.g., range detector) is active, route full mouse events to it
      if (cvState.sessionTool) {
        const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
        const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
        cvState.sessionTool.onMouseDown(cell.row, cell.col, edge, e, pos);
        requestRender();
        return;
      }

      // Fall through to click-based session handlers (doors, stairs)
      if (cvState.sessionClickFn) {
        cvState.sessionClickFn(pos.x, pos.y, transform, gridSize);
      }
      requestRender();
      return;
    }

    if (cvState.activeTool) {
      const transform = getTransform();
      const gridSize = state.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
      cvState.activeTool.onMouseDown(cell.row, cell.col, edge, e, pos);
      requestRender();
    }
  }
}

/**
 * Handle mousemove on the canvas — updates pan, hover state, and tool preview.
 * @param {MouseEvent} e - The mouse event.
 * @returns {void}
 */
export function onMouseMove(e: MouseEvent): void {
  const _moveStart = performance.now();
  const pos = getMousePos(e);

  // Background cell measure mode — update drag end and skip normal routing
  if (cvState._bgMeasureActive && cvState._bgMeasureStart) {
    cvState._bgMeasureEnd = pos;
    requestRender();
    return;
  }

  if (cvState.isPanning) {
    state.panX = cvState.panStartPanX + (pos.x - cvState.panStartX);
    state.panY = cvState.panStartPanY + (pos.y - cvState.panStartY);
    clampPan();
    markDirty();
    requestRender();
    return;
  }

  // Right-click drag → pan
  if (cvState.rightDown) {
    const dx = pos.x - cvState.rightStartX;
    const dy = pos.y - cvState.rightStartY;
    if (!cvState.rightDragged && Math.sqrt(dx * dx + dy * dy) >= PAN_THRESHOLD) {
      cvState.rightDragged = true;
      cvState.canvas!.style.cursor = 'grabbing';
    }
    if (cvState.rightDragged) {
      state.panX = cvState.rightStartPanX + dx;
      state.panY = cvState.rightStartPanY + dy;
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
  if (state.sessionToolsActive && cvState.sessionTool?.onMouseMove) {
    const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
    cvState.sessionTool.onMouseMove(cell.row, cell.col, edge, e, pos);
    requestRender();
    notify();
    return;
  }

  if (state.activeTool === 'wall' || state.activeTool === 'door') {
    // During a wall drag, the tool sets hoveredEdge itself (axis-locked preview)
    if (!cvState.activeTool?.dragging) {
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

  if (cvState.activeTool?.onMouseMove) {
    const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
    cvState.activeTool.onMouseMove(cell.row, cell.col, edge, e, pos);
  }

  // Only re-render if hovered cell changed (for hover highlight, edge highlight, etc.)
  // Tools that need per-pixel cursor tracking (e.g. placement preview) call
  // requestRender() from their own onMouseMove handler.
  const prevHover = cvState._lastHoveredCell;
  const curHover = state.hoveredCell;
  if (prevHover?.row !== curHover.row || prevHover.col !== curHover.col) {
    requestRender();
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  cvState._lastHoveredCell = curHover ? { row: curHover.row, col: curHover.col } : null;
  notify(); // update status bar
  renderTimings.mouseMove = { ms: performance.now() - _moveStart, frame: getTimingFrame() };
}

/**
 * Restore the canvas cursor to match the active tool's default cursor.
 * @returns {void}
 */
export function restoreToolCursor(): void {
  if (cvState.canvas) cvState.canvas.style.cursor = cvState.activeTool?.getCursor() ?? '';
}

/**
 * Handle mouseup on the canvas — finalizes pan, tool actions, and right-click context.
 * @param {MouseEvent} e - The mouse event.
 * @returns {void}
 */
export function onMouseUp(e: MouseEvent): void {
  // Background cell measure mode — compute cell size and apply callback
  if (cvState._bgMeasureActive && e.button === 0 && cvState._bgMeasureStart && cvState._bgMeasureEnd) {
    const dx = Math.abs(cvState._bgMeasureEnd.x - cvState._bgMeasureStart.x);
    const dy = Math.abs(cvState._bgMeasureEnd.y - cvState._bgMeasureStart.y);
    const d = Math.max(dx, dy);
    if (d > 4) {
      const { gridSize } = state.dungeon.metadata;
      const bi = state.dungeon.metadata.backgroundImage;
      const transform = getTransform();
      const cellPx = gridSize * transform.scale;
      const newPixelsPerCell = Math.round((d * (bi?.pixelsPerCell ?? 70)) / cellPx);
      if (cvState._bgMeasureCallback) cvState._bgMeasureCallback(Math.max(1, newPixelsPerCell));
    }
    _cancelBgMeasure();
    restoreToolCursor();
    requestRender();
    return;
  }

  if (cvState.isPanning) {
    cvState.isPanning = false;
    restoreToolCursor();
    return;
  }

  // Right-click release: contextual action if click (not a drag)
  if (e.button === 2 && cvState.rightDown) {
    const wasDragged = cvState.rightDragged;
    cvState.rightDown = false;
    cvState.rightDragged = false;
    restoreToolCursor();
    if (!wasDragged) {
      // Quick click — delegate to session tool or active tool's contextual right-click
      const pos = getMousePos(e);
      const transform = getTransform();
      const gridSize = state.dungeon.metadata.gridSize;
      const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
      const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
      if (state.sessionToolsActive && cvState.sessionTool?.onRightClick) {
        cvState.sessionTool.onRightClick(cell.row, cell.col, edge, e, pos);
      } else if (cvState.activeTool?.onRightClick) {
        cvState.activeTool.onRightClick(cell.row, cell.col, edge, e, pos);
      }
      requestRender();
    }
    return;
  }

  // Session tool mouse up (e.g., range detector drag end)
  if (state.sessionToolsActive && cvState.sessionTool?.onMouseUp) {
    const pos = getMousePos(e);
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
    cvState.sessionTool.onMouseUp(cell.row, cell.col, edge, e, pos);
    requestRender();
    return;
  }

  if (cvState.activeTool?.onMouseUp) {
    const pos = getMousePos(e);
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    const edge = nearestEdge(pos.x, pos.y, transform, gridSize);
    cvState.activeTool.onMouseUp(cell.row, cell.col, edge, e, pos);
    requestRender();
  }
}

/**
 * Handle mouseleave on the canvas — clears hover state and cancels active drags.
 * @returns {void}
 */
export function onMouseLeave(): void {
  if (cvState._bgMeasureActive) {
    _cancelBgMeasure();
    restoreToolCursor();
  }
  state.hoveredCell = null;
  state.hoveredEdge = null;
  cvState.isPanning = false;
  cvState.rightDown = false;
  cvState.rightDragged = false;
  cvState.canvas!.style.cursor = '';
  requestRender();
  notify();
}

/**
 * Handle mouse wheel on the canvas — zooms toward cursor or delegates to tool.
 * @param {WheelEvent} e - The wheel event.
 * @returns {void}
 */
export function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const pos = getMousePos(e);

  // Alt+wheel → dispatch to active tool (rotation/scale)
  if (e.altKey && cvState.activeTool?.onWheel) {
    const { gridSize, resolution } = state.dungeon.metadata;
    const transform = {
      scale: (CELL_SIZE * state.zoom) / _dgs(gridSize, resolution),
      offsetX: state.panX,
      offsetY: state.panY,
    };
    const cell = pixelToCell(pos.x, pos.y, transform, gridSize);
    cvState.activeTool.onWheel(cell.row, cell.col, e.deltaY, e);
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

// Internal helper — cancels background cell measure mode
function _cancelBgMeasure() {
  cvState._bgMeasureActive = false;
  cvState._bgMeasureCallback = null;
  cvState._bgMeasureStart = null;
  cvState._bgMeasureEnd = null;
}
