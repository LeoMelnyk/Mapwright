/**
 * hitbox-props.js - Hitbox generation, hit testing, and light segment extraction
 *
 * Handles generating simplified hitbox polygons from prop draw commands,
 * pixel-accurate hit testing for prop selection, and extracting
 * light-blocking line segments for the lighting engine.
 */

import type { OverlayProp, PropCatalog, PropCommand, PropDefinition } from '../types.js';
import { flipCommand, transformCommand } from './parse-props.js';

// ── Pixel Hit Testing ────────────────────────────────────────────────────────

/**
 * Test if a world-feet point hits the actual shapes of a prop's draw commands.
 * Uses geometric math (point-in-circle, point-in-rect, point-in-polygon) on
 * the transformed draw commands. Ignores shadows — only tests prop geometry.
 *
 * Works for any rotation and scale — no tile/canvas dependency.
 * @param {Object} prop - Overlay prop instance (x, y, type, rotation, scale, flipped)
 * @param {number} wx - World X coordinate in feet
 * @param {number} wy - World Y coordinate in feet
 * @param {Object} propCatalog - Prop catalog with definitions
 * @param {number} gridSize - Grid cell size in feet
 * @returns {boolean} True if the point hits the prop
 */
export function hitTestPropPixel(
  prop: OverlayProp,
  wx: number,
  wy: number,
  propCatalog: PropCatalog | null,
  gridSize: number,
): boolean {
  const propDef = propCatalog?.props[prop.type];
  if (!propDef?.commands.length) return false;

  const rotation = prop.rotation;
  const scale = prop.scale;
  const flipped = prop.flipped;

  // Convert world-feet cursor to prop-local normalized coordinates
  const [fRows, fCols] = propDef.footprint;
  const uw = fCols * gridSize;
  const uh = fRows * gridSize;
  // Un-scale: map from visual position back to unscaled prop space (scale from center)
  const pcx = prop.x + uw / 2;
  const pcy = prop.y + uh / 2;
  const unscaledX = pcx + (wx - pcx) / scale;
  const unscaledY = pcy + (wy - pcy) / scale;
  // To normalized prop coordinates (0..cols, 0..rows)
  const nx = (unscaledX - prop.x) / gridSize;
  const ny = (unscaledY - prop.y) / gridSize;
  const r = ((rotation % 360) + 360) % 360;

  // Fast path: use selection hitbox (if defined), else auto-generated hitbox
  // Note: propDef.hitbox (lighting) is intentionally NOT used here — it may be
  // a manual convex shape that's too loose for accurate click detection.
  const selHitbox = propDef.selectionHitbox ?? propDef.autoHitbox;
  if (selHitbox) {
    // Inverse-transform the test point back to unrotated/unflipped prop space.
    // Pure rotation around base-footprint center (matches the renderer's tile
    // blit at 90°/270° — no re-anchor shift).
    let hx = nx,
      hy = ny;
    if (r !== 0) {
      const cx = fCols / 2,
        cy = fRows / 2;
      switch (r) {
        case 90: {
          const tx = hx;
          hx = cx - (hy - cy);
          hy = cy + (tx - cx);
          break;
        }
        case 180: {
          hx = 2 * cx - hx;
          hy = 2 * cy - hy;
          break;
        }
        case 270: {
          const tx = hx;
          hx = cx + (hy - cy);
          hy = cy - (tx - cx);
          break;
        }
        default: {
          // Inverse of forward rotation by -rotation radians is rotation by +rotation.
          const rad = (rotation * Math.PI) / 180;
          const cos = Math.cos(rad),
            sin = Math.sin(rad);
          const dx = hx - cx,
            dy = hy - cy;
          hx = cx + dx * cos - dy * sin;
          hy = cy + dx * sin + dy * cos;
          break;
        }
      }
    }
    if (flipped) hx = fCols - hx;
    return _pointInPolygon(hx, hy, selHitbox);
  }

  // Fallback: test each draw command's shape (after flip+rotate transform).
  // transformCommand applies Option B re-anchoring (commands land in [0, eCols]
  // × [0, eRows]) while the rendered prop is at Option A (base-center rotated).
  // Shift the click into Option B space so the tests align.
  const isRotated90 = r === 90 || r === 270;
  const eRows = isRotated90 ? fCols : fRows;
  const eCols = isRotated90 ? fRows : fCols;
  const nxAdj = nx - (fCols - eCols) / 2;
  const nyAdj = ny - (fRows - eRows) / 2;
  let hit = false;
  for (const cmd of propDef.commands) {
    if (cmd.type === 'line') continue; // too thin
    const flippedCmd = flipped ? flipCommand(cmd, propDef.footprint) : cmd;
    const tc = r === 0 ? flippedCmd : transformCommand(flippedCmd, r, propDef.footprint);

    switch (tc.type) {
      case 'rect':
        if (tc.rotate != null && tc.rotate !== 0) {
          const cx = (tc.x ?? 0) + (tc.w ?? 0) / 2,
            cy = (tc.y ?? 0) + (tc.h ?? 0) / 2;
          const rad = (-tc.rotate * Math.PI) / 180;
          const cos = Math.cos(rad),
            sin = Math.sin(rad);
          const dx = nxAdj - cx,
            dy = nyAdj - cy;
          const lx = dx * cos - dy * sin + cx;
          const ly = dx * sin + dy * cos + cy;
          if (
            lx >= (tc.x ?? 0) &&
            lx <= (tc.x ?? 0) + (tc.w ?? 0) &&
            ly >= (tc.y ?? 0) &&
            ly <= (tc.y ?? 0) + (tc.h ?? 0)
          )
            hit = true;
        } else {
          if (
            nxAdj >= (tc.x ?? 0) &&
            nxAdj <= (tc.x ?? 0) + (tc.w ?? 0) &&
            nyAdj >= (tc.y ?? 0) &&
            nyAdj <= (tc.y ?? 0) + (tc.h ?? 0)
          )
            hit = true;
        }
        break;
      case 'circle': {
        const dx = nxAdj - (tc.cx ?? 0),
          dy = nyAdj - (tc.cy ?? 0);
        if (dx * dx + dy * dy <= (tc.r ?? 0) * (tc.r ?? 0)) hit = true;
        break;
      }
      case 'ellipse': {
        const edx = (nxAdj - (tc.cx ?? 0)) / (tc.rx ?? 1),
          edy = (nyAdj - (tc.cy ?? 0)) / (tc.ry ?? 1);
        if (edx * edx + edy * edy <= 1) hit = true;
        break;
      }
      case 'poly': {
        if (tc.points && tc.points.length >= 3 && _pointInPolygon(nxAdj, nyAdj, tc.points)) hit = true;
        break;
      }
      case 'arc': {
        const adx = nxAdj - (tc.cx ?? 0),
          ady = nyAdj - (tc.cy ?? 0);
        if (adx * adx + ady * ady > (tc.r ?? 0) * (tc.r ?? 0)) break;
        let angle = (Math.atan2(ady, adx) * 180) / Math.PI;
        if (angle < 0) angle += 360;
        const start = (((tc.startDeg ?? 0) % 360) + 360) % 360;
        const end = (((tc.endDeg ?? 0) % 360) + 360) % 360;
        if (start <= end) {
          if (angle >= start && angle <= end) hit = true;
        } else {
          if (angle >= start || angle <= end) hit = true;
        }
        break;
      }
      case 'cutout': {
        // Cutout subtracts from the hit area
        let inside = false;
        switch (tc.subShape) {
          case 'circle': {
            const dx = nxAdj - (tc.cx ?? 0),
              dy = nyAdj - (tc.cy ?? 0);
            inside = dx * dx + dy * dy <= (tc.r ?? 0) * (tc.r ?? 0);
            break;
          }
          case 'rect':
            inside =
              nxAdj >= (tc.x ?? 0) &&
              nxAdj <= (tc.x ?? 0) + (tc.w ?? 0) &&
              nyAdj >= (tc.y ?? 0) &&
              nyAdj <= (tc.y ?? 0) + (tc.h ?? 0);
            break;
          case 'ellipse': {
            const edx = (nxAdj - (tc.cx ?? 0)) / (tc.rx ?? 1),
              edy = (nyAdj - (tc.cy ?? 0)) / (tc.ry ?? 1);
            inside = edx * edx + edy * edy <= 1;
            break;
          }
          case undefined:
          default:
            break;
        }
        if (inside) hit = false;
        break;
      }
      case 'ring': {
        const dx = nxAdj - (tc.cx ?? 0),
          dy = nyAdj - (tc.cy ?? 0);
        const dist2 = dx * dx + dy * dy;
        if (dist2 <= (tc.outerR ?? 0) * (tc.outerR ?? 0) && dist2 >= (tc.innerR ?? 0) * (tc.innerR ?? 0)) hit = true;
        break;
      }
    }
  }
  return hit;
}

