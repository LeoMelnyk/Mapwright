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
  extractGoboZones,
  extractWindowGoboZones,
  buildGoboIndex,
  computeGoboProjectionPolygon,
  DEFAULT_LIGHT_Z,
  PropShadowIndex,
  GoboIndex,
  type WallSegment,
  type GoboZone,
} from './lighting-geometry.js';
import { _t } from './render-state.js';
import {
  INVERSE_SQUARE_K,
  RAY_EPSILON,
  ANIM_TIME_SCALE,
  GRADIENT_STOPS,
  FLICKER_FREQS,
  FLICKER_WEIGHTS,
  FLICKER_RADIUS_FREQ,
  BUMP_SAMPLE_SIZE,
  BUMP_RT_BASE,
  BUMP_RT_SPAN,
  BUMP_LIGHT_HEIGHT_FRAC,
  DEFAULT_CONE_SPREAD_DEG,
  CONE_SPREAD_MIN_DEG,
  CONE_SPREAD_MAX_DEG,
  SOFT_SHADOW_SAMPLES,
  SOFT_SHADOW_GOLDEN_ANGLE,
  COLOR_SHIFT_MAX_DEG,
  STRIKE_DEFAULT_FREQUENCY,
  STRIKE_DEFAULT_DURATION,
  STRIKE_DEFAULT_PROBABILITY,
  STRIKE_DEFAULT_BASELINE,
} from './lighting-config.js';
import { log } from '../util/index.js';
import { applyGobosToRT } from './gobo.js';

// Re-export geometry helpers so existing importers (render barrel, editor)
// keep working without ripple after the split.
export {
  extractWallSegments,
  extractPropShadowZones,
  buildPropShadowIndex,
  computePropShadowPolygon,
  extractGoboZones,
  extractWindowGoboZones,
  buildGoboIndex,
  computeGoboProjectionPolygon,
  DEFAULT_LIGHT_Z,
  PropShadowIndex,
  GoboIndex,
};
export type { WallSegment, GoboZone };

// ─── Constants ─────
// Tunable numbers live in lighting-config.ts. Only re-local wrappers for
// derived/cached values stay here.

/**
 * Convert a color temperature in Kelvin to an approximate sRGB hex string.
 *
 * Uses the Tanner Helland approximation — fast enough for a UI slider and
 * visually indistinguishable from higher-fidelity blackbody models for the
 * 1000–12000 K range we care about (candlelight → icy midnight sky). The
 * result is clamped per channel and returned as `#rrggbb`.
 *
 * Common reference points:
 *   1500 K — candle
 *   2000 K — dim incandescent / firelight
 *   3000 K — warm interior lamp
 *   4000 K — neutral white
 *   5500 K — daylight
 *   6500 K — overcast sky
 *   8000 K — cool shade
 *  10000 K — deep blue (cave bioluminescence, moonlit water)
 */
export function kelvinToRgb(kelvinIn: number): string {
  const k = Math.max(1000, Math.min(40000, kelvinIn)) / 100;
  let r: number, g: number, b: number;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
  }
  if (k >= 66) b = 255;
  else if (k <= 19) b = 0;
  else b = 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const hx = (v: number) => clamp(v).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

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
  const s = spread ?? DEFAULT_CONE_SPREAD_DEG;
  if (!Number.isFinite(s)) return DEFAULT_CONE_SPREAD_DEG;
  return Math.max(CONE_SPREAD_MIN_DEG, Math.min(CONE_SPREAD_MAX_DEG, s));
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
 * Per-light pooled "effective" buffer. getEffectiveLight rewrites the buffer
 * in place each frame instead of spreading `{...light}` into a fresh object,
 * dropping 50 light × 60 fps ≈ 3000 short-lived allocations/sec on maps with
 * heavy animation. WeakMap keeps us tied to the source light's lifetime, so
 * removing a light frees its buffer automatically.
 */
const effBufCache = new WeakMap<Light, Light>();

// ─── Deterministic helpers used by animation ───────────────────────────────

/** Cheap 32-bit integer hash (Wang). Returns a uniform value in [0, 1). */
function hash32(n: number): number {
  let x = n | 0;
  x = x ^ 61 ^ (x >>> 16);
  x = x + (x << 3);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return ((x >>> 0) % 0xffffff) / 0xffffff;
}

/**
 * Smooth 1D simplex-style noise. Pure JS, no dependency. Period-free for the
 * timescales we care about (animation runs in seconds, the cubic interpolant
 * between integer "lattice" points is C1 continuous and visually featureless).
 * Output range is roughly [-1, 1].
 */
function noise1D(x: number, seed: number): number {
  const xi = Math.floor(x);
  const xf = x - xi;
  const a = hash32(xi * 374761393 + seed * 668265263) * 2 - 1;
  const b = hash32((xi + 1) * 374761393 + seed * 668265263) * 2 - 1;
  const t = xf * xf * (3 - 2 * xf); // smoothstep
  return a * (1 - t) + b * t;
}

/**
 * Convert hex `#RRGGBB` to HSL, shift hue/saturation/lightness, and emit a
 * fresh hex string. Used by `colorMode: 'auto'` to red-shift a flickering
 * flame as its intensity dips.
 */
function shiftHexHue(hex: string, hueDeltaDeg: number, lightnessDelta = 0): string {
  const { r, g, b } = parseColor(hex);
  const rN = r / 255,
    gN = g / 255,
    bN = b / 255;
  const max = Math.max(rN, gN, bN),
    min = Math.min(rN, gN, bN);
  const l0 = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l0 > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rN) h = ((gN - bN) / d + (gN < bN ? 6 : 0)) * 60;
    else if (max === gN) h = ((bN - rN) / d + 2) * 60;
    else h = ((rN - gN) / d + 4) * 60;
  }
  const h2 = (((h + hueDeltaDeg) % 360) + 360) % 360;
  const l2 = Math.max(0, Math.min(1, l0 + lightnessDelta));
  // HSL → RGB
  const c = (1 - Math.abs(2 * l2 - 1)) * s;
  const hp = h2 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0,
    g1 = 0,
    b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l2 - c / 2;
  const hx = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${hx(r1)}${hx(g1)}${hx(b1)}`;
}

/** Linearly blend two hex colors. mix=0 → a, mix=1 → b. */
function mixHex(a: string, b: string, mix: number): string {
  const ca = parseColor(a),
    cb = parseColor(b);
  const m = Math.max(0, Math.min(1, mix));
  const lerp = (u: number, v: number) => Math.round(u + (v - u) * m);
  const hx = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hx(lerp(ca.r, cb.r))}${hx(lerp(ca.g, cb.g))}${hx(lerp(ca.b, cb.b))}`;
}

/** Strike envelope: sharp attack, exponential decay. Input/output in [0,1]. */
function strikeEnvelope(t: number): number {
  if (t < 0 || t > 1) return 0;
  // Fast attack (first 15%), exponential decay through the rest.
  if (t < 0.15) return t / 0.15;
  return Math.exp(-((t - 0.15) / 0.25));
}

// ─── Group transition state (runtime, not persisted) ───────────────────────
//
// `setLightGroupEnabled(group, bool, { transition })` writes here so the
// renderer can ramp the group's effective intensity over a few hundred ms
// instead of hard-cutting. Cleared automatically once a transition completes.

interface GroupTransition {
  toEnabled: boolean;
  startedAt: number; // monotonic seconds (matches `time` passed to renderLightmap)
  durationMs: number;
  envelope: 'simple-fade' | 'ignite' | 'extinguish';
  /** Snapshotted from-value (0..1) so re-toggles mid-transition stay smooth. */
  fromValue: number;
}

const groupTransitions = new Map<string, GroupTransition>();

/**
 * Begin a fade transition for a light group. The renderer reads back the
 * current ramp value via `getGroupIntensityScale` each frame, and clears
 * the entry once the transition has elapsed.
 */
