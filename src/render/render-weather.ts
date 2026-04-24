// Animated weather effects renderer.
//
// Each weather group renders in two layers:
//   • A translucent per-cell haze wash (cached once per state change, blitted
//     each frame).
//   • Animated particles dispatched per weather group by shape:
//       - `flake`  → snow/ash/embers/sandstorm/fog/leaves — cross-cell
//                    batched lifecycle with drift, wiggle, and fade.
//       - `ripple` → rain — expanding top-down ripples.
//       - `cloud`  → cloudy — soft shadow sprites drifting across the region
//                    along the wind axis.
// Particle motion is deterministic: seeded by (row, col, groupId, time) so
// rendering is stable across pan/zoom. Drawn as a phase of renderCells,
// layered on top of floors/walls/props but below the lightmap so lighting
// can darken weather in shadowed areas.

import type {
  Cell,
  CellGrid,
  CellHalfKey,
  Light,
  Metadata,
  RenderTransform,
  WeatherGroup,
  WeatherType,
} from '../types.js';
import { forEachCellWeatherAssignment, halfClip, cellHasGroup } from '../util/index.js';

// ── Invalidation state ─────────────────────────────────────────────────────
// Two invalidation signals feed the cache:
//   • `_fullRebuild` — next update clears the whole canvas and redraws every
//     weather cell. Used for config edits (affect every cell of a group),
//     group CRUD, undo/redo. Cheap either way.
//   • `_dirtyRect`  — bounding box of cells (in cell coords) that need
//     re-rasterizing. Used for cell-level changes (paint, erase, marquee,
//     flood fill). Expanded as more cells are touched between frames.

let _fullRebuild = true;
let _dirtyRect: { minRow: number; maxRow: number; minCol: number; maxCol: number } | null = null;

/** Next update rebuilds the whole weather canvas from scratch. */
export function markWeatherFullRebuild(): void {
  _fullRebuild = true;
}

/**
 * Expand the dirty rect to include `(row, col)`. Subsequent `updateWeatherCache`
 * will clear + redraw just the bbox of all marked cells — the rest of the
 * cached layer stays untouched.
 */
export function markWeatherCellDirty(row: number, col: number): void {
  if (!_dirtyRect) {
    _dirtyRect = { minRow: row, maxRow: row, minCol: col, maxCol: col };
    return;
  }
  if (row < _dirtyRect.minRow) _dirtyRect.minRow = row;
  if (row > _dirtyRect.maxRow) _dirtyRect.maxRow = row;
  if (col < _dirtyRect.minCol) _dirtyRect.minCol = col;
  if (col > _dirtyRect.maxCol) _dirtyRect.maxCol = col;
}

interface TypeDefaults {
  color: string;
  /** Upper bound on particles per cell at intensity = 1. */
  maxParticles: number;
  shape: 'ripple' | 'flake' | 'cloud';
  /**
   * Particle size as a fraction of cell size. For flake shapes = diameter,
   * for ripple = max radius of the expanding arc, for cloud = diameter in
   * cell-widths (so 3.0 = clouds ~3 cells across).
   */
  sizeFrac: number;
  /** Opacity used when stroking particles. Overridden by haze alpha internally. */
  particleAlpha: number;
  /**
   * Animation speed in cells-per-second at unit wind magnitude. Actual
   * speed is this × |wind|, clamped. Used by cloud shadow drift and some
   * flake wind timing.
   */
  cellsPerSec: number;

  // ── flake-shape tuning ───────────────────────────────────────────────────
  // These only apply when `shape === 'flake'`. Each parameter gives the
  // variant its character — snow is slow + calm, ash settles gently, embers
  // flicker out fast. Unset falls back to snow's values.
  /** Average air-phase duration at no wind, in seconds. Lower = quicker turnover. */
  airDurationBase?: number;
  /** Fade-phase duration at no wind, in seconds. Lower = snappier burn-out. */
  fadeDurationBase?: number;
  /** No-wind 2D wiggle amplitude as a fraction of cell width. Higher = more erratic. */
  wiggleAmp?: number;
  /** Max drift distance in cells at max wind. Higher = more wind-sensitive. */
  windDriftMaxCells?: number;
  /** Max motion-trail length in cells at max wind. Higher = more streak. */
  windTrailMaxCells?: number;
  /**
   * Minimum effective wind magnitude. If set, the wind vector is floored to
   * at least this length (direction still taken from the user's slider), so
   * the weather always reads as windy. Used for sandstorm — wind=0 acts as
   * baseline, and the user's slider layers additional intensity on top.
   */
  baseWindMag?: number;
  /**
   * Minimum effective intensity (0..1). Applied inside cloud rendering so
   * the slider never reads as empty — used by cloudy to guarantee some
   * overhead cover even at "clear skies." Omit for types where 0% should
   * mean truly nothing (e.g. fog).
   */
  intensityFloor?: number;
  /**
   * Ratio of minor axis to major axis (0..1). When set, flakes render as
   * rotating ellipses instead of circles — each particle gets a seeded
   * rotation that drifts slowly over time (tumbling in the air) and freezes
   * once landed. Used for leaves.
   */
  ovalAspect?: number;
  /**
   * For cloud-shape sprites only: how far out from the center each lobe
   * stays at full alpha before fading to transparent. 0 = no plateau
   * (smooth radial fade, very wispy), 0.55 = default cloud-shadow look
   * (solid core + soft edge), 0.9 = almost-solid lobe. Lower values read
   * as softer, foggier patches.
   */
  cloudCoreFrac?: number;
}

