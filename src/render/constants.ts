/**
 * constants.ts - Shared rendering constants.
 *
 * Single source of truth for all cross-cutting render-pipeline configuration.
 * Per-feature drawing parameters live with the feature renderer; only values
 * that are referenced from multiple files (or that benefit from being tweaked
 * together as a group) belong here.
 */

/** Pixels per foot at export resolution */
const GRID_SCALE: number = 20;
/** Pixel margin around the dungeon (scales with GRID_SCALE) */
const MARGIN: number = 100;
/** Default wall line width in pixels */
const LINE_WIDTH: number = 6;

/**
 * Z-position constants for sub-cell coordinate placement.
 */
const Z_POSITIONS: Record<string, number> = {
  TOP_LEFT: 0,
  TOP_CENTER: 1,
  TOP_RIGHT: 2,
  RIGHT_CENTER: 3,
  BOTTOM_RIGHT: 4,
  BOTTOM_CENTER: 5,
  BOTTOM_LEFT: 6,
  LEFT_CENTER: 7,
  CENTER: 8
};

/**
 * Feature-rendering geometry constants.
 *
 * These were previously scattered across borders.ts as file-scoped consts.
 * Hoisted here so the visual proportions of doors, secret doors, and stairs
 * can be tuned in one place rather than hunting through 1000-line files.
 */
const FEATURE_SIZES = {
  /** Fraction of cell edge a normal door occupies */
  DOOR_LENGTH_MULT: 0.6,
  /** Diagonal door length, compensated for √2 diagonal */
  DIAG_DOOR_LENGTH_MULT: 0.80 * Math.SQRT2,
  /** Font size multiplier for the "S" glyph on secret doors */
  SECRET_FONT_MULT: 0.7,
  /** Number of hatch lines drawn across a stair body */
  STAIR_NUM_LINES: 6,
  /** Inset margin from stair edge before hatching starts */
  STAIR_HATCH_MARGIN: 0.08,
  /** Spacing between successive hatch lines, as fraction of cell */
  STAIR_HATCH_LINE_SPACING: 0.2,
} as const;

/**
 * Bridge texture IDs.
 *
 * Single source of truth for which Polyhaven texture each bridge type maps to.
 * Imported by both render/bridges.ts (for drawing) and render/texture-catalog-node.ts
 * (for preloading textures referenced by a map's bridges).
 */
const BRIDGE_TEXTURE_IDS = {
  wood:  'polyhaven/weathered_planks',
  stone: 'polyhaven/stone_wall',
  rope:  'polyhaven/worn_planks',
  dock:  'polyhaven/brown_planks_09',
} as const;

export { GRID_SCALE, MARGIN, LINE_WIDTH, Z_POSITIONS, FEATURE_SIZES, BRIDGE_TEXTURE_IDS };
