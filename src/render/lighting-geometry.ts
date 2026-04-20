/**
 * Lighting geometry — wall segment extraction and z-height prop shadow zones.
 *
 * Pure geometry, no rendering. Extracted from lighting.ts to give the
 * 1400-line lighting module a cleaner internal split: this file owns the
 * "what occludes light" question; lighting.ts owns visibility/raycasting and
 * lightmap rendering.
 *
 * Public exports here are re-exported from lighting.ts for backwards compat.
 */

import type { CellGrid, GoboMode, GoboPattern, Metadata, OverlayProp, PropCatalog, PropDefinition } from '../types.js';
import { extractOverlayPropLightSegments } from './props.js';
import { getGoboDefinition } from './gobo-registry.js';
import {
  PROP_SHADOW_MAX_RATIO,
  PROP_SHADOW_EPSILON_FT,
  PROP_SHADOW_WITHIN_BASE,
  PROP_SHADOW_WITHIN_SPAN,
  PROP_SHADOW_ABOVE_BASE,
  PROP_SHADOW_ABOVE_SPAN,
  PROP_SHADOW_ABOVE_MAX,
} from './lighting-config.js';

/** A line segment in world-feet coordinates. */
export type WallSegment = { x1: number; y1: number; x2: number; y2: number };

/** Default light height in feet when no z is specified. */
export const DEFAULT_LIGHT_Z: number = 8;

// ─── Wall Segment Extraction ────────────────────────────────────────────────

/**
 * Extract wall segments from the cell grid as line segments in world-feet coords.
 *
 * Includes:
 *   • Cardinal walls (`w`/`d`/`s`) on each cell — `iw`/`id` are skipped
 *   • Void boundaries between floor cells and out-of-bounds/empty space
 *   • Diagonal walls on non-trim cells
 *   • Light-blocking props with infinite-height hitboxes (finite-height props
 *     are handled separately by extractPropShadowZones / computePropShadowPolygon)
 *   • Per-cell trimWall polylines (arc-trimmed corners)
 *
 * Duplicate segments (e.g. a wall on a cell + the reciprocal on its neighbor)
 * are deduplicated via a canonical-key set.
 */
