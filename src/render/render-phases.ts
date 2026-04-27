import type {
  BackgroundImage,
  Cell,
  CellGrid,
  Direction,
  Metadata,
  PropCatalog,
  RenderTransform,
  Segment,
  TextureOptions,
  TextureRuntime,
  Theme,
  VisibleBounds,
} from '../types.js';
import { cellHasChordEdge, getEdge, getInteriorEdges, getSegments, isChordEdge } from '../util/index.js';
import { toCanvas } from './bounds.js';
import { renderTimings, getTimingFrame } from './render-state.js';

/**
 * Returns the cell's renderable segments — segments that should appear in
 * the floor pass. Filters out segments with `voided: true`. Migration runs
 * at load time (`io.ts`), so by the time the renderer sees a cell its void
 * corners are already explicit `voided: true` segments — no neighbor-state
 * inference is needed here.
 */
function getRenderableSegments(cell: Cell): Segment[] {
  return getSegments(cell).filter((s) => !s.voided);
}

/** Does the polygon span the full unit square exactly? Fast path detection. */
function isFullSquarePolygon(poly: number[][]): boolean {
  if (poly.length !== 4) return false;
  const EPS = 1e-9;
  let nw = 0,
    ne = 0,
    se = 0,
    sw = 0;
  for (const p of poly) {
    const [x, y] = p;
    if (x === undefined || y === undefined) return false;
    if (Math.abs(x) < EPS && Math.abs(y) < EPS) nw++;
    else if (Math.abs(x - 1) < EPS && Math.abs(y) < EPS) ne++;
    else if (Math.abs(x - 1) < EPS && Math.abs(y - 1) < EPS) se++;
    else if (Math.abs(x) < EPS && Math.abs(y - 1) < EPS) sw++;
    else return false;
  }
  return nw === 1 && ne === 1 && se === 1 && sw === 1;
}
import {
  renderBorder,
  getDoubleDoorRole,
  getDoubleDoorDiagonalRole,
  renderDoubleBorder,
  renderDiagonalBorder,
  renderDiagonalDoubleBorder,
  drawStairsInCell,
  drawStairsLinkLabel,
  drawStairShape,
  drawStairShapeLinkLabel,
  wallSegmentCoords,
  scaleFactor,
  renderWindowRun,
} from './borders.js';
import { drawCellLabel, drawDmLabel } from './features.js';
import { renderAllProps, getRenderedPropsLayer } from './props.js';
import { drawWallShadow, drawRoughWalls, drawBufferShading } from './effects.js';
import {
  getBlendTopoCache,
  getBlendScratch,
  getViewportBlendLayer,
  getRenderedBlendLayer,
  BLEND_BITMAP_SIZE,
  PDF_EDGE_FALLBACK_OPACITY,
  PDF_CORNER_FALLBACK_OPACITY,
  getTexChunk,
} from './blend.js';

// ─── Constants ─────
const HAZARD_COLOR = '#f0c020';

// ── Texture pattern cache ─────────────────────────────────────────────────────
// createPattern + setTransform — same idea as the Path2D cache used for hatching:
// build one CanvasPattern per texture entry (tied to the rendering context) and
// update only its transform matrix each frame instead of issuing one drawImage
// per cell. On pan the transform update is a single DOMMatrix allocation; the
// actual pixel work is batched into one ctx.fill() call per texture group.
// Patterns are cached on entry._pattern / entry._patternCtx so they survive
// across frames and are only recreated when the image or context changes.

function _getTexPattern(ctx: CanvasRenderingContext2D, entry: TextureRuntime) {
  if (!entry._pattern || entry._patternCtx !== ctx) {
    // Prefer the pre-decoded ImageBitmap (populated by loadTextureImages after
    // createImageBitmap). Canvas2D treats a bitmap as a GPU-ready resource, so
    // the first fill doesn't pay a lazy-decode stall like it would with the raw
    // HTMLImageElement. Falls back to the element if the bitmap isn't ready yet
    // (still-loading texture or a browser without createImageBitmap support).
    const src = entry._patternBitmap ?? entry.img!;
    entry._pattern = ctx.createPattern(src, 'repeat');
    entry._patternCtx = ctx;
  }
  return entry._pattern as CanvasPattern;
}

function _applyPatternTransform(
  pattern: CanvasPattern,
  entry: TextureRuntime,
  cellPx: number,
  transform: RenderTransform,
  resolution = 1,
) {
  const img = entry.img!;
  const cw = Math.max(1, Math.floor(img.naturalWidth / 256));
  const ch = Math.max(1, Math.floor(img.naturalHeight / 256));
  // Scale: one chunk (srcW × srcH texture pixels) → one display cell.
  // Multiply cellPx by resolution so the texture tiles at the display-cell size
  // (5ft) rather than the internal cell size (2.5ft).
  const displayCellPx = cellPx * resolution;
  const srcW = Math.floor(img.naturalWidth / cw);
  const srcH = Math.floor(img.naturalHeight / ch);
  pattern.setTransform(
    new DOMMatrix([displayCellPx / srcW, 0, 0, displayCellPx / srcH, transform.offsetX, transform.offsetY]),
  );
}

/**
 * Visual params shared by every phase: grid size, theme, viewport transform.
 */
export interface RenderPhaseParams {
  gridSize: number;
  theme: Theme;
  transform: RenderTransform;
}

/**
 * Optional rendering knobs accepted by `renderFloors`. All fields default to
 * the equivalent of "off" or "no override".
 */
export interface RenderFloorsOptions {
  textureOptions?: TextureOptions | null;
  bgImageEl?: HTMLImageElement | null;
  bgImgConfig?: BackgroundImage | Record<string, number | string | boolean> | null;
  visibleBounds?: VisibleBounds | null;
  /** Sub-cell resolution multiplier (1, 2, …) */
  resolution?: number;
}

