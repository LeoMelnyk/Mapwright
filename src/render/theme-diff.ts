// Theme-change diffing and cache-bucket routing.
//
// A theme edit rarely touches every render cache. Hatching colors don't need
// the floors re-rasterized; a wall-shadow tweak doesn't invalidate the fluid
// Voronoi tiles. This module is the single source of truth for "property X
// belongs to cache bucket Y", so the editor can invalidate only what actually
// changed instead of rebuilding the whole map on every slider tick.

import type { Theme } from '../types.js';

/**
 * Cache buckets impacted by theme changes. Each bucket corresponds to a
 * distinct rebuild path in the render pipeline, matched to the phase that
 * actually consumes the property.
 *
 *  - `floors`       Base phases (background + floor fill). Full cells rebuild.
 *  - `blend`        Texture edge blending. Blend cache bust + full cells rebuild.
 *  - `walls`        Wall / door / secret-door geometry. Uses the snapshot-restore
 *                   "top phases" path — base phases are reused unchanged.
 *  - `grid`         Grid overlay. Same snapshot-restore path as walls.
 *  - `decorations`  Border frame + compass rose. Drawn per-frame OUTSIDE the
 *                   MapCache, so no cache invalidation is needed — a render
 *                   tick picks up the new color on the next frame.
 *  - `hatch`        Hatch composite in MapCache (signature-keyed sublayer).
 *  - `shading`      Outer / buffer shading composite (signature-keyed sublayer).
 *  - `fluid`        Water / lava / pit Path2D + rendered-fluid-layer caches.
 *  - `lava-light`   Lava-emitted lights → visibility / static lightmap bust.
 *  - `labels`       Labels drawn onto composite after the lightmap pass.
 */
export type ThemeBucket =
  | 'floors'
  | 'blend'
  | 'walls'
  | 'grid'
  | 'decorations'
  | 'hatch'
  | 'shading'
  | 'fluid'
  | 'lava-light'
  | 'labels';

/** Map from theme property name → cache bucket it invalidates. */
export const THEME_BUCKETS: Record<string, ThemeBucket> = {
  // Base phases — re-rasterize floor layer + texture base.
  background: 'floors',
  floor: 'floors',
  floorFill: 'floors',

  // Walls / doors — redrawn via the snapshot-restore top-phases path.
  wall: 'walls',
  wallStroke: 'walls',
  wallFill: 'walls',
  wallRoughness: 'walls',
  wallShadow: 'walls',
  door: 'walls',
  doorFill: 'walls',
  doorStroke: 'walls',
  secretDoor: 'walls',
  secretDoorColor: 'walls',

  // Border + compass rose are drawn per-frame on top of the cache, never
  // baked in. Changing these only requires a render tick.
  borderColor: 'decorations',
  compassRoseFill: 'decorations',
  compassRoseStroke: 'decorations',

  // Grid overlay
  grid: 'grid',
  gridLine: 'grid',
  gridLineWidth: 'grid',
  gridStyle: 'grid',
  gridOpacity: 'grid',
  gridNoise: 'grid',
  gridCornerLength: 'grid',

  // Hatching (difficult terrain crosshatch / rock patterns)
  hatchColor: 'hatch',
  hatchStyle: 'hatch',
  hatchSize: 'hatch',
  hatchOpacity: 'hatch',
  hatchDistance: 'hatch',

  // Outer / buffer shading
  outerShading: 'shading',
  bufferShadingColor: 'shading',
  bufferShadingOpacity: 'shading',

  // Fluid colors (water / lava / pit)
  waterShallowColor: 'fluid',
  waterMediumColor: 'fluid',
  waterDeepColor: 'fluid',
  waterCausticColor: 'fluid',
  lavaShallowColor: 'fluid',
  lavaMediumColor: 'fluid',
  lavaDeepColor: 'fluid',
  lavaCausticColor: 'fluid',
  pitBaseColor: 'fluid',
  pitCrackColor: 'fluid',
  pitVignetteColor: 'fluid',

  // Lava glow light (participates in lightmap)
  lavaLightColor: 'lava-light',
  lavaLightIntensity: 'lava-light',

  // Labels (rendered onto composite after lightmap)
  label: 'labels',
  labelBg: 'labels',
  textColor: 'labels',
  labels: 'labels',

  // Texture edge blending
  textureBlendWidth: 'blend',
};

/**
 * Buckets whose property values are rasterized into the MapCache base cells
 * canvas (floors / texture-blending / bridges). A change to any of these
 * keys requires rebuilding the BASE pass because the old pixels are baked
 * in. The `fluid` bucket used to be here, but fluids now live in their own
 * composite sublayer (see `buildFluidComposite` in fluid.ts) so fluid-only
 * theme edits no longer touch the cells canvas.
 */
const _CELLS_REBUILD_BUCKETS: ReadonlySet<ThemeBucket> = new Set<ThemeBucket>(['floors', 'blend']);

/**
 * Keys whose values affect the MapCache cells layer specifically.
 * Used by map-cache.ts to build a signature that skips cells-layer rebuilds
 * when only walls / grid / hatch / shading / label / decoration properties
 * changed — those can be repainted via cheaper paths (snapshot-restore or
 * composite-only) without redoing the base phases.
 */
export const CELLS_LAYER_KEYS: readonly string[] = Object.freeze(
  Object.entries(THEME_BUCKETS)
    .filter(([, b]) => _CELLS_REBUILD_BUCKETS.has(b))
    .map(([k]) => k),
);

function _deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    // Nested theme objects are small (wallShadow, outerShading, labels, grid).
    // JSON.stringify is fine and handles key-order differences via canonical form
    // only when keys match — but for theme objects keys are written in code in
    // a stable order, so this is acceptable for change detection.
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Diff two theme objects and return the set of cache buckets whose underlying
 * properties differ. Empty set → no render-relevant change occurred.
 */
export function diffThemeBuckets(prev: Theme, next: Theme): Set<ThemeBucket> {
  const buckets = new Set<ThemeBucket>();
  const pr = prev as Record<string, unknown>;
  const nx = next as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(pr), ...Object.keys(nx)]);
  for (const key of keys) {
    const bucket = THEME_BUCKETS[key];
    if (!bucket) continue;
    if (!_deepEqual(pr[key], nx[key])) {
      buckets.add(bucket);
    }
  }
  return buckets;
}

/**
 * Deep clone a theme so nested objects (wallShadow, outerShading, labels, grid)
 * snapshot independently of subsequent in-place mutation.
 */
export function cloneTheme(theme: Theme): Theme {
  return JSON.parse(JSON.stringify(theme)) as Theme;
}

/**
 * Signature of theme properties that affect the MapCache cells layer.
 * Used to detect whether a theme change requires re-rasterizing floors /
 * walls / borders or whether a composite-only rebuild is sufficient.
 */
export function cellsLayerThemeSig(theme: Theme): string {
  const t = theme as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const key of CELLS_LAYER_KEYS) {
    if (t[key] !== undefined) filtered[key] = t[key];
  }
  return JSON.stringify(filtered);
}
