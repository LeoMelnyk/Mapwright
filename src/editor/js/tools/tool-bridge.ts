// Bridge tool: 3-click corner-point placement + hover/select/move/rotate
// P1 → P2: entrance width.  P3: depth direction (always rectangular).
import type { BridgeType, Bridge, RenderTransform } from '../../../types.js';
import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { pushUndo, markDirty, notify } from '../state.js';
import { accumulateDirtyRect, bumpContentVersion } from '../../../render/index.js';
import { requestRender, getTransform, setCursor } from '../canvas-view.js';
import { toCanvas, nearestCorner } from '../utils.js';
import { isBridgeDegenerate, getBridgeCorners, getBridgeOccupiedCells } from '../bridge-geometry.js';
import { showToast } from '../toast.js';

const DRAG_THRESHOLD = 8; // pixels

// ── Helpers ───────────────────────────────────────────────────────────────────

function bridgeIdAt(row: number, col: number): number | null {
  const cell = state.dungeon.cells[row]?.[col];
  if (!cell?.center) return null;
  const id = cell.center['bridge-id'];
  return id != null ? id as number : null;
}

function getBridgeById(id: number): Bridge | null {
  return state.dungeon.metadata.bridges.find(b => b.id === id) ?? null;
}

/**
 * Rotate 3 control points 90° CW around the centroid of the bridge's 4 corners.
 * @param {number[][]} pts - [[r,c], [r,c], [r,c]]
 * @returns {number[][]}
 */
