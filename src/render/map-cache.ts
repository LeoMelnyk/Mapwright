// Shared offscreen map cache used by both the editor and player views.
//
// Two internal layers + snapshot:
//   1. _cellsLayer       — renderCells output (floors, grid, walls, bridges, props — no lightmap)
//   2. _compositeLayer   — cells + static lightmap + labels (final blit source)
//   3. _preGridSnapshot  — cells layer state before grid+walls+bridges+props
//
// Grid setting changes restore the snapshot and re-render only the cheap top
// phases (grid, walls, bridges, props), skipping expensive floors/textures/blending.
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

/** Internal cells-layer state (floors, grid, walls, bridges, props — no lightmap). */
interface CellsLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dirtySeq: number;
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
 * Shared offscreen map cache for editor and player views.
 * Manages cells layer, composite layer, and pre-grid snapshot for efficient redraws.
 */
export class MapCache {
  _pxPerFoot: number;
  _maxCacheDim: number;
  _cellsLayer: CellsLayer | null;
  _compositeLayer: CompositeLayer | null;
  _preGridSnapshot: SnapshotLayer | null;
  _dirtySeq: number;
  _compositeDirtySeq: number;
  _gridDirtySeq: number;
  _gridRedrawEnabled: boolean;
  _lastContentVersion: number;
  _lastLightingVersion: number;
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

