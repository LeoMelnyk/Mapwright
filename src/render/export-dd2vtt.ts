/**
 * Universal VTT (.dd2vtt) export module.
 *
 * Generates the dd2vtt JSON format used by Foundry VTT (via Universal Battlemap Import),
 * Roll20, and other VTT platforms. The format embeds a base64 PNG image alongside
 * line-of-sight walls, doors (portals), and lights in grid-unit coordinates.
 *
 * @module export-dd2vtt
 */

/// <reference types="node" />
import type { CellGrid, Dd2vttFormat, Dd2vttLight, Dd2vttPortal, Direction, Light, Metadata } from '../types.js';
import { GRID_SCALE, MARGIN } from './constants.js';
import { calculateBoundsFromCells } from './bounds.js';
import { getEdge, getInteriorEdges, isChordEdge } from '../util/index.js';

/**
 * Convert mapwright dungeon data to dd2vtt JSON format.
 *
 * @param {Buffer} pngBuffer - Rendered PNG image as a Buffer
 * @param {Object} config - Full dungeon config (metadata + cells)
 * @param {number} canvasWidth - Width of the rendered PNG in pixels
 * @param {number} canvasHeight - Height of the rendered PNG in pixels
 * @returns {Object} dd2vtt-format JSON object
 */
export function buildDd2vtt(
  pngBuffer: Buffer,
  config: { metadata: Metadata; cells: CellGrid },
  canvasWidth: number,
  canvasHeight: number,
): Dd2vttFormat {
  const { metadata, cells } = config;
  const gridSize = metadata.gridSize || 5;
  const resolution = metadata.resolution || 1;
  const displayGridSize = gridSize * resolution;

  // Calculate bounds to determine offset (same logic as compile.js — uses the
  // mapwright cell size in feet, NOT displayGridSize. `resolution` is the
  // mapwright-cells-per-Foundry-cell factor, not a feet multiplier: at
  // gridSize=2.5 ft and resolution=2, each mapwright cell is 2.5 ft wide and
  // two of them make one 5 ft Foundry cell.)
  const bounds = calculateBoundsFromCells(cells, gridSize);
  const offsetX = MARGIN - bounds.minX * GRID_SCALE;
  const offsetY = MARGIN - bounds.minY * GRID_SCALE;

  // Pixels per Foundry grid square in the rendered image
  const pixelsPerGrid = GRID_SCALE * displayGridSize;

  // Encode PNG as base64 data URI
  const imageBase64 = pngBuffer.toString('base64');

  // Extract walls (line_of_sight), windows (objects_line_of_sight), and doors
  // (portals) from the cell grid
  const { walls, objectWalls, portals } = extractWallsAndPortals(cells, gridSize, offsetX, offsetY, pixelsPerGrid);

  // Extract lights
  const lights = extractLights(metadata, displayGridSize, offsetX, offsetY, pixelsPerGrid);

  return {
    format: 0.4,
    resolution: {
      map_origin: { x: 0, y: 0 },
      map_size: { x: canvasWidth / pixelsPerGrid, y: canvasHeight / pixelsPerGrid },
      pixels_per_grid: pixelsPerGrid,
    },
    image: imageBase64,
    line_of_sight: walls,
    objects_line_of_sight: objectWalls,
    portals,
    lights,
    environment: {
      brt: metadata.ambientLight,
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
function extractWallsAndPortals(
  cells: CellGrid,
  gridSize: number,
  offsetX: number,
  offsetY: number,
  pixelsPerGrid: number,
): {
  walls: Array<[{ x: number; y: number }, { x: number; y: number }]>;
  objectWalls: Array<[{ x: number; y: number }, { x: number; y: number }]>;
  portals: Dd2vttPortal[];
} {
  const walls: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
  const objectWalls: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
  const portals: Dd2vttPortal[] = [];
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const seen = new Set<string>();

  // Doors are collected into per-edge-line maps so reciprocal edges (a cell's
  // south mirrored as its neighbor's north) collapse to one physical door,
  // and contiguous runs along the same line merge into a single portal.
  type DoorType = 'd' | 's';
  // horizontal line at y = line, spans cols [start, start+1]
  const horizontalDoors = new Map<number, Map<number, DoorType>>();
  // vertical line at x = line, spans rows [start, start+1]
  const verticalDoors = new Map<number, Map<number, DoorType>>();

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]![col];
      if (!cell) continue;

      // Cardinal directions: north, south, east, west
      const edges = [
        { dir: 'north', x1: col, y1: row, x2: col + 1, y2: row },
        { dir: 'south', x1: col, y1: row + 1, x2: col + 1, y2: row + 1 },
        { dir: 'west', x1: col, y1: row, x2: col, y2: row + 1 },
        { dir: 'east', x1: col + 1, y1: row, x2: col + 1, y2: row + 1 },
      ];

      for (const edge of edges) {
        const val = getEdge(cell, edge.dir as Direction);
        if (!val) continue;

        // Skip invisible walls/doors — they shouldn't affect VTT line of sight
        if (val === 'iw' || val === 'id') continue;

        if (val === 'w' || val === 'win') {
          // Walls go to line_of_sight (hard blockers). Windows go to
          // objects_line_of_sight — see-through but still block LOS, which
          // VTTs render as a soft/low wall the user can tune.
          const key = `${Math.min(edge.x1, edge.x2)},${Math.min(edge.y1, edge.y2)}-${Math.max(edge.x1, edge.x2)},${Math.max(edge.y1, edge.y2)}-${edge.dir}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const seg = cellToPixelSegment(edge, gridSize, offsetX, offsetY, pixelsPerGrid);
          const segment: [{ x: number; y: number }, { x: number; y: number }] = [
            { x: seg.x1, y: seg.y1 },
            { x: seg.x2, y: seg.y2 },
          ];
          if (val === 'win') objectWalls.push(segment);
          else walls.push(segment);
        } else {
          // Door ('d' or 's'). Stage into the per-line map keyed by canonical
          // edge position so reciprocal edges dedupe; we merge runs below.
          const doorType = val as DoorType;
          if (edge.dir === 'north' || edge.dir === 'south') {
            const line = edge.dir === 'north' ? row : row + 1;
            let byStart = horizontalDoors.get(line);
            if (!byStart) {
              byStart = new Map();
              horizontalDoors.set(line, byStart);
            }
            if (!byStart.has(col)) byStart.set(col, doorType);
          } else {
            const line = edge.dir === 'west' ? col : col + 1;
            let byStart = verticalDoors.get(line);
            if (!byStart) {
              byStart = new Map();
              verticalDoors.set(line, byStart);
            }
            if (!byStart.has(row)) byStart.set(row, doorType);
          }
        }
      }
    }
  }

  mergeDoorRuns(horizontalDoors, 'horizontal', portals, gridSize, offsetX, offsetY, pixelsPerGrid);
  mergeDoorRuns(verticalDoors, 'vertical', portals, gridSize, offsetX, offsetY, pixelsPerGrid);

  // Chord-trim wall polylines — stored per-cell on `interiorEdges[0].vertices`
  // as fractional cell-local coords. Same extraction the lighting engine uses
  // (see lighting-geometry.ts#extractWallSegments) so VTT LOS matches the
  // rendered shape of rounded corners and chord cuts.
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (!cell) continue;
      const interiorEdge = getInteriorEdges(cell)[0];
      if (!interiorEdge || !isChordEdge(interiorEdge)) continue;
      const wall = interiorEdge.vertices;
      if (wall.length < 2) continue;
      for (let i = 0; i < wall.length - 1; i++) {
        const seg = cellToPixelSegment(
          {
            x1: col + wall[i]![0]!,
            y1: row + wall[i]![1]!,
            x2: col + wall[i + 1]![0]!,
            y2: row + wall[i + 1]![1]!,
            dir: 'trim',
          },
          gridSize,
          offsetX,
          offsetY,
          pixelsPerGrid,
        );
        walls.push([
          { x: seg.x1, y: seg.y1 },
          { x: seg.x2, y: seg.y2 },
        ]);
      }
    }
  }

  return { walls, objectWalls, portals };
}

/**
 * Merge contiguous same-type door edges along each edge line into single
 * portals. `byLine` maps line-coordinate → (start → door type).
 */
function mergeDoorRuns(
  byLine: Map<number, Map<number, 'd' | 's'>>,
  orientation: 'horizontal' | 'vertical',
  portals: Dd2vttPortal[],
  gridSize: number,
  offsetX: number,
  offsetY: number,
  pixelsPerGrid: number,
): void {
  for (const [line, byStart] of byLine) {
    const starts = [...byStart.keys()].sort((a, b) => a - b);
    let runStart: number | null = null;
    let runEnd: number | null = null;
    let runType: 'd' | 's' | null = null;

    const flush = () => {
      if (runStart === null) return;
      const edge =
        orientation === 'horizontal'
          ? { x1: runStart, y1: line, x2: runEnd! + 1, y2: line, dir: 'north' }
          : { x1: line, y1: runStart, x2: line, y2: runEnd! + 1, dir: 'west' };
      const seg = cellToPixelSegment(edge, gridSize, offsetX, offsetY, pixelsPerGrid);
      portals.push({
        position: { x: (seg.x1 + seg.x2) / 2, y: (seg.y1 + seg.y2) / 2 },
        bounds: [
          { x: seg.x1, y: seg.y1 },
          { x: seg.x2, y: seg.y2 },
        ],
        rotation: orientation === 'horizontal' ? 0 : 90,
        closed: true,
        freestanding: false,
      });
      runStart = null;
      runEnd = null;
      runType = null;
    };

    for (const start of starts) {
      const type = byStart.get(start)!;
      if (runStart === null) {
        runStart = start;
        runEnd = start;
        runType = type;
      } else if (start === runEnd! + 1 && type === runType) {
        runEnd = start;
      } else {
        flush();
        runStart = start;
        runEnd = start;
        runType = type;
      }
    }
    flush();
  }
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
function cellToPixelSegment(
  edge: { x1: number; y1: number; x2: number; y2: number; dir: string },
  gridSize: number,
  offsetX: number,
  offsetY: number,
  pixelsPerGrid: number,
): { x1: number; y1: number; x2: number; y2: number } {
  // Cell coords → world feet → canvas pixels → Foundry-grid units
  const toGridUnits = (cellVal: number, offset: number) => {
    const worldFeet = cellVal * gridSize;
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
function extractLights(
  metadata: Metadata | null,
  displayGridSize: number,
  offsetX: number,
  offsetY: number,
  pixelsPerGrid: number,
): Dd2vttLight[] {
  if (!metadata?.lights || !metadata.lightingEnabled) return [];

  return metadata.lights.map((light: Light) => {
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
      intensity: light.intensity,
      color: `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`,
      shadows: true,
    };
  });
}
