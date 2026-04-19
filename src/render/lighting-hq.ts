/**
 * Pixel-perfect lighting renderer for PNG export.
 * Computes per-pixel falloff, shadow masks, and normal map bump.
 * Used exclusively by the export pipeline (compile.js).
 * The editor's real-time renderer continues using lighting.js.
 */

import type { CellGrid, Light, Metadata, PropCatalog, RenderTransform, TextureCatalog } from '../types.js';
import {
  extractWallSegments,
  computeVisibility,
  falloffMultiplier,
  parseColor,
  getEffectiveLight,
  extractPropShadowZones,
  buildPropShadowIndex,
  computePropShadowPolygon,
  clampSpread,
  DEFAULT_LIGHT_Z,
} from './lighting.js';
import { BUMP_LIGHT_HEIGHT_FRAC } from './lighting-config.js';

// ─── Normal Map Cache ─────────────────────────────────────────────────────────

/**
 * Pre-extract ImageData from each unique normal map used in the cell grid.
 * Returns a Map<textureId, { data, width, height }>.
 */
function cacheNormalMaps(cells: CellGrid, textureCatalog: TextureCatalog | null) {
  const cache = new Map();
  if (!textureCatalog?.textures) return cache;

  const seenIds = new Set<string>();
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = cells[r]![c];
      if (!cell) continue;
      if (cell.texture) seenIds.add(cell.texture);
      if (cell.textureSecondary) seenIds.add(cell.textureSecondary);
    }
  }

  // Create a temp canvas for reading image data
  let tmpCanvas: OffscreenCanvas | HTMLCanvasElement | undefined;
  let tmpCtx: OffscreenCanvasRenderingContext2D | undefined;

  for (const id of seenIds) {
    const entry = textureCatalog.textures[id];
    if (!entry?.norImg?.complete || !entry.norImg.naturalWidth) continue;

    const norImg = entry.norImg;
    const w = norImg.naturalWidth;
    const h = norImg.naturalHeight;

    if (!tmpCanvas) {
      if (typeof OffscreenCanvas !== 'undefined') {
        tmpCanvas = new OffscreenCanvas(w, h);
      } else {
        tmpCanvas = document.createElement('canvas');
      }
      tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    }

    // Resize if needed
    if (tmpCanvas.width !== w || tmpCanvas.height !== h) {
      tmpCanvas.width = w;
      tmpCanvas.height = h;
    }

    tmpCtx!.clearRect(0, 0, w, h);
    tmpCtx!.drawImage(norImg, 0, 0);
    const imageData = tmpCtx!.getImageData(0, 0, w, h);

    cache.set(id, { data: imageData.data, width: w, height: h });
  }

  return cache;
}

// ─── Shadow Mask Rasterization ────────────────────────────────────────────────

// Reusable mask canvas (resized as needed per light)
let maskCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let maskCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

/**
 * Rasterize a visibility polygon into a Uint8Array shadow mask.
 * Uses Canvas2D polygon fill for GPU-accelerated, anti-aliased rasterization.
 *
 * @param {Float32Array} visibility - interleaved [x0,y0,x1,y1,...] polygon in world-feet
 * @param {object} transform - {offsetX, offsetY, scale}
 * @param {number} bbX - bounding box left in pixels
 * @param {number} bbY - bounding box top in pixels
 * @param {number} bbW - bounding box width in pixels
 * @param {number} bbH - bounding box height in pixels
 * @returns {Uint8Array} - one byte per pixel: 0=shadow, 255=lit, AA values in between
 */