// ── Hitbox Generation ──────────────────────────────────────────────────────

const HITBOX_PX_PER_CELL: number = 32; // rasterization resolution per footprint cell
const HITBOX_SIMPLIFY_EPSILON: number = 0.08; // Douglas-Peucker tolerance in normalized coords

/**
 * Generate a simplified hitbox polygon from a prop's draw commands.
 * Rasterizes all commands onto a binary grid, traces the outer contour
 * using marching squares, then simplifies with Douglas-Peucker.
 *
 * @param {Array} commands - parsed draw commands
 * @param {number[]} footprint - [rows, cols]
 * @returns {Array<[number,number]>|null} polygon in prop-local coords (0..cols, 0..rows), or null if empty
 */
export function generateHitbox(commands: PropCommand[], footprint: [number, number]): [number, number][] | null {
  if (!commands.length) return null;
  const [fRows, fCols] = footprint;
  const gw = fCols * HITBOX_PX_PER_CELL;
  const gh = fRows * HITBOX_PX_PER_CELL;
  if (gw === 0 || gh === 0) return null;

  // 1. Rasterize commands onto binary grid
  const grid = new Uint8Array(gw * gh);
  for (let py = 0; py < gh; py++) {
    const ny = (py + 0.5) / HITBOX_PX_PER_CELL; // center of pixel in normalized coords
    for (let px = 0; px < gw; px++) {
      const nx = (px + 0.5) / HITBOX_PX_PER_CELL;
      grid[py * gw + px] = _testPointAgainstCommands(nx, ny, commands) ? 1 : 0;
    }
  }

  // 2. Collect all boundary pixels (filled with at least one empty cardinal neighbor)
  const boundary = [];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!grid[y * gw + x]) continue;
      const g = (bx: number, by: number) => (bx >= 0 && bx < gw && by >= 0 && by < gh ? grid[by * gw + bx] : 0);
      if (!g(x - 1, y) || !g(x + 1, y) || !g(x, y - 1) || !g(x, y + 1)) {
        boundary.push([x / HITBOX_PX_PER_CELL, y / HITBOX_PX_PER_CELL]);
      }
    }
  }
  if (boundary.length < 3) return null;

  // 3. Compute convex hull (Graham scan) — handles disconnected shapes (e.g. tree canopy + trunk)
  const hull = _convexHull(boundary as [number, number][]);
  if (hull.length < 3) return null;

  // 4. Simplify with Douglas-Peucker
  const simplified = _douglasPeucker(hull, HITBOX_SIMPLIFY_EPSILON);
  return simplified.length >= 3 ? simplified : null;
}

