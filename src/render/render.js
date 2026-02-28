import { toCanvas } from './bounds.js';
import { determineRoomCells, getDiagonalTrimCorner, drawRoundedWall } from './floors.js';
import { renderBorder, getDoubleDoorRole, getDoubleDoorDiagonalRole, renderDoubleBorder, renderDiagonalBorder, renderDiagonalDoubleBorder, drawStairsInCell, drawStairsLinkLabel, drawStairShape, drawStairShapeLinkLabel, wallSegmentCoords, diagonalWallSegmentCoords, scaleFactor } from './borders.js';
import { drawCellLabel, drawDmLabel } from './features.js';
import { drawMatrixGrid } from './decorations.js';
import { renderAllProps } from './props.js';
import { renderAllBridges } from './bridges.js';
import { drawWallShadow, drawRoughWalls, drawHatching, drawRockShading, drawBufferShading, drawOuterShading, invalidateEffectsCache } from './effects.js';
import { getFluidPathCache, invalidateFluidCache } from './fluid.js';
import { getBlendTopoCache, getBlendScratch, getViewportBlendLayer, BLEND_BITMAP_SIZE, PDF_EDGE_FALLBACK_OPACITY, PDF_CORNER_FALLBACK_OPACITY, getTexChunk } from './blend.js';

// Re-export cache invalidation functions (public API maintained for direct importers)
export { invalidateFluidCache };
export { invalidateBlendLayerCache } from './blend.js';

// ── Per-frame caches (invalidated by cells reference change) ─────────
let _roomCellsCache = { cells: null, result: null };
let _roundedCornersCache = { cells: null, result: null };

function getCachedRoomCells(cells) {
  if (_roomCellsCache.cells === cells) return _roomCellsCache.result;
  const result = determineRoomCells(cells);
  _roomCellsCache = { cells, result };
  return result;
}

function getCachedRoundedCorners(cells) {
  if (_roundedCornersCache.cells === cells) return _roundedCornersCache.result;
  const result = collectRoundedCorners(cells);
  _roundedCornersCache = { cells, result };
  return result;
}


/**
 * Call this whenever cell geometry changes in-place (rooms created/destroyed, walls/trims modified).
 * Resets room cell topology, rounded corners, hatching, and shading caches.
 * Does NOT clear fluid caches — call invalidateFluidCache() separately if fluids are affected.
 */
export function invalidateGeometryCache() {
  _roomCellsCache      = { cells: null, result: null };
  _roundedCornersCache = { cells: null, result: null };
  invalidateEffectsCache();
}

// ── Smart cache invalidation ─────────────────────────────────────────────────

function _cellHasFluid(cell) {
  if (!cell) return false;
  return cell.fill === 'water' || cell.fill === 'lava' || cell.fill === 'pit' || !!cell.hazard;
}

function _neighborHasFluid(row, col, cells) {
  return _cellHasFluid(cells[row - 1]?.[col]) ||
         _cellHasFluid(cells[row + 1]?.[col]) ||
         _cellHasFluid(cells[row]?.[col - 1]) ||
         _cellHasFluid(cells[row]?.[col + 1]);
}

/**
 * Capture the before-state of a set of cells prior to mutation.
 * Pass the result to smartInvalidate() after the mutation to determine which caches to clear.
 *
 * @param {Array} cells  The cell grid (pre-mutation)
 * @param {Array<{row, col}>} coords  Cells about to be mutated
 * @returns {Array<{row, col, wasVoid, fill, waterDepth, lavaDepth, hazard}>}
 */
export function captureBeforeState(cells, coords) {
  return coords.map(({ row, col }) => {
    const cell = cells[row]?.[col];
    if (!cell) return { row, col, wasVoid: true, fill: undefined, waterDepth: undefined, lavaDepth: undefined, hazard: undefined };
    return { row, col, wasVoid: false, fill: cell.fill, waterDepth: cell.waterDepth, lavaDepth: cell.lavaDepth, hazard: cell.hazard };
  });
}

/**
 * Smart invalidation — call after any in-place cell mutation.
 *
 * @param {Array<{row, col, wasVoid, fill, waterDepth, lavaDepth, hazard}>} changes
 *   Snapshot taken BEFORE the operation via captureBeforeState().
 * @param {Array} cells  The current (post-op) cell grid.
 * @param {{ forceGeometry?: boolean, forceFluid?: boolean }} [opts]
 *   Force flags for operations where auto-detection isn't sufficient
 *   (e.g. trim metadata edits that don't cause void transitions).
 *
 * Rules:
 *  - Any void↔floor transition → invalidateGeometryCache()
 *  - Any cell whose fill/depth/hazard data actually changed → invalidateFluidCache()
 *  - Void transitions near fluid cells → also invalidateFluidCache()
 *  - Wall/metadata changes with no void or fluid involvement → nothing cleared
 */
