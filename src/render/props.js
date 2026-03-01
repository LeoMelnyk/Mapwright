/**
 * props.js - Core prop system module
 *
 * Handles parsing .prop text files into prop definitions,
 * rotating/transforming draw commands for different facings,
 * and rendering props onto a canvas context.
 *
 * Supports texture-filled shapes (texfill), custom hex colors,
 * drop shadows, and blocks_light metadata.
 */

import { GRID_SCALE } from './constants.js';
import { toCanvas } from './bounds.js';


// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Scale factor relative to the base GRID_SCALE.
 * Matches the pattern used in borders.js.
 */
function scaleFactor(transform) {
  return transform.scale / GRID_SCALE;
}

/**
 * Parse a hex color string (#RRGGBB or #RGB) into { r, g, b }.
 */
function parseHexColor(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a .prop text file into a PropDefinition.
 *
 * File format:
 *   name: Pillar
 *   category: Structure
 *   footprint: 1x1
 *   facing: no
 *   shadow: yes
 *   blocks_light: no
 *   ---
 *   circle 0.5,0.5 0.35 fill
 *
 * @param {string} text - Raw contents of a .prop file
 * @returns {object} PropDefinition
 */
export function parsePropFile(text) {
  const separatorIndex = text.indexOf('---');
  if (separatorIndex === -1) {
    throw new Error('Invalid .prop file: missing --- separator');
  }

  const headerText = text.substring(0, separatorIndex);
  const bodyText = text.substring(separatorIndex + 3);

  // Parse header (YAML-like key: value pairs)
  const header = {};
  for (const line of headerText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.substring(0, colonIdx).trim().toLowerCase();
    const value = trimmed.substring(colonIdx + 1).trim();
    header[key] = value;
  }

  // Extract structured fields
  const name = header.name || 'Unnamed';
  const category = header.category || 'Misc';

  // Footprint: "RxC" -> [rows, cols]
  let footprint = [1, 1];
  if (header.footprint) {
    const parts = header.footprint.toLowerCase().split('x');
    if (parts.length === 2) {
      footprint = [parseInt(parts[0], 10) || 1, parseInt(parts[1], 10) || 1];
    }
  }

  // Facing: "yes"/"true" -> true, anything else -> false
  const facing = header.facing === 'yes' || header.facing === 'true';

  // Shadow: "yes"/"true" -> true (draws soft drop shadow under prop)
  const shadow = header.shadow === 'yes' || header.shadow === 'true';

  // Blocks light: "yes"/"true" -> true (metadata for future lighting integration)
  const blocksLight = header.blocks_light === 'yes' || header.blocks_light === 'true';

  // Padding: extra cells of overflow around the footprint (default 0)
  const padding = parseFloat(header.padding) || 0;

  // Parse body (draw commands)
  const commands = [];
  for (const line of bodyText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cmd = parseCommand(trimmed);
    if (cmd) commands.push(cmd);
  }

  // Collect unique texture IDs referenced by texfill commands
  const textures = [...new Set(
    commands.filter(c => c.style === 'texfill' && c.textureId).map(c => c.textureId)
  )];

  return { name, category, footprint, facing, shadow, blocksLight, padding, commands, textures };
}

/**
 * Parse extended style tokens starting at the given index.
 *
 * Handles three style modes:
 *   texfill textureId [opacity]     — fill shape with texture image
 *   fill|stroke [#hexcolor] [opacity] — custom color fill/stroke
 *   fill|stroke [opacity]           — theme color (existing behavior)
 *
 * @returns {{ style: string, color: string|null, textureId: string|null, opacity: number|null }}
 */
function parseStyleExtended(tokens, startIndex) {
  const styleToken = tokens[startIndex];
  if (!styleToken) return { style: 'fill', color: null, textureId: null, opacity: null };

  if (styleToken === 'texfill') {
    const textureId = tokens[startIndex + 1] || null;
    const opacity = parseOpacity(tokens[startIndex + 2]);
    return { style: 'texfill', color: null, textureId, opacity };
  }

  const style = styleToken === 'stroke' ? 'stroke' : 'fill';
  const nextToken = tokens[startIndex + 1];

  if (nextToken && nextToken.startsWith('#')) {
    const color = nextToken;
    const opacity = parseOpacity(tokens[startIndex + 2]);
    return { style, color, textureId: null, opacity };
  }

  const opacity = parseOpacity(nextToken);
  return { style, color: null, textureId: null, opacity };
}

/**
 * Parse a single draw command line into a command object.
 *
 * Supported:
 *   rect x,y w,h [fill|stroke|texfill] [#color|textureId] [opacity]
 *   circle cx,cy r [fill|stroke|texfill] [#color|textureId] [opacity]
 *   ellipse cx,cy rx,ry [fill|stroke|texfill] [#color|textureId] [opacity]
 *   line x1,y1 x2,y2 [lineWidth]
 *   poly x1,y1 x2,y2 ... [fill|stroke|texfill] [#color|textureId] [opacity]
 *   arc cx,cy r startDeg endDeg [fill|stroke|texfill] [#color|textureId] [opacity]
 */
function parseCommand(line) {
  const tokens = line.split(/\s+/);
  const type = tokens[0].toLowerCase();

  switch (type) {
    case 'rect': {
      const [x, y] = parseCoord(tokens[1]);
      const [w, h] = parseCoord(tokens[2]);
      const { style, color, textureId, opacity } = parseStyleExtended(tokens, 3);
      return { type: 'rect', x, y, w, h, style, color, textureId, opacity };
    }

    case 'circle': {
      const [cx, cy] = parseCoord(tokens[1]);
      const r = parseFloat(tokens[2]);
      const { style, color, textureId, opacity } = parseStyleExtended(tokens, 3);
      return { type: 'circle', cx, cy, r, style, color, textureId, opacity };
    }

    case 'ellipse': {
      const [cx, cy] = parseCoord(tokens[1]);
      const [rx, ry] = parseCoord(tokens[2]);
      const { style, color, textureId, opacity } = parseStyleExtended(tokens, 3);
      return { type: 'ellipse', cx, cy, rx, ry, style, color, textureId, opacity };
    }

    case 'line': {
      // line x1,y1 x2,y2 [lineWidth]
      const [x1, y1] = parseCoord(tokens[1]);
      const [x2, y2] = parseCoord(tokens[2]);
      const lineWidth = tokens[3] ? parseFloat(tokens[3]) : null;
      return { type: 'line', x1, y1, x2, y2, lineWidth };
    }

    case 'poly': {
      // poly x1,y1 x2,y2 x3,y3 ... [fill|stroke|texfill] [#color|textureId] [opacity]
      const points = [];
      let ext = { style: 'fill', color: null, textureId: null, opacity: null };
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === 'fill' || tokens[i] === 'stroke' || tokens[i] === 'texfill') {
          ext = parseStyleExtended(tokens, i);
          break;
        }
        const coord = parseCoord(tokens[i]);
        if (coord) points.push(coord);
      }
      return { type: 'poly', points, ...ext };
    }

    case 'arc': {
      const [cx, cy] = parseCoord(tokens[1]);
      const r = parseFloat(tokens[2]);
      const startDeg = parseFloat(tokens[3]);
      const endDeg = parseFloat(tokens[4]);
      const { style, color, textureId, opacity } = parseStyleExtended(tokens, 5);
      return { type: 'arc', cx, cy, r, startDeg, endDeg, style, color, textureId, opacity };
    }

    default:
      return null;
  }
}

