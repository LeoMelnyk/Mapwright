import type { Cell, RenderTransform } from '../../../types.js';
// Trim tool: click+drag to create multi-cell diagonal trims
//
// Drag direction auto-detects the corner (default "auto" mode):
//   Drag up-left → NW trim, drag up-right → NE, down-left → SW, down-right → SE
// Manual corner override available via toolbar buttons.
//
// For a size-N trim at corner C:
//   - N cells along the hypotenuse get diagonal borders + trim properties
//   - Interior cells (between hypotenuse and corner) get voided to null
//   - If rounded, all hypotenuse cells share the same arc center + radius

import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { mutate } from '../state.js';
import { toCanvas } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import { computeTrimCells, CARDINAL_OFFSETS, type TrimCorner, type TrimPreview } from '../../../util/index.js';

/**
 * Trim tool: click+drag to create multi-cell diagonal or arc trims on room corners.
 * Auto-detects corner direction from drag gesture.
 */
export class TrimTool extends Tool {
  dragging: boolean = false;
  dragStart: { row: number; col: number } | null = null;
  dragEnd: { row: number; col: number } | null = null;
  previewCells: TrimPreview | null = null;
  resolvedCorner: TrimCorner | null = null;
  hoverPos: { x: number; y: number } | null = null;
  hoverCorner: TrimCorner | null = null;

  constructor() {
    super('trim', 'T', 'crosshair');
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.previewCells = null;
    this.resolvedCorner = null;
    this.hoverPos = null;
    this.hoverCorner = null;
  }

  onActivate() {
    state.statusInstruction =
      'Drag from room corner to set trim size · R to round · I to invert · O to open · Right-click to remove';
  }

  onDeactivate() {
    this.dragging = false;
    this.previewCells = null;
    state.statusInstruction = null;
  }

  /**
   * Cancel an in-progress drag. Called by canvas-view on right-click during drag.
   * Returns true if a drag was cancelled, false otherwise.
   */
  onCancel() {
    if (!this.dragging) return false;
    this.dragging = false;
    this.previewCells = null;
    this.resolvedCorner = null;
    return true;
  }