export function smartInvalidate(changes, cells, { forceGeometry = false, forceFluid = false } = {}) {
  let needsGeometry = forceGeometry;
  let needsFluid    = forceFluid;

  for (const { row, col, wasVoid, fill: beforeFill, waterDepth: beforeWD, lavaDepth: beforeLD, hazard: beforeHazard } of changes) {
    if (needsGeometry && needsFluid) break;

    const afterCell = cells[row]?.[col];
    const isVoid    = afterCell === null || afterCell === undefined;

    if (wasVoid !== isVoid) {
      needsGeometry = true;
      if (!needsFluid) {
        const hadFluid = beforeFill === 'water' || beforeFill === 'lava' || beforeFill === 'pit' || !!beforeHazard;
        if (hadFluid || _cellHasFluid(afterCell) || _neighborHasFluid(row, col, cells)) {
          needsFluid = true;
        }
      }
    } else if (!wasVoid && !isVoid && !needsFluid) {
      // Non-void: only clear fluid cache if fill data actually changed
      if (beforeFill !== afterCell.fill ||
          beforeWD   !== afterCell.waterDepth ||
          beforeLD   !== afterCell.lavaDepth ||
          !!beforeHazard !== !!afterCell.hazard) {
        needsFluid = true;
      }
    }
  }

  if (needsGeometry) invalidateGeometryCache();
  if (needsFluid)    invalidateFluidCache();
}

// ── Texture pattern cache ─────────────────────────────────────────────────────
// createPattern + setTransform — same idea as the Path2D cache used for hatching:
// build one CanvasPattern per texture entry (tied to the rendering context) and
// update only its transform matrix each frame instead of issuing one drawImage
// per cell. On pan the transform update is a single DOMMatrix allocation; the
// actual pixel work is batched into one ctx.fill() call per texture group.
// Patterns are cached on entry._pattern / entry._patternCtx so they survive
// across frames and are only recreated when the image or context changes.

function _getTexPattern(ctx, entry) {
  if (!entry._pattern || entry._patternCtx !== ctx) {
    entry._pattern = ctx.createPattern(entry.img, 'repeat');
    entry._patternCtx = ctx;
  }
  return entry._pattern;
}

function _applyPatternTransform(pattern, entry, cellPx, transform) {
  const img = entry.img;
  const cw = Math.max(1, Math.floor(img.naturalWidth  / 256));
  const ch = Math.max(1, Math.floor(img.naturalHeight / 256));
  // Scale: one chunk (srcW × srcH texture pixels) → one cell (cellPx screen pixels).
  // Using floor-divided srcW/srcH matches getTexChunk exactly, so the pattern
  // boundaries align with the same chunk grid used by the drawImage fallback.
  const srcW = Math.floor(img.naturalWidth  / cw);
  const srcH = Math.floor(img.naturalHeight / ch);
  pattern.setTransform(new DOMMatrix([
    cellPx / srcW, 0, 0, cellPx / srcH,
    transform.offsetX, transform.offsetY,
  ]));
}

/**
 * Collect rounded corner arc descriptors from cells with trimRound.
 * Keyed by arc center — all trimRound cells sharing a center contribute to one entry.
 *
 * Entry flags (set by fog.js for player view, aggregated via OR across all cells):
 *   isOpen        — Decorative arc (no wall). buildArcVoidClip skips these by default.
 *   exteriorOnly  — Player fog: only exterior revealed. Rounded corner pass draws exterior
 *                   texture; buildArcVoidClip skips when skipExteriorOnly=true (grid pass).
 *   hideExterior  — Player fog: only interior revealed. Rounded corner pass skips entirely;
 *                   buildArcVoidClip includes even open arcs so renderFloors is clipped.
 */
function collectRoundedCorners(cells) {
  const roundedCorners = new Map();
  const numRows = cells.length;
  for (let row = 0; row < numRows; row++) {
    const numCols = cells[row]?.length || 0;
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (!cell?.trimRound) continue;
      const key = `${cell.trimArcCenterRow},${cell.trimArcCenterCol}`;
      if (!roundedCorners.has(key)) {
        roundedCorners.set(key, {
          centerRow: cell.trimArcCenterRow,
          centerCol: cell.trimArcCenterCol,
          radius: cell.trimArcRadius,
          corner: cell.trimCorner,
          inverted: !!cell.trimArcInverted,
          isOpen: !!cell.trimOpen,
          exteriorOnly: !!cell.trimShowExteriorOnly,
          hideExterior: !!cell.trimHideExterior,
        });
      } else {
        const entry = roundedCorners.get(key);
        if (cell.trimShowExteriorOnly) entry.exteriorOnly = true;
        if (cell.trimHideExterior) entry.hideExterior = true;
      }
    }
  }
  return roundedCorners;
}

