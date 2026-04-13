import type { CellGrid, Theme, RenderTransform } from '../types.js';
import { scaleFactor } from './borders.js';
import { toCanvas } from './bounds.js';
import { GRID_SCALE } from './constants.js';
import { HATCH_TILE_SIZE, HATCH_PATTERNS, WATER_TILE_SIZE, WATER_SPATIAL } from './patterns.js';

/** Cache for hatch/rock Path2D geometry keyed by map state. */
interface PathCache {
  cells: CellGrid;
  gridSize: number;
  size: number;
  maxDist: number;
  path: Path2D;
}

/** Cache for outer shading Path2D geometry. */
interface ShadingCache {
  cells: CellGrid;
  gridSize: number;
  size: number;
  roughness: number;
  resolution: number;
  path: Path2D;
}

// ─── Constants ─────
const ROUGH_WALL_SPACING = 25;
const BUFFER_SHADING_DEPTH = 0.35;

// ── Seeded LCG PRNG ─────────────────────────────────────────────────────────
// Returns a function yielding deterministic floats 0..1 for a given integer seed.
/**
 * Create a seeded LCG PRNG returning deterministic floats 0..1.
 * @param {number} seed - Integer seed value
 * @returns {Function} Generator function returning floats in [0, 1)
 */
export function seededLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ── Hex → rgba helper ───────────────────────────────────────────────────────
function hexToRgba(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Wall Drop Shadow ─────────────────────────────────────────────────────────
// Draws a soft shadow offset below-right of all wall segments.
// Called BEFORE the actual wall stroke so the shadow sits under the wall.
/**
 * Draw soft drop shadows below-right of all wall segments.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Object>} wallSegments - Array of {x1, y1, x2, y2} wall segments in canvas pixels
 * @param {Object} theme - Theme with wallShadow config
 * @param {Object} transform - Transform with scale
 * @returns {void}
 */
export function drawWallShadow(
  ctx: CanvasRenderingContext2D,
  wallSegments: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  theme: Theme,
  transform: RenderTransform,
): void {
  if (!theme.wallShadow || wallSegments.length === 0) return;
  const s = scaleFactor(transform);
  const { color, blur, offsetX, offsetY } = theme.wallShadow;

  ctx.save();
  ctx.strokeStyle = theme.wallStroke;
  ctx.lineWidth = 6 * s;
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * s;
  ctx.shadowOffsetX = offsetX * s;
  ctx.shadowOffsetY = offsetY * s;

  ctx.beginPath();
  for (const seg of wallSegments) {
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
  }
  ctx.stroke();

  // Reset shadow state
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.restore();
}

// ── Rough Wall Lines ─────────────────────────────────────────────────────────
// Hand-drawn wall effect using smooth quadratic Bézier curves through sparse
// control points with small perpendicular offsets. Deterministic per-segment
// seeding prevents shimmer during pan/zoom.
/**
 * Draw hand-drawn rough wall lines using quadratic Bezier curves.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Object>} wallSegments - Array of wall segment objects with seed
 * @param {Object} theme - Theme with wallRoughness and wallStroke
 * @param {Object} transform - Transform with scale
 * @returns {void}
 */
export function drawRoughWalls(
  ctx: CanvasRenderingContext2D,
  wallSegments: Array<{ x1: number; y1: number; x2: number; y2: number; seed?: number }>,
  theme: Theme,
  transform: RenderTransform,
): void {
  const s = scaleFactor(transform);
  const amp = (theme.wallRoughness ?? 0) * s * 1.5;
  const spacing = ROUGH_WALL_SPACING; // pixels between control points

  ctx.strokeStyle = theme.wallStroke;
  ctx.lineWidth = 6 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  for (const seg of wallSegments) {
    const { x1, y1, x2, y2, seed } = seg;
    const rand = seededLcg(seed ?? 0);

    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;

    // Perpendicular unit vector
    const px = -dy / len;
    const py = dx / len;

    // Sparse control points with random perpendicular offsets
    const numCtrl = Math.max(1, Math.ceil(len / spacing));
    const pts = [{ x: x1, y: y1 }];
    for (let i = 1; i < numCtrl; i++) {
      const t = i / numCtrl;
      const offset = (rand() - 0.5) * 2 * amp;
      pts.push({
        x: x1 + dx * t + px * offset,
        y: y1 + dy * t + py * offset,
      });
    }
    pts.push({ x: x2, y: y2 });

    // Draw smooth curve through control points
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    if (pts.length === 2) {
      ctx.lineTo(pts[1]!.x, pts[1]!.y);
    } else {
      // Quadratic Bézier through midpoints for C1 continuity
      for (let i = 1; i < pts.length - 1; i++) {
        const xMid = (pts[i]!.x + pts[i + 1]!.x) / 2;
        const yMid = (pts[i]!.y + pts[i + 1]!.y) / 2;
        ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, xMid, yMid);
      }
      ctx.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
    }
  }

  ctx.stroke();
}

