// Label tool: two sub-modes — Room Label (auto-increment) and DM Label (free text with scroll backdrop)
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty } from '../state.js';
import { getTransform, requestRender, setCursor } from '../canvas-view.js';
import { toCanvas, fromCanvas } from '../utils.js';
import { drawDmLabel } from '../../../render/index.js';


// Rubber stamp cursor — hotspot at bottom center of the stamp head
/** SVG rubber stamp cursor data URL with bottom-center hotspot. */
export const STAMP_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Crect x='6' y='2' width='12' height='8' rx='2' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Crect x='10' y='10' width='4' height='5' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Cpath d='M5 17 C5 15 8 15 8 15 L16 15 C16 15 19 15 19 17 L19 19 L5 19 Z' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Cline x1='5' y1='21' x2='19' y2='21' stroke='%23333' stroke-width='1.5'/%3E%3C/svg%3E") 12 22, crosshair`;

/** Hit radius in world feet for label proximity detection */
const LABEL_HIT_RADIUS = 2;

/**
 * Get the world-feet position of a label on a cell.
 * Uses labelX/labelY if set, otherwise cell center.
 */
function getLabelWorldPos(row: number, col: number, gridSize: number): { x: number; y: number } | null {
  const center = state.dungeon.cells[row]?.[col]?.center;
  if (!center) return null;
  return {
    // @ts-expect-error — strict-mode migration
    x: center.labelX ?? (col + 0.5) * gridSize,
    // @ts-expect-error — strict-mode migration
    y: center.labelY ?? (row + 0.5) * gridSize,
  };
}

/**
 * Find the nearest label to a world-feet position within LABEL_HIT_RADIUS.
 * Returns { row, col, dist } or null.
 */
function findNearestLabel(worldX: number, worldY: number, gridSize: number): { row: number; col: number; dist: number } | null {
  const cells = state.dungeon.cells;
  let best = null;
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const center = cells[r][c]?.center;
      if (!center?.label && !center?.dmLabel) continue;
      const lx = center.labelX ?? (c + 0.5) * gridSize;
      const ly = center.labelY ?? (r + 0.5) * gridSize;
      const dx = worldX - (lx as number);
      const dy = worldY - (ly as number);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= LABEL_HIT_RADIUS && (!best || dist < best.dist)) {
        best = { row: r, col: c, dist };
      }
    }
  }
  return best;
}

/**
 * Remove label position overrides and clean up empty center objects.
 */
function cleanupLabelPos(center: any): void {
  delete center.labelX;
  delete center.labelY;
  delete center.dmLabelX;
  delete center.dmLabelY;
}

/**
 * Label tool: place auto-incrementing room labels or DM text annotations.
 * Supports drag-to-move and proximity-based hover/selection.
 */
export class LabelTool extends Tool {
  [key: string]: any;
  declare _editing: boolean;
  declare _editRow: number;
  declare _editCol: number;
  declare _inputEl: HTMLInputElement | null;
  declare hoveredLabelCell: { row: number; col: number } | null;
  declare selectedLabelCell: { row: number; col: number } | null;
  declare _pendingDrag: { row: number; col: number } | null;
  declare _pendingDragPos: { x: number; y: number } | null;
  declare _isDragging: boolean;
  declare _dragWorldPos: { x: number; y: number } | null;
  declare _editWorldX: number | undefined;
  declare _editWorldY: number | undefined;

  constructor() {
    super('label', 'L', 'crosshair');
    this._editing = false;
    this._editRow = -1;
    this._editCol = -1;
    this._inputEl = null;

    // Hover / select / drag state
    this.hoveredLabelCell = null;  // { row, col } — label cell under cursor
    this.selectedLabelCell = null; // { row, col } — currently selected label
    this._pendingDrag = null;      // { row, col } — source cell at mousedown
    this._pendingDragPos = null;   // { x, y } — pixel pos at mousedown (threshold)
    this._isDragging = false;
    this._dragWorldPos = null;     // { x, y } — current drag position in world feet
  }

  getCursor() {
    return state.labelMode === 'dm' ? 'text' : STAMP_CURSOR;
  }

  onActivate() {
    state.statusInstruction = state.labelMode === 'dm'
      ? 'Click to place DM annotation · Hover to select/move · Del to delete'
      : 'Click to place room label · Hover to select/move · Del to delete';
  }

  onDeactivate() {
    if (this._editing) this._commit();
    this._resetDrag();
    this.hoveredLabelCell = null;
    this.selectedLabelCell = null;
    state.statusInstruction = null;
  }

