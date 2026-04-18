// Prop tool: place props from catalog or select/manipulate placed props
import type {
  CellGrid,
  Light,
  LightPreset,
  Metadata,
  OverlayProp,
  PropDefinition,
  RenderTransform,
} from '../../../types.js';
import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { mutate, markDirty, notify, getTheme, invalidateLightmap } from '../state.js';
import { getLightCatalog } from '../light-catalog.js';
import { requestRender, setCursor, getTransform } from '../canvas-view.js';
import { toCanvas } from '../utils.js';
import { renderProp, hitTestPropPixel } from '../../../render/index.js';
import { getTextureCatalog } from '../texture-catalog.js';
import { showToast } from '../toast.js';
import { lookupPropAt, markPropSpatialDirty } from '../prop-spatial.js';
import { createOverlayProp, refreshLinkedLights, visibleAnchorOf } from '../prop-overlay.js';
import { ensurePropTextures, ensurePropHitbox } from '../prop-catalog.js';
import { openPropEditDialog } from '../panels/prop-edit.js';

const BOX_SELECT_THRESHOLD = 8; // pixels before a mousedown-on-empty becomes a box-select drag

// ── Overlay Helpers ─────────────────────────────────────────────────────
// All prop data lives in metadata.props[]. These helpers access it.

function _ensurePropsArray(): Metadata {
  const meta = state.dungeon.metadata;
  meta.props ??= [];
  meta.nextPropId ??= 1;
  return meta;
}

function _findOverlayAt(row: number, col: number): OverlayProp | null {
  // Use spatial hash to find the topmost prop ID, then look up in the array
  const entry = lookupPropAt(row, col);
  if (!entry) return null;
  const meta = state.dungeon.metadata;
  return meta.props?.find((p: { id: string | number }) => p.id === entry.propId) ?? null;
}

function _removeOverlayAt(row: number, col: number): void {
  const entry = lookupPropAt(row, col);
  if (!entry) return;
  const meta = state.dungeon.metadata;
  if (!meta.props) return;
  const idx = meta.props.findIndex((p: { id: string | number }) => p.id === entry.propId);
  if (idx >= 0) meta.props.splice(idx, 1);
  // Remove linked lights
  if (meta.lights.length) {
    meta.lights = meta.lights.filter((l) => !(l.propRef?.row === row && l.propRef.col === col));
  }
}

function _removeOverlayById(propId: string | number): void {
  const meta = state.dungeon.metadata;
  if (!meta.props) return;
  const idx = meta.props.findIndex((p: { id: string | number }) => p.id === propId);
  if (idx < 0) return;
  const prop = meta.props[idx]!;
  const gs = meta.gridSize || 5;
  const anchorRow = Math.round(prop.y / gs);
  const anchorCol = Math.round(prop.x / gs);
  meta.props.splice(idx, 1);
  if (meta.lights.length) {
    meta.lights = meta.lights.filter((l) => !(l.propRef?.row === anchorRow && l.propRef.col === anchorCol));
  }
}

function _addOverlayAt(
  row: number,
  col: number,
  propType: string,
  facing: number,
  flipped: boolean = false,
): OverlayProp {
  const meta = _ensurePropsArray();
  const gs = meta.gridSize || 5;
  const entry = createOverlayProp(meta, propType, row, col, gs, { rotation: facing, flipped });
  // Caller passes the effective (rotated) top-left cell, but the renderer rotates
  // around the base-footprint center (Option A). Shift the stored anchor so the
  // visible prop lands on the requested cell for non-square props at 90°/270°.
  const propDef = state.propCatalog?.props[propType];
  if (propDef) {
    const r = ((facing % 360) + 360) % 360;
    const [fRows, fCols] = propDef.footprint;
    const isRotated90 = r === 90 || r === 270;
    const eRows = isRotated90 ? fCols : fRows;
    const eCols = isRotated90 ? fRows : fCols;
    entry.x -= ((fCols - eCols) / 2) * gs;
    entry.y -= ((fRows - eRows) / 2) * gs;
  }
  meta.props!.push(entry);
  ensurePropHitbox(propType);
  ensurePropTextures(propType);
  return entry;
}

/** Compute the pixel bounds of an overlay prop for selection/hover boxes. */
function _propBounds(
  overlay: { x: number; y: number; type: string; rotation?: number; scale?: number },
  gridSize: number,
  transform: RenderTransform,
) {
  const [spanRows, spanCols] = _overlaySpan(overlay);
  const scl = overlay.scale ?? 1.0;
  const w = spanCols * gridSize;
  const h = spanRows * gridSize;
  // Rotation center is the base-footprint center — matches renderer so 90°/270° line up
  // with the non-cardinal path instead of jumping.
  const catalog = state.propCatalog;
  const propDef = catalog?.props[overlay.type];
  const [fRows, fCols] = propDef?.footprint ?? [spanRows, spanCols];
  const cx = overlay.x + (fCols * gridSize) / 2;
  const cy = overlay.y + (fRows * gridSize) / 2;
  const topLeft = toCanvas(cx - (w * scl) / 2, cy - (h * scl) / 2, transform);
  const bottomRight = toCanvas(cx + (w * scl) / 2, cy + (h * scl) / 2, transform);
  return { topLeft, bottomRight };
}

/**
 * Compute the rotated-rectangle corners (in canvas pixels) that match the prop's rendered
 * orientation. Mirrors the non-cardinal branch of `renderOverlayProps`: rotates the base
 * footprint around its center by `-rotation` (CCW for positive degrees).
 * Also returns the axis-aligned bbox of those corners for label positioning.
 */
function _propSelectionShape(
  overlay: { x: number; y: number; type: string; rotation?: number; scale?: number },
  gridSize: number,
  transform: RenderTransform,
): {
  corners: { x: number; y: number }[];
  bbox: { topLeft: { x: number; y: number }; bottomRight: { x: number; y: number } };
} {
  const catalog = state.propCatalog;
  const propDef = catalog?.props[overlay.type];
  const rotation = overlay.rotation ?? 0;
  const r = ((rotation % 360) + 360) % 360;
  const scl = overlay.scale ?? 1.0;
  const isCardinal = (r === 0 || r === 90 || r === 180 || r === 270) && scl === 1.0;

  // Cardinal + scale 1 path uses axis-aligned effective-footprint bounds — unchanged.
  if (isCardinal || !propDef) {
    const b = _propBounds(overlay, gridSize, transform);
    return {
      corners: [
        b.topLeft,
        { x: b.bottomRight.x, y: b.topLeft.y },
        b.bottomRight,
        { x: b.topLeft.x, y: b.bottomRight.y },
      ],
      bbox: b,
    };
  }

  const [fRows, fCols] = propDef.footprint;
  const w = fCols * gridSize;
  const h = fRows * gridSize;
  // Rotation center matches renderer: (prop.x + fCols*gs/2, prop.y + fRows*gs/2).
  const cxWorld = overlay.x + w / 2;
  const cyWorld = overlay.y + h / 2;
  const hw = (w * scl) / 2;
  const hh = (h * scl) / 2;
  // Negated rotation to match ctx.rotate(-rotation) in the renderer.
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const local = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  const corners = local.map((p) => {
    const rx = p.x * cos - p.y * sin;
    const ry = p.x * sin + p.y * cos;
    return toCanvas(cxWorld + rx, cyWorld + ry, transform);
  });

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return {
    corners,
    bbox: { topLeft: { x: minX, y: minY }, bottomRight: { x: maxX, y: maxY } },
  };
}

