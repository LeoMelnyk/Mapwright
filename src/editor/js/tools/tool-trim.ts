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

import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, invalidateLightmap } from '../state.js';
import { captureBeforeState, smartInvalidate } from '../../../render/index.js';
import { toCanvas } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import { computeTrimCells } from '../../../util/index.js';

/**
 * Trim tool: click+drag to create multi-cell diagonal or arc trims on room corners.
 * Auto-detects corner direction from drag gesture.
 */
export class TrimTool extends Tool {
  [key: string]: any;
  declare dragging: boolean;
  declare dragStart: { row: number; col: number } | null;
  declare dragEnd: { row: number; col: number } | null;
  declare previewCells: any;
  declare resolvedCorner: string | null;
  declare hoverPos: { x: number; y: number } | null;
  declare hoverCorner: string | null;

  constructor() {
    super('trim', 'T', 'crosshair');
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.previewCells = null;
    this.resolvedCorner = null; // the corner used for current drag (auto-detected or manual)
    this.hoverPos = null;       // canvas pixel position for hover preview
    this.hoverCorner = null;    // resolved corner shown in last hover preview
  }

  onActivate() {
    state.statusInstruction = 'Drag from room corner to set trim size · R to round · I to invert · O to open · Right-click to remove';
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

  onMouseDown(row: any, col: any) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;

    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.resolvedCorner = state.trimCorner === 'auto' ? (this.hoverCorner || 'nw') : state.trimCorner;
    this._updatePreview();
  }