export function beginGroupTransition(
  group: string,
  toEnabled: boolean,
  envelope: 'simple-fade' | 'ignite' | 'extinguish' = 'simple-fade',
  durationMs = 600,
  now = performance.now() / 1000,
): void {
  const prev = groupTransitions.get(group);
  // Snapshot whatever the current effective value is, so re-toggling mid-fade
  // doesn't pop. If no prior transition, assume the inverse of the new target.
  const fromValue = prev ? getGroupIntensityScale(group, now) : toEnabled ? 0 : 1;
  groupTransitions.set(group, { toEnabled, startedAt: now, durationMs, envelope, fromValue });
  // Lights in this group must move from the static-baked layer onto the
  // animated overlay until the ramp finishes. Drop the static cache so the
  // next frame rebuilds with the new partition.
  _staticLmValid = false;
  _lastRenderLightmapKey = null;
}

/**
 * Effective intensity scale (0..1) for a group at a given time. Returns 1
 * for groups with no active transition (no fade in progress).
 */
export function getGroupIntensityScale(group: string | undefined, time: number): number {
  if (!group) return 1;
  const t = groupTransitions.get(group);
  if (!t) return 1;
  const elapsed = (time - t.startedAt) * 1000;
  const u = Math.max(0, Math.min(1, elapsed / t.durationMs));
  if (u >= 1) {
    return t.toEnabled ? 1 : 0;
  }
  const target = t.toEnabled ? 1 : 0;
  // Envelope-shaped lerp. simple-fade is smoothstep; ignite/extinguish
  // overshoot briefly to give a "warm-up" or "guttering" feel.
  const ease = u * u * (3 - 2 * u);
  let v = t.fromValue + (target - t.fromValue) * ease;
  if (t.envelope === 'ignite' && t.toEnabled) {
    // Brief flicker midway through the ramp-up.
    v *= 1 + 0.35 * Math.sin(u * Math.PI * 6) * (1 - u);
  } else if (t.envelope === 'extinguish' && !t.toEnabled) {
    // Gutter: spike at ~80% of the way, then collapse.
    if (u > 0.5 && u < 0.85) v += (0.4 * (u - 0.5)) / 0.35;
  }
  return Math.max(0, Math.min(1.5, v));
}

/** Enumerate all groups currently mid-transition (used by render loop to keep ticking). */
export function hasActiveGroupTransitions(): boolean {
  return groupTransitions.size > 0;
}

/** Drop transition state (e.g. on map load). */
export function clearGroupTransitions(): void {
  groupTransitions.clear();
}

/**
 * Return an effective (possibly animated) copy of a light for the given time.
 * Non-animated lights pass through unchanged (no allocation). Animated lights
 * get a per-light pooled buffer — callers must treat the returned object as
 * ephemeral (read-and-forget within the current frame).
 *
 * Honors:
 *   - phase offset (per-light desync; `phase: 0` for explicit sync)
 *   - flicker pattern: `sine` (default) | `noise`
 *   - guttering envelope on top of any flicker
 *   - color modulation (`colorMode: auto | secondary`)
 *   - radius variation on flicker / pulse / strobe
 *   - strike (lightning) deterministic windowed flashes
 *   - sweep (lighthouse) angle animation for directional lights
 *   - group transitions (fade / ignite / extinguish via beginGroupTransition)
 */
export function getEffectiveLight(light: Light, time: number): Light {
  const groupScale = getGroupIntensityScale(light.group, time);
  if (!light.animation?.type) {
    if (groupScale === 1) return light;
    // Group transition only — return a buffer with scaled intensity.
    let result = effBufCache.get(light);
    if (!result) {
      result = {} as Light;
      effBufCache.set(light, result);
    }
    Object.assign(result, light);
    result._propShadows = undefined;
    result._gobos = undefined;
    result.intensity = Math.max(0, light.intensity * groupScale);
    return result;
  }

  const a = light.animation;
  const speed = a.speed ?? 1.0;
  const amplitude = a.amplitude ?? 0.3;
  const radiusVariation = a.radiusVariation ?? 0;
  // Per-light phase offset. Defaults to a deterministic id-derived value so
  // identical-speed lights desync naturally — pass `phase: 0` to force sync.
  const phase = a.phase ?? hash32(light.id * 2654435761) * 1000;
  const t = (time + phase) * speed * ANIM_TIME_SCALE;

  let intensityMult = 1.0;
  let radiusMult = 1.0;
  let angleOverride: number | null = null;

  switch (a.type) {
    case 'flicker': {
      if (a.pattern === 'noise') {
        // Three octaves of 1D noise (frequencies tuned for "wind-buffeted").
        const n =
          0.55 * noise1D(t * 4.0, light.id) +
          0.3 * noise1D(t * 9.0 + 17, light.id ^ 0x9e37) +
          0.15 * noise1D(t * 19.0 + 41, light.id ^ 0x14d3);
        intensityMult = 1 + amplitude * n;
      } else {
        const [f1, f2, f3] = FLICKER_FREQS;
        const [w1, w2, w3] = FLICKER_WEIGHTS;
        intensityMult = 1 + amplitude * (w1 * Math.sin(t * f1) + w2 * Math.sin(t * f2) + w3 * Math.sin(t * f3));
      }
      break;
    }
    case 'pulse':
      intensityMult = 1 + amplitude * Math.sin(2 * Math.PI * t);
      break;
    case 'strobe':
      intensityMult = t % 1 < 0.5 ? 1 + amplitude : Math.max(0, 1 - amplitude);
      break;
    case 'strike': {
      // Deterministic windowed strike: each window of `1/frequency` seconds
      // either flashes (with envelope) or holds at baseline. Stateless.
      const freq = a.frequency ?? STRIKE_DEFAULT_FREQUENCY;
      const dur = a.duration ?? STRIKE_DEFAULT_DURATION;
      const prob = a.probability ?? STRIKE_DEFAULT_PROBABILITY;
      const baseline = a.baseline ?? STRIKE_DEFAULT_BASELINE;
      const win = 1 / Math.max(0.001, freq);
      const idx = Math.floor(t / win);
      const localT = (t - idx * win) / win; // 0..1
      const roll = hash32((light.id * 2654435761) ^ idx);
      if (roll < prob && localT < dur) {
        const env = strikeEnvelope(localT / dur);
        intensityMult = baseline + (1 + amplitude) * env;
      } else {
        intensityMult = baseline;
      }
      break;
    }
    case 'sweep': {
      // Rotate the directional light's angle (stored in degrees).
      const angularSpeed = a.angularSpeed ?? 60;
      const baseDeg = light.angle ?? 0;
      const tSec = (time + phase) * speed;
      if (a.arcRange && a.arcRange > 0) {
        // Triangle wave oscillation within ±arcRange/2 of arcCenter.
        const center = a.arcCenter ?? baseDeg;
        const span = a.arcRange / 2;
        const period = (4 * span) / Math.max(0.001, Math.abs(angularSpeed));
        const u = (((tSec % period) + period) % period) / period; // 0..1
        const x = u < 0.5 ? -span + 4 * span * u : 3 * span - 4 * span * u;
        angleOverride = center + x;
      } else {
        angleOverride = baseDeg + angularSpeed * tSec;
      }
      break;
    }
  }

  // Radius variation now applies to all sine-driven anim types (flicker, pulse, strobe).
  if (radiusVariation > 0 && (a.type === 'flicker' || a.type === 'pulse' || a.type === 'strobe')) {
    radiusMult = 1 + radiusVariation * Math.sin(t * FLICKER_RADIUS_FREQ);
  }

  // Guttering envelope: occasionally drop a flicker/strike to near-zero to
  // simulate a dying flame. Multiplier ranges from `(1 - guttering)` to 1.
  if (a.guttering && a.guttering > 0) {
    // Slow noise gates a temporary dropout.
    const g = noise1D(t * 0.7, light.id ^ 0xbeef);
    const dropMask = Math.max(0, g - (1 - a.guttering)); // 0..guttering
    intensityMult *= 1 - dropMask;
  }

  // Reuse a per-light buffer
  let result = effBufCache.get(light);
  if (!result) {
    result = {} as Light;
    effBufCache.set(light, result);
  }
  Object.assign(result, light);
  result._propShadows = undefined;

  // Apply group transition scale.
  intensityMult *= groupScale;

  result.intensity = Math.max(0.01, light.intensity * Math.max(0, intensityMult));
  if (light.radius && radiusMult !== 1.0) result.radius = Math.max(1, light.radius * Math.max(0.1, radiusMult));
  if (light.range && radiusMult !== 1.0) result.range = Math.max(1, light.range * Math.max(0.1, radiusMult));
  if (angleOverride !== null) result.angle = angleOverride;

  // Color modulation. `auto` shifts hue toward red as intensity dips below
  // baseline (physical flame-redshift model, so only below-baseline counts).
  // `secondary` blends `color ↔ colorSecondary` symmetrically around baseline
  // — the secondary shows during the bright peak as well as the dim trough,
  // so a pulse/flicker visibly cycles through the two colors.
  if (a.colorMode && a.colorMode !== 'none' && light.color) {
    const cv = a.colorVariation ?? 0.5;
    if (a.colorMode === 'auto') {
      const dip = Math.max(0, Math.min(1, 1 - intensityMult));
      // Negative hue shift = redward (assumes warm starting hue ~30°). For
      // cool magical lights this still reads as "the color got darker and
      // shifted along its own hue ring," which is acceptable.
      result.color = shiftHexHue(light.color, -COLOR_SHIFT_MAX_DEG * dip * cv, -0.05 * dip * cv);
    } else if (a.colorSecondary) {
      // Symmetric deviation from baseline — peaks and troughs both shift.
      const dev = Math.min(1, Math.abs(1 - intensityMult));
      result.color = mixHex(light.color, a.colorSecondary, dev * cv);
    }
  }

  return result;
}

