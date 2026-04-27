// Grid math and coordinate helpers
import type { Direction, Dungeon, RenderTransform } from '../../types.js';
import { CURRENT_FORMAT_VERSION } from './migrations.js';
import { RESOLUTION_DEFAULT, fromCanvas } from '../../util/index.js';

// Coordinate transforms (`toCanvas`, `fromCanvas`, `pixelToCell`) live in
// `src/util/grid.ts` so the player view and the Node-side render pipeline can
// share the same implementation. Re-exported here so editor-side importers
// don't need to update their import paths.
export { toCanvas, fromCanvas, pixelToCell } from '../../util/index.js';

/**
 * Detect which edge of a cell the mouse is nearest to.
 * @param {number} px - Canvas pixel X.
 * @param {number} py - Canvas pixel Y.
 * @param {Object} transform - The pan/zoom transform.
 * @param {number} gridSize - Grid cell size in feet.
 * @param {number} [edgeMarginRatio=0.25] - Fraction of cell width considered "near" an edge.
 * @returns {{ direction: string, row: number, col: number }|null} Edge info or null if not near an edge.
 */
export function nearestEdge(
  px: number,
  py: number,
  transform: RenderTransform,
  gridSize: number,
  edgeMarginRatio: number = 0.25,
): { direction: Direction; row: number; col: number } | null {
  const feet = fromCanvas(px, py, transform);
  const col = Math.floor(feet.x / gridSize);
  const row = Math.floor(feet.y / gridSize);

  const relX = feet.x / gridSize - col; // 0..1 within cell
  const relY = feet.y / gridSize - row;

  const margin = edgeMarginRatio;

  const candidates: Array<{ direction: Direction; dist: number }> = [];

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
  return { direction: candidates[0]!.direction, row, col };
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
export function createEmptyDungeon(
  name: string,
  rows: number,
  cols: number,
  gridSize: number = 5,
  theme: string = 'stone-dungeon',
  resolution: number = RESOLUTION_DEFAULT,
): Dungeon {
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
      labelStyle: 'circled' as const,
      features: {
        showGrid: true,
        showSubGrid: true,
        compassRose: true,
        scale: true,
        border: true,
      },
      levels: [{ name: 'Level 1', startRow: 0, numRows: internalRows }],
      lightingEnabled: false,
      ambientLight: 1.0,
      lights: [],
      stairs: [],
      bridges: [],
      nextLightId: 0,
      nextBridgeId: 0,
      nextStairId: 0,
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
export function nearestCorner(
  px: number,
  py: number,
  transform: RenderTransform,
  gridSize: number,
): { row: number; col: number } {
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

// ── Safe DOM helpers ──────────────────────────────────────────────────────

/**
 * Get a DOM element by ID, throwing a descriptive error if missing.
 * Use instead of `document.getElementById(id)!` for better error messages.
 */
export function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element: #${id}`);
  return el as T;
}

/**
 * Get a 2D canvas rendering context, throwing if unavailable.
 * Use instead of `canvas.getContext('2d')!` for better error messages.
 */
export function getCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`Failed to get 2d context from <canvas id="${canvas.id}">`);
  return ctx;
}
