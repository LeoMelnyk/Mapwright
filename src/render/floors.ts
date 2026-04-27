import { getSegments } from '../util/index.js';
import type { CellGrid } from '../types.js';

/**
 * A cell is a "room" cell when it is non-null AND has at least one non-voided
 * segment — matches the segment model where a cell whose only segment is voided
 * renders as empty space.
 */
function determineRoomCells(cells: CellGrid): boolean[][] {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  const isRoom: boolean[][] = Array.from({ length: numRows }, () => Array(numCols).fill(false));

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]![col];
      if (cell && getSegments(cell).some((s) => !s.voided)) {
        isRoom[row]![col] = true;
      }
    }
  }

  return isRoom;
}

export { determineRoomCells };