const TYPE_DEFAULTS: Record<WeatherType, TypeDefaults> = {
  rain: {
    color: '#a8c8ea',
    maxParticles: 8,
    // From a top-down perspective, rain reads as expanding ripples on the
    // ground where drops hit — not the diagonal streaks you'd see from the
    // side. Ripples spawn at seeded positions, grow outward, and fade.
    shape: 'ripple',
    sizeFrac: 0.3,
    particleAlpha: 0.7,
    cellsPerSec: 1.6,
  },
  snow: {
    color: '#ffffff',
    maxParticles: 7,
    // From top-down, gravity is out-of-plane — flakes don't drift toward the
    // bottom of the canvas on their own. Only wind moves them horizontally;
    // without wind they wiggle near the spawn point and then fade on the
    // floor.
    shape: 'flake',
    sizeFrac: 0.09,
    particleAlpha: 1,
    cellsPerSec: 0.3,
  },
  ash: {
    color: '#8a8a8a',
    maxParticles: 7,
    // Ash re-skins the snow `flake` lifecycle: airborne particles that
    // wiggle, land, and fade. Settles more slowly than snow and lingers on
    // the floor before fading, with a shorter wind trail since light soot
    // doesn't really streak.
    shape: 'flake',
    sizeFrac: 0.065,
    particleAlpha: 0.9,
    cellsPerSec: 0.3,
    airDurationBase: 4.2,
    fadeDurationBase: 2.0,
    wiggleAmp: 0.04,
    windDriftMaxCells: 2.0,
    windTrailMaxCells: 0.15,
  },
  embers: {
    color: '#ff8a3d',
    maxParticles: 8,
    // Embers flicker fast: short airborne window, snappy fade ("burn out"),
    // erratic wiggle (heat turbulence), and longer wind trails so a gust
    // through a fire reads as streaking sparks.
    shape: 'flake',
    sizeFrac: 0.055,
    particleAlpha: 1,
    cellsPerSec: 0.45,
    airDurationBase: 1.0,
    fadeDurationBase: 0.4,
    wiggleAmp: 0.1,
    windDriftMaxCells: 1.8,
    windTrailMaxCells: 0.5,
  },
  sandstorm: {
    color: '#d4b878',
    maxParticles: 14,
    // Sandstorm reuses the flake lifecycle but with a baseline wind floor
    // (25%) so there's always visible sand streaking through, even when the
    // user leaves the wind slider at zero. The user's wind slider layers
    // additional intensity on top up to the normal max. `fadeDurationBase=0`
    // disables the landed/fade phase — sand doesn't settle, it blows past.
    shape: 'flake',
    sizeFrac: 0.03,
    particleAlpha: 0.85,
    cellsPerSec: 2.2,
    airDurationBase: 0.6,
    fadeDurationBase: 0,
    wiggleAmp: 0.03,
    windDriftMaxCells: 3.5,
    windTrailMaxCells: 0.7,
    baseWindMag: 0.25,
  },
  fog: {
    color: '#d4dcde',
    maxParticles: 8,
    // Fog uses the cloud shape — soft volumetric sprites drifting across
    // the region — rather than per-cell particles. Lighter color than
    // cloudy shadows so the patches read as fog tendrils at ground level.
    // `hazeDensity` provides the uniform base fog; these patches add
    // motion and variety on top. Overlap stacks naturally for denser
    // pockets.
    //
    // Wind: the slider sweeps from "gentle fog creep" (wind=0, floored at
    // 10% effective magnitude) to "wind-blown fog" (wind=100%, 10× the
    // floor speed). Without the floor fog sits perfectly still, which
    // reads as dead rather than ambient. No `intensityFloor` so fog can
    // still be fully disabled by dropping intensity to 0.
    shape: 'cloud',
    sizeFrac: 4.0,
    particleAlpha: 0.3,
    cellsPerSec: 2.5,
    baseWindMag: 0.1,
    // Very soft lobes — no solid core plateau, so every fog patch fades
    // from center to edge smoothly and reads as wispy rather than a
    // hard-edged blob.
    cloudCoreFrac: 0.1,
  },
  leaves: {
    color: '#9a7a3a',
    maxParticles: 3,
    // Leaves reuse the flake lifecycle but render as rotating ellipses
    // (tumbling in air, static once landed) rather than circles. Zero wind
    // trail — individual leaf shapes don't streak the way blowing snow or
    // sand does. Long air phase (slow float), pronounced wiggle, and a long
    // settled-fade so fallen leaves linger before drifting away.
    shape: 'flake',
    sizeFrac: 0.1,
    particleAlpha: 0.9,
    cellsPerSec: 0.3,
    airDurationBase: 5.0,
    fadeDurationBase: 2.5,
    wiggleAmp: 0.07,
    windDriftMaxCells: 2.2,
    windTrailMaxCells: 0,
    ovalAspect: 0.45,
  },
  cloudy: {
    // Cloudy = soft cloud-shadow sprites drifting across the whole weather
    // region in the wind direction. Unlike flake-based particles, clouds
    // aren't per-cell — they live in region-space, traverse the bbox along
    // the wind axis, and wrap seamlessly when they exit the far side. A 5%
    // wind floor keeps them always moving. Color is pure black so the low
    // alpha reads as a shadow (less light) rather than a color tint.
    color: '#000000',
    maxParticles: 6, // Number of distinct cloud sprites drifting at once
    shape: 'cloud',
    // `sizeFrac` here = cloud diameter in cell-widths (so 3.0 = spans ~3 cells).
    sizeFrac: 3.0,
    particleAlpha: 0.35,
    cellsPerSec: 1.5, // At max wind, clouds travel ~1.5 cells/sec
    baseWindMag: 0.05,
    intensityFloor: 0.05, // Always at least a hint of cloud cover
  },
};

