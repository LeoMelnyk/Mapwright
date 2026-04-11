/**
 * Shared dungeon render pipeline.
 * Pure canvas 2D API — no Node or browser dependencies.
 * Used by both generate_dungeon.js (CLI) and the editor's Export PNG.
 */

import { asMultiLevel, type CellGrid, type Metadata, type PropCatalog, type TextureCatalog, type Theme } from '../types.js';
import type { OpenedDoor } from '../player/player-state.js';
import { GRID_SCALE, MARGIN } from './constants.js';
import { THEMES } from './themes.js';
import { calculateBoundsFromCells } from './bounds.js';
import { renderCells, renderLabels } from './render.js';
import { drawBackground, drawDungeonTitle, findCompassRosePosition, drawCompassRose, drawScaleIndicator, drawBorder } from './decorations.js';
import { renderLightmapHQ } from './lighting-hq.js';
import { extractFillLights } from './lighting.js';
import { buildPlayerCells, filterStairsForPlayer, filterBridgesForPlayer, filterPropsForPlayer } from '../player/fog.js';

/**
 * Fill in default values for theme color keys that downstream renderers
 * dereference. This is the single source of truth for theme defaults — no
 * other render module should use `theme.foo ?? '#XXXXXX'` fallbacks.
 *
 * Idempotent (calling on an already-normalized theme is a no-op) and
 * non-mutating (returns a fresh object).
 *
 * Cascading defaults preserve the existing intent: `doorStroke` falls back
 * to `wallStroke`, `compassRoseFill` falls back to `wallStroke`, etc.
 */
function normalizeTheme(theme: Theme): Theme {
  // Treat the input as possibly-partial. Themes loaded from .theme files at
  // runtime, theme overrides spread on top of presets, and user-edited themes
  // can all have missing keys even though the static Theme type marks them
  // as required. The cast lets us check each key with `??` defaults; the
  // returned object is guaranteed to satisfy the strict Theme contract.
  const t = theme as unknown as Record<string, string | number | undefined>;
  const wallStroke = (t.wallStroke as string | undefined) ?? '#000000';
  const normalized = {
    ...t,
    wallStroke,
    doorFill:          (t.doorFill as string | undefined)          ?? '#ffffff',
    doorStroke:        (t.doorStroke as string | undefined)        ?? wallStroke,
    secretDoorColor:   (t.secretDoorColor as string | undefined)   ?? wallStroke,
    floorFill:         (t.floorFill as string | undefined)         ?? '#ffffff',
    textColor:         (t.textColor as string | undefined)         ?? '#000000',
    compassRoseFill:   (t.compassRoseFill as string | undefined)   ?? wallStroke,
    compassRoseStroke: (t.compassRoseStroke as string | undefined) ?? wallStroke,
    hatchDistance:     (t.hatchDistance as number | undefined)     ?? 1,
    hatchSize:         (t.hatchSize as number | undefined)         ?? 0.5,
    hatchColor:        (t.hatchColor as string | undefined)        ?? wallStroke,
    wallRoughness:     (t.wallRoughness as number | undefined)     ?? 0,
    gridStyle:         (t.gridStyle as string | undefined)         ?? 'lines',
    gridLineWidth:     (t.gridLineWidth as number | undefined)     ?? 4,
    gridNoise:         (t.gridNoise as number | undefined)         ?? 0,
    gridCornerLength:  (t.gridCornerLength as number | undefined)  ?? 0.3,
    gridOpacity:       (t.gridOpacity as number | undefined)       ?? 0.5,
    textureBlendWidth: (t.textureBlendWidth as number | undefined) ?? 0.35,
  } as unknown as Theme;
  return normalized;
}

/**
 * Resolve theme config to a normalized theme object.
 * If themeOverrides is provided, start with the base theme and spread overrides on top.
 * The returned theme has all expected keys populated — downstream renderers
 * can read them directly without `?? defaults`.
 */
function resolveTheme(themeConfig: string | Record<string, unknown>, themeOverrides: Record<string, unknown> | null): Theme {
  let theme: Theme;
  if (typeof themeConfig === 'object') {
    theme = themeConfig as Theme;
  } else {
    const name = typeof themeConfig === 'string' ? themeConfig : 'blue-parchment';
    theme = THEMES[name];
  }
  let merged = theme;
  if (themeOverrides && typeof themeOverrides === 'object') {
    merged = { ...theme, ...themeOverrides } as Theme;
  }
  return normalizeTheme(merged);
}

// Re-exported for the editor's live render path so it can normalize themes
// loaded from .theme files before passing them to renderCells.
export { normalizeTheme };

