/**
 * bridges.js — Bridge rendering
 *
 * Draws bridge/dock spans defined by 3 corner points (P1, P2, P3).
 * P1→P2 is the entrance width; P3 determines depth direction.
 * The resulting rectangle is always consistent width (no tapering).
 *
 * Types: 'wood', 'stone', 'rope', 'dock'
 *   - wood:  weathered planks texture, plank seam lines, wood-post railings
 *   - stone: stone wall texture, mortar lines, low parapet strips
 *   - rope:  worn planks texture, lighter plank lines, rope-line railings
 *   - dock:  brown planks texture, bolder plank lines, bollard circles at corners
 */

import type { Theme, RenderTransform, Bridge } from '../types.js';
import { toCanvas } from './bounds.js';
import { warn } from './warnings.js';

// DOMMatrix: browser global, or imported from @napi-rs/canvas in Node.js
let _DOMMatrix = typeof DOMMatrix !== 'undefined' ? DOMMatrix : null;
if (!_DOMMatrix) {
  try { _DOMMatrix = (await import('@napi-rs/canvas')).DOMMatrix; } catch { /* browser — not needed, already global */ }
}

// ── Geometry (duplicated from editor/js/bridge-geometry.js to keep render self-contained) ──

function _getBridgeCorners(p1, p2, p3) {
  const bR = p2[0] - p1[0], bC = p2[1] - p1[1];
  const bLen2 = bR * bR + bC * bC;
  if (bLen2 < 0.001) return [p1, p2, p2, p1];

  const relR = p3[0] - p2[0], relC = p3[1] - p2[1];
  const dotPar = (relR * bR + relC * bC) / bLen2;
  const perpR = relR - dotPar * bR;
  const perpC = relC - dotPar * bC;

  return [p1, p2, [p2[0] + perpR, p2[1] + perpC], [p1[0] + perpR, p1[1] + perpC]];
}

// ── Point-in-polygon helpers (duplicated from stair-geometry.js — render folder cannot import from editor/js) ──

function _pointInPolygon(r, c, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ri = polygon[i][0], ci = polygon[i][1];
    const rj = polygon[j][0], cj = polygon[j][1];
    if (((ri > r) !== (rj > r)) && (c < (cj - ci) * (r - ri) / (rj - ri) + ci)) {
      inside = !inside;
    }
  }
  return inside;
}

function _pointOnPolygonEdge(r, c, polygon, eps = 0.01) {
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ri = polygon[i][0], ci = polygon[i][1];
    const rj = polygon[j][0], cj = polygon[j][1];
    const dr = rj - ri, dc = cj - ci;
    const len2 = dr * dr + dc * dc;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((r - ri) * dr + (c - ci) * dc) / len2));
    if (Math.hypot(c - (ci + t * dc), r - (ri + t * dr)) < eps) return true;
  }
  return false;
}

// ── Style constants ────────────────────────────────────────────────────────────

/** @type {Object.<string, string>} Map of bridge type to texture ID */
export const BRIDGE_TEXTURE_IDS = {
  wood:  'polyhaven/weathered_planks',
  stone: 'polyhaven/stone_wall',
  rope:  'polyhaven/worn_planks',
  dock:  'polyhaven/brown_planks_09',
};
const TEXTURE_IDS = BRIDGE_TEXTURE_IDS;

const FALLBACK_COLORS = {
  wood:  '#c8a065',
  stone: '#888880',
  rope:  '#b89a70',
  dock:  '#a07840',
};

// Plank/mortar line style per type
const PLANK_STYLE = {
  wood:  { spacingCells: 0.5,  color: '#3a1f00', lineWidth: 1.0 },
  stone: { spacingCells: 0.6,  color: '#555550', lineWidth: 0.8 },
  rope:  { spacingCells: 0.45, color: '#8a6a40', lineWidth: 0.7 },
  dock:  { spacingCells: 0.7,  color: '#3a1f00', lineWidth: 1.5 },
};