/** FNV-1a-ish mixer — cheap deterministic hash over (row, col, gid, salt). */
function hashCell(r: number, c: number, gid: string, salt: number): number {
  let h = 2166136261 ^ salt;
  h = Math.imul(h ^ r, 16777619);
  h = Math.imul(h ^ c, 16777619);
  for (let i = 0; i < gid.length; i++) {
    h = Math.imul(h ^ gid.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** Seeded PRNG, returns [0, 1). Splitmix32 variant — decent distribution, tiny code. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert WeatherGroup.wind.direction (0 = north, clockwise) to a canvas-space unit vector. */
function windVector(group: WeatherGroup): { x: number; y: number } {
  const rad = (group.wind.direction * Math.PI) / 180;
  // canvas y increases downward, so "north = up" → y = -cos(θ)
  return {
    x: Math.sin(rad) * group.wind.intensity,
    y: -Math.cos(rad) * group.wind.intensity,
  };
}

interface FlowState {
  /** Unit direction of motion in canvas space (0,0 when the group is static). */
  dirX: number;
  dirY: number;
  /** Unit perpendicular (rotated 90° CCW from dir). */
  perpX: number;
  perpY: number;
  /** True when there's enough motion to run the wind model; false for static fallback. */
  hasMotion: boolean;
  /** Unclamped wind magnitude. Zero when static. */
  mag: number;
}

/**
 * Compute the wind flow parameters for a group. Consumed by the flake and
 * cloud renderers to drive wind-driven drift, swivel, and cloud travel
 * speed. The `baseWindMag` knob lets weather types (sandstorm, cloudy)
 * enforce a minimum wind magnitude regardless of user input.
 */
function flowState(group: WeatherGroup): FlowState {
  const def = TYPE_DEFAULTS[group.type];
  let windX: number;
  let windY: number;
  const rawWind = windVector(group);
  const userWindMag = Math.sqrt(rawWind.x * rawWind.x + rawWind.y * rawWind.y);
  const baseWindMag = def.baseWindMag ?? 0;
  if (baseWindMag > userWindMag) {
    // Floor the wind magnitude at baseWindMag, keeping the user's direction.
    // At user wind=0 the direction field is still meaningful (slider value),
    // so we rebuild the vector from it instead of using the zeroed one.
    const rad = (group.wind.direction * Math.PI) / 180;
    windX = Math.sin(rad) * baseWindMag;
    windY = -Math.cos(rad) * baseWindMag;
  } else {
    windX = rawWind.x;
    windY = rawWind.y;
  }
  const mag = Math.sqrt(windX * windX + windY * windY);
  if (mag < 1e-6) {
    return { dirX: 0, dirY: 0, perpX: 0, perpY: 0, hasMotion: false, mag: 0 };
  }
  const dirX = windX / mag;
  const dirY = windY / mag;
  return { dirX, dirY, perpX: -dirY, perpY: dirX, hasMotion: true, mag };
}

/** Positive-modulo helper — standard `%` in JS returns negative for negative LHS. */
function pmod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

type WeatherBounds = { minRow: number; maxRow: number; minCol: number; maxCol: number };

/**
 * Draw the translucent haze wash over every weather cell. Haze is the only
 * part of weather rendering that's per-cell — particles are dispatched per
 * weather group and drawn in batches by shape-specific renderers
 * (`drawFlakesForGroup`, `drawRipplesForGroup`, `drawCloudsForGroup`).
 */
function _renderHazePass(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  metadata: Metadata | null | undefined,
  gridSize: number,
  transform: RenderTransform,
  bounds?: WeatherBounds | null,
): void {
  if (!metadata) return;
  const groups = metadata.weatherGroups;
  if (!groups || groups.length === 0) return;

  const groupById = new Map<string, WeatherGroup>();
  for (const g of groups) groupById.set(g.id, g);

  const cellPx = gridSize * transform.scale;
  const rMin = bounds ? Math.max(0, bounds.minRow) : 0;
  const rMax = bounds ? Math.min(cells.length - 1, bounds.maxRow) : cells.length - 1;
  const cMin = bounds ? Math.max(0, bounds.minCol) : 0;
  const cMaxDefault = (cells[0]?.length ?? 1) - 1;

  for (let r = rMin; r <= rMax; r++) {
    const row = cells[r];
    if (!row) continue;
    const cMax = bounds ? Math.min(row.length - 1, bounds.maxCol) : cMaxDefault;
    for (let c = cMin; c <= cMax; c++) {
      const cell = row[c];
      if (!cell) continue;
      const cellX = c * gridSize * transform.scale + transform.offsetX;
      const cellY = r * gridSize * transform.scale + transform.offsetY;
      forEachCellWeatherAssignment(cell, (halfKey, gid) => {
        const group = groupById.get(gid);
        if (!group) return;
        if (halfKey === 'full') {
          // Fast path: unsplit cell with no trimClip → plain rect fill.
          if (!cell.trimClip || cell.trimClip.length < 3) {
            drawHazeWash(ctx, group, cellX, cellY, cellPx);
            return;
          }
        }
        // Split or trim-clipped cell: clip to the half's polygon.
        ctx.save();
        ctx.beginPath();
        const rule = halfClip(ctx, cell, halfKey, cellX, cellY, cellPx);
        ctx.clip(rule);
        drawHazeWash(ctx, group, cellX, cellY, cellPx);
        ctx.restore();
      });
    }
  }
}

/**
 * Render weather particles and haze (static — no time offsets) into an
 * arbitrary ctx. This is the canonical static renderer used by PNG export
 * and any caller that wants a snapshot. For the animated editor view, call
 * `renderWeatherHaze` + `renderWeatherParticles` separately.
 * Safe to call when `metadata.weatherGroups` is empty — returns immediately.
 */
export function renderWeatherEffects(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  metadata: Metadata | null | undefined,
  gridSize: number,
  transform: RenderTransform,
  bounds?: { minRow: number; maxRow: number; minCol: number; maxCol: number } | null,
): void {
  // Haze first (in-cell fillRect, no clipping needed). Particles go through
  // the region-clipped path so they stay inside weather regions just like in
  // the animated editor view.
  _renderHazePass(ctx, cells, metadata, gridSize, transform, bounds);
  renderWeatherParticles(ctx, cells, metadata, gridSize, transform, 0);
}

/**
 * Render only the haze wash for weather cells. Used by the editor's world-
 * space cache so haze blits cheaply and the per-frame particle pass can
 * draw animated particles on top without ever invalidating the cache.
 */
export function renderWeatherHaze(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  metadata: Metadata | null | undefined,
  gridSize: number,
  transform: RenderTransform,
  bounds?: { minRow: number; maxRow: number; minCol: number; maxCol: number } | null,
): void {
  _renderHazePass(ctx, cells, metadata, gridSize, transform, bounds);
}

/**
 * Render only the particle layer. Call every frame from the editor with
 * `time = state.animClock` to drive motion; call with `time = 0` for a
 * static snapshot.
 *
 * Clipping is done once per weather group (to the union of the group's cell
 * rects), not per cell — particles drift freely within the region but can't
 * leak out of it. An outer `save/restore` isolates the canvas state so the
 * particle pass doesn't leak its `fillStyle`/`strokeStyle`/`globalAlpha` into
 * subsequent render phases.
 */
export function renderWeatherParticles(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  metadata: Metadata | null | undefined,
  gridSize: number,
  transform: RenderTransform,
  time: number,
): void {
  if (!metadata) return;
  const groups = metadata.weatherGroups;
  if (!groups || groups.length === 0) return;

  // Group weather assignments by group id — per half, so split cells
  // (diagonals, trims) can carry independent groups on each side.
  //
  // `halvesByGroup` drives the clip path: every half-assignment contributes
  // its polygon to the group's union. `cellsByGroup` is the deduplicated
  // cell list handed to the shape-specific draw functions; they sample
  // particles per cell and rely on the outer clip to confine them.
  const halvesByGroup = new Map<string, Array<{ r: number; c: number; halfKey: CellHalfKey }>>();
  const cellsByGroup = new Map<string, Array<[number, number]>>();
  const cellSeenByGroup = new Map<string, Set<string>>();
  for (const g of groups) {
    halvesByGroup.set(g.id, []);
    cellsByGroup.set(g.id, []);
    cellSeenByGroup.set(g.id, new Set());
  }
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      forEachCellWeatherAssignment(cell, (halfKey, gid) => {
        const halves = halvesByGroup.get(gid);
        if (!halves) return;
        halves.push({ r, c, halfKey });
        const seen = cellSeenByGroup.get(gid)!;
        const key = `${r},${c}`;
        if (!seen.has(key)) {
          seen.add(key);
          cellsByGroup.get(gid)!.push([r, c]);
        }
      });
    }
  }

  const cellPx = gridSize * transform.scale;

  ctx.save();
  try {
    for (const group of groups) {
      const halves = halvesByGroup.get(group.id);
      const list = cellsByGroup.get(group.id);
      if (!halves || halves.length === 0 || !list || list.length === 0) continue;

      ctx.save();
      // Build a single clip path that unions every half this group owns.
      // `halfClip` returns 'evenodd' for exterior halves (rect + trimClip
      // hole); we upgrade the whole group's clip to even-odd if any
      // contributor needs it — full/interior/diagonal halves don't overlap
      // each other, so even-odd still renders them correctly.
      ctx.beginPath();
      let evenodd = false;
      for (let i = 0; i < halves.length; i++) {
        const h = halves[i]!;
        const cell = cells[h.r]?.[h.c];
        if (!cell) continue;
        const x = h.c * gridSize * transform.scale + transform.offsetX;
        const y = h.r * gridSize * transform.scale + transform.offsetY;
        const rule = halfClip(ctx, cell, h.halfKey, x, y, cellPx);
        if (rule === 'evenodd') evenodd = true;
      }
      ctx.clip(evenodd ? 'evenodd' : 'nonzero');

      const shape = TYPE_DEFAULTS[group.type].shape;
      if (shape === 'flake') {
        drawFlakesForGroup(ctx, group, list, gridSize, transform, cellPx, time);
      } else if (shape === 'cloud') {
        drawCloudsForGroup(ctx, group, list, gridSize, transform, cellPx, time);
      } else {
        drawRipplesForGroup(ctx, group, list, gridSize, transform, cellPx, time);
      }

      ctx.restore();
    }
  } finally {
    ctx.restore();
  }
}

// ── Weather cache ──────────────────────────────────────────────────────────
// World-space offscreen canvas: weather is drawn once at map resolution
// (`pxPerFoot` pixels per foot) and reused across frames until weatherVersion
// changes. Blit scales it to the viewport via transform. Pan + zoom cost
// a single drawImage; slider tweaks rebuild only this cache, never the
// (expensive) cells cache.

interface WeatherCacheState {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  /** Source canvas dimensions (world pixels = rows/cols × gridSize × pxPerFoot). */
  cacheW: number;
  cacheH: number;
  /** Map dims / resolution baked into the current cache. */
  rows: number;
  cols: number;
  gridSize: number;
  pxPerFoot: number;
  /** True when the metadata has no weather groups — skip cache + blit entirely. */
  empty: boolean;
  /** True once the canvas has content matching the inputs (stays false while dirty). */
  initialized: boolean;
}

const cache: WeatherCacheState = {
  canvas: null,
  ctx: null,
  cacheW: 0,
  cacheH: 0,
  rows: 0,
  cols: 0,
  gridSize: 0,
  pxPerFoot: 0,
  empty: true,
  initialized: false,
};

/** Force a full rebuild on the next `updateWeatherCache` call. */
export function invalidateWeatherCache(): void {
  _fullRebuild = true;
  _dirtyRect = null;
  cache.initialized = false;
}

/** Reset cache to empty state — free the offscreen canvas (e.g. on new map). */
export function clearWeatherCache(): void {
  cache.canvas = null;
  cache.ctx = null;
  cache.cacheW = 0;
  cache.cacheH = 0;
  cache.rows = 0;
  cache.cols = 0;
  cache.gridSize = 0;
  cache.pxPerFoot = 0;
  cache.empty = true;
  cache.initialized = false;
  _fullRebuild = true;
  _dirtyRect = null;
}

function resizeCache(w: number, h: number): void {
  if (cache.canvas && cache.cacheW === w && cache.cacheH === h) return;
  cache.canvas = document.createElement('canvas');
  cache.canvas.width = w;
  cache.canvas.height = h;
  cache.ctx = cache.canvas.getContext('2d');
  cache.cacheW = w;
  cache.cacheH = h;
  // Dimensions changed — old contents are gone.
  cache.initialized = false;
}

/**
 * Rebuild the weather cache if anything that affects it has changed.
 *
 * - Dimensions/resolution changed → full rebuild (different canvas).
 * - `markWeatherFullRebuild` was called → full rebuild.
 * - Dirty cells marked via `markWeatherCellDirty` → clear + redraw only the
 *   bbox of those cells.
 * - Otherwise → no-op (cheap version check).
 */
export function updateWeatherCache(
  cells: CellGrid,
  metadata: Metadata | null | undefined,
  gridSize: number,
  numRows: number,
  numCols: number,
  pxPerFoot: number,
): void {
  const groups = metadata?.weatherGroups;
  const hasGroups = !!groups && groups.length > 0;

  const dimsChanged =
    cache.rows !== numRows || cache.cols !== numCols || cache.gridSize !== gridSize || cache.pxPerFoot !== pxPerFoot;

  // Fast path: nothing dirty, nothing changed — reuse cache as-is.
  if (!dimsChanged && !_fullRebuild && !_dirtyRect && cache.initialized) return;

  cache.rows = numRows;
  cache.cols = numCols;
  cache.gridSize = gridSize;
  cache.pxPerFoot = pxPerFoot;
  cache.empty = !hasGroups;

  if (!hasGroups) {
    // Nothing to draw; leave the canvas alone. Clear accumulated dirty state
    // so later re-enabling weather doesn't trigger a stale partial update.
    _fullRebuild = false;
    _dirtyRect = null;
    cache.initialized = true;
    return;
  }

  const w = Math.ceil(numCols * gridSize * pxPerFoot);
  const h = Math.ceil(numRows * gridSize * pxPerFoot);
  if (w <= 0 || h <= 0) {
    cache.empty = true;
    _fullRebuild = false;
    _dirtyRect = null;
    return;
  }

  resizeCache(w, h);
  const ctx = cache.ctx;
  if (!ctx) {
    cache.empty = true;
    return;
  }

  const worldTransform: RenderTransform = { scale: pxPerFoot, offsetX: 0, offsetY: 0 };

  // If the canvas is pristine (never drawn, or just resized) we must do a
  // full rebuild — partial rebuilds assume the existing canvas content is
  // consistent with the current state minus the dirty region.
  const needsFull = dimsChanged || _fullRebuild || !cache.initialized;

  if (needsFull) {
    ctx.clearRect(0, 0, w, h);
    renderWeatherHaze(ctx, cells, metadata, gridSize, worldTransform);
  } else if (_dirtyRect) {
    // Partial update: clear the bbox of dirty cells and redraw just the
    // haze there. The per-frame particle pass runs on the main canvas each
    // frame, so the cache itself only tracks the time-invariant haze layer.
    const cellSize = gridSize * pxPerFoot;
    const rMin = Math.max(0, _dirtyRect.minRow);
    const rMax = Math.min(numRows - 1, _dirtyRect.maxRow);
    const cMin = Math.max(0, _dirtyRect.minCol);
    const cMax = Math.min(numCols - 1, _dirtyRect.maxCol);
    if (rMin <= rMax && cMin <= cMax) {
      const x = cMin * cellSize;
      const y = rMin * cellSize;
      const rectW = (cMax - cMin + 1) * cellSize;
      const rectH = (rMax - rMin + 1) * cellSize;
      ctx.clearRect(x, y, rectW, rectH);
      renderWeatherHaze(ctx, cells, metadata, gridSize, worldTransform, {
        minRow: rMin,
        maxRow: rMax,
        minCol: cMin,
        maxCol: cMax,
      });
    }
  }

  _fullRebuild = false;
  _dirtyRect = null;
  cache.initialized = true;
}

/**
 * Blit the cached weather layer into `ctx` using the viewport transform.
 * A single drawImage — pan + zoom cost essentially nothing.
 */
export function blitWeatherCache(ctx: CanvasRenderingContext2D, transform: RenderTransform): void {
  if (cache.empty || !cache.canvas || cache.cacheW <= 0 || cache.cacheH <= 0) return;
  const s = transform.scale / cache.pxPerFoot;
  ctx.drawImage(
    cache.canvas,
    0,
    0,
    cache.cacheW,
    cache.cacheH,
    transform.offsetX,
    transform.offsetY,
    cache.cacheW * s,
    cache.cacheH * s,
  );
}

// ── Lightning as point lights ──────────────────────────────────────────────
// Lightning isn't a full-screen overlay — it's a transient point light
// dropped at a random cell inside the weather group. The existing lightmap
// renderer draws it like any other light, so walls/props cast shadows and
// the flash falls off with distance. Strikes are rare, brief, and intense.

/** Duration of each flash, in seconds. Short and sharp — real lightning is brief. */
const FLASH_DURATION = 0.18;
/** Attack time (ramp-up) as a fraction of `FLASH_DURATION`. */
const FLASH_ATTACK_FRAC = 0.1;
/**
 * Probabilistic time window for strike events, in seconds. Larger window
 * = rarer strikes overall. At `frequency = 1` there's exactly one expected
 * strike per window; at `frequency = 0.3` roughly one every three windows.
 */
const STRIKE_WINDOW = 3.0;

/** Peak light intensity multiplier per unit of `group.lightning.intensity`. */
const FLASH_INTENSITY_SCALE = 2.5;
/** Base radius (ft) before intensity scaling. */
const FLASH_BASE_RADIUS = 40;
/** Additional radius (ft) per unit of intensity. */
const FLASH_RADIUS_PER_INTENSITY = 60;
/**
 * Soft-shadow area-source radius (ft). The Light engine samples across a
 * disc of this size to produce penumbra wedges; typical lamps use 0.5–2 ft.
 * Lightning is a huge diffuse bolt, so we push this much higher for
 * strongly softened shadows.
 */
const FLASH_SOFT_SHADOW_RADIUS = 8;
/**
 * Light z-height in feet. A lightning bolt runs from the sky to the ground,
 * so the effective light origin sits well above the floor. The lighting
 * engine uses z to decide whether short props (chairs, rubble) cast
 * shadows — above ~6 ft they stop occluding. 10 ft puts the source around
 * normal ceiling height so only walls and tall props shadow.
 */
const FLASH_Z_HEIGHT = 10;

interface StrikeState {
  /** Envelope value in [0, 1] — shape of the flash's brightness over time. */
  envelope: number;
  /** Deterministic [0, 1) used to pick a cell within the group. */
  cellSeed: number;
}

/**
 * Deterministic per-group strike state at `time`. Returns null when no strike
 * is active in the current window. The cell-picking seed is part of the
 * returned data so the strike stays in one spot for its whole lifetime.
 */
function computeStrikeState(time: number, groupId: string, frequency: number): StrikeState | null {
  if (frequency <= 0) return null;
  const strikeProb = Math.min(1, frequency);
  const bucket = Math.floor(time / STRIKE_WINDOW);

  // Hash (bucket, groupId) → 32-bit int → normalized to [0, 1).
  let h = 2166136261 ^ bucket;
  h = Math.imul(h ^ (bucket >>> 8), 16777619);
  for (let i = 0; i < groupId.length; i++) h = Math.imul(h ^ groupId.charCodeAt(i), 16777619);
  const r01 = (h >>> 0) / 0x100000000;
  if (r01 >= strikeProb) return null;

  // Second hash for the strike's offset within the window.
  const h2 = Math.imul(h ^ 0xdeadbeef, 1597334677);
  const offset01 = (h2 >>> 0) / 0x100000000;
  const strikeTime = bucket * STRIKE_WINDOW + offset01 * STRIKE_WINDOW;
  const age = time - strikeTime;
  if (age < 0 || age > FLASH_DURATION) return null;

  const attack = FLASH_DURATION * FLASH_ATTACK_FRAC;
  let envelope: number;
  if (age < attack) envelope = age / attack;
  else envelope = 1 - (age - attack) / (FLASH_DURATION - attack);

  // Third hash for cell selection — stable across every frame of this strike.
  const h3 = Math.imul(h ^ 0xbadc0de, 374761393);
  const cellSeed = (h3 >>> 0) / 0x100000000;
  return { envelope, cellSeed };
}

/**
 * A cell is eligible to host a lightning strike if it has no wall or door
 * on any edge. Picking a strike cell with walls puts the light source *on*
 * the wall, which leaks illumination through into adjacent rooms — the
 * scene should only light up on the weather-exposed side of the wall.
 */
function isStrikeEligibleCell(cell: Cell): boolean {
  return !cell.north && !cell.south && !cell.east && !cell.west && !cell['nw-se'] && !cell['ne-sw'];
}

/**
 * Pick the Nth eligible floor cell belonging to `groupId`, deterministic
 * on `seed`. Wall-bordering cells are excluded so the strike always
 * originates in open space. Returns `null` when the group has no eligible
 * cells — the caller simply skips the strike, which is safer than spawning
 * the bolt on a wall where it leaks light to the other side.
 */
function pickStrikeCell(cells: CellGrid, groupId: string, seed: number): [number, number] | null {
  let count = 0;
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || !cellHasGroup(cell, groupId)) continue;
      if (isStrikeEligibleCell(cell)) count++;
    }
  }
  if (count === 0) return null;
  const target = Math.floor(seed * count);
  let i = 0;
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || !cellHasGroup(cell, groupId)) continue;
      if (!isStrikeEligibleCell(cell)) continue;
      if (i === target) return [r, c];
      i++;
    }
  }
  return null;
}

