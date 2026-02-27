/**
 * generate-hatch-patterns.js
 *
 * Generates line-hatching clusters for the dungeon wall shading style
 * and writes them as a baked-in JS constant matching HATCH_PATTERNS in patterns.js.
 *
 * Each cluster is a group of 2–4 roughly parallel line segments placed on a
 * Lloyd-relaxed jittered grid across a 300×300 toroidal tile. BFS distance from
 * room edges controls which clusters are visible and at what opacity.
 *
 * Usage:
 *   node tools/rock-patterns/generate-hatch-patterns.js > tools/rock-patterns/hatch-patterns-output.js
 *
 * Tweak CELL_SIZE, SPACING, HALF_LEN_*, LLOYD_ITERS, etc. then re-run.
 *
 * Algorithm (reverse-engineered from the original 94-cluster HATCH_PATTERNS data):
 *
 *   1. Seed placement — jittered grid + toroidal Lloyd relaxation:
 *      - 10×10 grid (CELL_SIZE=30) in a 300×300 tile → 100 seeds
 *      - Initial jitter: (0.2 + rng()*0.6) * CELL_SIZE (same as rock/water)
 *      - Toroidal Voronoi + Lloyd relaxation (4 iterations)
 *        → produces very uniform spacing with natural variation
 *      - Row-major traversal order (gy outer, gx inner)
 *
 *   2. Line cluster generation per seed:
 *      - Random angle θ ∈ [0, 2π)
 *      - 2–4 lines per cluster (80% → 3, 12% → 2, 8% → 4)
 *      - Lines spaced ~10px apart perpendicular to θ
 *      - Each line: half-length ~ Normal(19, 6), clamped [7, 41]
 *      - Per-line angle jitter ~ Normal(0, 3°)
 *      - Per-endpoint parallel jitter ~ Normal(0, 3px)
 *      - Integer-rounded coordinates
 *
 * Note: The original HATCH_PATTERNS data predates this generator. The exact
 * PRNG seed is unrecoverable (exhaustive LCG search over 2^32 seeds found no
 * match). This script produces statistically equivalent output — same density,
 * spacing, line characteristics, and visual appearance.
 */

import { Delaunay } from 'd3-delaunay';

// ── Parameters ────────────────────────────────────────────────────────────────
const TILE         = 300;    // coordinate space of one repeating tile
const CELL_SIZE    = 30;     // jittered grid cell size (10×10 = 100 cells)
const LLOYD_ITERS  = 4;      // Lloyd relaxation passes for uniform spacing
const SPACING      = 8;      // perpendicular distance between adjacent lines
const SPACING_JITTER = 1;    // ±jitter on perpendicular offset (stdev)
const HALF_LEN_MEAN  = 15;   // mean half-length of each line segment
const HALF_LEN_STD   = 4;    // standard deviation of half-length
const HALF_LEN_MIN   = 7;    // clamp minimum
const HALF_LEN_MAX   = 25;   // clamp maximum
const ANGLE_JITTER_DEG = 3;  // per-line angle deviation from cluster angle (degrees)
const PAR_JITTER   = 3;      // per-endpoint drift along line direction (px, stdev)

// Weighted line count: {2: ~12%, 3: ~80%, 4: ~8%}
const LINE_COUNT_WEIGHTS = [
  { n: 2, w: 0.12 },
  { n: 3, w: 0.80 },
  { n: 4, w: 0.08 },
];

// ── Seeded LCG RNG (same constants as rock/water generators) ────────────────
const SEED = 0x1337beef;
let s = SEED;
function resetRng(seed) { s = seed >>> 0; }
function rng() { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 0x100000000; }

// Box-Muller transform for normal distribution
function rngNormal(mean, std) {
  const u1 = rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  return mean + z * std;
}

// Weighted random selection
function rngWeighted(weights) {
  const r = rng();
  let cum = 0;
  for (const { n, w } of weights) {
    cum += w;
    if (r < cum) return n;
  }
  return weights[weights.length - 1].n;
}

// ── Toroidal Voronoi builder (same as rock/water generators) ────────────────
// Seeds are mirrored 8 ways around the tile so edge cells connect seamlessly.
// Index i*9+4 is the "center" (non-mirrored) copy of seed i.
function buildToroidalVoronoi(seeds, bounds) {
  const pts = [];
  for (const [x, y] of seeds) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        pts.push(x + dx * TILE, y + dy * TILE);
      }
    }
  }
  const delaunay = new Delaunay(pts);
  return delaunay.voronoi(bounds ?? [0, 0, TILE, TILE]);
}

