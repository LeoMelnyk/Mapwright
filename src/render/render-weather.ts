// Static weather effects renderer.
//
// Renders per-cell particles (streaks, dots, wisps, ovals) and a translucent
// haze wash for each cell assigned to a weather group. No animation yet —
// particle positions are deterministic, seeded by (row, col, groupId), so the
// same map always draws the same pattern between frames.
//
// Drawn as a phase of renderCells, layered on top of floors/walls/props but
// below the lightmap so lighting can darken weather in shadowed areas.

import type { Cell, CellGrid, Light, Metadata, RenderTransform, WeatherGroup, WeatherType } from '../types.js';

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
  shape: 'ripple' | 'streak' | 'dot' | 'wisp' | 'oval';
  /** Particle size as a fraction of cell size (dot/oval radius; ripple max radius). */
  sizeFrac: number;
  /** Streak / wisp length as a fraction of cell size. */
  lengthFrac: number;
  /** Base velocity vector (canvas coordinates: +y is down). Wind adds on top. */
  baseVx: number;
  baseVy: number;
  /** Opacity used when stroking particles. Overridden by haze alpha internally. */
  particleAlpha: number;
  /**
   * Animation speed in cells-per-second at unit velocity magnitude. Actual
   * speed is this × |baseVel + wind|, clamped. Motion direction comes from
   * the velocity vector; this scalar controls how fast particles traverse.
   */
  cellsPerSec: number;
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
    lengthFrac: 0,
    baseVx: 0,
    baseVy: 1,
    particleAlpha: 0.7,
    cellsPerSec: 1.6,
  },
  snow: {
    color: '#ffffff',
    maxParticles: 7,
    shape: 'dot',
    sizeFrac: 0.07,
    lengthFrac: 0,
    baseVx: 0,
    baseVy: 0.3,
    particleAlpha: 1,
    cellsPerSec: 0.3,
  },
  ash: {
    color: '#8a8a8a',
    maxParticles: 6,
    shape: 'dot',
    sizeFrac: 0.07,
    lengthFrac: 0,
    baseVx: 0,
    baseVy: 0.25,
    particleAlpha: 0.95,
    cellsPerSec: 0.18,
  },
  embers: {
    color: '#ff8a3d',
    maxParticles: 6,
    shape: 'dot',
    sizeFrac: 0.06,
    lengthFrac: 0,
    baseVx: 0,
    baseVy: -0.5,
    particleAlpha: 1,
    cellsPerSec: 0.45,
  },
  sandstorm: {
    color: '#d4b878',
    maxParticles: 9,
    shape: 'streak',
    sizeFrac: 0.04,
    lengthFrac: 0.32,
    baseVx: 0,
    baseVy: 0,
    particleAlpha: 0.85,
    cellsPerSec: 2.2,
  },
  fog: {
    color: '#cfd5d8',
    maxParticles: 2,
    shape: 'wisp',
    sizeFrac: 0.04,
    lengthFrac: 0.55,
    baseVx: 0,
    baseVy: 0,
    particleAlpha: 0.55,
    cellsPerSec: 0.08,
  },
  leaves: {
    color: '#9a7a3a',
    maxParticles: 3,
    shape: 'oval',
    sizeFrac: 0.1,
    lengthFrac: 0,
    baseVx: 0,
    baseVy: 0.35,
    particleAlpha: 0.9,
    cellsPerSec: 0.3,
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

/**
 * Compute the particle motion angle (radians, canvas space) for a group.
 * Returns null when the base + wind vector is degenerate (both components
 * zero), meaning particles have no preferred direction — the caller draws
 * orientation-less particles (dots, random-rotation ovals).
 */
function particleAngle(group: WeatherGroup): number | null {
  const def = TYPE_DEFAULTS[group.type];
  const wind = windVector(group);
  const vx = def.baseVx + wind.x;
  const vy = def.baseVy + wind.y;
  if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) return null;
  return Math.atan2(vy, vx);
}

interface FlowState {
  /** Unit direction of motion in canvas space (0,0 when the group is static). */
  dirX: number;
  dirY: number;
  /** Unit perpendicular (rotated 90° CCW from dir). Used for spread. */
  perpX: number;
  perpY: number;
  /**
   * Seconds a particle takes to traverse one cycle — entry edge to exit edge
   * across a cell, plus some lead-in/lead-out. Infinity when static.
   */
  cycleSec: number;
  /** True when there's enough motion to run the flow model; false for static fallback. */
  hasMotion: boolean;
}

/**
 * Compute the flow parameters for a group at the current cell. Used by
 * streaks/dots/wisps/ovals to run a "particles enter upstream edge, cross
 * cell, exit downstream edge" animation without modulo wrapping. Ripples
 * (rain) don't use flow — they expand in place at seeded positions.
 */
