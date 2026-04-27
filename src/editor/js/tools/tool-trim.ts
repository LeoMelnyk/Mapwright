import type { CardinalDirection, Cell, InteriorEdge, RenderTransform, Segment } from '../../../types.js';
// Trim tool: click+drag to create multi-cell diagonal trims
//
// Drag direction auto-detects the corner (default "auto" mode):
//   Drag up-left → NW trim, drag up-right → NE, down-left → SW, down-right → SE
// Manual corner override available via toolbar buttons.
//
// For a size-N trim at corner C:
//   - N cells along the hypotenuse get diagonal borders + trim properties
//   - Interior cells (between hypotenuse and corner) get voided to null
//   - If rounded, all hypotenuse cells share the same arc center + radius

import { Tool, type EdgeInfo, type CanvasPos } from './tool-base.js';
import state, { mutate } from '../state.js';
import { toCanvas } from '../utils.js';
import { requestRender } from '../canvas-view.js';
import {
  computeTrimCells,
  CARDINAL_OFFSETS,
  OPPOSITE,
  diagonalSegments,
  trimSegments,
  spliceSegments,
  getEdge,
  deleteEdge,
  getSegments,
  primaryTextureSegmentIndex,
  type TrimCorner,
  type TrimPreview,
} from '../../../util/index.js';

/**
 * Trim tool: click+drag to create multi-cell diagonal or arc trims on room corners.
 * Auto-detects corner direction from drag gesture.
 */
export class TrimTool extends Tool {
  dragging: boolean = false;
  dragStart: { row: number; col: number } | null = null;
  dragEnd: { row: number; col: number } | null = null;
  previewCells: TrimPreview | null = null;
  resolvedCorner: TrimCorner | null = null;
  hoverPos: { x: number; y: number } | null = null;
  hoverCorner: TrimCorner | null = null;

  constructor() {
    super('trim', 'T', 'crosshair');
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.previewCells = null;
    this.resolvedCorner = null;
    this.hoverPos = null;
    this.hoverCorner = null;
  }

  onActivate() {
    state.statusInstruction =
      'Drag from room corner to set trim size · R to round · I to invert · O to open · Right-click to remove';
  }

  onDeactivate() {
    this.dragging = false;
    this.previewCells = null;
    state.statusInstruction = null;
  }

  /**
   * Cancel an in-progress drag. Called by canvas-view on right-click during drag.
   * Returns true if a drag was cancelled, false otherwise.
   */
  onCancel() {
    if (!this.dragging) return false;
    this.dragging = false;
    this.previewCells = null;
    this.resolvedCorner = null;
    return true;
  }

