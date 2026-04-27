// convenience.js — High-level convenience methods: mergeRooms, shiftCells,
// normalizeMargin, createCorridor, setDoorBetween, placeLightInRoom.

import type { CardinalDirection, PlaceLightConfig } from '../../../types.js';
import {
  getApi,
  state,
  mutate,
  markDirty,
  notify,
  setReciprocal,
  invalidateAllCaches,
  toInt,
  withRollback,
  ApiValidationError,
  deleteEdge,
} from './_shared.js';

// ── Convenience ───────────────────────────────────────────────────────────

/**
 * Merge two adjacent rooms by removing all walls on their shared boundary.
 * Uses findWallBetween internally. One undo step.
 * @param {string} label1 - First room label
 * @param {string} label2 - Second room label
 * @returns {{ success: boolean, removed: number }} Count of walls cleared
 */
export function mergeRooms(label1: string, label2: string): { success: true; removed: number } {
  const wallResult = getApi().findWallBetween(label1, label2);
  if (!wallResult.success) {
    throw new ApiValidationError('NO_SHARED_BOUNDARY', `No shared boundary found between '${label1}' and '${label2}'`, {
      label1,
      label2,
    });
  }
  const walls = wallResult.walls;
  const coords: Array<{ row: number; col: number }> = walls.map(({ row, col }: { row: number; col: number }) => ({
    row: toInt(row),
    col: toInt(col),
  }));
  mutate(
    'mergeRooms',
    coords,
    () => {
      for (const { row, col, direction } of walls) {
        const iRow = toInt(row),
          iCol = toInt(col);
        const cell = state.dungeon.cells[iRow]?.[iCol];
        if (!cell) continue;
        deleteEdge(cell, direction as CardinalDirection);
        setReciprocal(iRow, iCol, direction, null);
      }
    },
    { invalidate: ['lighting'] },
  );
  return { success: true, removed: walls.length };
}

/**
 * Shift all cells in the dungeon by (dr, dc).
 * The grid grows to accommodate the shift -- no content is lost.
 * For multi-level maps, updates level startRow values when shifting vertically.
 * @param {number} dr - Row offset (positive = down)
 * @param {number} dc - Column offset (positive = right)
 * @returns {{ success: boolean, newRows: number, newCols: number }}
 */
export function shiftCells(dr: number, dc: number): { success: true; newRows: number; newCols: number } {
  dr = toInt(dr);
  dc = toInt(dc);
  const cells = state.dungeon.cells;
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  const newRows = rows + Math.abs(dr);
  const newCols = cols + Math.abs(dc);

  if (newRows > 200 || newCols > 200) {
    throw new ApiValidationError(
      'GRID_SIZE_EXCEEDED',
      `Shift would exceed maximum grid size (200×200). Result: ${newRows}×${newCols}`,
      { newRows, newCols, maxRows: 200, maxCols: 200 },
    );
  }

  // Row/col offset in the destination grid:
  // If dr > 0 (shift down), content starts at row dr; if dr < 0 (shift up), content starts at row 0.
  const rowOffset = Math.max(0, dr);
  const colOffset = Math.max(0, dc);

  return withRollback('shiftCells', () => {
    const sourceCells = state.dungeon.cells;
    const newCells = Array.from({ length: newRows }, () => Array(newCols).fill(null));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (sourceCells[r]?.[c]) newCells[r + rowOffset]![c + colOffset] = sourceCells[r]![c];
      }
    }
    state.dungeon.cells = newCells;

    // Update level startRow values (only affected by vertical shift)
    if (dr !== 0) {
      for (const level of state.dungeon.metadata.levels) {
        level.startRow += rowOffset;
      }
    }

    // Shift stair corner points
    if (rowOffset || colOffset) {
      for (const stair of state.dungeon.metadata.stairs) {
        for (const pt of stair.points) {
          pt[0] += rowOffset;
          pt[1] += colOffset;
        }
      }
    }

    markDirty();
    notify();
    return { success: true as const, newRows, newCols };
  });
}

/**
 * Normalize the dungeon grid so that every level has exactly `targetMargin`
 * empty (void) cells of margin around all structural content on all four sides.
 * Shrinks where margins are too large, expands where too small.
 *
 * Columns are treated globally (shared across all levels).
 * Rows are treated per-level (each level gets its own top/bottom margin).
 *
 * Updates: cells, level metadata, lights, bridges, stairs in metadata.
 * One undo step.
 *
 * @param {number} [targetMargin=2]  Desired empty-cell border width.
 * @returns {{ success, before, after, targetMargin, adjustments }}
 */