/**
 * Returns true if any weather group has an active lightning effect (enabled
 * + positive intensity + positive frequency + lighting enabled on the map).
 * Used by the editor to decide whether to keep the animation loop running
 * and whether to bypass the mapCache's static-lighting bake.
 */
export function hasActiveWeatherLightning(metadata: Metadata | null | undefined): boolean {
  if (!metadata?.lightingEnabled) return false;
  const groups = metadata.weatherGroups;
  if (!groups || groups.length === 0) return false;
  for (const g of groups) {
    if (g.lightning.enabled && g.lightning.intensity > 0 && g.lightning.frequency > 0) return true;
  }
  return false;
}

/**
 * Returns true if any weather group has particles worth animating. Every
 * supported shape (ripple, flake, cloud) has intrinsic motion — ripples
 * expand in place, flakes wiggle and fade, clouds drift along the wind
 * axis — so any group with intensity > 0 needs the animation loop ticking.
 */
export function hasActiveWeatherParticles(metadata: Metadata | null | undefined): boolean {
  const groups = metadata?.weatherGroups;
  if (!groups || groups.length === 0) return false;
  for (const g of groups) {
    if (g.intensity > 0) return true;
  }
  return false;
}

/**
 * Produce ephemeral `Light` objects for every weather group currently mid-
 * strike at `time`. The caller concatenates these onto the regular lights
 * array before calling `renderLightmap`, and the standard lighting pipeline
 * takes care of shadows, falloff, and blending.
 *
 * Returns an empty array in the common case (no active strikes), so the
 * caller can skip allocation when possible.
 */
