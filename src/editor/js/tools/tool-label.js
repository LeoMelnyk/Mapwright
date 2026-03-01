// Label tool: two sub-modes — Room Label (auto-increment) and DM Label (free text with scroll backdrop)
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty } from '../state.js';
import { getTransform, requestRender, setCursor } from '../canvas-view.js';
import { toCanvas } from '../utils.js';
import { drawDmLabel } from '../../../render/index.js';


// Rubber stamp cursor — hotspot at bottom center of the stamp head
export const STAMP_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Crect x='6' y='2' width='12' height='8' rx='2' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Crect x='10' y='10' width='4' height='5' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Cpath d='M5 17 C5 15 8 15 8 15 L16 15 C16 15 19 15 19 17 L19 19 L5 19 Z' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Cline x1='5' y1='21' x2='19' y2='21' stroke='%23333' stroke-width='1.5'/%3E%3C/svg%3E") 12 22, crosshair`;

function hasLabel(row, col) {
  const center = state.dungeon.cells[row]?.[col]?.center;
  return !!(center?.label != null || center?.dmLabel != null);
}

export class LabelTool extends Tool {
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
    this._dragGhostCell = null;    // { row, col } — target cell during drag
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
    this._dragGhostCell = null;
  }

  onRightClick(row, col) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;
    if (!cells[row][col]) return;

    // If editing this cell, cancel instead
    if (this._editing && this._editRow === row && this._editCol === col) {
      this._cancel();
      return;
    }

    const cell = cells[row][col];
    const mode = state.labelMode || 'room';

    if (mode === 'room') {
      if (!cell.center?.label) return;
      pushUndo('Remove label');
      delete cell.center.label;
      if (cell.center && Object.keys(cell.center).length === 0) delete cell.center;
      markDirty();
    } else {
      if (!cell.center?.dmLabel) return;
      pushUndo('Remove DM note');
      delete cell.center.dmLabel;
      if (cell.center && Object.keys(cell.center).length === 0) delete cell.center;
      markDirty();
    }
  }

  onMouseMove(row, col, edge, event, pos) {
    if (this._isDragging) {
      this._dragGhostCell = { row, col };
      requestRender();
      return;
    }

    if (this._pendingDrag) {
      const dx = pos.x - this._pendingDragPos.x;
      const dy = pos.y - this._pendingDragPos.y;
      if (Math.sqrt(dx * dx + dy * dy) > 8) {
        this._isDragging = true;
        this._pendingDragPos = null;
        setCursor('grabbing');
        this._dragGhostCell = { row, col };
        requestRender();
      }
      return;
    }

    if (hasLabel(row, col)) {
      if (!this.hoveredLabelCell || this.hoveredLabelCell.row !== row || this.hoveredLabelCell.col !== col) {
        this.hoveredLabelCell = { row, col };
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

  onMouseDown(row, col, _edge, _event, pos) {
    // If already editing (DM mode), commit first
    if (this._editing) this._commit();

    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;

    if (this.hoveredLabelCell) {
      // Select and start pending drag
      this.selectedLabelCell = { row, col };
      this._pendingDrag = { row, col };
      this._pendingDragPos = { x: pos.x, y: pos.y };
      requestRender();
      return;
    }

    // Empty cell: deselect and place
    this.selectedLabelCell = null;
    if (!cells[row][col]) cells[row][col] = {};

    const mode = state.labelMode || 'room';
    if (mode === 'room') {
      this._placeRoomLabel(row, col);
    } else {
      this._startDmEdit(row, col);
    }
  }

  onMouseUp(_row, _col, _edge, _event) {
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

  onKeyDown(event) {
    if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedLabelCell && !this._isDragging) {
      event.preventDefault();
      const { row, col } = this.selectedLabelCell;
      const cell = state.dungeon.cells[row]?.[col];
      if (cell?.center) {
        pushUndo('Remove label');
        delete cell.center.label;
        delete cell.center.dmLabel;
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

  _placeRoomLabel(row, col) {
    const cell = state.dungeon.cells[row][col];
    const nextNum = this._getNextRoomNumber();
    const letter = state.dungeon.metadata.dungeonLetter || 'A';

    pushUndo('Place label');
    if (!cell.center) cell.center = {};
    cell.center.label = letter + nextNum;
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

  _startDmEdit(row, col) {
    const cell = state.dungeon.cells[row][col];
    const currentLabel = cell.center?.dmLabel || '';

    this._editRow = row;
    this._editCol = col;
    this._editing = true;

    // Calculate screen position of cell center
    const gridSize = state.dungeon.metadata.gridSize;
    const transform = getTransform();
    const screenPos = toCanvas((col + 0.5) * gridSize, (row + 0.5) * gridSize, transform);

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
    container.appendChild(input);
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
      if (!cell.center) cell.center = {};
      cell.center.dmLabel = text;
    } else {
      if (cell?.center) {
        delete cell.center.dmLabel;
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
  }

  // ── Drag-to-move ─────────────────────────────────────────────────────────

  _commitDrag() {
    const src = this._pendingDrag;
    const dst = this._dragGhostCell;
    if (!src || !dst || (src.row === dst.row && src.col === dst.col)) {
      this._resetDrag();
      requestRender();
      return;
    }

    const cells = state.dungeon.cells;
    const srcCell = cells[src.row]?.[src.col];
    if (!srcCell?.center) { this._resetDrag(); return; }

    pushUndo('Move label');
    if (!cells[dst.row][dst.col]) cells[dst.row][dst.col] = {};
    if (!cells[dst.row][dst.col].center) cells[dst.row][dst.col].center = {};
    const dstCenter = cells[dst.row][dst.col].center;

    if (srcCell.center.label != null)   { dstCenter.label   = srcCell.center.label;   delete srcCell.center.label; }
    if (srcCell.center.dmLabel != null) { dstCenter.dmLabel = srcCell.center.dmLabel; delete srcCell.center.dmLabel; }
    if (Object.keys(srcCell.center).length === 0) delete srcCell.center;

    this.selectedLabelCell = { row: dst.row, col: dst.col };
    markDirty();
    this._resetDrag();
    requestRender();
  }

  // ── Overlay ───────────────────────────────────────────────────────────────

  renderOverlay(ctx, transform, gridSize) {
    // DM edit scroll preview
    if (this._editing) {
      const row = this._editRow;
      const col = this._editCol;
      const { x, y } = toCanvas((col + 0.5) * gridSize, (row + 0.5) * gridSize, transform);
      const text = this._inputEl?.value || ' ';
      drawDmLabel(ctx, x, y, text, transform.scale);
    }

    // Hover highlight (dashed, when not also the selected cell)
    if (this.hoveredLabelCell && !this._isDragging) {
      const { row, col } = this.hoveredLabelCell;
      const notSelected = !this.selectedLabelCell ||
        this.selectedLabelCell.row !== row || this.selectedLabelCell.col !== col;
      if (notSelected) {
        this._drawCellHighlight(ctx, transform, gridSize, row, col, {
          fill: 'rgba(150, 220, 255, 0.12)', stroke: 'rgba(150, 220, 255, 0.7)',
          lineWidth: 1.5, dash: [4, 3],
        });
      }
    }

    // Selection highlight (solid; dashed during drag to indicate "moving")
    if (this.selectedLabelCell) {
      const { row, col } = this.selectedLabelCell;
      this._drawCellHighlight(ctx, transform, gridSize, row, col, {
        fill:   this._isDragging ? 'rgba(60, 140, 255, 0.08)' : 'rgba(60, 140, 255, 0.15)',
        stroke: 'rgba(60, 140, 255, 0.9)',
        lineWidth: 2,
        dash: this._isDragging ? [4, 3] : [],
      });
    }

    // Drag ghost target (blue fill at drop target)
    if (this._isDragging && this._dragGhostCell) {
      const { row, col } = this._dragGhostCell;
      this._drawCellHighlight(ctx, transform, gridSize, row, col, {
        fill: 'rgba(100, 200, 255, 0.25)', stroke: 'rgba(100, 200, 255, 0.9)',
        lineWidth: 2,
      });
    }
  }

  _drawCellHighlight(ctx, transform, gridSize, row, col, { fill, stroke, lineWidth = 2, dash = [] } = {}) {
    const tl = toCanvas(col * gridSize, row * gridSize, transform);
    const br = toCanvas((col + 1) * gridSize, (row + 1) * gridSize, transform);
    const w = br.x - tl.x, h = br.y - tl.y;
    ctx.setLineDash(dash);
    if (fill)   { ctx.fillStyle   = fill;                                      ctx.fillRect(tl.x, tl.y, w, h); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.strokeRect(tl.x, tl.y, w, h); }
    ctx.setLineDash([]);
  }
}