  onMouseDown(row: number, col: number) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length ?? 0)) return;

    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.resolvedCorner = state.trimCorner === 'auto' ? (this.hoverCorner ?? 'nw') : (state.trimCorner as TrimCorner);
    this._updatePreview();
  }

  onMouseMove(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
    this.hoverPos = pos ?? null;
    if (!this.dragging) return;
    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length ?? 1) - 1, col));
    this.dragEnd = { row, col };

    // Auto-detect corner from drag direction
    if (state.trimCorner === 'auto') {
      const dr = this.dragEnd.row - this.dragStart!.row;
      const dc = this.dragEnd.col - this.dragStart!.col;
      // Only update direction once the mouse has moved at least 1 cell
      if (dr !== 0 || dc !== 0) {
        if (dr <= 0 && dc <= 0) this.resolvedCorner = 'nw';
        else if (dr <= 0 && dc >= 0) this.resolvedCorner = 'ne';
        else if (dr >= 0 && dc <= 0) this.resolvedCorner = 'sw';
        else this.resolvedCorner = 'se';
      }
    } else {
      this.resolvedCorner = state.trimCorner as TrimCorner;
    }

    this._updatePreview();
    requestRender();
  }

  onMouseUp() {
    if (!this.dragging) return;
    this.dragging = false;

    const preview = this.previewCells;
    if (!preview || preview.hypotenuse.length === 0) {
      this.previewCells = null;
      return;
    }

    const cells = state.dungeon.cells;

    // All cells that will be mutated
    const allCoords = [...preview.voided, ...preview.hypotenuse, ...(preview.insideArc ?? [])];

    const corner = this.resolvedCorner;
    const isRound = state.trimRound;
    const isInverted = state.trimInverted;

    const reciprocals = { north: 'south', south: 'north', east: 'west', west: 'east' };
    const offsets = CARDINAL_OFFSETS;
    const allDirs = ['north', 'south', 'east', 'west'];

    // Helper: clear all cardinal/diagonal walls and their reciprocals
    const clearWalls = (cell: Cell, r: number, c: number) => {
      for (const dir of allDirs) {
        if ((cell as Record<string, unknown>)[dir]) {
          delete (cell as Record<string, unknown>)[dir];
          const [dr, dc] = (offsets as unknown as Record<string, [number, number]>)[dir]!;
          const neighbor = cells[r + dr]?.[c + dc];
          if (neighbor) delete (neighbor as Record<string, unknown>)[(reciprocals as Record<string, string>)[dir]!];
        }
      }
      delete cell['nw-se'];
      delete cell['ne-sw'];
    };

    // Helper: remove all old-format trim flags from a cell
    const clearOldTrimFlags = (cell: Cell) => {
      delete cell.trimRound;
      delete (cell as Record<string, unknown>).trimArcCenterRow;
      delete (cell as Record<string, unknown>).trimArcCenterCol;
      delete (cell as Record<string, unknown>).trimArcRadius;
      delete (cell as Record<string, unknown>).trimArcInverted;
      delete (cell as Record<string, unknown>).trimInsideArc;
      delete cell.trimCorner;
      delete (cell as Record<string, unknown>).trimOpen;
      delete (cell as Record<string, unknown>).trimInverted;
      delete cell.trimClip;
      delete cell.trimWall;
      delete cell.trimPassable;
      delete cell.trimCrossing;
    };

    mutate(
      'Place trim',
      allCoords,
      () => {
        if (isRound) {
          // ── Round trim: per-cell data from computeTrimCells ──
          const trimData = computeTrimCells(preview, corner!, isInverted, state.trimOpen);
          const numRows = cells.length;
          const numCols = cells[0]?.length ?? 0;

          const trimZone = new Set([
            ...preview.voided.map((c) => `${c.row},${c.col}`),
            ...preview.hypotenuse.map((c) => `${c.row},${c.col}`),
            ...(preview.insideArc ?? []).map((c) => `${c.row},${c.col}`),
          ]);

          for (const [key, val] of trimData) {
            const [r, c] = key.split(',').map(Number) as [number, number];
            if (r < 0 || r >= numRows || c < 0 || c >= numCols) continue;
            const inZone = trimZone.has(key);

            if (val === null) {
              cells[r]![c] = null;
            } else if (val === 'interior') {
              if (inZone) {
                cells[r]![c] ??= {};
                const cell = cells[r]![c];
                clearWalls(cell, r, c);
                clearOldTrimFlags(cell);
              }
            } else if ((val as unknown as string) === 'diagonal') {
              cells[r]![c] ??= {};
              const cell = cells[r]![c];
              if (inZone) clearWalls(cell, r, c);
              clearOldTrimFlags(cell);
              cell.trimCorner = corner!;
              if (corner === 'nw' || corner === 'se') cell['ne-sw'] = 'w';
              else cell['nw-se'] = 'w';
              if (state.trimOpen) cell.trimOpen = true;
            } else {
              cells[r]![c] ??= {};
              const cell = cells[r]![c];
              if (inZone) clearWalls(cell, r, c);
              clearOldTrimFlags(cell);
              Object.assign(cell, val);
            }
          }
        } else {
          // ── Straight trim ──
          if (!state.trimOpen) {
            for (const { row: r, col: c } of preview.voided) {
              cells[r]![c] = null;
            }
          } else {
            for (const { row: r, col: c } of preview.voided) {
              const cell = cells[r]?.[c];
              if (!cell) continue;
              clearWalls(cell, r, c);
              clearOldTrimFlags(cell);
            }
          }

          for (const { row: r, col: c } of preview.hypotenuse) {
            cells[r]![c] ??= {};
            const cell = cells[r]![c];
            cell.trimCorner = corner!;
            clearWalls(cell, r, c);
            if (corner === 'nw' || corner === 'se') {
              cell['ne-sw'] = 'w';
            } else {
              cell['nw-se'] = 'w';
            }
            if (state.trimOpen) cell.trimOpen = true;
            else delete cell.trimOpen;
          }
        }
      },
      { invalidate: ['lighting'], forceGeometry: true },
    );

    this.previewCells = null;
    requestRender();
  }

  /**
   * Compute preview from drag start/end and resolved corner.
   */
  _updatePreview() {
    const corner = this.resolvedCorner;
    const { row: r0, col: c0 } = this.dragStart!;
    const { row: r1, col: c1 } = this.dragEnd!;

    // Size = max distance along row or col axis + 1
    const size = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0)) + 1;

    const hypotenuse: { row: number; col: number }[] = [];
    let voided: { row: number; col: number }[] = [];
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length ?? 0;

    // The click cell (r0,c0) is the corner tip (part of the void).
    // The hypotenuse is the diagonal edge separating room from void.
    // Indexed so hyp[0] has 0 void cells, hyp[N-1] has N-1 void cells.
    //
    // Row direction: south corners (sw/se) → click at bottom, hyp starts at top
    //                north corners (nw/ne) → click at top, hyp starts at bottom
    // Col direction: east corners (ne/se) → hyp col = c0-i (going west from click)
    //                west corners (nw/sw) → hyp col = c0+i (going east from click)
    const far = size - 1;

    for (let i = 0; i < size; i++) {
      let hr = 0,
        hc = 0;
      switch (corner) {
        case 'se':
          hr = r0 - far + i;
          hc = c0 - i;
          break;
        case 'nw':
          hr = r0 + far - i;
          hc = c0 + i;
          break;
        case 'ne':
          hr = r0 + far - i;
          hc = c0 - i;
          break;
        case 'sw':
          hr = r0 - far + i;
          hc = c0 + i;
          break;
        case null:
          break;
      }
      if (hr < 0 || hr >= numRows || hc < 0 || hc >= numCols) continue;
      hypotenuse.push({ row: hr, col: hc });
    }

    // Void: triangle between hypotenuse and click corner.
    // At hyp index i, there are i void cells filling back toward the click column.
    for (let i = 1; i < size; i++) {
      for (let j = 0; j < i; j++) {
        let vr = 0,
          vc = 0;
        switch (corner) {
          case 'se':
            vr = r0 - far + i;
            vc = c0 - i + 1 + j;
            break;
          case 'nw':
            vr = r0 + far - i;
            vc = c0 + j;
            break;
          case 'ne':
            vr = r0 + far - i;
            vc = c0 - i + 1 + j;
            break;
          case 'sw':
            vr = r0 - far + i;
            vc = c0 + j;
            break;
          case null:
            break;
        }
        if (vr < 0 || vr >= numRows || vc < 0 || vc >= numCols) continue;
        voided.push({ row: vr, col: vc });
      }
    }

    // Arc center: grid intersection at the trim's corner
    let arcCenter = { row: r0, col: c0 };
    const allRows = hypotenuse.map((c) => c.row).concat(voided.map((c) => c.row));
    const allCols = hypotenuse.map((c) => c.col).concat(voided.map((c) => c.col));
    if (allRows.length > 0) {
      const minR = Math.min(...allRows);
      const maxR = Math.max(...allRows);
      const minC = Math.min(...allCols);
      const maxC = Math.max(...allCols);

      switch (corner) {
        case 'nw':
          arcCenter = { row: minR, col: minC };
          break;
        case 'ne':
          arcCenter = { row: minR, col: maxC + 1 };
          break;
        case 'sw':
          arcCenter = { row: maxR + 1, col: minC };
          break;
        case 'se':
          arcCenter = { row: maxR + 1, col: maxC + 1 };
          break;
        case null:
          break;
      }
    }

    // For rounded non-inverted trims: the arc curves inward relative to the
    // straight diagonal, so only cells completely outside the arc should be
    // voided. Cells between the diagonal and the arc remain as room floor,
    // but their existing cardinal/diagonal walls must be cleared (the arc is
    // now the wall).
    const insideArc: { row: number; col: number }[] = [];
    if (state.trimRound && !state.trimInverted && voided.length > 0) {
      let acxGrid = 0,
        acyGrid = 0;
      switch (corner) {
        case 'nw':
          acxGrid = arcCenter.col + size;
          acyGrid = arcCenter.row + size;
          break;
        case 'ne':
          acxGrid = arcCenter.col - size;
          acyGrid = arcCenter.row + size;
          break;
        case 'sw':
          acxGrid = arcCenter.col + size;
          acyGrid = arcCenter.row - size;
          break;
        case 'se':
          acxGrid = arcCenter.col - size;
          acyGrid = arcCenter.row - size;
          break;
        case null:
          break;
      }
      voided = voided.filter(({ row: vr, col: vc }) => {
        // Closest distance from cell [vc, vc+1] × [vr, vr+1] to arc pivot
        const dx = Math.max(vc - acxGrid, 0, acxGrid - (vc + 1));
        const dy = Math.max(vr - acyGrid, 0, acyGrid - (vr + 1));
        const outside = Math.sqrt(dx * dx + dy * dy) > size;
        if (!outside) insideArc.push({ row: vr, col: vc });
        return outside;
      });
    }

    this.previewCells = { hypotenuse, voided, insideArc, arcCenter, size };
  }

  onRightClick(row: number, col: number) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length ?? 0)) return;
    const cell = cells[row]![col];
    if (!cell?.trimCorner) return;

    mutate(
      'Remove Trim',
      [{ row, col }],
      () => {
        delete cell.trimCorner;
        delete cell.trimRound;
        delete cell.trimArcCenterRow;
        delete cell.trimArcCenterCol;
        delete cell.trimArcRadius;
        delete cell.trimArcInverted;
        delete cell.trimInsideArc;
        delete cell.trimOpen;
        delete cell.trimInverted;
        delete cell.trimClip;
        delete cell.trimWall;
        delete cell.trimPassable;
        delete cell.trimCrossing;
        delete cell['nw-se'];
        delete cell['ne-sw'];
      },
      { invalidate: ['lighting'], forceGeometry: true },
    );
    requestRender();
  }

  onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.dragging) {
      this.onCancel();
      requestRender();
      return;
    }
    const syncTrimButtons = (prop: string, val: boolean) => {
      document.querySelectorAll<HTMLElement>(`#trim-shape-options [data-trim="${prop}"]`).forEach((b) => {
        b.classList.toggle('active', b.dataset.val === String(val));
      });
    };
    if (e.key === 'r' || e.key === 'R') {
      state.trimRound = !state.trimRound;
      syncTrimButtons('round', state.trimRound);
    }
    if (e.key === 'i' || e.key === 'I') {
      state.trimInverted = !state.trimInverted;
      syncTrimButtons('inverted', state.trimInverted);
    }
    if (e.key === 'o' || e.key === 'O') {
      state.trimOpen = !state.trimOpen;
      syncTrimButtons('open', state.trimOpen);
    }
  }

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
    // Hover preview — show which corner will be trimmed before dragging
    if (!this.dragging && state.hoveredCell && this.hoverPos) {
      const { row, col } = state.hoveredCell;
      const cells = state.dungeon.cells;
      if (row >= 0 && row < cells.length && col >= 0 && col < (cells[0]?.length ?? 0) && cells[row]![col] !== null) {
        let corner: TrimCorner;
        if (state.trimCorner === 'auto') {
          // Determine corner from which quadrant of the cell the cursor is in
          const cellTL = toCanvas(col * gridSize, row * gridSize, transform);
          const cellPx = gridSize * transform.scale;
          const inEast = this.hoverPos.x - cellTL.x > cellPx / 2;
          const inSouth = this.hoverPos.y - cellTL.y > cellPx / 2;
          corner = inSouth ? (inEast ? 'se' : 'sw') : inEast ? 'ne' : 'nw';
        } else {
          corner = state.trimCorner as TrimCorner;
        }
        this.hoverCorner = corner; // remember for onMouseDown
        this._drawHoverPreview(ctx, transform, gridSize, row, col, corner);
      }
    }

    if (!this.previewCells) return;
    const { hypotenuse, voided } = this.previewCells;
    const corner = this.resolvedCorner;
    const cellPx = gridSize * transform.scale;

    // Voided cells: red normally, green in Open mode (floor preserved)
    ctx.fillStyle = state.trimOpen ? 'rgba(80, 200, 120, 0.15)' : 'rgba(255, 80, 80, 0.25)';
    for (const { row, col } of voided) {
      const p = toCanvas(col * gridSize, row * gridSize, transform);
      ctx.fillRect(p.x, p.y, cellPx, cellPx);
    }

    // Hypotenuse cells in yellow
    ctx.fillStyle = 'rgba(255, 200, 50, 0.3)';
    for (const { row, col } of hypotenuse) {
      const p = toCanvas(col * gridSize, row * gridSize, transform);
      ctx.fillRect(p.x, p.y, cellPx, cellPx);
    }

    // Diagonal lines on hypotenuse
    ctx.strokeStyle = 'rgba(255, 200, 50, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const { row, col } of hypotenuse) {
      const x = col * gridSize,
        y = row * gridSize;
      let p1, p2;
      if (corner === 'nw' || corner === 'se') {
        p1 = toCanvas(x + gridSize, y, transform);
        p2 = toCanvas(x, y + gridSize, transform);
      } else {
        p1 = toCanvas(x, y, transform);
        p2 = toCanvas(x + gridSize, y + gridSize, transform);
      }
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();

    // Arc preview if rounded
    this._drawArcPreview(ctx, transform, gridSize, corner!);
  }

  _drawHoverPreview(
    ctx: CanvasRenderingContext2D,
    transform: RenderTransform,
    gridSize: number,
    row: number,
    col: number,
    corner: TrimCorner,
  ) {
    const x = col * gridSize;
    const y = row * gridSize;
    const tl = toCanvas(x, y, transform);
    const tr = toCanvas(x + gridSize, y, transform);
    const bl = toCanvas(x, y + gridSize, transform);
    const br = toCanvas(x + gridSize, y + gridSize, transform);

    // Diagonal endpoints: NW/SE → NE-SW (tr→bl); NE/SW → NW-SE (tl→br)
    const isNESW = corner === 'nw' || corner === 'se';
    const dp1 = isNESW ? tr : tl;
    const dp2 = isNESW ? bl : br;

    // The void triangle is the corner being cut plus the two diagonal endpoints
    const voidTri = {
      nw: [tl, tr, bl],
      ne: [tl, tr, br],
      sw: [tl, bl, br],
      se: [tr, bl, br],
    }[corner];

    ctx.save();

    // Red void triangle — shows which part gets removed
    ctx.fillStyle = 'rgba(255, 80, 80, 0.28)';
    ctx.beginPath();
    ctx.moveTo(voidTri[0]!.x, voidTri[0]!.y);
    ctx.lineTo(voidTri[1]!.x, voidTri[1]!.y);
    ctx.lineTo(voidTri[2]!.x, voidTri[2]!.y);
    ctx.closePath();
    ctx.fill();

    // Yellow diagonal line — the wall that will be placed
    ctx.strokeStyle = 'rgba(255, 200, 50, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(dp1.x, dp1.y);
    ctx.lineTo(dp2.x, dp2.y);
    ctx.stroke();

    ctx.restore();
  }

  _drawArcPreview(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number, corner: TrimCorner) {
    const { arcCenter, size } = this.previewCells!;
    const R = size * gridSize;
    const Rpx = R * transform.scale;
    const cp = toCanvas(arcCenter.col * gridSize, arcCenter.row * gridSize, transform);

    ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();

    if (state.trimInverted) {
      switch (corner) {
        case 'nw':
          ctx.arc(cp.x, cp.y, Rpx, Math.PI / 2, 0, true);
          break;
        case 'ne':
          ctx.arc(cp.x, cp.y, Rpx, Math.PI / 2, Math.PI, false);
          break;
        case 'sw':
          ctx.arc(cp.x, cp.y, Rpx, 0, (3 * Math.PI) / 2, true);
          break;
        case 'se':
          ctx.arc(cp.x, cp.y, Rpx, Math.PI, (3 * Math.PI) / 2, false);
          break;
      }
    } else {
      let acx = 0,
        acy = 0;
      switch (corner) {
        case 'nw':
          acx = (arcCenter.col + size) * gridSize;
          acy = (arcCenter.row + size) * gridSize;
          break;
        case 'ne':
          acx = (arcCenter.col - size) * gridSize;
          acy = (arcCenter.row + size) * gridSize;
          break;
        case 'sw':
          acx = (arcCenter.col + size) * gridSize;
          acy = (arcCenter.row - size) * gridSize;
          break;
        case 'se':
          acx = (arcCenter.col - size) * gridSize;
          acy = (arcCenter.row - size) * gridSize;
          break;
      }
      const acp = toCanvas(acx, acy, transform);
      switch (corner) {
        case 'nw':
          ctx.arc(acp.x, acp.y, Rpx, (3 * Math.PI) / 2, Math.PI, true);
          break;
        case 'ne':
          ctx.arc(acp.x, acp.y, Rpx, (3 * Math.PI) / 2, 0, false);
          break;
        case 'sw':
          ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, Math.PI, false);
          break;
        case 'se':
          ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, 0, true);
          break;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
