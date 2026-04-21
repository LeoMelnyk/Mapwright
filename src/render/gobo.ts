/**
 * Gobo rendering — pattern projection for aperture/occluder gobos.
 *
 * Each gobo zone carries a pattern id (`grid`, `slats`, `slot`, `diamond`,
 * `cross`, `mosaic`, `plain`, or a texture-based pattern). Given a light and
 * a gobo's floor projection quad (computed upstream in `lighting-geometry`),
 * the functions here multiply-blend the pattern's tracery into the per-light
 * RT. Procedural patterns draw 3D rectangles per bar and project all four
 * corners through the light for physically-correct perspective fanning;
 * texture patterns fall back to two-triangle affine mapping across the quad.
 */

import type { FalloffType, Light, RenderTransform } from '../types.js';
import { DEFAULT_LIGHT_Z } from './lighting-geometry.js';
import {
  COOKIE_TEX_SIZE,
  _allocCookieCanvas,
  _getCookieTexture,
  buildRadialGradient,
  buildRadialGradientWithDim,
  clampSpread,
  parseColor,
} from './lighting.js';
import { WATER_TILE_SIZE, WATER_PATTERNS } from './patterns.js';

// ─── Procedural Gobo Textures (density-parameterized) ──────────────────────
//
// Gobos reuse the cookie texture infrastructure but support per-zone density,
// since the whole point of a gobo is "this window has 6 panes, that grate has
// 4 bars." Cache key includes density + orientation. For pattern types that
// aren't density-sensitive (sigil, caustics, dapple, stained-glass) the
// cached cookie texture is reused verbatim.

const goboTexCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

function _drawGoboGrid(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, divisions: number) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  ctx.fillStyle = '#000';
  const step = COOKIE_TEX_SIZE / divisions;
  const bar = step * 0.18;
  for (let i = 0; i <= divisions; i++) {
    ctx.fillRect(i * step - bar / 2, 0, bar, COOKIE_TEX_SIZE);
    ctx.fillRect(0, i * step - bar / 2, COOKIE_TEX_SIZE, bar);
  }
}

function _drawGoboSlats(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bands: number,
  orientation: 'vertical' | 'horizontal',
) {
  // White background = light passes through gaps.
  // Black bars = slat shadow. Multiply composite turns black into darkened
  // gradient, white into unchanged — so we see light stripes between dark bars.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, COOKIE_TEX_SIZE, COOKIE_TEX_SIZE);
  ctx.fillStyle = '#000';
  const step = COOKIE_TEX_SIZE / bands;
  const barFrac = 0.35;
  for (let i = 0; i < bands; i++) {
    const o = (i + (1 - barFrac) / 2) * step;
    if (orientation === 'horizontal') {
      ctx.fillRect(0, o, COOKIE_TEX_SIZE, step * barFrac);
    } else {
      ctx.fillRect(o, 0, step * barFrac, COOKIE_TEX_SIZE);
    }
  }
}

function _getGoboTexture(
  pattern: string,
  density: number,
  orientation: 'vertical' | 'horizontal' = 'vertical',
): OffscreenCanvas | HTMLCanvasElement | null {
  // Non-density-sensitive patterns fall back to the cookie cache.
  if (pattern === 'sigil' || pattern === 'caustics' || pattern === 'dapple' || pattern === 'stained-glass') {
    return _getCookieTexture(pattern);
  }
  const key = `${pattern}:${density}:${orientation}`;
  let tex = goboTexCache.get(key);
  if (tex) return tex;
  tex = _allocCookieCanvas();
  const ctx = tex.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  if (pattern === 'grid') {
    _drawGoboGrid(ctx, Math.max(1, Math.round(density)));
  } else if (pattern === 'slats') {
    _drawGoboSlats(ctx, Math.max(1, Math.round(density)), orientation);
  } else {
    return null;
  }
  goboTexCache.set(key, tex);
  return tex;
}

/**
 * Multiply projected gobo patterns into the per-light RT, one per gobo that
 * this light clears.
 *
 * For `grid` and `slats` patterns the bars are rendered PROCEDURALLY — each
 * mullion / transom / slat projects to its own floor-line via the same
 * light-through-point math the projection polygon uses, and is drawn as a
 * black stroke. This gives physically-correct fanning (bars diverge from
 * the light's ground position exactly as sun-through-mullions would),
 * no affine-approximation distortion, and no triangle-seam artifacts.
 *
 * For `sigil`/`caustics`/`dapple`/`stained-glass` patterns (which can't be
 * expressed as a set of straight lines) the renderer falls back to
 * two-triangle affine texture mapping across the projected quad.
 */