// ── BFS Distance Map ─────────────────────────────────────────────────────────
// Builds an 8-connected Chebyshev distance map from all room cells.
// dist[r][c] = 0 for room cells, 1–maxDist for adjacent non-room cells,
// Infinity beyond maxDist. Shared by both line hatching and rock shading.
//
// Cached by (cells, roomCells, maxDist) reference — cells/roomCells are the
// same object references across all pan/zoom frames and only replaced when the
// map is edited, so cache hits eliminate the BFS entirely during panning.
let _distMapCache: {
  cells: CellGrid | null;
  roomCells: boolean[][] | null;
  maxDist: number;
  dist: Float32Array[] | null;
} = { cells: null, roomCells: null, maxDist: -1, dist: null };

function buildDistMap(cells: CellGrid, roomCells: boolean[][], maxDist: number) {
  if (_distMapCache.cells === cells && _distMapCache.roomCells === roomCells && _distMapCache.maxDist === maxDist) {
    return _distMapCache.dist;
  }
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const dist = Array.from({ length: numRows }, () => new Float32Array(numCols).fill(Infinity));
  const queue = new Int32Array(numRows * numCols);
  let qHead = 0,
    qTail = 0;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (roomCells[r]![c]) {
        dist[r]![c] = 0;
        queue[qTail++] = r * numCols + c;
      }
    }
  }
  while (qHead < qTail) {
    const idx = queue[qHead++]!;
    const r = (idx / numCols) | 0;
    const c = idx % numCols;
    const nd = dist[r]![c]! + 1;
    if (nd > maxDist) continue;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr,
          nc = c + dc;
        if (nr >= 0 && nr < numRows && nc >= 0 && nc < numCols && dist[nr]![nc] === Infinity) {
          dist[nr]![nc] = nd;
          queue[qTail++] = nr * numCols + nc;
        }
      }
    }
  }
  _distMapCache = { cells, roomCells, maxDist, dist };
  return dist;
}

// ── Wall Hatching Path2D Cache ───────────────────────────────────────────────
// Caches Path2D geometry in world coordinates per distance bucket. The expensive
// pattern iteration + path construction runs once; each frame just sets the
// canvas transform and strokes the cached paths at screen resolution.
let _hatchCache: PathCache | null = null;

/**
 * Draw line hatching in void areas near room cells.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme with hatchOpacity, hatchStyle, hatchSize, hatchColor
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {void}
 */
export function drawHatching(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
): void {
  if (!theme.hatchOpacity) return;
  if (theme.hatchStyle === 'rocks') return;

  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  if (!numRows || !numCols) return;

  const MAX_DIST = Math.round((theme.hatchDistance ?? 1) * 2);
  const size = theme.hatchSize ?? 0.5;
  const color = theme.hatchColor ?? theme.wallStroke;
  const mapW = numCols * gridSize,
    mapH = numRows * gridSize;

  // Rebuild Path2D cache if map data or relevant theme params changed.
  // roomCells is derived from cells, so cells ref-equality is sufficient.
  const hc = _hatchCache;
  if (hc?.cells !== cells || hc.gridSize !== gridSize || hc.size !== size || hc.maxDist !== MAX_DIST) {
    const dist = buildDistMap(cells, roomCells, MAX_DIST);
    const tileWorld = gridSize * 2 * (1.5 + size * 3);
    const patternScale = tileWorld / HATCH_TILE_SIZE;

    const hatchPath = new Path2D();
    const txMax = Math.ceil(mapW / tileWorld);
    const tyMax = Math.ceil(mapH / tileWorld);

    for (let ty = -1; ty <= tyMax; ty++) {
      for (let tx = -1; tx <= txMax; tx++) {
        const offsetX = tx * tileWorld;
        const offsetY = ty * tileWorld;
        for (const p of HATCH_PATTERNS) {
          const cWorldX = p.centre[0]! * patternScale + offsetX;
          const cWorldY = p.centre[1]! * patternScale + offsetY;
          const cellCol = Math.floor(cWorldX / gridSize);
          const cellRow = Math.floor(cWorldY / gridSize);
          if (cellRow < 0 || cellRow >= numRows || cellCol < 0 || cellCol >= numCols) continue;
          const d = dist![cellRow]![cellCol]!;
          if (d > MAX_DIST) continue;
          for (const line of p.cellLines) {
            hatchPath.moveTo(line[0]![0]! * patternScale + offsetX, line[0]![1]! * patternScale + offsetY);
            hatchPath.lineTo(line[1]![0]! * patternScale + offsetX, line[1]![1]! * patternScale + offsetY);
          }
        }
      }
    }

    _hatchCache = { cells, gridSize, size, maxDist: MAX_DIST, path: hatchPath };
  }

  // Stroke cached Path2D objects at screen resolution
  ctx.save();
  const _h0 = toCanvas(0, 0, transform);
  const _h1 = toCanvas(mapW, mapH, transform);
  ctx.beginPath();
  ctx.rect(_h0.x, _h0.y, _h1.x - _h0.x, _h1.y - _h0.y);
  ctx.clip();
  ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5 / transform.scale, 1 / GRID_SCALE);
  ctx.lineCap = 'round';
  ctx.globalAlpha = theme.hatchOpacity;
  ctx.stroke(_hatchCache!.path);
  ctx.restore();
}

