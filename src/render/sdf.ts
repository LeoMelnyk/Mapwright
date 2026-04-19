/**
 * Jump-flooded signed distance field over the wall-segment map.
 *
 * The SDF stores, at every grid cell, the pixel distance to the nearest
 * wall. We build it once per invalidation (driven off the same
 * WallSegment[] the visibility pipeline uses) and currently consume it for
 * a "contact shadow" darken-pass that tints pixels close to walls —
 * cheap way to add the grungy, hand-drawn look hard-edge visibility
 * polygons can't give on their own.
 *
 * Algorithm — Rong & Tan 2006's jump-flood:
 *   1. Rasterize every wall segment into a seed grid (each wall pixel
 *      records its own (x, y) as nearest-seed coords).
 *   2. For k = log2(maxDim) down to 0, step by 2^k and ask each cell
 *      "does one of my 8 offset neighbours reference a closer seed?".
 *      Each pass is O(N); log2 passes means O(N log N) total.
 *   3. After the final pass, distance = √((px - seedPx)² + (py - seedPy)²).
 *
 * Works at the lightmap resolution — no GPU required, no WebGL. Typical
 * build for a 500×500 map: ~8–15 ms on a mid-range laptop CPU.
 */

import type { WallSegment } from './lighting-geometry.js';

/**
 * A computed SDF: `dist[y * w + x]` is the distance (in pixels at the build
 * scale) from cell (x, y) to the nearest wall cell. `w`/`h` are the grid
 * dimensions.
 */
export interface WallSDF {
  dist: Float32Array;
  w: number;
  h: number;
  /** World-feet → pixel factor used when the field was built. */
  scale: number;
}

/**
 * Build a SDF whose grid covers [0, canvasW) × [0, canvasH) at `scale`
 * pixels per foot. The caller is responsible for keeping the same scale
 * across rebuilds; otherwise the distance values aren't comparable.
 *
 * Resolution trade-off: lower resolutions build faster but miss thin walls
 * (single-pixel walls at 1px/ft = 5ft-wide at 0.2 scale). 0.5px/ft works
 * for contact shadows; bump to 1px/ft for SDF-based visibility.
 */
export function buildWallSDF(segments: WallSegment[], worldW: number, worldH: number, scale: number): WallSDF {
  const w = Math.max(1, Math.ceil(worldW * scale));
  const h = Math.max(1, Math.ceil(worldH * scale));
  // Pack seed coords into two Int32Arrays (nearest X, nearest Y). -1 marks
  // "no seed yet" so the initial state is well-defined.
  const seedX = new Int32Array(w * h).fill(-1);
  const seedY = new Int32Array(w * h).fill(-1);

  // ── 1. Rasterize segments via Bresenham; mark each touched cell a seed.
  for (const seg of segments) {
    const x1 = Math.round(seg.x1 * scale);
    const y1 = Math.round(seg.y1 * scale);
    const x2 = Math.round(seg.x2 * scale);
    const y2 = Math.round(seg.y2 * scale);
    rasterizeSegment(seedX, seedY, w, h, x1, y1, x2, y2);
  }

  // ── 2. Jump-flood passes: step = maxDim/2, /4, /8, …, 1.
  const maxDim = Math.max(w, h);
  for (let step = Math.max(1, maxDim >> 1); step >= 1; step >>= 1) {
    jfaPass(seedX, seedY, w, h, step);
    if (step === 1) break;
  }

  // ── 3. Emit distances.
  const dist = new Float32Array(w * h);
  for (let y = 0, idx = 0; y < h; y++) {
    for (let x = 0; x < w; x++, idx++) {
      const sx = seedX[idx]!;
      const sy = seedY[idx]!;
      if (sx < 0) {
        dist[idx] = Infinity;
      } else {
        const dx = x - sx;
        const dy = y - sy;
        dist[idx] = Math.sqrt(dx * dx + dy * dy);
      }
    }
  }

  return { dist, w, h, scale };
}

/**
 * Sample the SDF at world-feet (x, y). Returns Infinity if the sample lies
 * outside the SDF grid.
 */
export function sampleSDF(sdf: WallSDF, worldX: number, worldY: number): number {
  const x = Math.floor(worldX * sdf.scale);
  const y = Math.floor(worldY * sdf.scale);
  if (x < 0 || x >= sdf.w || y < 0 || y >= sdf.h) return Infinity;
  return sdf.dist[y * sdf.w + x]!;
}

// ─── Internals ─────────────────────────────────────────────────────────────

/**
 * Rasterize a line segment into the seed grid (Bresenham). Every cell the
 * segment touches is marked as a seed pointing to itself.
 */
function rasterizeSegment(
  seedX: Int32Array,
  seedY: Int32Array,
  w: number,
  h: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  let x = x1;
  let y = y1;
  const dx = Math.abs(x2 - x1);
  const dy = -Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let err = dx + dy;
  const mark = (px: number, py: number) => {
    if (px < 0 || px >= w || py < 0 || py >= h) return;
    const i = py * w + px;
    seedX[i] = px;
    seedY[i] = py;
  };
  mark(x, y);
  while (x !== x2 || y !== y2) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    mark(x, y);
  }
}

/**
 * One jump-flood pass at the given step. Reads a snapshot of seedX/seedY
 * and writes back to them — safe because we only improve on existing seeds
 * (never regress to a worse one).
 */
function jfaPass(seedX: Int32Array, seedY: Int32Array, w: number, h: number, step: number) {
  // Snapshot so each cell reads stable neighbour values this pass.
  const sx0 = new Int32Array(seedX);
  const sy0 = new Int32Array(seedY);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let bestX = seedX[idx]!;
      let bestY = seedY[idx]!;
      let bestD = bestX < 0 ? Infinity : (x - bestX) * (x - bestX) + (y - bestY) * (y - bestY);
      for (let oy = -step; oy <= step; oy += step) {
        const ny = y + oy;
        if (ny < 0 || ny >= h) continue;
        for (let ox = -step; ox <= step; ox += step) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          if (nx < 0 || nx >= w) continue;
          const nIdx = ny * w + nx;
          const candX = sx0[nIdx]!;
          const candY = sy0[nIdx]!;
          if (candX < 0) continue;
          const ddx = x - candX;
          const ddy = y - candY;
          const d = ddx * ddx + ddy * ddy;
          if (d < bestD) {
            bestD = d;
            bestX = candX;
            bestY = candY;
          }
        }
      }
      seedX[idx] = bestX;
      seedY[idx] = bestY;
    }
  }
}
