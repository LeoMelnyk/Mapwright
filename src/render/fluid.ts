// Fluid (water / lava / pit) rendering — tile-based fast path.
//
// The Voronoi pattern in WATER_PATTERNS is deterministic and tileable. We
// render it ONCE per (variant, color, resolution) into an offscreen tile
// canvas, then blit it across the map via `createPattern(..., 'repeat')`.
// Visible variation comes from each cell sampling a different ~1/64th slice
// of the 8-cell-wide tile — no per-cell Voronoi work at render time.
//
// Spill-over onto adjacent cells is preserved via a per-variant clip path:
// cell rects + non-same-fluid neighbor rects (+ same-fluid different-depth
// neighbors, so depth transitions stay organic). Each variant's clip is
// painted in depth order (deep → medium → shallow) so shallower depths
// overspill into deeper regions along the boundary.
//
// Pit vignettes remain per-region radial gradients drawn on top of the tile
// blits; they aren't tileable.
//
// ## Caches
//  - `_fluidCellsCache` / `_pitDataCache` — per-(cells, fillType) collections
//    of fluid cell positions + depth maps + pit region groupings. Invalidate
//    only on cells-grid identity change.
//  - `_variantTileCache` — one `HTMLCanvasElement` per (variant, colorSig,
//    overlayColor, gridSize, pxPerFoot). Rendered once, blitted everywhere.
//  - `_variantClipCache` — one `Path2D` per (cells, variant). Cheap to build
//    (O(fluid cells)); rebuilt on cells identity change.

import type { CellGrid, Cell, Direction, Theme } from '../types.js';
import { WATER_TILE_SIZE, WATER_PATTERNS, WATER_SPATIAL } from './patterns.js';
import { getEdge, log } from '../util/index.js';

// ── Variant taxonomy ──────────────────────────────────────────────────────

/** One of the 7 fill variants the renderer knows about. */
export type FluidVariant =
  | 'pit'
  | 'water-shallow'
  | 'water-medium'
  | 'water-deep'
  | 'lava-shallow'
  | 'lava-medium'
  | 'lava-deep';

/** All variants in the order they are painted (deep → shallow). */
export const FLUID_VARIANTS: readonly FluidVariant[] = [
  'pit',
  'water-deep',
  'water-medium',
  'water-shallow',
  'lava-deep',
  'lava-medium',
  'lava-shallow',
];

/**
 * `renderCells` skipPhases for the BASE pass (floors + blending). Use this
 * alongside the fluid composite blit to sandwich fluids between the floor
 * layer and the structural top phases. Paired with {@link FLUID_TOP_SKIP}.
 */
export const FLUID_BASE_SKIP: Readonly<Record<string, boolean>> = Object.freeze({
  grid: true,
  walls: true,
  props: true,
  hazard: true,
  fills: true,
  bridges: true,
});

/**
 * `renderCells` skipPhases for the TOP pass (bridges + walls + grid + props
 * + hazard). Bridges render above the fluid composite but below props, so
 * they live with the structural layers. Shading is owned by the caller or
 * composite sublayers, never redrawn here.
 */
export const FLUID_TOP_SKIP: Readonly<Record<string, boolean>> = Object.freeze({
  shading: true,
  floors: true,
  blending: true,
  fills: true,
});

interface VariantMeta {
  fillType: 'water' | 'lava' | 'pit';
  depth: 1 | 2 | 3 | null; // null for pit
}

const VARIANT_META: Record<FluidVariant, VariantMeta> = {
  pit: { fillType: 'pit', depth: null },
  'water-shallow': { fillType: 'water', depth: 1 },
  'water-medium': { fillType: 'water', depth: 2 },
  'water-deep': { fillType: 'water', depth: 3 },
  'lava-shallow': { fillType: 'lava', depth: 1 },
  'lava-medium': { fillType: 'lava', depth: 2 },
  'lava-deep': { fillType: 'lava', depth: 3 },
};

// ── Defaults (used when a theme omits a color) ────────────────────────────

interface FluidColorDefaults {
  base?: string;
  shallow: string;
  medium: string;
  deep: string;
  crack?: string;
  caustic: string;
  vignette?: string;
}

const FLUID_DEFAULTS: Record<'water' | 'lava', FluidColorDefaults> = {
  water: { shallow: '#2d69a5', medium: '#1e4b8a', deep: '#0f2d6e', caustic: 'rgba(160,215,255,0.55)' },
  lava: { shallow: '#cc4400', medium: '#992200', deep: '#661100', caustic: 'rgba(255,160,60,0.55)' },
};

const PIT_DEFAULTS: FluidColorDefaults = {
  base: '#1a1a18',
  crack: 'rgba(0,0,0,0.45)',
  vignette: 'rgba(0,0,0,0.65)',
  shallow: '#1a1a18',
  medium: '#111110',
  deep: '#0a0a08',
  caustic: 'transparent',
};

function variantBaseColor(variant: FluidVariant, theme: Theme): string {
  const t = theme as Record<string, unknown>;
  switch (variant) {
    case 'pit':
      return (t.pitBaseColor as string | undefined) ?? PIT_DEFAULTS.base!;
    case 'water-shallow':
      return (t.waterShallowColor as string | undefined) ?? FLUID_DEFAULTS.water.shallow;
    case 'water-medium':
      return (t.waterMediumColor as string | undefined) ?? FLUID_DEFAULTS.water.medium;
    case 'water-deep':
      return (t.waterDeepColor as string | undefined) ?? FLUID_DEFAULTS.water.deep;
    case 'lava-shallow':
      return (t.lavaShallowColor as string | undefined) ?? FLUID_DEFAULTS.lava.shallow;
    case 'lava-medium':
      return (t.lavaMediumColor as string | undefined) ?? FLUID_DEFAULTS.lava.medium;
    case 'lava-deep':
      return (t.lavaDeepColor as string | undefined) ?? FLUID_DEFAULTS.lava.deep;
  }
}

