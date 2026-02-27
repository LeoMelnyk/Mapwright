// Label tool: two sub-modes — Room Label (auto-increment) and DM Label (free text with scroll backdrop)
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, getTheme } from '../state.js';
import { getTransform, requestRender } from '../canvas-view.js';
import { toCanvas } from '../utils.js';
import { drawDmLabel } from '../../../render/index.js';


// Rubber stamp cursor — hotspot at bottom center of the stamp head
export const STAMP_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Crect x='6' y='2' width='12' height='8' rx='2' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Crect x='10' y='10' width='4' height='5' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Cpath d='M5 17 C5 15 8 15 8 15 L16 15 C16 15 19 15 19 17 L19 19 L5 19 Z' fill='white' stroke='%23333' stroke-width='1.2'/%3E%3Cline x1='5' y1='21' x2='19' y2='21' stroke='%23333' stroke-width='1.5'/%3E%3C/svg%3E") 12 22, crosshair`;

export class LabelTool extends Tool {
  constructor() {
    super('label', 'L', 'crosshair');
    this._editing = false;
    this._editRow = -1;
    this._editCol = -1;
    this._inputEl = null;
  }

  getCursor() {
    return state.labelMode === 'dm' ? 'text' : STAMP_CURSOR;
  }

  onDeactivate() {
    if (this._editing) this._commit();
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
      pushUndo();
      delete cell.center.label;
      if (cell.center && Object.keys(cell.center).length === 0) delete cell.center;
      markDirty();
    } else {
      if (!cell.center?.dmLabel) return;
      pushUndo();
      delete cell.center.dmLabel;
      if (cell.center && Object.keys(cell.center).length === 0) delete cell.center;
      markDirty();
    }
  }

  onMouseDown(row, col, edge, event) {
    // If already editing (DM mode), commit first
    if (this._editing) this._commit();

    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;

    // Ensure cell exists
    if (!cells[row][col]) cells[row][col] = {};

    const mode = state.labelMode || 'room';

    if (mode === 'room') {
      this._placeRoomLabel(row, col);
    } else {
      this._startDmEdit(row, col);
    }
  }

  // ── Room Label mode: auto-increment, single click ──────────────────────

  _placeRoomLabel(row, col) {
    const cell = state.dungeon.cells[row][col];
    const nextNum = this._getNextRoomNumber();
    const letter = state.dungeon.metadata.dungeonLetter || 'A';

    pushUndo();
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
    container.appendChild(input);
    this._inputEl = input;

    // Focus after a microtask so the mousedown doesn't steal focus
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    // Event listeners
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

    pushUndo();

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

  renderOverlay(ctx, transform, gridSize) {
    if (!this._editing) return;

    // Only active in DM mode (room mode has no editing state)
    const row = this._editRow;
    const col = this._editCol;
    const { x, y } = toCanvas((col + 0.5) * gridSize, (row + 0.5) * gridSize, transform);
    const text = this._inputEl?.value || ' ';

    // Draw scroll backdrop preview (scaled to current zoom)
    drawDmLabel(ctx, x, y, text, transform.scale);
  }
}
