/**
 * 2D Lighting Engine for dungeon maps.
 * Computes shadow-casting visibility polygons from wall geometry
 * and renders a compositable lightmap.
 *
 * No DOM dependencies — works with any CanvasRenderingContext2D.
 *
 * Pure-geometry helpers (wall extraction, prop shadow zones, projected
 * polygon computation) live in lighting-geometry.ts. They are re-exported
 * here so existing imports keep working.
 */

import type {
  CellGrid,
  RenderTransform,
  FalloffType,
  Light,
  Metadata,
  PropCatalog,
  TextureCatalog,
  Theme,
} from '../types.js';
import {
  extractWallSegments,
  extractPropShadowZones,
  buildPropShadowIndex,
  computePropShadowPolygon,
  DEFAULT_LIGHT_Z,
  PropShadowIndex,
  type WallSegment,
} from './lighting-geometry.js';
import { _t } from './render-state.js';
import { log } from '../util/index.js';

// Re-export geometry helpers so existing importers (lighting-hq.ts, render barrel,
// editor) keep working without ripple after the split.
export {
  extractWallSegments,
  extractPropShadowZones,
  buildPropShadowIndex,
  computePropShadowPolygon,
  DEFAULT_LIGHT_Z,
  PropShadowIndex,
};
export type { WallSegment };

// ─── Constants ─────
const INVERSE_SQUARE_K = 25;
const RAY_EPSILON = 0.00001;
const ANIM_TIME_SCALE = 0.4;
const GRADIENT_STOPS = 16;

/**
 * Unpack a normal-map RGB triple (0–255 bytes) into a unit-ish vector with
 * components in [-1, 1]. The caller is responsible for normalization if it
 * matters — most normal maps are already close to unit length.
 *
 * Exported so the real-time cell-averaged bump path and the HQ per-pixel
 * bump path cannot drift on the byte→float encoding.
 */
export function unpackNormal(data: Uint8ClampedArray | Uint8Array, idx: number): [number, number, number] {
  return [(data[idx]! / 255) * 2 - 1, (data[idx + 1]! / 255) * 2 - 1, (data[idx + 2]! / 255) * 2 - 1];
}

/**
 * Clamp a directional light's spread (cone half-angle in degrees).
 *
 * Values outside [0, 180] produce divergent behaviour between the real-time
 * canvas `arc()` fill (which wraps to a full circle when the span ≥ 2π) and
 * the HQ per-pixel dot-product culling (which narrows again once `cos(spread)`
 * crosses back through 1). Clamping at the render boundary keeps both paths
 * in agreement regardless of how bad data entered the map.
 */
export function clampSpread(spread: number | undefined): number {
  const s = spread ?? 45;
  if (!Number.isFinite(s)) return 45;
  return Math.max(0, Math.min(180, s));
}

// ─── 2D Visibility Polygon (Shadow Casting) ────────────────────────────────

const EPSILON = RAY_EPSILON;

/**
 * Compute the intersection of a ray from (ox,oy) in direction (dx,dy)
 * with a line segment from (sx1,sy1) to (sx2,sy2).
 * Returns { t, u } where t is distance along ray, u is position along segment.
 * Returns null if no intersection.
 */
function raySegmentIntersect(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
) {
  const sdx = sx2 - sx1;
  const sdy = sy2 - sy1;
  const denom = dx * sdy - dy * sdx;
  if (Math.abs(denom) < EPSILON) return null;

  const t = ((sx1 - ox) * sdy - (sy1 - oy) * sdx) / denom;
  const u = ((sx1 - ox) * dy - (sy1 - oy) * dx) / denom;

  if (t < 0 || u < 0 || u > 1) return null;
  return { t, u };
}

// ─── Spatial Grid for Accelerated Ray Casting ─────────────────────────────

/**
 * Bucket wall segments into a 2D grid for O(1) spatial lookups.
 * Used by castRayGrid to only test segments along the ray path.
 *
 * `WallSegment` is imported from lighting-geometry.ts (single source of truth).
 */
class SegmentGrid {
  cellSize: number;
  ox: number;
  oy: number;
  w: number;
  h: number;
  buckets: (WallSegment[] | null)[];

  constructor(segments: WallSegment[], originX: number, originY: number, radius: number, cellSize: number) {
    this.cellSize = cellSize;
    this.ox = originX - radius - 2;
    this.oy = originY - radius - 2;
    const span = 2 * (radius + 2);
    this.w = Math.ceil(span / cellSize) + 1;
    this.h = Math.ceil(span / cellSize) + 1;
    this.buckets = new Array(this.w * this.h).fill(null);

    for (const seg of segments) {
      const minGx = Math.max(0, Math.floor((Math.min(seg.x1, seg.x2) - this.ox) / cellSize));
      const maxGx = Math.min(this.w - 1, Math.floor((Math.max(seg.x1, seg.x2) - this.ox) / cellSize));
      const minGy = Math.max(0, Math.floor((Math.min(seg.y1, seg.y2) - this.oy) / cellSize));
      const maxGy = Math.min(this.h - 1, Math.floor((Math.max(seg.y1, seg.y2) - this.oy) / cellSize));
      for (let gy = minGy; gy <= maxGy; gy++) {
        for (let gx = minGx; gx <= maxGx; gx++) {
          const idx = gy * this.w + gx;
          (this.buckets[idx] ??= []).push(seg);
        }
      }
    }
  }

  getBucket(gx: number, gy: number): WallSegment[] | null {
    if (gx < 0 || gx >= this.w || gy < 0 || gy >= this.h) return null;
    return this.buckets[gy * this.w + gx] ?? null;
  }
}

/**
 * Cast a ray using the spatial grid — only tests segments in grid cells along the ray path.
 * Uses DDA traversal for efficient grid walking.
 */
function castRayGrid(ox: number, oy: number, angle: number, grid: SegmentGrid) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const cs = grid.cellSize;

  let gx = Math.floor((ox - grid.ox) / cs);
  let gy = Math.floor((oy - grid.oy) / cs);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(cs / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(cs / dy) : Infinity;

  let tMaxX = dx !== 0 ? (dx > 0 ? (gx + 1) * cs + grid.ox - ox : gx * cs + grid.ox - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? (gy + 1) * cs + grid.oy - oy : gy * cs + grid.oy - oy) / dy : Infinity;

  let closest = null;
  const tested = new Set();
  const maxSteps = grid.w + grid.h;

  for (let step = 0; step < maxSteps; step++) {
    const segs = grid.getBucket(gx, gy);
    if (segs) {
      for (const seg of segs) {
        if (tested.has(seg)) continue;
        tested.add(seg);
        const hit = raySegmentIntersect(ox, oy, dx, dy, seg.x1, seg.y1, seg.x2, seg.y2);
        if (hit && hit.t > EPSILON && (!closest || hit.t < closest.t)) {
          closest = hit;
        }
      }
    }

    // If we have a hit within the current cell boundary, we can stop
    const cellBound = Math.min(tMaxX, tMaxY);
    if (closest && closest.t <= cellBound) break;

    // Step to next grid cell
    if (tMaxX < tMaxY) {
      gx += stepX;
      tMaxX += tDeltaX;
    } else {
      gy += stepY;
      tMaxY += tDeltaY;
    }

    if (gx < 0 || gx >= grid.w || gy < 0 || gy >= grid.h) break;
  }

  if (!closest) return null;
  return {
    x: ox + dx * closest.t,
    y: oy + dy * closest.t,
    t: closest.t,
  };
}