/** Convert manual hitbox commands (rect/circle/poly) into a single polygon. */
function manualHitboxToPolygon(cmds: PropCommand[]): [number, number][] | null {
  const points: [number, number][] = [];
  for (const cmd of cmds) {
    switch (cmd.subShape) {
      case 'rect':
        points.push(
          [cmd.x!, cmd.y!],
          [cmd.x! + cmd.w!, cmd.y!],
          [cmd.x! + cmd.w!, cmd.y! + cmd.h!],
          [cmd.x!, cmd.y! + cmd.h!],
        );
        break;
      case 'circle': {
        const N = 16;
        for (let i = 0; i < N; i++) {
          const angle = (i / N) * Math.PI * 2;
          points.push([cmd.cx! + cmd.r! * Math.cos(angle), cmd.cy! + cmd.r! * Math.sin(angle)]);
        }
        break;
      }
      case 'poly':
        if (cmd.points?.length) points.push(...(cmd.points as [number, number][]));
        break;
      case undefined:
      default:
        break;
    }
  }
  return points.length >= 3 ? points : null;
}

/**
 * Build hitbox zones for z-height shadow projection.
 * If manual hitbox commands carry z ranges, creates one zone per distinct range.
 * Otherwise produces a single zone using the prop's height header (or Infinity).
 */
