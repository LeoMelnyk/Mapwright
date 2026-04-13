// Wall tool: click/drag on cell edges to paint walls
// Drag is constrained to a straight line matching the first edge's orientation:
//   north/south edges → horizontal line (same row, varying col)
//   east/west edges   → vertical line   (same col, varying row)
//   nw-se edges       → diagonal line   (row and col change together)
//   ne-sw edges       → anti-diagonal   (row increases as col decreases)
import type { Cell, CellGrid, Direction, EdgeValue, UndoCellPatch } from '../../../types.js';
import { Tool, type EdgeInfo } from './tool-base.js';
import state, { pushPatchUndo, markDirty, invalidateLightmap } from '../state.js';
import { captureBeforeState, smartInvalidate } from '../../../render/index.js';
import { requestRender } from '../canvas-view.js';
import { isInBounds, setEdgeReciprocal, deleteEdgeReciprocal, getEdge, CARDINAL_OFFSETS } from '../../../util/index.js';

/** Clone a cell for undo patch storage. */
function cloneCell(cell: Cell | null): Cell | null {
  return cell ? (JSON.parse(JSON.stringify(cell)) as Cell) : null;
}

/**
 * Wall tool: click/drag on cell edges to paint walls in a constrained straight line.
 * Supports cardinal and diagonal wall directions.
 */
export class WallTool extends Tool {
  dragging: boolean = false;
  cancelled: boolean = false;
  lockedDir: string | null = null;
  startRow: number = 0;
  startCol: number = 0;

  // Patch accumulator: tracks before-states of all cells modified during a drag.
  // Key: "row,col", Value: cloned cell BEFORE the first modification.
  _beforeStates: Map<string, Cell | null> = new Map();

  constructor() {
    super('wall', 'W', 'pointer');
    this.dragging = false;
    this.cancelled = false;
    this.lockedDir = null;
    this.startRow = 0;
    this.startCol = 0;
    this._beforeStates = new Map();
  }

  onActivate() {
    state.statusInstruction =
      state.wallType === 'iw'
        ? 'Click or drag edge to place invisible wall · Blocks movement but hidden from players · Right-click to remove'
        : 'Click or drag edge to place wall · Right-click to remove';
  }

  onDeactivate() {
    state.statusInstruction = null;
  }

  onMouseDown(row: number, col: number, edge: EdgeInfo | null) {
    if (!edge) return;
    this.dragging = true;
    this.cancelled = false;
    this._beforeStates = new Map();
    // Lock to this edge's direction for the entire drag
    this.lockedDir = edge.direction;
    this.startRow = edge.row;
    this.startCol = edge.col;
    this._placeWall(edge.row, edge.col);
  }

  onMouseMove(row: number, col: number, edge: EdgeInfo | null) {
    if (!this.dragging || this.cancelled) return;
    const dir = this.lockedDir;
    const hoverRow = edge ? edge.row : row;
    const hoverCol = edge ? edge.col : col;

    let targetRow: number = hoverRow,
      targetCol: number = hoverCol;
    if (dir === 'north' || dir === 'south') {
      targetRow = this.startRow;
      targetCol = hoverCol;
    } else if (dir === 'east' || dir === 'west') {
      targetRow = hoverRow;
      targetCol = this.startCol;
    } else if (dir === 'nw-se') {
      const dr = hoverRow - this.startRow;
      const dc = hoverCol - this.startCol;
      const steps = Math.abs(dr) >= Math.abs(dc) ? dr : dc;
      targetRow = this.startRow + steps;
      targetCol = this.startCol + steps;
    } else if (dir === 'ne-sw') {
      const dr = hoverRow - this.startRow;
      const dc = hoverCol - this.startCol;
      const steps = Math.abs(dr) >= Math.abs(dc) ? dr : -dc;
      targetRow = this.startRow + steps;
      targetCol = this.startCol - steps;
    }

    if (dir) state.hoveredEdge = { direction: dir, row: targetRow, col: targetCol };

    this._fillLine(targetRow, targetCol);
    requestRender();
  }

  onMouseUp() {
    if (!this.dragging) return;
    this.dragging = false;

    // Push a compact patch entry with all accumulated changes
    if (this._beforeStates.size > 0 && !this.cancelled) {
      const cells = state.dungeon.cells;
      const patches: UndoCellPatch[] = [];
      for (const [key, before] of this._beforeStates) {
        const [r, c] = key.split(',').map(Number) as [number, number];
        patches.push({ row: r, col: c, before, after: cloneCell(cells[r]?.[c] ?? null) });
      }
      pushPatchUndo('Add wall', patches);
    }

    this._beforeStates = new Map();
    this.lockedDir = null;
  }

  onRightClick(row: number, col: number, edge: EdgeInfo | null) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;

    if (!isInBounds(cells, er, ec)) return;
    if (!cells[er]?.[ec]) return;
    if (!getEdge(cells[er][ec], direction as Direction)) return; // nothing to clear