/**
 * Compute 2D visibility polygon for a point light source.
 * Uses the classic ray-casting algorithm: cast rays toward all wall endpoints
 * at slight +/- epsilon offsets, then sort by angle and build the polygon.
 *
 * @param {number} lx - light X in world feet
 * @param {number} ly - light Y in world feet
 * @param {number} radius - light radius in world feet
 * @param {Array} segments - wall segments [{x1,y1,x2,y2}]
 * @returns {Array} visibility polygon [{x,y}, ...] in world feet
 */
export function computeVisibility(
  lx: number,
  ly: number,
  radius: number,
  segments: Array<{ x1: number; y1: number; x2: number; y2: number }>,
): Float32Array {
  // Add bounding box segments to limit visibility to the light's radius
  const r = radius + 1; // slight padding
  const bounds = [
    { x1: lx - r, y1: ly - r, x2: lx + r, y2: ly - r },
    { x1: lx + r, y1: ly - r, x2: lx + r, y2: ly + r },
    { x1: lx + r, y1: ly + r, x2: lx - r, y2: ly + r },
    { x1: lx - r, y1: ly + r, x2: lx - r, y2: ly - r },
  ];

  // Filter segments to those near the light, then add bounds
  const nearSegments = [];
  for (const seg of segments) {
    // Quick AABB check: segment bounding box overlaps light circle
    const minX = Math.min(seg.x1, seg.x2);
    const maxX = Math.max(seg.x1, seg.x2);
    const minY = Math.min(seg.y1, seg.y2);
    const maxY = Math.max(seg.y1, seg.y2);
    if (maxX < lx - radius - 1 || minX > lx + radius + 1) continue;
    if (maxY < ly - radius - 1 || minY > ly + radius + 1) continue;
    nearSegments.push(seg);
  }

  const allSegments = [...nearSegments, ...bounds];

  // Build spatial grid for accelerated ray casting (cell size = 5 world feet)
  const grid = new SegmentGrid(allSegments, lx, ly, radius, 5);

  // Collect unique endpoints
  const endpoints = new Set();
  for (const seg of allSegments) {
    endpoints.add(`${seg.x1},${seg.y1}`);
    endpoints.add(`${seg.x2},${seg.y2}`);
  }

  // Cast rays at each endpoint angle with +/- epsilon
  const angles = [];
  for (const ep of endpoints) {
    const [ex, ey] = (ep as string).split(',').map(Number) as [number, number];
    const angle = Math.atan2(ey - ly, ex - lx);
    angles.push(angle - EPSILON);
    angles.push(angle);
    angles.push(angle + EPSILON);
  }

  // Sort by angle
  angles.sort((a, b) => a - b);

  // Build visibility polygon using grid-accelerated ray casting.
  // Store as interleaved Float32Array [x0,y0,x1,y1,...] — no per-point object
  // allocation, and consumers can iterate with index arithmetic.
  const scratch = new Float32Array(angles.length * 2);
  let n = 0;
  for (const angle of angles) {
    const hit = castRayGrid(lx, ly, angle, grid);
    if (hit) {
      scratch[n * 2] = hit.x;
      scratch[n * 2 + 1] = hit.y;
      n++;
    }
  }
  return scratch.subarray(0, n * 2);
}

// ─── Lightmap Rendering ────────────────────────────────────────────────────

/**
 * Parse a hex color string into {r, g, b} (0-255).
 * @param {string} hex - Hex color string (e.g. '#FF9944')
 * @returns {{ r: number, g: number, b: number }} Parsed RGB values (0-255)
 */