export function normalizeMargin(targetMargin: number = 2): Record<string, unknown> {
  targetMargin = toInt(targetMargin);
  if (targetMargin < 0) {
    throw new ApiValidationError('INVALID_MARGIN', 'targetMargin must be a non-negative integer', {
      received: targetMargin,
    });
  }

  const cells = state.dungeon.cells;
  const meta = state.dungeon.metadata;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const gridSize = meta.gridSize || 5;

  // Resolve level list — fall back to whole-grid single level if no levels metadata.
  // When addLevel() is used, meta.levels only contains explicitly-added levels —
  // the initial map area (rows before the first explicit level) is an implied level.
  const hasMeta = Array.isArray(meta.levels) && meta.levels.length > 0;
  const allLevels: { name: string | null; startRow: number; numRows: number }[] = [];
  if (hasMeta) {
    const firstStart = meta.levels[0]!.startRow;
    if (firstStart > 1) {
      // Implied first level: rows 0 to (firstStart - 2), separator at (firstStart - 1)
      allLevels.push({ name: null, startRow: 0, numRows: firstStart - 1 });
    }
    for (const l of meta.levels) allLevels.push(l);
  } else {
    allLevels.push({ name: 'Level 1', startRow: 0, numRows: numRows });
  }
  const rawLevels = allLevels;

  // ── 1. Global column bounds ──────────────────────────────────────────────
  let globalMinCol = numCols;
  let globalMaxCol = -1;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (cells[r]?.[c] != null) {
        if (c < globalMinCol) globalMinCol = c;
        if (c > globalMaxCol) globalMaxCol = c;
      }
    }
  }

  if (globalMaxCol < 0) {
    return { success: true, message: 'No structural content found — nothing to normalize' };
  }

  const contentWidth = globalMaxCol - globalMinCol + 1;
  const colShift = targetMargin - globalMinCol; // +ve = move right, -ve = move left
  const newNumCols = 2 * targetMargin + contentWidth;

  // ── 2. Per-level row bounds ──────────────────────────────────────────────
  // Capture original startRow/numRows before any mutation
  const levelAdjustments = rawLevels.map((level, li) => {
    const origStartRow = level.startRow;
    const origNumRows = level.numRows;
    const rowEnd = origStartRow + origNumRows - 1;
    let minRow = rowEnd + 1;
    let maxRow = origStartRow - 1;

    for (let r = origStartRow; r <= rowEnd; r++) {
      for (let c = 0; c < numCols; c++) {
        if (cells[r]?.[c] != null) {
          if (r < minRow) minRow = r;
          if (r > maxRow) maxRow = r;
        }
      }
    }

    const hasContent = maxRow >= minRow;
    let topShift, newNumRows;
    if (hasContent) {
      const relMinRow = minRow - origStartRow; // current top margin within this level
      const contentHeight = maxRow - minRow + 1;
      topShift = targetMargin - relMinRow; // +ve = content moves down, -ve = moves up
      newNumRows = 2 * targetMargin + contentHeight;
    } else {
      topShift = 0;
      newNumRows = 2 * targetMargin; // empty level: preserve margin-only footprint
    }

    return { origStartRow, origNumRows, li, hasContent, topShift, newNumRows };
  });

  // ── 3. Compute new level start rows ──────────────────────────────────────
  let newTotalRows = 0;
  const newLevelStartRows: number[] = [];
  for (let i = 0; i < levelAdjustments.length; i++) {
    if (i > 0) newTotalRows += 1; // void separator row between levels
    newLevelStartRows.push(newTotalRows);
    newTotalRows += levelAdjustments[i]!.newNumRows;
  }

  // Helper: compute absolute-row delta for a given original row value
  const getRowDelta = (r: number) => {
    for (let i = 0; i < levelAdjustments.length; i++) {
      const { origStartRow, origNumRows, topShift } = levelAdjustments[i]!;
      if (r >= origStartRow && r < origStartRow + origNumRows) {
        return newLevelStartRows[i]! - origStartRow + topShift;
      }
    }
    return 0; // separator row — no structural content expected here
  };

  return withRollback('normalizeMargin', () => {
    return _doNormalizeMargin();
  });

  function _doNormalizeMargin() {
    // ── 4. Build new cells array ─────────────────────────────────────────────
    const newCells = Array.from({ length: newTotalRows }, () => Array(newNumCols).fill(null));
    for (const { origStartRow, origNumRows, li, topShift, newNumRows } of levelAdjustments) {
      const newStartRow = newLevelStartRows[li]!;
      for (let r = origStartRow; r < origStartRow + origNumRows; r++) {
        const newRelRow = r - origStartRow + topShift;
        if (newRelRow < 0 || newRelRow >= newNumRows) continue;
        const newAbsRow = newStartRow + newRelRow;
        for (let c = 0; c < numCols; c++) {
          if (cells[r]?.[c] == null) continue;
          const newCol = c + colShift;
          if (newCol < 0 || newCol >= newNumCols) continue;
          newCells[newAbsRow]![newCol] = cells[r]![c];
        }
      }
    }
    state.dungeon.cells = newCells;

    // ── 5. Update lights (world-feet x/y) ────────────────────────────────────
    for (const light of meta.lights) {
      const lightRow = light.y / gridSize;
      light.y += getRowDelta(lightRow) * gridSize;
      light.x += colShift * gridSize;
    }

    // ── 6. Update bridges (row/col point arrays) ──────────────────────────────
    for (const bridge of meta.bridges) {
      for (const pt of bridge.points) {
        pt[0] += getRowDelta(pt[0]);
        pt[1] += colShift;
      }
    }

    // ── 7. Update stair corner points in metadata ─────────────────────────────
    for (const stair of meta.stairs) {
      for (const pt of stair.points) {
        pt[0] += getRowDelta(pt[0]);
        pt[1] += colShift;
      }
    }

    // ── 8. Update level metadata ──────────────────────────────────────────────
    // Replace meta.levels with the complete list (including any implied first level)
    if (allLevels.length > 0) {
      meta.levels = allLevels.map((l, i) => ({
        name: l.name ?? `Level ${i + 1}`,
        startRow: newLevelStartRows[i]!,
        numRows: levelAdjustments[i]!.newNumRows,
      }));
    }

    invalidateAllCaches();
    markDirty();
    notify();

    return {
      success: true,
      before: { rows: numRows, cols: numCols },
      after: { rows: newTotalRows, cols: newNumCols },
      targetMargin,
      adjustments: {
        colShift,
        levels: levelAdjustments.map(({ li, topShift, newNumRows }) => ({
          index: li,
          name: rawLevels[li]!.name,
          topShift,
          newNumRows,
          newStartRow: newLevelStartRows[li]!,
        })),
      },
    };
  } // _doNormalizeMargin
}

