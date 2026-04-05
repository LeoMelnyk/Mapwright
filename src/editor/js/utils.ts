// Grid math and coordinate helpers
import type { Dungeon, RenderTransform } from '../../types.js';
import { CURRENT_FORMAT_VERSION } from './migrations.js';
import { RESOLUTION_DEFAULT } from '../../util/index.js';

/**
 * Convert feet coordinates to canvas pixels.
 * @param {number} x - X position in feet.
 * @param {number} y - Y position in feet.
 * @param {Object} transform - The pan/zoom transform ({ scale, offsetX, offsetY }).
 * @returns {{ x: number, y: number }} Canvas pixel coordinates.
 */
export function toCanvas(x: number, y: number, transform: RenderTransform): { x: number; y: number } {
  return {
    x: x * transform.scale + transform.offsetX,
    y: y * transform.scale + transform.offsetY,
  };
}

/**
 * Convert canvas pixels back to feet coordinates.
 * @param {number} px - Canvas pixel X.
 * @param {number} py - Canvas pixel Y.
 * @param {Object} transform - The pan/zoom transform ({ scale, offsetX, offsetY }).
 * @returns {{ x: number, y: number }} Position in feet.
 */
export function fromCanvas(px: number, py: number, transform: RenderTransform): { x: number; y: number } {
  return {
    x: (px - transform.offsetX) / transform.scale,
    y: (py - transform.offsetY) / transform.scale,
  };
}

/**
 * Convert canvas pixel position to grid cell (row, col).
 * @param {number} px - Canvas pixel X.
 * @param {number} py - Canvas pixel Y.
 * @param {Object} transform - The pan/zoom transform.
 * @param {number} gridSize - Grid cell size in feet.
 * @returns {{ row: number, col: number }} Grid cell coordinates.
 */
export function pixelToCell(px: number, py: number, transform: RenderTransform, gridSize: number): { row: number; col: number } {
  const feet = fromCanvas(px, py, transform);
  return {
    row: Math.floor(feet.y / gridSize),
    col: Math.floor(feet.x / gridSize),
  };
}

/**
 * Detect which edge of a cell the mouse is nearest to.
 * @param {number} px - Canvas pixel X.
 * @param {number} py - Canvas pixel Y.
 * @param {Object} transform - The pan/zoom transform.
 * @param {number} gridSize - Grid cell size in feet.
 * @param {number} [edgeMarginRatio=0.25] - Fraction of cell width considered "near" an edge.
 * @returns {{ direction: string, row: number, col: number }|null} Edge info or null if not near an edge.
 */
export function nearestEdge(px: number, py: number, transform: RenderTransform, gridSize: number, edgeMarginRatio: number = 0.25): { direction: string; row: number; col: number } | null {
  const feet = fromCanvas(px, py, transform);
  const col = Math.floor(feet.x / gridSize);
  const row = Math.floor(feet.y / gridSize);

  const relX = (feet.x / gridSize) - col; // 0..1 within cell
  const relY = (feet.y / gridSize) - row;

  const margin = edgeMarginRatio;

  const candidates = [];

  if (relY < margin) candidates.push({ direction: 'north', dist: relY });
  if (relY > 1 - margin) candidates.push({ direction: 'south', dist: 1 - relY });
  if (relX > 1 - margin) candidates.push({ direction: 'east', dist: 1 - relX });
  if (relX < margin) candidates.push({ direction: 'west', dist: relX });

  // Diagonal detection
  const nwseDist = Math.abs(relX - relY) / Math.SQRT2;
  const neswDist = Math.abs(relX - (1 - relY)) / Math.SQRT2;
  if (nwseDist < margin * 0.7) candidates.push({ direction: 'nw-se', dist: nwseDist });
  if (neswDist < margin * 0.7) candidates.push({ direction: 'ne-sw', dist: neswDist });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  return { direction: candidates[0].direction, row, col };
}

/**
 * Create an empty dungeon JSON with given dimensions.
 * @param {string} name - Dungeon display name.
 * @param {number} rows - Display rows (user-facing).
 * @param {number} cols - Display cols (user-facing).
 * @param {number} [gridSize=5] - Display grid size in feet.
 * @param {string} [theme='stone-dungeon'] - Theme identifier.
 * @param {number} [resolution] - Internal subdivision factor.
 * @returns {Object} A dungeon JSON object with metadata and empty cells grid.
 */
export function createEmptyDungeon(name: string, rows: number, cols: number, gridSize: number = 5, theme: string = 'stone-dungeon', resolution: number = RESOLUTION_DEFAULT): Dungeon {
  const internalRows = rows * resolution;
  const internalCols = cols * resolution;
  const internalGridSize = gridSize / resolution;

  const cells = [];
  for (let r = 0; r < internalRows; r++) {
    const row = [];
    for (let c = 0; c < internalCols; c++) {
      row.push(null);
    }
    cells.push(row);
  }
  return {
    metadata: {
      formatVersion: CURRENT_FORMAT_VERSION,
      dungeonName: name,
      gridSize: internalGridSize,
      resolution,
      theme,
      features: {
        showGrid: true,
        showSubGrid: true,
        compassRose: true,
        scale: true,
        border: true,
      },
      levels: [{ name: 'Level 1', startRow: 0, numRows: internalRows }],
      bridges: [],
      nextBridgeId: 0,
    },
    cells,
  };
}

/**
 * Find the nearest grid corner (intersection point) to a canvas pixel position.
 * Grid corners are at integer (row, col) positions where lines cross.
 * @param {number} px - Canvas pixel X
 * @param {number} py - Canvas pixel Y
 * @param {object} transform - { scale, offsetX, offsetY }
 * @param {number} gridSize - Grid cell size in feet
 * @returns {{ row: number, col: number }}
 */
export function nearestCorner(px: number, py: number, transform: RenderTransform, gridSize: number): { row: number; col: number } {
  const feet = fromCanvas(px, py, transform);
  return {
    row: Math.round(feet.y / gridSize),
    col: Math.round(feet.x / gridSize),
  };
}

/**
 * Deep clone an object via JSON round-trip.
 * @param {Object} obj - The object to clone.
 * @returns {Object} A deep copy of the input object.
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
