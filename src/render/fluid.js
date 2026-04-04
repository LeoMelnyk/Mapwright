import { WATER_TILE_SIZE, WATER_SPATIAL } from './patterns.js';

// ── Per-frame fluid/pit caches ───────────────────────────────────────────────
let _fluidCellsCache = { cells: null, water: null, lava: null };
let _pitDataCache = { cells: null, pitSet: null, pitCells: null, groups: null, numCols: 0, numRows: 0 };

// ── World-space fluid Path2D cache ──────────────────────────────────────────
// Builds pit/water/lava geometry as Path2D objects in world coordinates, keyed
// on cells + gridSize + theme. Rendered via ctx.setTransform (same as rock
// shading) so output is pixel-perfect at any zoom — no drawImage pixel scaling.
let _fluidPathCache = { cells: null, gridSize: null, theme: null, data: null };

// ── Rendered fluid layer cache ─────────────────────────────────────────────
// Pre-rendered offscreen canvas of all fill patterns (pit/water/lava) at cache
// resolution. Valid as long as _fluidPathCache is valid. Avoids re-rendering
// thousands of Voronoi Path2D objects on every map cache rebuild.
let _fluidRenderLayer = null;  // { canvas, w, h }

function getCachedFluidCells(cells, roomCells, fillType) {
  if (_fluidCellsCache.cells !== cells) {
    _fluidCellsCache = { cells, water: null, lava: null };
  }
  if (!_fluidCellsCache[fillType]) {
    _fluidCellsCache[fillType] = collectFluidCells(cells, roomCells, fillType);
  }
  return _fluidCellsCache[fillType];
}

function getCachedPitData(cells, roomCells) {
  if (_pitDataCache.cells === cells) return _pitDataCache;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const pitSet = new Set();
  const pitCells = [];
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
  const visited = new Set();
  const groups = [];
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const key = row * numCols + col;
      if (visited.has(key) || !pitSet.has(key)) continue;
      const group = [];
      const queue = [[row, col]];
      visited.add(key);
      while (queue.length > 0) {
        const [r2, c2] = queue.shift();
        group.push([r2, c2]);
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r2 + dr, nc = c2 + dc;
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

// ── Water rendering ──────────────────────────────────────────────────────────

/**
 * Collect water cells and read per-cell waterDepth (1/2/3).
 * Replaces the old BFS-based depth computation.
 */
function collectFluidCells(cells, roomCells, fillType) {
  const depthKey = fillType + 'Depth'; // 'waterDepth' or 'lavaDepth'
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const fluidSet = new Set();
  const fluidCells = [];
  const depthMap = new Map();
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (cell?.fill === fillType && roomCells[row]?.[col]) {
        const key = row * numCols + col;
        fluidSet.add(key);
        fluidCells.push([row, col]);
        depthMap.set(key, cell[depthKey] ?? 1);
      }
    }
  }
  return { fluidCells, depthMap, fluidSet, numCols };
}

// Default fluid colors keyed by fill type
const FLUID_DEFAULTS = {
  water: { shallow: '#2d69a5', medium: '#1e4b8a', deep: '#0f2d6e', caustic: 'rgba(160,215,255,0.55)' },
  lava:  { shallow: '#cc4400', medium: '#992200', deep: '#661100', caustic: 'rgba(255,160,60,0.55)' },
};

// Default pit colors — dark earthy stone with subtle cracks
const PIT_DEFAULTS = {
  base:     '#1a1a18',           // dark warm gray base
  crack:    'rgba(0,0,0,0.45)',  // dark crack lines between Voronoi cells
  vignette: 'rgba(0,0,0,0.65)', // radial darkening toward pit center
};

/**
 * Build world-space Path2D geometry for all fluid (water/lava) and pit fills.
 * Stores vertices in world coordinates; rendering uses ctx.setTransform so
 * output is pixel-perfect at any zoom level (no drawImage pixel scaling).
 * Called once per unique (cells, gridSize, theme) combination.
 *
 * @param {Array} roomCells - Pre-computed room cell mask (from getCachedRoomCells)
 */
