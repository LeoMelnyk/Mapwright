/**
 * props.js - Core prop system module
 *
 * Handles parsing .prop text files into prop definitions,
 * rotating/transforming draw commands for different facings,
 * and rendering props onto a canvas context.
 *
 * Supports texture-filled shapes (texfill), gradient fills
 * (gradient-radial, gradient-linear), custom hex colors,
 * drop shadows, and blocks_light metadata.
 */

import { GRID_SCALE } from './constants.js';
import { toCanvas } from './bounds.js';
import { warn } from './warnings.js';


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

/**
 * Scan tokens for a keyword followed by a numeric value.
 * Returns the parsed float value, or null if the keyword is not found.
 */
function scanKeyword(tokens, keyword) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === keyword && tokens[i + 1] != null) {
      return parseFloat(tokens[i + 1]);
    }
  }
  return null;
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

  // Height: prop height in feet for z-height shadow projection (default null = infinite)
  const height = header.height != null ? parseFloat(header.height) : null;

  // Padding: extra cells of overflow around the footprint (default 0)
  const padding = parseFloat(header.padding) || 0;

  // Prop-bundled lights: inline JSON array of { preset, x, y } (normalized 0–cols, 0–rows)
  let propLights = null;
  if (header.lights) {
    try { propLights = JSON.parse(header.lights); } catch (e) { warn(`[props] Malformed lights JSON in prop "${name}": ${e.message}`); }
  }

  // Parse body (draw commands + hitbox/selection commands)
  const commands = [];
  const manualHitboxCmds = [];
  const manualSelectionCmds = [];
  for (const line of bodyText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cmd = parseCommand(trimmed);
    if (!cmd) continue;
    if (cmd.type === 'hitbox') {
      manualHitboxCmds.push(cmd);
    } else if (cmd.type === 'selection') {
      manualSelectionCmds.push(cmd);
    } else {
      commands.push(cmd);
    }
  }

  // Collect unique texture IDs referenced by texfill commands
  const textures = [...new Set(
    commands.filter(c => c.style === 'texfill' && c.textureId).map(c => c.textureId)
  )];

  // Placement metadata (optional fields — gracefully default to null/empty)
  const placement = header.placement || null;                  // wall, corner, center, floor, any
  const roomTypes = header.room_types
    ? header.room_types.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const typicalCount = header.typical_count || null;           // single, few, many
  const clustersWith = header.clusters_with
    ? header.clusters_with.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const notes = header.notes || null;

  return {
    name, category, footprint, facing, shadow, blocksLight, padding, height,
    commands, textures, lights: propLights,
    manualHitbox: manualHitboxCmds.length > 0 ? manualHitboxCmds : null,
    manualSelection: manualSelectionCmds.length > 0 ? manualSelectionCmds : null,
    placement, roomTypes, typicalCount, clustersWith, notes,
  };
}

/**
 * Parse extended style tokens starting at the given index.
 *
 * Handles five style modes:
 *   gradient-radial #start #end [opacity]          — radial gradient fill
 *   gradient-linear #start #end [opacity] [angle N] — linear gradient fill
 *   texfill textureId [opacity]                     — fill shape with texture image
 *   fill|stroke [#hexcolor] [opacity]               — custom color fill/stroke
 *   fill|stroke [opacity]                           — theme color (existing behavior)
 *
 * @returns {{ style: string, color: string|null, textureId: string|null, opacity: number|null, gradientEnd?: string }}
 */
