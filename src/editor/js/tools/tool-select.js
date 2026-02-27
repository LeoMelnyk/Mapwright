// Select tool: click to select cells, inspect in properties panel
import { Tool } from './tool-base.js';
import state, { markDirty, notify } from '../state.js';

export class SelectTool extends Tool {
  constructor() {
    super('select', 'V', 'default');
  }

  onMouseDown(row, col, edge, event) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) {
      state.selectedCells = [];
      notify();
      return;
    }

    if (event.shiftKey) {
      // Toggle selection
      const idx = state.selectedCells.findIndex(c => c.row === row && c.col === col);
      if (idx >= 0) {
        state.selectedCells.splice(idx, 1);
      } else {
        state.selectedCells.push({ row, col });
      }
    } else {
      state.selectedCells = [{ row, col }];
    }

    markDirty();
    notify();
  }
}