/**
 * Create a walled corridor connecting two labeled rooms. Rooms must be axis-aligned
 * with enough perpendicular overlap for the corridor width. Auto-assigns a room label
 * and places doors at both ends.
 * @param {string} label1 - First room label
 * @param {string} label2 - Second room label
 * @param {number} [width=2] - Corridor width in cells
 * @returns {{ success: boolean, corridorLabel: string, r1: number, c1: number, r2: number, c2: number }}
 */
export function createCorridor(label1: string, label2: string, width: number = 2): Record<string, unknown> {
  const b1Result = getApi().getRoomBounds(label1);
  const b2Result = getApi().getRoomBounds(label2);
  if (!b1Result.success) return { success: false, error: `Room "${label1}" not found` };
  if (!b2Result.success) return { success: false, error: `Room "${label2}" not found` };
  const b1 = b1Result,
    b2 = b2Result;

  let cr1, cc1, cr2, cc2;

  const vOverlap = Math.min(b1.c2, b2.c2) - Math.max(b1.c1, b2.c1) + 1;
  const hOverlap = Math.min(b1.r2, b2.r2) - Math.max(b1.r1, b2.r1) + 1;

  if (b1.c2 < b2.c1 && vOverlap >= width) {
    // b1 left of b2
    cc1 = b1.c2 + 1;
    cc2 = b2.c1 - 1;
    const mid = Math.floor((Math.max(b1.r1, b2.r1) + Math.min(b1.r2, b2.r2)) / 2);
    cr1 = mid - Math.floor(width / 2);
    cr2 = cr1 + width - 1;
  } else if (b2.c2 < b1.c1 && vOverlap >= width) {
    // b2 left of b1
    cc1 = b2.c2 + 1;
    cc2 = b1.c1 - 1;
    const mid = Math.floor((Math.max(b1.r1, b2.r1) + Math.min(b1.r2, b2.r2)) / 2);
    cr1 = mid - Math.floor(width / 2);
    cr2 = cr1 + width - 1;
  } else if (b1.r2 < b2.r1 && hOverlap >= width) {
    // b1 above b2
    cr1 = b1.r2 + 1;
    cr2 = b2.r1 - 1;
    const mid = Math.floor((Math.max(b1.c1, b2.c1) + Math.min(b1.c2, b2.c2)) / 2);
    cc1 = mid - Math.floor(width / 2);
    cc2 = cc1 + width - 1;
  } else if (b2.r2 < b1.r1 && hOverlap >= width) {
    // b2 above b1
    cr1 = b2.r2 + 1;
    cr2 = b1.r1 - 1;
    const mid = Math.floor((Math.max(b1.c1, b2.c1) + Math.min(b1.c2, b2.c2)) / 2);
    cc1 = mid - Math.floor(width / 2);
    cc2 = cc1 + width - 1;
  } else {
    return {
      success: false,
      error: `Cannot auto-route a corridor between "${label1}" and "${label2}". Rooms must be axis-aligned with at least ${width} cells of shared overlap and a gap between them. Use createRoom manually for L-shaped paths.`,
    };
  }

  if (cr2 < cr1 || cc2 < cc1)
    return {
      success: false,
      error: `"${label1}" and "${label2}" are already touching — use findWallBetween + setDoor to add a door directly.`,
    };

  getApi().createRoom(cr1, cc1, cr2, cc2, 'merge');

  // Auto-assign next available room label
  const letter = state.dungeon.metadata.dungeonLetter ?? 'A';
  const pat = new RegExp(`^${letter}(\\d+)$`);
  const used = new Set();
  for (const row of state.dungeon.cells) {
    for (const cell of row) {
      const m = cell?.center?.label?.match(pat);
      if (m) used.add(parseInt(m[1]!));
    }
  }
  let n = 1;
  while (used.has(n)) n++;
  const corridorLabel = letter + n;
  getApi().setLabel(Math.floor((cr1 + cr2) / 2), Math.floor((cc1 + cc2) / 2), corridorLabel);

  // Place doors at both connection points
  for (const roomLabel of [label1, label2]) {
    const wallResult = getApi().findWallBetween(roomLabel, corridorLabel);
    if (wallResult.success && wallResult.walls.length) {
      const mid = wallResult.walls[Math.floor(wallResult.walls.length / 2)]!;
      getApi().setDoor(mid.row, mid.col, mid.direction, 'd');
    }
  }

  return { success: true, corridorLabel, r1: cr1, c1: cc1, r2: cr2, c2: cc2 };
}

