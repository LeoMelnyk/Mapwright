import type {
  CardinalDirection,
  Cell,
  CellGrid,
  RenderTransform,
  TextureCatalog,
  TextureOptions,
  TextureRuntime,
} from '../types.js';

/** Height map extracted from a texture's displacement map. */
interface HeightMap {
  data: Float32Array;
  w: number;
  h: number;
  srcW: number;
  srcH: number;
}

/** Texture entry with loaded image for blend operations. */
interface TexEntry {
  img: HTMLImageElement & { naturalWidth: number; naturalHeight: number };
  dispImg?: HTMLImageElement | null;
  _heightMap?: Float32Array;
  _heightMapW?: number;
  _heightMapH?: number;
  _baseHeight?: number;
  _hmap?: HeightMap | null;
  [key: string]: unknown;
}

/** Texture catalog with resolved texture entries (extends the base TextureCatalog). */
interface BlendTextureCatalog extends TextureCatalog {
  textures: Record<string, TexEntry | undefined>;
}

/** A blend edge descriptor. */
interface BlendEdge {
  row: number;
  col: number;
  direction: string;
  neighborEntry: TexEntry;
  neighborOpacity: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  clipPath: Path2D;
  bitmap: ImageBitmap | null;
}

/** A blend corner descriptor. */
interface BlendCorner {
  row: number;
  col: number;
  corner: string;
  neighborEntry: TexEntry;
  neighborOpacity: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  clipPath: Path2D;
  localCX: number;
  localCY: number;
  bitmap: ImageBitmap | null;
}

/** Module-level topo cache (nullable fields for initial empty state). */
interface BlendTopoCacheState {
  cells: CellGrid | null;
  gridSize: number | null;
  blendWidth: number | null;
  catalog: BlendTextureCatalog | null;
  texturesVersion: number;
  edges: BlendEdge[] | null;
  corners: BlendCorner[] | null;
}
import {
  CARDINAL_DIRS,
  OPPOSITE,
  isEdgeOpen,
  getSegments,
  segmentIndexOnBorder,
  segmentIndexAtCorner,
  cellHasChordEdge,
  log,
} from '../util/index.js';

type CornerKey = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Read the texture of the segment that borders the given cardinal side of
 * the cell. For unsplit cells this is the cell's only texture; for diagonal
 * cells it picks the half that actually faces that side, so a diagonal
 * wall doesn't bleed the opposite half's texture across to the neighbor.
 */
function cellTextureOnSide(cell: Cell | null | undefined, side: CardinalDirection): string | undefined {
  if (!cell) return undefined;
  return getSegments(cell)[segmentIndexOnBorder(cell, side)]?.texture;
}

function cellTextureOpacityOnSide(cell: Cell | null | undefined, side: CardinalDirection): number | undefined {
  if (!cell) return undefined;
  return getSegments(cell)[segmentIndexOnBorder(cell, side)]?.textureOpacity;
}

/**
 * Read the texture of the segment containing the given corner of the cell.
 * Returns `undefined` when the corner sits on an interior wall (between two
 * segments — e.g. the endpoints of a diagonal wall) so the caller skips
 * the corner blend rather than picking an arbitrary half.
 */
function cellTextureAtCorner(cell: Cell | null | undefined, corner: CornerKey): string | undefined {
  if (!cell) return undefined;
  const idx = segmentIndexAtCorner(cell, corner);
  if (idx === null) return undefined;
  return getSegments(cell)[idx]?.texture;
}

function cellTextureOpacityAtCorner(cell: Cell | null | undefined, corner: CornerKey): number | undefined {
  if (!cell) return undefined;
  const idx = segmentIndexAtCorner(cell, corner);
  if (idx === null) return undefined;
  return getSegments(cell)[idx]?.textureOpacity;
}

// ── Texture blend topology cache ──────────────────────────────────────────────
// Pre-computes edge/corner blend descriptors and world-space Path2D clip polygons.
// Keyed on (cells, gridSize, blendWidth, catalog). On pan/zoom only the
// scratch-canvas pixel work runs per frame — topology + geometry are reused.
let _blendTopoCache: BlendTopoCacheState = {
  cells: null,
  gridSize: null,
  blendWidth: null,
  catalog: null,
  texturesVersion: 0,
  edges: null,
  corners: null,
};

// ── Renderer-specific constants ───────────────────────────────────────────────
/** @type {number} Fallback opacity for blend edges in PDF rendering */
export const PDF_EDGE_FALLBACK_OPACITY = 0.6;
/** @type {number} Fallback opacity for blend corners in PDF rendering */
export const PDF_CORNER_FALLBACK_OPACITY = 0.5;

// ── Blend bitmap cache (Level 1) ─────────────────────────────────────────────
// Fixed resolution for pre-rendered gradient-masked texture tiles.
// Each ImageBitmap is zoom-independent and stored on the descriptor.
const BLEND_BITMAP_SIZE = 128;
export { BLEND_BITMAP_SIZE };

/**
 * Returns the source rect {srcX, srcY, srcW, srcH} for a drawImage call that
 * samples a 256×256 chunk of the texture for world cell (row, col).
 * Different cells get different chunks — the visual repeat period is
 * (imgWidth/256) × (imgHeight/256) cells, so a 2K image repeats every 64 cells.
 */
/**
 * Returns the source rect for a drawImage call that samples a 256x256 chunk of a texture.
 * @param {Object} entry - Texture catalog entry with img property
 * @param {number} row - Cell row for chunk selection
 * @param {number} col - Cell column for chunk selection
 * @returns {{ srcX: number, srcY: number, srcW: number, srcH: number }} Source rectangle
 */
export function getTexChunk(
  entry: TexEntry | TextureRuntime,
  row: number,
  col: number,
): { srcX: number; srcY: number; srcW: number; srcH: number } {
  const img = entry.img!;
  const chunkSize = 256;
  const cw = Math.max(1, Math.floor(img.naturalWidth / chunkSize));
  const ch = Math.max(1, Math.floor(img.naturalHeight / chunkSize));
  const srcW = Math.floor(img.naturalWidth / cw);
  const srcH = Math.floor(img.naturalHeight / ch);
  return {
    srcX: (((col % cw) + cw) % cw) * srcW,
    srcY: (((row % ch) + ch) % ch) * srcH,
    srcW,
    srcH,
  };
}

// ── Height-based texture splatting ───────────────────────────────────────────
// Technique: extract a downsampled luminance map from each texture image (once),
// then sample the facing edges of adjacent chunks to compute an organic blend
// boundary driven by the splatting formula from:
// https://www.gamedeveloper.com/programming/advanced-terrain-texture-splatting

const HMAP_SCALE = 8; // sample at 1/8 native resolution
const N_SAMPLES = 16; // polygon points along each blend edge
const SPLAT_DEPTH = 0.2; // smoothing zone (from the splatting article)