export function applyGobosToRT(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  light: Light,
  transform: RenderTransform,
  bbX: number,
  bbY: number,
  phase: 'occluder' | 'aperture' = 'occluder',
) {
  if (!light._gobos?.length) return;
  const lx = light.x;
  const ly = light.y;
  const lz = light.z ?? DEFAULT_LIGHT_Z;
  const sx = transform.scale;
  const ox = transform.offsetX - bbX;
  const oy = transform.offsetY - bbY;

  // For directional lights, the cone mask is applied downstream via
  // destination-in — but aperture-phase gobos paint with source-over (sunpool
  // readmit) and multiply over transparent pixels (pattern fills), both of
  // which bypass the downstream mask. Clip the whole aperture pass to the
  // cone so sweep/cone lights only project sunpools where the beam is
  // actually pointing through the aperture. Occluder-phase gobos don't need
  // this: they run before the cone mask and get destination-in'd cleanly.
  let conePushed = false;
  if (phase === 'aperture' && light.type === 'directional' && light._gobos.some((g) => g.mode === 'aperture')) {
    const angleRad = ((light.angle ?? 0) * Math.PI) / 180;
    const spreadRad = (clampSpread(light.spread) * Math.PI) / 180;
    const range = ((light.range ?? light.radius) || 30) * sx;
    const relCx = lx * sx + ox;
    const relCy = ly * sx + oy;
    gctx.save();
    gctx.beginPath();
    gctx.moveTo(relCx, relCy);
    gctx.arc(relCx, relCy, range, angleRad - spreadRad, angleRad + spreadRad);
    gctx.closePath();
    gctx.clip();
    conePushed = true;
  }

  for (const entry of light._gobos) {
    const strength = Math.max(0, Math.min(1, entry.strength));
    if (strength === 0) continue;
    // Aperture gobos run AFTER the visibility clip so they can re-admit
    // light through wall apertures; occluder gobos run BEFORE so the
    // visibility polygon naturally trims bars that would fall off-map.
    if ((entry.mode === 'aperture') !== (phase === 'aperture')) continue;

    if (entry.mode === 'aperture') {
      // Re-admit the light's gradient clipped to the sunpool quad so the
      // pattern bars have something to multiply against. The visibility
      // polygon already erased everything on the far side of the wall.
      _readmitApertureLight(gctx, entry, light, lx, ly, lz, sx, ox, oy);
    }

    if (entry.pattern === 'plain') {
      // Aperture-only — the sunpool was admitted above; no tracery overlays it.
      // Used for open windows, broken panes, clear glass without mullions.
    } else if (entry.pattern === 'grid' || entry.pattern === 'slats' || entry.pattern === 'slot') {
      _renderProceduralGoboLines(gctx, entry, lx, ly, lz, sx, ox, oy, strength);
    } else if (entry.pattern === 'diamond') {
      _renderProceduralGoboDiamond(gctx, entry, lx, ly, lz, sx, ox, oy, strength);
    } else if (entry.pattern === 'cross') {
      _renderProceduralGoboCross(gctx, entry, lx, ly, lz, sx, ox, oy, strength);
    } else if (entry.pattern === 'mosaic') {
      _renderProceduralGoboMosaic(gctx, entry, light, lx, ly, lz, sx, ox, oy, strength);
    } else {
      _renderGoboTexturePattern(gctx, entry, sx, ox, oy, strength);
    }
  }

  if (conePushed) gctx.restore();
}

/**
 * Re-admit light into the sunpool footprint for an aperture-mode gobo.
 *
 * The wall the window sits in is a full-height occluder — the visibility
 * polygon has already carved out everything on the far side. To model a
 * window we additively paint the light's radial gradient back into the
 * projection quad the gobo system already computed.
 *
 * `entry.quad` (built in `computeGoboProjectionPolygon`) is a 4-corner
 * trapezoid [segment_p1, segment_p2, far_p2, far_p1], with near edge ON
 * the wall and far edge at the zTop projection — already clamped to the
 * light's radius so it never extends past where the light could reach.
 * That's exactly what we want for the clip region: the lit sunpool is the
 * area from the aperture outward to the light's reach, along the rays
 * that pass through the window. Covers both lz>zTop (standard sunlight
 * cone) and lz inside [zBottom,zTop] (light at window height — clamp in
 * `_getOrComputeLightGeometry` keeps the far edge from inverting).
 *
 * Mirrors the dim-radius handling in `buildPointLightComposite` so the
 * sunpool extends all the way to the light's outer reach when the light
 * has a dim band (torch with dimRadius=60, radius=30 → sunpool visible
 * out to 60 ft, not cut off at 30).
 */
