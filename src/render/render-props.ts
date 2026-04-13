/**
 * render-props.js - Canvas rendering and tile caching for props
 *
 * Handles rendering props onto a canvas context, including texture-filled
 * shapes (texfill), gradient fills (gradient-radial, gradient-linear),
 * custom hex colors, drop shadows, and tile caching for performance.
 */

import type {
  CellGrid,
  Theme,
  RenderTransform,
  PropDefinition,
  PropCommand,
  PropCatalog,
  OverlayProp,
  Metadata,
  VisibleBounds,
} from '../types.js';
import { toCanvas } from './bounds.js';
import { warn } from './warnings.js';
import { parseHexColor, scaleFactor, flipCommand, transformCommand, isGradient } from './parse-props.js';

// ── Prop Tile Cache ──────────────────────────────────────────────────────────
// Pre-renders each unique {type, facing, flipped} combination to an OffscreenCanvas
// keyed by (type|facing|flipped|scale|wallStroke|texturesVersion).
// Cache hits replace all draw commands with a single drawImage call.
// Scale is part of the key so tiles are rebuilt on zoom changes.
// Theme changes bust the cache via wallStroke; texture loads via texturesVersion.
// Prop definition changes (catalog reload) require explicit invalidatePropsCache().

const _propTileCache = new Map();

/**
 * Clear all cached prop tiles.
 * Call when prop definitions change (catalog reload).
 * Theme and texture changes are handled automatically via the cache key.
 */
let _propsVersion = 0;
/**
 * Clear everything — tile bitmaps + render layer. Use when prop definitions or textures change.
 * @returns {void}
 */
export function invalidatePropsCache(): void {
  _propTileCache.clear();
  _propsRenderLayer = null;
  _propsVersion++;
}
/**
 * Clear only the full-map render layer. Use when props are moved/added/removed (tiles are still valid).
 * @returns {void}
 */
export function invalidatePropsRenderLayer(): void {
  _propsRenderLayer = null;
  _propsVersion++;
}
/**
 * Get the current props cache version counter.
 * @returns {number} Props version
 */
export function getPropsVersion(): number {
  return _propsVersion;
}

// ── Pre-rendered props layer cache ─────────────────────────────────────────
// Renders all props to an offscreen canvas at cache resolution. Reused across
// map cache rebuilds as long as props haven't changed.
let _propsRenderLayer: {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  w: number;
  h: number;
  propsVersion: number;
  texturesVersion: number;
} | null = null;

/**
 * Return a pre-rendered transparent canvas containing all props at cache resolution.
 * Returns null if no props exist. Cached as long as metadata.props reference
 * and texturesVersion haven't changed.
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme object
 * @param {Object} propCatalog - Prop catalog with definitions
 * @param {Function} getTextureImage - Function to retrieve texture images by ID
 * @param {number} texturesVersion - Texture load version counter
 * @param {Object} metadata - Dungeon metadata with props array
 * @param {number} cacheW - Cache canvas width in pixels
 * @param {number} cacheH - Cache canvas height in pixels
 * @param {number} [cacheScale=10] - Pixels per foot at cache resolution
 * @returns {HTMLCanvasElement|null} Pre-rendered props canvas, or null
 */
export function getRenderedPropsLayer(
  cells: CellGrid,
  gridSize: number,
  theme: Theme,
  propCatalog: PropCatalog | null,
  getTextureImage: ((id: string) => HTMLImageElement | null) | null,
  texturesVersion: number,
  metadata: Metadata | null,
  cacheW: number,
  cacheH: number,
  cacheScale: number = 10,
): OffscreenCanvas | HTMLCanvasElement | null {
  if (!propCatalog || !metadata?.props?.length) return null;

  if (
    _propsRenderLayer?.w === cacheW &&
    _propsRenderLayer.h === cacheH &&
    _propsRenderLayer.propsVersion === _propsVersion &&
    _propsRenderLayer.texturesVersion === texturesVersion
  ) {
    return _propsRenderLayer.canvas;
  }

  let offCanvas;
  if (_propsRenderLayer?.canvas) {
    offCanvas = _propsRenderLayer.canvas;
    if (offCanvas.width !== cacheW || offCanvas.height !== cacheH) {
      offCanvas.width = cacheW;
      offCanvas.height = cacheH;
    }
  } else {
    offCanvas = document.createElement('canvas');
    offCanvas.width = cacheW;
    offCanvas.height = cacheH;
  }

  const ctx = offCanvas.getContext('2d', { alpha: true }) as OffscreenCanvasRenderingContext2D;
  ctx.clearRect(0, 0, cacheW, cacheH);

  const cacheTransform = { scale: cacheScale, offsetX: 0, offsetY: 0 };

  renderOverlayProps(
    ctx,
    metadata.props,
    gridSize,
    theme,
    cacheTransform,
    propCatalog,
    getTextureImage,
    texturesVersion,
    null,
  );

  _propsRenderLayer = { canvas: offCanvas, w: cacheW, h: cacheH, propsVersion: _propsVersion, texturesVersion };
  return offCanvas;
}

