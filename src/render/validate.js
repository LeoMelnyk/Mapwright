import { floodFillRoom as sharedFloodFillRoom, parseCellKey } from '../util/index.js';

/**
 * Convert [x, y, z] coordinate to feet coordinates
 * @param {number} x - Grid square x position
 * @param {number} y - Grid square y position
 * @param {number} z - Sub-position (0-8)
 * @param {number} gridSize - Size of each grid square in feet
 * @returns {[number, number]} - [feetX, feetY]
 */
function coordinateToFeet(x, y, z, gridSize) {
  // Base position (grid square origin)
  const feetX = x * gridSize;
  const feetY = y * gridSize;

  // Z-position offsets within the square
  const halfGrid = gridSize / 2;

  const zOffsets = {
    0: [0, 0],                    // TOP_LEFT
    1: [halfGrid, 0],              // TOP_CENTER
    2: [gridSize, 0],              // TOP_RIGHT
    3: [gridSize, halfGrid],       // RIGHT_CENTER
    4: [gridSize, gridSize],       // BOTTOM_RIGHT
    5: [halfGrid, gridSize],       // BOTTOM_CENTER
    6: [0, gridSize],              // BOTTOM_LEFT
    7: [0, halfGrid],              // LEFT_CENTER
    8: [halfGrid, halfGrid]        // CENTER
  };

  const [offsetX, offsetY] = zOffsets[z] || [0, 0];

  return [feetX + offsetX, feetY + offsetY];
}

/**
 * Validate coordinate structure.
 * @param {Array} coord - Coordinate in [x, y, z] format
 * @param {string} context - Context for error message
 * @returns {void}
 * @throws {Error} If coordinate format is invalid
 */