    // Version tracking — compared against caller-supplied versions
    this._dirtySeq = 0;
    this._compositeDirtySeq = 0;
    this._gridDirtySeq = 0;
    this._gridRedrawEnabled = false;
    this._lastContentVersion = 0;
    this._lastLightingVersion = 0;

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
  }

  /**
   * Invalidate only the composite layer (lighting/theme change -- cells layer stays cached).
   * @returns {void}
   */
  invalidateComposite() {
    this._compositeDirtySeq++;
  }

  /**
   * Invalidate only the grid overlay -- triggers grid-only rebuild, no cells or composite touch.
   * @returns {void}
   */
  invalidateGrid() {
    this._gridDirtySeq++;
    this._gridRedrawEnabled = true;
  }

  /**
   * Free GPU memory by releasing all cached canvases.
   * @returns {void}
   */
  dispose() {
    this._cellsLayer = null;
    this._compositeLayer = null;
    this._preGridSnapshot = null;
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
   * @param {CanvasRenderingContext2D} destCtx - Destination canvas context
   * @param {{ offsetX: number, offsetY: number, scale: number }} transform - View transform
   * @returns {void}
   */
  blit(destCtx: CanvasRenderingContext2D, transform: RenderTransform) {
    if (!this._compositeLayer) return;
    const sx = transform.scale / this._pxPerFoot;
    const dw = this._compositeLayer.cacheW * sx;
    const dh = this._compositeLayer.cacheH * sx;
    destCtx.drawImage(this._compositeLayer.canvas, transform.offsetX, transform.offsetY, dw, dh);
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

    if (cacheW > this._maxCacheDim || cacheH > this._maxCacheDim) return false;

    // ── Dirty tracking ──
    const cv = p.contentVersion;
    if (cv !== this._lastContentVersion) {
      this._dirtySeq++;
      this._compositeDirtySeq++;
      this._lastContentVersion = cv;
    }

    const lv = p.lightingVersion;
    if (lv !== this._lastLightingVersion) {
      // Lighting changes only need composite rebuild (lightmap is baked there)
      if (!p.hasAnimLights) this._compositeDirtySeq++;
      this._lastLightingVersion = lv;
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

    const needsCompositeOnly =
      !needsCellsRedraw && this._compositeLayer && this._compositeLayer.compositeDirtySeq !== this._compositeDirtySeq;

    const needsGridOnly =
      !needsCellsRedraw &&
      !needsCompositeOnly &&
      this._gridRedrawEnabled &&
      this._preGridSnapshot &&
      this._cellsLayer!.gridDirtySeq !== this._gridDirtySeq;

    if (!needsCellsRedraw && !needsCompositeOnly && !needsGridOnly) return false;

    const _cacheStart = performance.now();
    const cacheTransform = { scale: pxPerFoot, offsetX: 0, offsetY: 0 };

    // Composite-only change (lighting/theme) — skip cells layer, just recomposite.
    // The lightmap has its own internal cache so this is cheap.
    if (needsCompositeOnly) {
      this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer);
      this._lastRebuildMs = performance.now() - _cacheStart;
      this._lastRebuildType = 'composite';
      return true;
    }

    // Grid-only change — restore pre-grid snapshot and re-render grid + walls + props.
    // Skips expensive shading/floors/textures/blending phases entirely.
    if (needsGridOnly) {
      if (this._preGridSnapshot) {
        this._rebuildFromSnapshot(p, cacheTransform, cacheW, cacheH, texVer);
        this._lastRebuildMs = performance.now() - _cacheStart;
        this._lastRebuildType = 'grid';
        return true;
      }
      // No snapshot yet — fall through to full rebuild which will capture one
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
    return true;
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

    // Create / resize cells layer
    if (this._cellsLayer?.cacheW !== cacheW || this._cellsLayer.cacheH !== cacheH) {
      const offscreen = document.createElement('canvas');
      offscreen.width = cacheW;
      offscreen.height = cacheH;
      this._cellsLayer = {
        canvas: offscreen,
        ctx: offscreen.getContext('2d', { alpha: false })!,
        dirtySeq: 0,
        cacheW,
        cacheH,
        texturesVersion: 0,
        skipSig: '',
        gridDirtySeq: 0,
      };
    }

    const offCtx = this._cellsLayer.ctx;
    offCtx.fillStyle = p.theme.background;
    offCtx.fillRect(0, 0, cacheW, cacheH);

    if (p.preRenderHook) p.preRenderHook(offCtx, cacheTransform);

    if (this._gridRedrawEnabled) {
      // Two-pass: render base phases, capture snapshot, then render grid+walls+props.
      // Snapshot enables cheap grid-only redraws later.
      const baseSkipPhases = { ...(p.skipPhases ?? {}), grid: true, walls: true, props: true, hazard: true };
      renderCells(offCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
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
      this._savePreGridSnapshot(cacheW, cacheH);
      const topSkipPhases = {
        ...(p.skipPhases ?? {}),
        shading: true,
        floors: true,
        blending: true,
        fills: true,
        bridges: true,
      };
      renderCells(offCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
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
    } else {
      // Single-pass: normal rendering (player view, or before first grid edit)
      renderCells(offCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
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
        skipPhases: p.skipPhases ?? null,
      });
    }

    this._cellsLayer.dirtySeq = this._dirtySeq;
    this._cellsLayer.gridDirtySeq = this._gridDirtySeq;
    this._cellsLayer.texturesVersion = texVer;
    this._cellsLayer.skipSig = skipSig;

    // Composite (cells + lightmap + labels)
    this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer);
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

    const layer = this._cellsLayer!;
    const offCtx = layer.ctx;
    offCtx.save();
    offCtx.beginPath();
    offCtx.rect(px1, py1, pw, ph);
    offCtx.clip();

    offCtx.fillStyle = p.theme.background;
    offCtx.fillRect(px1, py1, pw, ph);

    if (p.preRenderHook) p.preRenderHook(offCtx, cacheTransform);

    renderCells(offCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
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
      skipPhases: p.skipPhases ?? null,
      visibleBounds: padded,
    });

    offCtx.restore();
    layer.dirtySeq = this._dirtySeq;

    // Partial composite update (clipped to same region)
    this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer, { px1, py1, pw, ph });
  }

  // ── Internal: snapshot / restore for grid-only redraws ──

  _savePreGridSnapshot(cacheW: number, cacheH: number) {
    if (this._preGridSnapshot?.cacheW !== cacheW || this._preGridSnapshot.cacheH !== cacheH) {
      const offscreen = document.createElement('canvas');
      offscreen.width = cacheW;
      offscreen.height = cacheH;
      this._preGridSnapshot = { canvas: offscreen, ctx: offscreen.getContext('2d', { alpha: false })!, cacheW, cacheH };
    }
    this._preGridSnapshot.ctx.drawImage(this._cellsLayer!.canvas, 0, 0);
  }

  _rebuildFromSnapshot(
    p: MapCacheParams,
    cacheTransform: RenderTransform,
    cacheW: number,
    cacheH: number,
    texVer: number,
  ) {
    // Restore cells layer to pre-grid state
    const offCtx = this._cellsLayer!.ctx;
    offCtx.drawImage(this._preGridSnapshot!.canvas, 0, 0);

    // Re-render only grid + shading + walls + props (skip expensive base phases)
    const topSkipPhases = {
      ...(p.skipPhases ?? {}),
      shading: true,
      floors: true,
      blending: true,
      fills: true,
      bridges: true,
    };
    renderCells(offCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
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

    // Recomposite (cells changed, need to re-blit into composite)
    this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer);
  }

  // ── Internal: build composite layer (cells + static lightmap + labels) ──

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

    if (clipRect) {
      compCtx.save();
      compCtx.beginPath();
      compCtx.rect(clipRect.px1, clipRect.py1, clipRect.pw, clipRect.ph);
      compCtx.clip();
    }

    compCtx.globalCompositeOperation = 'source-over';
    compCtx.drawImage(this._cellsLayer!.canvas, 0, 0);

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