// ── Rock Shading Path2D Cache ────────────────────────────────────────────────
// Caches Path2D geometry in world coordinates. The expensive work (spatial index
// lookup, vertex transforms, path construction) is done once; each frame just
// sets the canvas transform and strokes the cached paths at screen resolution.
let _rockCache: PathCache | null = null;

/**
 * Draw rock shading (Voronoi-style) in void areas near room cells.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme with hatchOpacity, hatchStyle, hatchSize, hatchColor
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {void}
 */
export function drawRockShading(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
): void {
  if (!theme.hatchOpacity) return;
  if (theme.hatchStyle !== 'rocks' && theme.hatchStyle !== 'both') return;

  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  if (!numRows || !numCols) return;

  const MAX_DIST = Math.round((theme.hatchDistance ?? 1) * 2);
  const size = theme.hatchSize ?? 0.5;
  const color = (theme.hatchColor ?? theme.wallStroke) || '#000000';
  const mapW = numCols * gridSize,
    mapH = numRows * gridSize;

  // Rebuild Path2D cache if map data or relevant theme params changed.
  // roomCells is derived from cells, so cells ref-equality is sufficient.
  const rc = _rockCache;
  if (rc?.cells !== cells || rc.gridSize !== gridSize || rc.size !== size || rc.maxDist !== MAX_DIST) {
    const dist = buildDistMap(cells, roomCells, MAX_DIST);
    const tileWorld = gridSize * (8 + size * 8);
    const patternScale = tileWorld / WATER_TILE_SIZE;

    const rockPath = new Path2D();

    const { bins: spatialBins, N: binCount, binSize } = WATER_SPATIAL;
    const txMax = Math.ceil(mapW / tileWorld);
    const tyMax = Math.ceil(mapH / tileWorld);

    for (let ty = -1; ty <= tyMax; ty++) {
      for (let tx = -1; tx <= txMax; tx++) {
        const offsetX = tx * tileWorld;
        const offsetY = ty * tileWorld;
        const colMin = Math.max(0, Math.floor(offsetX / gridSize));
        const colMax = Math.min(numCols - 1, Math.floor((offsetX + tileWorld) / gridSize));
        const rowMin = Math.max(0, Math.floor(offsetY / gridSize));
        const rowMax = Math.min(numRows - 1, Math.floor((offsetY + tileWorld) / gridSize));
        if (colMin > colMax || rowMin > rowMax) continue;

        for (let r = rowMin; r <= rowMax; r++) {
          for (let col = colMin; col <= colMax; col++) {
            const d = dist![r]![col]!;
            if (d > MAX_DIST) continue;

            const txl0 = (col * gridSize - offsetX) / patternScale;
            const txl1 = ((col + 1) * gridSize - offsetX) / patternScale;
            const tyl0 = (r * gridSize - offsetY) / patternScale;
            const tyl1 = ((r + 1) * gridSize - offsetY) / patternScale;
            const bxMin = Math.max(0, Math.floor(txl0 / binSize));
            const bxMax = Math.min(binCount - 1, Math.ceil(txl1 / binSize) - 1);
            const byMin = Math.max(0, Math.floor(tyl0 / binSize));
            const byMax = Math.min(binCount - 1, Math.ceil(tyl1 / binSize) - 1);
            if (bxMin > bxMax || byMin > byMax) continue;

            for (let by = byMin; by <= byMax; by++) {
              for (let bx = bxMin; bx <= bxMax; bx++) {
                for (const p of spatialBins[by * binCount + bx]!) {
                  if (Math.floor((p.centre[0] * patternScale + offsetX) / gridSize) !== col) continue;
                  if (Math.floor((p.centre[1] * patternScale + offsetY) / gridSize) !== r) continue;
                  const verts = p.verts;
                  const wx0 = verts[0]![0]! * patternScale + offsetX;
                  const wy0 = verts[0]![1]! * patternScale + offsetY;
                  rockPath.moveTo(wx0, wy0);
                  for (let vi = 1; vi < verts.length; vi++) {
                    rockPath.lineTo(verts[vi]![0]! * patternScale + offsetX, verts[vi]![1]! * patternScale + offsetY);
                  }
                  rockPath.closePath();
                }
              }
            }
          }
        }
      }
    }

    _rockCache = { cells, gridSize, size, maxDist: MAX_DIST, path: rockPath };
  }

  // Stroke cached Path2D objects at screen resolution
  ctx.save();
  const _r0 = toCanvas(0, 0, transform);
  const _r1 = toCanvas(mapW, mapH, transform);
  ctx.beginPath();
  ctx.rect(_r0.x, _r0.y, _r1.x - _r0.x, _r1.y - _r0.y);
  ctx.clip();
  ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
  ctx.strokeStyle = color;
  ctx.lineWidth = (1.5 + size * 0.5) / GRID_SCALE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = theme.hatchOpacity;
  ctx.stroke(_rockCache!.path);
  ctx.restore();
}

