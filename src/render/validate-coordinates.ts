import type { DungeonBounds, CellGrid, Metadata } from '../types.js';

/** Room definition used by the legacy coordinate-based validator. */
export interface ValidatorRoom {
  id?: string;
  type?: string;
  walls?: number[][][];
  center?: [number, number, number];
  radiusSquares?: number;
  doors?: { coordinate: [number, number, number] }[];
  secretDoors?: { coordinate: [number, number, number] }[];
  traps?: { coordinate: [number, number, number] }[];
  features?: { coordinate?: [number, number, number] }[];
  [key: string]: unknown;
}

/**
 * Convert [x, y, z] coordinate to feet coordinates
 * @param {number} x - Grid square x position
 * @param {number} y - Grid square y position
 * @param {number} z - Sub-position (0-8)
 * @param {number} gridSize - Size of each grid square in feet
 * @returns {[number, number]} - [feetX, feetY]
 */
function coordinateToFeet(x: number, y: number, z: number, gridSize: number): [number, number] {
  // Base position (grid square origin)
  const feetX = x * gridSize;
  const feetY = y * gridSize;

  // Z-position offsets within the square
  const halfGrid = gridSize / 2;

  const zOffsets: Record<number, [number, number]> = {
    0: [0, 0], // TOP_LEFT
    1: [halfGrid, 0], // TOP_CENTER
    2: [gridSize, 0], // TOP_RIGHT
    3: [gridSize, halfGrid], // RIGHT_CENTER
    4: [gridSize, gridSize], // BOTTOM_RIGHT
    5: [halfGrid, gridSize], // BOTTOM_CENTER
    6: [0, gridSize], // BOTTOM_LEFT
    7: [0, halfGrid], // LEFT_CENTER
    8: [halfGrid, halfGrid], // CENTER
  };

  const [offsetX, offsetY] = zOffsets[z]!;

  return [feetX + offsetX, feetY + offsetY];
}

/**
 * Validate coordinate structure.
 * @param {Array} coord - Coordinate in [x, y, z] format
 * @param {string} context - Context for error message
 * @returns {void}
 * @throws {Error} If coordinate format is invalid
 */
function validateCoordinate(coord: [number, number, number], context: string): void {
  // coord is typed as [number, number, number] — always valid

  const [x, y, z] = coord;

  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`${context}: x and y must be integers, got ${JSON.stringify(coord)}`);
  }

  if (!Number.isInteger(z) || z < 0 || z > 8) {
    throw new Error(`${context}: z must be integer 0-8, got ${z}`);
  }
}

/**
 * Calculate bounding box for coordinate array
 * @param {Array} coordinates - Array of [x, y, z] coordinates
 * @param {number} gridSize - Grid size in feet
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
 */
function getCoordinateBounds(coordinates: number[][], gridSize: number): DungeonBounds {
  let minX = Infinity,
    minY = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity;

  for (const [x, y, z] of coordinates as [number, number, number][]) {
    const [feetX, feetY] = coordinateToFeet(x, y, z, gridSize);
    minX = Math.min(minX, feetX);
    minY = Math.min(minY, feetY);
    maxX = Math.max(maxX, feetX);
    maxY = Math.max(maxY, feetY);
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Validate coordinate-based configuration for grid alignment.
 * @param {Object} config - Dungeon config with rooms and gridSize
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
function validateGridAlignment(config: { metadata: Metadata; cells: CellGrid; rooms?: ValidatorRoom[] }): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.rooms) return { valid: true, errors: [] };

  // Validate all coordinates in rooms
  for (const room of config.rooms) {
    if (room.type === 'walls') {
      // Walls rooms: validate walls array
      if (!room.walls || !Array.isArray(room.walls)) {
        errors.push(`Room ${room.id}: walls room requires 'walls' array`);
        continue;
      }
      for (let i = 0; i < room.walls.length; i++) {
        const wallSegment = room.walls[i];
        if (!Array.isArray(wallSegment) || wallSegment.length < 2) {
          errors.push(`Room ${room.id} wall ${i}: each wall segment must be an array of at least 2 coordinates`);
          continue;
        }
        for (let j = 0; j < wallSegment.length; j++) {
          try {
            validateCoordinate(wallSegment[j] as [number, number, number], `Room ${room.id} wall ${i} point ${j}`);
          } catch (e) {
            errors.push((e as Error).message);
          }
        }
      }
    } else if (room.type === 'circular') {
      // Circular rooms: validate center and radiusSquares
      if (!room.center) {
        errors.push(`Room ${room.id}: circular room requires 'center' coordinate`);
        continue;
      }
      try {
        validateCoordinate(room.center, `Room ${room.id} center`);
      } catch (e) {
        errors.push((e as Error).message);
      }

      if (!Number.isInteger(room.radiusSquares) || !room.radiusSquares || room.radiusSquares < 1) {
        errors.push(`Room ${room.id}: radiusSquares must be positive integer, got ${room.radiusSquares}`);
      }
    } else {
      errors.push(`Room ${room.id}: unknown room type '${room.type}' (expected 'walls' or 'circular')`);
    }

    // Validate doors
    if (room.doors) {
      for (let i = 0; i < room.doors.length; i++) {
        const door = room.doors[i]!;
        try {
          validateCoordinate(door.coordinate, `Room ${room.id} door ${i}`);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
    }

    // Validate secret doors
    if (room.secretDoors) {
      for (let i = 0; i < room.secretDoors.length; i++) {
        const secretDoor = room.secretDoors[i]!;
        try {
          validateCoordinate(secretDoor.coordinate, `Room ${room.id} secretDoor ${i}`);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
    }

    // Validate traps
    if (room.traps) {
      for (let i = 0; i < room.traps.length; i++) {
        const trap = room.traps[i]!;
        try {
          validateCoordinate(trap.coordinate, `Room ${room.id} trap ${i}`);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
    }

    // Validate room features
    if (room.features) {
      for (let i = 0; i < room.features.length; i++) {
        const feature = room.features[i]!;
        if (feature.coordinate) {
          try {
            validateCoordinate(feature.coordinate, `Room ${room.id} feature ${i}`);
          } catch (e) {
            errors.push((e as Error).message);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('\n❌ Coordinate Validation Failed:\n');
    errors.forEach((e) => console.error(`   ${e}`));
    console.error('\nAll coordinates must be in [x, y, z] format with integer x, y and z in 0-8.');
    throw new Error('Coordinate validation failed');
  }

  console.log('✓ Coordinate validation passed');
  return { valid: true, errors: [] };
}

export { coordinateToFeet, validateCoordinate, getCoordinateBounds, validateGridAlignment };
