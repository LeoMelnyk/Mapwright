// Range detector tool: click+drag to measure spell/effect areas.
// Shared by DM (session mode) and player views via dependency injection.

import { Tool } from './tool-base.js';
import { toCanvas } from '../utils.js';
import { computeLine, computeCone, computeCircle, computeCube } from '../../../util/index.js';

const SHAPE_FNS = { line: computeLine, cone: computeCone, circle: computeCircle, cube: computeCube };
// Highlight colors — use bright fills + contrasting borders visible on any background
const FILL_COLOR = 'rgba(180, 100, 255, 0.35)';
const BORDER_COLOR = 'rgba(255, 255, 255, 0.9)';
const BORDER_SHADOW = 'rgba(80, 0, 160, 0.9)';
const COMMITTED_FILL = 'rgba(180, 100, 255, 0.3)';
const COMMITTED_BORDER = 'rgba(255, 255, 255, 0.8)';
const COMMITTED_SHADOW = 'rgba(80, 0, 160, 0.8)';
const REMOTE_FILL = 'rgba(60, 200, 255, 0.3)';
const REMOTE_BORDER = 'rgba(255, 255, 255, 0.8)';
const REMOTE_SHADOW = 'rgba(0, 80, 140, 0.8)';
const SHAPE_LINE_COLOR = 'rgba(255, 220, 100, 0.9)';
const CLEAR_TIMEOUT = 20000;

/**
 * Range detector tool: click+drag to measure spell/effect areas (line, cone, circle, cube).
 * Shared by DM (session mode) and player views via dependency injection.
 */
export class RangeTool extends Tool {
  declare _send: Function;
  declare _gridInfo: Function;
  declare _requestRender: Function;
  declare subTool: string;
  declare fixedRange: number;
  declare dragging: boolean;
  declare dragStart: { row: number; col: number } | null;
  declare dragEnd: { row: number; col: number } | null;
  declare mousePos: { x: number; y: number } | null;
  declare hoverCell: { row: number; col: number } | null;
  declare committedHighlight: any;
  declare remoteHighlight: any;
  declare _clearTimer: ReturnType<typeof setTimeout> | null;
  declare _remoteClearTimer: ReturnType<typeof setTimeout> | null;

  /**
   * @param {Function} sendFn       - (msg) => void, broadcasts to server
   * @param {Function} getGridInfo  - () => { gridSize, numRows, numCols }
   * @param {Function} requestRender - () => void, triggers canvas re-render
   */
  constructor(sendFn: Function, getGridInfo: Function, requestRender: Function) {
    super('range', 'R', 'crosshair');
    this._send = sendFn;
    this._gridInfo = getGridInfo;
    this._requestRender = requestRender;

    this.subTool = 'circle';
    this.fixedRange = 0; // 0 = auto (drag distance), >0 = fixed range in feet
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    this.hoverCell = null; // tracks mouse position for hover preview

    this.committedHighlight = null; // { cells, distanceFt, subTool }
    this.remoteHighlight = null;    // same shape
    this._clearTimer = null;
    this._remoteClearTimer = null;
  }

  setSubTool(name: string): void {
    if (SHAPE_FNS[name]) this.subTool = name;
  }

  setFixedRange(ft: number): void {
    this.fixedRange = ft;
  }

  /** Circle and cube with a fixed range are click-to-place (no drag needed). */
  _isClickToPlace() {
    return this.fixedRange > 0 && (this.subTool === 'circle' || this.subTool === 'cube');
  }