/**
 * Module-level frame time. Threaded into cookie animation through the per-
 * light composite path without changing every helper signature. Set at the
 * top of `_renderOneLight` (and friends) before the gradient is built.
 */
let _currentFrameTime = 0;

// ─── Procedural Cookies (gobos) ────────────────────────────────────────────
//
// Cookies are grayscale masks multiplied into a light's gradient before the
// visibility clip — they project patterns ("stained glass", "tree dapple",
// "prison bars") onto the lit area without needing external assets.
//
// Each cookie type renders once at a fixed size onto a reusable OffscreenCanvas
// and is then transformed (rotation/scroll/scale) per draw. Animated cookies
// re-transform per frame; the underlying texture is built once per type.

export const COOKIE_TEX_SIZE = 256;
const cookieTexCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

export function _allocCookieCanvas(): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  const c = document.createElement('canvas');
  c.width = COOKIE_TEX_SIZE;
  c.height = COOKIE_TEX_SIZE;
  return c;
}

function _drawCookieSlats(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  // Vertical bright slats: 6 bands.
  ctx.fillStyle = '#fff';
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const x = (i + 0.25) * (COOKIE_TEX_SIZE / bands);
    ctx.fillRect(x, 0, COOKIE_TEX_SIZE / bands / 2, COOKIE_TEX_SIZE);
  }
}