/**
 * Compute how far a neighbor texture penetrates into the current cell
 * using the height-based splatting formula.
 * @param {number} hCurrent - Height sample from current texture (0-1)
 * @param {number} hNeighbor - Height sample from neighbor texture (0-1)
 * @param {number} blendPx - Maximum blend distance in pixels
 * @returns {number} Penetration depth in pixels
 */
function splatPenetration(hCurrent: number, hNeighbor: number, blendPx: number) {
  const cc = hCurrent + 0.5,
    cn = hNeighbor + 0.5;
  const ma = Math.max(cc, cn) - SPLAT_DEPTH;
  const b1 = Math.max(cc - ma, 0);
  const b2 = Math.max(cn - ma, 0);
  return blendPx * (b1 + b2 > 0 ? b2 / (b1 + b2) : 0.5);
}

/**
 * Compute a scalar base height (0–1) from the texture's displacement map.
 * Higher value = physically taller / harder material (e.g. raised cobblestone > flat dirt).
 * Used to determine blend direction: the harder cell accepts the soft fade, never the reverse.
 * Result is cached on entry._baseHeight. Returns 0.5 if the displacement map is unavailable.
 */
function computeBaseHeight(entry: TexEntry): number {
  if (entry._baseHeight !== undefined) return entry._baseHeight;
  if (typeof OffscreenCanvas === 'undefined') {
    entry._baseHeight = 0.5;
    return 0.5;
  }
  if (!entry.dispImg?.complete || !entry.dispImg.naturalWidth) {
    // Don't cache if the image exists but hasn't loaded yet — will recompute next render
    if (entry.dispImg && !entry.dispImg.complete) return 0.5;
    entry._baseHeight = 0.5;
    return 0.5;
  }
  const sz = 64;
  const oc = new OffscreenCanvas(sz, sz);
  const octx = oc.getContext('2d');
  octx!.drawImage(entry.dispImg, 0, 0, sz, sz);
  try {
    const px = octx!.getImageData(0, 0, sz, sz).data;
    let sum = 0;
    for (let i = 0; i < sz * sz; i++)
      sum += (px[i * 4]! * 0.299 + px[i * 4 + 1]! * 0.587 + px[i * 4 + 2]! * 0.114) / 255;
    entry._baseHeight = sum / (sz * sz);
  } catch {
    entry._baseHeight = 0.5;
  }
  return entry._baseHeight;
}

/**
 * Lazily extract a 1/8-scale height grid from the displacement map.
 * Uses the displacement map (physical surface height) rather than diffuse luminance,
 * since diffuse brightness doesn't correlate with height (e.g. bright snow is soft,
 * dark stone can be hard). Falls back to diffuse if no displacement is available.
 * Cached on entry._hmap. Returns null in environments without OffscreenCanvas
 * (Node.js PDF renderer), which gracefully degrades to a uniform blend.
 */
function extractHeightMap(entry: TexEntry) {
  if ('_hmap' in entry) return entry._hmap;
  if (typeof OffscreenCanvas === 'undefined') {
    entry._hmap = null;
    return null;
  }

  // Prefer displacement map; fall back to diffuse if unavailable
  const img = entry.dispImg?.complete && entry.dispImg.naturalWidth ? entry.dispImg : entry.img;
  // Don't cache if image hasn't loaded yet — will recompute next render
  if (!img.complete || !img.naturalWidth) return null;
  const w = Math.max(1, Math.floor(img.naturalWidth / HMAP_SCALE));
  const h = Math.max(1, Math.floor(img.naturalHeight / HMAP_SCALE));
  const oc = new OffscreenCanvas(w, h);
  const octx = oc.getContext('2d');
  octx!.drawImage(img, 0, 0, w, h);
  try {
    const px = octx!.getImageData(0, 0, w, h).data;
    const hmap = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++)
      hmap[i] = (px[i * 4]! * 0.299 + px[i * 4 + 1]! * 0.587 + px[i * 4 + 2]! * 0.114) / 255;
    entry._hmap = { data: hmap, w, h, srcW: img.naturalWidth, srcH: img.naturalHeight };
  } catch {
    entry._hmap = null;
  }
  return entry._hmap;
}

/**
 * Sample N_SAMPLES height values along one edge of the cell's texture chunk.
 * edgeDir is which edge of this chunk faces the neighbor
 * ('north' = top row, 'south' = bottom row, 'west' = left col, 'east' = right col).
 * Returns null if hmap unavailable (fallback: treat all heights as 0.5).
 */
function sampleEdgeHeights(entry: TexEntry, row: number, col: number, edgeDir: string) {
  const hmap = extractHeightMap(entry);
  if (!hmap) return null;
  // Map chunk coordinates (in diffuse space) to hmap space using the hmap's source dimensions
  const { srcX, srcY, srcW, srcH } = getTexChunk(entry, row, col);
  const hmX = Math.floor((srcX / hmap.srcW) * hmap.w);
  const hmY = Math.floor((srcY / hmap.srcH) * hmap.h);
  const hmW = Math.max(1, Math.floor((srcW / hmap.srcW) * hmap.w));
  const hmH = Math.max(1, Math.floor((srcH / hmap.srcH) * hmap.h));

  const out = new Float32Array(N_SAMPLES);
  for (let i = 0; i < N_SAMPLES; i++) {
    const t = i / (N_SAMPLES - 1);
    let hx = 0,
      hy = 0;
    switch (edgeDir) {
      case 'north':
        hx = hmX + Math.round(t * (hmW - 1));
        hy = hmY;
        break;
      case 'south':
        hx = hmX + Math.round(t * (hmW - 1));
        hy = hmY + hmH - 1;
        break;
      case 'west':
        hx = hmX;
        hy = hmY + Math.round(t * (hmH - 1));
        break;
      case 'east':
        hx = hmX + hmW - 1;
        hy = hmY + Math.round(t * (hmH - 1));
        break;
    }
    out[i] = hmap.data[Math.min(hy, hmap.h - 1) * hmap.w + Math.min(hx, hmap.w - 1)]!;
  }
  return out;
}

/**
 * Sample a single height value from the height map at a cell-local position.
 * (localX, localY) are in [0..cellPx] coordinates within the cell.
 * Returns 0.5 if height map is unavailable.
 */
function sampleHeightAtPoint(
  entry: TexEntry,
  row: number,
  col: number,
  localX: number,
  localY: number,
  cellPx: number,
) {
  const hmap = extractHeightMap(entry);
  if (!hmap) return 0.5;
  const { srcX, srcY, srcW, srcH } = getTexChunk(entry, row, col);
  const imgX = srcX + (localX / cellPx) * srcW;
  const imgY = srcY + (localY / cellPx) * srcH;
  const hmX = Math.max(0, Math.min(hmap.w - 1, Math.floor((imgX / hmap.srcW) * hmap.w)));
  const hmY = Math.max(0, Math.min(hmap.h - 1, Math.floor((imgY / hmap.srcH) * hmap.h)));
  return hmap.data[hmY * hmap.w + hmX]!;
}