  /**
   * When fixedRange is set, compute an end cell at exactly that distance
   * in the direction of the mouse (dragEnd), keeping direction but overriding distance.
   * Line tool always ignores fixedRange.
   */
  _getEffectiveEnd(gridSize) {
    if (!this.dragStart || !this.dragEnd) return this.dragEnd;
    if (!this.fixedRange || this.subTool === 'line') return this.dragEnd;

    const dr = this.dragEnd.row - this.dragStart.row;
    const dc = this.dragEnd.col - this.dragStart.col;
    const fixedCells = this.fixedRange / gridSize;

    // Cube uses Chebyshev distance (max component) and computeCube adds +1,
    // so we target fixedCells-1 as the max component offset.
    if (this.subTool === 'cube') {
      const maxComp = Math.max(Math.abs(dr), Math.abs(dc));
      if (maxComp < 0.01) return this.dragEnd;
      const needed = fixedCells - 1; // 5ft cube → needed=0 → same cell → side=1
      if (needed < 0.01) return this.dragStart;
      const scale = needed / maxComp;
      return {
        row: Math.round(this.dragStart.row + dr * scale),
        col: Math.round(this.dragStart.col + dc * scale),
      };
    }

    // Circle/cone use Euclidean distance
    const dist = Math.sqrt(dr * dr + dc * dc);
    if (dist < 0.01) return this.dragEnd;
    const scale = fixedCells / dist;
    return {
      row: Math.round(this.dragStart.row + dr * scale),
      col: Math.round(this.dragStart.col + dc * scale),
    };
  }

  onActivate() {
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    this.hoverCell = null;
  }

  onDeactivate() {
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    this.hoverCell = null;
  }

  onRightClick() {
    this._clearCommitted();
    this._clearRemote();
    this._requestRender();
  }

  onMouseDown(row, col, _edge, _event, pos) {
    const { gridSize, numRows, numCols } = this._gridInfo();
    if (row < 0 || row >= numRows || col < 0 || col >= numCols) return;

    // Clear any existing committed highlight
    this._clearCommitted();
    this._clearRemote();

    // Click-to-place: circle/cube with fixed range commit immediately
    if (this._isClickToPlace()) {
      // Synthesize an end cell at fixed distance (direction: right, arbitrary since circle/cube are symmetric from origin)
      const fixedCells = this.fixedRange / gridSize;
      // Cube: computeCube adds +1 to max component, so offset by fixedCells-1
      const endOffset = this.subTool === 'cube' ? Math.round(fixedCells) - 1 : Math.round(fixedCells);
      const endRow = row + endOffset;
      const endCol = col;

      const fn = SHAPE_FNS[this.subTool];
      const result = fn(row, col, endRow, endCol, gridSize, numRows, numCols);

      this.committedHighlight = { cells: result.cells, distanceFt: result.distanceFt, subTool: this.subTool };
      this._send({
        type: 'range:highlight',
        cells: result.cells.map(c => ({ row: c.row, col: c.col })),
        distanceFt: result.distanceFt,
        subTool: this.subTool,
      });
      this._clearTimer = setTimeout(() => { this.committedHighlight = null; this._requestRender(); }, CLEAR_TIMEOUT);
      this._requestRender();
      return;
    }

    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.mousePos = pos || null;

    this._requestRender();
  }

  onMouseMove(row, col, _edge, _event, pos) {
    const { numRows, numCols } = this._gridInfo();
    row = Math.max(0, Math.min(numRows - 1, row));
    col = Math.max(0, Math.min(numCols - 1, col));

    // Always track hover for click-to-place preview
    const prevHover = this.hoverCell;
    this.hoverCell = { row, col };

    if (this.dragging) {
      this.dragEnd = { row, col };
      this.mousePos = pos || null;
      this._requestRender();
    } else if (this._isClickToPlace()) {
      // Re-render hover preview only when cell changes
      if (!prevHover || prevHover.row !== row || prevHover.col !== col) {
        this._requestRender();
      }
    }
  }