function _drawCookieDapple(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
  // Soft blobs (tree-canopy dapple).
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  for (let i = 0; i < 80; i++) {
    const cx = hash32(i * 17 + 1) * COOKIE_TEX_SIZE;
    const cy = hash32(i * 17 + 2) * COOKIE_TEX_SIZE;
    const r = 8 + hash32(i * 17 + 3) * 24;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
}

function _drawCookieCaustics(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
  // Wavy caustic-ish veins from sin interference.
  const img = ctx.createImageData(COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  const d = img.data;
  for (let y = 0; y < COOKIE_TEX_SIZE; y++) {
    for (let x = 0; x < COOKIE_TEX_SIZE; x++) {
      const u = x / COOKIE_TEX_SIZE;
      const v = y / COOKIE_TEX_SIZE;
      const a = Math.sin((u * 6 + Math.sin(v * 8) * 0.7) * Math.PI);
      const b = Math.sin((v * 5 + Math.cos(u * 11) * 0.4) * Math.PI);
      const w = Math.max(0, Math.abs(a) - 0.6) + Math.max(0, Math.abs(b) - 0.6);
      const lum = Math.min(255, Math.round(60 + w * 400));
      const i = (y * COOKIE_TEX_SIZE + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = lum;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function _drawCookieSigil(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  const cx = COOKIE_TEX_SIZE / 2;
  const cy = COOKIE_TEX_SIZE / 2;
  // Outer ring + inner ring + 7-pointed star.
  ctx.beginPath();
  ctx.arc(cx, cy, COOKIE_TEX_SIZE * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, COOKIE_TEX_SIZE * 0.28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * COOKIE_TEX_SIZE * 0.4;
    const y = cy + Math.sin(a) * COOKIE_TEX_SIZE * 0.4;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
}

function _drawCookieGrid(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  ctx.fillStyle = '#000';
  const step = COOKIE_TEX_SIZE / 8;
  const bar = step * 0.18;
  for (let i = 0; i < 9; i++) {
    ctx.fillRect(i * step - bar / 2, 0, bar, COOKIE_TEX_SIZE);
    ctx.fillRect(0, i * step - bar / 2, COOKIE_TEX_SIZE, bar);
  }
}

function _drawCookieStainedGlass(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
  // Voronoi-ish patches with dark leading.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  const sites: [number, number, number][] = [];
  for (let i = 0; i < 24; i++) {
    sites.push([
      hash32(i * 31 + 1) * COOKIE_TEX_SIZE,
      hash32(i * 31 + 2) * COOKIE_TEX_SIZE,
      0.55 + hash32(i * 31 + 3) * 0.45,
    ]);
  }
  const img = ctx.getImageData(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  const d = img.data;
  for (let y = 0; y < COOKIE_TEX_SIZE; y++) {
    for (let x = 0; x < COOKIE_TEX_SIZE; x++) {
      let best = Infinity,
        second = Infinity,
        bestIdx = 0;
      for (let i = 0; i < sites.length; i++) {
        const dx = x - sites[i]![0];
        const dy = y - sites[i]![1];
        const d2 = dx * dx + dy * dy;
        if (d2 < best) {
          second = best;
          best = d2;
          bestIdx = i;
        } else if (d2 < second) second = d2;
      }
      const edge = Math.sqrt(second) - Math.sqrt(best);
      const lead = edge < 3 ? 0 : 1;
      const lum = Math.round(255 * sites[bestIdx]![2] * lead);
      const i = (y * COOKIE_TEX_SIZE + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = lum;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function _getCookieTexture(type: string): OffscreenCanvas | HTMLCanvasElement | null {
  let tex = cookieTexCache.get(type);
  if (tex) return tex;
  tex = _allocCookieCanvas();
  const ctx = tex.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  switch (type) {
    case 'slats':
      _drawCookieSlats(ctx);
      break;
    case 'dapple':
      _drawCookieDapple(ctx);
      break;
    case 'caustics':
      _drawCookieCaustics(ctx);
      break;
    case 'sigil':
      _drawCookieSigil(ctx);
      break;
    case 'grid':
      _drawCookieGrid(ctx);
      break;
    case 'stained-glass':
      _drawCookieStainedGlass(ctx);
      break;
    default:
      return null;
  }
  cookieTexCache.set(type, tex);
  return tex;
}

/** List the names of every available procedural cookie. Exported for UI/API. */
export function listCookieTypes(): string[] {
  return ['slats', 'dapple', 'caustics', 'sigil', 'grid', 'stained-glass'];
}

/**
 * Apply a cookie mask onto the per-light RT (which already holds the
 * gradient). Composited with `multiply` so dark cookie pixels darken the
 * light, white pixels pass through. Caller is responsible for restoring
 * composite mode afterwards.
 */
function _applyCookieToRT(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cookie: NonNullable<Light['cookie']>,
  bbW: number,
  bbH: number,
  time: number,
  lightId: number,
  pxPerFoot: number,
) {
  const tex = _getCookieTexture(cookie.type);
  if (!tex) return;
  const scale = cookie.scale ?? 1;
  const phase = hash32(lightId * 1664525) * 1000;
  const rot = ((cookie.rotation ?? 0) + (cookie.rotationSpeed ?? 0) * (time + phase)) * (Math.PI / 180);
  const sx = (cookie.scrollX ?? 0) + (cookie.scrollSpeedX ?? 0) * (time + phase);
  const sy = (cookie.scrollY ?? 0) + (cookie.scrollSpeedY ?? 0) * (time + phase);
  const strength = Math.max(0, Math.min(1, cookie.strength ?? 1));
  if (strength === 0) return;

  gctx.save();
  gctx.globalCompositeOperation = 'multiply';
  gctx.globalAlpha = 1;
  // Center, rotate, scale — then tile the cookie texture so it always covers.
  gctx.translate(bbW / 2, bbH / 2);
  gctx.rotate(rot);
  // Cookie projection size. When `focusRadius` is set (typical for prop-
  // attached cookies like windows or grates), constrain the cookie to a
  // circle of that radius in feet — outside it, the cookie texture isn't
  // drawn so the gradient is preserved. This models the top-down reality
  // that a prop only projects its pattern onto the floor area immediately
  // beneath/beside it, not the entire light radius. Without focusRadius,
  // fall back to the legacy "cover the whole bbox" behavior.
  const cover =
    cookie.focusRadius != null ? cookie.focusRadius * 2 * pxPerFoot * scale : Math.max(bbW, bbH) * 1.5 * scale;
  gctx.scale(cover / COOKIE_TEX_SIZE, cover / COOKIE_TEX_SIZE);
  // Apply scroll (mod 1 wraps cleanly because the texture itself isn't tiled
  // here — for non-tile cookies the scroll just slides the visible window).
  gctx.translate(-COOKIE_TEX_SIZE / 2 + sx * COOKIE_TEX_SIZE, -COOKIE_TEX_SIZE / 2 + sy * COOKIE_TEX_SIZE);
  if (strength < 1) {
    // Blend the cookie with white at (1 - strength) so partial-strength
    // cookies fade toward "no cookie" instead of toward black.
    gctx.globalAlpha = strength;
  }
  gctx.drawImage(tex, 0, 0);
  // If strength < 1, also paint a white rect to blend toward "no mask".
  if (strength < 1) {
    gctx.globalCompositeOperation = 'lighter';
    gctx.globalAlpha = 1 - strength;
    gctx.fillStyle = '#ffffff';
    gctx.fillRect(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  }
  gctx.restore();
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
// Reusable offscreen canvas for the soft-shadow mask. Shared across every
// light in a frame to avoid per-light allocation.
let softMaskCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let softMaskCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
function ensureSoftMaskCanvas(w: number, h: number) {
  if (!softMaskCanvas || softMaskCanvas.width < w || softMaskCanvas.height < h) {
    // Split branches so TS narrows canvas → getContext return type in each
    // case instead of widening to the full RenderingContext union, which
    // would require an explicit cast the no-unnecessary-type-assertion rule
    // then strips back out.
    if (typeof OffscreenCanvas !== 'undefined') {
      softMaskCanvas = new OffscreenCanvas(Math.max(w, 64), Math.max(h, 64));
      softMaskCtx = softMaskCanvas.getContext('2d');
    } else {
      softMaskCanvas = Object.assign(document.createElement('canvas'), {
        width: Math.max(w, 64),
        height: Math.max(h, 64),
      });
      softMaskCtx = softMaskCanvas.getContext('2d');
    }
  }
  return softMaskCtx!;
}

/**
 * Rasterize N sample visibility polygons into a single averaged grayscale
 * mask, then destination-in the light's gradient against it. Rationale: the
 * outer gctx already holds the colored gradient; we don't want to overwrite
 * it with the mask, we want to restrict it proportionally.
 */
function _applySoftVisibilityMask(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  visibilities: Float32Array[],
  transform: RenderTransform,
  bbX: number,
  bbY: number,
  bbW: number,
  bbH: number,
) {
  const mctx = ensureSoftMaskCanvas(bbW, bbH);
  mctx.save();
  mctx.globalCompositeOperation = 'source-over';
  mctx.clearRect(0, 0, bbW, bbH);
  // Additively accumulate each sample polygon at alpha = 1/N so a pixel
  // visible from every sample reaches full alpha.
  const alpha = 1 / visibilities.length;
  mctx.globalCompositeOperation = 'lighter';
  mctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(4)})`;
  for (const vis of visibilities) {
    if (vis.length < 6) continue;
    clipToVisibility(mctx, vis, transform, bbX, bbY);
  }
  mctx.restore();

  // Apply mask: destination-in with the averaged grayscale — dimmer pixels
  // in the mask proportionally dim the colored gradient on gctx.
  gctx.save();
  gctx.globalCompositeOperation = 'destination-in';
  gctx.drawImage(softMaskCanvas!, 0, 0, bbW, bbH, 0, 0, bbW, bbH);
  gctx.restore();
}

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
export function buildRadialGradient(
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
 * Build a bright-plus-dim radial gradient matching what `buildPointLightComposite`
 * paints when `dimRadius > radius`. Inner region falls off normally out to
 * `rPx`, then holds at `dimIntensity` until the dim edge, then fades to 0.
 */
export function buildRadialGradientWithDim(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  relCx: number,
  relCy: number,
  rPx: number,
  dimRPx: number,
  r: number,
  g: number,
  b: number,
  intensity: number,
  lightRadius: number,
  falloff: FalloffType | string,
) {
  const dimIntensity = Math.min(1, intensity * 0.5);
  const brightFrac = rPx / dimRPx;
  const grad = gctx.createRadialGradient(relCx, relCy, 0, relCx, relCy, dimRPx);
  grad.addColorStop(0, `rgba(${r},${g},${b},${Math.min(1, intensity)})`);
  const numStops = 8;
  for (let i = 1; i < numStops; i++) {
    const t = i / numStops;
    const gradFrac = t * brightFrac;
    const mult = falloffMultiplier(t * lightRadius, lightRadius, falloff as FalloffType);
    const alpha = Math.max(dimIntensity, Math.min(1, intensity * mult));
    grad.addColorStop(gradFrac, `rgba(${r},${g},${b},${alpha.toFixed(4)})`);
  }
  grad.addColorStop(brightFrac, `rgba(${r},${g},${b},${dimIntensity})`);
  grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
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
  softVisibilities: Float32Array[] | null = null,
) {
  // Darkness lights paint BLACK into the lightmap (any brightness -> zero when
  // the lightmap is later multiplied onto the base). Same falloff shape as a
  // normal light, just with the RT's gradient color replaced so the outer
  // source-over composite simply overwrites ambient + accumulated lights.
  const { r, g, b } = light.darkness ? { r: 0, g: 0, b: 0 } : parseColor(light.color);
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

  // Cookie / gobo: multiply a procedural mask over the gradient before the
  // visibility clip. Skipped for darkness lights (the mask would just darken
  // already-black pixels with no visible effect). `transform.scale` is the
  // lightmap's pixels-per-foot, used by `focusRadius` to size the cookie in
  // world feet rather than viewport pixels.
  if (light.cookie && !light.darkness) {
    _applyCookieToRT(gctx, light.cookie, bbW, bbH, _currentFrameTime, light.id, transform.scale);
  }

  // Gobo projections run BEFORE the visibility clip: `multiply` composite
  // combines alpha additively (not multiplicatively), so drawing a gobo
  // pattern over an already-transparent region would make that region
  // opaque and leak bars into void/out-of-view cells. Applying before the
  // destination-in pass means the visibility clip trims the pattern to the
  // lit area just like it trims the gradient.
  if (!light.darkness && light._gobos?.length) {
    applyGobosToRT(gctx, light, transform, bbX, bbY, 'occluder');
  }

  if (softVisibilities && softVisibilities.length > 0) {
    // Soft shadows: average the sample polygons into a grayscale mask, then
    // destination-in against it. Walls seen by every sample stay fully lit;
    // corners seen by some samples fade toward dark, producing a penumbra.
    _applySoftVisibilityMask(gctx, softVisibilities, transform, bbX, bbY, bbW, bbH);
  } else {
    gctx.globalCompositeOperation = 'destination-in';
    gctx.fillStyle = '#ffffff';
    clipToVisibility(gctx, visibility, transform, bbX, bbY);
    gctx.globalCompositeOperation = 'source-over';
  }

  // Aperture gobos (windows) run AFTER the visibility clip. The wall blocks
  // light everywhere else, but the sunpool re-admission paints the gradient
  // back into the aperture's floor projection, followed by the pattern bars.
  if (!light.darkness && light._gobos?.length) {
    applyGobosToRT(gctx, light, transform, bbX, bbY, 'aperture');
  }

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
  softVisibilities: Float32Array[] | null = null,
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
  buildPointLightComposite(
    gctx,
    light,
    visibility,
    transform,
    bbX,
    bbY,
    bbW,
    bbH,
    cx,
    cy,
    rPx,
    dimRPx,
    softVisibilities,
  );
  if (light.darkness) {
    // The RT gradient is already colored black for darkness lights. Use
    // source-over so the black pixels OVERWRITE ambient + any accumulated
    // lights at the center of the radius, fading to transparent (no-op) at
    // the edge. Final multiply step turns black lightmap pixels into black
    // scene pixels — true magical darkness, even darkvision-proof.
    lctx.save();
    lctx.globalCompositeOperation = 'source-over';
    lctx.drawImage(lightRTCanvas!, 0, 0, bbW, bbH, bbX, bbY, bbW, bbH);
    lctx.restore();
  } else {
    lctx.drawImage(lightRTCanvas!, 0, 0, bbW, bbH, bbX, bbY, bbW, bbH);
  }
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
  softVisibilities: Float32Array[] | null = null,
): BakedLight | null {
  const { cx, cy, rPx, dimRPx, bbX, bbY, bbW, bbH } = _computePointLightBBox(light, transform, vpW, vpH);
  if (!Number.isFinite(bbW) || !Number.isFinite(bbH) || bbW <= 0 || bbH <= 0) return null;
  const canvas = _allocateBakedCanvas(bbW, bbH);
  const gctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  // Bake at intensity=1 so per-frame globalAlpha scales the whole composite.
  const bakeLight: Light = { ...light, intensity: 1 };
  buildPointLightComposite(
    gctx,
    bakeLight,
    visibility,
    transform,
    bbX,
    bbY,
    bbW,
    bbH,
    cx,
    cy,
    rPx,
    dimRPx,
    softVisibilities,
  );
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
  softVisibilities: Float32Array[] | null = null,
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

  // Occluder gobos — see the point-light path for the ordering rationale.
  if (light._gobos?.length) {
    applyGobosToRT(gctx, light, transform, bbX, bbY, 'occluder');
  }

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
  if (softVisibilities && softVisibilities.length > 0) {
    _applySoftVisibilityMask(gctx, softVisibilities, transform, bbX, bbY, bbW, bbH);
  } else {
    gctx.globalCompositeOperation = 'destination-in';
    gctx.fillStyle = '#ffffff';
    clipToVisibility(gctx, visibility, transform, bbX, bbY);
    gctx.globalCompositeOperation = 'source-over';
  }

  // Aperture gobos (windows) — runs after visibility clip so the sunpool
  // re-admission can paint outside the walls.
  if (light._gobos?.length) {
    applyGobosToRT(gctx, light, transform, bbX, bbY, 'aperture');
  }

  // Apply z-height prop shadows
  if (light._propShadows?.length) {
    _applyPropShadowsToRT(gctx, light, transform, bbX, bbY);
  }

  if (light.darkness) {
    // See renderPointLight — darkness cones paint black into the lightmap.
    lctx.save();
    lctx.globalCompositeOperation = 'source-over';
    lctx.drawImage(lightRTCanvas!, 0, 0, cw, ch, bbX, bbY, cw, ch);
    lctx.restore();
  } else {
    lctx.drawImage(lightRTCanvas!, 0, 0, cw, ch, bbX, bbY, cw, ch);
  }
}

// ─── Visibility Cache ──────────────────────────────────────────────────────

const visibilityCache = new Map();
/** Cached jittered-sample visibility polygons per light (soft shadows only). */
const softVisibilitiesCache = new Map<string, Float32Array[]>();
const propShadowsCache = new Map<
  string,
  Array<{ shadowPoly: number[][]; nearCenter: number[]; farCenter: number[]; opacity: number; hard: boolean }>
>();
/** Cached per-light gobo projections. Same lifecycle as `propShadowsCache`. */
const goboProjectionsCache = new Map<string, NonNullable<Light['_gobos']>>();
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
// Variant of the wall list with `'win'` edges removed — used for the
// aperture-visibility polygon that bounds window sunpools by walls beyond
// the window. Built only when the map has at least one aperture gobo.
let cachedOpenWallSegments: WallSegment[] | null = null;
let cachedPropShadowZones: ReturnType<typeof extractPropShadowZones> | null = null;
let cachedPropShadowIndex: PropShadowIndex | null = null;
let cachedGoboZones: GoboZone[] | null = null;
let cachedGoboIndex: GoboIndex | null = null;
// Per-light cache of the aperture-visibility polygon. Keyed off the same
// light-state key that keys visibilityCache, so it invalidates together.
const openVisibilityCache = new Map<string, Float32Array>();
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
// Last renderLightmap cacheKey — when the caller passes the same key, skip
// rebuild and just recomposite the existing _lmCanvas / _staticLmCanvas.
let _lastRenderLightmapKey: string | null = null;
let _lastRenderLightmapHadAnimated = false;

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
  _lastRenderLightmapKey = null;
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
  _lastRenderLightmapKey = null;
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
  openVisibilityCache.clear();
  softVisibilitiesCache.clear();
  propShadowsCache.clear();
  goboProjectionsCache.clear();
  bakedLightCache.clear();
  if (resolved === 'walls') {
    cachedWallSegments = null;
    cachedOpenWallSegments = null;
    cachedPropShadowZones = null;
    cachedPropShadowIndex = null;
    cachedGoboZones = null;
    cachedGoboIndex = null;
  } else if (resolved === 'props') {
    // Only prop shadows changed (e.g. prop picked up / moved) — keep wall segments
    cachedPropShadowZones = null;
    cachedPropShadowIndex = null;
    cachedGoboZones = null;
    cachedGoboIndex = null;
  }
  // Static lightmap depends on wall segments, prop shadows, AND any non-animated
  // light's position/intensity, so every scope currently invalidates it.
  _staticLmValid = false;
  _lastRenderLightmapKey = null;
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
  _lastRenderLightmapKey = null;
  log.dev(`invalidateLightmapCaches() — static + dynamic lightmap canvases dropped`);
}

// ─── Main Entry Point ──────────────────────────────────────────────────────
//
// Blend-mode contract (audited in Phase 4.11 of the 0.12 review):
//
//   Per-light RT canvas (lightRTCanvas, built inside renderPointLight /
//     renderDirectionalLight):
//     1. `source-over`     — radial gradient fill
//     2. `destination-in`  — cone and/or visibility polygon clip (AND)
//     3. `source-over`     — reset before prop-shadow application
//     4. `destination-out` — each prop shadow subtracted (penumbra gradient)
//
//   Per-light RT → lightmap canvas:
//     The outer lightmap context is in `lighter` (additive) mode when the RT
//     is blitted, so overlapping lights accumulate correctly. Two overlapping
//     red torches produce saturated red; red+blue overlap produces magenta.
//     8-bit per-channel clamping is the expected behaviour — matches Godot's
//     Light2D and Unity URP's 2D light accumulation.
//
//   Static lightmap (ambient + every static light):
//     Filled with `source-over` for the ambient tint, then each light draws
//     with `lighter`. The normal-map bump pass applies `multiply` at the end
//     so steep surfaces get darkened slightly.
//
//   Lightmap → main canvas:
//     `multiply`. The lightmap acts as a mask: brighter pixels leave the base
//     render untouched, darker pixels dim it toward black.
//
// Don't "clean up" these composite modes without updating this diagram and
// the tests that lock the contract in test/render/lighting.test.ts.

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
    /** When provided and unchanged from the previous call, skip the build
     *  phase entirely and recomposite the cached bitmap at the new dest rect.
     *  Use for zoom-only redraws where the lightmap content hasn't changed. */
    cacheKey?: string | null;
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
    cacheKey = null,
  } = options ?? {};

  // ── Cached recomposite fast path (zoom-only frames) ──
  if (cacheKey !== null && cacheKey === _lastRenderLightmapKey) {
    const cached = _lastRenderLightmapHadAnimated ? _lmCanvas : _staticLmCanvas;
    if (cached) {
      const useDest = destW > 0 && destH > 0;
      const dx = useDest ? destX : 0;
      const dy = useDest ? destY : 0;
      const dw = useDest ? destW : canvasW;
      const dh = useDest ? destH : canvasH;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(cached, dx, dy, dw, dh);
      ctx.restore();
      const bloomIntensity = metadata?.bloomIntensity ?? 0;
      if (bloomIntensity > 0) _applyBloom(ctx, cached, dx, dy, dw, dh, bloomIntensity);
      return;
    }
  }
  // Filter out lights whose group is disabled on this map. Un-grouped lights
  // (group undefined or '') are always rendered. Matches the light-group
  // toggle in the Lighting panel.
  const disabledGroups = metadata?.disabledLightGroups;
  const activeLights = lights.filter((l) => {
    if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) return false;
    if (disabledGroups && disabledGroups.length > 0 && l.group && disabledGroups.includes(l.group)) return false;
    return true;
  });

  // Wall segments are cached and only recomputed when invalidateVisibilityCache() is called.
  // Only profile when the cache actually rebuilds — ??= skips _t() on warm hits.
  cachedWallSegments ??= _t('lighting:segments', () => extractWallSegments(cells, gridSize, propCatalog, metadata));
  const segments = cachedWallSegments;

  // Windows-open wall segment list (same as `segments` minus `'win'` edges).
  // Only built when the map has at least one window — otherwise every light's
  // aperture-visibility polygon would duplicate its regular visibility
  // polygon. Used by the gobo aperture pipeline to bound sunpools by walls
  // beyond the window.
  if (metadata?.windows?.length) {
    cachedOpenWallSegments ??= _t('lighting:openSegments', () =>
      extractWallSegments(cells, gridSize, propCatalog, metadata, { treatWindowsAsOpen: true }),
    );
  } else {
    cachedOpenWallSegments = null;
  }
  const openSegments = cachedOpenWallSegments;

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

  // Gobo zones (upright patterned occluders — window mullions, prison bars).
  // Built alongside prop shadows; projection is computed per-light in
  // _getOrComputeLightGeometry and cached until invalidation.
  if (!cachedGoboIndex) {
    _t('lighting:goboZones', () => {
      const propZones = extractGoboZones(propCatalog, metadata, gridSize);
      const windowZones = extractWindowGoboZones(cells, metadata, gridSize);
      cachedGoboZones = windowZones.length ? propZones.concat(windowZones) : propZones;
      cachedGoboIndex = buildGoboIndex(cachedGoboZones).index;
    });
  }

  // Lightmap resolution: if lightPxPerFoot is set and smaller than the cache
  // resolution, render at reduced size and upscale. Lightmaps are smooth
  // gradients so lower resolution is visually imperceptible.
  const cacheScale = transform.scale; // px/ft of the full cache
  const lmScale = lightPxPerFoot > 0 && lightPxPerFoot < cacheScale ? lightPxPerFoot : cacheScale;
  const lmW = Math.ceil((canvasW * lmScale) / cacheScale);
  const lmH = Math.ceil((canvasH * lmScale) / cacheScale);
  const lmTransform = { scale: lmScale, offsetX: 0, offsetY: 0 };

  // Split lights into static (no animation) and animated. Lights belonging
  // to a group with an active fade/ignite/extinguish transition are also
  // routed to the animated path so the per-frame intensity ramp applies.
  const staticLights: Light[] = [];
  const animatedLights: Light[] = [];
  for (const light of activeLights) {
    const groupTransitioning = light.group ? groupTransitions.has(light.group) : false;
    if (light.animation?.type || groupTransitioning) {
      animatedLights.push(light);
    } else {
      staticLights.push(light);
    }
  }
  // Map-wide ambient animation (e.g. lightning storm). Force the animated
  // path so the overlay step can paint the per-frame ambient flash. Active
  // group transitions also force the animated path so the ramp keeps ticking
  // even on maps with no per-light animation.
  const ambientAnim = metadata?.ambientAnimation;
  const hasAmbientAnim = !!ambientAnim?.type;
  const hasAnimated = animatedLights.length > 0 || hasAmbientAnim || hasActiveGroupTransitions();

  // ── Static lightmap (ambient + all non-animated lights) ──
  // Only rebuilt when visibility cache is invalidated (wall/light changes).
  const staticCanvas = _getStaticLmCanvas(lmW, lmH);
  if (!_staticLmValid) {
    _t('lighting:staticBuild', () =>
      _buildStaticLightmap(staticCanvas, lmW, lmH, staticLights, activeLights, {
        time,
        ambientLevel,
        ambientColor,
        segments,
        openSegments,
        propShadowIndex,
        lmTransform,
        cells,
        gridSize,
        textureCatalog,
      }),
    );
    _staticLmValid = true;
  }

  // Determine where to draw the lightmap on the target canvas.
  // When destW/destH are set, the lightmap covers a sub-region of the target (screen overlay).
  // Otherwise it covers the full target (cache-space rendering).
  const useDest = destW > 0 && destH > 0;
  const dx = useDest ? destX : 0;
  const dy = useDest ? destY : 0;
  const dw = useDest ? destW : canvasW;
  const dh = useDest ? destH : canvasH;

  const bloomIntensity = metadata?.bloomIntensity ?? 0;

  if (!hasAnimated) {
    // Fast path: no animated lights — composite static lightmap directly
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(staticCanvas, dx, dy, dw, dh);
    ctx.restore();
    if (bloomIntensity > 0) _applyBloom(ctx, staticCanvas, dx, dy, dw, dh, bloomIntensity);
    _lastRenderLightmapKey = cacheKey;
    _lastRenderLightmapHadAnimated = false;
    return;
  }

  // ── Animated lights: blit static cache + render animated lights ──
  const animatedLightmap = _t('lighting:animated', () =>
    _renderAnimatedOverlay(ctx, staticCanvas, lmW, lmH, animatedLights, {
      time,
      segments,
      openSegments,
      propShadowIndex,
      lmTransform,
      dest: { x: dx, y: dy, w: dw, h: dh },
      ambientAnim: hasAmbientAnim ? ambientAnim : null,
      ambientColor,
    }),
  );
  if (bloomIntensity > 0) _applyBloom(ctx, animatedLightmap, dx, dy, dw, dh, bloomIntensity);
  _lastRenderLightmapKey = cacheKey;
  _lastRenderLightmapHadAnimated = true;

  // Sweep completed group transitions: anything past its duration moves out of
  // the runtime store so its lights flip back to the static-baked layer next
  // frame. Invalidate the static cache once at the boundary so the partition
  // takes effect.
  if (groupTransitions.size > 0) {
    let didComplete = false;
    for (const [g, tr] of groupTransitions) {
      const elapsed = (time - tr.startedAt) * 1000;
      if (elapsed >= tr.durationMs) {
        groupTransitions.delete(g);
        didComplete = true;
      }
    }
    if (didComplete) {
      _staticLmValid = false;
      _lastRenderLightmapKey = null;
    }
  }
}

/**
 * Per-frame build of the cached static lightmap layer: ambient fill + every
 * non-animated light + normal-map bump. Caller flips `_staticLmValid = true`
 * on return. Split out of renderLightmap so the invalidation-driven rebuild
 * is easy to follow and to benchmark in isolation.
 */
function _buildStaticLightmap(
  staticCanvas: OffscreenCanvas | HTMLCanvasElement,
  lmW: number,
  lmH: number,
  staticLights: Light[],
  allLights: Light[],
  params: {
    time: number;
    ambientLevel: number;
    ambientColor: string;
    segments: WallSegment[];
    openSegments: WallSegment[] | null;
    propShadowIndex: PropShadowIndex;
    lmTransform: RenderTransform;
    cells: CellGrid;
    gridSize: number;
    textureCatalog: TextureCatalog | null;
  },
): void {
  const slctx = staticCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  slctx.globalCompositeOperation = 'source-over';

  // Fill with ambient
  const amb = Math.max(0, Math.min(1, params.ambientLevel));
  const { r: ar, g: ag, b: ab } = parseColor(params.ambientColor);
  slctx.fillStyle = `rgb(${Math.round(ar * amb)}, ${Math.round(ag * amb)}, ${Math.round(ab * amb)})`;
  slctx.fillRect(0, 0, lmW, lmH);

  // Additively blend each static light
  slctx.globalCompositeOperation = 'lighter';
  for (const light of staticLights) {
    _renderOneLight(
      slctx,
      light,
      params.time,
      params.segments,
      params.lmTransform,
      params.propShadowIndex,
      params.openSegments,
    );
  }

  // Normal map bump uses all lights for direction, but only apply on static pass
  if (params.textureCatalog) {
    _t('lighting:normalMap', () =>
      applyNormalMapBump(slctx, allLights, params.cells, params.gridSize, params.lmTransform, params.textureCatalog),
    );
  }
}

/**
 * Per-frame animated overlay: copy the baked static layer onto the scratch
 * canvas, render each animated light on top, then composite the combined
 * lightmap onto the main context with 'multiply'.
 */
function _renderAnimatedOverlay(
  ctx: CanvasRenderingContext2D,
  staticCanvas: OffscreenCanvas | HTMLCanvasElement,
  lmW: number,
  lmH: number,
  animatedLights: Light[],
  params: {
    time: number;
    segments: WallSegment[];
    openSegments: WallSegment[] | null;
    propShadowIndex: PropShadowIndex;
    lmTransform: RenderTransform;
    dest: { x: number; y: number; w: number; h: number };
    ambientAnim?: {
      type: string;
      speed?: number;
      amplitude?: number;
      frequency?: number;
      duration?: number;
      probability?: number;
      baseline?: number;
      phase?: number;
    } | null;
    ambientColor?: string;
  },
): OffscreenCanvas | HTMLCanvasElement {
  const lightCanvas = _getLightmapCanvas(lmW, lmH);
  const lctx = lightCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

  // Start from the cached static lightmap
  lctx.globalCompositeOperation = 'source-over';
  lctx.drawImage(staticCanvas, 0, 0);

  // Map-wide ambient animation: paint a full-canvas additive flash whose
  // intensity follows a strike envelope. Currently only `strike` is meaningful;
  // pulse/flicker on ambient would also work but would force-invalidate the
  // static cache to avoid double-counting, which we don't want.
  if (params.ambientAnim?.type === 'strike') {
    const a = params.ambientAnim;
    const speed = a.speed ?? 1;
    const amplitude = a.amplitude ?? 1;
    const phase = a.phase ?? 0;
    const freq = a.frequency ?? 0.1; // storms strike less often than per-light wards
    const dur = a.duration ?? 0.18;
    const prob = a.probability ?? 0.5;
    const t = (params.time + phase) * speed * ANIM_TIME_SCALE;
    const win = 1 / Math.max(0.001, freq);
    const idx = Math.floor(t / win);
    const localT = (t - idx * win) / win;
    const roll = hash32((idx * 0x9e3779b1) | 0);
    if (roll < prob && localT < dur) {
      const env = strikeEnvelope(localT / dur);
      const flashAlpha = Math.max(0, Math.min(1, amplitude * env));
      if (flashAlpha > 0.01) {
        const c = parseColor(params.ambientColor && params.ambientColor.length > 0 ? params.ambientColor : '#ccddff');
        lctx.save();
        lctx.globalCompositeOperation = 'lighter';
        lctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${flashAlpha.toFixed(3)})`;
        lctx.fillRect(0, 0, lmW, lmH);
        lctx.restore();
      }
    }
  }

  // Additively blend animated lights
  lctx.globalCompositeOperation = 'lighter';
  for (const light of animatedLights) {
    _renderOneLight(
      lctx,
      light,
      params.time,
      params.segments,
      params.lmTransform,
      params.propShadowIndex,
      params.openSegments,
    );
  }

  // Composite lightmap onto main canvas with multiply
  const { x, y, w, h } = params.dest;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(lightCanvas, x, y, w, h);
  ctx.restore();
  return lightCanvas;
}

/**
 * Bloom post-pass. Composite a Gaussian-blurred copy of the lightmap onto
 * the scene with `lighter`, so bright torches bleed a soft halo over their
 * surroundings. Uses canvas `filter: blur()` — supported in Chromium/Edge
 * including Electron ≥ 24; no-op on browsers without support (filter is
 * silently ignored, result is just a soft additive pass without blur).
 *
 * Cost is small: one drawImage with filter, one composite. Fits well inside
 * a 60 fps frame budget.
 */
const BLOOM_BLUR_PX = 10;
function _applyBloom(
  ctx: CanvasRenderingContext2D,
  lightmap: OffscreenCanvas | HTMLCanvasElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  intensity: number,
) {
  const alpha = Math.max(0, Math.min(1, intensity));
  if (alpha === 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.filter = `blur(${BLOOM_BLUR_PX}px)`;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(lightmap, dx, dy, dw, dh);
  ctx.restore();
}

/**
 * Cache-keyed per-light geometry: (visibility polygon, prop shadow polygons).
 * Both depend only on light position/z/radius + world geometry, so animated
 * flicker/pulse lights that only vary intensity reuse the same entries every
 * frame. Cache is cleared by invalidateVisibilityCache().
 */
function _getOrComputeLightGeometry(
  eff: Light,
  effectiveRadius: number,
  lightZ: number,
  segments: WallSegment[],
  propShadowIndex: PropShadowIndex,
  openSegments: WallSegment[] | null = null,
): {
  cacheKey: string;
  visibility: Float32Array;
  openVisibility: Float32Array | null;
  softVisibilities: Float32Array[] | null;
  propShadows: Array<{
    shadowPoly: number[][];
    nearCenter: number[];
    farCenter: number[];
    opacity: number;
    hard: boolean;
  }>;
  gobos: NonNullable<Light['_gobos']>;
} {
  const cacheKey = `${eff.id}:${eff.x},${eff.y},${lightZ},${effectiveRadius}`;
  let visibility = visibilityCache.get(cacheKey);
  if (!visibility) {
    visibility = computeVisibility(eff.x, eff.y, effectiveRadius, segments);
    visibilityCache.set(cacheKey, visibility);
  }
  // Aperture-visibility polygon: the visibility this light would have if
  // window edges were open. Used to bound aperture sunpools by walls
  // beyond the window. Only computed when there's at least one aperture
  // gobo in the map — otherwise it would duplicate `visibility`.
  let openVisibility: Float32Array | null = null;
  if (openSegments) {
    openVisibility = openVisibilityCache.get(cacheKey) ?? null;
    if (!openVisibility) {
      openVisibility = computeVisibility(eff.x, eff.y, effectiveRadius, openSegments);
      openVisibilityCache.set(cacheKey, openVisibility);
    }
  }
  // Soft-shadow samples: compute N extra visibility polygons at jittered
  // offsets around the light center, cached separately so the hot flicker/
  // pulse path doesn't recompute them every frame.
  let softVisibilities: Float32Array[] | null = null;
  const softR = eff.softShadowRadius ?? 0;
  if (softR > 0) {
    const softKey = `${cacheKey}|soft${softR}`;
    softVisibilities = softVisibilitiesCache.get(softKey) ?? null;
    if (!softVisibilities) {
      softVisibilities = [];
      for (let i = 0; i < SOFT_SHADOW_SAMPLES; i++) {
        // Golden-angle disc sampling: angle spirals, radius = √(i/N)·softR
        // → samples spread uniformly across the disc.
        const angle = i * SOFT_SHADOW_GOLDEN_ANGLE;
        const r = Math.sqrt((i + 0.5) / SOFT_SHADOW_SAMPLES) * softR;
        const sx = eff.x + Math.cos(angle) * r;
        const sy = eff.y + Math.sin(angle) * r;
        softVisibilities.push(computeVisibility(sx, sy, effectiveRadius, segments));
      }
      softVisibilitiesCache.set(softKey, softVisibilities);
    }
  }
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

  // Gobo projections (upright patterned occluders → multiply-masked quads on
  // the floor). Read the module-level index directly — it's rebuilt in
  // renderLightmap before any per-light work runs.
  let gobos = goboProjectionsCache.get(cacheKey);
  if (!gobos) {
    gobos = [];
    if (cachedGoboIndex && cachedGoboIndex.size > 0) {
      const rSq = effectiveRadius * effectiveRadius;
      for (const zone of cachedGoboIndex.query(eff.x, eff.y, effectiveRadius)) {
        const dx = zone.centroidX - eff.x;
        const dy = zone.centroidY - eff.y;
        if (dx * dx + dy * dy > rSq) continue;
        // When the light sits INSIDE the gobo's z range [zBottom, zTop],
        // rays through z > lightZ travel upward and never hit the floor —
        // the projection formula (lightZ / (lightZ - zTop)) would flip
        // negative and smear the pattern behind the light. Clamp the
        // effective zTop to just below the light's z so everything
        // projects forward; a light at exactly aperture-height produces
        // a near-horizontal ray that hits the outer radius instead of
        // inverting.
        const effZTop = Math.min(zone.zTop, lightZ - 0.01);
        if (effZTop <= zone.zBottom) continue; // light at/below aperture bottom
        const proj = computeGoboProjectionPolygon(
          eff.x,
          eff.y,
          lightZ,
          zone.x1,
          zone.y1,
          zone.x2,
          zone.y2,
          zone.zBottom,
          effZTop,
          effectiveRadius,
        );
        if (!proj) continue;
        gobos.push({
          quad: proj.quad,
          zBottom: zone.zBottom,
          zTop: effZTop,
          goboId: zone.goboId,
          pattern: zone.pattern,
          density: zone.density,
          orientation: zone.orientation ?? 'vertical',
          mode: zone.mode,
          strength: zone.strength,
          ...(zone.tintColor ? { tintColor: zone.tintColor } : {}),
          ...(zone.colors?.length ? { colors: zone.colors } : {}),
        });
      }
    }
    goboProjectionsCache.set(cacheKey, gobos);
  }
  return { cacheKey, visibility, openVisibility, softVisibilities, propShadows, gobos };
}

/** Render a single light onto a lightmap context (assumes 'lighter' composite op). */
function _renderOneLight(
  lctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  light: Light,
  time: number,
  segments: WallSegment[],
  transform: RenderTransform,
  propShadowIndex: PropShadowIndex,
  openSegments: WallSegment[] | null = null,
) {
  _currentFrameTime = time;
  const eff = getEffectiveLight(light, time);
  const outerRadius = eff.dimRadius && eff.dimRadius > (eff.radius || 0) ? eff.dimRadius : eff.radius || 30;
  const effectiveRadius = eff.range ?? outerRadius;
  const lightZ = eff.z ?? DEFAULT_LIGHT_Z;

  // Cull lights whose bounding circle doesn't touch the lightmap canvas.
  // Avoids running computeVisibility (which does ray casts against every
  // nearby wall endpoint) on lights that can never contribute a pixel.
  const cxPx = eff.x * transform.scale + transform.offsetX;
  const cyPx = eff.y * transform.scale + transform.offsetY;
  const rPx = effectiveRadius * transform.scale;
  const vpW = lctx.canvas.width;
  const vpH = lctx.canvas.height;
  if (cxPx + rPx < 0 || cxPx - rPx > vpW || cyPx + rPx < 0 || cyPx - rPx > vpH) {
    return;
  }

  const { visibility, openVisibility, softVisibilities, propShadows, gobos } = _getOrComputeLightGeometry(
    eff,
    effectiveRadius,
    lightZ,
    segments,
    propShadowIndex,
    openSegments,
  );
  // Attach shadow + gobo data to the effective light so render functions can use it
  eff._propShadows = propShadows;
  eff._gobos = gobos;
  // Stash the aperture-visibility polygon on the effective light so the
  // gobo pipeline can clip sunpools to it. Non-enumerable would be nicer,
  // but the Light type already accepts ad-hoc caches like `_gobos`.
  (eff as Light & { _openVisibility?: Float32Array | null })._openVisibility = openVisibility;

  if (eff.type === 'directional') {
    renderDirectionalLight(lctx, eff, visibility, transform, softVisibilities);
    return;
  }

  // Bake-cache fast path: flicker/pulse/strobe/strike animations that only
  // vary intensity (no radius / color / angle / cookie change) reuse a
  // composited RT across frames — per-frame cost collapses to one
  // `drawImage` with `globalAlpha`. destination-in (visibility) and
  // destination-out (prop shadows) both commute with globalAlpha scaling,
  // so the result is identical.
  const anim = light.animation;
  const colorAnimates = !!anim && anim.colorMode && anim.colorMode !== 'none';
  const cookieAnimates =
    !!light.cookie &&
    ((light.cookie.rotationSpeed ?? 0) !== 0 ||
      (light.cookie.scrollSpeedX ?? 0) !== 0 ||
      (light.cookie.scrollSpeedY ?? 0) !== 0);
  const intensityOnly =
    !!anim?.type &&
    !(anim.radiusVariation && anim.radiusVariation > 0) &&
    !colorAnimates &&
    !cookieAnimates &&
    (anim.type === 'flicker' || anim.type === 'pulse' || anim.type === 'strobe' || anim.type === 'strike');
  if (intensityOnly) {
    const bakeKey = `${light.id}:${transform.scale.toFixed(3)}`;
    let baked = bakedLightCache.get(bakeKey);
    if (baked?.scale !== transform.scale) {
      const vpW2 = lctx.canvas.width;
      const vpH2 = lctx.canvas.height;
      // Bake the light with propShadows, gobos, and aperture-visibility
      // attached at intensity=1. `_openVisibility` is needed for aperture
      // sunpools to be bounded by walls beyond the window — without it,
      // sunpools leak into rooms the window opens onto that have their
      // own walls.
      const bakeLight: Light & { _openVisibility?: Float32Array | null } = {
        ...light,
        intensity: 1,
        _propShadows: propShadows,
        _gobos: gobos,
        _openVisibility: openVisibility,
      };
      baked = _bakePointLight(bakeLight, visibility, transform, vpW2, vpH2, softVisibilities) ?? undefined;
      if (baked) bakedLightCache.set(bakeKey, baked);
    }
    if (baked) {
      const alpha = Math.max(0, Math.min(1, eff.intensity));
      lctx.save();
      lctx.globalAlpha = alpha;
      // Darkness lights paint black pixels directly — the baked RT was built
      // from a black gradient, so source-over composites it over the
      // accumulated lightmap (and the outer 'lighter' mode the caller set
      // would incorrectly additively blend black with existing light).
      if (light.darkness) lctx.globalCompositeOperation = 'source-over';
      lctx.drawImage(baked.canvas, baked.bbX, baked.bbY);
      lctx.restore();
      return;
    }
  }

  renderPointLight(lctx, eff, visibility, transform, softVisibilities);
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
      const lz3 = BUMP_LIGHT_HEIGHT_FRAC;
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

      // Map avgDot (0 = grazing / steep, 1 = head-on) into a subtle brightness
      // range via lighting-config.BUMP_RT_BASE + avgDot * BUMP_RT_SPAN.
      const bumpFactor = BUMP_RT_BASE + avgDot * BUMP_RT_SPAN;
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
 * Called before renderLightmap whenever lighting is enabled.
 * Color and intensity are read from the resolved theme so themeOverrides apply automatically.
 *
 * @param {Array} cells - 2D cell grid
 * @param {number} gridSize - World feet per grid square
 * @param {object} theme - Resolved theme object (including any themeOverrides)
 * @returns {Array} Light objects ready for renderLightmap
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