// ── Outer Shading ────────────────────────────────────────────────────────────
// Draws a filled blob around the outside of the dungeon by placing a circle of
// radius (cellPx/2 + sizePx) on every room-cell centre and filling the union in
// one pass.  This Minkowski-sum approach gives naturally rounded outer edges at
// roughness = 0 (no seam artefacts) and organic jagged edges at higher roughness.
// The floor fills that follow paint over the room interior, leaving only the halo.
let _outerShadingCache: ShadingCache | null = null;

/**
 * Draw a filled Minkowski-sum blob around the outside of the dungeon for organic shading.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme with outerShading config (color, size, roughness)
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {number} [resolution=1] - Resolution multiplier for sub-cells
 * @returns {void}
 */
export function drawOuterShading(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  resolution: number = 1,
): void {
  if (!theme.outerShading?.color || !(theme.outerShading.size > 0)) return;

  const { color, size, roughness = 0 } = theme.outerShading;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const step = resolution;
  const displayGs = gridSize * step;

  // Rebuild Path2D cache if map data or shading params changed
  const oc = _outerShadingCache;
  if (
    oc?.cells !== cells ||
    oc.gridSize !== gridSize ||
    oc.size !== size ||
    oc.roughness !== roughness ||
    oc.resolution !== resolution
  ) {
    const path = new Path2D();
    const worldRadius = displayGs * (0.5 + size / 10);
    const roughAmp = roughness * 0.2 * displayGs;

    // Step by resolution — one arc per display cell, not per sub-cell
    for (let row = 0; row < numRows; row += step) {
      for (let col = 0; col < numCols; col += step) {
        // Check if any sub-cell is a room cell
        let isRoom = false;
        for (let dr = 0; dr < step && !isRoom; dr++)
          for (let dc = 0; dc < step && !isRoom; dc++) if (roomCells[row + dr]?.[col + dc]) isRoom = true;
        if (!isRoom) continue;

        const cx = (col + step * 0.5) * gridSize;
        const cy = (row + step * 0.5) * gridSize;

        let radius = worldRadius;
        if (roughAmp > 0) {
          const rand = seededLcg(row * 1337 + col * 7919 + 54321);
          radius += (rand() - 0.5) * 2 * roughAmp;
          if (radius <= 0) continue;
        }

        path.moveTo(cx + radius, cy);
        path.arc(cx, cy, radius, 0, Math.PI * 2);
      }
    }

    _outerShadingCache = { cells, gridSize, size, roughness, resolution, path };
  }

  // Fill cached path at screen resolution
  ctx.save();
  const _os0 = toCanvas(0, 0, transform);
  const _os1 = toCanvas(numCols * gridSize, numRows * gridSize, transform);
  ctx.beginPath();
  ctx.rect(_os0.x, _os0.y, _os1.x - _os0.x, _os1.y - _os0.y);
  ctx.clip();
  ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.offsetX, transform.offsetY);
  ctx.fillStyle = color;
  ctx.fill(_outerShadingCache!.path);
  ctx.restore();
}