// Scale is not part of the key — tiles are rendered once at TILE_BASE_PX per cell
// and scaled to the current display size via drawImage(tile, x, y, w, h).
// Props are deterministic vector shapes; browser bilinear scaling is sufficient.
function _tileCacheKey(type: string, facing: number, flipped: boolean, wallStroke: string, texturesVersion: number) {
  return `${type}|${facing}|${flipped ? 1 : 0}|${wallStroke}|${texturesVersion}`;
}

// Fixed tile resolution: pixels per grid cell. High enough to stay sharp at max zoom.
const TILE_BASE_PX = 128;

/**
 * Render a prop to an OffscreenCanvas tile at a fixed base resolution.
 * Returns null if OffscreenCanvas is unavailable (Node.js / PDF renderer).
 */
function _buildTile(
  propDef: PropDefinition,
  rotation: number,
  flipped: boolean,
  gridSize: number,
  theme: Theme,
  getTextureImage: ((id: string) => HTMLImageElement | null) | null,
) {
  if (typeof OffscreenCanvas === 'undefined') return null;

  const [fRows, fCols] = propDef.footprint;
  const isRotated90 = rotation === 90 || rotation === 270;
  const eRows = isRotated90 ? fCols : fRows;
  const eCols = isRotated90 ? fRows : fCols;

  const padding = propDef.padding || 0;
  const tileScale = TILE_BASE_PX / gridSize; // px per foot at tile resolution
  const w = Math.max(1, Math.ceil((eCols + 2 * padding) * TILE_BASE_PX));
  const h = Math.max(1, Math.ceil((eRows + 2 * padding) * TILE_BASE_PX));

  const oc = new OffscreenCanvas(w, h);
  const octx = oc.getContext('2d');

  const tileTransform = { scale: tileScale, offsetX: padding * TILE_BASE_PX, offsetY: padding * TILE_BASE_PX };
  if (!octx) return null;
  renderProp(octx, propDef, 0, 0, rotation, gridSize, theme, tileTransform, flipped, getTextureImage);

  return oc;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Convert a normalized prop coordinate to canvas pixel coordinates.
 *
 * A cell at grid position (row, col) has its top-left at feet coordinates
 * (col * gridSize, row * gridSize). Normalized prop coordinate (nx, ny)
 * maps to feet as: feetX = (col + nx) * gridSize, feetY = (row + ny) * gridSize.
 *
 * @param {number} nx - Normalized x (0..cols for multi-cell props)
 * @param {number} ny - Normalized y (0..rows for multi-cell props)
 * @param {number} row - Cell row in the grid
 * @param {number} col - Cell column in the grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {object} transform - { scale, offsetX, offsetY }
 * @returns {{ x: number, y: number }} Canvas pixel coordinates
 */
function propToCanvas(nx: number, ny: number, row: number, col: number, gridSize: number, transform: RenderTransform) {
  const feetX = (col + nx) * gridSize;
  const feetY = (row + ny) * gridSize;
  return toCanvas(feetX, feetY, transform);
}

/**
 * Apply fill or stroke style to the canvas context.
 *
 * Supports custom hex colors via cmd.color. Falls back to theme.wallStroke.
 * - stroke: uses cmd.color or theme.wallStroke
 * - fill: uses cmd.color or theme.wallStroke with semi-transparency (default 0.15 opacity)
 */
function applyStyle(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, cmd: PropCommand, theme: Theme) {
  const color = (cmd.color ?? theme.wallStroke) || '#000000';

  if (cmd.style === 'stroke') {
    ctx.strokeStyle = color;
  } else {
    // Fill: parse hex and apply as rgba with opacity
    const { r, g, b } = parseHexColor(color);
    const alpha = cmd.opacity ?? 0.15;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

/**
 * Create a Canvas gradient (radial or linear) for gradient-fill styles.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} cmd - Parsed command with style, color, gradientEnd, opacity, angle
 * @param {number} cx - Center x in canvas pixels
 * @param {number} cy - Center y in canvas pixels
 * @param {number} rx - Half-width (or radius) in canvas pixels
 * @param {number} ry - Half-height (or radius) in canvas pixels
 * @returns {CanvasGradient}
 */
function createGradient(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cmd: PropCommand,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
) {
  const { r: r1, g: g1, b: b1 } = parseHexColor(cmd.color ?? '#ffffff');
  const { r: r2, g: g2, b: b2 } = parseHexColor(cmd.gradientEnd ?? '#000000');
  const alpha = cmd.opacity ?? 0.8;

  let grad;
  if (cmd.style === 'gradient-radial') {
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
  } else {
    // Linear gradient — use the 'angle' modifier (degrees, 0 = top-to-bottom)
    const angle = cmd.angle ?? 0;
    const rad = (angle * Math.PI) / 180;
    const len = Math.max(rx, ry);
    const dx = Math.sin(rad) * len;
    const dy = -Math.cos(rad) * len;
    grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  }

  grad.addColorStop(0, `rgba(${r1}, ${g1}, ${b1}, ${alpha})`);
  grad.addColorStop(1, `rgba(${r2}, ${g2}, ${b2}, ${alpha})`);
  return grad;
}

/**
 * Fill a rectangular canvas region with a texture image.
 * Falls back to solid grey fill if the texture is not available.
 */
function drawTexFillRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cmd: PropCommand,
  x: number,
  y: number,
  w: number,
  h: number,
  getTextureImage: ((id: string) => HTMLImageElement | null) | null,
) {
  const img = cmd.textureId ? getTextureImage?.(cmd.textureId) : null;
  const alpha = cmd.opacity ?? 0.9;

  if (!img || !img.complete || !img.naturalWidth) {
    // No warning here — textures load asynchronously, fallback is expected until ready
    ctx.fillStyle = `rgba(128, 128, 128, ${alpha})`;
    ctx.fillRect(x, y, w, h);
    return;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, x, y, w, h);
  ctx.restore();
}

/**
 * Fill a clipped canvas path with a texture image.
 * The path must already be defined via beginPath + arc/moveTo/lineTo.
 * @param {object} bbox - { x, y, w, h } bounding box for drawImage
 */
function drawTexFillPath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cmd: PropCommand,
  bbox: { x: number; y: number; w: number; h: number },
  getTextureImage: ((id: string) => HTMLImageElement | null) | null,
) {
  const img = cmd.textureId ? getTextureImage?.(cmd.textureId) : null;
  const alpha = cmd.opacity ?? 0.9;

  if (!img || !img.complete || !img.naturalWidth) {
    ctx.fillStyle = `rgba(128, 128, 128, ${alpha})`;
    ctx.fill();
    return;
  }

  ctx.save();
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, bbox.x, bbox.y, bbox.w, bbox.h);
  ctx.restore();
}