export function extractWeatherLightningLights(
  cells: CellGrid,
  metadata: Metadata | null | undefined,
  time: number,
  gridSize: number,
): Light[] {
  if (!metadata?.lightingEnabled) return [];
  const groups = metadata.weatherGroups;
  if (!groups || groups.length === 0) return [];
  const lights: Light[] = [];
  // Negative IDs keep these from colliding with real lights in any map-wide
  // light set; the lightmap renderer treats IDs as per-frame identity only.
  let nextId = -1_000_000;
  for (const g of groups) {
    if (!g.lightning.enabled) continue;
    if (g.lightning.intensity <= 0 || g.lightning.frequency <= 0) continue;
    const strike = computeStrikeState(time, g.id, g.lightning.frequency);
    if (!strike) continue;
    const cell = pickStrikeCell(cells, g.id, strike.cellSeed);
    if (!cell) continue;
    const [row, col] = cell;
    const radius = FLASH_BASE_RADIUS + g.lightning.intensity * FLASH_RADIUS_PER_INTENSITY;
    lights.push({
      id: nextId--,
      x: col * gridSize + gridSize / 2,
      y: row * gridSize + gridSize / 2,
      type: 'point',
      radius,
      color: g.lightning.color ?? '#c4d8ff',
      intensity: strike.envelope * g.lightning.intensity * FLASH_INTENSITY_SCALE,
      falloff: 'sharp',
      // Source sits overhead — lightning comes from the sky, so short props
      // shouldn't cast floor shadows. Walls (full-height) still do.
      z: FLASH_Z_HEIGHT,
      // Very large area-source radius — lightning is a wide diffuse bolt,
      // not a pinpoint, so shadows should have wide penumbra wedges rather
      // than the sharp single-ray edges of a torch flame.
      softShadowRadius: FLASH_SOFT_SHADOW_RADIUS,
      // Marking with any animation.type routes the light through the engine's
      // animated path (rebuilt every frame) instead of the static cache
      // (which is only flushed on visibility-cache invalidation). The switch
      // in getEffectiveLight() has no case for this string, so the engine
      // passes our intensity through unchanged — we've already baked the
      // envelope in above.
      animation: { type: 'weather-strike' },
    });
  }
  return lights;
}

function drawHazeWash(
  ctx: CanvasRenderingContext2D,
  group: WeatherGroup,
  cellX: number,
  cellY: number,
  cellPx: number,
): void {
  if (group.hazeDensity <= 0) return;
  const def = TYPE_DEFAULTS[group.type];
  const color = group.particleColor ?? def.color;
  // Cap at 0.5 so weather never completely occludes the floor; fog still reads
  // as heavy at density = 1 because the flake-blob particles layer on top.
  ctx.globalAlpha = Math.min(0.5, group.hazeDensity * 0.5);
  ctx.fillStyle = color;
  ctx.fillRect(cellX, cellY, cellPx, cellPx);
}

// Module-scope scratch buffers for cross-cell batched ripple rendering.
// Each ripple has a unique alpha (fade progress) and radius, but arcs of
// any radius can share a single path — so bucketing by alpha lets the whole
// group stroke in one call per bucket.
const RIPPLE_FADE_BUCKETS = 5;
const _rippleBucketX: number[][] = Array.from({ length: RIPPLE_FADE_BUCKETS }, () => []);
const _rippleBucketY: number[][] = Array.from({ length: RIPPLE_FADE_BUCKETS }, () => []);
const _rippleBucketR: number[][] = Array.from({ length: RIPPLE_FADE_BUCKETS }, () => []);

/**
 * Batched rain renderer: consumes every cell of a weather group in one pass
 * and issues up to `RIPPLE_FADE_BUCKETS` stroke calls total instead of one
 * per live ripple.
 *
 * Each "slot" in a cell has its own period and spawn position; within each
 * period a ripple is born, expands to `maxRadius`, and fades. Between ripples
 * the slot is silent so neighboring slots stagger instead of pulsing
 * together.
 */