/**
 * Fill room backgrounds and render per-cell texture overlays.
 *
 * @param ctx - Canvas rendering context
 * @param cells - 2D cell grid
 * @param roomCells - Room cell mask
 * @param params - Required visual params (gridSize, theme, transform)
 * @param options - Optional rendering knobs (textures, bg image, viewport bounds, resolution)
 * @returns True if any textured cells were drawn
 */
export function renderFloors(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  roomCells: boolean[][],
  params: RenderPhaseParams,
  options: RenderFloorsOptions = {},
): boolean {
  const { gridSize, theme, transform } = params;
  const { textureOptions = null, bgImageEl = null, bgImgConfig = null, visibleBounds = null, resolution = 1 } = options;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const startRow = visibleBounds?.minRow ?? 0;
  const endRow = visibleBounds?.maxRow ?? numRows - 1;
  const startCol = visibleBounds?.minCol ?? 0;
  const endCol = visibleBounds?.maxCol ?? numCols - 1;
  let hasTexturedCells = false;
  const displayCellFeet = gridSize * resolution; // size of one display cell in feet

  // Pass 1: Build a single floor path covering all room cells, fill once.
  // Step by `resolution` to draw display-cell-sized rects — reduces canvas commands by 4x.
  // Trim corners fall back to per-sub-cell triangular clips.
  const step = resolution;
  const cellPxDisplay = displayCellFeet * transform.scale;
  const cellPxSub = gridSize * transform.scale;
  ctx.fillStyle = theme.wallFill ?? theme.wall;
  ctx.beginPath();
  // Snap iteration to display-cell boundaries for coalescing
  const floorStartRow = Math.floor(startRow / step) * step;
  const floorStartCol = Math.floor(startCol / step) * step;
  for (let row = floorStartRow; row <= endRow; row += step) {
    for (let col = floorStartCol; col <= endCol; col += step) {
      // Check sub-cells in this display cell. A sub-cell is "split" when it
      // has more than one segment (diagonal walls, trim arcs) OR when its
      // single segment isn't the implicit full-square polygon — both cases
      // require the per-segment polygon path instead of the fast rect path.
      let floorCount = 0,
        hasTrim = false;
      const totalSub = step * step;
      for (let dr = 0; dr < step && !hasTrim; dr++) {
        for (let dc = 0; dc < step; dc++) {
          const sr = row + dr,
            sc = col + dc;
          if (!roomCells[sr]?.[sc]) continue;
          const c = cells[sr]?.[sc];
          if (!c) continue;
          const segs = getSegments(c);
          if (segs.length > 1 || (segs[0] && !isFullSquarePolygon(segs[0].polygon))) {
            hasTrim = true;
            break;
          }
          floorCount++;
        }
      }
      if (!floorCount && !hasTrim) continue;

      if (!hasTrim && floorCount === totalSub) {
        // Fast path: all sub-cells are unsplit floor, draw one display-cell-sized rect.
        const p1 = toCanvas(col * gridSize, row * gridSize, transform);
        ctx.rect(p1.x, p1.y, cellPxDisplay, cellPxDisplay);
      } else {
        // Slow path: per-sub-cell, trace each renderable segment's polygon.
        // `getRenderableSegments` filters out voided segments. Unsplit cells
        // contribute a single full-square rect; split cells contribute their
        // polygon shapes.
        for (let dr = 0; dr < step; dr++) {
          for (let dc = 0; dc < step; dc++) {
            const sr = row + dr,
              sc = col + dc;
            if (!roomCells[sr]?.[sc]) continue;
            const cell = cells[sr]?.[sc];
            if (!cell) continue;
            const renderable = getRenderableSegments(cell);
            if (renderable.length === 0) continue;
            const x = sc * gridSize,
              y = sr * gridSize;
            const px = toCanvas(x, y, transform);
            for (const seg of renderable) {
              if (isFullSquarePolygon(seg.polygon)) {
                ctx.rect(px.x, px.y, cellPxSub, cellPxSub);
              } else {
                ctx.moveTo(px.x + seg.polygon[0]![0]! * cellPxSub, px.y + seg.polygon[0]![1]! * cellPxSub);
                for (let i = 1; i < seg.polygon.length; i++) {
                  ctx.lineTo(px.x + seg.polygon[i]![0]! * cellPxSub, px.y + seg.polygon[i]![1]! * cellPxSub);
                }
                ctx.closePath();
              }
            }
          }
        }
      }
    }
  }
  ctx.fill();

  // Background image: above floor base color, below texture tiles, clipped to floor cells
  if (bgImageEl && bgImgConfig && bgImageEl.complete && bgImageEl.naturalWidth > 0) {
    const cellPx = gridSize * transform.scale;
    const imgW = (bgImageEl.naturalWidth * cellPx) / (bgImgConfig.pixelsPerCell as number);
    const imgH = (bgImageEl.naturalHeight * cellPx) / (bgImgConfig.pixelsPerCell as number);
    const imgX = transform.offsetX + (bgImgConfig.offsetX as number) * cellPx;
    const imgY = transform.offsetY + (bgImgConfig.offsetY as number) * cellPx;
    ctx.save();
    ctx.clip(); // clip to the Pass 1 floor path — respects fog in player view, trim shapes in both
    ctx.globalAlpha = bgImgConfig.opacity as number;
    ctx.drawImage(bgImageEl, imgX, imgY, imgW, imgH);
    ctx.restore();
  }

  // Pass 2: Per-cell texture overlays
  // When DOMMatrix + createPattern are available (browser) we batch all cells
  // that share a texture into a single ctx.fill() call — same principle as the
  // Path2D cache used for hatching: build geometry once, replay cheaply.
  // Clipped cells (diagonal trim corners, half-texture splits) are rendered
  // individually but still use the pattern fill, eliminating the per-cell
  // drawImage + source-rect math. Node.js (PDF renderer) falls back to the
  // original drawImage path since DOMMatrix may not be available there.
  const cellPx = gridSize * transform.scale;
  const canBatch = typeof DOMMatrix !== 'undefined' && typeof ctx.createPattern === 'function';

  if (canBatch) {
    // ── Collect phase ──────────────────────────────────────────────────────
    // Per-segment iteration: every renderable segment with a texture either
    // joins the straight-batch fast path (unsplit cells with full-square
    // polygon — same texture group means one ctx.fill() for many cells) or
    // becomes a clippedWork entry that fills its polygon outline.
    //
    // straightBatches: { texId+texOp → { entry, texOp, rects[] } }
    // clippedWork:     { entry, texOp, polygon, tl }  (polygon is in cell-local [0..1] coords)
    const straightBatches = new Map();
    const clippedWork: Array<{
      entry: TextureRuntime;
      texOp: number;
      polygon: number[][];
      tl: { x: number; y: number };
    }> = [];

    const catalog = textureOptions?.catalog;
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        if (!roomCells[row]?.[col]) continue;
        const cell = cells[row]![col];
        if (!cell) continue;

        const renderable = getRenderableSegments(cell);
        if (renderable.length === 0) continue;

        const x = col * gridSize;
        const y = row * gridSize;
        const tl = toCanvas(x, y, transform);

        for (const seg of renderable) {
          const texId = seg.texture;
          if (!texId) continue;
          const entry = catalog?.textures[texId];
          if (!entry?.img?.complete || !entry.img.naturalWidth) continue;
          const texOp = seg.textureOpacity ?? 1.0;
          hasTexturedCells = true;

          if (isFullSquarePolygon(seg.polygon)) {
            const batchKey = `${texId}\x00${texOp}`;
            let batch = straightBatches.get(batchKey);
            if (!batch) {
              batch = { entry, texOp, rects: [] };
              straightBatches.set(batchKey, batch);
            }
            batch.rects.push(tl.x, tl.y);
          } else {
            clippedWork.push({ entry, texOp, polygon: seg.polygon, tl });
          }
        }
      }
    }

    // ── Straight batches: one fill per texture group ───────────────────────
    for (const { entry, texOp, rects } of straightBatches.values()) {
      const pattern = _getTexPattern(ctx, entry);
      _applyPatternTransform(pattern, entry, cellPx, transform, resolution);
      ctx.globalAlpha = texOp;
      ctx.fillStyle = pattern;
      ctx.beginPath();
      for (let i = 0; i < rects.length; i += 2) ctx.rect(rects[i], rects[i + 1], cellPx, cellPx);
      ctx.fill();
    }

    // ── Clipped cells: polygon pattern fill ────────────────────────────────
    // Each entry's polygon is in cell-local [0..1] coords; trace it onto the
    // canvas at the cell's top-left position. ctx.fill() on the polygon path
    // naturally clips the pattern — no ctx.clip()/save/restore needed.
    for (const item of clippedWork) {
      const { entry, texOp, polygon, tl } = item;
      const pattern = _getTexPattern(ctx, entry);
      _applyPatternTransform(pattern, entry, cellPx, transform, resolution);
      ctx.globalAlpha = texOp;
      ctx.fillStyle = pattern;
      ctx.beginPath();
      ctx.moveTo(tl.x + polygon[0]![0]! * cellPx, tl.y + polygon[0]![1]! * cellPx);
      for (let i = 1; i < polygon.length; i++) {
        ctx.lineTo(tl.x + polygon[i]![0]! * cellPx, tl.y + polygon[i]![1]! * cellPx);
      }
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalAlpha = 1.0;
  } else {
    // ── Fallback: per-cell drawImage (PDF renderer / no DOMMatrix) ─────────
    // Same per-segment iteration as the batched path. For each renderable
    // segment with a texture, clip to its polygon and drawImage the source.
    const catalog = textureOptions?.catalog;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        if (!roomCells[row]![col]) continue;
        const cell = cells[row]![col];
        if (!cell) continue;

        const renderable = getRenderableSegments(cell);
        if (renderable.length === 0) continue;

        const x = col * gridSize;
        const y = row * gridSize;
        const p1 = toCanvas(x, y, transform);

        for (const seg of renderable) {
          const texId = seg.texture;
          if (!texId) continue;
          const entry = catalog?.textures[texId];
          if (!entry?.img?.complete || !entry.img.naturalWidth) continue;
          const { srcX, srcY, srcW, srcH } = getTexChunk(entry, row, col);
          const texOp = seg.textureOpacity ?? 1.0;
          ctx.save();
          ctx.globalAlpha = texOp;
          if (!isFullSquarePolygon(seg.polygon)) {
            ctx.beginPath();
            ctx.moveTo(p1.x + seg.polygon[0]![0]! * cellPx, p1.y + seg.polygon[0]![1]! * cellPx);
            for (let i = 1; i < seg.polygon.length; i++) {
              ctx.lineTo(p1.x + seg.polygon[i]![0]! * cellPx, p1.y + seg.polygon[i]![1]! * cellPx);
            }
            ctx.closePath();
            ctx.clip();
          }
          ctx.drawImage(entry.img, srcX, srcY, srcW, srcH, p1.x, p1.y, cellPx, cellPx);
          ctx.restore();
          hasTexturedCells = true;
        }
      }
    }
  }

  return hasTexturedCells;
}

