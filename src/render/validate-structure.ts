import { asMultiLevel, type CellGrid } from '../types.js';

/**
 * Check if any cells have stair features
 */
function hasStairFeatures(cells: CellGrid) {
  const isMultiLevel = Array.isArray(cells[0]) && Array.isArray(cells[0][0]);
  const numLevels = isMultiLevel ? cells.length : 1;

  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? asMultiLevel(cells)[level] : cells;
    const numRows = levelCells.length;

    for (let row = 0; row < numRows; row++) {
      const numCols = levelCells[row]?.length ?? 0;

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
function validateSingleStair(
  cells: CellGrid,
  isMultiLevel: boolean,
  fromLevel: number,
  fromRow: number,
  fromCol: number,
  stairType: string,
  reciprocalType: string,
  target: unknown,
) {
  const errors = [];
  const targetArr = target as number[];

  let targetLevel: number, targetRow: number, targetCol: number;
  if (targetArr.length === 3) {
    [targetLevel, targetRow, targetCol] = targetArr;
  } else if (targetArr.length === 2) {
    targetLevel = fromLevel;
    [targetRow, targetCol] = targetArr;
  } else {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
        `${stairType} must be [level, row, col] or [row, col], got ${JSON.stringify(target)}`,
    );
    return errors;
  }

  const numLevels = isMultiLevel ? cells.length : 1;
  if (targetLevel < 0 || targetLevel >= numLevels) {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
        `${stairType} points to level ${targetLevel}, but only ${numLevels} level(s) exist`,
    );
    return errors;
  }

  const targetLevelCells = isMultiLevel ? asMultiLevel(cells)[targetLevel] : cells;
  const numRows = targetLevelCells.length;
  const numCols = targetLevelCells[0]?.length || 0;

  if (targetRow < 0 || targetRow >= numRows) {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
        `${stairType} points to row ${targetRow}, but level ${targetLevel} only has ${numRows} rows`,
    );
    return errors;
  }

  if (targetCol < 0 || targetCol >= numCols) {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
        `${stairType} points to col ${targetCol}, but level ${targetLevel} only has ${numCols} cols`,
    );
    return errors;
  }

  const targetCell = targetLevelCells[targetRow][targetCol];
  if (!targetCell) {
    errors.push(
      `Level ${fromLevel}, Cell [${fromRow}][${fromCol}]: ` +
        `${stairType} points to Level ${targetLevel}, Cell [${targetRow}][${targetCol}], ` +
        `but that cell is null/empty`,
    );
    return errors;
  }

  if (!targetCell.center?.[reciprocalType]) {
    errors.push(
      `Stair connection broken:\n` +
        `  Level ${fromLevel}, Cell [${fromRow}][${fromCol}] has ${stairType} pointing to ` +
        `[${targetLevel}, ${targetRow}, ${targetCol}]\n` +
        `  But Level ${targetLevel}, Cell [${targetRow}][${targetCol}] has no ${reciprocalType}\n` +
        `  → Add "${reciprocalType}": [${fromLevel}, ${fromRow}, ${fromCol}] to the target cell`,
    );
    return errors;
  }

  const reciprocal = targetCell.center[reciprocalType] as number[];
  let recipLevel: number, recipRow: number, recipCol: number;
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
        `  → Expected [${fromLevel}, ${fromRow}, ${fromCol}]`,
    );
  }

  return errors;
}

/**
 * Validate stair connections across all levels
 */
function validateStairConnections(cells: CellGrid, isMultiLevel: boolean) {
  const errors = [];
  const numLevels = isMultiLevel ? cells.length : 1;

  for (let level = 0; level < numLevels; level++) {
    const levelCells = isMultiLevel ? asMultiLevel(cells)[level] : cells;
    const numRows = levelCells.length;

    for (let row = 0; row < numRows; row++) {
      const numCols = levelCells[row]?.length ?? 0;

      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row][col];
        if (!cell?.center) continue;

        if (Array.isArray(cell.center['stairs-up'])) {
          errors.push(
            ...validateSingleStair(
              cells,
              isMultiLevel,
              level,
              row,
              col,
              'stairs-up',
              'stairs-down',
              cell.center['stairs-up'],
            ),
          );
        }

        if (Array.isArray(cell.center['stairs-down'])) {
          errors.push(
            ...validateSingleStair(
              cells,
              isMultiLevel,
              level,
              row,
              col,
              'stairs-down',
              'stairs-up',
              cell.center['stairs-down'],
            ),
          );
        }
      }
    }
  }

  return errors;
}

export { hasStairFeatures, validateStairConnections };