  onMouseDown(row: number, col: number) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length ?? 0)) return;

    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.resolvedCorner = state.trimCorner === 'auto' ? (this.hoverCorner ?? 'nw') : (state.trimCorner as TrimCorner);
    this._updatePreview();
  }

  onMouseMove(row: number, col: number, edge: EdgeInfo | null, event: MouseEvent, pos: CanvasPos | null) {
    this.hoverPos = pos ?? null;
    if (!this.dragging) return;
    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length ?? 1) - 1, col));
    this.dragEnd = { row, col };

    // Auto-detect corner from drag direction
    if (state.trimCorner === 'auto') {
      const dr = this.dragEnd.row - this.dragStart!.row;
      const dc = this.dragEnd.col - this.dragStart!.col;
      // Only update direction once the mouse has moved at least 1 cell
      if (dr !== 0 || dc !== 0) {
        if (dr <= 0 && dc <= 0) this.resolvedCorner = 'nw';
        else if (dr <= 0 && dc >= 0) this.resolvedCorner = 'ne';
        else if (dr >= 0 && dc <= 0) this.resolvedCorner = 'sw';
        else this.resolvedCorner = 'se';
      }
    } else {
      this.resolvedCorner = state.trimCorner as TrimCorner;
    }

    this._updatePreview();
    requestRender();
  }

  onMouseUp() {
    if (!this.dragging) return;
    this.dragging = false;

    const preview = this.previewCells;
    if (!preview || preview.hypotenuse.length === 0) {
      this.previewCells = null;
      return;
    }

    const cells = state.dungeon.cells;

    // All cells that will be mutated
    const allCoords = [...preview.voided, ...preview.hypotenuse, ...(preview.insideArc ?? [])];

    const corner = this.resolvedCorner;
    const isRound = state.trimRound;
    const isInverted = state.trimInverted;

    const allDirs: CardinalDirection[] = ['north', 'south', 'east', 'west'];

    // Helper: clear all cardinal walls + any prior interior partition.
    // Trim placement always claims the cell shape, so any pre-existing
    // diagonal/arc partition must be wiped before we re-partition.
    const clearWalls = (cell: Cell, r: number, c: number) => {
      for (const dir of allDirs) {
        if (getEdge(cell, dir)) {
          deleteEdge(cell, dir);
          const [dr, dc] = CARDINAL_OFFSETS[dir];
          const neighbor = cells[r + dr]?.[c + dc];
          if (neighbor) deleteEdge(neighbor, OPPOSITE[dir]);
        }
      }
      delete cell.segments;
      delete cell.interiorEdges;
    };

    // Helper: clear walls on the NEIGHBORS of a cell that's about to be
    // voided. Without this, neighbors keep reciprocal walls pointing into
    // the void, leaving stray wall segments visible inside the trimmed
    // corner.
    const clearNeighborWalls = (r: number, c: number) => {
      for (const dir of allDirs) {
        const [dr, dc] = CARDINAL_OFFSETS[dir];
        const neighbor = cells[r + dr]?.[c + dc];
        if (neighbor) deleteEdge(neighbor, OPPOSITE[dir]);
      }
    };

    // Build the diagonal that runs across a corner: NW/SE corners need the
    // NE-SW diagonal (running tr→bl); NE/SW corners need the NW-SE diagonal
    // (running tl→br). Matches the legacy edge-key convention.
    const cornerDiag = (cor: TrimCorner): 'nw-se' | 'ne-sw' => (cor === 'nw' || cor === 'se' ? 'ne-sw' : 'nw-se');

    // Snapshot the primary texture/opacity before partitioning so we can
    // restore it onto the new "primary" segment of the result. Trim placement
    // shouldn't wipe an existing floor texture — the room half (interior arc
    // segment / NE diagonal segment) inherits the texture the cell had before
    // the trim.
    const snapshotPrimaryTexture = (cell: Cell): { texture?: string; opacity?: number } => {
      const segs = getSegments(cell);
      const idx = primaryTextureSegmentIndex(cell);
      const seg = segs[idx];
      return { texture: seg?.texture, opacity: seg?.textureOpacity };
    };

    // Apply a partition (segments + one interior edge) to a cell via
    // spliceSegments. Always passes deep-cloned arrays so `replacePartition`'s
    // invariant assertions don't share references with the factory output.
    // `preservedTexture` is written onto the new primary segment after the
    // partition lands so existing textures survive trim placement.
    const writePartition = (
      cell: Cell,
      segments: [Segment, Segment],
      interiorEdge: InteriorEdge,
      preservedTexture: { texture?: string; opacity?: number } = {},
    ) => {
      spliceSegments(cell, {
        kind: 'replacePartition',
        segments: segments.map((s) => ({
          ...s,
          polygon: s.polygon.map((p) => [p[0]!, p[1]!]),
        })),
        interiorEdges: [
          {
            vertices: interiorEdge.vertices.map((v) => [v[0]!, v[1]!]),
            wall: interiorEdge.wall,
            between: [interiorEdge.between[0], interiorEdge.between[1]],
          },
        ],
      });
      if (preservedTexture.texture !== undefined) {
        spliceSegments(cell, {
          kind: 'setSegmentTexture',
          segmentIndex: primaryTextureSegmentIndex(cell),
          texture: preservedTexture.texture,
          textureOpacity: preservedTexture.opacity,
        });
      }
    };

    mutate(
      'Place trim',
      allCoords,
      () => {
        if (isRound) {
          // ── Round trim: per-cell trimClip from computeTrimCells, fed to
          // trimSegments() to produce the canonical (interior, exterior)
          // partition. The chord polyline (`interiorEdge.vertices`) fully
          // describes the curve; renderers stroke it directly via `isChordEdge`.
          const trimData = computeTrimCells(preview, corner!, isInverted, state.trimOpen);
          const numRows = cells.length;
          const numCols = cells[0]?.length ?? 0;

          for (const [key, val] of trimData) {
            const [r, c] = key.split(',').map(Number) as [number, number];
            if (r < 0 || r >= numRows || c < 0 || c >= numCols) continue;

            if (val === null) {
              clearNeighborWalls(r, c);
              cells[r]![c] = null;
              continue;
            }

            cells[r]![c] ??= {};
            const cell = cells[r]![c];
            const preserved = snapshotPrimaryTexture(cell);
            clearWalls(cell, r, c);

            if (val === 'interior') {
              // Plain floor — no partition needed; the cell stays unsplit.
              // Preserve the primary texture on the (now unsplit) full segment.
              if (preserved.texture !== undefined) {
                spliceSegments(cell, {
                  kind: 'setSegmentTexture',
                  segmentIndex: 0,
                  texture: preserved.texture,
                  textureOpacity: preserved.opacity,
                });
              }
              continue;
            }

            // Arc boundary cell.
            const { segments, interiorEdge } = trimSegments(val.trimClip, !!val.trimOpen);
            writePartition(cell, segments, interiorEdge, preserved);
            // Closed trim: void the exterior segment (the chord-cut piece on
            // the corner side). The chord wall is already 'w' from
            // trimSegments when openExterior=false, so connectivity is
            // correct; this hides the floor on the outside half.
            if (!val.trimOpen) {
              spliceSegments(cell, {
                kind: 'setSegmentVoided',
                segmentIndex: 1,
                voided: true,
              });
            }
          }
        } else {
          // ── Straight (non-round) trim ──
          if (!state.trimOpen) {
            for (const { row: r, col: c } of preview.voided) {
              clearNeighborWalls(r, c);
              cells[r]![c] = null;
            }
          } else {
            for (const { row: r, col: c } of preview.voided) {
              const cell = cells[r]?.[c];
              if (!cell) continue;
              clearWalls(cell, r, c);
            }
          }

          const diag = cornerDiag(corner!);
          // Map the trimmed corner to the segment indices (room vs cut) of
          // the resulting diagonal partition. `diagonalSegments` orders:
          //   nw-se: s0=SW, s1=NE
          //   ne-sw: s0=SE, s1=NW
          // For an NW or NE corner trim the cut triangle is s1; for SW/SE
          // it is s0. The opposite index is the room half that should keep
          // the floor texture.
          const cutIdx = corner === 'nw' || corner === 'ne' ? 1 : 0;
          const roomIdx = 1 - cutIdx;
          for (const { row: r, col: c } of preview.hypotenuse) {
            cells[r]![c] ??= {};
            const cell = cells[r]![c];
            const preserved = snapshotPrimaryTexture(cell);
            clearWalls(cell, r, c);
            const { segments, interiorEdge } = diagonalSegments(diag);
            interiorEdge.wall = state.trimOpen ? null : 'w';
            // No preservedTexture passed — we write it ourselves below to the
            // corner-aware room segment, since `primaryTextureSegmentIndex`
            // for diagonals always returns 1 (correct for SW/SE corners but
            // the void side for NW/NE).
            writePartition(cell, segments, interiorEdge);
            if (preserved.texture !== undefined) {
              spliceSegments(cell, {
                kind: 'setSegmentTexture',
                segmentIndex: roomIdx,
                texture: preserved.texture,
                textureOpacity: preserved.opacity,
              });
            }
            if (!state.trimOpen) {
              spliceSegments(cell, {
                kind: 'setSegmentVoided',
                segmentIndex: cutIdx,
                voided: true,
              });
            }
          }
        }
      },
      { invalidate: ['lighting'], forceGeometry: true },
    );

    this.previewCells = null;
    requestRender();
  }

  /**
   * Compute preview from drag start/end and resolved corner.
   */
  _updatePreview() {
    const corner = this.resolvedCorner;
    const { row: r0, col: c0 } = this.dragStart!;
    const { row: r1, col: c1 } = this.dragEnd!;

    // Size = max distance along row or col axis + 1
    const size = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0)) + 1;

    const hypotenuse: { row: number; col: number }[] = [];
    let voided: { row: number; col: number }[] = [];
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length ?? 0;

    // The click cell (r0,c0) is the corner tip (part of the void).
    // The hypotenuse is the diagonal edge separating room from void.
    // Indexed so hyp[0] has 0 void cells, hyp[N-1] has N-1 void cells.
    //
    // Row direction: south corners (sw/se) → click at bottom, hyp starts at top
    //                north corners (nw/ne) → click at top, hyp starts at bottom
    // Col direction: east corners (ne/se) → hyp col = c0-i (going west from click)
    //                west corners (nw/sw) → hyp col = c0+i (going east from click)
    const far = size - 1;

    for (let i = 0; i < size; i++) {
      let hr = 0,
        hc = 0;
      switch (corner) {
        case 'se':
          hr = r0 - far + i;
          hc = c0 - i;
          break;
        case 'nw':
          hr = r0 + far - i;
          hc = c0 + i;
          break;
        case 'ne':
          hr = r0 + far - i;
          hc = c0 - i;
          break;
        case 'sw':
          hr = r0 - far + i;
          hc = c0 + i;
          break;
        case null:
          break;
      }
      if (hr < 0 || hr >= numRows || hc < 0 || hc >= numCols) continue;
      hypotenuse.push({ row: hr, col: hc });
    }

    // Void: triangle between hypotenuse and click corner.
    // At hyp index i, there are i void cells filling back toward the click column.
    for (let i = 1; i < size; i++) {
      for (let j = 0; j < i; j++) {
        let vr = 0,
          vc = 0;
        switch (corner) {
          case 'se':
            vr = r0 - far + i;
            vc = c0 - i + 1 + j;
            break;
          case 'nw':
            vr = r0 + far - i;
            vc = c0 + j;
            break;
          case 'ne':
            vr = r0 + far - i;
            vc = c0 - i + 1 + j;
            break;
          case 'sw':
            vr = r0 - far + i;
            vc = c0 + j;
            break;
          case null:
            break;
        }
        if (vr < 0 || vr >= numRows || vc < 0 || vc >= numCols) continue;
        voided.push({ row: vr, col: vc });
      }
    }

    // Arc center: grid intersection at the trim's corner
    let arcCenter = { row: r0, col: c0 };
    const allRows = hypotenuse.map((c) => c.row).concat(voided.map((c) => c.row));
    const allCols = hypotenuse.map((c) => c.col).concat(voided.map((c) => c.col));
    if (allRows.length > 0) {
      const minR = Math.min(...allRows);
      const maxR = Math.max(...allRows);
      const minC = Math.min(...allCols);
      const maxC = Math.max(...allCols);

      switch (corner) {
        case 'nw':
          arcCenter = { row: minR, col: minC };
          break;
        case 'ne':
          arcCenter = { row: minR, col: maxC + 1 };
          break;
        case 'sw':
          arcCenter = { row: maxR + 1, col: minC };
          break;
        case 'se':
          arcCenter = { row: maxR + 1, col: maxC + 1 };
          break;
        case null:
          break;
      }
    }

    // For rounded non-inverted trims: the arc curves inward relative to the
    // straight diagonal, so only cells completely outside the arc should be
    // voided. Cells between the diagonal and the arc remain as room floor,
    // but their existing cardinal/diagonal walls must be cleared (the arc is
    // now the wall).
    const insideArc: { row: number; col: number }[] = [];
    if (state.trimRound && !state.trimInverted && voided.length > 0) {
      let acxGrid = 0,
        acyGrid = 0;
      switch (corner) {
        case 'nw':
          acxGrid = arcCenter.col + size;
          acyGrid = arcCenter.row + size;
          break;
        case 'ne':
          acxGrid = arcCenter.col - size;
          acyGrid = arcCenter.row + size;
          break;
        case 'sw':
          acxGrid = arcCenter.col + size;
          acyGrid = arcCenter.row - size;
          break;
        case 'se':
          acxGrid = arcCenter.col - size;
          acyGrid = arcCenter.row - size;
          break;
        case null:
          break;
      }
      voided = voided.filter(({ row: vr, col: vc }) => {
        // Closest distance from cell [vc, vc+1] × [vr, vr+1] to arc pivot.
        // `>= size - ε` keeps cells whose closest corner is ON the arc as
        // void: the corner touches the curve but the cell has zero area
        // inside the circle, so it should be cut. The epsilon guards
        // against floating-point loss in the sqrt.
        const dx = Math.max(vc - acxGrid, 0, acxGrid - (vc + 1));
        const dy = Math.max(vr - acyGrid, 0, acyGrid - (vr + 1));
        const outside = Math.sqrt(dx * dx + dy * dy) >= size - 1e-9;
        if (!outside) insideArc.push({ row: vr, col: vc });
        return outside;
      });
    }

    this.previewCells = { hypotenuse, voided, insideArc, arcCenter, size };
  }

  onRightClick(row: number, col: number) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length ?? 0)) return;
    const cell = cells[row]![col];
    // A trim/diagonal cell is any cell with an explicit interior partition
    // (segments + interior edges). Plain unsplit floor cells have no
    // segments array and are no-ops here.
    if (!cell?.segments || cell.segments.length < 2) return;

    mutate(
      'Remove Trim',
      [{ row, col }],
      () => {
        delete cell.segments;
        delete cell.interiorEdges;
      },
      { invalidate: ['lighting'], forceGeometry: true },
    );
    requestRender();
  }

  onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.dragging) {
      this.onCancel();
      requestRender();
      return;
    }
    const syncTrimButtons = (prop: string, val: boolean) => {
      document.querySelectorAll<HTMLElement>(`#trim-shape-options [data-trim="${prop}"]`).forEach((b) => {
        b.classList.toggle('active', b.dataset.val === String(val));
      });
    };
    if (e.key === 'r' || e.key === 'R') {
      state.trimRound = !state.trimRound;
      syncTrimButtons('round', state.trimRound);
    }
    if (e.key === 'i' || e.key === 'I') {
      state.trimInverted = !state.trimInverted;
      syncTrimButtons('inverted', state.trimInverted);
    }
    if (e.key === 'o' || e.key === 'O') {
      state.trimOpen = !state.trimOpen;
      syncTrimButtons('open', state.trimOpen);
    }
  }

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
    // Hover preview — show which corner will be trimmed before dragging
    if (!this.dragging && state.hoveredCell && this.hoverPos) {
      const { row, col } = state.hoveredCell;
      const cells = state.dungeon.cells;
      if (row >= 0 && row < cells.length && col >= 0 && col < (cells[0]?.length ?? 0) && cells[row]![col] !== null) {
        let corner: TrimCorner;
        if (state.trimCorner === 'auto') {
          // Determine corner from which quadrant of the cell the cursor is in
          const cellTL = toCanvas(col * gridSize, row * gridSize, transform);
          const cellPx = gridSize * transform.scale;
          const inEast = this.hoverPos.x - cellTL.x > cellPx / 2;
          const inSouth = this.hoverPos.y - cellTL.y > cellPx / 2;
          corner = inSouth ? (inEast ? 'se' : 'sw') : inEast ? 'ne' : 'nw';
        } else {
          corner = state.trimCorner as TrimCorner;
        }
        this.hoverCorner = corner; // remember for onMouseDown
        this._drawHoverPreview(ctx, transform, gridSize, row, col, corner);
      }
    }

    if (!this.previewCells) return;
    const { hypotenuse, voided } = this.previewCells;
    const corner = this.resolvedCorner;
    const cellPx = gridSize * transform.scale;

    // Color: red for cells/segments that will be deleted (closed trim),
    // green for "open" mode where the geometry stays passable (floor
    // preserved on both sides of the chord).
    const cutFill = state.trimOpen ? 'rgba(80, 200, 120, 0.15)' : 'rgba(255, 80, 80, 0.25)';
    ctx.fillStyle = cutFill;

    if (state.trimRound) {
      // Round trim: drive the highlight from `computeTrimCells` directly so
      // every cell the actual placement touches lights up. Whole-cell void
      // entries get a full rect; arc boundary cells get just their chord-cut
      // (s1 = exterior) polygon. Note the arc cell set isn't always the
      // same as `previewCells.hypotenuse` — the arc curve can sweep through
      // cells outside the diagonal — so iterating `trimData` is what makes
      // the preview match the result.
      const trimData = computeTrimCells(this.previewCells, corner!, state.trimInverted, state.trimOpen);
      for (const [key, val] of trimData) {
        const [r, c] = key.split(',').map(Number) as [number, number];
        if (val === null) {
          const p = toCanvas(c * gridSize, r * gridSize, transform);
          ctx.fillRect(p.x, p.y, cellPx, cellPx);
        } else if (val !== 'interior') {
          const { segments } = trimSegments(val.trimClip, !!val.trimOpen);
          this._fillCellPolygon(ctx, transform, gridSize, r, c, segments[1].polygon);
        }
      }
    } else {
      // Straight trim: full-cell red on the void corner, and a corner
      // triangle on each hypotenuse cell.
      for (const { row, col } of voided) {
        const p = toCanvas(col * gridSize, row * gridSize, transform);
        ctx.fillRect(p.x, p.y, cellPx, cellPx);
      }
      // Cell-local [0..1] cut triangle per corner. Names match visual position.
      const cutTriangle: number[][] = {
        nw: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        ne: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        sw: [
          [0, 0],
          [1, 1],
          [0, 1],
        ],
        se: [
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      }[corner!];
      for (const { row, col } of hypotenuse) {
        this._fillCellPolygon(ctx, transform, gridSize, row, col, cutTriangle);
      }
    }

    // Wall preview line — dashed blue, matching the round-arc style.
    if (state.trimRound) {
      this._drawArcPreview(ctx, transform, gridSize, corner!);
    } else {
      this._drawStraightWallPreview(ctx, transform, gridSize, corner!, hypotenuse);
    }
  }

  /** Dashed-blue diagonal stroke across each hypotenuse cell — the future wall. */
  _drawStraightWallPreview(
    ctx: CanvasRenderingContext2D,
    transform: RenderTransform,
    gridSize: number,
    corner: TrimCorner,
    hypotenuse: { row: number; col: number }[],
  ) {
    ctx.save();
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (const { row, col } of hypotenuse) {
      const x = col * gridSize;
      const y = row * gridSize;
      // NW/SE corners use NE→SW diagonal; NE/SW use NW→SE.
      const p1 = corner === 'nw' || corner === 'se' ? toCanvas(x + gridSize, y, transform) : toCanvas(x, y, transform);
      const p2 =
        corner === 'nw' || corner === 'se'
          ? toCanvas(x, y + gridSize, transform)
          : toCanvas(x + gridSize, y + gridSize, transform);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Fill a polygon in cell-local [0..1] coords inside the cell at (row, col). */
  _fillCellPolygon(
    ctx: CanvasRenderingContext2D,
    transform: RenderTransform,
    gridSize: number,
    row: number,
    col: number,
    poly: number[][],
  ) {
    if (poly.length < 3) return;
    const x = col * gridSize;
    const y = row * gridSize;
    ctx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const v = poly[i]!;
      const p = toCanvas(x + v[0]! * gridSize, y + v[1]! * gridSize, transform);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
  }

  _drawHoverPreview(
    ctx: CanvasRenderingContext2D,
    transform: RenderTransform,
    gridSize: number,
    row: number,
    col: number,
    corner: TrimCorner,
  ) {
    const x = col * gridSize;
    const y = row * gridSize;
    const tl = toCanvas(x, y, transform);
    const tr = toCanvas(x + gridSize, y, transform);
    const bl = toCanvas(x, y + gridSize, transform);
    const br = toCanvas(x + gridSize, y + gridSize, transform);

    // The void triangle is the corner being cut plus the two diagonal endpoints.
    // Its hypotenuse edge is the wall that will be placed — no separate
    // line stroke needed.
    const voidTri = {
      nw: [tl, tr, bl],
      ne: [tl, tr, br],
      sw: [tl, bl, br],
      se: [tr, bl, br],
    }[corner];

    ctx.save();
    ctx.fillStyle = 'rgba(255, 80, 80, 0.28)';
    ctx.beginPath();
    ctx.moveTo(voidTri[0]!.x, voidTri[0]!.y);
    ctx.lineTo(voidTri[1]!.x, voidTri[1]!.y);
    ctx.lineTo(voidTri[2]!.x, voidTri[2]!.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _drawArcPreview(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number, corner: TrimCorner) {
    const { arcCenter, size } = this.previewCells!;
    const R = size * gridSize;
    const Rpx = R * transform.scale;
    const cp = toCanvas(arcCenter.col * gridSize, arcCenter.row * gridSize, transform);

    ctx.strokeStyle = 'rgba(100, 200, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();

    if (state.trimInverted) {
      switch (corner) {
        case 'nw':
          ctx.arc(cp.x, cp.y, Rpx, Math.PI / 2, 0, true);
          break;
        case 'ne':
          ctx.arc(cp.x, cp.y, Rpx, Math.PI / 2, Math.PI, false);
          break;
        case 'sw':
          ctx.arc(cp.x, cp.y, Rpx, 0, (3 * Math.PI) / 2, true);
          break;
        case 'se':
          ctx.arc(cp.x, cp.y, Rpx, Math.PI, (3 * Math.PI) / 2, false);
          break;
      }
    } else {
      let acx = 0,
        acy = 0;
      switch (corner) {
        case 'nw':
          acx = (arcCenter.col + size) * gridSize;
          acy = (arcCenter.row + size) * gridSize;
          break;
        case 'ne':
          acx = (arcCenter.col - size) * gridSize;
          acy = (arcCenter.row + size) * gridSize;
          break;
        case 'sw':
          acx = (arcCenter.col + size) * gridSize;
          acy = (arcCenter.row - size) * gridSize;
          break;
        case 'se':
          acx = (arcCenter.col - size) * gridSize;
          acy = (arcCenter.row - size) * gridSize;
          break;
      }
      const acp = toCanvas(acx, acy, transform);
      switch (corner) {
        case 'nw':
          ctx.arc(acp.x, acp.y, Rpx, (3 * Math.PI) / 2, Math.PI, true);
          break;
        case 'ne':
          ctx.arc(acp.x, acp.y, Rpx, (3 * Math.PI) / 2, 0, false);
          break;
        case 'sw':
          ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, Math.PI, false);
          break;
        case 'se':
          ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, 0, true);
          break;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
