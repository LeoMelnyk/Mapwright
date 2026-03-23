/**
 * Shared dungeon render pipeline.
 * Pure canvas 2D API — no Node or browser dependencies.
 * Used by both generate_dungeon.js (CLI) and the editor's Export PNG.
 */

import { GRID_SCALE, MARGIN } from './constants.js';
import { THEMES } from './themes.js';
import { calculateBoundsFromCells } from './bounds.js';
import { renderCells, renderLabels } from './render.js';
import { drawBackground, drawDungeonTitle, findCompassRosePosition, drawCompassRose, drawScaleIndicator, drawBorder } from './decorations.js';
import { renderLightmapHQ } from './lighting-hq.js';
import { extractFillLights } from './lighting.js';
import { buildPlayerCells, filterStairsForPlayer, filterBridgesForPlayer, filterPropsForPlayer } from '../player/fog.js';

/**
 * Resolve theme config to a theme object.
 * If themeOverrides is provided, start with the base theme and spread overrides on top.
 */
function resolveTheme(themeConfig, themeOverrides) {
  let theme;
  if (typeof themeConfig === 'object' && themeConfig !== null) {
    theme = themeConfig;
  } else {
    const name = typeof themeConfig === 'string' ? themeConfig : 'blue-parchment';
    theme = THEMES[name] || THEMES['blue-parchment'];
  }
  if (themeOverrides && typeof themeOverrides === 'object') {
    return { ...theme, ...themeOverrides };
  }
  return theme;
}

/**
 * Calculate the required canvas pixel dimensions for a dungeon config.
 * @returns {{ width: number, height: number }}
 */
export function calculateCanvasSize(config) {
  const gridSize = config.metadata.gridSize;

  const isMultiLevel = config.metadata.levels > 1 &&
                       Array.isArray(config.cells[0]) &&
                       Array.isArray(config.cells[0][0]);

  if (isMultiLevel) {
    const numLevels = config.cells.length;
    let totalHeight = 0;
    let maxWidth = 0;
    const titleFontSize = config.metadata.titleFontSize || 32;
    const titleHeight = titleFontSize + 40;

    for (let level = 0; level < numLevels; level++) {
      const levelCells = config.cells[level];
      const levelBounds = calculateBoundsFromCells(levelCells, gridSize);
      const levelWidth = Math.ceil((levelBounds.maxX - levelBounds.minX) * GRID_SCALE + MARGIN * 2);
      const levelHeight = Math.ceil((levelBounds.maxY - levelBounds.minY) * GRID_SCALE + MARGIN * 2);
      totalHeight += levelHeight + titleHeight;
      maxWidth = Math.max(maxWidth, levelWidth);
    }

    return { width: maxWidth, height: totalHeight };
  }

  const bounds = calculateBoundsFromCells(config.cells, gridSize);
  const hasLevelSubtitles = config.metadata.levels && config.metadata.levels.length > 1;
  const subtitleHeight = hasLevelSubtitles ? 28 : 0;

  return {
    width: Math.ceil((bounds.maxX - bounds.minX) * GRID_SCALE + MARGIN * 2),
    height: Math.ceil((bounds.maxY - bounds.minY) * GRID_SCALE + MARGIN * 2) + subtitleHeight,
  };
}

/**
 * Render a complete dungeon map onto a canvas 2D context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} config - dungeon JSON (metadata + cells)
 * @param {number} width - canvas pixel width
 * @param {number} height - canvas pixel height
 */