    // Capture before-states for cell + reciprocal
    const coords: Array<{ row: number; col: number }> = [{ row: er, col: ec }];
    const offset = (CARDINAL_OFFSETS as unknown as Record<string, [number, number]>)[direction] as
      | [number, number]
      | undefined;
    if (offset && isInBounds(cells, er + offset[0], ec + offset[1])) {
      coords.push({ row: er + offset[0], col: ec + offset[1] });
    }

    const patches: UndoCellPatch[] = coords.map(({ row: r, col: c }) => ({
      row: r,
      col: c,
      before: cloneCell(cells[r]?.[c] ?? null),
      after: null,
    }));

    const before = captureBeforeState(cells, coords);
    deleteEdgeReciprocal(cells, er, ec, direction);

    // Fill in after-states
    for (const p of patches) {
      p.after = cloneCell(cells[p.row]?.[p.col] ?? null);
    }
    pushPatchUndo('Remove wall', patches);

    invalidateLightmap();
    smartInvalidate(before, cells);
    markDirty();
  }

  onCancel() {
    if (!this.dragging) return false;

    // Revert all cells from before-states
    if (this._beforeStates.size > 0) {
      const cells = state.dungeon.cells;
      const coords: Array<{ row: number; col: number }> = [];
      for (const [key, before] of this._beforeStates) {
        const [r, c] = key.split(',').map(Number) as [number, number];
        cells[r]![c] = before ? (JSON.parse(JSON.stringify(before)) as Cell) : null;
        coords.push({ row: r, col: c });
      }
      if (coords.length > 0) {
        invalidateLightmap();
        const renderBefore = captureBeforeState(cells, coords);
        smartInvalidate(renderBefore, cells);
        markDirty();
      }
    }

    this.dragging = false;
    this.cancelled = true;
    this._beforeStates = new Map();
    this.lockedDir = null;
    requestRender();
    return true;
  }

  /** Fill walls along the locked axis from start to (endRow, endCol) */
  _fillLine(endRow: number, endCol: number) {
    const dir = this.lockedDir;

    if (dir === 'north' || dir === 'south') {
      const r = this.startRow;
      const c1 = Math.min(this.startCol, endCol);
      const c2 = Math.max(this.startCol, endCol);
      for (let c = c1; c <= c2; c++) {
        this._placeWall(r, c);
      }
    } else if (dir === 'east' || dir === 'west') {
      const c = this.startCol;
      const r1 = Math.min(this.startRow, endRow);
      const r2 = Math.max(this.startRow, endRow);
      for (let r = r1; r <= r2; r++) {
        this._placeWall(r, c);
      }
    } else if (dir === 'nw-se') {
      const steps = endRow - this.startRow;
      const count = Math.abs(steps);
      const sign = steps >= 0 ? 1 : -1;
      for (let i = 0; i <= count; i++) {
        this._placeWall(this.startRow + i * sign, this.startCol + i * sign);
      }
    } else if (dir === 'ne-sw') {
      const steps = endRow - this.startRow;
      const count = Math.abs(steps);
      const sign = steps >= 0 ? 1 : -1;
      for (let i = 0; i <= count; i++) {
        this._placeWall(this.startRow + i * sign, this.startCol - i * sign);
      }
    }
  }

  /** Capture before-state for a cell if not already captured. */
  _captureBefore(cells: CellGrid, row: number, col: number) {
    const key = `${row},${col}`;
    if (!this._beforeStates.has(key)) {
      this._beforeStates.set(key, cloneCell(cells[row]?.[col] ?? null));
    }
  }

  _placeWall(row: number, col: number) {
    const cells = state.dungeon.cells;
    const direction = this.lockedDir!;
    const wallType = (state.wallType || 'w') as EdgeValue;

    if (!isInBounds(cells, row, col)) return;
    if (!cells[row]![col]) return;
    const existing = cells[row]![col];
    if ((existing as Record<string, unknown>)[direction] === wallType) return;
    if (
      (existing as Record<string, unknown>)[direction] === 'd' ||
      (existing as Record<string, unknown>)[direction] === 's' ||
      (existing as Record<string, unknown>)[direction] === 'id'
    )
      return;

    // Capture before-states for this cell and its reciprocal neighbor
    this._captureBefore(cells, row, col);
    const offset = (CARDINAL_OFFSETS as unknown as Record<string, [number, number]>)[direction] as
      | [number, number]
      | undefined;
    if (offset && isInBounds(cells, row + offset[0], col + offset[1])) {
      this._captureBefore(cells, row + offset[0], col + offset[1]);
    }

    const before = captureBeforeState(cells, [{ row, col }]);

    setEdgeReciprocal(cells, row, col, direction, wallType);

    invalidateLightmap();
    smartInvalidate(before, cells);
    markDirty();
  }
}