function buildHitboxZones(def: PropDefinition): { polygon: number[][]; zBottom: number; zTop: number }[] | null {
  const hasZRanges = def.manualHitbox?.some((cmd: PropCommand) => cmd.zBottom != null);

  if (hasZRanges) {
    const groups = new Map<string, { cmds: PropCommand[]; zBottom: number; zTop: number }>();
    for (const cmd of def.manualHitbox!) {
      const key = cmd.zBottom != null ? `${cmd.zBottom}-${cmd.zTop}` : 'default';
      if (!groups.has(key)) groups.set(key, { cmds: [], zBottom: cmd.zBottom ?? 0, zTop: cmd.zTop ?? Infinity });
      groups.get(key)!.cmds.push(cmd);
    }
    const zones: { polygon: number[][]; zBottom: number; zTop: number }[] = [];
    for (const { cmds, zBottom, zTop } of groups.values()) {
      const polygon = manualHitboxToPolygon(cmds);
      if (polygon) zones.push({ polygon, zBottom, zTop });
    }
    return zones.length > 0 ? zones : null;
  }

  const polygon = def.hitbox;
  if (!polygon) return null;
  const zTop = def.height != null && isFinite(def.height) ? def.height : Infinity;
  return [{ polygon, zBottom: 0, zTop }];
}

/**
 * Populate a prop definition's hitbox fields in place:
 * `autoHitbox` (convex-hull rasterization of draw commands), `hitbox`
 * (manual override or autoHitbox), `hitboxZones` (z-range polygons for light
 * occlusion), `selectionHitbox` (manual selection override).
 *
 * Idempotent — each field is only computed if absent, so it's safe to call
 * multiple times or on a def that already carries precomputed hitboxes (e.g.
 * from the prop bundle's baked payload).
 */
export function materializePropHitbox(def: PropDefinition): void {
  if (!def.autoHitbox && def.commands.length) {
    def.autoHitbox = generateHitbox(def.commands, def.footprint) ?? undefined;
  }
  def.hitbox ??= def.manualHitbox?.length ? (manualHitboxToPolygon(def.manualHitbox) ?? undefined) : def.autoHitbox;
  if (!def.hitboxZones && def.blocksLight) {
    def.hitboxZones = buildHitboxZones(def) ?? undefined;
  }
  if (!def.selectionHitbox && def.manualSelection?.length) {
    def.selectionHitbox = manualHitboxToPolygon(def.manualSelection) ?? undefined;
  }
}