/**
 * Calculate the required canvas pixel dimensions for a dungeon config.
 * @param {Object} config - Dungeon config with metadata and cells
 * @returns {{ width: number, height: number }} Required canvas dimensions in pixels
 */
export function calculateCanvasSize(config: { metadata: Metadata; cells: CellGrid }): { width: number; height: number } {
  // Guard against empty or missing cell grids
  if (!config.cells.length || (!Array.isArray(config.cells[0]) || !config.cells[0].length)) {
    return { width: 100, height: 100 };
  }

  const gridSize = config.metadata.gridSize;

  const isMultiLevel = config.metadata.levels.length > 1 &&
                       Array.isArray(config.cells[0]) &&
                       Array.isArray(config.cells[0][0]);

  if (isMultiLevel) {
    const multiCells = asMultiLevel(config.cells);
    const numLevels = multiCells.length;
    let totalHeight = 0;
    let maxWidth = 0;
    const titleFontSize = (config.metadata.titleFontSize as number) || 32;
    const titleHeight = titleFontSize + 40;

    for (let level = 0; level < numLevels; level++) {
      const levelCells = multiCells[level];
      const levelBounds = calculateBoundsFromCells(levelCells, gridSize);
      const levelWidth = Math.ceil((levelBounds.maxX - levelBounds.minX) * GRID_SCALE + MARGIN * 2);
      const levelHeight = Math.ceil((levelBounds.maxY - levelBounds.minY) * GRID_SCALE + MARGIN * 2);
      totalHeight += levelHeight + titleHeight;
      maxWidth = Math.max(maxWidth, levelWidth);
    }

    return { width: maxWidth, height: totalHeight };
  }

  const bounds = calculateBoundsFromCells(config.cells, gridSize);
  const hasLevelSubtitles = config.metadata.levels.length > 1;
  const subtitleHeight = hasLevelSubtitles ? 28 : 0;

  return {
    width: Math.ceil((bounds.maxX - bounds.minX) * GRID_SCALE + MARGIN * 2),
    height: Math.ceil((bounds.maxY - bounds.minY) * GRID_SCALE + MARGIN * 2) + subtitleHeight,
  };
}

/**
 * Render a complete dungeon map onto a canvas 2D context.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Object} config - Dungeon JSON (metadata + cells)
 * @param {number} width - Canvas pixel width
 * @param {number} height - Canvas pixel height
 * @param {Object|null} [propCatalog] - Prop catalog with definitions
 * @param {Object|null} [textureCatalog] - Texture catalog with loaded images
 * @param {HTMLImageElement|null} [bgImageEl] - Background image element
 * @returns {void}
 */