function variantOverlayColor(variant: FluidVariant, theme: Theme): string {
  const t = theme as Record<string, unknown>;
  if (variant === 'pit') return (t.pitCrackColor as string | undefined) ?? PIT_DEFAULTS.crack!;
  if (variant.startsWith('water')) return (t.waterCausticColor as string | undefined) ?? FLUID_DEFAULTS.water.caustic;
  return (t.lavaCausticColor as string | undefined) ?? FLUID_DEFAULTS.lava.caustic;
}

function hexToRgb(hex: string): [number, number, number] {
  const x = hex.replace('#', '');
  return [parseInt(x.substring(0, 2), 16), parseInt(x.substring(2, 4), 16), parseInt(x.substring(4, 6), 16)];
}

// ── Per-frame cell-collection caches ──────────────────────────────────────
// Reused as-is from the legacy path. These track WHICH cells are fluid, at
// WHICH depth, and (for pit) connected-region groupings for vignettes.

interface FluidData {
  fluidCells: [number, number][];
  depthMap: Map<number, number>;
  fluidSet: Set<number>;
  numCols: number;
}

interface PitData {
  cells: CellGrid | null;
  pitSet: Set<number> | null;
  pitCells: [number, number][] | null;
  groups: [number, number][][] | null;
  numCols: number;
  numRows: number;
}

let _fluidCellsCache: { cells: CellGrid | null; water: FluidData | null; lava: FluidData | null } = {
  cells: null,
  water: null,
  lava: null,
};
let _pitDataCache: PitData = { cells: null, pitSet: null, pitCells: null, groups: null, numCols: 0, numRows: 0 };

/**
 * Monotonic version bumped only when fluid-relevant data changes (variant
 * cells added/removed, depth tweaks, fluid theme recolor). MapCache keys
 * the fluid composite sig on this so wall/prop/texture edits — which bump
 * the global content version but don't touch fluids — don't force a full
 * fluid composite rebuild.
 */
let _fluidDataVersion = 0;
export function getFluidDataVersion(): number {
  return _fluidDataVersion;
}

// ── Partial-rebuild dirty region tracking ─────────────────────────────────
// `patchFluidRegion` accumulates the dirty cell region here so the next
// `buildFluidComposite` call can do a targeted clear+refill instead of a
// full-canvas rebuild. A pit-cell topology change disables partial rebuild
// for the next composite (vignette group centroids/radii recompute and paint
// outside the dirty rect), so we flip to full.
interface FluidDirtyRegion {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}
let _pendingPartialRegion: FluidDirtyRegion | null = null;
let _needsFullRebuild = true; // true on first composite (no canvas yet)

/**
 * Consume the pending dirty region. Returns `{ region, full }` describing
 * what the next composite rebuild should do. After this call, the pending
 * state is reset — the caller is expected to actually perform the rebuild.
 *
 *  - `full: true`  → rebuild the entire composite (theme change, cells-grid
 *    identity change, pit topology mutation, or first build).
 *  - `region` set  → clear+refill only that cell region.
 *  - both null     → no change pending (composite is up to date).
 */
export function consumeFluidPartialRegion(): { region: FluidDirtyRegion | null; full: boolean } {
  const result = _needsFullRebuild ? { region: null, full: true } : { region: _pendingPartialRegion, full: false };
  _pendingPartialRegion = null;
  _needsFullRebuild = false;
  return result;
}

function _markFullRebuild(): void {
  _needsFullRebuild = true;
  _pendingPartialRegion = null;
}

function _extendPartialRegion(region: FluidDirtyRegion): void {
  if (_needsFullRebuild) return; // full rebuild dominates
  if (!_pendingPartialRegion) {
    _pendingPartialRegion = { ...region };
    return;
  }
  const p = _pendingPartialRegion;
  if (region.minRow < p.minRow) p.minRow = region.minRow;
  if (region.maxRow > p.maxRow) p.maxRow = region.maxRow;
  if (region.minCol < p.minCol) p.minCol = region.minCol;
  if (region.maxCol > p.maxCol) p.maxCol = region.maxCol;
}

function _rebuildFluidCellsArrayFromSet(set: Set<number>, numCols: number): [number, number][] {
  // Sort by packed key so the resulting array is row-major (matches the
  // full-grid-scan ordering in `collectFluidCells`). The variant cell
  // signature hashes array order, so this keeps the polyClip cache stable.
  const keys = Array.from(set).sort((a, b) => a - b);
  const out: [number, number][] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    out[i] = [Math.floor(k / numCols), k % numCols];
  }
  return out;
}

function collectFluidCells(cells: CellGrid, roomCells: boolean[][], fillType: 'water' | 'lava'): FluidData {
  const depthKey = (fillType + 'Depth') as keyof Cell;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const fluidSet = new Set<number>();
  const fluidCells: [number, number][] = [];
  const depthMap = new Map<number, number>();
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (cell?.fill === fillType && roomCells[row]?.[col]) {
        const key = row * numCols + col;
        fluidSet.add(key);
        fluidCells.push([row, col]);
        depthMap.set(key, cell[depthKey] as number);
      }
    }
  }
  return { fluidCells, depthMap, fluidSet, numCols };
}