/** Parse "x,y" into [x, y]. */
function parseCoord(token) {
  if (!token) return [0, 0];
  const parts = token.split(',');
  return [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0];
}

/** Parse optional opacity value. Returns null if not present. */
function parseOpacity(token) {
  if (token === undefined || token === null) return null;
  const v = parseFloat(token);
  return isNaN(v) ? null : v;
}

// ── Coordinate Transformation ───────────────────────────────────────────────

/**
 * Rotate a point (x, y) around the footprint center by the given rotation.
 *
 * Footprint center for [rows, cols] is (cols/2, rows/2) in normalized space.
 * Props are authored facing north (rotation = 0).
 *
 * @param {number} x - Normalized x coordinate
 * @param {number} y - Normalized y coordinate
 * @param {number} rotation - 0, 90, 180, or 270 degrees
 * @param {[number, number]} footprint - [rows, cols]
 * @returns {[number, number]} Rotated [x, y]
 */
function rotatePoint(x, y, rotation, footprint) {
  const [rows, cols] = footprint;
  const cx = cols / 2;
  const cy = rows / 2;

  // After rotating a non-square footprint, the bounding box of the rotated
  // coordinates is shifted away from the (0,0) origin. Apply a translation
  // to re-anchor the minimum corner to (0,0) for the new footprint.
  // For 90° and 270°, the shift is (rows-cols)/2 in x and (cols-rows)/2 in y.
  const dx = (rows - cols) / 2;
  const dy = (cols - rows) / 2;

  switch (rotation) {
    case 90:
      return [cx + (y - cy) + dx, cy - (x - cx) + dy];
    case 180:
      return [2 * cx - x, 2 * cy - y];
    case 270:
      return [cx - (y - cy) + dx, cy + (x - cx) + dy];
    default: // 0
      return [x, y];
  }
}

