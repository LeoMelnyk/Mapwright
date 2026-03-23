/**
 * 2D Lighting Engine for dungeon maps.
 * Computes shadow-casting visibility polygons from wall geometry
 * and renders a compositable lightmap.
 *
 * No DOM dependencies — works with any CanvasRenderingContext2D.
 */

import { extractOverlayPropLightSegments } from './props.js';

// ─── Constants ─────
const INVERSE_SQUARE_K = 25;
const RAY_EPSILON = 0.00001;
const NUM_ARC_SEGS = 12;
const ANIM_TIME_SCALE = 0.4;
const GRADIENT_STOPS = 16;

// ─── Wall Geometry Extraction ──────────────────────────────────────────────

/**
 * Extract wall segments from the cell grid as line segments in world-feet coords.
 * Returns [{x1, y1, x2, y2}, ...] with duplicates removed.
 */
export function extractWallSegments(cells, gridSize, propCatalog, metadata = null) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const seen = new Set();
  const segments = [];

  function addSeg(x1, y1, x2, y2) {
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

      // Diagonal walls — skip for arc-trimmed cells; arc segments provide the boundary instead
      if (!cell.trimRound) {
        if (cell['nw-se'] && cell['nw-se'] !== 'iw' && cell['nw-se'] !== 'id') addSeg(cx, cy, cx1, cy1);
        if (cell['ne-sw'] && cell['ne-sw'] !== 'iw' && cell['ne-sw'] !== 'id') addSeg(cx1, cy, cx, cy1);
      }
    }
  }

  // Props that block light: extract actual shape geometry as segments
  if (propCatalog?.props) {
    if (metadata?.props?.length) {
      for (const op of metadata.props) {
        const propDef = propCatalog.props[op.type];
        if (!propDef?.blocksLight) continue;
        const propSegs = extractOverlayPropLightSegments(propDef, op, gridSize);
        for (const seg of propSegs) addSeg(seg.x1, seg.y1, seg.x2, seg.y2);
      }
    }
  }

  // Arc trim segments — approximate circular room boundaries with polylines.
  // Uses the same geometry as buildArcVoidClip() in render.js so that light
  // is blocked at the arc wall, matching how textures are clipped there.
  const arcMap = new Map();
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row][col];
      if (!cell?.trimRound) continue;
      const key = `${cell.trimArcCenterRow},${cell.trimArcCenterCol}`;
      if (!arcMap.has(key)) {
        arcMap.set(key, {
          centerRow: cell.trimArcCenterRow,
          centerCol: cell.trimArcCenterCol,
          radius:    cell.trimArcRadius,
          corner:    cell.trimCorner,
          inverted:  !!cell.trimArcInverted,
        });
      }
    }
  }

  for (const rc of arcMap.values()) {
    const R = rc.radius * gridSize;
    let acx, acy, startAngle, endAngle, anticlockwise;

    if (rc.inverted) {
      // Inverted arc: center is the trim block origin (same as ocp in render.js)
      acx = rc.centerCol * gridSize;
      acy = rc.centerRow * gridSize;
      switch (rc.corner) {
        case 'nw': startAngle = Math.PI / 2;   endAngle = 0;               anticlockwise = true;  break;
        case 'ne': startAngle = Math.PI / 2;   endAngle = Math.PI;         anticlockwise = false; break;
        case 'sw': startAngle = 0;             endAngle = 3 * Math.PI / 2; anticlockwise = true;  break;
        case 'se': startAngle = Math.PI;       endAngle = 3 * Math.PI / 2; anticlockwise = false; break;
        default: continue;
      }
    } else {
      // Non-inverted arc: center is offset inward by radius (same as acp in render.js)
      switch (rc.corner) {
        case 'nw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; startAngle = 3*Math.PI/2; endAngle = Math.PI;         anticlockwise = true;  break;
        case 'ne': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; startAngle = 3*Math.PI/2; endAngle = 0;               anticlockwise = false; break;
        case 'sw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; startAngle = Math.PI/2;   endAngle = Math.PI;         anticlockwise = false; break;
        case 'se': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; startAngle = Math.PI/2;   endAngle = 0;               anticlockwise = true;  break;
        default: continue;
      }
    }

    // Compute angular span (always positive)
    let range = anticlockwise ? startAngle - endAngle : endAngle - startAngle;
    if (range <= 0) range += 2 * Math.PI;

    // Approximate arc as line segments (sufficient for a quarter-circle)
    let prevX = acx + R * Math.cos(startAngle);
    let prevY = acy + R * Math.sin(startAngle);
    for (let i = 1; i <= NUM_ARC_SEGS; i++) {
      const t = i / NUM_ARC_SEGS;
      const angle = anticlockwise ? startAngle - t * range : startAngle + t * range;
      const x = acx + R * Math.cos(angle);
      const y = acy + R * Math.sin(angle);
      addSeg(prevX, prevY, x, y);
      prevX = x;
      prevY = y;
    }
  }

  return segments;
}