/**
 * Build a clip path that excludes arc void pie-slice regions.
 * Uses evenodd rule: canvas rect (count=1, drawn) + pie-slices (count=2, excluded).
 */
function buildArcVoidClip(ctx, roundedCorners, gridSize, transform, skipExteriorOnly = false) {
  ctx.beginPath();
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const rc of roundedCorners.values()) {
    // Open arcs (no wall) normally don't need a wedge clip — floor and secondary
    // textures extend through the wedge freely. But when hideExterior is set
    // (player fog: interior revealed, exterior not), the wedge must be excluded
    // so it renders as void instead of showing the primary texture.
    if (rc.isOpen && !rc.hideExterior) continue;
    // Exterior-only wedges (player fog: exterior revealed, interior not) are
    // skipped when the caller wants the grid to draw through them at full weight.
    if (skipExteriorOnly && rc.exteriorOnly) continue;
    const ocp = toCanvas(rc.centerCol * gridSize, rc.centerRow * gridSize, transform);
    const Rpx = rc.radius * gridSize * transform.scale;
    if (rc.inverted) {
      let startAngle, endAngle, anticlockwise;
      switch (rc.corner) {
        case 'nw': startAngle = Math.PI / 2;   endAngle = 0;               anticlockwise = true;  break;
        case 'ne': startAngle = Math.PI / 2;   endAngle = Math.PI;         anticlockwise = false; break;
        case 'sw': startAngle = 0;             endAngle = 3 * Math.PI / 2; anticlockwise = true;  break;
        case 'se': startAngle = Math.PI;       endAngle = 3 * Math.PI / 2; anticlockwise = false; break;
      }
      ctx.moveTo(ocp.x, ocp.y);
      ctx.lineTo(ocp.x + Rpx * Math.cos(startAngle), ocp.y + Rpx * Math.sin(startAngle));
      ctx.arc(ocp.x, ocp.y, Rpx, startAngle, endAngle, anticlockwise);
      ctx.lineTo(ocp.x, ocp.y);
    } else {
      let acx, acy;
      switch (rc.corner) {
        case 'nw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
        case 'ne': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
        case 'sw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
        case 'se': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
      }
      const acp = toCanvas(acx, acy, transform);
      switch (rc.corner) {
        case 'nw': ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x + Rpx, ocp.y); ctx.arc(acp.x, acp.y, Rpx, 3*Math.PI/2, Math.PI, true);  ctx.lineTo(ocp.x, ocp.y); break;
        case 'ne': ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x - Rpx, ocp.y); ctx.arc(acp.x, acp.y, Rpx, 3*Math.PI/2, 0, false);        ctx.lineTo(ocp.x, ocp.y); break;
        case 'sw': ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x + Rpx, ocp.y); ctx.arc(acp.x, acp.y, Rpx, Math.PI/2, Math.PI, false);    ctx.lineTo(ocp.x, ocp.y); break;
        case 'se': ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x - Rpx, ocp.y); ctx.arc(acp.x, acp.y, Rpx, Math.PI/2, 0, true);           ctx.lineTo(ocp.x, ocp.y); break;
      }
    }
    ctx.closePath();
  }
  ctx.clip('evenodd');
}

/** Save/clip helper for arc void regions. Restores with ctx.restore(). */
function withArcClip(ctx, hasRoundedArcs, roundedCorners, gridSize, transform, fn, skipExteriorOnly = false) {
  if (hasRoundedArcs) { ctx.save(); buildArcVoidClip(ctx, roundedCorners, gridSize, transform, skipExteriorOnly); }
  fn();
  if (hasRoundedArcs) ctx.restore();
}

/**
 * Fill room backgrounds and render per-cell texture overlays.
 * Returns true if any textured cells were drawn.
 */
