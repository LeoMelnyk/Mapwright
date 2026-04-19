// Minimap: small overview of the full dungeon, shown in bottom-right corner of canvas.
// Toggleable via View → Minimap. Click to pan main viewport to that position.
import state, { getTheme, markDirty, notify } from './state.js';
import { renderCells } from '../../render/index.js';
import { getEditorSettings } from './editor-settings.js';
import { displayGridSize as _dgs } from '../../util/index.js';

const MINIMAP_MAX_W = 220;
const MINIMAP_MAX_H = 165;
const MINIMAP_PAD = 4;
const CELL_SIZE = 40; // must match canvas-view.js

let minimapCanvas: HTMLCanvasElement | null = null;
let minimapCtx: CanvasRenderingContext2D | null = null;
let mainCanvas: HTMLCanvasElement | null = null;
let minimapWrapper: HTMLElement | null = null;

// Offscreen cache for the minimap cell rendering (expensive).
// Only rebuilt when map data changes. Pan/zoom just redraws the viewport rect.
let _mmCache: {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  dirtySeq: number;
  canvasW: number;
  canvasH: number;
} | null = null;

export function initMinimap(editorCanvas: HTMLCanvasElement): void {
  mainCanvas = editorCanvas;
  minimapWrapper = document.getElementById('minimap-wrapper');
  minimapCanvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
  if (!minimapCanvas || !minimapWrapper) return;
  minimapCtx = minimapCanvas.getContext('2d');

  const header = document.getElementById('minimap-header')!;

  // ── Click/drag on minimap canvas → pan main view ──
  let panning = false;

  minimapCanvas.addEventListener('mousedown', (e: MouseEvent) => {
    panning = true;
    const rect = minimapCanvas!.getBoundingClientRect();
    _panToMinimapPoint(e.clientX - rect.left, e.clientY - rect.top);
  });

  minimapCanvas.addEventListener('mousemove', (e: MouseEvent) => {
    if (!panning) return;
    const rect = minimapCanvas!.getBoundingClientRect();
    _panToMinimapPoint(e.clientX - rect.left, e.clientY - rect.top);
  });

  minimapCanvas.addEventListener('mouseup', () => {
    panning = false;
  });
  minimapCanvas.addEventListener('mouseleave', () => {
    panning = false;
  });

  // ── Drag header → reposition minimap ──
  let dragState: {
    startX: number;
    startY: number;
    initLeft: number;
    initTop: number;
    containerW: number;
    containerH: number;
  } | null = null;

  header.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const wrapperRect = minimapWrapper!.getBoundingClientRect();
    const containerRect = minimapWrapper!.parentElement!.getBoundingClientRect();
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      // current offset from container edges
      initLeft: wrapperRect.left - containerRect.left,
      initTop: wrapperRect.top - containerRect.top,
      containerW: containerRect.width,
      containerH: containerRect.height,
    };
    minimapWrapper!.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;

    let newLeft = dragState.initLeft + dx;
    let newTop = dragState.initTop + dy;

    // Clamp within container
    const wW = minimapWrapper!.offsetWidth;
    const wH = minimapWrapper!.offsetHeight;
    newLeft = Math.max(0, Math.min(newLeft, dragState.containerW - wW));
    newTop = Math.max(0, Math.min(newTop, dragState.containerH - wH));

    // Switch from bottom/right to top/left positioning
    minimapWrapper!.style.left = newLeft + 'px';
    minimapWrapper!.style.top = newTop + 'px';
    minimapWrapper!.style.right = 'auto';
    minimapWrapper!.style.bottom = 'auto';
  });

  window.addEventListener('mouseup', () => {
    if (dragState) {
      dragState = null;
      minimapWrapper!.classList.remove('dragging');
    }
  });
}

/**
 * Re-render the minimap. Called after each main render when minimap is visible.
 */
