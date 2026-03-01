// Room tool: click+drag to select a rectangle of cells, then auto-wall the boundary
//
// Basic mode: drag a rectangle → on mouseup, paint cells + wall outer edges + clear inner walls
// Shift: constrain the drag rectangle to a square (larger dimension wins)

import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, invalidateLightmap } from '../state.js';
import { captureBeforeState, smartInvalidate } from '../../../render/index.js';
import { toCanvas } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import { CARDINAL_DIRS, OPPOSITE, cellKey, parseCellKey, isInBounds, snapToSquare, normalizeBounds } from '../../../util/index.js';

export class RoomTool extends Tool {
  constructor() {
    super('room', 'R', 'crosshair');
    this.dragging = false;
    this.dragStart = null;  // {row, col}
    this.dragEnd = null;    // {row, col}
    this.mousePos = null;   // canvas pixel pos for size label
  }

  onActivate() {
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    state.statusInstruction = 'Right-click to void cell';
  }

  onDeactivate() {
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    state.statusInstruction = '';
  }

  onMouseDown(row, col) {
    const cells = state.dungeon.cells;
    if (!isInBounds(cells, row, col)) return;
    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.mousePos = null;
  }

  onMouseMove(row, col, _edge, event, pos) {
    if (!this.dragging) return;
    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length || 1) - 1, col));

    if (event?.shiftKey) {
      ({ row, col } = snapToSquare(row, col, this.dragStart.row, this.dragStart.col, cells));
    }

    this.dragEnd = { row, col };
    this.mousePos = pos || null;
    requestRender();
  }

  onMouseUp(row, col, _edge, event) {
    if (!this.dragging) return;
    this.dragging = false;

    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length || 1) - 1, col));

    if (event?.shiftKey) {
      ({ row, col } = snapToSquare(row, col, this.dragStart.row, this.dragStart.col, cells));
    }

    this.dragEnd = { row, col };
    this._applyWalls();

    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    requestRender();
  }

  onRightClick(row, col) {
    const cells = state.dungeon.cells;
    if (!isInBounds(cells, row, col)) return;
    if (cells[row][col] === null) return; // already void

    const before = captureBeforeState(cells, [{ row, col }]);
    pushUndo('Void cell');

    // Void the cell
    cells[row][col] = null;

    // Add walls to all adjacent non-void cells on the side facing this now-void cell
    const neighbors = [
      { dr: -1, dc: 0, wallDir: 'south' },  // north neighbor needs south wall
      { dr: 1, dc: 0, wallDir: 'north' },    // south neighbor needs north wall
      { dr: 0, dc: 1, wallDir: 'west' },     // east neighbor needs west wall
      { dr: 0, dc: -1, wallDir: 'east' },    // west neighbor needs east wall
    ];

    for (const { dr, dc, wallDir } of neighbors) {
      const nr = row + dr;
      const nc = col + dc;
      if (isInBounds(cells, nr, nc) && cells[nr][nc]) {
        cells[nr][nc][wallDir] = 'w';
      }
    }

    invalidateLightmap();
    smartInvalidate(before, cells);
    markDirty();
  }

  /**
   * Apply walls: paint all cells in the drag rect, wall outer edges, clear inner walls.
   * Merge mode: only wall edges facing void/OOB, clear walls against existing cells.
   */
  _applyWalls() {
    if (!this.dragStart || !this.dragEnd) return;

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row, this.dragStart.col, this.dragEnd.row, this.dragEnd.col);

    const selected = new Set();
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
    const rows = cells.length, cols = cells[0]?.length || 0;
    const coords = [];
    for (let r = Math.max(0, r1 - 1); r <= Math.min(rows - 1, r2 + 1); r++) {
      for (let c = Math.max(0, c1 - 1); c <= Math.min(cols - 1, c2 + 1); c++) {
        coords.push({ row: r, col: c });
      }
    }
    const before = captureBeforeState(cells, coords);

    pushUndo('Draw room');
    const has = (r, c) => selected.has(cellKey(r, c));

    for (const key of selected) {
      const [r, c] = parseCellKey(key);

      if (!cells[r][c]) cells[r][c] = {};
      const cell = cells[r][c];

      for (const { dir, dr, dc } of CARDINAL_DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        const inBounds_ = isInBounds(cells, nr, nc);
        const neighborCell = inBounds_ ? cells[nr][nc] : null;
        const reciprocal = OPPOSITE[dir];

        if (mergeMode) {
          if (!inBounds_ || !neighborCell) {
            if (cell[dir] !== 'd' && cell[dir] !== 's') cell[dir] = 'w';
          } else {
            if (cell[dir] !== 'd' && cell[dir] !== 's') delete cell[dir];
            if (neighborCell[reciprocal] !== 'd' && neighborCell[reciprocal] !== 's') delete neighborCell[reciprocal];
          }
        } else {
          if (has(nr, nc)) {
            if (cell[dir] !== 'd' && cell[dir] !== 's') delete cell[dir];
            if (neighborCell) {
              if (neighborCell[reciprocal] !== 'd' && neighborCell[reciprocal] !== 's') delete neighborCell[reciprocal];
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

    invalidateLightmap();
    smartInvalidate(before, cells);
    markDirty();
  }

  _drawSizeLabel(ctx, gridSize) {
    if (!this.mousePos || !this.dragStart || !this.dragEnd) return;
    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row, this.dragStart.col, this.dragEnd.row, this.dragEnd.col);
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

  renderOverlay(ctx, transform, gridSize) {
    if (!this.dragging || !this.dragStart || !this.dragEnd) return;

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row, this.dragStart.col, this.dragEnd.row, this.dragEnd.col);

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
        if (r === r1) { const p1 = toCanvas(x, y, transform), p2 = toCanvas(x + gridSize, y, transform); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
        if (r === r2) { const p1 = toCanvas(x, y + gridSize, transform), p2 = toCanvas(x + gridSize, y + gridSize, transform); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
        if (c === c1) { const p1 = toCanvas(x, y, transform), p2 = toCanvas(x, y + gridSize, transform); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
        if (c === c2) { const p1 = toCanvas(x + gridSize, y, transform), p2 = toCanvas(x + gridSize, y + gridSize, transform); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
      }
    }
    ctx.stroke();

    this._drawSizeLabel(ctx, gridSize);
  }
}