/**
 * Blend textures at cell boundaries using height-based splatting.
 * Uses a two-level cache:
 *  L1 — Per-edge/corner ImageBitmap (zoom-independent, rebuilt on topology change)
 *  L2 — Viewport blend layer (screen-res OffscreenCanvas, rebuilt on camera change)
 * Falls back to per-frame scratch canvas rendering for PDF path or missing bitmaps.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {Object|null} textureOptions - Texture catalog and blend settings
 * @param {Object|null} [cacheSize=null] - Cache dimensions {w, h, scale}
 * @returns {void}
 */
export function renderTextureBlending(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  transform: RenderTransform,
  textureOptions: TextureOptions | null,
  cacheSize: { w: number; h: number; scale?: number } | null = null,
): void {
  const blendWidth = textureOptions?.blendWidth ?? 0.35;
  if (blendWidth <= 0) return;

  const topo = getBlendTopoCache(cells, roomCells, gridSize, textureOptions!);
  if (!topo || (!topo.edges?.length && !topo.corners?.length)) return;

  const { scale: sc, offsetX: ox, offsetY: oy } = transform;
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;

  // ── Cache-mode fast path: pre-rendered blend layer at cache resolution ──
  if (cacheSize) {
    const blendLayer = getRenderedBlendLayer(topo, gridSize, cacheSize.w, cacheSize.h, cacheSize.scale);
    if (blendLayer) {
      ctx.drawImage(blendLayer, 0, 0);
      return;
    }
  }

  // ── L2 fast path: all bitmaps ready → single drawImage ──
  const allBitmapsReady =
    topo.edges!.every((e) => (e as unknown as { bitmap?: unknown }).bitmap) &&
    topo.corners!.every((c) => (c as unknown as { bitmap?: unknown }).bitmap);
  if (allBitmapsReady) {
    const layer = getViewportBlendLayer(canvasW, canvasH, transform, topo, gridSize);
    if (layer) {
      ctx.drawImage(layer, 0, 0);
      return;
    }
  }

  // ── Fallback: per-element rendering (PDF path, or some bitmaps missing) ──
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const vx0 = -transform.offsetX / transform.scale;
  const vy0 = -transform.offsetY / transform.scale;
  const vx1 = (canvasW - transform.offsetX) / transform.scale;
  const vy1 = (canvasH - transform.offsetY) / transform.scale;
  const rowMin = Math.max(0, Math.floor(vy0 / gridSize) - 2);
  const rowMax = Math.min(numRows - 1, Math.ceil(vy1 / gridSize) + 2);
  const colMin = Math.max(0, Math.floor(vx0 / gridSize) - 2);
  const colMax = Math.min(numCols - 1, Math.ceil(vx1 / gridSize) + 2);

  const cellPx = gridSize * sc;
  const blendPx = blendWidth * cellPx;
  const bsz = BLEND_BITMAP_SIZE;

  {
    // ── Edge pass ──
    for (const edge of topo.edges!) {
      if (edge.row < rowMin || edge.row > rowMax || edge.col < colMin || edge.col > colMax) continue;

      const screenX = edge.col * gridSize * sc + ox;
      const screenY = edge.row * gridSize * sc + oy;
      const cpx = Math.ceil(cellPx);

      if (edge.bitmap) {
        // L1 fast path: cached ImageBitmap (no gradient work)
        ctx.save();
        ctx.setTransform(sc, 0, 0, sc, ox, oy);
        ctx.clip(edge.clipPath);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = edge.neighborOpacity;
        ctx.drawImage(edge.bitmap, 0, 0, bsz, bsz, screenX, screenY, cpx, cpx);
        ctx.restore();
      } else {
        const scratch = getBlendScratch(cellPx);
        if (scratch) {
          // Per-frame scratch canvas (texture still loading)
          const sctx = scratch.getContext('2d')!;
          sctx.clearRect(0, 0, cellPx, cellPx);
          sctx.globalCompositeOperation = 'source-over';
          sctx.drawImage(edge.neighborEntry.img, edge.srcX, edge.srcY, edge.srcW, edge.srcH, 0, 0, cellPx, cellPx);

          let sg!: CanvasGradient;
          switch (edge.direction) {
            case 'north':
              sg = sctx.createLinearGradient(0, 0, 0, blendPx);
              break;
            case 'south':
              sg = sctx.createLinearGradient(0, cellPx, 0, cellPx - blendPx);
              break;
            case 'west':
              sg = sctx.createLinearGradient(0, 0, blendPx, 0);
              break;
            case 'east':
              sg = sctx.createLinearGradient(cellPx, 0, cellPx - blendPx, 0);
              break;
          }
          sg.addColorStop(0, 'rgba(0,0,0,0)');
          sg.addColorStop(1, 'rgba(0,0,0,1)');
          sctx.globalCompositeOperation = 'destination-out';
          sctx.fillStyle = sg;
          sctx.fillRect(0, 0, cellPx, cellPx);

          ctx.save();
          ctx.setTransform(sc, 0, 0, sc, ox, oy);
          ctx.clip(edge.clipPath);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = edge.neighborOpacity;
          ctx.drawImage(scratch, 0, 0, cpx, cpx, screenX, screenY, cpx, cpx);
          ctx.restore();
        } else {
          // PDF fallback (no OffscreenCanvas)
          ctx.save();
          ctx.setTransform(sc, 0, 0, sc, ox, oy);
          ctx.clip(edge.clipPath);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = edge.neighborOpacity * PDF_EDGE_FALLBACK_OPACITY;
          ctx.drawImage(
            edge.neighborEntry.img,
            edge.srcX,
            edge.srcY,
            edge.srcW,
            edge.srcH,
            screenX,
            screenY,
            cellPx,
            cellPx,
          );
          ctx.restore();
        }
      }
    }

    // ── Corner pass ──
    for (const cn of topo.corners!) {
      if (cn.row < rowMin || cn.row > rowMax || cn.col < colMin || cn.col > colMax) continue;

      const screenX = cn.col * gridSize * sc + ox;
      const screenY = cn.row * gridSize * sc + oy;
      const cpx = Math.ceil(cellPx);

      if (cn.bitmap) {
        // L1 fast path: cached ImageBitmap
        ctx.save();
        ctx.setTransform(sc, 0, 0, sc, ox, oy);
        ctx.clip(cn.clipPath);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = cn.neighborOpacity;
        ctx.drawImage(cn.bitmap, 0, 0, bsz, bsz, screenX, screenY, cpx, cpx);
        ctx.restore();
      } else {
        const scratch = getBlendScratch(cellPx);
        if (scratch) {
          // Per-frame scratch canvas (texture still loading)
          const sctx = scratch.getContext('2d')!;
          sctx.clearRect(0, 0, cellPx, cellPx);
          sctx.globalCompositeOperation = 'source-over';
          sctx.drawImage(cn.neighborEntry.img, cn.srcX, cn.srcY, cn.srcW, cn.srcH, 0, 0, cellPx, cellPx);

          const scratchCX = (cn.localCX / gridSize) * cellPx;
          const scratchCY = (cn.localCY / gridSize) * cellPx;
          const sg = sctx.createRadialGradient(scratchCX, scratchCY, 0, scratchCX, scratchCY, blendPx);
          sg.addColorStop(0, 'rgba(0,0,0,0)');
          sg.addColorStop(1, 'rgba(0,0,0,1)');
          sctx.globalCompositeOperation = 'destination-out';
          sctx.fillStyle = sg!;
          sctx.fillRect(0, 0, cellPx, cellPx);

          ctx.save();
          ctx.setTransform(sc, 0, 0, sc, ox, oy);
          ctx.clip(cn.clipPath);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = cn.neighborOpacity;
          ctx.drawImage(scratch, 0, 0, cpx, cpx, screenX, screenY, cpx, cpx);
          ctx.restore();
        } else {
          // PDF fallback
          ctx.save();
          ctx.setTransform(sc, 0, 0, sc, ox, oy);
          ctx.clip(cn.clipPath);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = cn.neighborOpacity * PDF_CORNER_FALLBACK_OPACITY;
          ctx.drawImage(cn.neighborEntry.img, cn.srcX, cn.srcY, cn.srcW, cn.srcH, screenX, screenY, cellPx, cellPx);
          ctx.restore();
        }
      }
    }
  }
}