/** Test a point (in prop-local normalized coords) against all commands at rotation=0, no flip. */
function _testPointAgainstCommands(nx: number, ny: number, commands: PropCommand[]): boolean {
  let hit = false;
  for (const cmd of commands) {
    if (cmd.type === 'line') continue;
    switch (cmd.type) {
      case 'rect':
        if (cmd.rotate != null && cmd.rotate !== 0) {
          const cx = (cmd.x ?? 0) + (cmd.w ?? 0) / 2,
            cy = (cmd.y ?? 0) + (cmd.h ?? 0) / 2;
          const rad = (-cmd.rotate * Math.PI) / 180;
          const cos = Math.cos(rad),
            sin = Math.sin(rad);
          const dx = nx - cx,
            dy = ny - cy;
          const lx = dx * cos - dy * sin + cx;
          const ly = dx * sin + dy * cos + cy;
          if (
            lx >= (cmd.x ?? 0) &&
            lx <= (cmd.x ?? 0) + (cmd.w ?? 0) &&
            ly >= (cmd.y ?? 0) &&
            ly <= (cmd.y ?? 0) + (cmd.h ?? 0)
          )
            hit = true;
        } else {
          if (
            nx >= (cmd.x ?? 0) &&
            nx <= (cmd.x ?? 0) + (cmd.w ?? 0) &&
            ny >= (cmd.y ?? 0) &&
            ny <= (cmd.y ?? 0) + (cmd.h ?? 0)
          )
            hit = true;
        }
        break;
      case 'circle': {
        const dx = nx - (cmd.cx ?? 0),
          dy = ny - (cmd.cy ?? 0);
        if (dx * dx + dy * dy <= (cmd.r ?? 0) * (cmd.r ?? 0)) hit = true;
        break;
      }
      case 'ellipse': {
        const edx = (nx - (cmd.cx ?? 0)) / (cmd.rx ?? 1),
          edy = (ny - (cmd.cy ?? 0)) / (cmd.ry ?? 1);
        if (edx * edx + edy * edy <= 1) hit = true;
        break;
      }
      case 'poly':
        if (cmd.points && cmd.points.length >= 3 && _pointInPolygon(nx, ny, cmd.points)) hit = true;
        break;
      case 'arc': {
        const adx = nx - (cmd.cx ?? 0),
          ady = ny - (cmd.cy ?? 0);
        if (adx * adx + ady * ady > (cmd.r ?? 0) * (cmd.r ?? 0)) break;
        let angle = (Math.atan2(ady, adx) * 180) / Math.PI;
        if (angle < 0) angle += 360;
        const start = (((cmd.startDeg ?? 0) % 360) + 360) % 360;
        const end = (((cmd.endDeg ?? 0) % 360) + 360) % 360;
        if (start <= end) {
          if (angle >= start && angle <= end) hit = true;
        } else {
          if (angle >= start || angle <= end) hit = true;
        }
        break;
      }
      case 'cutout': {
        let inside = false;
        switch (cmd.subShape) {
          case 'circle': {
            const dx = nx - (cmd.cx ?? 0),
              dy = ny - (cmd.cy ?? 0);
            inside = dx * dx + dy * dy <= (cmd.r ?? 0) * (cmd.r ?? 0);
            break;
          }
          case 'rect':
            inside =
              nx >= (cmd.x ?? 0) &&
              nx <= (cmd.x ?? 0) + (cmd.w ?? 0) &&
              ny >= (cmd.y ?? 0) &&
              ny <= (cmd.y ?? 0) + (cmd.h ?? 0);
            break;
          case 'ellipse': {
            const edx = (nx - (cmd.cx ?? 0)) / (cmd.rx ?? 1),
              edy = (ny - (cmd.cy ?? 0)) / (cmd.ry ?? 1);
            inside = edx * edx + edy * edy <= 1;
            break;
          }
          case undefined:
          default:
            break;
        }
        if (inside) hit = false;
        break;
      }
      case 'ring': {
        const dx = nx - (cmd.cx ?? 0),
          dy = ny - (cmd.cy ?? 0);
        const dist2 = dx * dx + dy * dy;
        if (dist2 <= (cmd.outerR ?? 0) * (cmd.outerR ?? 0) && dist2 >= (cmd.innerR ?? 0) * (cmd.innerR ?? 0))
          hit = true;
        break;
      }
    }
  }
  return hit;
}

/**
 * Convex hull via Graham scan.
 * @param {Array<[number,number]>} points
 * @returns {Array<[number,number]>}
 */
