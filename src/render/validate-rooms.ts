import { asMultiLevel, type Cell, type CellGrid } from '../types.js';
import { floodFillRoom as sharedFloodFillRoom, parseCellKey } from '../util/index.js';

/** Parsed room label for sorting. */
interface ParsedLabel {
  letter: string;
  number: number;
  original: string;
}

/**
 * Flood fill a single room region using the shared diagonal-aware BFS,
 * then collect all labels found within the filled cells.
 */
function floodFillRoomLabels(
  cells: CellGrid,
  startLevel: number,
  startRow: number,
  startCol: number,
  visited: boolean[][][],
  isMultiLevel: boolean,
) {
  const levelCells = (isMultiLevel ? asMultiLevel(cells)[startLevel] : cells)!;
  const cellKeys = sharedFloodFillRoom(levelCells as (Cell | null)[][], startRow, startCol);

  const labels = [];
  for (const key of cellKeys) {
    const [r, c] = parseCellKey(key);
    visited[startLevel]![r]![c] = true;
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
function validateRoomLabels(cells: CellGrid, isMultiLevel = false) {
  const errors = [];
  const numLevels = isMultiLevel ? cells.length : 1;

  const visited: boolean[][][] = [];
  for (let level = 0; level < numLevels; level++) {
    const levelCells = (isMultiLevel ? asMultiLevel(cells)[level] : cells)!;
    const numRows = levelCells.length;
    const numCols = levelCells[0]?.length ?? 0;
    visited[level] = Array.from({ length: numRows }, () => Array(numCols).fill(false) as boolean[]);
  }

  const allLabels = new Map<string, string>();

  for (let level = 0; level < numLevels; level++) {
    const levelCells = (isMultiLevel ? asMultiLevel(cells)[level] : cells)!;
    const numRows = levelCells.length;
    const numCols = levelCells[0]?.length ?? 0;

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row]![col];

        if (!cell) continue;
        if (visited[level]![row]![col]) continue;

        const labelsInRoom = floodFillRoomLabels(cells, level, row, col, visited, isMultiLevel);

        for (const l of labelsInRoom) {
          const pos = isMultiLevel ? `Level ${l.level}, [${l.row}][${l.col}]` : `[${l.row}][${l.col}]`;
          if (allLabels.has(l.label)) {
            errors.push(
              `Duplicate label "${l.label}" found at ${pos} ` +
                `and ${allLabels.get(l.label)}\n` +
                `  → Each label must be unique across the dungeon`,
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
 * Parse room label into components
 */
function parseRoomLabel(label: string): ParsedLabel | null {
  const match = /^([A-Z]+)(\d+)$/.exec(label);
  if (!match) return null;
  return {
    letter: match[1]!,
    number: parseInt(match[2]!, 10),
    original: label,
  };
}

/**
 * Compare room labels for sorting (alphanumeric)
 */
function compareRoomLabels(a: ParsedLabel, b: ParsedLabel) {
  if (a.letter !== b.letter) {
    return a.letter.localeCompare(b.letter);
  }
  return a.number - b.number;
}

/**
 * Check if we can traverse from one cell to another
 */
function canTraverse(fromCell: Cell | null, toCell: Cell | null, direction: string) {
  const borderMap = {
    north: { current: 'north', adjacent: 'south' },
    south: { current: 'south', adjacent: 'north' },
    east: { current: 'east', adjacent: 'west' },
    west: { current: 'west', adjacent: 'east' },
  };

  const { current, adjacent } = borderMap[direction as keyof typeof borderMap];

  // Validated dynamic property access — current/adjacent are cardinal direction strings from borderMap
  const fromBorder = (fromCell as Record<string, unknown> | null)?.[current];
  if (fromBorder === 'w') return false;

  const toBorder = (toCell as Record<string, unknown> | null)?.[adjacent];
  if (toBorder === 'w') return false;

  return true;
}

/**
 * BFS to find all reachable rooms from starting position
 */
function bfsReachableRooms(
  cells: CellGrid,
  startLevel: number,
  startRow: number,
  startCol: number,
  isMultiLevel: boolean,
) {
  const numLevels = isMultiLevel ? cells.length : 1;

  const visited: boolean[][][] = [];
  for (let level = 0; level < numLevels; level++) {
    const levelCells = (isMultiLevel ? asMultiLevel(cells)[level] : cells)!;
    const numRows = levelCells.length;
    const numCols = levelCells[0]?.length ?? 0;
    visited[level] = Array.from({ length: numRows }, () => Array(numCols).fill(false) as boolean[]);
  }

  const reachedRooms = new Set<string>();
  const queue: { level: number; row: number; col: number }[] = [{ level: startLevel, row: startRow, col: startCol }];

  visited[startLevel]![startRow]![startCol] = true;
  const startLevelCells = (isMultiLevel ? asMultiLevel(cells)[startLevel] : cells)!;
  const startCell = startLevelCells[startRow]![startCol];
  if (startCell?.center?.label) {
    reachedRooms.add(startCell.center.label);
  }

  while (queue.length > 0) {
    const { level, row, col } = queue.shift()!;
    const levelCells = (isMultiLevel ? asMultiLevel(cells)[level] : cells)!;
    const cell = levelCells[row]![col];

    // 1. Try horizontal movement (4 cardinal directions)
    const directions = [
      { dir: 'north', dRow: -1, dCol: 0 },
      { dir: 'south', dRow: 1, dCol: 0 },
      { dir: 'east', dRow: 0, dCol: 1 },
      { dir: 'west', dRow: 0, dCol: -1 },
    ];

    for (const { dir, dRow, dCol } of directions) {
      const newRow = row + dRow;
      const newCol = col + dCol;
      const numRows = levelCells.length;
      const numCols = levelCells[0]?.length ?? 0;

      if (newRow < 0 || newRow >= numRows || newCol < 0 || newCol >= numCols) {
        continue;
      }

      if (visited[level]![newRow]![newCol]) {
        continue;
      }

      const nextCell = levelCells[newRow]![newCol] ?? null;
      if (canTraverse(cell ?? null, nextCell, dir)) {
        visited[level]![newRow]![newCol] = true;
        queue.push({ level, row: newRow, col: newCol });

        if (nextCell?.center?.label) {
          reachedRooms.add(nextCell.center.label);
        }
      }
    }

    // 2. Try vertical movement (stairs)
    if (cell?.center) {
      // Check stairs-up (skip non-array markers — visual-only from .map compiler)
      if (Array.isArray(cell.center['stairs-up'])) {
        const stairTarget = cell.center['stairs-up'] as number[];
        let targetLevel: number, targetRow: number, targetCol: number;

        if (stairTarget.length === 3) {
          [targetLevel, targetRow, targetCol] = stairTarget as [number, number, number];
        } else {
          targetLevel = level;
          [targetRow, targetCol] = stairTarget as [number, number];
        }

        if (!visited[targetLevel]![targetRow]![targetCol]) {
          visited[targetLevel]![targetRow]![targetCol] = true;
          queue.push({ level: targetLevel, row: targetRow, col: targetCol });

          const targetLevelCells = (isMultiLevel ? asMultiLevel(cells)[targetLevel] : cells)!;
          const targetCell = targetLevelCells[targetRow]![targetCol];
          if (targetCell?.center?.label) {
            reachedRooms.add(targetCell.center.label);
          }
        }
      }

      // Check stairs-down (skip non-array markers — visual-only from .map compiler)
      if (Array.isArray(cell.center['stairs-down'])) {
        const stairTarget = cell.center['stairs-down'] as number[];
        let targetLevel: number, targetRow: number, targetCol: number;

        if (stairTarget.length === 3) {
          [targetLevel, targetRow, targetCol] = stairTarget as [number, number, number];
        } else {
          targetLevel = level;
          [targetRow, targetCol] = stairTarget as [number, number];
        }

        if (!visited[targetLevel]![targetRow]![targetCol]) {
          visited[targetLevel]![targetRow]![targetCol] = true;
          queue.push({ level: targetLevel, row: targetRow, col: targetCol });

          const targetLevelCells = (isMultiLevel ? asMultiLevel(cells)[targetLevel] : cells)!;
          const targetCell = targetLevelCells[targetRow]![targetCol];
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
function detectInaccessibleRooms(cells: CellGrid, isMultiLevel = false) {
  const numLevels = isMultiLevel ? cells.length : 1;
  const errors = [];

  const roomPositions = new Map();

  for (let level = 0; level < numLevels; level++) {
    const levelCells = (isMultiLevel ? asMultiLevel(cells)[level] : cells)!;
    const numRows = levelCells.length;
    const numCols = levelCells[0]?.length ?? 0;

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const cell = levelCells[row]![col];
        if (cell?.center?.label) {
          if (!roomPositions.has(cell.center.label)) {
            roomPositions.set(cell.center.label, []);
          }
          roomPositions.get(cell.center.label).push({ level, row, col });
        }
      }
    }
  }

  if (roomPositions.size === 0) return [];
  if (roomPositions.size === 1) return [];

  const roomLabels = Array.from(roomPositions.keys());
  const parsedLabels = roomLabels
    .map((label) => parseRoomLabel(label))
    .filter((parsed): parsed is ParsedLabel => parsed !== null);

  if (parsedLabels.length === 0) {
    return ['No valid room labels found (expected format: A1, B12, etc.)'];
  }

  parsedLabels.sort(compareRoomLabels);
  const startingLabel = parsedLabels[0]!.original;
  const startingPositions = roomPositions.get(startingLabel);
  const startPos = startingPositions[0];

  const reachedRooms = bfsReachableRooms(cells, startPos.level, startPos.row, startPos.col, isMultiLevel);

  const unreachableRooms = [];
  for (const [label, positions] of roomPositions) {
    if (!reachedRooms.has(label)) {
      const pos = positions[0];
      unreachableRooms.push({
        label,
        position: isMultiLevel ? `Level ${pos.level}, Cell [${pos.row}][${pos.col}]` : `[${pos.row}][${pos.col}]`,
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

export { floodFillRoomLabels, validateRoomLabels, detectInaccessibleRooms };