function flowState(group: WeatherGroup, cellPx: number): FlowState {
  const def = TYPE_DEFAULTS[group.type];
  const wind = windVector(group);
  const vx = def.baseVx + wind.x;
  const vy = def.baseVy + wind.y;
  const mag = Math.sqrt(vx * vx + vy * vy);
  if (mag < 1e-6) {
    return { dirX: 0, dirY: 0, perpX: 0, perpY: 0, cycleSec: Infinity, hasMotion: false };
  }
  const dirX = vx / mag;
  const dirY = vy / mag;
  const speedPxPerSec = def.cellsPerSec * Math.min(2, mag) * cellPx;
  // Cycle distance is 1.5 × cell size: particles start ~0.25 cell before the
  // near edge and exit ~0.25 cell past the far edge, so the visible path
  // through the cell has no entry/exit pop.
  const cycleSec = (cellPx * 1.5) / speedPxPerSec;
  return { dirX, dirY, perpX: -dirY, perpY: dirX, cycleSec, hasMotion: true };
}

/** Positive-modulo helper — standard `%` in JS returns negative for negative LHS. */
function pmod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

/**
 * Compute a particle's canvas position under the flow model. `phaseSeed`
 * and `perpSeed` are stable per-particle random values in [0, 1).
 * Returns a position that smoothly traverses the cell along the motion
 * direction — entering from upstream edge, exiting downstream, with the
 * next cycle taking its place behind.
 */
function flowPosition(
  phaseSeed: number,
  perpSeed: number,
  time: number,
  flow: FlowState,
  cellX: number,
  cellY: number,
  cellPx: number,
): { x: number; y: number } {
  const phase = pmod(phaseSeed + time / flow.cycleSec, 1);
  // Map phase 0..1 to along-distance from -0.25*cellPx to +1.25*cellPx
  // (centered on the cell, extends 0.25 cellPx in each direction).
  const along = (phase - 0.25) * cellPx * 1.5 - cellPx * 0.5;
  const perp = (perpSeed - 0.5) * cellPx;
  const centerX = cellX + cellPx * 0.5;
  const centerY = cellY + cellPx * 0.5;
  return {
    x: centerX + flow.dirX * along + flow.perpX * perp,
    y: centerY + flow.dirY * along + flow.perpY * perp,
  };
}

interface InnerOptions {
  drawHaze?: boolean;
  drawParticles?: boolean;
  /** Seconds elapsed (for animation). 0 renders particles at their seeded base positions. */
  time?: number;
  bounds?: { minRow: number; maxRow: number; minCol: number; maxCol: number } | null;
}

/**
 * Shared per-cell draw loop. Iterates every weather cell inside `bounds`
 * (or the whole grid), looks up its group, and calls the haze / particle
 * helpers according to `options`. Split from the public helpers so cache
 * builders (haze-only) and per-frame overlays (particles-only, animated)
 * can reuse the same traversal.
 */
