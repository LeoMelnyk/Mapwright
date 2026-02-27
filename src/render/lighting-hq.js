/**
 * Pixel-perfect lighting renderer for PNG export.
 * Computes per-pixel falloff, shadow masks, and normal map bump.
 * Used exclusively by the export pipeline (compile.js).
 * The editor's real-time renderer continues using lighting.js.
 */

import { extractWallSegments, computeVisibility, falloffMultiplier, parseColor } from './lighting.js';

// ─── Normal Map Cache ─────────────────────────────────────────────────────────

/**
 * Pre-extract ImageData from each unique normal map used in the cell grid.
 * Returns a Map<textureId, { data, width, height }>.
 */
function cacheNormalMaps(cells, textureCatalog) {
  const cache = new Map();
  if (!textureCatalog?.textures) return cache;

  const seenIds = new Set();
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = cells[r][c];
      if (!cell) continue;
      if (cell.texture) seenIds.add(cell.texture);
      if (cell.textureSecondary) seenIds.add(cell.textureSecondary);
    }
  }

  // Create a temp canvas for reading image data
  let tmpCanvas, tmpCtx;

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
      tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });
    }

    // Resize if needed
    if (tmpCanvas.width !== w || tmpCanvas.height !== h) {
      tmpCanvas.width = w;
      tmpCanvas.height = h;
    }

    tmpCtx.clearRect(0, 0, w, h);
    tmpCtx.drawImage(norImg, 0, 0);
    const imageData = tmpCtx.getImageData(0, 0, w, h);

    cache.set(id, { data: imageData.data, width: w, height: h });
  }

  return cache;
}

// ─── Shadow Mask Rasterization ────────────────────────────────────────────────

// Reusable mask canvas (resized as needed per light)
let maskCanvas = null;
let maskCtx = null;

/**
 * Rasterize a visibility polygon into a Uint8Array shadow mask.
 * Uses Canvas2D polygon fill for GPU-accelerated, anti-aliased rasterization.
 *
 * @param {Array} visibility - [{x,y},...] polygon in world-feet
 * @param {object} transform - {offsetX, offsetY, scale}
 * @param {number} bbX - bounding box left in pixels
 * @param {number} bbY - bounding box top in pixels
 * @param {number} bbW - bounding box width in pixels
 * @param {number} bbH - bounding box height in pixels
 * @returns {Uint8Array} - one byte per pixel: 0=shadow, 255=lit, AA values in between
 */
function rasterizeShadowMask(visibility, transform, bbX, bbY, bbW, bbH) {
  if (!maskCanvas) {
    if (typeof OffscreenCanvas !== 'undefined') {
      maskCanvas = new OffscreenCanvas(bbW, bbH);
    } else {
      maskCanvas = document.createElement('canvas');
      maskCanvas.width = bbW;
      maskCanvas.height = bbH;
    }
    maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  }

  // Resize if needed
  if (maskCanvas.width < bbW || maskCanvas.height < bbH) {
    maskCanvas.width = bbW;
    maskCanvas.height = bbH;
  }

  maskCtx.clearRect(0, 0, bbW, bbH);
  maskCtx.fillStyle = '#ffffff';

  // Draw visibility polygon offset by bounding box origin
  maskCtx.beginPath();
  const p0 = visibility[0];
  maskCtx.moveTo(
    p0.x * transform.scale + transform.offsetX - bbX,
    p0.y * transform.scale + transform.offsetY - bbY
  );
  for (let i = 1; i < visibility.length; i++) {
    const p = visibility[i];
    maskCtx.lineTo(
      p.x * transform.scale + transform.offsetX - bbX,
      p.y * transform.scale + transform.offsetY - bbY
    );
  }
  maskCtx.closePath();
  maskCtx.fill();

  // Read back R channel as shadow mask
  const imageData = maskCtx.getImageData(0, 0, bbW, bbH);
  const src = imageData.data;
  const mask = new Uint8Array(bbW * bbH);
  for (let i = 0, j = 0; i < src.length; i += 4, j++) {
    mask[j] = src[i]; // R channel
  }

  return mask;
}

// ─── Main HQ Renderer ────────────────────────────────────────────────────────

/**
 * Render pixel-perfect lightmap for PNG export.
 * Same signature as renderLightmap() from lighting.js but with per-pixel precision.
 */