// Fluid rendering has been moved to a dedicated composite sublayer — see
// `buildFluidComposite` in `./fluid.js`. The grid phase is handled directly
// in `renderCells` (see `render-cells.ts`), so no function is needed here.

/**
 * Draw hazard triangles as the topmost overlay — renders above walls, props, and labels.
 * Checks both cell.hazard (new format) and cell.fill === 'difficult-terrain' (legacy).
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {void}
 */
export function renderHazardOverlay(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  gridSize: number,
  transform: RenderTransform,
): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (!cell) continue;
      if (!cell.hazard && (cell.fill as string) !== 'difficult-terrain') continue;

      const x = col * gridSize;
      const y = row * gridSize;
      const p = toCanvas(x, y, transform);
      const cellPx = gridSize * transform.scale;

      ctx.save();
      const size = cellPx * 0.3;
      const h = size * (Math.sqrt(3) / 2);
      const cx = p.x + cellPx - size * 0.75;
      const cy = p.y + h * 0.75;

      const top = { x: cx, y: cy - h * 0.55 };
      const left = { x: cx - size / 2, y: cy + h * 0.45 };
      const right = { x: cx + size / 2, y: cy + h * 0.45 };

      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(right.x, right.y);
      ctx.lineTo(left.x, left.y);
      ctx.closePath();
      ctx.fillStyle = HAZARD_COLOR;
      ctx.fill();
      ctx.strokeStyle = '#222222';
      ctx.lineWidth = Math.max(1, cellPx * 0.04);
      ctx.lineJoin = 'round';
      ctx.stroke();

      const bangW = Math.max(1, cellPx * 0.04);
      const bangTop = cy - h * 0.22;
      const bangBot = cy + h * 0.12;
      const dotY = cy + h * 0.25;
      const dotR = bangW * 0.7;

      ctx.fillStyle = '#222222';
      ctx.strokeStyle = '#222222';
      ctx.lineWidth = bangW;
      ctx.lineCap = 'round';

      ctx.beginPath();
      ctx.moveTo(cx, bangTop);
      ctx.lineTo(cx, bangBot);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, dotY, dotR, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }
}

