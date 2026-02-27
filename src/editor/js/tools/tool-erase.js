// Erase tool: drag a selection box, then void all cells within it on release
// Shift: constrain the drag rectangle to a square (larger dimension wins)
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, invalidateLightmap } from '../state.js';
import { captureBeforeState, smartInvalidate } from '../../../render/index.js';
import { toCanvas } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import { isInBounds, snapToSquare, normalizeBounds } from '../../../util/index.js';

export class EraseTool extends Tool {
  constructor() {
    super('erase', 'E', 'crosshair');
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
  }

  onMouseDown(row, col) {
    const cells = state.dungeon.cells;
    if (!isInBounds(cells, row, col)) return;
    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.mousePos = null;
    requestRender();
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

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row, this.dragStart.col, this.dragEnd.row, this.dragEnd.col);

    const eraseMode = state.eraseMode || 'all';

    let hasContent = false;
    for (let r = r1; r <= r2 && !hasContent; r++) {
      for (let c = c1; c <= c2 && !hasContent; c++) {
        if (eraseMode === 'texture') {
          if (cells[r][c]?.texture) hasContent = true;
        } else {
          if (cells[r][c] !== null) hasContent = true;
        }
      }
    }

    if (hasContent) {
      const coords = [];
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) coords.push({ row: r, col: c });
      }
      const before = captureBeforeState(cells, coords);

      pushUndo();
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (eraseMode === 'texture') {
            if (cells[r][c]) {
              delete cells[r][c].texture;
              delete cells[r][c].textureOpacity;
            }
          } else {
            cells[r][c] = null;
          }
        }
      }
      invalidateLightmap();
      smartInvalidate(before, cells);
      markDirty();
    }

    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    requestRender();
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
    const topLeft = toCanvas(c1 * gridSize, r1 * gridSize, transform);
    const w = (c2 - c1 + 1) * cellPx;
    const h = (r2 - r1 + 1) * cellPx;

    ctx.fillStyle = 'rgba(255, 80, 80, 0.20)';
    ctx.fillRect(topLeft.x, topLeft.y, w, h);

    ctx.strokeStyle = 'rgba(255, 80, 80, 0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(topLeft.x, topLeft.y, w, h);

    this._drawSizeLabel(ctx, gridSize);
  }
}