function rasterizeShadowMask(
  visibility: Float32Array,
  transform: RenderTransform,
  bbX: number,
  bbY: number,
  bbW: number,
  bbH: number,
  softVisibilities: Float32Array[] | null = null,
) {
  if (!maskCanvas) {
    if (typeof OffscreenCanvas !== 'undefined') {
      maskCanvas = new OffscreenCanvas(bbW, bbH);
    } else {
      maskCanvas = document.createElement('canvas');
      maskCanvas.width = bbW;
      maskCanvas.height = bbH;
    }
    maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  }

  // Resize if needed
  if (maskCanvas.width < bbW || maskCanvas.height < bbH) {
    maskCanvas.width = bbW;
    maskCanvas.height = bbH;
  }

  maskCtx!.clearRect(0, 0, bbW, bbH);

  const sx = transform.scale;
  const ox = transform.offsetX - bbX;
  const oy = transform.offsetY - bbY;

  function drawPoly(vis: Float32Array) {
    maskCtx!.beginPath();
    const n = vis.length;
    maskCtx!.moveTo(vis[0]! * sx + ox, vis[1]! * sx + oy);
    for (let i = 2; i < n; i += 2) {
      maskCtx!.lineTo(vis[i]! * sx + ox, vis[i + 1]! * sx + oy);
    }
    maskCtx!.closePath();
    maskCtx!.fill();
  }

  if (softVisibilities && softVisibilities.length > 0) {
    // Soft shadows: average N sample polygons by stacking them additively
    // at alpha = 1/N so pixels seen by every sample reach full white and
    // pixels seen by some fade toward gray (penumbra).
    maskCtx!.save();
    const alpha = 1 / softVisibilities.length;
    maskCtx!.globalCompositeOperation = 'lighter';
    maskCtx!.fillStyle = `rgba(255,255,255,${alpha.toFixed(4)})`;
    for (const vis of softVisibilities) {
      if (vis.length < 6) continue;
      drawPoly(vis);
    }
    maskCtx!.restore();
  } else {
    maskCtx!.fillStyle = '#ffffff';
    drawPoly(visibility);
  }

  // Read back R channel as shadow mask
  const imageData = maskCtx!.getImageData(0, 0, bbW, bbH);
  const src = imageData.data;
  const mask = new Uint8Array(bbW * bbH);
  for (let i = 0, j = 0; i < src.length; i += 4, j++) {
    mask[j] = src[i]!; // R channel
  }

  return mask;
}

// ─── Main HQ Renderer ────────────────────────────────────────────────────────

/**
 * Render pixel-perfect lightmap for PNG export.
 * Same signature as renderLightmap() from lighting.js but with per-pixel precision.
 * @param {CanvasRenderingContext2D} ctx - Target canvas context
 * @param {Array} lights - Array of light definitions
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Feet per cell
 * @param {Object} transform - Transform with offsetX, offsetY, scale
 * @param {number} canvasW - Canvas pixel width
 * @param {number} canvasH - Canvas pixel height
 * @param {number} ambientLevel - Ambient light level (0.0 to 1.0)
 * @param {Object|null} textureCatalog - Texture catalog for normal maps
 * @param {Object|null} propCatalog - Prop catalog for shadow extraction
 * @param {Object|null} options - Options with ambientColor, time
 * @param {Object|null} [metadata] - Dungeon metadata
 * @returns {void}
 */