  onMouseUp(row, col) {
    if (!this.dragging) return;
    this.dragging = false;

    const { gridSize, numRows, numCols } = this._gridInfo();
    row = Math.max(0, Math.min(numRows - 1, row));
    col = Math.max(0, Math.min(numCols - 1, col));
    this.dragEnd = { row, col };

    // Compute final shape (use effective end for fixed range)
    const end = this._getEffectiveEnd(gridSize);
    const fn = SHAPE_FNS[this.subTool];
    const result = fn(this.dragStart.row, this.dragStart.col, end.row, end.col, gridSize, numRows, numCols);

    this.committedHighlight = {
      cells: result.cells,
      distanceFt: result.distanceFt,
      subTool: this.subTool,
    };

    // Broadcast to other clients
    this._send({
      type: 'range:highlight',
      cells: result.cells.map(c => ({ row: c.row, col: c.col })),
      distanceFt: result.distanceFt,
      subTool: this.subTool,
    });

    // Auto-clear after timeout (or when next measurement starts)
    this._clearTimer = setTimeout(() => {
      this.committedHighlight = null;
      this._requestRender();
    }, CLEAR_TIMEOUT);

    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    this._requestRender();
  }

  /** Called when a range:highlight arrives from the network. */
  applyRemoteHighlight(msg) {
    this._clearRemote();
    this.remoteHighlight = {
      cells: msg.cells,
      distanceFt: msg.distanceFt,
      subTool: msg.subTool,
    };
    this._remoteClearTimer = setTimeout(() => {
      this.remoteHighlight = null;
      this._requestRender();
    }, CLEAR_TIMEOUT);
    this._requestRender();
  }

  _clearCommitted() {
    if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
    this.committedHighlight = null;
  }

