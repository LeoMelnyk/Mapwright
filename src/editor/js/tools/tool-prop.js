// Prop tool: place props from catalog or select/manipulate placed props
import { Tool } from './tool-base.js';
import state, { pushUndo, undo, markDirty, notify, getTheme, invalidateLightmap } from '../state.js';
import { getLightCatalog } from '../light-catalog.js';
import { requestRender, setCursor, getTransform } from '../canvas-view.js';
import { toCanvas } from '../utils.js';
import { renderProp, hitTestPropPixel } from '../../../render/index.js';
import { getTextureCatalog } from '../texture-catalog.js';
import { showToast } from '../toast.js';
import { lookupPropAt, markPropSpatialDirty } from '../prop-spatial.js';
import { createOverlayProp } from '../prop-overlay.js';
import { bringForward, sendBackward } from '../api/props.js';

const BOX_SELECT_THRESHOLD = 8; // pixels before a mousedown-on-empty becomes a box-select drag

// ── Overlay Helpers ─────────────────────────────────────────────────────
// All prop data lives in metadata.props[]. These helpers access it.

function _ensurePropsArray() {
  const meta = state.dungeon.metadata;
  if (!meta.props) meta.props = [];
  if (!meta.nextPropId) meta.nextPropId = 1;
  return meta;
}

function _findOverlayAt(row, col) {
  // Use spatial hash to find the topmost prop ID, then look up in the array
  const entry = lookupPropAt(row, col);
  if (!entry) return null;
  const meta = state.dungeon.metadata;
  return meta?.props?.find(p => p.id === entry.propId) ?? null;
}

function _removeOverlayAt(row, col) {
  const entry = lookupPropAt(row, col);
  if (!entry) return;
  const meta = state.dungeon.metadata;
  if (!meta?.props) return;
  const idx = meta.props.findIndex(p => p.id === entry.propId);
  if (idx >= 0) meta.props.splice(idx, 1);
  // Remove linked lights
  if (meta.lights?.length) {
    meta.lights = meta.lights.filter(l => !(l.propRef?.row === row && l.propRef?.col === col));
  }
}

function _addOverlayAt(row, col, propType, facing, flipped = false) {
  const meta = _ensurePropsArray();
  const gs = meta.gridSize || 5;
  const entry = createOverlayProp(meta, propType, row, col, gs, { rotation: facing, flipped });
  meta.props.push(entry);
  return entry;
}

/** Compute the pixel bounds of an overlay prop for selection/hover boxes. */
function _propBounds(overlay, gridSize, transform) {
  const [spanRows, spanCols] = _overlaySpan(overlay);
  const scl = overlay.scale ?? 1.0;
  const w = spanCols * gridSize;
  const h = spanRows * gridSize;
  // Scale expands from center (matching how the canvas transform renderer works)
  const cx = overlay.x + w / 2;
  const cy = overlay.y + h / 2;
  const topLeft = toCanvas(cx - (w * scl) / 2, cy - (h * scl) / 2, transform);
  const bottomRight = toCanvas(cx + (w * scl) / 2, cy + (h * scl) / 2, transform);
  return { topLeft, bottomRight };
}

/** Get the effective span of an overlay prop from its catalog definition + rotation. */
function _overlaySpan(overlayProp) {
  const catalog = state.propCatalog;
  const propDef = catalog?.props?.[overlayProp.type];
  if (!propDef) return [1, 1];
  return getEffectiveFootprint(propDef, overlayProp.rotation || 0);
}

/** Find the topmost overlay prop whose visual AABB contains the pixel position.
 *  Returns { row, col } anchor (for compat with existing selection system) or null. */
function _hitTestProps(pos, transform, gridSize) {
  const meta = state.dungeon.metadata;
  if (!meta?.props?.length || !pos) return null;

  // Convert pixel position to world-feet
  const wx = (pos.x - transform.offsetX) / transform.scale;
  const wy = (pos.y - transform.offsetY) / transform.scale;

  const catalog = state.propCatalog;

  // Collect AABB hits, then filter by geometric shape test. Sort by z desc, area asc.
  const hits = [];
  for (const prop of meta.props) {
    const [spanRows, spanCols] = _overlaySpan(prop);
    const scl = prop.scale ?? 1.0;
    const w = spanCols * gridSize * scl;
    const h = spanRows * gridSize * scl;
    const uw = spanCols * gridSize;
    const uh = spanRows * gridSize;
    const cx = prop.x + uw / 2;
    const cy = prop.y + uh / 2;
    const minX = cx - w / 2;
    const minY = cy - h / 2;
    const maxX = cx + w / 2;
    const maxY = cy + h / 2;

    if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY) {
      hits.push({ prop, area: w * h, z: prop.zIndex ?? 10 });
    }
  }

  if (hits.length === 0) return null;

  // Sort: highest z first, then smallest area
  hits.sort((a, b) => b.z - a.z || a.area - b.area);

  // Pick the first hit that passes pixel-level alpha test
  let best = null;
  for (const hit of hits) {
    if (hitTestPropPixel(hit.prop, wx, wy, catalog, gridSize)) {
      best = hit.prop;
      break;
    }
  }

  if (!best) return null;
  const anchorRow = Math.round(best.y / gridSize);
  const anchorCol = Math.round(best.x / gridSize);
  return { row: anchorRow, col: anchorCol, propId: best.id };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getEffectiveFootprint(propDef, rotation) {
  const [rows, cols] = propDef.footprint;
  if (rotation === 90 || rotation === 270) return [cols, rows];
  return [rows, cols];
}

