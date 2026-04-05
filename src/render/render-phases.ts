import type { CellGrid, Theme, RenderTransform, VisibleBounds } from '../types.js';
import { toCanvas } from './bounds.js';
import { renderTimings, getTimingFrame } from './render-state.js';
import { withTrimVoidClip } from './render-cache.js';
import { getDiagonalTrimCorner } from './floors.js';
import { renderBorder, getDoubleDoorRole, getDoubleDoorDiagonalRole, renderDoubleBorder, renderDiagonalBorder, renderDiagonalDoubleBorder, drawStairsInCell, drawStairsLinkLabel, drawStairShape, drawStairShapeLinkLabel, wallSegmentCoords, scaleFactor } from './borders.js';
import { drawCellLabel, drawDmLabel } from './features.js';
import { drawMatrixGrid } from './decorations.js';
import { renderAllProps, getRenderedPropsLayer } from './props.js';
import { drawWallShadow, drawRoughWalls, drawBufferShading } from './effects.js';
import { getFluidPathCache, getRenderedFluidLayer } from './fluid.js';
import { getBlendTopoCache, getBlendScratch, getViewportBlendLayer, getRenderedBlendLayer, BLEND_BITMAP_SIZE, PDF_EDGE_FALLBACK_OPACITY, PDF_CORNER_FALLBACK_OPACITY, getTexChunk } from './blend.js';

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

function _getTexPattern(ctx: any, entry: any) {
  if (!entry._pattern || entry._patternCtx !== ctx) {
    entry._pattern = ctx.createPattern(entry.img, 'repeat');
    entry._patternCtx = ctx;
  }
  return entry._pattern;
}

function _applyPatternTransform(pattern: any, entry: any, cellPx: any, transform: any, resolution = 1) {
  const img = entry.img;
  const cw = Math.max(1, Math.floor(img.naturalWidth  / 256));
  const ch = Math.max(1, Math.floor(img.naturalHeight / 256));
  // Scale: one chunk (srcW × srcH texture pixels) → one display cell.
  // Multiply cellPx by resolution so the texture tiles at the display-cell size
  // (5ft) rather than the internal cell size (2.5ft).
  const displayCellPx = cellPx * resolution;
  const srcW = Math.floor(img.naturalWidth  / cw);
  const srcH = Math.floor(img.naturalHeight / ch);
  pattern.setTransform(new DOMMatrix([
    displayCellPx / srcW, 0, 0, displayCellPx / srcH,
    transform.offsetX, transform.offsetY,
  ]));
}

/**
 * Fill room backgrounds and render per-cell texture overlays.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme object with floor colors
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {Object|null} textureOptions - Texture catalog and blend settings
 * @param {HTMLImageElement|null} [bgImageEl=null] - Background image element
 * @param {Object|null} [bgImgConfig=null] - Background image config
 * @param {Object|null} [visibleBounds=null] - Viewport bounds for culling
 * @param {number} [resolution=1] - Resolution multiplier for sub-cells
 * @returns {boolean} True if any textured cells were drawn
 */