function rotatePts90CW(pts: number[][]): number[][] {
  const corners = getBridgeCorners(pts[0], pts[1], pts[2]);
  const cR = corners.reduce((s, c) => s + c[0], 0) / 4;
  const cC = corners.reduce((s, c) => s + c[1], 0) / 4;
  return pts.map(([r, c]) => [cR + (c - cC), cC - (r - cR)]);
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export class BridgeTool extends Tool {
  _phase: string = 'idle';
  _p1: [number, number] | null = null;
  _p2: [number, number] | null = null;
  hoveredBridgeId: number | null = null;
  _isDragging: boolean = false;
  _dragBridgeId: number | null = null;
  _dragStartPos: { x: number; y: number } | null = null;
  _dragOrigPoints: [number, number][] | null = null;
  _pendingDrag: { bridgeId: number } | null = null;
  _pendingDragPos: { x: number; y: number } | null = null;
  _pendingDragCorner: { row: number; col: number } | null = null;
  _basePoints: [number, number][] | null = null;
  _dragDelta: { dRow: number; dCol: number } = { dRow: 0, dCol: 0 };

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

  onKeyDown(event: KeyboardEvent) {
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
        notify();
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
        this._dirtyFromBridge(bridge.id);
        this._clearCellMarkers(bridge.id);
        bridge.points = rotated as Bridge['points'];
        this._setCellMarkers(bridge.id, occupied);
        this._dirtyFromCells(occupied);
        markDirty();
        notify();
        requestRender();
      }
      return;
    }
  }

  onRightClick(row: number, col: number) {
    if (this._isDragging) return;
    const id = bridgeIdAt(row, col);
    if (id == null) return;
    pushUndo('Remove Bridge');
    if (state.selectedBridgeId === id) state.selectedBridgeId = null;
    this._removeBridge(id);
    markDirty();
    notify();
    requestRender();
  }

  onMouseDown(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
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
        this._pendingDragPos = { x: pos!.x, y: pos!.y };
        this._pendingDragCorner = { row: corner.row, col: corner.col };
        this._basePoints = bridge.points.map(p => [...p] as [number, number]);
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

  onMouseMove(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
    if (this._isDragging) {
      const cur = this._cornerFromPos(pos);
      this._dragDelta = {
        dRow: cur.row - this._pendingDragCorner!.row,
        dCol: cur.col - this._pendingDragCorner!.col,
      };
      state.hoveredCorner = null;
      return;
    }

    if (this._pendingDrag) {
      const dx = pos!.x - this._pendingDragPos!.x;
      const dy = pos!.y - this._pendingDragPos!.y;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        this._isDragging = true;
        this._dragBridgeId = this._pendingDrag.bridgeId;
        this._pendingDrag = null;
        setCursor('grabbing');
        const cur = this._cornerFromPos(pos);
        this._dragDelta = {
          dRow: cur.row - this._pendingDragCorner!.row,
          dCol: cur.col - this._pendingDragCorner!.col,
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

  _cornerFromPos(pos: CanvasPos | null) {
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize;
    return nearestCorner(pos!.x, pos!.y, transform, gridSize);
  }

  // ── Placement ────────────────────────────────────────────────────────────────

  _handleClick(corner: { row: number; col: number }) {
    if (this._phase === 'idle') {
      this._p1 = [corner.row, corner.col];
      this._phase = 'have_p1';
      requestRender();
      return;
    }

    if (this._phase === 'have_p1') {
      const p2: [number, number] = [corner.row, corner.col];
      if (p2[0] === this._p1![0] && p2[1] === this._p1![1]) {
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
      const p3: [number, number] = [corner.row, corner.col];

      if (isBridgeDegenerate(this._p1!, this._p2!, p3)) {
        showToast('Bridge has zero depth. Choose a point off the entrance line.', 'warning');
        return;
      }

      const occupied = getBridgeOccupiedCells(this._p1!, this._p2!, p3);
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

      this._commitBridge(this._p1!, this._p2!, p3, occupied);
      this._resetPlacement();
    }
  }

  // ── Commit / Remove ───────────────────────────────────────────────────────

  _commitBridge(p1: [number, number], p2: [number, number], p3: [number, number], occupiedCells: { row: number; col: number }[]) {
    pushUndo('Place Bridge');

    const meta = state.dungeon.metadata;
    const id = meta.nextBridgeId++;
    const type = (state.bridgeType || 'wood') as BridgeType;
    const corners = getBridgeCorners(p1, p2, p3);

    // Geometry diagnostics for angle-dependent rendering bugs
    const baseR = p2[0] - p1[0], baseC = p2[1] - p1[1];
    const baseLen = Math.sqrt(baseR * baseR + baseC * baseC);
    const angleDeg = Math.atan2(baseC, baseR) * 180 / Math.PI;
    const depthR = corners[3][0] - p1[0], depthC = corners[3][1] - p1[1];
    const depthLen = Math.sqrt(depthR * depthR + depthC * depthC);
    console.log(`[bridge] Placed bridge ${id} (${type})`, {
      points: { p1, p2, p3 },
      corners,
      angleDeg: Math.round(angleDeg * 10) / 10,
      baseLen: Math.round(baseLen * 100) / 100,
      depthLen: Math.round(depthLen * 100) / 100,
      occupiedCells: occupiedCells.length,
      cells: occupiedCells.map(c => `[${c.row},${c.col}]`).join(' '),
    });

    meta.bridges.push({ id, type, points: [p1, p2, p3] });

    this._setCellMarkers(id, occupiedCells);
    this._dirtyFromCells(occupiedCells);
    markDirty();
    notify();
    requestRender();
  }

  _commitDrag() {
    const id = this._dragBridgeId;
    const bridge = getBridgeById(id!);
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
    this._dirtyFromBridge(id!);
    this._clearCellMarkers(id!);
    bridge.points = ghostPts as Bridge['points'];
    this._setCellMarkers(id!, occupied);
    this._dirtyFromCells(occupied);
    markDirty();
    notify();
    this._resetDrag();
    requestRender();
  }

  _removeBridge(id: number) {
    // Accumulate dirty rect before clearing markers
    this._dirtyFromBridge(id);
    this._clearCellMarkers(id);
    const bridges = state.dungeon.metadata.bridges;
    const idx = bridges.findIndex(b => b.id === id);
    if (idx !== -1) bridges.splice(idx, 1);
  }

  /** Accumulate dirty rect from a bridge's occupied cells. */
  _dirtyFromBridge(id: number) {
    const cells = state.dungeon.cells;
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        if (cells[r]?.[c]?.center?.['bridge-id'] === id) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    if (minR <= maxR) {
      accumulateDirtyRect(minR, minC, maxR, maxC);
      bumpContentVersion();
    }
  }

  /** Accumulate dirty rect from a list of occupied cells. */
  _dirtyFromCells(occupiedCells: { row: number; col: number }[]) {
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (const { row, col } of occupiedCells) {
      if (row < minR) minR = row;
      if (row > maxR) maxR = row;
      if (col < minC) minC = col;
      if (col > maxC) maxC = col;
    }
    if (minR <= maxR) {
      accumulateDirtyRect(minR, minC, maxR, maxC);
      bumpContentVersion();
    }
  }

  _clearCellMarkers(id: number) {
    const cells = state.dungeon.cells;
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[r]?.length || 0); c++) {
        if (cells[r]?.[c]?.center?.['bridge-id'] === id) {
          delete cells[r][c]!.center!['bridge-id'];
          if (Object.keys(cells[r][c]!.center!).length === 0) delete cells[r][c]!.center;
        }
      }
    }
  }

  _setCellMarkers(id: number, occupiedCells: { row: number; col: number }[]) {
    const cells = state.dungeon.cells;
    for (const { row, col } of occupiedCells) {
      if (!cells[row]?.[col]) continue;
      cells[row][col].center ??= {};
      cells[row][col].center['bridge-id'] = id;
    }
  }

  // ── Ghost helpers ─────────────────────────────────────────────────────────

  _getGhostPoints() {
    const { dRow, dCol } = this._dragDelta as { dRow: number; dCol: number };
    return this._basePoints!.map(([r, c]) => [r + dRow, c + dCol] as [number, number]);
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

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
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

  _drawBridgePoly(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number, p1: [number, number], p2: [number, number], p3: [number, number], { fill, stroke, lineWidth = 2, dash = [] }: { fill?: string; stroke?: string; lineWidth?: number; dash?: number[] } = {}) {
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

  _drawPreview(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number, p1: [number, number], p2: [number, number], p3: [number, number]) {
    this._drawBridgePoly(ctx, transform, gridSize, p1, p2, p3, {
      fill:      'rgba(100, 200, 255, 0.12)',
      stroke:    'rgba(100, 200, 255, 0.6)',
      lineWidth: 1.5,
      dash:      [4, 3],
    });
  }
}