export function renderLightmapHQ(
  ctx: CanvasRenderingContext2D,
  lights: Light[],
  cells: CellGrid,
  gridSize: number,
  transform: RenderTransform,
  canvasW: number,
  canvasH: number,
  ambientLevel: number,
  textureCatalog: TextureCatalog | null,
  propCatalog: PropCatalog | null,
  options: Record<string, unknown> | null,
  metadata: Metadata | null = null,
): void {
  const { ambientColor = '#ffffff', time = 0 } = options ?? {};
  // Mirror the group filter from the real-time renderer so PNG exports
  // respect the DM's group-toggle state.
  const disabledGroups = metadata?.disabledLightGroups;
  const activeLights =
    disabledGroups && disabledGroups.length > 0
      ? lights.filter((l) => !l.group || !disabledGroups.includes(l.group))
      : lights;

  // Float32 accumulator for light contributions (RGB, no alpha)
  const lightAccum = new Float32Array(canvasW * canvasH * 3);

  // Cache normal map pixel data once
  const normalCache = cacheNormalMaps(cells, textureCatalog);

  // Extract wall segments (including infinite-height light-blocking props)
  const segments = extractWallSegments(cells, gridSize, propCatalog, metadata);

  // Extract prop shadow zones + spatial index for z-height projection.
  // The index lets each light look up only the zones whose bucket overlaps
  // its bounding circle instead of scanning every prop in the map.
  const propShadowIndex = buildPropShadowIndex(extractPropShadowZones(propCatalog, metadata, gridSize)).index;

  // Precompute inverse transform
  const invScale = 1.0 / transform.scale;
  const offX = transform.offsetX;
  const offY = transform.offsetY;

  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  // Normal map chunk size (matches getTexChunk in render.js)
  const CHUNK_SIZE = 256;

  for (const light of activeLights) {
    const eff = getEffectiveLight(light, time as number);
    // Darkness lights subtract illumination instead of adding. Applied as a
    // signed accumulation; the output loop clamps to [0, 255] so heavy
    // darkness doesn't wrap around.
    const darknessSign = light.darkness ? -1 : 1;
    const brightRadius = (eff.range ?? eff.radius) || 30;
    const dimRadius = eff.dimRadius && eff.dimRadius > (eff.radius || 0) ? eff.dimRadius : null;
    const effectiveRadius = dimRadius ?? brightRadius;

    // Compute visibility polygon at outer radius
    const visibility = computeVisibility(eff.x, eff.y, effectiveRadius, segments);
    if (visibility.length < 3) continue;

    // Soft-shadow samples: same golden-angle disc sampling as the real-time
    // path so export PNGs match the editor preview on the same map.
    let softVisibilities: Float32Array[] | null = null;
    const softR = eff.softShadowRadius ?? 0;
    if (softR > 0) {
      softVisibilities = [];
      const N = 4; // matches SOFT_SHADOW_SAMPLES
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const angle = i * golden;
        const r = Math.sqrt((i + 0.5) / N) * softR;
        const sx = eff.x + Math.cos(angle) * r;
        const sy = eff.y + Math.sin(angle) * r;
        softVisibilities.push(computeVisibility(sx, sy, effectiveRadius, segments));
      }
    }

    // Compute z-height prop shadow polygons for this light. Cull zones whose
    // centroid lies outside the light's radius (mirrors the realtime path in
    // lighting.ts) so a map with many distant props doesn't pay per-pixel
    // point-in-polygon cost for shadows that can't reach.
    const lightZ = eff.z ?? DEFAULT_LIGHT_Z;
    const propShadows = [];
    if (propShadowIndex.size > 0) {
      const rSq = effectiveRadius * effectiveRadius;
      for (const zone of propShadowIndex.query(eff.x, eff.y, effectiveRadius)) {
        const dx = zone.centroidX - eff.x;
        const dy = zone.centroidY - eff.y;
        if (dx * dx + dy * dy > rSq) continue;
        const shadow = computePropShadowPolygon(
          eff.x,
          eff.y,
          lightZ,
          zone.worldPolygon,
          zone.zBottom,
          zone.zTop,
          effectiveRadius,
        );
        if (shadow) propShadows.push(shadow);
      }
    }

    // Light center and outer radius in pixel coords
    const cxPx = eff.x * transform.scale + offX;
    const cyPx = eff.y * transform.scale + offY;
    const rPx = effectiveRadius * transform.scale;

    // Bounding box in pixels (clamped to canvas)
    const bbX = Math.max(0, Math.floor(cxPx - rPx));
    const bbY = Math.max(0, Math.floor(cyPx - rPx));
    const bbX2 = Math.min(canvasW, Math.ceil(cxPx + rPx));
    const bbY2 = Math.min(canvasH, Math.ceil(cyPx + rPx));
    const bbW = bbX2 - bbX;
    const bbH = bbY2 - bbY;
    if (bbW <= 0 || bbH <= 0) continue;

    // Rasterize shadow mask for this light's bounding box (soft version if
    // the light opted in — sample polygons get averaged inside).
    const shadowMask = rasterizeShadowMask(visibility, transform, bbX, bbY, bbW, bbH, softVisibilities);

    // Parse light color to [0,1]
    const { r, g, b } = parseColor(eff.color || '#ff9944');
    const rNorm = r / 255;
    const gNorm = g / 255;
    const bNorm = b / 255;
    const intensity = eff.intensity;
    const falloff = eff.falloff;

    // Precompute directional cone parameters
    const isDirectional = eff.type === 'directional';
    let coneDirX = 0,
      coneDirY = 0,
      cosSpread = 0;
    if (isDirectional) {
      const angleRad = ((eff.angle ?? 0) * Math.PI) / 180;
      coneDirX = Math.cos(angleRad);
      coneDirY = Math.sin(angleRad);
      cosSpread = Math.cos((clampSpread(eff.spread) * Math.PI) / 180);
    }

    // Light height above floor for 3D normal map direction
    const lightHeight = gridSize * BUMP_LIGHT_HEIGHT_FRAC;

    // Per-pixel iteration
    for (let py = bbY; py < bbY2; py++) {
      const maskRowOff = (py - bbY) * bbW;

      for (let px = bbX; px < bbX2; px++) {
        // Shadow test
        const shadowByte = shadowMask[maskRowOff + (px - bbX)]!;
        if (shadowByte === 0) continue;
        const shadowFrac = shadowByte / 255.0;

        // World-feet coords
        const worldX = (px - offX) * invScale;
        const worldY = (py - offY) * invScale;

        // Distance from light center
        const dx = worldX - eff.x;
        const dy = worldY - eff.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > effectiveRadius * effectiveRadius) continue;
        const dist = Math.sqrt(distSq);

        // Cone test for directional lights
        if (isDirectional) {
          if (dist > 0.001) {
            const cosAngle = (dx * coneDirX + dy * coneDirY) / dist;
            if (cosAngle < cosSpread) continue;
          }
        }

        // Bright zone vs dim zone
        let contribution;
        if (dist <= brightRadius) {
          const falloffVal = falloffMultiplier(dist, brightRadius, falloff);
          const dimFloor = dimRadius ? intensity * 0.5 : 0;
          if (falloffVal < 0.001 && dimFloor < 0.001) continue;
          // Normal map bump
          let bumpFactor = 1.0;
          const cellCol = Math.floor(worldX / gridSize);
          const cellRow = Math.floor(worldY / gridSize);
          if (cellRow >= 0 && cellRow < numRows && cellCol >= 0 && cellCol < numCols) {
            const cell = cells[cellRow]![cellCol];
            const norData = cell?.texture ? normalCache.get(cell.texture) : null;
            if (norData) {
              const norW = norData.width;
              const norH = norData.height;
              const cw = Math.max(1, Math.floor(norW / CHUNK_SIZE));
              const ch = Math.max(1, Math.floor(norH / CHUNK_SIZE));
              const srcW = norW / cw;
              const srcH = norH / ch;
              const chunkX = ((cellCol % cw) + cw) % cw;
              const chunkY = ((cellRow % ch) + ch) % ch;
              const fracX = worldX / gridSize - cellCol;
              const fracY = worldY / gridSize - cellRow;
              const sampleX = Math.min(norW - 1, Math.floor(chunkX * srcW + fracX * srcW));
              const sampleY = Math.min(norH - 1, Math.floor(chunkY * srcH + fracY * srcH));
              const nIdx = (sampleY * norW + sampleX) * 4;
              // Matches unpackNormal() in lighting.ts — inlined here because this
              // runs per-pixel per-light in the HQ hot loop and tuple destructuring
              // would allocate ~5M times on a 500×500 map with 20 lights.
              const nx = (norData.data[nIdx]! / 255) * 2 - 1;
              const ny = (norData.data[nIdx + 1]! / 255) * 2 - 1;
              const nz = (norData.data[nIdx + 2]! / 255) * 2 - 1;
              const lLen = Math.sqrt(dx * dx + dy * dy + lightHeight * lightHeight);
              if (lLen > 0.001) {
                const ndotl = (nx * dx + ny * dy + nz * lightHeight) / lLen;
                bumpFactor = 1.0 + (Math.max(0, ndotl) - 1.0) * 0.4;
              }
            }
          }
          const brightContrib = intensity * falloffVal;
          contribution = Math.max(brightContrib, dimFloor) * shadowFrac * bumpFactor;
        } else if (dimRadius) {
          // Dim zone: linear falloff from half-intensity at bright edge to zero at dim edge
          const dimT = 1 - (dist - brightRadius) / (dimRadius - brightRadius);
          if (dimT < 0.001) continue;
          contribution = intensity * 0.5 * dimT * shadowFrac;
        } else {
          continue;
        }

        // Z-height prop shadow attenuation
        if (propShadows.length > 0) {
          let propShadowFactor = 1.0;
          for (const { shadowPoly, nearCenter, farCenter, opacity, hard } of propShadows) {
            if (_pointInPolygon(worldX, worldY, shadowPoly)) {
              let shadowStrength;
              if (hard) {
                // Hard shadow: full opacity, no gradient (light at prop level)
                shadowStrength = opacity;
              } else {
                // Soft shadow: gradient position (0 = near edge, 1 = far edge)
                const gradDx = farCenter[0]! - nearCenter[0]!;
                const gradDy = farCenter[1]! - nearCenter[1]!;
                const gradLenSq = gradDx * gradDx + gradDy * gradDy;
                let t = 0;
                if (gradLenSq > 0.001) {
                  t = Math.max(
                    0,
                    Math.min(1, ((worldX - nearCenter[0]!) * gradDx + (worldY - nearCenter[1]!) * gradDy) / gradLenSq),
                  );
                }
                shadowStrength = opacity * (1 - t); // fades from opacity at near to 0 at far
              }
              propShadowFactor = Math.min(propShadowFactor, 1 - shadowStrength);
            }
          }
          contribution *= propShadowFactor;
        }

        const accIdx = (py * canvasW + px) * 3;
        const signed = darknessSign * contribution;
        lightAccum[accIdx]! += rNorm * signed;
        lightAccum[accIdx + 1]! += gNorm * signed;
        lightAccum[accIdx + 2]! += bNorm * signed;
      }
    }
  }

  // Convert accumulator to final lightmap ImageData (colored ambient)
  const ambient = Math.max(0, Math.min(1, ambientLevel));
  const { r: ar, g: ag, b: ab } = parseColor(ambientColor as string);
  const ambR = (ar / 255) * ambient;
  const ambG = (ag / 255) * ambient;
  const ambB = (ab / 255) * ambient;

  const imageData = ctx.createImageData(canvasW, canvasH);
  const out = imageData.data;

  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    // Clamp both ends — darkness lights can push the accumulator negative.
    out[i] = Math.max(0, Math.min(255, Math.round((ambR + lightAccum[j]!) * 255)));
    out[i + 1] = Math.max(0, Math.min(255, Math.round((ambG + lightAccum[j + 1]!) * 255)));
    out[i + 2] = Math.max(0, Math.min(255, Math.round((ambB + lightAccum[j + 2]!) * 255)));
    out[i + 3] = 255;
  }

  // Composite onto target canvas with multiply
  let lightCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    lightCanvas = new OffscreenCanvas(canvasW, canvasH);
  } else {
    lightCanvas = document.createElement('canvas');
    lightCanvas.width = canvasW;
    lightCanvas.height = canvasH;
  }
  const lctx = lightCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  lctx.putImageData(imageData, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(lightCanvas, 0, 0);
  ctx.restore();
}

/**
 * Ray-casting point-in-polygon test. Returns true if (px, py) is inside the polygon.
 * Polygon is [[x,y], ...] in world-feet coordinates.
 */
function _pointInPolygon(px: number, py: number, polygon: number[][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]! as [number, number];
    const [xj, yj] = polygon[j]! as [number, number];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