// Scratch OffscreenCanvas for blending — destination-out gradient applied here so it
// never punches holes through the main canvas's existing dungeon content.
let blendScratch: OffscreenCanvas | null = null;
let blendScratchPx = 0;

/**
 * Get or create a scratch OffscreenCanvas for blend gradient masking.
 * @param {number} px - Required canvas size in pixels
 * @returns {OffscreenCanvas|null} Scratch canvas, or null if OffscreenCanvas unavailable
 */
export function getBlendScratch(px: number): OffscreenCanvas | null {
  const p = Math.ceil(px);
  if (!blendScratch) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    blendScratch = new OffscreenCanvas(p, p);
    blendScratchPx = p;
  } else if (blendScratchPx < p) {
    blendScratch.width = p;
    blendScratch.height = p;
    blendScratchPx = p;
  }
  return blendScratch;
}

// ── L1 Bitmap cache builders ────────────────────────────────────────────────

/** Close all ImageBitmaps in a topo cache to free GPU memory. */
function closeBlendBitmaps(cache: BlendTopoCacheState) {
  if (cache.edges) {
    for (const edge of cache.edges) {
      if (edge.bitmap) {
        edge.bitmap.close();
        edge.bitmap = null;
      }
    }
  }
  if (cache.corners) {
    for (const corner of cache.corners) {
      if (corner.bitmap) {
        corner.bitmap.close();
        corner.bitmap = null;
      }
    }
  }
}

/**
 * Pre-render all edge/corner blend tiles to ImageBitmaps at BLEND_BITMAP_SIZE resolution.
 * Uses the shared scratch OffscreenCanvas + transferToImageBitmap() for each descriptor.
 * Skipped entirely in Node.js (PDF path, no OffscreenCanvas).
 */
function buildBlendBitmaps(edges: BlendEdge[], corners: BlendCorner[], gridSize: number, blendWidth: number) {
  if (typeof OffscreenCanvas === 'undefined') return;

  const sz = BLEND_BITMAP_SIZE;
  const blendPx = blendWidth * sz;
  const scratch = getBlendScratch(sz);
  if (!scratch) return;
  const sctx = scratch.getContext('2d')!;

  // ── Edge bitmaps ──
  for (const edge of edges) {
    sctx.clearRect(0, 0, sz, sz);
    sctx.globalCompositeOperation = 'source-over';
    sctx.drawImage(edge.neighborEntry.img, edge.srcX, edge.srcY, edge.srcW, edge.srcH, 0, 0, sz, sz);

    let sg: CanvasGradient;
    switch (edge.direction) {
      case 'north':
        sg = sctx.createLinearGradient(0, 0, 0, blendPx);
        break;
      case 'south':
        sg = sctx.createLinearGradient(0, sz, 0, sz - blendPx);
        break;
      case 'west':
        sg = sctx.createLinearGradient(0, 0, blendPx, 0);
        break;
      default:
        sg = sctx.createLinearGradient(sz, 0, sz - blendPx, 0);
        break;
    }
    sg.addColorStop(0, 'rgba(0,0,0,0)');
    sg.addColorStop(1, 'rgba(0,0,0,1)');
    sctx.globalCompositeOperation = 'destination-out';
    sctx.fillStyle = sg;
    sctx.fillRect(0, 0, sz, sz);

    try {
      edge.bitmap = scratch.transferToImageBitmap();
    } catch {
      edge.bitmap = null;
    }
  }

  // ── Corner bitmaps ──
  for (const cn of corners) {
    sctx.clearRect(0, 0, sz, sz);
    sctx.globalCompositeOperation = 'source-over';
    sctx.drawImage(cn.neighborEntry.img, cn.srcX, cn.srcY, cn.srcW, cn.srcH, 0, 0, sz, sz);

    const scratchCX = (cn.localCX / gridSize) * sz;
    const scratchCY = (cn.localCY / gridSize) * sz;
    const sg = sctx.createRadialGradient(scratchCX, scratchCY, 0, scratchCX, scratchCY, blendPx);
    sg.addColorStop(0, 'rgba(0,0,0,0)');
    sg.addColorStop(1, 'rgba(0,0,0,1)');
    sctx.globalCompositeOperation = 'destination-out';
    sctx.fillStyle = sg;
    sctx.fillRect(0, 0, sz, sz);

    try {
      cn.bitmap = scratch.transferToImageBitmap();
    } catch {
      cn.bitmap = null;
    }
  }
}

// ── Offscreen map cache blend layer ─────────────────────────────────────────
// Pre-rendered blend layer at cache resolution. Persists across map cache
// rebuilds as long as the blend topology hasn't changed. Separate from the
// viewport L2 layer so they don't invalidate each other.
let _blendCacheLayer: {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  w: number;
  h: number;
  topoRef: BlendEdge[];
} | null = null;

/**
 * Return a pre-rendered blend layer for the offscreen map cache.
 * Returns null if no bitmaps are ready or in Node.js (PDF path).
 * @param {Object} topo - Blend topology cache with edges and corners
 * @param {number} gridSize - Grid cell size in feet
 * @param {number} cacheW - Cache canvas width in pixels
 * @param {number} cacheH - Cache canvas height in pixels
 * @param {number} [cacheScale=10] - Pixels per foot at cache resolution
 * @returns {HTMLCanvasElement|OffscreenCanvas|null} Pre-rendered blend canvas, or null
 */
