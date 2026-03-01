// Erase tool: drag a selection box, then void all cells within it on release
// Shift: constrain the drag rectangle to a square (larger dimension wins)
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, invalidateLightmap } from '../state.js';
import { captureBeforeState, smartInvalidate } from '../../../render/index.js';
import { toCanvas } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import { showToast } from '../toast.js';
import { isInBounds, snapToSquare, normalizeBounds } from '../../../util/index.js';

function _removeStair(meta, cells, id) {
  const stairs = meta?.stairs;
  if (!stairs) return;
  const idx = stairs.findIndex(s => s.id === id);
  if (idx === -1) return;
  const stairDef = stairs[idx];

  // Unlink partner
  if (stairDef.link) {
    const partner = stairs.find(s => s.link === stairDef.link && s.id !== id);
    if (partner) partner.link = null;
  }

  stairs.splice(idx, 1);

  // Clear stair-id from any cells outside the erased region that still reference it
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      if (cells[r]?.[c]?.center?.['stair-id'] === id) {
        delete cells[r][c].center['stair-id'];
        if (Object.keys(cells[r][c].center).length === 0) delete cells[r][c].center;
      }
    }
  }
}

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

      // Collect stair IDs before cells are nulled (stairs span multiple cells)
      const stairIdsToRemove = new Set();
      if (eraseMode !== 'texture') {
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            const id = cells[r]?.[c]?.center?.['stair-id'];
            if (id != null) stairIdsToRemove.add(id);
          }
        }
      }

      pushUndo(eraseMode === 'texture' ? 'Erase texture' : 'Erase cells');
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

      if (eraseMode !== 'texture') {
        const meta = state.dungeon.metadata;

        // Remove stair definitions (and unlink partners)
        for (const id of stairIdsToRemove) {
          _removeStair(meta, cells, id);
        }

        // Remove bridges with any point inside the erased region
        if (meta.bridges?.length) {
          meta.bridges = meta.bridges.filter(bridge =>
            !bridge.points.some(([r, c]) => r >= r1 && r <= r2 && c >= c1 && c <= c2)
          );
        }
      }

      invalidateLightmap();
      smartInvalidate(before, cells);
      markDirty();

      if (stairIdsToRemove.size > 0) {
        showToast('Linked stairs were unlinked');
      }
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