export function parseColor(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

/**
 * Compute falloff multiplier for a given distance and radius.
 * @param {number} dist - Distance from light center in feet
 * @param {number} radius - Light radius in feet
 * @param {string} falloff - Falloff type ('linear', 'quadratic', 'inverse-square', 'smooth')
 * @returns {number} Falloff multiplier (0.0 to 1.0)
 */
export function falloffMultiplier(dist: number, radius: number, falloff: FalloffType): number {
  if (radius <= 0) return 1;
  const t = Math.max(0, 1 - dist / radius);
  switch (falloff) {
    case 'linear':
      return t;
    case 'quadratic':
      return t * t;
    case 'inverse-square': {
      // 1/(1+k*d²) normalized so f(0)=1 and f(r)≈0
      const k = INVERSE_SQUARE_K;
      const dNorm = dist / radius;
      const raw = 1 / (1 + k * dNorm * dNorm);
      const floor = 1 / (1 + k);
      return Math.max(0, (raw - floor) / (1 - floor));
    }
    case 'sharp':
    case 'step':
    case 'smooth':
    default: {
      const sm = t * t * (3 - 2 * t); // smoothstep
      return sm * sm; // squared: steeper outer falloff (0.18% at 87.5% radius vs 4.3% before)
    }
  }
}

/**
 * Return an effective (possibly animated) copy of a light for the given time.
 * Returns the same object if no animation is set (avoids allocation).
 *
 * @param {object} light
 * @param {number} time - Elapsed seconds
 * @returns {Object} Effective light with animated properties applied
 */
export function getEffectiveLight(light: Light, time: number): Light {
  if (!light.animation?.type) return light;
  const { type, speed = 1.0, amplitude = 0.3, radiusVariation = 0 } = light.animation;
  const t = time * speed * ANIM_TIME_SCALE;

  let intensityMult = 1.0;
  let radiusMult = 1.0;

  switch (type) {
    case 'flicker':
      intensityMult = 1 + amplitude * (0.5 * Math.sin(t * 17.3) + 0.3 * Math.sin(t * 31.7) + 0.2 * Math.sin(t * 7.1));
      if (radiusVariation > 0) radiusMult = 1 + radiusVariation * Math.sin(t * 11.3);
      break;
    case 'pulse':
      intensityMult = 1 + amplitude * Math.sin(2 * Math.PI * t);
      break;
    case 'strobe':
      intensityMult = t % 1 < 0.5 ? 1 + amplitude : Math.max(0, 1 - amplitude);
      break;
  }

  const result = { ...light };
  result.intensity = Math.max(0.01, light.intensity * Math.max(0, intensityMult));
  if (light.radius && radiusMult !== 1.0) result.radius = Math.max(1, light.radius * Math.max(0.1, radiusMult));
  if (light.range && radiusMult !== 1.0) result.range = Math.max(1, light.range * Math.max(0.1, radiusMult));
  return result;
}

// ─── Per-Light Compositing Canvas (GPU shadow mask) ────────────────────────
// A single reusable OffscreenCanvas is used for all lights — resized as needed.
// This avoids per-frame allocation while still supporting different light sizes.

let lightRTCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let lightRTCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

function ensureLightRTCanvas(w: number, h: number) {
  const cw = Math.ceil(w),
    ch = Math.ceil(h);
  if (!lightRTCanvas) {
    if (typeof OffscreenCanvas !== 'undefined') {
      lightRTCanvas = new OffscreenCanvas(cw, ch);
      lightRTCtx = lightRTCanvas.getContext('2d');
    } else {
      lightRTCanvas = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
      lightRTCtx = lightRTCanvas.getContext('2d');
    }
  } else if (lightRTCanvas.width < cw || lightRTCanvas.height < ch) {
    lightRTCanvas.width = Math.max(lightRTCanvas.width, cw);
    lightRTCanvas.height = Math.max(lightRTCanvas.height, ch);
  }
  return lightRTCtx!;
}

/**
 * Apply z-height prop shadows to the per-light RT canvas.
 * Uses 'destination-out' to subtract shadow areas from the light's gradient,
 * with a linear gradient from near (opaque) to far (transparent) for penumbra.
 */
function _applyPropShadowsToRT(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  light: Light,
  transform: RenderTransform,
  bbX: number,
  bbY: number,
) {
  for (const { shadowPoly, nearCenter, farCenter, opacity, hard } of light._propShadows as Array<{
    shadowPoly: number[][];
    nearCenter: number[];
    farCenter: number[];
    opacity: number;
    hard: boolean;
  }>) {
    // Convert world-feet shadow polygon to pixel coordinates relative to the RT canvas
    const pxPoly = shadowPoly.map(([wx, wy]: number[]) => [
      wx! * transform.scale + transform.offsetX - bbX,
      wy! * transform.scale + transform.offsetY - bbY,
    ]);

    // Subtract shadow from the light using destination-out
    gctx.save();
    gctx.globalCompositeOperation = 'destination-out';

    if (hard) {
      // Hard shadow: full opacity, no gradient (light is at prop level → infinite occlusion)
      gctx.fillStyle = `rgba(0,0,0,${opacity.toFixed(3)})`;
    } else {
      // Soft shadow: linear gradient penumbra from near edge → far edge
      const ncx = nearCenter[0]! * transform.scale + transform.offsetX - bbX;
      const ncy = nearCenter[1]! * transform.scale + transform.offsetY - bbY;
      const fcx = farCenter[0]! * transform.scale + transform.offsetX - bbX;
      const fcy = farCenter[1]! * transform.scale + transform.offsetY - bbY;
      const grad = gctx.createLinearGradient(ncx, ncy, fcx, fcy);
      grad.addColorStop(0, `rgba(0,0,0,${opacity.toFixed(3)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      gctx.fillStyle = grad;
    }
    gctx.beginPath();
    gctx.moveTo(pxPoly[0]![0]!, pxPoly[0]![1]!);
    for (let i = 1; i < pxPoly.length; i++) {
      gctx.lineTo(pxPoly[i]![0]!, pxPoly[i]![1]!);
    }
    gctx.closePath();
    gctx.fill();
    gctx.restore();
  }
}

/**
 * Draw visibility polygon as a white filled shape into gctx,
 * offset so that world-to-canvas coords are relative to (bbX, bbY).
 *
 * `visibility` is an interleaved Float32Array [x0, y0, x1, y1, ...].
 */
function clipToVisibility(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  visibility: Float32Array,
  transform: RenderTransform,
  bbX: number,
  bbY: number,
) {
  const n = visibility.length;
  if (n < 6) return; // need ≥ 3 points
  const sx = transform.scale;
  const ox = transform.offsetX - bbX;
  const oy = transform.offsetY - bbY;
  gctx.beginPath();
  gctx.moveTo(visibility[0]! * sx + ox, visibility[1]! * sx + oy);
  for (let i = 2; i < n; i += 2) {
    gctx.lineTo(visibility[i]! * sx + ox, visibility[i + 1]! * sx + oy);
  }
  gctx.closePath();
  gctx.fill();
}

/**
 * Build gradient stops for a radial gradient from (cx, cy) out to radius rPx,
 * using gradient center offset within the bounding box at (relCx, relCy).
 */
function buildRadialGradient(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  relCx: number,
  relCy: number,
  rPx: number,
  r: number,
  g: number,
  b: number,
  intensity: number,
  lightRadius: number,
  falloff: FalloffType | string,
) {
  const grad = gctx.createRadialGradient(relCx, relCy, 0, relCx, relCy, rPx);
  grad.addColorStop(0, `rgba(${r},${g},${b},${Math.min(1.0, intensity)})`);
  const numStops = GRADIENT_STOPS;
  for (let i = 1; i <= numStops; i++) {
    const frac = i / numStops;
    const mult = falloffMultiplier(frac * lightRadius, lightRadius, falloff as FalloffType);
    grad.addColorStop(frac, `rgba(${r},${g},${b},${Math.min(1.0, intensity * mult)})`);
  }
  return grad;
}

/**
 * Render a single point light onto the lightmap using GPU-composited shadow mask.
 * Uses destination-in composite to mask a radial gradient to the visibility polygon —
 * giving anti-aliased shadow edges without a CPU pixel loop.
 */
/**
 * Build the composited point-light RT (gradient + visibility clip + prop shadows)
 * into `gctx`, which must already be sized to (bbW, bbH) and cleared. Returns
 * nothing; the caller owns the draw-to-target step. Split out so the bake
 * cache can reuse the same composite logic on a persistent per-light canvas.
 */
function buildPointLightComposite(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  light: Light,
  visibility: Float32Array,
  transform: RenderTransform,
  bbX: number,
  bbY: number,
  bbW: number,
  bbH: number,
  cx: number,
  cy: number,
  rPx: number,
  dimRPx: number | null,
) {
  const { r, g, b } = parseColor(light.color);
  const intensity = light.intensity;
  const falloff: FalloffType = light.falloff;
  const relCx = cx - bbX;
  const relCy = cy - bbY;

  if (dimRPx) {
    const dimIntensity = Math.min(1, intensity * 0.5);
    const brightFrac = rPx / dimRPx;
    const grad = gctx.createRadialGradient(relCx, relCy, 0, relCx, relCy, dimRPx);
    grad.addColorStop(0, `rgba(${r},${g},${b},${Math.min(1, intensity)})`);
    const numStops = 8;
    for (let i = 1; i < numStops; i++) {
      const t = i / numStops;
      const gradFrac = t * brightFrac;
      const mult = falloffMultiplier(t * light.radius, light.radius, falloff);
      const alpha = Math.max(dimIntensity, Math.min(1, intensity * mult));
      grad.addColorStop(gradFrac, `rgba(${r},${g},${b},${alpha.toFixed(4)})`);
    }
    grad.addColorStop(brightFrac, `rgba(${r},${g},${b},${dimIntensity})`);
    grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, bbW, bbH);
  } else {
    gctx.fillStyle = buildRadialGradient(gctx, relCx, relCy, rPx, r, g, b, intensity, light.radius, falloff);
    gctx.fillRect(0, 0, bbW, bbH);
  }

  gctx.globalCompositeOperation = 'destination-in';
  gctx.fillStyle = '#ffffff';
  clipToVisibility(gctx, visibility, transform, bbX, bbY);
  gctx.globalCompositeOperation = 'source-over';

  if (light._propShadows?.length) {
    _applyPropShadowsToRT(gctx, light, transform, bbX, bbY);
  }
}

function _computePointLightBBox(light: Light, transform: RenderTransform, vpW: number, vpH: number) {
  const cx = light.x * transform.scale + transform.offsetX;
  const cy = light.y * transform.scale + transform.offsetY;
  const rPx = light.radius * transform.scale;
  const dimRPx = light.dimRadius && light.dimRadius > light.radius ? light.dimRadius * transform.scale : null;
  const outerRPx = dimRPx ?? rPx;
  const bbX = Math.floor(Math.max(cx - outerRPx, 0));
  const bbY = Math.floor(Math.max(cy - outerRPx, 0));
  const bbW = Math.ceil(Math.min(cx + outerRPx, vpW)) - bbX;
  const bbH = Math.ceil(Math.min(cy + outerRPx, vpH)) - bbY;
  return { cx, cy, rPx, dimRPx, bbX, bbY, bbW, bbH };
}

function _allocateBakedCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function renderPointLight(
  lctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  light: Light,
  visibility: Float32Array,
  transform: RenderTransform,
) {
  if (visibility.length < 6) return; // < 3 points

  // Clip bounding box to the canvas viewport. Without this, zooming in deeply
  // makes outerRPx thousands of pixels, causing a massive OffscreenCanvas and
  // radial gradient to be allocated every frame. Snap to integer pixel
  // coordinates: fractional bbX/bbY cause drawImage to sub-pixel interpolate,
  // blending gradient edge pixels with transparent ones and producing a faint
  // visible line at the bounding box edge.
  const { cx, cy, rPx, dimRPx, bbX, bbY, bbW, bbH } = _computePointLightBBox(
    light,
    transform,
    lctx.canvas.width,
    lctx.canvas.height,
  );
  if (bbW <= 0 || bbH <= 0) return; // fully off-screen

  const gctx = ensureLightRTCanvas(bbW, bbH);
  gctx.clearRect(0, 0, bbW, bbH);
  buildPointLightComposite(gctx, light, visibility, transform, bbX, bbY, bbW, bbH, cx, cy, rPx, dimRPx);
  lctx.drawImage(lightRTCanvas!, 0, 0, bbW, bbH, bbX, bbY, bbW, bbH);
}

/**
 * Bake a point light's full composite at intensity=1 onto a fresh persistent
 * OffscreenCanvas. Caller blits with globalAlpha = current intensity each frame.
 * Returns null if the light is fully off-screen.
 */
function _bakePointLight(
  light: Light,
  visibility: Float32Array,
  transform: RenderTransform,
  vpW: number,
  vpH: number,
): BakedLight | null {
  const { cx, cy, rPx, dimRPx, bbX, bbY, bbW, bbH } = _computePointLightBBox(light, transform, vpW, vpH);
  if (bbW <= 0 || bbH <= 0) return null;
  const canvas = _allocateBakedCanvas(bbW, bbH);
  const gctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  // Bake at intensity=1 so per-frame globalAlpha scales the whole composite.
  const bakeLight: Light = { ...light, intensity: 1 };
  buildPointLightComposite(gctx, bakeLight, visibility, transform, bbX, bbY, bbW, bbH, cx, cy, rPx, dimRPx);
  return { canvas, bbX, bbY, bbW, bbH, scale: transform.scale };
}

/**
 * Render a single directional (cone) light using GPU-composited shadow mask.
 */
function renderDirectionalLight(
  lctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  light: Light,
  visibility: Float32Array,
  transform: RenderTransform,
) {
  if (visibility.length < 6) return; // < 3 points

  const cx = light.x * transform.scale + transform.offsetX;
  const cy = light.y * transform.scale + transform.offsetY;
  const range = ((light.range ?? light.radius) || 30) * transform.scale;

  const { r, g, b } = parseColor(light.color);
  const intensity = light.intensity;
  const falloff: FalloffType = light.falloff;
  const angleRad = ((light.angle ?? 0) * Math.PI) / 180;
  const spreadRad = (clampSpread(light.spread) * Math.PI) / 180;
  const effRadius = (light.range ?? light.radius) || 30;

  const vpW = lctx.canvas.width;
  const vpH = lctx.canvas.height;
  const bbX = Math.floor(Math.max(cx - range, 0));
  const bbY = Math.floor(Math.max(cy - range, 0));
  const bbW = Math.ceil(Math.min(cx + range, vpW)) - bbX;
  const bbH = Math.ceil(Math.min(cy + range, vpH)) - bbY;
  if (bbW <= 0 || bbH <= 0) return;

  const cw = bbW;
  const ch = bbH;

  const gctx = ensureLightRTCanvas(cw, ch);
  gctx.clearRect(0, 0, cw, ch);

  const relCx = cx - bbX;
  const relCy = cy - bbY;

  // Radial gradient fill
  gctx.fillStyle = buildRadialGradient(gctx, relCx, relCy, range, r, g, b, intensity, effRadius, falloff);
  gctx.fillRect(0, 0, bbW, bbH);

  // Mask: intersection of visibility polygon AND cone
  gctx.globalCompositeOperation = 'destination-in';
  gctx.fillStyle = '#ffffff';

  // Cone shape
  gctx.beginPath();
  gctx.moveTo(relCx, relCy);
  gctx.arc(relCx, relCy, range, angleRad - spreadRad, angleRad + spreadRad);
  gctx.closePath();
  gctx.fill();

  // Visibility polygon (further restricts)
  gctx.globalCompositeOperation = 'destination-in';
  gctx.fillStyle = '#ffffff';
  clipToVisibility(gctx, visibility, transform, bbX, bbY);
  gctx.globalCompositeOperation = 'source-over';

  // Apply z-height prop shadows
  if (light._propShadows?.length) {
    _applyPropShadowsToRT(gctx, light, transform, bbX, bbY);
  }

  lctx.drawImage(lightRTCanvas!, 0, 0, cw, ch, bbX, bbY, cw, ch);
}

// ─── Visibility Cache ──────────────────────────────────────────────────────

const visibilityCache = new Map();
const propShadowsCache = new Map<
  string,
  Array<{ shadowPoly: number[][]; nearCenter: number[]; farCenter: number[]; opacity: number; hard: boolean }>
>();
type BakedLight = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  bbX: number;
  bbY: number;
  bbW: number;
  bbH: number;
  scale: number;
};
// Intensity-only animated lights (flicker/pulse/strobe without radiusVariation)
// bake their full composited RT — gradient + visibility clip + prop shadows —
// at intensity=1 once per light/scale, then each frame applies intensity via
// globalAlpha on a single drawImage. The destination-in (visibility mask) and
// destination-out (prop shadows) passes commute with globalAlpha scaling, so
// the result is mathematically identical to rebuilding the composite every frame.
const bakedLightCache = new Map<string, BakedLight>();
let cachedWallSegments: WallSegment[] | null = null;
let cachedPropShadowZones: ReturnType<typeof extractPropShadowZones> | null = null;
let cachedPropShadowIndex: PropShadowIndex | null = null;
let _lightingVersion = 0;

/**
 * Return the current lighting version counter. Bumped on every invalidation.
 * @returns {number} Lighting version
 */
export function getLightingVersion(): number {
  return _lightingVersion;
}

// ─── Reusable Lightmap Canvases ───────────────────────────────────────────
// _lmCanvas: final lightmap (static + animated, composited each frame)
// _staticLmCanvas: cached static-only lightmap (rebuilt only when lights/walls change)
let _lmCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let _lmW = 0,
  _lmH = 0;
let _staticLmCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let _staticLmValid = false;

function _getLightmapCanvas(w: number, h: number) {
  if (_lmCanvas && _lmW === w && _lmH === h) return _lmCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    _lmCanvas = new OffscreenCanvas(w, h);
  } else {
    _lmCanvas = document.createElement('canvas');
    _lmCanvas.width = w;
    _lmCanvas.height = h;
  }
  _lmW = w;
  _lmH = h;
  _staticLmCanvas = null; // force rebuild of static cache too
  _staticLmValid = false;
  return _lmCanvas;
}

function _getStaticLmCanvas(w: number, h: number) {
  if (_staticLmCanvas?.width === w && _staticLmCanvas.height === h) return _staticLmCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    _staticLmCanvas = new OffscreenCanvas(w, h);
  } else {
    _staticLmCanvas = document.createElement('canvas');
    _staticLmCanvas.width = w;
    _staticLmCanvas.height = h;
  }
  _staticLmValid = false;
  return _staticLmCanvas;
}

/**
 * Scope of a lighting-cache invalidation.
 *
 *   `'walls'`   — wall segments or diagonal-wall geometry changed. Rebuilds
 *                 cachedWallSegments + cachedPropShadowZones + every per-light
 *                 cache + the static lightmap.
 *   `'props'`   — a light-blocking prop moved/rotated/changed scale. Rebuilds
 *                 cachedPropShadowZones + prop-shadow cache + baked-light cache
 *                 + static lightmap. Keeps wall segments.
 *   `'lights'`  — only a light's position/config changed. Rebuilds per-light
 *                 caches + static lightmap. Keeps wall segments and prop zones.
 */
export type LightCacheScope = 'walls' | 'props' | 'lights';

/**
 * Clear lighting-cache entries that depend on a given scope of change. Every
 * wall-, prop-, or light-mutating tool calls this (directly or via
 * invalidateLightmap()), so per-frame hash recomputation is unnecessary.
 *
 * Legacy `true` / `false` aliases map to `'walls'` and `'lights'`.
 */
export function invalidateVisibilityCache(scope: LightCacheScope | boolean = 'walls'): void {
  // Legacy boolean aliases kept for backwards compat with older callers.
  const resolved: LightCacheScope = scope === true ? 'walls' : scope === false ? 'lights' : scope;

  visibilityCache.clear();
  propShadowsCache.clear();
  bakedLightCache.clear();
  if (resolved === 'walls') {
    cachedWallSegments = null;
    cachedPropShadowZones = null;
    cachedPropShadowIndex = null;
  } else if (resolved === 'props') {
    // Only prop shadows changed (e.g. prop picked up / moved) — keep wall segments
    cachedPropShadowZones = null;
    cachedPropShadowIndex = null;
  }
  // Static lightmap depends on wall segments, prop shadows, AND any non-animated
  // light's position/intensity, so every scope currently invalidates it.
  _staticLmValid = false;
  _lightingVersion++;
  log.devTrace(`invalidateVisibilityCache('${resolved}') → lightingVersion ${_lightingVersion}`);
}

/**
 * Force full lightmap cache teardown (call when lightmap resolution changes).
 * @returns {void}
 */
export function invalidateLightmapCaches(): void {
  _staticLmCanvas = null;
  _staticLmValid = false;
  _lmCanvas = null;
  _lmW = 0;
  _lmH = 0;
  log.dev(`invalidateLightmapCaches() — static + dynamic lightmap canvases dropped`);
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Render the complete lightmap onto a canvas context using 'multiply' composite.
 *
 * @param {CanvasRenderingContext2D} ctx - target context
 * @param {Array} lights - array of light definitions
 * @param {Array} cells - 2D cell grid
 * @param {number} gridSize - feet per cell
 * @param {object} transform - {offsetX, offsetY, scale}
 * @param {number} canvasW - canvas pixel width
 * @param {number} canvasH - canvas pixel height
 * @param {number} ambientLevel - 0.0 (pitch black) to 1.0 (fully lit)
 * @param {Object|null} [textureCatalog] - Optional texture catalog for normal maps
 * @param {Object|null} [propCatalog] - Prop catalog for shadow extraction
 * @param {Object|null} [options] - Options with ambientColor, time, lightPxPerFoot
 * @param {Object|null} [metadata=null] - Dungeon metadata
 * @returns {void}
 */
export function renderLightmap(
  ctx: CanvasRenderingContext2D,
  lights: Light[],
  cells: CellGrid,
  gridSize: number,
  transform: RenderTransform,
  canvasW: number,
  canvasH: number,
  ambientLevel: number,
  textureCatalog: TextureCatalog | null,
  propCatalog: PropCatalog | null,
  options: {
    ambientColor?: string;
    time?: number;
    lightPxPerFoot?: number;
    destX?: number;
    destY?: number;
    destW?: number;
    destH?: number;
  } | null,
  metadata: Metadata | null = null,
): void {
  const {
    ambientColor = '#ffffff',
    time = 0,
    lightPxPerFoot = 0,
    destX = 0,
    destY = 0,
    destW = 0,
    destH = 0,
  } = options ?? {};
  const activeLights = lights;

  // Wall segments are cached and only recomputed when invalidateVisibilityCache() is called.
  // Only profile when the cache actually rebuilds — ??= skips _t() on warm hits.
  cachedWallSegments ??= _t('lighting:segments', () => extractWallSegments(cells, gridSize, propCatalog, metadata));
  const segments = cachedWallSegments;

  // Prop shadow zones for z-height projection (cached alongside wall segments).
  // The spatial index is built lazily alongside the zones so per-light lookups
  // don't scan every prop on every frame.
  if (!cachedPropShadowIndex) {
    _t('lighting:propZones', () => {
      cachedPropShadowZones ??= extractPropShadowZones(propCatalog, metadata, gridSize);
      cachedPropShadowIndex = buildPropShadowIndex(cachedPropShadowZones).index;
    });
  }
  const propShadowIndex = cachedPropShadowIndex!;

  // Lightmap resolution: if lightPxPerFoot is set and smaller than the cache
  // resolution, render at reduced size and upscale. Lightmaps are smooth
  // gradients so lower resolution is visually imperceptible.
  const cacheScale = transform.scale; // px/ft of the full cache
  const lmScale = lightPxPerFoot > 0 && lightPxPerFoot < cacheScale ? lightPxPerFoot : cacheScale;
  const lmW = Math.ceil((canvasW * lmScale) / cacheScale);
  const lmH = Math.ceil((canvasH * lmScale) / cacheScale);
  const lmTransform = { scale: lmScale, offsetX: 0, offsetY: 0 };

  // Split lights into static (no animation) and animated
  const staticLights: Light[] = [];
  const animatedLights: Light[] = [];
  for (const light of activeLights) {
    if (light.animation?.type) {
      animatedLights.push(light);
    } else {
      staticLights.push(light);
    }
  }
  const hasAnimated = animatedLights.length > 0;

  // ── Static lightmap (ambient + all non-animated lights) ──
  // Only rebuilt when visibility cache is invalidated (wall/light changes).
  const staticCanvas = _getStaticLmCanvas(lmW, lmH);
  if (!_staticLmValid) {
    _t('lighting:staticBuild', () => {
      const slctx = staticCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      slctx.globalCompositeOperation = 'source-over';

      // Fill with ambient
      const amb = Math.max(0, Math.min(1, ambientLevel));
      const { r: ar, g: ag, b: ab } = parseColor(ambientColor);
      slctx.fillStyle = `rgb(${Math.round(ar * amb)}, ${Math.round(ag * amb)}, ${Math.round(ab * amb)})`;
      slctx.fillRect(0, 0, lmW, lmH);

      // Additively blend each static light
      slctx.globalCompositeOperation = 'lighter';
      for (const light of staticLights) {
        _renderOneLight(slctx, light, time, segments, lmTransform, propShadowIndex);
      }

      // Normal map bump uses all lights for direction, but only apply on static pass
      if (textureCatalog) {
        _t('lighting:normalMap', () =>
          applyNormalMapBump(slctx, activeLights, cells, gridSize, lmTransform, textureCatalog),
        );
      }

      _staticLmValid = true;
    });
  }

  // Determine where to draw the lightmap on the target canvas.
  // When destW/destH are set, the lightmap covers a sub-region of the target (screen overlay).
  // Otherwise it covers the full target (cache-space rendering).
  const useDest = destW > 0 && destH > 0;
  const dx = useDest ? destX : 0;
  const dy = useDest ? destY : 0;
  const dw = useDest ? destW : canvasW;
  const dh = useDest ? destH : canvasH;

  if (!hasAnimated) {
    // Fast path: no animated lights — composite static lightmap directly
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(staticCanvas, dx, dy, dw, dh);
    ctx.restore();
    return;
  }

  // ── Animated lights: blit static cache + render animated lights ──
  _t('lighting:animated', () => {
    const lightCanvas = _getLightmapCanvas(lmW, lmH);
    const lctx = lightCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

    // Start from the cached static lightmap
    lctx.globalCompositeOperation = 'source-over';
    lctx.drawImage(staticCanvas, 0, 0);

    // Additively blend animated lights
    lctx.globalCompositeOperation = 'lighter';
    for (const light of animatedLights) {
      _renderOneLight(lctx, light, time, segments, lmTransform, propShadowIndex);
    }

    // Composite lightmap onto main canvas with multiply
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lightCanvas, dx, dy, dw, dh);
    ctx.restore();
  });
}

/** Render a single light onto a lightmap context (assumes 'lighter' composite op). */
function _renderOneLight(
  lctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  light: Light,
  time: number,
  segments: WallSegment[],
  transform: RenderTransform,
  propShadowIndex: PropShadowIndex,
) {
  const eff = getEffectiveLight(light, time);
  const outerRadius = eff.dimRadius && eff.dimRadius > (eff.radius || 0) ? eff.dimRadius : eff.radius || 30;
  const effectiveRadius = eff.range ?? outerRadius;
  const lightZ = eff.z ?? DEFAULT_LIGHT_Z;

  // Cull lights whose bounding circle doesn't touch the lightmap canvas.
  // Avoids running computeVisibility (which does ray casts against every
  // nearby wall endpoint) on lights that can never contribute a pixel.
  // `transform` is the lightmap transform, so (x,y)*scale+offset lands in
  // lctx.canvas-space directly.
  const cxPx = eff.x * transform.scale + transform.offsetX;
  const cyPx = eff.y * transform.scale + transform.offsetY;
  const rPx = effectiveRadius * transform.scale;
  const vpW = lctx.canvas.width;
  const vpH = lctx.canvas.height;
  if (cxPx + rPx < 0 || cxPx - rPx > vpW || cyPx + rPx < 0 || cyPx - rPx > vpH) {
    return;
  }

  const cacheKey = `${light.id}:${eff.x},${eff.y},${lightZ},${effectiveRadius}`;
  let visibility = visibilityCache.get(cacheKey);
  if (!visibility) {
    visibility = computeVisibility(eff.x, eff.y, effectiveRadius, segments);
    visibilityCache.set(cacheKey, visibility);
  }

  // Compute z-height prop shadow polygons for this light. Shadow geometry
  // only depends on light position+z+radius and prop zones (both invalidated
  // via invalidateVisibilityCache → propShadowsCache.clear), so animated
  // flicker/pulse lights that only vary intensity reuse the cached polygons.
  let propShadows = propShadowsCache.get(cacheKey);
  if (!propShadows) {
    propShadows = [];
    if (propShadowIndex.size > 0) {
      const rSq = effectiveRadius * effectiveRadius;
      // query() pre-filters to zones whose bucket overlaps the light's bbox;
      // the centroid distance check catches the remaining buckets near the
      // corners of the bbox that fall outside the actual circle.
      for (const zone of propShadowIndex.query(eff.x, eff.y, effectiveRadius)) {
        const dx = zone.centroidX - eff.x;
        const dy = zone.centroidY - eff.y;
        if (dx * dx + dy * dy > rSq) continue;
        const shadow = computePropShadowPolygon(
          eff.x,
          eff.y,
          lightZ,
          zone.worldPolygon,
          zone.zBottom,
          zone.zTop,
          effectiveRadius,
        );
        if (shadow) propShadows.push(shadow);
      }
    }
    propShadowsCache.set(cacheKey, propShadows);
  }
  // Attach shadow data to the effective light so render functions can use it
  eff._propShadows = propShadows;

  if (eff.type === 'directional') {
    renderDirectionalLight(lctx, eff, visibility, transform);
    return;
  }

  // Bake-cache fast path: flicker/pulse/strobe animations that only vary
  // intensity (no radiusVariation) reuse a composited RT across frames —
  // per-frame cost collapses to one `drawImage` with `globalAlpha`.
  // destination-in (visibility) and destination-out (prop shadows) both
  // commute with globalAlpha scaling, so the result is identical.
  const anim = light.animation;
  const intensityOnly =
    !!anim?.type &&
    !(anim.radiusVariation && anim.radiusVariation > 0) &&
    (anim.type === 'flicker' || anim.type === 'pulse' || anim.type === 'strobe');
  if (intensityOnly) {
    const bakeKey = `${light.id}:${transform.scale.toFixed(3)}`;
    let baked = bakedLightCache.get(bakeKey);
    if (baked?.scale !== transform.scale) {
      const vpW2 = lctx.canvas.width;
      const vpH2 = lctx.canvas.height;
      // Bake the light with propShadows attached at intensity=1.
      const bakeLight: Light = { ...light, intensity: 1, _propShadows: propShadows };
      baked = _bakePointLight(bakeLight, visibility, transform, vpW2, vpH2) ?? undefined;
      if (baked) bakedLightCache.set(bakeKey, baked);
    }
    if (baked) {
      const alpha = Math.max(0, Math.min(1, eff.intensity));
      lctx.save();
      lctx.globalAlpha = alpha;
      lctx.drawImage(baked.canvas, baked.bbX, baked.bbY);
      lctx.restore();
      return;
    }
  }

  renderPointLight(lctx, eff, visibility, transform);
}

// ─── Simplified Normal Map Bump Effect ─────────────────────────────────────

/**
 * Apply a simplified bump effect using normal maps.
 * For each lit cell with a normal map, sample the normal map at a few points
 * and modulate brightness based on how much the surface faces "up" (Z component).
 *
 * This is a subtle effect — not per-pixel lighting, but a per-cell brightness
 * modifier that gives textured surfaces visual depth under lighting.
 */
// Reusable temp canvas for normal map sampling (avoids per-cell allocation)
const BUMP_SAMPLE_SIZE = 4;
let bumpTmpCanvas = null;
let bumpTmpCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

function getBumpTmpCtx() {
  if (!bumpTmpCtx) {
    if (typeof OffscreenCanvas !== 'undefined') {
      bumpTmpCanvas = new OffscreenCanvas(BUMP_SAMPLE_SIZE, BUMP_SAMPLE_SIZE);
    } else {
      bumpTmpCanvas = document.createElement('canvas');
      bumpTmpCanvas.width = BUMP_SAMPLE_SIZE;
      bumpTmpCanvas.height = BUMP_SAMPLE_SIZE;
    }
    bumpTmpCtx = bumpTmpCanvas.getContext('2d', { willReadFrequently: true }) as typeof bumpTmpCtx;
  }
  return bumpTmpCtx;
}

function applyNormalMapBump(
  lctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  lights: Light[],
  cells: CellGrid,
  gridSize: number,
  transform: RenderTransform,
  textureCatalog: TextureCatalog | null,
) {
  if (!textureCatalog) return;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const tmpCtx = getBumpTmpCtx()!;

  // Use 'multiply' for darkening areas with steep normals
  lctx.save();
  lctx.globalCompositeOperation = 'multiply';

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]![col];
      if (!cell?.texture) continue;

      const texId = cell.texture;
      const entry = textureCatalog.textures[texId];
      if (!entry?.norImg?.complete) continue;

      // Compute dominant light direction at cell center
      const cellCenterX = (col + 0.5) * gridSize;
      const cellCenterY = (row + 0.5) * gridSize;

      let totalLightX = 0,
        totalLightY = 0,
        totalIntensity = 0;
      for (const light of lights) {
        const dx = light.x - cellCenterX;
        const dy = light.y - cellCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const effectiveRadius = (light.range ?? light.radius) || 30;
        if (dist > effectiveRadius) continue;
        const weight = falloffMultiplier(dist, effectiveRadius, light.falloff) * light.intensity;
        if (weight < 0.01) continue;
        totalLightX += (dx / (dist || 1)) * weight;
        totalLightY += (dy / (dist || 1)) * weight;
        totalIntensity += weight;
      }

      if (totalIntensity < 0.01) continue;

      // Normalize light direction (in 2D, pointing from cell toward light)
      const lenXY = Math.sqrt(totalLightX * totalLightX + totalLightY * totalLightY);
      // Light direction as a 3D vector: (lx, ly, 0.7) normalized — slight top-down bias
      const lx3 = lenXY > 0 ? (totalLightX / lenXY) * 0.5 : 0;
      const ly3 = lenXY > 0 ? (totalLightY / lenXY) * 0.5 : 0;
      const lz3 = 0.7;
      const lLen = Math.sqrt(lx3 * lx3 + ly3 * ly3 + lz3 * lz3);

      // Sample normal map at 4x4 grid and average the dot product
      const norImg = entry.norImg;
      const texScale = (entry as unknown as { scale?: number }).scale ?? 2;
      const imgW = norImg.width;
      const imgH = norImg.height;
      const srcX = ((col % texScale) / texScale) * imgW;
      const srcY = ((row % texScale) / texScale) * imgH;
      const srcW = imgW / texScale;
      const srcH = imgH / texScale;

      tmpCtx.clearRect(0, 0, BUMP_SAMPLE_SIZE, BUMP_SAMPLE_SIZE);
      tmpCtx.drawImage(norImg, srcX, srcY, srcW, srcH, 0, 0, BUMP_SAMPLE_SIZE, BUMP_SAMPLE_SIZE);
      const imageData = tmpCtx.getImageData(0, 0, BUMP_SAMPLE_SIZE, BUMP_SAMPLE_SIZE);
      const data = imageData.data;

      let dotSum = 0;
      let sampleCount = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [nx, ny, nz] = unpackNormal(data, i);

        // Dot product with light direction
        const dot = (nx * lx3 + ny * ly3 + nz * lz3) / lLen;
        dotSum += Math.max(0, dot);
        sampleCount++;
      }

      if (sampleCount === 0) continue;
      const avgDot = dotSum / sampleCount;

      // Map to a subtle brightness range: 0.85 (steep surfaces) to 1.1 (flat/aligned surfaces)
      const bumpFactor = 0.85 + avgDot * 0.25;
      const bumpByte = Math.round(Math.max(0, Math.min(255, bumpFactor * 255)));

      // Draw cell overlay
      const px = col * gridSize * transform.scale + transform.offsetX;
      const py = row * gridSize * transform.scale + transform.offsetY;
      const pSize = gridSize * transform.scale;

      lctx.fillStyle = `rgb(${bumpByte}, ${bumpByte}, ${bumpByte})`;
      lctx.fillRect(px, py, pSize, pSize);
    }
  }

  lctx.restore();
}

// ─── Coverage Heatmap ──────────────────────────────────────────────────────

/**
 * Render a coverage heatmap overlay showing total light intensity per cell.
 * Useful during DM prep to identify unlit zones at a glance.
 *
 * Color gradient:
 *   0.00 → 0.25  black → dark blue  (unlit / very dim)
 *   0.25 → 0.60  dark blue → yellow (moderate coverage)
 *   0.60 → 1.00  yellow → white     (well-lit, clamped at total ≥ 2.0)
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} lights
 * @param {Array} cells
 * @param {number} gridSize
 * @param {Object} transform - {offsetX, offsetY, scale}
 * @returns {void}
 */
export function renderCoverageHeatmap(
  ctx: CanvasRenderingContext2D,
  lights: Light[],
  cells: CellGrid,
  gridSize: number,
  transform: RenderTransform,
): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const activeLights = lights;

  ctx.save();
  ctx.globalAlpha = 0.65;

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]![col];
      if (!cell) continue;

      const cellCenterX = (col + 0.5) * gridSize;
      const cellCenterY = (row + 0.5) * gridSize;

      // Sum falloff contributions from all lights
      let total = 0;
      for (const light of activeLights) {
        const dx = light.x - cellCenterX;
        const dy = light.y - cellCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const radius = (light.range ?? light.radius) || 30;
        if (dist > radius) continue;
        total += falloffMultiplier(dist, radius, light.falloff) * light.intensity;
      }

      // Normalize to [0,1], clamp at total ≥ 2.0
      const t = Math.min(1, total / 2.0);
      let cr, cg, cb;
      if (t < 0.25) {
        const s = t / 0.25;
        cr = 0;
        cg = 0;
        cb = Math.round(s * 180);
      } else if (t < 0.6) {
        const s = (t - 0.25) / 0.35;
        cr = Math.round(s * 255);
        cg = Math.round(s * 200);
        cb = Math.round(180 * (1 - s));
      } else {
        const s = (t - 0.6) / 0.4;
        cr = 255;
        cg = Math.round(200 + s * 55);
        cb = Math.round(s * 255);
      }

      const px = col * gridSize * transform.scale + transform.offsetX;
      const py = row * gridSize * transform.scale + transform.offsetY;
      const pSize = gridSize * transform.scale;

      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillRect(px, py, pSize, pSize);
    }
  }

  ctx.restore();
}

// ─── Fill-Based Synthetic Lights ───────────────────────────────────────────

/**
 * Generate synthetic point lights for fill cells that should emit light (e.g. lava).
 * Called before renderLightmap / renderLightmapHQ whenever lighting is enabled.
 * Color and intensity are read from the resolved theme so themeOverrides apply automatically.
 *
 * @param {Array} cells - 2D cell grid
 * @param {number} gridSize - World feet per grid square
 * @param {object} theme - Resolved theme object (including any themeOverrides)
 * @returns {Array} Light objects ready for renderLightmap / renderLightmapHQ
 */
let _fillLightsCache: {
  cells: CellGrid;
  gridSize: number;
  color: string;
  intensity: number;
  version: number;
  lights: Light[];
} | null = null;

export function extractFillLights(
  cells: CellGrid,
  gridSize: number,
  theme: Theme | Record<string, unknown> = {},
): Light[] {
  const color = (theme as Record<string, unknown>).lavaLightColor as string;
  const intensity = (theme as Record<string, unknown>).lavaLightIntensity as number;

  // Fill lights only change when cells, gridSize, or the lava theme colors change.
  // `_lightingVersion` is bumped by `invalidateVisibilityCache` — which is called
  // by `smartInvalidate` on any fluid-involving cell edit and by the theme-change
  // pipeline on lava-light bucket changes. So keying on it covers the common cases.
  if (
    _fillLightsCache?.cells === cells &&
    _fillLightsCache.gridSize === gridSize &&
    _fillLightsCache.color === color &&
    _fillLightsCache.intensity === intensity &&
    _fillLightsCache.version === _lightingVersion
  ) {
    return _fillLightsCache.lights;
  }

  const lights: Light[] = [];
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  // ── Step 1: flood-fill connected lava regions ──────────────────────────────
  const visited = new Set();
  const regions = [];

  for (let r0 = 0; r0 < numRows; r0++) {
    for (let c0 = 0; c0 < numCols; c0++) {
      if (visited.has(`${r0},${c0}`)) continue;
      if (cells[r0]?.[c0]?.fill !== 'lava') continue;

      const region = [];
      const queue = [[r0, c0]];
      visited.add(`${r0},${c0}`);
      while (queue.length > 0) {
        const [r, c] = queue.shift()! as [number, number];
        region.push([r, c]);
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const nr = r + dr,
            nc = c + dc;
          const nk = `${nr},${nc}`;
          if (visited.has(nk)) continue;
          if (cells[nr]?.[nc]?.fill !== 'lava') continue;
          visited.add(nk);
          queue.push([nr, nc]);
        }
      }
      regions.push(region);
    }
  }

  // ── Step 2: place lights for each region ───────────────────────────────────
  for (const region of regions) {
    const area = region.length;
    const regionSet = new Set(region.map(([r, c]) => `${r},${c}`));
    const placed = new Set();

    // Spacing (cells between light centres): scales with pool area so large
    // pools don't stack hundreds of overlapping lights.
    //   area ≤ 4   → single centroid light
    //   area ≤ 25  → spacing 2
    //   area ≤ 100 → spacing 3
    //   area > 100 → spacing 4
    let spacing;
    if (area <= 4) {
      spacing = null;
    } else if (area <= 25) {
      spacing = 2;
    } else if (area <= 100) {
      spacing = 3;
    } else {
      spacing = 4;
    }

    const pushLight = (r: number, c: number) => {
      const id = `fill-lava-${r}-${c}`;
      if (placed.has(id)) return;
      placed.add(id);
      lights.push({
        id: parseInt(id.replace(/\D/g, '')) || 0,
        x: (c + 0.5) * gridSize,
        y: (r + 0.5) * gridSize,
        type: 'point',
        radius: 0,
        dimRadius: gridSize * 4,
        color,
        intensity,
        falloff: 'smooth',
      } as Light);
    };

    if (spacing === null) {
      // Tiny pool: one light at the cell closest to the centroid
      const avgR = region.reduce((s, [r]) => s + r!, 0) / area;
      const avgC = region.reduce((s, [, c]) => s + c!, 0) / area;
      const [br, bc] = region.reduce((best, [r, c]) => {
        const d = (r! - avgR) ** 2 + (c! - avgC) ** 2;
        const bd = (best[0]! - avgR) ** 2 + (best[1]! - avgC) ** 2;
        return d < bd ? [r!, c!] : best;
      }, region[0]!) as [number, number];
      pushLight(br, bc);
    } else {
      // Larger pool: regular grid anchored to the bounding box.
      // Each grid point snaps to the nearest lava cell within spacing/2
      // so irregular shapes still get full coverage.
      let minR = Infinity,
        maxR = -Infinity,
        minC = Infinity,
        maxC = -Infinity;
      for (const [r, c] of region as [number, number][]) {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }

      // Centre the grid within the bounding box
      const rowOff = Math.floor(((maxR - minR) % spacing) / 2);
      const colOff = Math.floor(((maxC - minC) % spacing) / 2);
      const snap = Math.ceil(spacing / 2);

      for (let gr = minR + rowOff; gr <= maxR; gr += spacing) {
        for (let gc = minC + colOff; gc <= maxC; gc += spacing) {
          // Find the nearest lava cell to this grid point
          let bestR = -1,
            bestC = -1,
            bestD = Infinity;
          for (let dr = -snap; dr <= snap; dr++) {
            for (let dc = -snap; dc <= snap; dc++) {
              if (!regionSet.has(`${gr + dr},${gc + dc}`)) continue;
              const d = dr * dr + dc * dc;
              if (d < bestD) {
                bestD = d;
                bestR = gr + dr;
                bestC = gc + dc;
              }
            }
          }
          if (bestR !== -1) pushLight(bestR, bestC);
        }
      }
    }
  }

  _fillLightsCache = { cells, gridSize, color, intensity, version: _lightingVersion, lights };
  return lights;
}