function validateCoordinate(coord, context) {
  if (!Array.isArray(coord) || coord.length !== 3) {
    throw new Error(`${context}: Invalid coordinate format ${JSON.stringify(coord)} (expected [x, y, z])`);
  }

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
function getCoordinateBounds(coordinates, gridSize) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const [x, y, z] of coordinates) {
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
function validateGridAlignment(config) {
  const errors = [];

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
            validateCoordinate(wallSegment[j], `Room ${room.id} wall ${i} point ${j}`);
          } catch (e) {
            errors.push(e.message);
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
        errors.push(e.message);
      }

      if (!Number.isInteger(room.radiusSquares) || room.radiusSquares < 1) {
        errors.push(`Room ${room.id}: radiusSquares must be positive integer, got ${room.radiusSquares}`);
      }
    } else {
      errors.push(`Room ${room.id}: unknown room type '${room.type}' (expected 'walls' or 'circular')`);
    }

    // Validate doors
    if (room.doors) {
      for (let i = 0; i < room.doors.length; i++) {
        const door = room.doors[i];
        if (!door.coordinate) {
          errors.push(`Room ${room.id} door ${i}: missing 'coordinate' property`);
          continue;
        }
        try {
          validateCoordinate(door.coordinate, `Room ${room.id} door ${i}`);
        } catch (e) {
          errors.push(e.message);
        }
      }
    }

    // Validate secret doors
    if (room.secretDoors) {
      for (let i = 0; i < room.secretDoors.length; i++) {
        const secretDoor = room.secretDoors[i];
        if (!secretDoor.coordinate) {
          errors.push(`Room ${room.id} secretDoor ${i}: missing 'coordinate' property`);
          continue;
        }
        try {
          validateCoordinate(secretDoor.coordinate, `Room ${room.id} secretDoor ${i}`);
        } catch (e) {
          errors.push(e.message);
        }
      }
    }

    // Validate traps
    if (room.traps) {
      for (let i = 0; i < room.traps.length; i++) {
        const trap = room.traps[i];
        if (!trap.coordinate) {
          errors.push(`Room ${room.id} trap ${i}: missing 'coordinate' property`);
          continue;
        }
        try {
          validateCoordinate(trap.coordinate, `Room ${room.id} trap ${i}`);
        } catch (e) {
          errors.push(e.message);
        }
      }
    }

    // Validate room features
    if (room.features) {
      for (let i = 0; i < room.features.length; i++) {
        const feature = room.features[i];
        if (feature.coordinate) {
          try {
            validateCoordinate(feature.coordinate, `Room ${room.id} feature ${i}`);
          } catch (e) {
            errors.push(e.message);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('\n❌ Coordinate Validation Failed:\n');
    errors.forEach(e => console.error(`   ${e}`));
    console.error('\nAll coordinates must be in [x, y, z] format with integer x, y and z in 0-8.');
    throw new Error('Coordinate validation failed');
  }

  console.log('✓ Coordinate validation passed');
}

/**
 * Validate a single cell's structure and border types.
 * @param {Object|null} cell - Cell object to validate
 * @param {number} level - Level index
 * @param {number} row - Cell row
 * @param {number} col - Cell column
 * @param {string[]} errors - Array to push error messages into
 * @returns {void}
 */
function validateCell(cell, level, row, col, errors) {
  const cellId = level !== null ? `Level ${level}, Cell [${row}][${col}]` : `Cell [${row}][${col}]`;

  // null or undefined is valid (empty cell)
  if (cell === null || cell === undefined) {
    return;
  }

  // Cell must be an object
  if (typeof cell !== 'object') {
    errors.push(`${cellId}: must be an object or null, got ${typeof cell}`);
    return;
  }

  // Validate border properties
  const validBorders = ['north', 'east', 'south', 'west', 'nw-se', 'ne-sw'];
  const validBorderValues = ['w', 'd', 's'];

  for (const key in cell) {
    if (key === 'center') {
      // Validate center property
      if (typeof cell.center !== 'object' || cell.center === null) {
        errors.push(`${cellId}.center: must be an object, got ${typeof cell.center}`);
        continue;
      }

      if (cell.center.label !== undefined && typeof cell.center.label !== 'string') {
        errors.push(`${cellId}.center.label: must be a string, got ${typeof cell.center.label}`);
      }

      // Check if cell has diagonal borders - labels would be obscured (stairs are fine on diagonals)
      if ((cell['nw-se'] || cell['ne-sw']) && cell.center.label) {
        errors.push(`${cellId}: cannot have center label with diagonal borders (nw-se or ne-sw would obscure the label)`);
      }

      // Check if cell has both label and stairs - they overlap
      if (cell.center.label && (cell.center['stairs-up'] || cell.center['stairs-down'])) {
        errors.push(`${cellId}: cannot have both label and stairs in the same cell (they would overlap). Place stairs in an adjacent unlabeled cell.`);
      }

      // Unknown center properties are allowed for future extensibility (stairs-up, stairs-down, etc.)
    } else if (key === 'trimCorner') {
      // Compiler-generated metadata for diagonal trim rendering
      const validCorners = ['nw', 'ne', 'sw', 'se'];
      if (!validCorners.includes(cell[key])) {
        errors.push(`${cellId}.trimCorner: must be one of ${validCorners.join(', ')}, got '${cell[key]}'`);
      }
    } else if (key === 'trimRound' || key === 'trimArcCenterRow' || key === 'trimArcCenterCol' || key === 'trimArcRadius' || key === 'trimArcInverted') {
      // Compiler-generated metadata for rounded (arc) trim rendering
    } else if (validBorders.includes(key)) {
      // Validate border value
      if (!validBorderValues.includes(cell[key])) {
        errors.push(`${cellId}.${key}: must be 'w', 'd', or 's', got '${cell[key]}'`);
      }
    } else {
      errors.push(`${cellId}: unknown property '${key}' (valid: north, east, south, west, center, trimCorner)`);
    }
  }
}

/**
 * Validate matrix-based configuration structure and cell data.
 * @param {Object} config - Dungeon config with metadata and cells
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }} Validation result
 */
function validateMatrixFormat(config) {
  const errors = [];

  // 1. Check metadata exists with required fields
  if (!config.metadata) {
    errors.push('Missing required "metadata" object');
  } else {
    if (!config.metadata.dungeonName) {
      errors.push('metadata.dungeonName is required');
    }
    if (!config.metadata.gridSize || !Number.isInteger(config.metadata.gridSize) || config.metadata.gridSize < 1) {
      errors.push('metadata.gridSize must be a positive integer');
    }
  }

  // 2. Check cells is array of arrays
  if (!config.cells || !Array.isArray(config.cells)) {
    errors.push('Missing required "cells" array');
    if (errors.length > 0) {
      reportValidationErrors(errors, 'Matrix Format Validation Failed');
    }
    return; // Can't continue without cells array
  }

  if (config.cells.length === 0) {
    errors.push('cells array must have at least 1 row');
  }

  // Detect if multi-level format (3D array) early
  const isMultiLevel = config.metadata.levels > 1 &&
                       Array.isArray(config.cells[0]) &&
                       Array.isArray(config.cells[0][0]);

  // Validate cell structure based on format
  if (isMultiLevel) {
    // Multi-level: validate each level
    const numLevels = config.cells.length;

    if (numLevels !== config.metadata.levels) {
      errors.push(`metadata.levels is ${config.metadata.levels} but cells array has ${numLevels} levels`);
    }

    for (let level = 0; level < numLevels; level++) {
      const levelCells = config.cells[level];

      if (!Array.isArray(levelCells)) {
        errors.push(`Level ${level}: must be an array`);
        continue;
      }

      if (levelCells.length === 0) {
        errors.push(`Level ${level}: must have at least 1 row`);
        continue;
      }

      // Validate this level's cells
      const numCols = levelCells[0]?.length || 0;
      for (let row = 0; row < levelCells.length; row++) {
        if (!Array.isArray(levelCells[row])) {
          errors.push(`Level ${level}, Row ${row}: must be an array`);
          continue;
        }
        if (levelCells[row].length !== numCols) {
          errors.push(`Level ${level}, Row ${row}: has ${levelCells[row].length} columns, expected ${numCols} (all rows must have same length)`);
        }

        // Validate each cell in this level
        for (let col = 0; col < levelCells[row].length; col++) {
          const cell = levelCells[row][col];
          validateCell(cell, level, row, col, errors);
        }
      }
    }
  } else {
    // Single-level: validate as 2D array
    const numCols = config.cells[0]?.length || 0;
    for (let row = 0; row < config.cells.length; row++) {
      if (!Array.isArray(config.cells[row])) {
        errors.push(`Row ${row}: must be an array`);
        continue;
      }
      if (config.cells[row].length !== numCols) {
        errors.push(`Row ${row}: has ${config.cells[row].length} columns, expected ${numCols} (all rows must have same length)`);
      }

      // Validate each cell
      for (let col = 0; col < config.cells[row].length; col++) {
        const cell = config.cells[row][col];
        validateCell(cell, null, row, col, errors);
      }
    }
  }

  // 5. Detect border collisions
  const collisionErrors = detectBorderCollisions(config.cells);
  errors.push(...collisionErrors);

  // 6. Validate null adjacency (walls required between null and non-null cells)
  const nullAdjacencyErrors = validateNullAdjacency(config.cells, isMultiLevel);
  errors.push(...nullAdjacencyErrors);

  // 6.25. Validate door adjacency (doors/secret doors can't lead into null cells)
  const doorAdjacencyErrors = validateDoorAdjacency(config.cells, isMultiLevel);
  errors.push(...doorAdjacencyErrors);

  // 6.5. Validate room labels (each room has at most one label)
  const roomLabelErrors = validateRoomLabels(config.cells, isMultiLevel);
  errors.push(...roomLabelErrors);

  // 7. Detect inaccessible rooms
  const inaccessibilityErrors = detectInaccessibleRooms(config.cells, isMultiLevel);
  errors.push(...inaccessibilityErrors);

  // 8. Validate stair connections (if multi-level)
  if (isMultiLevel || hasStairFeatures(config.cells)) {
    const stairErrors = validateStairConnections(config.cells, isMultiLevel);
    errors.push(...stairErrors);
  }

  if (errors.length > 0) {
    reportValidationErrors(errors, 'Matrix Format Validation Failed');
  }

  console.log('✓ Matrix format validation passed');
}

/**
 * Detect border collisions between adjacent cells
 */
function detectBorderCollisions(cells) {
  const errors = [];
  const numRows = cells.length;

  for (let row = 0; row < numRows; row++) {
    const numCols = cells[row].length;

    for (let col = 0; col < numCols; col++) {
      const cell = cells[row][col];
      if (!cell) continue;

      // Check east border collision (with cell to the right)
      if (col < numCols - 1 && cell.east) {
        const rightCell = cells[row][col + 1];
        if (rightCell?.west && cell.east !== rightCell.west) {
          errors.push(
            `Border collision detected:\n` +
            `  Cell [${row}][${col}] has east: "${cell.east}" but\n` +
            `  Cell [${row}][${col + 1}] has west: "${rightCell.west}"\n` +
            `  → Conflict: ${getBorderName(cell.east)} vs ${getBorderName(rightCell.west)}`
          );
        }
      }

      // Check south border collision (with cell below)
      if (row < numRows - 1 && cell.south) {
        const belowCell = cells[row + 1][col];
        if (belowCell?.north && cell.south !== belowCell.north) {
          errors.push(
            `Border collision detected:\n` +
            `  Cell [${row}][${col}] has south: "${cell.south}" but\n` +
            `  Cell [${row + 1}][${col}] has north: "${belowCell.north}"\n` +
            `  → Conflict: ${getBorderName(cell.south)} vs ${getBorderName(belowCell.north)}`
          );
        }
      }

      // Check nw-se diagonal collision (with cell diagonally below-right)
      if (row < numRows - 1 && col < numCols - 1 && cell['nw-se']) {
        const diagCell = cells[row + 1][col + 1];
        if (diagCell?.['nw-se'] && cell['nw-se'] !== diagCell['nw-se']) {
          errors.push(
            `Diagonal border collision detected:\n` +
            `  Cell [${row}][${col}] has nw-se: "${cell['nw-se']}" but\n` +
            `  Cell [${row + 1}][${col + 1}] has nw-se: "${diagCell['nw-se']}"\n` +
            `  → Conflict: ${getBorderName(cell['nw-se'])} vs ${getBorderName(diagCell['nw-se'])}`
          );
        }
      }

      // Check ne-sw diagonal collision (with cell diagonally below-left)
      if (row < numRows - 1 && col > 0 && cell['ne-sw']) {
        const diagCell = cells[row + 1][col - 1];
        if (diagCell?.['ne-sw'] && cell['ne-sw'] !== diagCell['ne-sw']) {
          errors.push(
            `Diagonal border collision detected:\n` +
            `  Cell [${row}][${col}] has ne-sw: "${cell['ne-sw']}" but\n` +
            `  Cell [${row + 1}][${col - 1}] has ne-sw: "${diagCell['ne-sw']}"\n` +
            `  → Conflict: ${getBorderName(cell['ne-sw'])} vs ${getBorderName(diagCell['ne-sw'])}`
          );
        }
      }
    }
  }

  return errors;
}

/**
 * Flood fill a single room region using the shared diagonal-aware BFS,
 * then collect all labels found within the filled cells.
 */
function floodFillRoomLabels(cells, startLevel, startRow, startCol, visited, isMultiLevel) {
  const levelCells = isMultiLevel ? cells[startLevel] : cells;
  const cellKeys = sharedFloodFillRoom(levelCells, startRow, startCol);

  const labels = [];
  for (const key of cellKeys) {
    const [r, c] = parseCellKey(key);
    visited[startLevel][r][c] = true;
    const cell = levelCells[r]?.[c];
    if (cell?.center?.label) {
      labels.push({ label: cell.center.label, row: r, col: c, level: startLevel });
    }
  }
  return labels;
}

/**
 * Validate that no duplicate labels exist across the dungeon
 */
function validateRoomLabels(cells, isMultiLevel = false) {
  const errors = [];
  const numLevels = isMultiLevel ? cells.length : 1;

  const visited = [];
  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? cells[level] : cells;
    const numRows = levelCells.length;
    const numCols = levelCells[0]?.length || 0;
    visited[level] = Array.from({length: numRows}, () => Array(numCols).fill(false));
  }

  const allLabels = new Map();

  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? cells[level] : cells;
    const numRows = levelCells.length;
    const numCols = levelCells[0]?.length || 0;

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row][col];

        if (!cell) continue;
        if (visited[level][row][col]) continue;

        const labelsInRoom = floodFillRoomLabels(cells, level, row, col, visited, isMultiLevel);

        for (const l of labelsInRoom) {
          const pos = isMultiLevel
            ? `Level ${l.level}, [${l.row}][${l.col}]`
            : `[${l.row}][${l.col}]`;
          if (allLabels.has(l.label)) {
            errors.push(
              `Duplicate label "${l.label}" found at ${pos} ` +
              `and ${allLabels.get(l.label)}\n` +
              `  → Each label must be unique across the dungeon`
            );
          } else {
            allLabels.set(l.label, pos);
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Validate that walls exist between null and non-null cells
 */
function validateNullAdjacency(cells, isMultiLevel = false) {
  const errors = [];
  const numLevels = isMultiLevel ? cells.length : 1;

  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? cells[level] : cells;
    const numRows = levelCells.length;

    for (let row = 0; row < numRows; row++) {
      const numCols = levelCells[row].length;

      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row][col];

        if (!cell) continue;

        const levelPrefix = isMultiLevel ? `Level ${level}, ` : '';

        const hasDiag = cell['ne-sw'] || cell['nw-se'];
        const diagCovers = new Set();
        if (hasDiag) {
          if (cell['ne-sw']) { diagCovers.add('north'); diagCovers.add('west'); diagCovers.add('south'); diagCovers.add('east'); }
          if (cell['nw-se']) { diagCovers.add('north'); diagCovers.add('east'); diagCovers.add('south'); diagCovers.add('west'); }
        }

        // Check north adjacency
        if (row > 0) {
          const northCell = levelCells[row - 1][col];
          if (northCell === null || northCell === undefined) {
            if (cell.north !== 'w' && !diagCovers.has('north')) {
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] is adjacent to null cell to the north but has no wall.\n` +
                `  → Current north border: ${cell.north || '(none)'}\n` +
                `  → Required: north: "w"`
              );
            }
          }
        }

        // Check south adjacency
        if (row < numRows - 1) {
          const southCell = levelCells[row + 1][col];
          if (southCell === null || southCell === undefined) {
            if (cell.south !== 'w' && !diagCovers.has('south')) {
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] is adjacent to null cell to the south but has no wall.\n` +
                `  → Current south border: ${cell.south || '(none)'}\n` +
                `  → Required: south: "w"`
              );
            }
          }
        }

        // Check east adjacency
        if (col < numCols - 1) {
          const eastCell = levelCells[row][col + 1];
          if (eastCell === null || eastCell === undefined) {
            if (cell.east !== 'w' && !diagCovers.has('east')) {
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] is adjacent to null cell to the east but has no wall.\n` +
                `  → Current east border: ${cell.east || '(none)'}\n` +
                `  → Required: east: "w"`
              );
            }
          }
        }

        // Check west adjacency
        if (col > 0) {
          const westCell = levelCells[row][col - 1];
          if (westCell === null || westCell === undefined) {
            if (cell.west !== 'w' && !diagCovers.has('west')) {
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] is adjacent to null cell to the west but has no wall.\n` +
                `  → Current west border: ${cell.west || '(none)'}\n` +
                `  → Required: west: "w"`
              );
            }
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Validate that doors and secret doors don't lead into null/void cells
 */
function validateDoorAdjacency(cells, isMultiLevel = false) {
  const errors = [];
  const numLevels = isMultiLevel ? cells.length : 1;

  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? cells[level] : cells;
    const numRows = levelCells.length;

    for (let row = 0; row < numRows; row++) {
      const numCols = levelCells[row].length;

      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row][col];

        if (!cell) continue;

        const levelPrefix = isMultiLevel ? `Level ${level}, ` : '';

        const checkDoor = (dir, adjRow, adjCol) => {
          if (cell[dir] === 'd' || cell[dir] === 's') {
            const adjCell = levelCells[adjRow]?.[adjCol];
            if (adjCell === null || adjCell === undefined) {
              const doorType = cell[dir] === 's' ? 'secret door' : 'door';
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] has a ${doorType} to the ${dir} leading into null/void space.\n` +
                `  → Current ${dir} border: "${cell[dir]}"\n` +
                `  → ${doorType.charAt(0).toUpperCase() + doorType.slice(1)}s cannot lead into null cells\n` +
                `  → Either remove the ${doorType} or add a valid cell to the ${dir}`
              );
            }
          }
        };

        if (row > 0) checkDoor('north', row - 1, col);
        if (row < numRows - 1) checkDoor('south', row + 1, col);
        if (col < levelCells[row].length - 1) checkDoor('east', row, col + 1);
        if (col > 0) checkDoor('west', row, col - 1);
      }
    }
  }

  return errors;
}

/**
 * Parse room label into components
 */
function parseRoomLabel(label) {
  const match = label.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  return {
    letter: match[1],
    number: parseInt(match[2], 10),
    original: label
  };
}

/**
 * Compare room labels for sorting (alphanumeric)
 */
function compareRoomLabels(labelA, labelB) {
  if (labelA.letter !== labelB.letter) {
    return labelA.letter.localeCompare(labelB.letter);
  }
  return labelA.number - labelB.number;
}

/**
 * Check if we can traverse from one cell to another
 */
function canTraverse(fromCell, toCell, direction) {
  const borderMap = {
    'north': {current: 'north', adjacent: 'south'},
    'south': {current: 'south', adjacent: 'north'},
    'east': {current: 'east', adjacent: 'west'},
    'west': {current: 'west', adjacent: 'east'}
  };

  const {current, adjacent} = borderMap[direction];

  const fromBorder = fromCell?.[current];
  if (fromBorder === 'w') return false;

  const toBorder = toCell?.[adjacent];
  if (toBorder === 'w') return false;

  return true;
}

/**
 * BFS to find all reachable rooms from starting position
 */
function bfsReachableRooms(cells, startLevel, startRow, startCol, isMultiLevel) {
  const numLevels = isMultiLevel ? cells.length : 1;

  const visited = [];
  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? cells[level] : cells;
    const numRows = levelCells.length;
    const numCols = levelCells[0]?.length || 0;
    visited[level] = Array.from({length: numRows}, () => Array(numCols).fill(false));
  }

  const reachedRooms = new Set();
  const queue = [{level: startLevel, row: startRow, col: startCol}];

  visited[startLevel][startRow][startCol] = true;
  const startLevelCells = isMultiLevel ? cells[startLevel] : cells;
  const startCell = startLevelCells[startRow][startCol];
  if (startCell?.center?.label) {
    reachedRooms.add(startCell.center.label);
  }

  while (queue.length > 0) {
    const {level, row, col} = queue.shift();
    const levelCells = isMultiLevel ? cells[level] : cells;
    const cell = levelCells[row][col];

    // 1. Try horizontal movement (4 cardinal directions)
    const directions = [
      {dir: 'north', dRow: -1, dCol: 0},
      {dir: 'south', dRow: 1, dCol: 0},
      {dir: 'east', dRow: 0, dCol: 1},
      {dir: 'west', dRow: 0, dCol: -1}
    ];

    for (const {dir, dRow, dCol} of directions) {
      const newRow = row + dRow;
      const newCol = col + dCol;
      const numRows = levelCells.length;
      const numCols = levelCells[0]?.length || 0;

      if (newRow < 0 || newRow >= numRows || newCol < 0 || newCol >= numCols) {
        continue;
      }

      if (visited[level][newRow][newCol]) {
        continue;
      }

      const nextCell = levelCells[newRow][newCol];
      if (canTraverse(cell, nextCell, dir)) {
        visited[level][newRow][newCol] = true;
        queue.push({level, row: newRow, col: newCol});

        if (nextCell?.center?.label) {
          reachedRooms.add(nextCell.center.label);
        }
      }
    }

    // 2. Try vertical movement (stairs)
    if (cell?.center) {
      // Check stairs-up (skip non-array markers — visual-only from .map compiler)
      if (Array.isArray(cell.center['stairs-up'])) {
        const stairTarget = cell.center['stairs-up'];
        let targetLevel, targetRow, targetCol;

        if (stairTarget.length === 3) {
          [targetLevel, targetRow, targetCol] = stairTarget;
        } else {
          targetLevel = level;
          [targetRow, targetCol] = stairTarget;
        }

        if (!visited[targetLevel][targetRow][targetCol]) {
          visited[targetLevel][targetRow][targetCol] = true;
          queue.push({level: targetLevel, row: targetRow, col: targetCol});

          const targetLevelCells = isMultiLevel ? cells[targetLevel] : cells;
          const targetCell = targetLevelCells[targetRow][targetCol];
          if (targetCell?.center?.label) {
            reachedRooms.add(targetCell.center.label);
          }
        }
      }

      // Check stairs-down (skip non-array markers — visual-only from .map compiler)
      if (Array.isArray(cell.center['stairs-down'])) {
        const stairTarget = cell.center['stairs-down'];
        let targetLevel, targetRow, targetCol;

        if (stairTarget.length === 3) {
          [targetLevel, targetRow, targetCol] = stairTarget;
        } else {
          targetLevel = level;
          [targetRow, targetCol] = stairTarget;
        }

        if (!visited[targetLevel][targetRow][targetCol]) {
          visited[targetLevel][targetRow][targetCol] = true;
          queue.push({level: targetLevel, row: targetRow, col: targetCol});

          const targetLevelCells = isMultiLevel ? cells[targetLevel] : cells;
          const targetCell = targetLevelCells[targetRow][targetCol];
          if (targetCell?.center?.label) {
            reachedRooms.add(targetCell.center.label);
          }
        }
      }
    }
  }

  return reachedRooms;
}

/**
 * Detect rooms that are inaccessible from the starting room
 */
function detectInaccessibleRooms(cells, isMultiLevel = false) {
  const numLevels = isMultiLevel ? cells.length : 1;
  const errors = [];

  const roomPositions = new Map();

  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? cells[level] : cells;
    const numRows = levelCells.length;
    const numCols = levelCells[0]?.length || 0;

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row][col];
        if (cell?.center?.label) {
          if (!roomPositions.has(cell.center.label)) {
            roomPositions.set(cell.center.label, []);
          }
          roomPositions.get(cell.center.label).push({level, row, col});
        }
      }
    }
  }

  if (roomPositions.size === 0) return [];
  if (roomPositions.size === 1) return [];

  const roomLabels = Array.from(roomPositions.keys());
  const parsedLabels = roomLabels
    .map(label => parseRoomLabel(label))
    .filter(parsed => parsed !== null);

  if (parsedLabels.length === 0) {
    return ['No valid room labels found (expected format: A1, B12, etc.)'];
  }

  parsedLabels.sort(compareRoomLabels);
  const startingLabel = parsedLabels[0].original;
  const startingPositions = roomPositions.get(startingLabel);
  const startPos = startingPositions[0];

  const reachedRooms = bfsReachableRooms(
    cells,
    startPos.level,
    startPos.row,
    startPos.col,
    isMultiLevel
  );

  const unreachableRooms = [];
  for (const [label, positions] of roomPositions) {
    if (!reachedRooms.has(label)) {
      const pos = positions[0];
      unreachableRooms.push({
        label,
        position: isMultiLevel
          ? `Level ${pos.level}, Cell [${pos.row}][${pos.col}]`
          : `[${pos.row}][${pos.col}]`
      });
    }
  }

  if (unreachableRooms.length > 0) {
    errors.push(`\nInaccessible rooms detected (cannot be reached from starting room ${startingLabel}):\n`);

    for (const room of unreachableRooms) {
      errors.push(`  Room ${room.label} at ${room.position} - No path from ${startingLabel}`);
    }

    const hint = isMultiLevel
      ? `\n  Hint: Add doors, stairs, or remove walls to connect these rooms to the main dungeon.`
      : `\n  Hint: Add doors or remove walls to connect these rooms to the main dungeon.`;
    errors.push(hint);
  }

  return errors;
}

/**
 * Check if any cells have stair features
 */
function hasStairFeatures(cells) {
  const isMultiLevel = Array.isArray(cells[0]) && Array.isArray(cells[0][0]);
  const numLevels = isMultiLevel ? cells.length : 1;

  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? cells[level] : cells;
    const numRows = levelCells.length;

    for (let row = 0; row < numRows; row++) {
      const numCols = levelCells[row].length;

      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row][col];
        if (cell?.center?.['stairs-up'] || cell?.center?.['stairs-down']) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Validate a single stair connection
 */
function validateSingleStair(cells, isMultiLevel, fromLevel, fromRow, fromCol, stairType, reciprocalType, target) {
  const errors = [];

  let targetLevel, targetRow, targetCol;
  if (target.length === 3) {
    [targetLevel, targetRow, targetCol] = target;
  } else if (target.length === 2) {
    targetLevel = fromLevel;
    [targetRow, targetCol] = target;
  } else {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
      `${stairType} must be [level, row, col] or [row, col], got ${JSON.stringify(target)}`
    );
    return errors;
  }

  const numLevels = isMultiLevel ? cells.length : 1;
  if (targetLevel < 0 || targetLevel >= numLevels) {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
      `${stairType} points to level ${targetLevel}, but only ${numLevels} level(s) exist`
    );
    return errors;
  }

  const targetLevelCells = isMultiLevel ? cells[targetLevel] : cells;
  const numRows = targetLevelCells.length;
  const numCols = targetLevelCells[0]?.length || 0;

  if (targetRow < 0 || targetRow >= numRows) {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
      `${stairType} points to row ${targetRow}, but level ${targetLevel} only has ${numRows} rows`
    );
    return errors;
  }

  if (targetCol < 0 || targetCol >= numCols) {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
      `${stairType} points to col ${targetCol}, but level ${targetLevel} only has ${numCols} cols`
    );
    return errors;
  }

  const targetCell = targetLevelCells[targetRow][targetCol];
  if (!targetCell) {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
      `${stairType} points to Level ${targetLevel}, Cell [${targetRow}][${targetCol}], ` +
      `but that cell is null/empty`
    );
    return errors;
  }

  if (!targetCell.center?.[reciprocalType]) {
    errors.push(
      `Stair connection broken:\n` +
      `  Level ${fromLevel}, Cell [${fromRow}][${fromCol}] has ${stairType} pointing to ` +
      `[${targetLevel}, ${targetRow}, ${targetCol}]\n` +
      `  But Level ${targetLevel}, Cell [${targetRow}][${targetCol}] has no ${reciprocalType}\n` +
      `  → Add "${reciprocalType}": [${fromLevel}, ${fromRow}, ${fromCol}] to the target cell`
    );
    return errors;
  }

  const reciprocal = targetCell.center[reciprocalType];
  let recipLevel, recipRow, recipCol;
  if (reciprocal.length === 3) {
    [recipLevel, recipRow, recipCol] = reciprocal;
  } else {
    recipLevel = targetLevel;
    [recipRow, recipCol] = reciprocal;
  }

  if (recipLevel !== fromLevel || recipRow !== fromRow || recipCol !== fromCol) {
    errors.push(
      `Stair connection mismatch:\n` +
      `  Level ${fromLevel}, Cell [${fromRow}][${fromCol}] has ${stairType} pointing to ` +
      `[${targetLevel}, ${targetRow}, ${targetCol}]\n` +
      `  But Level ${targetLevel}, Cell [${targetRow}][${targetCol}] has ${reciprocalType} ` +
      `pointing to [${recipLevel}, ${recipRow}, ${recipCol}]\n` +
      `  → Expected [${fromLevel}, ${fromRow}, ${fromCol}]`
    );
  }

  return errors;
}

/**
 * Validate stair connections across all levels
 */
function validateStairConnections(cells, isMultiLevel) {
  const errors = [];
  const numLevels = isMultiLevel ? cells.length : 1;

  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? cells[level] : cells;
    const numRows = levelCells.length;

    for (let row = 0; row < numRows; row++) {
      const numCols = levelCells[row].length;

      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row][col];
        if (!cell?.center) continue;

        if (Array.isArray(cell.center['stairs-up'])) {
          errors.push(...validateSingleStair(
            cells, isMultiLevel, level, row, col,
            'stairs-up', 'stairs-down', cell.center['stairs-up']
          ));
        }

        if (Array.isArray(cell.center['stairs-down'])) {
          errors.push(...validateSingleStair(
            cells, isMultiLevel, level, row, col,
            'stairs-down', 'stairs-up', cell.center['stairs-down']
          ));
        }
      }
    }
  }

  return errors;
}

/**
 * Get human-readable name for border value
 */
function getBorderName(value) {
  const names = {
    'w': 'wall',
    'd': 'door',
    's': 'secret door'
  };
  return names[value] || value;
}

/**
 * Report validation errors and throw
 */
function reportValidationErrors(errors, title) {
  console.error(`\n❌ ${title}:\n`);
  errors.forEach(e => console.error(`   ${e}`));
  console.error('');
  throw new Error('Validation failed');
}

/**
 * Validate dungeon configuration (legacy coordinate-based).
 * @param {Object} config - Dungeon config to validate
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
function validateConfig(config) {
  if (!config.dungeonName) throw new Error('Missing required field: dungeonName');
  if (!config.gridSize) throw new Error('Missing required field: gridSize');
  if (!config.rooms || config.rooms.length === 0) throw new Error('No rooms defined');

  const ids = new Set();
  for (const room of config.rooms) {
    if (!room.id) throw new Error(`Room missing ID: ${JSON.stringify(room)}`);
    if (ids.has(room.id)) throw new Error(`Duplicate room ID: ${room.id}`);
    ids.add(room.id);
  }
}

export {
  coordinateToFeet,
  validateCoordinate,
  getCoordinateBounds,
  validateGridAlignment,
  validateCell,
  validateMatrixFormat,
  validateConfig
};