/**
 * Flip a single draw command horizontally (mirror across the vertical axis).
 *
 * For a point (x, y) with footprint [rows, cols]: x' = cols - x, y' = y.
 *
 * @param {object} cmd - Parsed command object
 * @param {[number, number]} footprint - [rows, cols]
 * @returns {object} New command with mirrored coordinates
 */
function flipCommand(cmd, footprint) {
  const cols = footprint[1];

  switch (cmd.type) {
    case 'rect':
      return { ...cmd, x: cols - cmd.x - cmd.w };

    case 'circle':
      return { ...cmd, cx: cols - cmd.cx };

    case 'ellipse':
      return { ...cmd, cx: cols - cmd.cx };

    case 'line':
      return { ...cmd, x1: cols - cmd.x1, x2: cols - cmd.x2 };

    case 'poly':
      return { ...cmd, points: cmd.points.map(([px, py]) => [cols - px, py]) };

    case 'arc':
      // Reflecting angles over the vertical axis: θ → 180° - θ
      // Swap start/end to preserve clockwise winding.
      return {
        ...cmd,
        cx: cols - cmd.cx,
        startDeg: 180 - cmd.endDeg,
        endDeg: 180 - cmd.startDeg,
      };

    default:
      return cmd;
  }
}

/**
 * Transform a single draw command's coordinates for the given rotation.
 *
 * Returns a new command object with transformed coordinates.
 * For 90/270 rotations:
 *   - ellipse rx/ry are swapped
 *   - arc start/end degrees are adjusted
 *
 * @param {object} cmd - Parsed command object
 * @param {number} rotation - 0, 90, 180, or 270
 * @param {[number, number]} footprint - [rows, cols]
 * @returns {object} New command with transformed coordinates
 */
