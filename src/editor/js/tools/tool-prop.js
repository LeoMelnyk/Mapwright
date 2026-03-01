// Prop tool: place props from catalog or select/manipulate placed props
import { Tool } from './tool-base.js';
import state, { pushUndo, undo, markDirty, notify, getTheme } from '../state.js';
import { requestRender } from '../canvas-view.js';
import { toCanvas } from '../utils.js';
import { renderProp } from '../../../render/index.js';
import { getTextureCatalog } from '../texture-catalog.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function getEffectiveFootprint(propDef, rotation) {
  const [rows, cols] = propDef.footprint;
  if (rotation === 90 || rotation === 270) return [cols, rows];
  return [rows, cols];
}

function findPropAnchor(cells, row, col) {
  // Check if this cell IS an anchor
  if (cells[row]?.[col]?.prop) return { row, col };

  // Search nearby cells (max 4 cells in any direction for reasonable prop sizes)
  const searchRadius = 4;

  for (let r = Math.max(0, row - searchRadius); r <= row; r++) {
    for (let c = Math.max(0, col - searchRadius); c <= col; c++) {
      const cell = cells[r]?.[c];
      if (!cell?.prop) continue;
      const [spanRows, spanCols] = cell.prop.span;
      if (r + spanRows > row && c + spanCols > col) {
        // This prop's span covers (row, col)
        return { row: r, col: c };
      }
    }
  }
  return null;
}

function isFootprintClear(cells, anchorRow, anchorCol, spanRows, spanCols) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  for (let r = anchorRow; r < anchorRow + spanRows; r++) {
    for (let c = anchorCol; c < anchorCol + spanCols; c++) {
      if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
      if (cells[r][c] === null) return false; // void cell
      // Check if another prop covers this cell
      const existingAnchor = findPropAnchor(cells, r, c);
      if (existingAnchor) return false;
    }
  }
  return true;
}

function getTextureResolver() {
  const texCat = getTextureCatalog();
  return texCat
    ? (id) => { const e = texCat.textures[id]; return e?.img?.complete ? e.img : null; }
    : null;
}

// ── Tool ────────────────────────────────────────────────────────────────────

export class PropTool extends Tool {
  constructor() {
    super('prop', '9', 'crosshair');
    this.dragStart = null;
    this.dragEnd = null;
    // Drag-to-move state
    this.isDragging = false;
    this.dragAnchor = null;       // {row, col} — original anchor of the prop being dragged
    this.dragFacing = 0;          // facing (can change mid-drag via R)
    this.dragFlipped = false;     // flipped state (can change mid-drag via F)
    this.dragGhost = null;        // {row, col} — current ghost position
    this.dragPropDef = null;      // cached prop definition
    this.dragOrigProp = null;     // snapshot of original cell.prop for undo
  }

  getCursor() {
    return state.propMode === 'select' ? 'default' : 'crosshair';
  }

  onActivate() {
    state.statusInstruction = 'Right-click to delete prop';
  }

  onDeactivate() {
    if (this.isDragging) {
      undo(); // restore prop at original position
    }
    this._resetDragState();
    state.statusInstruction = '';
  }

  _resetDragState() {
    this.dragStart = null;
    this.dragEnd = null;
    this.isDragging = false;
    this.dragAnchor = null;
    this.dragFacing = 0;
    this.dragFlipped = false;
    this.dragGhost = null;
    this.dragPropDef = null;
    this.dragOrigProp = null;
  }

  onMouseDown(row, col, edge, event) {
    if (state.propMode === 'place') {
      this._placeOnMouseDown(row, col);
    } else {
      this._selectOnMouseDown(row, col, event);
    }
  }

  onMouseMove(row, col, edge, event) {
    if (state.propMode === 'place') {
      state.hoveredCell = { row, col };
      requestRender();
    } else if (this.isDragging) {
      this.dragGhost = { row, col };
      requestRender();
    } else {
      if (this.dragStart) {
        this.dragEnd = { row, col };
        requestRender();
      }
    }
  }

  onMouseUp(row, col, edge, event) {
    if (state.propMode === 'select' && this.isDragging) {
      this._finishDrag();
      return;
    }

    if (state.propMode === 'select' && this.dragStart && this.dragEnd) {
      const r1 = Math.min(this.dragStart.row, this.dragEnd.row);
      const r2 = Math.max(this.dragStart.row, this.dragEnd.row);
      const c1 = Math.min(this.dragStart.col, this.dragEnd.col);
      const c2 = Math.max(this.dragStart.col, this.dragEnd.col);

      // Only box-select if actually dragged (not a single click)
      if (this.dragStart.row !== this.dragEnd.row || this.dragStart.col !== this.dragEnd.col) {
        const cells = state.dungeon.cells;
        const numRows = cells.length;
        const numCols = cells[0]?.length || 0;

        for (let r = Math.max(0, r1); r <= Math.min(r2, numRows - 1); r++) {
          for (let c = Math.max(0, c1); c <= Math.min(c2, numCols - 1); c++) {
            if (cells[r]?.[c]?.prop) {
              const anchor = { row: r, col: c };
              const already = state.selectedPropAnchors.some(a => a.row === r && a.col === c);
              if (!already) {
                state.selectedPropAnchors.push(anchor);
              }
            }
          }
        }
        notify();
        requestRender();
      }
    }
    this.dragStart = null;
    this.dragEnd = null;
  }