  onMouseMove(row: any, col: any, edge: any, event: any, pos: any) {
    this.hoverPos = pos || null;
    if (!this.dragging) return;
    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length || 1) - 1, col));
    this.dragEnd = { row, col };

    // Auto-detect corner from drag direction
    if (state.trimCorner === 'auto') {
      // @ts-expect-error — strict-mode migration
      const dr = this.dragEnd.row - this!.dragStart.row;
      // @ts-expect-error — strict-mode migration
      const dc = this.dragEnd.col - this!.dragStart.col;
      // Only update direction once the mouse has moved at least 1 cell
      if (dr !== 0 || dc !== 0) {
        if (dr <= 0 && dc <= 0) this.resolvedCorner = 'nw';
        else if (dr <= 0 && dc >= 0) this.resolvedCorner = 'ne';
        else if (dr >= 0 && dc <= 0) this.resolvedCorner = 'sw';
        else this.resolvedCorner = 'se';
      }
    } else {
      this.resolvedCorner = state.trimCorner;
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

    // Capture before state for all cells that will be mutated
    const allCoords = [
      ...preview.voided,
      ...preview.hypotenuse,
      ...(preview.insideArc || []),
    ];
    const before = captureBeforeState(cells, allCoords);

    pushUndo('Place trim');
    const corner = this.resolvedCorner;
    const isRound = state.trimRound;
    const isInverted = state.trimInverted;

    const reciprocals = { north: 'south', south: 'north', east: 'west', west: 'east' };
    const offsets = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
    const allDirs = ['north', 'south', 'east', 'west'];

    // Helper: clear all cardinal/diagonal walls and their reciprocals
    const clearWalls = (cell: any, r: any, c: any) => {
      for (const dir of allDirs) {
        if (cell[dir]) {
          delete cell[dir];
          const [dr, dc] = (offsets as any)[dir];
          const neighbor = cells[r + dr]?.[c + dc];
          // @ts-expect-error — strict-mode migration
          if (neighbor) delete (neighbor as any)[reciprocals[dir]];
        }
      }
      delete cell['nw-se'];
      delete cell['ne-sw'];
    };

    // Helper: remove all old-format trim flags from a cell
    const clearOldTrimFlags = (cell: any) => {
      delete cell.trimRound;
      delete cell.trimArcCenterRow;
      delete cell.trimArcCenterCol;
      delete cell.trimArcRadius;
      delete cell.trimArcInverted;
      delete cell.trimInsideArc;
      delete cell.trimCorner;
      delete cell.trimOpen;
      delete cell.trimInverted;
      delete cell.trimClip;
      delete cell.trimWall;
      delete cell.trimPassable;
    delete cell.trimCrossing;
    };

    if (isRound) {
      // ── Round trim: per-cell data from computeTrimCells ──
      // @ts-expect-error — strict-mode migration
      const trimData = computeTrimCells(preview, corner, isInverted, state.trimOpen);
      const numRows = cells.length;
      const numCols = cells[0]?.length || 0;

      // Track which cells are in the original trim zone (walls should be cleared).
      // Buffer-ring neighbors that get arc data should NOT have their walls cleared.
      const trimZone = new Set([
        ...preview.voided.map((c: any) => `${c.row},${c.col}`),
        ...preview.hypotenuse.map((c: any) => `${c.row},${c.col}`),
        ...(preview.insideArc || []).map((c: any) => `${c.row},${c.col}`),
      ]);

      for (const [key, val] of trimData) {
        const [r, c] = key.split(',').map(Number);
        if (r < 0 || r >= numRows || c < 0 || c >= numCols) continue;
        const inZone = trimZone.has(key);

        if (val === null) {
          // Void cell
          cells[r][c] = null;
        } else if (val === 'interior') {
          // Regular floor — only clear walls/flags if in the trim zone
          if (inZone) {
            if (!cells[r][c]) cells[r][c] = {};
            const cell = cells[r][c];
            clearWalls(cell, r, c);
            clearOldTrimFlags(cell);
          }
        // @ts-expect-error — strict-mode migration
        } else if (val === 'diagonal') {
          // Inverted hypotenuse: straight diagonal wall (like straight trims)
          if (!cells[r][c]) cells[r][c] = {};
          const cell = cells[r][c];
          if (inZone) clearWalls(cell, r, c);
          clearOldTrimFlags(cell);
          // @ts-expect-error — strict-mode migration
          cell.trimCorner = corner;
          if (corner === 'nw' || corner === 'se') cell['ne-sw'] = 'w';
          else cell['nw-se'] = 'w';
          if (state.trimOpen) cell.trimOpen = true;
        } else {
          // Arc boundary cell — stamp new properties
          if (!cells[r][c]) cells[r][c] = {};
          const cell = cells[r][c];
          if (inZone) clearWalls(cell, r, c);
          clearOldTrimFlags(cell);
          Object.assign(cell, val);
        }
      }
    } else {
      // ── Straight trim: original logic (unchanged) ──

      // Void interior cells, or in Open mode clear their walls
      if (!state.trimOpen) {
        for (const { row: r, col: c } of preview.voided) {
          cells[r][c] = null;
        }
      } else {
        for (const { row: r, col: c } of preview.voided) {
          const cell = cells[r]?.[c];
          if (!cell) continue;
          clearWalls(cell, r, c);
          clearOldTrimFlags(cell);
        }
      }

      // Set hypotenuse cells
      for (const { row: r, col: c } of preview.hypotenuse) {
        if (!cells[r][c]) cells[r][c] = {};
        const cell = cells[r][c];
        // @ts-expect-error — strict-mode migration
        cell.trimCorner = corner;
        clearWalls(cell, r, c);

        // Set diagonal border
        if (corner === 'nw' || corner === 'se') {
          cell['ne-sw'] = 'w';
        } else {
          cell['nw-se'] = 'w';
        }

        if (state.trimOpen) cell.trimOpen = true;
        else delete cell.trimOpen;
      }
    }

    this.previewCells = null;
    invalidateLightmap();
    // forceGeometry: trim metadata on hypotenuse cells always invalidates rounded corners cache
    smartInvalidate(before, cells, { forceGeometry: true });
    markDirty();
    requestRender();
  }

  /**
   * Compute preview from drag start/end and resolved corner.
   */
  _updatePreview() {
    const corner = this.resolvedCorner;
    // @ts-expect-error — strict-mode migration
    const { row: r0, col: c0 } = this.dragStart;
    // @ts-expect-error — strict-mode migration
    const { row: r1, col: c1 } = this.dragEnd;

    // Size = max distance along row or col axis + 1
    const size = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0)) + 1;

    const hypotenuse = [];
    let voided = [];
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;

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
      let hr, hc;
      switch (corner) {
        case 'se': hr = r0 - far + i; hc = c0 - i; break;
        case 'nw': hr = r0 + far - i; hc = c0 + i; break;
        case 'ne': hr = r0 + far - i; hc = c0 - i; break;
        case 'sw': hr = r0 - far + i; hc = c0 + i; break;
      }
      // @ts-expect-error — strict-mode migration
      if (hr < 0 || hr >= numRows || hc < 0 || hc >= numCols) continue;
      hypotenuse.push({ row: hr, col: hc });
    }

    // Void: triangle between hypotenuse and click corner.
    // At hyp index i, there are i void cells filling back toward the click column.
    for (let i = 1; i < size; i++) {
      for (let j = 0; j < i; j++) {
        let vr, vc;
        switch (corner) {
          case 'se': vr = r0 - far + i; vc = c0 - i + 1 + j; break;
          case 'nw': vr = r0 + far - i; vc = c0 + j;         break;
          case 'ne': vr = r0 + far - i; vc = c0 - i + 1 + j; break;
          case 'sw': vr = r0 - far + i; vc = c0 + j;         break;
        }
        // @ts-expect-error — strict-mode migration
        if (vr < 0 || vr >= numRows || vc < 0 || vc >= numCols) continue;
        voided.push({ row: vr, col: vc });
      }
    }

    // Arc center: grid intersection at the trim's corner
    let arcCenter = { row: r0, col: c0 };
    const allRows = hypotenuse.map(c => c.row).concat(voided.map(c => c.row));
    const allCols = hypotenuse.map(c => c.col).concat(voided.map(c => c.col));
    if (allRows.length > 0) {
      // @ts-expect-error — strict-mode migration
      const minR = Math.min(...allRows);
      // @ts-expect-error — strict-mode migration
      const maxR = Math.max(...allRows);
      const minC = Math.min(...allCols);
      const maxC = Math.max(...allCols);

      switch (corner) {
        case 'nw': arcCenter = { row: minR, col: minC }; break;
        case 'ne': arcCenter = { row: minR, col: maxC + 1 }; break;
        case 'sw': arcCenter = { row: maxR + 1, col: minC }; break;
        case 'se': arcCenter = { row: maxR + 1, col: maxC + 1 }; break;
      }
    }

    // For rounded non-inverted trims: the arc curves inward relative to the
    // straight diagonal, so only cells completely outside the arc should be
    // voided. Cells between the diagonal and the arc remain as room floor,
    // but their existing cardinal/diagonal walls must be cleared (the arc is
    // now the wall).
    const insideArc: any = [];
    if (state.trimRound && !state.trimInverted && voided.length > 0) {
      // @ts-expect-error — strict-mode migration
      let acxGrid, acyGrid;
      switch (corner) {
        case 'nw': acxGrid = arcCenter.col + size; acyGrid = arcCenter.row + size; break;
        case 'ne': acxGrid = arcCenter.col - size; acyGrid = arcCenter.row + size; break;
        case 'sw': acxGrid = arcCenter.col + size; acyGrid = arcCenter.row - size; break;
        case 'se': acxGrid = arcCenter.col - size; acyGrid = arcCenter.row - size; break;
      }
      voided = voided.filter(({ row: vr, col: vc }) => {
        // Closest distance from cell [vc, vc+1] × [vr, vr+1] to arc pivot
        // @ts-expect-error — strict-mode migration
        const dx = Math.max(vc - acxGrid, 0, acxGrid - (vc + 1));
        // @ts-expect-error — strict-mode migration
        const dy = Math.max(vr - acyGrid, 0, acyGrid - (vr + 1));
        const outside = Math.sqrt(dx * dx + dy * dy) > size;
        if (!outside) insideArc.push({ row: vr, col: vc });
        return outside;
      });
    }

    this.previewCells = { hypotenuse, voided, insideArc, arcCenter, size };
  }

  onRightClick(row: any, col: any) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;
    const cell = cells[row][col];
    if (!cell || !cell.trimCorner) return;

    const before = captureBeforeState(cells, [{ row, col }]);
    pushUndo('Remove Trim');

    // Clear both old-format and new-format trim properties
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

    invalidateLightmap();
    smartInvalidate(before, cells, { forceGeometry: true });
    markDirty();
    requestRender();
  }

  onKeyDown(e: any) {
    if (e.key === 'Escape' && this.dragging) {
      this.onCancel();
      requestRender();
      return;
    }
    const syncTrimButtons = (prop: any, val: any) => {
      document.querySelectorAll(`#trim-shape-options [data-trim="${prop}"]`).forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.val === String(val));
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

  renderOverlay(ctx: any, transform: any, gridSize: any) {
    // Hover preview — show which corner will be trimmed before dragging
    if (!this.dragging && state.hoveredCell && this.hoverPos) {
      const { row, col } = state.hoveredCell;
      const cells = state.dungeon.cells;
      if (row >= 0 && row < cells.length && col >= 0 && col < (cells[0]?.length || 0) && cells[row][col] !== null) {
        let corner;
        if (state.trimCorner === 'auto') {
          // Determine corner from which quadrant of the cell the cursor is in
          const cellTL = toCanvas(col * gridSize, row * gridSize, transform);
          const cellPx = gridSize * transform.scale;
          const inEast = this.hoverPos.x - cellTL.x > cellPx / 2;
          const inSouth = this.hoverPos.y - cellTL.y > cellPx / 2;
          corner = inSouth ? (inEast ? 'se' : 'sw') : (inEast ? 'ne' : 'nw');
        } else {
          corner = state.trimCorner;
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
      const x = col * gridSize, y = row * gridSize;
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
    if (state.trimRound && this.previewCells.arcCenter) {
      this._drawArcPreview(ctx, transform, gridSize, corner);
    }
  }

  _drawHoverPreview(ctx: any, transform: any, gridSize: any, row: any, col: any, corner: any) {
    const x = col * gridSize;
    const y = row * gridSize;
    const tl = toCanvas(x,             y,             transform);
    const tr = toCanvas(x + gridSize,  y,             transform);
    const bl = toCanvas(x,             y + gridSize,  transform);
    const br = toCanvas(x + gridSize,  y + gridSize,  transform);

    // Diagonal endpoints: NW/SE → NE-SW (tr→bl); NE/SW → NW-SE (tl→br)
    const isNESW = (corner === 'nw' || corner === 'se');
    const dp1 = isNESW ? tr : tl;
    const dp2 = isNESW ? bl : br;

    // The void triangle is the corner being cut plus the two diagonal endpoints
    // @ts-expect-error — strict-mode migration
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
    ctx.moveTo(voidTri[0].x, voidTri[0].y);
    ctx.lineTo(voidTri[1].x, voidTri[1].y);
    ctx.lineTo(voidTri[2].x, voidTri[2].y);
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

  _drawArcPreview(ctx: any, transform: any, gridSize: any, corner: any) {
    const { arcCenter, size } = this.previewCells;
    const R = size * gridSize;
    const Rpx = R * transform.scale;
    const cp = toCanvas(arcCenter.col * gridSize, arcCenter.row * gridSize, transform);

    ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();

    if (state.trimInverted) {
      switch (corner) {
        case 'nw': ctx.arc(cp.x, cp.y, Rpx, Math.PI / 2, 0, true); break;
        case 'ne': ctx.arc(cp.x, cp.y, Rpx, Math.PI / 2, Math.PI, false); break;
        case 'sw': ctx.arc(cp.x, cp.y, Rpx, 0, 3 * Math.PI / 2, true); break;
        case 'se': ctx.arc(cp.x, cp.y, Rpx, Math.PI, 3 * Math.PI / 2, false); break;
      }
    } else {
      let acx, acy;
      switch (corner) {
        case 'nw': acx = (arcCenter.col + size) * gridSize; acy = (arcCenter.row + size) * gridSize; break;
        case 'ne': acx = (arcCenter.col - size) * gridSize; acy = (arcCenter.row + size) * gridSize; break;
        case 'sw': acx = (arcCenter.col + size) * gridSize; acy = (arcCenter.row - size) * gridSize; break;
        case 'se': acx = (arcCenter.col - size) * gridSize; acy = (arcCenter.row - size) * gridSize; break;
      }
      // @ts-expect-error — strict-mode migration
      const acp = toCanvas(acx, acy, transform);
      switch (corner) {
        case 'nw': ctx.arc(acp.x, acp.y, Rpx, 3 * Math.PI / 2, Math.PI, true); break;
        case 'ne': ctx.arc(acp.x, acp.y, Rpx, 3 * Math.PI / 2, 0, false); break;
        case 'sw': ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, Math.PI, false); break;
        case 'se': ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, 0, true); break;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