export function updateMinimap(): void {
  if (!minimapCanvas || !minimapCtx || !mainCanvas || !minimapWrapper) return;

  const visible = getEditorSettings().minimap === true;
  minimapWrapper.style.display = visible ? 'block' : 'none';
  if (!visible) return;

  const { dungeon } = state;
  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize || 5;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  if (numRows === 0 || numCols === 0) return;

  const theme = getTheme();

  // Compute minimap scale to fit entire dungeon within max dimensions
  const worldW = numCols * gridSize;
  const worldH = numRows * gridSize;
  const innerW = MINIMAP_MAX_W - MINIMAP_PAD * 2;
  const innerH = MINIMAP_MAX_H - MINIMAP_PAD * 2;
  const minimapScale = Math.min(innerW / worldW, innerH / worldH);

  const drawW = worldW * minimapScale;
  const drawH = worldH * minimapScale;
  const canvasW = drawW + MINIMAP_PAD * 2;
  const canvasH = drawH + MINIMAP_PAD * 2;

  // Resize canvas only if dimensions changed (avoids flicker)
  if (minimapCanvas.width !== Math.ceil(canvasW) || minimapCanvas.height !== Math.ceil(canvasH)) {
    minimapCanvas.width = Math.ceil(canvasW);
    minimapCanvas.height = Math.ceil(canvasH);
  }

  const ctx = minimapCtx;

  // ── Cached cell rendering ──
  // Only rebuild when map data changes (undoStack/redoStack length as proxy).
  const dirtySig = (state.undoStack.length || 0) * 10000 + (state.redoStack.length || 0);
  const cacheW = Math.ceil(canvasW);
  const cacheH = Math.ceil(canvasH);
  if (_mmCache?.dirtySeq !== dirtySig || _mmCache.canvasW !== cacheW || _mmCache.canvasH !== cacheH) {
    if (_mmCache?.canvasW !== cacheW || _mmCache.canvasH !== cacheH) {
      const offscreen = document.createElement('canvas');
      offscreen.width = cacheW;
      offscreen.height = cacheH;
      _mmCache = { canvas: offscreen, ctx: offscreen.getContext('2d')!, dirtySeq: 0, canvasW: cacheW, canvasH: cacheH };
    }
    const offCtx = _mmCache.ctx;
    offCtx.clearRect(0, 0, cacheW, cacheH);
    offCtx.fillStyle = theme.background;
    offCtx.fillRect(0, 0, cacheW, cacheH);
    const minimapTransform = {
      offsetX: MINIMAP_PAD,
      offsetY: MINIMAP_PAD,
      scale: minimapScale,
    };
    renderCells(offCtx as CanvasRenderingContext2D, cells, gridSize, theme, minimapTransform, {
      showGrid: false,
      propCatalog: null,
      textureOptions: null,
      metadata,
      skipLabels: true,
      showInvisible: false,
      skipPhases: { shading: true },
    });
    _mmCache.dirtySeq = dirtySig;
  }

  // Blit cached cells
  ctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  ctx.drawImage(_mmCache.canvas, 0, 0);

  // Draw viewport rectangle
  const mainScale = (CELL_SIZE * state.zoom) / _dgs(gridSize, metadata.resolution);
  const vpLeft = (-state.panX / mainScale) * minimapScale + MINIMAP_PAD;
  const vpTop = (-state.panY / mainScale) * minimapScale + MINIMAP_PAD;
  const vpW = (mainCanvas.width / mainScale) * minimapScale;
  const vpH = (mainCanvas.height / mainScale) * minimapScale;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 2]);
  ctx.strokeRect(vpLeft, vpTop, vpW, vpH);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(vpLeft, vpTop, vpW, vpH);
  ctx.setLineDash([]);
  ctx.restore();
}

/** Force minimap to rebuild its cached cells on next render. */
export function invalidateMinimapCache(): void {
  _mmCache = null;
}

function _panToMinimapPoint(mx: number, my: number) {
  const { dungeon } = state;
  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize || 5;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  const worldW = numCols * gridSize;
  const worldH = numRows * gridSize;
  const innerW = MINIMAP_MAX_W - MINIMAP_PAD * 2;
  const innerH = MINIMAP_MAX_H - MINIMAP_PAD * 2;
  const minimapScale = Math.min(innerW / worldW, innerH / worldH);

  // World coords of the click
  const wx = (mx - MINIMAP_PAD) / minimapScale;
  const wy = (my - MINIMAP_PAD) / minimapScale;

  // Center the main view on this world point
  const mainScale = (CELL_SIZE * state.zoom) / _dgs(gridSize, metadata.resolution);
  state.panX = mainCanvas!.width / 2 - wx * mainScale;
  state.panY = mainCanvas!.height / 2 - wy * mainScale;

  markDirty();
  notify();
}
