// Select tool: click/drag to select cells; drag selected cells to move them
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, notify, invalidateLightmap } from '../state.js';
import { requestRender, setCursor } from '../canvas-view.js';
import { showToast } from '../toast.js';
import { captureBeforeState, smartInvalidate } from '../../../render/index.js';

const MOVE_THRESHOLD = 8; // pixels before a mousedown-on-selection becomes a move drag

const DIRS = [
  { dir: 'north', dr: -1, dc:  0, opp: 'south' },
  { dir: 'south', dr:  1, dc:  0, opp: 'north' },
  { dir: 'east',  dr:  0, dc:  1, opp: 'west'  },
  { dir: 'west',  dr:  0, dc: -1, opp: 'east'  },
];

export class SelectTool extends Tool {
  constructor() {
    super('select', 'V', 'default');
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.shiftHeld = false;
    // Move drag state
    this.moveDragging = false;
    this.moveDragStart = null;  // {row, col} grid position at drag start
    this.moveDragOffset = null; // {dRow, dCol} current ghost offset
    // Pending move (mousedown on selected cell, waiting for drag threshold)
    this._pendingMove = false;
    this._pendingMoveStart = null; // {row, col} grid position at mousedown
    this._pendingMovePos = null;   // {x, y} pixel position at mousedown
    // Paste mode cursor tracking
    this.pasteHover = null;     // {row, col} — current cursor cell for paste preview
  }

  onActivate() {
    state.statusInstruction = state.selectMode === 'inspect'
      ? 'Click a cell to inspect its properties'
      : 'Drag to select cells · Shift+drag to add · Arrow keys to move · Ctrl+C to copy · Del to delete';
  }

  onDeactivate() {
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.moveDragging = false;
    this.moveDragStart = null;
    this.moveDragOffset = null;
    this._pendingMove = false;
    this._pendingMoveStart = null;
    this._pendingMovePos = null;
    this.pasteHover = null;
    state.pasteMode = false;
    state.statusInstruction = null;
    setCursor('default');
  }

  // ── Mouse Handlers ───────────────────────────────────────────────────────