export function renderDungeonToCanvas(ctx: CanvasRenderingContext2D, config: { metadata: Metadata; cells: CellGrid }, width: number, height: number, propCatalog: PropCatalog | null = null, textureCatalog: TextureCatalog | null = null, bgImageEl: HTMLImageElement | null = null): void {
  const gridSize = config.metadata.gridSize;
  const dungeonName = config.metadata.dungeonName;
  const theme = resolveTheme(config.metadata.theme || 'blue-parchment', config.metadata.themeOverrides ?? null);
  const features = config.metadata.features;
  const showGridInCorridors = features.showGrid;
  const labelStyle = config.metadata.labelStyle;

  const isMultiLevel = config.metadata.levels.length > 1 &&
                       Array.isArray(config.cells[0]) &&
                       Array.isArray(config.cells[0][0]);

  drawBackground(ctx, width, height, theme);

  if (isMultiLevel) {
    const multiCells = asMultiLevel(config.cells);
    let yOffset = 0;
    const titleFontSize = (config.metadata.titleFontSize as number) || 32;
    const titleHeight = titleFontSize + 40;

    for (let level = 0; level < multiCells.length; level++) {
      const levelCells = multiCells[level];
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
      const levelLightingEnabled = config.metadata.lightingEnabled;
      renderCells(ctx, levelCells, gridSize, theme, levelTransform, {
        showGrid: showGridInCorridors, labelStyle, propCatalog, textureOptions: levelTexOpts,
        metadata: config.metadata, skipLabels: levelLightingEnabled,
        bgImageEl, bgImgConfig: config.metadata.backgroundImage ?? null,
      });

      // Lighting overlay for this level (pixel-perfect for export)
      if (levelLightingEnabled) {
        // Filter placed lights to this level's row range, then merge with fill lights
        const levelDef = config.metadata.levels[level];
        const levelLights = config.metadata.lights.filter((l) => {
          const lightRow = (l.y) / gridSize;
          return lightRow >= levelDef.startRow && lightRow < levelDef.startRow + levelDef.numRows;
        });
        const levelFillLights = extractFillLights(levelCells, gridSize, theme);
        const allLevelLights = levelFillLights.length
          ? [...levelLights, ...levelFillLights]
          : levelLights;
        const levelHeight2 = Math.ceil((levelBounds.maxY - levelBounds.minY) * GRID_SCALE + MARGIN * 2);
        renderLightmapHQ(ctx, allLevelLights, levelCells, gridSize, levelTransform,
          width, levelHeight2, config.metadata.ambientLight, textureCatalog, propCatalog,
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
    const hasLevelSubtitles = config.metadata.levels.length > 1;
    const subtitleHeight = hasLevelSubtitles ? 28 : 0;

    const transform = {
      offsetX: MARGIN - bounds.minX * GRID_SCALE,
      offsetY: MARGIN - bounds.minY * GRID_SCALE + subtitleHeight,
      scale: GRID_SCALE,
    };

    if (dungeonName) {
      const titleFontSize = (config.metadata.titleFontSize as number) || 32;
      drawDungeonTitle(ctx, width, dungeonName, titleFontSize, theme);
    }

    const texOpts = textureCatalog ? { catalog: textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35 } : null;
    const singleLevelLightingEnabled = config.metadata.lightingEnabled;
    renderCells(ctx, config.cells, gridSize, theme, transform, {
      showGrid: showGridInCorridors, labelStyle, propCatalog, textureOptions: texOpts,
      metadata: config.metadata, skipLabels: singleLevelLightingEnabled,
      bgImageEl, bgImgConfig: config.metadata.backgroundImage ?? null,
    });

    // Lighting overlay (pixel-perfect for export)
    if (singleLevelLightingEnabled) {
      const fillLights = extractFillLights(config.cells, gridSize, theme);
      const allLights = fillLights.length
        ? [...config.metadata.lights, ...fillLights]
        : config.metadata.lights;
      renderLightmapHQ(ctx, allLights, config.cells, gridSize, transform,
        width, height, config.metadata.ambientLight, textureCatalog, propCatalog,
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
        ctx.fillStyle = theme.textColor ?? theme.label;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(level.name ?? '', width / 2, nameY);
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
 * @param {Object|null} [textureCatalog] - Texture catalog with loaded images
 * @returns {void}
 */
export function renderPlayerViewToCanvas(ctx: CanvasRenderingContext2D, config: { metadata: Metadata; cells: CellGrid }, revealedCells: Set<string>, fogOptions: { openedDoors?: OpenedDoor[]; openedStairs?: number[] } | null, width: number, height: number, propCatalog: PropCatalog | null = null, textureCatalog: TextureCatalog | null = null): void {
  const { openedDoors = [], openedStairs = [] } = fogOptions ?? {};
  const gridSize = config.metadata.gridSize;
  const theme = resolveTheme(config.metadata.theme || 'blue-parchment', config.metadata.themeOverrides ?? null);
  const features = config.metadata.features;
  const showGrid = features.showGrid;
  const labelStyle = config.metadata.labelStyle;

  // Apply fog-of-war filtering
  const revealedSet = revealedCells;
  const playerCells = buildPlayerCells(config, revealedSet, openedDoors);
  const filteredStairs = filterStairsForPlayer(config.metadata.stairs, revealedSet, openedStairs);
  const filteredBridges = filterBridgesForPlayer(config.metadata.bridges, revealedSet);
  const filteredProps = filterPropsForPlayer(config.metadata.props, revealedSet, gridSize, propCatalog);
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
  const lightingEnabled = playerMetadata.lightingEnabled && playerMetadata.lights.length > 0;

  renderCells(ctx, playerCells, gridSize, theme, transform, {
    showGrid, labelStyle, propCatalog, textureOptions: texOpts,
    metadata: playerMetadata, skipLabels: lightingEnabled,
  });

  if (lightingEnabled) {
    const fillLights = extractFillLights(playerCells, gridSize, theme);
    const allLights = fillLights.length
      ? [...playerMetadata.lights, ...fillLights]
      : playerMetadata.lights;
    renderLightmapHQ(ctx, allLights, playerCells, gridSize, transform,
      width, height, playerMetadata.ambientLight, textureCatalog, propCatalog,
      null, playerMetadata);
    renderLabels(ctx, playerCells, gridSize, theme, transform, labelStyle);
  }
}
