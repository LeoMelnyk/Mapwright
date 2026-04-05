/**
 * Universal VTT (.dd2vtt) export module.
 *
 * Generates the dd2vtt JSON format used by Foundry VTT (via Universal Battlemap Import),
 * Roll20, and other VTT platforms. The format embeds a base64 PNG image alongside
 * line-of-sight walls, doors (portals), and lights in grid-unit coordinates.
 *
 * @module export-dd2vtt
 */

import type { Dd2vttFormat, CellGrid } from '../types.js';
import { GRID_SCALE, MARGIN } from './constants.js';
import { calculateBoundsFromCells } from './bounds.js';

/**
 * Convert mapwright dungeon data to dd2vtt JSON format.
 *
 * @param {Buffer} pngBuffer - Rendered PNG image as a Buffer
 * @param {Object} config - Full dungeon config (metadata + cells)
 * @param {number} canvasWidth - Width of the rendered PNG in pixels
 * @param {number} canvasHeight - Height of the rendered PNG in pixels
 * @returns {Object} dd2vtt-format JSON object
 */
export function buildDd2vtt(pngBuffer: Buffer, config: any, canvasWidth: number, canvasHeight: number): Dd2vttFormat {
  const { metadata, cells } = config;
  const gridSize = metadata.gridSize || 5;
  const resolution = metadata.resolution || 1;
  const displayGridSize = gridSize * resolution;

  // Calculate bounds to determine offset (same logic as compile.js)
  const bounds = calculateBoundsFromCells(cells, displayGridSize);
  const offsetX = MARGIN - bounds.minX * GRID_SCALE;
  const offsetY = MARGIN - bounds.minY * GRID_SCALE;

  // Pixels per grid square in the rendered image
  const pixelsPerGrid = GRID_SCALE * displayGridSize;

  // Encode PNG as base64 data URI
  const imageBase64 = pngBuffer.toString('base64');

  // Extract walls (line_of_sight) and doors (portals) from the cell grid
  const { walls, portals } = extractWallsAndPortals(cells, displayGridSize, offsetX, offsetY, pixelsPerGrid);

  // Extract lights
  const lights = extractLights(metadata, displayGridSize, offsetX, offsetY, pixelsPerGrid);

  return {
    format: 0.3,
    resolution: {
      map_origin: { x: 0, y: 0 },
      map_size: { x: canvasWidth / pixelsPerGrid, y: canvasHeight / pixelsPerGrid },
      pixels_per_grid: pixelsPerGrid,
    },
    image: imageBase64,
    line_of_sight: walls,
    portals,
    lights,
    environment: {
      brt: metadata.ambientLight ?? 0.5,
      exp: 0,
    },
  };
}

/**
 * Extract wall segments and door portals from the cell grid.
 *
 * Walls become line_of_sight entries: [[x1,y1],[x2,y2]]
 * Doors become portals with open/closed state and rotation.
 *
 * @param {Array<Array>} cells - 2D cell grid
 * @param {number} displayGridSize - Grid size in display units (feet * resolution)
 * @param {number} offsetX - Canvas X offset in pixels
 * @param {number} offsetY - Canvas Y offset in pixels
 * @param {number} pixelsPerGrid - Pixels per grid square
 * @returns {{ walls: Array, portals: Array }}
 */