/**
 * Draw buffer shading, wall segments (with shadows), non-wall borders, and arc walls.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme object
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {boolean} [showInvisible=false] - When true, render invisible walls/doors in ghost style
 * @param {Object|null} [visibleBounds=null] - Viewport bounds for culling
 * @param {number} [_res=1] - Resolution multiplier for sub-cells
 * @returns {void}
 */
export function renderWallsAndBorders(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  showInvisible: boolean = false,
  visibleBounds: VisibleBounds | null = null,
  _res: number = 1,
): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  drawBufferShading(ctx, cells, roomCells, gridSize, theme, transform);

  // Collect wall ('w') segments for batched rendering; draw non-wall borders immediately
  const wallSegments = [];
  const deferredDiagDoors = []; // rendered after wall batch to avoid overdraw
  const WALL_DIRS = ['north', 'south', 'east', 'west'];

  const startRow = visibleBounds?.minRow ?? 0;
  const endRow = visibleBounds?.maxRow ?? numRows - 1;
  const startCol = visibleBounds?.minCol ?? 0;
  const endCol = visibleBounds?.maxCol ?? numCols - 1;

  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      const cell = cells[row]?.[col];
      if (!cell) continue;

      // Cardinal borders with double door auto-detection
      const borders: [string, number, number, number, number, string][] = [
        ['north', col, row, col + 1, row, 'horizontal'],
        ['south', col, row + 1, col + 1, row + 1, 'horizontal'],
        ['east', col + 1, row, col + 1, row + 1, 'vertical'],
        ['west', col, row, col, row + 1, 'vertical'],
      ];
      for (const [dir, x1, y1, x2, y2, orient] of borders) {
        const bt = getEdge(cell, dir as Direction) as string;
        if (!bt) continue;
        if (bt === 'd' || bt === 's') {
          const role = getDoubleDoorRole(cells, row, col, dir, _res);
          if (role === 'partner') continue;
          if (role === 'anchor') {
            renderDoubleBorder(ctx, cells, row, col, dir, bt, orient, theme, gridSize, transform, _res);
            continue;
          }
          if (role === 'single-wide') {
            // Render a single door spanning one display cell (resolution sub-cells)
            // Extend the wall segment coordinates to cover the full display cell width
            const wx1 = x1,
              wy1 = y1;
            let wx2 = x2,
              wy2 = y2;
            if (orient === 'horizontal') {
              wx2 = x1 + _res; // extend cols by resolution
            } else {
              wy2 = y1 + _res; // extend rows by resolution
            }
            renderBorder(ctx, wx1, wy1, wx2, wy2, bt, orient, theme, gridSize, transform);
            continue;
          }
        }
        if (bt === 'w') {
          // Deduplicate shared edges: south/east walls are the same physical edge
          // as the neighbor's north/west. Skip if neighbor owns the reciprocal.
          if (dir === 'south' && cells[row + 1]?.[col]?.north === 'w') continue;
          if (dir === 'east' && cells[row]?.[col + 1]?.west === 'w') continue;
          const { p1, p2 } = wallSegmentCoords(x1, y1, x2, y2, gridSize, transform);
          const dirIdx = WALL_DIRS.indexOf(dir);
          const seed = (row * 1000 + col) * 6 + dirIdx;
          wallSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, seed });
        } else if (bt === 'win') {
          // Window: NOT added to the wall-segments batch. The window overlay
          // pass below paints the full window symbol (glass pane + frame +
          // mullions) directly on the edge. Flanking 'w' cells still draw
          // their own wall segments up to the window's edge.
          continue;
        } else if (bt === 'iw') {
          // Invisible wall: skip unless showInvisible (deduplicate same as 'w')
          if (!showInvisible) continue;
          if (dir === 'south' && cells[row + 1]?.[col]?.north === 'iw') continue;
          if (dir === 'east' && cells[row]?.[col + 1]?.west === 'iw') continue;
          renderBorder(ctx, x1, y1, x2, y2, bt, orient, theme, gridSize, transform);
        } else if (bt === 'id') {
          // Invisible door: skip unless showInvisible
          if (!showInvisible) continue;
          renderBorder(ctx, x1, y1, x2, y2, bt, orient, theme, gridSize, transform);
        } else {
          renderBorder(ctx, x1, y1, x2, y2, bt, orient, theme, gridSize, transform);
        }
      }

      // Diagonal borders — collect doors for deferred rendering, walls handled below.
      // Skip cells whose interior edge is a chord (the chord-stroke pass
      // owns those — they're not straight corner-to-corner diagonals).
      if (cellHasChordEdge(cell)) continue;
      for (const diag of ['nw-se', 'ne-sw'] as const) {
        const bt = getEdge(cell, diag);
        if (!bt) continue;
        if (bt === 'd' || bt === 's') {
          const role = getDoubleDoorDiagonalRole(cells, row, col, diag, _res);
          if (role === 'partner') continue;
          deferredDiagDoors.push({ role, row, col, bt, diag });
        } else if (bt === 'iw' || bt === 'id') {
          if (!showInvisible) continue;
          renderDiagonalBorder(ctx, col, row, bt, diag, theme, gridSize, transform);
        }
        // 'w' walls are handled by the merged diagonal wall pass below
      }
    }
  }

  // Merge diagonal sub-cells into continuous wall segments.
  // Includes door cells ('d','s') so the wall line is unbroken — doors paint
  // gaps on top. Windows ('win') are NOT included — the window overlay pass
  // draws the full window symbol on top of the bare edge.
  let _diagMergeCount = 0;
  const diagSeen = new Set();
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      for (const diag of ['nw-se', 'ne-sw'] as const) {
        const cell = cells[row]?.[col];
        if (!cell) continue;
        // Skip chord-bearing cells — those are drawn by the chord-stroke pass.
        if (cellHasChordEdge(cell)) continue;
        const bt = getEdge(cell, diag);
        if (!bt) continue;
        if (bt !== 'w' && bt !== 'd' && bt !== 's') continue;
        const key = `${row},${col},${diag}`;
        if (diagSeen.has(key)) continue;

        // Walk forward along the diagonal to find the full run (walls + doors)
        const dr = diag === 'nw-se' ? 1 : 1;
        const dc = diag === 'nw-se' ? 1 : -1;
        let runLen = 0;
        let r = row,
          c = col;
        while (r >= 0 && r < numRows && c >= 0 && c < numCols) {
          const cc = cells[r]?.[c];
          if (!cc) break;
          if (cellHasChordEdge(cc)) break;
          const v = getEdge(cc, diag);
          if (v !== 'w' && v !== 'd' && v !== 's') break;
          diagSeen.add(`${r},${c},${diag}`);
          runLen++;
          r += dr;
          c += dc;
        }

        // Build one long segment from start to end of run
        let fx1, fy1, fx2, fy2;
        if (diag === 'nw-se') {
          fx1 = col * gridSize;
          fy1 = row * gridSize;
          fx2 = (col + runLen) * gridSize;
          fy2 = (row + runLen) * gridSize;
        } else {
          fx1 = (col + 1) * gridSize;
          fy1 = row * gridSize;
          fx2 = (col + 1 - runLen) * gridSize;
          fy2 = (row + runLen) * gridSize;
        }
        const p1 = toCanvas(fx1, fy1, transform);
        const p2 = toCanvas(fx2, fy2, transform);
        const seed = (row * 1000 + col) * 6 + (diag === 'nw-se' ? 4 : 5);
        wallSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, seed });
        _diagMergeCount++;
      }
    }
  }
  if (_diagMergeCount > 0) renderTimings._diagMerged = { ms: _diagMergeCount, frame: getTimingFrame() };

  // Draw all wall segments — shadow pass first, then walls on top
  if (wallSegments.length > 0) {
    const s = scaleFactor(transform);
    drawWallShadow(ctx, wallSegments, theme, transform);

    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;
    if (theme.wallRoughness && theme.wallRoughness > 0) {
      drawRoughWalls(ctx, wallSegments, theme, transform);
    } else {
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      for (const seg of wallSegments) {
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
      }
      ctx.stroke();
    }
  }

  // Deferred diagonal doors — drawn after wall batch so walls don't cover door gaps
  for (const { role, row, col, bt, diag } of deferredDiagDoors) {
    if (role === 'anchor') {
      renderDiagonalDoubleBorder(ctx, cells, row, col, bt, diag, theme, gridSize, transform, _res);
    } else if (role === 'single-wide') {
      renderDiagonalBorder(ctx, col, row, bt, diag, theme, gridSize, transform, _res);
    } else {
      // null role = single sub-cell door
      renderDiagonalBorder(ctx, col, row, bt, diag, theme, gridSize, transform);
    }
  }

  // Per-cell chord walls — stroke the polyline `cell.interiorEdges[0].vertices`
  // for any chord-shaped interior edge. The chord is drawn unconditionally
  // for visible walls (`wall === 'w'` or `null`); `wall` otherwise controls
  // connectivity (can a token cross), not visual presence. Open trims
  // (`wall == null`) still render the architectural outline — they're just
  // passable. Invisible chord walls (`wall === 'iw'`) skip the stroke entirely
  // so they're hidden from view (matching cardinal `iw` semantics). Straight
  // corner-to-corner diagonals are handled by the diagonal merge pass above
  // and rejected here by `isChordEdge`.
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      const cell = cells[row]?.[col];
      if (!cell) continue;
      const ie = getInteriorEdges(cell)[0];
      if (!ie || !isChordEdge(ie)) continue;
      if (ie.wall === 'iw') continue;
      const wall = ie.vertices;
      const cx = col * gridSize,
        cy = row * gridSize;
      const s = scaleFactor(transform);

      // Shadow pass
      if (theme.wallShadow) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 8 * s;
        ctx.lineCap = 'round';
        const sx = 2 * s,
          sy = 2 * s;
        ctx.beginPath();
        const p0s = toCanvas(
          cx + (wall[0]![0] as number) * gridSize + sx / transform.scale,
          cy + (wall[0]![1] as number) * gridSize + sy / transform.scale,
          transform,
        );
        ctx.moveTo(p0s.x, p0s.y);
        for (let i = 1; i < wall.length; i++) {
          const p = toCanvas(
            cx + (wall[i]![0] as number) * gridSize + sx / transform.scale,
            cy + (wall[i]![1] as number) * gridSize + sy / transform.scale,
            transform,
          );
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Wall stroke
      ctx.save();
      ctx.strokeStyle = theme.wallStroke;
      ctx.lineWidth = 6 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const p0 = toCanvas(cx + (wall[0]![0] as number) * gridSize, cy + (wall[0]![1] as number) * gridSize, transform);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < wall.length; i++) {
        const p = toCanvas(cx + (wall[i]![0] as number) * gridSize, cy + (wall[i]![1] as number) * gridSize, transform);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── Window overlay pass ──────────────────────────────────────────────────
  // Each run of adjacent 'win' edges along the same line renders as a single
  // wide window symbol, drawn on top of the continuous wall stroke.
  // Cardinals use canonical north/west (south/east are rendered by the
  // neighbor cell's north/west entry). Diagonals have no reciprocal, so each
  // cell owns its own diagonal edge.
  {
    const windowSeen = new Set<string>();
    const winDirs: { dir: 'north' | 'west' | 'nw-se' | 'ne-sw'; dr: number; dc: number }[] = [
      { dir: 'north', dr: 0, dc: 1 },
      { dir: 'west', dr: 1, dc: 0 },
      { dir: 'nw-se', dr: 1, dc: 1 },
      { dir: 'ne-sw', dr: 1, dc: -1 },
    ];
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const cell = cells[row]?.[col];
        if (!cell) continue;
        for (const { dir, dr, dc } of winDirs) {
          if (getEdge(cell, dir) !== 'win') continue;
          const key = `${dir}|${row}|${col}`;
          if (windowSeen.has(key)) continue;
          // Walk backward to find the run start (stops at non-win or missing cell).
          let sr = row;
          let sc = col;
          for (;;) {
            const pr = sr - dr;
            const pc = sc - dc;
            const prev = cells[pr]?.[pc];
            if (!prev || getEdge(prev, dir) !== 'win') break;
            sr = pr;
            sc = pc;
          }
          // Walk forward to measure length and mark cells visited.
          let runLen = 0;
          let er = sr;
          let ec = sc;
          for (;;) {
            const c = cells[er]?.[ec];
            if (!c || getEdge(c, dir) !== 'win') break;
            windowSeen.add(`${dir}|${er}|${ec}`);
            runLen++;
            er += dr;
            ec += dc;
          }
          renderWindowRun(ctx, sr, sc, dir, runLen, theme, gridSize, transform);
        }
      }
    }
  }
}