function getCachedFluidCells(cells: CellGrid, roomCells: boolean[][], fillType: 'water' | 'lava'): FluidData {
  if (_fluidCellsCache.cells !== cells) {
    _fluidCellsCache = { cells, water: null, lava: null };
  }
  _fluidCellsCache[fillType] ??= collectFluidCells(cells, roomCells, fillType);
  return _fluidCellsCache[fillType];
}

function getCachedPitData(cells: CellGrid, roomCells: boolean[][]): PitData {
  if (_pitDataCache.cells === cells) return _pitDataCache;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const pitSet = new Set<number>();
  const pitCells: [number, number][] = [];
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (cell?.fill === 'pit' && roomCells[row]?.[col]) {
        pitSet.add(row * numCols + col);
        pitCells.push([row, col]);
      }
    }
  }
  // BFS for connected pit groups (used for vignette rendering)
  const visited = new Set<number>();
  const groups: [number, number][][] = [];
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const key = row * numCols + col;
      if (visited.has(key) || !pitSet.has(key)) continue;
      const group: [number, number][] = [];
      const queue: [number, number][] = [[row, col]];
      visited.add(key);
      while (queue.length > 0) {
        const [r2, c2] = queue.shift()!;
        group.push([r2, c2]);
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const nr = r2 + dr,
            nc = c2 + dc;
          if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
          const nkey = nr * numCols + nc;
          if (!visited.has(nkey) && pitSet.has(nkey)) {
            visited.add(nkey);
            queue.push([nr, nc]);
          }
        }
      }
      groups.push(group);
    }
  }
  _pitDataCache = { cells, pitSet, pitCells, groups, numCols, numRows };
  return _pitDataCache;
}

// ── Variant tile cache ────────────────────────────────────────────────────

interface VariantTileEntry {
  canvas: HTMLCanvasElement;
  sig: string;
}
const _variantTileCache: Partial<Record<FluidVariant, VariantTileEntry>> = {};

/**
 * Get (or build) a tileable offscreen canvas for a fluid variant. The tile
 * is `gridSize * 8` world-feet wide (matches the legacy Voronoi tile size)
 * and rendered at `pxPerFoot` resolution. Repeated via `createPattern` when
 * blitted into the fluid composite.
 *
 * The tile bakes:
 *  - A base fill (variant color).
 *  - Each of ~670 Voronoi polygons with a fixed per-polygon jitter (seeded
 *    by `p.idx` only, so the pattern is stable across the map rather than
 *    per-cell random — visible variation still comes from each map cell
 *    sampling a different slice of the 8-cell tile).
 *  - A stroked overlay pass: caustics (water/lava) or cracks (pit).
 */