export function renderLightmapHQ(ctx, lights, cells, gridSize, transform, canvasW, canvasH, ambientLevel, textureCatalog, propCatalog) {
  const activeLights = lights || [];

  // Float32 accumulator for light contributions (RGB, no alpha)
  const lightAccum = new Float32Array(canvasW * canvasH * 3);

  // Cache normal map pixel data once
  const normalCache = cacheNormalMaps(cells, textureCatalog);

  // Extract wall segments (including light-blocking props)
  const segments = extractWallSegments(cells, gridSize, propCatalog);

  // Precompute inverse transform
  const invScale = 1.0 / transform.scale;
  const offX = transform.offsetX;
  const offY = transform.offsetY;

  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Normal map chunk size (matches getTexChunk in render.js)
  const CHUNK_SIZE = 256;

  for (const light of activeLights) {
    const effectiveRadius = light.range || light.radius || 30;

    // Compute visibility polygon
    const visibility = computeVisibility(light.x, light.y, effectiveRadius, segments);
    if (visibility.length < 3) continue;

    // Light center and radius in pixel coords
    const cxPx = light.x * transform.scale + offX;
    const cyPx = light.y * transform.scale + offY;
    const rPx = effectiveRadius * transform.scale;

    // Bounding box in pixels (clamped to canvas)
    const bbX = Math.max(0, Math.floor(cxPx - rPx));
    const bbY = Math.max(0, Math.floor(cyPx - rPx));
    const bbX2 = Math.min(canvasW, Math.ceil(cxPx + rPx));
    const bbY2 = Math.min(canvasH, Math.ceil(cyPx + rPx));
    const bbW = bbX2 - bbX;
    const bbH = bbY2 - bbY;
    if (bbW <= 0 || bbH <= 0) continue;

    // Rasterize shadow mask for this light's bounding box
    const shadowMask = rasterizeShadowMask(visibility, transform, bbX, bbY, bbW, bbH);

    // Parse light color to [0,1]
    const { r, g, b } = parseColor(light.color || '#ff9944');
    const rNorm = r / 255;
    const gNorm = g / 255;
    const bNorm = b / 255;
    const intensity = light.intensity ?? 1.0;
    const falloff = light.falloff || 'smooth';

    // Precompute directional cone parameters
    const isDirectional = light.type === 'directional';
    let coneDirX = 0, coneDirY = 0, cosSpread = 0;
    if (isDirectional) {
      const angleRad = (light.angle || 0) * Math.PI / 180;
      coneDirX = Math.cos(angleRad);
      coneDirY = Math.sin(angleRad);
      cosSpread = Math.cos((light.spread || 45) * Math.PI / 180);
    }

    // Light height above floor for 3D normal map direction
    const lightHeight = gridSize * 0.7;

    // Per-pixel iteration
    for (let py = bbY; py < bbY2; py++) {
      const maskRowOff = (py - bbY) * bbW;

      for (let px = bbX; px < bbX2; px++) {
        // Shadow test
        const shadowByte = shadowMask[maskRowOff + (px - bbX)];
        if (shadowByte === 0) continue;
        const shadowFrac = shadowByte / 255.0;

        // World-feet coords
        const worldX = (px - offX) * invScale;
        const worldY = (py - offY) * invScale;

        // Distance from light center
        const dx = worldX - light.x;
        const dy = worldY - light.y;
        const distSq = dx * dx + dy * dy;
        const radiusSq = effectiveRadius * effectiveRadius;
        if (distSq > radiusSq) continue;
        const dist = Math.sqrt(distSq);

        // Cone test for directional lights
        if (isDirectional) {
          if (dist > 0.001) {
            const cosAngle = (dx * coneDirX + dy * coneDirY) / dist;
            if (cosAngle < cosSpread) continue;
          }
        }

        // Exact per-pixel falloff
        const falloffVal = falloffMultiplier(dist, effectiveRadius, falloff);
        if (falloffVal < 0.001) continue;

        // Normal map bump
        let bumpFactor = 1.0;
        const cellCol = Math.floor(worldX / gridSize);
        const cellRow = Math.floor(worldY / gridSize);

        if (cellRow >= 0 && cellRow < numRows && cellCol >= 0 && cellCol < numCols) {
          const cell = cells[cellRow][cellCol];
          const texId = cell?.texture;
          if (texId) {
            const norData = normalCache.get(texId);
            if (norData) {
              // UV mapping matching getTexChunk() from render.js
              const norW = norData.width;
              const norH = norData.height;
              const cw = Math.max(1, Math.floor(norW / CHUNK_SIZE));
              const ch = Math.max(1, Math.floor(norH / CHUNK_SIZE));
              const srcW = norW / cw;
              const srcH = norH / ch;

              const chunkX = ((cellCol % cw) + cw) % cw;
              const chunkY = ((cellRow % ch) + ch) % ch;

              const fracX = (worldX / gridSize) - cellCol;
              const fracY = (worldY / gridSize) - cellRow;

              const sampleX = Math.min(norW - 1, Math.floor(chunkX * srcW + fracX * srcW));
              const sampleY = Math.min(norH - 1, Math.floor(chunkY * srcH + fracY * srcH));
              const nIdx = (sampleY * norW + sampleX) * 4;

              // Decode normal from RGB
              const nx = (norData.data[nIdx] / 255) * 2 - 1;
              const ny = (norData.data[nIdx + 1] / 255) * 2 - 1;
              const nz = (norData.data[nIdx + 2] / 255) * 2 - 1;

              // 3D light direction (from surface to light)
              const lx3 = dx;
              const ly3 = dy;
              const lz3 = lightHeight;
              const lLen = Math.sqrt(lx3 * lx3 + ly3 * ly3 + lz3 * lz3);

              if (lLen > 0.001) {
                const ndotl = (nx * lx3 + ny * ly3 + nz * lz3) / lLen;
                const clampedDot = Math.max(0, ndotl);
                // Blend between 1.0 (no bump) and the N·L value
                bumpFactor = 1.0 + (clampedDot - 1.0) * 0.4; // bumpStrength = 0.4
              }
            }
          }
        }

        // Accumulate
        const contribution = intensity * falloffVal * shadowFrac * bumpFactor;
        const accIdx = (py * canvasW + px) * 3;
        lightAccum[accIdx] += rNorm * contribution;
        lightAccum[accIdx + 1] += gNorm * contribution;
        lightAccum[accIdx + 2] += bNorm * contribution;
      }
    }
  }

  // Convert accumulator to final lightmap ImageData
  const ambient = Math.max(0, Math.min(1, ambientLevel));
  const imageData = ctx.createImageData(canvasW, canvasH);
  const out = imageData.data;

  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    out[i]     = Math.min(255, Math.round((ambient + lightAccum[j])     * 255));
    out[i + 1] = Math.min(255, Math.round((ambient + lightAccum[j + 1]) * 255));
    out[i + 2] = Math.min(255, Math.round((ambient + lightAccum[j + 2]) * 255));
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
  const lctx = lightCanvas.getContext('2d');
  lctx.putImageData(imageData, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(lightCanvas, 0, 0);
  ctx.restore();
}
