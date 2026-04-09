import type { CellGrid, RenderTransform, Metadata } from '../../../types.js';
// Erase tool: drag a selection box, then void all cells within it on release
// Shift: constrain the drag rectangle to a square (larger dimension wins)
import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { pushUndo, markDirty, notify, invalidateLightmap } from '../state.js';
import { captureBeforeState, smartInvalidate, accumulateDirtyRect } from '../../../render/index.js';
import { toCanvas } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import { showToast } from '../toast.js';
import { isInBounds, snapToSquare, normalizeBounds } from '../../../util/index.js';

function _removeStair(meta: Metadata, cells: CellGrid, id: number): void {
  const stairs = meta.stairs;
  const idx = stairs.findIndex((s: { id: number }) => s.id === id);
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
        delete cells[r][c]!.center!['stair-id'];
        if (Object.keys(cells[r][c]!.center!).length === 0) delete cells[r][c]!.center;
      }
    }
  }
}

/**
 * Erase tool: drag a selection box to void all cells within it on release.
 * Also removes associated stairs, bridges, props, and lights.
 */
export class EraseTool extends Tool {
  declare dragging: boolean;
  declare dragStart: { row: number; col: number } | null;
  declare dragEnd: { row: number; col: number } | null;
  declare mousePos: { x: number; y: number } | null;

  constructor() {
    super('erase', 'E', 'crosshair');
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
  }

  onActivate() {
    state.statusInstruction = 'Drag to erase cells · Shift to constrain to square';
  }

  onDeactivate() {
    state.statusInstruction = null;
  }

  onMouseDown(row: number, col: number) {
    const cells = state.dungeon.cells;
    if (!isInBounds(cells, row, col)) return;
    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.mousePos = null;
    requestRender();
  }

  onMouseMove(row: number, col: number, _edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
    if (!this.dragging) return;
    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length || 1) - 1, col));

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
    col = Math.max(0, Math.min((cells[0]?.length || 1) - 1, col));

    if (event.shiftKey) {
      ({ row, col } = snapToSquare(row, col, this.dragStart!.row, this.dragStart!.col, cells));
    }

    this.dragEnd = { row, col };

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart!.row, this.dragStart!.col, this.dragEnd.row, this.dragEnd.col);

    let hasContent = false;
    for (let r = r1; r <= r2 && !hasContent; r++) {
      for (let c = c1; c <= c2 && !hasContent; c++) {
        if (cells[r][c] !== null) hasContent = true;
      }
    }

    if (hasContent) {
      const coords = [];
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) coords.push({ row: r, col: c });
      }
      const before = captureBeforeState(cells, coords);

      // Collect stair IDs before cells are nulled (stairs span multiple cells)
      const stairIdsToRemove = new Set<number>();
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const id = cells[r]?.[c]?.center?.['stair-id'];
          if (id != null) stairIdsToRemove.add(id);
        }
      }

      // Expand dirty region to cover multi-cell props that extend beyond the erase box
      const dirtyR1 = r1, dirtyC1 = c1;
      let dirtyR2 = r2, dirtyC2 = c2;
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const prop = cells[r]?.[c]?.prop;
          if (prop?.span) {
            const sr = prop.span[0] || 1, scc = prop.span[1] || 1;
            if (r + sr - 1 > dirtyR2) dirtyR2 = r + sr - 1;
            if (c + scc - 1 > dirtyC2) dirtyC2 = c + scc - 1;
          }
        }
      }
      accumulateDirtyRect(dirtyR1, dirtyC1, dirtyR2, dirtyC2);

      pushUndo('Erase cells');
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          cells[r][c] = null;
        }
      }

      const meta = state.dungeon.metadata;

      // Remove stair definitions (and unlink partners)
      for (const id of stairIdsToRemove) {
        _removeStair(meta, cells, id);
      }

      // Remove bridges with any point inside the erased region
      if (meta.bridges.length) {
        meta.bridges = meta.bridges.filter(bridge =>
          !bridge.points.some(([r, c]) => r >= r1 && r <= r2 && c >= c1 && c <= c2)
        );
      }

      // Remove overlay props whose anchor falls inside the erased region
      if (meta.props?.length) {
        const gridSize = meta.gridSize || 5;
        meta.props = meta.props.filter(p => {
          const pRow = Math.round(p.y / gridSize);
          const pCol = Math.round(p.x / gridSize);
          return pRow < r1 || pRow > r2 || pCol < c1 || pCol > c2;
        });
      }

      // Remove lights whose world position or prop anchor falls inside the erased region
      if (meta.lights.length) {
        const gridSize = meta.gridSize || 5;
        meta.lights = meta.lights.filter(light => {
          // Position-based: light center in erased region
          const lightRow = Math.floor(light.y / gridSize);
          const lightCol = Math.floor(light.x / gridSize);
          if (lightRow >= r1 && lightRow <= r2 && lightCol >= c1 && lightCol <= c2) return false;
          // PropRef-based: prop anchor in erased region (covers multi-cell props)
          if (light.propRef) {
            const { row: pr, col: pc } = light.propRef;
            if (pr >= r1 && pr <= r2 && pc >= c1 && pc <= c2) return false;
          }
          return true;
        });
        if (state.selectedLightId != null &&
            !meta.lights.find(l => l.id === state.selectedLightId)) {
          state.selectedLightId = null;
        }
      }

      invalidateLightmap();
      smartInvalidate(before, cells);
      markDirty();
      notify();

      if (stairIdsToRemove.size > 0) {
        showToast('Linked stairs were unlinked');
      }
    }

    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    requestRender();
  }

  _drawSizeLabel(ctx: CanvasRenderingContext2D, gridSize: number) {
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

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
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