function _readmitApertureLight(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  entry: NonNullable<Light['_gobos']>[number],
  light: Light,
  lx: number,
  ly: number,
  lz: number,
  sx: number,
  ox: number,
  oy: number,
) {
  if (lz <= entry.zBottom) return; // light at/below aperture bottom — no passage
  // Build the sunpool quad by projecting the aperture segment through the
  // light onto the floor at the two z bounds. Physics: a ray from the
  // light that grazes the aperture's TOP (z=zTop) lands farthest from the
  // wall; a ray that grazes the aperture's BOTTOM (z=zBottom) lands
  // CLOSEST to the wall. The wall below the aperture blocks rays that
  // would otherwise land between the wall and the near edge, and the wall
  // above the aperture blocks rays that would otherwise land past the far
  // edge. So the lit sunpool is the band between the two projections.
  //
  // `entry.zTop` was clamped to `lightZ - 0.01` upstream when the light
  // sits inside the aperture range, so `t = lz/(lz - zTop)` stays finite.
  //
  // For lz=8, aperture [4, 6]: near-edge distance = d_l, far-edge = 3·d_l.
  // For lz=20, aperture [4, 6]: near = 0.25·d_l, far = 0.43·d_l (thin
  // sliver — matches a near-overhead light source).
  const quad = entry.quad as [number[], number[], number[], number[]];
  const a1x = quad[0][0]!;
  const a1y = quad[0][1]!;
  const a2x = quad[1][0]!;
  const a2y = quad[1][1]!;

  const hasDim = light.dimRadius != null && light.dimRadius > light.radius;
  const reach = hasDim ? light.dimRadius! : light.radius;
  // Safety cap: near aperture-height the true `t` diverges (zTop ≈ lz), so
  // the raw projection can fly off to thousands of feet. Cap at 8×reach
  // so the quad stays numerically sane; the gradient has already faded to
  // zero by that distance, so the visual is unchanged from "infinite."
  const extendCap = reach * 8;

  const projectThrough = (px: number, py: number, z: number): [number, number] => {
    const denom = lz - z;
    if (denom < 1e-6) {
      // Near-aperture-height guard. Extend straight out along the ray from
      // light through the aperture endpoint up to the safety cap.
      const dx = px - lx;
      const dy = py - ly;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) return [px, py];
      return [px + (dx / dist) * extendCap, py + (dy / dist) * extendCap];
    }
    const t = lz / denom;
    const fx = lx + t * (px - lx);
    const fy = ly + t * (py - ly);
    // Cap the projection magnitude to avoid runaway far points when z is
    // barely below lz (only really matters for zTop near aperture height;
    // zBottom is always well below lz when we got here).
    const dx = fx - lx;
    const dy = fy - ly;
    const dist = Math.hypot(dx, dy);
    if (dist > extendCap) {
      const k = extendCap / dist;
      return [lx + dx * k, ly + dy * k];
    }
    return [fx, fy];
  };
  // Near edge via zBottom (close to wall — wall below aperture blocks
  // anything closer); far edge via zTop (wall above aperture blocks
  // anything further).
  const near1 = projectThrough(a1x, a1y, entry.zBottom);
  const near2 = projectThrough(a2x, a2y, entry.zBottom);
  const far1 = projectThrough(a1x, a1y, entry.zTop);
  const far2 = projectThrough(a2x, a2y, entry.zTop);

  const toPx = (wx: number, wy: number): [number, number] => [wx * sx + ox, wy * sx + oy];
  const p1 = toPx(near1[0], near1[1]);
  const p2 = toPx(near2[0], near2[1]);
  const p3 = toPx(far2[0], far2[1]);
  const p4 = toPx(far1[0], far1[1]);

  let { r, g, b } = light.darkness ? { r: 0, g: 0, b: 0 } : parseColor(light.color);
  // Stained-glass / mosaic: blend the light's color with the pane's color.
  // Pure wavelength multiply is physically accurate but nukes brightness when
  // the light and tint are near-opposite (warm torch × blue glass → near
  // black). An average keeps the sunpool visible while shifting it toward
  // the glass color, which is what DMs actually want for stained-glass
  // cathedrals and mosaic rose windows. Darkness lights are untouched.
  if (entry.tintColor && !light.darkness) {
    const tint = parseColor(entry.tintColor);
    r = (r + tint.r) / 2;
    g = (g + tint.g) / 2;
    b = (b + tint.b) / 2;
  }
  const intensity = light.intensity;
  const falloff: FalloffType = light.falloff;
  const relCx = lx * sx + ox;
  const relCy = ly * sx + oy;
  const rPx = light.radius * sx;
  const dimRPx = hasDim ? light.dimRadius! * sx : null;

  // Clip to the aperture fan. The far-edge extension above guarantees the
  // gradient fades out by the radius boundary rather than being chord-cut.
  gctx.save();
  gctx.beginPath();
  gctx.moveTo(p1[0], p1[1]);
  gctx.lineTo(p2[0], p2[1]);
  gctx.lineTo(p3[0], p3[1]);
  gctx.lineTo(p4[0], p4[1]);
  gctx.closePath();
  gctx.clip();

  // Further clip to the aperture-visibility polygon — the light's visibility
  // computed with `'win'` edges open. Bounds the sunpool by any walls beyond
  // the window so light doesn't leak through into rooms past the aperture.
  const openVis = (light as Light & { _openVisibility?: Float32Array | null })._openVisibility;
  if (openVis && openVis.length >= 6) {
    const ovPx = sx;
    gctx.beginPath();
    gctx.moveTo(openVis[0]! * ovPx + ox, openVis[1]! * ovPx + oy);
    for (let i = 2; i < openVis.length; i += 2) {
      gctx.lineTo(openVis[i]! * ovPx + ox, openVis[i + 1]! * ovPx + oy);
    }
    gctx.closePath();
    gctx.clip();
  }

  gctx.globalCompositeOperation = 'source-over';
  const grad = dimRPx
    ? buildRadialGradientWithDim(gctx, relCx, relCy, rPx, dimRPx, r, g, b, intensity, light.radius, falloff)
    : buildRadialGradient(gctx, relCx, relCy, rPx, r, g, b, intensity, light.radius, falloff);
  gctx.fillStyle = grad;
  gctx.fillRect(0, 0, gctx.canvas.width, gctx.canvas.height);
  gctx.restore();
}

/**
 * Procedural polygon rendering for `grid` / `slats` gobos. Each bar in the
 * gobo's 2D plane is a real 3D rectangle — width along the gobo segment,
 * height in z — and its floor shadow is the quadrilateral formed by
 * projecting all four corners via the light's perspective. Filled with a
 * black multiply pass so the shadow is a solid dark band, not a thin stroke
 * that vanishes in the gradient falloff. Correctly fanning, no affine
 * artifacts, no triangle-seam discontinuities.
 */
