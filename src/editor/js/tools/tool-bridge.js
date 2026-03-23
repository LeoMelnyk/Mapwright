// Bridge tool: 3-click corner-point placement + hover/select/move/rotate
// P1 → P2: entrance width.  P3: depth direction (always rectangular).
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty } from '../state.js';
import { requestRender, getTransform, setCursor } from '../canvas-view.js';
import { toCanvas, nearestCorner } from '../utils.js';
import { isBridgeDegenerate, getBridgeCorners, getBridgeOccupiedCells } from '../bridge-geometry.js';
import { showToast } from '../toast.js';

const DRAG_THRESHOLD = 8; // pixels

// ── Helpers ───────────────────────────────────────────────────────────────────

function bridgeIdAt(row, col) {
  const cell = state.dungeon.cells[row]?.[col];
  if (!cell?.center) return null;
  const id = cell.center['bridge-id'];
  return id != null ? id : null;
}

function getBridgeById(id) {
  return state.dungeon.metadata.bridges?.find(b => b.id === id) ?? null;
}

/**
 * Rotate 3 control points 90° CW around the centroid of the bridge's 4 corners.
 * @param {number[][]} pts - [[r,c], [r,c], [r,c]]
 * @returns {number[][]}
 */
function rotatePts90CW(pts) {
  const corners = getBridgeCorners(pts[0], pts[1], pts[2]);
  const cR = corners.reduce((s, c) => s + c[0], 0) / 4;
  const cC = corners.reduce((s, c) => s + c[1], 0) / 4;
  return pts.map(([r, c]) => [cR + (c - cC), cC - (r - cR)]);
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export class BridgeTool extends Tool {
  constructor() {
    super('bridge', 'B', 'crosshair');
    this._phase = 'idle'; // 'idle' | 'have_p1' | 'have_p2'
    this._p1 = null;
    this._p2 = null;

    // Hover / select / drag state
    this.hoveredBridgeId = null;
    this._isDragging = false;
    this._dragBridgeId = null;
    this._pendingDrag = null;       // { bridgeId } — threshold not yet crossed
    this._pendingDragPos = null;    // { x, y } — mousedown pixel position
    this._pendingDragCorner = null; // { row, col } — corner at mousedown (drag anchor)
    this._basePoints = null;        // [[r,c],[r,c],[r,c]] — base pts (R-key rotations baked in)
    this._dragDelta = { dRow: 0, dCol: 0 };
  }

  getCursor() { return 'crosshair'; }

  onActivate() {
    this._resetPlacement();
    state.statusInstruction = 'Click to place bridge · Hover bridge to select/move · R to rotate · Del to delete';
  }

  onDeactivate() {
    this._resetAll();
    state.statusInstruction = null;
  }

  _resetPlacement() {
    this._phase = 'idle';
    this._p1 = null;
    this._p2 = null;
  }

  _resetDrag() {
    this._isDragging = false;
    this._dragBridgeId = null;
    this._pendingDrag = null;
    this._pendingDragPos = null;
    this._pendingDragCorner = null;
    this._basePoints = null;
    this._dragDelta = { dRow: 0, dCol: 0 };
  }

  _resetAll() {
    this._resetPlacement();
    this._resetDrag();
    this.hoveredBridgeId = null;
    state.selectedBridgeId = null;
  }

  onCancel() {
    if (this._isDragging) {
      this._resetDrag();
      requestRender();
      return true;
    }
    if (this._pendingDrag) {
      this._resetDrag();
      return true;
    }
    if (this._phase !== 'idle') {
      this._resetPlacement();
      requestRender();
      return true;
    }
    return false;
  }

  onKeyDown(event) {
    if (event.key === 'Escape') {
      if (this.onCancel()) event.preventDefault();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (state.selectedBridgeId != null && !this._isDragging && this._phase === 'idle') {
        event.preventDefault();
        pushUndo('Remove Bridge');
        this._removeBridge(state.selectedBridgeId);
        state.selectedBridgeId = null;
        markDirty();
        requestRender();
      }
      return;
    }

    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();

      if (this._isDragging) {
        // Rotate the ghost around the centroid of its 4 corners; bake into _basePoints
        const { dRow, dCol } = this._dragDelta;
        const ghost = this._getGhostPoints();
        const rotated = rotatePts90CW(ghost);
        this._basePoints = rotated.map(([r, c]) => [r - dRow, c - dCol]);
        requestRender();
        return;
      }

      if (state.selectedBridgeId != null && this._phase === 'idle') {
        const bridge = getBridgeById(state.selectedBridgeId);
        if (!bridge) return;
        const rotated = rotatePts90CW(bridge.points);
        const [rp1, rp2, rp3] = rotated;

        if (isBridgeDegenerate(rp1, rp2, rp3)) {
          showToast('Rotated bridge is degenerate.', 'warning');
          return;
        }
        const occupied = getBridgeOccupiedCells(rp1, rp2, rp3);
        if (occupied.length === 0) {
          showToast('Rotated bridge has no area.', 'warning');
          return;
        }
        const cells = state.dungeon.cells;
        const numRows = cells.length, numCols = cells[0]?.length || 0;
        for (const { row, col } of occupied) {
          if (row < 0 || row >= numRows || col < 0 || col >= numCols) {
            showToast('Rotated bridge would go out of bounds.', 'warning');
            return;
          }
        }

        pushUndo('Rotate Bridge');
        this._clearCellMarkers(bridge.id);
        bridge.points = rotated;
        this._setCellMarkers(bridge.id, occupied);
        markDirty();
        requestRender();
      }
      return;
    }
  }

  onRightClick(row, col) {
    if (this._isDragging) return;
    const id = bridgeIdAt(row, col);
    if (id == null) return;
    pushUndo('Remove Bridge');
    if (state.selectedBridgeId === id) state.selectedBridgeId = null;
    this._removeBridge(id);
    markDirty();
    requestRender();
  }

  onMouseDown(row, col, edge, event, pos) {
    if (this._isDragging) return;

    if (this._phase !== 'idle') {
      // Continue multi-click placement
      this._handleClick(this._cornerFromPos(pos));
      return;
    }

    // Idle: bridge hovered → select + start pending drag
    if (this.hoveredBridgeId != null) {
      state.selectedBridgeId = this.hoveredBridgeId;
      const bridge = getBridgeById(this.hoveredBridgeId);
      if (bridge) {
        const corner = this._cornerFromPos(pos);
        this._pendingDrag = { bridgeId: this.hoveredBridgeId };
        this._pendingDragPos = { x: pos.x, y: pos.y };
        this._pendingDragCorner = { row: corner.row, col: corner.col };
        this._basePoints = bridge.points.map(p => [...p]);
        this._dragDelta = { dRow: 0, dCol: 0 };
      }
      requestRender();
      return;
    }

    // Idle, no bridge hovered: deselect and start new placement
    if (state.selectedBridgeId != null) {
      state.selectedBridgeId = null;
    }
    this._handleClick(this._cornerFromPos(pos));
  }

  onMouseMove(row, col, edge, event, pos) {
    if (this._isDragging) {
      const cur = this._cornerFromPos(pos);
      this._dragDelta = {
        dRow: cur.row - this._pendingDragCorner.row,
        dCol: cur.col - this._pendingDragCorner.col,
      };
      state.hoveredCorner = null;
      return;
    }

    if (this._pendingDrag) {
      const dx = pos.x - this._pendingDragPos.x;
      const dy = pos.y - this._pendingDragPos.y;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        this._isDragging = true;
        this._dragBridgeId = this._pendingDrag.bridgeId;
        this._pendingDrag = null;
        setCursor('grabbing');
        const cur = this._cornerFromPos(pos);
        this._dragDelta = {
          dRow: cur.row - this._pendingDragCorner.row,
          dCol: cur.col - this._pendingDragCorner.col,
        };
        state.hoveredCorner = null;
      }
      return;
    }

    if (this._phase !== 'idle') {
      // Placement phase: keep hoveredCorner as-is (set by canvas-view)
      this.hoveredBridgeId = null;
      return;
    }

    // Idle: hover detection
    const id = bridgeIdAt(row, col);
    if (id !== this.hoveredBridgeId) {
      this.hoveredBridgeId = id;
    }
    if (id != null) {
      setCursor('grab');
      state.hoveredCorner = null; // suppress snap dot when over a bridge
    } else {
      setCursor('crosshair');
      // hoveredCorner already set by canvas-view
    }
  }

  onMouseUp() {
    if (this._isDragging) {
      this._commitDrag();
      setCursor(this.hoveredBridgeId != null ? 'grab' : 'crosshair');
      return;
    }
    if (this._pendingDrag) {
      // Click without drag: selection was set on mousedown, just clean up
      this._resetDrag();
    }
  }

  // ── Corner helper ─────────────────────────────────────────────────────────

  _cornerFromPos(pos) {
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    return nearestCorner(pos.x, pos.y, transform, gridSize);
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

  // ── Commit / Remove ───────────────────────────────────────────────────────

  _commitBridge(p1, p2, p3, occupiedCells) {
    pushUndo('Place Bridge');

    const meta = state.dungeon.metadata;
    if (!meta.bridges) meta.bridges = [];
    if (meta.nextBridgeId == null) meta.nextBridgeId = 0;

    const id = meta.nextBridgeId++;
    const type = state.bridgeType || 'wood';
    meta.bridges.push({ id, type, points: [p1, p2, p3] });

    this._setCellMarkers(id, occupiedCells);
    markDirty();
    requestRender();
  }

  _commitDrag() {
    const id = this._dragBridgeId;
    const bridge = getBridgeById(id);
    if (!bridge) { this._resetDrag(); return; }

    const ghostPts = this._getGhostPoints();
    const [gp1, gp2, gp3] = ghostPts;

    if (isBridgeDegenerate(gp1, gp2, gp3)) {
      showToast('Bridge position is invalid.', 'warning');
      this._resetDrag();
      requestRender();
      return;
    }

    const occupied = getBridgeOccupiedCells(gp1, gp2, gp3);
    const cells = state.dungeon.cells;
    const numRows = cells.length, numCols = cells[0]?.length || 0;
    let valid = occupied.length > 0;
    if (valid) {
      for (const { row, col } of occupied) {
        if (row < 0 || row >= numRows || col < 0 || col >= numCols) { valid = false; break; }
      }
    }
    if (!valid) {
      showToast('Bridge would go out of bounds.', 'warning');
      this._resetDrag();
      requestRender();
      return;
    }

    pushUndo('Move Bridge');
    this._clearCellMarkers(id);
    bridge.points = ghostPts;
    this._setCellMarkers(id, occupied);
    markDirty();
    this._resetDrag();
    requestRender();
  }

  _removeBridge(id) {
    this._clearCellMarkers(id);
    const bridges = state.dungeon.metadata?.bridges;
    if (!bridges) return;
    const idx = bridges.findIndex(b => b.id === id);
    if (idx !== -1) bridges.splice(idx, 1);
  }

  _clearCellMarkers(id) {
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

  _setCellMarkers(id, occupiedCells) {
    const cells = state.dungeon.cells;
    for (const { row, col } of occupiedCells) {
      if (!cells[row][col]) cells[row][col] = {};
      if (!cells[row][col].center) cells[row][col].center = {};
      cells[row][col].center['bridge-id'] = id;
    }
  }

  // ── Ghost helpers ─────────────────────────────────────────────────────────

  _getGhostPoints() {
    const { dRow, dCol } = this._dragDelta;
    return this._basePoints.map(([r, c]) => [r + dRow, c + dCol]);
  }

  _ghostIsValid() {
    const [gp1, gp2, gp3] = this._getGhostPoints();
    if (isBridgeDegenerate(gp1, gp2, gp3)) return false;
    const occupied = getBridgeOccupiedCells(gp1, gp2, gp3);
    if (occupied.length === 0) return false;
    const cells = state.dungeon.cells;
    const numRows = cells.length, numCols = cells[0]?.length || 0;
    for (const { row, col } of occupied) {
      if (row < 0 || row >= numRows || col < 0 || col >= numCols) return false;
    }
    return true;
  }

  // ── Overlay ───────────────────────────────────────────────────────────────

  renderOverlay(ctx, transform, gridSize) {
    // 1. Drag ghost
    if (this._isDragging) {
      const [gp1, gp2, gp3] = this._getGhostPoints();
      const valid = this._ghostIsValid();
      this._drawBridgePoly(ctx, transform, gridSize, gp1, gp2, gp3, {
        fill:   valid ? 'rgba(100, 200, 255, 0.15)' : 'rgba(255, 80, 80, 0.15)',
        stroke: valid ? 'rgba(100, 200, 255, 0.8)'  : 'rgba(255, 80, 80, 0.8)',
        lineWidth: 2,
      });
      return; // skip placement preview during drag
    }

    // 2. Hover highlight (when not also the selected bridge)
    if (this.hoveredBridgeId != null && this.hoveredBridgeId !== state.selectedBridgeId) {
      const bridge = getBridgeById(this.hoveredBridgeId);
      if (bridge) {
        const [p1, p2, p3] = bridge.points;
        this._drawBridgePoly(ctx, transform, gridSize, p1, p2, p3, {
          fill:      'rgba(150, 220, 255, 0.12)',
          stroke:    'rgba(150, 220, 255, 0.7)',
          lineWidth: 1.5,
          dash:      [4, 3],
        });
      }
    }

    // 3. Selection highlight
    if (state.selectedBridgeId != null) {
      const bridge = getBridgeById(state.selectedBridgeId);
      if (bridge) {
        const [p1, p2, p3] = bridge.points;
        this._drawBridgePoly(ctx, transform, gridSize, p1, p2, p3, {
          fill:      'rgba(60, 140, 255, 0.15)',
          stroke:    'rgba(60, 140, 255, 0.9)',
          lineWidth: 2,
        });
      }
    }

    // 4. Snap dot (shown during placement or when idle with no bridge hovered)
    const hc = state.hoveredCorner;
    if (hc) {
      const p = toCanvas(hc.col * gridSize, hc.row * gridSize, transform);
      ctx.fillStyle = 'rgba(255, 180, 50, 0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 5. Placement preview
    if (this._phase === 'have_p1' && this._p1) {
      const pp1 = toCanvas(this._p1[1] * gridSize, this._p1[0] * gridSize, transform);

      ctx.fillStyle = 'rgba(100, 200, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(pp1.x, pp1.y, 6, 0, Math.PI * 2);
      ctx.fill();

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

      ctx.fillStyle = 'rgba(100, 200, 255, 0.9)';
      for (const pp of [pp1, pp2]) {
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, 6, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pp1.x, pp1.y);
      ctx.lineTo(pp2.x, pp2.y);
      ctx.stroke();

      if (hc && !isBridgeDegenerate(this._p1, this._p2, [hc.row, hc.col])) {
        this._drawPreview(ctx, transform, gridSize, this._p1, this._p2, [hc.row, hc.col]);
      }
    }
  }

  _drawBridgePoly(ctx, transform, gridSize, p1, p2, p3, { fill, stroke, lineWidth = 2, dash = [] } = {}) {
    const corners = getBridgeCorners(p1, p2, p3);
    const pts = corners.map(c => toCanvas(c[1] * gridSize, c[0] * gridSize, transform));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.setLineDash(dash);
    if (fill)   { ctx.fillStyle   = fill;              ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
    ctx.setLineDash([]);
  }

  _drawPreview(ctx, transform, gridSize, p1, p2, p3) {
    this._drawBridgePoly(ctx, transform, gridSize, p1, p2, p3, {
      fill:      'rgba(100, 200, 255, 0.12)',
      stroke:    'rgba(100, 200, 255, 0.6)',
      lineWidth: 1.5,
      dash:      [4, 3],
    });
  }
}