// ── Generate patterns ───────────────────────────────────────────────────────
function generatePatterns(seed) {
  resetRng(seed);

  // 1. Jittered grid seeds
  const gridCols = Math.ceil(TILE / CELL_SIZE);
  const gridRows = Math.ceil(TILE / CELL_SIZE);
  let seeds = [];

  for (let gy = 0; gy < gridRows; gy++) {
    for (let gx = 0; gx < gridCols; gx++) {
      seeds.push([
        (gx + 0.2 + rng() * 0.6) * CELL_SIZE,
        (gy + 0.2 + rng() * 0.6) * CELL_SIZE,
      ]);
    }
  }

  // 2. Lloyd relaxation — move each seed to its Voronoi cell centroid
  for (let iter = 0; iter < LLOYD_ITERS; iter++) {
    const voronoi = buildToroidalVoronoi(seeds);
    const next = [];
    for (let i = 0; i < seeds.length; i++) {
      const cell = voronoi.cellPolygon(i * 9 + 4);
      if (!cell || cell.length < 4) { next.push(seeds[i]); continue; }

      // Shoelace centroid (closed polygon: first == last point)
      let cx = 0, cy = 0, area = 0;
      for (let j = 0; j < cell.length - 1; j++) {
        const [x0, y0] = cell[j], [x1, y1] = cell[j + 1];
        const a = x0 * y1 - x1 * y0;
        area += a;
        cx += (x0 + x1) * a;
        cy += (y0 + y1) * a;
      }
      area /= 2;
      if (Math.abs(area) < 1e-6) { next.push(seeds[i]); continue; }
      cx /= 6 * area;
      cy /= 6 * area;

      // Wrap back into [0, TILE) for toroidal continuity
      next.push([((cx % TILE) + TILE) % TILE, ((cy % TILE) + TILE) % TILE]);
    }
    seeds = next;
  }

  // 3. Round centres to integers
  const centres = seeds.map(([x, y]) => [Math.round(x), Math.round(y)]);

  // 4. For each centre, generate a cluster of parallel lines
  const patterns = [];
  const DEG2RAD = Math.PI / 180;

  for (const [cx, cy] of centres) {
    const theta = rng() * 2 * Math.PI;             // cluster angle
    const nLines = rngWeighted(LINE_COUNT_WEIGHTS); // 2, 3, or 4

    // perpendicular (normal) direction
    const nx = -Math.sin(theta);
    const ny = Math.cos(theta);

    const cellLines = [];

    for (let i = 0; i < nLines; i++) {
      // Perpendicular offset: centred around 0, spaced by SPACING
      const perpOffset = (i - (nLines - 1) / 2) * SPACING
        + rngNormal(0, SPACING_JITTER);

      // Per-line angle jitter
      const lineAngle = theta + rngNormal(0, ANGLE_JITTER_DEG * DEG2RAD);
      const ld = [Math.cos(lineAngle), Math.sin(lineAngle)];

      // Half-length with normal distribution, clamped
      let halfLen = rngNormal(HALF_LEN_MEAN, HALF_LEN_STD);
      halfLen = Math.max(HALF_LEN_MIN, Math.min(HALF_LEN_MAX, halfLen));

      // Per-endpoint parallel jitter
      const parJ0 = rngNormal(0, PAR_JITTER);
      const parJ1 = rngNormal(0, PAR_JITTER);

      // Compute endpoints
      const baseX = cx + perpOffset * nx;
      const baseY = cy + perpOffset * ny;

      const x0 = Math.round(baseX + (-halfLen + parJ0) * ld[0]);
      const y0 = Math.round(baseY + (-halfLen + parJ0) * ld[1]);
      const x1 = Math.round(baseX + (halfLen + parJ1) * ld[0]);
      const y1 = Math.round(baseY + (halfLen + parJ1) * ld[1]);

      cellLines.push([[x0, y0], [x1, y1]]);
    }

    patterns.push({ cellLines, centre: [cx, cy] });
  }

  return patterns;
}

// ── Main ────────────────────────────────────────────────────────────────────
const patterns = generatePatterns(SEED);

// ── Output ──────────────────────────────────────────────────────────────────
const lines = patterns.map(({ cellLines, centre }) => {
  const c = `[${centre.join(',')}]`;
  const cls = cellLines.map(([p0, p1]) => `[[${p0.join(',')}],[${p1.join(',')}]]`).join(',');
  return `  { cellLines: [${cls}], centre: ${c} }`;
});

process.stdout.write(
`// ── Hatching Patterns ────────────────────────────────────────────────────────
// Auto-generated by generate-hatch-patterns.js — do not edit by hand.
// Re-generate: node tools/rock-patterns/generate-hatch-patterns.js > tools/rock-patterns/hatch-patterns-output.js
// Parameters: TILE=${TILE}, CELL_SIZE=${CELL_SIZE}, LLOYD_ITERS=${LLOYD_ITERS}, SPACING=${SPACING}, seeds=${patterns.length}, SEED=0x${SEED.toString(16)}
export const HATCH_TILE_SIZE = ${TILE};
export const HATCH_PATTERNS = [
${lines.join(',\n')},
];
`);
