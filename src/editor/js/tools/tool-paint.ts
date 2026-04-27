import type { CellGrid, RenderTransform } from '../../../types.js';
// Paint tool: click+drag to box-select a rectangle, then apply fill/texture/room on mouseup.
// Shift+click in texture mode: flood-fill the entire connected room.
// Shift+click in clear-texture mode: flood-clear an entire room's textures.
// Shift+drag in room mode: constrain selection to a square.
// Syringe mode: click to pick up a cell's texture, then auto-switch to texture paint.
import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { mutate, getTheme } from '../state.js';
import { setCursor, getTransform, requestRender } from '../canvas-view.js';
import { toCanvas } from '../utils.js';
import { selectTexture } from '../panels/index.js';
import { loadTextureImages } from '../texture-catalog.js';
import { invalidateBlendLayerCache, accumulateDirtyRect, patchBlendForDirtyRegion } from '../../../render/index.js';
import {
  cellKey,
  isInBounds,
  normalizeBounds,
  snapToSquare,
  traverse,
  getSegments,
  getSegmentIndexAt,
  writeSegmentTexture,
} from '../../../util/index.js';

// SVG paint bucket cursor — hotspot at the drip tip (bottom-left of bucket)
const BUCKET_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='white' stroke='%23333' stroke-width='1.2' d='M16.56 8.94L7.62 0 6.21 1.41l2.38 2.38-5.15 5.15a1.49 1.49 0 0 0 0 2.12l5.5 5.5c.29.29.68.44 1.06.44s.77-.15 1.06-.44l5.5-5.5c.59-.58.59-1.53 0-2.12zM5.21 10L10 5.21 14.79 10H5.21zM19 11.5s-2 2.17-2 3.5c0 1.1.9 2 2 2s2-.9 2-2c0-1.33-2-3.5-2-3.5z'/%3E%3C/svg%3E") 2 22, crosshair`;

// SVG eyedropper/syringe cursor — hotspot at the tip (bottom-left)
/** SVG eyedropper/syringe cursor data URL with bottom-left hotspot. */
export const SYRINGE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='white' stroke='%23333' stroke-width='1.2' d='M20.71 5.63l-2.34-2.34a1 1 0 0 0-1.41 0l-3.54 3.54 1.41 1.41L13.41 9.66l-5.66 5.66-1.41-1.41-1.41 1.41 1.41 1.41L4.59 18.5 3 20.08 3.92 21l1.5-1.59 1.76-1.76 1.41 1.41 1.41-1.41-1.41-1.41 5.66-5.66 1.41 1.41 1.42-1.42-1.42-1.41 3.54-3.54a1 1 0 0 0 0-1.41z'/%3E%3C/svg%3E") 1 23, crosshair`;

/** Incrementally patch blend edges/corners for a dirty region instead of full rebuild. */
function _patchBlend(region: { minRow: number; maxRow: number; minCol: number; maxCol: number }): void {
  const theme = getTheme();
  const textureOptions = state.textureCatalog
    ? {
        catalog: state.textureCatalog,
        blendWidth: theme.textureBlendWidth ?? 0.35,
        texturesVersion: state.texturesVersion,
      }
    : null;
  if (textureOptions) {
    patchBlendForDirtyRegion(region, state.dungeon.cells, state.dungeon.metadata.gridSize || 5, textureOptions);
  }
}

// ── Half-cell texture helpers ─────────────────────────────────────────────────

/** Normalized (0..1) mouse position within the cell (row, col). */
function getRelPos(event: MouseEvent, row: number, col: number) {
  const t = getTransform();
  const gs = state.dungeon.metadata.gridSize;
  const worldX = (event.offsetX - t.offsetX) / t.scale;
  const worldY = (event.offsetY - t.offsetY) / t.scale;
  return {
    relX: (worldX - col * gs) / gs,
    relY: (worldY - row * gs) / gs,
  };
}

/**
 * Texture flood-fill BFS via the unified `traverse()` segment graph.
 *
 * Returns `(filledCells, toFill)` where `toFill` entries are
 * `[row, col, segmentIndex]`. Arc cells are visited naturally — each
 * (interior, exterior) segment is its own graph node, so the BFS reaches
 * exactly the segments on the user's side of the chord and no others.
 */