export function getRenderedBlendLayer(
  topo: BlendTopoCacheState,
  gridSize: number,
  cacheW: number,
  cacheH: number,
  cacheScale: number = 10,
): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  if (!topo.edges?.length && !topo.corners?.length) return null;
  const edges = topo.edges!;
  const corners = topo.corners!;
  if (!edges.every((e: BlendEdge) => e.bitmap) || !corners.every((c: BlendCorner) => c.bitmap)) return null;

  // Return cached layer if still valid
  if (_blendCacheLayer?.w === cacheW && _blendCacheLayer.h === cacheH && _blendCacheLayer.topoRef === topo.edges) {
    return _blendCacheLayer.canvas;
  }

  // Build the layer at cache resolution
  const sc = cacheScale;
  const ox = 0,
    oy = 0;
  const cellPx = gridSize * sc;
  const sz = BLEND_BITMAP_SIZE;

  let offCanvas;
  if (_blendCacheLayer?.canvas) {
    offCanvas = _blendCacheLayer.canvas;
    if (offCanvas.width !== cacheW || offCanvas.height !== cacheH) {
      offCanvas = new OffscreenCanvas(cacheW, cacheH);
    }
  } else {
    offCanvas = new OffscreenCanvas(cacheW, cacheH);
  }

  const lctx = offCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  lctx.clearRect(0, 0, cacheW, cacheH);

  for (const edge of edges) {
    if (!edge.bitmap) continue;
    const screenX = edge.col * gridSize * sc + ox;
    const screenY = edge.row * gridSize * sc + oy;
    const cpx = Math.ceil(cellPx);
    lctx.save();
    lctx.setTransform(sc, 0, 0, sc, ox, oy);
    lctx.clip(edge.clipPath);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = edge.neighborOpacity;
    lctx.drawImage(edge.bitmap, 0, 0, sz, sz, screenX, screenY, cpx, cpx);
    lctx.restore();
  }

  for (const cn of corners) {
    if (!cn.bitmap) continue;
    const screenX = cn.col * gridSize * sc + ox;
    const screenY = cn.row * gridSize * sc + oy;
    const cpx = Math.ceil(cellPx);
    lctx.save();
    lctx.setTransform(sc, 0, 0, sc, ox, oy);
    lctx.clip(cn.clipPath);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = cn.neighborOpacity;
    lctx.drawImage(cn.bitmap, 0, 0, sz, sz, screenX, screenY, cpx, cpx);
    lctx.restore();
  }

  _blendCacheLayer = { canvas: offCanvas, w: cacheW, h: cacheH, topoRef: edges };
  return offCanvas;
}

// ── L2 Viewport blend layer ─────────────────────────────────────────────────
// A single OffscreenCanvas compositing all visible blended tiles at screen resolution.
// Valid as long as transform + canvas dimensions + topology haven't changed.

let _blendLayer: OffscreenCanvas | null = null;
let _blendLayerValid = false;
let _blendLayerOx = 0;
let _blendLayerOy = 0;
let _blendLayerSc = 0;
let _blendLayerW = 0;
let _blendLayerH = 0;
let _blendLayerTopoRef: BlendEdge[] | null = null;

function invalidateViewportBlendLayer() {
  _blendLayerValid = false;
}

/**
 * Returns the cached viewport blend layer, rebuilding it if the camera or topology changed.
 * Returns null in Node.js (PDF path).
 * @param {number} canvasW - Canvas width in pixels
 * @param {number} canvasH - Canvas height in pixels
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {Object} topo - Blend topology cache with edges and corners
 * @param {number} gridSize - Grid cell size in feet
 * @returns {OffscreenCanvas|null} Viewport blend canvas, or null
 */
export function getViewportBlendLayer(
  canvasW: number,
  canvasH: number,
  transform: RenderTransform,
  topo: BlendTopoCacheState,
  gridSize: number,
): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas === 'undefined') return null;

  // Check L2 validity
  if (
    _blendLayerValid &&
    _blendLayerOx === transform.offsetX &&
    _blendLayerOy === transform.offsetY &&
    _blendLayerSc === transform.scale &&
    _blendLayerW === canvasW &&
    _blendLayerH === canvasH &&
    _blendLayerTopoRef === topo.edges
  ) {
    return _blendLayer;
  }

  // (Re)create layer canvas if size changed
  if (!_blendLayer || _blendLayerW !== canvasW || _blendLayerH !== canvasH) {
    _blendLayer = new OffscreenCanvas(canvasW, canvasH);
  }

  // Rebuild from L1 bitmaps
  const lctx = _blendLayer.getContext('2d') as OffscreenCanvasRenderingContext2D;
  lctx.clearRect(0, 0, canvasW, canvasH);

  const { scale: sc, offsetX: ox, offsetY: oy } = transform;
  const cellPx = gridSize * sc;
  const sz = BLEND_BITMAP_SIZE;

  // Viewport culling bounds (world coords)
  const rowMin = Math.floor(-oy / sc / gridSize) - 2;
  const rowMax = Math.ceil((canvasH - oy) / sc / gridSize) + 2;
  const colMin = Math.floor(-ox / sc / gridSize) - 2;
  const colMax = Math.ceil((canvasW - ox) / sc / gridSize) + 2;

  // Edge pass
  for (const edge of topo.edges!) {
    if (edge.row < rowMin || edge.row > rowMax || edge.col < colMin || edge.col > colMax) continue;
    if (!edge.bitmap) continue;

    const screenX = edge.col * gridSize * sc + ox;
    const screenY = edge.row * gridSize * sc + oy;
    const cpx = Math.ceil(cellPx);

    lctx.save();
    lctx.setTransform(sc, 0, 0, sc, ox, oy);
    lctx.clip(edge.clipPath);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = edge.neighborOpacity;
    lctx.drawImage(edge.bitmap, 0, 0, sz, sz, screenX, screenY, cpx, cpx);
    lctx.restore();
  }

  // Corner pass
  for (const cn of topo.corners!) {
    if (cn.row < rowMin || cn.row > rowMax || cn.col < colMin || cn.col > colMax) continue;
    if (!cn.bitmap) continue;

    const screenX = cn.col * gridSize * sc + ox;
    const screenY = cn.row * gridSize * sc + oy;
    const cpx = Math.ceil(cellPx);

    lctx.save();
    lctx.setTransform(sc, 0, 0, sc, ox, oy);
    lctx.clip(cn.clipPath);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalAlpha = cn.neighborOpacity;
    lctx.drawImage(cn.bitmap, 0, 0, sz, sz, screenX, screenY, cpx, cpx);
    lctx.restore();
  }

  // Update validity
  _blendLayerValid = true;
  _blendLayerOx = transform.offsetX;
  _blendLayerOy = transform.offsetY;
  _blendLayerSc = transform.scale;
  _blendLayerW = canvasW;
  _blendLayerH = canvasH;
  _blendLayerTopoRef = topo.edges;

  return _blendLayer;
}

// ── Blend topology builder ────────────────────────────────────────────────────
// Scans all cells (no viewport culling) and pre-computes edge/corner descriptors
// with world-coordinate Path2D clip polygons. This runs once when cells change;
// the per-frame render loop only does scratch-canvas pixel work + clip composite.

