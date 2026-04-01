// Shared offscreen map cache used by both the editor and player views.
//
// Two internal layers:
//   1. _cellsLayer  — cells-only render (renderCells output, no lightmap)
//   2. _compositeLayer — cells + static lightmap + labels (final blit source)
//
// Supports partial dirty-region redraws when only a small area changed.
// State-agnostic — receives all data through update() parameters.

// Import directly from source files (not index.js) to avoid circular dependency,
// since index.js re-exports MapCache from this file.
import { renderCells, renderLabels } from './render.js';
import { renderLightmap, extractFillLights } from './lighting.js';

const DEFAULT_MAX_CACHE_DIM = 16384;

export class MapCache {
  constructor({ pxPerFoot = 20, maxCacheDim = DEFAULT_MAX_CACHE_DIM } = {}) {
    this._pxPerFoot = pxPerFoot;
    this._maxCacheDim = maxCacheDim;

    // Internal layers
    this._cellsLayer = null;   // { canvas, ctx, dirtySeq, cacheW, cacheH, texturesVersion, skipSig }
    this._compositeLayer = null; // { canvas, ctx, dirtySeq, cacheW, cacheH, texturesVersion }

    // Version tracking — compared against caller-supplied versions
    this._dirtySeq = 0;
    this._lastContentVersion = 0;
    this._lastLightingVersion = 0;

    // Diagnostics
    this._cellsRebuildCount = 0;
    this._compositeRebuildCount = 0;
    this._lastRebuildMs = 0;
  }