const EDGE_COLORS = {
  wood:  '#3a1f00',
  stone: '#333333',
  rope:  '#5a3a00',
  dock:  '#3a1f00',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build the bridge path (4-corner polygon) on ctx.
 */
function _buildPath(ctx, A, B, C, D) {
  ctx.beginPath();
  ctx.moveTo(A.x, A.y);
  ctx.lineTo(B.x, B.y);
  ctx.lineTo(C.x, C.y);
  ctx.lineTo(D.x, D.y);
  ctx.closePath();
}

/**
 * Tile a texture image across the bridge.
 * Uses createPattern so the texture repeats naturally.
 */
function _fillTexture(ctx, texImg, cellPx, transform) {
  try {
    const pattern = ctx.createPattern(texImg, 'repeat');
    if (!pattern) return false;
    // Align texture to the world grid so it doesn't slide on pan/zoom
    const imgW = texImg.naturalWidth || texImg.width;
    const scale = cellPx / imgW;
    pattern.setTransform(new _DOMMatrix([
      scale, 0, 0, scale,
      transform.offsetX % cellPx,
      transform.offsetY % cellPx,
    ]));
    ctx.fillStyle = pattern;
    return true;
  } catch (err) {
    console.warn('[bridge-tex] _fillTexture failed:', err?.message || err);
    return false;
  }
}

/**
 * Compute the world-anchored phase offset for plank lines.
 * Returns the distance (in feet) from the entry edge (A corner) to the first
 * world-grid-aligned plank, so adjacent end-to-end bridges have seamless lines.
 */
function _computePhaseOffset(corners, gridSize, spacingCells) {
  const dep_r = (corners[3][0] - corners[0][0]) * gridSize;
  const dep_c = (corners[3][1] - corners[0][1]) * gridSize;
  const depthFeet = Math.hypot(dep_r, dep_c);
  if (depthFeet < 0.001) return 0;
  const dur = dep_r / depthFeet, duc = dep_c / depthFeet;
  // Project A's world position onto the depth unit vector
  const a_proj = corners[0][0] * gridSize * dur + corners[0][1] * gridSize * duc;
  const sf = spacingCells * gridSize;
  return ((-a_proj % sf) + sf) % sf;
}

/**
 * Draw plank/mortar lines across the bridge span (parallel to the AB base,
 * stepping along the depth direction from A→D).
 * phaseOffsetPx anchors the first line to a world-grid position for seamless joins.
 */
function _drawPlankLines(ctx, A, B, depthDx, depthDy, depthLen, spacingPx, lineWidth, phaseOffsetPx) {
  if (spacingPx < 1) return;

  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'butt';

  for (let d = phaseOffsetPx; d < depthLen; d += spacingPx) {
    const t = d / depthLen;
    ctx.beginPath();
    ctx.moveTo(A.x + t * depthDx, A.y + t * depthDy);
    ctx.lineTo(B.x + t * depthDx, B.y + t * depthDy);
    ctx.stroke();
  }
}

/**
 * Compute railing suppression flags for the two long sides (A→D and B→C).
 * For each side, tests a point 0.3 cells outside the edge midpoint against all
 * other bridge footprints. If inside another bridge, that railing is suppressed.
 * Also computes per-corner suppression for dock bollards.
 */
function _computeRailingSuppression(corners, allBridges, thisBridgeId) {
  const noSuppress = { suppressAD: false, suppressBC: false, suppressCorner: [false, false, false, false] };
  const others = allBridges.filter(b => b.id !== thisBridgeId);
  if (!others.length) return noSuppress;

  const otherPolygons = others.map(b => _getBridgeCorners(b.points[0], b.points[1], b.points[2]));

  const bLen = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]);
  if (bLen < 0.001) return noSuppress;
  const buR = (corners[1][0] - corners[0][0]) / bLen;
  const buC = (corners[1][1] - corners[0][1]) / bLen;
  const off = 0.3; // test 0.3 cells outside the edge midpoint

  // A→D side: outward is −base direction (away from B)
  const adR = (corners[0][0] + corners[3][0]) / 2 - off * buR;
  const adC = (corners[0][1] + corners[3][1]) / 2 - off * buC;
  const suppressAD = otherPolygons.some(p => _pointInPolygon(adR, adC, p));

  // B→C side: outward is +base direction (away from A)
  const bcR = (corners[1][0] + corners[2][0]) / 2 + off * buR;
  const bcC = (corners[1][1] + corners[2][1]) / 2 + off * buC;
  const suppressBC = otherPolygons.some(p => _pointInPolygon(bcR, bcC, p));

  // Dock corners: suppress bollard if corner is inside or on the edge of another bridge
  const suppressCorner = corners.map(([cr, cc]) =>
    otherPolygons.some(p => _pointInPolygon(cr, cc, p) || _pointOnPolygonEdge(cr, cc, p, 0.05))
  );

  return { suppressAD, suppressBC, suppressCorner };
}

// ── Railing drawing ────────────────────────────────────────────────────────────

/**
 * Wood railings: a thin filled strip + post circles along both long sides.
 */