/**
 * Place a door on the shared wall between two adjacent labeled rooms.
 * Picks the midpoint of the shared boundary.
 * @param {string} label1 - First room label
 * @param {string} label2 - Second room label
 * @param {string} [type='d'] - Door type: 'd' (normal) or 's' (secret)
 * @returns {{ success: boolean, row: number, col: number, direction: string }}
 */
export function setDoorBetween(
  label1: string,
  label2: string,
  type: string = 'd',
): { success: true; row: number; col: number; direction: string } {
  const wallResult = getApi().findWallBetween(label1, label2);
  if (!wallResult.success || !wallResult.walls.length) {
    throw new ApiValidationError(
      'NO_SHARED_BOUNDARY',
      `No shared wall found between "${label1}" and "${label2}". Rooms must be adjacent.`,
      { label1, label2 },
    );
  }
  const mid = wallResult.walls[Math.floor(wallResult.walls.length / 2)]!;
  getApi().setDoor(mid.row, mid.col, mid.direction, type);
  return { success: true, row: mid.row, col: mid.col, direction: mid.direction };
}

/**
 * Place a light at the center of a labeled room. Handles world-feet conversion automatically.
 * @param {string} label - Room label
 * @param {string} [preset] - Light preset name from the catalog
 * @param {Object} [config] - Additional light configuration overrides
 * @returns {{ success: boolean, id: number }}
 */
export function placeLightInRoom(
  label: string,
  preset?: string,
  config: PlaceLightConfig = {},
): Record<string, unknown> {
  // Use the centroid of the room's actual floor cells, not the bbox center —
  // L/U/+ shaped rooms have bbox centers that fall in void.
  const cellsResult = getApi().listRoomCells(label);
  if (!cellsResult.success || !cellsResult.cells?.length) {
    return { success: false, error: cellsResult.error ?? `Room "${label}" not found` };
  }
  const roomCells = cellsResult.cells;
  let sumR = 0,
    sumC = 0;
  for (const [r, c] of roomCells) {
    sumR += r;
    sumC += c;
  }
  const cR = sumR / roomCells.length;
  const cC = sumC / roomCells.length;
  let bestRow = roomCells[0]![0];
  let bestCol = roomCells[0]![1];
  let bestDist = Infinity;
  for (const [r, c] of roomCells) {
    const d = (r - cR) ** 2 + (c - cC) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestRow = r;
      bestCol = c;
    }
  }
  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const res = meta.resolution || 1;
  const dgs = gs * res;
  const x = bestCol * dgs + dgs / 2;
  const y = bestRow * dgs + dgs / 2;
  return getApi().placeLight(x, y, preset ? { preset, ...config } : config);
}