function _convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;

  // Find lowest point (then leftmost)
  let pivot = 0;
  for (let i = 1; i < points.length; i++) {
    if (
      points[i]![1] < points[pivot]![1] ||
      (points[i]![1] === points[pivot]![1] && points[i]![0] < points[pivot]![0])
    ) {
      pivot = i;
    }
  }
  [points[0], points[pivot]] = [points[pivot]!, points[0]!];
  const p0 = points[0];

  // Sort by polar angle from pivot
  points.sort((a, b) => {
    if (a === p0) return -1;
    if (b === p0) return 1;
    const cross = (a[0] - p0[0]) * (b[1] - p0[1]) - (a[1] - p0[1]) * (b[0] - p0[0]);
    if (cross !== 0) return -cross; // CCW order
    // Collinear: closer first
    const da = (a[0] - p0[0]) ** 2 + (a[1] - p0[1]) ** 2;
    const db = (b[0] - p0[0]) ** 2 + (b[1] - p0[1]) ** 2;
    return da - db;
  });

  // Build hull
  const hull: [number, number][] = [points[0], points[1]!];
  for (let i = 2; i < points.length; i++) {
    while (hull.length > 1) {
      const a = hull[hull.length - 2]!;
      const b = hull[hull.length - 1]!;
      const c = points[i]!;
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross > 0) break; // left turn — keep
      hull.pop();
    }
    hull.push(points[i]!);
  }
  return hull;
}

/**
 * Douglas-Peucker polyline simplification.
 * @param {Array<[number,number]>} points
 * @param {number} epsilon - tolerance
 * @returns {Array<[number,number]>}
 */
function _douglasPeucker(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length <= 2) return points;

  // Find point with max distance from the line between first and last
  let maxDist = 0;
  let maxIdx = 0;
  const [x1, y1] = points[0]!;
  const [x2, y2] = points[points.length - 1]!;
  const dx = x2 - x1,
    dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i]!;
    let dist;
    if (lenSq === 0) {
      dist = Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
    } else {
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
      const projX = x1 + t * dx;
      const projY = y1 + t * dy;
      dist = Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
    }
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = _douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = _douglasPeucker(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0]!, points[points.length - 1]!];
}

/** Ray-casting point-in-polygon test. */
function _pointInPolygon(px: number, py: number, points: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]! as [number, number];
    const [xj, yj] = points[j]! as [number, number];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Overlay Lighting Geometry ────────────────────────────────────────────────

/**
 * Extract light-blocking segments from an overlay prop.
 * Handles arbitrary rotation and scale.
 *
 * @param {object} propDef - PropDefinition
 * @param {object} overlayProp - overlay prop entry { x, y, rotation, scale, flipped }
 * @param {number} gridSize
 * @returns {Array<{x1, y1, x2, y2}>} Segments in world-feet
 */
export function extractOverlayPropLightSegments(
  propDef: PropDefinition,
  overlayProp: OverlayProp,
  gridSize: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const rotation = overlayProp.rotation;
  const scale = overlayProp.scale;
  const flipped = overlayProp.flipped;
  const [fRows, fCols] = propDef.footprint;
  const r = ((rotation % 360) + 360) % 360;

  // Fast path: use hitbox polygon if available
  if (propDef.hitbox) {
    const hitbox = propDef.hitbox;
    const cx = fCols / 2;
    const cy = fRows / 2;

    // Transform each hitbox vertex: flip → rotate around base-footprint center →
    // scale → world-feet → translate. No re-anchor shift — the rotated prop
    // stays centered on its 0°-oriented bbox (matches the renderer's tile blit).
    const worldPts = hitbox.map(([hx, hy]: number[]) => {
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
      return {
        x: overlayProp.x + pcx + (wx - pcx) * scale,
        y: overlayProp.y + pcy + (wy - pcy) * scale,
      };
    });
    // Emit closed polygon segments
    const segments = [];
    for (let i = 0; i < worldPts.length; i++) {
      const a = worldPts[i]!;
      const b = worldPts[(i + 1) % worldPts.length]!;
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    return segments;
  }

  // Fallback: iterate draw commands
  // For grid-aligned rotation at scale 1.0, delegate to existing function.
  // Shift the anchor by (fDiff/2) cells so the rotated prop ends up centered on
  // its 0°-oriented bbox — matching the renderer's tile blit (base-center rotation).
  if ((r === 0 || r === 90 || r === 180 || r === 270) && scale === 1.0) {
    const isRotated90 = r === 90 || r === 270;
    const eRows = isRotated90 ? fCols : fRows;
    const eCols = isRotated90 ? fRows : fCols;
    const row = overlayProp.y / gridSize + (fRows - eRows) / 2;
    const col = overlayProp.x / gridSize + (fCols - eCols) / 2;
    return extractPropLightSegments(propDef, row, col, r, flipped, gridSize);
  }

  // Arbitrary rotation/scale: extract segments then transform
  const baseSegments = extractPropLightSegments(propDef, 0, 0, 0, flipped, gridSize);

  const cx = (fCols / 2) * gridSize;
  const cy = (fRows / 2) * gridSize;
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return baseSegments.map((seg) => {
    function transform(x: number, y: number) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = dx * scale;
      const sy = dy * scale;
      const rx = sx * cos - sy * sin;
      const ry = sx * sin + sy * cos;
      return {
        x: rx + cx * scale + overlayProp.x - cx * (scale - 1),
        y: ry + cy * scale + overlayProp.y - cy * (scale - 1),
      };
    }
    const p1 = transform(seg.x1, seg.y1);
    const p2 = transform(seg.x2, seg.y2);
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  });
}

