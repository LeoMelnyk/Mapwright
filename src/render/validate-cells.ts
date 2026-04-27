import { asMultiLevel, type CardinalDirection, type Cell, type CellGrid, type EdgeValue } from '../types.js';
import { getEdge } from '../util/index.js';

/**
 * Validate a single cell's structure and border types.
 * @param {Object|null} cell - Cell object to validate
 * @param {number} level - Level index
 * @param {number} row - Cell row
 * @param {number} col - Cell column
 * @param {string[]} errors - Array to push error messages into
 * @returns {void}
 */
function validateCell(cell: Cell | null, level: number | null, row: number, col: number, errors: string[]): void {
  const cellId = level !== null ? `Level ${level}, Cell [${row}][${col}]` : `Cell [${row}][${col}]`;

  // null or undefined is valid (empty cell)
  if (cell === null) {
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
      if (typeof cell.center !== 'object') {
        errors.push(`${cellId}.center: must be an object, got ${typeof cell.center}`);
        continue;
      }

      if (cell.center.label !== undefined && typeof cell.center.label !== 'string') {
        errors.push(`${cellId}.center.label: must be a string, got ${typeof cell.center.label}`);
      }

      // Check if cell has diagonal borders - labels would be obscured (stairs are fine on diagonals)
      if ((getEdge(cell, 'nw-se') || getEdge(cell, 'ne-sw')) && cell.center.label) {
        errors.push(
          `${cellId}: cannot have center label with diagonal borders (nw-se or ne-sw would obscure the label)`,
        );
      }

      // Check if cell has both label and stairs - they overlap
      if (cell.center.label && (cell.center['stairs-up'] || cell.center['stairs-down'])) {
        errors.push(
          `${cellId}: cannot have both label and stairs in the same cell (they would overlap). Place stairs in an adjacent unlabeled cell.`,
        );
      }

      // Unknown center properties are allowed for future extensibility (stairs-up, stairs-down, etc.)
    } else if (key === 'trimCorner') {
      // Compiler-generated metadata for diagonal trim rendering
      const validCorners = ['nw', 'ne', 'sw', 'se'];
      // Validated dynamic property access — key is checked against known properties above
      if (!validCorners.includes((cell as Record<string, unknown>)[key] as string)) {
        errors.push(
          `${cellId}.trimCorner: must be one of ${validCorners.join(', ')}, got '${(cell as Record<string, unknown>)[key]}'`,
        );
      }
    } else if (
      key === 'trimRound' ||
      key === 'trimArcCenterRow' ||
      key === 'trimArcCenterCol' ||
      key === 'trimArcRadius' ||
      key === 'trimArcInverted'
    ) {
      // Compiler-generated metadata for rounded (arc) trim rendering
    } else if (validBorders.includes(key)) {
      // Validate border value
      // Validated dynamic property access — key is checked against validBorders above
      if (!validBorderValues.includes((cell as Record<string, unknown>)[key] as string)) {
        errors.push(`${cellId}.${key}: must be 'w', 'd', or 's', got '${(cell as Record<string, unknown>)[key]}'`);
      }
    } else {
      errors.push(`${cellId}: unknown property '${key}' (valid: north, east, south, west, center, trimCorner)`);
    }
  }
}

/**
 * Validate that walls exist between null and non-null cells
 */
