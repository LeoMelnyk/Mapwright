// Minimap: small overview of the full dungeon, shown in bottom-right corner of canvas.
// Toggleable via View → Minimap. Click to pan main viewport to that position.
import state, { getTheme, markDirty, notify } from './state.js';
import { renderCells } from '../../render/index.js';
import { getEditorSettings } from './editor-settings.js';

const MINIMAP_MAX_W = 220;
const MINIMAP_MAX_H = 165;
const MINIMAP_PAD = 4;
const CELL_SIZE = 40; // must match canvas-view.js

let minimapCanvas = null;
let minimapCtx = null;
let mainCanvas = null;

export function initMinimap(editorCanvas) {
  mainCanvas = editorCanvas;
  minimapCanvas = document.getElementById('minimap-canvas');
  if (!minimapCanvas) return;
  minimapCtx = minimapCanvas.getContext('2d');

  // Click or drag on minimap → pan main view to that world position
  let dragging = false;

  minimapCanvas.addEventListener('mousedown', (e) => {
    dragging = true;
    const rect = minimapCanvas.getBoundingClientRect();
    _panToMinimapPoint(e.clientX - rect.left, e.clientY - rect.top);
  });

  minimapCanvas.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = minimapCanvas.getBoundingClientRect();
    _panToMinimapPoint(e.clientX - rect.left, e.clientY - rect.top);
  });

  minimapCanvas.addEventListener('mouseup', () => { dragging = false; });
  minimapCanvas.addEventListener('mouseleave', () => { dragging = false; });
}

/**
 * Re-render the minimap. Called after each main render when minimap is visible.
 */
export function updateMinimap() {
  if (!minimapCanvas || !minimapCtx || !mainCanvas) return;

  const visible = getEditorSettings().minimap === true;
  minimapCanvas.style.display = visible ? 'block' : 'none';
  if (!visible) return;

  const { dungeon } = state;
  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize || 5;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  if (numRows === 0 || numCols === 0) return;

  const theme = getTheme();
  if (!theme) return;

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

  // Background
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, minimapCanvas.width, minimapCanvas.height);

  // Render cells (no textures, no labels, no grid for performance)
  const minimapTransform = {
    offsetX: MINIMAP_PAD,
    offsetY: MINIMAP_PAD,
    scale: minimapScale,
  };
  renderCells(ctx, cells, gridSize, theme, minimapTransform, {
    showGrid: false,
    propCatalog: null,
    textureOptions: null,
    metadata,
    skipLabels: true,
    showInvisible: false,
  });

  // Draw viewport rectangle
  const mainScale = CELL_SIZE * state.zoom / gridSize;
  const vpLeft = (-state.panX / mainScale) * minimapScale + MINIMAP_PAD;
  const vpTop  = (-state.panY / mainScale) * minimapScale + MINIMAP_PAD;
  const vpW    = (mainCanvas.width  / mainScale) * minimapScale;
  const vpH    = (mainCanvas.height / mainScale) * minimapScale;

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

function _panToMinimapPoint(mx, my) {
  const { dungeon } = state;
  const { cells, metadata } = dungeon;
  const gridSize = metadata.gridSize || 5;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const worldW = numCols * gridSize;
  const worldH = numRows * gridSize;
  const innerW = MINIMAP_MAX_W - MINIMAP_PAD * 2;
  const innerH = MINIMAP_MAX_H - MINIMAP_PAD * 2;
  const minimapScale = Math.min(innerW / worldW, innerH / worldH);

  // World coords of the click
  const wx = (mx - MINIMAP_PAD) / minimapScale;
  const wy = (my - MINIMAP_PAD) / minimapScale;

  // Center the main view on this world point
  const mainScale = CELL_SIZE * state.zoom / gridSize;
  state.panX = mainCanvas.width  / 2 - wx * mainScale;
  state.panY = mainCanvas.height / 2 - wy * mainScale;

  markDirty();
  notify();
}