  _resetDrag() {
    this._isDragging = false;
    this._pendingDrag = null;
    this._pendingDragPos = null;
    this._dragWorldPos = null;
  }

  onRightClick(row: any, col: any) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;
    if (!cells[row][col]) return;

    // If editing this cell, cancel instead
    if (this._editing && this._editRow === row && this._editCol === col) {
      this._cancel();
      return;
    }

    // Find nearest label to click position (use cell center as approximation for right-click)
    const gridSize = state.dungeon.metadata.gridSize;
    const hit = findNearestLabel((col + 0.5) * gridSize, (row + 0.5) * gridSize, gridSize);
    if (!hit) return;

    const cell = cells[hit.row][hit.col];
    const mode = state.labelMode || 'room';

    if (mode === 'room') {
      if (!cell!.center?.label) return;
      pushUndo('Remove label');
      delete cell!.center.label;
      cleanupLabelPos(cell!.center);
      if (Object.keys(cell!.center).length === 0) delete cell!.center;
      markDirty();
    } else {
      if (!cell!.center?.dmLabel) return;
      pushUndo('Remove DM note');
      delete cell!.center.dmLabel;
      cleanupLabelPos(cell!.center);
      if (Object.keys(cell!.center).length === 0) delete cell!.center;
      markDirty();
    }
  }

  onMouseMove(row: any, col: any, edge: any, event: any, pos: any) {
    const gridSize = state.dungeon.metadata.gridSize;
    const transform = getTransform();
    const world = fromCanvas(pos.x, pos.y, transform);

    if (this._isDragging) {
      this._dragWorldPos = { x: world.x, y: world.y };
      requestRender();
      return;
    }

    if (this._pendingDrag) {
      // @ts-expect-error — strict-mode migration
      const dx = pos.x - this!._pendingDragPos.x;
      // @ts-expect-error — strict-mode migration
      const dy = pos.y - this!._pendingDragPos.y;
      if (Math.sqrt(dx * dx + dy * dy) > 8) {
        this._isDragging = true;
        this._pendingDragPos = null;
        setCursor('grabbing');
        this._dragWorldPos = { x: world.x, y: world.y };
        requestRender();
      }
      return;
    }

    // Proximity-based hover detection
    const hit = findNearestLabel(world.x, world.y, gridSize);
    if (hit) {
      if (!this.hoveredLabelCell || this.hoveredLabelCell.row !== hit.row || this.hoveredLabelCell.col !== hit.col) {
        this.hoveredLabelCell = { row: hit.row, col: hit.col };
        requestRender();
      }
      setCursor('grab');
    } else {
      if (this.hoveredLabelCell) {
        this.hoveredLabelCell = null;
        requestRender();
      }
      setCursor(state.labelMode === 'dm' ? 'text' : STAMP_CURSOR);
    }
  }

  onMouseDown(row: any, col: any, _edge: any, _event: any, pos: any) {
    // If already editing (DM mode), commit first
    if (this._editing) this._commit();

    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;

    if (this.hoveredLabelCell) {
      // Select and start pending drag
      this.selectedLabelCell = { row: this.hoveredLabelCell.row, col: this.hoveredLabelCell.col };
      this._pendingDrag = { row: this.hoveredLabelCell.row, col: this.hoveredLabelCell.col };
      this._pendingDragPos = { x: pos.x, y: pos.y };
      requestRender();
      return;
    }

    // Empty cell: deselect and place
    this.selectedLabelCell = null;
    if (!cells[row][col]) cells[row][col] = {};

    const transform = getTransform();
    const world = fromCanvas(pos.x, pos.y, transform);

    const mode = state.labelMode || 'room';
    if (mode === 'room') {
      this._placeRoomLabel(row, col, world.x, world.y);
    } else {
      this._startDmEdit(row, col, world.x, world.y);
    }
  }

  onMouseUp() {
    if (this._isDragging) {
      this._commitDrag();
      setCursor(this.hoveredLabelCell ? 'grab' : (state.labelMode === 'dm' ? 'text' : STAMP_CURSOR));
      return;
    }
    if (this._pendingDrag) {
      // Click without drag — selection already set on mousedown
      this._resetDrag();
    }
  }

  onKeyDown(event: any) {
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedLabelCell && !this._isDragging) {
      event.preventDefault();
      const { row, col } = this.selectedLabelCell;
      const cell = state.dungeon.cells[row]?.[col];
      if (cell?.center) {
        pushUndo('Remove label');
        delete cell.center.label;
        delete cell.center.dmLabel;
        cleanupLabelPos(cell.center);
        if (Object.keys(cell.center).length === 0) delete cell.center;
        this.selectedLabelCell = null;
        markDirty();
        requestRender();
      }
      return;
    }

    if (event.key === 'Escape' && this._isDragging) {
      this._resetDrag();
      requestRender();
      event.preventDefault();
    }
  }

  // ── Room Label mode: auto-increment, single click ──────────────────────

  _placeRoomLabel(row: any, col: any, worldX: any, worldY: any) {
    const cell = state.dungeon.cells[row][col];
    const nextNum = this._getNextRoomNumber();
    const letter = state.dungeon.metadata.dungeonLetter || 'A';

    pushUndo('Place label');
    if (!cell!.center) cell!.center = {};
    // @ts-expect-error — strict-mode migration
    cell!.center.label = letter + nextNum;
    cell!.center.labelX = worldX;
    cell!.center.labelY = worldY;
    markDirty();
  }

  _getNextRoomNumber() {
    const letter = state.dungeon.metadata.dungeonLetter || 'A';
    const pattern = new RegExp(`^${letter}(\\d+)$`);
    const used = new Set();
    for (const row of state.dungeon.cells) {
      for (const cell of row) {
        if (cell?.center?.label) {
          const m = cell.center.label.match(pattern);
          if (m) used.add(parseInt(m[1]));
        }
      }
    }
    // Return the lowest unused number (fills gaps from deletions)
    for (let n = 1; ; n++) {
      if (!used.has(n)) return n;
    }
  }

  // ── DM Label mode: inline text editing ─────────────────────────────────

  _startDmEdit(row: any, col: any, worldX: any, worldY: any) {
    const cell = state.dungeon.cells[row][col];
    const currentLabel = cell!.center?.dmLabel || '';

    this._editRow = row;
    this._editCol = col;
    this._editWorldX = worldX;
    this._editWorldY = worldY;
    this._editing = true;

    // Calculate screen position from world position
    const transform = getTransform();
    const screenPos = toCanvas(worldX, worldY, transform);

    // Create the input element inside canvas-container
    const container = document.getElementById('canvas-container');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentLabel;
    input.className = 'label-edit-input dm-label';
    input.style.left = `${screenPos.x}px`;
    input.style.top = `${screenPos.y}px`;
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    container!.appendChild(input);
    this._inputEl = input;

    // Focus after a microtask so the mousedown doesn't steal focus
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    // Event listeners
    input.addEventListener('input', () => requestRender());
    input.addEventListener('blur', () => this._commit());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // prevent tool shortcuts while typing
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this._cancel();
      }
    });

    // Render the scroll background via overlay
    requestRender();
  }

  _commit() {
    if (!this._editing) return;

    const cells = state.dungeon.cells;
    const cell = cells[this._editRow]?.[this._editCol];
    const text = this._inputEl?.value.trim() || '';

    pushUndo('DM note');

    if (text) {
      if (!cell!.center) cell!.center = {};
      cell!.center.dmLabel = text;
      cell!.center.dmLabelX = this._editWorldX;
      cell!.center.dmLabelY = this._editWorldY;
    } else {
      if (cell?.center) {
        delete cell.center.dmLabel;
        delete cell.center.dmLabelX;
        delete cell.center.dmLabelY;
        if (Object.keys(cell.center).length === 0) delete cell.center;
      }
    }

    this._cleanup();
    markDirty();
    requestRender();
  }

  _cancel() {
    this._cleanup();
    requestRender();
  }

  _cleanup() {
    // Set _editing false BEFORE removing input — removal triggers blur,
    // which calls _commit(), and we need it to bail out early.
    this._editing = false;
    if (this._inputEl) {
      this._inputEl.remove();
      this._inputEl = null;
    }
    this._editRow = -1;
    this._editCol = -1;
    this._editWorldX = undefined;
    this._editWorldY = undefined;
  }

  // ── Drag-to-move ─────────────────────────────────────────────────────────

  _commitDrag() {
    const src = this._pendingDrag;
    const worldPos = this._dragWorldPos;
    if (!src || !worldPos) {
      this._resetDrag();
      requestRender();
      return;
    }

    const cells = state.dungeon.cells;
    const srcCell = cells[src.row]?.[src.col];
    if (!srcCell?.center) { this._resetDrag(); return; }

    const gridSize = state.dungeon.metadata.gridSize;
    // Find destination cell from world position
    const dstRow = Math.floor(worldPos.y / gridSize);
    const dstCol = Math.floor(worldPos.x / gridSize);

    // Clamp to grid bounds
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const clampedRow = Math.max(0, Math.min(numRows - 1, dstRow));
    const clampedCol = Math.max(0, Math.min(numCols - 1, dstCol));

    pushUndo('Move label');

    if (clampedRow === src.row && clampedCol === src.col) {
      // Same cell — just update position
      if (srcCell.center.label != null) {
        srcCell.center.labelX = worldPos.x;
        srcCell.center.labelY = worldPos.y;
      }
      if (srcCell.center.dmLabel != null) {
        srcCell.center.dmLabelX = worldPos.x;
        srcCell.center.dmLabelY = worldPos.y;
      }
    } else {
      // Different cell — move label data and set position
      if (!cells[clampedRow][clampedCol]) cells[clampedRow][clampedCol] = {};
      if (!cells[clampedRow][clampedCol].center) cells[clampedRow][clampedCol].center = {};
      const dstCenter = cells[clampedRow][clampedCol].center;

      if (srcCell.center.label != null) {
        dstCenter.label = srcCell.center.label;
        dstCenter.labelX = worldPos.x;
        dstCenter.labelY = worldPos.y;
        delete srcCell.center.label;
        delete srcCell.center.labelX;
        delete srcCell.center.labelY;
      }
      if (srcCell.center.dmLabel != null) {
        dstCenter.dmLabel = srcCell.center.dmLabel;
        dstCenter.dmLabelX = worldPos.x;
        dstCenter.dmLabelY = worldPos.y;
        delete srcCell.center.dmLabel;
        delete srcCell.center.dmLabelX;
        delete srcCell.center.dmLabelY;
      }
      if (Object.keys(srcCell.center).length === 0) delete srcCell.center;
    }

    this.selectedLabelCell = { row: clampedRow, col: clampedCol };
    markDirty();
    this._resetDrag();
    requestRender();
  }

  // ── Overlay ───────────────────────────────────────────────────────────────

  renderOverlay(ctx: any, transform: any, gridSize: any) {
    // DM edit scroll preview
    if (this._editing) {
      const wx = this._editWorldX ?? (this._editCol + 0.5) * gridSize;
      const wy = this._editWorldY ?? (this._editRow + 0.5) * gridSize;
      const { x, y } = toCanvas(wx, wy, transform);
      const text = this._inputEl?.value || ' ';
      drawDmLabel(ctx, x, y, text, transform.scale);
    }

    // Hover highlight (dashed circle at label position)
    if (this.hoveredLabelCell && !this._isDragging) {
      const { row, col } = this.hoveredLabelCell;
      const notSelected = !this.selectedLabelCell ||
        this.selectedLabelCell.row !== row || this.selectedLabelCell.col !== col;
      if (notSelected) {
        this._drawLabelHighlight(ctx, transform, gridSize, row, col, {
          fill: 'rgba(150, 220, 255, 0.12)', stroke: 'rgba(150, 220, 255, 0.7)',
          // @ts-expect-error — strict-mode migration
          lineWidth: 1.5, dash: [4, 3],
        });
      }
    }

    // Selection highlight (solid; dashed during drag to indicate "moving")
    if (this.selectedLabelCell) {
      const { row, col } = this.selectedLabelCell;
      this._drawLabelHighlight(ctx, transform, gridSize, row, col, {
        fill:   this._isDragging ? 'rgba(60, 140, 255, 0.08)' : 'rgba(60, 140, 255, 0.15)',
        stroke: 'rgba(60, 140, 255, 0.9)',
        lineWidth: 2,
        // @ts-expect-error — strict-mode migration
        dash: this._isDragging ? [4, 3] : [],
      });
    }

    // Drag ghost (circle at drag position)
    if (this._isDragging && this._dragWorldPos) {
      const p = toCanvas(this._dragWorldPos.x, this._dragWorldPos.y, transform);
      const radius = LABEL_HIT_RADIUS * transform.scale;
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(100, 200, 255, 0.25)';
      ctx.strokeStyle = 'rgba(100, 200, 255, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** Draw a highlight circle around a label's world position */
  // @ts-expect-error — strict-mode migration
  _drawLabelHighlight(ctx: any, transform: any, gridSize: any, row: any, col: any, { fill, stroke, lineWidth = 2, dash = [] } = {}) {
    const pos = getLabelWorldPos(row, col, gridSize);
    if (!pos) return;
    const p = toCanvas(pos.x, pos.y, transform);
    const radius = LABEL_HIT_RADIUS * transform.scale;
    ctx.setLineDash(dash);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