// ─── 2D Visibility Polygon (Shadow Casting) ────────────────────────────────

const EPSILON = RAY_EPSILON;

/**
 * Compute the intersection of a ray from (ox,oy) in direction (dx,dy)
 * with a line segment from (sx1,sy1) to (sx2,sy2).
 * Returns { t, u } where t is distance along ray, u is position along segment.
 * Returns null if no intersection.
 */
function raySegmentIntersect(ox, oy, dx, dy, sx1, sy1, sx2, sy2) {
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
 */
class SegmentGrid {
  constructor(segments, originX, originY, radius, cellSize) {
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
          if (!this.buckets[idx]) this.buckets[idx] = [];
          this.buckets[idx].push(seg);
        }
      }
    }
  }

  getBucket(gx, gy) {
    if (gx < 0 || gx >= this.w || gy < 0 || gy >= this.h) return null;
    return this.buckets[gy * this.w + gx];
  }
}

/**
 * Cast a ray using the spatial grid — only tests segments in grid cells along the ray path.
 * Uses DDA traversal for efficient grid walking.
 */
function castRayGrid(ox, oy, angle, grid) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const cs = grid.cellSize;

  let gx = Math.floor((ox - grid.ox) / cs);
  let gy = Math.floor((oy - grid.oy) / cs);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(cs / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(cs / dy) : Infinity;

  let tMaxX = dx !== 0
    ? ((dx > 0 ? (gx + 1) * cs + grid.ox - ox : gx * cs + grid.ox - ox) / dx)
    : Infinity;
  let tMaxY = dy !== 0
    ? ((dy > 0 ? (gy + 1) * cs + grid.oy - oy : gy * cs + grid.oy - oy) / dy)
    : Infinity;

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
export function computeVisibility(lx, ly, radius, segments) {
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
    const [ex, ey] = ep.split(',').map(Number);
    const angle = Math.atan2(ey - ly, ex - lx);
    angles.push(angle - EPSILON);
    angles.push(angle);
    angles.push(angle + EPSILON);
  }

  // Sort by angle
  angles.sort((a, b) => a - b);

  // Build visibility polygon using grid-accelerated ray casting
  const polygon = [];
  for (const angle of angles) {
    const hit = castRayGrid(lx, ly, angle, grid);
    if (hit) {
      polygon.push({ x: hit.x, y: hit.y });
    }
  }

  return polygon;
}


// ─── Lightmap Rendering ────────────────────────────────────────────────────

/**
 * Parse a hex color string into {r, g, b} (0-255).
 */