/** Offset anchor so the prop centers on the mouse cell instead of top-left anchoring. */
function centeredAnchor(row, col, propDef, rotation) {
  const [spanRows, spanCols] = getEffectiveFootprint(propDef, rotation);
  return {
    row: row - Math.floor(spanRows / 2),
    col: col - Math.floor(spanCols / 2),
  };
}

function findPropAnchor(_cells, row, col) {
  // O(1) spatial hash lookup (reads from metadata.props[])
  const entry = lookupPropAt(row, col);
  if (entry) return { row: entry.anchorRow, col: entry.anchorCol };
  return null;
}

function isFootprintClear(cells, anchorRow, anchorCol, spanRows, spanCols) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  for (let r = anchorRow; r < anchorRow + spanRows; r++) {
    for (let c = anchorCol; c < anchorCol + spanCols; c++) {
      if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
      if (cells[r][c] === null) return false; // void cell
      // Overlapping props is now allowed (z-ordered stickers layer)
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
    this.dragGhost = null;        // {row, col, worldX?, worldY?} — lead prop's current ghost position
    this.dragFreeform = false;    // true when Ctrl held during drag (sub-cell positioning)
    // Pending drag (prop clicked but not yet moved beyond threshold)
    this._pendingDragAnchor = null;  // anchor of prop to potentially drag
    this._pendingDragPos = null;     // pixel position at prop mousedown
    // Hover state
    this.hoveredAnchor = null;    // anchor cell of prop currently under cursor
    this.hoverRow = null;
    this.hoverCol = null;
    this.hoverFreeform = false;   // true when Ctrl held during hover (freeform ghost)
    this.hoverWorldX = null;      // world-feet X when freeform hover
    this.hoverWorldY = null;      // world-feet Y when freeform hover
    // Paste mode cursor tracking
    this.pasteHover = null;       // {row, col} — current cursor cell for paste preview
  }

  getCursor() {
    return 'crosshair'; // dynamic cursor updates happen in onMouseMove
  }

  onActivate() {
    state.statusInstruction = 'Click place · R rotate · Alt+Scroll fine rotate · Alt+Shift+Scroll scale · Arrows nudge · [ ] z-order · Ctrl freeform · Shift snap';
  }

  onDeactivate() {
    if (this.isDragging) {
      undo(); // restore prop at original position
    }
    this._resetDragState();
    this._resetHoverState();
    state.propPasteMode = false;
    this.pasteHover = null;
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
    this.hoverFreeform = false;
    this.hoverWorldX = null;
    this.hoverWorldY = null;
  }

  // ── Mouse Handlers ───────────────────────────────────────────────────────

  onMouseDown(row, col, edge, event, pos) {
    // Paste mode: commit paste at cursor position
    if (state.propPasteMode && state.propClipboard) {
      this._commitPropPaste(row, col);
      return;
    }

    const cells = state.dungeon.cells;
    const transform = getTransform();
    const anchor = pos
      ? _hitTestProps(pos, transform, state.dungeon.metadata.gridSize || 5)
      : findPropAnchor(cells, row, col);

    if (anchor) {
      // Clicking on a prop → select/drag flow
      this._selectOnMouseDown(anchor.row, anchor.col, event, pos, anchor.propId);
    } else {
      // Clicking on empty space → defer place; start tracking for potential box-select
      this._pendingPlace = { row, col };
      this._pendingPlacePos = pos || null;
      this._pendingPlaceCtrl = event.ctrlKey || event.metaKey;
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

    // Paste mode: update hover for preview
    if (state.propPasteMode) {
      if (!this.pasteHover || this.pasteHover.row !== row || this.pasteHover.col !== col) {
        this.pasteHover = { row, col };
        requestRender();
      }
      return;
    }

    if (this.isDragging) {
      this.dragFreeform = event.ctrlKey || event.metaKey;
      this.dragSnapToGrid = event.shiftKey;
      if (this.dragFreeform && pos) {
        // Freeform: track exact world-feet position
        const transform = getTransform();
        this.dragGhost = {
          row, col,
          worldX: (pos.x - transform.offsetX) / transform.scale,
          worldY: (pos.y - transform.offsetY) / transform.scale,
        };
      } else {
        this.dragGhost = { row, col };
      }
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

    // Not in any drag — update hover state and cursor (geometric shape hit test)
    const cells = state.dungeon.cells;
    const hoverTransform = getTransform();
    const anchor = pos
      ? _hitTestProps(pos, hoverTransform, state.dungeon.metadata.gridSize || 5)
      : findPropAnchor(cells, row, col);
    if (anchor) {
      if (!this.hoveredAnchor || this.hoveredAnchor.row !== anchor.row || this.hoveredAnchor.col !== anchor.col) {
        this.hoveredAnchor = anchor;
        this.hoverFreeform = false;
        setCursor('grab');
        requestRender();
      }
    } else {
      // Track freeform hover when Ctrl held (for placement ghost)
      const wantsFreeform = (event.ctrlKey || event.metaKey) && pos;
      if (wantsFreeform) {
        this.hoverFreeform = true;
        this.hoverWorldX = (pos.x - hoverTransform.offsetX) / hoverTransform.scale;
        this.hoverWorldY = (pos.y - hoverTransform.offsetY) / hoverTransform.scale;
      } else if (this.hoverFreeform) {
        this.hoverFreeform = false;
        this.hoverWorldX = null;
        this.hoverWorldY = null;
      }
      if (this.hoveredAnchor !== null) {
        this.hoveredAnchor = null;
        setCursor('crosshair');
        requestRender();
      } else if (state.selectedProp) {
        requestRender();
      }
    }
  }

  onMouseUp(_row, _col, _edge, event, pos) {
    if (this.isDragging) {
      this._finishDrag();
      return;
    }

    if (this.isBoxSelecting) {
      // Finalize box-select — check which props overlap the selection rectangle
      if (this.dragStart && this.dragEnd) {
        const r1 = Math.min(this.dragStart.row, this.dragEnd.row);
        const r2 = Math.max(this.dragStart.row, this.dragEnd.row) + 1;
        const c1 = Math.min(this.dragStart.col, this.dragEnd.col);
        const c2 = Math.max(this.dragStart.col, this.dragEnd.col) + 1;
        const meta = state.dungeon.metadata;
        const gs = meta.gridSize || 5;
        const boxMinX = c1 * gs, boxMinY = r1 * gs;
        const boxMaxX = c2 * gs, boxMaxY = r2 * gs;

        if (meta?.props) {
          const selectedIds = new Set();
          for (const prop of meta.props) {
            // Check if prop's visual bounds overlap the selection box
            const [spanRows, spanCols] = _overlaySpan(prop);
            const scl = prop.scale ?? 1.0;
            const uw = spanCols * gs, uh = spanRows * gs;
            const pcx = prop.x + uw / 2, pcy = prop.y + uh / 2;
            const pw = uw * scl, ph = uh * scl;
            const pMinX = pcx - pw / 2, pMinY = pcy - ph / 2;
            const pMaxX = pcx + pw / 2, pMaxY = pcy + ph / 2;

            if (pMaxX > boxMinX && pMinX < boxMaxX && pMaxY > boxMinY && pMinY < boxMaxY) {
              if (!selectedIds.has(prop.id)) {
                selectedIds.add(prop.id);
                const anchorRow = Math.round(prop.y / gs);
                const anchorCol = Math.round(prop.x / gs);
                state.selectedPropAnchors.push({ row: anchorRow, col: anchorCol, propId: prop.id });
              }
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
      const freeform = (event?.ctrlKey || event?.metaKey) || this._pendingPlaceCtrl;
      let placeRow = this._pendingPlace.row;
      let placeCol = this._pendingPlace.col;
      // Center prop on cursor
      if (state.selectedProp) {
        const catalog = state.propCatalog;
        const pDef = catalog?.props?.[state.selectedProp];
        if (pDef) {
          const anchor = centeredAnchor(placeRow, placeCol, pDef, state.propRotation);
          placeRow = anchor.row;
          placeCol = anchor.col;
        }
      }
      this._placeAtCell(placeRow, placeCol, pos || this._pendingPlacePos, freeform);
      this._pendingPlace = null;
      this._pendingPlacePos = null;
      this.dragStart = null;
    }
  }

  onKeyDown(e) {
    // Escape cancels drag, or clears the selected prop template
    if (e.key === 'Escape') {
      if (state.propPasteMode) {
        state.propPasteMode = false;
        this.pasteHover = null;
        requestRender();
        return;
      }
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
      return;
    }

    // Arrow keys: nudge selected props by 1 foot (or 1 cell with Shift)
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && state.selectedPropAnchors.length > 0) {
      e.preventDefault();
      const gs = state.dungeon.metadata.gridSize || 5;
      const step = e.shiftKey ? gs : 1; // Shift = full cell, bare = 1 foot
      let dx = 0, dy = 0;
      if (e.key === 'ArrowUp')    dy = -step;
      if (e.key === 'ArrowDown')  dy = step;
      if (e.key === 'ArrowLeft')  dx = -step;
      if (e.key === 'ArrowRight') dx = step;

      pushUndo('Nudge prop');
      for (const anchor of state.selectedPropAnchors) {
        const overlay = _findOverlayAt(anchor.row, anchor.col);
        if (overlay) {
          overlay.x += dx;
          overlay.y += dy;
        }
      }
      // Update anchor positions to match new grid cells
      state.selectedPropAnchors = state.selectedPropAnchors.map(a => {
        const overlay = _findOverlayAt(a.row, a.col);
        if (!overlay) return a;
        const newRow = Math.round(overlay.y / gs);
        const newCol = Math.round(overlay.x / gs);
        return { row: newRow, col: newCol };
      });
      markPropSpatialDirty();
      invalidateLightmap();
      markDirty();
      notify();
      requestRender();
      return;
    }

    // Z-order: [ = send backward, ] = bring forward
    if ((e.key === '[' || e.key === ']') && state.selectedPropAnchors.length > 0) {
      const anchor = state.selectedPropAnchors[0];
      const overlay = _findOverlayAt(anchor.row, anchor.col);
      if (overlay) {
        if (e.key === ']') bringForward(overlay.id);
        else sendBackward(overlay.id);
        requestRender();
      }
    }
  }

  onWheel(row, col, deltaY, event) {
    // Alt+scroll = rotate, Alt+Shift+scroll = scale
    // Debounce undo: only push a new undo entry if >500ms since last wheel tick
    const now = Date.now();
    const WHEEL_UNDO_DEBOUNCE = 500;
    if (!this._lastWheelUndoTime || now - this._lastWheelUndoTime > WHEEL_UNDO_DEBOUNCE) {
      pushUndo();
    }
    this._lastWheelUndoTime = now;

    // Collect target overlays: all selected, or hovered single prop
    const meta = state.dungeon.metadata;
    const gs = meta.gridSize || 5;
    const overlays = [];
    if (state.selectedPropAnchors.length > 0) {
      for (const a of state.selectedPropAnchors) {
        const o = a.propId ? meta?.props?.find(p => p.id === a.propId) : _findOverlayAt(a.row, a.col);
        if (o) overlays.push(o);
      }
    } else if (this.hoveredAnchor) {
      const o = this.hoveredAnchor.propId
        ? meta?.props?.find(p => p.id === this.hoveredAnchor.propId)
        : _findOverlayAt(this.hoveredAnchor.row, this.hoveredAnchor.col);
      if (o) overlays.push(o);
    }
    if (overlays.length === 0) return;

    if (overlays.length === 1) {
      // Single prop: simple rotation/scale
      if (event.shiftKey) {
        const step = deltaY > 0 ? -0.1 : 0.1;
        overlays[0].scale = Math.max(0.25, Math.min(4.0, (overlays[0].scale ?? 1.0) + step));
        overlays[0].scale = Math.round(overlays[0].scale * 100) / 100;
      } else {
        const step = deltaY > 0 ? 15 : -15;
        overlays[0].rotation = (((overlays[0].rotation || 0) + step) % 360 + 360) % 360;
      }
    } else {
      // Multi-prop: pivot around group center
      // Compute group center in world-feet
      let cx = 0, cy = 0;
      for (const o of overlays) {
        const [sr, sc] = _overlaySpan(o);
        cx += o.x + (sc * gs) / 2;
        cy += o.y + (sr * gs) / 2;
      }
      cx /= overlays.length;
      cy /= overlays.length;

      if (event.shiftKey) {
        // Group scale: scale each prop, adjust positions to maintain relative distance
        const step = deltaY > 0 ? -0.1 : 0.1;
        for (const o of overlays) {
          const [sr, sc] = _overlaySpan(o);
          const propCx = o.x + (sc * gs) / 2;
          const propCy = o.y + (sr * gs) / 2;
          // Scale distance from group center
          const dx = propCx - cx;
          const dy = propCy - cy;
          const newScale = Math.max(0.25, Math.min(4.0, (o.scale ?? 1.0) + step));
          const scaleFactor = newScale / (o.scale ?? 1.0);
          o.x = cx + dx * scaleFactor - (sc * gs) / 2;
          o.y = cy + dy * scaleFactor - (sr * gs) / 2;
          o.scale = Math.round(newScale * 100) / 100;
        }
      } else {
        // Group rotate: rotate each prop's position around group center + rotate the prop itself
        const step = deltaY > 0 ? 15 : -15;
        const rad = (-step * Math.PI) / 180; // negate to match visual rotation direction
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        for (const o of overlays) {
          const [sr, sc] = _overlaySpan(o);
          const propCx = o.x + (sc * gs) / 2;
          const propCy = o.y + (sr * gs) / 2;
          // Orbit around group center
          const dx = propCx - cx;
          const dy = propCy - cy;
          const newCx = cx + dx * cos - dy * sin;
          const newCy = cy + dx * sin + dy * cos;
          o.x = newCx - (sc * gs) / 2;
          o.y = newCy - (sr * gs) / 2;
          // Rotate the prop itself
          o.rotation = (((o.rotation || 0) + step) % 360 + 360) % 360;
        }
      }
    }

    // Update anchors to match new positions
    state.selectedPropAnchors = overlays.map(o => ({
      row: Math.round(o.y / gs),
      col: Math.round(o.x / gs),
      propId: o.id,
    }));

    markPropSpatialDirty();
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
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
    // If dragging or pasting, right-click cancels the action instead of deleting
    if (this.isDragging) {
      this._cancelDrag();
      requestRender();
      return;
    }
    if (state.propPasteMode) {
      state.propPasteMode = false;
      this.pasteHover = null;
      notify();
      requestRender();
      return;
    }

    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;

    // Use cell-based lookup (right-click doesn't receive pixel pos)
    const anchor = findPropAnchor(cells, row, col);
    if (!anchor) return;

    const overlay = _findOverlayAt(anchor.row, anchor.col);
    if (!overlay) return;

    pushUndo('Delete prop');
    _removeOverlayAt(anchor.row, anchor.col);

    // Remove from selection if it was selected
    state.selectedPropAnchors = state.selectedPropAnchors.filter(
      a => a.row !== anchor.row || a.col !== anchor.col
    );

    markPropSpatialDirty();
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
  }

  // ── Overlay ──────────────────────────────────────────────────────────────

  renderOverlay(ctx, transform, gridSize) {
    // 0. Paste preview — ghost props following cursor
    if (state.propPasteMode && state.propClipboard && this.pasteHover) {
      const { row: tRow, col: tCol } = this.pasteHover;
      const theme = getTheme();
      const catalog = state.propCatalog;
      const allValid = this._allPastePositionsValid(tRow, tCol);
      const borderColor = allValid ? 'rgba(100, 255, 100, 0.5)' : 'rgba(255, 100, 100, 0.5)';

      const gs = state.dungeon.metadata.gridSize || 5;
      for (const { dRow, dCol, prop } of state.propClipboard.props) {
        // Compute freeform sub-cell offset from original prop
        const origAnchorCol = Math.round(prop.x / gs);
        const origAnchorRow = Math.round(prop.y / gs);
        const offsetX = (prop.x - origAnchorCol * gs) / gs;
        const offsetY = (prop.y - origAnchorRow * gs) / gs;
        const row = tRow + dRow + offsetY;
        const col = tCol + dCol + offsetX;
        const propDef = catalog?.props?.[prop.type];
        if (!propDef) continue;
        const rot = prop.rotation ?? prop.facing ?? 0;
        const scl = prop.scale ?? 1.0;
        const flipped = !!prop.flipped;
        const [spanRows, spanCols] = getEffectiveFootprint(propDef, rot);
        const needsTransform = scl !== 1.0 || (rot !== 0 && rot !== 90 && rot !== 180 && rot !== 270);

        ctx.save();
        ctx.globalAlpha = 0.45;
        if (needsTransform) {
          const [fRows, fCols] = propDef.footprint;
          const centerNx = fCols / 2, centerNy = fRows / 2;
          const { x: cx, y: cy } = toCanvas((col + centerNx) * gridSize, (row + centerNy) * gridSize, transform);
          ctx.translate(cx, cy);
          ctx.rotate((-rot * Math.PI) / 180);
          ctx.scale(scl, scl);
          const cellPx = gridSize * transform.scale;
          const offsetTransform = { scale: transform.scale, offsetX: -centerNx * cellPx, offsetY: -centerNy * cellPx };
          renderProp(ctx, propDef, 0, 0, 0, gridSize, theme, offsetTransform, flipped, getTextureResolver());
        } else {
          renderProp(ctx, propDef, row, col, rot, gridSize, theme, transform, flipped, getTextureResolver());
        }
        ctx.restore();

        const w = spanCols * gridSize, h = spanRows * gridSize;
        const bCx = col * gridSize + w / 2, bCy = row * gridSize + h / 2;
        const topLeft = toCanvas(bCx - (w * scl) / 2, bCy - (h * scl) / 2, transform);
        const bottomRight = toCanvas(bCx + (w * scl) / 2, bCy + (h * scl) / 2, transform);
        ctx.save();
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
        ctx.restore();
      }
    }

    // 1. Drag ghost (when moving props)
    if (this.isDragging && this.dragGhost && this.dragItems.length > 0) {
      const allValid = this._allPositionsValid();
      const borderColor = allValid ? 'rgba(100, 255, 100, 0.5)' : 'rgba(255, 100, 100, 0.5)';
      const theme = getTheme();

      const isFreeformGhost = this.dragFreeform && this.dragGhost.worldX != null;

      for (const item of this.dragItems) {
        // Compute ghost position, including freeform sub-cell offset
        let row, col;
        const snapToGrid = this.dragSnapToGrid;
        const fox = snapToGrid ? 0 : (item.freeOffsetX || 0);
        const foy = snapToGrid ? 0 : (item.freeOffsetY || 0);
        if (isFreeformGhost) {
          const gs = gridSize;
          row = (this.dragGhost.worldY + item.offsetRow * gs) / gs;
          col = (this.dragGhost.worldX + item.offsetCol * gs) / gs;
        } else {
          row = this.dragGhost.row + item.offsetRow + foy;
          col = this.dragGhost.col + item.offsetCol + fox;
        }
        const [spanRows, spanCols] = getEffectiveFootprint(item.propDef, item.facing);
        const scl = item.scale ?? 1.0;
        const needsTransform = scl !== 1.0 || (item.facing !== 0 && item.facing !== 90 && item.facing !== 180 && item.facing !== 270);

        ctx.save();
        ctx.globalAlpha = 0.4;
        if (needsTransform) {
          // Use canvas transform for scaled/arbitrary-rotated props
          const [fRows, fCols] = item.propDef.footprint;
          const centerNx = fCols / 2;
          const centerNy = fRows / 2;
          const { x: cx, y: cy } = toCanvas((col + centerNx) * gridSize, (row + centerNy) * gridSize, transform);
          ctx.translate(cx, cy);
          ctx.rotate((-item.facing * Math.PI) / 180);
          ctx.scale(scl, scl);
          const cellPx = gridSize * transform.scale;
          const offsetTransform = {
            scale: transform.scale,
            offsetX: -centerNx * cellPx,
            offsetY: -centerNy * cellPx,
          };
          renderProp(ctx, item.propDef, 0, 0, 0, gridSize, theme, offsetTransform, item.flipped, getTextureResolver());
        } else {
          renderProp(ctx, item.propDef, row, col, item.facing, gridSize, theme, transform, item.flipped, getTextureResolver());
        }
        ctx.restore();

        // Bounding box around the ghost
        const w = spanCols * gridSize;
        const h = spanRows * gridSize;
        const cx = col * gridSize + w / 2;
        const cy = row * gridSize + h / 2;
        const topLeft = toCanvas(cx - (w * scl) / 2, cy - (h * scl) / 2, transform);
        const bottomRight = toCanvas(cx + (w * scl) / 2, cy + (h * scl) / 2, transform);
        ctx.save();
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 2;
        ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
        ctx.restore();

        // Draw name label only for the lead prop
        if (item.offsetRow === 0 && item.offsetCol === 0) {
          const name = item.propDef.name || item.origType || '';
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
      const catalog = state.propCatalog;
      const prevDef = catalog?.props?.[state.selectedProp];
      if (prevDef) {
        if (this.hoverFreeform && this.hoverWorldX != null) {
          // Freeform: ghost follows exact cursor position (sub-cell)
          const [spanRows, spanCols] = getEffectiveFootprint(prevDef, state.propRotation);
          const freeRow = this.hoverWorldY / gridSize - spanRows / 2;
          const freeCol = this.hoverWorldX / gridSize - spanCols / 2;
          this._renderPlacePreview(ctx, transform, gridSize, freeRow, freeCol);
        } else {
          const anchor = centeredAnchor(this.hoverRow, this.hoverCol, prevDef, state.propRotation);
          this._renderPlacePreview(ctx, transform, gridSize, anchor.row, anchor.col);
        }
      }
    }

    // 4. Hover highlight — thin dashed outline on the prop under the cursor
    if (this.hoveredAnchor && !this.isDragging) {
      const hoverOverlay = _findOverlayAt(this.hoveredAnchor.row, this.hoveredAnchor.col);
      if (hoverOverlay) {
        const { topLeft, bottomRight } = _propBounds(hoverOverlay, gridSize, transform);
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
      // Use propId if available (from box-select), else fall back to spatial lookup
      const meta = state.dungeon.metadata;
      const selOverlay = anchor.propId
        ? meta?.props?.find(p => p.id === anchor.propId)
        : _findOverlayAt(anchor.row, anchor.col);
      if (!selOverlay) continue;
      const { topLeft, bottomRight } = _propBounds(selOverlay, gridSize, transform);

      ctx.save();
      ctx.strokeStyle = 'rgba(100, 180, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      ctx.restore();

      const propDef = state.propCatalog?.props?.[selOverlay.type];
      const rot = selOverlay.rotation ?? 0;
      const selScale = selOverlay.scale ?? 1.0;
      const name = (propDef?.name || selOverlay.type) + ` ${rot}°` + (selScale !== 1.0 ? ` ${Math.round(selScale * 100)}%` : '');
      this._drawNameLabel(ctx, name, topLeft, bottomRight);
    }
  }

  // ── Place ────────────────────────────────────────────────────────────────

  _placeAtCell(row, col, pixelPos = null, freeform = false) {
    if (!state.selectedProp) return;
    const catalog = state.propCatalog;
    if (!catalog?.props?.[state.selectedProp]) return;

    const propDef = catalog.props[state.selectedProp];
    const [spanRows, spanCols] = getEffectiveFootprint(propDef, state.propRotation);
    const cells = state.dungeon.cells;

    if (!isFootprintClear(cells, row, col, spanRows, spanCols)) return;

    pushUndo('Place prop');
    const entry = _addOverlayAt(row, col, state.selectedProp, state.propRotation, state.propFlipped || false);

    // Freeform: Ctrl+click places at exact pixel position (sub-cell),
    // centering the prop on the cursor (matching the ghost preview)
    if (freeform && pixelPos) {
      const transform = getTransform();
      if (transform) {
        const gs = state.dungeon.metadata.gridSize || 5;
        const cursorWorldX = (pixelPos.x - transform.offsetX) / transform.scale;
        const cursorWorldY = (pixelPos.y - transform.offsetY) / transform.scale;
        entry.x = cursorWorldX - (spanCols * gs) / 2;
        entry.y = cursorWorldY - (spanRows * gs) / 2;
      }
    }

    // Create linked lights if the prop defines any
    if (propDef.lights?.length) {
      const meta = state.dungeon.metadata;
      if (!meta.lights) meta.lights = [];
      if (!meta.nextLightId) meta.nextLightId = 1;
      const gridSize = meta.gridSize || 5;
      const lightCatalog = getLightCatalog();
      const [origRows, origCols] = propDef.footprint;

      for (const lightDef of propDef.lights) {
        // Start from normalized footprint coords (unrotated)
        let nx = lightDef.x ?? 0.5;
        let ny = lightDef.y ?? 0.5;

        // Rotate offset to match prop rotation
        const rot = state.propRotation;
        if (rot === 90) {
          [nx, ny] = [origRows - ny, nx];
        } else if (rot === 180) {
          [nx, ny] = [origCols - nx, origRows - ny];
        } else if (rot === 270) {
          [nx, ny] = [ny, origCols - nx];
        }

        // Use the prop's actual world position (accounts for freeform offset)
        const worldX = entry.x + nx * gridSize;
        const worldY = entry.y + ny * gridSize;

        // Merge preset defaults with overrides from the prop entry
        const preset = lightCatalog?.lights?.[lightDef.preset] || {};
        const light = {
          id: meta.nextLightId++,
          x: worldX,
          y: worldY,
          type: preset.type || 'point',
          radius: preset.radius ?? 20,
          color: preset.color || '#ff9944',
          intensity: preset.intensity ?? 1.0,
          falloff: preset.falloff || 'smooth',
          presetId: lightDef.preset,
          propRef: { row, col },
        };
        if (preset.dimRadius) light.dimRadius = preset.dimRadius;
        if (preset.animation?.type) light.animation = { ...preset.animation };

        meta.lights.push(light);
      }
    }

    // Always invalidate — any prop may block light
    markPropSpatialDirty();
    invalidateLightmap();
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
    const valid = isFootprintClear(cells, Math.floor(row), Math.floor(col), spanRows, spanCols);
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

  _selectOnMouseDown(row, col, event, pos, propId) {
    const anchor = { row, col, propId };

    // Check if this prop is already in the selection (by ID or by position)
    const idx = state.selectedPropAnchors.findIndex(a =>
      (propId && a.propId === propId) || (a.row === row && a.col === col)
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
    // Move all selected props if the dragged anchor is in the selection,
    // otherwise just move the single prop that was clicked.
    const anchorsToMove = state.selectedPropAnchors.some(a =>
      (anchor.propId && a.propId === anchor.propId) || (a.row === anchor.row && a.col === anchor.col)
    ) ? state.selectedPropAnchors : [anchor];

    const meta = state.dungeon.metadata;
    const gs = meta.gridSize || 5;
    const items = [];
    for (const a of anchorsToMove) {
      // Use propId when available (from box-select), else spatial lookup
      const overlay = a.propId
        ? meta?.props?.find(p => p.id === a.propId)
        : _findOverlayAt(a.row, a.col);
      if (!overlay) continue;
      const propDef = state.propCatalog?.props?.[overlay.type];
      if (!propDef) continue;
      // Compute freeform sub-cell offset
      const freeOffsetX = (overlay.x - Math.round(overlay.x / gs) * gs) / gs;
      const freeOffsetY = (overlay.y - Math.round(overlay.y / gs) * gs) / gs;
      // Find linked lights (by propRef matching this prop's anchor)
      const anchorRow = Math.round(overlay.y / gs);
      const anchorCol = Math.round(overlay.x / gs);
      const linkedLightIds = (meta.lights || [])
        .filter(l => l.propRef?.row === anchorRow && l.propRef?.col === anchorCol)
        .map(l => l.id);
      items.push({
        anchor: { row: a.row, col: a.col },
        propId: overlay.id,
        offsetRow: a.row - anchor.row,
        offsetCol: a.col - anchor.col,
        freeOffsetX,
        freeOffsetY,
        origX: overlay.x,
        origY: overlay.y,
        linkedLightIds,
        propDef,
        origType: overlay.type,
        facing: overlay.rotation || 0,
        flipped: overlay.flipped || false,
        scale: overlay.scale ?? 1.0,
        zIndex: overlay.zIndex ?? 10,
      });
    }
    if (items.length === 0) return;

    pushUndo(items.length > 1 ? 'Move props' : 'Move prop');
    for (const item of items) {
      // Remove by ID for reliability
      if (meta?.props) {
        const idx = meta.props.findIndex(p => p.id === item.propId);
        if (idx >= 0) meta.props.splice(idx, 1);
      }
    }

    // Props removed from overlay — update spatial hash and lighting immediately
    markPropSpatialDirty();
    invalidateLightmap();

    this.isDragging = true;
    this.dragItems = items;
    this.dragLeadAnchor = { row: anchor.row, col: anchor.col };
    this.dragGhost = { row: anchor.row, col: anchor.col };
    setCursor('grabbing');
  }

  _allPositionsValid() {
    // Props are free-form overlays — just check the anchor cell is within map bounds
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    for (const item of this.dragItems) {
      const newRow = this.dragGhost.row + item.offsetRow;
      const newCol = this.dragGhost.col + item.offsetCol;
      if (newRow < 0 || newRow >= numRows || newCol < 0 || newCol >= numCols) return false;
    }
    return true;
  }

  _finishDrag() {
    if (this.dragItems.length === 0 || !this.dragGhost) {
      this._cancelDrag();
      return;
    }

    if (this._allPositionsValid()) {
      const gs = state.dungeon.metadata.gridSize || 5;
      const isFreeform = this.dragFreeform && this.dragGhost.worldX != null;
      const newAnchors = [];
      for (const item of this.dragItems) {
        const newRow = this.dragGhost.row + item.offsetRow;
        const newCol = this.dragGhost.col + item.offsetCol;
        const entry = _addOverlayAt(newRow, newCol, item.origType, item.facing, item.flipped);
        entry.scale = item.scale;
        entry.zIndex = item.zIndex;
        if (isFreeform) {
          // Ctrl+drag: place at exact world-feet position
          entry.x = this.dragGhost.worldX + item.offsetCol * gs;
          entry.y = this.dragGhost.worldY + item.offsetRow * gs;
        } else if (!this.dragSnapToGrid && (item.freeOffsetX || item.freeOffsetY)) {
          // Preserve original freeform sub-cell offset (unless Shift = snap to grid)
          entry.x += (item.freeOffsetX || 0) * gs;
          entry.y += (item.freeOffsetY || 0) * gs;
        }
        newAnchors.push({ row: newRow, col: newCol, propId: entry.id });

        // Move linked lights by the same delta as the prop
        if (item.linkedLightIds.length > 0) {
          const dx = entry.x - item.origX;
          const dy = entry.y - item.origY;
          const meta = state.dungeon.metadata;
          const newPropRefRow = Math.round(entry.y / gs);
          const newPropRefCol = Math.round(entry.x / gs);
          for (const lightId of item.linkedLightIds) {
            const light = meta.lights?.find(l => l.id === lightId);
            if (light) {
              light.x += dx;
              light.y += dy;
              light.propRef = { row: newPropRefRow, col: newPropRefCol };
            }
          }
        }
      }
      state.selectedPropAnchors = newAnchors;
      markPropSpatialDirty();
      invalidateLightmap();
      markDirty();
      notify();
    } else {
      undo();
    }

    this.isDragging = false;
    this.dragFreeform = false;
    this.dragItems = [];
    this.dragLeadAnchor = null;
    this.dragGhost = null;
    setCursor(this.hoveredAnchor ? 'grab' : 'crosshair');
    requestRender();
  }

  _cancelDrag() {
    if (this.isDragging) undo();
    this.isDragging = false;
    this.dragFreeform = false;
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
      pushUndo('Rotate prop');
      const anchor = state.selectedPropAnchors[0];
      const overlay = _findOverlayAt(anchor.row, anchor.col);
      if (overlay) {
        // Props are free-form overlays — no footprint validation needed for rotation
        overlay.rotation = (((overlay.rotation || 0) + degrees) % 360 + 360) % 360;
      }
      markPropSpatialDirty();
      invalidateLightmap();
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
      pushUndo('Flip prop');
      const { row: fRow, col: fCol } = state.selectedPropAnchors[0];
      const overlay = _findOverlayAt(fRow, fCol);
      if (overlay) {
        overlay.flipped = !overlay.flipped;
      }
      markPropSpatialDirty();
    invalidateLightmap();
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
    const meta = state.dungeon.metadata;
    const gs = meta.gridSize || 5;

    // Collect overlays
    const overlays = [];
    for (const a of state.selectedPropAnchors) {
      const o = a.propId ? meta?.props?.find(p => p.id === a.propId) : _findOverlayAt(a.row, a.col);
      if (o) overlays.push(o);
    }
    if (overlays.length === 0) return;

    // Compute group center in world-feet
    let cx = 0, cy = 0;
    for (const o of overlays) {
      const [sr, sc] = _overlaySpan(o);
      cx += o.x + (sc * gs) / 2;
      cy += o.y + (sr * gs) / 2;
    }
    cx /= overlays.length;
    cy /= overlays.length;

    pushUndo('Rotate props');

    // Rotate each prop around group center + rotate the prop itself
    const rad = (-degrees * Math.PI) / 180; // negate to match visual direction
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (const o of overlays) {
      const [sr, sc] = _overlaySpan(o);
      const propCx = o.x + (sc * gs) / 2;
      const propCy = o.y + (sr * gs) / 2;
      // Orbit around group center
      const dx = propCx - cx;
      const dy = propCy - cy;
      const newCx = cx + dx * cos - dy * sin;
      const newCy = cy + dx * sin + dy * cos;
      o.x = newCx - (sc * gs) / 2;
      o.y = newCy - (sr * gs) / 2;
      // Rotate the prop itself
      o.rotation = (((o.rotation || 0) + degrees) % 360 + 360) % 360;
    }

    // Update selection anchors
    state.selectedPropAnchors = overlays.map(o => ({
      row: Math.round(o.y / gs),
      col: Math.round(o.x / gs),
      propId: o.id,
    }));
    markPropSpatialDirty();
    invalidateLightmap();
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
      const overlay = _findOverlayAt(anchor.row, anchor.col);
      if (!overlay) continue;
      const [spanRows, spanCols] = _overlaySpan(overlay);
      items.push({ anchor, overlay, spanRows, spanCols });
      c_min = Math.min(c_min, anchor.col);
      c_max = Math.max(c_max, anchor.col + spanCols);
    }
    if (items.length === 0) return;
    const W = c_max - c_min;

    const placements = items.map(({ anchor, overlay, spanRows, spanCols }) => ({
      newRow: anchor.row,
      newCol: c_min + W - (anchor.col - c_min) - spanCols,
      newSpanRows: spanRows,
      newSpanCols: spanCols,
      newFacing: overlay.rotation || 0,
      flipped: !overlay.flipped,
      type: overlay.type,
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
    for (const { oldAnchor } of placements) {
      _removeOverlayAt(oldAnchor.row, oldAnchor.col);
    }
    const newAnchors = [];
    for (const p of placements) {
      _addOverlayAt(p.newRow, p.newCol, p.type, p.newFacing, p.flipped);
      newAnchors.push({ row: p.newRow, col: p.newCol });
    }
    state.selectedPropAnchors = newAnchors;
    markPropSpatialDirty();
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
  }

  _deleteSelected() {
    if (state.selectedPropAnchors.length === 0) return;

    pushUndo('Delete prop');

    for (const anchor of state.selectedPropAnchors) {
      _removeOverlayAt(anchor.row, anchor.col);
    }

    state.selectedPropAnchors = [];
    markPropSpatialDirty();
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
  }

  // ── Prop Copy/Paste ──────────────────────────────────────────────────────

  _allPastePositionsValid(targetRow, targetCol) {
    if (!state.propClipboard) return false;
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const { props } = state.propClipboard;
    const catalog = state.propCatalog;

    for (const { dRow, dCol, prop } of props) {
      const row = targetRow + dRow;
      const col = targetCol + dCol;
      // Compute span from catalog + rotation (overlay props don't have span)
      const propDef = catalog?.props?.[prop.type];
      const [spanRows, spanCols] = propDef
        ? getEffectiveFootprint(propDef, prop.rotation || prop.facing || 0)
        : [1, 1];

      for (let r = row; r < row + spanRows; r++) {
        for (let c = col; c < col + spanCols; c++) {
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
          if (cells[r][c] === null) return false;
        }
      }
    }
    return true;
  }

  _commitPropPaste(targetRow, targetCol) {
    if (!state.propClipboard) return;
    if (!this._allPastePositionsValid(targetRow, targetCol)) return;

    const cells = state.dungeon.cells;
    const { props } = state.propClipboard;

    pushUndo('Paste props');

    // Remove any existing props at paste anchor positions
    for (const { dRow, dCol } of props) {
      const r = targetRow + dRow, c = targetCol + dCol;
      _removeOverlayAt(r, c);
    }

    // Place pasted props
    const newAnchors = [];
    for (const { dRow, dCol, prop } of props) {
      const row = targetRow + dRow;
      const col = targetCol + dCol;
      const cell = cells[row]?.[col];
      if (!cell) continue;
      const entry = _addOverlayAt(row, col, prop.type, prop.facing || prop.rotation || 0, !!prop.flipped);
      if (prop.scale != null) entry.scale = prop.scale;
      if (prop.zIndex != null) entry.zIndex = prop.zIndex;
      // Preserve freeform sub-cell offset from the original prop
      const gs = state.dungeon.metadata.gridSize || 5;
      const origAnchorRow = Math.round(prop.y / gs);
      const origAnchorCol = Math.round(prop.x / gs);
      const offsetX = prop.x - origAnchorCol * gs;
      const offsetY = prop.y - origAnchorRow * gs;
      if (Math.abs(offsetX) > 0.01 || Math.abs(offsetY) > 0.01) {
        entry.x = col * gs + offsetX;
        entry.y = row * gs + offsetY;
      }
      newAnchors.push({ row, col });
    }

    state.selectedPropAnchors = newAnchors;
    state.propPasteMode = false;
    this.pasteHover = null;
    markPropSpatialDirty();
    invalidateLightmap();
    markDirty();
    notify();
    requestRender();
    showToast(`Pasted ${newAnchors.length} prop${newAnchors.length === 1 ? '' : 's'}`);
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