function parseStyleExtended(tokens, startIndex) {
  const styleToken = tokens[startIndex];
  if (!styleToken) return { style: 'fill', color: null, textureId: null, opacity: null };

  if (styleToken === 'gradient-radial') {
    const startColor = tokens[startIndex + 1] || '#ffffff';
    const endColor = tokens[startIndex + 2] || '#000000';
    const opacity = parseOpacity(tokens[startIndex + 3]);
    return { style: 'gradient-radial', color: startColor, textureId: null, opacity, gradientEnd: endColor };
  }

  if (styleToken === 'gradient-linear') {
    const startColor = tokens[startIndex + 1] || '#ffffff';
    const endColor = tokens[startIndex + 2] || '#000000';
    const opacity = parseOpacity(tokens[startIndex + 3]);
    return { style: 'gradient-linear', color: startColor, textureId: null, opacity, gradientEnd: endColor };
  }

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
 *   rect x,y w,h [fill|stroke|texfill|gradient-radial|gradient-linear] [#color|textureId] [opacity] [width N] [rotate N] [angle N]
 *   circle cx,cy r [fill|stroke|texfill|gradient-radial|gradient-linear] [#color|textureId] [opacity] [width N] [angle N]
 *   ellipse cx,cy rx,ry [fill|stroke|texfill|gradient-radial|gradient-linear] [#color|textureId] [opacity] [width N] [angle N]
 *   line x1,y1 x2,y2 [lineWidth] [width N]
 *   poly x1,y1 x2,y2 ... [fill|stroke|texfill|gradient-radial|gradient-linear] [#color|textureId] [opacity] [width N] [angle N]
 *   arc cx,cy r startDeg endDeg [fill|stroke|texfill|gradient-radial|gradient-linear] [#color|textureId] [opacity] [width N] [angle N]
 *   cutout circle cx,cy r | cutout rect x,y w,h | cutout ellipse cx,cy rx,ry
 *   ring cx,cy outerR innerR [fill|stroke|texfill|gradient-radial|gradient-linear] [#color|textureId] [opacity] [width N] [angle N]
 */
function parseCommand(line) {
  const tokens = line.split(/\s+/);
  const type = tokens[0].toLowerCase();

  switch (type) {
    case 'rect': {
      const [x, y] = parseCoord(tokens[1]);
      const [w, h] = parseCoord(tokens[2]);
      const { style, color, textureId, opacity, gradientEnd } = parseStyleExtended(tokens, 3);
      const width = scanKeyword(tokens, 'width');
      const rotate = scanKeyword(tokens, 'rotate');
      const angle = scanKeyword(tokens, 'angle');
      return { type: 'rect', x, y, w, h, style, color, textureId, opacity, gradientEnd, width, rotate, angle };
    }

    case 'circle': {
      const [cx, cy] = parseCoord(tokens[1]);
      const r = parseFloat(tokens[2]);
      const { style, color, textureId, opacity, gradientEnd } = parseStyleExtended(tokens, 3);
      const width = scanKeyword(tokens, 'width');
      const angle = scanKeyword(tokens, 'angle');
      return { type: 'circle', cx, cy, r, style, color, textureId, opacity, gradientEnd, width, angle };
    }

    case 'ellipse': {
      const [cx, cy] = parseCoord(tokens[1]);
      const [rx, ry] = parseCoord(tokens[2]);
      const { style, color, textureId, opacity, gradientEnd } = parseStyleExtended(tokens, 3);
      const width = scanKeyword(tokens, 'width');
      const angle = scanKeyword(tokens, 'angle');
      return { type: 'ellipse', cx, cy, rx, ry, style, color, textureId, opacity, gradientEnd, width, angle };
    }

    case 'line': {
      // line x1,y1 x2,y2 [stroke [#color] [opacity]]
      // Legacy: line x1,y1 x2,y2 [lineWidth]
      const [x1, y1] = parseCoord(tokens[1]);
      const [x2, y2] = parseCoord(tokens[2]);
      let lineWidth = null;
      let color = null;
      let opacity = null;
      if (tokens[3] === 'stroke') {
        const parsed = parseStyleExtended(tokens, 3);
        color = parsed.color;
        opacity = parsed.opacity;
      } else if (tokens[3]) {
        lineWidth = parseFloat(tokens[3]);
      }
      const width = scanKeyword(tokens, 'width');
      return { type: 'line', x1, y1, x2, y2, lineWidth, color, opacity, width };
    }

    case 'poly': {
      // poly x1,y1 x2,y2 x3,y3 ... [fill|stroke|texfill] [#color|textureId] [opacity]
      const points = [];
      let ext = { style: 'fill', color: null, textureId: null, opacity: null };
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === 'fill' || tokens[i] === 'stroke' || tokens[i] === 'texfill' || tokens[i] === 'gradient-radial' || tokens[i] === 'gradient-linear') {
          ext = parseStyleExtended(tokens, i);
          break;
        }
        const coord = parseCoord(tokens[i]);
        if (coord) points.push(coord);
      }
      const polyWidth = scanKeyword(tokens, 'width');
      const polyAngle = scanKeyword(tokens, 'angle');
      return { type: 'poly', points, ...ext, width: polyWidth, angle: polyAngle };
    }

    case 'arc': {
      const [cx, cy] = parseCoord(tokens[1]);
      const r = parseFloat(tokens[2]);
      const startDeg = parseFloat(tokens[3]);
      const endDeg = parseFloat(tokens[4]);
      const { style, color, textureId, opacity, gradientEnd } = parseStyleExtended(tokens, 5);
      const width = scanKeyword(tokens, 'width');
      const angle = scanKeyword(tokens, 'angle');
      return { type: 'arc', cx, cy, r, startDeg, endDeg, style, color, textureId, opacity, gradientEnd, width, angle };
    }

    case 'cutout': {
      const subShape = tokens[1]?.toLowerCase();
      switch (subShape) {
        case 'circle': {
          const [cx, cy] = parseCoord(tokens[2]);
          const r = parseFloat(tokens[3]);
          return { type: 'cutout', subShape: 'circle', cx, cy, r };
        }
        case 'rect': {
          const [x, y] = parseCoord(tokens[2]);
          const [w, h] = parseCoord(tokens[3]);
          return { type: 'cutout', subShape: 'rect', x, y, w, h };
        }
        case 'ellipse': {
          const [cx, cy] = parseCoord(tokens[2]);
          const [rx, ry] = parseCoord(tokens[3]);
          return { type: 'cutout', subShape: 'ellipse', cx, cy, rx, ry };
        }
        default:
          return null;
      }
    }

    case 'ring': {
      const [cx, cy] = parseCoord(tokens[1]);
      const outerR = parseFloat(tokens[2]);
      const innerR = parseFloat(tokens[3]);
      const { style, color, textureId, opacity, gradientEnd } = parseStyleExtended(tokens, 4);
      const width = scanKeyword(tokens, 'width');
      const angle = scanKeyword(tokens, 'angle');
      return { type: 'ring', cx, cy, outerR, innerR, style, color, textureId, opacity, gradientEnd, width, angle };
    }

    case 'bezier': {
      const [x1, y1] = parseCoord(tokens[1]);
      const [cp1x, cp1y] = parseCoord(tokens[2]);
      const [cp2x, cp2y] = parseCoord(tokens[3]);
      const [x2, y2] = parseCoord(tokens[4]);
      const { style, color, textureId, opacity } = parseStyleExtended(tokens, 5);
      const width = scanKeyword(tokens, 'width');
      return { type: 'bezier', x1, y1, cp1x, cp1y, cp2x, cp2y, x2, y2, style, color, textureId, opacity, width };
    }

    case 'qbezier': {
      const [x1, y1] = parseCoord(tokens[1]);
      const [cpx, cpy] = parseCoord(tokens[2]);
      const [x2, y2] = parseCoord(tokens[3]);
      const { style, color, textureId, opacity } = parseStyleExtended(tokens, 4);
      const width = scanKeyword(tokens, 'width');
      return { type: 'qbezier', x1, y1, cpx, cpy, x2, y2, style, color, textureId, opacity, width };
    }

    case 'ering': {
      const [cx, cy] = parseCoord(tokens[1]);
      const [outerRx, outerRy] = parseCoord(tokens[2]);
      const [innerRx, innerRy] = parseCoord(tokens[3]);
      const { style, color, textureId, opacity } = parseStyleExtended(tokens, 4);
      const width = scanKeyword(tokens, 'width');
      return { type: 'ering', cx, cy, outerRx, outerRy, innerRx, innerRy, style, color, textureId, opacity, width };
    }

    case 'clip-begin': {
      const subShape = tokens[1]?.toLowerCase();
      switch (subShape) {
        case 'circle': {
          const [cx, cy] = parseCoord(tokens[2]);
          const r = parseFloat(tokens[3]);
          return { type: 'clip-begin', subShape: 'circle', cx, cy, r };
        }
        case 'rect': {
          const [x, y] = parseCoord(tokens[2]);
          const [w, h] = parseCoord(tokens[3]);
          return { type: 'clip-begin', subShape: 'rect', x, y, w, h };
        }
        case 'ellipse': {
          const [cx, cy] = parseCoord(tokens[2]);
          const [rx, ry] = parseCoord(tokens[3]);
          return { type: 'clip-begin', subShape: 'ellipse', cx, cy, rx, ry };
        }
        default: return null;
      }
    }

    case 'clip-end': {
      return { type: 'clip-end' };
    }

    case 'hitbox':
    case 'selection': {
      // hitbox rect x,y w,h [z bottom-top]  — lighting occlusion shape with optional height zone
      // selection rect x,y w,h              — click/selection shape
      // Both support: rect, circle, poly
      const shape = tokens[1]?.toLowerCase();
      // Scan for trailing 'z' keyword: "z 0-6" → { zBottom: 0, zTop: 6 }
      let zBottom = null, zTop = null;
      for (let zi = 2; zi < tokens.length; zi++) {
        if (tokens[zi] === 'z' && tokens[zi + 1]) {
          const parts = tokens[zi + 1].split('-');
          if (parts.length === 2) {
            zBottom = parseFloat(parts[0]);
            zTop = parseFloat(parts[1]);
          }
          break;
        }
      }
      const zInfo = zBottom != null ? { zBottom, zTop } : {};
      switch (shape) {
        case 'rect': {
          const [x, y] = parseCoord(tokens[2]);
          const [w, h] = parseCoord(tokens[3]);
          return { type, subShape: 'rect', x, y, w, h, ...zInfo };
        }
        case 'circle': {
          const [cx, cy] = parseCoord(tokens[2]);
          const r = parseFloat(tokens[3]);
          return { type, subShape: 'circle', cx, cy, r, ...zInfo };
        }
        case 'poly': {
          const points = [];
          for (let pi = 2; pi < tokens.length; pi++) {
            if (tokens[pi] === 'z') break; // stop before z keyword
            const coord = parseCoord(tokens[pi]);
            if (coord) points.push(coord);
          }
          return { type, subShape: 'poly', points, ...zInfo };
        }
        default: return null;
      }
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

  // For linear gradients, horizontal flip negates the angle
  function flipAngle(result) {
    if (result.angle != null && result.style === 'gradient-linear') {
      return { ...result, angle: -result.angle };
    }
    return result;
  }

  switch (cmd.type) {
    case 'rect':
      return flipAngle({ ...cmd, x: cols - cmd.x - cmd.w, rotate: cmd.rotate != null ? -cmd.rotate : cmd.rotate });

    case 'circle':
      return flipAngle({ ...cmd, cx: cols - cmd.cx });

    case 'ellipse':
      return flipAngle({ ...cmd, cx: cols - cmd.cx });

    case 'line':
      return { ...cmd, x1: cols - cmd.x1, x2: cols - cmd.x2 };

    case 'poly':
      return flipAngle({ ...cmd, points: cmd.points.map(([px, py]) => [cols - px, py]) });

    case 'arc':
      // Reflecting angles over the vertical axis: θ → 180° - θ
      // Swap start/end to preserve clockwise winding.
      return flipAngle({
        ...cmd,
        cx: cols - cmd.cx,
        startDeg: 180 - cmd.endDeg,
        endDeg: 180 - cmd.startDeg,
      });

    case 'cutout': {
      switch (cmd.subShape) {
        case 'circle':
          return { ...cmd, cx: cols - cmd.cx };
        case 'rect':
          return { ...cmd, x: cols - cmd.x - cmd.w };
        case 'ellipse':
          return { ...cmd, cx: cols - cmd.cx };
        default:
          return cmd;
      }
    }

    case 'ring':
      return flipAngle({ ...cmd, cx: cols - cmd.cx });

    case 'bezier':
      return { ...cmd, x1: cols - cmd.x1, cp1x: cols - cmd.cp1x, cp2x: cols - cmd.cp2x, x2: cols - cmd.x2 };

    case 'qbezier':
      return { ...cmd, x1: cols - cmd.x1, cpx: cols - cmd.cpx, x2: cols - cmd.x2 };

    case 'ering':
      return { ...cmd, cx: cols - cmd.cx };

    case 'clip-begin': {
      switch (cmd.subShape) {
        case 'circle':
          return { ...cmd, cx: cols - cmd.cx };
        case 'rect':
          return { ...cmd, x: cols - cmd.x - cmd.w };
        case 'ellipse':
          return { ...cmd, cx: cols - cmd.cx };
        default:
          return cmd;
      }
    }

    case 'clip-end':
      return cmd;

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

  // For linear gradients, rotate the angle by the same amount as the shape
  const rotatedAngle = (cmd.angle != null && cmd.style === 'gradient-linear')
    ? cmd.angle + rotation
    : cmd.angle;

  switch (cmd.type) {
    case 'rect': {
      if (cmd.rotate != null) {
        // Rotated rect: rotate center point and accumulate angle
        const cx = cmd.x + cmd.w / 2;
        const cy = cmd.y + cmd.h / 2;
        const [ncx, ncy] = rotatePoint(cx, cy, rotation, footprint);
        // For 90/270, swap w/h
        const swap = rotation === 90 || rotation === 270;
        const nw = swap ? cmd.h : cmd.w;
        const nh = swap ? cmd.w : cmd.h;
        return { ...cmd, x: ncx - nw / 2, y: ncy - nh / 2, w: nw, h: nh, rotate: cmd.rotate + rotation, angle: rotatedAngle };
      }
      // Non-rotated rect: AABB approach
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
      return { ...cmd, x: minX, y: minY, w: maxX - minX, h: maxY - minY, angle: rotatedAngle };
    }

    case 'circle': {
      const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
      return { ...cmd, cx: ncx, cy: ncy, angle: rotatedAngle };
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
        angle: rotatedAngle,
      };
    }

    case 'line': {
      const [nx1, ny1] = rotatePoint(cmd.x1, cmd.y1, rotation, footprint);
      const [nx2, ny2] = rotatePoint(cmd.x2, cmd.y2, rotation, footprint);
      return { ...cmd, x1: nx1, y1: ny1, x2: nx2, y2: ny2 };
    }

    case 'poly': {
      const newPoints = cmd.points.map(([px, py]) => rotatePoint(px, py, rotation, footprint));
      return { ...cmd, points: newPoints, angle: rotatedAngle };
    }

    case 'arc': {
      const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
      return {
        ...cmd,
        cx: ncx,
        cy: ncy,
        startDeg: cmd.startDeg + rotation,
        endDeg: cmd.endDeg + rotation,
        angle: rotatedAngle,
      };
    }

    case 'cutout': {
      switch (cmd.subShape) {
        case 'circle': {
          const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
          return { ...cmd, cx: ncx, cy: ncy };
        }
        case 'rect': {
          const corners = [
            [cmd.x, cmd.y],
            [cmd.x + cmd.w, cmd.y],
            [cmd.x + cmd.w, cmd.y + cmd.h],
            [cmd.x, cmd.y + cmd.h],
          ];
          const rotated = corners.map(([px, py]) => rotatePoint(px, py, rotation, footprint));
          const xs = rotated.map(p => p[0]);
          const ys = rotated.map(p => p[1]);
          return { ...cmd, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }
        case 'ellipse': {
          const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
          const swapRadii = rotation === 90 || rotation === 270;
          return { ...cmd, cx: ncx, cy: ncy, rx: swapRadii ? cmd.ry : cmd.rx, ry: swapRadii ? cmd.rx : cmd.ry };
        }
        default:
          return cmd;
      }
    }

    case 'ring': {
      const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
      return { ...cmd, cx: ncx, cy: ncy, angle: rotatedAngle };
    }

    case 'bezier': {
      const [nx1, ny1] = rotatePoint(cmd.x1, cmd.y1, rotation, footprint);
      const [ncp1x, ncp1y] = rotatePoint(cmd.cp1x, cmd.cp1y, rotation, footprint);
      const [ncp2x, ncp2y] = rotatePoint(cmd.cp2x, cmd.cp2y, rotation, footprint);
      const [nx2, ny2] = rotatePoint(cmd.x2, cmd.y2, rotation, footprint);
      return { ...cmd, x1: nx1, y1: ny1, cp1x: ncp1x, cp1y: ncp1y, cp2x: ncp2x, cp2y: ncp2y, x2: nx2, y2: ny2 };
    }

    case 'qbezier': {
      const [nx1, ny1] = rotatePoint(cmd.x1, cmd.y1, rotation, footprint);
      const [ncpx, ncpy] = rotatePoint(cmd.cpx, cmd.cpy, rotation, footprint);
      const [nx2, ny2] = rotatePoint(cmd.x2, cmd.y2, rotation, footprint);
      return { ...cmd, x1: nx1, y1: ny1, cpx: ncpx, cpy: ncpy, x2: nx2, y2: ny2 };
    }

    case 'ering': {
      const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
      const swapRadii = rotation === 90 || rotation === 270;
      return {
        ...cmd,
        cx: ncx,
        cy: ncy,
        outerRx: swapRadii ? cmd.outerRy : cmd.outerRx,
        outerRy: swapRadii ? cmd.outerRx : cmd.outerRy,
        innerRx: swapRadii ? cmd.innerRy : cmd.innerRx,
        innerRy: swapRadii ? cmd.innerRx : cmd.innerRy,
      };
    }

    case 'clip-begin': {
      switch (cmd.subShape) {
        case 'circle': {
          const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
          return { ...cmd, cx: ncx, cy: ncy };
        }
        case 'rect': {
          const corners = [
            [cmd.x, cmd.y],
            [cmd.x + cmd.w, cmd.y],
            [cmd.x + cmd.w, cmd.y + cmd.h],
            [cmd.x, cmd.y + cmd.h],
          ];
          const rotated = corners.map(([px, py]) => rotatePoint(px, py, rotation, footprint));
          const xs = rotated.map(p => p[0]);
          const ys = rotated.map(p => p[1]);
          return { ...cmd, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }
        case 'ellipse': {
          const [ncx, ncy] = rotatePoint(cmd.cx, cmd.cy, rotation, footprint);
          const swapRadii = rotation === 90 || rotation === 270;
          return { ...cmd, cx: ncx, cy: ncy, rx: swapRadii ? cmd.ry : cmd.rx, ry: swapRadii ? cmd.rx : cmd.ry };
        }
        default:
          return cmd;
      }
    }

    case 'clip-end':
      return cmd;

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
let _propsVersion = 0;
/** Clear everything — tile bitmaps + render layer. Use when prop definitions or textures change. */
export function invalidatePropsCache() {
  _propTileCache.clear();
  _propsRenderLayer = null;
  _propsVersion++;
}
/** Clear only the full-map render layer. Use when props are moved/added/removed (tiles are still valid). */
export function invalidatePropsRenderLayer() {
  _propsRenderLayer = null;
  _propsVersion++;
}
export function getPropsVersion() { return _propsVersion; }

// ── Pre-rendered props layer cache ─────────────────────────────────────────
// Renders all props to an offscreen canvas at cache resolution. Reused across
// map cache rebuilds as long as props haven't changed.
let _propsRenderLayer = null; // { canvas, w, h, propsRef, texturesVersion }

/**
 * Return a pre-rendered transparent canvas containing all props at cache resolution.
 * Returns null if no props exist. Cached as long as metadata.props reference
 * and texturesVersion haven't changed.
 */
export function getRenderedPropsLayer(cells, gridSize, theme, propCatalog, getTextureImage, texturesVersion, metadata, cacheW, cacheH, cacheScale = 10) {
  if (!propCatalog || !metadata?.props?.length) return null;

  if (_propsRenderLayer && _propsRenderLayer.w === cacheW && _propsRenderLayer.h === cacheH &&
      _propsRenderLayer.propsVersion === _propsVersion && _propsRenderLayer.texturesVersion === texturesVersion) {
    return _propsRenderLayer.canvas;
  }

  let offCanvas;
  if (_propsRenderLayer && _propsRenderLayer.canvas) {
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

  const ctx = offCanvas.getContext('2d', { alpha: true });
  ctx.clearRect(0, 0, cacheW, cacheH);

  const cacheTransform = { scale: cacheScale, offsetX: 0, offsetY: 0 };

  renderOverlayProps(ctx, metadata.props, gridSize, theme, cacheTransform, propCatalog, getTextureImage, texturesVersion, null);

  _propsRenderLayer = { canvas: offCanvas, w: cacheW, h: cacheH, propsVersion: _propsVersion, texturesVersion };
  return offCanvas;
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
function createGradient(ctx, cmd, cx, cy, rx, ry) {
  const { r: r1, g: g1, b: b1 } = parseHexColor(cmd.color || '#ffffff');
  const { r: r2, g: g2, b: b2 } = parseHexColor(cmd.gradientEnd || '#000000');
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

/** Helper to check if a command uses a gradient style. */
function isGradient(cmd) {
  return cmd.style === 'gradient-radial' || cmd.style === 'gradient-linear';
}

/**
 * Fill a rectangular canvas region with a texture image.
 * Falls back to solid grey fill if the texture is not available.
 */
function drawTexFillRect(ctx, cmd, x, y, w, h, getTextureImage) {
  const img = getTextureImage?.(cmd.textureId);
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
function _drawPropShadow(ctx, propDef, row, col, rotation, gridSize, transform) { // eslint-disable-line unused-imports/no-unused-vars
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
      if (cmd.rotate != null && cmd.rotate !== 0) {
        // Rotated rect: translate to center, rotate, draw centered
        const cx = cmd.x + cmd.w / 2;
        const cy = cmd.y + cmd.h / 2;
        const center = propToCanvas(cx, cy, row, col, gridSize, transform);
        const halfW = (cmd.w / 2) * gridSize * transform.scale;
        const halfH = (cmd.h / 2) * gridSize * transform.scale;

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

      const topLeft = propToCanvas(cmd.x, cmd.y, row, col, gridSize, transform);
      const bottomRight = propToCanvas(cmd.x + cmd.w, cmd.y + cmd.h, row, col, gridSize, transform);
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
      const p1 = propToCanvas(cmd.x1, cmd.y1, row, col, gridSize, transform);
      const p2 = propToCanvas(cmd.x2, cmd.y2, row, col, gridSize, transform);

      const prevAlpha = ctx.globalAlpha;
      if (cmd.opacity != null) ctx.globalAlpha = cmd.opacity;
      ctx.strokeStyle = cmd.color || '#000000';
      ctx.lineWidth = cmd.width != null ? cmd.width * s : (cmd.lineWidth !== null ? cmd.lineWidth * s : strokeWidth);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.globalAlpha = prevAlpha;
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
      } else if (isGradient(cmd)) {
        const xs = canvasPoints.map(p => p.x);
        const ys = canvasPoints.map(p => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        ctx.fillStyle = createGradient(ctx, cmd, (minX + maxX) / 2, (minY + maxY) / 2, (maxX - minX) / 2, (maxY - minY) / 2);
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
      const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
      const rPx = cmd.r * gridSize * transform.scale;
      const startRad = (cmd.startDeg * Math.PI) / 180;
      const endRad = (cmd.endDeg * Math.PI) / 180;

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
          drawTexFillPath(ctx, cmd, {
            x: center.x - rPx, y: center.y - rPx, w: rPx * 2, h: rPx * 2
          }, getTextureImage);
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
          const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
          const rPx = cmd.r * gridSize * transform.scale;
          ctx.beginPath();
          ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'rect': {
          const topLeft = propToCanvas(cmd.x, cmd.y, row, col, gridSize, transform);
          const bottomRight = propToCanvas(cmd.x + cmd.w, cmd.y + cmd.h, row, col, gridSize, transform);
          ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
          break;
        }
        case 'ellipse': {
          const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
          const rxPx = cmd.rx * gridSize * transform.scale;
          const ryPx = cmd.ry * gridSize * transform.scale;
          ctx.save();
          ctx.translate(center.x, center.y);
          ctx.scale(rxPx, ryPx);
          ctx.beginPath();
          ctx.arc(0, 0, 1, 0, Math.PI * 2);
          ctx.restore();
          ctx.fill();
          break;
        }
      }
      break;
    }

    case 'ring': {
      const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
      const outerPx = cmd.outerR * gridSize * transform.scale;
      const innerPx = cmd.innerR * gridSize * transform.scale;

      ctx.beginPath();
      ctx.arc(center.x, center.y, outerPx, 0, Math.PI * 2);
      ctx.arc(center.x, center.y, innerPx, 0, Math.PI * 2, true);

      if (cmd.style === 'texfill') {
        const img = getTextureImage?.(cmd.textureId);
        const alpha = cmd.opacity ?? 0.9;
        if (img && img.complete && img.naturalWidth) {
          ctx.save();
          ctx.clip('evenodd');
          ctx.globalAlpha = alpha;
          ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight,
            center.x - outerPx, center.y - outerPx, outerPx * 2, outerPx * 2);
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
      const p1 = propToCanvas(cmd.x1, cmd.y1, row, col, gridSize, transform);
      const cp1 = propToCanvas(cmd.cp1x, cmd.cp1y, row, col, gridSize, transform);
      const cp2 = propToCanvas(cmd.cp2x, cmd.cp2y, row, col, gridSize, transform);
      const p2 = propToCanvas(cmd.x2, cmd.y2, row, col, gridSize, transform);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
      if (cmd.style === 'fill' || cmd.style === 'texfill') {
        ctx.closePath();
        if (cmd.style === 'texfill') {
          const xs = [p1.x, cp1.x, cp2.x, p2.x];
          const ys = [p1.y, cp1.y, cp2.y, p2.y];
          const minX = Math.min(...xs), minY = Math.min(...ys);
          drawTexFillPath(ctx, cmd, { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }, getTextureImage);
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
      const p1 = propToCanvas(cmd.x1, cmd.y1, row, col, gridSize, transform);
      const cp = propToCanvas(cmd.cpx, cmd.cpy, row, col, gridSize, transform);
      const p2 = propToCanvas(cmd.x2, cmd.y2, row, col, gridSize, transform);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.quadraticCurveTo(cp.x, cp.y, p2.x, p2.y);
      if (cmd.style === 'fill' || cmd.style === 'texfill') {
        ctx.closePath();
        if (cmd.style === 'texfill') {
          const xs = [p1.x, cp.x, p2.x];
          const ys = [p1.y, cp.y, p2.y];
          const minX = Math.min(...xs), minY = Math.min(...ys);
          drawTexFillPath(ctx, cmd, { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }, getTextureImage);
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
      const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
      const outerRxPx = cmd.outerRx * gridSize * transform.scale;
      const outerRyPx = cmd.outerRy * gridSize * transform.scale;
      const innerRxPx = cmd.innerRx * gridSize * transform.scale;
      const innerRyPx = cmd.innerRy * gridSize * transform.scale;
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
        const img = getTextureImage?.(cmd.textureId);
        const alpha = cmd.opacity ?? 0.9;
        if (img && img.complete && img.naturalWidth) {
          ctx.save();
          ctx.clip('evenodd');
          ctx.globalAlpha = alpha;
          ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, center.x - outerRxPx, center.y - outerRyPx, outerRxPx * 2, outerRyPx * 2);
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
          const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
          const rPx = cmd.r * gridSize * transform.scale;
          ctx.arc(center.x, center.y, rPx, 0, Math.PI * 2);
          break;
        }
        case 'rect': {
          const topLeft = propToCanvas(cmd.x, cmd.y, row, col, gridSize, transform);
          const bottomRight = propToCanvas(cmd.x + cmd.w, cmd.y + cmd.h, row, col, gridSize, transform);
          ctx.rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
          break;
        }
        case 'ellipse': {
          const center = propToCanvas(cmd.cx, cmd.cy, row, col, gridSize, transform);
          const rxPx = cmd.rx * gridSize * transform.scale;
          const ryPx = cmd.ry * gridSize * transform.scale;
          ctx.save();
          ctx.translate(center.x, center.y);
          ctx.scale(rxPx, ryPx);
          ctx.arc(0, 0, 1, 0, Math.PI * 2);
          ctx.restore();
          break;
        }
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
 * @param {boolean} flipped - Horizontal mirror
 * @param {function|null} getTextureImage - (textureId) => HTMLImageElement|null
 */
export function renderProp(ctx, propDef, row, col, rotation, gridSize, theme, transform, flipped = false, getTextureImage = null) {
  if (!propDef || !propDef.commands || propDef.commands.length === 0) return;

  // Drop shadow disabled — looked bad at map scale

  // If the prop has cutout commands, we must render to an isolated canvas first.
  // destination-out on the main canvas would erase floor pixels, not just prop pixels.
  const hasCutout = propDef.commands.some(c => c.type === 'cutout');
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
function _renderPropIsolated(ctx, propDef, row, col, rotation, gridSize, theme, transform, flipped, getTextureImage) {
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
  const createCanvas = (typeof OffscreenCanvas !== 'undefined')
    ? (w, h) => new OffscreenCanvas(w, h)
    : (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const tmpCanvas = createCanvas(w, h);
  const tmpCtx = tmpCanvas.getContext('2d');

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
 * @param {function|null} getTextureImage - (textureId) => HTMLImageElement|null
 */
export function renderAllProps(ctx, cells, gridSize, theme, transform, propCatalog, getTextureImage = null, texturesVersion = 0, visibleBounds = null, metadata = null) {
  if (!propCatalog || !propCatalog.props) return;

  // Render from metadata.props[] overlay (v2+). If no overlay props, nothing to render.
  if (metadata?.props?.length) {
    renderOverlayProps(ctx, metadata.props, gridSize, theme, transform, propCatalog, getTextureImage, texturesVersion, visibleBounds);
  }
}

// ── Pixel Hit Testing ────────────────────────────────────────────────────────

/**
 * Test if a world-feet point hits a non-transparent pixel of a prop.
 * Uses the tile cache for grid-aligned props at scale 1.0.
 * Falls back to true (AABB hit) for arbitrary rotation/scale.
 *
 * @param {object} prop - overlay prop entry
 * @param {number} wx - world-feet x of cursor
 * @param {number} wy - world-feet y of cursor
 * @param {object} propCatalog - { props: { [type]: PropDefinition } }
 * @param {number} gridSize
 * @param {object} theme
 * @param {function|null} getTextureImage
 * @param {number} texturesVersion
 * @returns {boolean} true if the pixel is non-transparent (or AABB fallback)
 */
// ── Hitbox Generation ──────────────────────────────────────────────────────

const HITBOX_PX_PER_CELL = 32; // rasterization resolution per footprint cell
const HITBOX_SIMPLIFY_EPSILON = 0.08; // Douglas-Peucker tolerance in normalized coords

/**
 * Generate a simplified hitbox polygon from a prop's draw commands.
 * Rasterizes all commands onto a binary grid, traces the outer contour
 * using marching squares, then simplifies with Douglas-Peucker.
 *
 * @param {Array} commands - parsed draw commands
 * @param {number[]} footprint - [rows, cols]
 * @returns {Array<[number,number]>|null} polygon in prop-local coords (0..cols, 0..rows), or null if empty
 */
export function generateHitbox(commands, footprint) {
  if (!commands?.length) return null;
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
      const g = (bx, by) => (bx >= 0 && bx < gw && by >= 0 && by < gh) ? grid[by * gw + bx] : 0;
      if (!g(x - 1, y) || !g(x + 1, y) || !g(x, y - 1) || !g(x, y + 1)) {
        boundary.push([x / HITBOX_PX_PER_CELL, y / HITBOX_PX_PER_CELL]);
      }
    }
  }
  if (boundary.length < 3) return null;

  // 3. Compute convex hull (Graham scan) — handles disconnected shapes (e.g. tree canopy + trunk)
  const hull = _convexHull(boundary);
  if (!hull || hull.length < 3) return null;

  // 4. Simplify with Douglas-Peucker
  const simplified = _douglasPeucker(hull, HITBOX_SIMPLIFY_EPSILON);
  return simplified.length >= 3 ? simplified : null;
}

/** Test a point (in prop-local normalized coords) against all commands at rotation=0, no flip. */
function _testPointAgainstCommands(nx, ny, commands) {
  let hit = false;
  for (const cmd of commands) {
    if (cmd.type === 'line') continue;
    switch (cmd.type) {
      case 'rect':
        if (cmd.rotate != null && cmd.rotate !== 0) {
          const cx = cmd.x + cmd.w / 2, cy = cmd.y + cmd.h / 2;
          const rad = (-cmd.rotate * Math.PI) / 180;
          const cos = Math.cos(rad), sin = Math.sin(rad);
          const dx = nx - cx, dy = ny - cy;
          const lx = dx * cos - dy * sin + cx;
          const ly = dx * sin + dy * cos + cy;
          if (lx >= cmd.x && lx <= cmd.x + cmd.w && ly >= cmd.y && ly <= cmd.y + cmd.h) hit = true;
        } else {
          if (nx >= cmd.x && nx <= cmd.x + cmd.w && ny >= cmd.y && ny <= cmd.y + cmd.h) hit = true;
        }
        break;
      case 'circle': {
        const dx = nx - cmd.cx, dy = ny - cmd.cy;
        if (dx * dx + dy * dy <= cmd.r * cmd.r) hit = true;
        break;
      }
      case 'ellipse': {
        const edx = (nx - cmd.cx) / cmd.rx, edy = (ny - cmd.cy) / cmd.ry;
        if (edx * edx + edy * edy <= 1) hit = true;
        break;
      }
      case 'poly':
        if (cmd.points?.length >= 3 && _pointInPolygon(nx, ny, cmd.points)) hit = true;
        break;
      case 'arc': {
        const adx = nx - cmd.cx, ady = ny - cmd.cy;
        if (adx * adx + ady * ady > cmd.r * cmd.r) break;
        let angle = Math.atan2(ady, adx) * 180 / Math.PI;
        if (angle < 0) angle += 360;
        const start = ((cmd.startDeg % 360) + 360) % 360;
        const end = ((cmd.endDeg % 360) + 360) % 360;
        if (start <= end) { if (angle >= start && angle <= end) hit = true; }
        else { if (angle >= start || angle <= end) hit = true; }
        break;
      }
      case 'cutout': {
        let inside = false;
        switch (cmd.subShape) {
          case 'circle': {
            const dx = nx - cmd.cx, dy = ny - cmd.cy;
            inside = dx * dx + dy * dy <= cmd.r * cmd.r;
            break;
          }
          case 'rect':
            inside = nx >= cmd.x && nx <= cmd.x + cmd.w && ny >= cmd.y && ny <= cmd.y + cmd.h;
            break;
          case 'ellipse': {
            const edx = (nx - cmd.cx) / cmd.rx, edy = (ny - cmd.cy) / cmd.ry;
            inside = edx * edx + edy * edy <= 1;
            break;
          }
        }
        if (inside) hit = false;
        break;
      }
      case 'ring': {
        const dx = nx - cmd.cx, dy = ny - cmd.cy;
        const dist2 = dx * dx + dy * dy;
        if (dist2 <= cmd.outerR * cmd.outerR && dist2 >= cmd.innerR * cmd.innerR) hit = true;
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
function _convexHull(points) {
  if (points.length < 3) return points;

  // Find lowest point (then leftmost)
  let pivot = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][1] < points[pivot][1] || (points[i][1] === points[pivot][1] && points[i][0] < points[pivot][0])) {
      pivot = i;
    }
  }
  [points[0], points[pivot]] = [points[pivot], points[0]];
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
  const hull = [points[0], points[1]];
  for (let i = 2; i < points.length; i++) {
    while (hull.length > 1) {
      const a = hull[hull.length - 2];
      const b = hull[hull.length - 1];
      const c = points[i];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross > 0) break; // left turn — keep
      hull.pop();
    }
    hull.push(points[i]);
  }
  return hull;
}

/**
 * Douglas-Peucker polyline simplification.
 * @param {Array<[number,number]>} points
 * @param {number} epsilon - tolerance
 * @returns {Array<[number,number]>}
 */
function _douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points;

  // Find point with max distance from the line between first and last
  let maxDist = 0;
  let maxIdx = 0;
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
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
  return [points[0], points[points.length - 1]];
}

/**
 * Test if a world-feet point hits the actual shapes of a prop's draw commands.
 * Uses geometric math (point-in-circle, point-in-rect, point-in-polygon) on
 * the transformed draw commands. Ignores shadows — only tests prop geometry.
 *
 * Works for any rotation and scale — no tile/canvas dependency.
 */
export function hitTestPropPixel(prop, wx, wy, propCatalog, gridSize) {
  const propDef = propCatalog?.props?.[prop.type];
  if (!propDef?.commands?.length) return false;

  const rotation = prop.rotation ?? 0;
  const scale = prop.scale ?? 1.0;
  const flipped = prop.flipped ?? false;

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
  const selHitbox = propDef.selectionHitbox || propDef.autoHitbox;
  if (selHitbox) {
    // Inverse-transform the test point back to unrotated/unflipped prop space
    let hx = nx, hy = ny;
    if (r !== 0) {
      const cx = fCols / 2, cy = fRows / 2;
      const rdx = (fRows - fCols) / 2;
      const rdy = (fCols - fRows) / 2;
      switch (r) {
        case 90:  { const tx = hx - rdx, ty = hy - rdy; hx = cx + (ty - cy); hy = cy - (tx - cx); break; }
        case 180: { hx = 2 * cx - hx; hy = 2 * cy - hy; break; }
        case 270: { const tx = hx - rdx, ty = hy - rdy; hx = cx - (ty - cy); hy = cy + (tx - cx); break; }
        default: {
          const rad = (r * Math.PI) / 180;
          const cos = Math.cos(rad), sin = Math.sin(rad);
          const dx = hx - cx, dy = hy - cy;
          hx = cx + dx * cos + dy * sin;
          hy = cy - dx * sin + dy * cos;
          break;
        }
      }
    }
    if (flipped) hx = fCols - hx;
    return _pointInPolygon(hx, hy, selHitbox);
  }

  // Fallback: test each draw command's shape (after flip+rotate transform)
  let hit = false;
  for (const cmd of propDef.commands) {
    if (cmd.type === 'line') continue; // too thin
    const flippedCmd = flipped ? flipCommand(cmd, propDef.footprint) : cmd;
    const tc = (r === 0) ? flippedCmd : transformCommand(flippedCmd, r, propDef.footprint);

    switch (tc.type) {
      case 'rect':
        if (tc.rotate != null && tc.rotate !== 0) {
          const cx = tc.x + tc.w / 2, cy = tc.y + tc.h / 2;
          const rad = (-tc.rotate * Math.PI) / 180;
          const cos = Math.cos(rad), sin = Math.sin(rad);
          const dx = nx - cx, dy = ny - cy;
          const lx = dx * cos - dy * sin + cx;
          const ly = dx * sin + dy * cos + cy;
          if (lx >= tc.x && lx <= tc.x + tc.w && ly >= tc.y && ly <= tc.y + tc.h) hit = true;
        } else {
          if (nx >= tc.x && nx <= tc.x + tc.w && ny >= tc.y && ny <= tc.y + tc.h) hit = true;
        }
        break;
      case 'circle': {
        const dx = nx - tc.cx, dy = ny - tc.cy;
        if (dx * dx + dy * dy <= tc.r * tc.r) hit = true;
        break;
      }
      case 'ellipse': {
        const edx = (nx - tc.cx) / tc.rx, edy = (ny - tc.cy) / tc.ry;
        if (edx * edx + edy * edy <= 1) hit = true;
        break;
      }
      case 'poly': {
        if (tc.points?.length >= 3 && _pointInPolygon(nx, ny, tc.points)) hit = true;
        break;
      }
      case 'arc': {
        const adx = nx - tc.cx, ady = ny - tc.cy;
        if (adx * adx + ady * ady > tc.r * tc.r) break;
        let angle = Math.atan2(ady, adx) * 180 / Math.PI;
        if (angle < 0) angle += 360;
        const start = ((tc.startDeg % 360) + 360) % 360;
        const end = ((tc.endDeg % 360) + 360) % 360;
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
            const dx = nx - tc.cx, dy = ny - tc.cy;
            inside = dx * dx + dy * dy <= tc.r * tc.r;
            break;
          }
          case 'rect':
            inside = nx >= tc.x && nx <= tc.x + tc.w && ny >= tc.y && ny <= tc.y + tc.h;
            break;
          case 'ellipse': {
            const edx = (nx - tc.cx) / tc.rx, edy = (ny - tc.cy) / tc.ry;
            inside = edx * edx + edy * edy <= 1;
            break;
          }
        }
        if (inside) hit = false;
        break;
      }
      case 'ring': {
        const dx = nx - tc.cx, dy = ny - tc.cy;
        const dist2 = dx * dx + dy * dy;
        if (dist2 <= tc.outerR * tc.outerR && dist2 >= tc.innerR * tc.innerR) hit = true;
        break;
      }
    }
  }
  return hit;
}

/** Ray-casting point-in-polygon test. */
function _pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
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
 * @param {object|null} visibleBounds - { minRow, maxRow, minCol, maxCol }
 */
export function renderOverlayProps(ctx, overlayProps, gridSize, theme, transform, propCatalog, getTextureImage = null, texturesVersion = 0, visibleBounds = null) {
  if (!overlayProps?.length || !propCatalog?.props) return;

  const wallStroke = theme?.wallStroke || '';

  // Purge unknown prop types from the source array so we don't spam warnings every frame
  for (let i = overlayProps.length - 1; i >= 0; i--) {
    if (!propCatalog.props[overlayProps[i].type]) {
      warn(`[props] Unknown overlay prop type "${overlayProps[i].type}" (${overlayProps[i].id}) — removed from map`);
      overlayProps.splice(i, 1);
    }
  }
  if (!overlayProps.length) return;

  // Sort by zIndex (stable: original order preserved for equal z)
  const sorted = [...overlayProps].sort((a, b) => (a.zIndex ?? 10) - (b.zIndex ?? 10));

  for (const prop of sorted) {
    const propDef = propCatalog.props[prop.type];

    const rotation = prop.rotation ?? 0;
    const scale = prop.scale ?? 1.0;
    const flipped = prop.flipped ?? false;
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
export function extractOverlayPropLightSegments(propDef, overlayProp, gridSize) {
  const rotation = overlayProp.rotation ?? 0;
  const scale = overlayProp.scale ?? 1.0;
  const flipped = overlayProp.flipped ?? false;
  const [fRows, fCols] = propDef.footprint;
  const r = ((rotation % 360) + 360) % 360;

  // Fast path: use hitbox polygon if available
  if (propDef.hitbox) {
    const hitbox = propDef.hitbox;
    const cx = fCols / 2;
    const cy = fRows / 2;
    const rdx = (fRows - fCols) / 2;
    const rdy = (fCols - fRows) / 2;

    // Transform each hitbox vertex: flip → rotate → scale → world-feet → translate
    const worldPts = hitbox.map(([hx, hy]) => {
      let px = flipped ? fCols - hx : hx;
      let py = hy;
      // Rotate using rotatePoint logic
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
      // To world-feet with scale
      const wx = px * gridSize;
      const wy = py * gridSize;
      const pcx = (r === 90 || r === 270 ? fRows : fCols) * gridSize / 2;
      const pcy = (r === 90 || r === 270 ? fCols : fRows) * gridSize / 2;
      return {
        x: overlayProp.x + pcx + (wx - pcx) * scale,
        y: overlayProp.y + pcy + (wy - pcy) * scale,
      };
    });
    // Emit closed polygon segments
    const segments = [];
    for (let i = 0; i < worldPts.length; i++) {
      const a = worldPts[i];
      const b = worldPts[(i + 1) % worldPts.length];
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    return segments;
  }

  // Fallback: iterate draw commands
  if (!propDef?.commands) return [];

  // For grid-aligned rotation at scale 1.0, delegate to existing function
  if ((r === 0 || r === 90 || r === 180 || r === 270) && scale === 1.0) {
    const row = overlayProp.y / gridSize;
    const col = overlayProp.x / gridSize;
    return extractPropLightSegments(propDef, row, col, r, flipped, gridSize);
  }

  // Arbitrary rotation/scale: extract segments then transform
  const baseSegments = extractPropLightSegments(propDef, 0, 0, 0, flipped, gridSize);

  const cx = (fCols / 2) * gridSize;
  const cy = (fRows / 2) * gridSize;
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return baseSegments.map(seg => {
    function transform(x, y) {
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
    // Skip cutouts — they remove geometry, not add it
    if (cmd.type === 'cutout') continue;

    // Apply same transform order as renderProp: flip first, then rotate
    const flippedCmd = flipped ? flipCommand(cmd, propDef.footprint) : cmd;
    const tc = transformCommand(flippedCmd, rotation, propDef.footprint);

    switch (tc.type) {
      case 'rect': {
        if (tc.rotate != null && tc.rotate !== 0) {
          // Rotated rect: compute actual corners
          const cx = tc.x + tc.w / 2, cy = tc.y + tc.h / 2;
          const rad = (tc.rotate * Math.PI) / 180;
          const cos = Math.cos(rad), sin = Math.sin(rad);
          const hw = tc.w / 2, hh = tc.h / 2;
          const corners = [
            [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]
          ].map(([lx, ly]) => toWorldFeet(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos, row, col, gridSize));
          for (let i = 0; i < 4; i++) {
            const a = corners[i], b = corners[(i + 1) % 4];
            segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          }
        } else {
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
        }
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

      case 'ring': {
        // Generate segments for both outer and inner circles
        const outerPts = circleToPolygon(tc.cx, tc.cy, tc.outerR);
        const outerWorld = outerPts.map(p => toWorldFeet(p.x, p.y, row, col, gridSize));
        segments.push(...polygonToSegments(outerWorld));
        const innerPts = circleToPolygon(tc.cx, tc.cy, tc.innerR);
        const innerWorld = innerPts.map(p => toWorldFeet(p.x, p.y, row, col, gridSize));
        segments.push(...polygonToSegments(innerWorld));
        break;
      }
    }
  }

  return segments;
}