  get pxPerFoot() { return this._pxPerFoot; }

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
      cacheW: this._compositeLayer?.cacheW ?? 0,
      cacheH: this._compositeLayer?.cacheH ?? 0,
    };
  }

  /**
   * Check whether the map fits within GPU texture limits at current pxPerFoot.
   */
  canCache(numRows, numCols, gridSize) {
    const cacheW = Math.ceil(numCols * gridSize * this._pxPerFoot);
    const cacheH = Math.ceil(numRows * gridSize * this._pxPerFoot);
    return cacheW <= this._maxCacheDim && cacheH <= this._maxCacheDim;
  }

  /** Force a full rebuild on the next update(). */
  invalidate() { this._dirtySeq++; }

  /** Free GPU memory. */
  dispose() {
    this._cellsLayer = null;
    this._compositeLayer = null;
  }

  /**
   * Get the composite canvas for external use (e.g., animated light overlay).
   * Returns null if cache is not built yet.
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
   * @param {CanvasRenderingContext2D} destCtx
   * @param {{ offsetX: number, offsetY: number, scale: number }} transform
   */
  blit(destCtx, transform) {
    if (!this._compositeLayer) return;
    const sx = transform.scale / this._pxPerFoot;
    const dw = this._compositeLayer.cacheW * sx;
    const dh = this._compositeLayer.cacheH * sx;
    destCtx.drawImage(this._compositeLayer.canvas,
      transform.offsetX, transform.offsetY, dw, dh);
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
   * @param {object|null} p.skipPhases       — editor debug skip flags
   * @param {boolean}     p.skipLabels       — skip label rendering in renderCells (rendered after lightmap)
   */
  update(p) {
    const pxPerFoot = this._pxPerFoot;
    const numRows = p.cells.length;
    const numCols = p.cells[0]?.length || 0;
    const cacheW = Math.ceil(numCols * p.gridSize * pxPerFoot);
    const cacheH = Math.ceil(numRows * p.gridSize * pxPerFoot);

    if (cacheW > this._maxCacheDim || cacheH > this._maxCacheDim) return false;

    // ── Dirty tracking ──
    const cv = p.contentVersion;
    if (cv !== this._lastContentVersion) {
      this._dirtySeq++;
      this._lastContentVersion = cv;
    }

    const lv = p.lightingVersion;
    if (lv !== this._lastLightingVersion) {
      // Only bump dirty seq for lighting when it's baked into the composite
      if (!p.hasAnimLights) this._dirtySeq++;
      this._lastLightingVersion = lv;
    }

    const texVer = p.texturesVersion;
    const skipSig = p.skipPhases
      ? Object.keys(p.skipPhases).filter(k => p.skipPhases[k] && k !== 'all').join(',')
      : '';

    const needsCellsRedraw = !this._cellsLayer ||
      this._cellsLayer.dirtySeq !== this._dirtySeq ||
      this._cellsLayer.cacheW !== cacheW || this._cellsLayer.cacheH !== cacheH ||
      this._cellsLayer.texturesVersion !== texVer ||
      this._cellsLayer.skipSig !== skipSig;

    if (!needsCellsRedraw) return false;

    const _cacheStart = performance.now();
    const cacheTransform = { scale: pxPerFoot, offsetX: 0, offsetY: 0 };

    // ── Check for partial redraw eligibility ──
    const canPartial = p.dirtyRegion && this._cellsLayer &&
      this._cellsLayer.cacheW === cacheW && this._cellsLayer.cacheH === cacheH &&
      this._cellsLayer.texturesVersion === texVer &&
      this._cellsLayer.skipSig === skipSig;

    if (canPartial) {
      this._rebuildPartial(p, cacheTransform, cacheW, cacheH, numRows, numCols, texVer, skipSig);
    } else {
      this._rebuildFull(p, cacheTransform, cacheW, cacheH, numRows, numCols, texVer, skipSig);
    }

    this._lastRebuildMs = performance.now() - _cacheStart;
    return true;
  }

  // ── Internal: full cells + composite rebuild ──

  _rebuildFull(p, cacheTransform, cacheW, cacheH, numRows, numCols, texVer, skipSig) {
    this._cellsRebuildCount++;

    // Create / resize cells layer
    if (!this._cellsLayer || this._cellsLayer.cacheW !== cacheW || this._cellsLayer.cacheH !== cacheH) {
      const offscreen = document.createElement('canvas');
      offscreen.width = cacheW;
      offscreen.height = cacheH;
      this._cellsLayer = { canvas: offscreen, ctx: offscreen.getContext('2d', { alpha: false }), dirtySeq: 0, cacheW, cacheH };
    }

    const offCtx = this._cellsLayer.ctx;
    offCtx.fillStyle = p.theme.background;
    offCtx.fillRect(0, 0, cacheW, cacheH);

    if (p.preRenderHook) p.preRenderHook(offCtx, cacheTransform);

    renderCells(offCtx, p.cells, p.gridSize, p.theme, cacheTransform, {
      showGrid: p.showGrid,
      labelStyle: p.labelStyle,
      propCatalog: p.skipPhases?.props ? null : p.propCatalog,
      textureOptions: p.skipPhases?.textures ? null : p.textureOptions,
      metadata: p.metadata,
      skipLabels: p.skipLabels ?? (p.lightingEnabled || !!p.skipPhases?.labels),
      showInvisible: p.showInvisible,
      bgImageEl: p.bgImageEl,
      bgImgConfig: p.bgImgConfig,
      cacheSize: { w: cacheW, h: cacheH, scale: this._pxPerFoot },
      skipPhases: p.skipPhases || null,
    });

    this._cellsLayer.dirtySeq = this._dirtySeq;
    this._cellsLayer.texturesVersion = texVer;
    this._cellsLayer.skipSig = skipSig;

    // Composite (cells + lightmap + labels)
    this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer);
  }

  // ── Internal: partial cells + composite rebuild ──

  _rebuildPartial(p, cacheTransform, cacheW, cacheH, numRows, numCols, texVer) {
    const PAD = 3;
    const padded = {
      minRow: Math.max(0, p.dirtyRegion.minRow - PAD),
      maxRow: Math.min(numRows - 1, p.dirtyRegion.maxRow + PAD),
      minCol: Math.max(0, p.dirtyRegion.minCol - PAD),
      maxCol: Math.min(numCols - 1, p.dirtyRegion.maxCol + PAD),
    };
    const px1 = padded.minCol * p.gridSize * this._pxPerFoot;
    const py1 = padded.minRow * p.gridSize * this._pxPerFoot;
    const px2 = (padded.maxCol + 1) * p.gridSize * this._pxPerFoot;
    const py2 = (padded.maxRow + 1) * p.gridSize * this._pxPerFoot;
    const pw = px2 - px1, ph = py2 - py1;

    const offCtx = this._cellsLayer.ctx;
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
      skipLabels: p.skipLabels ?? (p.lightingEnabled || !!p.skipPhases?.labels),
      showInvisible: p.showInvisible,
      bgImageEl: p.bgImageEl,
      bgImgConfig: p.bgImgConfig,
      cacheSize: { w: cacheW, h: cacheH, scale: this._pxPerFoot },
      skipPhases: p.skipPhases || null,
      visibleBounds: padded,
    });

    offCtx.restore();
    this._cellsLayer.dirtySeq = this._dirtySeq;

    // Partial composite update (clipped to same region)
    this._buildComposite(p, cacheTransform, cacheW, cacheH, texVer, { px1, py1, pw, ph });
  }

  // ── Internal: build composite layer (cells + static lightmap + labels) ──

  _buildComposite(p, cacheTransform, cacheW, cacheH, texVer, clipRect = null) {
    if (!this._compositeLayer || this._compositeLayer.cacheW !== cacheW || this._compositeLayer.cacheH !== cacheH) {
      const offscreen = document.createElement('canvas');
      offscreen.width = cacheW;
      offscreen.height = cacheH;
      this._compositeLayer = { canvas: offscreen, ctx: offscreen.getContext('2d', { alpha: false }), dirtySeq: 0, cacheW, cacheH };
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
    compCtx.drawImage(this._cellsLayer.canvas, 0, 0);

    // Bake static lighting into composite (skip when animated lights exist —
    // those are rendered per-frame at screen resolution by the caller)
    if (p.lightingEnabled && !p.hasAnimLights && !p.skipPhases?.lighting) {
      const fillLights = extractFillLights(p.cells, p.gridSize, p.theme);
      const allLights = fillLights.length
        ? [...(p.lights || []), ...fillLights]
        : (p.lights || []);
      renderLightmap(compCtx, allLights, p.cells, p.gridSize, cacheTransform,
        cacheW, cacheH, p.ambientLight ?? 0.15,
        p.textureCatalog, p.propCatalog,
        { ambientColor: p.ambientColor || '#ffffff', time: p.animClock ?? 0, lightPxPerFoot: p.lightPxPerFoot ?? 10 },
        p.metadata);
    }

    // Labels rendered after lightmap so they're visible on dark maps
    if (p.lightingEnabled) {
      renderLabels(compCtx, p.cells, p.gridSize, p.theme, cacheTransform, p.labelStyle);
    }

    if (clipRect) compCtx.restore();

    this._compositeLayer.dirtySeq = this._dirtySeq;
    this._compositeLayer.texturesVersion = texVer;
  }
}