// ── Buffer Shading (Inner AO) ────────────────────────────────────────────────
// Draws a dark gradient along the inside edges of room cells that border walls.
// Gives depth by simulating the shadow a wall casts onto the floor.
/**
 * Draw inner ambient occlusion gradients along room edges bordering walls.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme with bufferShadingOpacity and wallStroke
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {void}
 */
export function drawBufferShading(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
): void {
  if (!theme.bufferShadingOpacity) return;

  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const depthFraction = BUFFER_SHADING_DEPTH; // gradient extends 35% into the cell

  // Viewport culling: only process cells visible on screen
  const _bvx0 = -transform.offsetX / transform.scale;
  const _bvy0 = -transform.offsetY / transform.scale;
  const _bvx1 = (ctx.canvas.width - transform.offsetX) / transform.scale;
  const _bvy1 = (ctx.canvas.height - transform.offsetY) / transform.scale;
  const rowMin = Math.max(0, Math.floor(_bvy0 / gridSize) - 1);
  const rowMax = Math.min(numRows - 1, Math.ceil(_bvy1 / gridSize) + 1);
  const colMin = Math.max(0, Math.floor(_bvx0 / gridSize) - 1);
  const colMax = Math.min(numCols - 1, Math.ceil(_bvx1 / gridSize) + 1);

  ctx.save();
  ctx.globalAlpha = theme.bufferShadingOpacity;

  for (let row = rowMin; row <= rowMax; row++) {
    for (let col = colMin; col <= colMax; col++) {
      if (!roomCells[row]![col]) continue;
      const cell = cells[row]![col];
      if (!cell) continue;

      const p1 = toCanvas(col * gridSize, row * gridSize, transform);
      const p2 = toCanvas((col + 1) * gridSize, (row + 1) * gridSize, transform);
      const cellPx = p2.x - p1.x;
      const depthPx = cellPx * depthFraction;
      const darkColor = hexToRgba(theme.wallStroke, 0.5);
      const clearColor = hexToRgba(theme.wallStroke, 0);

      if (cell.north === 'w') {
        const grad = ctx.createLinearGradient(p1.x, p1.y, p1.x, p1.y + depthPx);
        grad.addColorStop(0, darkColor);
        grad.addColorStop(1, clearColor);
        ctx.fillStyle = grad;
        ctx.fillRect(p1.x, p1.y, cellPx, depthPx);
      }
      if (cell.south === 'w') {
        const grad = ctx.createLinearGradient(p1.x, p2.y, p1.x, p2.y - depthPx);
        grad.addColorStop(0, darkColor);
        grad.addColorStop(1, clearColor);
        ctx.fillStyle = grad;
        ctx.fillRect(p1.x, p2.y - depthPx, cellPx, depthPx);
      }
      if (cell.west === 'w') {
        const grad = ctx.createLinearGradient(p1.x, p1.y, p1.x + depthPx, p1.y);
        grad.addColorStop(0, darkColor);
        grad.addColorStop(1, clearColor);
        ctx.fillStyle = grad;
        ctx.fillRect(p1.x, p1.y, depthPx, cellPx);
      }
      if (cell.east === 'w') {
        const grad = ctx.createLinearGradient(p2.x, p1.y, p2.x - depthPx, p1.y);
        grad.addColorStop(0, darkColor);
        grad.addColorStop(1, clearColor);
        ctx.fillStyle = grad;
        ctx.fillRect(p2.x - depthPx, p1.y, depthPx, cellPx);
      }
    }
  }

  ctx.restore();
}

/**
 * Invalidate all geometry/shading caches in this module.
 * Call whenever cell structure changes in-place (rooms created/destroyed, walls added/removed).
 * @returns {void}
 */
export function invalidateEffectsCache(): void {
  _hatchCache = null;
  _rockCache = null;
  _outerShadingCache = null;
}