export function renderFloors(ctx: CanvasRenderingContext2D, cells: CellGrid, roomCells: boolean[][], gridSize: number, theme: Theme, transform: RenderTransform, textureOptions: any, bgImageEl: any = null, bgImgConfig: any = null, visibleBounds: VisibleBounds | null = null, resolution: number = 1): boolean {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const startRow = visibleBounds?.minRow ?? 0;
  const endRow = visibleBounds?.maxRow ?? (numRows - 1);
  const startCol = visibleBounds?.minCol ?? 0;
  const endCol = visibleBounds?.maxCol ?? (numCols - 1);
  let hasTexturedCells = false;
  const displayCellFeet = gridSize * resolution;  // size of one display cell in feet

  // Pass 1: Build a single floor path covering all room cells, fill once.
  // Step by `resolution` to draw display-cell-sized rects — reduces canvas commands by 4x.
  // Trim corners fall back to per-sub-cell triangular clips.
  const step = resolution;
  const cellPxDisplay = displayCellFeet * transform.scale;
  const cellPxSub = gridSize * transform.scale;
  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = theme.wallFill;
  ctx.beginPath();
  // Snap iteration to display-cell boundaries for coalescing
  const floorStartRow = Math.floor(startRow / step) * step;
  const floorStartCol = Math.floor(startCol / step) * step;
  for (let row = floorStartRow; row <= endRow; row += step) {
    for (let col = floorStartCol; col <= endCol; col += step) {
      // Check sub-cells in this display cell
      let floorCount = 0, hasTrim = false;
      const totalSub = step * step;
      for (let dr = 0; dr < step && !hasTrim; dr++) {
        for (let dc = 0; dc < step; dc++) {
          const sr = row + dr, sc = col + dc;
          if (!roomCells[sr]?.[sc]) continue;
          const c = cells[sr]?.[sc];
          if (c?.trimShowExteriorOnly) continue;
          floorCount++;
          if (c && (getDiagonalTrimCorner(c, cells, sr, sc) || c.trimClip)) { hasTrim = true; break; }
        }
      }
      if (!floorCount) continue;

      if (!hasTrim && floorCount === totalSub) {
        // Fast path: all sub-cells are floor, draw one display-cell-sized rect
        const p1 = toCanvas(col * gridSize, row * gridSize, transform);
        ctx.rect(p1.x, p1.y, cellPxDisplay, cellPxDisplay);
      } else {
        // Slow path: per-sub-cell for trim corners
        for (let dr = 0; dr < step; dr++) {
          for (let dc = 0; dc < step; dc++) {
            const sr = row + dr, sc = col + dc;
            if (!roomCells[sr]?.[sc]) continue;
            const cell = cells[sr]?.[sc];
            if (!cell || cell.trimShowExteriorOnly) continue;
            const x = sc * gridSize, y = sr * gridSize;
            const trimCorner = getDiagonalTrimCorner(cell, cells, sr, sc);
            if (trimCorner && !cell.trimWall && !cell.trimOpen) {
              const tl = toCanvas(x, y, transform);
              const tr = toCanvas(x + gridSize, y, transform);
              const bl = toCanvas(x, y + gridSize, transform);
              const br = toCanvas(x + gridSize, y + gridSize, transform);
              switch (trimCorner) {
                case 'nw': ctx.moveTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y); break;
                case 'ne': ctx.moveTo(tl.x, tl.y); ctx.lineTo(bl.x, bl.y); ctx.lineTo(br.x, br.y); break;
                case 'sw': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); break;
                case 'se': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y); break;
              }
              ctx.closePath();
            } else if (cell.trimClip) {
              if (cell.trimOpen && !cell.trimHideExterior && !cell.trimShowExteriorOnly) {
                // Open trim, both sides visible — draw full cell rect
                const p1 = toCanvas(x, y, transform);
                ctx.rect(p1.x, p1.y, cellPxSub, cellPxSub);
              } else if ((cell.textureSecondary || cell.trimOpen) && !cell.trimHideExterior && !cell.trimShowExteriorOnly) {
                // Closed trim with secondary texture: both halves need floor base color
                const p1 = toCanvas(x, y, transform);
                ctx.rect(p1.x, p1.y, cellPxSub, cellPxSub);
              } else {
                // Closed trim, room side only
                const clip = cell.trimClip;
                const gs = cellPxSub;
                const px = toCanvas(x, y, transform);
                ctx.moveTo(px.x + clip[0][0] * gs, px.y + clip[0][1] * gs);
                for (let i = 1; i < clip.length; i++) {
                  ctx.lineTo(px.x + clip[i][0] * gs, px.y + clip[i][1] * gs);
                }
                ctx.closePath();
              }
            } else {
              const p1 = toCanvas(x, y, transform);
              ctx.rect(p1.x, p1.y, cellPxSub, cellPxSub);
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
    const imgW = bgImageEl.naturalWidth  * cellPx / bgImgConfig.pixelsPerCell;
    const imgH = bgImageEl.naturalHeight * cellPx / bgImgConfig.pixelsPerCell;
    const imgX = transform.offsetX + bgImgConfig.offsetX * cellPx;
    const imgY = transform.offsetY + bgImgConfig.offsetY * cellPx;
    ctx.save();
    ctx.clip(); // clip to the Pass 1 floor path — respects fog in player view, trim shapes in both
    ctx.globalAlpha = bgImgConfig.opacity ?? 0.5;
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
    // straightBatches: simple rect cells grouped by (texId, opacity) — one fill call per group.
    // clippedWork:     cells needing a triangular fill (trim corners, half-texture diagonals).
    const straightBatches = new Map(); // `${texId}\x00${texOp}` → { entry, texOp, rects[] }
    const clippedWork = [];            // { entry, texOp, clipType, tl, tr, bl, br }

    const catalog = textureOptions?.catalog;
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        if (!roomCells[row]?.[col]) continue;
        const cell = cells[row][col];
        if (!cell) continue;
        if (cell.trimShowExteriorOnly) continue; // exterior-only: skip interior face fill
        const x = col * gridSize;
        const y = row * gridSize;
        const trimCorner = getDiagonalTrimCorner(cell, cells, row, col);
        const p1 = toCanvas(x, y, transform);
        const tl = p1;
        const tr = toCanvas(x + gridSize, y, transform);
        const bl = toCanvas(x, y + gridSize, transform);
        const br = toCanvas(x + gridSize, y + gridSize, transform);

        const hasNWSE = !!cell['nw-se'];
        const hasNESW = !!cell['ne-sw'];
        const hasHalfTex = !trimCorner && (hasNWSE || hasNESW) && !!cell.textureSecondary;

        if (hasHalfTex) {
          const halves = hasNWSE
            ? [{ clipType: 'sw', key: 'texture',          opKey: 'textureOpacity' },
               { clipType: 'ne', key: 'textureSecondary', opKey: 'textureSecondaryOpacity' }]
            : [{ clipType: 'se', key: 'texture',          opKey: 'textureOpacity' },
               { clipType: 'nw', key: 'textureSecondary', opKey: 'textureSecondaryOpacity' }];
          for (const { clipType, key, opKey } of halves) {
            const tid = (cell as any)[key] || cell.texture;
            if (!tid) continue;
            const entry = catalog?.textures[tid];
            if (!entry?.img?.complete || !entry.img.naturalWidth) continue;
            clippedWork.push({ entry, texOp: (cell as any)[opKey] ?? cell.textureOpacity ?? 1.0, clipType, tl, tr, bl, br });
            hasTexturedCells = true;
          }
          continue;
        }

        let texId = cell.texture;
        let texOp = cell.textureOpacity ?? 1.0;
        if (trimCorner && !cell.trimOpen) {
          if ((hasNWSE && trimCorner === 'sw') || (hasNESW && trimCorner === 'se')) {
            texId = cell.textureSecondary ?? texId;
            texOp = cell.textureSecondaryOpacity ?? texOp;
          }
        }
        // @ts-expect-error — strict-mode migration
        const texEntry = texId ? catalog?.textures[texId!] : null;
        const secId = cell.textureSecondary;
        // @ts-expect-error — strict-mode migration
        const secEntry = secId ? catalog?.textures[secId!] : null;
        const hasPrimary = texEntry?.img?.complete && texEntry.img.naturalWidth;
        const hasSecondary = secEntry?.img?.complete && secEntry.img.naturalWidth;
        if (!hasPrimary && !hasSecondary) continue;
        hasTexturedCells = true;

        if (trimCorner && !cell.trimWall && !cell.trimOpen) {
          // Straight diagonal trim
          if (hasPrimary) clippedWork.push({ entry: texEntry, texOp, clipType: trimCorner, tl, tr, bl, br });
        } else if (cell.trimClip) {
          // Arc cell: if both textures exist, split at the arc curve.
          // For open trims with only one texture, draw as full rect.
          const showInterior = !cell.trimShowExteriorOnly;
          const showExterior = !cell.trimHideExterior;
          if (hasPrimary && hasSecondary) {
            if (showInterior) clippedWork.push({ entry: texEntry, texOp, clipType: 'trimClip', trimClip: cell.trimClip, tl, tr, bl, br });
            if (showExterior) clippedWork.push({ entry: secEntry, texOp: cell.textureSecondaryOpacity ?? 1.0, clipType: 'trimClipInvert', trimClip: cell.trimClip, tl, tr, bl, br });
          } else {
            // Closed trim: clip to room side only
            if (hasPrimary && showInterior) clippedWork.push({ entry: texEntry, texOp, clipType: 'trimClip', trimClip: cell.trimClip, tl, tr, bl, br });
            if (hasSecondary && showExterior) clippedWork.push({ entry: secEntry, texOp: cell.textureSecondaryOpacity ?? 1.0, clipType: 'trimClipInvert', trimClip: cell.trimClip, tl, tr, bl, br });
          }
        } else if (cell.trimWall && cell.trimCorner && (hasPrimary || hasSecondary)) {
          // Fallback for arc cells missing trimClip (old format or pre-reload): triangle approximation
          const voidCorner = cell.trimCorner;
          const roomCorner = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }[voidCorner];
          if (hasPrimary) clippedWork.push({ entry: texEntry, texOp, clipType: roomCorner, tl, tr, bl, br });
          if (hasSecondary) clippedWork.push({ entry: secEntry, texOp: cell.textureSecondaryOpacity ?? 1.0, clipType: voidCorner, tl, tr, bl, br });
        } else if (hasPrimary) {
          const batchKey = `${texId}\x00${texOp}`;
          let batch = straightBatches.get(batchKey);
          if (!batch) { batch = { entry: texEntry, texOp, rects: [] }; straightBatches.set(batchKey, batch); }
          batch.rects.push(tl.x, tl.y);
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

    // ── Clipped cells: triangular pattern fill, no save/restore needed ─────
    // ctx.fill() on the triangle path naturally restricts the pattern to the
    // triangle shape — no ctx.clip() required, so no save/restore overhead.
    for (const item of clippedWork) {
      const { entry, texOp, clipType, tl, tr, bl, br } = item;
      const pattern = _getTexPattern(ctx, entry);
      _applyPatternTransform(pattern, entry, cellPx, transform, resolution);
      ctx.globalAlpha = texOp;
      ctx.fillStyle = pattern;
      ctx.beginPath();
      if (clipType === 'trimClip') {
        const clip = item.trimClip;
        const gs = cellPx;
        ctx.moveTo(tl.x + clip![0][0] * gs, tl.y + clip![0][1] * gs);
        for (let i = 1; i < clip!.length; i++) {
          ctx.lineTo(tl.x + clip![i][0] * gs, tl.y + clip![i][1] * gs);
        }
      } else if (clipType === 'trimClipInvert') {
        // Void side: cell rect minus trimClip polygon (using evenodd)
        const clip = item.trimClip;
        const gs = cellPx;
        ctx.rect(tl.x, tl.y, gs, gs);
        ctx.moveTo(tl.x + clip![0][0] * gs, tl.y + clip![0][1] * gs);
        for (let i = 1; i < clip!.length; i++) {
          ctx.lineTo(tl.x + clip![i][0] * gs, tl.y + clip![i][1] * gs);
        }
        ctx.closePath();
        ctx.fill('evenodd');
        ctx.beginPath(); // reset — skip the normal fill below
        continue;
      } else {
        switch (clipType) {
          case 'nw': ctx.moveTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y); break;
          case 'ne': ctx.moveTo(tl.x, tl.y); ctx.lineTo(bl.x, bl.y); ctx.lineTo(br.x, br.y); break;
          case 'sw': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); break;
          case 'se': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y); break;
        }
      }
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalAlpha = 1.0;

  } else {
    // ── Fallback: original per-cell drawImage (Node.js PDF renderer) ───────
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        if (!roomCells[row][col]) continue;
        const cell = cells[row][col];
        if (!cell) continue;
        if (cell.trimShowExteriorOnly) continue; // exterior-only: skip interior face fill
        const x = col * gridSize;
        const y = row * gridSize;
        const trimCorner = getDiagonalTrimCorner(cell, cells, row, col);
        const catalog = textureOptions?.catalog;
        const p1 = toCanvas(x, y, transform);
        const tl = p1;
        const tr = toCanvas(x + gridSize, y, transform);
        const bl = toCanvas(x, y + gridSize, transform);
        const br = toCanvas(x + gridSize, y + gridSize, transform);

        const hasNWSE = !!cell['nw-se'];
        const hasNESW = !!cell['ne-sw'];
        const hasHalfTex = !trimCorner && (hasNWSE || hasNESW) && !!cell.textureSecondary;

        if (hasHalfTex) {
          const halves = hasNWSE
            ? [{ clipType: 'sw', key: 'texture',          opKey: 'textureOpacity' },
               { clipType: 'ne', key: 'textureSecondary', opKey: 'textureSecondaryOpacity' }]
            : [{ clipType: 'se', key: 'texture',          opKey: 'textureOpacity' },
               { clipType: 'nw', key: 'textureSecondary', opKey: 'textureSecondaryOpacity' }];
          for (const { clipType, key, opKey } of halves) {
            const tid = (cell as any)[key] || cell.texture;
            if (!tid) continue;
            const entry = catalog?.textures[tid];
            if (!entry?.img?.complete || !entry.img.naturalWidth) continue;
            const { srcX, srcY, srcW, srcH } = getTexChunk(entry, row, col);
            ctx.save();
            ctx.beginPath();
            switch (clipType) {
              case 'ne': ctx.moveTo(tl.x, tl.y); ctx.lineTo(bl.x, bl.y); ctx.lineTo(br.x, br.y); break;
              case 'sw': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); break;
              case 'se': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y); break;
              case 'nw': ctx.moveTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y); break;
            }
            ctx.closePath();
            ctx.clip();
            ctx.globalAlpha = (cell as any)[opKey] ?? cell.textureOpacity ?? 1.0;
            ctx.drawImage(entry.img, srcX, srcY, srcW, srcH, p1.x, p1.y, cellPx, cellPx);
            ctx.restore();
            hasTexturedCells = true;
          }
        } else {
          let texId = cell.texture;
          let texOp = cell.textureOpacity ?? 1.0;
          if (trimCorner && !cell.trimOpen) {
            if ((hasNWSE && trimCorner === 'sw') || (hasNESW && trimCorner === 'se')) {
              texId = cell.textureSecondary ?? texId;
              texOp = cell.textureSecondaryOpacity ?? texOp;
            }
          }
          // @ts-expect-error — strict-mode migration
          const texEntry = texId ? catalog?.textures[texId!] : null;
          if (texEntry?.img?.complete && texEntry.img.naturalWidth) {
            const { srcX, srcY, srcW, srcH } = getTexChunk(texEntry, row, col);
            ctx.save();
            ctx.globalAlpha = texOp;
            if (cell.trimClip) {
              const clip = cell.trimClip;
              const gs = cellPx;
              ctx.beginPath();
              ctx.moveTo(p1.x + clip[0][0] * gs, p1.y + clip[0][1] * gs);
              for (let i = 1; i < clip.length; i++) {
                ctx.lineTo(p1.x + clip[i][0] * gs, p1.y + clip[i][1] * gs);
              }
              ctx.closePath();
              ctx.clip();
            } else if (trimCorner && !cell.trimWall) {
              ctx.beginPath();
              switch (trimCorner) {
                case 'nw': ctx.moveTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y); break;
                case 'ne': ctx.moveTo(tl.x, tl.y); ctx.lineTo(bl.x, bl.y); ctx.lineTo(br.x, br.y); break;
                case 'sw': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); break;
                case 'se': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y); break;
              }
              ctx.closePath();
              ctx.clip();
            }
            ctx.drawImage(texEntry.img, srcX, srcY, srcW, srcH, p1.x, p1.y, cellPx, cellPx);
            ctx.restore();
            hasTexturedCells = true;
          }
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
export function renderTextureBlending(ctx: CanvasRenderingContext2D, cells: CellGrid, roomCells: boolean[][], gridSize: number, transform: RenderTransform, textureOptions: any, cacheSize: { w: number; h: number } | null = null): void {
  const blendWidth = textureOptions?.blendWidth ?? 0.35;
  if (blendWidth <= 0) return;

  const topo = getBlendTopoCache(cells, roomCells, gridSize, textureOptions);
  if (!topo.edges?.length && !topo.corners?.length) return;

  const { scale: sc, offsetX: ox, offsetY: oy } = transform;
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;

  // ── Cache-mode fast path: pre-rendered blend layer at cache resolution ──
  if (cacheSize) {
    const blendLayer = getRenderedBlendLayer(topo, gridSize, cacheSize.w, cacheSize.h, (cacheSize as any).scale);
    if (blendLayer) {
      ctx.drawImage(blendLayer, 0, 0);
      return;
    }
  }

  // ── L2 fast path: all bitmaps ready → single drawImage ──
  const allBitmapsReady = topo.edges.every((e: any) => e.bitmap) && topo.corners.every((c: any) => c.bitmap);
  if (allBitmapsReady) {
    const layer = getViewportBlendLayer(canvasW, canvasH, transform, topo, gridSize);
    if (layer) {
      ctx.drawImage(layer, 0, 0);
      return;
    }
  }

  // ── Fallback: per-element rendering (PDF path, or some bitmaps missing) ──
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
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
    for (const edge of topo.edges) {
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
          const sctx = scratch.getContext('2d');
          sctx.clearRect(0, 0, cellPx, cellPx);
          sctx.globalCompositeOperation = 'source-over';
          sctx.drawImage(edge.neighborEntry.img, edge.srcX, edge.srcY, edge.srcW, edge.srcH, 0, 0, cellPx, cellPx);

          let sg;
          switch (edge.direction) {
            case 'north': sg = sctx.createLinearGradient(0, 0, 0, blendPx); break;
            case 'south': sg = sctx.createLinearGradient(0, cellPx, 0, cellPx - blendPx); break;
            case 'west':  sg = sctx.createLinearGradient(0, 0, blendPx, 0); break;
            case 'east':  sg = sctx.createLinearGradient(cellPx, 0, cellPx - blendPx, 0); break;
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
          ctx.drawImage(edge.neighborEntry.img, edge.srcX, edge.srcY, edge.srcW, edge.srcH, screenX, screenY, cellPx, cellPx);
          ctx.restore();
        }
      }
    }

    // ── Corner pass ──
    for (const cn of topo.corners) {
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
          const sctx = scratch.getContext('2d');
          sctx.clearRect(0, 0, cellPx, cellPx);
          sctx.globalCompositeOperation = 'source-over';
          sctx.drawImage(cn.neighborEntry.img, cn.srcX, cn.srcY, cn.srcW, cn.srcH, 0, 0, cellPx, cellPx);

          const scratchCX = (cn.localCX / gridSize) * cellPx;
          const scratchCY = (cn.localCY / gridSize) * cellPx;
          const sg = sctx.createRadialGradient(scratchCX, scratchCY, 0, scratchCX, scratchCY, blendPx);
          sg.addColorStop(0, 'rgba(0,0,0,0)');
          sg.addColorStop(1, 'rgba(0,0,0,1)');
          sctx.globalCompositeOperation = 'destination-out';
          sctx.fillStyle = sg;
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

/**
 * Render pit/water/lava fills using cached world-space Path2D geometry,
 * composited via ctx.setTransform (same as rock shading) for pixel-perfect
 * output at any zoom level. Also draws the grid overlay.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme object
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {boolean} showGrid - Whether to draw the grid overlay
 * @param {boolean} [skipGrid=false] - Skip grid rendering (caller handles separately)
 * @param {Object|null} [metadata=null] - Dungeon metadata
 * @param {Object|null} [cacheSize=null] - Cache dimensions {w, h, scale}
 * @returns {void}
 */
export function renderFillPatternsAndGrid(ctx: CanvasRenderingContext2D, cells: CellGrid, roomCells: boolean[][], gridSize: number, theme: Theme, transform: RenderTransform, showGrid: boolean, skipGrid: boolean = false, metadata: any = null, cacheSize: { w: number; h: number } | null = null): void {
  const { scale: sc, offsetX: txOff, offsetY: tyOff } = transform;

  const data = getFluidPathCache(cells, gridSize, theme, roomCells);

  if (data.pit || data.water || data.lava) {
    withTrimVoidClip(ctx, cells, gridSize, transform, () => {
      // Try pre-rendered layer cache (only when rendering to the offscreen map cache)
      const fluidLayer = cacheSize ? getRenderedFluidLayer(data, gridSize, cacheSize.w, cacheSize.h, (cacheSize as any).scale) : null;

      if (fluidLayer) {
        // Blit the cached fluid layer
        ctx.drawImage(fluidLayer, 0, 0);
      } else {
        // Direct render path (viewport mode or first build before cache is ready)
        ctx.save();
        ctx.setTransform(sc, 0, 0, sc, txOff, tyOff);

        for (const fd of [data.pit, data.water, data.lava]) {
          if (!fd) continue;
          ctx.save();
          ctx.clip(fd.clipPath);

          for (const [colorKey, path] of fd.fills) {
            const rv = (colorKey >> 16) & 0xFF;
            const gv = (colorKey >> 8) & 0xFF;
            const bv = colorKey & 0xFF;
            ctx.fillStyle = `rgb(${rv},${gv},${bv})`;
            ctx.fill(path);
          }

          if (fd.cracksPath) {
            ctx.strokeStyle = fd.crackColor;
            ctx.lineWidth = Math.max(0.3 / sc, 0.06);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke(fd.cracksPath);

            for (const { gcx, gcy, maxDistWorld, cells: group } of fd.vignetteGroups) {
              const grad = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, maxDistWorld);
              grad.addColorStop(0, fd.vignetteColor);
              grad.addColorStop(0.4, 'rgba(0,0,0,0.25)');
              grad.addColorStop(1, 'rgba(0,0,0,0)');
              ctx.fillStyle = grad;
              for (const [r2, c2] of group) {
                ctx.fillRect(c2 * gridSize, r2 * gridSize, gridSize, gridSize);
              }
            }
          } else {
            ctx.strokeStyle = fd.causticColor;
            ctx.lineWidth = Math.max(0.5 / sc, 0.09);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke(fd.causticPath);
          }

          ctx.restore();
        }

        ctx.restore();
      }
    });
  }

  // Grid overlay — skipped here when caller handles it separately (e.g. to draw bridges first).
  if (!skipGrid && showGrid) {
    withTrimVoidClip(ctx, cells, gridSize, transform, () => {
      drawMatrixGrid(ctx, cells, roomCells, gridSize, transform, theme, showGrid, metadata);
    });
  }
}