/**
 * Draw room labels and DM labels. Exported so callers can invoke this as a separate
 * post-lighting pass, keeping labels unaffected by the multiply lightmap overlay.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme object
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {string} labelStyle - Label style ('circled', 'plain', 'bold')
 * @returns {void}
 */
export function renderLabels(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  labelStyle: string,
): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const style = labelStyle || 'circled';

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]![col];
      if (cell?.center?.label || cell?.center?.dmLabel) {
        // Use labelX/labelY (world feet) if set, otherwise default to cell center
        const labelX = cell.center.labelX ?? (col + 0.5) * gridSize;
        const labelY = cell.center.labelY ?? (row + 0.5) * gridSize;
        const p = toCanvas(labelX, labelY, transform);

        if (cell.center.label) {
          drawCellLabel(ctx, p.x, p.y, cell.center.label, theme, style, transform.scale);
        }

        // DM labels: use dmLabelX/dmLabelY if set, otherwise same position
        if (cell.center.dmLabel) {
          const dmX = (cell.center.dmLabelX as number | undefined) ?? (col + 0.5) * gridSize;
          const dmY = (cell.center.dmLabelY as number | undefined) ?? (row + 0.5) * gridSize;
          const dp = toCanvas(dmX, dmY, transform);
          drawDmLabel(ctx, dp.x, dp.y, cell.center.dmLabel, transform.scale);
        }
      }
    }
  }
}