function extractWallsAndPortals(cells: CellGrid, displayGridSize: number, offsetX: number, offsetY: number, pixelsPerGrid: number): { walls: any[]; portals: any[] } {
  const walls = [];
  const portals = [];
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const seen = new Set();

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row][col];
      if (!cell) continue;

      // Cardinal directions: north, south, east, west
      const edges = [
        { dir: 'north', x1: col, y1: row, x2: col + 1, y2: row },
        { dir: 'south', x1: col, y1: row + 1, x2: col + 1, y2: row + 1 },
        { dir: 'west',  x1: col, y1: row, x2: col, y2: row + 1 },
        { dir: 'east',  x1: col + 1, y1: row, x2: col + 1, y2: row + 1 },
      ];

      for (const edge of edges) {
        const val = cell[edge.dir];
        if (!val) continue;

        // Skip invisible walls/doors — they shouldn't affect VTT line of sight
        if (val === 'iw' || val === 'id') continue;

        // Deduplicate: each wall segment is shared between two cells
        const key = `${Math.min(edge.x1, edge.x2)},${Math.min(edge.y1, edge.y2)}-${Math.max(edge.x1, edge.x2)},${Math.max(edge.y1, edge.y2)}-${edge.dir}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Convert cell-grid coords to pixel coords, then to grid-unit coords
        const seg = cellToPixelSegment(edge, displayGridSize, offsetX, offsetY, pixelsPerGrid);

        if (val === 'w') {
          // Wall → line of sight blocker
          walls.push([
            { x: seg.x1, y: seg.y1 },
            { x: seg.x2, y: seg.y2 },
          ]);
        } else if (val === 'd' || val === 's') {
          // Door → portal (closed by default, secret doors also closed)
          const rotation = (edge.dir === 'north' || edge.dir === 'south') ? 0 : 90;
          portals.push({
            position: {
              x: (seg.x1 + seg.x2) / 2,
              y: (seg.y1 + seg.y2) / 2,
            },
            bounds: [
              { x: seg.x1, y: seg.y1 },
              { x: seg.x2, y: seg.y2 },
            ],
            rotation,
            closed: true,
            freestanding: false,
          });
        }
      }
    }
  }

  return { walls, portals };
}

/**
 * Convert a cell-grid edge to grid-unit coordinates in the exported image space.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number }} edge - Edge in cell coords
 * @param {number} displayGridSize - Grid size in display units
 * @param {number} offsetX - Canvas X offset in pixels
 * @param {number} offsetY - Canvas Y offset in pixels
 * @param {number} pixelsPerGrid - Pixels per grid square
 * @returns {{ x1: number, y1: number, x2: number, y2: number }} Edge in grid-unit coords
 */
function cellToPixelSegment(edge: any, displayGridSize: number, offsetX: number, offsetY: number, pixelsPerGrid: number): { x1: number; y1: number; x2: number; y2: number } {
  // Cell coords → world feet → canvas pixels → grid units
  const toGridUnits = (cellVal, offset) => {
    const worldFeet = cellVal * displayGridSize;
    const canvasPixels = worldFeet * GRID_SCALE + offset;
    return canvasPixels / pixelsPerGrid;
  };

  return {
    x1: toGridUnits(edge.x1, offsetX),
    y1: toGridUnits(edge.y1, offsetY),
    x2: toGridUnits(edge.x2, offsetX),
    y2: toGridUnits(edge.y2, offsetY),
  };
}

/**
 * Extract lights from metadata and convert to dd2vtt format.
 *
 * @param {Object} metadata - Dungeon metadata with lights array
 * @param {number} displayGridSize - Grid size in display units
 * @param {number} offsetX - Canvas X offset in pixels
 * @param {number} offsetY - Canvas Y offset in pixels
 * @param {number} pixelsPerGrid - Pixels per grid square
 * @returns {Array<Object>} Array of dd2vtt light objects
 */
function extractLights(metadata: any, displayGridSize: number, offsetX: number, offsetY: number, pixelsPerGrid: number): any[] {
  if (!metadata.lights || !metadata.lightingEnabled) return [];

  return metadata.lights.map(light => {
    // Light positions are in world feet — convert to canvas pixels, then grid units
    const canvasX = light.x * GRID_SCALE + offsetX;
    const canvasY = light.y * GRID_SCALE + offsetY;
    const gridX = canvasX / pixelsPerGrid;
    const gridY = canvasY / pixelsPerGrid;

    // Convert radius from feet to grid units
    const radiusGridUnits = light.radius / displayGridSize;

    // Parse color hex to r,g,b (0-1 range)
    const color = light.color || '#ff9944';
    const r = parseInt(color.slice(1, 3), 16) / 255;
    const g = parseInt(color.slice(3, 5), 16) / 255;
    const b = parseInt(color.slice(5, 7), 16) / 255;

    return {
      position: { x: gridX, y: gridY },
      range: radiusGridUnits,
      intensity: light.intensity ?? 1.0,
      color: `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`,
      shadows: true,
    };
  });
}
