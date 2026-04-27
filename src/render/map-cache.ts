// Shared offscreen map cache used by both the editor and player views.
//
// Layer anatomy:
//   1. _preGridSnapshot  — BASE cells phases (floors, blending, bridges).
//                          Renamed from its legacy "snapshot" role, this is
//                          now a first-class sublayer, rebuilt only when
//                          base-relevant content or theme changes.
//   2. _fluidComposite   — water / lava / pit via tile blits with spill-
//                          aware clips. See buildFluidComposite() in fluid.ts.
//   3. _cellsLayer       — TOP cells phases (walls, grid, props, hazard).
//                          alpha=true so the base + fluid show through where
//                          there's no structural content.
//   4. _compositeLayer   — final flat: bg → shading → hatch → base → fluid →
//                          top → lightmap → labels.
//
// This split lets fluid-only changes rebuild just `_fluidComposite` (no cells
// work), wall/grid changes rebuild just `_cellsLayer`, and floor/blending
// changes rebuild just `_preGridSnapshot` — matching the theme-diff buckets.
//
// Supports partial dirty-region redraws when only a small area changed.
// State-agnostic — receives all data through update() parameters.

// Import directly from source files (not index.js) to avoid circular dependency,
// since index.js re-exports MapCache from this file.
import type {
  RenderTransform,
  CellGrid,
  Theme,
  Light,
  Metadata,
  PropCatalog,
  TextureCatalog,
  TextureOptions,
} from '../types.js';
import { renderCells, renderLabels } from './render.js';
import { drawOuterShading } from './effects.js';
import { getCachedRoomCells } from './render-cache.js';
import { HATCH_TILE_SIZE, HATCH_PATTERNS, WATER_TILE_SIZE, WATER_SPATIAL } from './patterns.js';
import { GRID_SCALE } from './constants.js';
import { cellsLayerThemeSig } from './theme-diff.js';
import { buildFluidComposite, fluidThemeSig, getFluidDataVersion, consumeFluidPartialRegion } from './fluid.js';
import { log, getSegments, isCellSplit } from '../util/index.js';

/** Internal cells-layer state (floors, grid, walls, bridges, props — no lightmap). */
interface CellsLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dirtySeq: number;
  /** Top-layer-specific dirty seq. Advances only when walls/props/hazard/trim change.
   *  Lets partial rebuilds skip clearing the top layer on texture-only paints, so
   *  features spanning cells (e.g. 2-cell diagonal doors) aren't half-clipped
   *  at the padded-rebuild boundary. */
  topDirtySeq: number;
  cacheW: number;
  cacheH: number;
  texturesVersion: number;
  skipSig: string;
  gridDirtySeq: number;
}

/** Internal composite-layer state (cells + static lightmap + labels). */
interface CompositeLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dirtySeq: number;
  cacheW: number;
  cacheH: number;
  compositeDirtySeq: number;
  texturesVersion: number;
}

/** Pre-grid snapshot for cheap grid-only redraws. */
interface SnapshotLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cacheW: number;
  cacheH: number;
}

/** Clip rectangle for partial composite updates. */
interface ClipRect {
  px1: number;
  py1: number;
  pw: number;
  ph: number;
}

/** Parameters passed to MapCache.update() and internal rebuild methods. */
interface MapCacheParams {
  cells: CellGrid;
  gridSize: number;
  theme: Theme;
  metadata: Metadata | null;
  propCatalog: PropCatalog | null;
  textureCatalog: TextureCatalog | null;
  textureOptions: TextureOptions | null;
  getTextureImage?: ((id: string) => HTMLImageElement | null) | null;
  contentVersion: number;
  topContentVersion?: number;
  geometryVersion?: number;
  lightingVersion: number;
  labelStyle: string;
  showGrid: boolean;
  bgImageEl: HTMLImageElement | null;
  bgImgConfig: Record<string, number | string | boolean> | null;
  ambientLight: number;
  lights: Light[];
  skipPhases?: Record<string, boolean> | null;
  skipLabels?: boolean;
  showInvisible?: boolean;
  lightingEnabled?: boolean;
  hasAnimLights?: boolean;
  preRenderHook?: ((ctx: CanvasRenderingContext2D, transform: RenderTransform) => void) | null;
  texturesVersion?: number;
  dirtyRegion?: { minRow: number; maxRow: number; minCol: number; maxCol: number } | null;
  ambientColor?: string | null;
  animClock?: number;
  lightPxPerFoot?: number;
}
import { renderLightmap, extractFillLights } from './lighting.js';

const DEFAULT_MAX_CACHE_DIM: number = 16384;

/**
 * Signature of theme properties that affect the cells layer specifically.
 * Uses the canonical allow-list from theme-diff so effects, fill, grid, label,
 * and lava-light property changes skip the (expensive) cells rebuild and only
 * flip the composite / grid / lightmap as appropriate.
 */
function _cellsThemeSig(theme: Theme): string {
  return cellsLayerThemeSig(theme);
}

/**
 * Shared offscreen map cache for editor and player views.
 * Manages cells layer, composite layer, and pre-grid snapshot for efficient redraws.
 */
export class MapCache {
  _pxPerFoot: number;
  _maxCacheDim: number;
  _cellsLayer: CellsLayer | null; // TOP phases only (walls/grid/props/hazard)
  _compositeLayer: CompositeLayer | null;
  _preGridSnapshot: SnapshotLayer | null; // BASE phases only (floors/blending/bridges)
  _fluidComposite: HTMLCanvasElement | null;
  _fluidCompositeSig: string;
  _shadingCanvas: HTMLCanvasElement | null;
  _hatchCanvas: HTMLCanvasElement | null;
  _shadingSig: string;
  _hatchSig: string;
  _effectsComposite: HTMLCanvasElement | null;
  _effectsCompositeSig: string;
  _lastGeometryVersion: number;
  _lastCellsThemeSig: string;
  _lastFluidThemeSig: string;
  _dirtySeq: number;
  _topDirtySeq: number;
  _compositeDirtySeq: number;
  _gridDirtySeq: number;
  /** @deprecated kept for API compatibility — the base/top split is always on now. */
  _gridRedrawEnabled: boolean;
  _lastContentVersion: number;
  _lastTopContentVersion: number;
  _lastShowInvisible: boolean;
  _lastLightingVersion: number;
  _lastTheme: Theme | null;
  _cellsRebuildCount: number;
  _compositeRebuildCount: number;
  _lastRebuildMs: number;
  _lastRebuildType: string;

