import type { RenderTransform } from '../../../types.js';
// Room tool: click+drag to select a rectangle of cells, then auto-wall the boundary
//
// Basic mode: drag a rectangle → on mouseup, paint cells + wall outer edges + clear inner walls
// Shift: constrain the drag rectangle to a square (larger dimension wins)

import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { mutate } from '../state.js';
import { toCanvas } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import {
  CARDINAL_DIRS,
  OPPOSITE,
  cellKey,
  parseCellKey,
  isInBounds,
  snapToSquare,
  normalizeBounds,
} from '../../../util/index.js';

/**
 * Room tool: click+drag to paint cells and auto-wall the boundary rectangle.
 * Supports 'room' mode (walls on all edges) and 'merge' mode (walls only facing void).
 */
export class RoomTool extends Tool {
  dragging: boolean = false;
  dragStart: { row: number; col: number } | null = null;
  dragEnd: { row: number; col: number } | null = null;
  mousePos: { x: number; y: number } | null = null;

  constructor() {
    super('room', 'R', 'crosshair');
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
  }

  onActivate() {
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    state.statusInstruction =
      state.roomMode === 'merge'
        ? 'Drag over adjacent rooms to merge them into one'
        : 'Drag to draw room · Shift for square · Right-click to void';
  }

  onDeactivate() {
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    state.statusInstruction = '';
  }

  onMouseDown(row: number, col: number) {
    const cells = state.dungeon.cells;
    if (!isInBounds(cells, row, col)) return;
    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.mousePos = null;
  }