function _renderProceduralGoboLines(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  entry: NonNullable<Light['_gobos']>[number],
  lx: number,
  ly: number,
  lz: number,
  sx: number,
  ox: number,
  oy: number,
  strength: number,
) {
  const [nearP1, nearP2] = entry.quad as [number[], number[], number[], number[]];
  const x1 = nearP1[0]!;
  const y1 = nearP1[1]!;
  const x2 = nearP2[0]!;
  const y2 = nearP2[1]!;
  const { zBottom, zTop, density, pattern, orientation } = entry;
  if (lz <= zBottom) return;

  // Project a 3D point onto the z=0 floor from the light position.
  const proj = (px: number, py: number, pz: number): [number, number] => {
    const denom = lz - pz;
    if (Math.abs(denom) < 1e-6) return [px, py];
    const t = lz / denom;
    return [lx + t * (px - lx), ly + t * (py - ly)];
  };
  // World-feet → RT canvas pixels.
  const toPx = (wx: number, wy: number): [number, number] => [wx * sx + ox, wy * sx + oy];

  // Proportional bar width: how much of each cell the mullion/slat occupies.
  // Grid = thin dividers (like window muntins), slats = thick bars (iron).
  // Slot = INVERSE — most of the aperture is opaque stone, a narrow central
  // opening lets light through (arrow slits, letterbox windows, murder holes).
  const barFrac = pattern === 'slats' ? 0.45 : 0.22;
  const slotFrac = 0.14; // width of each slot opening as fraction of aperture

  gctx.save();
  gctx.globalCompositeOperation = 'multiply';
  gctx.globalAlpha = strength;
  gctx.fillStyle = '#000';

  const drawMullions = pattern === 'grid' || (pattern === 'slats' && orientation !== 'horizontal');
  const drawTransoms = pattern === 'grid' || (pattern === 'slats' && orientation === 'horizontal');

  // Fill a 4-corner polygon in canvas pixel coordinates.
  const fillQuad = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
    gctx.beginPath();
    gctx.moveTo(a[0], a[1]);
    gctx.lineTo(b[0], b[1]);
    gctx.lineTo(c[0], c[1]);
    gctx.lineTo(d[0], d[1]);
    gctx.closePath();
    gctx.fill();
  };

  // Draw a 3D rectangle spanning (uA..uB) along the aperture segment and
  // (zBottom..zTop) in height. Used for `slot` flank bars that cover the
  // opaque stone on either side of each slit.
  const fillBarU = (uA: number, uB: number) => {
    const xA = x1 + uA * (x2 - x1);
    const yA = y1 + uA * (y2 - y1);
    const xB = x1 + uB * (x2 - x1);
    const yB = y1 + uB * (y2 - y1);
    const a = toPx(...proj(xA, yA, zBottom));
    const b = toPx(...proj(xB, yB, zBottom));
    const c = toPx(...proj(xB, yB, zTop));
    const d = toPx(...proj(xA, yA, zTop));
    fillQuad(a, b, c, d);
  };

  // Draw a 3D rectangle covering the full aperture width (u: 0..1) between
  // zA and zB. Used for horizontal-orientation `slot` letterbox openings.
  const fillBarZ = (zA: number, zB: number) => {
    if (lz <= zA) return;
    const zLo = Math.max(zBottom, zA);
    const zHi = Math.min(zTop, zB);
    if (zLo >= zHi) return;
    const a = toPx(...proj(x1, y1, zLo));
    const b = toPx(...proj(x2, y2, zLo));
    const c = toPx(...proj(x2, y2, zHi));
    const d = toPx(...proj(x1, y1, zHi));
    fillQuad(a, b, c, d);
  };

  if (pattern === 'slot') {
    if (orientation !== 'horizontal') {
      // Vertical slots (arrow slits) — opaque bars flank each central slit
      // along the aperture's horizontal axis.
      const hwU = slotFrac / (2 * density);
      let lastU = 0;
      for (let i = 0; i < density; i++) {
        const uC = (i + 0.5) / density;
        const uL = Math.max(0, uC - hwU);
        const uR = Math.min(1, uC + hwU);
        if (uL > lastU) fillBarU(lastU, uL);
        lastU = uR;
      }
      if (lastU < 1) fillBarU(lastU, 1);
    } else {
      // Horizontal slots (letterbox / murder hole) — opaque bars flank each
      // slit along the aperture's vertical axis.
      const zSpan = zTop - zBottom;
      const hwZ = (slotFrac * zSpan) / (2 * density);
      let lastZ = zBottom;
      for (let i = 0; i < density; i++) {
        const zC = zBottom + ((i + 0.5) / density) * zSpan;
        const zL = Math.max(zBottom, zC - hwZ);
        const zU = Math.min(zTop, zC + hwZ);
        if (zL > lastZ) fillBarZ(lastZ, zL);
        lastZ = zU;
      }
      if (lastZ < zTop) fillBarZ(lastZ, zTop);
    }
    gctx.restore();
    return;
  }

  if (drawMullions) {
    // Each vertical mullion is a 3D rectangle (bar_width × gobo_height) at
    // u-position u_center ± hw along the gobo segment. Project the four
    // corners to the floor and fill the trapezoid.
    const hwU = barFrac / (2 * density); // half-width in normalized u
    const count = pattern === 'grid' ? density + 1 : density;
    for (let i = 0; i < count; i++) {
      const uCenter = pattern === 'grid' ? i / density : (i + 0.5) / density;
      const uL = uCenter - hwU;
      const uR = uCenter + hwU;
      const xL = x1 + uL * (x2 - x1);
      const yL = y1 + uL * (y2 - y1);
      const xR = x1 + uR * (x2 - x1);
      const yR = y1 + uR * (y2 - y1);
      const a = toPx(...proj(xL, yL, zBottom));
      const b = toPx(...proj(xR, yR, zBottom));
      const c = toPx(...proj(xR, yR, zTop));
      const d = toPx(...proj(xL, yL, zTop));
      fillQuad(a, b, c, d);
    }
  }

  if (drawTransoms) {
    // Each horizontal transom is a 3D rectangle (gobo_width × bar_height) at
    // z-center ± half-bar-height. Project the four corners and fill.
    const zSpan = zTop - zBottom;
    const hwZ = (barFrac * zSpan) / (2 * density);
    const count = pattern === 'grid' ? density + 1 : density;
    for (let i = 0; i < count; i++) {
      const zFrac = pattern === 'grid' ? i / density : (i + 0.5) / density;
      const zCenter = zBottom + zFrac * zSpan;
      const zL = Math.max(zBottom, zCenter - hwZ);
      const zU = Math.min(zTop, zCenter + hwZ);
      if (lz <= zL) continue;
      const a = toPx(...proj(x1, y1, zL));
      const b = toPx(...proj(x2, y2, zL));
      const c = toPx(...proj(x2, y2, zU));
      const d = toPx(...proj(x1, y1, zU));
      fillQuad(a, b, c, d);
    }
  }
  gctx.restore();
}

/**
 * Procedural mosaic rendering — stained-glass / church window. The aperture
 * is divided into a `density × density` grid of colored panes; each pane is a
 * 3D rectangle projected onto the floor. Each pane filters the sunpool
 * gradient through its palette color via MULTIPLY compositing — the physical
 * model for a spectral filter. A red pane passes only red wavelengths, a
 * blue pane passes only blue, so beams of saturated colored light fall on
 * the floor rather than muted tints. Warm torches through cool panes
 * correctly come out dim (warm light has little blue to transmit); daylight
 * through the same panes would stay bright. Lead cames (thin black bars)
 * separate adjacent panes.
 */
