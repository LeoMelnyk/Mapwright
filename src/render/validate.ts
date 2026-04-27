import { asMultiLevel, type CardinalDirection, type Cell, type CellGrid, type Metadata } from '../types.js';
import { getEdge, LEGACY_CELL_FIELDS } from '../util/index.js';

// ── Sub-module imports ─────────────────────────────────────────────────────
import {
  coordinateToFeet,
  validateCoordinate,
  getCoordinateBounds,
  validateGridAlignment,
  type ValidatorRoom,
} from './validate-coordinates.js';
import { validateCell, validateNullAdjacency, validateDoorAdjacency } from './validate-cells.js';
import { validateRoomLabels, detectInaccessibleRooms } from './validate-rooms.js';
import { hasStairFeatures, validateStairConnections } from './validate-structure.js';

/**
 * Validate matrix-based configuration structure and cell data.
 * @param {Object} config - Dungeon config with metadata and cells
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }} Validation result
 */
function validateMatrixFormat(config: { metadata: Metadata; cells: CellGrid }): void {
  const errors: string[] = [];

  // 1. Check metadata required fields
  if (!config.metadata.dungeonName) {
    errors.push('metadata.dungeonName is required');
  }
  if (!config.metadata.gridSize || !Number.isInteger(config.metadata.gridSize) || config.metadata.gridSize < 1) {
    errors.push('metadata.gridSize must be a positive integer');
  }

  if (config.cells.length === 0) {
    errors.push('cells array must have at least 1 row');
  }

  // Detect if multi-level format (3D array) early
  const numMetaLevels = config.metadata.levels.length;
  const isMultiLevel = numMetaLevels > 1 && Array.isArray(config.cells[0]) && Array.isArray(config.cells[0][0]);

  // Validate cell structure based on format
  if (isMultiLevel) {
    // Multi-level: validate each level
    const numLevels = config.cells.length;

    if (numLevels !== numMetaLevels) {
      errors.push(`metadata.levels is ${numMetaLevels} but cells array has ${numLevels} levels`);
    }

    for (let level = 0; level < numLevels; level++) {
      const levelCells = asMultiLevel(config.cells)[level];

      if (!Array.isArray(levelCells)) {
        errors.push(`Level ${level}: must be an array`);
        continue;
      }

      if (levelCells.length === 0) {
        errors.push(`Level ${level}: must have at least 1 row`);
        continue;
      }

      // Validate this level's cells
      const numCols = levelCells[0]?.length ?? 0;
      for (let row = 0; row < levelCells.length; row++) {
        if (!Array.isArray(levelCells[row])) {
          errors.push(`Level ${level}, Row ${row}: must be an array`);
          continue;
        }
        if (levelCells[row]!.length !== numCols) {
          errors.push(
            `Level ${level}, Row ${row}: has ${levelCells[row]!.length} columns, expected ${numCols} (all rows must have same length)`,
          );
        }

        // Validate each cell in this level
        for (let col = 0; col < levelCells[row]!.length; col++) {
          const cell = levelCells[row]![col] ?? null;
          validateCell(cell, level, row, col, errors);
        }
      }
    }
  } else {
    // Single-level: validate as 2D array
    const numCols = config.cells[0]?.length ?? 0;
    for (let row = 0; row < config.cells.length; row++) {
      if (!Array.isArray(config.cells[row])) {
        errors.push(`Row ${row}: must be an array`);
        continue;
      }
      if (config.cells[row]!.length !== numCols) {
        errors.push(
          `Row ${row}: has ${config.cells[row]!.length} columns, expected ${numCols} (all rows must have same length)`,
        );
      }

      // Validate each cell
      for (let col = 0; col < config.cells[row]!.length; col++) {
        const cell = config.cells[row]![col] as unknown as Cell | null;
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
function detectBorderCollisions(cells: CellGrid) {
  const errors = [];
  const numRows = cells.length;

  for (let row = 0; row < numRows; row++) {
    const numCols = cells[row]!.length;

    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]![col];
      if (!cell) continue;

      // Check east border collision (with cell to the right)
      if (col < numCols - 1 && cell.east) {
        const rightCell = cells[row]![col + 1];
        if (rightCell?.west && cell.east !== rightCell.west) {
          errors.push(
            `Border collision detected:\n` +
              `  Cell [${row}][${col}] has east: "${cell.east}" but\n` +
              `  Cell [${row}][${col + 1}] has west: "${rightCell.west}"\n` +
              `  → Conflict: ${getBorderName(cell.east)} vs ${getBorderName(rightCell.west)}`,
          );
        }
      }

      // Check south border collision (with cell below)
      if (row < numRows - 1 && cell.south) {
        const belowCell = cells[row + 1]![col];
        if (belowCell?.north && cell.south !== belowCell.north) {
          errors.push(
            `Border collision detected:\n` +
              `  Cell [${row}][${col}] has south: "${cell.south}" but\n` +
              `  Cell [${row + 1}][${col}] has north: "${belowCell.north}"\n` +
              `  → Conflict: ${getBorderName(cell.south)} vs ${getBorderName(belowCell.north)}`,
          );
        }
      }

      // Check nw-se diagonal collision (with cell diagonally below-right)
      if (row < numRows - 1 && col < numCols - 1) {
        const cellNwSe = getEdge(cell, 'nw-se');
        if (cellNwSe) {
          const diagCell = cells[row + 1]![col + 1];
          const diagNwSe = diagCell ? getEdge(diagCell, 'nw-se') : null;
          if (diagNwSe && cellNwSe !== diagNwSe) {
            errors.push(
              `Diagonal border collision detected:\n` +
                `  Cell [${row}][${col}] has nw-se: "${cellNwSe}" but\n` +
                `  Cell [${row + 1}][${col + 1}] has nw-se: "${diagNwSe}"\n` +
                `  → Conflict: ${getBorderName(cellNwSe)} vs ${getBorderName(diagNwSe)}`,
            );
          }
        }
      }

      // Check ne-sw diagonal collision (with cell diagonally below-left)
      if (row < numRows - 1 && col > 0) {
        const cellNeSw = getEdge(cell, 'ne-sw');
        if (cellNeSw) {
          const diagCell = cells[row + 1]![col - 1];
          const diagNeSw = diagCell ? getEdge(diagCell, 'ne-sw') : null;
          if (diagNeSw && cellNeSw !== diagNeSw) {
            errors.push(
              `Diagonal border collision detected:\n` +
                `  Cell [${row}][${col}] has ne-sw: "${cellNeSw}" but\n` +
                `  Cell [${row + 1}][${col - 1}] has ne-sw: "${diagNeSw}"\n` +
                `  → Conflict: ${getBorderName(cellNeSw)} vs ${getBorderName(diagNeSw)}`,
            );
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Get human-readable name for border value
 */
function getBorderName(value: string | null) {
  const names = {
    w: 'wall',
    d: 'door',
    s: 'secret door',
  };
  return names[value as keyof typeof names] || value;
}

/**
 * Report validation errors and throw
 */
function reportValidationErrors(errors: string[], title: string) {
  console.error(`\n❌ ${title}:\n`);
  errors.forEach((e: string) => console.error(`   ${e}`));
  console.error('');
  throw new Error('Validation failed');
}

/**
 * Validate dungeon configuration (legacy coordinate-based).
 * @param {Object} config - Dungeon config to validate
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
function validateConfig(config: {
  metadata: Metadata;
  cells: CellGrid;
  rooms?: ValidatorRoom[];
  dungeonName?: string;
  gridSize?: number;
  [key: string]: unknown;
}): void {
  if (!config.dungeonName) throw new Error('Missing required field: dungeonName');
  if (!config.gridSize) throw new Error('Missing required field: gridSize');
  if (!config.rooms || config.rooms.length === 0) throw new Error('No rooms defined');

  const ids = new Set<string>();
  for (const room of config.rooms) {
    if (!room.id) throw new Error(`Room missing ID: ${JSON.stringify(room)}`);
    if (ids.has(room.id)) throw new Error(`Duplicate room ID: ${room.id}`);
    ids.add(room.id);
  }
}

// ── Lightweight load-time validation ────────────────────────────────────────

/**
 * Known Cell property keys.
 *
 * Validation runs on raw JSON before migration, so the set includes both
 * the modern segment-authoritative fields and every legacy field that
 * `migrateCellsToSegments` knows how to convert — otherwise loading an old
 * save would warn on every cell. Once a cell has been migrated, the legacy
 * fields are stripped and only the modern keys appear.
 *
 * The legacy half of the list is sourced from `LEGACY_CELL_FIELDS` in
 * `util/migrate-segments.ts` so legacy field names live in exactly one
 * place in the codebase.
 */
const KNOWN_CELL_KEYS = new Set<string>([
  // Modern (post-migration) fields.
  'north',
  'south',
  'east',
  'west',
  'fill',
  'fillDepth',
  'hazard',
  'segments',
  'interiorEdges',
  'waterDepth',
  'lavaDepth',
  'center',
  'prop',
  // Legacy fields accepted on input — `migrateCellsToSegments` removes them.
  ...LEGACY_CELL_FIELDS,
]);

const VALID_EDGE_VALUES = new Set<string | null | undefined>(['w', 'd', 's', 'iw', 'id', null, undefined]);
const VALID_FILL_TYPES = new Set(['water', 'lava', 'pit']);

/**
 * Lightweight structural validation for dungeon JSON at load time.
 * Returns warnings (never throws or rejects the file).
 */
function validateDungeonStructure(dungeon: { metadata: Metadata; cells: CellGrid }): string[] {
  const warnings: string[] = [];
  const meta = dungeon.metadata;

  // Metadata checks
  if (typeof meta.gridSize !== 'number' || meta.gridSize <= 0) {
    warnings.push(`metadata.gridSize should be a positive number, got ${String(meta.gridSize)}`);
  }
  if (typeof meta.theme !== 'string' || !meta.theme) {
    warnings.push(`metadata.theme should be a non-empty string, got ${String(meta.theme)}`);
  }

  // Cells structure check
  if (!Array.isArray(dungeon.cells) || dungeon.cells.length === 0) {
    warnings.push('cells should be a non-empty 2D array');
    return warnings;
  }

  const expectedCols = dungeon.cells[0]?.length ?? 0;
  const edgeDirs: CardinalDirection[] = ['north', 'south', 'east', 'west'];

  // Sample up to 200 cells to avoid slow validation on large maps
  const totalRows = dungeon.cells.length;
  const step = Math.max(1, Math.floor(totalRows / 50));
  let cellsChecked = 0;

  for (let r = 0; r < totalRows && cellsChecked < 200; r += step) {
    const row = dungeon.cells[r];
    if (!Array.isArray(row)) {
      warnings.push(`Row ${r} is not an array`);
      continue;
    }
    if (row.length !== expectedCols) {
      warnings.push(`Row ${r} has ${row.length} columns, expected ${expectedCols}`);
    }

    for (let c = 0; c < row.length && cellsChecked < 200; c += step) {
      const cell = row[c];
      if (cell === null) continue;
      if (typeof cell !== 'object') {
        warnings.push(`Cell [${r}][${c}] is ${typeof cell}, expected object or null`);
        cellsChecked++;
        continue;
      }

      // Check for unknown keys
      for (const key of Object.keys(cell)) {
        if (!KNOWN_CELL_KEYS.has(key)) {
          warnings.push(`Cell [${r}][${c}] has unknown property "${key}"`);
        }
      }

      // Validate edge values
      for (const dir of edgeDirs) {
        const val = getEdge(cell, dir);
        if (val !== undefined && !VALID_EDGE_VALUES.has(val as string | null)) {
          warnings.push(`Cell [${r}][${c}].${dir} has invalid edge value "${String(val)}"`);
        }
      }

      // Validate fill type
      if (cell.fill !== undefined && !VALID_FILL_TYPES.has(cell.fill as string)) {
        warnings.push(`Cell [${r}][${c}].fill has invalid type "${cell.fill}"`);
      }

      cellsChecked++;
    }
  }

  return warnings;
}

export {
  coordinateToFeet,
  validateCoordinate,
  getCoordinateBounds,
  validateGridAlignment,
  validateCell,
  validateMatrixFormat,
  validateConfig,
  validateDungeonStructure,
};