function validateNullAdjacency(cells: CellGrid, isMultiLevel = false) {
  const errors = [];
  const numLevels = isMultiLevel ? cells.length : 1;

  for (let level = 0; level < numLevels; level++) {
    const levelCells = (isMultiLevel ? asMultiLevel(cells)[level] : cells)!;
    const numRows = levelCells.length;

    for (let row = 0; row < numRows; row++) {
      const numCols = levelCells[row]?.length ?? 0;

      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row]![col];

        if (!cell) continue;

        const levelPrefix = isMultiLevel ? `Level ${level}, ` : '';

        const neSw = getEdge(cell, 'ne-sw');
        const nwSe = getEdge(cell, 'nw-se');
        const diagCovers = new Set<string>();
        if (neSw) {
          diagCovers.add('north');
          diagCovers.add('west');
          diagCovers.add('south');
          diagCovers.add('east');
        }
        if (nwSe) {
          diagCovers.add('north');
          diagCovers.add('east');
          diagCovers.add('south');
          diagCovers.add('west');
        }

        // Check north adjacency
        if (row > 0) {
          const northCell = levelCells[row - 1]![col];
          if (northCell === null) {
            if (cell.north !== 'w' && !diagCovers.has('north')) {
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] is adjacent to null cell to the north but has no wall.\n` +
                  `  → Current north border: ${cell.north ?? '(none)'}\n` +
                  `  → Required: north: "w"`,
              );
            }
          }
        }

        // Check south adjacency
        if (row < numRows - 1) {
          const southCell = levelCells[row + 1]![col];
          if (southCell === null) {
            if (cell.south !== 'w' && !diagCovers.has('south')) {
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] is adjacent to null cell to the south but has no wall.\n` +
                  `  → Current south border: ${cell.south ?? '(none)'}\n` +
                  `  → Required: south: "w"`,
              );
            }
          }
        }

        // Check east adjacency
        if (col < numCols - 1) {
          const eastCell = levelCells[row]![col + 1];
          if (eastCell === null) {
            if (cell.east !== 'w' && !diagCovers.has('east')) {
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] is adjacent to null cell to the east but has no wall.\n` +
                  `  → Current east border: ${cell.east ?? '(none)'}\n` +
                  `  → Required: east: "w"`,
              );
            }
          }
        }

        // Check west adjacency
        if (col > 0) {
          const westCell = levelCells[row]![col - 1];
          if (westCell === null) {
            if (cell.west !== 'w' && !diagCovers.has('west')) {
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] is adjacent to null cell to the west but has no wall.\n` +
                  `  → Current west border: ${cell.west ?? '(none)'}\n` +
                  `  → Required: west: "w"`,
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
function validateDoorAdjacency(cells: CellGrid, isMultiLevel = false) {
  const errors: string[] = [];
  const numLevels = isMultiLevel ? cells.length : 1;

  for (let level = 0; level < numLevels; level++) {
    const levelCells = (isMultiLevel ? asMultiLevel(cells)[level] : cells)!;
    const numRows = levelCells.length;

    for (let row = 0; row < numRows; row++) {
      const numCols = levelCells[row]?.length ?? 0;

      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row]![col];

        if (!cell) continue;

        const levelPrefix = isMultiLevel ? `Level ${level}, ` : '';

        const checkDoor = (dir: CardinalDirection, adjRow: number, adjCol: number) => {
          const edgeVal: EdgeValue = getEdge(cell, dir);
          if (edgeVal === 'd' || edgeVal === 's') {
            const adjCell = levelCells[adjRow]?.[adjCol];
            if (adjCell === null) {
              const doorType = edgeVal === 's' ? 'secret door' : 'door';
              errors.push(
                `${levelPrefix}Cell [${row}][${col}] has a ${doorType} to the ${dir} leading into null/void space.\n` +
                  `  → Current ${dir} border: "${edgeVal}"\n` +
                  `  → ${doorType.charAt(0).toUpperCase() + doorType.slice(1)}s cannot lead into null cells\n` +
                  `  → Either remove the ${doorType} or add a valid cell to the ${dir}`,
              );
            }
          }
        };

        if (row > 0) checkDoor('north', row - 1, col);
        if (row < numRows - 1) checkDoor('south', row + 1, col);
        if (col < (levelCells[row]?.length ?? 0) - 1) checkDoor('east', row, col + 1);
        if (col > 0) checkDoor('west', row, col - 1);
      }
    }
  }

  return errors;
}

export { validateCell, validateNullAdjacency, validateDoorAdjacency };