function _renderProceduralGoboMosaic(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  entry: NonNullable<Light['_gobos']>[number],
  light: Light,
  lx: number,
  ly: number,
  lz: number,
  sx: number,
  ox: number,
  oy: number,
  strength: number,
) {
  const [nearP1, nearP2] = entry.quad as [number[], number[], number[], number[]];
  const x1 = nearP1[0]!;
  const y1 = nearP1[1]!;
  const x2 = nearP2[0]!;
  const y2 = nearP2[1]!;
  const { zBottom, zTop, density, colors } = entry;
  if (lz <= zBottom) return;

  // Project a 3D point onto the z=0 floor from the light position.
  const proj = (px: number, py: number, pz: number): [number, number] => {
    const denom = lz - pz;
    if (Math.abs(denom) < 1e-6) return [px, py];
    const t = lz / denom;
    return [lx + t * (px - lx), ly + t * (py - ly)];
  };
  const toPx = (wx: number, wy: number): [number, number] => [wx * sx + ox, wy * sx + oy];

  const fillQuad = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
    gctx.beginPath();
    gctx.moveTo(a[0], a[1]);
    gctx.lineTo(b[0], b[1]);
    gctx.lineTo(c[0], c[1]);
    gctx.lineTo(d[0], d[1]);
    gctx.closePath();
    gctx.fill();
  };

  // Project a u/z rectangle (inside the aperture's normalized space) to floor px.
  const paneQuad = (u0: number, u1: number, z0: number, z1: number) => {
    const xL0 = x1 + u0 * (x2 - x1);
    const yL0 = y1 + u0 * (y2 - y1);
    const xR0 = x1 + u1 * (x2 - x1);
    const yR0 = y1 + u1 * (y2 - y1);
    const a = toPx(...proj(xL0, yL0, z0));
    const b = toPx(...proj(xR0, yR0, z0));
    const c = toPx(...proj(xR0, yR0, z1));
    const d = toPx(...proj(xL0, yL0, z1));
    return [a, b, c, d] as [[number, number], [number, number], [number, number], [number, number]];
  };

  const zSpan = zTop - zBottom;
  const cols = Math.max(1, Math.round(density));
  const rows = Math.max(1, Math.round(density));

  // Project a single (u, z) point on the aperture plane onto the floor.
  const projPoint = (u: number, z: number): [number, number] => {
    const x = x1 + u * (x2 - x1);
    const y = y1 + u * (y2 - y1);
    return toPx(...proj(x, y, z));
  };

  // Compute the aperture sunpool clip — same quad _readmitApertureLight uses
  // — so the multiply fills that follow are confined to the actual lit area.
  // Without this, Canvas's 'multiply' composite over transparent pixels still
  // draws at full opacity (transparent src dominates when dest is empty),
  // which was leaking colored shards beyond the sunpool boundary.
  if (lz <= entry.zBottom) return;
  {
    const quad = entry.quad as [number[], number[], number[], number[]];
    const a1x = quad[0][0]!;
    const a1y = quad[0][1]!;
    const a2x = quad[1][0]!;
    const a2y = quad[1][1]!;
    const hasDim = light.dimRadius != null && light.dimRadius > light.radius;
    const reach = hasDim ? light.dimRadius! : light.radius;
    const extendCap = reach * 8;
    const projectThrough = (px: number, py: number, z: number): [number, number] => {
      const denom = lz - z;
      if (denom < 1e-6) {
        const dxr = px - lx;
        const dyr = py - ly;
        const dist = Math.hypot(dxr, dyr);
        if (dist < 1e-6) return [px, py];
        return [px + (dxr / dist) * extendCap, py + (dyr / dist) * extendCap];
      }
      const t = lz / denom;
      const fx = lx + t * (px - lx);
      const fy = ly + t * (py - ly);
      const dxr = fx - lx;
      const dyr = fy - ly;
      const dist = Math.hypot(dxr, dyr);
      if (dist > extendCap) {
        const k = extendCap / dist;
        return [lx + dxr * k, ly + dyr * k];
      }
      return [fx, fy];
    };
    const near1 = projectThrough(a1x, a1y, entry.zBottom);
    const near2 = projectThrough(a2x, a2y, entry.zBottom);
    const far1 = projectThrough(a1x, a1y, entry.zTop);
    const far2 = projectThrough(a2x, a2y, entry.zTop);
    const q1 = toPx(near1[0], near1[1]);
    const q2 = toPx(near2[0], near2[1]);
    const q3 = toPx(far2[0], far2[1]);
    const q4 = toPx(far1[0], far1[1]);
    gctx.save();
    gctx.beginPath();
    gctx.moveTo(q1[0], q1[1]);
    gctx.lineTo(q2[0], q2[1]);
    gctx.lineTo(q3[0], q3[1]);
    gctx.lineTo(q4[0], q4[1]);
    gctx.closePath();
    gctx.clip();
    const openVis = (light as Light & { _openVisibility?: Float32Array | null })._openVisibility;
    if (openVis && openVis.length >= 6) {
      gctx.beginPath();
      gctx.moveTo(openVis[0]! * sx + ox, openVis[1]! * sx + oy);
      for (let i = 2; i < openVis.length; i += 2) {
        gctx.lineTo(openVis[i]! * sx + ox, openVis[i + 1]! * sx + oy);
      }
      gctx.closePath();
      gctx.clip();
    }
  }

  // Use the project's existing Voronoi tile (WATER_PATTERNS) as the source of
  // irregular shards — same pre-computed tile used for fluids. `density` maps
  // to a window into the 300×300 tile: larger density = smaller window =
  // fewer (bigger) shards; smaller density = bigger window = more (smaller)
  // shards, like density controls the glass scale. A per-goboId hash offsets
  // the window so different mosaic gobos hit different regions of the tile
  // and don't all look the same.
  if (colors?.length) {
    const hashStr = (s: string): number => {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) {
        h = (h ^ s.charCodeAt(i)) >>> 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h >>> 0;
    };
    const seed = hashStr(entry.goboId);

    // Aperture dimensions in tile units. Fewer tile units → window covers a
    // smaller slice of the tile → fewer, bigger shards per aperture.
    // Calibrated so density=3 yields roughly a dozen shards across a 5ft-wide
    // window, density=6 yields ~40.
    const tileUnitsPerDensity = 12;
    const tileU = Math.max(4, density * tileUnitsPerDensity);
    const tileZ = tileU * (zSpan / Math.max(0.01, Math.hypot(x2 - x1, y2 - y1)));
    const tileOffU = ((seed % (WATER_TILE_SIZE * 1000)) / 1000) % (WATER_TILE_SIZE - tileU);
    const tileOffZ = (((seed >>> 13) % (WATER_TILE_SIZE * 1000)) / 1000) % (WATER_TILE_SIZE - tileZ);

    // Map a tile-space point (tx, ty) into aperture (u, z).
    const tileToAperture = (tx: number, ty: number): { u: number; z: number } => ({
      u: (tx - tileOffU) / tileU,
      z: zBottom + ((ty - tileOffZ) / tileZ) * zSpan,
    });

    gctx.save();
    gctx.globalCompositeOperation = 'multiply';
    gctx.globalAlpha = strength;
    let cellIdx = 0;
    for (const cell of WATER_PATTERNS) {
      const cx = cell.centre[0];
      const cy = cell.centre[1];
      // Bail early if this cell's centre can't possibly touch the aperture
      // window (its vertices fan out only a small distance from centre).
      if (
        cx < tileOffU - tileU * 0.15 ||
        cx > tileOffU + tileU * 1.15 ||
        cy < tileOffZ - tileZ * 0.15 ||
        cy > tileOffZ + tileZ * 1.15
      ) {
        continue;
      }

      gctx.beginPath();
      let drew = false;
      for (let i = 0; i < cell.verts.length; i++) {
        const raw = tileToAperture(cell.verts[i]![0]!, cell.verts[i]![1]!);
        // Clip to the aperture window — past the edges the projection math
        // would fly off into infinity. Clamp and rely on the outer aperture
        // clip (`_readmitApertureLight`) to trim any residual overshoot.
        const u = Math.max(0, Math.min(1, raw.u));
        const z = Math.max(zBottom, Math.min(zTop, raw.z));
        const p = projPoint(u, z);
        if (!drew) {
          gctx.moveTo(p[0], p[1]);
          drew = true;
        } else {
          gctx.lineTo(p[0], p[1]);
        }
      }
      if (!drew) continue;
      gctx.closePath();
      gctx.fillStyle = colors[cellIdx % colors.length]!;
      gctx.fill();
      cellIdx++;
    }
    gctx.restore();

    // Lead cames — stroke every shard boundary in dark for the leaded-glass
    // look. Thin relative to the map scale so it reads as tracery, not a
    // heavy grid.
    gctx.save();
    gctx.globalCompositeOperation = 'multiply';
    gctx.globalAlpha = strength;
    gctx.strokeStyle = '#000';
    gctx.lineJoin = 'round';
    gctx.lineWidth = Math.max(0.6, sx * 0.03);
    gctx.beginPath();
    for (const cell of WATER_PATTERNS) {
      const cx = cell.centre[0];
      const cy = cell.centre[1];
      if (
        cx < tileOffU - tileU * 0.15 ||
        cx > tileOffU + tileU * 1.15 ||
        cy < tileOffZ - tileZ * 0.15 ||
        cy > tileOffZ + tileZ * 1.15
      ) {
        continue;
      }
      let drew = false;
      for (let i = 0; i < cell.verts.length; i++) {
        const raw = tileToAperture(cell.verts[i]![0]!, cell.verts[i]![1]!);
        const u = Math.max(0, Math.min(1, raw.u));
        const z = Math.max(zBottom, Math.min(zTop, raw.z));
        const p = projPoint(u, z);
        if (!drew) {
          gctx.moveTo(p[0], p[1]);
          drew = true;
        } else {
          gctx.lineTo(p[0], p[1]);
        }
      }
      if (drew) gctx.closePath();
    }
    gctx.stroke();
    gctx.restore();
  } else {
    // No palette — fall back to a plain dark grid so the mosaic pattern is
    // still readable as a window, not a flat bright rectangle.
    gctx.save();
    gctx.globalCompositeOperation = 'multiply';
    gctx.globalAlpha = strength;
    gctx.fillStyle = '#000';
    const uCameHw = 0.04 / cols / 2;
    const zCameHw = (0.04 / rows / 2) * zSpan;
    for (let c = 0; c <= cols; c++) {
      const uC = c / cols;
      const uL = Math.max(0, uC - uCameHw);
      const uR = Math.min(1, uC + uCameHw);
      if (uR <= uL) continue;
      const [a, b, cc, d] = paneQuad(uL, uR, zBottom, zTop);
      fillQuad(a, b, cc, d);
    }
    for (let r = 0; r <= rows; r++) {
      const zC = zBottom + (r / rows) * zSpan;
      const zL = Math.max(zBottom, zC - zCameHw);
      const zU = Math.min(zTop, zC + zCameHw);
      if (zU <= zL || lz <= zL) continue;
      const [a, b, cc, d] = paneQuad(0, 1, zL, zU);
      fillQuad(a, b, cc, d);
    }
    gctx.restore();
  }
  // Pop the aperture-fan clip pushed at the top of the function.
  gctx.restore();
}