  /**
   * Create a new MapCache instance.
   * @param {Object} [options] - Configuration options
   * @param {number} [options.pxPerFoot=20] - Pixels per foot at cache resolution
   * @param {number} [options.maxCacheDim=16384] - Maximum cache dimension in pixels
   */
  constructor({ pxPerFoot = 20, maxCacheDim = DEFAULT_MAX_CACHE_DIM } = {}) {
    this._pxPerFoot = pxPerFoot;
    this._maxCacheDim = maxCacheDim;

    // Internal layers
    this._cellsLayer = null;
    this._compositeLayer = null;
    this._preGridSnapshot = null;
    this._fluidComposite = null;
    this._fluidCompositeSig = '';
    this._shadingCanvas = null;
    this._hatchCanvas = null;
    this._shadingSig = '';
    this._hatchSig = '';
    this._effectsComposite = null;
    this._effectsCompositeSig = '';
    this._lastGeometryVersion = 0;
    this._lastCellsThemeSig = '';
    this._lastFluidThemeSig = '';

    // Version tracking — compared against caller-supplied versions
    this._dirtySeq = 0;
    this._topDirtySeq = 0;
    this._compositeDirtySeq = 0;
    this._gridDirtySeq = 0;
    this._gridRedrawEnabled = true;
    this._lastContentVersion = 0;
    this._lastTopContentVersion = 0;
    this._lastShowInvisible = false;
    this._lastLightingVersion = 0;
    this._lastTheme = null;

    // Diagnostics
    this._cellsRebuildCount = 0;
    this._compositeRebuildCount = 0;
    this._lastRebuildMs = 0;
    this._lastRebuildType = 'none';
  }

  get pxPerFoot() {
    return this._pxPerFoot;
  }

  set pxPerFoot(v) {
    if (v !== this._pxPerFoot) {
      this._pxPerFoot = v;
      this.invalidate();
    }
  }

  get stats() {
    return {
      cellsRebuilds: this._cellsRebuildCount,
      compositeRebuilds: this._compositeRebuildCount,
      lastRebuildMs: this._lastRebuildMs,
      lastRebuildType: this._lastRebuildType,
      cacheW: this._compositeLayer?.cacheW ?? 0,
      cacheH: this._compositeLayer?.cacheH ?? 0,
    };
  }

  /**
   * Check whether the map fits within GPU texture limits at current pxPerFoot.
   * @param {number} numRows - Number of grid rows
   * @param {number} numCols - Number of grid columns
   * @param {number} gridSize - Grid cell size in feet
   * @returns {boolean} True if the map fits within the maximum cache dimension
   */
  canCache(numRows: number, numCols: number, gridSize: number) {
    const cacheW = Math.ceil(numCols * gridSize * this._pxPerFoot);
    const cacheH = Math.ceil(numRows * gridSize * this._pxPerFoot);
    return cacheW <= this._maxCacheDim && cacheH <= this._maxCacheDim;
  }

  /**
   * Force a full rebuild on the next update().
   * @returns {void}
   */
  invalidate() {
    this._dirtySeq++;
    this._compositeDirtySeq++;
    log.devTrace(`MapCache.invalidate() → dirtySeq=${this._dirtySeq}`);
  }

  /**
   * Invalidate only the composite layer (lighting/theme change -- cells layer stays cached).
   * @returns {void}
   */
  invalidateComposite() {
    this._compositeDirtySeq++;
    log.dev(`MapCache.invalidateComposite() → composite-only`);
  }

  /**
   * Invalidate only the grid overlay -- triggers grid-only rebuild, no cells or composite touch.
   * @returns {void}
   */
  invalidateGrid() {
    this._gridDirtySeq++;
    this._gridRedrawEnabled = true;
    log.dev(`MapCache.invalidateGrid() → grid-overlay only`);
  }

  /**
   * Invalidate just the props (and the other top-of-stack phases: walls, grid, labels).
   * Uses the pre-grid snapshot to skip expensive base phases (floors, textures, blending,
   * fills, bridges). Call this whenever overlay props change position/rotation/scale/zIndex.
   * @returns {void}
   */
  invalidateProps() {
    // Enable two-pass rebuild so the snapshot gets captured on the next full rebuild.
    this._gridRedrawEnabled = true;
    if (this._preGridSnapshot) {
      // Snapshot already exists — cheap grid-only rebuild will pick up new prop art.
      // _rebuildFromSnapshot calls _buildComposite internally, so we don't bump
      // _compositeDirtySeq here (that would route through composite-only, which just
      // re-blits the stale cells layer and skips the prop replay).
      this._gridDirtySeq++;
      log.dev(`MapCache.invalidateProps() → grid-only (cheap path)`);
    } else {
      // No snapshot yet — force a full rebuild. The two-pass path will create the
      // snapshot so subsequent prop edits hit the fast grid-only path.
      this._dirtySeq++;
      this._compositeDirtySeq++;
      log.devTrace(`MapCache.invalidateProps() → FULL REBUILD (no snapshot)`);
    }
  }

  /**
   * Free GPU memory by releasing all cached canvases.
   * @returns {void}
   */
  dispose() {
    this._cellsLayer = null;
    this._compositeLayer = null;
    this._preGridSnapshot = null;
    this._fluidComposite = null;
    this._fluidCompositeSig = '';
    this._shadingCanvas = null;
    this._hatchCanvas = null;
    this._shadingSig = '';
    this._hatchSig = '';
    this._effectsComposite = null;
    this._effectsCompositeSig = '';
    log.dev(`MapCache.dispose() → all layers freed`);
  }

  /**
   * Get the composite canvas for external use (e.g., animated light overlay).
   * Returns null if cache is not built yet.
   * @returns {{ canvas: HTMLCanvasElement, cacheW: number, cacheH: number }|null}
   */
  getComposite() {
    if (!this._compositeLayer) return null;
    return {
      canvas: this._compositeLayer.canvas,
      cacheW: this._compositeLayer.cacheW,
      cacheH: this._compositeLayer.cacheH,
    };
  }