function renderFloors(ctx, cells, roomCells, gridSize, theme, transform, textureOptions) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  let hasTexturedCells = false;

  // Pass 1: Build a single floor path covering all room cells, fill once
  ctx.fillStyle = theme.wallFill;
  ctx.beginPath();
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      if (!roomCells[row][col]) continue;
      const cell = cells[row][col];
      if (cell?.trimShowExteriorOnly) continue; // exterior-only: skip interior face fill
      const x = col * gridSize;
      const y = row * gridSize;
      const trimCorner = cell ? getDiagonalTrimCorner(cell, cells, row, col) : null;
      if (trimCorner && !cell.trimRound && !cell.trimOpen) {
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
      } else {
        const p1 = toCanvas(x, y, transform);
        ctx.rect(p1.x, p1.y, gridSize * transform.scale, gridSize * transform.scale);
      }
    }
  }
  ctx.fill();

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
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        if (!roomCells[row][col]) continue;
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
            const tid = cell[key] || cell.texture;
            if (!tid) continue;
            const entry = catalog?.textures[tid];
            if (!entry?.img?.complete || !entry.img.naturalWidth) continue;
            clippedWork.push({ entry, texOp: cell[opKey] ?? cell.textureOpacity ?? 1.0, clipType, tl, tr, bl, br });
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
        const texEntry = texId ? catalog?.textures[texId] : null;
        if (!texEntry?.img?.complete || !texEntry.img.naturalWidth) continue;
        hasTexturedCells = true;

        if (trimCorner && !cell.trimRound && !cell.trimOpen) {
          clippedWork.push({ entry: texEntry, texOp, clipType: trimCorner, tl, tr, bl, br });
        } else {
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
      _applyPatternTransform(pattern, entry, cellPx, transform);
      ctx.globalAlpha = texOp;
      ctx.fillStyle = pattern;
      ctx.beginPath();
      for (let i = 0; i < rects.length; i += 2) ctx.rect(rects[i], rects[i + 1], cellPx, cellPx);
      ctx.fill();
    }

    // ── Clipped cells: triangular pattern fill, no save/restore needed ─────
    // ctx.fill() on the triangle path naturally restricts the pattern to the
    // triangle shape — no ctx.clip() required, so no save/restore overhead.
    for (const { entry, texOp, clipType, tl, tr, bl, br } of clippedWork) {
      const pattern = _getTexPattern(ctx, entry);
      _applyPatternTransform(pattern, entry, cellPx, transform);
      ctx.globalAlpha = texOp;
      ctx.fillStyle = pattern;
      ctx.beginPath();
      switch (clipType) {
        case 'nw': ctx.moveTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y); break;
        case 'ne': ctx.moveTo(tl.x, tl.y); ctx.lineTo(bl.x, bl.y); ctx.lineTo(br.x, br.y); break;
        case 'sw': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); break;
        case 'se': ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(bl.x, bl.y); break;
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
            const tid = cell[key] || cell.texture;
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
            ctx.globalAlpha = cell[opKey] ?? cell.textureOpacity ?? 1.0;
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
          const texEntry = texId ? catalog?.textures[texId] : null;
          if (texEntry?.img?.complete && texEntry.img.naturalWidth) {
            const { srcX, srcY, srcW, srcH } = getTexChunk(texEntry, row, col);
            ctx.save();
            ctx.globalAlpha = texOp;
            if (trimCorner && !cell.trimRound) {
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
 */
function renderTextureBlending(ctx, cells, roomCells, roundedCorners, hasRoundedArcs, gridSize, transform, textureOptions) {
  const blendWidth = textureOptions?.blendWidth ?? 0.35;
  if (blendWidth <= 0) return;

  const topo = getBlendTopoCache(cells, roomCells, gridSize, textureOptions);
  if (!topo.edges?.length && !topo.corners?.length) return;

  const { scale: sc, offsetX: ox, offsetY: oy } = transform;
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;

  // ── L2 fast path: all bitmaps ready → single drawImage ──
  const allBitmapsReady = topo.edges.every(e => e.bitmap) && topo.corners.every(c => c.bitmap);
  if (allBitmapsReady) {
    const layer = getViewportBlendLayer(canvasW, canvasH, transform, topo, gridSize);
    if (layer) {
      withArcClip(ctx, hasRoundedArcs, roundedCorners, gridSize, transform, () => {
        ctx.drawImage(layer, 0, 0);
      });
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

  withArcClip(ctx, hasRoundedArcs, roundedCorners, gridSize, transform, () => {
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
  });
}

/**
 * Render pit/water/lava fills using cached world-space Path2D geometry,
 * composited via ctx.setTransform (same as rock shading) for pixel-perfect
 * output at any zoom level. Also draws the grid overlay.
 */
function renderFillPatternsAndGrid(ctx, cells, roomCells, roundedCorners, hasRoundedArcs, gridSize, theme, transform, showGrid, skipGrid = false) {
  const { scale: sc, offsetX: txOff, offsetY: tyOff } = transform;
  const data = getFluidPathCache(cells, gridSize, theme, roomCells);

  if (data.pit || data.water || data.lava) {
    ctx.save();
    // Arc void clip applied in screen space before switching CTM
    if (hasRoundedArcs) {
      buildArcVoidClip(ctx, roundedCorners, gridSize, transform);
    }
    // Switch to world-space CTM — all cached Path2D coordinates are in world units.
    // The arc void clip above is stored in device space and remains active.
    ctx.setTransform(sc, 0, 0, sc, txOff, tyOff);

    for (const fd of [data.pit, data.water, data.lava]) {
      if (!fd) continue;
      ctx.save();
      ctx.clip(fd.clipPath); // wall-aware clip in world space

      // Batched fill pass — one fill() per colour group
      for (const [colorKey, path] of fd.fills) {
        const rv = (colorKey >> 16) & 0xFF;
        const gv = (colorKey >> 8) & 0xFF;
        const bv = colorKey & 0xFF;
        ctx.fillStyle = `rgb(${rv},${gv},${bv})`;
        ctx.fill(path);
      }

      if (fd.cracksPath) {
        // Pit: crack strokes + radial vignette per connected group
        ctx.strokeStyle = fd.crackColor;
        ctx.lineWidth = Math.max(0.3 / sc, 0.06); // world units → correct screen px at any zoom
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
        // Fluid (water/lava): caustic edge strokes
        ctx.strokeStyle = fd.causticColor;
        ctx.lineWidth = Math.max(0.5 / sc, 0.09); // world units → correct screen px at any zoom
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(fd.causticPath);
      }

      ctx.restore();
    }

    ctx.restore();
  }

  // Grid overlay — skipped here when caller handles it separately (e.g. to draw bridges first).
  if (!skipGrid && showGrid) {
    withArcClip(ctx, hasRoundedArcs, roundedCorners, gridSize, transform, () => {
      drawMatrixGrid(ctx, cells, roomCells, gridSize, transform, theme, showGrid);
    }, true);
  }
}

/**
 * Draw hazard triangles as the topmost overlay — renders above walls, props, and labels.
 * Checks both cell.hazard (new format) and cell.fill === 'difficult-terrain' (legacy).
 */
function renderHazardOverlay(ctx, cells, gridSize, transform) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (!cell) continue;
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
      ctx.fillStyle = '#f0c020';
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
 * @param {boolean} [showInvisible=false] - When true, render invisible walls/doors in ghost style.
 */
function renderWallsAndBorders(ctx, cells, roomCells, roundedCorners, gridSize, theme, transform, showInvisible = false) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  drawBufferShading(ctx, cells, roomCells, gridSize, theme, transform);

  // Collect wall ('w') segments for batched rendering; draw non-wall borders immediately
  const wallSegments = [];
  const WALL_DIRS = ['north', 'south', 'east', 'west'];

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
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
        const bt = cell[dir];
        if (!bt) continue;
        if (bt === 'd' || bt === 's') {
          const role = getDoubleDoorRole(cells, row, col, dir);
          if (role === 'partner') continue;
          if (role === 'anchor') {
            renderDoubleBorder(ctx, cells, row, col, dir, bt, orient, theme, gridSize, transform);
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

      // Diagonal borders with double door auto-detection
      for (const diag of ['nw-se', 'ne-sw']) {
        const bt = cell[diag];
        if (!bt) continue;
        if (cell.trimRound) continue;
        if (bt === 'd' || bt === 's') {
          const role = getDoubleDoorDiagonalRole(cells, row, col, diag);
          if (role === 'partner') continue;
          if (role === 'anchor') {
            renderDiagonalDoubleBorder(ctx, cells, row, col, bt, diag, theme, gridSize, transform);
            continue;
          }
        }
        if (bt === 'w') {
          const { p1, p2 } = diagonalWallSegmentCoords(col, row, diag, gridSize, transform);
          const diagIdx = diag === 'nw-se' ? 4 : 5;
          const seed = (row * 1000 + col) * 6 + diagIdx;
          wallSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, seed });
        } else if (bt === 'iw' || bt === 'id') {
          // Invisible: skip unless showInvisible
          if (!showInvisible) continue;
          renderDiagonalBorder(ctx, col, row, bt, diag, theme, gridSize, transform);
        } else {
          renderDiagonalBorder(ctx, col, row, bt, diag, theme, gridSize, transform);
        }
      }
    }
  }

  // Draw all wall segments — shadow pass first, then walls on top
  if (wallSegments.length > 0) {
    const s = scaleFactor(transform);
    drawWallShadow(ctx, wallSegments, theme, transform);

    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;
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

  // Arc walls for rounded trims
  for (const rc of roundedCorners.values()) {
    drawRoundedWall(ctx, rc, theme, gridSize, transform);
  }
}

/**
 * Draw room labels and DM labels. Exported so callers can invoke this as a separate
 * post-lighting pass, keeping labels unaffected by the multiply lightmap overlay.
 */
export function renderLabels(ctx, cells, gridSize, theme, transform, labelStyle) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const style = labelStyle || 'circled';

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row][col];
      if (cell?.center?.label || cell?.center?.dmLabel) {
        const centerX = (col + 0.5) * gridSize;
        const centerY = (row + 0.5) * gridSize;
        const p = toCanvas(centerX, centerY, transform);

        if (cell.center.label) {
          drawCellLabel(ctx, p.x, p.y, cell.center.label, theme, style, transform.scale);
        }
        if (cell.center.dmLabel) {
          drawDmLabel(ctx, p.x, p.y, cell.center.dmLabel, transform.scale);
        }
      }
    }
  }
}

