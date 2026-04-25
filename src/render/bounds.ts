import type { CellGrid, DungeonBounds } from '../types.js';
import { coordinateToFeet, getCoordinateBounds } from './validate.js';
import { toCanvas } from '../util/index.js';

/**
 * Calculate bounds from matrix-based cells.
 * @param {CellGrid} cells - 2D grid of cell objects
 * @param {number} gridSize - Grid cell size in feet
 * @returns {DungeonBounds} Bounding box in feet
 */
function calculateBoundsFromCells(cells: CellGrid, gridSize: number): DungeonBounds {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  return {
    minX: 0,
    minY: 0,
    maxX: numCols * gridSize,
    maxY: numRows * gridSize,
  };
}

interface LegacyRoom {
  type: string;
  walls?: (number[][] | { from: [number, number]; to: [number, number]; controlPoints?: [number, number][] })[];
  coordinates?: [number, number, number][];
  center?: [number, number] | [number, number, number];
  radiusSquares?: number;
  topLeft?: [number, number];
  width?: number;
  height?: number;
  controlPoints?: [number, number][];
  id?: string | number;
}

interface LegacyConfig {
  gridSize: number;
  rooms: LegacyRoom[];
}

/**
 * Calculate bounds (legacy coordinate-based system).
 * @param {LegacyConfig} config - Dungeon config with rooms and gridSize
 * @returns {DungeonBounds} Bounding box in feet
 */
function calculateBounds(config: LegacyConfig): DungeonBounds {
  let minX = Infinity,
    minY = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity;

  const gridSize = config.gridSize;

  for (const room of config.rooms) {
    if (room.type === 'walls') {
      const coords: [number, number][] = [];
      for (const wallSegment of room.walls! as number[][][]) {
        coords.push(...(wallSegment as [number, number][]));
      }
      const bounds = getCoordinateBounds(coords, gridSize);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    } else if (room.type === 'grid') {
      const bounds = getCoordinateBounds(room.coordinates!, gridSize);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    } else if (room.type === 'circular') {
      const center3 = room.center as [number, number, number];
      const [centerX, centerY] = coordinateToFeet(center3[0], center3[1], center3[2], gridSize);
      const radius = room.radiusSquares! * gridSize;
      minX = Math.min(minX, centerX - radius);
      minY = Math.min(minY, centerY - radius);
      maxX = Math.max(maxX, centerX + radius);
      maxY = Math.max(maxY, centerY + radius);
    } else if (room.type === 'custom') {
      const coords: [number, number][] = [];
      for (const wall of room.walls! as {
        from: [number, number];
        to: [number, number];
        controlPoints?: [number, number][];
      }[]) {
        coords.push(wall.from);
        coords.push(wall.to);
        if (wall.controlPoints) {
          coords.push(...wall.controlPoints);
        }
      }
      const bounds = getCoordinateBounds(coords, gridSize);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    } else if (room.type === 'rectangular') {
      const [x, y] = room.topLeft!;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + room.width!);
      maxY = Math.max(maxY, y + room.height!);
    } else if (room.type === 'cave') {
      const [cx, cy] = room.center!;
      const hw = room.width! / 2;
      const hh = room.height! / 2;
      minX = Math.min(minX, cx - hw);
      minY = Math.min(minY, cy - hh);
      maxX = Math.max(maxX, cx + hw);
      maxY = Math.max(maxY, cy + hh);
    }
  }

  const padding = 5;
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

export { calculateBoundsFromCells, calculateBounds, toCanvas };