function buildFluidGeometry(cells, gridSize, theme, roomCells) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const toRgb = h => {
    if (Array.isArray(h)) return h;
    const x = h.replace('#', '');
    return [parseInt(x.substring(0, 2), 16), parseInt(x.substring(2, 4), 16), parseInt(x.substring(4, 6), 16)];
  };

  const tileWorld = gridSize * 8;
  const patternScale = tileWorld / WATER_TILE_SIZE;
  const { bins: spatialBins, N: binCount, binSize } = WATER_SPATIAL;
  const bleedDirs = [[-1, 0, 'north'], [1, 0, 'south'], [0, -1, 'west'], [0, 1, 'east']];

  function buildForFluid(fillType) {
    const { fluidCells, depthMap, fluidSet } = getCachedFluidCells(cells, roomCells, fillType);
    if (fluidCells.length === 0) return null;

    const defaults = FLUID_DEFAULTS[fillType] || FLUID_DEFAULTS.water;
    const fluidColors = [
      toRgb(theme[fillType + 'ShallowColor'] || defaults.shallow),
      toRgb(theme[fillType + 'MediumColor']  || defaults.medium),
      toRgb(theme[fillType + 'DeepColor']    || defaults.deep),
    ];
    const causticColor = theme[fillType + 'CausticColor'] || defaults.caustic;

    // Wall-aware clip path in world space — includes bleed cells adjacent to fluid.
    // For trim boundary cells, clip to the floor polygon (trimClip) instead of the full cell rect.
    const clipPath = new Path2D();
    for (const [row, col] of fluidCells) {
      const cell = cells[row][col];
      if (cell.trimClip && !cell.trimOpen) {
        // Add only the floor polygon (trimClip is in cell-local [0,1] coords)
        const ox = col * gridSize, oy = row * gridSize;
        const clip = cell.trimClip;
        clipPath.moveTo(ox + clip[0][0] * gridSize, oy + clip[0][1] * gridSize);
        for (let i = 1; i < clip.length; i++)
          clipPath.lineTo(ox + clip[i][0] * gridSize, oy + clip[i][1] * gridSize);
        clipPath.closePath();
      } else {
        clipPath.rect(col * gridSize, row * gridSize, gridSize, gridSize);
      }
      for (const [dr, dc, dir] of bleedDirs) {
        const nr = row + dr, nc = col + dc;
        if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
        if (fluidSet.has(nr * numCols + nc)) continue;
        if (cell[dir] === 'w' || cell[dir] === 'd') continue;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor) continue; // don't bleed into void cells (trimmed away)
        if (neighbor.trimClip && !neighbor.trimOpen) continue;
        clipPath.rect(nc * gridSize, nr * gridSize, gridSize, gridSize);
      }
    }

    // Fluid bounding box for tile iteration (no viewport culling — cache is viewport-independent)
    let wMinX = Infinity, wMinY = Infinity, wMaxX = -Infinity, wMaxY = -Infinity;
    for (const [row, col] of fluidCells) {
      if (col * gridSize < wMinX) wMinX = col * gridSize;
      if (row * gridSize < wMinY) wMinY = row * gridSize;
      if ((col + 1) * gridSize > wMaxX) wMaxX = (col + 1) * gridSize;
      if ((row + 1) * gridSize > wMaxY) wMaxY = (row + 1) * gridSize;
    }
    const txMin = Math.floor(wMinX / tileWorld) - 1;
    const txMax = Math.ceil(wMaxX / tileWorld) + 1;
    const tyMin = Math.floor(wMinY / tileWorld) - 1;
    const tyMax = Math.ceil(wMaxY / tileWorld) + 1;

    // Collect world-space polygon data grouped by colour for batched fills.
    // Jitter quantized to 7 discrete levels → O(~21) colour groups regardless of tile count.
    const strokeData = []; // flat: [nv, x0, y0, x1, y1, ...]
    const fillBatches = new Map(); // colorKey -> [strokeData base indices]

    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const offX = tx * tileWorld;
        const offY = ty * tileWorld;
        const colMin = Math.max(0, Math.floor(offX / gridSize));
        const colMax = Math.min(numCols - 1, Math.floor((offX + tileWorld) / gridSize));
        const rowMin = Math.max(0, Math.floor(offY / gridSize));
        const rowMax = Math.min(numRows - 1, Math.floor((offY + tileWorld) / gridSize));
        if (colMin > colMax || rowMin > rowMax) continue;

        for (let r = rowMin; r <= rowMax; r++) {
          for (let col = colMin; col <= colMax; col++) {
            const key = r * numCols + col;
            if (!fluidSet.has(key)) continue;

            const depth = depthMap.get(key) ?? 1;
            const baseC = fluidColors[Math.min(depth, 3) - 1];

            const txl0 = (col * gridSize - offX) / patternScale;
            const txl1 = ((col + 1) * gridSize - offX) / patternScale;
            const tyl0 = (r * gridSize - offY) / patternScale;
            const tyl1 = ((r + 1) * gridSize - offY) / patternScale;
            const bxMin = Math.max(0, Math.floor(txl0 / binSize));
            const bxMax = Math.min(binCount - 1, Math.ceil(txl1 / binSize) - 1);
            const byMin = Math.max(0, Math.floor(tyl0 / binSize));
            const byMax = Math.min(binCount - 1, Math.ceil(tyl1 / binSize) - 1);
            if (bxMin > bxMax || byMin > byMax) continue;

            for (let by = byMin; by <= byMax; by++) {
              for (let bx = bxMin; bx <= bxMax; bx++) {
                for (const p of spatialBins[by * binCount + bx]) {
                  if (Math.floor((p.centre[0] * patternScale + offX) / gridSize) !== col) continue;
                  if (Math.floor((p.centre[1] * patternScale + offY) / gridSize) !== r) continue;

                  let js = ((r * 997 + col * 1009 + p.idx * 31) >>> 0) || 1;
                  js = (Math.imul(js, 1664525) + 1013904223) >>> 0;
                  const jitter = Math.round((js / 0x100000000 - 0.5) * 7) * 2;

                  const rv = Math.max(0, Math.min(255, Math.round(baseC[0] + jitter)));
                  const gv = Math.max(0, Math.min(255, Math.round(baseC[1] + jitter)));
                  const bv = Math.max(0, Math.min(255, Math.round(baseC[2] + jitter)));
                  const colorKey = (rv << 16) | (gv << 8) | bv;

                  // World-space vertices (no sc/offset multiplication)
                  const verts = p.verts;
                  const nv = verts.length;
                  const base = strokeData.length;
                  strokeData.push(nv);
                  for (let i = 0; i < nv; i++) {
                    strokeData.push(verts[i][0] * patternScale + offX, verts[i][1] * patternScale + offY);
                  }

                  let batch = fillBatches.get(colorKey);
                  if (!batch) { batch = []; fillBatches.set(colorKey, batch); }
                  batch.push(base);
                }
              }
            }
          }
        }
      }
    }

    // Build fills Map: interior base-fill rects first, then Voronoi polygons merged in
    const fills = new Map(); // colorKey -> Path2D

    // Interior cells (all 4 neighbours fluid): exact base colour, no jitter
    for (const [row, col] of fluidCells) {
      let isEdge = false;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (!fluidSet.has((row + dr) * numCols + (col + dc))) { isEdge = true; break; }
      }
      if (isEdge) continue;
      const depth = depthMap.get(row * numCols + col) ?? 1;
      const baseC = fluidColors[Math.min(depth, 3) - 1];
      const colorKey = (baseC[0] << 16) | (baseC[1] << 8) | baseC[2];
      let p = fills.get(colorKey);
      if (!p) { p = new Path2D(); fills.set(colorKey, p); }
      p.rect(col * gridSize, row * gridSize, gridSize, gridSize);
    }

    // Voronoi polygons merged into the same Map (same colorKey shares a Path2D)
    for (const [colorKey, bases] of fillBatches) {
      let path = fills.get(colorKey);
      if (!path) { path = new Path2D(); fills.set(colorKey, path); }
      for (const base of bases) {
        const nv = strokeData[base];
        path.moveTo(strokeData[base + 1], strokeData[base + 2]);
        for (let i = 1; i < nv; i++) {
          path.lineTo(strokeData[base + 1 + i * 2], strokeData[base + 2 + i * 2]);
        }
        path.closePath();
      }
    }

    // All-edges caustic stroke path
    const causticPath = new Path2D();
    let si = 0;
    while (si < strokeData.length) {
      const nv = strokeData[si++];
      causticPath.moveTo(strokeData[si], strokeData[si + 1]); si += 2;
      for (let j = 1; j < nv; j++) {
        causticPath.lineTo(strokeData[si], strokeData[si + 1]); si += 2;
      }
      causticPath.closePath();
    }

    return { clipPath, fills, causticPath, causticColor };
  }

  function buildForPit() {
    const { pitSet, pitCells, groups } = getCachedPitData(cells, roomCells);
    if (pitCells.length === 0) return null;

    const baseColor = toRgb(theme.pitBaseColor || PIT_DEFAULTS.base);
    const crackColor = theme.pitCrackColor || PIT_DEFAULTS.crack;
    const vignetteColor = theme.pitVignetteColor || PIT_DEFAULTS.vignette;

    // Wall-aware clip in world space — respects trim boundaries
    const clipPath = new Path2D();
    for (const [row, col] of pitCells) {
      const cell = cells[row][col];
      if (cell.trimClip && !cell.trimOpen) {
        const ox = col * gridSize, oy = row * gridSize;
        const clip = cell.trimClip;
        clipPath.moveTo(ox + clip[0][0] * gridSize, oy + clip[0][1] * gridSize);
        for (let i = 1; i < clip.length; i++)
          clipPath.lineTo(ox + clip[i][0] * gridSize, oy + clip[i][1] * gridSize);
        clipPath.closePath();
      } else {
        clipPath.rect(col * gridSize, row * gridSize, gridSize, gridSize);
      }
      for (const [dr, dc, dir] of bleedDirs) {
        const nr = row + dr, nc = col + dc;
        if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
        if (pitSet.has(nr * numCols + nc)) continue;
        if (cell[dir] === 'w' || cell[dir] === 'd') continue;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor) continue; // don't bleed into void cells (trimmed away)
        if (neighbor.trimClip && !neighbor.trimOpen) continue;
        clipPath.rect(nc * gridSize, nr * gridSize, gridSize, gridSize);
      }
    }

    // Bounding box
    let wMinX = Infinity, wMinY = Infinity, wMaxX = -Infinity, wMaxY = -Infinity;
    for (const [row, col] of pitCells) {
      if (col * gridSize < wMinX) wMinX = col * gridSize;
      if (row * gridSize < wMinY) wMinY = row * gridSize;
      if ((col + 1) * gridSize > wMaxX) wMaxX = (col + 1) * gridSize;
      if ((row + 1) * gridSize > wMaxY) wMaxY = (row + 1) * gridSize;
    }
    const txMin = Math.floor(wMinX / tileWorld) - 1;
    const txMax = Math.ceil(wMaxX / tileWorld) + 1;
    const tyMin = Math.floor(wMinY / tileWorld) - 1;
    const tyMax = Math.ceil(wMaxY / tileWorld) + 1;

    const strokeData = [];
    const fillBatches = new Map();

    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const offX = tx * tileWorld;
        const offY = ty * tileWorld;
        const colMin = Math.max(0, Math.floor(offX / gridSize));
        const colMax = Math.min(numCols - 1, Math.floor((offX + tileWorld) / gridSize));
        const rowMin = Math.max(0, Math.floor(offY / gridSize));
        const rowMax = Math.min(numRows - 1, Math.floor((offY + tileWorld) / gridSize));
        if (colMin > colMax || rowMin > rowMax) continue;

        for (let r = rowMin; r <= rowMax; r++) {
          for (let col = colMin; col <= colMax; col++) {
            if (!pitSet.has(r * numCols + col)) continue;

            const txl0 = (col * gridSize - offX) / patternScale;
            const txl1 = ((col + 1) * gridSize - offX) / patternScale;
            const tyl0 = (r * gridSize - offY) / patternScale;
            const tyl1 = ((r + 1) * gridSize - offY) / patternScale;
            const bxMin = Math.max(0, Math.floor(txl0 / binSize));
            const bxMax = Math.min(binCount - 1, Math.ceil(txl1 / binSize) - 1);
            const byMin = Math.max(0, Math.floor(tyl0 / binSize));
            const byMax = Math.min(binCount - 1, Math.ceil(tyl1 / binSize) - 1);
            if (bxMin > bxMax || byMin > byMax) continue;

            for (let by = byMin; by <= byMax; by++) {
              for (let bx = bxMin; bx <= bxMax; bx++) {
                for (const p of spatialBins[by * binCount + bx]) {
                  if (Math.floor((p.centre[0] * patternScale + offX) / gridSize) !== col) continue;
                  if (Math.floor((p.centre[1] * patternScale + offY) / gridSize) !== r) continue;

                  // Asymmetric jitter: biased darker for pit stone look.
                  // Quantized to 5 discrete levels to enable colour-batch rendering.
                  let js = ((r * 997 + col * 1009 + p.idx * 31) >>> 0) || 1;
                  js = (Math.imul(js, 1664525) + 1013904223) >>> 0;
                  const jitter = Math.round((js / 0x100000000 - 0.55) * 5) * (16 / 5);

                  const rv = Math.max(0, Math.min(255, Math.round(baseColor[0] + jitter)));
                  const gv = Math.max(0, Math.min(255, Math.round(baseColor[1] + jitter)));
                  const bv = Math.max(0, Math.min(255, Math.round(baseColor[2] + jitter)));
                  const colorKey = (rv << 16) | (gv << 8) | bv;

                  const verts = p.verts;
                  const nv = verts.length;
                  const base = strokeData.length;
                  strokeData.push(nv);
                  for (let i = 0; i < nv; i++) {
                    strokeData.push(verts[i][0] * patternScale + offX, verts[i][1] * patternScale + offY);
                  }

                  let batch = fillBatches.get(colorKey);
                  if (!batch) { batch = []; fillBatches.set(colorKey, batch); }
                  batch.push(base);
                }
              }
            }
          }
        }
      }
    }

    // Build fills Map: interior rects first, then Voronoi polygons
    const fills = new Map();
    for (const [row, col] of pitCells) {
      let isEdge = false;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (!pitSet.has((row + dr) * numCols + (col + dc))) { isEdge = true; break; }
      }
      if (isEdge) continue;
      const colorKey = (baseColor[0] << 16) | (baseColor[1] << 8) | baseColor[2];
      let p = fills.get(colorKey);
      if (!p) { p = new Path2D(); fills.set(colorKey, p); }
      p.rect(col * gridSize, row * gridSize, gridSize, gridSize);
    }

    for (const [colorKey, bases] of fillBatches) {
      let path = fills.get(colorKey);
      if (!path) { path = new Path2D(); fills.set(colorKey, path); }
      for (const base of bases) {
        const nv = strokeData[base];
        path.moveTo(strokeData[base + 1], strokeData[base + 2]);
        for (let i = 1; i < nv; i++) {
          path.lineTo(strokeData[base + 1 + i * 2], strokeData[base + 2 + i * 2]);
        }
        path.closePath();
      }
    }

    const cracksPath = new Path2D();
    let si = 0;
    while (si < strokeData.length) {
      const nv = strokeData[si++];
      cracksPath.moveTo(strokeData[si], strokeData[si + 1]); si += 2;
      for (let j = 1; j < nv; j++) {
        cracksPath.lineTo(strokeData[si], strokeData[si + 1]); si += 2;
      }
      cracksPath.closePath();
    }

    // Pre-compute vignette group data in world units (recreated per render since
    // createRadialGradient uses the active CTM at call time, not at gradient creation)
    const vignetteGroups = groups.map(group => {
      const gcx = group.reduce((sum, [, c]) => sum + (c + 0.5) * gridSize, 0) / group.length;
      const gcy = group.reduce((sum, [r]) => sum + (r + 0.5) * gridSize, 0) / group.length;
      let maxDistWorld = 0;
      for (const [r2, c2] of group) {
        for (const [cx, cy] of [[c2, r2], [c2 + 1, r2], [c2, r2 + 1], [c2 + 1, r2 + 1]]) {
          const d = Math.sqrt((cx * gridSize - gcx) ** 2 + (cy * gridSize - gcy) ** 2);
          if (d > maxDistWorld) maxDistWorld = d;
        }
      }
      return { gcx, gcy, maxDistWorld, cells: group };
    });

    return { clipPath, fills, cracksPath, crackColor, vignetteColor, vignetteGroups };
  }

  return {
    water: buildForFluid('water'),
    lava: buildForFluid('lava'),
    pit: buildForPit(),
  };
}

