/**
 * Shared dungeon render pipeline.
 * Pure canvas 2D API — no Node or browser dependencies.
 * Used by both generate_dungeon.js (CLI) and the editor's Export PNG.
 */

import {
  asMultiLevel,
  type CellGrid,
  type Metadata,
  type PropCatalog,
  type TextureCatalog,
  type Theme,
} from '../types.js';
import type { OpenedDoor } from '../player/player-state.js';
import { GRID_SCALE, MARGIN } from './constants.js';
import { THEMES } from './themes.js';
import { calculateBoundsFromCells } from './bounds.js';
import { renderCells, renderLabels } from './render.js';
import {
  drawBackground,
  drawDungeonTitle,
  findCompassRosePosition,
  drawCompassRose,
  drawScaleIndicator,
  drawBorder,
} from './decorations.js';
import { extractFillLights, renderLightmap, invalidateVisibilityCache } from './lighting.js';
import { buildFluidComposite, invalidateFluidCache, FLUID_BASE_SKIP, FLUID_TOP_SKIP } from './fluid.js';
import { renderWeatherEffects } from './render-weather.js';
import { getCachedRoomCells } from './render-cache.js';
import {
  buildPlayerCells,
  filterStairsForPlayer,
  filterBridgesForPlayer,
  filterPropsForPlayer,
} from '../player/fog.js';

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
    doorFill: (t.doorFill as string | undefined) ?? '#ffffff',
    doorStroke: (t.doorStroke as string | undefined) ?? wallStroke,
    secretDoorColor: (t.secretDoorColor as string | undefined) ?? wallStroke,
    floorFill: (t.floorFill as string | undefined) ?? '#ffffff',
    textColor: (t.textColor as string | undefined) ?? '#000000',
    compassRoseFill: (t.compassRoseFill as string | undefined) ?? wallStroke,
    compassRoseStroke: (t.compassRoseStroke as string | undefined) ?? wallStroke,
    hatchDistance: (t.hatchDistance as number | undefined) ?? 1,
    hatchSize: (t.hatchSize as number | undefined) ?? 0.5,
    hatchColor: (t.hatchColor as string | undefined) ?? wallStroke,
    wallRoughness: (t.wallRoughness as number | undefined) ?? 0,
    gridStyle: (t.gridStyle as string | undefined) ?? 'lines',
    gridLineWidth: (t.gridLineWidth as number | undefined) ?? 4,
    gridNoise: (t.gridNoise as number | undefined) ?? 0,
    gridCornerLength: (t.gridCornerLength as number | undefined) ?? 0.3,
    gridOpacity: (t.gridOpacity as number | undefined) ?? 0.5,
    textureBlendWidth: (t.textureBlendWidth as number | undefined) ?? 0.35,
    waterShallowColor: (t.waterShallowColor as string | undefined) ?? '#2d69a5',
    waterMediumColor: (t.waterMediumColor as string | undefined) ?? '#1c4480',
    waterDeepColor: (t.waterDeepColor as string | undefined) ?? '#0c265c',
    waterCausticColor: (t.waterCausticColor as string | undefined) ?? 'rgba(160,215,255,0.55)',
    lavaShallowColor: (t.lavaShallowColor as string | undefined) ?? '#cc4400',
    lavaMediumColor: (t.lavaMediumColor as string | undefined) ?? '#992200',
    lavaDeepColor: (t.lavaDeepColor as string | undefined) ?? '#661100',
    lavaCausticColor: (t.lavaCausticColor as string | undefined) ?? 'rgba(255,160,60,0.55)',
    lavaLightColor: (t.lavaLightColor as string | undefined) ?? '#ff5500',
    lavaLightIntensity: (t.lavaLightIntensity as number | undefined) ?? 0.7,
    pitBaseColor: (t.pitBaseColor as string | undefined) ?? '#0a0a0a',
    pitCrackColor: (t.pitCrackColor as string | undefined) ?? '#1a1a1a',
    pitVignetteColor: (t.pitVignetteColor as string | undefined) ?? 'rgba(0,0,0,0.5)',
  } as unknown as Theme;
  return normalized;
}

