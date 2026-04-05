/**
 * constants.ts - Shared rendering constants.
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

export { GRID_SCALE, MARGIN, LINE_WIDTH, Z_POSITIONS };