/**
 * Draw hazard triangles as the topmost overlay — renders above walls, props, and labels.
 * Checks both cell.hazard (new format) and cell.fill === 'difficult-terrain' (legacy).
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {void}
 */
export function renderHazardOverlay(ctx: CanvasRenderingContext2D, cells: CellGrid, gridSize: number, transform: RenderTransform): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (!cell) continue;
      // @ts-expect-error — strict-mode migration
      if (!cell.hazard && cell.fill !== 'difficult-terrain') continue;

      const x = col * gridSize;
      const y = row * gridSize;
      const p = toCanvas(x, y, transform);
      const cellPx = gridSize * transform.scale;

      ctx.save();
      const size = cellPx * 0.3;
      const h = size * (Math.sqrt(3) / 2);
      const cx = p.x + cellPx - size * 0.75;
      const cy = p.y + h * 0.75;

      const top    = { x: cx,              y: cy - h * 0.55 };
      const left   = { x: cx - size / 2,   y: cy + h * 0.45 };
      const right  = { x: cx + size / 2,   y: cy + h * 0.45 };

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
      const dotY    = cy + h * 0.25;
      const dotR    = bangW * 0.7;

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
export function renderWallsAndBorders(ctx: CanvasRenderingContext2D, cells: CellGrid, roomCells: boolean[][], gridSize: number, theme: Theme, transform: RenderTransform, showInvisible: boolean = false, visibleBounds: VisibleBounds | null = null, _res: number = 1): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  drawBufferShading(ctx, cells, roomCells, gridSize, theme, transform);

  // Collect wall ('w') segments for batched rendering; draw non-wall borders immediately
  const wallSegments = [];
  const deferredDiagDoors = []; // rendered after wall batch to avoid overdraw
  const WALL_DIRS = ['north', 'south', 'east', 'west'];

  const startRow = visibleBounds?.minRow ?? 0;
  const endRow = visibleBounds?.maxRow ?? (numRows - 1);
  const startCol = visibleBounds?.minCol ?? 0;
  const endCol = visibleBounds?.maxCol ?? (numCols - 1);

  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      const cell = cells[row][col];
      if (!cell) continue;

      // Cardinal borders with double door auto-detection
      const borders = [
        ['north', col, row, col + 1, row, 'horizontal'],
        ['south', col, row + 1, col + 1, row + 1, 'horizontal'],
        ['east',  col + 1, row, col + 1, row + 1, 'vertical'],
        ['west',  col, row, col, row + 1, 'vertical'],
      ];
      for (const [dir, x1, y1, x2, y2, orient] of borders) {
        const bt = (cell as any)[dir];
        if (!bt) continue;
        if (bt === 'd' || bt === 's') {
          // @ts-expect-error — strict-mode migration
          const role = getDoubleDoorRole(cells, row, col, dir, _res);
          if (role === 'partner') continue;
          if (role === 'anchor') {
            // @ts-expect-error — strict-mode migration
            renderDoubleBorder(ctx, cells, row, col, dir, bt, orient, theme, gridSize, transform, _res);
            continue;
          }
          if (role === 'single-wide') {
            // Render a single door spanning one display cell (resolution sub-cells)
            // Extend the wall segment coordinates to cover the full display cell width
            const wx1 = x1, wy1 = y1; let wx2 = x2, wy2 = y2;
            if (orient === 'horizontal') {
              // @ts-expect-error — strict-mode migration
              wx2 = x1 + _res; // extend cols by resolution
            } else {
              // @ts-expect-error — strict-mode migration
              wy2 = y1 + _res; // extend rows by resolution
            }
            // @ts-expect-error — strict-mode migration
            renderBorder(ctx, wx1, wy1, wx2, wy2, bt, orient, theme, gridSize, transform);
            continue;
          }
        }
        if (bt === 'w') {
          // Deduplicate shared edges: south/east walls are the same physical edge
          // as the neighbor's north/west. Skip if neighbor owns the reciprocal.
          if (dir === 'south' && cells[row + 1]?.[col]?.north === 'w') continue;
          if (dir === 'east' && cells[row]?.[col + 1]?.west === 'w') continue;
          // @ts-expect-error — strict-mode migration
          const { p1, p2 } = wallSegmentCoords(x1, y1, x2, y2, gridSize, transform);
          // @ts-expect-error — strict-mode migration
          const dirIdx = WALL_DIRS.indexOf(dir);
          const seed = (row * 1000 + col) * 6 + dirIdx;
          wallSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, seed });
        } else if (bt === 'iw') {
          // Invisible wall: skip unless showInvisible (deduplicate same as 'w')
          if (!showInvisible) continue;
          if (dir === 'south' && cells[row + 1]?.[col]?.north === 'iw') continue;
          if (dir === 'east' && cells[row]?.[col + 1]?.west === 'iw') continue;
          // @ts-expect-error — strict-mode migration
          renderBorder(ctx, x1, y1, x2, y2, bt, orient, theme, gridSize, transform);
        } else if (bt === 'id') {
          // Invisible door: skip unless showInvisible
          if (!showInvisible) continue;
          // @ts-expect-error — strict-mode migration
          renderBorder(ctx, x1, y1, x2, y2, bt, orient, theme, gridSize, transform);
        } else {
          // @ts-expect-error — strict-mode migration
          renderBorder(ctx, x1, y1, x2, y2, bt, orient, theme, gridSize, transform);
        }
      }

      // Diagonal borders — collect doors for deferred rendering, walls handled below
      for (const diag of ['nw-se', 'ne-sw']) {
        const bt = (cell as any)[diag];
        if (!bt) continue;
        if (cell.trimWall) continue;
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
  // Includes door cells ('d','s') so the wall line is unbroken — doors paint gaps on top.
  let _diagMergeCount = 0;
  const diagSeen = new Set();
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      for (const diag of ['nw-se', 'ne-sw']) {
        const cell = cells[row]?.[col];
        // @ts-expect-error — strict-mode migration
        const bt = cell?.[diag];
        if (!bt || cell.trimWall) continue;
        if (bt !== 'w' && bt !== 'd' && bt !== 's') continue;
        const key = `${row},${col},${diag}`;
        if (diagSeen.has(key)) continue;

        // Walk forward along the diagonal to find the full run (walls + doors)
        const dr = diag === 'nw-se' ? 1 : 1;
        const dc = diag === 'nw-se' ? 1 : -1;
        let runLen = 0;
        let r = row, c = col;
        while (r >= 0 && r < numRows && c >= 0 && c < numCols) {
          const v = (cells as any)[r]?.[c]?.[diag];
          if ((v !== 'w' && v !== 'd' && v !== 's') || cells[r]?.[c]?.trimWall) break;
          diagSeen.add(`${r},${c},${diag}`);
          runLen++;
          r += dr; c += dc;
        }

        // Build one long segment from start to end of run
        let fx1, fy1, fx2, fy2;
        if (diag === 'nw-se') {
          fx1 = col * gridSize;              fy1 = row * gridSize;
          fx2 = (col + runLen) * gridSize;   fy2 = (row + runLen) * gridSize;
        } else {
          fx1 = (col + 1) * gridSize;            fy1 = row * gridSize;
          fx2 = (col + 1 - runLen) * gridSize;   fy2 = (row + runLen) * gridSize;
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
    // @ts-expect-error — strict-mode migration
    if (theme.wallRoughness > 0) {
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

  // Per-cell arc walls
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      const cell = cells[row]?.[col];
      if (!cell?.trimWall) continue;
      const wall = cell.trimWall;
      const cx = col * gridSize, cy = row * gridSize;
      const s = scaleFactor(transform);

      // Shadow pass
      if (theme.wallShadow) {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 8 * s;
        ctx.lineCap = 'round';
        const sx = 2 * s, sy = 2 * s;
        ctx.beginPath();
        // @ts-expect-error — strict-mode migration
        const p0s = toCanvas(cx + (wall[0][0] as number) * gridSize + sx / transform.scale, cy + (wall[0][1] as number) * gridSize + sy / transform.scale, transform);
        ctx.moveTo(p0s.x, p0s.y);
        for (let i = 1; i < wall.length; i++) {
          // @ts-expect-error — strict-mode migration
          const p = toCanvas(cx + (wall[i][0] as number) * gridSize + sx / transform.scale, cy + (wall[i][1] as number) * gridSize + sy / transform.scale, transform);
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
      // @ts-expect-error — strict-mode migration
      const p0 = toCanvas(cx + (wall[0][0] as number) * gridSize, cy + (wall[0][1] as number) * gridSize, transform);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < wall.length; i++) {
        // @ts-expect-error — strict-mode migration
        const p = toCanvas(cx + (wall[i][0] as number) * gridSize, cy + (wall[i][1] as number) * gridSize, transform);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
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
export function renderLabels(ctx: CanvasRenderingContext2D, cells: CellGrid, gridSize: number, theme: Theme, transform: RenderTransform, labelStyle: string): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const style = labelStyle || 'circled';

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row][col];
      if (cell?.center?.label || cell?.center?.dmLabel) {
        // Use labelX/labelY (world feet) if set, otherwise default to cell center
        const labelX = cell.center.labelX ?? (col + 0.5) * gridSize;
        const labelY = cell.center.labelY ?? (row + 0.5) * gridSize;
        // @ts-expect-error — strict-mode migration
        const p = toCanvas(labelX, labelY, transform);

        if (cell.center.label) {
          drawCellLabel(ctx, p.x, p.y, cell.center.label, theme, style, transform.scale);
        }

        // DM labels: use dmLabelX/dmLabelY if set, otherwise same position
        if (cell.center.dmLabel) {
          const dmX = cell.center.dmLabelX ?? (col + 0.5) * gridSize;
          const dmY = cell.center.dmLabelY ?? (row + 0.5) * gridSize;
          // @ts-expect-error — strict-mode migration
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
export function renderLabelsStairsProps(ctx: CanvasRenderingContext2D, cells: CellGrid, gridSize: number, theme: Theme, transform: RenderTransform, labelStyle: string, propCatalog: any, textureOptions: any, metadata: any, skipLabels: boolean = false, visibleBounds: VisibleBounds | null = null, cacheSize: { w: number; h: number } | null = null): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Props (furniture, objects)
  const getTextureImage = textureOptions?.catalog
    ? (id: any) => { const e = textureOptions.catalog.textures[id]; return e?.img?.complete ? e.img : null; }
    : null;

  // Try pre-rendered props layer cache
  const propsLayer = cacheSize ? getRenderedPropsLayer(cells, gridSize, theme, propCatalog, getTextureImage, textureOptions?.texturesVersion ?? 0, metadata, cacheSize.w, cacheSize.h, (cacheSize as any).scale) : null;
  if (propsLayer) {
    ctx.drawImage(propsLayer, 0, 0);
  } else {
    renderAllProps(ctx, cells, gridSize, theme, transform, propCatalog, getTextureImage, textureOptions?.texturesVersion ?? 0, visibleBounds, metadata);
  }

  // Room labels and DM labels — skipped when lighting is enabled so they can be
  // drawn after the lightmap, keeping them unaffected by the multiply overlay.
  if (!skipLabels) {
    renderLabels(ctx, cells, gridSize, theme, transform, labelStyle);
  }

  // Stairs — new system: metadata.stairs[] array of shape definitions
  const stairDefs = metadata?.stairs || [];

  for (const stairDef of stairDefs) {
    drawStairShape(ctx, stairDef, theme, gridSize, transform);

    if (stairDef.link) {
      let minRow = Infinity, minCol = Infinity;
      for (const [r, c] of stairDef.points) {
        if (r < minRow) minRow = r;
        if (c < minCol) minCol = c;
      }
      drawStairShapeLinkLabel(ctx, minCol * gridSize, minRow * gridSize,
        stairDef.link, theme, transform);
    }
  }

  // Legacy fallback: old per-cell stairs for unmigrated files
  if (stairDefs.length === 0) {
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const cell = cells[row][col];
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
          // @ts-expect-error — strict-mode migration
          drawStairsLinkLabel(ctx, p.x, p.y, cell.center['stairs-link'], theme, transform);
        }
      }
    }
  }
}
