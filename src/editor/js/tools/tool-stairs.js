// Stairs tool: 3-click corner-point placement, linking
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, notify } from '../state.js';
import { accumulateDirtyRect } from '../../../render/index.js';
import { requestRender, getTransform } from '../canvas-view.js';
import { toCanvas, nearestCorner } from '../utils.js';
import {
  classifyStairShape,
  isDegenerate,
  getOccupiedCells,
  computeHatchLines,
} from '../stair-geometry.js';
import { showToast } from '../toast.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the stair ID that covers the given cell, or null.
 */
function stairIdAt(row, col) {
  const cell = state.dungeon.cells[row]?.[col];
  if (!cell?.center) return null;
  const id = cell.center['stair-id'];
  return id != null ? id : null;
}

/**
 * Find a stair definition by ID.
 */
function findStair(id) {
  return (state.dungeon.metadata?.stairs || []).find(s => s.id === id) || null;
}

/**
 * Get the next available A-Z link label.
 */
function getNextLinkLabel() {
  const used = new Set();
  for (const stair of (state.dungeon.metadata?.stairs || [])) {
    if (stair.link) used.add(stair.link);
  }
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return letter;
  }
  return '?';
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export class StairsTool extends Tool {
  constructor() {
    super('stairs', 'S', 'crosshair');
    this._phase = 'idle'; // 'idle' | 'have_p1' | 'have_p2'
    this._p1 = null;
    this._p2 = null;
  }

  getCursor() {
    return state.stairsMode === 'link' ? 'pointer' : 'crosshair';
  }

  onActivate() {
    this._resetPlacement();
    state.statusInstruction = state.stairsMode === 'link'
      ? 'Click a stair to select it · Click another to link · Click a linked stair to unlink · Right-click to delete'
      : 'Click to place corner 1 of 3';
  }

  onDeactivate() {
    this._resetPlacement();
    state.linkSource = null;
    state.statusInstruction = null;
  }

  _resetPlacement() {
    this._phase = 'idle';
    this._p1 = null;
    this._p2 = null;
    state.stairPlacement = { p1: null, p2: null };
  }

  /**
   * Called by canvas-view on right-click down (before checking drag).
   * Return true to indicate we consumed it (cancel in-progress placement).
   */
  onCancel() {
    if (this._phase !== 'idle') {
      this._resetPlacement();
      if (state.stairsMode === 'place') state.statusInstruction = 'Click to place corner 1 of 3';
      requestRender();
      return true;
    }
    return false;
  }

  onKeyDown(event) {
    if (event.key === 'Escape') {
      if (this._phase !== 'idle') {
        this._resetPlacement();
        if (state.stairsMode === 'place') state.statusInstruction = 'Click to place corner 1 of 3';
        requestRender();
        event.preventDefault();
      }
    }
  }

  onRightClick(row, col) {
    // Right-click on a cell with stairs: remove the entire stair
    const id = stairIdAt(row, col);
    if (id == null) return;

    pushUndo('Remove stairs');
    this._removeStair(id);
    markDirty();
    notify();
    requestRender();
  }

  onMouseDown(row, col, edge, event, pos) {
    const mode = state.stairsMode;
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    const corner = nearestCorner(pos.x, pos.y, transform, gridSize);

    if (mode === 'place') {
      this._handlePlaceClick(corner);
    } else if (mode === 'link') {
      this._handleLinkClick(row, col);
    }
  }

  onMouseMove() {
    // Corner hover is already updated in canvas-view.js via state.hoveredCorner
  }

  // ── Placement ──────────────────────────────────────────────────────────────

  _handlePlaceClick(corner) {
    if (this._phase === 'idle') {
      this._p1 = [corner.row, corner.col];
      this._phase = 'have_p1';
      state.stairPlacement = { p1: this._p1, p2: null };
      state.statusInstruction = 'Click corner 2 of 3';
      requestRender();
      return;
    }

    if (this._phase === 'have_p1') {
      const p2 = [corner.row, corner.col];
      // Same point as P1: cancel
      if (p2[0] === this._p1[0] && p2[1] === this._p1[1]) {
        this._resetPlacement();
        state.statusInstruction = 'Click to place corner 1 of 3';
        requestRender();
        return;
      }
      this._p2 = p2;
      this._phase = 'have_p2';
      state.stairPlacement = { p1: this._p1, p2: this._p2 };
      state.statusInstruction = 'Click depth point';
      requestRender();
      return;
    }

    if (this._phase === 'have_p2') {
      const p3 = [corner.row, corner.col];

      // Validate
      if (isDegenerate(this._p1, this._p2, p3)) {
        showToast('Degenerate shape (zero area). Choose a different point.', 'warning');
        return;
      }

      // Check for overlap
      const shape = classifyStairShape(this._p1, this._p2, p3);
      const occupied = getOccupiedCells(shape.vertices);
      const cells = state.dungeon.cells;

      if (occupied.length === 0) {
        showToast('No cells covered by this shape.', 'warning');
        return;
      }

      // Check for existing stairs and out-of-bounds
      for (const { row, col } of occupied) {
        if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) {
          showToast('Stair shape extends out of bounds.', 'warning');
          return;
        }
        if (!cells[row]?.[col]) continue; // void cell — allowed but won't get stair-id
        const existingId = cells[row][col]?.center?.['stair-id'];
        if (existingId != null) {
          showToast('Overlaps an existing stair. Remove it first.', 'warning');
          return;
        }
      }

      // Commit
      this._commitStair(this._p1, this._p2, p3, occupied);
      this._resetPlacement();
      state.statusInstruction = 'Click to place corner 1 of 3';
    }
  }

  _commitStair(p1, p2, p3, occupiedCells) {
    pushUndo('Place stairs');

    const meta = state.dungeon.metadata;
    if (!meta.stairs) meta.stairs = [];
    if (meta.nextStairId == null) meta.nextStairId = 0;

    const id = meta.nextStairId++;
    meta.stairs.push({ id, points: [p1, p2, p3], link: null });

    const cells = state.dungeon.cells;
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (const { row, col } of occupiedCells) {
      if (!cells[row][col]) cells[row][col] = {};
      if (!cells[row][col].center) cells[row][col].center = {};
      cells[row][col].center['stair-id'] = id;
      if (row < minR) minR = row;
      if (row > maxR) maxR = row;
      if (col < minC) minC = col;
      if (col > maxC) maxC = col;
    }

    accumulateDirtyRect(minR, minC, maxR, maxC);
    markDirty();
    notify();
    requestRender();
  }

  _removeStair(id) {
    const meta = state.dungeon.metadata;
    const stairs = meta?.stairs;
    if (!stairs) return;

    // Find the stair
    const idx = stairs.findIndex(s => s.id === id);
    if (idx === -1) return;
    const stairDef = stairs[idx];

    // Unlink partner if linked
    if (stairDef.link) {
      const partner = stairs.find(s => s.link === stairDef.link && s.id !== id);
      if (partner) partner.link = null;
    }

    // Remove from array
    stairs.splice(idx, 1);

    // Clear cell references and track dirty region
    const cells = state.dungeon.cells;
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        if (cells[r]?.[c]?.center?.['stair-id'] === id) {
          delete cells[r][c].center['stair-id'];
          if (Object.keys(cells[r][c].center).length === 0) delete cells[r][c].center;
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    if (minR <= maxR) accumulateDirtyRect(minR, minC, maxR, maxC);

    // Clear link source if it pointed to this stair
    if (state.linkSource === id) state.linkSource = null;
  }

  // ── Linking ────────────────────────────────────────────────────────────────

  _handleLinkClick(row, col) {
    const id = stairIdAt(row, col);
    if (id == null) {
      // Clicked empty cell — cancel pending link
      state.linkSource = null;
      requestRender();
      return;
    }

    const stairDef = findStair(id);
    if (!stairDef) return;

    // No pending source — select this stair
    if (state.linkSource == null) {
      // If already linked, clicking it unlinks
      if (stairDef.link) {
        pushUndo('Unlink stairs');
        const partner = (state.dungeon.metadata.stairs || []).find(
          s => s.link === stairDef.link && s.id !== id
        );
        if (partner) partner.link = null;
        stairDef.link = null;
        markDirty();
        notify();
        requestRender();
        return;
      }
      state.linkSource = id;
      requestRender();
      return;
    }

    // Clicked same stair as source — cancel
    if (state.linkSource === id) {
      state.linkSource = null;
      requestRender();
      return;
    }

    // Second click — link the two stairs
    pushUndo('Link stairs');
    const label = getNextLinkLabel();
    const stairs = state.dungeon.metadata.stairs;
    const src = stairs.find(s => s.id === state.linkSource);
    const tgt = stairDef;

    // Remove old links if any
    if (src?.link) {
      const oldPartner = stairs.find(s => s.link === src.link && s.id !== src.id);
      if (oldPartner) oldPartner.link = null;
    }
    if (tgt.link) {
      const oldPartner = stairs.find(s => s.link === tgt.link && s.id !== tgt.id);
      if (oldPartner) oldPartner.link = null;
    }

    if (src) src.link = label;
    tgt.link = label;

    state.linkSource = null;
    markDirty();
    notify();
    requestRender();
  }

  // ── Overlay (preview) ──────────────────────────────────────────────────────

  renderOverlay(ctx, transform, gridSize) {
    const hc = state.hoveredCorner;

    // Draw snapped corner dot on hover
    if (hc && state.stairsMode === 'place') {
      const p = toCanvas(hc.col * gridSize, hc.row * gridSize, transform);
      ctx.fillStyle = 'rgba(255, 200, 50, 0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Phase indicators
    if (this._phase === 'have_p1' && this._p1) {
      // Draw P1 dot
      const pp1 = toCanvas(this._p1[1] * gridSize, this._p1[0] * gridSize, transform);
      ctx.fillStyle = 'rgba(100, 200, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(pp1.x, pp1.y, 6, 0, Math.PI * 2);
      ctx.fill();

      // Line from P1 to hover corner
      if (hc) {
        const ph = toCanvas(hc.col * gridSize, hc.row * gridSize, transform);
        ctx.strokeStyle = 'rgba(100, 200, 255, 0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(pp1.x, pp1.y);
        ctx.lineTo(ph.x, ph.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (this._phase === 'have_p2' && this._p1 && this._p2) {
      // Draw P1 and P2 dots
      const pp1 = toCanvas(this._p1[1] * gridSize, this._p1[0] * gridSize, transform);
      const pp2 = toCanvas(this._p2[1] * gridSize, this._p2[0] * gridSize, transform);

      ctx.fillStyle = 'rgba(100, 200, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(pp1.x, pp1.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pp2.x, pp2.y, 6, 0, Math.PI * 2);
      ctx.fill();

      // Base line P1→P2
      ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pp1.x, pp1.y);
      ctx.lineTo(pp2.x, pp2.y);
      ctx.stroke();

      // Preview shape to hover corner
      if (hc) {
        const p3 = [hc.row, hc.col];
        if (!isDegenerate(this._p1, this._p2, p3)) {
          this._drawPreview(ctx, transform, gridSize, this._p1, this._p2, p3);
        }
      }
    }
  }

  _drawPreview(ctx, transform, gridSize, p1, p2, p3) {
    const shape = classifyStairShape(p1, p2, p3);

    // Draw polygon outline
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (let i = 0; i < shape.vertices.length; i++) {
      const v = shape.vertices[i];
      const p = toCanvas(v[1] * gridSize, v[0] * gridSize, transform);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw preview hatching lines
    const lines = computeHatchLines([p1, p2, p3]);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (const line of lines) {
      const start = toCanvas(line.c1 * gridSize, line.r1 * gridSize, transform);
      const end = toCanvas(line.c2 * gridSize, line.r2 * gridSize, transform);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
  }
}