function _strokeShape(ctx: CanvasRenderingContext2D, corners: { x: number; y: number }[]): void {
  if (corners.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(corners[0]!.x, corners[0]!.y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
  ctx.closePath();
  ctx.stroke();
}

/** Get the effective span of an overlay prop from its catalog definition + rotation. */
function _overlaySpan(overlayProp: { type: string; rotation?: number; scale?: number }): [number, number] {
  const catalog = state.propCatalog;
  const propDef = catalog?.props[overlayProp.type];
  if (!propDef) return [1, 1];
  return getEffectiveFootprint(propDef, overlayProp.rotation ?? 0);
}

/** Find the topmost overlay prop whose visual AABB contains the pixel position.
 *  Returns { row, col } anchor (for compat with existing selection system) or null. */
function _hitTestProps(pos: { x: number; y: number } | null, transform: RenderTransform, gridSize: number) {
  const meta = state.dungeon.metadata;
  if (!meta.props?.length || !pos) return null;

  // Convert pixel position to world-feet
  const wx = (pos.x - transform.offsetX) / transform.scale;
  const wy = (pos.y - transform.offsetY) / transform.scale;

  const catalog = state.propCatalog;

  // Collect AABB hits, then filter by geometric shape test. Sort by z desc, area asc.
  const hits = [];
  for (const prop of meta.props) {
    const scl = prop.scale;
    const propDef = catalog?.props[prop.type];
    const [fRows, fCols] = propDef?.footprint ?? _overlaySpan(prop);
    // AABB of the rotated-and-scaled rectangle around the base-footprint center.
    // For non-cardinal angles, the rotated rect extends beyond the axis-aligned
    // effective span, so use the full trigonometric envelope.
    const rad = (prop.rotation * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(rad));
    const absSin = Math.abs(Math.sin(rad));
    const halfW = ((fCols / 2) * absCos + (fRows / 2) * absSin) * gridSize * scl;
    const halfH = ((fCols / 2) * absSin + (fRows / 2) * absCos) * gridSize * scl;
    const cx = prop.x + (fCols * gridSize) / 2;
    const cy = prop.y + (fRows * gridSize) / 2;
    const minX = cx - halfW;
    const minY = cy - halfH;
    const maxX = cx + halfW;
    const maxY = cy + halfH;

    if (wx >= minX && wx <= maxX && wy >= minY && wy <= maxY) {
      hits.push({ prop, area: halfW * halfH * 4, z: prop.zIndex });
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

function getEffectiveFootprint(propDef: PropDefinition, rotation: number): [number, number] {
  const [rows, cols] = propDef.footprint;
  if (rotation === 90 || rotation === 270) return [cols, rows];
  return [rows, cols];
}

/** Offset anchor so the prop centers on the mouse cell instead of top-left anchoring. */
function centeredAnchor(row: number, col: number, propDef: PropDefinition, rotation: number) {
  const [spanRows, spanCols] = getEffectiveFootprint(propDef, rotation);
  return {
    row: row - Math.floor(spanRows / 2),
    col: col - Math.floor(spanCols / 2),
  };
}

function findPropAnchor(_cells: CellGrid, row: number, col: number) {
  // O(1) spatial hash lookup (reads from metadata.props[])
  const entry = lookupPropAt(row, col);
  if (entry) return { row: entry.anchorRow, col: entry.anchorCol };
  return null;
}

function isFootprintClear(cells: CellGrid, anchorRow: number, anchorCol: number, spanRows: number, spanCols: number) {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  for (let r = anchorRow; r < anchorRow + spanRows; r++) {
    for (let c = anchorCol; c < anchorCol + spanCols; c++) {
      if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
      if (cells[r]![c] === null) return false; // void cell
      // Overlapping props is now allowed (z-ordered stickers layer)
    }
  }
  return true;
}

function getTextureResolver() {
  const texCat = getTextureCatalog();
  return texCat
    ? (id: string) => {
        const e = texCat.textures[id];
        return e?.img?.complete ? e.img : null;
      }
    : null;
}

// ── Tool ────────────────────────────────────────────────────────────────────

/**
 * Prop tool: place props from catalog, select/move/rotate/flip placed props,
 * and manage prop z-ordering. Supports box-select and copy/paste.
 */
export class PropTool extends Tool {
  declare selectedPropId: number | null;
  declare _dragging: boolean;
  declare _dragPropId: number | null;
  declare _dragStartPos: { x: number; y: number } | null;
  declare _dragStartWorld: { x: number; y: number } | null;
  declare _boxSelectStart: { x: number; y: number } | null;
  declare _boxSelectEnd: { x: number; y: number } | null;
  declare _boxSelecting: boolean;
  dragStart: { row: number; col: number; x?: number; y?: number } | null;
  dragEnd: { row: number; col: number; x?: number; y?: number } | null;
  isBoxSelecting: boolean;
  _pendingPlace: { row: number; col: number } | null;
  _pendingPlacePos: { x: number; y: number } | null;
  isDragging: boolean;
  dragItems: {
    anchor: { row: number; col: number };
    propDef?: PropDefinition;
    origProp?: OverlayProp;
    offsetRow: number;
    offsetCol: number;
    facing: number;
    flipped: boolean;
    propId: number | string;
    origType: string;
    origX: number;
    origY: number;
    freeOffsetX: number;
    freeOffsetY: number;
    linkedLightIds: number[];
    scale: number;
    zIndex: number;
  }[];
  dragLeadAnchor: { row: number; col: number } | null;
  dragGhost: { row: number; col: number; worldX?: number; worldY?: number } | null;
  dragFreeform: boolean;
  _pendingDragAnchor: { row: number; col: number } | null;
  _pendingDragPos: { x: number; y: number } | null;
  hoveredAnchor: { row: number; col: number; propId?: number | string } | null;
  hoverRow: number | null;
  hoverCol: number | null;
  hoverFreeform: boolean;
  hoverWorldX: number | null;
  hoverWorldY: number | null;
  pasteHover: { row: number; col: number } | null;
  dragSnapToGrid: boolean = false;
  _lastWheelUndoTime: number = 0;
  /**
   * Debounce arrow-key nudge undo the same way wheel rotate/scale is: rapid
   * repeat taps (or a held arrow key repeating at ~30 Hz) collapse into a
   * single undo entry instead of filling the stack with 30 entries per second.
   */
  _lastNudgeUndoTime: number = 0;
  _pendingPlaceCtrl: boolean = false;
  _preDragMetaSnapshot: string | null = null;
  /** Remember the last silent-rejection toast so rapid repeat clicks don't spam. */
  _lastToast: { key: string; time: number } = { key: '', time: 0 };

  constructor() {
    super('prop', '9', 'crosshair');
    // Box-select state
    this.dragStart = null;
    this.dragEnd = null;
    this.isBoxSelecting = false;
    // Pending place (deferred from mousedown to mouseup, to allow box-select on drag)
    this._pendingPlace = null; // { row, col }
    this._pendingPlacePos = null; // { x, y } pixel position at mousedown
    // Drag-to-move state (multi-prop)
    this.isDragging = false;
    this.dragItems = []; // [{ anchor, propDef, origProp, offsetRow, offsetCol, facing, flipped }]
    this.dragLeadAnchor = null; // anchor of the directly-dragged prop (offset 0,0)
    this.dragGhost = null; // {row, col, worldX?, worldY?} — lead prop's current ghost position
    this.dragFreeform = false; // true when Ctrl held during drag (sub-cell positioning)
    // Pending drag (prop clicked but not yet moved beyond threshold)
    this._pendingDragAnchor = null; // anchor of prop to potentially drag
    this._pendingDragPos = null; // pixel position at prop mousedown
    // Hover state
    this.hoveredAnchor = null; // anchor cell of prop currently under cursor
    this.hoverRow = null;
    this.hoverCol = null;
    this.hoverFreeform = false; // true when Ctrl held during hover (freeform ghost)
    this.hoverWorldX = null; // world-feet X when freeform hover
    this.hoverWorldY = null; // world-feet Y when freeform hover
    // Paste mode cursor tracking
    this.pasteHover = null; // {row, col} — current cursor cell for paste preview
  }

  getCursor() {
    return 'crosshair'; // dynamic cursor updates happen in onMouseMove
  }

  onActivate() {
    state.statusInstruction =
      'Click place · R rotate · Alt+Scroll fine rotate · Alt+Shift+Scroll scale · Arrows nudge · [ ] z-order · Ctrl freeform · Shift snap';
  }

  onDeactivate() {
    if (this.isDragging) {
      this._restoreDragItems();
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
    this._preDragMetaSnapshot = null;
  }

  _resetHoverState() {
    this.hoveredAnchor = null;
    this.hoverRow = null;
    this.hoverCol = null;
    this.hoverFreeform = false;
    this.hoverWorldX = null;
    this.hoverWorldY = null;
  }

  /**
   * Show a toast for a silent-rejection case (placement blocked, flip blocked,
   * paste blocked). Debounced per reason-key over 1500ms so rapid repeat clicks
   * on the same invalid spot don't stack toasts.
   */
  _toastOnce(key: string, message: string): void {
    const now = Date.now();
    if (this._lastToast.key === key && now - this._lastToast.time < 1500) return;
    this._lastToast = { key, time: now };
    showToast(message);
  }

  // ── Mouse Handlers ───────────────────────────────────────────────────────

  onMouseDown(row: number, col: number, _edge: EdgeInfo | null, event: MouseEvent | null, pos: CanvasPos | null) {
    // Paste mode: commit paste at cursor position
    if (state.propPasteMode && state.propClipboard) {
      this._commitPropPaste(row, col);
      return;
    }

    const cells = state.dungeon.cells;
    const transform = getTransform();
    // When a stamp is armed, clicks always place — never select an existing prop.
    const anchor = state.selectedProp
      ? null
      : pos
        ? _hitTestProps(pos, transform, state.dungeon.metadata.gridSize || 5)
        : findPropAnchor(cells, row, col);

    // Double-click on a prop opens the edit dialog (no drag, no box-select).
    if (anchor && event?.detail === 2) {
      const overlay = (anchor as { propId?: number | string }).propId
        ? state.dungeon.metadata.props?.find(
            (p: { id: string | number }) => p.id === (anchor as { propId?: number | string }).propId,
          )
        : _findOverlayAt(anchor.row, anchor.col);
      if (overlay) {
        state.selectedPropAnchors = [
          { row: anchor.row, col: anchor.col, propId: (anchor as { propId?: number | string }).propId },
        ];
        notify();
        openPropEditDialog(overlay);
        return;
      }
    }

    if (anchor) {
      // Clicking on a prop → select/drag flow
      this._selectOnMouseDown(anchor.row, anchor.col, event!, pos, (anchor as { propId?: number | string }).propId);
    } else {
      // Clicking on empty space → defer place; start tracking for potential box-select
      this._pendingPlace = { row, col };
      this._pendingPlacePos = pos ?? null;
      this._pendingPlaceCtrl = event?.ctrlKey ?? event?.metaKey ?? false;
      this.isBoxSelecting = false;
      this.dragStart = { row, col };
      this.dragEnd = null;
      if (!event?.shiftKey) state.selectedPropAnchors = [];
      notify();
      requestRender();
    }
  }

  onMouseMove(row: number, col: number, _edge: EdgeInfo | null, event: MouseEvent | null, pos: CanvasPos | null) {
    this.hoverRow = row;
    this.hoverCol = col;

    // Paste mode: update hover for preview
    if (state.propPasteMode) {
      if (this.pasteHover?.row !== row || this.pasteHover.col !== col) {
        this.pasteHover = { row, col };
        requestRender();
      }
      return;
    }

    if (this.isDragging) {
      this.dragFreeform = event?.ctrlKey ?? event?.metaKey ?? false;
      this.dragSnapToGrid = event?.shiftKey ?? false;
      if (this.dragFreeform && pos) {
        // Freeform: track exact world-feet position
        const transform = getTransform();
        this.dragGhost = {
          row,
          col,
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

    // Not in any drag — update hover state and cursor (geometric shape hit test).
    // When a stamp is armed, existing props are non-interactive — skip the hit test
    // so the cursor stays on the placement ghost instead of flipping to "grab".
    const cells = state.dungeon.cells;
    const hoverTransform = getTransform();
    const anchor = state.selectedProp
      ? null
      : pos
        ? _hitTestProps(pos, hoverTransform, state.dungeon.metadata.gridSize || 5)
        : findPropAnchor(cells, row, col);
    if (anchor) {
      if (this.hoveredAnchor?.row !== anchor.row || this.hoveredAnchor.col !== anchor.col) {
        this.hoveredAnchor = anchor;
        this.hoverFreeform = false;
        setCursor('grab');
        requestRender();
      }
    } else {
      // Track freeform hover when Ctrl is held (sub-cell placement ghost).
      // Shift overrides Ctrl and forces a grid-snapped ghost, matching the
      // commit-side behavior below.
      const ctrlHeldHover = event?.ctrlKey ?? event?.metaKey;
      const shiftHeldHover = event?.shiftKey ?? false;
      const wantsFreeform = ctrlHeldHover && !shiftHeldHover && pos;
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

  onMouseUp(_row: number, _col: number, _edge: EdgeInfo | null, event: MouseEvent | null, pos?: CanvasPos | null) {
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
        const boxMinX = c1 * gs,
          boxMinY = r1 * gs;
        const boxMaxX = c2 * gs,
          boxMaxY = r2 * gs;

        if (meta.props) {
          const selectedIds = new Set();
          const catalog = state.propCatalog;
          for (const prop of meta.props) {
            // Check if prop's visual bounds overlap the selection box. Use the base-footprint
            // center so 90°/270° props line up with the renderer's pivot.
            const [spanRows, spanCols] = _overlaySpan(prop);
            const scl = prop.scale;
            const uw = spanCols * gs,
              uh = spanRows * gs;
            const propDef = catalog?.props[prop.type];
            const [fRows, fCols] = propDef?.footprint ?? [spanRows, spanCols];
            const pcx = prop.x + (fCols * gs) / 2,
              pcy = prop.y + (fRows * gs) / 2;
            const pw = uw * scl,
              ph = uh * scl;
            const pMinX = pcx - pw / 2,
              pMinY = pcy - ph / 2;
            const pMaxX = pcx + pw / 2,
              pMaxY = pcy + ph / 2;

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
      // No significant drag — place prop at the original click position.
      // Ctrl (or ⌘) = freeform sub-cell placement. Shift overrides Ctrl to
      // force a grid snap — matches the keybindings helper's "Shift → Snap
      // to grid" advertisement.
      const ctrlHeld = event?.ctrlKey ?? event?.metaKey ?? this._pendingPlaceCtrl;
      const shiftHeld = event?.shiftKey ?? false;
      const freeform = ctrlHeld && !shiftHeld;
      let placeRow = this._pendingPlace.row;
      let placeCol = this._pendingPlace.col;
      // Center prop on cursor
      if (state.selectedProp) {
        const catalog = state.propCatalog;
        const pDef = catalog?.props[state.selectedProp];
        if (pDef) {
          const anchor = centeredAnchor(placeRow, placeCol, pDef, state.propRotation);
          placeRow = anchor.row;
          placeCol = anchor.col;
        }
      }
      this._placeAtCell(placeRow, placeCol, pos ?? this._pendingPlacePos, freeform);
      this._pendingPlace = null;
      this._pendingPlacePos = null;
      this.dragStart = null;
    }
  }

  onKeyDown(e: KeyboardEvent) {
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
        state.propRotation = 0;
        state.propScale = 1.0;
        notify();
        requestRender();
      }
      return;
    }

    // Enter on a single selected prop opens the edit dialog. Dialog owns
    // further Enter presses while open via a capturing window listener, so
    // this only fires when the dialog is closed.
    if (e.key === 'Enter' && state.selectedPropAnchors.length === 1 && !state.propPasteMode && !this.isDragging) {
      const anchor = state.selectedPropAnchors[0]!;
      const overlay = anchor.propId
        ? state.dungeon.metadata.props?.find((p: { id: string | number }) => p.id === anchor.propId)
        : _findOverlayAt(anchor.row, anchor.col);
      if (overlay) {
        e.preventDefault();
        openPropEditDialog(overlay);
      }
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      const degrees = e.shiftKey ? 270 : 90;
      if (state.propPasteMode) {
        this._rotatePasteClipboard(degrees);
        return;
      }
      if (this.isDragging) {
        this._rotateDragGroup(degrees);
        requestRender();
        return;
      }
      this._handleRotate(degrees);
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      if (state.propPasteMode) {
        this._flipPasteClipboard();
        return;
      }
      if (this.isDragging) {
        this._flipDragGroup();
        requestRender();
        return;
      }
      this._handleFlip();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      // In paste mode, Delete has no target (nothing is selected) — ignore.
      if (state.propPasteMode) return;
      this._deleteSelected();
      return;
    }

    // Arrow keys: nudge selected props by 1 foot (or 1 cell with Shift)
    if (state.propPasteMode && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      // No-op in paste mode — the paste ghost follows the cursor, there's nothing to nudge.
      e.preventDefault();
      return;
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && state.selectedPropAnchors.length > 0) {
      e.preventDefault();
      const gs = state.dungeon.metadata.gridSize || 5;
      const step = e.shiftKey ? gs : 1; // Shift = full cell, bare = 1 foot
      let dx = 0,
        dy = 0;
      if (e.key === 'ArrowUp') dy = -step;
      if (e.key === 'ArrowDown') dy = step;
      if (e.key === 'ArrowLeft') dx = -step;
      if (e.key === 'ArrowRight') dx = step;

      const nudgeMeta = state.dungeon.metadata;
      // Debounce undo: a new undo entry is only pushed if >500 ms passed since
      // the last arrow-key nudge, so holding a direction arrow doesn't fill
      // the undo stack with one entry per keyboard repeat.
      const now = Date.now();
      const NUDGE_UNDO_DEBOUNCE = 500;
      const needsUndo = !this._lastNudgeUndoTime || now - this._lastNudgeUndoTime > NUDGE_UNDO_DEBOUNCE;
      this._lastNudgeUndoTime = now;

      const applyNudge = () => {
        for (const anchor of state.selectedPropAnchors) {
          const overlay = anchor.propId
            ? nudgeMeta.props?.find((p: { id: string | number }) => p.id === anchor.propId)
            : _findOverlayAt(anchor.row, anchor.col);
          if (overlay) {
            const propDef = state.propCatalog?.props[overlay.type];
            const oldVisible = visibleAnchorOf(overlay, propDef, gs);
            overlay.x += dx;
            overlay.y += dy;
            refreshLinkedLights(nudgeMeta, overlay, propDef, oldVisible, dx, dy);
          }
        }
      };

      if (needsUndo) {
        mutate('Nudge prop', [], applyNudge, { metaOnly: true, invalidate: ['lighting:props', 'props'] });
      } else {
        // Subsequent nudges in the burst — mutate in place, no new undo entry.
        applyNudge();
        markPropSpatialDirty();
        invalidateLightmap('props');
        markDirty();
        notify('props');
      }
      // Update anchor positions to match new grid cells
      state.selectedPropAnchors = state.selectedPropAnchors.map(
        (a: { row: number; col: number; propId?: number | string }) => {
          const overlay = a.propId
            ? nudgeMeta.props?.find((p: { id: string | number }) => p.id === a.propId)
            : _findOverlayAt(a.row, a.col);
          if (!overlay) return a;
          const newRow = Math.round(overlay.y / gs);
          const newCol = Math.round(overlay.x / gs);
          return { row: newRow, col: newCol, propId: a.propId };
        },
      );
      requestRender();
      return;
    }

    // Z-order: [ = decrement z, ] = increment z (direct +/-1 on every press)
    if (e.key === '[' || e.key === ']') {
      const step = e.key === ']' ? 1 : -1;
      if (state.propPasteMode) {
        this._adjustPasteZ(step);
        return;
      }
      if (this.isDragging && this.dragItems.length > 0) {
        for (const item of this.dragItems) {
          item.zIndex = Math.max(0, item.zIndex + step);
        }
        requestRender();
        return;
      }
      if (state.selectedPropAnchors.length > 0) {
        const meta = state.dungeon.metadata;
        const overlays = state.selectedPropAnchors
          .map((a: { row: number; col: number; propId?: string | number }) =>
            a.propId != null
              ? (meta.props?.find((p: { id: string | number }) => p.id === a.propId) ?? null)
              : _findOverlayAt(a.row, a.col),
          )
          .filter((o): o is NonNullable<typeof o> => o !== null);
        if (overlays.length > 0) {
          mutate(
            step > 0 ? 'Increment prop z-index' : 'Decrement prop z-index',
            [],
            () => {
              for (const overlay of overlays) {
                overlay.zIndex = Math.max(0, overlay.zIndex + step);
              }
            },
            { metaOnly: true, invalidate: ['props'] },
          );
          requestRender();
        }
      }
    }
  }

  onWheel(row: number, col: number, deltaY: number, event: WheelEvent) {
    // Alt+scroll = rotate, Alt+Shift+scroll = scale

    // ── Drag ghost: adjust ghost items directly (no undo, no state mutation) ──
    if (this.isDragging && this.dragItems.length > 0) {
      if (event.shiftKey) {
        const step = deltaY > 0 ? -0.1 : 0.1;
        for (const item of this.dragItems) {
          item.scale = Math.max(0.25, Math.min(4.0, item.scale + step));
          item.scale = Math.round(item.scale * 100) / 100;
        }
      } else {
        const step = deltaY > 0 ? 15 : -15;
        if (this.dragItems.length === 1) {
          this.dragItems[0]!.facing = ((((this.dragItems[0]!.facing || 0) + step) % 360) + 360) % 360;
        } else {
          this._rotateDragGroup(step);
        }
      }
      requestRender();
      return;
    }

    // ── Paste ghost: rotate/scale all clipboard items ──
    if (state.propPasteMode && state.propClipboard) {
      if (event.shiftKey) {
        const step = deltaY > 0 ? -0.1 : 0.1;
        for (const entry of state.propClipboard.props) {
          const next = Math.max(0.25, Math.min(4.0, entry.prop.scale + step));
          entry.prop.scale = Math.round(next * 100) / 100;
        }
      } else {
        const step = deltaY > 0 ? 15 : -15;
        for (const entry of state.propClipboard.props) {
          entry.prop.rotation = ((((entry.prop.rotation || 0) + step) % 360) + 360) % 360;
        }
      }
      requestRender();
      return;
    }

    // ── Placement ghost: adjust placement defaults (no undo needed) ──
    if (!this.hoveredAnchor && state.selectedProp && this.hoverRow != null) {
      if (event.shiftKey) {
        const step = deltaY > 0 ? -0.1 : 0.1;
        state.propScale = Math.max(0.25, Math.min(4.0, state.propScale + step));
        state.propScale = Math.round(state.propScale * 100) / 100;
      } else {
        const step = deltaY > 0 ? 15 : -15;
        state.propRotation = ((((state.propRotation || 0) + step) % 360) + 360) % 360;
      }
      requestRender();
      return;
    }

    // ── Placed/selected props: mutate overlays with undo ──
    // Debounce undo: only push a new undo entry if >500ms since last wheel tick
    const now = Date.now();
    const WHEEL_UNDO_DEBOUNCE = 500;
    const needsUndo = !this._lastWheelUndoTime || now - this._lastWheelUndoTime > WHEEL_UNDO_DEBOUNCE;
    this._lastWheelUndoTime = now;

    // Collect target overlays: all selected, or hovered single prop
    const meta = state.dungeon.metadata;
    const gs = meta.gridSize || 5;
    const overlays: OverlayProp[] = [];
    if (state.selectedPropAnchors.length > 0) {
      for (const a of state.selectedPropAnchors) {
        const o = a.propId
          ? meta.props?.find((p: { id: string | number }) => p.id === a.propId)
          : _findOverlayAt(a.row, a.col);
        if (o) overlays.push(o);
      }
    } else if (this.hoveredAnchor) {
      const o = this.hoveredAnchor.propId
        ? meta.props?.find((p: { id: string | number }) => p.id === this.hoveredAnchor!.propId)
        : _findOverlayAt(this.hoveredAnchor.row, this.hoveredAnchor.col);
      if (o) overlays.push(o);
    }
    if (overlays.length === 0) return;

    const applyWheelMutation = () => {
      // Snapshot pre-mutation world position + visible anchor for light reattach.
      const snap = overlays.map((o) => {
        const def = state.propCatalog?.props[o.type];
        return {
          overlay: o,
          propDef: def,
          oldVisible: visibleAnchorOf(o, def, gs),
          oldX: o.x,
          oldY: o.y,
        };
      });
      if (overlays.length === 1) {
        // Single prop: simple rotation/scale
        if (event.shiftKey) {
          const step = deltaY > 0 ? -0.1 : 0.1;
          overlays[0]!.scale = Math.max(0.25, Math.min(4.0, overlays[0]!.scale + step));
          overlays[0]!.scale = Math.round(overlays[0]!.scale * 100) / 100;
        } else {
          const step = deltaY > 0 ? 15 : -15;
          overlays[0]!.rotation = ((((overlays[0]!.rotation || 0) + step) % 360) + 360) % 360;
        }
      } else {
        // Multi-prop: pivot around group center
        // Compute group center in world-feet
        let cx = 0,
          cy = 0;
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
            const newScale = Math.max(0.25, Math.min(4.0, o.scale + step));
            const scaleFactor = newScale / o.scale;
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
            o.rotation = ((((o.rotation || 0) + step) % 360) + 360) % 360;
          }
        }
      }
      // Reattach any linked lights and translate them by each prop's world delta.
      for (const s of snap) {
        refreshLinkedLights(meta, s.overlay, s.propDef, s.oldVisible, s.overlay.x - s.oldX, s.overlay.y - s.oldY);
      }
    };

    if (needsUndo) {
      mutate('Transform prop', [], applyWheelMutation, { metaOnly: true, invalidate: ['lighting:props', 'props'] });
    } else {
      // Subsequent ticks in a burst — mutate directly, no new undo entry
      applyWheelMutation();
      markPropSpatialDirty();
      invalidateLightmap('props');
      markDirty();
      notify();
    }

    // Update anchors to match new positions
    state.selectedPropAnchors = overlays.map((o) => ({
      row: Math.round(o.y / gs),
      col: Math.round(o.x / gs),
      propId: o.id,
    }));

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

  onRightClick(row: number, col: number, _edge: EdgeInfo | null, _event: MouseEvent, pos: CanvasPos | null = null) {
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

    // When a stamp is armed, right-click clears it (mirrors Escape) instead of deleting a prop.
    if (state.selectedProp) {
      state.selectedProp = null;
      state.propRotation = 0;
      state.propScale = 1.0;
      notify();
      requestRender();
      return;
    }

    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length ?? 0)) return;

    // Prefer pixel-based hit test so stacked props pick the top-most under the cursor.
    // Why: cell-based lookups (lookupPropAt) return an arbitrary prop covering the cell,
    // which for overlapping props is usually the bottom-most in visual z-order.
    const transform = getTransform();
    const gridSize = state.dungeon.metadata.gridSize || 5;
    const anchor = pos ? _hitTestProps(pos, transform, gridSize) : findPropAnchor(cells, row, col);
    if (!anchor) return;

    // Resolve the overlay by id when the pixel hit test gave us one — falling back to
    // cell lookup would re-introduce the stacked-prop ambiguity we just resolved.
    const propId = (anchor as { propId?: number | string }).propId;
    const meta = state.dungeon.metadata;
    const overlay =
      propId !== undefined
        ? (meta.props?.find((p: { id: string | number }) => p.id === propId) ?? null)
        : _findOverlayAt(anchor.row, anchor.col);
    if (!overlay) return;

    const anchorToDelete = anchor;
    mutate(
      'Delete prop',
      [],
      () => {
        if (propId !== undefined) _removeOverlayById(propId);
        else _removeOverlayAt(anchorToDelete.row, anchorToDelete.col);
      },
      { metaOnly: true, invalidate: ['lighting:props', 'props'] },
    );

    // Remove from selection if it was selected
    state.selectedPropAnchors = state.selectedPropAnchors.filter(
      (a: { row: number; col: number }) => a.row !== anchorToDelete.row || a.col !== anchorToDelete.col,
    );

    requestRender();
  }

  // ── Overlay ──────────────────────────────────────────────────────────────

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
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
        const propDef = catalog?.props[prop.type];
        if (!propDef) continue;
        const rot = prop.rotation;
        const scl = prop.scale;
        const flipped = prop.flipped;
        const needsTransform = scl !== 1.0 || (rot !== 0 && rot !== 90 && rot !== 180 && rot !== 270);

        ctx.save();
        ctx.globalAlpha = 0.45;
        if (needsTransform) {
          const [fRows, fCols] = propDef.footprint;
          const centerNx = fCols / 2,
            centerNy = fRows / 2;
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

        // Rotated outline around the ghost — matches the rendered prop orientation.
        const ghostOverlay = {
          x: col * gridSize,
          y: row * gridSize,
          type: prop.type,
          rotation: rot,
          scale: scl,
        };
        const { corners } = _propSelectionShape(ghostOverlay, gridSize, transform);
        ctx.save();
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 2;
        _strokeShape(ctx, corners);
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
        // Compute ghost position (visible anchor cell), including freeform sub-cell offset
        let row, col;
        const snapToGrid = this.dragSnapToGrid;
        const fox = snapToGrid ? 0 : item.freeOffsetX || 0;
        const foy = snapToGrid ? 0 : item.freeOffsetY || 0;
        if (isFreeformGhost) {
          const gs = gridSize;
          row = (this.dragGhost.worldY! + item.offsetRow * gs) / gs;
          col = (this.dragGhost.worldX! + item.offsetCol * gs) / gs;
        } else {
          row = this.dragGhost.row + item.offsetRow + foy;
          col = this.dragGhost.col + item.offsetCol + fox;
        }
        const scl = item.scale;
        const needsTransform = scl !== 1.0 || item.facing !== 0;

        // Shift the render anchor so the visible ghost lands on the target
        // (visible-anchor) cell, matching how _addOverlayAt stores the final prop.
        const [fRowsGhost, fColsGhost] = item.propDef!.footprint;
        const rGhost = ((item.facing % 360) + 360) % 360;
        const isR90Ghost = rGhost === 90 || rGhost === 270;
        const eRowsGhost = isR90Ghost ? fColsGhost : fRowsGhost;
        const eColsGhost = isR90Ghost ? fRowsGhost : fColsGhost;
        const renderRow = row - (fRowsGhost - eRowsGhost) / 2;
        const renderCol = col - (fColsGhost - eColsGhost) / 2;

        ctx.save();
        ctx.globalAlpha = 0.4;
        if (needsTransform) {
          // Use canvas transform for scaled/arbitrary-rotated props
          const centerNx = fColsGhost / 2;
          const centerNy = fRowsGhost / 2;
          const { x: cx, y: cy } = toCanvas(
            (renderCol + centerNx) * gridSize,
            (renderRow + centerNy) * gridSize,
            transform,
          );
          ctx.translate(cx, cy);
          ctx.rotate((-item.facing * Math.PI) / 180);
          ctx.scale(scl, scl);
          const cellPx = gridSize * transform.scale;
          const offsetTransform = {
            scale: transform.scale,
            offsetX: -centerNx * cellPx,
            offsetY: -centerNy * cellPx,
          };
          renderProp(ctx, item.propDef!, 0, 0, 0, gridSize, theme, offsetTransform, item.flipped, getTextureResolver());
        } else {
          renderProp(
            ctx,
            item.propDef!,
            renderRow,
            renderCol,
            item.facing,
            gridSize,
            theme,
            transform,
            item.flipped,
            getTextureResolver(),
          );
        }
        ctx.restore();

        // Bounding box around the ghost — rotated + scaled to match the rendered prop.
        const ghostOverlay = {
          x: renderCol * gridSize,
          y: renderRow * gridSize,
          type: item.origType,
          rotation: item.facing,
          scale: scl,
        };
        const { corners, bbox } = _propSelectionShape(ghostOverlay, gridSize, transform);
        ctx.save();
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 2;
        _strokeShape(ctx, corners);
        ctx.restore();

        // Draw name label only for the lead prop
        if (item.offsetRow === 0 && item.offsetCol === 0) {
          const name = (item.propDef?.name ?? item.origType) || '';
          if (name) {
            let label = name + ` ${item.facing}°`;
            if (scl !== 1.0) label += ` ${Math.round(scl * 100)}%`;
            if (item.zIndex !== 10) label += ` z${item.zIndex}`;
            this._drawNameLabel(ctx, label, bbox.topLeft, bbox.bottomRight);
          }
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
    if (
      !this.isDragging &&
      !this.isBoxSelecting &&
      !this.hoveredAnchor &&
      this.hoverRow != null &&
      this.hoverCol != null &&
      state.selectedProp
    ) {
      const catalog = state.propCatalog;
      const prevDef = catalog?.props[state.selectedProp];
      if (prevDef) {
        if (this.hoverFreeform && this.hoverWorldX != null) {
          // Freeform: ghost follows exact cursor position (sub-cell).
          // Pass the visible top-left (effective span) — _renderPlacePreview
          // shifts to the data anchor internally.
          const [spanRowsFree, spanColsFree] = getEffectiveFootprint(prevDef, state.propRotation);
          const freeRow = this.hoverWorldY! / gridSize - spanRowsFree / 2;
          const freeCol = this.hoverWorldX / gridSize - spanColsFree / 2;
          this._renderPlacePreview(ctx, transform, gridSize, freeRow, freeCol);
        } else {
          const anchor = centeredAnchor(this.hoverRow, this.hoverCol, prevDef, state.propRotation);
          this._renderPlacePreview(ctx, transform, gridSize, anchor.row, anchor.col);
        }
      }
    }

    // 4. Hover highlight — thin dashed outline on the prop under the cursor
    if (this.hoveredAnchor && !this.isDragging) {
      const meta = state.dungeon.metadata;
      const hoverOverlay = this.hoveredAnchor.propId
        ? meta.props?.find((p: { id: string | number }) => p.id === this.hoveredAnchor!.propId)
        : _findOverlayAt(this.hoveredAnchor.row, this.hoveredAnchor.col);
      if (hoverOverlay) {
        const { corners } = _propSelectionShape(hoverOverlay, gridSize, transform);
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(100, 200, 255, 0.6)';
        ctx.lineWidth = 1.5;
        _strokeShape(ctx, corners);
        ctx.restore();
      }
    }

    // 5. Selection highlights
    for (const anchor of state.selectedPropAnchors) {
      // Use propId if available (from box-select), else fall back to spatial lookup
      const meta = state.dungeon.metadata;
      const selOverlay = anchor.propId
        ? meta.props?.find((p: { id: string | number }) => p.id === anchor.propId)
        : _findOverlayAt(anchor.row, anchor.col);
      if (!selOverlay) continue;
      const { corners, bbox } = _propSelectionShape(selOverlay, gridSize, transform);

      ctx.save();
      ctx.strokeStyle = 'rgba(100, 180, 255, 0.8)';
      ctx.lineWidth = 2;
      _strokeShape(ctx, corners);
      ctx.restore();

      const propDef = state.propCatalog?.props[selOverlay.type];
      const rot = selOverlay.rotation;
      const selScale = selOverlay.scale;
      const selZ = selOverlay.zIndex;
      let label = (propDef?.name ?? selOverlay.type) + ` ${rot}°`;
      if (selScale !== 1.0) label += ` ${Math.round(selScale * 100)}%`;
      if (selZ !== 10) label += ` z${selZ}`;
      this._drawNameLabel(ctx, label, bbox.topLeft, bbox.bottomRight);
    }
  }

  // ── Place ────────────────────────────────────────────────────────────────

  _placeAtCell(row: number, col: number, pixelPos: CanvasPos | null = null, freeform = false) {
    if (!state.selectedProp) return;
    const catalog = state.propCatalog;
    if (!catalog?.props[state.selectedProp]) return;

    const propDef = catalog.props[state.selectedProp]!;
    const [spanRows, spanCols] = getEffectiveFootprint(propDef, state.propRotation);
    const cells = state.dungeon.cells;

    if (!isFootprintClear(cells, row, col, spanRows, spanCols)) {
      // Distinguish out-of-bounds from void-cell so the user knows what's wrong.
      const numRows = cells.length;
      const numCols = cells[0]?.length ?? 0;
      const outOfBounds = row < 0 || row + spanRows > numRows || col < 0 || col + spanCols > numCols;
      this._toastOnce(
        outOfBounds ? 'out-of-bounds' : 'void',
        outOfBounds
          ? `Can't place ${propDef.name}: outside the map`
          : `Can't place ${propDef.name}: cell is void — paint floor first`,
      );
      return;
    }

    mutate(
      'Place prop',
      [],
      () => {
        const entry = _addOverlayAt(row, col, state.selectedProp!, state.propRotation, state.propFlipped || false);
        if (state.propScale !== 1.0) entry.scale = state.propScale;

        // Freeform: Ctrl+click places at exact pixel position (sub-cell),
        // centering the prop on the cursor (matching the ghost preview).
        // Use base-footprint center to match the renderer's Option A rotation pivot,
        // so non-square props at 90°/270° visually center on the cursor.
        if (freeform && pixelPos) {
          const transform = getTransform();
          const gs = state.dungeon.metadata.gridSize || 5;
          const [fRowsFree, fColsFree] = propDef.footprint;
          const cursorWorldX = (pixelPos.x - transform.offsetX) / transform.scale;
          const cursorWorldY = (pixelPos.y - transform.offsetY) / transform.scale;
          entry.x = cursorWorldX - (fColsFree * gs) / 2;
          entry.y = cursorWorldY - (fRowsFree * gs) / 2;
        }

        // Create linked lights if the prop defines any
        if (propDef.lights?.length) {
          const meta = state.dungeon.metadata;
          if (!meta.nextLightId) meta.nextLightId = 1;
          const gridSize = meta.gridSize || 5;
          const lightCatalog = getLightCatalog();
          const [origRows, origCols] = propDef.footprint;

          for (const lightDef of propDef.lights) {
            // Start from normalized footprint coords (unrotated)
            let nx = lightDef.x;
            let ny = lightDef.y;

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
            const preset = lightCatalog?.lights[lightDef.preset] ?? ({} as Partial<LightPreset>);
            const light: Light = {
              id: meta.nextLightId++,
              x: worldX,
              y: worldY,
              type: preset.type ?? 'point',
              radius: lightDef.radius ?? preset.radius ?? 20,
              color: lightDef.color ?? preset.color ?? '#ff9944',
              intensity: lightDef.intensity ?? preset.intensity ?? 1.0,
              falloff: lightDef.falloff ?? preset.falloff ?? 'smooth',
              presetId: lightDef.preset,
              propRef: { row, col },
            };
            const dim = lightDef.dimRadius ?? preset.dimRadius;
            if (dim) light.dimRadius = dim;
            if (lightDef.angle != null) light.angle = lightDef.angle;
            if (lightDef.spread != null) light.spread = lightDef.spread;
            if (preset.animation?.type) light.animation = { ...preset.animation };

            meta.lights.push(light);
          }
        }
      },
      { metaOnly: true, invalidate: ['lighting:props', 'props'] },
    );

    requestRender();
  }

  _renderPlacePreview(
    ctx: CanvasRenderingContext2D,
    transform: RenderTransform,
    gridSize: number,
    row: number,
    col: number,
  ) {
    const catalog = state.propCatalog;
    if (!state.selectedProp || !catalog?.props[state.selectedProp]) return;

    const propDef = catalog.props[state.selectedProp]!;
    const rot = state.propRotation;
    const scl = state.propScale;
    const [spanRows, spanCols] = getEffectiveFootprint(propDef, rot);
    const cells = state.dungeon.cells;
    const valid = isFootprintClear(cells, Math.floor(row), Math.floor(col), spanRows, spanCols);
    const theme = getTheme();
    const needsTransform = scl !== 1.0 || rot !== 0;

    // Callers pass the visible top-left cell; shift to the data anchor so the
    // Option A render (which rotates around base-center) lands on the target.
    const [fRowsPrev, fColsPrev] = propDef.footprint;
    const rPrev = ((rot % 360) + 360) % 360;
    const isR90Prev = rPrev === 90 || rPrev === 270;
    const eRowsPrev = isR90Prev ? fColsPrev : fRowsPrev;
    const eColsPrev = isR90Prev ? fRowsPrev : fColsPrev;
    const renderRow = row - (fRowsPrev - eRowsPrev) / 2;
    const renderCol = col - (fColsPrev - eColsPrev) / 2;

    ctx.save();
    ctx.globalAlpha = 0.4;
    if (needsTransform) {
      const centerNx = fColsPrev / 2,
        centerNy = fRowsPrev / 2;
      const { x: cx, y: cy } = toCanvas(
        (renderCol + centerNx) * gridSize,
        (renderRow + centerNy) * gridSize,
        transform,
      );
      ctx.translate(cx, cy);
      ctx.rotate((-rot * Math.PI) / 180);
      ctx.scale(scl, scl);
      const cellPx = gridSize * transform.scale;
      const offsetTransform = { scale: transform.scale, offsetX: -centerNx * cellPx, offsetY: -centerNy * cellPx };
      renderProp(ctx, propDef, 0, 0, 0, gridSize, theme, offsetTransform, state.propFlipped, getTextureResolver());
    } else {
      renderProp(
        ctx,
        propDef,
        renderRow,
        renderCol,
        rot,
        gridSize,
        theme,
        transform,
        state.propFlipped,
        getTextureResolver(),
      );
    }
    ctx.restore();

    const w = spanCols * gridSize,
      h = spanRows * gridSize;
    // Center on the visible-anchor (span-based) so the box hugs the cell-aligned ghost.
    const bCx = (col + spanCols / 2) * gridSize,
      bCy = (row + spanRows / 2) * gridSize;
    const topLeft = toCanvas(bCx - (w * scl) / 2, bCy - (h * scl) / 2, transform);
    const bottomRight = toCanvas(bCx + (w * scl) / 2, bCy + (h * scl) / 2, transform);
    const borderColor = valid ? 'rgba(100, 255, 100, 0.5)' : 'rgba(255, 100, 100, 0.5)';
    ctx.save();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.restore();

    // Tooltip label
    const name = propDef.name || state.selectedProp;
    let label = name + ` ${rot}°`;
    if (scl !== 1.0) label += ` ${Math.round(scl * 100)}%`;
    this._drawNameLabel(ctx, label, topLeft, bottomRight);
  }

  // ── Select + Drag ────────────────────────────────────────────────────────

  _selectOnMouseDown(
    row: number,
    col: number,
    event: MouseEvent,
    pos: CanvasPos | null,
    propId: string | number | undefined,
  ) {
    const anchor = { row, col, propId };

    // Check if this prop is already in the selection (by ID or by position)
    const idx = state.selectedPropAnchors.findIndex(
      (a: { row: number; col: number; propId?: string | number }) =>
        (propId && a.propId === propId) ?? (a.row === row && a.col === col),
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
      this._pendingDragPos = pos ?? null;
    } else {
      // Clicking a prop not in the selection → select only this one, start pending drag
      state.selectedPropAnchors = [anchor];
      this._pendingDragAnchor = anchor;
      this._pendingDragPos = pos ?? null;
    }

    notify();
    requestRender();
  }

  _activateDrag(anchor: { row: number; col: number; propId?: string | number }) {
    // Move all selected props if the dragged anchor is in the selection,
    // otherwise just move the single prop that was clicked.
    const anchorsToMove = state.selectedPropAnchors.some(
      (a: { row: number; col: number; propId?: string | number }) =>
        (anchor.propId && a.propId === anchor.propId) ?? (a.row === anchor.row && a.col === anchor.col),
    )
      ? state.selectedPropAnchors
      : [anchor];

    const meta = state.dungeon.metadata;
    const gs = meta.gridSize || 5;
    const items = [];
    for (const a of anchorsToMove) {
      // Use propId when available (from box-select), else spatial lookup
      const overlay = a.propId
        ? meta.props?.find((p: { id: string | number }) => p.id === a.propId)
        : _findOverlayAt(a.row, a.col);
      if (!overlay) continue;
      const propDef = state.propCatalog?.props[overlay.type];
      if (!propDef) continue;
      // Un-shift the rotation-compensation offset so freeform/anchor math is
      // expressed in visible-anchor space (where the user sees the prop), not
      // data-anchor space (which is offset by (fCols-eCols)/2 at 90°/270°).
      const [fRowsI, fColsI] = propDef.footprint;
      const rI = ((overlay.rotation % 360) + 360) % 360;
      const isR90I = rI === 90 || rI === 270;
      const eRowsI = isR90I ? fColsI : fRowsI;
      const eColsI = isR90I ? fRowsI : fColsI;
      const visibleX = overlay.x + ((fColsI - eColsI) / 2) * gs;
      const visibleY = overlay.y + ((fRowsI - eRowsI) / 2) * gs;
      // Compute freeform sub-cell offset (in visible-anchor space)
      const freeOffsetX = (visibleX - Math.round(visibleX / gs) * gs) / gs;
      const freeOffsetY = (visibleY - Math.round(visibleY / gs) * gs) / gs;
      // Find linked lights (by propRef matching this prop's visible anchor)
      const anchorRow = Math.round(visibleY / gs);
      const anchorCol = Math.round(visibleX / gs);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const linkedLightIds = (meta.lights || [])
        .filter((l) => l.propRef?.row === anchorRow && l.propRef.col === anchorCol)
        .map((l) => l.id);
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
        scale: overlay.scale,
        zIndex: overlay.zIndex,
      });
    }
    if (items.length === 0) return;

    // Snapshot metadata BEFORE removing props — used by _finishDrag for undo
    this._preDragMetaSnapshot = JSON.stringify(state.dungeon.metadata);

    for (const item of items) {
      // Remove by ID for reliability
      if (meta.props) {
        const idx = meta.props.findIndex((p: { id: string | number }) => p.id === item.propId);
        if (idx >= 0) meta.props.splice(idx, 1);
      }
    }

    // Props removed from overlay — update spatial hash and prop shadows,
    // but keep cached wall segments (expensive) since walls haven't changed.
    markPropSpatialDirty();
    invalidateLightmap('props');

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
    const numCols = cells[0]?.length ?? 0;
    for (const item of this.dragItems) {
      const newRow = this.dragGhost!.row + item.offsetRow;
      const newCol = this.dragGhost!.col + item.offsetCol;
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
      const label = this.dragItems.length > 1 ? 'Move props' : 'Move prop';
      const preDragMeta = this._preDragMetaSnapshot!;
      const dragGhost = this.dragGhost;
      const dragItems = this.dragItems;
      const dragFreeform = this.dragFreeform;
      const dragSnapToGrid = this.dragSnapToGrid;
      let newAnchors: { row: number; col: number; propId: string | number }[] = [];
      mutate(
        label,
        [],
        () => {
          const meta = state.dungeon.metadata;
          const gs = meta.gridSize || 5;
          const ghost = dragGhost;
          const isFreeform = dragFreeform && ghost.worldX != null;
          const anchors: { row: number; col: number; propId: string | number }[] = [];
          for (const item of dragItems) {
            const newRow = ghost.row + item.offsetRow;
            const newCol = ghost.col + item.offsetCol;
            const entry = _addOverlayAt(newRow, newCol, item.origType, item.facing, item.flipped);
            entry.scale = item.scale;
            entry.zIndex = item.zIndex;
            if (isFreeform) {
              // Ctrl+drag: place at exact world-feet position
              entry.x = ghost.worldX! + item.offsetCol * gs;
              entry.y = ghost.worldY! + item.offsetRow * gs;
            } else if (!dragSnapToGrid && (item.freeOffsetX || item.freeOffsetY)) {
              // Preserve original freeform sub-cell offset (unless Shift = snap to grid)
              entry.x += (item.freeOffsetX || 0) * gs;
              entry.y += (item.freeOffsetY || 0) * gs;
            }
            anchors.push({ row: newRow, col: newCol, propId: entry.id });

            // Move linked lights by the same delta as the prop
            if (item.linkedLightIds.length > 0) {
              const dx = entry.x - item.origX;
              const dy = entry.y - item.origY;
              // propRef tracks the visible-anchor cell (un-shifted), not the stored data anchor
              const [fRowsL, fColsL] = item.propDef!.footprint;
              const rL = ((item.facing % 360) + 360) % 360;
              const isR90L = rL === 90 || rL === 270;
              const eRowsL = isR90L ? fColsL : fRowsL;
              const eColsL = isR90L ? fRowsL : fColsL;
              const newPropRefRow = Math.round(entry.y / gs + (fRowsL - eRowsL) / 2);
              const newPropRefCol = Math.round(entry.x / gs + (fColsL - eColsL) / 2);
              for (const lightId of item.linkedLightIds) {
                const light = meta.lights.find((l) => l.id === lightId);
                if (light) {
                  light.x += dx;
                  light.y += dy;
                  light.propRef = { row: newPropRefRow, col: newPropRefCol };
                }
              }
            }
          }
          newAnchors = anchors;
        },
        { metaOnly: true, invalidate: ['lighting:props', 'props'] },
      );
      // Lift removed the originals from meta.props before mutate ran, so the
      // captured before-state has them missing. Rewrite it to the pre-drag
      // snapshot so undo restores them at their original positions.
      const lastEntry = state.undoStack[state.undoStack.length - 1];
      if (lastEntry?.patch?.meta) lastEntry.patch.meta.before = preDragMeta;
      state.selectedPropAnchors = newAnchors;
    } else {
      this._restoreDragItems();
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
    if (this.isDragging) this._restoreDragItems();
    this.isDragging = false;
    this.dragFreeform = false;
    this.dragItems = [];
    this.dragLeadAnchor = null;
    this.dragGhost = null;
    setCursor('crosshair');
    requestRender();
  }

  /** Re-insert dragged props at their original positions (no undo deserialize). */
  _restoreDragItems() {
    const restoredAnchors = [];
    for (const item of this.dragItems) {
      const entry = _addOverlayAt(item.anchor.row, item.anchor.col, item.origType, item.facing, item.flipped);
      entry.scale = item.scale;
      entry.zIndex = item.zIndex;
      // Restore exact original world-feet position
      entry.x = item.origX;
      entry.y = item.origY;
      restoredAnchors.push({ row: item.anchor.row, col: item.anchor.col, propId: entry.id });
    }
    state.selectedPropAnchors = restoredAnchors;
    markPropSpatialDirty();
    invalidateLightmap('props');
    notify();
  }

  // ── Key Handlers ────────────────────────────────────────────────────────

  _handleRotate(degrees: number) {
    if (state.selectedPropAnchors.length > 1) {
      this._rotateSelectedGroup(degrees);
      return;
    }
    if (state.selectedPropAnchors.length === 1) {
      const anchor = state.selectedPropAnchors[0]!;
      const meta = state.dungeon.metadata;
      const gs = meta.gridSize || 5;
      mutate(
        'Rotate prop',
        [],
        () => {
          const overlay = anchor.propId
            ? meta.props?.find((p: { id: string | number }) => p.id === anchor.propId)
            : _findOverlayAt(anchor.row, anchor.col);
          if (overlay) {
            // Props are free-form overlays — no footprint validation needed for rotation
            const propDef = state.propCatalog?.props[overlay.type];
            const oldVisible = visibleAnchorOf(overlay, propDef, gs);
            overlay.rotation = ((((overlay.rotation || 0) + degrees) % 360) + 360) % 360;
            refreshLinkedLights(meta, overlay, propDef, oldVisible, 0, 0);
          }
        },
        { metaOnly: true, invalidate: ['lighting:props', 'props'] },
      );
      requestRender();
      return;
    }
    // No selection → rotate placement default
    state.propRotation = (((state.propRotation + degrees) % 360) + 360) % 360;
    notify();
    requestRender();
  }

  _handleFlip() {
    if (state.selectedPropAnchors.length > 1) {
      this._flipSelectedGroup();
      return;
    }
    if (state.selectedPropAnchors.length === 1) {
      const anchor = state.selectedPropAnchors[0]!;
      const meta = state.dungeon.metadata;
      mutate(
        'Flip prop',
        [],
        () => {
          const overlay = anchor.propId
            ? meta.props?.find((p: { id: string | number }) => p.id === anchor.propId)
            : _findOverlayAt(anchor.row, anchor.col);
          if (overlay) {
            overlay.flipped = !overlay.flipped;
          }
        },
        { metaOnly: true, invalidate: ['lighting:props', 'props'] },
      );
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
      this.dragItems[0]!.facing = (((this.dragItems[0]!.facing + degrees) % 360) + 360) % 360;
      return;
    }

    // Compute bounding box of all items in absolute grid space
    let r_min = Infinity,
      c_min = Infinity,
      r_max = -Infinity,
      c_max = -Infinity;
    for (const item of this.dragItems) {
      const [spanRows, spanCols] = getEffectiveFootprint(item.propDef!, item.facing);
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
      const [spanRows, spanCols] = getEffectiveFootprint(item.propDef!, item.facing);
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
      item.facing = (((item.facing + degrees) % 360) + 360) % 360;
    }
  }

  // Flip all dragItems horizontally as a group, updating col offsets and flipped flags
  _flipDragGroup() {
    if (!this.dragGhost || this.dragItems.length === 0) return;
    if (this.dragItems.length === 1) {
      this.dragItems[0]!.flipped = !this.dragItems[0]!.flipped;
      return;
    }

    let c_min = Infinity,
      c_max = -Infinity;
    for (const item of this.dragItems) {
      const [, spanCols] = getEffectiveFootprint(item.propDef!, item.facing);
      const absCol = this.dragGhost.col + item.offsetCol;
      c_min = Math.min(c_min, absCol);
      c_max = Math.max(c_max, absCol + spanCols);
    }
    const W = c_max - c_min;

    for (const item of this.dragItems) {
      const [, spanCols] = getEffectiveFootprint(item.propDef!, item.facing);
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
    const overlays: OverlayProp[] = [];
    for (const a of state.selectedPropAnchors) {
      const o = a.propId
        ? meta.props?.find((p: { id: string | number }) => p.id === a.propId)
        : _findOverlayAt(a.row, a.col);
      if (o) overlays.push(o);
    }
    if (overlays.length === 0) return;

    // Compute group center in world-feet
    let cx = 0,
      cy = 0;
    for (const o of overlays) {
      const [sr, sc] = _overlaySpan(o);
      cx += o.x + (sc * gs) / 2;
      cy += o.y + (sr * gs) / 2;
    }
    cx /= overlays.length;
    cy /= overlays.length;

    mutate(
      'Rotate props',
      [],
      () => {
        const groupMeta = state.dungeon.metadata;
        const snap = overlays.map((o) => {
          const def = state.propCatalog?.props[o.type];
          return { overlay: o, propDef: def, oldVisible: visibleAnchorOf(o, def, gs), oldX: o.x, oldY: o.y };
        });
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
          o.rotation = ((((o.rotation || 0) + degrees) % 360) + 360) % 360;
        }
        for (const s of snap) {
          refreshLinkedLights(
            groupMeta,
            s.overlay,
            s.propDef,
            s.oldVisible,
            s.overlay.x - s.oldX,
            s.overlay.y - s.oldY,
          );
        }
      },
      { metaOnly: true, invalidate: ['lighting:props', 'props'] },
    );

    // Update selection anchors
    state.selectedPropAnchors = overlays.map((o) => ({
      row: Math.round(o.y / gs),
      col: Math.round(o.x / gs),
      propId: o.id,
    }));
    requestRender();
  }

  // Flip selected props horizontally as a spatial group
  _flipSelectedGroup() {
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length ?? 0;

    const items = [];
    let c_min = Infinity,
      c_max = -Infinity;
    const flipMeta = state.dungeon.metadata;
    for (const anchor of state.selectedPropAnchors) {
      const overlay = anchor.propId
        ? flipMeta.props?.find((p: { id: string | number }) => p.id === anchor.propId)
        : _findOverlayAt(anchor.row, anchor.col);
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
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) {
            this._toastOnce('flip-blocked', "Can't flip: some props would land outside the map");
            return;
          }
          if (cells[r]![c] === null) {
            this._toastOnce('flip-blocked', "Can't flip: some props would land on void cells");
            return;
          }
          const key = `${r},${c}`;
          if (claimed.has(key)) {
            this._toastOnce('flip-blocked', "Can't flip: selection would overlap itself after mirror");
            return;
          }
          const existing = findPropAnchor(cells, r, c);
          if (existing && !oldKeys.has(`${existing.row},${existing.col}`)) {
            this._toastOnce('flip-blocked', "Can't flip: target cells already hold another prop");
            return;
          }
          claimed.add(key);
        }
      }
    }

    let newAnchors: { row: number; col: number }[] = [];
    mutate(
      'Flip props',
      [],
      () => {
        for (const { oldAnchor } of placements) {
          _removeOverlayAt(oldAnchor.row, oldAnchor.col);
        }
        const anchors: { row: number; col: number }[] = [];
        for (const p of placements) {
          _addOverlayAt(p.newRow, p.newCol, p.type, p.newFacing, p.flipped);
          anchors.push({ row: p.newRow, col: p.newCol });
        }
        newAnchors = anchors;
      },
      { metaOnly: true, invalidate: ['lighting:props', 'props'] },
    );
    state.selectedPropAnchors = newAnchors;
    requestRender();
  }

  _deleteSelected() {
    if (state.selectedPropAnchors.length === 0) return;

    const anchorsToDelete = [...state.selectedPropAnchors];
    mutate(
      'Delete prop',
      [],
      () => {
        for (const anchor of anchorsToDelete) {
          // Use propId when available to avoid deleting an overlapping prop on top
          if (anchor.propId != null) {
            _removeOverlayById(anchor.propId);
          } else {
            _removeOverlayAt(anchor.row, anchor.col);
          }
        }
      },
      { metaOnly: true, invalidate: ['lighting:props', 'props'] },
    );

    state.selectedPropAnchors = [];
    requestRender();
  }

  // ── Prop Copy/Paste ──────────────────────────────────────────────────────

  /** Rotate every prop in the paste clipboard by `degrees` (in place, no undo). */
  _rotatePasteClipboard(degrees: number) {
    if (!state.propClipboard) return;
    for (const entry of state.propClipboard.props) {
      entry.prop.rotation = ((((entry.prop.rotation || 0) + degrees) % 360) + 360) % 360;
    }
    requestRender();
  }

  /** Flip every prop in the paste clipboard (in place, no undo). */
  _flipPasteClipboard() {
    if (!state.propClipboard) return;
    for (const entry of state.propClipboard.props) {
      entry.prop.flipped = !entry.prop.flipped;
    }
    requestRender();
  }

  /** Bump zIndex of every prop in the paste clipboard by `step` (floored at 0). */
  _adjustPasteZ(step: number) {
    if (!state.propClipboard) return;
    for (const entry of state.propClipboard.props) {
      entry.prop.zIndex = Math.max(0, entry.prop.zIndex + step);
    }
    requestRender();
  }

  _allPastePositionsValid(targetRow: number, targetCol: number) {
    if (!state.propClipboard) return false;
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length ?? 0;
    const { props } = state.propClipboard;
    const catalog = state.propCatalog;

    for (const { dRow, dCol, prop } of props) {
      const row = targetRow + dRow;
      const col = targetCol + dCol;
      // Compute span from catalog + rotation (overlay props don't have span)
      const propDef = catalog?.props[prop.type];
      const [spanRows, spanCols] = propDef ? getEffectiveFootprint(propDef, prop.rotation) : [1, 1];

      for (let r = row; r < row + spanRows; r++) {
        for (let c = col; c < col + spanCols; c++) {
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
          if (cells[r]![c] === null) return false;
        }
      }
    }
    return true;
  }

  _commitPropPaste(targetRow: number, targetCol: number) {
    if (!state.propClipboard) return;
    if (!this._allPastePositionsValid(targetRow, targetCol)) {
      this._toastOnce('paste-blocked', "Can't paste here: some props overlap void cells or the map edge");
      return;
    }

    const cells = state.dungeon.cells;
    const { props } = state.propClipboard;

    let newAnchors: { row: number; col: number }[] = [];
    let lightsCreated = 0;
    mutate(
      'Paste props',
      [],
      () => {
        // Remove any existing props at paste anchor positions
        for (const { dRow, dCol } of props) {
          const r = targetRow + dRow,
            c = targetCol + dCol;
          _removeOverlayAt(r, c);
        }

        // Place pasted props (and their associated lights)
        const meta = state.dungeon.metadata;
        const gs = meta.gridSize || 5;
        if (!meta.nextLightId) meta.nextLightId = 1;
        const anchors: { row: number; col: number }[] = [];
        for (const { dRow, dCol, prop, lights } of props) {
          const row = targetRow + dRow;
          const col = targetCol + dCol;
          const cell = cells[row]?.[col];
          if (!cell) continue;
          const rotation = (prop.facing ?? prop.rotation) || 0;
          const entry = _addOverlayAt(row, col, prop.type, rotation, prop.flipped);
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (prop.scale != null) entry.scale = prop.scale;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (prop.zIndex != null) entry.zIndex = prop.zIndex;
          // `_addOverlayAt` already applied the 90°/270° anchor-shift correctly
          // for the target (row, col). We only need to carry over the source
          // prop's freeform sub-cell offset (if any) as an additive delta — NOT
          // overwrite entry.x/y, which would discard the rotation shift.
          const propDef = state.propCatalog?.props[prop.type];
          if (propDef) {
            const [fRows, fCols] = propDef.footprint;
            const r = ((rotation % 360) + 360) % 360;
            const isR90 = r === 90 || r === 270;
            const eRows = isR90 ? fCols : fRows;
            const eCols = isR90 ? fRows : fCols;
            const shiftX = ((fCols - eCols) / 2) * gs;
            const shiftY = ((fRows - eRows) / 2) * gs;
            const visX = prop.x + shiftX;
            const visY = prop.y + shiftY;
            const subOffsetX = visX - Math.round(visX / gs) * gs;
            const subOffsetY = visY - Math.round(visY / gs) * gs;
            if (Math.abs(subOffsetX) > 0.01 || Math.abs(subOffsetY) > 0.01) {
              entry.x += subOffsetX;
              entry.y += subOffsetY;
            }
          }
          anchors.push({ row, col });

          // Create associated lights at the pasted prop's new position
          if (lights?.length) {
            const newPropRefRow = Math.round(entry.y / gs);
            const newPropRefCol = Math.round(entry.x / gs);
            for (const light of lights) {
              const newLight: Light = {
                id: meta.nextLightId++,
                x: entry.x + (light._offsetX ?? 0),
                y: entry.y + (light._offsetY ?? 0),
                type: (light.type ?? 'point') as Light['type'],
                radius: light.radius as number,
                color: (light.color as string) || '#ff9944',
                intensity: light.intensity as number,
                falloff: (light.falloff ?? 'smooth') as Light['falloff'],
                propRef: { row: newPropRefRow, col: newPropRefCol },
              };
              if (light.presetId) newLight.presetId = light.presetId as string;
              if (light.dimRadius) newLight.dimRadius = light.dimRadius as number;
              if (light.animation)
                newLight.animation =
                  typeof light.animation === 'string' ? JSON.parse(light.animation) : { ...light.animation };
              meta.lights.push(newLight);
              lightsCreated++;
            }
          }
        }
        newAnchors = anchors;
      },
      { metaOnly: true, invalidate: ['lighting:props', 'props'] },
    );

    state.selectedPropAnchors = newAnchors;
    state.propPasteMode = false;
    this.pasteHover = null;
    requestRender();
    const lightMsg = lightsCreated > 0 ? ` with ${lightsCreated} light${lightsCreated === 1 ? '' : 's'}` : '';
    showToast(`Pasted ${newAnchors.length} prop${newAnchors.length === 1 ? '' : 's'}${lightMsg}`);
  }

  _drawNameLabel(
    ctx: CanvasRenderingContext2D,
    name: string,
    topLeft: { x: number; y: number },
    bottomRight: { x: number; y: number },
  ) {
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