  onMouseMove(row: number, col: number, _edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
    if (!this.dragging) return;
    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length ?? 1) - 1, col));

    if (event.shiftKey) {
      ({ row, col } = snapToSquare(row, col, this.dragStart!.row, this.dragStart!.col, cells));
    }

    this.dragEnd = { row, col };
    this.mousePos = pos ?? null;
    requestRender();
  }

  onMouseUp(row: number, col: number, _edge: EdgeInfo | null, event: MouseEvent) {
    if (!this.dragging) return;
    this.dragging = false;

    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length ?? 1) - 1, col));

    if (event.shiftKey) {
      ({ row, col } = snapToSquare(row, col, this.dragStart!.row, this.dragStart!.col, cells));
    }

    this.dragEnd = { row, col };
    this._applyWalls();

    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    requestRender();
  }

  onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && this.dragging) {
      this._cancelDrag();
      event.preventDefault();
    }
  }

  onRightClick(row: number, col: number) {
    if (this.dragging) {
      this._cancelDrag();
      return;
    }

    const cells = state.dungeon.cells;
    if (!isInBounds(cells, row, col)) return;
    if (cells[row]![col] === null) return; // already void

    // Include target cell + neighbors in coords (neighbors get walls added)
    const neighborOffsets = [
      { dr: -1, dc: 0, wallDir: 'south' },
      { dr: 1, dc: 0, wallDir: 'north' },
      { dr: 0, dc: 1, wallDir: 'west' },
      { dr: 0, dc: -1, wallDir: 'east' },
    ];
    const coords: Array<{ row: number; col: number }> = [{ row, col }];
    for (const { dr, dc } of neighborOffsets) {
      if (isInBounds(cells, row + dr, col + dc)) coords.push({ row: row + dr, col: col + dc });
    }

    mutate(
      'Void cell',
      coords,
      () => {
        cells[row]![col] = null;
        for (const { dr, dc, wallDir } of neighborOffsets) {
          const nr = row + dr;
          const nc = col + dc;
          if (isInBounds(cells, nr, nc) && cells[nr]![nc]) {
            (cells[nr]![nc] as Record<string, unknown>)[wallDir] = 'w';
          }
        }
      },
      { invalidate: ['lighting'] },
    );
  }

  _cancelDrag() {
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    requestRender();
  }

  /**
   * Apply walls: paint all cells in the drag rect, wall outer edges, clear inner walls.
   * Merge mode: only wall edges facing void/OOB, clear walls against existing cells.
   */
  _applyWalls() {
    if (!this.dragStart || !this.dragEnd) return;

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row,
      this.dragStart.col,
      this.dragEnd.row,
      this.dragEnd.col,
    );

    const selected = new Set<string>();
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        selected.add(cellKey(r, c));
      }
    }

    if (selected.size === 0) return;

    const mergeMode = state.roomMode === 'merge';
    const cells = state.dungeon.cells;

    // Capture before state for all selected cells plus their 1-cell border
    // (the border cells may also be modified when mirroring outer walls)
    const rows = cells.length,
      cols = cells[0]?.length ?? 0;
    const coords = [];
    for (let r = Math.max(0, r1 - 1); r <= Math.min(rows - 1, r2 + 1); r++) {
      for (let c = Math.max(0, c1 - 1); c <= Math.min(cols - 1, c2 + 1); c++) {
        coords.push({ row: r, col: c });
      }
    }
    mutate(
      'Draw room',
      coords,
      () => {
        const has = (r: number, c: number) => selected.has(cellKey(r, c));

        for (const key of selected) {
          const [r, c] = parseCellKey(key);

          cells[r]![c] ??= {};
          const cell = cells[r]![c];

          for (const { dir, dr, dc } of CARDINAL_DIRS) {
            const nr = r + dr;
            const nc = c + dc;
            const inBounds_ = isInBounds(cells, nr, nc);
            const neighborCell = inBounds_ ? cells[nr]![nc] : null;
            const reciprocal = OPPOSITE[dir];

            if (mergeMode) {
              if (!inBounds_ || !neighborCell) {
                if (cell[dir] !== 'd' && cell[dir] !== 's') cell[dir] = 'w';
              } else {
                if (cell[dir] !== 'd' && cell[dir] !== 's') delete cell[dir];
                if (neighborCell[reciprocal] !== 'd' && neighborCell[reciprocal] !== 's')
                  delete neighborCell[reciprocal];
              }
            } else {
              if (has(nr, nc)) {
                if (cell[dir] !== 'd' && cell[dir] !== 's') delete cell[dir];
                if (neighborCell) {
                  if (neighborCell[reciprocal] !== 'd' && neighborCell[reciprocal] !== 's')
                    delete neighborCell[reciprocal];
                }
              } else {
                if (cell[dir] !== 'd' && cell[dir] !== 's') cell[dir] = 'w';
                if (neighborCell && neighborCell[reciprocal] !== 'd' && neighborCell[reciprocal] !== 's') {
                  neighborCell[reciprocal] = 'w';
                }
              }
            }
          }
        }
      },
      { invalidate: ['lighting'] },
    );
  }

  _drawSizeLabel(ctx: CanvasRenderingContext2D, gridSize: number) {
    if (!this.mousePos || !this.dragStart || !this.dragEnd) return;
    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row,
      this.dragStart.col,
      this.dragEnd.row,
      this.dragEnd.col,
    );
    const wFt = (c2 - c1 + 1) * gridSize;
    const hFt = (r2 - r1 + 1) * gridSize;
    const label = `${wFt} ft × ${hFt} ft`;

    ctx.save();
    ctx.font = 'bold 12px sans-serif';
    const pad = 5;
    const boxW = ctx.measureText(label).width + pad * 2;
    const boxH = 20;
    const bx = this.mousePos.x + 12;
    const by = this.mousePos.y - 12 - boxH;

    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + pad, by + boxH / 2);
    ctx.restore();
  }

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
    if (!this.dragging || !this.dragStart || !this.dragEnd) return;

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row,
      this.dragStart.col,
      this.dragEnd.row,
      this.dragEnd.col,
    );

    const cellPx = gridSize * transform.scale;

    // Fill selected cells
    ctx.fillStyle = 'rgba(80, 200, 120, 0.25)';
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const p = toCanvas(c * gridSize, r * gridSize, transform);
        ctx.fillRect(p.x, p.y, cellPx, cellPx);
      }
    }

    // Draw boundary (where walls will go)
    ctx.strokeStyle = 'rgba(80, 200, 120, 0.9)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const x = c * gridSize;
        const y = r * gridSize;
        if (r === r1) {
          const p1 = toCanvas(x, y, transform),
            p2 = toCanvas(x + gridSize, y, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        if (r === r2) {
          const p1 = toCanvas(x, y + gridSize, transform),
            p2 = toCanvas(x + gridSize, y + gridSize, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        if (c === c1) {
          const p1 = toCanvas(x, y, transform),
            p2 = toCanvas(x, y + gridSize, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        if (c === c2) {
          const p1 = toCanvas(x + gridSize, y, transform),
            p2 = toCanvas(x + gridSize, y + gridSize, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
      }
    }
    ctx.stroke();

    this._drawSizeLabel(ctx, gridSize);
  }
}
