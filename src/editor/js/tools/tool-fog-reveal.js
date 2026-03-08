// Tool: drag to reveal a rectangular region of cells to players.
import { Tool } from './tool-base.js';
import { sessionState, revealRect } from '../dm-session.js';
import { requestRender } from '../canvas-view.js';
import state, { notify } from '../state.js';
import { toCanvas } from '../utils.js';

export class FogRevealTool extends Tool {
  constructor() {
    super('fog-reveal', 'F', 'crosshair');
    this.dragging = false;
    this.dragStart = null;  // { row, col }
    this.dragEnd   = null;  // { row, col }
    this._prevDmView = false;
  }

  onActivate() {
    this._prevDmView = sessionState.dmViewActive;
    sessionState.dmViewActive = true;
    state.statusInstruction = 'Drag to reveal cells to players';
    requestRender();
    notify();
  }

  onDeactivate() {
    this.dragging = false;
    this.dragStart = this.dragEnd = null;
    sessionState.dmViewActive = this._prevDmView;
    state.statusInstruction = null;
    requestRender();
    notify();
  }

  onMouseDown(row, col) {
    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd   = { row, col };
    requestRender();
  }

  onMouseMove(row, col) {
    if (!this.dragging) return;
    this.dragEnd = { row, col };
    requestRender();
  }

  onMouseUp(row, col) {
    if (!this.dragging) return;
    this.dragging = false;
    const { row: r1, col: c1 } = this.dragStart;
    this.dragStart = this.dragEnd = null;
    revealRect(r1, c1, row, col);
    notify();
  }

  renderOverlay(ctx, transform, gridSize) {
    if (!this.dragging || !this.dragStart || !this.dragEnd) return;
    const cs = gridSize * transform.scale;
    const minRow = Math.min(this.dragStart.row, this.dragEnd.row);
    const maxRow = Math.max(this.dragStart.row, this.dragEnd.row);
    const minCol = Math.min(this.dragStart.col, this.dragEnd.col);
    const maxCol = Math.max(this.dragStart.col, this.dragEnd.col);
    const { x, y } = toCanvas(minCol * gridSize, minRow * gridSize, transform);
    const w = (maxCol - minCol + 1) * cs;
    const h = (maxRow - minRow + 1) * cs;
    ctx.save();
    ctx.fillStyle   = 'rgba(255, 220, 80, 0.18)';
    ctx.strokeStyle = 'rgba(255, 200, 50, 0.95)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
    ctx.restore();
  }
}