/**
 * Procedural diamond/lattice rendering — draws a leaded-glass pattern as a
 * set of diagonal bars (two families of parallel lines crossing at ±45° in
 * the gobo's u/z plane). Each bar is drawn as a single parallelogram with
 * a perpendicular offset in pixel space — constant pixel thickness, no
 * z-overshoot artifacts, no sub-sampling staircase.
 *
 * `density` = number of diamonds along the gobo's width. The two diagonal
 * families each have `2*density+1` bars to tile cleanly across the opening.
 */
function _renderProceduralGoboDiamond(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  entry: NonNullable<Light['_gobos']>[number],
  lx: number,
  ly: number,
  lz: number,
  sx: number,
  ox: number,
  oy: number,
  strength: number,
) {
  const [nearP1, nearP2, farP2, farP1] = entry.quad as [number[], number[], number[], number[]];
  const x1 = nearP1[0]!;
  const y1 = nearP1[1]!;
  const x2 = nearP2[0]!;
  const y2 = nearP2[1]!;
  const { zBottom, zTop } = entry;
  const density = Math.max(1, Math.round(entry.density));
  if (lz <= zBottom) return;

  const proj = (px: number, py: number, pz: number): [number, number] => {
    const denom = lz - pz;
    if (Math.abs(denom) < 1e-6) return [px, py];
    const t = lz / denom;
    return [lx + t * (px - lx), ly + t * (py - ly)];
  };
  const toPx = (wx: number, wy: number): [number, number] => [wx * sx + ox, wy * sx + oy];

  const zSpan = zTop - zBottom;
  // Diamond aspect: tie the u-axis and z-axis step to a single cell size so
  // diamonds are square in the gobo plane (not squashed when zSpan ≠ width).
  const gobU = Math.hypot(x2 - x1, y2 - y1);
  const cellSize = gobU / density; // diamond width along u
  const numZ = Math.max(1, Math.round(zSpan / cellSize));
  const barFracU = 0.1; // bar thickness as fraction of cellSize
  const thickness = barFracU * cellSize; // bar thickness in world feet

  gctx.save();
  // Clip to the projected aperture trapezoid. Diagonal bars are parameterized
  // over ranges that extend past u∈[0,1] so nearby sunpools (adjacent windows)
  // would otherwise catch stray lattice fragments.
  gctx.beginPath();
  const [cx1, cy1] = toPx(nearP1[0]!, nearP1[1]!);
  const [cx2, cy2] = toPx(nearP2[0]!, nearP2[1]!);
  const [cx3, cy3] = toPx(farP2[0]!, farP2[1]!);
  const [cx4, cy4] = toPx(farP1[0]!, farP1[1]!);
  gctx.moveTo(cx1, cy1);
  gctx.lineTo(cx2, cy2);
  gctx.lineTo(cx3, cy3);
  gctx.lineTo(cx4, cy4);
  gctx.closePath();
  gctx.clip();
  gctx.globalCompositeOperation = 'multiply';
  gctx.globalAlpha = strength;
  gctx.fillStyle = '#000';

  // Convert a gobo-plane point (uWorld ft along aperture, zWorld ft) into
  // world 3D then project to floor pixels.
  const worldToPx = (uWorld: number, zWorld: number): [number, number] => {
    const uFrac = uWorld / gobU;
    const wx = x1 + uFrac * (x2 - x1);
    const wy = y1 + uFrac * (y2 - y1);
    return toPx(...proj(wx, wy, zWorld));
  };

  // Draw a diagonal bar as a single parallelogram. Project the centerline's
  // two endpoints to the floor, then offset perpendicular in pixel space. This
  // avoids 3D perpendicular offsets that could push corners above `lightZ`
  // (where the upstream clamp pins zTop) and flip the projection behind the
  // light. Constant-pixel thickness is fine for thin lead bars.
  const halfThickPx = (thickness * sx) / 2;
  const drawDiagonalBar = (startU: number, endU: number) => {
    const [p0x, p0y] = worldToPx(startU * gobU, zBottom);
    const [p1x, p1y] = worldToPx(endU * gobU, zTop);
    const dx = p1x - p0x;
    const dy = p1y - p0y;
    const lenPx = Math.hypot(dx, dy);
    if (lenPx < 1e-3) return;
    const perpX = (-dy / lenPx) * halfThickPx;
    const perpY = (dx / lenPx) * halfThickPx;
    gctx.beginPath();
    gctx.moveTo(p0x + perpX, p0y + perpY);
    gctx.lineTo(p1x + perpX, p1y + perpY);
    gctx.lineTo(p1x - perpX, p1y - perpY);
    gctx.lineTo(p0x - perpX, p0y - perpY);
    gctx.closePath();
    gctx.fill();
  };

  // Family 1: "/" bars — u increases with z. Sweep starting u from -numZ..density.
  for (let k = -numZ; k <= density; k++) {
    const startU = k / density;
    const endU = (k + numZ) / density;
    drawDiagonalBar(startU, endU);
  }
  // Family 2: "\" bars — u decreases with z.
  for (let k = 0; k <= density + numZ; k++) {
    const startU = k / density;
    const endU = (k - numZ) / density;
    drawDiagonalBar(startU, endU);
  }

  gctx.restore();
}