function paintFloodBFS(
  cells: CellGrid,
  startRow: number,
  startCol: number,
  startRelX: number,
  startRelY: number,
): {
  filledCells: Set<string>;
  toFill: [number, number, number][];
} {
  const filledCells = new Set<string>();
  const toFill: [number, number, number][] = [];
  const startCell = cells[startRow]?.[startCol];
  if (!startCell) return { filledCells, toFill };

  const startSegmentIndex = getSegmentIndexAt(startCell, startRelX, startRelY);

  traverse(
    cells,
    {
      row: startRow,
      col: startCol,
      segmentIndex: startSegmentIndex >= 0 ? startSegmentIndex : 0,
    },
    {
      visit: (ctx) => {
        const fillKey = cellKey(ctx.row, ctx.col);
        // First-segment-wins: a cell with multiple segments visited via
        // traverse contributes only one write. Diagonal/trim cells are
        // typically reached through a single segment (the chord wall blocks
        // the other), so this rarely matters in practice.
        if (filledCells.has(fillKey)) return;
        filledCells.add(fillKey);
        toFill.push([ctx.row, ctx.col, ctx.segmentIndex]);
      },
    },
  );

  // Legacy contract: even if traverse() returned no segments (e.g. start
  // segment is voided), the start cell is still included so the user's
  // click is acknowledged.
  if (filledCells.size === 0) {
    filledCells.add(cellKey(startRow, startCol));
    toFill.push([startRow, startCol, Math.max(0, startSegmentIndex)]);
  }

  return { filledCells, toFill };
}

/**
 * Paint tool: click+drag to box-select, then apply texture/room floor paint.
 * Supports flood-fill (shift+click), syringe/eyedropper, and clear-texture modes.
 */
export class PaintTool extends Tool {
  dragging: boolean = false;
  dragStart: { row: number; col: number } | null = null;
  dragEnd: { row: number; col: number } | null = null;
  declare mousePos: { x: number; y: number } | null;
  _onKeyDown!: (e: KeyboardEvent) => void;
  _onKeyUp!: (e: KeyboardEvent) => void;

