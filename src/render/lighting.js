/**
 * 2D Lighting Engine for dungeon maps.
 * Computes shadow-casting visibility polygons from wall geometry
 * and renders a compositable lightmap.
 *
 * No DOM dependencies — works with any CanvasRenderingContext2D.
 */

import { extractPropLightSegments } from './props.js';

// ─── Wall Geometry Extraction ──────────────────────────────────────────────

/**
 * Extract wall segments from the cell grid as line segments in world-feet coords.
 * Returns [{x1, y1, x2, y2}, ...] with duplicates removed.
 */
export function extractWallSegments(cells, gridSize, propCatalog) {
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

      // Diagonal walls — skip for arc-trimmed cells; arc segments provide the boundary instead
      if (!cell.trimRound) {
        if (cell['nw-se'] && cell['nw-se'] !== 'iw' && cell['nw-se'] !== 'id') addSeg(cx, cy, cx1, cy1);
        if (cell['ne-sw'] && cell['ne-sw'] !== 'iw' && cell['ne-sw'] !== 'id') addSeg(cx1, cy, cx, cy1);
      }
    }
  }

  // Props that block light: extract actual shape geometry as segments
  if (propCatalog?.props) {
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const cell = cells[row][col];
        if (!cell?.prop) continue;

        const propDef = propCatalog.props[cell.prop.type];
        if (!propDef?.blocksLight) continue;

        const rotation = cell.prop.facing || 0;
        const flipped = cell.prop.flipped || false;
        const propSegs = extractPropLightSegments(propDef, row, col, rotation, flipped, gridSize);
        for (const seg of propSegs) {
          addSeg(seg.x1, seg.y1, seg.x2, seg.y2);
        }
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

    // Approximate arc as 12 line segments (sufficient for a quarter-circle)
    const NUM_ARC_SEGS = 12;
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

const EPSILON = 0.00001;

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

/**
 * Cast a ray from origin and find the closest intersection with any wall segment.
 * Returns { x, y, t } or null if no hit.
 */
function castRay(ox, oy, angle, segments) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let closest = null;

  for (const seg of segments) {
    const hit = raySegmentIntersect(ox, oy, dx, dy, seg.x1, seg.y1, seg.x2, seg.y2);
    if (hit && hit.t > EPSILON && (!closest || hit.t < closest.t)) {
      closest = hit;
    }
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

  // Build visibility polygon
  const polygon = [];
  for (const angle of angles) {
    const hit = castRay(lx, ly, angle, allSegments);
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
  const t = Math.max(0, 1 - dist / radius);
  switch (falloff) {
    case 'linear': return t;
    case 'quadratic': return t * t;
    case 'smooth':
    default:
      return t * t * (3 - 2 * t); // smoothstep
  }
}

/**
 * Render a single point light's contribution onto a canvas context.
 * Clips to the visibility polygon and fills with a radial gradient.
 */
function renderPointLight(ctx, light, visibility, transform) {
  if (visibility.length < 3) return;

  const cx = light.x * transform.scale + transform.offsetX;
  const cy = light.y * transform.scale + transform.offsetY;
  const rPx = light.radius * transform.scale;

  const { r, g, b } = parseColor(light.color || '#ff9944');
  const intensity = light.intensity ?? 1.0;

  // Create radial gradient
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, rPx);
  const centerAlpha = Math.min(1.0, intensity);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${centerAlpha})`);

  // Add falloff stops based on curve type
  const falloff = light.falloff || 'smooth';
  const numStops = 8;
  for (let i = 1; i <= numStops; i++) {
    const frac = i / numStops;
    const mult = falloffMultiplier(frac * light.radius, light.radius, falloff);
    const alpha = Math.min(1.0, intensity * mult);
    gradient.addColorStop(frac, `rgba(${r}, ${g}, ${b}, ${alpha})`);
  }

  ctx.save();

  // Clip to visibility polygon
  ctx.beginPath();
  const p0 = visibility[0];
  ctx.moveTo(
    p0.x * transform.scale + transform.offsetX,
    p0.y * transform.scale + transform.offsetY
  );
  for (let i = 1; i < visibility.length; i++) {
    const p = visibility[i];
    ctx.lineTo(
      p.x * transform.scale + transform.offsetX,
      p.y * transform.scale + transform.offsetY
    );
  }
  ctx.closePath();
  ctx.clip();

  // Fill with gradient
  ctx.fillStyle = gradient;
  ctx.fillRect(cx - rPx, cy - rPx, rPx * 2, rPx * 2);

  ctx.restore();
}

/**
 * Render a single directional (cone) light's contribution.
 * Similar to point light but clipped to a cone defined by angle + spread.
 */
function renderDirectionalLight(ctx, light, visibility, transform) {
  if (visibility.length < 3) return;

  const cx = light.x * transform.scale + transform.offsetX;
  const cy = light.y * transform.scale + transform.offsetY;
  const range = (light.range || light.radius || 30) * transform.scale;

  const { r, g, b } = parseColor(light.color || '#ffffff');
  const intensity = light.intensity ?? 1.0;

  // Direction and spread in radians
  const angleRad = (light.angle || 0) * Math.PI / 180;
  const spreadRad = (light.spread || 45) * Math.PI / 180;

  ctx.save();

  // Build a clipping path: intersection of visibility polygon and cone
  // First clip to visibility polygon
  ctx.beginPath();
  const p0 = visibility[0];
  ctx.moveTo(
    p0.x * transform.scale + transform.offsetX,
    p0.y * transform.scale + transform.offsetY
  );
  for (let i = 1; i < visibility.length; i++) {
    const p = visibility[i];
    ctx.lineTo(
      p.x * transform.scale + transform.offsetX,
      p.y * transform.scale + transform.offsetY
    );
  }
  ctx.closePath();
  ctx.clip();

  // Then clip to cone
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, range, angleRad - spreadRad, angleRad + spreadRad);
  ctx.closePath();
  ctx.clip();

  // Radial gradient for falloff within cone
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, range);
  const falloff = light.falloff || 'smooth';
  const numStops = 8;
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${Math.min(1.0, intensity)})`);
  for (let i = 1; i <= numStops; i++) {
    const frac = i / numStops;
    const effectiveRadius = light.range || light.radius || 30;
    const mult = falloffMultiplier(frac * effectiveRadius, effectiveRadius, falloff);
    const alpha = Math.min(1.0, intensity * mult);
    gradient.addColorStop(frac, `rgba(${r}, ${g}, ${b}, ${alpha})`);
  }

  ctx.fillStyle = gradient;
  ctx.fillRect(cx - range, cy - range, range * 2, range * 2);

  ctx.restore();
}