export function extractWallSegments(
  cells: CellGrid,
  gridSize: number,
  propCatalog: PropCatalog | null,
  metadata: Metadata | null = null,
): WallSegment[] {
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const seen = new Set<string>();
  const segments: WallSegment[] = [];

  function addSeg(x1: number, y1: number, x2: number, y2: number) {
    // Canonical key: always smaller endpoint first
    const key = x1 < x2 || (x1 === x2 && y1 < y2) ? `${x1},${y1}-${x2},${y2}` : `${x2},${y2}-${x1},${y1}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push({ x1, y1, x2, y2 });
  }

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]![col];
      if (!cell) continue;

      const cx = col * gridSize;
      const cy = row * gridSize;
      const cx1 = (col + 1) * gridSize;
      const cy1 = (row + 1) * gridSize;

      // Cardinal walls (w, d, s all block light; iw and id are invisible — light passes through)
      if (cell.north && cell.north !== 'iw' && cell.north !== 'id') addSeg(cx, cy, cx1, cy);
      if (cell.south && cell.south !== 'iw' && cell.south !== 'id') addSeg(cx, cy1, cx1, cy1);
      if (cell.west && cell.west !== 'iw' && cell.west !== 'id') addSeg(cx, cy, cx, cy1);
      if (cell.east && cell.east !== 'iw' && cell.east !== 'id') addSeg(cx1, cy, cx1, cy1);

      // Void-boundary segments — treat the edge between a floor cell and void/out-of-bounds
      // as an opaque wall so light cannot escape into empty space
      if (!cells[row - 1]?.[col]) addSeg(cx, cy, cx1, cy);
      if (!cells[row + 1]?.[col]) addSeg(cx, cy1, cx1, cy1);
      if (!cells[row]?.[col - 1]) addSeg(cx, cy, cx, cy1);
      if (!cells[row]?.[col + 1]) addSeg(cx1, cy, cx1, cy1);

      // Diagonal walls — skip for arc-trimmed cells; trimWall polylines provide the boundary instead
      if (!cell.trimWall) {
        if (cell['nw-se'] && cell['nw-se'] !== 'iw' && cell['nw-se'] !== 'id') addSeg(cx, cy, cx1, cy1);
        if (cell['ne-sw'] && cell['ne-sw'] !== 'iw' && cell['ne-sw'] !== 'id') addSeg(cx1, cy, cx, cy1);
      }
    }
  }

  // Props that block light: extract actual shape geometry as segments.
  // Props with finite-height hitbox zones are excluded here — they are handled
  // separately by the z-height shadow projection system (computePropShadowPolygon).
  // Only props with infinite height (no height set) go into the wall segment list.
  if (propCatalog?.props) {
    if (metadata?.props?.length) {
      for (const op of metadata.props) {
        const propDef = propCatalog.props[op.type];
        if (!propDef?.blocksLight) continue;
        // If this prop has hitboxZones with finite height, skip it here — it will
        // cast projected shadows instead of infinite occlusion.
        if (propDef.hitboxZones?.some((z) => isFinite(z.zTop))) continue;
        const propSegs = extractOverlayPropLightSegments(propDef, op, gridSize);
        for (const seg of propSegs) addSeg(seg.x1, seg.y1, seg.x2, seg.y2);
      }
    }
  }

  // Arc trim wall segments — read per-cell trimWall polylines and convert to
  // world-feet line segments for the shadow/visibility system.
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row]?.[col];
      if (!cell?.trimWall || typeof cell.trimWall === 'string') continue;
      const wall = cell.trimWall;
      const ox = col * gridSize,
        oy = row * gridSize;
      for (let i = 0; i < wall.length - 1; i++) {
        addSeg(
          ox + wall[i]![0]! * gridSize,
          oy + wall[i]![1]! * gridSize,
          ox + wall[i + 1]![0]! * gridSize,
          oy + wall[i + 1]![1]! * gridSize,
        );
      }
    }
  }

  return segments;
}

// ─── Z-Height Prop Shadow Zones ─────────────────────────────────────────────

/** A single finite-height zone flattened out for the spatial index. */
export interface ShadowZone {
  worldPolygon: number[][];
  centroidX: number;
  centroidY: number;
  zBottom: number;
  zTop: number;
}

/**
 * Bucket size (world-feet) for the prop-shadow spatial index. Chosen to be
 * slightly larger than a typical indoor light radius (cf. "torch=15,
 * brazier=22, max=28" in the editor guide) so most lights touch only 1–4
 * buckets. Tweak if dungeon-scale changes.
 */
const SHADOW_INDEX_BUCKET_FT = 30;

/**
 * Flat spatial index over prop shadow zones keyed by 30×30-ft buckets.
 * Each bucket holds the zones whose centroid falls inside it; `query(lx, ly, r)`
 * returns the zones whose bucket overlaps the light's bounding circle.
 *
 * Built once per lightmap rebuild alongside extractPropShadowZones, then
 * reused across every light in the frame.
 */
export class PropShadowIndex {
  private buckets = new Map<number, ShadowZone[]>();
  readonly bucketSize = SHADOW_INDEX_BUCKET_FT;
  /** Total zones indexed. `_renderOneLight` checks this to skip building the per-light prop-shadows array entirely when zero. */
  readonly size: number;

  constructor(zones: ShadowZone[]) {
    this.size = zones.length;
    for (const zone of zones) {
      const key = this.bucketKey(zone.centroidX, zone.centroidY);
      let list = this.buckets.get(key);
      if (!list) this.buckets.set(key, (list = []));
      list.push(zone);
    }
  }

  private bucketKey(x: number, y: number): number {
    // Pack (bx, by) into a single i32 key. Range ±16k buckets ≈ ±500k feet
    // world, well beyond any realistic dungeon.
    const bx = Math.floor(x / this.bucketSize);
    const by = Math.floor(y / this.bucketSize);
    return (bx + 16384) * 32768 + (by + 16384);
  }

  /** Return every zone whose bucket overlaps the circle (lx, ly, radius). */
  *query(lx: number, ly: number, radius: number): Generator<ShadowZone> {
    if (this.size === 0) return;
    const b = this.bucketSize;
    const bx0 = Math.floor((lx - radius) / b);
    const bx1 = Math.floor((lx + radius) / b);
    const by0 = Math.floor((ly - radius) / b);
    const by1 = Math.floor((ly + radius) / b);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const list = this.buckets.get((bx + 16384) * 32768 + (by + 16384));
        if (!list) continue;
        for (const zone of list) yield zone;
      }
    }
  }
}

/**
 * Build a flat list of every finite-height zone across every prop, plus a
 * PropShadowIndex for fast per-light radius culling. Replaces callers that
 * previously did nested `for ({zones} of result) for (zone of zones)` loops.
 */
export function buildPropShadowIndex(zonesByProp: ReturnType<typeof extractPropShadowZones>): {
  flat: ShadowZone[];
  index: PropShadowIndex;
} {
  const flat: ShadowZone[] = [];
  for (const { zones } of zonesByProp) {
    for (const z of zones) flat.push(z);
  }
  return { flat, index: new PropShadowIndex(flat) };
}

/**
 * Extract prop shadow zones for z-height shadow projection.
 *
 * Returns one entry per light-blocking prop that has at least one finite-height
 * hitbox zone, with zones in world-feet coordinates and precomputed centroids
 * for fast radius culling at render time.
 */
export function extractPropShadowZones(
  propCatalog: PropCatalog | null,
  metadata: Metadata | null,
  gridSize: number,
): {
  propId: number | string;
  overlayProp: OverlayProp;
  zones: { worldPolygon: number[][]; centroidX: number; centroidY: number; zBottom: number; zTop: number }[];
}[] {
  const result: ReturnType<typeof extractPropShadowZones> = [];
  if (!propCatalog?.props || !metadata?.props?.length) return result;

  for (const op of metadata.props) {
    const propDef = propCatalog.props[op.type];
    if (!propDef || !propDef.blocksLight || !propDef.hitboxZones) continue;

    // Only include props that have at least one finite-height zone
    const finiteZones = propDef.hitboxZones.filter((z) => isFinite(z.zTop));
    if (finiteZones.length === 0) continue;

    // Transform each zone's polygon to world-feet coordinates.
    // Scale the z-height by the prop's scale factor (a 2× scaled pillar is twice as tall).
    const propScale = op.scale;
    const zones = finiteZones.map((zone: Record<string, unknown>) => {
      const worldPoly = transformHitboxToWorld(zone.polygon as number[][], propDef, op, gridSize);
      // Precompute centroid for fast radius culling in _renderOneLight
      let cx = 0,
        cy = 0;
      for (const [px, py] of worldPoly as [number, number][]) {
        cx += px;
        cy += py;
      }
      const n = worldPoly.length || 1;
      return {
        worldPolygon: worldPoly,
        centroidX: cx / n,
        centroidY: cy / n,
        zBottom: (zone.zBottom as number) * propScale,
        zTop: (zone.zTop as number) * propScale,
      };
    });

    result.push({ propId: op.id, overlayProp: op, zones });
  }
  return result;
}

/**
 * Transform a hitbox polygon from prop-local normalized coordinates to world-feet.
 * Reuses the same transform logic as extractOverlayPropLightSegments
 * (flip → rotate → scale → translate).
 */
function transformHitboxToWorld(
  polygon: number[][],
  propDef: PropDefinition,
  overlayProp: OverlayProp,
  gridSize: number,
): number[][] {
  const rotation = overlayProp.rotation;
  const scale = overlayProp.scale;
  const flipped = overlayProp.flipped;
  const [fRows, fCols] = propDef.footprint;
  const r = ((rotation % 360) + 360) % 360;
  const cx = fCols / 2;
  const cy = fRows / 2;

  return polygon.map(([hx, hy]: number[]) => {
    let px = flipped ? fCols - hx! : hx!;
    let py = hy!;
    switch (r) {
      case 90: {
        const nx = cx + (py - cy);
        const ny = cy - (px - cx);
        px = nx;
        py = ny;
        break;
      }
      case 180: {
        px = 2 * cx - px;
        py = 2 * cy - py;
        break;
      }
      case 270: {
        const nx = cx - (py - cy);
        const ny = cy + (px - cx);
        px = nx;
        py = ny;
        break;
      }
      case 0:
        break;
      default: {
        const rad = (-r * Math.PI) / 180;
        const cos = Math.cos(rad),
          sin = Math.sin(rad);
        const dx = px - cx,
          dy = py - cy;
        px = cx + dx * cos - dy * sin;
        py = cy + dx * sin + dy * cos;
        break;
      }
    }
    const wx = px * gridSize;
    const wy = py * gridSize;
    const pcx = (fCols * gridSize) / 2;
    const pcy = (fRows * gridSize) / 2;
    return [overlayProp.x + pcx + (wx - pcx) * scale, overlayProp.y + pcy + (wy - pcy) * scale];
  });
}

/**
 * Compute the projected shadow polygon for a single prop hitbox zone cast by a single light.
 *
 * The shadow is a trapezoid-like shape projected from the prop silhouette (as seen
 * from the light position) outward to a distance determined by the height ratio.
 *
 *   lightZ < zBottom  → light passes underneath, no shadow
 *   lightZ ∈ [zB,zT]  → finite shadow from far face, length based on height ratio
 *   lightZ > zTop     → shorter shadow (light looks down)
 *
 * The shadow always projects from the FAR face (away from light) outward.
 * Returns null if the light is below the prop, inside it, or the resulting
 * shadow would be smaller than half a foot.
 */
export function computePropShadowPolygon(
  lx: number,
  ly: number,
  lz: number,
  worldPoly: number[][],
  zBottom: number,
  zTop: number,
  lightRadius: number,
): { shadowPoly: number[][]; nearCenter: number[]; farCenter: number[]; opacity: number; hard: boolean } | null {
  // Light is below the prop — no shadow (light passes underneath)
  if (lz < zBottom) return null;

  // Height difference between light and prop top. When near zero, shadow is very long.
  const heightDiff = Math.abs(lz - zTop);
  // Cap ratio to avoid extreme/infinite shadows when light ≈ prop top height
  const projRatio =
    heightDiff < PROP_SHADOW_EPSILON_FT ? PROP_SHADOW_MAX_RATIO : Math.min(PROP_SHADOW_MAX_RATIO, zTop / heightDiff);

  // Find the silhouette edges: vertices on the shadow-facing side of the polygon
  // as seen from the light position. We find the two tangent vertices.
  const n = worldPoly.length;
  if (n < 3) return null;

  // Compute cross-product signs for each edge relative to the light
  const signs = new Array(n);
  for (let i = 0; i < n; i++) {
    const [ax, ay] = worldPoly[i]! as [number, number];
    const [bx, by] = worldPoly[(i + 1) % n]! as [number, number];
    const cross = (ax - lx) * (by - ly) - (ay - ly) * (bx - lx);
    signs[i] = cross;
  }

  // Find tangent transitions (sign changes)
  let tangent1 = -1,
    tangent2 = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (signs[i] >= 0 && signs[j] < 0) tangent1 = j;
    if (signs[i] < 0 && signs[j] >= 0) tangent2 = j;
  }

  // If we couldn't find tangent points (light is inside polygon), no shadow
  if (tangent1 === -1 || tangent2 === -1) return null;

  // Shadow always projects from the FAR face (away from light).
  // tangent2→tangent1 traverses the back-facing edges.
  const shadowFace: number[][] = [];
  let idx = tangent2;
  for (;;) {
    shadowFace.push(worldPoly[idx]!);
    if (idx === tangent1) break;
    idx = (idx + 1) % n;
  }

  if (shadowFace.length < 2) return null;

  // Project each shadow-face vertex outward from the light
  const farVertices = [];
  let maxShadowLen = 0;

  for (const [vx, vy] of shadowFace as [number, number][]) {
    const dx = vx - lx;
    const dy = vy - ly;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const shadowLen = dist * projRatio;
    if (shadowLen > maxShadowLen) maxShadowLen = shadowLen;
    const maxExt = Math.max(0, lightRadius - dist);
    const clampedLen = Math.min(shadowLen, maxExt);

    if (dist < 0.001) {
      farVertices.push([vx, vy]);
    } else {
      const nx = dx / dist;
      const ny = dy / dist;
      farVertices.push([vx + nx * clampedLen, vy + ny * clampedLen]);
    }
  }

  // Skip tiny shadows (less than half a foot)
  if (maxShadowLen < 0.5) return null;

  // Build the shadow polygon: near edge (shadow face) + far edge (projected, reversed)
  const shadowPoly = [...shadowFace, ...farVertices.reverse()];

  // Near and far centers for gradient direction
  const nearCenter = (shadowFace as [number, number][])
    .reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
    .map((v) => v / shadowFace.length);
  const farCenter = (farVertices as [number, number][])
    .reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
    .map((v) => v / farVertices.length);

  // Opacity: higher when light is within or near the zone (more occlusion),
  // lower when light is well above (only the top edge casts a faint shadow)
  const opacity =
    lz <= zTop
      ? // Within zone: skim over top → BASE, down at base → BASE + SPAN = 1.0.
        PROP_SHADOW_WITHIN_BASE + PROP_SHADOW_WITHIN_SPAN * ((zTop - lz) / (zTop - zBottom || 1))
      : // Above zone: only the upper slice occludes, so the shadow stays soft.
        Math.min(PROP_SHADOW_ABOVE_MAX, PROP_SHADOW_ABOVE_BASE + PROP_SHADOW_ABOVE_SPAN * (zTop / lz));
  return { shadowPoly, nearCenter, farCenter, opacity, hard: false };
}

// ─── Gobo (Projected Pattern) Zones ────────────────────────────────────────
//
// A gobo is an upright patterned occluder declared on a prop — e.g. the
// mullions of a window or the bars of a prison grate. When a light hits the
// gobo segment from above (light z > gobo zBottom), the pattern is projected
// onto the floor on the FAR side of the segment from the light, same math as
// prop-shadow projection but on a line segment rather than a polygon.
//
// The pattern itself is multiplied into the lightmap at render time; the
// geometry here only owns the projected quadrilateral.

/** A single upright gobo segment flattened out for the spatial index. */
export interface GoboZone {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  centroidX: number;
  centroidY: number;
  zBottom: number;
  zTop: number;
  goboId: string;
  /** Resolved pattern from the gobo catalog (registry lookup at extraction time). */
  pattern: GoboPattern;
  /** Effective density: prop's per-placement override if set, else the gobo definition's. */
  density: number;
  /** Slat orientation — only meaningful for `slats` pattern. */
  orientation?: 'vertical' | 'horizontal';
  /** Projection mode — see {@link GoboMode}. */
  mode: GoboMode;
  strength: number;
  sourcePropId: number | string;
}

/**
 * Flat spatial index over gobo zones. Identical bucket strategy to
 * {@link PropShadowIndex} — prop shadows and gobos both gate on the light's
 * bounding circle and benefit from the same 30-ft bucket size.
 */
export class GoboIndex {
  private buckets = new Map<number, GoboZone[]>();
  readonly bucketSize = SHADOW_INDEX_BUCKET_FT;
  readonly size: number;

  constructor(zones: GoboZone[]) {
    this.size = zones.length;
    for (const zone of zones) {
      const key = this.bucketKey(zone.centroidX, zone.centroidY);
      let list = this.buckets.get(key);
      if (!list) this.buckets.set(key, (list = []));
      list.push(zone);
    }
  }

  private bucketKey(x: number, y: number): number {
    const bx = Math.floor(x / this.bucketSize);
    const by = Math.floor(y / this.bucketSize);
    return (bx + 16384) * 32768 + (by + 16384);
  }

  *query(lx: number, ly: number, radius: number): Generator<GoboZone> {
    if (this.size === 0) return;
    const b = this.bucketSize;
    const bx0 = Math.floor((lx - radius) / b);
    const bx1 = Math.floor((lx + radius) / b);
    const by0 = Math.floor((ly - radius) / b);
    const by1 = Math.floor((ly + radius) / b);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const list = this.buckets.get((bx + 16384) * 32768 + (by + 16384));
        if (!list) continue;
        for (const zone of list) yield zone;
      }
    }
  }
}

/**
 * Build a spatial index over every gobo segment on the map. Call once per
 * lightmap rebuild alongside `extractPropShadowZones` — the per-light loop
 * then does `goboIndex.query(lx, ly, radius)` exactly the same way.
 */
export function buildGoboIndex(zones: GoboZone[]): { flat: GoboZone[]; index: GoboIndex } {
  return { flat: zones, index: new GoboIndex(zones) };
}

/**
 * Extract every gobo segment on the map in world-feet coordinates.
 *
 * Mirrors `extractPropShadowZones`: iterates every placed overlay prop whose
 * definition declares `gobos:`, transforms each gobo's local-space segment
 * endpoints to world space, and precomputes a centroid for fast bucket culling.
 */
export function extractGoboZones(
  propCatalog: PropCatalog | null,
  metadata: Metadata | null,
  gridSize: number,
): GoboZone[] {
  const result: GoboZone[] = [];
  if (!propCatalog?.props || !metadata?.props?.length) return result;

  for (const op of metadata.props) {
    const propDef = propCatalog.props[op.type];
    if (!propDef?.gobos?.length) continue;

    const propScale = op.scale;
    for (const g of propDef.gobos) {
      // Resolve pattern + density via the registry. If the catalog isn't loaded
      // (e.g. Node CLI render without a gobo catalog), skip the zone silently.
      const def = getGoboDefinition(g.gobo);
      if (!def) continue;
      // Transform local-cell endpoints through the same flip/rotate/scale/
      // translate pipeline used for hitbox polygons.
      const world = transformHitboxToWorld(
        [
          [g.x1, g.y1],
          [g.x2, g.y2],
        ],
        propDef,
        op,
        gridSize,
      );
      const [wx1, wy1] = world[0]! as [number, number];
      const [wx2, wy2] = world[1]! as [number, number];
      result.push({
        x1: wx1,
        y1: wy1,
        x2: wx2,
        y2: wy2,
        centroidX: (wx1 + wx2) / 2,
        centroidY: (wy1 + wy2) / 2,
        zBottom: g.zBottom * propScale,
        zTop: g.zTop * propScale,
        goboId: g.gobo,
        pattern: def.pattern,
        density: g.density ?? def.density,
        ...(def.orientation ? { orientation: def.orientation } : {}),
        mode: g.mode ?? 'occluder',
        strength: g.strength ?? 1,
        sourcePropId: op.id,
      });
    }
  }
  return result;
}

/**
 * Compute the projected gobo quadrilateral on the floor from a single light
 * hitting a single upright gobo segment.
 *
 * Mirrors {@link computePropShadowPolygon} but for a line segment: each of
 * the two segment endpoints projects outward from the light to a far point,
 * and the four corners form a trapezoid. The renderer multiplies the gobo
 * texture into this quad — near edge = the gobo itself, far edge = where the
 * pattern fades out.
 *
 * Returns null if the light is below `zBottom` (passes underneath) or the
 * resulting projection is too small to be worth drawing.
 */
export function computeGoboProjectionPolygon(
  lx: number,
  ly: number,
  lz: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  zBottom: number,
  zTop: number,
  lightRadius: number,
): { quad: number[][]; nearP1: number[]; nearP2: number[]; farP1: number[]; farP2: number[] } | null {
  if (lz < zBottom) return null;

  const heightDiff = Math.abs(lz - zTop);
  const projRatio =
    heightDiff < PROP_SHADOW_EPSILON_FT ? PROP_SHADOW_MAX_RATIO : Math.min(PROP_SHADOW_MAX_RATIO, zTop / heightDiff);

  const projectPoint = (px: number, py: number): { far: [number, number]; shadowLen: number } => {
    const dx = px - lx;
    const dy = py - ly;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const shadowLen = dist * projRatio;
    const maxExt = Math.max(0, lightRadius - dist);
    const clampedLen = Math.min(shadowLen, maxExt);
    if (dist < 0.001) return { far: [px, py], shadowLen: 0 };
    return { far: [px + (dx / dist) * clampedLen, py + (dy / dist) * clampedLen], shadowLen };
  };

  const a = projectPoint(x1, y1);
  const b = projectPoint(x2, y2);
  // Skip negligible projections.
  if (Math.max(a.shadowLen, b.shadowLen) < 0.5) return null;

  // Near edge = the segment itself (world-feet).
  const nearP1: [number, number] = [x1, y1];
  const nearP2: [number, number] = [x2, y2];
  // Winding: nearP1 → nearP2 → farP2 → farP1 keeps the quad non-self-intersecting
  // whether the light is "above" or "below" the segment in world space.
  const quad: number[][] = [nearP1, nearP2, b.far, a.far];
  return { quad, nearP1, nearP2, farP1: a.far, farP2: b.far };
}