  constructor() {
    super('paint', 'P', 'crosshair');
    this.dragging = false;
    this.dragStart = null; // {row, col}
    this.dragEnd = null; // {row, col}
    this.mousePos = null; // canvas pixel pos for size label

    // Bound listeners stored so they can be removed on deactivate
    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && state.paintMode !== 'syringe') {
        setCursor(SYRINGE_CURSOR);
      } else if (
        e.key === 'Shift' &&
        !e.altKey &&
        (state.paintMode === 'texture' || state.paintMode === 'clear-texture')
      ) {
        setCursor(BUCKET_CURSOR);
      }
    };
    this._onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        // Restore: if shift still held in texture mode show bucket, else normal cursor
        if (e.shiftKey && (state.paintMode === 'texture' || state.paintMode === 'clear-texture')) {
          setCursor(BUCKET_CURSOR);
        } else {
          setCursor(state.paintMode === 'syringe' ? SYRINGE_CURSOR : 'crosshair');
        }
      } else if (e.key === 'Shift') {
        // If alt is still held, keep showing syringe cursor
        if (e.altKey && state.paintMode !== 'syringe') {
          setCursor(SYRINGE_CURSOR);
        } else {
          setCursor(state.paintMode === 'syringe' ? SYRINGE_CURSOR : 'crosshair');
        }
      }
    };
  }

  getCursor() {
    return state.paintMode === 'syringe' ? SYRINGE_CURSOR : 'crosshair';
  }

  onActivate() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    if (state.paintMode === 'syringe') setCursor(SYRINGE_CURSOR);
    const statuses = {
      texture: 'Drag to paint texture · Shift+click to flood fill · Alt+click to sample · Right-click to clear',
      syringe: 'Click to sample texture from a cell · Switches to Texture mode',
      room: 'Drag to paint room floor color',
      'clear-texture': 'Drag to clear texture · Shift+click to flood clear',
    };
    state.statusInstruction = statuses[(state.paintMode || 'room') as keyof typeof statuses] || null;
  }

  onDeactivate() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    setCursor('crosshair'); // reset if shift was held when switching tools
    state.statusInstruction = null;
  }

  onMouseDown(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent) {
    // Alt+click: syringe pick regardless of current mode
    if (event.altKey) {
      this.syringePick(row, col, event);
      return;
    }
    // Shift+click: flood fill shortcuts (unchanged)
    if (event.shiftKey && state.paintMode === 'texture') {
      this.floodFill(row, col, event);
      return;
    }
    if (event.shiftKey && state.paintMode === 'clear-texture') {
      this.floodFillClear(row, col, event);
      return;
    }
    if (state.paintMode === 'syringe') {
      this.syringePick(row, col, event);
      return;
    }
    // Start box-drag for texture, clear-texture, and room modes
    const cells = state.dungeon.cells;
    if (!isInBounds(cells, row, col)) return;
    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.mousePos = null;
  }

  onMouseMove(row: number, col: number, _edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
    if (!this.dragging) return;
    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length ?? 1) - 1, col));

    if (event.shiftKey && state.paintMode === 'room') {
      ({ row, col } = snapToSquare(row, col, this.dragStart!.row, this.dragStart!.col, cells));
    }

    this.dragEnd = { row, col };
    this.mousePos = pos ?? null;
    requestRender();
  }

  onMouseUp(row: number, col: number, _edge: EdgeInfo | null, event: MouseEvent) {
    if (!this.dragging) return;
    this.dragging = false;

    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length ?? 1) - 1, col));

    if (event.shiftKey && state.paintMode === 'room') {
      ({ row, col } = snapToSquare(row, col, this.dragStart!.row, this.dragStart!.col, cells));
    }

    this.dragEnd = { row, col };

    // For texture / clear-texture, a no-drag click targets the single
    // segment under the cursor (the highlighted half), not the whole cell.
    // Box-drag (multi-cell or even 1×1 with no segment-precision needed for
    // unsplit cells) goes through `_applyToBox`, which now writes/clears
    // every non-voided segment of every cell in the rect.
    const isClick = this.dragStart!.row === this.dragEnd.row && this.dragStart!.col === this.dragEnd.col;
    const mode = state.paintMode;
    if (isClick && (mode === 'texture' || mode === 'clear-texture')) {
      this._applyToSegmentAt(row, col, event, mode);
    } else {
      this._applyToBox();
    }

    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    requestRender();
  }

  /**
   * Single-click texture / clear-texture: target only the segment under the
   * cursor. Hit-tests the click position against the cell's segments and
   * mutates that one segment.
   */
  _applyToSegmentAt(row: number, col: number, event: MouseEvent, mode: 'texture' | 'clear-texture') {
    const cells = state.dungeon.cells;
    const cell = cells[row]?.[col];
    if (!cell) return;
    const { relX, relY } = getRelPos(event, row, col);
    const segIdx = Math.max(0, getSegmentIndexAt(cell, relX, relY));
    const segs = getSegments(cell);
    const seg = segs[segIdx];
    if (!seg || seg.voided) return;

    if (mode === 'texture') {
      const tid = state.activeTexture;
      if (!tid) return;
      void loadTextureImages(tid);
      const opacity = state.textureOpacity;
      if (seg.texture === tid && seg.textureOpacity === opacity) return;
      mutate(
        'Paint texture',
        [{ row, col }],
        () => {
          writeSegmentTexture(cell, segIdx, tid, opacity);
          accumulateDirtyRect(row, col, row, col);
          _patchBlend({ minRow: row, maxRow: row, minCol: col, maxCol: col });
        },
        { textureOnly: true },
      );
    } else {
      // clear-texture
      if (!seg.texture) return;
      mutate(
        'Clear texture',
        [{ row, col }],
        () => {
          writeSegmentTexture(cell, segIdx, null);
          accumulateDirtyRect(row, col, row, col);
          _patchBlend({ minRow: row, maxRow: row, minCol: col, maxCol: col });
        },
        { textureOnly: true },
      );
    }
  }

  floodFill(startRow: number, startCol: number, event: MouseEvent) {
    const cells = state.dungeon.cells;
    if (!cells[startRow]?.[startCol]) return; // void cell — nothing to fill

    const tid = state.activeTexture;
    if (!tid) return;
    void loadTextureImages(tid); // ensure images are loading (no-op if already started)

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const { relX: startRelX, relY: startRelY } = event
      ? getRelPos(event, startRow, startCol)
      : { relX: 0.5, relY: 0.5 };

    const { toFill } = paintFloodBFS(cells, startRow, startCol, startRelX, startRelY);

    const opacity = state.textureOpacity;

    // The traverse()-driven BFS above naturally visits the right segment
    // for every reached cell — including arc cells (each (interior, exterior)
    // segment is its own graph node, gated by the chord wall). No arc
    // post-pass is needed; the deleted `correctArcCells` (220 lines) was a
    // legacy hack to compensate for the half-key data path that segments
    // make obsolete.
    const coords = toFill.map(([r, c]) => ({ row: r, col: c }));
    mutate(
      'Flood fill',
      coords,
      () => {
        let fMinR = Infinity,
          fMaxR = -Infinity,
          fMinC = Infinity,
          fMaxC = -Infinity;
        for (const [r, c, segmentIndex] of toFill) {
          const cell = cells[r]![c]!;
          writeSegmentTexture(cell, segmentIndex, tid, opacity);
          if (r < fMinR) fMinR = r;
          if (r > fMaxR) fMaxR = r;
          if (c < fMinC) fMinC = c;
          if (c > fMaxC) fMaxC = c;
        }
        if (fMinR <= fMaxR) {
          accumulateDirtyRect(fMinR, fMinC, fMaxR, fMaxC);
          _patchBlend({ minRow: fMinR, maxRow: fMaxR, minCol: fMinC, maxCol: fMaxC });
        }
      },
      { textureOnly: true },
    );
  }

  /** Shift+click in clear-texture mode: flood-clear all textures in the connected room. */
  floodFillClear(startRow: number, startCol: number, event: MouseEvent) {
    const cells = state.dungeon.cells;
    if (!cells[startRow]?.[startCol]) return;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const { relX: startRelX, relY: startRelY } = event
      ? getRelPos(event, startRow, startCol)
      : { relX: 0.5, relY: 0.5 };

    // Same segment-aware BFS as floodFill — each visited (cell, segment)
    // becomes one clear target.
    const { toFill: toClear } = paintFloodBFS(cells, startRow, startCol, startRelX, startRelY);

    // Only push undo if at least one targeted segment actually has a texture
    // to clear.
    let hasTexture = false;
    for (const [r, c, segmentIndex] of toClear) {
      const cell = cells[r]![c]!;
      if (getSegments(cell)[segmentIndex]?.texture) {
        hasTexture = true;
        break;
      }
    }
    if (!hasTexture) return;

    const coords = toClear.map(([r, c]) => ({ row: r, col: c }));
    mutate(
      'Clear texture',
      coords,
      () => {
        let cMinR = Infinity,
          cMaxR = -Infinity,
          cMinC = Infinity,
          cMaxC = -Infinity;
        for (const [r, c, segmentIndex] of toClear) {
          const cell = cells[r]![c]!;
          writeSegmentTexture(cell, segmentIndex, null);
          if (r < cMinR) cMinR = r;
          if (r > cMaxR) cMaxR = r;
          if (c < cMinC) cMinC = c;
          if (c > cMaxC) cMaxC = c;
        }
        if (cMinR <= cMaxR) {
          accumulateDirtyRect(cMinR, cMinC, cMaxR, cMaxC);
          _patchBlend({ minRow: cMinR, maxRow: cMaxR, minCol: cMinC, maxCol: cMaxC });
        }
      },
      { textureOnly: true },
    );
  }

  /** Syringe mode: pick up the texture from the clicked cell and switch to texture paint. */
  syringePick(row: number, col: number, event: MouseEvent) {
    const cells = state.dungeon.cells;
    if (!cells[row]?.[col]) return;

    const cell = cells[row][col];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const { relX, relY } = event ? getRelPos(event, row, col) : { relX: 0.5, relY: 0.5 };
    // Hit-test the click position to a segment and read its texture/opacity.
    // Unsplit cells produce segment 0 (the implicit full segment).
    const segIdxPick = Math.max(0, getSegmentIndexAt(cell, relX, relY));
    const seg = getSegments(cell)[segIdxPick];
    const tid = seg?.texture;
    if (!tid) return; // no texture on this cell/segment

    // Pick up opacity too
    const opacity = seg.textureOpacity ?? 1;
    state.textureOpacity = opacity;
    const slider = document.getElementById('texture-opacity-slider')!;
    const valueEl = document.getElementById('texture-opacity-value')!;
    (slider as HTMLInputElement).value = String(Math.round(opacity * 100));
    valueEl.textContent = `${Math.round(opacity * 100)}%`;

    // selectTexture sets activeTexture, switches to paint+texture mode, and updates the panel
    selectTexture(tid);
  }

  onRightClick(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length ?? 0)) return;
    if (cells[row]![col] === null) return;

    const mode = state.paintMode || 'room';
    const cell = cells[row]![col]!;

    if (mode === 'texture' || mode === 'clear-texture' || mode === 'syringe') {
      // Clear texture from the segment under the cursor.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const { relX, relY } = event ? getRelPos(event, row, col) : { relX: 0.5, relY: 0.5 };
      const segIdx = getSegmentIndexAt(cell, relX, relY);
      const segmentIndex = segIdx >= 0 ? segIdx : 0;
      // Early out before pushing undo / firing render if there's nothing to clear.
      if (!getSegments(cell)[segmentIndex]?.texture) return;
      mutate(
        'Clear texture',
        [{ row, col }],
        () => {
          writeSegmentTexture(cell, segmentIndex, null);
          accumulateDirtyRect(row, col, row, col);
          _patchBlend({ minRow: row, maxRow: row, minCol: col, maxCol: col });
        },
        { textureOnly: true },
      );
    }
  }

  /** Apply the active paint mode to all cells in the drag rectangle. */
  _applyToBox() {
    if (!this.dragStart || !this.dragEnd) return;

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row,
      this.dragStart.col,
      this.dragEnd.row,
      this.dragEnd.col,
    );

    const mode = state.paintMode || 'room';
    const cells = state.dungeon.cells;

    if (mode === 'room') {
      let hasWork = false;
      for (let r = r1; r <= r2 && !hasWork; r++) {
        for (let c = c1; c <= c2 && !hasWork; c++) {
          if (cells[r]?.[c] === null || cells[r]?.[c]?.fill) hasWork = true;
        }
      }
      if (!hasWork) return;

      const coords = [];
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (cells[r]) coords.push({ row: r, col: c });
        }
      }

      mutate('Paint room', coords, () => {
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            if (!cells[r]) continue;
            if (cells[r]![c] !== null) {
              if (cells[r]![c]?.fill) delete cells[r]![c]!.fill;
            } else {
              cells[r]![c] = {};
            }
          }
        }
      });
    } else if (mode === 'texture') {
      const tid = state.activeTexture;
      if (!tid) return;
      void loadTextureImages(tid);
      const opacity = state.textureOpacity;
      // Box-paint writes the texture onto every non-voided segment of every
      // cell in the rect. Single-segment precision (the half under the
      // cursor) is handled by `_applyToSegmentAt` for no-drag clicks.
      let hasWork = false;
      for (let r = r1; r <= r2 && !hasWork; r++) {
        for (let c = c1; c <= c2 && !hasWork; c++) {
          const cell = cells[r]?.[c];
          if (!cell) continue;
          for (const seg of getSegments(cell)) {
            if (seg.voided) continue;
            if (seg.texture !== tid || seg.textureOpacity !== opacity) {
              hasWork = true;
              break;
            }
          }
        }
      }
      if (!hasWork) return;
      const texCoords: Array<{ row: number; col: number }> = [];
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (cells[r]?.[c]) texCoords.push({ row: r, col: c });
        }
      }
      mutate(
        'Paint texture',
        texCoords,
        () => {
          for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
              const cell = cells[r]?.[c];
              if (!cell) continue;
              const segs = getSegments(cell);
              for (let i = 0; i < segs.length; i++) {
                if (segs[i]!.voided) continue;
                writeSegmentTexture(cell, i, tid, opacity);
              }
            }
          }
          accumulateDirtyRect(r1, c1, r2, c2);
          _patchBlend({ minRow: r1, maxRow: r2, minCol: c1, maxCol: c2 });
        },
        { textureOnly: true },
      );
    } else if (mode === 'clear-texture') {
      // Box-clear wipes every non-voided segment's texture in the rect.
      let hasWork = false;
      for (let r = r1; r <= r2 && !hasWork; r++) {
        for (let c = c1; c <= c2 && !hasWork; c++) {
          const cell = cells[r]?.[c];
          if (cell && getSegments(cell).some((s) => !s.voided && s.texture)) hasWork = true;
        }
      }
      if (!hasWork) return;
      const clearCoords: Array<{ row: number; col: number }> = [];
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (cells[r]?.[c]) clearCoords.push({ row: r, col: c });
        }
      }
      mutate(
        'Clear texture',
        clearCoords,
        () => {
          for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
              const cell = cells[r]?.[c];
              if (!cell) continue;
              const segs = getSegments(cell);
              for (let i = 0; i < segs.length; i++) {
                if (segs[i]!.voided) continue;
                writeSegmentTexture(cell, i, null);
              }
            }
          }
          accumulateDirtyRect(r1, c1, r2, c2);
          invalidateBlendLayerCache();
        },
        { textureOnly: true },
      );
    }
  }

  _drawSizeLabel(ctx: CanvasRenderingContext2D, gridSize: number) {
    if (!this.mousePos || !this.dragStart || !this.dragEnd) return;
    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row,
      this.dragStart.col,
      this.dragEnd.row,
      this.dragEnd.col,
    );
    const wFt = (c2 - c1 + 1) * gridSize;
    const hFt = (r2 - r1 + 1) * gridSize;
    const label = `${wFt} ft × ${hFt} ft`;

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

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
    if (!this.dragging || !this.dragStart || !this.dragEnd) return;

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row,
      this.dragStart.col,
      this.dragEnd.row,
      this.dragEnd.col,
    );

    const mode = state.paintMode || 'room';
    const cellPx = gridSize * transform.scale;

    // Color per mode: green = room, blue = texture, red = clear
    const fillColor =
      mode === 'room'
        ? 'rgba(80, 200, 120, 0.25)'
        : mode === 'texture'
          ? 'rgba(80, 140, 220, 0.25)'
          : 'rgba(220, 80, 80, 0.25)';
    const strokeColor =
      mode === 'room'
        ? 'rgba(80, 200, 120, 0.9)'
        : mode === 'texture'
          ? 'rgba(80, 140, 220, 0.9)'
          : 'rgba(220, 80, 80, 0.9)';

    ctx.fillStyle = fillColor;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const p = toCanvas(c * gridSize, r * gridSize, transform);
        ctx.fillRect(p.x, p.y, cellPx, cellPx);
      }
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const x = c * gridSize;
        const y = r * gridSize;
        if (r === r1) {
          const p1 = toCanvas(x, y, transform),
            p2 = toCanvas(x + gridSize, y, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        if (r === r2) {
          const p1 = toCanvas(x, y + gridSize, transform),
            p2 = toCanvas(x + gridSize, y + gridSize, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        if (c === c1) {
          const p1 = toCanvas(x, y, transform),
            p2 = toCanvas(x, y + gridSize, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        if (c === c2) {
          const p1 = toCanvas(x + gridSize, y, transform),
            p2 = toCanvas(x + gridSize, y + gridSize, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
      }
    }
    ctx.stroke();

    this._drawSizeLabel(ctx, gridSize);
  }
}