/**
 * Procedural Latin-cross rendering — one vertical bar centered along the gobo's
 * u-axis plus one horizontal transom about 60% up the opening. Projects the
 * same way as grid mullions. Density is ignored (a cross is a cross), but the
 * cross's proportions scale with the opening dimensions.
 */
function _renderProceduralGoboCross(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  entry: NonNullable<Light['_gobos']>[number],
  lx: number,
  ly: number,
  lz: number,
  sx: number,
  ox: number,
  oy: number,
  strength: number,
) {
  const [nearP1, nearP2] = entry.quad as [number[], number[], number[], number[]];
  const x1 = nearP1[0]!;
  const y1 = nearP1[1]!;
  const x2 = nearP2[0]!;
  const y2 = nearP2[1]!;
  const { zBottom, zTop } = entry;
  if (lz <= zBottom) return;

  const proj = (px: number, py: number, pz: number): [number, number] => {
    const denom = lz - pz;
    if (Math.abs(denom) < 1e-6) return [px, py];
    const t = lz / denom;
    return [lx + t * (px - lx), ly + t * (py - ly)];
  };
  const toPx = (wx: number, wy: number): [number, number] => [wx * sx + ox, wy * sx + oy];

  const zSpan = zTop - zBottom;
  // Cross arm thickness relative to opening. Larger = chunkier cross.
  const barFrac = 0.18;
  const hwU = barFrac / 2;
  const hwZ = (barFrac * zSpan) / 2;
  // Transom at 60% of height (Latin cross proportions: crossbar above center).
  const zCross = zBottom + 0.6 * zSpan;

  gctx.save();
  gctx.globalCompositeOperation = 'multiply';
  gctx.globalAlpha = strength;
  gctx.fillStyle = '#000';

  const segPoint = (uNorm: number): [number, number] => [x1 + uNorm * (x2 - x1), y1 + uNorm * (y2 - y1)];
  const fillQuad = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
    gctx.beginPath();
    gctx.moveTo(a[0], a[1]);
    gctx.lineTo(b[0], b[1]);
    gctx.lineTo(c[0], c[1]);
    gctx.lineTo(d[0], d[1]);
    gctx.closePath();
    gctx.fill();
  };

  // Vertical bar: u-centered, spans full z.
  {
    const [xL, yL] = segPoint(0.5 - hwU);
    const [xR, yR] = segPoint(0.5 + hwU);
    const a = toPx(...proj(xL, yL, zBottom));
    const b = toPx(...proj(xR, yR, zBottom));
    const c = toPx(...proj(xR, yR, zTop));
    const d = toPx(...proj(xL, yL, zTop));
    fillQuad(a, b, c, d);
  }
  // Horizontal transom: spans full u, centered at zCross.
  {
    const [xL, yL] = segPoint(0);
    const [xR, yR] = segPoint(1);
    const zL = Math.max(zBottom, zCross - hwZ);
    const zU = Math.min(zTop, zCross + hwZ);
    if (lz > zL) {
      const a = toPx(...proj(xL, yL, zL));
      const b = toPx(...proj(xR, yR, zL));
      const c = toPx(...proj(xR, yR, zU));
      const d = toPx(...proj(xL, yL, zU));
      fillQuad(a, b, c, d);
    }
  }
  gctx.restore();
}