const CORNER_DIRS: readonly {
  dr1: number;
  dc1: number;
  dr2: number;
  dc2: number;
  corner: CornerKey;
  dir1: CardinalDirection;
  dir2: CardinalDirection;
  // The corner of each participating neighbor that meets `corner` of the
  // current cell. n1Corner is on the dir1 neighbor, n2Corner on the dir2
  // neighbor, diagCorner on the diagonal-across cell. Used so segment-aware
  // texture lookups query the half of each neighbor that actually faces
  // this corner.
  n1Corner: CornerKey;
  n2Corner: CornerKey;
  diagCorner: CornerKey;
}[] = [
  {
    dr1: -1,
    dc1: 0,
    dr2: 0,
    dc2: -1,
    corner: 'nw',
    dir1: 'north',
    dir2: 'west',
    n1Corner: 'sw',
    n2Corner: 'ne',
    diagCorner: 'se',
  },
  {
    dr1: -1,
    dc1: 0,
    dr2: 0,
    dc2: 1,
    corner: 'ne',
    dir1: 'north',
    dir2: 'east',
    n1Corner: 'se',
    n2Corner: 'nw',
    diagCorner: 'sw',
  },
  {
    dr1: 1,
    dc1: 0,
    dr2: 0,
    dc2: -1,
    corner: 'sw',
    dir1: 'south',
    dir2: 'west',
    n1Corner: 'nw',
    n2Corner: 'se',
    diagCorner: 'ne',
  },
  {
    dr1: 1,
    dc1: 0,
    dr2: 0,
    dc2: 1,
    corner: 'se',
    dir1: 'south',
    dir2: 'east',
    n1Corner: 'ne',
    n2Corner: 'sw',
    diagCorner: 'nw',
  },
];

function buildBlendTopology(cells: CellGrid, roomCells: boolean[][], gridSize: number, textureOptions: TextureOptions) {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const blendWidth = textureOptions.blendWidth;
  const catalog = textureOptions.catalog as BlendTextureCatalog;
  const blendWorld = blendWidth * gridSize;
  const edges = [];
  const corners = [];

  // ── Edge scan ──────────────────────────────────────────────────────
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (!cell || !roomCells[row]![col]) continue;
      if (cellHasChordEdge(cell)) continue; // no blending on trimmed cells

      for (const { dr, dc, dir } of CARDINAL_DIRS) {
        const nr = row + dr,
          nc = col + dc;
        if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor || !roomCells[nr]![nc]) continue;
        if (cellHasChordEdge(neighbor)) continue;
        // Pick the texture of whichever segment actually faces this edge —
        // for a diagonally-walled cell the two halves border different
        // cardinal sides, so the cell's "primary" texture is wrong on the
        // sides that belong to the other half.
        const cellTex = cellTextureOnSide(cell, dir);
        if (!cellTex) continue;
        const neighborTex = cellTextureOnSide(neighbor, OPPOSITE[dir]);
        if (!neighborTex) continue;
        if (neighborTex === cellTex) continue;
        if (!isEdgeOpen(cell, neighbor, dir)) continue;

        const currentEntry = catalog.textures[cellTex];
        const neighborEntry = catalog.textures[neighborTex];
        if (!currentEntry || !neighborEntry) continue;
        if (!neighborEntry.img.complete || !neighborEntry.img.naturalWidth) continue;

        const curH = computeBaseHeight(currentEntry);
        const nbrH = computeBaseHeight(neighborEntry);
        if (curH < nbrH + 0.05) continue;

        // Height sampling + penetration in world units
        const h_cur = sampleEdgeHeights(currentEntry, row, col, dir);
        const h_nbr = sampleEdgeHeights(neighborEntry, nr, nc, OPPOSITE[dir]);
        const pen = new Float32Array(N_SAMPLES);
        for (let i = 0; i < N_SAMPLES; i++) {
          pen[i] = splatPenetration(h_cur ? h_cur[i]! : 0.5, h_nbr ? h_nbr[i]! : 0.5, blendWorld);
        }

        // World-coordinate Path2D clip polygon
        const wx = col * gridSize;
        const wy = row * gridSize;
        const gs = gridSize;
        const clipPath = new Path2D();
        switch (dir) {
          case 'north':
            clipPath.moveTo(wx, wy);
            for (let i = 0; i < N_SAMPLES; i++) clipPath.lineTo(wx + (i * gs) / (N_SAMPLES - 1), wy + pen[i]!);
            clipPath.lineTo(wx + gs, wy);
            break;
          case 'south':
            clipPath.moveTo(wx, wy + gs);
            for (let i = 0; i < N_SAMPLES; i++) clipPath.lineTo(wx + (i * gs) / (N_SAMPLES - 1), wy + gs - pen[i]!);
            clipPath.lineTo(wx + gs, wy + gs);
            break;
          case 'west':
            clipPath.moveTo(wx, wy);
            for (let i = 0; i < N_SAMPLES; i++) clipPath.lineTo(wx + pen[i]!, wy + (i * gs) / (N_SAMPLES - 1));
            clipPath.lineTo(wx, wy + gs);
            break;
          case 'east':
            clipPath.moveTo(wx + gs, wy);
            for (let i = 0; i < N_SAMPLES; i++) clipPath.lineTo(wx + gs - pen[i]!, wy + (i * gs) / (N_SAMPLES - 1));
            clipPath.lineTo(wx + gs, wy + gs);
            break;
        }
        clipPath.closePath();

        const { srcX, srcY, srcW, srcH } = getTexChunk(neighborEntry, row, col);

        edges.push({
          row,
          col,
          direction: dir,
          neighborEntry,
          neighborOpacity: cellTextureOpacityOnSide(neighbor, OPPOSITE[dir]) ?? 1.0,
          srcX,
          srcY,
          srcW,
          srcH,
          clipPath,
          bitmap: null, // filled by buildBlendBitmaps
        });
      }
    }
  }

  // ── Corner scan ────────────────────────────────────────────────────
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (!cell || !roomCells[row]![col]) continue;
      if (cellHasChordEdge(cell)) continue; // no blending on trimmed cells

      for (const { dr1, dc1, dr2, dc2, corner, dir1, dir2, n1Corner, n2Corner, diagCorner } of CORNER_DIRS) {
        // The current cell's texture at *this* corner. Skipped (undefined)
        // when the corner sits on a diagonal wall — both halves meet there
        // and we can't pick a non-arbitrary side.
        const cellTex = cellTextureAtCorner(cell, corner);
        if (!cellTex) continue;
        const currentEntry = catalog.textures[cellTex];
        if (!currentEntry) continue;
        const curH = computeBaseHeight(currentEntry);

        const n1r = row + dr1,
          n1c = col + dc1;
        const n2r = row + dr2,
          n2c = col + dc2;
        const n1Cell = cells[n1r]?.[n1c];
        const n2Cell = cells[n2r]?.[n2c];
        if (cellHasChordEdge(n1Cell)) continue; // no blending from trimmed cells
        if (cellHasChordEdge(n2Cell)) continue;
        if (!isEdgeOpen(cell, n1Cell ?? null, dir1) || !isEdgeOpen(cell, n2Cell ?? null, dir2)) continue;
        const diagR = row + dr1 + dr2;
        const diagC = col + dc1 + dc2;
        if (diagR < 0 || diagR >= numRows || diagC < 0 || diagC >= numCols) continue;
        const diagCell = cells[diagR]?.[diagC];
        if (!diagCell) continue;
        if (cellHasChordEdge(diagCell)) continue; // no blending from trimmed cells
        // Each neighbor's texture is read at the corner of *that* cell which
        // meets our corner — same segment-aware reasoning as the cell side.
        const diagTex = cellTextureAtCorner(diagCell, diagCorner);
        if (!diagTex) continue;

        let softTexture, softSampleR, softSampleC, softOpacity;
        if (diagTex === cellTex) {
          const n1Tex = cellTextureAtCorner(n1Cell, n1Corner);
          const n2Tex = cellTextureAtCorner(n2Cell, n2Corner);
          if (!n1Tex || !n2Tex) continue;
          if (n1Tex === cellTex || n2Tex === cellTex) continue;
          if (n1Tex !== n2Tex) continue;
          if (!roomCells[n1r]?.[n1c] || !roomCells[n2r]?.[n2c]) continue;
          softTexture = n1Tex;
          softSampleR = n1r;
          softSampleC = n1c;
          softOpacity = cellTextureOpacityAtCorner(n1Cell, n1Corner) ?? 1.0;
        } else {
          if (!roomCells[diagR]?.[diagC]) continue;
          softTexture = diagTex;
          softSampleR = diagR;
          softSampleC = diagC;
          softOpacity = cellTextureOpacityAtCorner(diagCell, diagCorner) ?? 1.0;
        }

        const adjEntry = catalog.textures[softTexture];
        if (!adjEntry?.img.complete || !adjEntry.img.naturalWidth) continue;
        if (curH < computeBaseHeight(adjEntry) + 0.05) continue;

        // Corner point in world-local coords
        let localCX = 0,
          localCY = 0,
          startAngle = 0;
        switch (corner) {
          case 'nw':
            localCX = 0;
            localCY = 0;
            startAngle = 0;
            break;
          case 'ne':
            localCX = gridSize;
            localCY = 0;
            startAngle = Math.PI / 2;
            break;
          case 'sw':
            localCX = 0;
            localCY = gridSize;
            startAngle = (3 * Math.PI) / 2;
            break;
          case 'se':
            localCX = gridSize;
            localCY = gridSize;
            startAngle = Math.PI;
            break;
        }

        const radii = new Float32Array(8); // N_ARC = 8
        for (let i = 0; i < 8; i++) {
          const angle = startAngle + ((Math.PI / 2) * i) / 7;
          const sampleLX = localCX + blendWorld * 0.5 * Math.cos(angle);
          const sampleLY = localCY + blendWorld * 0.5 * Math.sin(angle);
          const hc = sampleHeightAtPoint(currentEntry, row, col, sampleLX, sampleLY, gridSize);
          const hn = sampleHeightAtPoint(adjEntry, softSampleR, softSampleC, sampleLX, sampleLY, gridSize);
          radii[i] = splatPenetration(hc, hn, blendWorld);
        }

        const wx = col * gridSize;
        const wy = row * gridSize;
        const worldCX = wx + localCX;
        const worldCY = wy + localCY;
        const clipPath = new Path2D();
        clipPath.moveTo(worldCX, worldCY);
        for (let i = 0; i < 8; i++) {
          const angle = startAngle + ((Math.PI / 2) * i) / 7;
          clipPath.lineTo(worldCX + radii[i]! * Math.cos(angle), worldCY + radii[i]! * Math.sin(angle));
        }
        clipPath.closePath();

        const { srcX, srcY, srcW, srcH } = getTexChunk(adjEntry, row, col);

        corners.push({
          row,
          col,
          corner,
          neighborEntry: adjEntry,
          neighborOpacity: softOpacity,
          srcX,
          srcY,
          srcW,
          srcH,
          clipPath,
          localCX,
          localCY,
          bitmap: null, // filled by buildBlendBitmaps
        });
      }
    }
  }

  return { edges, corners };
}