  /**
   * Blit the cached map to a destination context at the given transform.
   *
   * Clips to the destination viewport so Chromium only touches the visible
   * portion of the composite. The 3-arg `drawImage` form doesn't cull by
   * source rect — with a large composite and a small viewport, Chromium
   * still has to walk the whole source texture, producing unbounded GPU work
   * proportional to map size, not screen size. Using the 9-arg form with
   * source + dest rects bounds the work to `(visible viewport × dpr)` pixels.
   *
   * @param {CanvasRenderingContext2D} destCtx - Destination canvas context
   * @param {{ offsetX: number, offsetY: number, scale: number }} transform - View transform
   * @returns {void}
   */
  blit(destCtx: CanvasRenderingContext2D, transform: RenderTransform) {
    if (!this._compositeLayer) return;
    const sx = transform.scale / this._pxPerFoot;
    if (sx <= 0) return;

    const canvas = destCtx.canvas;
    // destCtx is set up with a DPR transform (see canvas-view-render.ts:107),
    // so "visible in CSS coords" is what we care about for culling.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const viewportW = canvas.width / dpr;
    const viewportH = canvas.height / dpr;

    // Portion of the composite that lands within [0, viewport].
    // composite pixel p maps to CSS pixel `offsetX + p * sx` (same for Y).
    const srcX = Math.max(0, -transform.offsetX / sx);
    const srcY = Math.max(0, -transform.offsetY / sx);
    const srcMaxX = Math.min(this._compositeLayer.cacheW, (viewportW - transform.offsetX) / sx);
    const srcMaxY = Math.min(this._compositeLayer.cacheH, (viewportH - transform.offsetY) / sx);
    const srcW = srcMaxX - srcX;
    const srcH = srcMaxY - srcY;
    if (srcW <= 0 || srcH <= 0) return; // composite entirely off-screen

    const dstX = transform.offsetX + srcX * sx;
    const dstY = transform.offsetY + srcY * sx;
    const dstW = srcW * sx;
    const dstH = srcH * sx;

    destCtx.drawImage(this._compositeLayer.canvas, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
  }

  /**
   * Update the cache if stale. Returns true if a rebuild occurred.
   *
   * @param {object} p
   * @param {number}      p.contentVersion   — monotonic counter for content changes
   * @param {number}      p.lightingVersion  — monotonic counter for lighting changes
   * @param {number}      p.texturesVersion  — texture load counter
   * @param {object}      p.cells            — the cell grid (possibly pre-filtered for player)
   * @param {number}      p.gridSize
   * @param {object}      p.theme
   * @param {boolean}     p.showGrid
   * @param {string}      p.labelStyle
   * @param {object|null} p.propCatalog
   * @param {object|null} p.textureOptions   — { catalog, blendWidth, texturesVersion }
   * @param {object}      p.metadata         — full dungeon metadata (possibly filtered)
   * @param {boolean}     p.showInvisible    — editor shows invisible walls/doors
   * @param {object|null} p.bgImageEl        — HTMLImageElement for background image
   * @param {object|null} p.bgImgConfig      — background image config
   * @param {boolean}     p.lightingEnabled
   * @param {boolean}     p.hasAnimLights    — if true, lighting NOT baked into composite
   * @param {Array|null}  p.lights           — light array (metadata.lights)
   * @param {number}      p.animClock        — animation timestamp
   * @param {number}      p.lightPxPerFoot   — lighting resolution
   * @param {number}      p.ambientLight     — ambient light level
   * @param {string|null} p.ambientColor     — ambient light color
   * @param {object|null} p.textureCatalog   — for lighting wall segment extraction
   * @param {object|null} p.dirtyRegion      — { minRow, maxRow, minCol, maxCol } or null
   * @param {Function|null} p.preRenderHook  — (ctx, cacheTransform) called before renderCells
   * @param {Object|null} p.skipPhases       — editor debug skip flags
   * @param {boolean}     p.skipLabels       — skip label rendering in renderCells (rendered after lightmap)
   * @returns {boolean} True if a rebuild occurred
   */
  update(p: MapCacheParams) {
    const pxPerFoot = this._pxPerFoot;
    const numRows = p.cells.length;
    const numCols = p.cells[0]?.length ?? 0;
    const cacheW = Math.ceil(numCols * p.gridSize * pxPerFoot);
    const cacheH = Math.ceil(numRows * p.gridSize * pxPerFoot);

    if (cacheW > this._maxCacheDim || cacheH > this._maxCacheDim) {
      log.dev(`MapCache.update: skipping — map ${cacheW}×${cacheH}px exceeds maxCacheDim ${this._maxCacheDim}`);
      return false;
    }

    // ── Dirty tracking ──
    const cv = p.contentVersion;
    if (cv !== this._lastContentVersion) {
      this._dirtySeq++;
      this._compositeDirtySeq++;
      log.dev(`MapCache.update: contentVersion ${this._lastContentVersion} → ${cv} forces cells rebuild`);
      this._lastContentVersion = cv;
    }

    // Top-layer version: advances only when walls/props/hazard/trim change.
    // Defaults to contentVersion when callers don't provide it (preserves legacy behaviour).
    const tcv = p.topContentVersion ?? cv;
    if (tcv !== this._lastTopContentVersion) {
      this._topDirtySeq++;
      this._lastTopContentVersion = tcv;
    }

    // `showInvisible` controls whether invisible walls (`iw`) / doors (`id`) draw
    // on the top layer. It flips with the active tool (wall/door tool → on,
    // paint/prop → off), so a tool switch must force a top-layer rebuild even
    // though no cell content changed.
    const showInvisible = !!p.showInvisible;
    if (showInvisible !== this._lastShowInvisible) {
      this._dirtySeq++;
      this._topDirtySeq++;
      this._compositeDirtySeq++;
      this._lastShowInvisible = showInvisible;
      log.dev(`MapCache.update: showInvisible → ${showInvisible} forces top rebuild`);
    }

    const lv = p.lightingVersion;
    if (lv !== this._lastLightingVersion) {
      // Always invalidate: lighting changes may also toggle hasAnimLights, and
      // the composite's baked-vs-unbaked lighting state must match the current
      // hasAnimLights. The downstream bake at the render step is already
      // guarded by `!hasAnimLights`, so an invalidation here simply forces the
      // composite to be rebuilt in the correct state.
      this._compositeDirtySeq++;
      log.dev(`MapCache.update: lightingVersion ${this._lastLightingVersion} → ${lv} → composite rebuild`);
      this._lastLightingVersion = lv;
    }

    // Theme change detection — only rebuild caches whose inputs actually changed.
    // Effects (hatching/shading) and fills have their own signature-based caches
    // in the composite, so changing those properties doesn't need a cells rebuild.
    if (p.theme !== this._lastTheme) {
      if (this._lastTheme !== null) {
        const newCellsSig = _cellsThemeSig(p.theme);
        if (newCellsSig !== this._lastCellsThemeSig) {
          // Cells-relevant property changed (floor color, wall color, grid, etc.)
          this._dirtySeq++;
          this._compositeDirtySeq++;
          log.dev(`theme cells-relevant change → cells rebuild`);
        } else {
          // Only effects/fill properties changed — composite handles it
          this._compositeDirtySeq++;
          log.dev(`theme effects/fill-only change → composite rebuild`);
        }
        this._lastCellsThemeSig = newCellsSig;
      } else {
        this._lastCellsThemeSig = _cellsThemeSig(p.theme);
      }
      this._lastTheme = p.theme;
    }

    // Check if effects layer signatures changed (theme hatching/shading params edited
    // without changing the theme reference — e.g. theme panel sliders). Effects live
    // in the composite, not the cells layer, so only bump composite version.
    const geomVer = p.geometryVersion ?? 0;
    const resolution = p.metadata?.resolution ?? 1;
    const newShadingSig = this._shadingSignature(p.theme, cacheW, cacheH, geomVer, resolution);
    const newHatchSig = this._hatchSignature(p.theme, cacheW, cacheH);
    if (
      (newShadingSig !== this._shadingSig && !(this._shadingSig === '' && !this._shadingCanvas)) ||
      (newHatchSig !== this._hatchSig && !(this._hatchSig === '' && !this._hatchCanvas))
    ) {
      this._compositeDirtySeq++;
      log.dev(`MapCache.update: effects signature changed → composite rebuild`);
    }

    const texVer = p.texturesVersion ?? 0;
    const skipSig = p.skipPhases
      ? Object.keys(p.skipPhases)
          .filter((k) => p.skipPhases![k] && k !== 'all')
          .join(',')
      : '';

    const needsCellsRedraw =
      this._cellsLayer?.dirtySeq !== this._dirtySeq ||
      this._cellsLayer.cacheW !== cacheW ||
      this._cellsLayer.cacheH !== cacheH ||
      this._cellsLayer.texturesVersion !== texVer ||
      this._cellsLayer.skipSig !== skipSig;

    const needsGridOnly =
      !needsCellsRedraw &&
      this._gridRedrawEnabled &&
      this._preGridSnapshot &&
      this._cellsLayer!.gridDirtySeq !== this._gridDirtySeq;

    const needsCompositeOnly =
      !needsCellsRedraw &&
      !needsGridOnly &&
      this._compositeLayer &&
      this._compositeLayer.compositeDirtySeq !== this._compositeDirtySeq;

    if (!needsCellsRedraw && !needsCompositeOnly && !needsGridOnly) return false;

    const _cacheStart = performance.now();
    const cacheTransform = { scale: pxPerFoot, offsetX: 0, offsetY: 0 };

    // Grid-only change — restore pre-grid snapshot and re-render grid + walls + props.
    // Skips expensive shading/floors/textures/blending phases entirely. Takes priority
    // over composite-only because _rebuildFromSnapshot calls _buildComposite at the end,
    // so it handles both channels in one pass (needed when a prop edit bumps lighting
    // and props together — composite-only alone would re-blit a stale cells layer).
    if (needsGridOnly) {
      this._rebuildFromSnapshot(p, cacheTransform, cacheW, cacheH, texVer);
      this._lastRebuildMs = performance.now() - _cacheStart;
      this._lastRebuildType = 'grid';
      log.dev(`MapCache.update → grid rebuild (${this._lastRebuildMs.toFixed(1)}ms)`);
      return true;
    }

    // Composite-only change (lighting/theme) — skip cells layer, just recomposite.
    // The lightmap has its own internal cache so this is cheap.
    if (needsCompositeOnly) {
      this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer);
      this._lastRebuildMs = performance.now() - _cacheStart;
      this._lastRebuildType = 'composite';
      log.dev(`MapCache.update → composite rebuild (${this._lastRebuildMs.toFixed(1)}ms)`);
      return true;
    }

    // ── Check for partial redraw eligibility ──
    const canPartial =
      p.dirtyRegion &&
      this._cellsLayer?.cacheW === cacheW &&
      this._cellsLayer.cacheH === cacheH &&
      this._cellsLayer.texturesVersion === texVer &&
      this._cellsLayer.skipSig === skipSig;

    if (canPartial) {
      this._rebuildPartial(p, cacheTransform, cacheW, cacheH, numRows, numCols, texVer, skipSig);
    } else {
      this._rebuildFull(p, cacheTransform, cacheW, cacheH, numRows, numCols, texVer, skipSig);
    }

    this._lastRebuildMs = performance.now() - _cacheStart;
    this._lastRebuildType = canPartial ? 'partial' : 'full';
    log.dev(`MapCache.update → ${this._lastRebuildType} cells rebuild (${this._lastRebuildMs.toFixed(1)}ms)`);
    return true;
  }