export function getFluidVariantTile(
  variant: FluidVariant,
  theme: Theme,
  gridSize: number,
  pxPerFoot: number,
): HTMLCanvasElement {
  const baseHex = variantBaseColor(variant, theme);
  const overlay = variantOverlayColor(variant, theme);
  const sig = `${baseHex}|${overlay}|${gridSize}|${pxPerFoot}`;
  const cached = _variantTileCache[variant];
  if (cached?.sig === sig) return cached.canvas;

  const tileWorld = gridSize * 8;
  const tilePx = Math.max(1, Math.ceil(tileWorld * pxPerFoot));
  const patternScale = tileWorld / WATER_TILE_SIZE; // world feet per pattern unit
  const pxScale = patternScale * pxPerFoot; // canvas px per pattern unit

  const canvas = cached?.canvas ?? document.createElement('canvas');
  if (canvas.width !== tilePx || canvas.height !== tilePx) {
    canvas.width = tilePx;
    canvas.height = tilePx;
  }
  const ctx = canvas.getContext('2d', { alpha: true })!;
  ctx.clearRect(0, 0, tilePx, tilePx);

  // Base fill — interior cells sit on this flat color; Voronoi polygons
  // sit on top with their jitter offsets.
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, tilePx, tilePx);

  const baseRgb = hexToRgb(baseHex);
  const isPit = variant === 'pit';

  // Jitter — seeded by polygon index only (not cell row/col) so the tile
  // is stable. Water/lava use ±6 (7 discrete levels); pit biases darker
  // with 5 levels.
  ctx.beginPath();
  for (const p of WATER_PATTERNS) {
    let js = Math.imul(p.idx! * 31 + 12345, 1664525) >>> 0;
    js = (Math.imul(js, 1664525) + 1013904223) >>> 0;
    const unit = js / 0x100000000;
    const jitter = isPit ? Math.round((unit - 0.55) * 5) * (16 / 5) : Math.round((unit - 0.5) * 7) * 2;
    const rv = Math.max(0, Math.min(255, Math.round(baseRgb[0] + jitter)));
    const gv = Math.max(0, Math.min(255, Math.round(baseRgb[1] + jitter)));
    const bv = Math.max(0, Math.min(255, Math.round(baseRgb[2] + jitter)));
    ctx.fillStyle = `rgb(${rv},${gv},${bv})`;
    ctx.beginPath();
    ctx.moveTo(p.verts[0]![0]! * pxScale, p.verts[0]![1]! * pxScale);
    for (let i = 1; i < p.verts.length; i++) {
      ctx.lineTo(p.verts[i]![0]! * pxScale, p.verts[i]![1]! * pxScale);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Overlay: stroke all Voronoi edges (caustic shimmer for water/lava,
  // crack lines for pit). Single batched Path2D for one stroke call.
  const overlayPath = new Path2D();
  for (const p of WATER_PATTERNS) {
    overlayPath.moveTo(p.verts[0]![0]! * pxScale, p.verts[0]![1]! * pxScale);
    for (let i = 1; i < p.verts.length; i++) {
      overlayPath.lineTo(p.verts[i]![0]! * pxScale, p.verts[i]![1]! * pxScale);
    }
    overlayPath.closePath();
  }
  ctx.strokeStyle = overlay;
  ctx.lineWidth = Math.max(isPit ? 0.3 : 0.5, pxPerFoot * (isPit ? 0.03 : 0.05));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(overlayPath);

  _variantTileCache[variant] = { canvas, sig };
  return canvas;
}

// ── Variant clip cache ────────────────────────────────────────────────────
//
// The clip for a variant is the union of:
//   1. cell rects for cells matching the variant's depth
//   2. non-same-fluid neighbor rects where the shared edge is open
//      (preserves ragged bleed onto void / dirt / different fluid families)
//   3. same-fluid different-depth neighbor rects (organic depth transitions)
//   4. trim polygons for cells with `trimClip`
//
// Variants are blitted deep → shallow (see `FLUID_VARIANTS` order) so
// shallower depths overspill into deeper cells along the boundary.

interface VariantClip {
  /**
   * Wall-respecting EXTENT in world-space: variant cell rects plus rects of
   * open-edge (non-walled) neighbors. Used to constrain the fluid from
   * bleeding through walls / doors.
   */
  extentClip: Path2D;
  /**
   * ORGANIC shape in world-space: the union of Voronoi polygons whose centre
   * falls inside a variant cell. These polygons naturally extend past cell
   * boundaries, giving the organic ragged edge — intersected with
   * `extentClip` at draw time, walls still respected.
   */
  polyClip: Path2D;
  /** True if any cells of this variant exist (else the composite skips it). */
  hasCells: boolean;
}

interface VariantClipCacheEntry {
  cells: CellGrid;
  gridSize: number;
  roomCellsRef: boolean[][];
  clips: Partial<Record<FluidVariant, VariantClip>>;
}
let _variantClipCache: VariantClipCacheEntry | null = null;

// Separate long-lived cache for the polyClip (the Voronoi-polygon-union),
// keyed on variant cell-set signature. Building this Path2D is the single
// biggest cost (~65µs per polygon for thousands of polygons), so we reuse
// it across any change that doesn't actually move a cell into or out of
// the variant — wall placements near water, door tweaks, prop edits, even
// floor painting adjacent to water, all bypass the rebuild.
interface PolyClipCacheEntry {
  cellSig: string;
  polyClip: Path2D;
}
const _polyClipCache: Partial<Record<FluidVariant, PolyClipCacheEntry>> = {};
let _polyClipCacheCellsRef: CellGrid | null = null;

function _variantCellSig(variantCells: [number, number][], numCols: number): string {
  // Cheap, order-agnostic signature. The cell pairs come out of
  // getCachedFluidCells / getCachedPitData in row-major order already, so
  // building the string is a single pass — no sort.
  let sig = `${variantCells.length}|`;
  for (let i = 0; i < variantCells.length; i++) {
    const [r, c] = variantCells[i]!;
    sig += r * numCols + c;
    sig += ',';
  }
  return sig;
}

const BLEED_DIRS: readonly [number, number, Direction][] = [
  [-1, 0, 'north'],
  [1, 0, 'south'],
  [0, -1, 'west'],
  [0, 1, 'east'],
];

// ── Polygon-by-cell index ─────────────────────────────────────────────────
// Maps grid-cell index (row*numCols + col) → list of every Voronoi polygon
// whose centre falls inside that cell, across all tile copies that cover
// the map. Built ONCE per (gridSize, numRows, numCols); stable across all
// cell mutations because it depends only on map dimensions and the fixed
// `WATER_PATTERNS` tile.
//
// Before this index: `buildVariantClip` iterated ~100k polygons per map
// per rebuild, taking ~2s on fluid-heavy maps. With it, clip construction
// is O(variant cells × polygons-per-cell ≈ 7) and each rebuild is <5ms.
interface IndexedPolygon {
  offX: number;
  offY: number;
  verts: number[][];
}
let _polyByCellCache: {
  key: string;
  map: Map<number, IndexedPolygon[]>;
} | null = null;

function getPolyByCell(gridSize: number, numRows: number, numCols: number): Map<number, IndexedPolygon[]> {
  const key = `${gridSize}|${numRows}|${numCols}`;
  if (_polyByCellCache?.key === key) return _polyByCellCache.map;
  const _t0 = performance.now();

  const tileWorld = gridSize * 8;
  const patternScale = tileWorld / WATER_TILE_SIZE;
  const { bins: spatialBins, N: binCount } = WATER_SPATIAL;
  const totalBins = binCount * binCount;

  const mapMaxX = numCols * gridSize;
  const mapMaxY = numRows * gridSize;
  const txMin = 0;
  const txMax = Math.ceil(mapMaxX / tileWorld);
  const tyMin = 0;
  const tyMax = Math.ceil(mapMaxY / tileWorld);

  const map = new Map<number, IndexedPolygon[]>();
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const offX = tx * tileWorld;
      const offY = ty * tileWorld;
      for (let bi = 0; bi < totalBins; bi++) {
        const bin = spatialBins[bi]!;
        for (let pi = 0; pi < bin.length; pi++) {
          const p = bin[pi]!;
          const wx = p.centre[0] * patternScale + offX;
          const wy = p.centre[1] * patternScale + offY;
          const col = Math.floor(wx / gridSize);
          const row = Math.floor(wy / gridSize);
          if (col < 0 || col >= numCols || row < 0 || row >= numRows) continue;
          const cellKey = row * numCols + col;
          let list = map.get(cellKey);
          if (!list) {
            list = [];
            map.set(cellKey, list);
          }
          list.push({ offX, offY, verts: p.verts });
        }
      }
    }
  }

  _polyByCellCache = { key, map };
  log.dev(`[fluid] getPolyByCell rebuilt ${map.size} cells in ${(performance.now() - _t0).toFixed(1)}ms`);
  return map;
}

