// Bridge tool: 3-click corner-point placement
// P1 → P2: entrance width.  P3: depth direction (always rectangular).
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty } from '../state.js';
import { requestRender, getTransform } from '../canvas-view.js';
import { toCanvas, nearestCorner } from '../utils.js';
import { isBridgeDegenerate, getBridgeCorners, getBridgeOccupiedCells } from '../bridge-geometry.js';
import { showToast } from '../toast.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function bridgeIdAt(row, col) {
  const cell = state.dungeon.cells[row]?.[col];
  if (!cell?.center) return null;
  const id = cell.center['bridge-id'];
  return id != null ? id : null;
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export class BridgeTool extends Tool {
  constructor() {
    super('bridge', 'B', 'crosshair');
    this._phase = 'idle'; // 'idle' | 'have_p1' | 'have_p2'
    this._p1 = null;
    this._p2 = null;
  }

  getCursor() { return 'crosshair'; }

  onActivate()   { this._resetPlacement(); }
  onDeactivate() { this._resetPlacement(); }

  _resetPlacement() {
    this._phase = 'idle';
    this._p1 = null;
    this._p2 = null;
  }

  onCancel() {
    if (this._phase !== 'idle') {
      this._resetPlacement();
      requestRender();
      return true;
    }
    return false;
  }

  onKeyDown(event) {
    if (event.key === 'Escape' && this._phase !== 'idle') {
      this._resetPlacement();
      requestRender();
      event.preventDefault();
    }
  }

  onRightClick(row, col) {
    const id = bridgeIdAt(row, col);
    if (id == null) return;
    pushUndo('Remove Bridge');
    this._removeBridge(id);
    markDirty();
    requestRender();
  }

  onMouseDown(row, col, edge, event, pos) {
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    const corner = nearestCorner(pos.x, pos.y, transform, gridSize);
    this._handleClick(corner);
  }

  // ── Placement ────────────────────────────────────────────────────────────────

  _handleClick(corner) {
    if (this._phase === 'idle') {
      this._p1 = [corner.row, corner.col];
      this._phase = 'have_p1';
      requestRender();
      return;
    }

    if (this._phase === 'have_p1') {
      const p2 = [corner.row, corner.col];
      if (p2[0] === this._p1[0] && p2[1] === this._p1[1]) {
        this._resetPlacement();
        requestRender();
        return;
      }
      this._p2 = p2;
      this._phase = 'have_p2';
      requestRender();
      return;
    }

    if (this._phase === 'have_p2') {
      const p3 = [corner.row, corner.col];

      if (isBridgeDegenerate(this._p1, this._p2, p3)) {
        showToast('Bridge has zero depth. Choose a point off the entrance line.', 'warning');
        return;
      }

      const occupied = getBridgeOccupiedCells(this._p1, this._p2, p3);
      if (occupied.length === 0) {
        showToast('No cells covered by this bridge.', 'warning');
        return;
      }

      const cells = state.dungeon.cells;
      const numRows = cells.length;
      const numCols = cells[0]?.length || 0;
      for (const { row, col } of occupied) {
        if (row < 0 || row >= numRows || col < 0 || col >= numCols) {
          showToast('Bridge extends out of bounds.', 'warning');
          return;
        }
      }

      this._commitBridge(this._p1, this._p2, p3, occupied);
      this._resetPlacement();
    }
  }

  _commitBridge(p1, p2, p3, occupiedCells) {
    pushUndo('Place Bridge');

    const meta = state.dungeon.metadata;
    if (!meta.bridges) meta.bridges = [];
    if (meta.nextBridgeId == null) meta.nextBridgeId = 0;

    const id = meta.nextBridgeId++;
    const type = state.bridgeType || 'wood';
    meta.bridges.push({ id, type, points: [p1, p2, p3] });

    const cells = state.dungeon.cells;
    for (const { row, col } of occupiedCells) {
      if (!cells[row][col]) cells[row][col] = {};
      if (!cells[row][col].center) cells[row][col].center = {};
      cells[row][col].center['bridge-id'] = id;
    }

    markDirty();
    requestRender();
  }

  _removeBridge(id) {
    const meta = state.dungeon.metadata;
    const bridges = meta?.bridges;
    if (!bridges) return;

    const idx = bridges.findIndex(b => b.id === id);
    if (idx === -1) return;
    bridges.splice(idx, 1);

    const cells = state.dungeon.cells;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        if (cells[r]?.[c]?.center?.['bridge-id'] === id) {
          delete cells[r][c].center['bridge-id'];
          if (Object.keys(cells[r][c].center).length === 0) delete cells[r][c].center;
        }
      }
    }
  }

  // ── Overlay (preview) ────────────────────────────────────────────────────────

  renderOverlay(ctx, transform, gridSize) {
    const hc = state.hoveredCorner;

    // Snap dot on hover
    if (hc) {
      const p = toCanvas(hc.col * gridSize, hc.row * gridSize, transform);
      ctx.fillStyle = 'rgba(255, 180, 50, 0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this._phase === 'have_p1' && this._p1) {
      const pp1 = toCanvas(this._p1[1] * gridSize, this._p1[0] * gridSize, transform);

      // P1 dot
      ctx.fillStyle = 'rgba(100, 200, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(pp1.x, pp1.y, 6, 0, Math.PI * 2);
      ctx.fill();

      // Dashed line to hover corner
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
      const pp1 = toCanvas(this._p1[1] * gridSize, this._p1[0] * gridSize, transform);
      const pp2 = toCanvas(this._p2[1] * gridSize, this._p2[0] * gridSize, transform);

      // P1 and P2 dots
      ctx.fillStyle = 'rgba(100, 200, 255, 0.9)';
      for (const pp of [pp1, pp2]) {
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }

      // Width line P1→P2
      ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pp1.x, pp1.y);
      ctx.lineTo(pp2.x, pp2.y);
      ctx.stroke();

      // Preview rectangle to hover corner
      if (hc && !isBridgeDegenerate(this._p1, this._p2, [hc.row, hc.col])) {
        this._drawPreview(ctx, transform, gridSize, this._p1, this._p2, [hc.row, hc.col]);
      }
    }
  }

  _drawPreview(ctx, transform, gridSize, p1, p2, p3) {
    const corners = getBridgeCorners(p1, p2, p3);
    const pts = corners.map(c => toCanvas(c[1] * gridSize, c[0] * gridSize, transform));

    ctx.fillStyle = 'rgba(100, 200, 255, 0.12)';
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