/**
 * Two-triangle affine texture mapping for non-grid patterns (sigil,
 * caustics, dapple, stained-glass). Each triangle's 3 corners land exactly
 * on projected quad corners; the texture is stretched linearly inside.
 */
function _renderGoboTexturePattern(
  gctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  entry: NonNullable<Light['_gobos']>[number],
  sx: number,
  ox: number,
  oy: number,
  strength: number,
) {
  const W = COOKIE_TEX_SIZE;
  const H = COOKIE_TEX_SIZE;
  const [nearP1, nearP2, farP2, farP1] = entry.quad as [number[], number[], number[], number[]];
  const tex = _getGoboTexture(entry.pattern, entry.density, entry.orientation);
  if (!tex) return;

  const nP1x = nearP1[0]! * sx + ox;
  const nP1y = nearP1[1]! * sx + oy;
  const nP2x = nearP2[0]! * sx + ox;
  const nP2y = nearP2[1]! * sx + oy;
  const fP1x = farP1[0]! * sx + ox;
  const fP1y = farP1[1]! * sx + oy;
  const fP2x = farP2[0]! * sx + ox;
  const fP2y = farP2[1]! * sx + oy;

  gctx.save();
  gctx.globalCompositeOperation = 'multiply';
  gctx.globalAlpha = strength;

  const drawTriangle = (
    tu1: number,
    tv1: number,
    wx1: number,
    wy1: number,
    tu2: number,
    tv2: number,
    wx2: number,
    wy2: number,
    tu3: number,
    tv3: number,
    wx3: number,
    wy3: number,
  ) => {
    const det = tu1 * (tv2 - tv3) - tv1 * (tu2 - tu3) + (tu2 * tv3 - tu3 * tv2);
    if (Math.abs(det) < 1e-9) return;
    const invDet = 1 / det;
    const m11 = (tv2 - tv3) * invDet,
      m12 = (tv3 - tv1) * invDet,
      m13 = (tv1 - tv2) * invDet;
    const m21 = (tu3 - tu2) * invDet,
      m22 = (tu1 - tu3) * invDet,
      m23 = (tu2 - tu1) * invDet;
    const m31 = (tu2 * tv3 - tu3 * tv2) * invDet,
      m32 = (tu3 * tv1 - tu1 * tv3) * invDet,
      m33 = (tu1 * tv2 - tu2 * tv1) * invDet;
    const a = m11 * wx1 + m12 * wx2 + m13 * wx3;
    const c = m21 * wx1 + m22 * wx2 + m23 * wx3;
    const e = m31 * wx1 + m32 * wx2 + m33 * wx3;
    const b = m11 * wy1 + m12 * wy2 + m13 * wy3;
    const d = m21 * wy1 + m22 * wy2 + m23 * wy3;
    const f = m31 * wy1 + m32 * wy2 + m33 * wy3;
    gctx.save();
    gctx.beginPath();
    gctx.moveTo(wx1, wy1);
    gctx.lineTo(wx2, wy2);
    gctx.lineTo(wx3, wy3);
    gctx.closePath();
    gctx.clip();
    const pat = gctx.createPattern(tex, 'no-repeat');
    if (!pat) {
      gctx.restore();
      return;
    }
    pat.setTransform({ a, b, c, d, e, f });
    gctx.fillStyle = pat;
    const minX = Math.min(wx1, wx2, wx3);
    const minY = Math.min(wy1, wy2, wy3);
    const maxX = Math.max(wx1, wx2, wx3);
    const maxY = Math.max(wy1, wy2, wy3);
    gctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    gctx.restore();
  };
  drawTriangle(0, 0, nP1x, nP1y, W, 0, nP2x, nP2y, 0, H, fP1x, fP1y);
  drawTriangle(W, 0, nP2x, nP2y, W, H, fP2x, fP2y, 0, H, fP1x, fP1y);

  if (strength < 1) {
    gctx.globalCompositeOperation = 'lighter';
    gctx.globalAlpha = 1 - strength;
    gctx.fillStyle = '#ffffff';
    gctx.beginPath();
    gctx.moveTo(nP1x, nP1y);
    gctx.lineTo(nP2x, nP2y);
    gctx.lineTo(fP2x, fP2y);
    gctx.lineTo(fP1x, fP1y);
    gctx.closePath();
    gctx.fill();
  }
  gctx.restore();
}