function buildVariantClip(
  variant: FluidVariant,
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
): VariantClip {
  const meta = VARIANT_META[variant];
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const extentClip = new Path2D();
  const polyClip = new Path2D();

  // Figure out which cells belong to this variant.
  const variantCells: [number, number][] = [];
  if (meta.fillType === 'pit') {
    const pd = getCachedPitData(cells, roomCells);
    for (const [r, c] of pd.pitCells ?? []) variantCells.push([r, c]);
  } else {
    const fd = getCachedFluidCells(cells, roomCells, meta.fillType);
    for (const [r, c] of fd.fluidCells) {
      const key = r * numCols + c;
      if (fd.depthMap.get(key) === meta.depth) variantCells.push([r, c]);
    }
  }

  if (variantCells.length === 0) return { extentClip, polyClip, hasCells: false };

  const _tStart = performance.now();

  // ── EXTENT clip — wall-respecting rectangular region ──────────────────
  const variantSet = new Set<number>();
  for (const [r, c] of variantCells) variantSet.add(r * numCols + c);

  const cellIsSameFamily = (r: number, c: number): boolean => {
    const cell = cells[r]?.[c];
    if (!cell) return false;
    if (!roomCells[r]?.[c]) return false;
    return cell.fill === meta.fillType;
  };

  for (const [row, col] of variantCells) {
    const cell = cells[row]![col]!;
    // Own cell: trim-aware
    if (cell.trimClip && !cell.trimOpen) {
      const ox = col * gridSize;
      const oy = row * gridSize;
      const poly = cell.trimClip;
      extentClip.moveTo(ox + poly[0]![0]! * gridSize, oy + poly[0]![1]! * gridSize);
      for (let i = 1; i < poly.length; i++) {
        extentClip.lineTo(ox + poly[i]![0]! * gridSize, oy + poly[i]![1]! * gridSize);
      }
      extentClip.closePath();
    } else {
      extentClip.rect(col * gridSize, row * gridSize, gridSize, gridSize);
    }

    // Spill onto open-edge neighbors (wall/door blocks bleed).
    for (const [dr, dc, dir] of BLEED_DIRS) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
      const neighborKey = nr * numCols + nc;
      if (variantSet.has(neighborKey)) continue;
      const edgeVal = getEdge(cell, dir);
      if (edgeVal === 'w' || edgeVal === 'd') continue;
      const neighbor = cells[nr]?.[nc];
      if (!neighbor) continue;
      const isSameFamily = cellIsSameFamily(nr, nc);
      if (!isSameFamily) {
        if (neighbor.trimClip && !neighbor.trimOpen) continue;
        extentClip.rect(nc * gridSize, nr * gridSize, gridSize, gridSize);
      } else {
        // Same-family different-depth neighbor: include for organic depth transitions.
        if (neighbor.trimClip && !neighbor.trimOpen) {
          const ox = nc * gridSize;
          const oy = nr * gridSize;
          const poly = neighbor.trimClip;
          extentClip.moveTo(ox + poly[0]![0]! * gridSize, oy + poly[0]![1]! * gridSize);
          for (let i = 1; i < poly.length; i++) {
            extentClip.lineTo(ox + poly[i]![0]! * gridSize, oy + poly[i]![1]! * gridSize);
          }
          extentClip.closePath();
        } else {
          extentClip.rect(nc * gridSize, nr * gridSize, gridSize, gridSize);
        }
      }
    }
  }

  const _tExtent = performance.now() - _tStart;

  // ── POLY clip — Voronoi polygons whose centre is in a variant cell ────
  // The polyClip depends ONLY on which cells belong to the variant; it's
  // invariant across wall placements, neighbor edits, and anything else
  // that doesn't change the variant's cell set. We cache it separately
  // from the extentClip, keyed on a signature of the variant cell set,
  // so wall/prop edits don't trigger the ~1000ms Path2D rebuild.
  if (_polyClipCacheCellsRef !== cells) {
    // Cells identity changed (new map loaded) — drop every polyClip entry.
    for (const k of Object.keys(_polyClipCache)) {
      delete _polyClipCache[k as FluidVariant];
    }
    _polyClipCacheCellsRef = cells;
  }
  const cellSig = _variantCellSig(variantCells, numCols);
  const cached = _polyClipCache[variant];
  let finalPolyClip: Path2D;
  let polyCount = 0;
  let _tPoly: number;
  if (cached?.cellSig === cellSig) {
    finalPolyClip = cached.polyClip;
    _tPoly = 0;
  } else {
    const _tPolyStart = performance.now();
    const tileWorld = gridSize * 8;
    const patternScale = tileWorld / WATER_TILE_SIZE;
    const polyMap = getPolyByCell(gridSize, numRows, numCols);
    for (const [row, col] of variantCells) {
      const polys = polyMap.get(row * numCols + col);
      if (!polys) continue;
      for (let i = 0; i < polys.length; i++) {
        const { offX, offY, verts } = polys[i]!;
        polyClip.moveTo(verts[0]![0]! * patternScale + offX, verts[0]![1]! * patternScale + offY);
        for (let vi = 1; vi < verts.length; vi++) {
          polyClip.lineTo(verts[vi]![0]! * patternScale + offX, verts[vi]![1]! * patternScale + offY);
        }
        polyClip.closePath();
        polyCount++;
      }
    }
    finalPolyClip = polyClip;
    _polyClipCache[variant] = { cellSig, polyClip: finalPolyClip };
    _tPoly = performance.now() - _tPolyStart;
  }
  log.dev(
    `[fluid] buildVariantClip(${variant}): cells=${variantCells.length} polys=${polyCount} extent=${_tExtent.toFixed(1)}ms poly=${_tPoly.toFixed(1)}ms ${cached?.cellSig === cellSig ? '(poly cache hit)' : '(poly rebuilt)'}`,
  );

  return { extentClip, polyClip: finalPolyClip, hasCells: true };
}

