import type { Cell, CellGrid, RenderTransform, TextureOptions, Theme } from '../types.js';
import { getDirtyRegion, _accumulateDirtyCell, _bumpGeometryVersion, bumpContentVersion } from './render-state.js';
import { determineRoomCells } from './floors.js';
import { patchBlendRegion, getBlendCacheParams, invalidateBlendLayerCache } from './blend.js';
import { invalidateFluidCache, patchFluidRegion, getFluidCacheParams } from './fluid.js';
import { invalidateVisibilityCache } from './lighting.js';
import { invalidateEffectsCache } from './effects.js';
import { toCanvas } from './bounds.js';
import { getSegments, log } from '../util/index.js';

/**
 * Snapshot every segment's texture id (or null if empty). Used by
 * `captureBeforeState` to detect texture-only mutations cheaply via diff
 * against the post-op state.
 */
function snapshotSegmentTextures(cell: Cell): (string | null)[] {
  return getSegments(cell).map((s) => s.texture ?? null);
}

/** True if two segment-texture snapshots differ in any slot. */
function segmentTexturesDiffer(a: (string | null)[], b: (string | null)[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

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
  log.devTrace(`invalidateGeometryCache() — room cells + effects cleared`);
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
  /**
   * Per-segment texture ids (or `null` for an empty segment). Length equals
   * the cell's segment count at snapshot time. Compared element-wise against
   * a fresh snapshot in `smartInvalidate` to detect any texture change.
   */
  segmentTextures: (string | null)[];
}

export function captureBeforeState(cells: CellGrid, coords: Array<{ row: number; col: number }>): BeforeState[] {
  return coords.map(({ row, col }) => {
    const cell = cells[row]?.[col];
    if (!cell)
      return {
        row,
        col,
        wasVoid: true,
        fill: null,
        waterDepth: null,
        lavaDepth: null,
        hazard: false,
        segmentTextures: [],
      };
    return {
      row,
      col,
      wasVoid: false,
      fill: (cell.fill as string | null) ?? null,
      waterDepth: (cell.waterDepth as number | null) ?? null,
      lavaDepth: (cell.lavaDepth as number | null) ?? null,
      hazard: !!cell.hazard,
      segmentTextures: snapshotSegmentTextures(cell),
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
  {
    forceGeometry = false,
    forceFluid = false,
    textureOnly = false,
  }: { forceGeometry?: boolean; forceFluid?: boolean; textureOnly?: boolean } = {},
): void {
  let needsGeometry = forceGeometry;
  let needsFluid = forceFluid;
  // Track texture changes so undo/redo and right-click paths trigger a blend
  // patch — the blend topology is keyed on neighbouring textures, and stale
  // blends are visible as wrong-coloured edges at texture seams after undo.
  let needsBlend = false;

  for (const {
    row,
    col,
    wasVoid,
    fill: beforeFill,
    waterDepth: beforeWD,
    lavaDepth: beforeLD,
    hazard: beforeHazard,
    segmentTextures: beforeSegTex,
  } of changes) {
    if (needsGeometry && needsFluid && needsBlend) break;

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
      // Void↔floor toggles alter the blend topology too (appearing/disappearing cells).
      // Check both sides: removing a textured cell drops blend edges; adding a textured
      // cell introduces new ones. Empty-floor toggles (no texture either side) don't
      // touch blend.
      if (
        beforeSegTex.some((t) => t !== null) ||
        (afterCell !== null && snapshotSegmentTextures(afterCell).some((t) => t !== null))
      ) {
        needsBlend = true;
      }
    } else if (!wasVoid && !isVoid) {
      // captureBeforeState normalizes missing fields to null, but the raw cell
      // object may have `undefined` for fields that were never set. Naively
      // comparing `null !== undefined` is true — so any edit on a cell without
      // a fill triggered a full fluid composite rebuild. Normalize both sides.
      const afterFill = afterCell.fill ?? null;
      const afterWD = afterCell.waterDepth ?? null;
      const afterLD = afterCell.lavaDepth ?? null;
      const afterHazard = !!afterCell.hazard;
      const afterSegTex = snapshotSegmentTextures(afterCell);
      if (segmentTexturesDiffer(beforeSegTex, afterSegTex)) {
        needsBlend = true;
      }
      if (beforeFill !== afterFill || beforeWD !== afterWD || beforeLD !== afterLD || beforeHazard !== afterHazard) {
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

  // Fluid cache: with the tile-composite architecture, variant clips are
  // cheap to rebuild (O(fluid cells)), and tile textures stay valid across
  // cell edits. We just bust the clip cache and let the next composite
  // rebuild produce fresh geometry.
  if (needsFluid) {
    const fp = !forceFluid ? getFluidCacheParams() : null;
    if (fp && dirtyRegion) {
      const roomCells = getCachedRoomCells(cells);
      patchFluidRegion(dirtyRegion, cells, roomCells, fp.gridSize, {} as Theme);
    } else {
      invalidateFluidCache();
    }
    // Lava emits light — invalidate the static lightmap so fill lights
    // are re-extracted and rendered during the composite update.
    invalidateVisibilityCache('lights');
  }

  // Patch blend edges for the dirty region if a blend cache already exists.
  // `needsGeometry` covers void↔floor transitions (edges may appear/disappear);
  // `needsBlend` covers texture-change edits (undo/redo, right-click clear,
  // any direct-mutation path that doesn't call _patchBlend itself).
  if ((needsGeometry || needsBlend) && dirtyRegion) {
    _patchBlendFromCache(cells, dirtyRegion);
  }

  // Top-layer (walls/props/hazard) only needs rebuild when something other than
  // pure texture changed. `textureOnly` lets texture-paint paths skip the top
  // rebuild entirely so a region-fill near a diagonal door doesn't clear + re-clip
  // the walls layer (which was the cause of diagonal features being half-cut
  // when their geometry straddled the partial-rebuild clip boundary).
  // Any geometry change (void↔floor) always bumps top because walls can appear/disappear with it.
  const topChanged = !textureOnly || needsGeometry;
  bumpContentVersion({ topChanged });
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
  // A cell needs void-clipping when any of its segments is voided.
  // Quick scan: bail early if no such cells exist.
  let hasVoid = false;
  for (let r = 0; !hasVoid && r < cells.length; r++)
    for (let c = 0; !hasVoid && c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      const segs = getSegments(cell);
      if (segs.some((s) => s.voided)) hasVoid = true;
    }

  if (!hasVoid) {
    fn();
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // For each split cell with a voided segment, add `cellRect` + `non-voided
  // segment polygon(s)` to the path. With `'evenodd'`, the cell rect is
  // even (excluded), the non-voided polygon is odd (included) — so we end
  // up clipping to canvas-rect minus the voided slivers.
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      const segs = getSegments(cell);
      if (!segs.some((s) => s.voided)) continue;
      const tl = toCanvas(c * gridSize, r * gridSize, transform);
      const gs = gridSize * transform.scale;
      ctx.rect(tl.x, tl.y, gs, gs);
      for (const seg of segs) {
        if (seg.voided) continue;
        const poly = seg.polygon;
        if (poly.length < 3) continue;
        ctx.moveTo(tl.x + poly[0]![0]! * gs, tl.y + poly[0]![1]! * gs);
        for (let i = 1; i < poly.length; i++) {
          ctx.lineTo(tl.x + poly[i]![0]! * gs, tl.y + poly[i]![1]! * gs);
        }
        ctx.closePath();
      }
    }
  }
  ctx.clip('evenodd');
  fn();
  ctx.restore();
}