function transformCommand(cmd, rotation, footprint) {
  if (rotation === 0) return cmd;

  switch (cmd.type) {
    case 'rect': {
      // Rotate all four corners and compute the new bounding box
      const corners = [
        [cmd.x, cmd.y],
        [cmd.x + cmd.w, cmd.y],
        [cmd.x + cmd.w, cmd.y + cmd.h],
        [cmd.x, cmd.y + cmd.h],
      ];
      const rotated = corners.map(([px, py]) => rotatePoint(px, py, rotation, footprint));
      const xs = rotated.map(p => p[0]);
      const ys = rotated.map(p => p[1]);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      return { ...cmd, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    case 'circle': {
      const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
      return { ...cmd, cx: ncx, cy: ncy };
    }

    case 'ellipse': {
      const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
      // Swap rx/ry for 90 and 270 rotations
      const swapRadii = rotation === 90 || rotation === 270;
      return {
        ...cmd,
        cx: ncx,
        cy: ncy,
        rx: swapRadii ? cmd.ry : cmd.rx,
        ry: swapRadii ? cmd.rx : cmd.ry,
      };
    }

    case 'line': {
      const [nx1, ny1] = rotatePoint(cmd.x1, cmd.y1, rotation, footprint);
      const [nx2, ny2] = rotatePoint(cmd.x2, cmd.y2, rotation, footprint);
      return { ...cmd, x1: nx1, y1: ny1, x2: nx2, y2: ny2 };
    }

    case 'poly': {
      const newPoints = cmd.points.map(([px, py]) => rotatePoint(px, py, rotation, footprint));
      return { ...cmd, points: newPoints };
    }

    case 'arc': {
      const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
      return {
        ...cmd,
        cx: ncx,
        cy: ncy,
        startDeg: cmd.startDeg + rotation,
        endDeg: cmd.endDeg + rotation,
      };
    }

    default:
      return cmd;
  }
}

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
export function invalidatePropsCache() {
  _propTileCache.clear();
}

// Scale is not part of the key — tiles are rendered once at TILE_BASE_PX per cell
// and scaled to the current display size via drawImage(tile, x, y, w, h).
// Props are deterministic vector shapes; browser bilinear scaling is sufficient.
function _tileCacheKey(type, facing, flipped, wallStroke, texturesVersion) {
  return `${type}|${facing}|${flipped ? 1 : 0}|${wallStroke}|${texturesVersion}`;
}

// Fixed tile resolution: pixels per grid cell. High enough to stay sharp at max zoom.
const TILE_BASE_PX = 128;

/**
 * Render a prop to an OffscreenCanvas tile at a fixed base resolution.
 * Returns null if OffscreenCanvas is unavailable (Node.js / PDF renderer).
 */
function _buildTile(propDef, rotation, flipped, gridSize, theme, getTextureImage) {
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
function propToCanvas(nx, ny, row, col, gridSize, transform) {
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
function applyStyle(ctx, cmd, theme) {
  const color = cmd.color || theme.wallStroke || '#000000';

  if (cmd.style === 'stroke') {
    ctx.strokeStyle = color;
  } else {
    // Fill: parse hex and apply as rgba with opacity
    const { r, g, b } = parseHexColor(color);
    const alpha = cmd.opacity !== null && cmd.opacity !== undefined ? cmd.opacity : 0.15;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

/**
 * Fill a rectangular canvas region with a texture image.
 * Falls back to solid grey fill if the texture is not available.
 */
function drawTexFillRect(ctx, cmd, x, y, w, h, getTextureImage) {
  const img = getTextureImage?.(cmd.textureId);
  const alpha = cmd.opacity ?? 0.9;

  if (!img || !img.complete || !img.naturalWidth) {
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
function drawTexFillPath(ctx, cmd, bbox, getTextureImage) {
  const img = getTextureImage?.(cmd.textureId);
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
function drawPropShadow(ctx, propDef, row, col, rotation, gridSize, transform) {
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
  const grad = ctx.createRadialGradient(
    center.x + ox, center.y + oy, 0,
    center.x + ox, center.y + oy, blurRadius
  );
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
function drawCommand(ctx, cmd, row, col, gridSize, theme, transform, getTextureImage) {
  const s = scaleFactor(transform);
  // transform.lineWidth lets callers (e.g. thumbnail renderer) override the
  // computed stroke width so lines don't appear fat at large thumbnail scales.
  const strokeWidth = transform.lineWidth ?? (2 * s);

  ctx.save();

  switch (cmd.type) {
    case 'rect': {
      const topLeft = propToCanvas(cmd.x, cmd.y, row, col, gridSize, transform);
      const bottomRight = propToCanvas(cmd.x + cmd.w, cmd.y + cmd.h, row, col, gridSize, transform);
      const w = bottomRight.x - topLeft.x;
      const h = bottomRight.y - topLeft.y;

      if (cmd.style === 'texfill') {
        drawTexFillRect(ctx, cmd, topLeft.x, topLeft.y, w, h, getTextureImage);
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = strokeWidth;
          ctx.strokeRect(topLeft.x, topLeft.y, w, h);
        } else {
          ctx.fillRect(topLeft.x, topLeft.y, w, h);
        }
      }
      break;
    }

    case 'circle': {
      const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
      // Radius in canvas pixels: r normalized cells * gridSize feet * scale
      const rPx = cmd.r * gridSize * transform.scale;

      ctx.beginPath();
      ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
      ctx.closePath();

      if (cmd.style === 'texfill') {
        drawTexFillPath(ctx, cmd, {
          x: center.x - rPx, y: center.y - rPx, w: rPx * 2, h: rPx * 2
        }, getTextureImage);
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
      break;
    }

    case 'ellipse': {
      const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
      const rxPx = cmd.rx * gridSize * transform.scale;
      const ryPx = cmd.ry * gridSize * transform.scale;

      // Build ellipse path
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.scale(rxPx, ryPx);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.restore();

      if (cmd.style === 'texfill') {
        drawTexFillPath(ctx, cmd, {
          x: center.x - rxPx, y: center.y - ryPx, w: rxPx * 2, h: ryPx * 2
        }, getTextureImage);
      } else {
        applyStyle(ctx, cmd, theme);
        // Fill/stroke after restoring the transform so line width isn't scaled
        if (cmd.style === 'stroke') {
          ctx.lineWidth = strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
      break;
    }

    case 'line': {
      const p1 = propToCanvas(cmd.x1, cmd.y1, row, col, gridSize, transform);
      const p2 = propToCanvas(cmd.x2, cmd.y2, row, col, gridSize, transform);

      ctx.strokeStyle = cmd.color || theme.wallStroke || '#000000';
      ctx.lineWidth = cmd.lineWidth !== null ? cmd.lineWidth * s : strokeWidth;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      break;
    }

    case 'poly': {
      if (cmd.points.length < 2) break;

      const canvasPoints = cmd.points.map(([px, py]) =>
        propToCanvas(px, py, row, col, gridSize, transform)
      );

      ctx.beginPath();
      ctx.moveTo(canvasPoints[0].x, canvasPoints[0].y);
      for (let i = 1; i < canvasPoints.length; i++) {
        ctx.lineTo(canvasPoints[i].x, canvasPoints[i].y);
      }
      ctx.closePath();

      if (cmd.style === 'texfill') {
        // Compute bounding box of polygon
        const xs = canvasPoints.map(p => p.x);
        const ys = canvasPoints.map(p => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        drawTexFillPath(ctx, cmd, {
          x: minX, y: minY,
          w: Math.max(...xs) - minX,
          h: Math.max(...ys) - minY
        }, getTextureImage);
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
      break;
    }

    case 'arc': {
      const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
      const rPx = cmd.r * gridSize * transform.scale;
      const startRad = (cmd.startDeg * Math.PI) / 180;
      const endRad = (cmd.endDeg * Math.PI) / 180;

      ctx.beginPath();
      ctx.arc(center.x, center.y, rPx, startRad, endRad);

      if (cmd.style === 'texfill') {
        ctx.closePath();
        drawTexFillPath(ctx, cmd, {
          x: center.x - rPx, y: center.y - rPx, w: rPx * 2, h: rPx * 2
        }, getTextureImage);
      } else {
        applyStyle(ctx, cmd, theme);
        if (cmd.style === 'stroke') {
          ctx.lineWidth = strokeWidth;
          ctx.stroke();
        } else {
          ctx.fill();
        }
      }
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
 * @param {boolean} flipped - Horizontal mirror
 * @param {function|null} getTextureImage - (textureId) => HTMLImageElement|null
 */
export function renderProp(ctx, propDef, row, col, rotation, gridSize, theme, transform, flipped = false, getTextureImage = null) {
  if (!propDef || !propDef.commands || propDef.commands.length === 0) return;

  // Draw drop shadow before prop commands
  if (propDef.shadow) {
    drawPropShadow(ctx, propDef, row, col, rotation, gridSize, transform);
  }

  for (const cmd of propDef.commands) {
    // Flip first (in native prop space), then rotate.
    const flippedCmd = flipped ? flipCommand(cmd, propDef.footprint) : cmd;
    const transformed = transformCommand(flippedCmd, rotation, propDef.footprint);
    drawCommand(ctx, transformed, row, col, gridSize, theme, transform, getTextureImage);
  }
}

/**
 * Render all props found in the cell matrix.
 *
 * Iterates every cell; if cell.prop exists, looks up its definition in
 * propCatalog and renders it.
 *
 * cell.prop = { type: string, span: [rows, cols], facing: 0|90|180|270 }
 *
 * @param {CanvasRenderingContext2D} ctx - Canvas 2D context
 * @param {Array<Array<object>>} cells - 2D grid of cell objects
 * @param {number} gridSize - Grid cell size in feet
 * @param {object} theme - Theme object
 * @param {object} transform - { scale, offsetX, offsetY }
 * @param {object|null} propCatalog - { props: { [type]: PropDefinition } }
 * @param {function|null} getTextureImage - (textureId) => HTMLImageElement|null
 */
export function renderAllProps(ctx, cells, gridSize, theme, transform, propCatalog, getTextureImage = null, texturesVersion = 0) {
  if (!propCatalog || !propCatalog.props) return;

  const wallStroke = theme?.wallStroke || '';
  const numRows = cells.length;

  for (let row = 0; row < numRows; row++) {
    const rowCells = cells[row];
    if (!rowCells) continue;
    const numCols = rowCells.length;

    for (let col = 0; col < numCols; col++) {
      const cell = rowCells[col];
      if (!cell || !cell.prop) continue;

      const { type, facing, flipped } = cell.prop;
      const rotation = facing || 0;

      const propDef = propCatalog.props[type];
      if (!propDef) continue;

      const key = _tileCacheKey(type, rotation, flipped || false, wallStroke, texturesVersion);
      let tile = _propTileCache.get(key);

      if (tile === undefined) {
        // Cache miss: build tile (returns null if OffscreenCanvas unavailable)
        tile = _buildTile(propDef, rotation, flipped || false, gridSize, theme, getTextureImage);
        _propTileCache.set(key, tile);
      }

      if (tile) {
        const [fRows, fCols] = propDef.footprint;
        const isRotated90 = rotation === 90 || rotation === 270;
        const eRows = isRotated90 ? fCols : fRows;
        const eCols = isRotated90 ? fRows : fCols;
        const padding = propDef.padding || 0;
        const cellPx = gridSize * transform.scale;
        const { x, y } = propToCanvas(-padding, -padding, row, col, gridSize, transform);
        ctx.drawImage(tile, x, y, (eCols + 2 * padding) * cellPx, (eRows + 2 * padding) * cellPx);
      } else {
        // Fallback: direct render (Node.js / PDF renderer without OffscreenCanvas)
        renderProp(ctx, propDef, row, col, rotation, gridSize, theme, transform, flipped || false, getTextureImage);
      }
    }
  }
}

// ── Lighting Geometry Extraction ─────────────────────────────────────────────

const CIRCLE_SIDES = 12;

/**
 * Convert a normalized prop coordinate to world-feet coordinates.
 */
function toWorldFeet(nx, ny, row, col, gridSize) {
  return { x: (col + nx) * gridSize, y: (row + ny) * gridSize };
}

/**
 * Generate polygon vertices for a circle, returned as [{x, y}, ...].
 */
function circleToPolygon(cx, cy, r, sides = CIRCLE_SIDES) {
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
function ellipseToPolygon(cx, cy, rx, ry, sides = CIRCLE_SIDES) {
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
function polygonToSegments(points) {
  const segs = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
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
export function extractPropLightSegments(propDef, row, col, rotation, flipped, gridSize) {
  if (!propDef?.commands) return [];

  const segments = [];

  for (const cmd of propDef.commands) {
    // Skip lines — too thin to block light
    if (cmd.type === 'line') continue;

    // Apply same transform order as renderProp: flip first, then rotate
    const flippedCmd = flipped ? flipCommand(cmd, propDef.footprint) : cmd;
    const tc = transformCommand(flippedCmd, rotation, propDef.footprint);

    switch (tc.type) {
      case 'rect': {
        const tl = toWorldFeet(tc.x, tc.y, row, col, gridSize);
        const tr = toWorldFeet(tc.x + tc.w, tc.y, row, col, gridSize);
        const br = toWorldFeet(tc.x + tc.w, tc.y + tc.h, row, col, gridSize);
        const bl = toWorldFeet(tc.x, tc.y + tc.h, row, col, gridSize);
        segments.push(
          { x1: tl.x, y1: tl.y, x2: tr.x, y2: tr.y },
          { x1: tr.x, y1: tr.y, x2: br.x, y2: br.y },
          { x1: br.x, y1: br.y, x2: bl.x, y2: bl.y },
          { x1: bl.x, y1: bl.y, x2: tl.x, y2: tl.y },
        );
        break;
      }

      case 'circle': {
        const pts = circleToPolygon(tc.cx, tc.cy, tc.r);
        const worldPts = pts.map(p => toWorldFeet(p.x, p.y, row, col, gridSize));
        segments.push(...polygonToSegments(worldPts));
        break;
      }

      case 'ellipse': {
        const pts = ellipseToPolygon(tc.cx, tc.cy, tc.rx, tc.ry);
        const worldPts = pts.map(p => toWorldFeet(p.x, p.y, row, col, gridSize));
        segments.push(...polygonToSegments(worldPts));
        break;
      }

      case 'poly': {
        if (tc.points.length < 2) break;
        const worldPts = tc.points.map(([px, py]) => toWorldFeet(px, py, row, col, gridSize));
        segments.push(...polygonToSegments(worldPts));
        break;
      }

      case 'arc': {
        const startRad = (tc.startDeg * Math.PI) / 180;
        const endRad = (tc.endDeg * Math.PI) / 180;
        const ARC_SUBDIVISIONS = 8;
        const pts = [];
        for (let i = 0; i <= ARC_SUBDIVISIONS; i++) {
          const t = i / ARC_SUBDIVISIONS;
          const angle = startRad + t * (endRad - startRad);
          const p = toWorldFeet(
            tc.cx + tc.r * Math.cos(angle),
            tc.cy + tc.r * Math.sin(angle),
            row, col, gridSize
          );
          pts.push(p);
        }
        // Arc segments (open chain, not closed loop)
        for (let i = 0; i < pts.length - 1; i++) {
          segments.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
        }
        break;
      }
    }
  }

  return segments;
}