  onKeyDown(e) {
    // Escape cancels drag
    if (e.key === 'Escape' && this.isDragging) {
      this._cancelDrag();
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      if (this.isDragging) {
        // Rotate ghost during drag
        this.dragFacing = (this.dragFacing + 90) % 360;
        requestRender();
        return;
      }
      this._handleRotate(90);
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      if (this.isDragging) {
        // Flip ghost during drag
        this.dragFlipped = !this.dragFlipped;
        requestRender();
        return;
      }
      this._handleFlip();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.propMode === 'select') {
        this._deleteSelected();
      }
    }
  }

  onCancel() {
    if (this.isDragging) {
      this._cancelDrag();
      return true;
    }
    return false;
  }

  onRightClick(row, col) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;

    const anchor = findPropAnchor(cells, row, col);
    if (!anchor) return;

    const cell = cells[anchor.row]?.[anchor.col];
    if (!cell?.prop) return;

    pushUndo('Delete prop');
    delete cell.prop;

    // Remove from selection if it was selected
    state.selectedPropAnchors = state.selectedPropAnchors.filter(
      a => a.row !== anchor.row || a.col !== anchor.col
    );

    markDirty();
    notify();
    requestRender();
  }

  renderOverlay(ctx, transform, gridSize) {
    if (state.propMode === 'place') {
      this._renderPlaceOverlay(ctx, transform, gridSize);
    } else {
      this._renderSelectOverlay(ctx, transform, gridSize);
    }
  }

  // ── Place Mode ──────────────────────────────────────────────────────────

  _placeOnMouseDown(row, col) {
    if (!state.selectedProp) return;
    const catalog = state.propCatalog;
    if (!catalog?.props?.[state.selectedProp]) return;

    const propDef = catalog.props[state.selectedProp];
    const [spanRows, spanCols] = getEffectiveFootprint(propDef, state.propRotation);
    const cells = state.dungeon.cells;

    if (!isFootprintClear(cells, row, col, spanRows, spanCols)) return;

    pushUndo('Place prop');
    cells[row][col].prop = {
      type: state.selectedProp,
      span: [spanRows, spanCols],
      facing: state.propRotation,
      ...(state.propFlipped && { flipped: true }),
    };
    markDirty();
    notify();
  }

  _renderPlaceOverlay(ctx, transform, gridSize) {
    if (!state.selectedProp || !state.hoveredCell) return;
    const catalog = state.propCatalog;
    if (!catalog?.props?.[state.selectedProp]) return;

    const propDef = catalog.props[state.selectedProp];
    const [spanRows, spanCols] = getEffectiveFootprint(propDef, state.propRotation);
    const { row, col } = state.hoveredCell;
    const cells = state.dungeon.cells;
    const valid = isFootprintClear(cells, row, col, spanRows, spanCols);
    const theme = getTheme();

    // Draw ghost preview
    ctx.save();
    ctx.globalAlpha = 0.4;
    const getTexImg = getTextureResolver();
    renderProp(ctx, propDef, row, col, state.propRotation, gridSize, theme, transform, state.propFlipped, getTexImg);
    ctx.restore();

    // Draw colored border around footprint cells
    const borderColor = valid ? 'rgba(100, 255, 100, 0.5)' : 'rgba(255, 100, 100, 0.5)';
    ctx.save();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;

    const topLeft = toCanvas(col * gridSize, row * gridSize, transform);
    const bottomRight = toCanvas((col + spanCols) * gridSize, (row + spanRows) * gridSize, transform);
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.restore();
  }

  // ── Select Mode ─────────────────────────────────────────────────────────

  _selectOnMouseDown(row, col, event) {
    const cells = state.dungeon.cells;
    const anchor = findPropAnchor(cells, row, col);

    // Check if clicking on an already-selected prop → start drag
    if (anchor && !event.shiftKey) {
      const alreadySelected = state.selectedPropAnchors.some(
        a => a.row === anchor.row && a.col === anchor.col
      );
      if (alreadySelected) {
        const cell = cells[anchor.row]?.[anchor.col];
        if (cell?.prop) {
          const catalog = state.propCatalog;
          const propDef = catalog?.props?.[cell.prop.type];
          if (propDef) {
            // Enter drag mode
            pushUndo('Move prop'); // snapshot state before we remove the prop
            this.isDragging = true;
            this.dragAnchor = { row: anchor.row, col: anchor.col };
            this.dragOrigProp = { ...cell.prop, span: [...cell.prop.span] };
            this.dragFacing = cell.prop.facing;
            this.dragFlipped = cell.prop.flipped || false;
            this.dragPropDef = propDef;
            this.dragGhost = { row: anchor.row, col: anchor.col };
            // Remove prop from cell so isFootprintClear works at new positions
            delete cell.prop;
            // Don't start box-select
            this.dragStart = null;
            this.dragEnd = null;
            requestRender();
            return;
          }
        }
      }
    }

    // Normal select behavior
    this.dragStart = { row, col };
    this.dragEnd = null;

    if (!event.shiftKey) {
      state.selectedPropAnchors = [];
    }

    if (anchor) {
      const idx = state.selectedPropAnchors.findIndex(
        a => a.row === anchor.row && a.col === anchor.col
      );
      if (event.shiftKey && idx >= 0) {
        // Toggle off
        state.selectedPropAnchors.splice(idx, 1);
      } else if (idx < 0) {
        state.selectedPropAnchors.push(anchor);
      }
    }

    notify();
    requestRender();
  }

  _finishDrag() {
    if (!this.dragGhost || !this.dragPropDef || !this.dragOrigProp) {
      this._cancelDrag();
      return;
    }

    const { row, col } = this.dragGhost;
    const cells = state.dungeon.cells;
    const [spanRows, spanCols] = getEffectiveFootprint(this.dragPropDef, this.dragFacing);
    const valid = isFootprintClear(cells, row, col, spanRows, spanCols);

    if (valid) {
      // Place prop at new position (undo was already pushed in mouseDown)
      cells[row][col].prop = {
        type: this.dragOrigProp.type,
        span: [spanRows, spanCols],
        facing: this.dragFacing,
        ...(this.dragFlipped && { flipped: true }),
      };
      // Update selection to point to new anchor
      state.selectedPropAnchors = state.selectedPropAnchors.map(a =>
        (a.row === this.dragAnchor.row && a.col === this.dragAnchor.col)
          ? { row, col }
          : a
      );
      markDirty();
      notify();
    } else {
      // Invalid placement — undo to restore original state
      undo();
    }

    this.isDragging = false;
    this.dragAnchor = null;
    this.dragFacing = 0;
    this.dragFlipped = false;
    this.dragGhost = null;
    this.dragPropDef = null;
    this.dragOrigProp = null;
    requestRender();
  }

  _cancelDrag() {
    if (this.isDragging) {
      undo(); // restore prop at original position
    }
    this.isDragging = false;
    this.dragAnchor = null;
    this.dragFacing = 0;
    this.dragFlipped = false;
    this.dragGhost = null;
    this.dragPropDef = null;
    this.dragOrigProp = null;
    requestRender();
  }

  _renderSelectOverlay(ctx, transform, gridSize) {
    // Draw drag ghost if actively dragging
    if (this.isDragging && this.dragGhost && this.dragPropDef) {
      const { row, col } = this.dragGhost;
      const cells = state.dungeon.cells;
      const theme = getTheme();
      const [spanRows, spanCols] = getEffectiveFootprint(this.dragPropDef, this.dragFacing);
      const valid = isFootprintClear(cells, row, col, spanRows, spanCols);

      // Ghost prop
      ctx.save();
      ctx.globalAlpha = 0.4;
      const getTexImg = getTextureResolver();
      renderProp(ctx, this.dragPropDef, row, col, this.dragFacing, gridSize, theme, transform, this.dragFlipped, getTexImg);
      ctx.restore();

      // Validity border
      const borderColor = valid ? 'rgba(100, 255, 100, 0.5)' : 'rgba(255, 100, 100, 0.5)';
      ctx.save();
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 2;
      const topLeft = toCanvas(col * gridSize, row * gridSize, transform);
      const bottomRight = toCanvas((col + spanCols) * gridSize, (row + spanRows) * gridSize, transform);
      ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      ctx.restore();

      // Name label on ghost
      const name = this.dragPropDef.name || this.dragOrigProp?.type || '';
      if (name) {
        this._drawNameLabel(ctx, name, topLeft, bottomRight);
      }
    }

    // Draw selection rectangle while box-selecting
    if (this.dragStart && this.dragEnd) {
      const r1 = Math.min(this.dragStart.row, this.dragEnd.row);
      const r2 = Math.max(this.dragStart.row, this.dragEnd.row) + 1;
      const c1 = Math.min(this.dragStart.col, this.dragEnd.col);
      const c2 = Math.max(this.dragStart.col, this.dragEnd.col) + 1;

      const topLeft = toCanvas(c1 * gridSize, r1 * gridSize, transform);
      const bottomRight = toCanvas(c2 * gridSize, r2 * gridSize, transform);

      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(100, 180, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      ctx.restore();
    }

    // Highlight selected props
    const cells = state.dungeon.cells;
    for (const anchor of state.selectedPropAnchors) {
      const cell = cells[anchor.row]?.[anchor.col];
      if (!cell?.prop) continue;
      const [spanRows, spanCols] = cell.prop.span;

      const topLeft = toCanvas(anchor.col * gridSize, anchor.row * gridSize, transform);
      const bottomRight = toCanvas(
        (anchor.col + spanCols) * gridSize,
        (anchor.row + spanRows) * gridSize,
        transform
      );

      ctx.save();
      ctx.strokeStyle = 'rgba(100, 180, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      ctx.restore();

      // Draw prop name label above the selection
      const propDef = state.propCatalog?.props?.[cell.prop.type];
      const name = propDef?.name || cell.prop.type;
      this._drawNameLabel(ctx, name, topLeft, bottomRight);
    }
  }

  _drawNameLabel(ctx, name, topLeft, bottomRight) {
    const centerX = (topLeft.x + bottomRight.x) / 2;
    const aboveY = topLeft.y - 6;

    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const metrics = ctx.measureText(name);
    const pillW = metrics.width + 10;
    const pillH = 16;
    const pillX = centerX - pillW / 2;
    const pillY = aboveY - pillH;

    // Semi-transparent background pill
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 3);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fill();

    // White text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, centerX, aboveY - 2);
    ctx.restore();
  }

  // ── Key Handlers ────────────────────────────────────────────────────────

  _handleRotate(degrees) {
    if (state.propMode === 'place') {
      state.propRotation = (state.propRotation + degrees) % 360;
      notify();
      requestRender();
    } else if (state.propMode === 'select' && state.selectedPropAnchors.length > 0) {
      const cells = state.dungeon.cells;
      pushUndo('Rotate prop');

      for (const anchor of state.selectedPropAnchors) {
        const cell = cells[anchor.row]?.[anchor.col];
        if (!cell?.prop) continue;

        const newFacing = (cell.prop.facing + degrees) % 360;
        const [oldSpanRows, oldSpanCols] = cell.prop.span;

        // For 90/270 rotation, swap span dimensions
        let newSpanRows, newSpanCols;
        if (degrees === 90 || degrees === 270) {
          newSpanRows = oldSpanCols;
          newSpanCols = oldSpanRows;
        } else {
          newSpanRows = oldSpanRows;
          newSpanCols = oldSpanCols;
        }

        // Validate the rotated footprint fits
        const numRows = cells.length;
        const numCols = cells[0]?.length || 0;
        let fits = true;
        for (let r = anchor.row; r < anchor.row + newSpanRows && fits; r++) {
          for (let c = anchor.col; c < anchor.col + newSpanCols && fits; c++) {
            if (r < 0 || r >= numRows || c < 0 || c >= numCols) { fits = false; break; }
            if (cells[r][c] === null) { fits = false; break; }
            // Allow cells covered by this same prop
            if (r === anchor.row && c === anchor.col) continue;
            const existing = findPropAnchor(cells, r, c);
            if (existing && (existing.row !== anchor.row || existing.col !== anchor.col)) {
              fits = false;
            }
          }
        }

        if (fits) {
          cell.prop.facing = newFacing;
          cell.prop.span = [newSpanRows, newSpanCols];
        }
      }

      markDirty();
      notify();
      requestRender();
    }
  }

  _handleFlip() {
    if (state.propMode === 'place') {
      state.propFlipped = !state.propFlipped;
      notify();
      requestRender();
    } else if (state.propMode === 'select' && state.selectedPropAnchors.length > 0) {
      const cells = state.dungeon.cells;
      pushUndo('Flip prop');
      for (const anchor of state.selectedPropAnchors) {
        const cell = cells[anchor.row]?.[anchor.col];
        if (!cell?.prop) continue;
        if (cell.prop.flipped) {
          delete cell.prop.flipped;
        } else {
          cell.prop.flipped = true;
        }
      }
      markDirty();
      notify();
      requestRender();
    }
  }

  _deleteSelected() {
    if (state.selectedPropAnchors.length === 0) return;
    const cells = state.dungeon.cells;

    pushUndo('Delete prop');

    for (const anchor of state.selectedPropAnchors) {
      const cell = cells[anchor.row]?.[anchor.col];
      if (cell?.prop) {
        delete cell.prop;
      }
    }

    state.selectedPropAnchors = [];
    markDirty();
    notify();
    requestRender();
  }
}