/**
 * Resolve theme config to a normalized theme object.
 * If themeOverrides is provided, start with the base theme and spread overrides on top.
 * The returned theme has all expected keys populated — downstream renderers
 * can read them directly without `?? defaults`.
 */
function resolveTheme(
  themeConfig: string | Record<string, unknown>,
  themeOverrides: Record<string, unknown> | null,
): Theme {
  let theme: Theme;
  if (typeof themeConfig === 'object') {
    theme = themeConfig as Theme;
  } else {
    const name = typeof themeConfig === 'string' ? themeConfig : 'blue-parchment';
    theme = THEMES[name]!;
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

// ── Export fluid helper ──────────────────────────────────────────────────
// The live editor's MapCache composites fluids between the base and top
// cells phases. The export pipeline mirrors that split: we call
// `renderCells` twice with disjoint `skipPhases` and blit a fluid
// composite in between, so walls / grid / props stay visually above
// water / lava / pit.

function _blitFluidCompositeForLevel(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  gridSize: number,
  theme: Theme,
  transform: { scale: number; offsetX: number; offsetY: number },
): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  if (!numRows || !numCols) return;
  const cacheW = Math.ceil(numCols * gridSize * transform.scale);
  const cacheH = Math.ceil(numRows * gridSize * transform.scale);
  const roomCells = getCachedRoomCells(cells);
  const composite = buildFluidComposite(cells, roomCells, gridSize, theme, transform.scale, cacheW, cacheH, null);
  if (!composite) return;
  // Composite renders world (0,0) at canvas (0,0); transform.offsetX/Y
  // maps world (0,0) to target (offsetX, offsetY). Blit at that offset so
  // the world coords line up.
  ctx.drawImage(composite, transform.offsetX, transform.offsetY);
}

/**
 * Calculate the required canvas pixel dimensions for a dungeon config.
 * @param {Object} config - Dungeon config with metadata and cells
 * @returns {{ width: number, height: number }} Required canvas dimensions in pixels
 */
export function calculateCanvasSize(config: { metadata: Metadata; cells: CellGrid }): {
  width: number;
  height: number;
} {
  // Guard against empty or missing cell grids
  if (!config.cells.length || !Array.isArray(config.cells[0]) || !config.cells[0].length) {
    return { width: 100, height: 100 };
  }

  const gridSize = config.metadata.gridSize;

  const isMultiLevel =
    config.metadata.levels.length > 1 && Array.isArray(config.cells[0]) && Array.isArray(config.cells[0][0]);

  if (isMultiLevel) {
    const multiCells = asMultiLevel(config.cells);
    const numLevels = multiCells.length;
    let totalHeight = 0;
    let maxWidth = 0;
    const titleFontSize = (config.metadata.titleFontSize as number) || 32;
    const titleHeight = titleFontSize + 40;

    for (let level = 0; level < numLevels; level++) {
      const levelCells = multiCells[level]!;
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
export function renderDungeonToCanvas(
  ctx: CanvasRenderingContext2D,
  config: { metadata: Metadata; cells: CellGrid },
  width: number,
  height: number,
  propCatalog: PropCatalog | null = null,
  textureCatalog: TextureCatalog | null = null,
  bgImageEl: HTMLImageElement | null = null,
  renderOptions: { bakeLighting?: boolean; bakeWeather?: boolean } = {},
): void {
  const bakeLightingOpt = renderOptions.bakeLighting !== false;
  const bakeWeatherOpt = renderOptions.bakeWeather !== false;
  const gridSize = config.metadata.gridSize;
  const dungeonName = config.metadata.dungeonName;
  const theme = resolveTheme(config.metadata.theme || 'blue-parchment', config.metadata.themeOverrides ?? null);
  const features = config.metadata.features;
  const showGridInCorridors = features.showGrid;
  const labelStyle = config.metadata.labelStyle;

  const isMultiLevel =
    config.metadata.levels.length > 1 && Array.isArray(config.cells[0]) && Array.isArray(config.cells[0][0]);

  drawBackground(ctx, width, height, theme);

  if (isMultiLevel) {
    const multiCells = asMultiLevel(config.cells);
    let yOffset = 0;
    const titleFontSize = (config.metadata.titleFontSize as number) || 32;
    const titleHeight = titleFontSize + 40;

    for (let level = 0; level < multiCells.length; level++) {
      const levelCells = multiCells[level]!;
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

      const levelTexOpts = textureCatalog
        ? { catalog: textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35 }
        : null;
      const levelLightingEnabled = config.metadata.lightingEnabled && bakeLightingOpt;
      // Pass 1: base phases (shading + floors + blending + bridges)
      renderCells(ctx, levelCells, gridSize, theme, levelTransform, {
        showGrid: showGridInCorridors,
        labelStyle,
        propCatalog: null,
        textureOptions: levelTexOpts,
        metadata: config.metadata,
        skipLabels: true,
        bgImageEl,
        bgImgConfig: config.metadata.backgroundImage ?? null,
        skipPhases: { ...FLUID_BASE_SKIP },
      });
      // Fluid composite (water / lava / pit) between base and top phases
      invalidateFluidCache();
      _blitFluidCompositeForLevel(ctx, levelCells, gridSize, theme, levelTransform);
      // Pass 2: top phases (walls + grid + props + hazard)
      renderCells(ctx, levelCells, gridSize, theme, levelTransform, {
        showGrid: showGridInCorridors,
        labelStyle,
        propCatalog,
        textureOptions: levelTexOpts,
        metadata: config.metadata,
        skipLabels: levelLightingEnabled,
        bgImageEl: null,
        bgImgConfig: null,
        skipPhases: { ...FLUID_TOP_SKIP },
      });

      // Lighting overlay for this level (pixel-perfect for export)
      if (levelLightingEnabled) {
        // Filter placed lights to this level's row range, then merge with fill lights
        const levelDef = config.metadata.levels[level]!;
        const levelLights = config.metadata.lights.filter((l) => {
          const lightRow = l.y / gridSize;
          return lightRow >= levelDef.startRow && lightRow < levelDef.startRow + levelDef.numRows;
        });
        const levelFillLights = extractFillLights(levelCells, gridSize, theme);
        const allLevelLights = levelFillLights.length ? [...levelLights, ...levelFillLights] : levelLights;
        const levelMapW = Math.ceil((levelBounds.maxX - levelBounds.minX) * GRID_SCALE);
        const levelMapH = Math.ceil((levelBounds.maxY - levelBounds.minY) * GRID_SCALE);
        // Use the editor's lightmap path so exports match what the user sees.
        // Drop the visibility cache first — successive exports of different
        // maps share the module-level cache and would otherwise reuse stale
        // wall geometry.
        invalidateVisibilityCache('walls');
        renderLightmap(
          ctx,
          allLevelLights,
          levelCells,
          gridSize,
          { scale: GRID_SCALE, offsetX: 0, offsetY: 0 },
          levelMapW,
          levelMapH,
          config.metadata.ambientLight,
          textureCatalog,
          propCatalog,
          {
            ambientColor: config.metadata.ambientColor ?? '#ffffff',
            time: performance.now() / 1000,
            destX: levelTransform.offsetX,
            destY: levelTransform.offsetY,
            destW: levelMapW,
            destH: levelMapH,
          },
          config.metadata,
        );
        // Draw labels after lightmap so they are unaffected by the multiply overlay
        renderLabels(ctx, levelCells, gridSize, theme, levelTransform, labelStyle);
      }

      // Weather (static snapshot — haze + frozen particles). Matches the
      // editor's static-mode render; lightning is omitted since a still image
      // can't convey a flash.
      if (bakeWeatherOpt) {
        renderWeatherEffects(ctx, levelCells, config.metadata, gridSize, levelTransform);
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
    const singleLevelLightingEnabled = config.metadata.lightingEnabled && bakeLightingOpt;
    // Pass 1: base phases (shading + floors + blending + bridges)
    renderCells(ctx, config.cells, gridSize, theme, transform, {
      showGrid: showGridInCorridors,
      labelStyle,
      propCatalog: null,
      textureOptions: texOpts,
      metadata: config.metadata,
      skipLabels: true,
      bgImageEl,
      bgImgConfig: config.metadata.backgroundImage ?? null,
      skipPhases: { ...FLUID_BASE_SKIP },
    });
    // Fluid composite (water / lava / pit) between base and top phases
    invalidateFluidCache();
    _blitFluidCompositeForLevel(ctx, config.cells, gridSize, theme, transform);
    // Pass 2: top phases (walls + grid + props + hazard)
    renderCells(ctx, config.cells, gridSize, theme, transform, {
      showGrid: showGridInCorridors,
      labelStyle,
      propCatalog,
      textureOptions: texOpts,
      metadata: config.metadata,
      skipLabels: singleLevelLightingEnabled,
      bgImageEl: null,
      bgImgConfig: null,
      skipPhases: { ...FLUID_TOP_SKIP },
    });

    // Lighting overlay (pixel-perfect for export)
    if (singleLevelLightingEnabled) {
      const fillLights = extractFillLights(config.cells, gridSize, theme);
      const allLights = fillLights.length ? [...config.metadata.lights, ...fillLights] : config.metadata.lights;
      const mapW = Math.ceil((bounds.maxX - bounds.minX) * GRID_SCALE);
      const mapH = Math.ceil((bounds.maxY - bounds.minY) * GRID_SCALE);
      invalidateVisibilityCache('walls');
      renderLightmap(
        ctx,
        allLights,
        config.cells,
        gridSize,
        { scale: GRID_SCALE, offsetX: 0, offsetY: 0 },
        mapW,
        mapH,
        config.metadata.ambientLight,
        textureCatalog,
        propCatalog,
        {
          ambientColor: config.metadata.ambientColor ?? '#ffffff',
          time: performance.now() / 1000,
          destX: transform.offsetX,
          destY: transform.offsetY,
          destW: mapW,
          destH: mapH,
        },
        config.metadata,
      );
      // Draw labels after lightmap so they are unaffected by the multiply overlay
      renderLabels(ctx, config.cells, gridSize, theme, transform, labelStyle);
    }

    // Weather (static snapshot — haze + frozen particles). Matches the
    // editor's static-mode render; lightning is omitted since a still image
    // can't convey a flash.
    if (bakeWeatherOpt) {
      renderWeatherEffects(ctx, config.cells, config.metadata, gridSize, transform);
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
export function renderPlayerViewToCanvas(
  ctx: CanvasRenderingContext2D,
  config: { metadata: Metadata; cells: CellGrid },
  revealedCells: Set<string>,
  fogOptions: { openedDoors?: OpenedDoor[]; openedStairs?: number[] } | null,
  width: number,
  height: number,
  propCatalog: PropCatalog | null = null,
  textureCatalog: TextureCatalog | null = null,
): void {
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
    showGrid,
    labelStyle,
    propCatalog,
    textureOptions: texOpts,
    metadata: playerMetadata,
    skipLabels: lightingEnabled,
  });

  if (lightingEnabled) {
    const fillLights = extractFillLights(playerCells, gridSize, theme);
    const allLights = fillLights.length ? [...playerMetadata.lights, ...fillLights] : playerMetadata.lights;
    invalidateVisibilityCache('walls');
    renderLightmap(
      ctx,
      allLights,
      playerCells,
      gridSize,
      transform,
      width,
      height,
      playerMetadata.ambientLight,
      textureCatalog,
      propCatalog,
      {
        ambientColor: playerMetadata.ambientColor ?? '#ffffff',
        time: performance.now() / 1000,
      },
      playerMetadata,
    );
    renderLabels(ctx, playerCells, gridSize, theme, transform, labelStyle);
  }

  // Weather (static snapshot). Use the fog-filtered `playerCells` so unrevealed
  // areas stay weather-free — matches the live player view's under-fog behavior.
  renderWeatherEffects(ctx, playerCells, playerMetadata, gridSize, transform);
}
