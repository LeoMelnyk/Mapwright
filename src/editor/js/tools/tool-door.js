// Door tool: click on cell edges to place/toggle doors (normal or secret)
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, notify, invalidateLightmap } from '../state.js';
import { isInBounds, setEdgeReciprocal, deleteEdgeReciprocal } from '../../../util/index.js';

export class DoorTool extends Tool {
  constructor() {
    super('door', 'D', 'pointer');
  }

  onRightClick(row, col, edge) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;

    if (!isInBounds(cells, er, ec)) return;
    if (!cells[er][ec]) return;
    if (!cells[er][ec][direction]) return; // nothing to clear

    pushUndo();
    deleteEdgeReciprocal(cells, er, ec, direction);

    invalidateLightmap();
    markDirty();
    notify();
  }

  onMouseDown(row, col, edge, event) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;

    if (!isInBounds(cells, er, ec)) return;
    if (!cells[er][ec]) cells[er][ec] = {}; // create cell if void

    pushUndo();

    const cell = cells[er][ec];
    const doorType = state.doorType || 'd'; // 'd' or 's'

    // Toggle: if clicking same value, clear it (revert to wall)
    if (cell[direction] === doorType) {
      setEdgeReciprocal(cells, er, ec, direction, 'w');
    } else {
      setEdgeReciprocal(cells, er, ec, direction, doorType);
    }

    invalidateLightmap();
    markDirty();
    notify();
  }
}