function _drawWoodRailings(ctx, A, B, C, D, bux, buy, baseLen, depthDx, depthDy, depthLen, cellPx, suppressAD, suppressBC) {
  const railThick = Math.max(2, cellPx * 0.08); // ~8% of a cell width in pixels

  if (depthLen < 1) return;

  const innerBux = bux * railThick;
  const innerBuy = buy * railThick;

  ctx.fillStyle = 'rgba(80, 40, 10, 0.75)';

  for (const [start, end, sign, suppress] of [[A, D, 1, suppressAD], [B, C, -1, suppressBC]]) {
    if (suppress) continue;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineTo(end.x + sign * innerBux, end.y + sign * innerBuy);
    ctx.lineTo(start.x + sign * innerBux, start.y + sign * innerBuy);
    ctx.closePath();
    ctx.fill();

    // Post circles every ~1 cell along the railing
    const postSpacing = Math.max(cellPx * 0.8, 8);
    const numPosts = Math.max(2, Math.floor(depthLen / postSpacing) + 1);
    const r = Math.max(2, railThick * 0.7);

    for (let i = 0; i <= numPosts; i++) {
      const t = i / numPosts;
      const px = start.x + t * (end.x - start.x) + sign * innerBux * 0.5;
      const py = start.y + t * (end.y - start.y) + sign * innerBuy * 0.5;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = '#5c3a10';
      ctx.fill();
      ctx.fillStyle = 'rgba(80, 40, 10, 0.75)';
    }
  }
}

/**
 * Stone railings: solid low parapet strips on both long sides.
 */