/**
 * Get or rebuild the blend topology cache (edge/corner descriptors and bitmaps).
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} textureOptions - Texture catalog and blend settings
 * @returns {Object} Blend topology cache with edges and corners arrays
 */
export function getBlendTopoCache(
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  textureOptions: TextureOptions,
): BlendTopoCacheState | null {
  const blendWidth = textureOptions.blendWidth;
  const catalog = textureOptions.catalog;
  const texturesVersion = textureOptions.texturesVersion ?? 0;
  if (
    _blendTopoCache.cells === cells &&
    _blendTopoCache.gridSize === gridSize &&
    _blendTopoCache.blendWidth === blendWidth &&
    _blendTopoCache.catalog === catalog &&
    _blendTopoCache.texturesVersion === texturesVersion
  ) {
    return _blendTopoCache;
  }

  // Close old ImageBitmaps before rebuilding
  closeBlendBitmaps(_blendTopoCache);
  invalidateViewportBlendLayer();

  const { edges, corners } = buildBlendTopology(cells, roomCells, gridSize, textureOptions);

  // Pre-render blend bitmaps (L1 cache)
  buildBlendBitmaps(edges, corners, gridSize, blendWidth);

  _blendTopoCache = {
    cells,
    gridSize,
    blendWidth,
    catalog: catalog as BlendTextureCatalog | null,
    texturesVersion,
    edges,
    corners,
  };
  return _blendTopoCache;
}

/**
 * Return the stored parameters from the current blend topo cache (or null if no cache).
 * @returns {{ gridSize: number, blendWidth: number, catalog: Object, texturesVersion: number }|null}
 */
export function getBlendCacheParams(): {
  gridSize: number;
  blendWidth: number;
  catalog: TextureCatalog;
  texturesVersion: number;
} | null {
  if (!_blendTopoCache.edges) return null;
  return {
    gridSize: _blendTopoCache.gridSize as number,
    blendWidth: _blendTopoCache.blendWidth as number,
    catalog: _blendTopoCache.catalog as TextureCatalog,
    texturesVersion: _blendTopoCache.texturesVersion,
  };
}

/**
 * Invalidate and dispose all blend layer caches and bitmaps.
 * @returns {void}
 */
export function invalidateBlendLayerCache(): void {
  closeBlendBitmaps(_blendTopoCache);
  invalidateViewportBlendLayer();
  _blendCacheLayer = null;
  _blendTopoCache = {
    cells: null,
    gridSize: null,
    blendWidth: null,
    catalog: null,
    texturesVersion: 0,
    edges: null,
    corners: null,
  };
  log.devTrace(`invalidateBlendLayerCache() — blend topology + bitmaps cleared`);
}

/**
 * Incremental blend update — rebuild only edges/corners touching a dirty region.
 * Much cheaper than invalidateBlendLayerCache() for single-cell texture changes.
 *
 * @param {{ minRow: number, maxRow: number, minCol: number, maxCol: number }} region
 * @param {Array} cells
 * @param {Array} roomCells
 * @param {number} gridSize
 * @param {Object} textureOptions - Texture catalog and blend settings
 * @returns {void}
 */