// ─── Visibility Cache ──────────────────────────────────────────────────────

let visibilityCache = new Map();
let cachedWallHash = null;
let cachedWallSegments = null;

/**
 * Compute a simple hash for wall segment arrays to detect changes.
 */
function hashWalls(segments) {
  // Simple checksum: sum of all coordinates, rounded to avoid float issues
  let h = segments.length;
  for (const s of segments) {
    h = (h * 31 + (s.x1 * 1000 | 0)) | 0;
    h = (h * 31 + (s.y1 * 1000 | 0)) | 0;
    h = (h * 31 + (s.x2 * 1000 | 0)) | 0;
    h = (h * 31 + (s.y2 * 1000 | 0)) | 0;
  }
  return h;
}

/**
 * Clear the visibility polygon cache. Call when walls change.
 */
export function invalidateVisibilityCache() {
  visibilityCache.clear();
  cachedWallHash = null;
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
export function renderLightmap(ctx, lights, cells, gridSize, transform, canvasW, canvasH, ambientLevel, textureCatalog, propCatalog) {
  const activeLights = lights || [];

  // Extract wall segments (cached)
  const wallSegments = extractWallSegments(cells, gridSize, propCatalog);
  const wallHash = hashWalls(wallSegments);

  if (wallHash !== cachedWallHash) {
    visibilityCache.clear();
    cachedWallHash = wallHash;
    cachedWallSegments = wallSegments;
  }

  const segments = cachedWallSegments || wallSegments;

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

  // Fill with ambient darkness (white = fully lit, so we start with gray = ambient)
  // For multiply mode: rgb(ambientLevel*255, ambientLevel*255, ambientLevel*255)
  const amb = Math.round(Math.max(0, Math.min(1, ambientLevel)) * 255);
  lctx.fillStyle = `rgb(${amb}, ${amb}, ${amb})`;
  lctx.fillRect(0, 0, canvasW, canvasH);

  // Additively blend each light's contribution on top of ambient
  lctx.globalCompositeOperation = 'lighter';

  for (const light of activeLights) {
    // Cache key for visibility polygon
    const cacheKey = `${light.id}:${light.x},${light.y},${light.radius || light.range || 30}`;
    let visibility = visibilityCache.get(cacheKey);

    if (!visibility) {
      const effectiveRadius = light.range || light.radius || 30;
      visibility = computeVisibility(light.x, light.y, effectiveRadius, segments);
      visibilityCache.set(cacheKey, visibility);
    }

    if (light.type === 'directional') {
      renderDirectionalLight(lctx, light, visibility, transform);
    } else {
      renderPointLight(lctx, light, visibility, transform);
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