/**
 * Draw props, room/DM labels, and stairs (both new shape-based and legacy per-cell).
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme object
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {string} labelStyle - Label style ('circled', 'plain', 'bold')
 * @param {Object|null} propCatalog - Prop catalog with definitions
 * @param {Object|null} textureOptions - Texture catalog and blend settings
 * @param {Object} metadata - Dungeon metadata with props, stairs, etc.
 * @param {boolean} [skipLabels=false] - Skip label rendering (drawn after lightmap instead)
 * @param {Object|null} [visibleBounds=null] - Viewport bounds for culling
 * @param {Object|null} [cacheSize=null] - Cache dimensions {w, h, scale}
 * @returns {void}
 */
export function renderLabelsStairsProps(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  labelStyle: string,
  propCatalog: PropCatalog | null,
  textureOptions: TextureOptions | null,
  metadata: Metadata | null,
  skipLabels: boolean = false,
  visibleBounds: VisibleBounds | null = null,
  cacheSize: { w: number; h: number; scale?: number } | null = null,
): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  // Props (furniture, objects)
  const getTextureImage: ((id: string) => HTMLImageElement | null) | null = textureOptions?.catalog
    ? (id: string) => {
        const e = textureOptions.catalog.textures[id];
        return e?.img?.complete ? (e.img as HTMLImageElement) : null;
      }
    : null;

  // Try pre-rendered props layer cache
  const propsLayer = cacheSize
    ? getRenderedPropsLayer(
        cells,
        gridSize,
        theme,
        propCatalog,
        getTextureImage,
        textureOptions?.texturesVersion ?? 0,
        metadata,
        cacheSize.w,
        cacheSize.h,
        cacheSize.scale,
      )
    : null;
  if (propsLayer) {
    ctx.drawImage(propsLayer, 0, 0);
  } else {
    renderAllProps(
      ctx,
      cells,
      gridSize,
      theme,
      transform,
      propCatalog,
      getTextureImage,
      textureOptions?.texturesVersion ?? 0,
      visibleBounds,
      metadata,
    );
  }

  // Room labels and DM labels — skipped when lighting is enabled so they can be
  // drawn after the lightmap, keeping them unaffected by the multiply overlay.
  if (!skipLabels) {
    renderLabels(ctx, cells, gridSize, theme, transform, labelStyle);
  }

  // Stairs — new system: metadata.stairs[] array of shape definitions
  const stairDefs = metadata?.stairs ?? [];

  for (const stairDef of stairDefs) {
    drawStairShape(ctx, stairDef, theme, gridSize, transform);

    if (stairDef.link) {
      let minRow = Infinity,
        minCol = Infinity;
      for (const [r, c] of stairDef.points) {
        if (r < minRow) minRow = r;
        if (c < minCol) minCol = c;
      }
      drawStairShapeLinkLabel(ctx, minCol * gridSize, minRow * gridSize, stairDef.link, theme, transform);
    }
  }

  // Legacy fallback: old per-cell stairs for unmigrated files
  if (stairDefs.length === 0) {
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const cell = cells[row]![col];
        if (!cell?.center) continue;
        const centerX = (col + 0.5) * gridSize;
        const centerY = (row + 0.5) * gridSize;
        const p = toCanvas(centerX, centerY, transform);
        const hasLabel = !!cell.center.label;
        const s = transform.scale / 10;

        if (cell.center['stairs-up']) {
          drawStairsInCell(ctx, p.x, p.y, 'stairs-up', theme, gridSize, hasLabel, transform);
        }
        if (cell.center['stairs-down']) {
          const offsetX = cell.center['stairs-up'] ? 15 * s : 0;
          const offsetY = cell.center['stairs-up'] ? 15 * s : 0;
          drawStairsInCell(ctx, p.x + offsetX, p.y + offsetY, 'stairs-down', theme, gridSize, hasLabel, transform);
        }
        if (cell.center['stairs-link']) {
          drawStairsLinkLabel(ctx, p.x, p.y, cell.center['stairs-link'] as string, theme, transform);
        }
      }
    }
  }
}
