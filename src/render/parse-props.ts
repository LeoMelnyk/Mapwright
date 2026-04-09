/**
 * parse-props.js - Prop parsing and coordinate transformation
 *
 * Handles parsing .prop text files into prop definitions,
 * rotating/transforming draw commands for different facings,
 * and coordinate utility functions shared by render and hitbox modules.
 */

import type { PropDefinition, PropCommand, PropPlacement, RenderTransform } from '../types.js';
import { GRID_SCALE } from './constants.js';
import { warn } from './warnings.js';


// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Scale factor relative to the base GRID_SCALE.
 * Matches the pattern used in borders.js.
 * @param {Object} transform - Transform with scale property
 * @returns {number} Scale multiplier relative to GRID_SCALE
 */
export function scaleFactor(transform: RenderTransform): number {
  return transform.scale / GRID_SCALE;
}

/**
 * Parse a hex color string (#RRGGBB or #RGB) into { r, g, b }.
 * @param {string} hex - Hex color string (e.g. '#FF0000' or '#F00')
 * @returns {{ r: number, g: number, b: number }} Parsed RGB values (0-255)
 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
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
 * @param {string[]} tokens - Array of string tokens to search
 * @param {string} keyword - Keyword to find
 * @returns {number|null} Parsed float value, or null if not found
 */
export function scanKeyword(tokens: string[], keyword: string): number | null {
  for (let i = 0; i < tokens.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tokens[i+1] can be out of bounds
    if (tokens[i] === keyword && tokens[i + 1] != null) {
      return parseFloat(tokens[i + 1]);
    }
  }
  return null;
}

/**
 * Check if a command uses a gradient style.
 * @param {Object} cmd - Parsed draw command
 * @returns {boolean} True if the command uses gradient-radial or gradient-linear
 */
