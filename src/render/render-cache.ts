import type { Cell, CellGrid, RenderTransform, TextureOptions, Theme } from '../types.js';
import { getDirtyRegion, _accumulateDirtyCell, _bumpGeometryVersion, bumpContentVersion } from './render-state.js';
import { determineRoomCells } from './floors.js';
import { patchBlendRegion, getBlendCacheParams, invalidateBlendLayerCache } from './blend.js';
import { invalidateFluidCache, patchFluidRegion, getFluidCacheParams } from './fluid.js';
import { invalidateVisibilityCache } from './lighting.js';
import { invalidateEffectsCache } from './effects.js';
import { toCanvas } from './bounds.js';

// Re-export cache invalidation functions (public API maintained for direct importers)
export { invalidateFluidCache };
export { invalidateBlendLayerCache };

// ── Per-frame caches (invalidated by cells reference change) ─────────
let _roomCellsCache: { cells: CellGrid | null; result: boolean[][] | null } = { cells: null, result: null };
/**
 * Return cached room cell mask, recomputing only when cells reference changes.
 * @param {Array<Array<Object>>} cells - 2D grid of cell objects
 * @returns {Array<Array<boolean>>} 2D boolean grid where true = room cell
 */
export function getCachedRoomCells(cells: CellGrid): boolean[][] {
  if (_roomCellsCache.cells === cells) return _roomCellsCache.result!;
  const result = determineRoomCells(cells);
  _roomCellsCache = { cells, result };
  return result;
}

/**
 * Call this whenever cell geometry changes in-place (rooms created/destroyed, walls/trims modified).
 * Resets room cell topology, rounded corners, hatching, and shading caches.
 * Does NOT clear fluid caches — call invalidateFluidCache() separately if fluids are affected.
 * @returns {void}
 */
export function invalidateGeometryCache(): void {
  _roomCellsCache = { cells: null, result: null };
  invalidateEffectsCache();
}

// ── Smart cache invalidation ─────────────────────────────────────────────────

function _cellHasFluid(cell: Cell | null): boolean {
  if (!cell) return false;
  return cell.fill === 'water' || cell.fill === 'lava' || cell.fill === 'pit' || !!cell.hazard;
}

function _neighborHasFluid(row: number, col: number, cells: CellGrid): boolean {
  return (
    _cellHasFluid(cells[row - 1]?.[col] ?? null) ||
    _cellHasFluid(cells[row + 1]?.[col] ?? null) ||
    _cellHasFluid(cells[row]?.[col - 1] ?? null) ||
    _cellHasFluid(cells[row]?.[col + 1] ?? null)
  );
}

/**
 * Capture the before-state of a set of cells prior to mutation.
 * Pass the result to smartInvalidate() after the mutation to determine which caches to clear.
 *
 * @param {Array} cells  The cell grid (pre-mutation)
 * @param {Array<{row, col}>} coords  Cells about to be mutated
 * @returns {Array<{row, col, wasVoid, fill, waterDepth, lavaDepth, hazard}>}
 */
interface BeforeState {
  row: number;
  col: number;
  wasVoid: boolean;
  fill: string | null;
  waterDepth: number | null;
  lavaDepth: number | null;
  hazard: boolean;
}