  _clearRemote() {
    if (this._remoteClearTimer) { clearTimeout(this._remoteClearTimer); this._remoteClearTimer = null; }
    this.remoteHighlight = null;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  renderOverlay(ctx, transform, gridSize) {
    const { numRows, numCols } = this._gridInfo();

    // 1. Remote highlight (bottom layer)
    if (this.remoteHighlight) {
      this._drawCells(ctx, transform, gridSize, this.remoteHighlight.cells, REMOTE_FILL, REMOTE_BORDER, REMOTE_SHADOW);
    }

    // 2. Committed highlight (own measurement)
    if (this.committedHighlight) {
      this._drawCells(ctx, transform, gridSize, this.committedHighlight.cells, COMMITTED_FILL, COMMITTED_BORDER, COMMITTED_SHADOW);
    }

    // 3. Live drag preview (top layer)
    if (this.dragging && this.dragStart && this.dragEnd) {
      const end = this._getEffectiveEnd(gridSize);
      const fn = SHAPE_FNS[this.subTool];
      const result = fn(this.dragStart.row, this.dragStart.col, end.row, end.col, gridSize, numRows, numCols);
      this._drawCells(ctx, transform, gridSize, result.cells, FILL_COLOR, BORDER_COLOR, BORDER_SHADOW);

      // Draw shape-specific overlays
      if (this.subTool === 'line') {
        this._drawLineOverlay(ctx, transform, gridSize, end);
      } else if (this.subTool === 'cone') {
        this._drawConeOverlay(ctx, transform, gridSize, end);
      } else if (this.subTool === 'circle') {
        this._drawCircleOverlay(ctx, transform, gridSize, result.distanceFt);
      } else if (this.subTool === 'cube') {
        this._drawCubeOverlay(ctx, transform, gridSize, result.cells);
      }

      // Draw origin marker
      this._drawOriginMarker(ctx, transform, gridSize);

      // Draw distance label
      this._drawLabel(ctx, result.distanceFt, this.subTool);
    }

    // 4. Hover preview for click-to-place (circle/cube with fixed range)
    if (!this.dragging && this.hoverCell && this._isClickToPlace()) {
      const fixedCells = this.fixedRange / gridSize;
      const hOffset = this.subTool === 'cube' ? Math.round(fixedCells) - 1 : Math.round(fixedCells);
      const hEnd = { row: this.hoverCell.row + hOffset, col: this.hoverCell.col };
      const fn = SHAPE_FNS[this.subTool];
      const hResult = fn(this.hoverCell.row, this.hoverCell.col, hEnd.row, hEnd.col, gridSize, numRows, numCols);
      this._drawCells(ctx, transform, gridSize, hResult.cells, FILL_COLOR, BORDER_COLOR, BORDER_SHADOW);

      if (this.subTool === 'circle') {
        this._drawCircleOverlayAt(ctx, transform, gridSize, this.hoverCell, hResult.distanceFt);
      } else if (this.subTool === 'cube') {
        this._drawCubeOverlay(ctx, transform, gridSize, hResult.cells);
      }
    }
  }

  _drawCells(ctx, transform, gridSize, cells, fillColor, borderColor, shadowColor) {
    const cellPx = gridSize * transform.scale;

    // Build a set for fast neighbor lookup (for border drawing)
    const cellSet = new Set(cells.map(c => `${c.row},${c.col}`));

    // Fill with hatched pattern for visibility on any background
    ctx.fillStyle = fillColor;
    for (const { row, col } of cells) {
      const p = toCanvas(col * gridSize, row * gridSize, transform);
      ctx.fillRect(p.x, p.y, cellPx, cellPx);
    }

    // Draw diagonal hatch lines over each cell for extra visibility
    ctx.save();
    ctx.strokeStyle = borderColor;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    const step = Math.max(6, cellPx / 4);
    for (const { row, col } of cells) {
      const p = toCanvas(col * gridSize, row * gridSize, transform);
      ctx.beginPath();
      for (let d = -cellPx; d < cellPx * 2; d += step) {
        const x0 = Math.max(p.x, p.x + d);
        const y0 = Math.max(p.y, p.y - d + cellPx);
        const x1 = Math.min(p.x + cellPx, p.x + d + cellPx);
        const y1 = Math.min(p.y + cellPx, p.y - d);
        if (x0 < p.x + cellPx && x1 > p.x && y0 > p.y && y1 < p.y + cellPx) {
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    // Collect border segments (edges facing non-highlighted cells)
    const segments = [];
    for (const { row, col } of cells) {
      const x = col * gridSize;
      const y = row * gridSize;
      if (!cellSet.has(`${row - 1},${col}`)) {
        segments.push([toCanvas(x, y, transform), toCanvas(x + gridSize, y, transform)]);
      }
      if (!cellSet.has(`${row + 1},${col}`)) {
        segments.push([toCanvas(x, y + gridSize, transform), toCanvas(x + gridSize, y + gridSize, transform)]);
      }
      if (!cellSet.has(`${row},${col - 1}`)) {
        segments.push([toCanvas(x, y, transform), toCanvas(x, y + gridSize, transform)]);
      }
      if (!cellSet.has(`${row},${col + 1}`)) {
        segments.push([toCanvas(x + gridSize, y, transform), toCanvas(x + gridSize, y + gridSize, transform)]);
      }
    }

    // Draw dark shadow border first (wider), then bright border on top
    if (shadowColor) {
      ctx.strokeStyle = shadowColor;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (const [a, b] of segments) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
    }
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of segments) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
  }

  /** Draw a line from start cell center to end cell center. */
  _drawLineOverlay(ctx, transform, gridSize, end) {
    const sx = this.dragStart.col * gridSize + gridSize / 2;
    const sy = this.dragStart.row * gridSize + gridSize / 2;
    const ex = end.col * gridSize + gridSize / 2;
    const ey = end.row * gridSize + gridSize / 2;

    const p1 = toCanvas(sx, sy, transform);
    const p2 = toCanvas(ex, ey, transform);

    ctx.save();
    ctx.setLineDash([6, 4]);
    // Dark shadow
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    // Bright line
    ctx.strokeStyle = SHAPE_LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Draw cone wedge: two lines from origin + straight edge at distance. */
  _drawConeOverlay(ctx, transform, gridSize, end) {
    const sx = this.dragStart.col * gridSize + gridSize / 2;
    const sy = this.dragStart.row * gridSize + gridSize / 2;
    const ex = end.col * gridSize + gridSize / 2;
    const ey = end.row * gridSize + gridSize / 2;

    const origin = toCanvas(sx, sy, transform);
    const angle = Math.atan2(ey - sy, ex - sx);
    const halfAngle = Math.PI / 4; // 45 degrees each side
    // Exact center-to-center distance, then push tips out so the far edge
    // midpoint reaches the target cell center (matches computeCone geometry)
    const dx = ex - sx, dy = ey - sy;
    const tipPx = (Math.sqrt(dx * dx + dy * dy) / Math.cos(halfAngle)) * transform.scale;

    // Two edge endpoints
    const leftAngle = angle - halfAngle;
    const rightAngle = angle + halfAngle;
    const leftEnd = { x: origin.x + Math.cos(leftAngle) * tipPx, y: origin.y + Math.sin(leftAngle) * tipPx };
    const rightEnd = { x: origin.x + Math.cos(rightAngle) * tipPx, y: origin.y + Math.sin(rightAngle) * tipPx };

    ctx.save();
    ctx.setLineDash([6, 4]);
    // Dark shadow
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(leftEnd.x, leftEnd.y);
    ctx.lineTo(rightEnd.x, rightEnd.y);
    ctx.lineTo(origin.x, origin.y);
    ctx.stroke();
    // Bright line
    ctx.strokeStyle = SHAPE_LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(leftEnd.x, leftEnd.y);
    ctx.lineTo(rightEnd.x, rightEnd.y);
    ctx.lineTo(origin.x, origin.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Draw circle outline at the measured radius. */
  _drawCircleOverlay(ctx, transform, gridSize, distanceFt) {
    const sx = this.dragStart.col * gridSize + gridSize / 2;
    const sy = this.dragStart.row * gridSize + gridSize / 2;
    const origin = toCanvas(sx, sy, transform);
    const radiusPx = (distanceFt / gridSize) * gridSize * transform.scale;

    ctx.save();
    ctx.setLineDash([6, 4]);
    // Dark shadow
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    // Bright line
    ctx.strokeStyle = SHAPE_LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Draw circle outline centered on an arbitrary cell (for hover preview). */
  _drawCircleOverlayAt(ctx, transform, gridSize, cell, distanceFt) {
    const sx = cell.col * gridSize + gridSize / 2;
    const sy = cell.row * gridSize + gridSize / 2;
    const origin = toCanvas(sx, sy, transform);
    const radiusPx = (distanceFt / gridSize) * gridSize * transform.scale;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = SHAPE_LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Draw cube outline around the affected cells. */
  _drawCubeOverlay(ctx, transform, gridSize, cells) {
    if (cells.length === 0) return;

    // Find bounding box of the cube cells
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (const { row, col } of cells) {
      if (row < minR) minR = row;
      if (row > maxR) maxR = row;
      if (col < minC) minC = col;
      if (col > maxC) maxC = col;
    }

    const p1 = toCanvas(minC * gridSize, minR * gridSize, transform);
    const p2 = toCanvas((maxC + 1) * gridSize, (maxR + 1) * gridSize, transform);
    const w = p2.x - p1.x;
    const h = p2.y - p1.y;

    ctx.save();
    ctx.setLineDash([6, 4]);
    // Dark shadow
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 4;
    ctx.strokeRect(p1.x, p1.y, w, h);
    // Bright line
    ctx.strokeStyle = SHAPE_LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(p1.x, p1.y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawOriginMarker(ctx, transform, gridSize) {
    if (!this.dragStart) return;
    const cx = this.dragStart.col * gridSize + gridSize / 2;
    const cy = this.dragStart.row * gridSize + gridSize / 2;
    const p = toCanvas(cx, cy, transform);
    const r = gridSize * transform.scale * 0.18;

    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = SHAPE_LINE_COLOR;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _drawLabel(ctx, distanceFt, subTool) {
    if (!this.mousePos) return;
    const label = `${distanceFt} ft ${subTool}`;

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
}