/**
 * Get (or build) the world-space clip Path2D for a fluid variant. Cached on
 * `cells` identity + gridSize; invalidated by `invalidateFluidCache`.
 */
export function getFluidVariantClip(
  variant: FluidVariant,
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
): VariantClip {
  if (
    _variantClipCache?.cells === cells &&
    _variantClipCache.gridSize === gridSize &&
    _variantClipCache.roomCellsRef === roomCells
  ) {
    const existing = _variantClipCache.clips[variant];
    if (existing) return existing;
  } else {
    _variantClipCache = { cells, gridSize, roomCellsRef: roomCells, clips: {} };
  }
  const built = buildVariantClip(variant, cells, roomCells, gridSize);
  _variantClipCache.clips[variant] = built;
  return built;
}

// ── Fluid composite builder ───────────────────────────────────────────────

/**
 * Build the fluid composite — an offscreen canvas at cache resolution with
 * every fluid variant blitted within its own clip, plus pit vignettes
 * layered on top. This is the ONLY rendering path the live editor and the
 * HQ export pipeline use for fluids.
 *
 * Returns `null` if the map contains no fluid cells.
 *
 * @param reuseCanvas  Optional existing canvas to reuse (avoids allocation).
 * @param dirtyRect    Optional cell-space dirty region. When provided
 *   alongside a reusable canvas of matching size, only the corresponding
 *   canvas strip is cleared and refilled — the rest of the composite is
 *   left intact. Expanded by one cell internally to cover variant spill
 *   into neighbor cells.
 */