function _drawStoneRailings(ctx, A, B, C, D, bux, buy, cellPx, suppressAD, suppressBC) {
  const parapetThick = Math.max(3, cellPx * 0.15);
  const innerBux = bux * parapetThick;
  const innerBuy = buy * parapetThick;

  ctx.fillStyle = 'rgba(50, 50, 50, 0.70)';

  for (const [start, end, sign, suppress] of [[A, D, 1, suppressAD], [B, C, -1, suppressBC]]) {
    if (suppress) continue;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineTo(end.x + sign * innerBux, end.y + sign * innerBuy);
    ctx.lineTo(start.x + sign * innerBux, start.y + sign * innerBuy);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
}

/**
 * Rope railings: two parallel lines on each long side with perpendicular tie marks.
 */
function _drawRopeRailings(ctx, A, B, C, D, bux, buy, depthLen, cellPx, suppressAD, suppressBC) {
  const ropeOffset1 = cellPx * 0.06;
  const ropeOffset2 = cellPx * 0.12;

  ctx.lineCap = 'round';

  for (const [start, end, sign, suppress] of [[A, D, 1, suppressAD], [B, C, -1, suppressBC]]) {
    if (suppress) continue;
    // Two rope lines
    for (const offset of [ropeOffset1, ropeOffset2]) {
      const ox = sign * bux * offset;
      const oy = sign * buy * offset;
      ctx.strokeStyle = 'rgba(90, 60, 20, 0.85)';
      ctx.lineWidth = Math.max(1, cellPx * 0.025);
      ctx.beginPath();
      ctx.moveTo(start.x + ox, start.y + oy);
      ctx.lineTo(end.x + ox, end.y + oy);
      ctx.stroke();
    }

    // Tie marks every ~0.6 cells
    const tieSpacing = Math.max(cellPx * 0.5, 8);
    const numTies = Math.max(2, Math.floor(depthLen / tieSpacing));
    ctx.strokeStyle = 'rgba(90, 60, 20, 0.6)';
    ctx.lineWidth = Math.max(0.5, cellPx * 0.015);
    for (let i = 0; i <= numTies; i++) {
      const t = i / numTies;
      const px = start.x + t * (end.x - start.x);
      const py = start.y + t * (end.y - start.y);
      ctx.beginPath();
      ctx.moveTo(px + sign * bux * ropeOffset1, py + sign * buy * ropeOffset1);
      ctx.lineTo(px + sign * bux * ropeOffset2, py + sign * buy * ropeOffset2);
      ctx.stroke();
    }
  }
}

/**
 * Dock bollards: small circle posts at the 4 corners.
 * suppressCorner[i] skips the bollard at corner i (A=0, B=1, C=2, D=3).
 */
function _drawDockBollards(ctx, A, B, C, D, cellPx, suppressCorner) {
  const r = Math.max(3, cellPx * 0.12);
  ctx.fillStyle = '#3a2000';
  ctx.strokeStyle = '#6a4010';
  ctx.lineWidth = Math.max(1, cellPx * 0.02);
  [A, B, C, D].forEach((pt, i) => {
    if (suppressCorner[i]) return;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
}

// ── Main rendering ─────────────────────────────────────────────────────────────

/**
 * Render a single bridge onto the canvas.
 */
function renderBridge(ctx, bridge, allBridges, gridSize, theme, transform, getTextureImage) {
  const [p1, p2, p3] = bridge.points;
  const corners = _getBridgeCorners(p1, p2, p3);

  // Convert to canvas pixels
  const A = toCanvas(corners[0][1] * gridSize, corners[0][0] * gridSize, transform);
  const B = toCanvas(corners[1][1] * gridSize, corners[1][0] * gridSize, transform);
  const C = toCanvas(corners[2][1] * gridSize, corners[2][0] * gridSize, transform);
  const D = toCanvas(corners[3][1] * gridSize, corners[3][0] * gridSize, transform);

  // Geometry vectors in canvas pixels
  const baseLen = Math.hypot(B.x - A.x, B.y - A.y);
  if (baseLen < 1) return;

  const depthDx = D.x - A.x, depthDy = D.y - A.y;
  const depthLen = Math.hypot(depthDx, depthDy);
  if (depthLen < 1) return;

  // Base unit vector (A→B direction), used for railing inset calculations
  const bux = (B.x - A.x) / baseLen;
  const buy = (B.y - A.y) / baseLen;

  const cellPx = gridSize * transform.scale;
  const type = bridge.type || 'wood';

  // ── 1. Clip to bridge polygon ──
  ctx.save();
  _buildPath(ctx, A, B, C, D);
  ctx.clip();

  // ── 2. Texture / color base fill ──
  const texId = TEXTURE_IDS[type] || TEXTURE_IDS.wood;
  const texImg = getTextureImage ? getTextureImage(texId) : null;

  _buildPath(ctx, A, B, C, D);
  if (texImg && _fillTexture(ctx, texImg, cellPx, transform)) {
    ctx.globalAlpha = 0.85;
  } else {
    ctx.fillStyle = FALLBACK_COLORS[type] || FALLBACK_COLORS.wood;
    ctx.globalAlpha = 0.90;
  }
  ctx.fill();
  ctx.globalAlpha = 1;

  // ── 3. Plank / mortar lines (world-anchored, parallel to base AB) ──
  const style = PLANK_STYLE[type] || PLANK_STYLE.wood;
  const spacingPx = style.spacingCells * cellPx;
  const phaseOffset = _computePhaseOffset(corners, gridSize, style.spacingCells);
  const phaseOffsetPx = phaseOffset * transform.scale;
  ctx.strokeStyle = style.color;
  _drawPlankLines(ctx, A, B, depthDx, depthDy, depthLen, spacingPx, style.lineWidth, phaseOffsetPx);

  // ── 4. Compute railing suppression for adjacent bridges ──
  const { suppressAD, suppressBC, suppressCorner } = _computeRailingSuppression(corners, allBridges, bridge.id);

  // ── 5. Type-specific railings (still inside clip) ──
  if (type === 'wood') {
    _drawWoodRailings(ctx, A, B, C, D, bux, buy, baseLen, depthDx, depthDy, depthLen, cellPx, suppressAD, suppressBC);
  } else if (type === 'stone') {
    _drawStoneRailings(ctx, A, B, C, D, bux, buy, cellPx, suppressAD, suppressBC);
  } else if (type === 'rope') {
    _drawRopeRailings(ctx, A, B, C, D, bux, buy, depthLen, cellPx, suppressAD, suppressBC);
  } else if (type === 'dock') {
    _drawDockBollards(ctx, A, B, C, D, cellPx, suppressCorner);
  }

  ctx.restore();

  // ── 6. Edge outline (drawn after restore, so it sits on top of the fill) ──
  _buildPath(ctx, A, B, C, D);
  ctx.strokeStyle = EDGE_COLORS[type] || EDGE_COLORS.wood;
  ctx.lineWidth = Math.max(1, transform.scale / 8);
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/**
 * Render all bridges from the dungeon metadata.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} bridges - Array of bridge definitions from metadata.bridges
 * @param {number} gridSize - Cell size in feet
 * @param {object} theme - Current theme object
 * @param {object} transform - { scale, offsetX, offsetY }
 * @param {Function|null} getTextureImage - (textureId: string) => HTMLImageElement|null
 * @returns {void}
 */
export function renderAllBridges(ctx: CanvasRenderingContext2D, bridges: Bridge[] | undefined, gridSize: number, theme: Theme, transform: RenderTransform, getTextureImage: any): void {
  if (!bridges || bridges.length === 0) return;
  for (const bridge of bridges) {
    try {
      renderBridge(ctx, bridge, bridges, gridSize, theme, transform, getTextureImage);
    } catch (e) {
      // Don't let a malformed bridge crash the whole render pass
      warn(`[bridges] Render error for bridge ${bridge.id}: ${e.message}`);
    }
  }
}