function drawRipplesForGroup(
  ctx: CanvasRenderingContext2D,
  group: WeatherGroup,
  cellList: Array<[number, number]>,
  gridSize: number,
  transform: RenderTransform,
  cellPx: number,
  time: number,
): void {
  const def = TYPE_DEFAULTS[group.type];
  if (def.shape !== 'ripple') return;
  const color = group.particleColor ?? def.color;
  const alpha = def.particleAlpha;
  const maxRadius = cellPx * def.sizeFrac;
  const liveFrac = 0.45;
  const count = Math.round(def.maxParticles * group.intensity);
  if (count <= 0) return;

  for (let b = 0; b < RIPPLE_FADE_BUCKETS; b++) {
    _rippleBucketX[b]!.length = 0;
    _rippleBucketY[b]!.length = 0;
    _rippleBucketR[b]!.length = 0;
  }

  const scale = transform.scale;
  const offX = transform.offsetX;
  const offY = transform.offsetY;

  for (let ci = 0; ci < cellList.length; ci++) {
    const rc = cellList[ci] as [number, number];
    const r = rc[0];
    const c = rc[1];
    const cellX = c * gridSize * scale + offX;
    const cellY = r * gridSize * scale + offY;
    const seed = hashCell(r, c, group.id, 0);
    const rand = makeRng(seed);

    for (let i = 0; i < count; i++) {
      const px = rand() * cellPx;
      const py = rand() * cellPx;
      const periodJitter = 0.9 + rand() * 1.1;
      const phaseOffset = rand();
      const cyclePhase = pmod(time / periodJitter + phaseOffset, 1);
      if (cyclePhase > liveFrac) continue;
      const rippleProgress = cyclePhase / liveFrac;
      const radius = rippleProgress * maxRadius;
      const fade = 1 - rippleProgress;
      let bucket = (fade * RIPPLE_FADE_BUCKETS) | 0;
      if (bucket < 0) bucket = 0;
      else if (bucket >= RIPPLE_FADE_BUCKETS) bucket = RIPPLE_FADE_BUCKETS - 1;
      _rippleBucketX[bucket]!.push(cellX + px);
      _rippleBucketY[bucket]!.push(cellY + py);
      _rippleBucketR[bucket]!.push(radius);
    }
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.8, cellPx * 0.02);
  ctx.lineCap = 'round';

  for (let b = 0; b < RIPPLE_FADE_BUCKETS; b++) {
    const xs = _rippleBucketX[b] as number[];
    const n = xs.length;
    if (n === 0) continue;
    const ys = _rippleBucketY[b] as number[];
    const rs = _rippleBucketR[b] as number[];
    ctx.globalAlpha = alpha * ((b + 0.5) / RIPPLE_FADE_BUCKETS);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const fx = xs[i] as number;
      const fy = ys[i] as number;
      const fr = rs[i] as number;
      ctx.moveTo(fx + fr, fy);
      ctx.arc(fx, fy, fr, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
}

/**
 * Snow from top-down. Gravity is out-of-plane so flakes don't drift down the
 * canvas on their own — each flake lives in two phases:
 *
 *  • Air phase: if wind is present, the flake drifts along the wind vector
 *    toward a seeded landing spot (distance scales with wind strength) with
 *    a sinusoidal perpendicular swivel. With no wind, it just wiggles in a
 *    small 2D pattern near the spawn spot.
 *  • Landed phase: position locked, alpha fades to zero.
 *
 * Phase seeds stagger flakes so a cell always holds a mix of mid-drift,
 * mid-wiggle, and mid-fade particles.
 */
// Module-scope scratch buffers for cross-cell batched flake rendering.
// FADE_BUCKETS quantizes fade alpha so all fade particles across the whole
// group can be drawn with ~FADE_BUCKETS fill calls instead of one per
// particle. 4 buckets is visually indistinguishable from continuous alpha
// for a dim short-lived fade.
const FADE_BUCKETS = 4;
const _fadeBucketX: number[][] = Array.from({ length: FADE_BUCKETS }, () => []);
const _fadeBucketY: number[][] = Array.from({ length: FADE_BUCKETS }, () => []);
// Rotation per fade entry — only used for oval-shaped flake variants (leaves).
// Kept populated in lockstep with X/Y when `ovalAspect` is set, left empty
// otherwise.
const _fadeBucketRot: number[][] = Array.from({ length: FADE_BUCKETS }, () => []);

// Collected positions for oval-shaped flake variants (leaves). These get
// baked into a single batched Path2D after the main loop via Path2D.addPath,
// so the whole group of leaves is drawn with one ctx.fill call — same
// batching discipline as snow/ash/embers.
const _ovalAirX: number[] = [];
const _ovalAirY: number[] = [];
const _ovalAirRot: number[] = [];

// Cached unit-ellipse Path2D template. addPath(template, matrix) transforms
// the template by the given affine matrix when appending — so one template
// is all we need regardless of per-leaf rotation.
let _leafTemplate: Path2D | null = null;
let _leafTemplateKey = '';
// Reusable matrix object passed to addPath per particle. addPath snapshots
// matrix values at call time, so we can set fields and reuse without
// allocating a new DOMMatrix per leaf.
const _leafMatrix: DOMMatrix | null = typeof DOMMatrix !== 'undefined' ? new DOMMatrix() : null;

function getLeafTemplate(majorR: number, minorR: number): Path2D | null {
  const key = `${majorR.toFixed(2)}|${minorR.toFixed(2)}`;
  if (_leafTemplate && _leafTemplateKey === key) return _leafTemplate;
  if (typeof Path2D === 'undefined') return null;
  _leafTemplate = new Path2D();
  _leafTemplate.ellipse(0, 0, majorR, minorR, 0, 0, Math.PI * 2);
  _leafTemplateKey = key;
  return _leafTemplate;
}

/**
 * Batched snow renderer: consumes every cell of a weather group in one pass
 * and issues only ~5 canvas draw calls total (1 air stroke/fill + up to 4
 * fade bucket fills), instead of O(cells × particles) individual draws.
 *
 * This is the critical perf path — per-particle canvas calls are dominated
 * by GPU state-change overhead, so a 400-cell blizzard goes from thousands
 * of draws to a handful per frame.
 */
function drawFlakesForGroup(
  ctx: CanvasRenderingContext2D,
  group: WeatherGroup,
  cellList: Array<[number, number]>,
  gridSize: number,
  transform: RenderTransform,
  cellPx: number,
  time: number,
): void {
  const def = TYPE_DEFAULTS[group.type];
  if (def.shape !== 'flake') return;
  const color = group.particleColor ?? def.color;
  const alpha = def.particleAlpha;
  const flow = flowState(group);

  const radius = Math.max(0.8, cellPx * def.sizeFrac * 0.5);

  // Per-variant tuning — defaults match snow.
  const airBase = def.airDurationBase ?? 3.5;
  const fadeBase = def.fadeDurationBase ?? 1.2;
  const wiggleAmp = def.wiggleAmp ?? 0.05;
  const driftMax = def.windDriftMaxCells ?? 2.5;
  const trailMax = def.windTrailMaxCells ?? 0.3;
  const ovalAspect = def.ovalAspect;
  const isOval = ovalAspect !== undefined && ovalAspect > 0;
  // Oval variants (leaves) need a larger draw radius to feel visibly leafy
  // — the flattened ellipse reads as smaller than a circle of the same base
  // radius, so we bump the long axis.
  const majorRadius = isOval ? radius * 1.6 : radius;
  const minorRadius = isOval ? majorRadius * ovalAspect : radius;

  const windFactor = flow.hasMotion ? Math.min(1, flow.mag) : 0;
  // Drift formula preserves snow's original behavior (0.6 at calm, 2.5 at
  // max wind) when driftMax=2.5, and scales proportionally for other types.
  const windDriftCells = flow.hasMotion ? driftMax * (0.24 + 0.76 * windFactor * windFactor) : 0;
  const airScale = 1 - windFactor * 0.75;
  const fadeDuration = fadeBase * (1 - windFactor * 0.75);
  const trailCells = flow.hasMotion ? windFactor * trailMax : 0;
  const useStreaks = trailCells > 0.02;
  const trailDx = useStreaks ? -flow.dirX * cellPx * trailCells : 0;
  const trailDy = useStreaks ? -flow.dirY * cellPx * trailCells : 0;

  const baseCount = Math.round(def.maxParticles * group.intensity * (1 + windFactor * 2));
  if (baseCount <= 0) return;

  // Reset bucket scratch without reallocating.
  for (let b = 0; b < FADE_BUCKETS; b++) {
    _fadeBucketX[b]!.length = 0;
    _fadeBucketY[b]!.length = 0;
    if (isOval) _fadeBucketRot[b]!.length = 0;
  }
  if (isOval) {
    _ovalAirX.length = 0;
    _ovalAirY.length = 0;
    _ovalAirRot.length = 0;
  }

  // Single path for all air-phase flakes across every cell in the group
  // (circles or streaks). Oval flakes skip the path build — they render via
  // sprite blits in a separate pass below.
  if (!isOval) {
    if (useStreaks) {
      ctx.strokeStyle = color;
      ctx.lineWidth = radius * 2;
      ctx.lineCap = 'round';
    } else {
      ctx.fillStyle = color;
    }
    ctx.globalAlpha = alpha;
    ctx.beginPath();
  }

  let airHasAny = false;
  const scale = transform.scale;
  const offX = transform.offsetX;
  const offY = transform.offsetY;

  for (let ci = 0; ci < cellList.length; ci++) {
    const rc = cellList[ci] as [number, number];
    const r = rc[0];
    const c = rc[1];
    const cellX = c * gridSize * scale + offX;
    const cellY = r * gridSize * scale + offY;
    const seed = hashCell(r, c, group.id, 0);
    const rand = makeRng(seed);

    for (let i = 0; i < baseCount; i++) {
      const xSeed = rand();
      const ySeed = rand();
      const phaseSeed = rand();
      const swivelSeed = rand();
      const periodSeed = rand();
      // Oval variants consume an extra rand for their seeded rotation so
      // each leaf has its own orientation.
      const rotSeed = isOval ? rand() : 0;

      // ±30% jitter, proportional to airBase — a fixed ±1s jitter would push
      // sub-second airBase values (embers, sandstorm) into zero or negative.
      const airDuration = airBase * (1 + (periodSeed - 0.5) * 0.6) * airScale;
      const totalDuration = airDuration + fadeDuration;
      const lifeTime = pmod(time + phaseSeed * totalDuration, totalDuration);

      const landX = cellX + xSeed * cellPx;
      const landY = cellY + ySeed * cellPx;

      if (lifeTime < airDuration) {
        const progress = lifeTime / airDuration;
        let px: number;
        let py: number;
        if (flow.hasMotion) {
          const driftDist = cellPx * windDriftCells * (1 - progress);
          const swivelFreq = 1.0 + swivelSeed * 0.8;
          const swivelPhase = time * swivelFreq * Math.PI * 2 + swivelSeed * 100;
          const swivelAmount = Math.sin(swivelPhase) * cellPx * 0.07;
          px = landX - flow.dirX * driftDist + flow.perpX * swivelAmount;
          py = landY - flow.dirY * driftDist + flow.perpY * swivelAmount;
        } else {
          const wiggleFreq = 0.8 + swivelSeed * 0.6;
          const phaseA = time * wiggleFreq * Math.PI * 2 + swivelSeed * 100;
          const phaseB = time * wiggleFreq * Math.PI * 2 * 1.3 + swivelSeed * 50 + 1.7;
          px = landX + Math.sin(phaseA) * cellPx * wiggleAmp;
          py = landY + Math.cos(phaseB) * cellPx * wiggleAmp;
        }
        // Fade-in envelope at the start of air phase: first `fadeInFrac`
        // of the airborne window ramps alpha from 0→1 so particles don't
        // pop in. Streaks skip fade-in (bucketing them would require a
        // second stroke path and visual gain is minor when trails are
        // short-lived).
        const fadeInFrac = useStreaks ? 0 : 0.15;
        const alphaFactor = fadeInFrac > 0 && progress < fadeInFrac ? progress / fadeInFrac : 1;
        if (alphaFactor >= 0.99 || useStreaks) {
          airHasAny = true;
          if (useStreaks) {
            ctx.moveTo(px, py);
            ctx.lineTo(px + trailDx, py + trailDy);
          } else if (isOval) {
            // Defer oval rendering to a sprite-blit pass after the loop
            // — path ops are too expensive per particle for thousands of
            // leaves. Rotation tumbles while airborne.
            const rotation = rotSeed * Math.PI * 2 + time * (rotSeed - 0.5) * 0.8;
            _ovalAirX.push(px);
            _ovalAirY.push(py);
            _ovalAirRot.push(rotation);
          } else {
            ctx.moveTo(px + radius, py);
            ctx.arc(px, py, radius, 0, Math.PI * 2);
          }
        } else {
          // Fade-in: share the fade buckets with fade-out particles. Same
          // alpha quantization; position is the live airborne spot, not
          // the landing spot.
          let bucket = (alphaFactor * FADE_BUCKETS) | 0;
          if (bucket < 0) bucket = 0;
          else if (bucket >= FADE_BUCKETS) bucket = FADE_BUCKETS - 1;
          _fadeBucketX[bucket]!.push(px);
          _fadeBucketY[bucket]!.push(py);
          if (isOval) {
            // Live tumbling rotation while fading in.
            const rotation = rotSeed * Math.PI * 2 + time * (rotSeed - 0.5) * 0.8;
            _fadeBucketRot[bucket]!.push(rotation);
          }
        }
      } else {
        const fadeProgress = (lifeTime - airDuration) / fadeDuration;
        const particleAlpha = 1 - fadeProgress; // 1..0
        let bucket = (particleAlpha * FADE_BUCKETS) | 0;
        if (bucket < 0) bucket = 0;
        else if (bucket >= FADE_BUCKETS) bucket = FADE_BUCKETS - 1;
        _fadeBucketX[bucket]!.push(landX);
        _fadeBucketY[bucket]!.push(landY);
        if (isOval) {
          // Landed leaves freeze their rotation — no more tumbling.
          _fadeBucketRot[bucket]!.push(rotSeed * Math.PI * 2);
        }
      }
    }
  }

  if (isOval) {
    // Batched oval-flake rendering via Path2D.addPath. Each leaf's rotated
    // ellipse is appended to a single Path2D by transforming a cached unit-
    // ellipse template through a reused DOMMatrix — then one ctx.fill per
    // alpha level draws every leaf in one GPU call. This is the same
    // batching discipline as snow, just with per-particle transforms.
    const template = getLeafTemplate(majorRadius, minorRadius);
    const matrix = _leafMatrix;
    if (template && matrix) {
      ctx.fillStyle = color;

      // Air phase.
      const airN = _ovalAirX.length;
      if (airN > 0) {
        const airPath = new Path2D();
        for (let i = 0; i < airN; i++) {
          const px = _ovalAirX[i] as number;
          const py = _ovalAirY[i] as number;
          const rot = _ovalAirRot[i] as number;
          const cosR = Math.cos(rot);
          const sinR = Math.sin(rot);
          matrix.a = cosR;
          matrix.b = sinR;
          matrix.c = -sinR;
          matrix.d = cosR;
          matrix.e = px;
          matrix.f = py;
          airPath.addPath(template, matrix);
        }
        ctx.globalAlpha = alpha;
        ctx.fill(airPath);
      }

      // Fade buckets — one globalAlpha + one fill per bucket.
      for (let b = 0; b < FADE_BUCKETS; b++) {
        const xs = _fadeBucketX[b] as number[];
        const n = xs.length;
        if (n === 0) continue;
        const ys = _fadeBucketY[b] as number[];
        const rots = _fadeBucketRot[b] as number[];
        const fadePath = new Path2D();
        for (let i = 0; i < n; i++) {
          const fx = xs[i] as number;
          const fy = ys[i] as number;
          const rot = rots[i] as number;
          const cosR = Math.cos(rot);
          const sinR = Math.sin(rot);
          matrix.a = cosR;
          matrix.b = sinR;
          matrix.c = -sinR;
          matrix.d = cosR;
          matrix.e = fx;
          matrix.f = fy;
          fadePath.addPath(template, matrix);
        }
        ctx.globalAlpha = alpha * ((b + 0.5) / FADE_BUCKETS);
        ctx.fill(fadePath);
      }
    }
    return;
  }

  if (airHasAny) {
    if (useStreaks) ctx.stroke();
    else ctx.fill();
  }

  // Flush fade buckets — up to FADE_BUCKETS fills for the whole group.
  ctx.fillStyle = color;
  for (let b = 0; b < FADE_BUCKETS; b++) {
    const xs = _fadeBucketX[b] as number[];
    const n = xs.length;
    if (n === 0) continue;
    const ys = _fadeBucketY[b] as number[];
    ctx.globalAlpha = alpha * ((b + 0.5) / FADE_BUCKETS);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const fx = xs[i] as number;
      const fy = ys[i] as number;
      ctx.moveTo(fx + radius, fy);
      ctx.arc(fx, fy, radius, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

// ── Cloud shadows ──────────────────────────────────────────────────────────
// `cloudy` weather isn't per-cell particles — it's a handful of soft cloud-
// shadow sprites that drift across the whole weather region in the wind
// direction. Each sprite is pre-rendered once (lumpy blob via overlapping
// radial gradients), then blitted with drawImage at a time-based position
// that wraps when it exits the region's bounding box along the wind axis.
// The region clip (set in renderWeatherParticles) masks the sprites to the
// actual weather region shape.

const CLOUD_SPRITE_SIZE = 256;
const CLOUD_VARIANTS = 4;
// Multi-slot cache so multiple cloud-shape groups (e.g. cloudy + fog on the
// same map) don't thrash each other's sprites each frame.
const _cloudSpriteCache = new Map<string, HTMLCanvasElement[]>();

function cloudColorStops(hex: string, alphaMax: number): { inner: string; outer: string } {
  let r = 0;
  let g = 0;
  let b = 0;
  if (hex.length === 7 && hex.startsWith('#')) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else if (hex.length === 4 && hex.startsWith('#')) {
    const rr = hex[1] as string;
    const gg = hex[2] as string;
    const bb = hex[3] as string;
    r = parseInt(rr + rr, 16);
    g = parseInt(gg + gg, 16);
    b = parseInt(bb + bb, 16);
  }
  return {
    inner: `rgba(${r},${g},${b},${alphaMax})`,
    outer: `rgba(${r},${g},${b},0)`,
  };
}

function getCloudSprites(color: string, coreFrac: number): HTMLCanvasElement[] | null {
  // Key includes coreFrac so cloudy (hard-core shadows) and fog (soft
  // wisps) cache separate sprite sets rather than stealing each other's.
  const key = `${color}|${coreFrac.toFixed(2)}`;
  const cached = _cloudSpriteCache.get(key);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;
  const sprites: HTMLCanvasElement[] = [];
  // Each sprite uses a tiny per-lobe alpha (inner color stop alpha) so
  // overlapping lobes inside a single cloud build a soft lumpy silhouette
  // without any lobe's hard edge dominating. Global alpha at draw time scales
  // the whole thing per `particleAlpha`.
  const stops = cloudColorStops(color, 0.45);
  for (let v = 0; v < CLOUD_VARIANTS; v++) {
    const canvas = document.createElement('canvas');
    canvas.width = CLOUD_SPRITE_SIZE;
    canvas.height = CLOUD_SPRITE_SIZE;
    const sctx = canvas.getContext('2d');
    if (!sctx) return null;

    // Seeded per-variant so the library always regenerates the same shapes.
    let seed = (0xc10d ^ Math.imul(v, 0x9e3779b1)) >>> 0;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const numLobes = 7 + Math.floor(rand() * 4); // 7–10 lobes per cloud
    for (let i = 0; i < numLobes; i++) {
      // Lobes cluster near the center to form a cohesive blob.
      const cx = CLOUD_SPRITE_SIZE * (0.25 + rand() * 0.5);
      const cy = CLOUD_SPRITE_SIZE * (0.3 + rand() * 0.4);
      const r = CLOUD_SPRITE_SIZE * (0.18 + rand() * 0.18);
      const grad = sctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, stops.inner);
      if (coreFrac > 0) grad.addColorStop(coreFrac, stops.inner);
      grad.addColorStop(1, stops.outer);
      sctx.fillStyle = grad;
      sctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    sprites.push(canvas);
  }
  _cloudSpriteCache.set(key, sprites);
  return sprites;
}

function drawCloudsForGroup(
  ctx: CanvasRenderingContext2D,
  group: WeatherGroup,
  cellList: Array<[number, number]>,
  gridSize: number,
  transform: RenderTransform,
  cellPx: number,
  time: number,
): void {
  const def = TYPE_DEFAULTS[group.type];
  if (def.shape !== 'cloud') return;
  const color = group.particleColor ?? def.color;
  // Intensity scales cloud coverage only — more clouds, not darker ones.
  // Individual patch depth stays at `particleAlpha` so a dense layer and a
  // sparse one both read as the same kind of weather, just more or less of
  // it. `intensityFloor` on the type lets cloudy guarantee a minimum
  // overcast; types that omit it (fog) allow 0% = truly nothing.
  const floor = def.intensityFloor ?? 0;
  const rawIntensity = Math.max(floor, Math.min(1, group.intensity));
  const alpha = def.particleAlpha;
  if (alpha <= 0) return;

  const coreFrac = def.cloudCoreFrac ?? 0.55;
  const sprites = getCloudSprites(color, coreFrac);
  if (!sprites || sprites.length === 0) return;

  // Region bbox in screen coords.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const scale = transform.scale;
  const offX = transform.offsetX;
  const offY = transform.offsetY;
  for (let ci = 0; ci < cellList.length; ci++) {
    const rc = cellList[ci] as [number, number];
    const x = rc[1] * gridSize * scale + offX;
    const y = rc[0] * gridSize * scale + offY;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + cellPx > maxX) maxX = x + cellPx;
    if (y + cellPx > maxY) maxY = y + cellPx;
  }

  // Wind direction in canvas space. With baseWindMag set, flow.hasMotion is
  // always true, but guard just in case and default to eastward drift.
  const flow = flowState(group);
  const dirX = flow.hasMotion ? flow.dirX : 1;
  const dirY = flow.hasMotion ? flow.dirY : 0;
  const windMag = flow.hasMotion ? flow.mag : 0;
  const speedPxPerSec = def.cellsPerSec * Math.min(2, windMag) * cellPx;

  // Project bbox corners onto wind axis to get u (along-wind) and v (perpendicular) extents.
  const cornersX = [minX, maxX, minX, maxX];
  const cornersY = [minY, minY, maxY, maxY];
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < 4; i++) {
    const cx = cornersX[i] as number;
    const cy = cornersY[i] as number;
    const u = cx * dirX + cy * dirY;
    const v = -cx * dirY + cy * dirX;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }

  const cloudDiameter = def.sizeFrac * cellPx; // world-size in px
  // Per-cloud size jitter picks a multiplier in [0.4, 4.0] with a heavy
  // bias toward the low end (pow curve) — most clouds are small-to-medium,
  // with occasional large cloud masses drifting through. Margin must fit
  // the largest possible size so big clouds don't pop into view at the
  // region edge.
  const MAX_SIZE_JITTER = 4.0;
  const margin = cloudDiameter * MAX_SIZE_JITTER * 0.55;
  const uPeriod = uMax - uMin + 2 * margin;
  const vSpan = vMax - vMin;
  if (uPeriod <= 0) return;

  const cloudCount = Math.max(1, Math.round(def.maxParticles * (1 + rawIntensity * 9)));
  ctx.globalAlpha = alpha;

  for (let i = 0; i < cloudCount; i++) {
    // Seed per (group, cloud index) so the drift is stable across frames.
    let seed = hashCell(i, 0, group.id, 0xc1d5e);
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const seedU = rand();
    const seedV = rand();
    const spriteIdx = Math.floor(rand() * sprites.length);
    // Skew toward smaller clouds with occasional big ones — pow(rand, 1.6)
    // biases the distribution low, so most clouds are small-to-medium with
    // occasional large masses rather than a flat even mix.
    const sizeJitter = 0.4 + Math.pow(rand(), 1.6) * (MAX_SIZE_JITTER - 0.4);

    // Wrap the along-wind position on the extended period. Positive speed
    // drifts downstream; as time advances, the cloud moves from uMin−margin
    // toward uMax+margin and wraps.
    const u = uMin - margin + pmod(seedU + (time * speedPxPerSec) / uPeriod, 1) * uPeriod;
    const v = vMin + seedV * vSpan;

    // Back to screen coords.
    const cx = u * dirX - v * dirY;
    const cy = u * dirY + v * dirX;

    const drawSize = cloudDiameter * sizeJitter;
    const half = drawSize * 0.5;
    const sprite = sprites[spriteIdx] as HTMLCanvasElement;
    ctx.drawImage(sprite, cx - half, cy - half, drawSize, drawSize);
  }
}
