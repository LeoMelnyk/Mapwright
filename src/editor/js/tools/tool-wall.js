// Wall tool: click/drag on cell edges to paint walls
// Drag is constrained to a straight line matching the first edge's orientation:
//   north/south edges → horizontal line (same row, varying col)
//   east/west edges   → vertical line   (same col, varying row)
//   nw-se edges       → diagonal line   (row and col change together)
//   ne-sw edges       → anti-diagonal   (row increases as col decreases)
import { Tool } from './tool-base.js';
import state, { pushUndo, undo, markDirty, invalidateLightmap } from '../state.js';
import { captureBeforeState, smartInvalidate } from '../../../render/index.js';
import { requestRender } from '../canvas-view.js';
import { isInBounds, setEdgeReciprocal, deleteEdgeReciprocal } from '../../../util/index.js';

export class WallTool extends Tool {
  constructor() {
    super('wall', 'W', 'pointer');
    this.dragging = false;
    this.undoPushed = false;
    this.cancelled = false;
    // Drag constraint: locked direction + axis
    this.lockedDir = null;
    this.startRow = 0;
    this.startCol = 0;
  }

  onMouseDown(row, col, edge, event) {
    if (!edge) return;
    this.dragging = true;
    this.undoPushed = false;
    this.cancelled = false;
    // Lock to this edge's direction for the entire drag
    this.lockedDir = edge.direction;
    this.startRow = edge.row;
    this.startCol = edge.col;
    this._placeWall(edge.row, edge.col);
  }

  onMouseMove(row, col, edge, event) {
    if (!this.dragging || this.cancelled) return;
    const dir = this.lockedDir;
    const hoverRow = edge ? edge.row : row;
    const hoverCol = edge ? edge.col : col;

    let targetRow, targetCol;
    if (dir === 'north' || dir === 'south') {
      // Horizontal: lock row, vary col
      targetRow = this.startRow;
      targetCol = hoverCol;
    } else if (dir === 'east' || dir === 'west') {
      // Vertical: lock col, vary row
      targetRow = hoverRow;
      targetCol = this.startCol;
    } else if (dir === 'nw-se') {
      // Diagonal: row and col move together (+1,+1 or -1,-1)
      // Project hovered cell onto the nw-se diagonal through start
      const dr = hoverRow - this.startRow;
      const dc = hoverCol - this.startCol;
      // Use whichever delta is larger in magnitude to determine steps
      const steps = Math.abs(dr) >= Math.abs(dc) ? dr : dc;
      targetRow = this.startRow + steps;
      targetCol = this.startCol + steps;
    } else if (dir === 'ne-sw') {
      // Anti-diagonal: row goes up as col goes right (or vice versa)
      // nw-se: dr == dc; ne-sw: dr == -dc
      const dr = hoverRow - this.startRow;
      const dc = hoverCol - this.startCol;
      const steps = Math.abs(dr) >= Math.abs(dc) ? dr : -dc;
      targetRow = this.startRow + steps;
      targetCol = this.startCol - steps;
    }

    // Lock the preview indicator to the constrained axis end-point
    state.hoveredEdge = { direction: dir, row: targetRow, col: targetCol };

    this._fillLine(targetRow, targetCol);
    requestRender();
  }

  onMouseUp() {
    this.dragging = false;
    this.undoPushed = false;
    this.lockedDir = null;
  }

  onRightClick(row, col, edge) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;

    if (!isInBounds(cells, er, ec)) return;
    if (!cells[er][ec]) return;
    if (!cells[er][ec][direction]) return; // nothing to clear

    const before = captureBeforeState(cells, [{ row: er, col: ec }]);
    pushUndo();
    deleteEdgeReciprocal(cells, er, ec, direction);

    invalidateLightmap();
    smartInvalidate(before, cells);
    markDirty();
  }

  onCancel() {
    if (!this.dragging) return false;
    if (this.undoPushed) {
      undo(); // Reverts the pushUndo from _placeWall — restores cells + calls markDirty/notify
    }
    this.dragging = false;
    this.cancelled = true;
    this.undoPushed = false;
    this.lockedDir = null;
    requestRender();
    return true;
  }

  /** Fill walls along the locked axis from start to (endRow, endCol) */
  _fillLine(endRow, endCol) {
    const dir = this.lockedDir;

    if (dir === 'north' || dir === 'south') {
      // Horizontal line: same row, walk columns
      const r = this.startRow;
      const c1 = Math.min(this.startCol, endCol);
      const c2 = Math.max(this.startCol, endCol);
      for (let c = c1; c <= c2; c++) {
        this._placeWall(r, c);
      }
    } else if (dir === 'east' || dir === 'west') {
      // Vertical line: same col, walk rows
      const c = this.startCol;
      const r1 = Math.min(this.startRow, endRow);
      const r2 = Math.max(this.startRow, endRow);
      for (let r = r1; r <= r2; r++) {
        this._placeWall(r, c);
      }
    } else if (dir === 'nw-se') {
      // Diagonal: row and col step together
      const steps = endRow - this.startRow; // positive = SE, negative = NW
      const count = Math.abs(steps);
      const sign = steps >= 0 ? 1 : -1;
      for (let i = 0; i <= count; i++) {
        this._placeWall(this.startRow + i * sign, this.startCol + i * sign);
      }
    } else if (dir === 'ne-sw') {
      // Anti-diagonal: row and col step in opposite directions
      const steps = endRow - this.startRow; // positive = SW, negative = NE
      const count = Math.abs(steps);
      const sign = steps >= 0 ? 1 : -1;
      for (let i = 0; i <= count; i++) {
        this._placeWall(this.startRow + i * sign, this.startCol - i * sign);
      }
    }
  }

  _placeWall(row, col) {
    const cells = state.dungeon.cells;
    const direction = this.lockedDir;

    if (!isInBounds(cells, row, col)) return;

    // Skip void cells — walls require an existing cell on this side
    if (!cells[row][col]) return;
    const existing = cells[row][col];
    if (existing[direction] === 'w') return;
    if (existing[direction] === 'd' || existing[direction] === 's') return;

    const before = captureBeforeState(cells, [{ row, col }]);

    if (!this.undoPushed) {
      pushUndo();
      this.undoPushed = true;
    }

    setEdgeReciprocal(cells, row, col, direction, 'w');

    invalidateLightmap();
    smartInvalidate(before, cells);
    markDirty();
  }
}