export function renderDungeonToCanvas(ctx, config, width, height, propCatalog = null, textureCatalog = null, bgImageEl = null) {
  const gridSize = config.metadata.gridSize;
  const dungeonName = config.metadata.dungeonName;
  const theme = resolveTheme(config.metadata.theme || 'blue-parchment', config.metadata.themeOverrides);
  const features = config.metadata.features || {};
  const showGridInCorridors = features.showGrid === true;
  const labelStyle = config.metadata.labelStyle || 'circled';

  const isMultiLevel = config.metadata.levels > 1 &&
                       Array.isArray(config.cells[0]) &&
                       Array.isArray(config.cells[0][0]);

  drawBackground(ctx, width, height, theme);

  if (isMultiLevel) {
    let yOffset = 0;
    const titleFontSize = config.metadata.titleFontSize || 32;
    const titleHeight = titleFontSize + 40;

    for (let level = 0; level < config.cells.length; level++) {
      const levelCells = config.cells[level];
      const levelName = `${dungeonName} - Level ${level}`;

      drawDungeonTitle(ctx, width, levelName, titleFontSize, theme, yOffset);
      yOffset += titleHeight;

      const levelBounds = calculateBoundsFromCells(levelCells, gridSize);
      const levelHeight = Math.ceil((levelBounds.maxY - levelBounds.minY) * GRID_SCALE + MARGIN * 2);

      const levelTransform = {
        offsetX: MARGIN - levelBounds.minX * GRID_SCALE,
        offsetY: yOffset + MARGIN - levelBounds.minY * GRID_SCALE,
        scale: GRID_SCALE,
      };

      const levelTexOpts = textureCatalog ? { catalog: textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35 } : null;
      const levelLightingEnabled = !!config.metadata.lightingEnabled;
      renderCells(ctx, levelCells, gridSize, theme, levelTransform, {
        showGrid: showGridInCorridors, labelStyle, propCatalog, textureOptions: levelTexOpts,
        metadata: config.metadata, skipLabels: levelLightingEnabled,
        bgImageEl, bgImgConfig: config.metadata.backgroundImage ?? null,
      });

      // Lighting overlay for this level (pixel-perfect for export)
      if (levelLightingEnabled) {
        // Filter placed lights to this level's row range, then merge with fill lights
        const levelLights = (config.metadata.lights || []).filter(l => {
          const lightRow = l.y / gridSize;
          return lightRow >= level.startRow && lightRow < level.startRow + level.numRows;
        });
        const levelFillLights = extractFillLights(levelCells, gridSize, theme);
        const allLevelLights = levelFillLights.length
          ? [...levelLights, ...levelFillLights]
          : levelLights;
        const levelHeight = Math.ceil((levelBounds.maxY - levelBounds.minY) * GRID_SCALE + MARGIN * 2);
        renderLightmapHQ(ctx, allLevelLights, levelCells, gridSize, levelTransform,
          width, levelHeight, config.metadata.ambientLight ?? 0.15, textureCatalog, propCatalog,
          null, config.metadata);
        // Draw labels after lightmap so they are unaffected by the multiply overlay
        renderLabels(ctx, levelCells, gridSize, theme, levelTransform, labelStyle);
      }

      if (features.compassRose) {
        const compassPos = findCompassRosePosition(levelCells, gridSize, width, levelHeight, levelTransform);
        if (compassPos) drawCompassRose(ctx, compassPos.x, compassPos.y, theme);
      }

      yOffset += levelHeight;
    }

    if (features.scale) {
      drawScaleIndicator(ctx, width / 2, height - 20, gridSize, theme, config.metadata.resolution);
    }
    if (features.border) {
      drawBorder(ctx, width, height, theme);
    }

  } else {
    const bounds = calculateBoundsFromCells(config.cells, gridSize);
    const hasLevelSubtitles = config.metadata.levels && config.metadata.levels.length > 1;
    const subtitleHeight = hasLevelSubtitles ? 28 : 0;

    const transform = {
      offsetX: MARGIN - bounds.minX * GRID_SCALE,
      offsetY: MARGIN - bounds.minY * GRID_SCALE + subtitleHeight,
      scale: GRID_SCALE,
    };

    if (dungeonName) {
      const titleFontSize = config.metadata.titleFontSize || 32;
      drawDungeonTitle(ctx, width, dungeonName, titleFontSize, theme);
    }

    const texOpts = textureCatalog ? { catalog: textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35 } : null;
    const singleLevelLightingEnabled = !!config.metadata.lightingEnabled;
    renderCells(ctx, config.cells, gridSize, theme, transform, {
      showGrid: showGridInCorridors, labelStyle, propCatalog, textureOptions: texOpts,
      metadata: config.metadata, skipLabels: singleLevelLightingEnabled,
      bgImageEl, bgImgConfig: config.metadata.backgroundImage ?? null,
    });

    // Lighting overlay (pixel-perfect for export)
    if (singleLevelLightingEnabled) {
      const fillLights = extractFillLights(config.cells, gridSize, theme);
      const allLights = fillLights.length
        ? [...(config.metadata.lights || []), ...fillLights]
        : (config.metadata.lights || []);
      renderLightmapHQ(ctx, allLights, config.cells, gridSize, transform,
        width, height, config.metadata.ambientLight ?? 0.15, textureCatalog, propCatalog,
        null, config.metadata);
      // Draw labels after lightmap so they are unaffected by the multiply overlay
      renderLabels(ctx, config.cells, gridSize, theme, transform, labelStyle);
    }

    if (hasLevelSubtitles) {
      const subtitleFontSize = 18;
      for (const level of config.metadata.levels) {
        const levelTopY = level.startRow * gridSize * transform.scale + transform.offsetY;
        const nameY = levelTopY - 10;
        ctx.save();
        ctx.font = `italic ${subtitleFontSize}px Georgia, "Times New Roman", serif`;
        ctx.fillStyle = theme.textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(level.name, width / 2, nameY);
        ctx.restore();
      }
    }

    if (features.compassRose) {
      const compassPos = findCompassRosePosition(config.cells, gridSize, width, height, transform);
      if (compassPos) drawCompassRose(ctx, compassPos.x, compassPos.y, theme);
    }
    if (features.scale) {
      drawScaleIndicator(ctx, width / 2, height - 20, gridSize, theme, config.metadata.resolution);
    }
    if (features.border) {
      drawBorder(ctx, width, height, theme);
    }
  }
}

