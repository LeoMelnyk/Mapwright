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

import type { CellGrid, Metadata, OverlayProp, PropCatalog, PropDefinition } from '../types.js';
import { extractOverlayPropLightSegments } from './props.js';

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
  const numCols = cells[0]?.length || 0;
  const seen = new Set<string>();
  const segments: WallSegment[] = [];

  function addSeg(x1: number, y1: number, x2: number, y2: number) {
    // Canonical key: always smaller endpoint first
    const key = x1 < x2 || (x1 === x2 && y1 < y2)
      ? `${x1},${y1}-${x2},${y2}`
      : `${x2},${y2}-${x1},${y1}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push({ x1, y1, x2, y2 });
  }

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row][col];
      if (!cell) continue;

      const cx = col * gridSize;
      const cy = row * gridSize;
      const cx1 = (col + 1) * gridSize;
      const cy1 = (row + 1) * gridSize;

      // Cardinal walls (w, d, s all block light; iw and id are invisible — light passes through)
      if (cell.north && cell.north !== 'iw' && cell.north !== 'id') addSeg(cx, cy, cx1, cy);
      if (cell.south && cell.south !== 'iw' && cell.south !== 'id') addSeg(cx, cy1, cx1, cy1);
      if (cell.west  && cell.west  !== 'iw' && cell.west  !== 'id') addSeg(cx, cy, cx, cy1);
      if (cell.east  && cell.east  !== 'iw' && cell.east  !== 'id') addSeg(cx1, cy, cx1, cy1);

      // Void-boundary segments — treat the edge between a floor cell and void/out-of-bounds
      // as an opaque wall so light cannot escape into empty space
      if (!cells[row - 1]?.[col]) addSeg(cx,  cy,  cx1, cy);
      if (!cells[row + 1]?.[col]) addSeg(cx,  cy1, cx1, cy1);
      if (!cells[row]?.[col - 1]) addSeg(cx,  cy,  cx,  cy1);
      if (!cells[row]?.[col + 1]) addSeg(cx1, cy,  cx1, cy1);

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
        if (!propDef.blocksLight) continue;
        // If this prop has hitboxZones with finite height, skip it here — it will
        // cast projected shadows instead of infinite occlusion.
        if (propDef.hitboxZones?.some(z => isFinite(z.zTop))) continue;
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
      const ox = col * gridSize, oy = row * gridSize;
      for (let i = 0; i < wall.length - 1; i++) {
        addSeg(
          ox + wall[i][0] * gridSize, oy + wall[i][1] * gridSize,
          ox + wall[i + 1][0] * gridSize, oy + wall[i + 1][1] * gridSize,
        );
      }
    }
  }

  return segments;
}

// ─── Z-Height Prop Shadow Zones ─────────────────────────────────────────────

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
): { propId: number | string; overlayProp: OverlayProp; zones: { worldPolygon: number[][]; centroidX: number; centroidY: number; zBottom: number; zTop: number }[] }[] {
  const result: ReturnType<typeof extractPropShadowZones> = [];
  if (!propCatalog?.props || !metadata?.props?.length) return result;

  for (const op of metadata.props) {
    const propDef = propCatalog.props[op.type];
    if (!propDef.blocksLight || !propDef.hitboxZones) continue;

    // Only include props that have at least one finite-height zone
    const finiteZones = propDef.hitboxZones.filter(z => isFinite(z.zTop));
    if (finiteZones.length === 0) continue;

    // Transform each zone's polygon to world-feet coordinates.
    // Scale the z-height by the prop's scale factor (a 2× scaled pillar is twice as tall).
    const propScale = op.scale;
    const zones = finiteZones.map((zone: Record<string, unknown>) => {
      const worldPoly = transformHitboxToWorld(zone.polygon as number[][], propDef, op, gridSize);
      // Precompute centroid for fast radius culling in _renderOneLight
      let cx = 0, cy = 0;
      for (const [px, py] of worldPoly) { cx += px; cy += py; }
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
  const rdx = (fRows - fCols) / 2;
  const rdy = (fCols - fRows) / 2;

  return polygon.map(([hx, hy]: number[]) => {
    let px = flipped ? fCols - hx : hx;
    let py = hy;
    switch (r) {
      case 90:  { const nx = cx + (py - cy) + rdx; const ny = cy - (px - cx) + rdy; px = nx; py = ny; break; }
      case 180: { px = 2 * cx - px; py = 2 * cy - py; break; }
      case 270: { const nx = cx - (py - cy) + rdx; const ny = cy + (px - cx) + rdy; px = nx; py = ny; break; }
      case 0: break;
      default: {
        const rad = (-r * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const dx = px - cx, dy = py - cy;
        px = cx + dx * cos - dy * sin;
        py = cy + dx * sin + dy * cos;
        break;
      }
    }
    const wx = px * gridSize;
    const wy = py * gridSize;
    const pcx = (r === 90 || r === 270 ? fRows : fCols) * gridSize / 2;
    const pcy = (r === 90 || r === 270 ? fCols : fRows) * gridSize / 2;
    return [
      overlayProp.x + pcx + (wx - pcx) * scale,
      overlayProp.y + pcy + (wy - pcy) * scale,
    ];
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
  lx: number, ly: number, lz: number,
  worldPoly: number[][],
  zBottom: number, zTop: number,
  lightRadius: number,
): { shadowPoly: number[][]; nearCenter: number[]; farCenter: number[]; opacity: number; hard: boolean } | null {
  // Light is below the prop — no shadow (light passes underneath)
  if (lz < zBottom) return null;

  // Height difference between light and prop top. When near zero, shadow is very long.
  const heightDiff = Math.abs(lz - zTop);
  // Cap ratio to avoid extreme/infinite shadows when light ≈ prop top height
  const MAX_RATIO = 20;
  const projRatio = heightDiff < 0.1 ? MAX_RATIO : Math.min(MAX_RATIO, zTop / heightDiff);

  // Find the silhouette edges: vertices on the shadow-facing side of the polygon
  // as seen from the light position. We find the two tangent vertices.
  const n = worldPoly.length;
  if (n < 3) return null;

  // Compute cross-product signs for each edge relative to the light
  const signs = new Array(n);
  for (let i = 0; i < n; i++) {
    const [ax, ay] = worldPoly[i];
    const [bx, by] = worldPoly[(i + 1) % n];
    const cross = (ax - lx) * (by - ly) - (ay - ly) * (bx - lx);
    signs[i] = cross;
  }

  // Find tangent transitions (sign changes)
  let tangent1 = -1, tangent2 = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (signs[i] >= 0 && signs[j] < 0) tangent1 = j;
    if (signs[i] < 0 && signs[j] >= 0) tangent2 = j;
  }

  // If we couldn't find tangent points (light is inside polygon), no shadow
  if (tangent1 === -1 || tangent2 === -1) return null;

  // Shadow always projects from the FAR face (away from light).
  // tangent2→tangent1 traverses the back-facing edges.
  const shadowFace = [];
  let idx = tangent2;
  for (;;) {
    shadowFace.push(worldPoly[idx]);
    if (idx === tangent1) break;
    idx = (idx + 1) % n;
  }

  if (shadowFace.length < 2) return null;

  // Project each shadow-face vertex outward from the light
  const farVertices = [];
  let maxShadowLen = 0;

  for (const [vx, vy] of shadowFace) {
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
  const nearCenter = shadowFace.reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
    .map(v => v / shadowFace.length);
  const farCenter = farVertices.reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
    .map(v => v / farVertices.length);

  // Opacity: higher when light is within or near the zone (more occlusion),
  // lower when light is well above (only the top edge casts a faint shadow)
  const occlusionFraction = lz <= zTop
    ? 0.7 + 0.3 * ((zTop - lz) / (zTop - zBottom || 1)) // within zone: 0.7–1.0
    : Math.min(0.85, 0.4 + 0.45 * (zTop / lz));          // above zone: 0.4–0.85
  const opacity = occlusionFraction;
  return { shadowPoly, nearCenter, farCenter, opacity, hard: false };
}