export function buildFluidComposite(
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  theme: Theme,
  pxPerFoot: number,
  cacheW: number,
  cacheH: number,
  reuseCanvas?: HTMLCanvasElement | null,
  dirtyRect?: { minRow: number; maxRow: number; minCol: number; maxCol: number } | null,
): HTMLCanvasElement | null {
  // Quick check — do we have any fluid at all?
  let anyFluid = false;
  for (const v of FLUID_VARIANTS) {
    const vc = getFluidVariantClip(v, cells, roomCells, gridSize);
    if (vc.hasCells) {
      anyFluid = true;
      break;
    }
  }
  if (!anyFluid) return null;

  const _tAll = performance.now();
  const canvas = reuseCanvas ?? document.createElement('canvas');
  const canvasSizeMatches = canvas.width === cacheW && canvas.height === cacheH;
  if (!canvasSizeMatches) {
    canvas.width = cacheW;
    canvas.height = cacheH;
  }
  const ctx = canvas.getContext('2d', { alpha: true })!;

  // Partial rebuild only possible when we're drawing into an existing canvas
  // whose size already matches (otherwise the canvas was just resized and is
  // blank). Fall back to a full-canvas clear otherwise.
  const canPartial = !!dirtyRect && !!reuseCanvas && canvasSizeMatches;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  // Expand the dirty cell region by 1 cell: Voronoi polys centered in variant
  // cells and open-edge spill both reach up to one neighbor cell, so a 1-cell
  // padding covers every pixel a removed/added cell could have painted.
  let rectCx = 0,
    rectCy = 0,
    rectCw = cacheW,
    rectCh = cacheH;
  let worldX0 = 0,
    worldY0 = 0,
    worldX1 = numCols * gridSize,
    worldY1 = numRows * gridSize;
  if (canPartial) {
    const padMinRow = Math.max(0, dirtyRect.minRow - 1);
    const padMaxRow = Math.min(numRows - 1, dirtyRect.maxRow + 1);
    const padMinCol = Math.max(0, dirtyRect.minCol - 1);
    const padMaxCol = Math.min(numCols - 1, dirtyRect.maxCol + 1);
    worldX0 = padMinCol * gridSize;
    worldY0 = padMinRow * gridSize;
    worldX1 = (padMaxCol + 1) * gridSize;
    worldY1 = (padMaxRow + 1) * gridSize;
    rectCx = Math.max(0, Math.floor(worldX0 * pxPerFoot));
    rectCy = Math.max(0, Math.floor(worldY0 * pxPerFoot));
    rectCw = Math.min(cacheW - rectCx, Math.ceil((worldX1 - worldX0) * pxPerFoot) + 1);
    rectCh = Math.min(cacheH - rectCy, Math.ceil((worldY1 - worldY0) * pxPerFoot) + 1);
  }

  ctx.clearRect(rectCx, rectCy, rectCw, rectCh);

  // We work in two coordinate systems:
  //   - CANVAS PIXELS for the tile-pattern fill (so createPattern tiles
  //     every tilePx canvas pixels, naturally matching the tile size).
  //   - WORLD FEET for the clip Path2D construction — applied under a
  //     temporary scale transform so the world-space path lands on the
  //     correct canvas pixels. Clip regions persist in canvas-pixel space
  //     once set, so we can reset the transform before the fill.

  for (const variant of FLUID_VARIANTS) {
    const _tClipStart = performance.now();
    const { extentClip, polyClip, hasCells } = getFluidVariantClip(variant, cells, roomCells, gridSize);
    const _tClipMs = performance.now() - _tClipStart;
    if (!hasCells) continue;

    const _tTileStart = performance.now();
    const tile = getFluidVariantTile(variant, theme, gridSize, pxPerFoot);
    const _tTileMs = performance.now() - _tTileStart;

    const _tFillStart = performance.now();
    ctx.save();
    // 1. Apply world→canvas scale so the world-space clips land correctly.
    ctx.setTransform(pxPerFoot, 0, 0, pxPerFoot, 0, 0);
    // Intersect polyClip (organic Voronoi edges) with extentClip
    // (wall-respecting rectangular extent). Inside fluid cells + open-edge
    // neighbors, polygons centred in fluid cells paint; walls cut off bleed.
    ctx.clip(extentClip);
    ctx.clip(polyClip);
    // 2. Reset to identity so the pattern fill tiles in canvas pixels.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = ctx.createPattern(tile, 'repeat')!;
    // Partial rebuild: fillRect only the dirty sub-strip; canvas clip still
    // constrains paint to the variant's extent∩poly. Full rebuild uses the
    // whole cache rect.
    ctx.fillRect(rectCx, rectCy, rectCw, rectCh);
    ctx.restore();
    const _tFillMs = performance.now() - _tFillStart;
    log.dev(
      `[fluid] ${variant}: clip=${_tClipMs.toFixed(1)}ms tile=${_tTileMs.toFixed(1)}ms fill=${_tFillMs.toFixed(1)}ms`,
    );
  }
  log.dev(
    `[fluid] buildFluidComposite total=${(performance.now() - _tAll).toFixed(1)}ms ${canPartial ? `partial=${rectCw}x${rectCh}px` : 'full'}`,
  );

  // Pit vignettes — per-region radial gradient pass. Groups came from the
  // BFS-connected pit regions in `getCachedPitData`.
  const pitData = getCachedPitData(cells, roomCells);
  if (pitData.groups && pitData.groups.length > 0) {
    const vignetteColor = (theme as Record<string, unknown>).pitVignetteColor as string | undefined;
    const vc = vignetteColor ?? PIT_DEFAULTS.vignette!;
    // Clip to the pit variant's clip so the vignette doesn't paint outside
    // pit regions.
    const pitClip = getFluidVariantClip('pit', cells, roomCells, gridSize);
    if (pitClip.hasCells) {
      ctx.save();
      // Vignettes are expressed in world feet (gradient centers + radii).
      // Apply world→canvas scale so gradient math lands on canvas pixels.
      ctx.setTransform(pxPerFoot, 0, 0, pxPerFoot, 0, 0);
      // Match the fluid region — extent ∩ polygon — so the vignette doesn't
      // paint past walls or outside the organic pit silhouette.
      ctx.clip(pitClip.extentClip);
      ctx.clip(pitClip.polyClip);
      if (canPartial) {
        // Additional clip to the dirty world rect so we don't paint vignette
        // pixels outside the strip we just cleared. patchFluidRegion forces
        // a full rebuild on pit-topology changes, so group centroids/radii
        // are guaranteed unchanged here — the repainted slice is consistent
        // with the vignette pixels left in place outside the dirty rect.
        const dirtyWorld = new Path2D();
        dirtyWorld.rect(worldX0, worldY0, worldX1 - worldX0, worldY1 - worldY0);
        ctx.clip(dirtyWorld);
      }
      for (const group of pitData.groups) {
        let gcx = 0;
        let gcy = 0;
        for (const [r, c] of group) {
          gcx += (c + 0.5) * gridSize;
          gcy += (r + 0.5) * gridSize;
        }
        gcx /= group.length;
        gcy /= group.length;
        let maxDist = 0;
        for (const [r, c] of group) {
          for (const [cx, cy] of [
            [c, r],
            [c + 1, r],
            [c, r + 1],
            [c + 1, r + 1],
          ] as const) {
            const d = Math.hypot(cx * gridSize - gcx, cy * gridSize - gcy);
            if (d > maxDist) maxDist = d;
          }
        }
        const grad = ctx.createRadialGradient(gcx, gcy, 0, gcx, gcy, maxDist);
        grad.addColorStop(0, vc);
        grad.addColorStop(0.4, 'rgba(0,0,0,0.25)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        for (const [r, c] of group) {
          ctx.fillRect(c * gridSize, r * gridSize, gridSize, gridSize);
        }
      }
      ctx.restore();
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// ── Cache introspection + invalidation ────────────────────────────────────

/**
 * Theme signature covering every fluid-relevant color. Used by MapCache to
 * detect fluid-theme-only changes so the fluid composite can rebuild
 * without touching the cells layer.
 */
export function fluidThemeSig(theme: Theme): string {
  const t = theme as Record<string, unknown>;
  return [
    t.waterShallowColor,
    t.waterMediumColor,
    t.waterDeepColor,
    t.waterCausticColor,
    t.lavaShallowColor,
    t.lavaMediumColor,
    t.lavaDeepColor,
    t.lavaCausticColor,
    t.pitBaseColor,
    t.pitCrackColor,
    t.pitVignetteColor,
  ].join(',');
}

/**
 * Return stored parameters from the variant clip cache (or null if empty).
 * Used by `smartInvalidate` in render-cache.ts to decide whether a patch is
 * possible after in-place cell mutation.
 */
export function getFluidCacheParams(): { gridSize: number } | null {
  if (!_variantClipCache) return null;
  return { gridSize: _variantClipCache.gridSize };
}

/**
 * Clear every fluid cache. Call on cells-grid replacement, fluid theme
 * change, or any time the variant geometry might have gone stale.
 */
export function invalidateFluidCache(): void {
  _fluidCellsCache = { cells: null, water: null, lava: null };
  _pitDataCache = { cells: null, pitSet: null, pitCells: null, groups: null, numCols: 0, numRows: 0 };
  _variantClipCache = null;
  _fluidDataVersion++;
  _markFullRebuild();
  // Don't evict tile canvases — they're keyed on (variant, colorSig,
  // gridSize, pxPerFoot) and can be reused as long as those match.
}

/**
 * Evict ALL tile canvases too. Call on theme color change so tiles rebuild
 * with the new colors on next composite.
 */
export function invalidateFluidTileCache(): void {
  for (const v of FLUID_VARIANTS) delete _variantTileCache[v];
}

/**
 * Incremental patch hook — called by `smartInvalidate` after an in-place
 * fluid cell mutation. Updates the fluid/pit cell caches for the cells
 * inside `region` only (no full-grid scan), clears the variant clip cache
 * (the per-variant polyClip cache keyed on cell-set signature survives the
 * common case where only depth or hazard changed), and accumulates the
 * region so the next `buildFluidComposite` can do a partial clear+refill.
 *
 * Pit topology changes inside the region trigger a full rebuild because
 * vignette centroids/radii depend on the full group — partial repaint
 * would leave stale vignette pixels outside the dirty rect.
 */
export function patchFluidRegion(
  region: { minRow: number; maxRow: number; minCol: number; maxCol: number },
  cells: CellGrid,
  roomCells: boolean[][],
  _gridSize: number,
  _theme: Theme,
): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  const r0 = Math.max(0, region.minRow);
  const r1 = Math.min(numRows - 1, region.maxRow);
  const c0 = Math.max(0, region.minCol);
  const c1 = Math.min(numCols - 1, region.maxCol);

  // ── Water / lava: incrementally patch set + depthMap for cells in region ──
  if (_fluidCellsCache.cells === cells) {
    for (const fillType of ['water', 'lava'] as const) {
      const cache = _fluidCellsCache[fillType];
      if (!cache) continue;
      const depthKey = (fillType + 'Depth') as keyof Cell;
      let mutated = false;
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const key = row * numCols + col;
          const cell = cells[row]?.[col];
          const inRoom = !!roomCells[row]?.[col];
          const shouldBe = !!cell && cell.fill === fillType && inRoom;
          const had = cache.fluidSet.has(key);
          if (shouldBe) {
            const d = (cell[depthKey] as number | undefined) ?? 1;
            if (!had) {
              cache.fluidSet.add(key);
              mutated = true;
            }
            if (cache.depthMap.get(key) !== d) cache.depthMap.set(key, d);
          } else if (had) {
            cache.fluidSet.delete(key);
            cache.depthMap.delete(key);
            mutated = true;
          }
        }
      }
      if (mutated) {
        cache.fluidCells = _rebuildFluidCellsArrayFromSet(cache.fluidSet, numCols);
      }
    }
  } else {
    // Cells identity changed — can't incrementally patch. Drop caches and
    // force a full rebuild on the next composite request.
    _fluidCellsCache = { cells: null, water: null, lava: null };
    _markFullRebuild();
  }

  // ── Pit: incrementally patch pitSet; if topology changed, rebuild BFS groups ──
  let pitTopologyChanged = false;
  if (_pitDataCache.cells === cells && _pitDataCache.pitSet) {
    const pitSet = _pitDataCache.pitSet;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const key = row * numCols + col;
        const cell = cells[row]?.[col];
        const inRoom = !!roomCells[row]?.[col];
        const shouldBe = !!cell && cell.fill === 'pit' && inRoom;
        const had = pitSet.has(key);
        if (shouldBe !== had) {
          pitTopologyChanged = true;
          if (shouldBe) pitSet.add(key);
          else pitSet.delete(key);
        }
      }
    }
    if (pitTopologyChanged) {
      // Rebuild pitCells + group BFS from the updated set.
      const pd = _pitDataCache;
      const pitCells: [number, number][] = _rebuildFluidCellsArrayFromSet(pitSet, numCols);
      const visited = new Set<number>();
      const groups: [number, number][][] = [];
      for (const [row, col] of pitCells) {
        const startKey = row * numCols + col;
        if (visited.has(startKey)) continue;
        const group: [number, number][] = [];
        const queue: [number, number][] = [[row, col]];
        visited.add(startKey);
        while (queue.length > 0) {
          const [r2, c2] = queue.shift()!;
          group.push([r2, c2]);
          for (const [dr, dc] of [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
          ] as const) {
            const nr = r2 + dr;
            const nc = c2 + dc;
            if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
            const nkey = nr * numCols + nc;
            if (!visited.has(nkey) && pitSet.has(nkey)) {
              visited.add(nkey);
              queue.push([nr, nc]);
            }
          }
        }
        groups.push(group);
      }
      pd.pitCells = pitCells;
      pd.groups = groups;
    }
  } else {
    _pitDataCache = { cells: null, pitSet: null, pitCells: null, groups: null, numCols: 0, numRows: 0 };
    _markFullRebuild();
    pitTopologyChanged = true; // forces full path below
  }

  // Variant clips are stale (extentClip geometry depends on per-cell trims
  // and open-edge neighbors; polyClip reuses per-variant cache keyed on
  // cell-set signature, so that survives the common depth-only patch).
  _variantClipCache = null;

  if (pitTopologyChanged) {
    _markFullRebuild();
  } else {
    _extendPartialRegion({ minRow: r0, maxRow: r1, minCol: c0, maxCol: c1 });
  }

  _fluidDataVersion++;
}