function _renderWeatherInner(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  metadata: Metadata | null | undefined,
  gridSize: number,
  transform: RenderTransform,
  options: InnerOptions,
): void {
  if (!metadata) return;
  const groups = metadata.weatherGroups;
  if (!groups || groups.length === 0) return;

  const groupById = new Map<string, WeatherGroup>();
  for (const g of groups) groupById.set(g.id, g);

  const cellPx = gridSize * transform.scale;
  const rMin = options.bounds ? Math.max(0, options.bounds.minRow) : 0;
  const rMax = options.bounds ? Math.min(cells.length - 1, options.bounds.maxRow) : cells.length - 1;
  const cMin = options.bounds ? Math.max(0, options.bounds.minCol) : 0;
  const cMaxDefault = (cells[0]?.length ?? 1) - 1;
  const time = options.time ?? 0;
  const needClip = !!options.drawParticles; // haze is always in-cell; particles overflow.

  for (let r = rMin; r <= rMax; r++) {
    const row = cells[r];
    if (!row) continue;
    const cMax = options.bounds ? Math.min(row.length - 1, options.bounds.maxCol) : cMaxDefault;
    for (let c = cMin; c <= cMax; c++) {
      const gid = row[c]?.weatherGroupId;
      if (!gid) continue;
      const group = groupById.get(gid);
      if (!group) continue;

      const cellX = c * gridSize * transform.scale + transform.offsetX;
      const cellY = r * gridSize * transform.scale + transform.offsetY;

      if (needClip) {
        // Particles can overflow by streak length / wisp curvature; clip keeps
        // the hard cell boundary and makes partial-rebuild cache updates safe.
        ctx.save();
        ctx.beginPath();
        ctx.rect(cellX, cellY, cellPx, cellPx);
        ctx.clip();
      }
      if (options.drawHaze) drawHazeWash(ctx, group, cellX, cellY, cellPx);
      if (options.drawParticles) drawParticles(ctx, group, r, c, cellX, cellY, cellPx, time);
      if (needClip) ctx.restore();
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
  _renderWeatherInner(ctx, cells, metadata, gridSize, transform, {
    drawHaze: true,
    drawParticles: true,
    time: 0,
    bounds,
  });
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
  _renderWeatherInner(ctx, cells, metadata, gridSize, transform, {
    drawHaze: true,
    drawParticles: false,
    time: 0,
    bounds,
  });
}

/**
 * Render only the particle layer. Call every frame from the editor with
 * `time = state.animClock` to drive motion; call with `time = 0` for a
 * static snapshot. Particles are clipped per-cell so they don't bleed into
 * the hard boundary between weather groups.
 */
export function renderWeatherParticles(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  metadata: Metadata | null | undefined,
  gridSize: number,
  transform: RenderTransform,
  time: number,
): void {
  _renderWeatherInner(ctx, cells, metadata, gridSize, transform, {
    drawHaze: false,
    drawParticles: true,
    time,
  });
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
    cache.rows !== numRows ||
    cache.cols !== numCols ||
    cache.gridSize !== gridSize ||
    cache.pxPerFoot !== pxPerFoot;

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
      if (cell?.weatherGroupId !== groupId) continue;
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
      if (cell?.weatherGroupId !== groupId) continue;
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
 * Returns true if any weather group has particles worth animating —
 * intensity > 0 and the type's base velocity or current wind gives them
 * motion. Used to decide whether the animation loop needs to tick even
 * when no lighting is active. Fog/sandstorm with zero wind render
 * statically (no motion), so they don't need the loop running.
 */
export function hasActiveWeatherParticles(metadata: Metadata | null | undefined): boolean {
  const groups = metadata?.weatherGroups;
  if (!groups || groups.length === 0) return false;
  for (const g of groups) {
    if (g.intensity <= 0) continue;
    const def = TYPE_DEFAULTS[g.type];
    const vx = def.baseVx + Math.sin((g.wind.direction * Math.PI) / 180) * g.wind.intensity;
    const vy = def.baseVy + -Math.cos((g.wind.direction * Math.PI) / 180) * g.wind.intensity;
    if (Math.abs(vx) > 1e-6 || Math.abs(vy) > 1e-6) return true;
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
  // as heavy at density = 1 because of the wisp particles layered on top.
  ctx.globalAlpha = Math.min(0.5, group.hazeDensity * 0.5);
  ctx.fillStyle = color;
  ctx.fillRect(cellX, cellY, cellPx, cellPx);
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  group: WeatherGroup,
  r: number,
  c: number,
  cellX: number,
  cellY: number,
  cellPx: number,
  time: number,
): void {
  const def = TYPE_DEFAULTS[group.type];
  const count = Math.round(def.maxParticles * group.intensity);
  if (count <= 0) return;

  const color = group.particleColor ?? def.color;
  const angle = particleAngle(group);
  const seed = hashCell(r, c, group.id, 0);
  const rand = makeRng(seed);
  const flow = flowState(group, cellPx);

  switch (def.shape) {
    case 'ripple':
      drawRipples(ctx, color, def.particleAlpha, count, rand, cellX, cellY, cellPx, def.sizeFrac, time);
      break;
    case 'streak':
      drawStreaks(ctx, color, def.particleAlpha, count, angle ?? Math.PI / 2, rand, cellX, cellY, cellPx, def.lengthFrac, flow, time);
      break;
    case 'dot':
      drawDots(ctx, color, def.particleAlpha, count, rand, cellX, cellY, cellPx, def.sizeFrac, flow, time);
      break;
    case 'wisp':
      drawWisps(ctx, color, def.particleAlpha, count, angle ?? 0, rand, cellX, cellY, cellPx, def.lengthFrac, flow, time);
      break;
    case 'oval':
      drawOvals(ctx, color, def.particleAlpha, count, rand, cellX, cellY, cellPx, def.sizeFrac, flow, time);
      break;
  }
}

/**
 * Rain from top-down: each "slot" in a cell has its own period and spawn
 * position. Within each period, a ripple is born, expands to `maxRadius`,
 * and fades. Between ripples the slot is quiet. Slots are staggered so the
 * cell constantly has a few live ripples at different stages.
 */
function drawRipples(
  ctx: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  count: number,
  rand: () => number,
  cellX: number,
  cellY: number,
  cellPx: number,
  sizeFrac: number,
  time: number,
): void {
  const maxRadius = cellPx * sizeFrac;
  // Active fraction of each slot's period during which the ripple is visible;
  // the remaining time the slot is silent, which staggers neighboring slots
  // without them all drawing at once.
  const liveFrac = 0.45;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const px = rand() * cellPx;
    const py = rand() * cellPx;
    const periodJitter = 0.9 + rand() * 1.1; // seconds
    const phaseOffset = rand();
    const cyclePhase = pmod(time / periodJitter + phaseOffset, 1);
    if (cyclePhase > liveFrac) continue;
    const rippleProgress = cyclePhase / liveFrac; // 0..1 within live window
    const radius = rippleProgress * maxRadius;
    const fade = 1 - rippleProgress;
    ctx.globalAlpha = alpha * fade;
    ctx.lineWidth = Math.max(0.8, cellPx * 0.02);
    ctx.beginPath();
    ctx.arc(cellX + px, cellY + py, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawStreaks(
  ctx: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  count: number,
  angle: number,
  rand: () => number,
  cellX: number,
  cellY: number,
  cellPx: number,
  lengthFrac: number,
  flow: FlowState,
  time: number,
): void {
  const len = cellPx * lengthFrac;
  const dx = Math.cos(angle) * len;
  const dy = Math.sin(angle) * len;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.6, cellPx * 0.02);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const phaseSeed = rand();
    const perpSeed = rand();
    let px: number;
    let py: number;
    if (flow.hasMotion) {
      const p = flowPosition(phaseSeed, perpSeed, time, flow, cellX, cellY, cellPx);
      px = p.x;
      py = p.y;
    } else {
      // No motion — scatter at seeded static positions.
      px = cellX + phaseSeed * cellPx;
      py = cellY + perpSeed * cellPx;
    }
    ctx.moveTo(px - dx / 2, py - dy / 2);
    ctx.lineTo(px + dx / 2, py + dy / 2);
  }
  ctx.stroke();
}

function drawDots(
  ctx: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  count: number,
  rand: () => number,
  cellX: number,
  cellY: number,
  cellPx: number,
  sizeFrac: number,
  flow: FlowState,
  time: number,
): void {
  const size = Math.max(1, cellPx * sizeFrac);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const phaseSeed = rand();
    const perpSeed = rand();
    let px: number;
    let py: number;
    if (flow.hasMotion) {
      const p = flowPosition(phaseSeed, perpSeed, time, flow, cellX, cellY, cellPx);
      px = p.x;
      py = p.y;
    } else {
      px = cellX + phaseSeed * cellPx;
      py = cellY + perpSeed * cellPx;
    }
    ctx.fillRect(px - size / 2, py - size / 2, size, size);
  }
}

function drawWisps(
  ctx: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  count: number,
  angle: number,
  rand: () => number,
  cellX: number,
  cellY: number,
  cellPx: number,
  lengthFrac: number,
  flow: FlowState,
  time: number,
): void {
  const len = cellPx * lengthFrac;
  const dx = Math.cos(angle) * len;
  const dy = Math.sin(angle) * len;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, cellPx * 0.04);
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const phaseSeed = rand();
    const perpSeed = rand();
    const bulgeSeed = rand() - 0.5;
    let px: number;
    let py: number;
    if (flow.hasMotion) {
      const p = flowPosition(phaseSeed, perpSeed, time, flow, cellX, cellY, cellPx);
      px = p.x;
      py = p.y;
    } else {
      px = cellX + phaseSeed * cellPx;
      py = cellY + perpSeed * cellPx;
    }
    const bulge = bulgeSeed * 0.4;
    const perpX = -dy * bulge;
    const perpY = dx * bulge;
    ctx.beginPath();
    ctx.moveTo(px - dx / 2, py - dy / 2);
    ctx.quadraticCurveTo(px + perpX, py + perpY, px + dx / 2, py + dy / 2);
    ctx.stroke();
  }
}

function drawOvals(
  ctx: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  count: number,
  rand: () => number,
  cellX: number,
  cellY: number,
  cellPx: number,
  sizeFrac: number,
  flow: FlowState,
  time: number,
): void {
  const a = Math.max(1.2, cellPx * sizeFrac);
  const b = a * 0.45;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const phaseSeed = rand();
    const perpSeed = rand();
    const rotSeed = rand();
    let px: number;
    let py: number;
    if (flow.hasMotion) {
      const p = flowPosition(phaseSeed, perpSeed, time, flow, cellX, cellY, cellPx);
      px = p.x;
      py = p.y;
    } else {
      px = cellX + phaseSeed * cellPx;
      py = cellY + perpSeed * cellPx;
    }
    // Leaves also tumble — rotation advances slowly over time so each leaf
    // has its own drift-spin seeded by rotSeed.
    const rot = rotSeed * Math.PI * 2 + time * (rotSeed - 0.5) * 0.8;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, a, b, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