/**
 * Get or rebuild the world-space fluid Path2D geometry cache.
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme object with fluid color settings
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @returns {{ pit: Object|null, water: Object|null, lava: Object|null }} Cached fluid geometry data
 */
export function getFluidPathCache(cells, gridSize, theme, roomCells) {
  if (_fluidPathCache.cells === cells && _fluidPathCache.gridSize === gridSize && _fluidPathCache.theme === theme) {
    return _fluidPathCache.data;
  }
  const data = buildFluidGeometry(cells, gridSize, theme, roomCells);
  _fluidPathCache = { cells, gridSize, theme, data };
  return data;
}

/**
 * Return a pre-rendered offscreen canvas containing all fluid fills at cache resolution.
 * Returns null if there are no fluids. The canvas is cached and reused as long as the
 * fluid path cache is valid and dimensions match.
 *
 * Arc void clips are NOT applied here — the caller applies them when blitting this layer
 * onto the main cache canvas (avoids duplicating complex arc geometry code).
 * @param {Object} data - Fluid geometry data from getFluidPathCache
 * @param {number} gridSize - Grid cell size in feet
 * @param {number} cacheW - Cache canvas width in pixels
 * @param {number} cacheH - Cache canvas height in pixels
 * @param {number} [cacheScale=10] - Pixels per foot at cache resolution
 * @returns {HTMLCanvasElement|null} Pre-rendered fluid canvas, or null
 */