  onMouseDown(row, col, edge, event, pos) {
    // Paste mode: commit paste at cursor position
    if (state.pasteMode && state.clipboard) {
      this._commitPaste(row, col);
      return;
    }

    // Inspect mode: click a cell to select it (the properties panel shows automatically)
    if (state.selectMode === 'inspect') {
      const cells = state.dungeon.cells;
      if (row >= 0 && row < cells.length && col >= 0 && col < (cells[0]?.length || 0)) {
        state.selectedCells = [{ row, col }];
        notify();
      }
      return;
    }

    // Clicking on a selected cell (without shift) → defer to pending move
    const onSelected = !event.shiftKey &&
      state.selectedCells.some(c => c.row === row && c.col === col);
    if (onSelected) {
      this._pendingMove = true;
      this._pendingMoveStart = { row, col };
      this._pendingMovePos = pos || null;
      return;
    }

    // Clicking on unselected space → start box-select
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) {
      state.selectedCells = [];
      notify();
      return;
    }
    this.dragging = true;
    this.shiftHeld = event.shiftKey;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    markDirty();
  }

  onMouseMove(row, col, edge, event, pos) {
    // Paste mode: update hover for preview
    if (state.pasteMode) {
      if (!this.pasteHover || this.pasteHover.row !== row || this.pasteHover.col !== col) {
        this.pasteHover = { row, col };
        markDirty();
      }
      return;
    }

    // Check if pending move crossed threshold → activate move drag
    if (this._pendingMove && pos && this._pendingMovePos) {
      const dx = pos.x - this._pendingMovePos.x;
      const dy = pos.y - this._pendingMovePos.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        this.moveDragging = true;
        this.moveDragStart = this._pendingMoveStart;
        this.moveDragOffset = { dRow: 0, dCol: 0 };
        this._pendingMove = false;
        this._pendingMoveStart = null;
        this._pendingMovePos = null;
      }
    }

    if (this.moveDragging) {
      this._onMoveModeMouseMove(row, col);
      return;
    }

    if (this.dragging) {
      const cells = state.dungeon.cells;
      const clampedRow = Math.max(0, Math.min(cells.length - 1, row));
      const clampedCol = Math.max(0, Math.min((cells[0]?.length || 1) - 1, col));
      if (this.dragEnd.row !== clampedRow || this.dragEnd.col !== clampedCol) {
        this.dragEnd = { row: clampedRow, col: clampedCol };
        markDirty();
      }
      return;
    }

    // Idle: update cursor based on whether we're hovering over selected cells
    if (state.selectMode !== 'inspect') {
      const onSelected = state.selectedCells.some(c => c.row === row && c.col === col);
      setCursor(onSelected ? 'move' : 'default');
    }
  }

  onMouseUp() {
    if (this.moveDragging) {
      this._onMoveModeMouseUp();
      return;
    }

    // Pending move that never crossed drag threshold → no-op, keep selection
    if (this._pendingMove) {
      this._pendingMove = false;
      this._pendingMoveStart = null;
      this._pendingMovePos = null;
      return;
    }

    if (!this.dragging) return;
    this.dragging = false;

    const minRow = Math.min(this.dragStart.row, this.dragEnd.row);
    const maxRow = Math.max(this.dragStart.row, this.dragEnd.row);
    const minCol = Math.min(this.dragStart.col, this.dragEnd.col);
    const maxCol = Math.max(this.dragStart.col, this.dragEnd.col);

    const boxCells = [];
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        boxCells.push({ row: r, col: c });
      }
    }

    if (this.shiftHeld) {
      // Add box cells to existing selection, toggling any already-selected cells
      const existing = new Set(state.selectedCells.map(c => `${c.row},${c.col}`));
      for (const cell of boxCells) {
        const key = `${cell.row},${cell.col}`;
        if (existing.has(key)) existing.delete(key);
        else existing.add(key);
      }
      state.selectedCells = [...existing].map(k => {
        const [r, c] = k.split(',').map(Number);
        return { row: r, col: c };
      });
    } else {
      state.selectedCells = boxCells;
    }

    this.dragStart = null;
    this.dragEnd = null;
    markDirty();
    notify();
  }

  onKeyDown(event) {
    if (state.selectedCells.length === 0) return;
    const deltas = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const d = deltas[event.key];
    if (!d) return;
    event.preventDefault();
    this._applyMove(d[0], d[1]);
  }

  // ── Move helpers ─────────────────────────────────────────────────────────

  _onMoveModeMouseMove(row, col) {
    if (!this.moveDragging) return;
    const dRow = row - this.moveDragStart.row;
    const dCol = col - this.moveDragStart.col;
    if (dRow !== this.moveDragOffset.dRow || dCol !== this.moveDragOffset.dCol) {
      this.moveDragOffset = { dRow, dCol };
      markDirty();
    }
  }

  _onMoveModeMouseUp() {
    if (!this.moveDragging) return;
    this.moveDragging = false;
    const { dRow, dCol } = this.moveDragOffset;
    this.moveDragOffset = null;
    this.moveDragStart = null;
    if (dRow !== 0 || dCol !== 0) {
      this._applyMove(dRow, dCol);
    }
  }

  /**
   * Commit a paste at (targetRow, targetCol) — top-left anchor of the clipboard.
   */
  _commitPaste(targetRow, targetCol) {
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const { cells: clipCells } = state.clipboard;

    // Bounds check
    for (const { dRow, dCol } of clipCells) {
      const r = targetRow + dRow, c = targetCol + dCol;
      if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
    }

    const destCoords = clipCells.map(({ dRow, dCol }) => ({
      row: targetRow + dRow,
      col: targetCol + dCol,
    }));

    const before = captureBeforeState(cells, destCoords);
    pushUndo('Paste');

    // Remove any lights sitting on destination cells
    const destSet = new Set(destCoords.map(({ row, col }) => `${row},${col}`));
    const lights = state.dungeon.metadata.lights;
    if (lights?.length) {
      const gridSize = state.dungeon.metadata.gridSize || 5;
      state.dungeon.metadata.lights = lights.filter(light => {
        const lr = Math.round(light.y / gridSize);
        const lc = Math.round(light.x / gridSize);
        return !destSet.has(`${lr},${lc}`);
      });
    }

    // Write clipboard data (fully replaces destination cells, clearing old fills/props/etc.)
    for (const { dRow, dCol, data } of clipCells) {
      const r = targetRow + dRow, c = targetCol + dCol;
      cells[r][c] = data ? JSON.parse(JSON.stringify(data)) : null;
    }

    // Update selection to pasted positions
    state.selectedCells = destCoords;

    state.pasteMode = false;
    this.pasteHover = null;
    invalidateLightmap();
    smartInvalidate(before, cells);
    markDirty();
    notify();
    requestRender();
    showToast('Pasted');
  }

  /**
   * Move all selected cells by (dRow, dCol).
   * Walls between selected cells are preserved.
   * Boundary walls (facing non-selected neighbors) are removed from both sides.
   * Lights anchored to selected cells move with them.
   */
  _applyMove(dRow, dCol) {
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const selected = state.selectedCells;

    // Abort if any destination is out of bounds
    for (const { row, col } of selected) {
      const nr = row + dRow, nc = col + dCol;
      if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) return;
    }

    const selectedSet = new Set(selected.map(c => `${c.row},${c.col}`));
    const destSet = new Set(selected.map(c => `${c.row + dRow},${c.col + dCol}`));

    // Snapshot cell data (deep clone) before any mutation
    const snapshots = selected.map(({ row, col }) => ({
      row, col,
      data: cells[row][col] ? JSON.parse(JSON.stringify(cells[row][col])) : null,
    }));

    // Capture before state for smart cache invalidation (sources + destinations)
    const affectedCoords = [
      ...selected,
      ...selected.map(({ row, col }) => ({ row: row + dRow, col: col + dCol })),
    ];
    const before = captureBeforeState(cells, affectedCoords);

    pushUndo('Move selection');

    // Strip boundary walls: walls facing non-selected neighbors
    for (const snap of snapshots) {
      if (!snap.data) continue;
      for (const { dir, dr, dc, opp } of DIRS) {
        const nr = snap.row + dr, nc = snap.col + dc;
        if (!selectedSet.has(`${nr},${nc}`)) {
          const neighbor = cells[nr]?.[nc];
          if (neighbor) delete neighbor[opp];
          delete snap.data[dir];
        }
      }
    }

    // Clear stale wall references in neighbors of destination cells that will be replaced.
    // When a non-selected cell is overwritten at the destination, its neighbors still hold
    // wall edges pointing at the old content — strip those before writing new data.
    for (const { row, col } of selected) {
      const dr2 = row + dRow, dc2 = col + dCol;
      if (selectedSet.has(`${dr2},${dc2}`)) continue; // destination is itself selected, will be voided
      const existingDest = cells[dr2]?.[dc2];
      if (!existingDest) continue;
      for (const { dr: ndr, dc: ndc, opp } of DIRS) {
        const nr = dr2 + ndr, nc = dc2 + ndc;
        if (selectedSet.has(`${nr},${nc}`) || destSet.has(`${nr},${nc}`)) continue;
        const neighbor = cells[nr]?.[nc];
        if (neighbor) delete neighbor[opp];
      }
    }

    // Void old positions
    for (const { row, col } of selected) {
      cells[row][col] = null;
    }

    // Write to new positions
    for (const { row, col, data } of snapshots) {
      cells[row + dRow][col + dCol] = data;
    }

    // Move lights anchored to selected cells
    const lights = state.dungeon.metadata.lights;
    if (lights?.length) {
      const gridSize = state.dungeon.metadata.gridSize || 5;
      for (const light of lights) {
        const lightRow = Math.round(light.y / gridSize);
        const lightCol = Math.round(light.x / gridSize);
        if (selectedSet.has(`${lightRow},${lightCol}`)) {
          light.x += dCol * gridSize;
          light.y += dRow * gridSize;
        }
      }
    }

    // Update selection to new positions
    state.selectedCells = selected.map(({ row, col }) => ({ row: row + dRow, col: col + dCol }));

    invalidateLightmap();
    smartInvalidate(before, cells, { forceGeometry: true });
    markDirty();
    notify();
    requestRender();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  renderOverlay(ctx, transform, gridSize) {
    const cs = gridSize * transform.scale;

    // Paste preview: ghost cells following cursor
    if (state.pasteMode && state.clipboard && this.pasteHover) {
      const { row: tRow, col: tCol } = this.pasteHover;
      ctx.save();
      ctx.fillStyle = 'rgba(80, 220, 140, 0.3)';
      ctx.strokeStyle = 'rgba(80, 220, 140, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      for (const { dRow, dCol } of state.clipboard.cells) {
        const x = transform.offsetX + (tCol + dCol) * cs;
        const y = transform.offsetY + (tRow + dRow) * cs;
        ctx.fillRect(x, y, cs, cs);
        ctx.strokeRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Selection highlights
    if (state.selectedCells.length > 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(100, 160, 255, 0.25)';
      ctx.strokeStyle = 'rgba(100, 160, 255, 0.9)';
      ctx.lineWidth = 1.5;
      for (const { row, col } of state.selectedCells) {
        const x = transform.offsetX + col * cs;
        const y = transform.offsetY + row * cs;
        ctx.fillRect(x, y, cs, cs);
        ctx.strokeRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
      }
      ctx.restore();
    }

    // Ghost cells while dragging selected cells
    if (this.moveDragging && this.moveDragOffset && state.selectedCells.length > 0) {
      const { dRow, dCol } = this.moveDragOffset;
      if (dRow !== 0 || dCol !== 0) {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 165, 50, 0.35)';
        ctx.strokeStyle = 'rgba(255, 165, 50, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        for (const { row, col } of state.selectedCells) {
          const x = transform.offsetX + (col + dCol) * cs;
          const y = transform.offsetY + (row + dRow) * cs;
          ctx.fillRect(x, y, cs, cs);
          ctx.strokeRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
        }
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Rubber-band rectangle while box-selecting
    if (this.dragging && this.dragStart && this.dragEnd) {
      const minRow = Math.min(this.dragStart.row, this.dragEnd.row);
      const maxRow = Math.max(this.dragStart.row, this.dragEnd.row);
      const minCol = Math.min(this.dragStart.col, this.dragEnd.col);
      const maxCol = Math.max(this.dragStart.col, this.dragEnd.col);

      const x = transform.offsetX + minCol * cs;
      const y = transform.offsetY + minRow * cs;
      const w = (maxCol - minCol + 1) * cs;
      const h = (maxRow - minRow + 1) * cs;

      ctx.save();
      ctx.fillStyle = this.shiftHeld ? 'rgba(100, 220, 160, 0.15)' : 'rgba(100, 160, 255, 0.15)';
      ctx.strokeStyle = this.shiftHeld ? 'rgba(100, 220, 160, 0.9)' : 'rgba(100, 160, 255, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}