/**
 * Draw props, room/DM labels, and stairs (both new shape-based and legacy per-cell).
 */
function renderLabelsStairsProps(ctx, cells, gridSize, theme, transform, labelStyle, propCatalog, textureOptions, metadata, skipLabels = false) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Props (furniture, objects)
  const getTextureImage = textureOptions?.catalog
    ? (id) => { const e = textureOptions.catalog.textures[id]; return e?.img?.complete ? e.img : null; }
    : null;

  renderAllProps(ctx, cells, gridSize, theme, transform, propCatalog, getTextureImage, textureOptions?.texturesVersion ?? 0);

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
          drawStairsLinkLabel(ctx, p.x, p.y, cell.center['stairs-link'], theme, transform);
        }
      }
    }
  }
}

/**
 * Render matrix-based dungeon map — orchestrates all rendering phases.
 */
export function renderCells(ctx, cells, gridSize, theme, transform, options = {}) {
  const {
    showGrid = false,
    labelStyle = 'circled',
    propCatalog = null,
    textureOptions = null,
    metadata = null,
    skipLabels = false,
    showInvisible = false,
  } = options;
  const roomCells = getCachedRoomCells(cells);
  const roundedCorners = getCachedRoundedCorners(cells);
  const hasRoundedArcs = roundedCorners.size > 0;

  // Outer shading + hatching (before floor fills so floor paint covers them)
  drawOuterShading(ctx, cells, roomCells, gridSize, theme, transform);
  drawHatching(ctx, cells, roomCells, gridSize, theme, transform);
  drawRockShading(ctx, cells, roomCells, gridSize, theme, transform);

  // Floor backgrounds + textures (clipped to exclude arc voids)
  let hasTexturedCells = false;
  withArcClip(ctx, hasRoundedArcs, roundedCorners, gridSize, transform, () => {
    hasTexturedCells = renderFloors(ctx, cells, roomCells, gridSize, theme, transform, textureOptions);
  });

  // Arc secondary post-pass: for each arc wedge, draw textureSecondary inside the void-corner region.
  // Iterates roundedCorners (not cells) so it catches all cells clipped by each wedge, including
  // adjacent floor cells that don't have trimRound themselves (happens with larger-radius arcs).
  if (hasRoundedArcs && textureOptions?.catalog) {
    const catalog = textureOptions.catalog;
    const cellPx = gridSize * transform.scale;
    const canBatch = typeof DOMMatrix !== 'undefined' && typeof ctx.createPattern === 'function';
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    for (const rc of roundedCorners.values()) {
      const ocp = toCanvas(rc.centerCol * gridSize, rc.centerRow * gridSize, transform);
      const Rpx = rc.radius * gridSize * transform.scale;
      // Build the void-corner wedge clip for this arc
      ctx.save();
      ctx.beginPath();
      if (!rc.inverted) {
        let acx, acy;
        switch (rc.corner) {
          case 'nw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
          case 'ne': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
          case 'sw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
          case 'se': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
        }
        const acp = toCanvas(acx, acy, transform);
        switch (rc.corner) {
          case 'nw': ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x + Rpx, ocp.y); ctx.arc(acp.x, acp.y, Rpx, 3*Math.PI/2, Math.PI, true);  ctx.lineTo(ocp.x, ocp.y); break;
          case 'ne': ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x - Rpx, ocp.y); ctx.arc(acp.x, acp.y, Rpx, 3*Math.PI/2, 0, false);        ctx.lineTo(ocp.x, ocp.y); break;
          case 'sw': ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x + Rpx, ocp.y); ctx.arc(acp.x, acp.y, Rpx, Math.PI/2, Math.PI, false);    ctx.lineTo(ocp.x, ocp.y); break;
          case 'se': ctx.moveTo(ocp.x, ocp.y); ctx.lineTo(ocp.x - Rpx, ocp.y); ctx.arc(acp.x, acp.y, Rpx, Math.PI/2, 0, true);           ctx.lineTo(ocp.x, ocp.y); break;
        }
      } else {
        let startAngle, endAngle, anticlockwise;
        switch (rc.corner) {
          case 'nw': startAngle = Math.PI / 2;   endAngle = 0;               anticlockwise = true;  break;
          case 'ne': startAngle = Math.PI / 2;   endAngle = Math.PI;         anticlockwise = false; break;
          case 'sw': startAngle = 0;             endAngle = 3 * Math.PI / 2; anticlockwise = true;  break;
          case 'se': startAngle = Math.PI;       endAngle = 3 * Math.PI / 2; anticlockwise = false; break;
        }
        ctx.moveTo(ocp.x, ocp.y);
        ctx.lineTo(ocp.x + Rpx * Math.cos(startAngle), ocp.y + Rpx * Math.sin(startAngle));
        ctx.arc(ocp.x, ocp.y, Rpx, startAngle, endAngle, anticlockwise);
        ctx.lineTo(ocp.x, ocp.y);
      }
      ctx.closePath();
      ctx.clip();
      // Bounding box in cell indices: which cells could overlap this wedge?
      const R = rc.radius;
      let r0, r1, c0, c1;
      switch (rc.corner) {
        case 'nw': r0 = rc.centerRow;     r1 = rc.centerRow + R; c0 = rc.centerCol;     c1 = rc.centerCol + R; break;
        case 'ne': r0 = rc.centerRow;     r1 = rc.centerRow + R; c0 = rc.centerCol - R; c1 = rc.centerCol;     break;
        case 'sw': r0 = rc.centerRow - R; r1 = rc.centerRow;     c0 = rc.centerCol;     c1 = rc.centerCol + R; break;
        case 'se': r0 = rc.centerRow - R; r1 = rc.centerRow;     c0 = rc.centerCol - R; c1 = rc.centerCol;     break;
      }
      r0 = Math.max(0, Math.floor(r0));
      r1 = Math.min(numRows - 1, Math.ceil(r1));
      c0 = Math.max(0, Math.floor(c0));
      c1 = Math.min(numCols - 1, Math.ceil(c1));
      // Interior-only: exterior not revealed — skip the entire wedge texture pass.
      // The arc void clip already prevents renderFloors from drawing here;
      // this skip prevents the per-cell textureSecondary loop from drawing too.
      if (rc.hideExterior) {
        ctx.restore();
        continue;
      }
      // Void-corner background fill for player fog exterior-only reveal:
      // trimInsideArc cells in the corner are null in playerCells (not in revealedCells)
      // and are skipped by the per-cell loop below. Fill the entire clip region first
      // using the terrain texture synthesized by fog.js onto any trimRound cell.
      let hasExteriorOnly = false;
      {
        let bgTex = null, bgOp = 1.0;
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) {
            const cell = cells[row]?.[col];
            if (cell?.trimShowExteriorOnly) {
              hasExteriorOnly = true;
              if (cell.textureSecondary && !bgTex) {
                bgTex = cell.textureSecondary;
                bgOp = cell.textureSecondaryOpacity ?? 1.0;
              }
            }
          }
        }
        if (hasExteriorOnly) {
          const tl0 = toCanvas(c0 * gridSize, r0 * gridSize, transform);
          const br1 = toCanvas((c1 + 1) * gridSize, (r1 + 1) * gridSize, transform);
          const bw = br1.x - tl0.x, bh = br1.y - tl0.y;
          if (bgTex) {
            const entry = catalog.textures[bgTex];
            if (entry?.img?.complete && entry.img.naturalWidth) {
              if (canBatch) {
                const pattern = _getTexPattern(ctx, entry);
                _applyPatternTransform(pattern, entry, cellPx, transform);
                ctx.globalAlpha = bgOp;
                ctx.fillStyle = pattern;
                ctx.beginPath();
                ctx.rect(tl0.x, tl0.y, bw, bh);
                ctx.fill();
              } else {
                for (let row = r0; row <= r1; row++) {
                  for (let col = c0; col <= c1; col++) {
                    const tl = toCanvas(col * gridSize, row * gridSize, transform);
                    const { srcX, srcY, srcW, srcH } = getTexChunk(entry, row, col);
                    ctx.globalAlpha = bgOp;
                    ctx.drawImage(entry.img, srcX, srcY, srcW, srcH, tl.x, tl.y, cellPx, cellPx);
                  }
                }
              }
            }
          } else {
            ctx.fillStyle = theme.wallFill;
            ctx.globalAlpha = 1.0;
            ctx.beginPath();
            ctx.rect(tl0.x, tl0.y, bw, bh);
            ctx.fill();
          }
        }
      }
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          if (!roomCells[row]?.[col]) continue;
          const cell = cells[row]?.[col];
          if (!cell?.textureSecondary) {
            // Background fill already covered the full bbox with bgTex terrain texture.
            // No per-cell wallFill needed — that would overwrite the terrain with dark stone,
            // making subsequent grid lines invisible (black-on-black).
            continue;
          }
          const entry = catalog.textures[cell.textureSecondary];
          if (!entry?.img?.complete || !entry.img.naturalWidth) continue;
          const tl = toCanvas(col * gridSize, row * gridSize, transform);
          const texOp = cell.textureSecondaryOpacity ?? 1.0;
          if (canBatch) {
            const pattern = _getTexPattern(ctx, entry);
            _applyPatternTransform(pattern, entry, cellPx, transform);
            ctx.globalAlpha = texOp;
            ctx.fillStyle = pattern;
            ctx.beginPath();
            ctx.rect(tl.x, tl.y, cellPx, cellPx);
            ctx.fill();
          } else {
            const { srcX, srcY, srcW, srcH } = getTexChunk(entry, row, col);
            ctx.globalAlpha = texOp;
            ctx.drawImage(entry.img, srcX, srcY, srcW, srcH, tl.x, tl.y, cellPx, cellPx);
          }
        }
      }
      ctx.restore();

      // Supplemental grid for null cells in the wedge that drawMatrixGrid
      // cannot reach (it only draws between adjacent room cells). Drawn
      // WITHOUT the curved wedge clip so lines match the main grid weight.
      // Only draws edges where at least one side is NOT a room cell, so
      // there is no overlap with the main grid pass.
      if (hasExteriorOnly && showGrid) {
        ctx.strokeStyle = theme.gridLine;
        ctx.lineWidth = 1;
        ctx.lineCap = 'butt';
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) {
            const here = !!roomCells[row]?.[col];
            const south = !!roomCells[row + 1]?.[col];
            const east  = !!roomCells[row]?.[col + 1];
            // Bottom edge — skip if main grid already draws it (both room cells)
            if (!here || !south) {
              const p1 = toCanvas(col * gridSize, (row + 1) * gridSize, transform);
              const p2 = toCanvas((col + 1) * gridSize, (row + 1) * gridSize, transform);
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(p2.x, p2.y);
            }
            // Right edge — skip if main grid already draws it (both room cells)
            if (!here || !east) {
              const p1 = toCanvas((col + 1) * gridSize, row * gridSize, transform);
              const p2 = toCanvas((col + 1) * gridSize, (row + 1) * gridSize, transform);
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(p2.x, p2.y);
            }
          }
        }
        // Top edge of first row and left edge of first column
        for (let col = c0; col <= c1; col++) {
          if (!roomCells[r0 - 1]?.[col] || !roomCells[r0]?.[col]) {
            const p1 = toCanvas(col * gridSize, r0 * gridSize, transform);
            const p2 = toCanvas((col + 1) * gridSize, r0 * gridSize, transform);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
          }
        }
        for (let row = r0; row <= r1; row++) {
          if (!roomCells[row]?.[c0 - 1] || !roomCells[row]?.[c0]) {
            const p1 = toCanvas(c0 * gridSize, row * gridSize, transform);
            const p2 = toCanvas(c0 * gridSize, (row + 1) * gridSize, transform);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
          }
        }
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }
    }
    ctx.globalAlpha = 1.0;
  }

  // Texture edge + corner blending
  if (hasTexturedCells) {
    renderTextureBlending(ctx, cells, roomCells, roundedCorners, hasRoundedArcs, gridSize, transform, textureOptions);
  }

  // Fill patterns (pit/water/lava) — grid drawn later so bridges sit under it
  renderFillPatternsAndGrid(ctx, cells, roomCells, roundedCorners, hasRoundedArcs, gridSize, theme, transform, showGrid, true);

  // Buffer shading + walls + arc walls
  renderWallsAndBorders(ctx, cells, roomCells, roundedCorners, gridSize, theme, transform, showInvisible);

  // Bridges — rendered above fills and walls but below grid, props, and labels
  const getTextureImageForBridges = textureOptions?.catalog
    ? (id) => { const e = textureOptions.catalog.textures[id]; return e?.img?.complete ? e.img : null; }
    : null;
  renderAllBridges(ctx, metadata?.bridges, gridSize, theme, transform, getTextureImageForBridges);

  // Grid overlay — drawn after bridges so grid lines show on top of bridge surface
  if (showGrid) {
    withArcClip(ctx, hasRoundedArcs, roundedCorners, gridSize, transform, () => {
      drawMatrixGrid(ctx, cells, roomCells, gridSize, transform, theme, showGrid);
    }, true);
  }

  // Props, labels, stairs
  renderLabelsStairsProps(ctx, cells, gridSize, theme, transform, labelStyle, propCatalog, textureOptions, metadata, skipLabels);

  // Hazard overlay — topmost layer, renders above everything
  renderHazardOverlay(ctx, cells, gridSize, transform);
}