/**
 * Draw a soft drop shadow under a prop.
 * Rendered as a radial-gradient ellipse matching the footprint, offset slightly.
 */
function _drawPropShadow(
  ctx: CanvasRenderingContext2D,
  propDef: PropDefinition,
  row: number,
  col: number,
  rotation: number,
  gridSize: number,
  transform: RenderTransform,
) {
  const [fRows, fCols] = propDef.footprint;
  // Effective footprint after rotation
  const isRotated90 = rotation === 90 || rotation === 270;
  const eRows = isRotated90 ? fCols : fRows;
  const eCols = isRotated90 ? fRows : fCols;

  const s = scaleFactor(transform);
  const cellPx = gridSize * transform.scale;

  // Center of footprint in canvas coordinates
  const center = propToCanvas(eCols / 2, eRows / 2, row, col, gridSize, transform);
  const rx = (eCols / 2) * cellPx * 0.85;
  const ry = (eRows / 2) * cellPx * 0.85;

  // Offset shadow slightly down-right
  const ox = 2 * s;
  const oy = 2 * s;
  const blurRadius = Math.max(rx, ry) * 1.1;

  ctx.save();
  const grad = ctx.createRadialGradient(center.x + ox, center.y + oy, 0, center.x + ox, center.y + oy, blurRadius);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.25)');
  grad.addColorStop(0.6, 'rgba(0, 0, 0, 0.10)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(center.x + ox, center.y + oy, rx * 1.1, ry * 1.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Draw a single transformed command onto the canvas.
 *
 * All coordinates are normalized; this function converts them to canvas pixels
 * using the cell position, grid size, and transform.
 *
 * @param {function|null} getTextureImage - (textureId) => HTMLImageElement|null
 */
function drawCommand(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  cmd: PropCommand,
  row: number,
  col: number,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  getTextureImage: ((id: string) => HTMLImageElement | null) | null,
) {
  const s = scaleFactor(transform);
  // transform.lineWidth lets callers (e.g. thumbnail renderer) override the
  // computed stroke width so lines don't appear fat at large thumbnail scales.
  const strokeWidth = transform.lineWidth ?? 2 * s;

  ctx.save();

  switch (cmd.type) {
    case 'rect': {
      if (cmd.rotate != null && cmd.rotate !== 0) {
        // Rotated rect: translate to center, rotate, draw centered
        const cx = cmd.x! + cmd.w! / 2;
        const cy = cmd.y! + cmd.h! / 2;
        const center = propToCanvas(cx, cy, row, col, gridSize, transform);
        const halfW = (cmd.w! / 2) * gridSize * transform.scale;
        const halfH = (cmd.h! / 2) * gridSize * transform.scale;

        ctx.save();
        ctx.translate(center.x, center.y);
        ctx.rotate((cmd.rotate * Math.PI) / 180);

        if (cmd.style === 'texfill') {
          drawTexFillRect(ctx, cmd, -halfW, -halfH, halfW * 2, halfH * 2, getTextureImage);
        } else if (isGradient(cmd)) {
          ctx.fillStyle = createGradient(ctx, cmd, 0, 0, halfW, halfH);
          ctx.fillRect(-halfW, -halfH, halfW * 2, halfH * 2);
        } else {
          applyStyle(ctx, cmd, theme);
          if (cmd.style === 'stroke') {
            ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
            ctx.strokeRect(-halfW, -halfH, halfW * 2, halfH * 2);
          } else {
            ctx.fillRect(-halfW, -halfH, halfW * 2, halfH * 2);
          }
        }
        ctx.restore();
        break;
      }

      const topLeft = propToCanvas(cmd.x!, cmd.y!, row, col, gridSize, transform);
      const bottomRight = propToCanvas(cmd.x! + cmd.w!, cmd.y! + cmd.h!, row, col, gridSize, transform);
      const w = bottomRight.x - topLeft.x;
      const h = bottomRight.y - topLeft.y;

      if (cmd.style === 'texfill') {
        drawTexFillRect(ctx, cmd, topLeft.x, topLeft.y, w, h, getTextureImage);
      } else if (isGradient(cmd)) {
        ctx.fillStyle = createGradient(ctx, cmd, topLeft.x + w / 2, topLeft.y + h / 2, w / 2, h / 2);
        ctx.fillRect(topLeft.x, topLeft.y, w, h);
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
          ctx.strokeRect(topLeft.x, topLeft.y, w, h);
        } else {
          ctx.fillRect(topLeft.x, topLeft.y, w, h);
        }
      }
      break;
    }

    case 'circle': {
      const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
      // Radius in canvas pixels: r normalized cells * gridSize feet * scale
      const rPx = cmd.r! * gridSize * transform.scale;

      ctx.beginPath();
      ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
      ctx.closePath();

      if (cmd.style === 'texfill') {
        drawTexFillPath(
          ctx,
          cmd,
          {
            x: center.x - rPx,
            y: center.y - rPx,
            w: rPx * 2,
            h: rPx * 2,
          },
          getTextureImage,
        );
      } else if (isGradient(cmd)) {
        ctx.fillStyle = createGradient(ctx, cmd, center.x, center.y, rPx, rPx);
        ctx.fill();
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
      break;
    }

    case 'ellipse': {
      const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
      const rxPx = cmd.rx! * gridSize * transform.scale;
      const ryPx = cmd.ry! * gridSize * transform.scale;

      // Build ellipse path
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.scale(rxPx, ryPx);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.restore();

      if (cmd.style === 'texfill') {
        drawTexFillPath(
          ctx,
          cmd,
          {
            x: center.x - rxPx,
            y: center.y - ryPx,
            w: rxPx * 2,
            h: ryPx * 2,
          },
          getTextureImage,
        );
      } else if (isGradient(cmd)) {
        ctx.fillStyle = createGradient(ctx, cmd, center.x, center.y, rxPx, ryPx);
        ctx.fill();
      } else {
        applyStyle(ctx, cmd, theme);
        // Fill/stroke after restoring the transform so line width isn't scaled
        if (cmd.style === 'stroke') {
          ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
      break;
    }

    case 'line': {
      const p1 = propToCanvas(cmd.x1!, cmd.y1!, row, col, gridSize, transform);
      const p2 = propToCanvas(cmd.x2!, cmd.y2!, row, col, gridSize, transform);

      const prevAlpha = ctx.globalAlpha;
      if (cmd.opacity != null) ctx.globalAlpha = cmd.opacity;
      ctx.strokeStyle = cmd.color ?? '#000000';
      ctx.lineWidth = cmd.width != null ? cmd.width * s : cmd.lineWidth != null ? cmd.lineWidth * s : strokeWidth;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.globalAlpha = prevAlpha;
      break;
    }

    case 'poly': {
      if (!cmd.points || cmd.points.length < 2) break;

      const canvasPoints = cmd.points.map(([px, py]: number[]) =>
        propToCanvas(px!, py!, row, col, gridSize, transform),
      );

      ctx.beginPath();
      ctx.moveTo(canvasPoints[0]!.x, canvasPoints[0]!.y);
      for (let i = 1; i < canvasPoints.length; i++) {
        ctx.lineTo(canvasPoints[i]!.x, canvasPoints[i]!.y);
      }
      ctx.closePath();

      if (cmd.style === 'texfill') {
        // Compute bounding box of polygon
        const xs = canvasPoints.map((p: { x: number; y: number }) => p.x);
        const ys = canvasPoints.map((p: { x: number; y: number }) => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        drawTexFillPath(
          ctx,
          cmd,
          {
            x: minX,
            y: minY,
            w: Math.max(...xs) - minX,
            h: Math.max(...ys) - minY,
          },
          getTextureImage,
        );
      } else if (isGradient(cmd)) {
        const xs = canvasPoints.map((p: { x: number; y: number }) => p.x);
        const ys = canvasPoints.map((p: { x: number; y: number }) => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        ctx.fillStyle = createGradient(
          ctx,
          cmd,
          (minX + maxX) / 2,
          (minY + maxY) / 2,
          (maxX - minX) / 2,
          (maxY - minY) / 2,
        );
        ctx.fill();
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
      break;
    }

    case 'arc': {
      const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
      const rPx = cmd.r! * gridSize * transform.scale;
      const startRad = (cmd.startDeg! * Math.PI) / 180;
      const endRad = (cmd.endDeg! * Math.PI) / 180;

      if (cmd.style === 'stroke') {
        // Stroke: just the arc curve, no center lines
        ctx.beginPath();
        ctx.arc(center.x, center.y, rPx, startRad, endRad);
        applyStyle(ctx, cmd, theme);
        ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
        ctx.stroke();
      } else {
        // Fill/texfill/gradient: wedge/pie slice path
        ctx.beginPath();
        ctx.moveTo(center.x, center.y);
        ctx.arc(center.x, center.y, rPx, startRad, endRad);
        ctx.lineTo(center.x, center.y);
        ctx.closePath();

        if (cmd.style === 'texfill') {
          drawTexFillPath(
            ctx,
            cmd,
            {
              x: center.x - rPx,
              y: center.y - rPx,
              w: rPx * 2,
              h: rPx * 2,
            },
            getTextureImage,
          );
        } else if (isGradient(cmd)) {
          ctx.fillStyle = createGradient(ctx, cmd, center.x, center.y, rPx, rPx);
          ctx.fill();
        } else {
          applyStyle(ctx, cmd, theme);
          ctx.fill();
        }
      }
      break;
    }

    case 'cutout': {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,1)';

      switch (cmd.subShape) {
        case 'circle': {
          const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
          const rPx = cmd.r! * gridSize * transform.scale;
          ctx.beginPath();
          ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'rect': {
          const topLeft = propToCanvas(cmd.x!, cmd.y!, row, col, gridSize, transform);
          const bottomRight = propToCanvas(cmd.x! + cmd.w!, cmd.y! + cmd.h!, row, col, gridSize, transform);
          ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
          break;
        }
        case 'ellipse': {
          const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
          const rxPx = cmd.rx! * gridSize * transform.scale;
          const ryPx = cmd.ry! * gridSize * transform.scale;
          ctx.save();
          ctx.translate(center.x, center.y);
          ctx.scale(rxPx, ryPx);
          ctx.beginPath();
          ctx.arc(0, 0, 1, 0, Math.PI * 2);
          ctx.restore();
          ctx.fill();
          break;
        }
        case undefined:
        default:
          break;
      }
      break;
    }

    case 'ring': {
      const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
      const outerPx = cmd.outerR! * gridSize * transform.scale;
      const innerPx = cmd.innerR! * gridSize * transform.scale;

      ctx.beginPath();
      ctx.arc(center.x, center.y, outerPx, 0, Math.PI * 2);
      ctx.arc(center.x, center.y, innerPx, 0, Math.PI * 2, true);

      if (cmd.style === 'texfill') {
        const img = getTextureImage?.(cmd.textureId!);
        const alpha = cmd.opacity ?? 0.9;
        if (img && img.complete && img.naturalWidth) {
          ctx.save();
          ctx.clip('evenodd');
          ctx.globalAlpha = alpha;
          ctx.drawImage(
            img,
            0,
            0,
            img.naturalWidth,
            img.naturalHeight,
            center.x - outerPx,
            center.y - outerPx,
            outerPx * 2,
            outerPx * 2,
          );
          ctx.restore();
        } else {
          ctx.fillStyle = `rgba(128, 128, 128, ${alpha})`;
          ctx.fill('evenodd');
        }
      } else if (isGradient(cmd)) {
        ctx.fillStyle = createGradient(ctx, cmd, center.x, center.y, outerPx, outerPx);
        ctx.fill('evenodd');
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill('evenodd');
        }
      }
      break;
    }

    case 'bezier': {
      const p1 = propToCanvas(cmd.x1!, cmd.y1!, row, col, gridSize, transform);
      const cp1 = propToCanvas(cmd.cp1x!, cmd.cp1y!, row, col, gridSize, transform);
      const cp2 = propToCanvas(cmd.cp2x!, cmd.cp2y!, row, col, gridSize, transform);
      const p2 = propToCanvas(cmd.x2!, cmd.y2!, row, col, gridSize, transform);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
      if (cmd.style === 'fill' || cmd.style === 'texfill') {
        ctx.closePath();
        if (cmd.style === 'texfill') {
          const xs = [p1.x, cp1.x, cp2.x, p2.x];
          const ys = [p1.y, cp1.y, cp2.y, p2.y];
          const minX = Math.min(...xs),
            minY = Math.min(...ys);
          drawTexFillPath(
            ctx,
            cmd,
            { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY },
            getTextureImage,
          );
        } else {
          applyStyle(ctx, cmd, theme);
          ctx.fill();
        }
      } else {
        applyStyle(ctx, cmd, theme);
        ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
        ctx.stroke();
      }
      break;
    }

    case 'qbezier': {
      const p1 = propToCanvas(cmd.x1!, cmd.y1!, row, col, gridSize, transform);
      const cp = propToCanvas(cmd.cpx!, cmd.cpy!, row, col, gridSize, transform);
      const p2 = propToCanvas(cmd.x2!, cmd.y2!, row, col, gridSize, transform);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.quadraticCurveTo(cp.x, cp.y, p2.x, p2.y);
      if (cmd.style === 'fill' || cmd.style === 'texfill') {
        ctx.closePath();
        if (cmd.style === 'texfill') {
          const xs = [p1.x, cp.x, p2.x];
          const ys = [p1.y, cp.y, p2.y];
          const minX = Math.min(...xs),
            minY = Math.min(...ys);
          drawTexFillPath(
            ctx,
            cmd,
            { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY },
            getTextureImage,
          );
        } else {
          applyStyle(ctx, cmd, theme);
          ctx.fill();
        }
      } else {
        applyStyle(ctx, cmd, theme);
        ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
        ctx.stroke();
      }
      break;
    }

    case 'ering': {
      const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
      const outerRxPx = cmd.outerRx! * gridSize * transform.scale;
      const outerRyPx = cmd.outerRy! * gridSize * transform.scale;
      const innerRxPx = cmd.innerRx! * gridSize * transform.scale;
      const innerRyPx = cmd.innerRy! * gridSize * transform.scale;
      ctx.beginPath();
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.scale(outerRxPx, outerRyPx);
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.restore();
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.scale(innerRxPx, innerRyPx);
      ctx.arc(0, 0, 1, 0, Math.PI * 2, true);
      ctx.restore();
      if (cmd.style === 'texfill') {
        const img = getTextureImage?.(cmd.textureId!);
        const alpha = cmd.opacity ?? 0.9;
        if (img && img.complete && img.naturalWidth) {
          ctx.save();
          ctx.clip('evenodd');
          ctx.globalAlpha = alpha;
          ctx.drawImage(
            img,
            0,
            0,
            img.naturalWidth,
            img.naturalHeight,
            center.x - outerRxPx,
            center.y - outerRyPx,
            outerRxPx * 2,
            outerRyPx * 2,
          );
          ctx.restore();
        } else {
          ctx.fillStyle = `rgba(128, 128, 128, ${alpha})`;
          ctx.fill('evenodd');
        }
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = cmd.width != null ? cmd.width * s : strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill('evenodd');
        }
      }
      break;
    }

    case 'clip-begin': {
      ctx.save();
      ctx.beginPath();
      switch (cmd.subShape) {
        case 'circle': {
          const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
          const rPx = cmd.r! * gridSize * transform.scale;
          ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
          break;
        }
        case 'rect': {
          const topLeft = propToCanvas(cmd.x!, cmd.y!, row, col, gridSize, transform);
          const bottomRight = propToCanvas(cmd.x! + cmd.w!, cmd.y! + cmd.h!, row, col, gridSize, transform);
          ctx.rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
          break;
        }
        case 'ellipse': {
          const center = propToCanvas(cmd.cx!, cmd.cy!, row, col, gridSize, transform);
          const rxPx = cmd.rx! * gridSize * transform.scale;
          const ryPx = cmd.ry! * gridSize * transform.scale;
          ctx.save();
          ctx.translate(center.x, center.y);
          ctx.scale(rxPx, ryPx);
          ctx.arc(0, 0, 1, 0, Math.PI * 2);
          ctx.restore();
          break;
        }
        case undefined:
        default:
          break;
      }
      ctx.clip();
      break;
    }

    case 'clip-end': {
      ctx.restore();
      break;
    }
  }

  ctx.restore();
}

/**
 * Render a single prop onto the canvas.
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas 2D context
 * @param {object} propDef - PropDefinition from parsePropFile
 * @param {number} row - Grid row of the prop's anchor cell
 * @param {number} col - Grid column of the prop's anchor cell
 * @param {number} rotation - 0, 90, 180, or 270 degrees
 * @param {number} gridSize - Grid cell size in feet
 * @param {object} theme - Theme object (must have wallStroke)
 * @param {object} transform - { scale, offsetX, offsetY }
 * @param {boolean} [flipped=false] - Horizontal mirror
 * @param {Function|null} [getTextureImage=null] - (textureId) => HTMLImageElement|null
 * @returns {void}
 */
export function renderProp(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  propDef: PropDefinition,
  row: number,
  col: number,
  rotation: number,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  flipped: boolean = false,
  getTextureImage: ((id: string) => HTMLImageElement | null) | null = null,
): void {
  if (propDef.commands.length === 0) return;

  // Drop shadow disabled — looked bad at map scale

  // If the prop has cutout commands, we must render to an isolated canvas first.
  // destination-out on the main canvas would erase floor pixels, not just prop pixels.
  const hasCutout = propDef.commands.some((c) => c.type === 'cutout');
  if (hasCutout) {
    _renderPropIsolated(ctx, propDef, row, col, rotation, gridSize, theme, transform, flipped, getTextureImage);
    return;
  }

  for (const cmd of propDef.commands) {
    // Flip first (in native prop space), then rotate.
    const flippedCmd = flipped ? flipCommand(cmd, propDef.footprint) : cmd;
    const transformed = transformCommand(flippedCmd, rotation, propDef.footprint);
    drawCommand(ctx, transformed, row, col, gridSize, theme, transform, getTextureImage);
  }
}

/**
 * Render a prop with cutout commands to a temporary canvas, then composite back.
 * This ensures destination-out only affects the prop's own pixels.
 */
function _renderPropIsolated(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  propDef: PropDefinition,
  row: number,
  col: number,
  rotation: number,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  flipped: boolean,
  getTextureImage: ((id: string) => HTMLImageElement | null) | null,
) {
  const [fRows, fCols] = propDef.footprint;
  const isRotated90 = rotation === 90 || rotation === 270;
  const eRows = isRotated90 ? fCols : fRows;
  const eCols = isRotated90 ? fRows : fCols;
  const padding = propDef.padding || 0;

  const cellPx = gridSize * transform.scale;
  const w = Math.ceil((eCols + 2 * padding) * cellPx);
  const h = Math.ceil((eRows + 2 * padding) * cellPx);
  if (w <= 0 || h <= 0) return;

  // Compute where the prop's top-left would be on the main canvas
  const origin = propToCanvas(-padding, -padding, row, col, gridSize, transform);

  // Create isolated canvas
  let tmpCanvas: OffscreenCanvas | HTMLCanvasElement;
  let tmpCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    tmpCanvas = new OffscreenCanvas(w, h);
    tmpCtx = tmpCanvas.getContext('2d');
  } else {
    tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    tmpCtx = tmpCanvas.getContext('2d');
  }
  if (!tmpCtx) return;

  // Render into the isolated canvas with an offset transform so coords map correctly
  const isoTransform = {
    scale: transform.scale,
    offsetX: transform.offsetX - origin.x,
    offsetY: transform.offsetY - origin.y,
  };

  for (const cmd of propDef.commands) {
    const flippedCmd = flipped ? flipCommand(cmd, propDef.footprint) : cmd;
    const transformed = transformCommand(flippedCmd, rotation, propDef.footprint);
    drawCommand(tmpCtx, transformed, row, col, gridSize, theme, isoTransform, getTextureImage);
  }

  // Draw the isolated result back onto the main canvas
  ctx.drawImage(tmpCanvas, origin.x, origin.y);
}

/**
 * Render all props from the metadata overlay.
 *
 * Props are stored in metadata.props[] as overlay entries with world-feet
 * coordinates. If no overlay props exist, nothing is rendered.
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas 2D context
 * @param {Array<Array<object>>} cells - 2D grid of cell objects (unused, kept for API compat)
 * @param {number} gridSize - Grid cell size in feet
 * @param {object} theme - Theme object
 * @param {object} transform - { scale, offsetX, offsetY }
 * @param {object|null} propCatalog - { props: { [type]: PropDefinition } }
 * @param {Function|null} [getTextureImage=null] - (textureId) => HTMLImageElement|null
 * @param {number} [texturesVersion=0] - Texture load version counter
 * @param {Object|null} [visibleBounds=null] - Viewport bounds for culling
 * @param {Object|null} [metadata=null] - Dungeon metadata with props array
 * @returns {void}
 */
export function renderAllProps(
  ctx: CanvasRenderingContext2D,
  cells: CellGrid,
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  propCatalog: PropCatalog | null,
  getTextureImage: ((id: string) => HTMLImageElement | null) | null = null,
  texturesVersion: number = 0,
  visibleBounds: VisibleBounds | null = null,
  metadata: Metadata | null = null,
): void {
  if (!propCatalog?.props) return;

  // Render from metadata.props[] overlay (v2+). If no overlay props, nothing to render.
  if (metadata?.props?.length) {
    renderOverlayProps(
      ctx,
      metadata.props,
      gridSize,
      theme,
      transform,
      propCatalog,
      getTextureImage,
      texturesVersion,
      visibleBounds,
    );
  }
}

// ── Overlay Prop Rendering ───────────────────────────────────────────────────

/**
 * Render overlay props from metadata.props[], sorted by zIndex.
 * Grid-aligned props at scale 1.0 reuse the tile cache for performance.
 * Arbitrary rotation or non-1.0 scale uses canvas transforms.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} overlayProps - metadata.props[] array
 * @param {number} gridSize
 * @param {object} theme
 * @param {object} transform - { scale, offsetX, offsetY }
 * @param {object} propCatalog - { props: { [type]: PropDefinition } }
 * @param {function|null} getTextureImage
 * @param {number} texturesVersion
 * @param {Object|null} [visibleBounds=null] - { minRow, maxRow, minCol, maxCol }
 * @returns {void}
 */
export function renderOverlayProps(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  overlayProps: OverlayProp[],
  gridSize: number,
  theme: Theme,
  transform: RenderTransform,
  propCatalog: PropCatalog | null,
  getTextureImage: ((id: string) => HTMLImageElement | null) | null = null,
  texturesVersion: number = 0,
  visibleBounds: VisibleBounds | null = null,
): void {
  if (!overlayProps.length || !propCatalog?.props) return;

  const wallStroke = theme.wallStroke;

  // Purge unknown prop types from the source array so we don't spam warnings every frame.
  // Record<string, PropDefinition> lies about runtime — missing keys return undefined.
  for (let i = overlayProps.length - 1; i >= 0; i--) {
    if (!propCatalog.props[overlayProps[i]!.type]) {
      warn(`[props] Unknown overlay prop type "${overlayProps[i]!.type}" (${overlayProps[i]!.id}) — removed from map`);
      overlayProps.splice(i, 1);
    }
  }
  if (!overlayProps.length) return;

  // Sort by zIndex (stable: original order preserved for equal z)
  const sorted = [...overlayProps].sort((a, b) => a.zIndex - b.zIndex);

  for (const prop of sorted) {
    const propDef = propCatalog.props[prop.type]!;

    const rotation = prop.rotation;
    const scale = prop.scale;
    const flipped = prop.flipped;
    const r = ((rotation % 360) + 360) % 360;
    const isGridAligned = (r === 0 || r === 90 || r === 180 || r === 270) && scale === 1.0;

    // Convert world-feet position to grid row/col
    const col = prop.x / gridSize;
    const row = prop.y / gridSize;

    // Viewport culling
    if (visibleBounds) {
      const [fRows, fCols] = propDef.footprint;
      const isRotated90 = r === 90 || r === 270;
      const eRows = (isRotated90 ? fCols : fRows) * scale;
      const eCols = (isRotated90 ? fRows : fCols) * scale;
      if (row + eRows < visibleBounds.minRow || row > visibleBounds.maxRow) continue;
      if (col + eCols < visibleBounds.minCol || col > visibleBounds.maxCol) continue;
    }

    if (isGridAligned) {
      // Grid-aligned at scale 1.0 — reuse tile cache (same path as renderAllProps)
      const key = _tileCacheKey(prop.type, r, flipped, wallStroke, texturesVersion);
      let tile = _propTileCache.get(key);

      if (tile === undefined) {
        tile = _buildTile(propDef, r, flipped, gridSize, theme, getTextureImage);
        _propTileCache.set(key, tile);
      }

      if (tile) {
        const [fRows, fCols] = propDef.footprint;
        const isRotated90 = r === 90 || r === 270;
        const eRows = isRotated90 ? fCols : fRows;
        const eCols = isRotated90 ? fRows : fCols;
        const padding = propDef.padding || 0;
        const cellPx = gridSize * transform.scale;
        const { x, y } = propToCanvas(-padding, -padding, row, col, gridSize, transform);
        ctx.drawImage(tile, x, y, (eCols + 2 * padding) * cellPx, (eRows + 2 * padding) * cellPx);
      } else {
        renderProp(ctx, propDef, row, col, r, gridSize, theme, transform, flipped, getTextureImage);
      }
    } else {
      // Arbitrary rotation or non-1.0 scale — use canvas transforms
      const [fRows, fCols] = propDef.footprint;
      const centerNx = fCols / 2;
      const centerNy = fRows / 2;
      const { x: cx, y: cy } = propToCanvas(centerNx, centerNy, row, col, gridSize, transform);

      ctx.save();
      ctx.translate(cx, cy);
      // Negate angle: transformCommand (tile path) rotates CCW for positive angles,
      // but ctx.rotate rotates CW. Negate to match so both paths agree visually.
      ctx.rotate((-rotation * Math.PI) / 180);
      ctx.scale(scale, scale);

      // Render prop centered at origin
      const cellPx = gridSize * transform.scale;
      const offsetTransform = {
        scale: transform.scale,
        offsetX: -centerNx * cellPx,
        offsetY: -centerNy * cellPx,
      };
      renderProp(ctx, propDef, 0, 0, 0, gridSize, theme, offsetTransform, flipped, getTextureImage);
      ctx.restore();
    }
  }
}