export function parseColor(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

/**
 * Compute falloff multiplier for a given distance and radius.
 */
export function falloffMultiplier(dist, radius, falloff) {
  if (radius <= 0) return 1;
  const t = Math.max(0, 1 - dist / radius);
  switch (falloff) {
    case 'linear': return t;
    case 'quadratic': return t * t;
    case 'inverse-square': {
      // 1/(1+k*d²) normalized so f(0)=1 and f(r)≈0
      const k = INVERSE_SQUARE_K;
      const dNorm = dist / radius;
      const raw = 1 / (1 + k * dNorm * dNorm);
      const floor = 1 / (1 + k);
      return Math.max(0, (raw - floor) / (1 - floor));
    }
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
 * @param {number} time - elapsed seconds
 * @returns {object}
 */
export function getEffectiveLight(light, time) {
  if (!light.animation?.type) return light;
  const { type, speed = 1.0, amplitude = 0.3, radiusVariation = 0 } = light.animation;
  const t = (time ?? 0) * speed * ANIM_TIME_SCALE;

  let intensityMult = 1.0;
  let radiusMult = 1.0;

  switch (type) {
    case 'flicker':
      intensityMult = 1 + amplitude * (
        0.5 * Math.sin(t * 17.3) +
        0.3 * Math.sin(t * 31.7) +
        0.2 * Math.sin(t * 7.1)
      );
      if (radiusVariation > 0) radiusMult = 1 + radiusVariation * Math.sin(t * 11.3);
      break;
    case 'pulse':
      intensityMult = 1 + amplitude * Math.sin(2 * Math.PI * t);
      break;
    case 'strobe':
      intensityMult = (t % 1) < 0.5 ? 1 + amplitude : Math.max(0, 1 - amplitude);
      break;
  }

  const result = { ...light };
  result.intensity = Math.max(0.01, (light.intensity ?? 1.0) * Math.max(0, intensityMult));
  if (light.radius && radiusMult !== 1.0) result.radius = Math.max(1, light.radius * Math.max(0.1, radiusMult));
  if (light.range  && radiusMult !== 1.0) result.range  = Math.max(1, light.range  * Math.max(0.1, radiusMult));
  return result;
}

// ─── Per-Light Compositing Canvas (GPU shadow mask) ────────────────────────
// A single reusable OffscreenCanvas is used for all lights — resized as needed.
// This avoids per-frame allocation while still supporting different light sizes.

let lightRTCanvas = null;
let lightRTCtx = null;

function ensureLightRTCanvas(w, h) {
  const cw = Math.ceil(w), ch = Math.ceil(h);
  if (!lightRTCanvas) {
    lightRTCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(cw, ch)
      : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    lightRTCtx = lightRTCanvas.getContext('2d');
  } else if (lightRTCanvas.width < cw || lightRTCanvas.height < ch) {
    lightRTCanvas.width  = Math.max(lightRTCanvas.width,  cw);
    lightRTCanvas.height = Math.max(lightRTCanvas.height, ch);
  }
  return lightRTCtx;
}

/**
 * Draw visibility polygon as a white filled shape into gctx,
 * offset so that world-to-canvas coords are relative to (bbX, bbY).
 */
function clipToVisibility(gctx, visibility, transform, bbX, bbY) {
  gctx.beginPath();
  const p0 = visibility[0];
  gctx.moveTo(
    p0.x * transform.scale + transform.offsetX - bbX,
    p0.y * transform.scale + transform.offsetY - bbY,
  );
  for (let i = 1; i < visibility.length; i++) {
    const p = visibility[i];
    gctx.lineTo(
      p.x * transform.scale + transform.offsetX - bbX,
      p.y * transform.scale + transform.offsetY - bbY,
    );
  }
  gctx.closePath();
  gctx.fill();
}

/**
 * Build gradient stops for a radial gradient from (cx, cy) out to radius rPx,
 * using gradient center offset within the bounding box at (relCx, relCy).
 */
function buildRadialGradient(gctx, relCx, relCy, rPx, r, g, b, intensity, lightRadius, falloff) {
  const grad = gctx.createRadialGradient(relCx, relCy, 0, relCx, relCy, rPx);
  grad.addColorStop(0, `rgba(${r},${g},${b},${Math.min(1.0, intensity)})`);
  const numStops = GRADIENT_STOPS;
  for (let i = 1; i <= numStops; i++) {
    const frac = i / numStops;
    const mult = falloffMultiplier(frac * lightRadius, lightRadius, falloff);
    grad.addColorStop(frac, `rgba(${r},${g},${b},${Math.min(1.0, intensity * mult)})`);
  }
  return grad;
}

/**
 * Render a single point light onto the lightmap using GPU-composited shadow mask.
 * Uses destination-in composite to mask a radial gradient to the visibility polygon —
 * giving anti-aliased shadow edges without a CPU pixel loop.
 */
function renderPointLight(lctx, light, visibility, transform) {
  if (visibility.length < 3) return;

  const cx = light.x * transform.scale + transform.offsetX;
  const cy = light.y * transform.scale + transform.offsetY;
  const rPx   = light.radius * transform.scale;
  const dimRPx = (light.dimRadius && light.dimRadius > light.radius)
    ? light.dimRadius * transform.scale : null;
  const outerRPx = dimRPx || rPx;

  // Clip bounding box to the canvas viewport. Without this, zooming in deeply
  // makes outerRPx thousands of pixels, causing a massive OffscreenCanvas and
  // radial gradient to be allocated every frame.
  const vpW = lctx.canvas.width;
  const vpH = lctx.canvas.height;
  const bbX = Math.max(cx - outerRPx, 0);
  const bbY = Math.max(cy - outerRPx, 0);
  const bbW = Math.min(cx + outerRPx, vpW) - bbX;
  const bbH = Math.min(cy + outerRPx, vpH) - bbY;
  if (bbW <= 0 || bbH <= 0) return; // fully off-screen

  // Use ceiled integer dimensions consistently. The RT canvas is reused across
  // lights, so fractional bbW/bbH can leave a thin strip of stale pixels from
  // the previous light that drawImage (which reads Math.ceil pixels) picks up,
  // creating a visible line at the light's bounding box edge.
  const cw = Math.ceil(bbW);
  const ch = Math.ceil(bbH);

  const gctx = ensureLightRTCanvas(cw, ch);
  gctx.clearRect(0, 0, cw, ch);

  const { r, g, b } = parseColor(light.color || '#ff9944');
  const intensity = light.intensity ?? 1.0;
  const falloff   = light.falloff || 'smooth';
  const relCx = cx - bbX; // gradient center within the clipped box
  const relCy = cy - bbY;

  if (dimRPx) {
    // Unified gradient: bright zone clamped to dimIntensity floor, dim zone fades to 0.
    // Prevents the brightness jump that occurs when two source-over gradients are layered.
    const dimIntensity = Math.min(1, intensity * 0.5);
    const brightFrac = rPx / dimRPx;
    const grad = gctx.createRadialGradient(relCx, relCy, 0, relCx, relCy, dimRPx);
    grad.addColorStop(0, `rgba(${r},${g},${b},${Math.min(1, intensity)})`);
    const numStops = 8;
    for (let i = 1; i < numStops; i++) {
      const t = i / numStops; // fraction through bright zone
      const gradFrac = t * brightFrac;
      const mult = falloffMultiplier(t * light.radius, light.radius, falloff);
      const alpha = Math.max(dimIntensity, Math.min(1, intensity * mult));
      grad.addColorStop(gradFrac, `rgba(${r},${g},${b},${alpha.toFixed(4)})`);
    }
    grad.addColorStop(brightFrac, `rgba(${r},${g},${b},${dimIntensity})`);
    grad.addColorStop(1.0,        `rgba(${r},${g},${b},0)`);
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, bbW, bbH);
  } else {
    // No dim zone — standard bright gradient
    gctx.fillStyle = buildRadialGradient(gctx, relCx, relCy, rPx, r, g, b, intensity, light.radius, falloff);
    gctx.fillRect(0, 0, bbW, bbH);
  }

  // Mask gradient to visibility polygon
  gctx.globalCompositeOperation = 'destination-in';
  gctx.fillStyle = '#ffffff';
  clipToVisibility(gctx, visibility, transform, bbX, bbY);
  gctx.globalCompositeOperation = 'source-over';

  lctx.drawImage(lightRTCanvas, 0, 0, cw, ch, bbX, bbY, cw, ch);
}

/**
 * Render a single directional (cone) light using GPU-composited shadow mask.
 */
function renderDirectionalLight(lctx, light, visibility, transform) {
  if (visibility.length < 3) return;

  const cx    = light.x * transform.scale + transform.offsetX;
  const cy    = light.y * transform.scale + transform.offsetY;
  const range = (light.range || light.radius || 30) * transform.scale;

  const { r, g, b } = parseColor(light.color || '#ffffff');
  const intensity  = light.intensity ?? 1.0;
  const falloff    = light.falloff || 'smooth';
  const angleRad   = (light.angle || 0) * Math.PI / 180;
  const spreadRad  = (light.spread || 45) * Math.PI / 180;
  const effRadius  = light.range || light.radius || 30;

  const vpW = lctx.canvas.width;
  const vpH = lctx.canvas.height;
  const bbX = Math.max(cx - range, 0);
  const bbY = Math.max(cy - range, 0);
  const bbW = Math.min(cx + range, vpW) - bbX;
  const bbH = Math.min(cy + range, vpH) - bbY;
  if (bbW <= 0 || bbH <= 0) return;

  const cw = Math.ceil(bbW);
  const ch = Math.ceil(bbH);

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

  lctx.drawImage(lightRTCanvas, 0, 0, cw, ch, bbX, bbY, cw, ch);
}

// ─── Visibility Cache ──────────────────────────────────────────────────────

const visibilityCache = new Map();
let cachedWallSegments = null;

/**
 * Clear the visibility polygon cache. Call when walls or props change.
 * All wall-changing tools call invalidateLightmap() → this function,
 * so per-frame hash recomputation is unnecessary.
 */
export function invalidateVisibilityCache() {
  visibilityCache.clear();
  cachedWallSegments = null;
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
 * @param {object} [textureCatalog] - optional texture catalog for normal maps
 */
export function renderLightmap(ctx, lights, cells, gridSize, transform, canvasW, canvasH, ambientLevel, textureCatalog, propCatalog, options, metadata = null) {
  const { ambientColor = '#ffffff', time = 0 } = options || {};
  const activeLights = lights || [];

  // Wall segments are cached and only recomputed when invalidateVisibilityCache() is called.
  // Every tool that modifies walls/props/lights calls invalidateLightmap() → invalidateVisibilityCache(),
  // so per-frame extraction and hashing is unnecessary and was causing GC pressure.
  if (!cachedWallSegments) {
    cachedWallSegments = extractWallSegments(cells, gridSize, propCatalog, metadata);
  }
  const segments = cachedWallSegments;

  // Use an OffscreenCanvas for the lightmap to avoid interfering with main context state
  let lightCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    lightCanvas = new OffscreenCanvas(canvasW, canvasH);
  } else {
    lightCanvas = document.createElement('canvas');
    lightCanvas.width = canvasW;
    lightCanvas.height = canvasH;
  }
  const lctx = lightCanvas.getContext('2d');

  // Fill with ambient. For multiply mode: ambientColor * ambientLevel.
  // Void cells stay black (multiply with black = black) so ambient doesn't brighten empty space.
  const amb = Math.max(0, Math.min(1, ambientLevel));
  const { r: ar, g: ag, b: ab } = parseColor(ambientColor);
  const ambStyle = `rgb(${Math.round(ar * amb)}, ${Math.round(ag * amb)}, ${Math.round(ab * amb)})`;
  // Start fully white (multiply-neutral), then paint ambient only onto non-void cells
  lctx.fillStyle = '#ffffff';
  lctx.fillRect(0, 0, canvasW, canvasH);
  lctx.fillStyle = ambStyle;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (!cells[r][c]) continue;
      const px = c * gridSize * transform.scale + transform.offsetX;
      const py = r * gridSize * transform.scale + transform.offsetY;
      const size = gridSize * transform.scale;
      lctx.fillRect(px, py, size, size);
    }
  }

  // Additively blend each light's contribution on top of ambient
  lctx.globalCompositeOperation = 'lighter';

  for (const light of activeLights) {
    const eff = getEffectiveLight(light, time);

    // Outer radius for visibility: max of bright radius and dim radius
    const outerRadius = (eff.dimRadius && eff.dimRadius > (eff.radius || 0))
      ? eff.dimRadius : (eff.radius || 30);
    const effectiveRadius = eff.range || outerRadius;
    const cacheKey = `${light.id}:${eff.x},${eff.y},${effectiveRadius}`;
    let visibility = visibilityCache.get(cacheKey);

    if (!visibility) {
      visibility = computeVisibility(eff.x, eff.y, effectiveRadius, segments);
      visibilityCache.set(cacheKey, visibility);
    }

    if (eff.type === 'directional') {
      renderDirectionalLight(lctx, eff, visibility, transform);
    } else {
      renderPointLight(lctx, eff, visibility, transform);
    }
  }

  // Apply simplified normal map bump effect
  if (textureCatalog) {
    applyNormalMapBump(lctx, activeLights, cells, gridSize, transform, textureCatalog);
  }

  // Composite lightmap onto main canvas with multiply
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(lightCanvas, 0, 0);
  ctx.restore();
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
let bumpTmpCtx = null;

function getBumpTmpCtx() {
  if (!bumpTmpCtx) {
    if (typeof OffscreenCanvas !== 'undefined') {
      bumpTmpCanvas = new OffscreenCanvas(BUMP_SAMPLE_SIZE, BUMP_SAMPLE_SIZE);
    } else {
      bumpTmpCanvas = document.createElement('canvas');
      bumpTmpCanvas.width = BUMP_SAMPLE_SIZE;
      bumpTmpCanvas.height = BUMP_SAMPLE_SIZE;
    }
    bumpTmpCtx = bumpTmpCanvas.getContext('2d', { willReadFrequently: true });
  }
  return bumpTmpCtx;
}

function applyNormalMapBump(lctx, lights, cells, gridSize, transform, textureCatalog) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const tmpCtx = getBumpTmpCtx();

  // Use 'multiply' for darkening areas with steep normals
  lctx.save();
  lctx.globalCompositeOperation = 'multiply';

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row][col];
      if (!cell || !cell.texture) continue;

      const entry = textureCatalog.get?.(cell.texture) || textureCatalog[cell.texture];
      if (!entry?.norImg?.complete) continue;

      // Compute dominant light direction at cell center
      const cellCenterX = (col + 0.5) * gridSize;
      const cellCenterY = (row + 0.5) * gridSize;

      let totalLightX = 0, totalLightY = 0, totalIntensity = 0;
      for (const light of lights) {
        const dx = light.x - cellCenterX;
        const dy = light.y - cellCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const effectiveRadius = light.range || light.radius || 30;
        if (dist > effectiveRadius) continue;
        const weight = falloffMultiplier(dist, effectiveRadius, light.falloff || 'smooth') * (light.intensity || 1);
        if (weight < 0.01) continue;
        totalLightX += (dx / (dist || 1)) * weight;
        totalLightY += (dy / (dist || 1)) * weight;
        totalIntensity += weight;
      }

      if (totalIntensity < 0.01) continue;

      // Normalize light direction (in 2D, pointing from cell toward light)
      const lenXY = Math.sqrt(totalLightX * totalLightX + totalLightY * totalLightY);
      // Light direction as a 3D vector: (lx, ly, 0.7) normalized — slight top-down bias
      const lx3 = lenXY > 0 ? totalLightX / lenXY * 0.5 : 0;
      const ly3 = lenXY > 0 ? totalLightY / lenXY * 0.5 : 0;
      const lz3 = 0.7;
      const lLen = Math.sqrt(lx3 * lx3 + ly3 * ly3 + lz3 * lz3);

      // Sample normal map at 4x4 grid and average the dot product
      const norImg = entry.norImg;
      const texScale = entry.scale || 2;
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
        // Normal map: RGB = XYZ mapped from [0,255] to [-1,1]
        const nx = (data[i] / 255) * 2 - 1;
        const ny = (data[i + 1] / 255) * 2 - 1;
        const nz = (data[i + 2] / 255) * 2 - 1;

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
 * @param {object} transform - {offsetX, offsetY, scale}
 */