export function isGradient(cmd: PropCommand): boolean {
  return cmd.style === 'gradient-radial' || cmd.style === 'gradient-linear';
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
export function parsePropFile(text: string): PropDefinition {
  const separatorIndex = text.indexOf('---');
  if (separatorIndex === -1) {
    throw new Error('Invalid .prop file: missing --- separator');
  }

  const headerText = text.substring(0, separatorIndex);
  const bodyText = text.substring(separatorIndex + 3);

  // Parse header (YAML-like key: value pairs)
  const header: Record<string, string> = {};
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
  let footprint: [number, number] = [1, 1];
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
  const height = isNaN(parseFloat(header.height)) ? null : parseFloat(header.height);

  // Padding: extra cells of overflow around the footprint (default 0)
  const padding = parseFloat(header.padding) || 0;

  // Prop-bundled lights: inline JSON array of { preset, x, y } (normalized 0–cols, 0–rows)
  let propLights = null;
  if (header.lights) {
    try { propLights = JSON.parse(header.lights); } catch (e) { warn(`[props] Malformed lights JSON in prop "${name}": ${(e as Error).message}`); }
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
    commands.filter(c => c.style === 'texfill' && c.textureId).map(c => c.textureId!)
  )];

  // Placement metadata (optional fields — gracefully default to null/empty)
  const placement = (header.placement || null) as PropPlacement;  // wall, corner, center, floor, any
  const roomTypes = header.room_types
    ? header.room_types.split(',').map((s: string) => s.trim()).filter(Boolean)
    : [];
  const typicalCount = header.typical_count || null;           // single, few, many
  const clustersWith = header.clusters_with
    ? header.clusters_with.split(',').map((s: string) => s.trim()).filter(Boolean)
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
 * @param {string[]} tokens - Array of string tokens from a command line
 * @param {number} startIndex - Index to start parsing style from
 * @returns {{ style: string, color: string|null, textureId: string|null, opacity: number|null, gradientEnd?: string }}
 */
export function parseStyleExtended(tokens: string[], startIndex: number): { style: string; color: string | null; textureId: string | null; opacity: number | null; gradientEnd?: string } {
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

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- nextToken can be undefined (array out of bounds)
  if (nextToken?.startsWith('#')) {
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
 *
 * @param {string} line - Single line of draw command text
 * @returns {Object|null} Parsed command object, or null if unrecognized
 */
export function parseCommand(line: string): PropCommand | null {
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
      let ext: { style: string; color: string | null; textureId: string | null; opacity: number | null; gradientEnd?: string } = { style: 'fill', color: null, textureId: null, opacity: null };
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === 'fill' || tokens[i] === 'stroke' || tokens[i] === 'texfill' || tokens[i] === 'gradient-radial' || tokens[i] === 'gradient-linear') {
          ext = parseStyleExtended(tokens, i);
          break;
        }
        const coord = parseCoord(tokens[i]);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- parseCoord returns null for unparseable tokens
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
            points.push(coord);
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

/**
 * Parse "x,y" into [x, y].
 * @param {string} token - Comma-separated coordinate string
 * @returns {[number, number]} Parsed [x, y] coordinates
 */
export function parseCoord(token: string): [number, number] {
  if (!token) return [0, 0];
  const parts = token.split(',');
  return [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0];
}

/**
 * Parse optional opacity value. Returns null if not present.
 * @param {string|undefined|null} token - String token to parse as opacity
 * @returns {number|null} Parsed opacity value, or null if not present
 */
export function parseOpacity(token: string): number | null {
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
export function rotatePoint(x: number, y: number, rotation: number, footprint: [number, number]): [number, number] {
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
export function flipCommand(cmd: PropCommand, footprint: [number, number]): PropCommand {
  const cols = footprint[1];

  // For linear gradients, horizontal flip negates the angle
  function flipAngle(result: PropCommand): PropCommand {
    if (result.angle != null && result.style === 'gradient-linear') {
      return { ...result, angle: -(result.angle) };
    }
    return result;
  }

  switch (cmd.type) {
    case 'rect':
      return flipAngle({ ...cmd, x: cols - cmd.x! - cmd.w!, rotate: cmd.rotate != null ? -cmd.rotate : cmd.rotate });

    case 'circle':
      return flipAngle({ ...cmd, cx: cols - cmd.cx! });

    case 'ellipse':
      return flipAngle({ ...cmd, cx: cols - cmd.cx! });

    case 'line':
      return { ...cmd, x1: cols - cmd.x1!, x2: cols - cmd.x2! };

    case 'poly':
      return flipAngle({ ...cmd, points: cmd.points!.map(([px, py]: number[]) => [cols - px, py]) });

    case 'arc':
      // Reflecting angles over the vertical axis: θ → 180° - θ
      // Swap start/end to preserve clockwise winding.
      return flipAngle({
        ...cmd,
        cx: cols - cmd.cx!,
        startDeg: 180 - cmd.endDeg!,
        endDeg: 180 - cmd.startDeg!,
      });

    case 'cutout': {
      switch (cmd.subShape) {
        case 'circle':
          return { ...cmd, cx: cols - cmd.cx! };
        case 'rect':
          return { ...cmd, x: cols - cmd.x! - cmd.w! };
        case 'ellipse':
          return { ...cmd, cx: cols - cmd.cx! };
        case undefined:
        default:
          return cmd;
      }
    }

    case 'ring':
      return flipAngle({ ...cmd, cx: cols - cmd.cx! });

    case 'bezier':
      return { ...cmd, x1: cols - cmd.x1!, cp1x: cols - cmd.cp1x!, cp2x: cols - cmd.cp2x!, x2: cols - cmd.x2! };

    case 'qbezier':
      return { ...cmd, x1: cols - cmd.x1!, cpx: cols - cmd.cpx!, x2: cols - cmd.x2! };

    case 'ering':
      return { ...cmd, cx: cols - cmd.cx! };

    case 'clip-begin': {
      switch (cmd.subShape) {
        case 'circle':
          return { ...cmd, cx: cols - cmd.cx! };
        case 'rect':
          return { ...cmd, x: cols - cmd.x! - cmd.w! };
        case 'ellipse':
          return { ...cmd, cx: cols - cmd.cx! };
        case undefined:
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
export function transformCommand(cmd: PropCommand, rotation: number, footprint: [number, number]): PropCommand {
  if (rotation === 0) return cmd;

  // For linear gradients, rotate the angle by the same amount as the shape
  const rotatedAngle = (cmd.angle != null && cmd.style === 'gradient-linear')
    ? cmd.angle + rotation
    : cmd.angle;

  switch (cmd.type) {
    case 'rect': {
      if (cmd.rotate != null) {
        // Rotated rect: rotate center point and accumulate angle
        const cx = cmd.x! + cmd.w! / 2;
        const cy = cmd.y! + cmd.h! / 2;
        const [ncx, ncy] = rotatePoint(cx, cy, rotation, footprint);
        // For 90/270, swap w/h
        const swap = rotation === 90 || rotation === 270;
        const nw = swap ? cmd.h : cmd.w;
        const nh = swap ? cmd.w : cmd.h;
        return { ...cmd, x: ncx - nw! / 2, y: ncy - nh! / 2, w: nw, h: nh, rotate: cmd.rotate + rotation, angle: rotatedAngle };
      }
      // Non-rotated rect: AABB approach
      const corners = [
        [cmd.x!, cmd.y!],
        [cmd.x! + cmd.w!, cmd.y!],
        [cmd.x! + cmd.w!, cmd.y! + cmd.h!],
        [cmd.x!, cmd.y! + cmd.h!],
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
      const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
      return { ...cmd, cx: ncx, cy: ncy, angle: rotatedAngle };
    }

    case 'ellipse': {
      const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
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
      const [nx1, ny1] = rotatePoint(cmd.x1!, cmd.y1!, rotation, footprint);
      const [nx2, ny2] = rotatePoint(cmd.x2!, cmd.y2!, rotation, footprint);
      return { ...cmd, x1: nx1, y1: ny1, x2: nx2, y2: ny2 };
    }

    case 'poly': {
      const newPoints = cmd.points!.map(([px, py]: number[]) => rotatePoint(px, py, rotation, footprint));
      return { ...cmd, points: newPoints, angle: rotatedAngle };
    }

    case 'arc': {
      const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
      return {
        ...cmd,
        cx: ncx,
        cy: ncy,
        startDeg: cmd.startDeg! + rotation,
        endDeg: cmd.endDeg! + rotation,
        angle: rotatedAngle,
      };
    }

    case 'cutout': {
      switch (cmd.subShape) {
        case 'circle': {
          const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
          return { ...cmd, cx: ncx, cy: ncy };
        }
        case 'rect': {
          const corners = [
            [cmd.x!, cmd.y!],
            [cmd.x! + cmd.w!, cmd.y!],
            [cmd.x! + cmd.w!, cmd.y! + cmd.h!],
            [cmd.x!, cmd.y! + cmd.h!],
          ];
          const rotated = corners.map(([px, py]) => rotatePoint(px, py, rotation, footprint));
          const xs = rotated.map(p => p[0]);
          const ys = rotated.map(p => p[1]);
          return { ...cmd, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }
        case 'ellipse': {
          const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
          const swapRadii = rotation === 90 || rotation === 270;
          return { ...cmd, cx: ncx, cy: ncy, rx: swapRadii ? cmd.ry : cmd.rx, ry: swapRadii ? cmd.rx : cmd.ry };
        }
        case undefined:
        default:
          return cmd;
      }
    }

    case 'ring': {
      const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
      return { ...cmd, cx: ncx, cy: ncy, angle: rotatedAngle };
    }

    case 'bezier': {
      const [nx1, ny1] = rotatePoint(cmd.x1!, cmd.y1!, rotation, footprint);
      const [ncp1x, ncp1y] = rotatePoint(cmd.cp1x!, cmd.cp1y!, rotation, footprint);
      const [ncp2x, ncp2y] = rotatePoint(cmd.cp2x!, cmd.cp2y!, rotation, footprint);
      const [nx2, ny2] = rotatePoint(cmd.x2!, cmd.y2!, rotation, footprint);
      return { ...cmd, x1: nx1, y1: ny1, cp1x: ncp1x, cp1y: ncp1y, cp2x: ncp2x, cp2y: ncp2y, x2: nx2, y2: ny2 };
    }

    case 'qbezier': {
      const [nx1, ny1] = rotatePoint(cmd.x1!, cmd.y1!, rotation, footprint);
      const [ncpx, ncpy] = rotatePoint(cmd.cpx!, cmd.cpy!, rotation, footprint);
      const [nx2, ny2] = rotatePoint(cmd.x2!, cmd.y2!, rotation, footprint);
      return { ...cmd, x1: nx1, y1: ny1, cpx: ncpx, cpy: ncpy, x2: nx2, y2: ny2 };
    }

    case 'ering': {
      const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
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
          const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
          return { ...cmd, cx: ncx, cy: ncy };
        }
        case 'rect': {
          const corners = [
            [cmd.x!, cmd.y!],
            [cmd.x! + cmd.w!, cmd.y!],
            [cmd.x! + cmd.w!, cmd.y! + cmd.h!],
            [cmd.x!, cmd.y! + cmd.h!],
          ];
          const rotated = corners.map(([px, py]) => rotatePoint(px, py, rotation, footprint));
          const xs = rotated.map(p => p[0]);
          const ys = rotated.map(p => p[1]);
          return { ...cmd, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }
        case 'ellipse': {
          const [ncx, ncy] = rotatePoint(cmd.cx!, cmd.cy!, rotation, footprint);
          const swapRadii = rotation === 90 || rotation === 270;
          return { ...cmd, cx: ncx, cy: ncy, rx: swapRadii ? cmd.ry : cmd.rx, ry: swapRadii ? cmd.rx : cmd.ry };
        }
        case undefined:
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