export function getRenderedFluidLayer(data, gridSize, cacheW, cacheH, cacheScale = 10) {
  if (!data.pit && !data.water && !data.lava) return null;

  // Return cached layer if still valid
  if (_fluidRenderLayer && _fluidRenderLayer.w === cacheW && _fluidRenderLayer.h === cacheH &&
      _fluidRenderLayer.pathCacheRef === _fluidPathCache) {
    return _fluidRenderLayer.canvas;
  }

  // Create or resize the offscreen canvas
  let offCanvas;
  if (_fluidRenderLayer && _fluidRenderLayer.canvas) {
    offCanvas = _fluidRenderLayer.canvas;
    if (offCanvas.width !== cacheW || offCanvas.height !== cacheH) {
      offCanvas.width = cacheW;
      offCanvas.height = cacheH;
    }
  } else {
    offCanvas = document.createElement('canvas');
    offCanvas.width = cacheW;
    offCanvas.height = cacheH;
  }

  const ctx = offCanvas.getContext('2d', { alpha: true });
  ctx.clearRect(0, 0, cacheW, cacheH);

  const sc = cacheScale;

  // World-space CTM — all cached Path2D coordinates are in world units
  ctx.setTransform(sc, 0, 0, sc, 0, 0);

  for (const fd of [data.pit, data.water, data.lava]) {
    if (!fd) continue;
    ctx.save();
    ctx.clip(fd.clipPath);

    // Batched fill pass
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

  _fluidRenderLayer = { canvas: offCanvas, w: cacheW, h: cacheH, pathCacheRef: _fluidPathCache, cacheScale, gridSize };
  return offCanvas;
}

/**
 * Return stored parameters from the current fluid path cache (or null if no cache).
 * @returns {{ gridSize: number, theme: Object }|null} Cached parameters, or null
 */
export function getFluidCacheParams() {
  if (!_fluidPathCache.data) return null;
  return { gridSize: _fluidPathCache.gridSize, theme: _fluidPathCache.theme };
}

/**
 * Call this whenever fluid/pit cell data is mutated in-place (same cells reference).
 * @returns {void}
 */
export function invalidateFluidCache() {
  _fluidPathCache  = { cells: null, gridSize: null, theme: null, data: null };
  _fluidCellsCache = { cells: null, water: null, lava: null };
  _pitDataCache    = { cells: null, pitSet: null, pitCells: null, groups: null, numCols: 0, numRows: 0 };
  _fluidRenderLayer = null;
}

/**
 * Incremental fluid update — rebuild geometry for just the dirty region and
 * re-render that area on the existing fluid layer canvas.
 *
 * @param {{ minRow: number, maxRow: number, minCol: number, maxCol: number }} region
 * @param {Array} cells  Current cell grid
 * @param {Array} roomCells  Room cell mask
 * @param {number} gridSize
 * @param {Object} theme - Theme object with fluid color settings
 * @returns {void}
 */
export function patchFluidRegion(region, cells, roomCells, gridSize, theme) {
  if (!_fluidRenderLayer || !_fluidRenderLayer.canvas) return;
  const { canvas, cacheScale: sc } = _fluidRenderLayer;
  if (!sc) return;

  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Clear area: 1 cell padding around dirty region (wipes bleed pixels)
  // Scan area: 2 cells padding (re-renders neighbors whose patterns bleed in)
  const CLEAR_PAD = 1;
  const SCAN_PAD = 2;
  const clearMinR = Math.max(0, region.minRow - CLEAR_PAD);
  const clearMaxR = Math.min(numRows - 1, region.maxRow + CLEAR_PAD);
  const clearMinC = Math.max(0, region.minCol - CLEAR_PAD);
  const clearMaxC = Math.min(numCols - 1, region.maxCol + CLEAR_PAD);
  const minR = Math.max(0, region.minRow - SCAN_PAD);
  const maxR = Math.min(numRows - 1, region.maxRow + SCAN_PAD);
  const minC = Math.max(0, region.minCol - SCAN_PAD);
  const maxC = Math.min(numCols - 1, region.maxCol + SCAN_PAD);

  // Clear the dirty region on the render layer
  const px = clearMinC * gridSize * sc;
  const py = clearMinR * gridSize * sc;
  const pw = (clearMaxC - clearMinC + 1) * gridSize * sc;
  const ph = (clearMaxR - clearMinR + 1) * gridSize * sc;
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(px, py, pw, ph);

  // Rebuild geometry for fluid cells in the dirty region and render them
  const tileWorld = gridSize * 8;
  const patternScale = tileWorld / WATER_TILE_SIZE;
  const { bins: spatialBins, N: binCount, binSize } = WATER_SPATIAL;
  const bleedDirs = [[-1, 0, 'north'], [1, 0, 'south'], [0, -1, 'west'], [0, 1, 'east']];

  const toRgb = h => {
    if (Array.isArray(h)) return h;
    const x = h.replace('#', '');
    return [parseInt(x.substring(0, 2), 16), parseInt(x.substring(2, 4), 16), parseInt(x.substring(4, 6), 16)];
  };

  // Clip rendering to the dirty region
  ctx.beginPath();
  ctx.rect(px, py, pw, ph);
  ctx.clip();
  ctx.setTransform(sc, 0, 0, sc, 0, 0);

  for (const fillType of ['pit', 'water', 'lava']) {
    // Collect fluid cells in the dirty region
    const depthKey = fillType + 'Depth';
    const fluidCells = [];
    const fluidSet = new Set();
    const depthMap = new Map();

    // Scan the dirty region for fluid cells
    for (let row = minR; row <= maxR; row++) {
      for (let col = minC; col <= maxC; col++) {
        const cell = cells[row]?.[col];
        if (cell?.fill === fillType && roomCells[row]?.[col]) {
          const key = row * numCols + col;
          fluidSet.add(key);
          fluidCells.push([row, col]);
          depthMap.set(key, cell[depthKey] ?? 1);
        }
      }
    }
    // Also collect immediate neighbors outside the region for edge detection
    for (let row = Math.max(0, minR - 1); row <= Math.min(numRows - 1, maxR + 1); row++) {
      for (let col = Math.max(0, minC - 1); col <= Math.min(numCols - 1, maxC + 1); col++) {
        if (row >= minR && row <= maxR && col >= minC && col <= maxC) continue;
        const cell = cells[row]?.[col];
        if (cell?.fill === fillType && roomCells[row]?.[col]) {
          fluidSet.add(row * numCols + col);
        }
      }
    }

    if (fluidCells.length === 0) continue;

    const isPit = fillType === 'pit';
    const defaults = isPit ? PIT_DEFAULTS : (FLUID_DEFAULTS[fillType] || FLUID_DEFAULTS.water);
    const fluidColors = isPit
      ? [toRgb(theme.pitBaseColor || defaults.base)]
      : [
          toRgb(theme[fillType + 'ShallowColor'] || defaults.shallow),
          toRgb(theme[fillType + 'MediumColor']  || defaults.medium),
          toRgb(theme[fillType + 'DeepColor']    || defaults.deep),
        ];

    // Build clip path for this region's cells — respects trim boundaries
    const clipPath = new Path2D();
    for (const [row, col] of fluidCells) {
      const cell = cells[row][col];
      if (cell.trimClip && !cell.trimOpen) {
        const ox = col * gridSize, oy = row * gridSize;
        const clip = cell.trimClip;
        clipPath.moveTo(ox + clip[0][0] * gridSize, oy + clip[0][1] * gridSize);
        for (let i = 1; i < clip.length; i++)
          clipPath.lineTo(ox + clip[i][0] * gridSize, oy + clip[i][1] * gridSize);
        clipPath.closePath();
      } else {
        clipPath.rect(col * gridSize, row * gridSize, gridSize, gridSize);
      }
      for (const [dr, dc, dir] of bleedDirs) {
        const nr = row + dr, nc = col + dc;
        if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
        if (fluidSet.has(nr * numCols + nc)) continue;
        if (cell[dir] === 'w' || cell[dir] === 'd') continue;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor) continue; // don't bleed into void cells (trimmed away)
        if (neighbor.trimClip && !neighbor.trimOpen) continue;
        clipPath.rect(nc * gridSize, nr * gridSize, gridSize, gridSize);
      }
    }

    ctx.save();
    ctx.clip(clipPath);

    // Interior cells: solid base fill
    for (const [row, col] of fluidCells) {
      let isEdge = false;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (!fluidSet.has((row + dr) * numCols + (col + dc))) { isEdge = true; break; }
      }
      if (isEdge) continue;
      const baseC = isPit ? fluidColors[0] : fluidColors[Math.min((depthMap.get(row * numCols + col) ?? 1), 3) - 1];
      ctx.fillStyle = `rgb(${baseC[0]},${baseC[1]},${baseC[2]})`;
      ctx.fillRect(col * gridSize, row * gridSize, gridSize, gridSize);
    }

    // Voronoi polygons for edge cells
    const txMin = Math.floor((minC * gridSize) / tileWorld) - 1;
    const txMax = Math.ceil(((maxC + 1) * gridSize) / tileWorld) + 1;
    const tyMin = Math.floor((minR * gridSize) / tileWorld) - 1;
    const tyMax = Math.ceil(((maxR + 1) * gridSize) / tileWorld) + 1;

    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const offX = tx * tileWorld;
        const offY = ty * tileWorld;
        const cMin = Math.max(minC, Math.floor(offX / gridSize));
        const cMax = Math.min(maxC, Math.floor((offX + tileWorld) / gridSize));
        const rMin2 = Math.max(minR, Math.floor(offY / gridSize));
        const rMax2 = Math.min(maxR, Math.floor((offY + tileWorld) / gridSize));
        if (cMin > cMax || rMin2 > rMax2) continue;

        for (let r = rMin2; r <= rMax2; r++) {
          for (let col = cMin; col <= cMax; col++) {
            const key = r * numCols + col;
            if (!fluidSet.has(key)) continue;

            const depth = depthMap.get(key) ?? 1;
            const baseC = isPit ? fluidColors[0] : fluidColors[Math.min(depth, 3) - 1];

            const txl0 = (col * gridSize - offX) / patternScale;
            const txl1 = ((col + 1) * gridSize - offX) / patternScale;
            const tyl0 = (r * gridSize - offY) / patternScale;
            const tyl1 = ((r + 1) * gridSize - offY) / patternScale;
            const bxMin = Math.max(0, Math.floor(txl0 / binSize));
            const bxMax = Math.min(binCount - 1, Math.ceil(txl1 / binSize) - 1);
            const byMin = Math.max(0, Math.floor(tyl0 / binSize));
            const byMax = Math.min(binCount - 1, Math.ceil(tyl1 / binSize) - 1);
            if (bxMin > bxMax || byMin > byMax) continue;

            for (let by = byMin; by <= byMax; by++) {
              for (let bx = bxMin; bx <= bxMax; bx++) {
                for (const p of spatialBins[by * binCount + bx]) {
                  if (Math.floor((p.centre[0] * patternScale + offX) / gridSize) !== col) continue;
                  if (Math.floor((p.centre[1] * patternScale + offY) / gridSize) !== r) continue;

                  let js = ((r * 997 + col * 1009 + p.idx * 31) >>> 0) || 1;
                  js = (Math.imul(js, 1664525) + 1013904223) >>> 0;
                  const jitter = Math.round((js / 0x100000000 - 0.5) * 7) * 2;

                  const rv = Math.max(0, Math.min(255, Math.round(baseC[0] + jitter)));
                  const gv = Math.max(0, Math.min(255, Math.round(baseC[1] + jitter)));
                  const bv = Math.max(0, Math.min(255, Math.round(baseC[2] + jitter)));

                  ctx.fillStyle = `rgb(${rv},${gv},${bv})`;
                  const verts = p.verts;
                  ctx.beginPath();
                  ctx.moveTo(verts[0][0] * patternScale + offX, verts[0][1] * patternScale + offY);
                  for (let i = 1; i < verts.length; i++) {
                    ctx.lineTo(verts[i][0] * patternScale + offX, verts[i][1] * patternScale + offY);
                  }
                  ctx.closePath();
                  ctx.fill();
                }
              }
            }
          }
        }
      }
    }

    // Caustic/crack stroke
    if (isPit) {
      const crackColor = theme.pitCrackColor || defaults.crack;
      ctx.strokeStyle = crackColor;
      ctx.lineWidth = Math.max(0.3 / sc, 0.06);
    } else {
      const causticColor = theme[fillType + 'CausticColor'] || defaults.caustic;
      ctx.strokeStyle = causticColor;
      ctx.lineWidth = Math.max(0.5 / sc, 0.09);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Re-stroke Voronoi edges for the dirty region
    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const offX = tx * tileWorld;
        const offY = ty * tileWorld;
        const cMin = Math.max(minC, Math.floor(offX / gridSize));
        const cMax = Math.min(maxC, Math.floor((offX + tileWorld) / gridSize));
        const rMin2 = Math.max(minR, Math.floor(offY / gridSize));
        const rMax2 = Math.min(maxR, Math.floor((offY + tileWorld) / gridSize));
        if (cMin > cMax || rMin2 > rMax2) continue;

        for (let r = rMin2; r <= rMax2; r++) {
          for (let col = cMin; col <= cMax; col++) {
            if (!fluidSet.has(r * numCols + col)) continue;

            const txl0 = (col * gridSize - offX) / patternScale;
            const txl1 = ((col + 1) * gridSize - offX) / patternScale;
            const tyl0 = (r * gridSize - offY) / patternScale;
            const tyl1 = ((r + 1) * gridSize - offY) / patternScale;
            const bxMin = Math.max(0, Math.floor(txl0 / binSize));
            const bxMax = Math.min(binCount - 1, Math.ceil(txl1 / binSize) - 1);
            const byMin = Math.max(0, Math.floor(tyl0 / binSize));
            const byMax = Math.min(binCount - 1, Math.ceil(tyl1 / binSize) - 1);
            if (bxMin > bxMax || byMin > byMax) continue;

            for (let by = byMin; by <= byMax; by++) {
              for (let bx = bxMin; bx <= bxMax; bx++) {
                for (const p of spatialBins[by * binCount + bx]) {
                  if (Math.floor((p.centre[0] * patternScale + offX) / gridSize) !== col) continue;
                  if (Math.floor((p.centre[1] * patternScale + offY) / gridSize) !== r) continue;
                  const verts = p.verts;
                  ctx.beginPath();
                  ctx.moveTo(verts[0][0] * patternScale + offX, verts[0][1] * patternScale + offY);
                  for (let i = 1; i < verts.length; i++) {
                    ctx.lineTo(verts[i][0] * patternScale + offX, verts[i][1] * patternScale + offY);
                  }
                  ctx.closePath();
                  ctx.stroke();
                }
              }
            }
          }
        }
      }
    }

    ctx.restore();
  }

  ctx.restore();
}