/**
 * Render a player view of a dungeon with fog-of-war applied.
 * Applies the same filtering as the live player view: unrevealed cells become void,
 * secret/invisible doors are hidden, and only revealed props/stairs/bridges are shown.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} config - dungeon JSON (metadata + cells)
 * @param {Set<string>} revealedCells - set of "row,col" keys
 * @param {object} fogOptions - { openedDoors?, openedStairs? }
 * @param {number} width - canvas pixel width
 * @param {number} height - canvas pixel height
 * @param {object|null} propCatalog
 * @param {object|null} textureCatalog
 */
export function renderPlayerViewToCanvas(ctx, config, revealedCells, fogOptions, width, height, propCatalog = null, textureCatalog = null) {
  const { openedDoors = [], openedStairs = [] } = fogOptions || {};
  const gridSize = config.metadata.gridSize;
  const theme = resolveTheme(config.metadata.theme || 'blue-parchment', config.metadata.themeOverrides);
  const features = config.metadata.features || {};
  const showGrid = features.showGrid === true;
  const labelStyle = config.metadata.labelStyle || 'circled';

  // Apply fog-of-war filtering
  const playerCells = buildPlayerCells(config, revealedCells, openedDoors);
  const filteredStairs = filterStairsForPlayer(config.metadata.stairs, revealedCells, openedStairs);
  const filteredBridges = filterBridgesForPlayer(config.metadata.bridges, revealedCells);
  const filteredProps = filterPropsForPlayer(config.metadata.props, revealedCells, gridSize, propCatalog);
  const playerMetadata = { ...config.metadata, stairs: filteredStairs, bridges: filteredBridges, props: filteredProps };

  // Black background (fog)
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  const bounds = calculateBoundsFromCells(config.cells, gridSize);
  const transform = {
    offsetX: MARGIN - bounds.minX * GRID_SCALE,
    offsetY: MARGIN - bounds.minY * GRID_SCALE,
    scale: GRID_SCALE,
  };

  const texOpts = textureCatalog ? { catalog: textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35 } : null;
  const lightingEnabled = !!(playerMetadata.lightingEnabled && playerMetadata.lights?.length > 0);

  renderCells(ctx, playerCells, gridSize, theme, transform, {
    showGrid, labelStyle, propCatalog, textureOptions: texOpts,
    metadata: playerMetadata, skipLabels: lightingEnabled,
  });

  if (lightingEnabled) {
    const fillLights = extractFillLights(playerCells, gridSize, theme);
    const allLights = fillLights.length
      ? [...(playerMetadata.lights || []), ...fillLights]
      : (playerMetadata.lights || []);
    renderLightmapHQ(ctx, allLights, playerCells, gridSize, transform,
      width, height, playerMetadata.ambientLight ?? 0.15, textureCatalog, propCatalog,
      null, playerMetadata);
    renderLabels(ctx, playerCells, gridSize, theme, transform, labelStyle);
  }
}