// ── Lighting Geometry Extraction ─────────────────────────────────────────────

const CIRCLE_SIDES: number = 12;

/**
 * Convert a normalized prop coordinate to world-feet coordinates.
 */
function toWorldFeet(nx: number, ny: number, row: number, col: number, gridSize: number): { x: number; y: number } {
  return { x: (col + nx) * gridSize, y: (row + ny) * gridSize };
}

/**
 * Generate polygon vertices for a circle, returned as [{x, y}, ...].
 */
function circleToPolygon(
  cx: number,
  cy: number,
  r: number,
  sides: number = CIRCLE_SIDES,
): Array<{ x: number; y: number }> {
  const points = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

/**
 * Generate polygon vertices for an ellipse, returned as [{x, y}, ...].
 */
function ellipseToPolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  sides: number = CIRCLE_SIDES,
): Array<{ x: number; y: number }> {
  const points = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return points;
}

/**
 * Convert a list of polygon points into closed-loop edge segments.
 * @param {Array<{x: number, y: number}>} points - Polygon vertices in world feet
 * @returns {Array<{x1, y1, x2, y2}>} Line segments
 */
function polygonToSegments(
  points: Array<{ x: number; y: number }>,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const segs = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return segs;
}

/**
 * Extract light-blocking line segments from a prop's draw commands.
 *
 * Transforms each command using the prop's rotation/flip, converts shapes
 * to line segments in world-feet coordinates for the lighting engine.
 *
 * @param {object} propDef - PropDefinition from parsePropFile
 * @param {number} row - Grid row of anchor cell
 * @param {number} col - Grid column of anchor cell
 * @param {number} rotation - 0, 90, 180, or 270 degrees
 * @param {boolean} flipped - Horizontal mirror
 * @param {number} gridSize - Grid cell size in feet
 * @returns {Array<{x1, y1, x2, y2}>} Segments in world-feet coordinates
 */