export function patchBlendRegion(
  region: { minRow: number; maxRow: number; minCol: number; maxCol: number },
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  textureOptions: TextureOptions,
): void {
  if (!_blendTopoCache.edges) {
    // No existing topology — need a full build
    invalidateBlendLayerCache();
    return;
  }

  const blendWidth = textureOptions.blendWidth;

  // Expand region by 1 cell — neighbors of dirty cells may gain/lose blend edges
  const PAD = 1;
  const minR = Math.max(0, region.minRow - PAD);
  const maxR = Math.min(cells.length - 1, region.maxRow + PAD);
  const minC = Math.max(0, region.minCol - PAD);
  const maxC = Math.min((cells[0]?.length ?? 0) - 1, region.maxCol + PAD);

  // Remove old edges/corners in the region (close their bitmaps)
  const oldEdges = _blendTopoCache.edges;
  const oldCorners = _blendTopoCache.corners;
  const keptEdges = [];
  const keptCorners = [];

  for (const edge of oldEdges) {
    if (edge.row >= minR && edge.row <= maxR && edge.col >= minC && edge.col <= maxC) {
      if (edge.bitmap) {
        edge.bitmap.close();
        edge.bitmap = null;
      }
    } else {
      keptEdges.push(edge);
    }
  }
  for (const corner of oldCorners!) {
    if (corner.row >= minR && corner.row <= maxR && corner.col >= minC && corner.col <= maxC) {
      if (corner.bitmap) {
        corner.bitmap.close();
        corner.bitmap = null;
      }
    } else {
      keptCorners.push(corner);
    }
  }

  // Rebuild edges/corners for just the dirty region using buildBlendTopology
  // with a restricted scan area
  const regionTopo = _buildBlendTopologyForRegion(cells, roomCells, gridSize, textureOptions, minR, maxR, minC, maxC);

  // Build bitmaps for only the new edges/corners
  buildBlendBitmaps(regionTopo.edges, regionTopo.corners, gridSize, blendWidth);

  // Merge into the kept topology
  _blendTopoCache.edges = keptEdges.concat(regionTopo.edges);
  _blendTopoCache.corners = keptCorners.concat(regionTopo.corners);

  // Patch the blend cache layer for the dirty region
  if (_blendCacheLayer?.canvas) {
    const sc = _blendCacheLayer.w / (cells[0]!.length * gridSize) || 10;
    const lctx = _blendCacheLayer.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    const sz = BLEND_BITMAP_SIZE;
    const cellPx = gridSize * sc;

    // Clear the dirty region on the cache layer
    const px1 = minC * gridSize * sc;
    const py1 = minR * gridSize * sc;
    const pw = (maxC - minC + 1) * gridSize * sc;
    const ph = (maxR - minR + 1) * gridSize * sc;
    lctx.save();
    lctx.beginPath();
    lctx.rect(px1, py1, pw, ph);
    lctx.clip();
    lctx.clearRect(px1, py1, pw, ph);

    // Re-render only the new edges/corners in the region
    for (const edge of regionTopo.edges) {
      const screenX = edge.col * gridSize * sc;
      const screenY = edge.row * gridSize * sc;
      const cpx = Math.ceil(cellPx);
      lctx.save();
      lctx.setTransform(sc, 0, 0, sc, 0, 0);
      lctx.clip(edge.clipPath);
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalAlpha = edge.neighborOpacity;
      lctx.drawImage(edge.bitmap!, 0, 0, sz, sz, screenX, screenY, cpx, cpx);
      lctx.restore();
    }
    for (const cn of regionTopo.corners) {
      const screenX = cn.col * gridSize * sc;
      const screenY = cn.row * gridSize * sc;
      const cpx = Math.ceil(cellPx);
      lctx.save();
      lctx.setTransform(sc, 0, 0, sc, 0, 0);
      lctx.clip(cn.clipPath);
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalAlpha = cn.neighborOpacity;
      lctx.drawImage(cn.bitmap!, 0, 0, sz, sz, screenX, screenY, cpx, cpx);
      lctx.restore();
    }

    lctx.restore();
  }

  // Invalidate the viewport blend layer (it's cheap to rebuild from topo+bitmaps)
  invalidateViewportBlendLayer();
}

/**
 * Build blend topology for a restricted cell region only.
 * Same logic as buildBlendTopology but limited to [minR..maxR, minC..maxC].
 */