export function captureBeforeState(cells: CellGrid, coords: Array<{ row: number; col: number }>): BeforeState[] {
  return coords.map(({ row, col }) => {
    const cell = cells[row]?.[col];
    if (!cell) return { row, col, wasVoid: true, fill: null, waterDepth: null, lavaDepth: null, hazard: false };
    return {
      row,
      col,
      wasVoid: false,
      fill: (cell.fill as string | null) ?? null,
      waterDepth: (cell.waterDepth as number | null) ?? null,
      lavaDepth: (cell.lavaDepth as number | null) ?? null,
      hazard: !!cell.hazard,
    };
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
 * @returns {void}
 *
 * Rules:
 *  - Any void↔floor transition → invalidateGeometryCache() + invalidateBlendLayerCache()
 *  - Any cell whose fill/depth/hazard data actually changed → invalidateFluidCache()
 *  - Void transitions near fluid cells → also invalidateFluidCache()
 *  - Wall/metadata changes with no void or fluid involvement → nothing cleared
 */
export function smartInvalidate(
  changes: BeforeState[],
  cells: CellGrid,
  { forceGeometry = false, forceFluid = false }: { forceGeometry?: boolean; forceFluid?: boolean } = {},
): void {
  let needsGeometry = forceGeometry;
  let needsFluid = forceFluid;

  for (const {
    row,
    col,
    wasVoid,
    fill: beforeFill,
    waterDepth: beforeWD,
    lavaDepth: beforeLD,
    hazard: beforeHazard,
  } of changes) {
    if (needsGeometry && needsFluid) break;

    const afterCell = cells[row]?.[col] ?? null;
    const isVoid = afterCell === null;

    if (wasVoid !== isVoid) {
      needsGeometry = true;
      if (!needsFluid) {
        const hadFluid = beforeFill === 'water' || beforeFill === 'lava' || beforeFill === 'pit' || beforeHazard;
        if (hadFluid || _cellHasFluid(afterCell) || _neighborHasFluid(row, col, cells)) {
          needsFluid = true;
        }
      }
    } else if (!wasVoid && !isVoid) {
      if (
        beforeFill !== afterCell.fill ||
        beforeWD !== afterCell.waterDepth ||
        beforeLD !== afterCell.lavaDepth ||
        beforeHazard !== afterCell.hazard
      ) {
        needsFluid = true;
      }
    }
  }

  if (needsGeometry) {
    invalidateGeometryCache();
    _bumpGeometryVersion();
  }

  // Accumulate dirty region for partial cache redraws.
  // Must be computed BEFORE the blend/fluid patches so the region is available.
  for (const { row, col } of changes) {
    _accumulateDirtyCell(row, col);
  }

  const dirtyRegion = getDirtyRegion();

  // Fluid cache: locally rebuild just the dirty region on the existing render
  // layer — works for both adding and removing fills.
  if (needsFluid) {
    const fp = !forceFluid ? getFluidCacheParams() : null;
    if (fp && dirtyRegion) {
      const roomCells = getCachedRoomCells(cells);
      patchFluidRegion(dirtyRegion, cells, roomCells, fp.gridSize, fp.theme);
    } else {
      invalidateFluidCache();
    }
    // Lava emits light — invalidate the static lightmap so fill lights
    // are re-extracted and rendered during the composite update.
    invalidateVisibilityCache(false);
  }

  // Patch blend edges for the dirty region if a blend cache already exists.
  if (needsGeometry && dirtyRegion) {
    _patchBlendFromCache(cells, dirtyRegion);
  }

  bumpContentVersion();
}

/** Patch blend topology for a dirty region using parameters from the existing blend cache. */
function _patchBlendFromCache(
  cells: CellGrid,
  region: { minRow: number; maxRow: number; minCol: number; maxCol: number },
): void {
  // Grab the blend cache's stored catalog + settings (set during the last full build)
  const cached = getBlendCacheParams();
  if (!cached) return; // no blend cache exists yet — nothing to patch
  const roomCells = getCachedRoomCells(cells);
  patchBlendRegion(region, cells, roomCells, cached.gridSize, {
    catalog: cached.catalog,
    blendWidth: cached.blendWidth,
    texturesVersion: cached.texturesVersion,
  });
}

/**
 * Incremental blend patch — rebuilds only blend edges/corners touching a dirty region.
 * Uses cached roomCells so the caller doesn't need to compute them.
 * @param {{ minRow: number, maxRow: number, minCol: number, maxCol: number }} region - Dirty region bounds
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} textureOptions - Texture catalog and blend settings
 * @returns {void}
 */
export function patchBlendForDirtyRegion(
  region: { minRow: number; maxRow: number; minCol: number; maxCol: number },
  cells: CellGrid,
  gridSize: number,
  textureOptions: TextureOptions | null,
): void {
  if (!textureOptions) return;
  const roomCells = getCachedRoomCells(cells);
  patchBlendRegion(region, cells, roomCells, gridSize, textureOptions);
}

/**
 * Incremental fluid patch — rebuilds only fluid geometry touching a dirty region.
 * @param {{ minRow: number, maxRow: number, minCol: number, maxCol: number }} region - Dirty region bounds
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Current theme object
 * @returns {void}
 */
export function patchFluidForDirtyRegion(
  region: { minRow: number; maxRow: number; minCol: number; maxCol: number },
  cells: CellGrid,
  gridSize: number,
  theme: Theme,
): void {
  const roomCells = getCachedRoomCells(cells);
  patchFluidRegion(region, cells, roomCells, gridSize, theme);
}

/**
 * Collect rounded corner arc descriptors from cells with trimRound.
 * Keyed by arc center — all trimRound cells sharing a center contribute to one entry.
 *
 * Entry flags (set by fog.js for player view, aggregated via OR across all cells):
 *   isOpen        — Decorative arc (no wall).
 *   exteriorOnly  — Player fog: only exterior revealed.
 *   hideExterior  — Player fog: only interior revealed.
 *
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @returns {Map<string, Object>} Map of arc center keys to corner descriptor objects
 */
export function collectRoundedCorners(cells: CellGrid): Map<string, Record<string, unknown>> {
  const roundedCorners = new Map();
  const numRows = cells.length;
  for (let row = 0; row < numRows; row++) {
    const numCols = cells[row]?.length ?? 0;
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
 * Trace a single arc wedge pie-slice subpath for one rounded corner.
 * Appends to the current path — caller must beginPath/closePath/clip.
 * Used by the player fog overlay (arc-aware fog masking).
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Object} rc - Rounded corner descriptor (centerRow, centerCol, radius, corner, inverted)
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {void}
 */
export function traceArcWedge(
  ctx: CanvasRenderingContext2D,
  rc: {
    row: number;
    col: number;
    radius: number;
    centerRow: number;
    centerCol: number;
    corner: string;
    inverted: boolean;
    startAngle: number;
    endAngle: number;
  },
  gridSize: number,
  transform: RenderTransform,
): void {
  const ocp = toCanvas(rc.centerCol * gridSize, rc.centerRow * gridSize, transform);
  const Rpx = rc.radius * gridSize * transform.scale;
  if (rc.inverted) {
    let startAngle = 0,
      endAngle = 0,
      anticlockwise = false;
    switch (rc.corner) {
      case 'nw':
        startAngle = Math.PI / 2;
        endAngle = 0;
        anticlockwise = true;
        break;
      case 'ne':
        startAngle = Math.PI / 2;
        endAngle = Math.PI;
        anticlockwise = false;
        break;
      case 'sw':
        startAngle = 0;
        endAngle = (3 * Math.PI) / 2;
        anticlockwise = true;
        break;
      case 'se':
        startAngle = Math.PI;
        endAngle = (3 * Math.PI) / 2;
        anticlockwise = false;
        break;
    }
    ctx.moveTo(ocp.x, ocp.y);
    ctx.lineTo(ocp.x + Rpx * Math.cos(startAngle), ocp.y + Rpx * Math.sin(startAngle));
    ctx.arc(ocp.x, ocp.y, Rpx, startAngle, endAngle, anticlockwise);
    ctx.lineTo(ocp.x, ocp.y);
  } else {
    let acx = 0,
      acy = 0;
    switch (rc.corner) {
      case 'nw':
        acx = (rc.centerCol + rc.radius) * gridSize;
        acy = (rc.centerRow + rc.radius) * gridSize;
        break;
      case 'ne':
        acx = (rc.centerCol - rc.radius) * gridSize;
        acy = (rc.centerRow + rc.radius) * gridSize;
        break;
      case 'sw':
        acx = (rc.centerCol + rc.radius) * gridSize;
        acy = (rc.centerRow - rc.radius) * gridSize;
        break;
      case 'se':
        acx = (rc.centerCol - rc.radius) * gridSize;
        acy = (rc.centerRow - rc.radius) * gridSize;
        break;
    }
    const acp = toCanvas(acx, acy, transform);
    switch (rc.corner) {
      case 'nw':
        ctx.moveTo(ocp.x, ocp.y);
        ctx.lineTo(ocp.x + Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, (3 * Math.PI) / 2, Math.PI, true);
        ctx.lineTo(ocp.x, ocp.y);
        break;
      case 'ne':
        ctx.moveTo(ocp.x, ocp.y);
        ctx.lineTo(ocp.x - Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, (3 * Math.PI) / 2, 0, false);
        ctx.lineTo(ocp.x, ocp.y);
        break;
      case 'sw':
        ctx.moveTo(ocp.x, ocp.y);
        ctx.lineTo(ocp.x + Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, Math.PI, false);
        ctx.lineTo(ocp.x, ocp.y);
        break;
      case 'se':
        ctx.moveTo(ocp.x, ocp.y);
        ctx.lineTo(ocp.x - Rpx, ocp.y);
        ctx.arc(acp.x, acp.y, Rpx, Math.PI / 2, 0, true);
        ctx.lineTo(ocp.x, ocp.y);
        break;
    }
  }
}

/**
 * Run `fn` inside a clip that excludes the void portions of trim cells
 * (both arc trimClip and straight diagonal trims).
 * Uses evenodd: canvas rect (odd=visible) + per-cell [cellRect + roomPoly] (even=void, odd=floor).
 * No-op if no trim cells exist in the grid.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {Function} fn - Callback to invoke inside the clip
 * @returns {void}
 */
export function withTrimVoidClip(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  gridSize: number,
  transform: RenderTransform,
  fn: () => void,
): void {
  // Quick scan: bail early if no closed trim cells exist
  let hasTrim = false;
  for (let r = 0; !hasTrim && r < cells.length; r++)
    for (let c = 0; !hasTrim && c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (cell?.trimClip && !cell.trimOpen) hasTrim = true;
      else if (cell?.trimCorner && !cell.trimClip && !cell.trimOpen) hasTrim = true;
    }

  if (!hasTrim) {
    fn();
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      const tl = toCanvas(c * gridSize, r * gridSize, transform);
      const gs = gridSize * transform.scale;
      if (cell.trimClip && !cell.trimOpen) {
        // Arc trim: cell rect + trimClip polygon
        const clip = cell.trimClip;
        ctx.rect(tl.x, tl.y, gs, gs);
        ctx.moveTo(tl.x + clip[0]![0]! * gs, tl.y + clip[0]![1]! * gs);
        for (let i = 1; i < clip.length; i++) ctx.lineTo(tl.x + clip[i]![0]! * gs, tl.y + clip[i]![1]! * gs);
        ctx.closePath();
      } else if (cell.trimCorner && !cell.trimClip && !cell.trimOpen) {
        // Diagonal trim: cell rect + room triangle (excludes void corner)
        const tr = { x: tl.x + gs, y: tl.y };
        const bl = { x: tl.x, y: tl.y + gs };
        const br = { x: tl.x + gs, y: tl.y + gs };
        ctx.rect(tl.x, tl.y, gs, gs);
        switch (cell.trimCorner) {
          case 'nw':
            ctx.moveTo(tr.x, tr.y);
            ctx.lineTo(br.x, br.y);
            ctx.lineTo(bl.x, bl.y);
            break;
          case 'ne':
            ctx.moveTo(tl.x, tl.y);
            ctx.lineTo(bl.x, bl.y);
            ctx.lineTo(br.x, br.y);
            break;
          case 'sw':
            ctx.moveTo(tl.x, tl.y);
            ctx.lineTo(tr.x, tr.y);
            ctx.lineTo(br.x, br.y);
            break;
          case 'se':
            ctx.moveTo(tl.x, tl.y);
            ctx.lineTo(tr.x, tr.y);
            ctx.lineTo(bl.x, bl.y);
            break;
        }
        ctx.closePath();
      }
    }
  }
  ctx.clip('evenodd');
  fn();
  ctx.restore();
}