export function renderCoverageHeatmap(ctx, lights, cells, gridSize, transform) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const activeLights = lights || [];

  ctx.save();
  ctx.globalAlpha = 0.65;

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const cell = cells[row][col];
      if (!cell) continue;

      const cellCenterX = (col + 0.5) * gridSize;
      const cellCenterY = (row + 0.5) * gridSize;

      // Sum falloff contributions from all lights
      let total = 0;
      for (const light of activeLights) {
        const dx = light.x - cellCenterX;
        const dy = light.y - cellCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const radius = light.range || light.radius || 30;
        if (dist > radius) continue;
        total += falloffMultiplier(dist, radius, light.falloff || 'smooth') * (light.intensity ?? 1.0);
      }

      // Normalize to [0,1], clamp at total ≥ 2.0
      const t = Math.min(1, total / 2.0);
      let cr, cg, cb;
      if (t < 0.25) {
        const s = t / 0.25;
        cr = 0; cg = 0; cb = Math.round(s * 180);
      } else if (t < 0.60) {
        const s = (t - 0.25) / 0.35;
        cr = Math.round(s * 255); cg = Math.round(s * 200); cb = Math.round(180 * (1 - s));
      } else {
        const s = (t - 0.60) / 0.40;
        cr = 255; cg = Math.round(200 + s * 55); cb = Math.round(s * 255);
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
export function extractFillLights(cells, gridSize, theme = {}) {
  const color     = theme.lavaLightColor     ?? '#ff6600';
  const intensity = theme.lavaLightIntensity ?? 0.70;
  const lights = [];
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

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
        const [r, c] = queue.shift();
        region.push([r, c]);
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr, nc = c + dc;
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

    const pushLight = (r, c) => {
      const id = `fill-lava-${r}-${c}`;
      if (placed.has(id)) return;
      placed.add(id);
      lights.push({
        id,
        x:         (c + 0.5) * gridSize,
        y:         (r + 0.5) * gridSize,
        type:      'point',
        radius:    0,
        dimRadius: gridSize * 4,
        color,
        intensity,
        falloff:   'smooth',
      });
    };

    if (spacing === null) {
      // Tiny pool: one light at the cell closest to the centroid
      const avgR = region.reduce((s, [r]) => s + r, 0) / area;
      const avgC = region.reduce((s, [, c]) => s + c, 0) / area;
      const [br, bc] = region.reduce((best, [r, c]) => {
        const d  = (r - avgR) ** 2 + (c - avgC) ** 2;
        const bd = (best[0] - avgR) ** 2 + (best[1] - avgC) ** 2;
        return d < bd ? [r, c] : best;
      }, region[0]);
      pushLight(br, bc);
    } else {
      // Larger pool: regular grid anchored to the bounding box.
      // Each grid point snaps to the nearest lava cell within spacing/2
      // so irregular shapes still get full coverage.
      let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
      for (const [r, c] of region) {
        if (r < minR) minR = r;  if (r > maxR) maxR = r;
        if (c < minC) minC = c;  if (c > maxC) maxC = c;
      }

      // Centre the grid within the bounding box
      const rowOff = Math.floor(((maxR - minR) % spacing) / 2);
      const colOff = Math.floor(((maxC - minC) % spacing) / 2);
      const snap   = Math.ceil(spacing / 2);

      for (let gr = minR + rowOff; gr <= maxR; gr += spacing) {
        for (let gc = minC + colOff; gc <= maxC; gc += spacing) {
          // Find the nearest lava cell to this grid point
          let bestR = -1, bestC = -1, bestD = Infinity;
          for (let dr = -snap; dr <= snap; dr++) {
            for (let dc = -snap; dc <= snap; dc++) {
              if (!regionSet.has(`${gr + dr},${gc + dc}`)) continue;
              const d = dr * dr + dc * dc;
              if (d < bestD) { bestD = d; bestR = gr + dr; bestC = gc + dc; }
            }
          }
          if (bestR !== -1) pushLight(bestR, bestC);
        }
      }
    }
  }

  return lights;
}