  // ── Internal: shading/hatching layer caching ──
  //
  // Shading (outer glow): uses real roomCells so size/roughness create organic
  // edges around rooms. Rebuilds on geometry + theme changes (cheap — just circles).
  //
  // Hatching (cross-hatch/rock patterns): follows the player view's architecture —
  // built ONCE with allRoom=true (patterns cover the entire grid), then a cheap
  // Minkowski-sum mask clips to room proximity on geometry changes.
  // The expensive Path2D construction only runs on theme/dimension changes.

  _shadingSignature(theme: Theme, cacheW: number, cacheH: number, geomVer: number, resolution: number): string {
    const os = (theme as Record<string, unknown>).outerShading as Record<string, unknown> | undefined;
    if (!os?.color || !((os.size as number) > 0)) return '';
    return `S,${geomVer},${cacheW},${cacheH},${resolution},${os.color},${os.size},${os.roughness ?? 0}`;
  }

  _hatchSignature(theme: Theme, cacheW: number, cacheH: number): string {
    if (!(theme as Record<string, number>).hatchOpacity) return '';
    const t = theme as Record<string, unknown>;
    return `H,${cacheW},${cacheH},${t.hatchOpacity},${t.hatchSize ?? 0.5},${t.hatchDistance ?? 1},${t.hatchStyle ?? 'lines'},${t.hatchColor ?? (theme as Record<string, string>).wallStroke}`;
  }

