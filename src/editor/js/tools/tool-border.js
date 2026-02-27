// Border tool: click on cell edges to set wall/door/secret/clear
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, notify, invalidateLightmap } from '../state.js';
import { captureBeforeState, smartInvalidate } from '../../../render/index.js';
import { isInBounds, setEdgeReciprocal, deleteEdgeReciprocal } from '../../../util/index.js';

export class BorderTool extends Tool {
  constructor() {
    super('border', 'B', 'pointer');
  }

  onMouseDown(row, col, edge, event) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;

    if (!isInBounds(cells, er, ec)) return;

    // Capture before state (before cell creation — wasVoid must be accurate)
    const before = captureBeforeState(cells, [{ row: er, col: ec }]);

    // Ensure cell exists
    if (!cells[er][ec]) cells[er][ec] = {};

    pushUndo();

    const cell = cells[er][ec];
    const newValue = state.borderType; // 'w', 'd', 's', or null

    // Toggle: if clicking same value, clear it
    if (cell[direction] === newValue || newValue === null) {
      deleteEdgeReciprocal(cells, er, ec, direction);
    } else {
      setEdgeReciprocal(cells, er, ec, direction, newValue);
    }

    invalidateLightmap();
    smartInvalidate(before, cells);
    markDirty();
    notify();
  }
}