export function extractPropLightSegments(
  propDef: PropDefinition,
  row: number,
  col: number,
  rotation: number,
  flipped: boolean,
  gridSize: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const segments = [];

  for (const cmd of propDef.commands) {
    // Skip lines — too thin to block light
    if (cmd.type === 'line') continue;
    // Skip cutouts — they remove geometry, not add it
    if (cmd.type === 'cutout') continue;

    // Apply same transform order as renderProp: flip first, then rotate
    const flippedCmd = flipped ? flipCommand(cmd, propDef.footprint) : cmd;
    const tc = transformCommand(flippedCmd, rotation, propDef.footprint);

    switch (tc.type) {
      case 'rect': {
        if (tc.rotate != null && tc.rotate !== 0) {
          // Rotated rect: compute actual corners
          const cx = (tc.x ?? 0) + (tc.w ?? 0) / 2,
            cy = (tc.y ?? 0) + (tc.h ?? 0) / 2;
          const rad = (tc.rotate * Math.PI) / 180;
          const cos = Math.cos(rad),
            sin = Math.sin(rad);
          const hw = (tc.w ?? 0) / 2,
            hh = (tc.h ?? 0) / 2;
          const corners = [
            [-hw, -hh],
            [hw, -hh],
            [hw, hh],
            [-hw, hh],
          ].map(([lx, ly]) => toWorldFeet(cx + lx! * cos - ly! * sin, cy + lx! * sin + ly! * cos, row, col, gridSize));
          for (let i = 0; i < 4; i++) {
            const a = corners[i]!,
              b = corners[(i + 1) % 4]!;
            segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          }
        } else {
          const tl = toWorldFeet(tc.x ?? 0, tc.y ?? 0, row, col, gridSize);
          const tr = toWorldFeet((tc.x ?? 0) + (tc.w ?? 0), tc.y ?? 0, row, col, gridSize);
          const br = toWorldFeet((tc.x ?? 0) + (tc.w ?? 0), (tc.y ?? 0) + (tc.h ?? 0), row, col, gridSize);
          const bl = toWorldFeet(tc.x ?? 0, (tc.y ?? 0) + (tc.h ?? 0), row, col, gridSize);
          segments.push(
            { x1: tl.x, y1: tl.y, x2: tr.x, y2: tr.y },
            { x1: tr.x, y1: tr.y, x2: br.x, y2: br.y },
            { x1: br.x, y1: br.y, x2: bl.x, y2: bl.y },
            { x1: bl.x, y1: bl.y, x2: tl.x, y2: tl.y },
          );
        }
        break;
      }

      case 'circle': {
        const pts = circleToPolygon(tc.cx ?? 0, tc.cy ?? 0, tc.r ?? 0);
        const worldPts = pts.map((p) => toWorldFeet(p.x, p.y, row, col, gridSize));
        segments.push(...polygonToSegments(worldPts));
        break;
      }

      case 'ellipse': {
        const pts = ellipseToPolygon(tc.cx ?? 0, tc.cy ?? 0, tc.rx ?? 0, tc.ry ?? 0);
        const worldPts = pts.map((p) => toWorldFeet(p.x, p.y, row, col, gridSize));
        segments.push(...polygonToSegments(worldPts));
        break;
      }

      case 'poly': {
        if (!tc.points || tc.points.length < 2) break;
        const worldPts = tc.points.map(([px, py]: number[]) => toWorldFeet(px!, py!, row, col, gridSize));
        segments.push(...polygonToSegments(worldPts));
        break;
      }

      case 'arc': {
        const startRad = ((tc.startDeg ?? 0) * Math.PI) / 180;
        const endRad = ((tc.endDeg ?? 0) * Math.PI) / 180;
        const ARC_SUBDIVISIONS = 8;
        const pts = [];
        for (let i = 0; i <= ARC_SUBDIVISIONS; i++) {
          const t = i / ARC_SUBDIVISIONS;
          const angle = startRad + t * (endRad - startRad);
          const p = toWorldFeet(
            (tc.cx ?? 0) + (tc.r ?? 0) * Math.cos(angle),
            (tc.cy ?? 0) + (tc.r ?? 0) * Math.sin(angle),
            row,
            col,
            gridSize,
          );
          pts.push(p);
        }
        // Arc segments (open chain, not closed loop)
        for (let i = 0; i < pts.length - 1; i++) {
          segments.push({ x1: pts[i]!.x, y1: pts[i]!.y, x2: pts[i + 1]!.x, y2: pts[i + 1]!.y });
        }
        break;
      }

      case 'ring': {
        // Generate segments for both outer and inner circles
        const outerPts = circleToPolygon(tc.cx ?? 0, tc.cy ?? 0, tc.outerR ?? 0);
        const outerWorld = outerPts.map((p) => toWorldFeet(p.x, p.y, row, col, gridSize));
        segments.push(...polygonToSegments(outerWorld));
        const innerPts = circleToPolygon(tc.cx ?? 0, tc.cy ?? 0, tc.innerR ?? 0);
        const innerWorld = innerPts.map((p) => toWorldFeet(p.x, p.y, row, col, gridSize));
        segments.push(...polygonToSegments(innerWorld));
        break;
      }
    }
  }

  return segments;
}
