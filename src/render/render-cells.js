import { _t } from './render-state.js';
import { getCachedRoomCells, withTrimVoidClip } from './render-cache.js';
import { renderFloors, renderTextureBlending, renderFillPatternsAndGrid, renderHazardOverlay, renderWallsAndBorders, renderLabelsStairsProps } from './render-phases.js';
import { drawMatrixGrid } from './decorations.js';
import { renderAllBridges } from './bridges.js';
import { drawHatching, drawRockShading, drawOuterShading } from './effects.js';

/**
 * Render matrix-based dungeon map — orchestrates all rendering phases.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D grid of cell objects
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme object for colors and styles
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {Object} [options] - Rendering options (showGrid, labelStyle, propCatalog, etc.)
 * @returns {void}
 */
export function renderCells(ctx, cells, gridSize, theme, transform, options = {}) {
  const {
    showGrid = false,
    labelStyle = 'circled',
    propCatalog = null,
    textureOptions = null,
    metadata = null,
    skipLabels = false,
    showInvisible = false,
    bgImageEl = null,
    bgImgConfig = null,
    visibleBounds = null,
    cacheSize = null,  // { w, h } — when set, enables per-phase render layer caching
    skipPhases = null,  // { shading, floors, blending, fills, walls, props, ... } — debug skip flags
  } = options;
  const roomCells = _t('roomCells', () => getCachedRoomCells(cells));

  // ── Base phases: shading + floors (rendered directly, no layer canvas) ──
  const _res = metadata?.resolution || 1;
  let hasTexturedCells = false;

  if (!skipPhases?.shading) {
    _t('shading', () => {
      if (!skipPhases?.outerShading) {
        drawOuterShading(ctx, cells, roomCells, gridSize, theme, transform, _res);
      }
      if (!skipPhases?.hatching) {
        drawHatching(ctx, cells, roomCells, gridSize, theme, transform);
        drawRockShading(ctx, cells, roomCells, gridSize, theme, transform);
      }
    });
  }
  if (!skipPhases?.floors) {
    _t('floors', () => {
      hasTexturedCells = renderFloors(ctx, cells, roomCells, gridSize, theme, transform, textureOptions, bgImageEl, bgImgConfig, visibleBounds, _res);
    });
  }

  // Texture edge + corner blending
  if (!skipPhases?.blending) {
    _t('blending', () => {
      if (hasTexturedCells) {
        renderTextureBlending(ctx, cells, roomCells, gridSize, transform, textureOptions, cacheSize);
      }
    });
  }

  // Fill patterns (pit/water/lava)
  if (!skipPhases?.fills) {
    _t('fills', () => renderFillPatternsAndGrid(ctx, cells, roomCells, gridSize, theme, transform, showGrid, true, metadata, cacheSize));
  }

  // ── Bridges, grid, hatching, walls ──────────
  if (!skipPhases?.bridges) {
    _t('bridges', () => {
      const getTextureImageForBridges = textureOptions?.catalog
        ? (id) => { const e = textureOptions.catalog.textures[id]; return e?.img && (e.img.complete !== false) ? e.img : null; }
        : null;
      renderAllBridges(ctx, metadata?.bridges, gridSize, theme, transform, getTextureImageForBridges);
    });
  }

  if (!skipPhases?.grid) {
    _t('grid', () => {
      if (showGrid) {
        withTrimVoidClip(ctx, cells, gridSize, transform, () => {
          drawMatrixGrid(ctx, cells, roomCells, gridSize, transform, theme, showGrid, metadata);
        });
      }
    });
  }

  if (!skipPhases?.walls) {
    _t('walls', () => renderWallsAndBorders(ctx, cells, roomCells, gridSize, theme, transform, showInvisible, visibleBounds, _res));
  }

  // Props, labels, stairs
  if (!skipPhases?.props) {
    _t('props', () => renderLabelsStairsProps(ctx, cells, gridSize, theme, transform, labelStyle, propCatalog, textureOptions, metadata, skipLabels, visibleBounds, cacheSize));
  }

  // Hazard overlay — topmost layer, renders above everything
  if (!skipPhases?.hazard) {
    _t('hazard', () => renderHazardOverlay(ctx, cells, gridSize, transform));
  }
}