  /** Build the shading layer using real roomCells (preserves size/roughness edges).
   *  Rebuilds on geometry + theme shading changes — cheap, just circles. */
  _ensureShadingLayer(
    cells: CellGrid,
    gridSize: number,
    theme: Theme,
    metadata: Metadata | null,
    cacheW: number,
    cacheH: number,
    geomVer: number,
  ): void {
    const resolution = metadata?.resolution ?? 1;
    const sig = this._shadingSignature(theme, cacheW, cacheH, geomVer, resolution);
    if (sig === this._shadingSig && this._shadingCanvas) return;
    if (!sig) {
      this._shadingCanvas = null;
      this._shadingSig = '';
      return;
    }
    if (this._shadingCanvas?.width !== cacheW || this._shadingCanvas.height !== cacheH) {
      this._shadingCanvas = document.createElement('canvas');
      this._shadingCanvas.width = cacheW;
      this._shadingCanvas.height = cacheH;
    }
    const ctx = this._shadingCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, cacheW, cacheH);
    const cacheTransform = { scale: this._pxPerFoot, offsetX: 0, offsetY: 0 };
    const roomCells = getCachedRoomCells(cells);
    drawOuterShading(ctx, cells, roomCells, gridSize, theme, cacheTransform, resolution);
    this._shadingSig = sig;
    log.dev(`MapCache._ensureShadingLayer → rebuilt (sig=${sig.slice(0, 40)}…)`);
  }

  /** Build the hatching base layer by rendering one tile and repeating it.
   *  Only rebuilds on theme/size change — geometry changes only affect the mask. */
  _ensureHatchLayer(_cells: CellGrid, gridSize: number, theme: Theme, cacheW: number, cacheH: number): void {
    const sig = this._hatchSignature(theme, cacheW, cacheH);
    if (sig === this._hatchSig && this._hatchCanvas) return;
    if (!sig) {
      this._hatchCanvas = null;
      this._hatchSig = '';
      return;
    }
    if (this._hatchCanvas?.width !== cacheW || this._hatchCanvas.height !== cacheH) {
      this._hatchCanvas = document.createElement('canvas');
      this._hatchCanvas.width = cacheW;
      this._hatchCanvas.height = cacheH;
    }
    const ctx = this._hatchCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, cacheW, cacheH);

    const pxPerFoot = this._pxPerFoot;
    const hatchSize = (theme as Record<string, number>).hatchSize ?? 0.5;
    const hatchOpacity = (theme as Record<string, number>).hatchOpacity ?? 0;
    const hatchColor = ((theme as Record<string, string>).hatchColor ?? theme.wallStroke) || '#000000';
    const hatchStyle = (theme as Record<string, string>).hatchStyle ?? 'lines';

    // ── Line hatching tile ──
    if (hatchStyle !== 'rocks') {
      const tileWorld = gridSize * 2 * (1.5 + hatchSize * 3);
      const tilePx = Math.ceil(tileWorld * pxPerFoot);
      const patternScale = tileWorld / HATCH_TILE_SIZE;
      const pxScale = patternScale * pxPerFoot;

      const tile = document.createElement('canvas');
      tile.width = tilePx;
      tile.height = tilePx;
      const tc = tile.getContext('2d')!;
      const path = new Path2D();
      for (const p of HATCH_PATTERNS) {
        for (const line of p.cellLines) {
          path.moveTo(line[0]![0]! * pxScale, line[0]![1]! * pxScale);
          path.lineTo(line[1]![0]! * pxScale, line[1]![1]! * pxScale);
        }
      }
      tc.strokeStyle = hatchColor;
      tc.lineWidth = Math.max(0.5, pxPerFoot / GRID_SCALE);
      tc.lineCap = 'round';
      tc.globalAlpha = hatchOpacity;
      tc.stroke(path);

      const pattern = ctx.createPattern(tile, 'repeat')!;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, cacheW, cacheH);
    }

    // ── Rock shading tile ──
    if (hatchStyle === 'rocks' || hatchStyle === 'both') {
      const tileWorld = gridSize * (8 + hatchSize * 8);
      const tilePx = Math.ceil(tileWorld * pxPerFoot);
      const patternScale = tileWorld / WATER_TILE_SIZE;
      const pxScale = patternScale * pxPerFoot;

      const tile = document.createElement('canvas');
      tile.width = tilePx;
      tile.height = tilePx;
      const tc = tile.getContext('2d')!;
      const path = new Path2D();
      const { bins: spatialBins, N: binCount } = WATER_SPATIAL;
      for (let by = 0; by < binCount; by++) {
        for (let bx = 0; bx < binCount; bx++) {
          for (const p of spatialBins[by * binCount + bx]!) {
            const verts = p.verts;
            path.moveTo(verts[0]![0]! * pxScale, verts[0]![1]! * pxScale);
            for (let vi = 1; vi < verts.length; vi++) {
              path.lineTo(verts[vi]![0]! * pxScale, verts[vi]![1]! * pxScale);
            }
            path.closePath();
          }
        }
      }
      tc.strokeStyle = hatchColor;
      tc.lineWidth = ((1.5 + hatchSize * 0.5) / GRID_SCALE) * pxPerFoot;
      tc.lineCap = 'round';
      tc.lineJoin = 'round';
      tc.globalAlpha = hatchOpacity;
      tc.stroke(path);

      const pattern = ctx.createPattern(tile, 'repeat')!;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, cacheW, cacheH);
    }

    this._hatchSig = sig;
    log.dev(`MapCache._ensureHatchLayer → rebuilt tile (sig=${sig.slice(0, 40)}…)`);
  }

  /**
   * Build the hatching composite: hatching base masked to room proximity via
   * Minkowski-sum arcs around room cells, then room interiors cut out.
   * Same approach as the player view's fog-edge composites.
   * Shading is NOT masked here — it uses real roomCells and has its own edges.
   */
  _ensureHatchComposite(
    cells: CellGrid,
    gridSize: number,
    theme: Theme,
    cacheW: number,
    cacheH: number,
    geomVer: number,
  ): void {
    if (!this._hatchCanvas) {
      this._effectsComposite = null;
      this._effectsCompositeSig = '';
      return;
    }

    const sig = `${geomVer},${cacheW},${cacheH},${this._hatchSig}`;
    if (sig === this._effectsCompositeSig && this._effectsComposite) return;

    if (this._effectsComposite?.width !== cacheW || this._effectsComposite.height !== cacheH) {
      this._effectsComposite = document.createElement('canvas');
      this._effectsComposite.width = cacheW;
      this._effectsComposite.height = cacheH;
    }
    const ctx = this._effectsComposite.getContext('2d')!;
    ctx.clearRect(0, 0, cacheW, cacheH);

    // Draw hatching base onto composite
    ctx.drawImage(this._hatchCanvas, 0, 0);

    // Minkowski-sum mask: keep content only inside rounded region around room cells
    const roomCells = getCachedRoomCells(cells);
    const cellPx = gridSize * this._pxPerFoot;
    const MAX_DIST = Math.round((((theme as Record<string, unknown>).hatchDistance as number | undefined) ?? 1) * 2);
    const ballRadius = cellPx * (0.5 + MAX_DIST);

    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    for (let r = 0; r < roomCells.length; r++) {
      const row = roomCells[r]!;
      for (let c = 0; c < row.length; c++) {
        if (!row[c]) continue;
        const cx = (c + 0.5) * cellPx;
        const cy = (r + 0.5) * cellPx;
        ctx.moveTo(cx + ballRadius, cy);
        ctx.arc(cx, cy, ballRadius, 0, Math.PI * 2);
      }
    }
    ctx.fill('nonzero');

    // Cut out room cell interiors for a clean inner edge.
    // For trim cells, only cut out the room portion (trimClip polygon) so
    // the voided portion still shows hatching underneath.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    for (let r = 0; r < roomCells.length; r++) {
      const row = roomCells[r]!;
      for (let c = 0; c < row.length; c++) {
        if (!row[c]) continue;
        const cell = cells[r]?.[c];
        if (cell && isCellSplit(cell)) {
          // Split cell — cut out only the room portion (the non-voided
          // segment(s)). For arc trims and diagonal cuts where one side is
          // voided, this leaves the void hatched. When neither segment is
          // voided (clean diagonal partition), all segments are room.
          const segs = getSegments(cell);
          const px = c * cellPx,
            py = r * cellPx;
          for (const seg of segs) {
            if (seg.voided) continue;
            const poly = seg.polygon;
            ctx.moveTo(px + poly[0]![0]! * cellPx, py + poly[0]![1]! * cellPx);
            for (let i = 1; i < poly.length; i++) {
              ctx.lineTo(px + poly[i]![0]! * cellPx, py + poly[i]![1]! * cellPx);
            }
            ctx.closePath();
          }
        } else {
          // Normal cell — cut out entirely
          ctx.rect(c * cellPx, r * cellPx, cellPx, cellPx);
        }
      }
    }
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    this._effectsCompositeSig = sig;
    log.dev(`MapCache._ensureHatchComposite → rebuilt mask (${roomCells.length}×${roomCells[0]?.length ?? 0})`);
  }

  // ── Internal: full cells + composite rebuild ──

  _rebuildFull(
    p: MapCacheParams,
    cacheTransform: RenderTransform,
    cacheW: number,
    cacheH: number,
    numRows: number,
    numCols: number,
    texVer: number,
    skipSig: string,
  ) {
    this._cellsRebuildCount++;

    this._ensureBaseLayer(cacheW, cacheH);
    this._ensureTopLayer(cacheW, cacheH);

    // Shading/hatching effects live in the composite, not the cells layers.
    const effectsSkip = { ...(p.skipPhases ?? {}), shading: true };

    // ── Pass 1: BASE phases (floors, blending) → _preGridSnapshot.
    // Bridges moved to the TOP pass so they render above fluid; fluid
    // (`fills`) is now a composite sublayer and not a renderCells phase.
    const baseCtx = this._preGridSnapshot!.ctx;
    baseCtx.clearRect(0, 0, cacheW, cacheH);
    if (p.preRenderHook) p.preRenderHook(baseCtx, cacheTransform);
    const baseSkipPhases = {
      ...effectsSkip,
      grid: true,
      walls: true,
      props: true,
      hazard: true,
      fills: true,
      bridges: true,
    };
    renderCells(baseCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
      showGrid: p.showGrid,
      labelStyle: p.labelStyle,
      propCatalog: null,
      textureOptions: p.skipPhases?.textures ? null : p.textureOptions,
      metadata: p.metadata,
      skipLabels: true,
      showInvisible: p.showInvisible,
      bgImageEl: p.bgImageEl,
      bgImgConfig: p.bgImgConfig,
      cacheSize: { w: cacheW, h: cacheH, scale: this._pxPerFoot },
      skipPhases: baseSkipPhases,
    });

    // ── Pass 2: TOP phases (bridges, walls, grid, props, hazard) → _cellsLayer.
    // Alpha-transparent by default so base + fluid show through where
    // there's no structural content. Bridges live here so they render
    // above the fluid composite but below props / hazard.
    const topCtx = this._cellsLayer!.ctx;
    topCtx.clearRect(0, 0, cacheW, cacheH);
    const topSkipPhases = {
      ...effectsSkip,
      floors: true,
      blending: true,
      fills: true,
    };
    renderCells(topCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
      showGrid: p.showGrid,
      labelStyle: p.labelStyle,
      propCatalog: p.skipPhases?.props ? null : p.propCatalog,
      textureOptions: p.skipPhases?.textures ? null : p.textureOptions,
      metadata: p.metadata,
      skipLabels: p.skipLabels ?? p.lightingEnabled ?? !!p.skipPhases?.labels,
      showInvisible: p.showInvisible,
      bgImageEl: p.bgImageEl,
      bgImgConfig: p.bgImgConfig,
      cacheSize: { w: cacheW, h: cacheH, scale: this._pxPerFoot },
      skipPhases: topSkipPhases,
    });

    this._cellsLayer!.dirtySeq = this._dirtySeq;
    this._cellsLayer!.topDirtySeq = this._topDirtySeq;
    this._cellsLayer!.gridDirtySeq = this._gridDirtySeq;
    this._cellsLayer!.texturesVersion = texVer;
    this._cellsLayer!.skipSig = skipSig;

    // Composite (base + fluid + top + lightmap + labels)
    this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer);
  }

  // Allocate / reuse the BASE layer canvas (floors/blending/bridges).
  _ensureBaseLayer(cacheW: number, cacheH: number) {
    if (this._preGridSnapshot?.cacheW !== cacheW || this._preGridSnapshot.cacheH !== cacheH) {
      const offscreen = document.createElement('canvas');
      offscreen.width = cacheW;
      offscreen.height = cacheH;
      this._preGridSnapshot = { canvas: offscreen, ctx: offscreen.getContext('2d')!, cacheW, cacheH };
    }
  }

  // Allocate / reuse the TOP layer canvas (walls/grid/props/hazard).
  _ensureTopLayer(cacheW: number, cacheH: number) {
    if (this._cellsLayer?.cacheW !== cacheW || this._cellsLayer.cacheH !== cacheH) {
      const offscreen = document.createElement('canvas');
      offscreen.width = cacheW;
      offscreen.height = cacheH;
      this._cellsLayer = {
        canvas: offscreen,
        ctx: offscreen.getContext('2d')!,
        dirtySeq: 0,
        topDirtySeq: 0,
        cacheW,
        cacheH,
        texturesVersion: 0,
        skipSig: '',
        gridDirtySeq: 0,
      };
    }
  }

  // ── Internal: partial cells + composite rebuild ──

  _rebuildPartial(
    p: MapCacheParams,
    cacheTransform: RenderTransform,
    cacheW: number,
    cacheH: number,
    numRows: number,
    numCols: number,
    texVer: number,
    _skipSig?: string,
  ) {
    const PAD = 3;
    const dr = p.dirtyRegion!;
    const padded = {
      minRow: Math.max(0, dr.minRow - PAD),
      maxRow: Math.min(numRows - 1, dr.maxRow + PAD),
      minCol: Math.max(0, dr.minCol - PAD),
      maxCol: Math.min(numCols - 1, dr.maxCol + PAD),
    };
    const px1 = padded.minCol * p.gridSize * this._pxPerFoot;
    const py1 = padded.minRow * p.gridSize * this._pxPerFoot;
    const px2 = (padded.maxCol + 1) * p.gridSize * this._pxPerFoot;
    const py2 = (padded.maxRow + 1) * p.gridSize * this._pxPerFoot;
    const pw = px2 - px1,
      ph = py2 - py1;

    this._ensureBaseLayer(cacheW, cacheH);
    this._ensureTopLayer(cacheW, cacheH);
    const effectsSkip = { ...(p.skipPhases ?? {}), shading: true };

    // ── Base canvas — clear + redraw base phases within clip.
    const baseCtx = this._preGridSnapshot!.ctx;
    baseCtx.save();
    baseCtx.beginPath();
    baseCtx.rect(px1, py1, pw, ph);
    baseCtx.clip();
    baseCtx.clearRect(px1, py1, pw, ph);
    if (p.preRenderHook) p.preRenderHook(baseCtx, cacheTransform);
    renderCells(baseCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
      showGrid: p.showGrid,
      labelStyle: p.labelStyle,
      propCatalog: null,
      textureOptions: p.skipPhases?.textures ? null : p.textureOptions,
      metadata: p.metadata,
      skipLabels: true,
      showInvisible: p.showInvisible,
      bgImageEl: p.bgImageEl,
      bgImgConfig: p.bgImgConfig,
      cacheSize: { w: cacheW, h: cacheH, scale: this._pxPerFoot },
      skipPhases: { ...effectsSkip, grid: true, walls: true, props: true, hazard: true, fills: true, bridges: true },
      visibleBounds: padded,
      dirtyRegion: padded,
    });
    baseCtx.restore();

    // ── Top canvas — clear + redraw top phases within clip (alpha).
    // Skip entirely when the top-layer version hasn't advanced (texture/fill-only
    // edits). Clearing the top layer here on a texture paint is what caused
    // diagonal features spanning the padded clip boundary to be half-cut.
    const topNeedsRebuild = this._cellsLayer!.topDirtySeq !== this._topDirtySeq;
    if (topNeedsRebuild) {
      const topCtx = this._cellsLayer!.ctx;
      topCtx.save();
      topCtx.beginPath();
      topCtx.rect(px1, py1, pw, ph);
      topCtx.clip();
      topCtx.clearRect(px1, py1, pw, ph);
      renderCells(topCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
        showGrid: p.showGrid,
        labelStyle: p.labelStyle,
        propCatalog: p.skipPhases?.props ? null : p.propCatalog,
        textureOptions: p.skipPhases?.textures ? null : p.textureOptions,
        metadata: p.metadata,
        skipLabels: p.skipLabels ?? p.lightingEnabled ?? !!p.skipPhases?.labels,
        showInvisible: p.showInvisible,
        bgImageEl: p.bgImageEl,
        bgImgConfig: p.bgImgConfig,
        cacheSize: { w: cacheW, h: cacheH, scale: this._pxPerFoot },
        skipPhases: { ...effectsSkip, floors: true, blending: true, fills: true },
        visibleBounds: padded,
        dirtyRegion: padded,
      });
      topCtx.restore();
      this._cellsLayer!.topDirtySeq = this._topDirtySeq;
    }

    this._cellsLayer!.dirtySeq = this._dirtySeq;
    // Keep gridDirtySeq / texturesVersion / skipSig in sync — _rebuildPartial
    // runs both base and top passes, so any pending grid/texture/skip work is
    // folded in. If we don't stamp these, the next `update()` sees stale
    // sequence numbers and runs a redundant full-canvas grid rebuild (which
    // bypasses the clipRect optimization), producing a big GPU task for no
    // reason.
    this._cellsLayer!.gridDirtySeq = this._gridDirtySeq;
    this._cellsLayer!.texturesVersion = texVer;
    this._cellsLayer!.skipSig = _skipSig ?? this._cellsLayer!.skipSig;

    // Partial composite update (clipped to same region)
    this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer, { px1, py1, pw, ph });
  }

  // ── Internal: top-layer-only rebuild (walls/grid/props/hazard) ──
  //
  // Used when only the top phases changed (e.g. a wall color tweak or a
  // grid opacity slider). Clears the cells-top canvas and redraws only the
  // top phases — base layer and fluid composite are reused as-is.

  _rebuildFromSnapshot(
    p: MapCacheParams,
    cacheTransform: RenderTransform,
    cacheW: number,
    cacheH: number,
    texVer: number,
  ) {
    this._ensureTopLayer(cacheW, cacheH);
    const topCtx = this._cellsLayer!.ctx;
    topCtx.clearRect(0, 0, cacheW, cacheH);

    const topSkipPhases = {
      ...(p.skipPhases ?? {}),
      shading: true,
      floors: true,
      blending: true,
      fills: true,
    };
    renderCells(topCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
      showGrid: p.showGrid,
      labelStyle: p.labelStyle,
      propCatalog: p.skipPhases?.props ? null : p.propCatalog,
      textureOptions: p.skipPhases?.textures ? null : p.textureOptions,
      metadata: p.metadata,
      skipLabels: p.skipLabels ?? p.lightingEnabled ?? !!p.skipPhases?.labels,
      showInvisible: p.showInvisible,
      bgImageEl: p.bgImageEl,
      bgImgConfig: p.bgImgConfig,
      cacheSize: { w: cacheW, h: cacheH, scale: this._pxPerFoot },
      skipPhases: topSkipPhases,
    });

    this._cellsLayer!.gridDirtySeq = this._gridDirtySeq;
    this._cellsLayer!.topDirtySeq = this._topDirtySeq;

    // Recomposite (top changed, need to re-blit into composite)
    this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer);
  }

  // ── Internal: fluid composite sublayer ──
  //
  // Rebuilt when the fluid theme signature changes (any fluid color) or
  // when cell mutations invalidate the variant clips. Blitted into the
  // final composite between the base layer and the top layer so walls
  // and grid stay visually on top.

  _ensureFluidComposite(cells: CellGrid, gridSize: number, theme: Theme, cacheW: number, cacheH: number) {
    const fluidSig = fluidThemeSig(theme);
    // Key on the fluid-specific data version — bumps only when fluid
    // cells are added/removed, waterDepth changes, or the fluid theme
    // is recoloured (see `smartInvalidate` in render-cache.ts for the
    // needsFluid detection that drives `_fluidDataVersion`). Wall /
    // prop / texture / far-from-fluid geometry edits don't force the
    // composite to rebuild.
    const sig = `${getFluidDataVersion()},${cacheW},${cacheH},${fluidSig}`;
    if (sig === this._fluidCompositeSig && this._fluidComposite) return;

    const roomCells = getCachedRoomCells(cells);
    const existing = this._fluidComposite;
    // Consume the pending fluid dirty region accumulated by `patchFluidRegion`.
    // A theme-color change or a size change invalidates every pixel of the
    // composite, so only forward the dirty rect when neither happened — else
    // fall back to a full rebuild (dirtyRect = null).
    const pending = consumeFluidPartialRegion();
    const themeChanged = fluidSig !== this._lastFluidThemeSig;
    const sizeMatches = !!existing && existing.width === cacheW && existing.height === cacheH;
    const dirtyRect = !pending.full && !themeChanged && sizeMatches ? pending.region : null;
    const next = buildFluidComposite(
      cells,
      roomCells,
      gridSize,
      theme,
      this._pxPerFoot,
      cacheW,
      cacheH,
      existing,
      dirtyRect,
    );
    this._fluidComposite = next;
    this._lastFluidThemeSig = fluidSig;
    this._fluidCompositeSig = sig;
    log.dev(`MapCache._ensureFluidComposite → ${next ? (dirtyRect ? 'partial' : 'rebuilt') : 'no fluids'}`);
  }

  // ── Internal: build composite layer ──
  // Order: background → shading → hatching → BASE cells → fluid composite →
  //        TOP cells → lightmap → labels.
  //
  // Effects live here so effects-only changes (theme sliders) skip the
  // cells rebuild. Fluid sits between base and top so walls/grid/props
  // stay visually above water/lava/pit.

  _buildComposite(
    p: MapCacheParams,
    cacheTransform: RenderTransform,
    cacheW: number,
    cacheH: number,
    texVer: number,
    clipRect: ClipRect | null = null,
  ) {
    if (this._compositeLayer?.cacheW !== cacheW || this._compositeLayer.cacheH !== cacheH) {
      const offscreen = document.createElement('canvas');
      offscreen.width = cacheW;
      offscreen.height = cacheH;
      this._compositeLayer = {
        canvas: offscreen,
        ctx: offscreen.getContext('2d', { alpha: false })!,
        dirtySeq: 0,
        cacheW,
        cacheH,
        compositeDirtySeq: 0,
        texturesVersion: 0,
      };
    }

    this._compositeRebuildCount++;
    const compCtx = this._compositeLayer.ctx;

    // When a clipRect is supplied (partial rebuild from a small dirty region),
    // use the source-rect form of drawImage so each blit only touches the
    // relevant strip of pixels on both the source and destination. The old
    // `ctx.clip()` approach restricted writes but still forced Chromium to
    // rasterize every source at full-canvas size — that was the bulk of the
    // GPU stall on single-cell texture applies.
    const cx = clipRect ? clipRect.px1 : 0;
    const cy = clipRect ? clipRect.py1 : 0;
    const cw = clipRect ? clipRect.pw : cacheW;
    const ch = clipRect ? clipRect.ph : cacheH;

    // drawImage with source + dest rects. When not clipping, fall back to the
    // simpler 3-arg form (avoids unnecessary sub-rect math).
    const blit = clipRect
      ? (src: CanvasImageSource) => compCtx.drawImage(src, cx, cy, cw, ch, cx, cy, cw, ch)
      : (src: CanvasImageSource) => compCtx.drawImage(src, 0, 0);

    compCtx.globalCompositeOperation = 'source-over';

    // Background fill (was in cells layer, now here so cells layer can be transparent)
    compCtx.fillStyle = p.theme.background;
    compCtx.fillRect(cx, cy, cw, ch);

    // Effects layers — built/cached here so effects-only theme changes skip cells rebuild
    if (!p.skipPhases?.shading) {
      const geomVer = p.geometryVersion ?? 0;
      if (!p.skipPhases?.outerShading) {
        this._ensureShadingLayer(p.cells, p.gridSize, p.theme, p.metadata, cacheW, cacheH, geomVer);
        if (this._shadingCanvas) blit(this._shadingCanvas);
      }
      if (!p.skipPhases?.hatching) {
        this._ensureHatchLayer(p.cells, p.gridSize, p.theme, cacheW, cacheH);
        this._ensureHatchComposite(p.cells, p.gridSize, p.theme, cacheW, cacheH, geomVer);
        if (this._effectsComposite) blit(this._effectsComposite);
      }
    }

    // Base cells layer (floors + blending + bridges). Opaque inside rooms
    // so shading / hatching bleeds only outside the floor.
    if (this._preGridSnapshot) {
      blit(this._preGridSnapshot.canvas);
    }

    // Fluid composite (water / lava / pit tile blits with spill-aware clips).
    // Rebuilt when fluid theme sig changes or variant clips get invalidated.
    if (!p.skipPhases?.fills) {
      this._ensureFluidComposite(p.cells, p.gridSize, p.theme, cacheW, cacheH);
      if (this._fluidComposite) {
        blit(this._fluidComposite);
      }
    }

    // Top cells layer (walls, grid, props, hazard). Alpha-transparent so
    // base + fluid show through where there's no structural content.
    blit(this._cellsLayer!.canvas);

    // Lighting + labels still render full-canvas internally; scope them to the
    // clip rect so a partial rebuild doesn't re-bake lighting over the whole map.
    if (clipRect) {
      compCtx.save();
      compCtx.beginPath();
      compCtx.rect(cx, cy, cw, ch);
      compCtx.clip();
    }

    // Bake static lighting into composite (skip when animated lights exist —
    // those are rendered per-frame at screen resolution by the caller)
    if (p.lightingEnabled && !p.hasAnimLights && !p.skipPhases?.lighting) {
      const fillLights = extractFillLights(p.cells, p.gridSize, p.theme);
      const allLights = fillLights.length ? [...p.lights, ...fillLights] : p.lights;
      renderLightmap(
        compCtx,
        allLights,
        p.cells,
        p.gridSize,
        cacheTransform,
        cacheW,
        cacheH,
        p.ambientLight,
        p.textureCatalog,
        p.propCatalog,
        { ambientColor: p.ambientColor ?? '#ffffff', time: p.animClock ?? 0, lightPxPerFoot: p.lightPxPerFoot ?? 10 },
        p.metadata,
      );
    }

    // Labels rendered after lightmap so they're visible on dark maps
    if (p.lightingEnabled) {
      renderLabels(compCtx, p.cells, p.gridSize, p.theme, cacheTransform, p.labelStyle);
    }

    if (clipRect) compCtx.restore();

    this._compositeLayer.dirtySeq = this._dirtySeq;
    this._compositeLayer.compositeDirtySeq = this._compositeDirtySeq;
    this._compositeLayer.texturesVersion = texVer;
  }
}