function _buildBlendTopologyForRegion(
  cells: CellGrid,
  roomCells: boolean[][],
  gridSize: number,
  textureOptions: TextureOptions,
  minR: number,
  maxR: number,
  minC: number,
  maxC: number,
) {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const blendWidth = textureOptions.blendWidth;
  const catalog = textureOptions.catalog as BlendTextureCatalog;
  const blendWorld = blendWidth * gridSize;
  const edges = [];
  const corners = [];

  // ── Edge scan (restricted) ──
  for (let row = minR; row <= maxR; row++) {
    for (let col = minC; col <= maxC; col++) {
      const cell = cells[row]?.[col];
      if (!cell || !roomCells[row]?.[col]) continue;
      if (cellHasChordEdge(cell)) continue;

      for (const { dr, dc, dir } of CARDINAL_DIRS) {
        const nr = row + dr,
          nc = col + dc;
        if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor || !roomCells[nr]?.[nc]) continue;
        if (cellHasChordEdge(neighbor)) continue;
        const cellTex = cellTextureOnSide(cell, dir);
        if (!cellTex) continue;
        const neighborTex = cellTextureOnSide(neighbor, OPPOSITE[dir]);
        if (!neighborTex) continue;
        if (neighborTex === cellTex) continue;
        if (!isEdgeOpen(cell, neighbor, dir)) continue;

        const currentEntry = catalog.textures[cellTex];
        const neighborEntry = catalog.textures[neighborTex];
        if (!currentEntry || !neighborEntry) continue;
        if (!neighborEntry.img.complete || !neighborEntry.img.naturalWidth) continue;

        const curH = computeBaseHeight(currentEntry);
        const nbrH = computeBaseHeight(neighborEntry);
        if (curH < nbrH + 0.05) continue;

        const h_cur = sampleEdgeHeights(currentEntry, row, col, dir);
        const h_nbr = sampleEdgeHeights(neighborEntry, nr, nc, OPPOSITE[dir]);
        const pen = new Float32Array(N_SAMPLES);
        for (let i = 0; i < N_SAMPLES; i++) {
          pen[i] = splatPenetration(h_cur ? h_cur[i]! : 0.5, h_nbr ? h_nbr[i]! : 0.5, blendWorld);
        }

        const wx = col * gridSize,
          wy = row * gridSize,
          gs = gridSize;
        const clipPath = new Path2D();
        switch (dir) {
          case 'north':
            clipPath.moveTo(wx, wy);
            for (let i = 0; i < N_SAMPLES; i++) clipPath.lineTo(wx + (i * gs) / (N_SAMPLES - 1), wy + pen[i]!);
            clipPath.lineTo(wx + gs, wy);
            break;
          case 'south':
            clipPath.moveTo(wx, wy + gs);
            for (let i = 0; i < N_SAMPLES; i++) clipPath.lineTo(wx + (i * gs) / (N_SAMPLES - 1), wy + gs - pen[i]!);
            clipPath.lineTo(wx + gs, wy + gs);
            break;
          case 'west':
            clipPath.moveTo(wx, wy);
            for (let i = 0; i < N_SAMPLES; i++) clipPath.lineTo(wx + pen[i]!, wy + (i * gs) / (N_SAMPLES - 1));
            clipPath.lineTo(wx, wy + gs);
            break;
          case 'east':
            clipPath.moveTo(wx + gs, wy);
            for (let i = 0; i < N_SAMPLES; i++) clipPath.lineTo(wx + gs - pen[i]!, wy + (i * gs) / (N_SAMPLES - 1));
            clipPath.lineTo(wx + gs, wy + gs);
            break;
        }
        clipPath.closePath();

        const { srcX, srcY, srcW, srcH } = getTexChunk(neighborEntry, row, col);
        edges.push({
          row,
          col,
          direction: dir,
          neighborEntry,
          neighborOpacity: cellTextureOpacityOnSide(neighbor, OPPOSITE[dir]) ?? 1.0,
          srcX,
          srcY,
          srcW,
          srcH,
          clipPath,
          bitmap: null,
        });
      }
    }
  }

  // ── Corner scan (restricted) ──
  for (let row = minR; row <= maxR; row++) {
    for (let col = minC; col <= maxC; col++) {
      const cell = cells[row]?.[col];
      if (!cell || !roomCells[row]?.[col]) continue;
      if (cellHasChordEdge(cell)) continue;

      for (const { dr1, dc1, dr2, dc2, corner, dir1, dir2, n1Corner, n2Corner, diagCorner } of CORNER_DIRS) {
        const cellTex = cellTextureAtCorner(cell, corner);
        if (!cellTex) continue;
        const currentEntry = catalog.textures[cellTex];
        if (!currentEntry) continue;
        const curH = computeBaseHeight(currentEntry);

        const n1r = row + dr1,
          n1c = col + dc1;
        const n2r = row + dr2,
          n2c = col + dc2;
        const n1Cell = cells[n1r]?.[n1c];
        const n2Cell = cells[n2r]?.[n2c];
        if (cellHasChordEdge(n1Cell)) continue;
        if (cellHasChordEdge(n2Cell)) continue;
        if (!isEdgeOpen(cell, n1Cell ?? null, dir1) || !isEdgeOpen(cell, n2Cell ?? null, dir2)) continue;
        const diagR = row + dr1 + dr2,
          diagC = col + dc1 + dc2;
        if (diagR < 0 || diagR >= numRows || diagC < 0 || diagC >= numCols) continue;
        const diagCell = cells[diagR]?.[diagC];
        if (!diagCell) continue;
        if (cellHasChordEdge(diagCell)) continue;
        const diagTex = cellTextureAtCorner(diagCell, diagCorner);
        if (!diagTex) continue;

        let softTexture, softSampleR, softSampleC, softOpacity;
        if (diagTex === cellTex) {
          const n1Tex = cellTextureAtCorner(n1Cell, n1Corner);
          const n2Tex = cellTextureAtCorner(n2Cell, n2Corner);
          if (!n1Tex || !n2Tex) continue;
          if (n1Tex === cellTex || n2Tex === cellTex) continue;
          if (n1Tex !== n2Tex) continue;
          if (!roomCells[n1r]?.[n1c] || !roomCells[n2r]?.[n2c]) continue;
          softTexture = n1Tex;
          softSampleR = n1r;
          softSampleC = n1c;
          softOpacity = cellTextureOpacityAtCorner(n1Cell, n1Corner) ?? 1.0;
        } else {
          if (!roomCells[diagR]?.[diagC]) continue;
          softTexture = diagTex;
          softSampleR = diagR;
          softSampleC = diagC;
          softOpacity = cellTextureOpacityAtCorner(diagCell, diagCorner) ?? 1.0;
        }

        const adjEntry = catalog.textures[softTexture];
        if (!adjEntry?.img.complete || !adjEntry.img.naturalWidth) continue;
        if (curH < computeBaseHeight(adjEntry) + 0.05) continue;

        let localCX = 0,
          localCY = 0;
        switch (corner) {
          case 'nw':
            localCX = 0;
            localCY = 0;
            break;
          case 'ne':
            localCX = gridSize;
            localCY = 0;
            break;
          case 'sw':
            localCX = 0;
            localCY = gridSize;
            break;
          case 'se':
            localCX = gridSize;
            localCY = gridSize;
            break;
        }
        let startAngle = 0;
        switch (corner) {
          case 'nw':
            startAngle = 0;
            break;
          case 'ne':
            startAngle = Math.PI / 2;
            break;
          case 'sw':
            startAngle = (3 * Math.PI) / 2;
            break;
          case 'se':
            startAngle = Math.PI;
            break;
        }

        const radii = new Float32Array(8);
        for (let i = 0; i < 8; i++) {
          const angle = startAngle + ((Math.PI / 2) * i) / 7;
          const sampleLX = localCX + blendWorld * 0.5 * Math.cos(angle);
          const sampleLY = localCY + blendWorld * 0.5 * Math.sin(angle);
          const hc = sampleHeightAtPoint(currentEntry, row, col, sampleLX, sampleLY, gridSize);
          const hn = sampleHeightAtPoint(adjEntry, softSampleR, softSampleC, sampleLX, sampleLY, gridSize);
          radii[i] = splatPenetration(hc, hn, blendWorld);
        }

        const wx = col * gridSize,
          wy = row * gridSize;
        const worldCX = wx + localCX,
          worldCY = wy + localCY;
        const clipPath = new Path2D();
        clipPath.moveTo(worldCX, worldCY);
        for (let i = 0; i < 8; i++) {
          const angle = startAngle + ((Math.PI / 2) * i) / 7;
          clipPath.lineTo(worldCX + radii[i]! * Math.cos(angle), worldCY + radii[i]! * Math.sin(angle));
        }
        clipPath.closePath();

        const { srcX, srcY, srcW, srcH } = getTexChunk(adjEntry, row, col);
        corners.push({
          row,
          col,
          corner,
          neighborEntry: adjEntry,
          neighborOpacity: softOpacity,
          srcX,
          srcY,
          srcW,
          srcH,
          clipPath,
          localCX,
          localCY,
          bitmap: null,
        });
      }
    }
  }

  return { edges, corners };
}
