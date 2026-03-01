// Prop tool: place props from catalog or select/manipulate placed props
import { Tool } from './tool-base.js';
import state, { pushUndo, undo, markDirty, notify, getTheme } from '../state.js';
import { requestRender, setCursor } from '../canvas-view.js';
import { toCanvas } from '../utils.js';
import { renderProp } from '../../../render/index.js';
import { getTextureCatalog } from '../texture-catalog.js';

const BOX_SELECT_THRESHOLD = 8; // pixels before a mousedown-on-empty becomes a box-select drag

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
    // Box-select state
    this.dragStart = null;
    this.dragEnd = null;
    this.isBoxSelecting = false;
    // Pending place (deferred from mousedown to mouseup, to allow box-select on drag)
    this._pendingPlace = null;    // { row, col }
    this._pendingPlacePos = null; // { x, y } pixel position at mousedown
    // Drag-to-move state (multi-prop)
    this.isDragging = false;
    this.dragItems = [];          // [{ anchor, propDef, origProp, offsetRow, offsetCol, facing, flipped }]
    this.dragLeadAnchor = null;   // anchor of the directly-dragged prop (offset 0,0)
    this.dragGhost = null;        // {row, col} — lead prop's current ghost position
    // Pending drag (prop clicked but not yet moved beyond threshold)
    this._pendingDragAnchor = null;  // anchor of prop to potentially drag
    this._pendingDragPos = null;     // pixel position at prop mousedown
    // Hover state
    this.hoveredAnchor = null;    // anchor cell of prop currently under cursor
    this.hoverRow = null;
    this.hoverCol = null;
  }

  getCursor() {
    return 'crosshair'; // dynamic cursor updates happen in onMouseMove
  }

  onActivate() {
    state.statusInstruction = 'Click to place · Hover prop to select/move · Right-click to delete';
  }

  onDeactivate() {
    if (this.isDragging) {
      undo(); // restore prop at original position
    }
    this._resetDragState();
    this._resetHoverState();
    state.statusInstruction = '';
  }

  _resetDragState() {
    this.dragStart = null;
    this.dragEnd = null;
    this.isBoxSelecting = false;
    this._pendingPlace = null;
    this._pendingPlacePos = null;
    this._pendingDragAnchor = null;
    this._pendingDragPos = null;
    this.isDragging = false;
    this.dragItems = [];
    this.dragLeadAnchor = null;
    this.dragGhost = null;
  }

  _resetHoverState() {
    this.hoveredAnchor = null;
    this.hoverRow = null;
    this.hoverCol = null;
  }

  // ── Mouse Handlers ───────────────────────────────────────────────────────

  onMouseDown(row, col, edge, event, pos) {
    const cells = state.dungeon.cells;
    const anchor = findPropAnchor(cells, row, col);

    if (anchor) {
      // Clicking on a prop → select/drag flow
      this._selectOnMouseDown(row, col, event, pos);
    } else {
      // Clicking on empty space → defer place; start tracking for potential box-select
      this._pendingPlace = { row, col };
      this._pendingPlacePos = pos || null;
      this.isBoxSelecting = false;
      this.dragStart = { row, col };
      this.dragEnd = null;
      if (!event.shiftKey) state.selectedPropAnchors = [];
      notify();
      requestRender();
    }
  }

  onMouseMove(row, col, edge, event, pos) {
    this.hoverRow = row;
    this.hoverCol = col;

    if (this.isDragging) {
      this.dragGhost = { row, col };
      requestRender();
      return;
    }

    // Check if a pending prop drag has crossed the threshold → activate drag
    if (this._pendingDragAnchor && pos && this._pendingDragPos) {
      const dx = pos.x - this._pendingDragPos.x;
      const dy = pos.y - this._pendingDragPos.y;
      if (Math.sqrt(dx * dx + dy * dy) > BOX_SELECT_THRESHOLD) {
        this._activateDrag(this._pendingDragAnchor);
        this._pendingDragAnchor = null;
        this._pendingDragPos = null;
        // Fall through — isDragging is now true, will be caught on next frame
        this.dragGhost = { row, col };
        requestRender();
        return;
      }
    }

    // Check if pending empty-space drag has crossed threshold → switch to box-select
    if (this._pendingPlace && pos && this._pendingPlacePos) {
      const dx = pos.x - this._pendingPlacePos.x;
      const dy = pos.y - this._pendingPlacePos.y;
      if (Math.sqrt(dx * dx + dy * dy) > BOX_SELECT_THRESHOLD) {
        this._pendingPlace = null;
        this._pendingPlacePos = null;
        this.isBoxSelecting = true;
      }
    }

    if (this.isBoxSelecting) {
      this.dragEnd = { row, col };
      requestRender();
      return;
    }

    // Not in any drag — update hover state and cursor
    const cells = state.dungeon.cells;
    const anchor = findPropAnchor(cells, row, col);
    if (anchor) {
      if (!this.hoveredAnchor || this.hoveredAnchor.row !== anchor.row || this.hoveredAnchor.col !== anchor.col) {
        this.hoveredAnchor = anchor;
        setCursor('grab');
        requestRender();
      }
    } else {
      if (this.hoveredAnchor !== null) {
        this.hoveredAnchor = null;
        setCursor('crosshair');
        requestRender();
      }
    }
  }

  onMouseUp(_row, _col, _edge, _event) {
    if (this.isDragging) {
      this._finishDrag();
      return;
    }

    if (this.isBoxSelecting) {
      // Finalize box-select
      if (this.dragStart && this.dragEnd) {
        const r1 = Math.min(this.dragStart.row, this.dragEnd.row);
        const r2 = Math.max(this.dragStart.row, this.dragEnd.row);
        const c1 = Math.min(this.dragStart.col, this.dragEnd.col);
        const c2 = Math.max(this.dragStart.col, this.dragEnd.col);
        const cells = state.dungeon.cells;
        const numRows = cells.length;
        const numCols = cells[0]?.length || 0;

        for (let r = Math.max(0, r1); r <= Math.min(r2, numRows - 1); r++) {
          for (let c = Math.max(0, c1); c <= Math.min(c2, numCols - 1); c++) {
            if (cells[r]?.[c]?.prop) {
              const already = state.selectedPropAnchors.some(a => a.row === r && a.col === c);
              if (!already) state.selectedPropAnchors.push({ row: r, col: c });
            }
          }
        }
        notify();
      }
      this.isBoxSelecting = false;
      this.dragStart = null;
      this.dragEnd = null;
      requestRender();
      return;
    }

    if (this._pendingDragAnchor) {
      // Click on prop without drag — just leave it selected, clear pending drag
      this._pendingDragAnchor = null;
      this._pendingDragPos = null;
    }

    if (this._pendingPlace) {
      // No significant drag — place prop at the original click position
      this._placeAtCell(this._pendingPlace.row, this._pendingPlace.col);
      this._pendingPlace = null;
      this._pendingPlacePos = null;
      this.dragStart = null;
    }
  }

  onKeyDown(e) {
    // Escape cancels drag, or clears the selected prop template
    if (e.key === 'Escape') {
      if (this.isDragging) {
        this._cancelDrag();
      } else if (state.selectedProp) {
        state.selectedProp = null;
        notify();
        requestRender();
      }
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      const degrees = e.shiftKey ? 270 : 90;
      if (this.isDragging) {
        this._rotateDragGroup(degrees);
        requestRender();
        return;
      }
      this._handleRotate(degrees);
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      if (this.isDragging) {
        this._flipDragGroup();
        requestRender();
        return;
      }
      this._handleFlip();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      this._deleteSelected();
    }
  }

  onCancel() {
    if (this.isDragging) {
      this._cancelDrag();
      return true;
    }
    if (this._pendingDragAnchor) {
      this._pendingDragAnchor = null;
      this._pendingDragPos = null;
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

  // ── Overlay ──────────────────────────────────────────────────────────────

  renderOverlay(ctx, transform, gridSize) {
    const cells = state.dungeon.cells;

    // 1. Drag ghost (when moving props)
    if (this.isDragging && this.dragGhost && this.dragItems.length > 0) {
      const allValid = this._allPositionsValid();
      const borderColor = allValid ? 'rgba(100, 255, 100, 0.5)' : 'rgba(255, 100, 100, 0.5)';
      const theme = getTheme();

      for (const item of this.dragItems) {
        const row = this.dragGhost.row + item.offsetRow;
        const col = this.dragGhost.col + item.offsetCol;
        const [spanRows, spanCols] = getEffectiveFootprint(item.propDef, item.facing);

        ctx.save();
        ctx.globalAlpha = 0.4;
        renderProp(ctx, item.propDef, row, col, item.facing, gridSize, theme, transform, item.flipped, getTextureResolver());
        ctx.restore();

        const topLeft = toCanvas(col * gridSize, row * gridSize, transform);
        const bottomRight = toCanvas((col + spanCols) * gridSize, (row + spanRows) * gridSize, transform);
        ctx.save();
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
        ctx.restore();

        // Draw name label only for the lead prop
        if (item.offsetRow === 0 && item.offsetCol === 0) {
          const name = item.propDef.name || item.origProp?.type || '';
          if (name) this._drawNameLabel(ctx, name, topLeft, bottomRight);
        }
      }
    }

    // 2. Box-select rubber-band rectangle
    if (this.isBoxSelecting && this.dragStart && this.dragEnd) {
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
      ctx.fillStyle = 'rgba(100, 180, 255, 0.08)';
      ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      ctx.restore();
    }

    // 3. Placement preview — when hovering empty space with a prop selected
    if (!this.isDragging && !this.isBoxSelecting && !this.hoveredAnchor &&
        this.hoverRow != null && this.hoverCol != null && state.selectedProp) {
      this._renderPlacePreview(ctx, transform, gridSize, this.hoverRow, this.hoverCol);
    }

    // 4. Hover highlight — thin dashed outline on the prop under the cursor
    if (this.hoveredAnchor && !this.isDragging) {
      const cell = cells[this.hoveredAnchor.row]?.[this.hoveredAnchor.col];
      if (cell?.prop) {
        const [spanRows, spanCols] = cell.prop.span;
        const topLeft = toCanvas(this.hoveredAnchor.col * gridSize, this.hoveredAnchor.row * gridSize, transform);
        const bottomRight = toCanvas(
          (this.hoveredAnchor.col + spanCols) * gridSize,
          (this.hoveredAnchor.row + spanRows) * gridSize,
          transform
        );
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(100, 200, 255, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
        ctx.restore();
      }
    }

    // 5. Selection highlights
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

      const propDef = state.propCatalog?.props?.[cell.prop.type];
      const name = propDef?.name || cell.prop.type;
      this._drawNameLabel(ctx, name, topLeft, bottomRight);
    }
  }

  // ── Place ────────────────────────────────────────────────────────────────

  _placeAtCell(row, col) {
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
    requestRender();
  }

  _renderPlacePreview(ctx, transform, gridSize, row, col) {
    const catalog = state.propCatalog;
    if (!catalog?.props?.[state.selectedProp]) return;

    const propDef = catalog.props[state.selectedProp];
    const [spanRows, spanCols] = getEffectiveFootprint(propDef, state.propRotation);
    const cells = state.dungeon.cells;
    const valid = isFootprintClear(cells, row, col, spanRows, spanCols);
    const theme = getTheme();

    ctx.save();
    ctx.globalAlpha = 0.4;
    renderProp(ctx, propDef, row, col, state.propRotation, gridSize, theme, transform, state.propFlipped, getTextureResolver());
    ctx.restore();

    const borderColor = valid ? 'rgba(100, 255, 100, 0.5)' : 'rgba(255, 100, 100, 0.5)';
    ctx.save();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    const topLeft = toCanvas(col * gridSize, row * gridSize, transform);
    const bottomRight = toCanvas((col + spanCols) * gridSize, (row + spanRows) * gridSize, transform);
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.restore();
  }

  // ── Select + Drag ────────────────────────────────────────────────────────

  _selectOnMouseDown(row, col, event, pos) {
    const cells = state.dungeon.cells;
    const anchor = findPropAnchor(cells, row, col);
    if (!anchor) return;

    const idx = state.selectedPropAnchors.findIndex(
      a => a.row === anchor.row && a.col === anchor.col
    );

    if (event.shiftKey) {
      // Shift-click: toggle this prop in/out of selection
      if (idx >= 0) {
        state.selectedPropAnchors.splice(idx, 1);
      } else {
        state.selectedPropAnchors.push(anchor);
      }
    } else if (idx >= 0) {
      // Clicking a prop already in the selection → keep the whole group, start pending drag
      this._pendingDragAnchor = anchor;
      this._pendingDragPos = pos || null;
    } else {
      // Clicking a prop not in the selection → select only this one, start pending drag
      state.selectedPropAnchors = [anchor];
      this._pendingDragAnchor = anchor;
      this._pendingDragPos = pos || null;
    }

    notify();
    requestRender();
  }

  _activateDrag(anchor) {
    const cells = state.dungeon.cells;

    // Move all selected props if the dragged anchor is in the selection,
    // otherwise just move the single prop that was clicked.
    const anchorsToMove = state.selectedPropAnchors.some(
      a => a.row === anchor.row && a.col === anchor.col
    ) ? state.selectedPropAnchors : [anchor];

    const items = [];
    for (const a of anchorsToMove) {
      const cell = cells[a.row]?.[a.col];
      if (!cell?.prop) continue;
      const propDef = state.propCatalog?.props?.[cell.prop.type];
      if (!propDef) continue;
      items.push({
        anchor: { row: a.row, col: a.col },
        offsetRow: a.row - anchor.row,
        offsetCol: a.col - anchor.col,
        propDef,
        origProp: { ...cell.prop, span: [...cell.prop.span] },
        facing: cell.prop.facing,
        flipped: cell.prop.flipped || false,
      });
    }
    if (items.length === 0) return;

    pushUndo(items.length > 1 ? 'Move props' : 'Move prop');
    for (const item of items) {
      const cell = cells[item.anchor.row]?.[item.anchor.col];
      if (cell?.prop) delete cell.prop;
    }

    this.isDragging = true;
    this.dragItems = items;
    this.dragLeadAnchor = { row: anchor.row, col: anchor.col };
    this.dragGhost = { row: anchor.row, col: anchor.col };
    setCursor('grabbing');
  }

  _allPositionsValid() {
    const cells = state.dungeon.cells;
    const claimed = new Set();
    for (const item of this.dragItems) {
      const newRow = this.dragGhost.row + item.offsetRow;
      const newCol = this.dragGhost.col + item.offsetCol;
      const [spanRows, spanCols] = getEffectiveFootprint(item.propDef, item.facing);
      if (!isFootprintClear(cells, newRow, newCol, spanRows, spanCols)) return false;
      for (let r = newRow; r < newRow + spanRows; r++) {
        for (let c = newCol; c < newCol + spanCols; c++) {
          const key = `${r},${c}`;
          if (claimed.has(key)) return false;
          claimed.add(key);
        }
      }
    }
    return true;
  }

  _finishDrag() {
    if (this.dragItems.length === 0 || !this.dragGhost) {
      this._cancelDrag();
      return;
    }

    if (this._allPositionsValid()) {
      const cells = state.dungeon.cells;
      const newAnchors = [];
      for (const item of this.dragItems) {
        const newRow = this.dragGhost.row + item.offsetRow;
        const newCol = this.dragGhost.col + item.offsetCol;
        const [spanRows, spanCols] = getEffectiveFootprint(item.propDef, item.facing);
        cells[newRow][newCol].prop = {
          type: item.origProp.type,
          span: [spanRows, spanCols],
          facing: item.facing,
          ...(item.flipped && { flipped: true }),
        };
        newAnchors.push({ row: newRow, col: newCol });
      }
      state.selectedPropAnchors = newAnchors;
      markDirty();
      notify();
    } else {
      undo();
    }

    this.isDragging = false;
    this.dragItems = [];
    this.dragLeadAnchor = null;
    this.dragGhost = null;
    setCursor(this.hoveredAnchor ? 'grab' : 'crosshair');
    requestRender();
  }

  _cancelDrag() {
    if (this.isDragging) undo();
    this.isDragging = false;
    this.dragItems = [];
    this.dragLeadAnchor = null;
    this.dragGhost = null;
    setCursor('crosshair');
    requestRender();
  }

  // ── Key Handlers ────────────────────────────────────────────────────────

  _handleRotate(degrees) {
    if (state.selectedPropAnchors.length > 1) {
      this._rotateSelectedGroup(degrees);
      return;
    }
    if (state.selectedPropAnchors.length === 1) {
      const cells = state.dungeon.cells;
      pushUndo('Rotate prop');
      const anchor = state.selectedPropAnchors[0];
      const cell = cells[anchor.row]?.[anchor.col];
      if (cell?.prop) {
        const newFacing = (cell.prop.facing + degrees) % 360;
        const [oldSpanRows, oldSpanCols] = cell.prop.span;
        const [newSpanRows, newSpanCols] = (degrees === 90 || degrees === 270)
          ? [oldSpanCols, oldSpanRows] : [oldSpanRows, oldSpanCols];

        const numRows = cells.length;
        const numCols = cells[0]?.length || 0;
        let fits = true;
        for (let r = anchor.row; r < anchor.row + newSpanRows && fits; r++) {
          for (let c = anchor.col; c < anchor.col + newSpanCols && fits; c++) {
            if (r < 0 || r >= numRows || c < 0 || c >= numCols) { fits = false; break; }
            if (cells[r][c] === null) { fits = false; break; }
            if (r === anchor.row && c === anchor.col) continue;
            const existing = findPropAnchor(cells, r, c);
            if (existing && (existing.row !== anchor.row || existing.col !== anchor.col)) fits = false;
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
      return;
    }
    // No selection → rotate placement default
    state.propRotation = (state.propRotation + degrees) % 360;
    notify();
    requestRender();
  }

  _handleFlip() {
    if (state.selectedPropAnchors.length > 1) {
      this._flipSelectedGroup();
      return;
    }
    if (state.selectedPropAnchors.length === 1) {
      const cells = state.dungeon.cells;
      pushUndo('Flip prop');
      const cell = cells[state.selectedPropAnchors[0].row]?.[state.selectedPropAnchors[0].col];
      if (cell?.prop) {
        if (cell.prop.flipped) delete cell.prop.flipped;
        else cell.prop.flipped = true;
      }
      markDirty();
      notify();
      requestRender();
      return;
    }
    // No selection → flip placement default
    state.propFlipped = !state.propFlipped;
    notify();
    requestRender();
  }

  // ── Group Transform Helpers ───────────────────────────────────────────────

  // Rotate all dragItems 90° CW or CCW as a group, updating offsets and facings
  _rotateDragGroup(degrees = 90) {
    if (!this.dragGhost || this.dragItems.length === 0) return;
    if (this.dragItems.length === 1) {
      this.dragItems[0].facing = (this.dragItems[0].facing + degrees) % 360;
      return;
    }

    // Compute bounding box of all items in absolute grid space
    let r_min = Infinity, c_min = Infinity, r_max = -Infinity, c_max = -Infinity;
    for (const item of this.dragItems) {
      const [spanRows, spanCols] = getEffectiveFootprint(item.propDef, item.facing);
      const absRow = this.dragGhost.row + item.offsetRow;
      const absCol = this.dragGhost.col + item.offsetCol;
      r_min = Math.min(r_min, absRow);
      c_min = Math.min(c_min, absCol);
      r_max = Math.max(r_max, absRow + spanRows);
      c_max = Math.max(c_max, absCol + spanCols);
    }
    const H = r_max - r_min;
    const W = c_max - c_min;

    for (const item of this.dragItems) {
      const [spanRows, spanCols] = getEffectiveFootprint(item.propDef, item.facing);
      const absRow = this.dragGhost.row + item.offsetRow;
      const absCol = this.dragGhost.col + item.offsetCol;
      const relRow = absRow - r_min;
      const relCol = absCol - c_min;
      // CW: newRelRow=relCol, newRelCol=H-relRow-spanRows
      // CCW: newRelRow=W-relCol-spanCols, newRelCol=relRow
      const newRelRow = degrees === 90 ? relCol : W - relCol - spanCols;
      const newRelCol = degrees === 90 ? H - relRow - spanRows : relRow;
      item.offsetRow = r_min + newRelRow - this.dragGhost.row;
      item.offsetCol = c_min + newRelCol - this.dragGhost.col;
      item.facing = (item.facing + degrees) % 360;
    }
  }

  // Flip all dragItems horizontally as a group, updating col offsets and flipped flags
  _flipDragGroup() {
    if (!this.dragGhost || this.dragItems.length === 0) return;
    if (this.dragItems.length === 1) {
      this.dragItems[0].flipped = !this.dragItems[0].flipped;
      return;
    }

    let c_min = Infinity, c_max = -Infinity;
    for (const item of this.dragItems) {
      const [, spanCols] = getEffectiveFootprint(item.propDef, item.facing);
      const absCol = this.dragGhost.col + item.offsetCol;
      c_min = Math.min(c_min, absCol);
      c_max = Math.max(c_max, absCol + spanCols);
    }
    const W = c_max - c_min;

    for (const item of this.dragItems) {
      const [, spanCols] = getEffectiveFootprint(item.propDef, item.facing);
      const absCol = this.dragGhost.col + item.offsetCol;
      const relCol = absCol - c_min;
      item.offsetCol = c_min + W - relCol - spanCols - this.dragGhost.col;
      item.flipped = !item.flipped;
    }
  }

  // Rotate selected props 90° CW or CCW as a spatial group
  _rotateSelectedGroup(degrees = 90) {
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;

    const items = [];
    let r_min = Infinity, c_min = Infinity, r_max = -Infinity, c_max = -Infinity;
    for (const anchor of state.selectedPropAnchors) {
      const cell = cells[anchor.row]?.[anchor.col];
      if (!cell?.prop) continue;
      const [spanRows, spanCols] = cell.prop.span;
      items.push({ anchor, cell, spanRows, spanCols });
      r_min = Math.min(r_min, anchor.row);
      c_min = Math.min(c_min, anchor.col);
      r_max = Math.max(r_max, anchor.row + spanRows);
      c_max = Math.max(c_max, anchor.col + spanCols);
    }
    if (items.length === 0) return;
    const H = r_max - r_min;
    const W = c_max - c_min;

    // Compute new positions (CW or CCW bbox rotation)
    const placements = items.map(({ anchor, cell, spanRows, spanCols }) => {
      const relRow = anchor.row - r_min;
      const relCol = anchor.col - c_min;
      // CW: newRelRow=relCol, newRelCol=H-relRow-spanRows
      // CCW: newRelRow=W-relCol-spanCols, newRelCol=relRow
      const newRelRow = degrees === 90 ? relCol : W - relCol - spanCols;
      const newRelCol = degrees === 90 ? H - relRow - spanRows : relRow;
      return {
        newRow: r_min + newRelRow,
        newCol: c_min + newRelCol,
        newSpanRows: spanCols,
        newSpanCols: spanRows,
        newFacing: (cell.prop.facing + degrees) % 360,
        flipped: !!cell.prop.flipped,
        type: cell.prop.type,
        oldAnchor: anchor,
      };
    });

    // Validate: in-bounds, non-void, no external prop overlap
    const oldKeys = new Set(items.map(({ anchor }) => `${anchor.row},${anchor.col}`));
    const claimed = new Set();
    for (const p of placements) {
      for (let r = p.newRow; r < p.newRow + p.newSpanRows; r++) {
        for (let c = p.newCol; c < p.newCol + p.newSpanCols; c++) {
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
          if (cells[r][c] === null) return;
          const key = `${r},${c}`;
          if (claimed.has(key)) return;
          const existing = findPropAnchor(cells, r, c);
          if (existing && !oldKeys.has(`${existing.row},${existing.col}`)) return;
          claimed.add(key);
        }
      }
    }

    pushUndo('Rotate props');
    for (const { oldAnchor } of placements) delete cells[oldAnchor.row][oldAnchor.col].prop;
    const newAnchors = [];
    for (const p of placements) {
      cells[p.newRow][p.newCol].prop = {
        type: p.type,
        span: [p.newSpanRows, p.newSpanCols],
        facing: p.newFacing,
        ...(p.flipped && { flipped: true }),
      };
      newAnchors.push({ row: p.newRow, col: p.newCol });
    }
    state.selectedPropAnchors = newAnchors;
    markDirty();
    notify();
    requestRender();
  }

  // Flip selected props horizontally as a spatial group
  _flipSelectedGroup() {
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;

    const items = [];
    let c_min = Infinity, c_max = -Infinity;
    for (const anchor of state.selectedPropAnchors) {
      const cell = cells[anchor.row]?.[anchor.col];
      if (!cell?.prop) continue;
      const [spanRows, spanCols] = cell.prop.span;
      items.push({ anchor, cell, spanRows, spanCols });
      c_min = Math.min(c_min, anchor.col);
      c_max = Math.max(c_max, anchor.col + spanCols);
    }
    if (items.length === 0) return;
    const W = c_max - c_min;

    const placements = items.map(({ anchor, cell, spanRows, spanCols }) => ({
      newRow: anchor.row,
      newCol: c_min + W - (anchor.col - c_min) - spanCols,
      newSpanRows: spanRows,
      newSpanCols: spanCols,
      newFacing: cell.prop.facing,
      flipped: !cell.prop.flipped,
      type: cell.prop.type,
      oldAnchor: anchor,
    }));

    const oldKeys = new Set(items.map(({ anchor }) => `${anchor.row},${anchor.col}`));
    const claimed = new Set();
    for (const p of placements) {
      for (let r = p.newRow; r < p.newRow + p.newSpanRows; r++) {
        for (let c = p.newCol; c < p.newCol + p.newSpanCols; c++) {
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
          if (cells[r][c] === null) return;
          const key = `${r},${c}`;
          if (claimed.has(key)) return;
          const existing = findPropAnchor(cells, r, c);
          if (existing && !oldKeys.has(`${existing.row},${existing.col}`)) return;
          claimed.add(key);
        }
      }
    }

    pushUndo('Flip props');
    for (const { oldAnchor } of placements) delete cells[oldAnchor.row][oldAnchor.col].prop;
    const newAnchors = [];
    for (const p of placements) {
      cells[p.newRow][p.newCol].prop = {
        type: p.type,
        span: [p.newSpanRows, p.newSpanCols],
        facing: p.newFacing,
        ...(p.flipped && { flipped: true }),
      };
      newAnchors.push({ row: p.newRow, col: p.newCol });
    }
    state.selectedPropAnchors = newAnchors;
    markDirty();
    notify();
    requestRender();
  }

  _deleteSelected() {
    if (state.selectedPropAnchors.length === 0) return;
    const cells = state.dungeon.cells;

    pushUndo('Delete prop');

    for (const anchor of state.selectedPropAnchors) {
      const cell = cells[anchor.row]?.[anchor.col];
      if (cell?.prop) delete cell.prop;
    }

    state.selectedPropAnchors = [];
    markDirty();
    notify();
    requestRender();
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

    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 3);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, centerX, aboveY - 2);
    ctx.restore();
  }
}
