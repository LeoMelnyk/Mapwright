#!/usr/bin/env node
/**
 * validate-props.js - CLI tool to validate prop footprint bounds.
 *
 * Usage:
 *   node tools/validate-props.js                     # scan all .prop files in src/props/
 *   node tools/validate-props.js shield-rack.prop     # validate specific files
 *
 * Exit code 0 if all valid, 1 if any warnings.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOLERANCE = 0.02;

// Valid falloff types (from src/types.ts FalloffType)
const VALID_FALLOFFS = new Set(['smooth', 'linear', 'sharp', 'step', 'quadratic', 'inverse-square']);

// Load available light presets from manifest.
let VALID_LIGHT_PRESETS = null;
function loadLightPresets() {
  if (VALID_LIGHT_PRESETS) return VALID_LIGHT_PRESETS;
  try {
    const manifestPath = join(__dirname, '..', 'src', 'lights', 'manifest.json');
    const names = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    VALID_LIGHT_PRESETS = new Set(names);
  } catch {
    VALID_LIGHT_PRESETS = new Set();
  }
  return VALID_LIGHT_PRESETS;
}

// ── Lightweight prop parser (self-contained, no ES module imports needed) ────

function parseCoord(token) {
  if (!token) return [0, 0];
  const parts = token.split(',');
  return [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0];
}

function parseHeader(headerText) {
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

  const name = header.name || 'Unnamed';
  let footprint = [1, 1];
  if (header.footprint) {
    const parts = header.footprint.toLowerCase().split('x');
    if (parts.length === 2) {
      footprint = [parseInt(parts[0], 10) || 1, parseInt(parts[1], 10) || 1];
    }
  }
  const padding = parseFloat(header.padding) || 0;

  return { name, footprint, padding };
}

/**
 * Parse a command line into a minimal object with type and coordinates.
 * Returns null for unrecognized or comment lines.
 */
function parseCommandLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const tokens = trimmed.split(/\s+/);
  const type = tokens[0].toLowerCase();

  switch (type) {
    case 'rect': {
      const [x, y] = parseCoord(tokens[1]);
      const [w, h] = parseCoord(tokens[2]);
      return { type: 'rect', x, y, w, h };
    }
    case 'circle': {
      const [cx, cy] = parseCoord(tokens[1]);
      const r = parseFloat(tokens[2]);
      return { type: 'circle', cx, cy, r };
    }
    case 'ellipse': {
      const [cx, cy] = parseCoord(tokens[1]);
      const [rx, ry] = parseCoord(tokens[2]);
      return { type: 'ellipse', cx, cy, rx, ry };
    }
    case 'line': {
      const [x1, y1] = parseCoord(tokens[1]);
      const [x2, y2] = parseCoord(tokens[2]);
      return { type: 'line', x1, y1, x2, y2 };
    }
    case 'poly': {
      const points = [];
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === 'fill' || tokens[i] === 'stroke' || tokens[i] === 'texfill') break;
        if (tokens[i] === 'width') break;
        const coord = tokens[i].split(',');
        if (coord.length === 2 && !isNaN(parseFloat(coord[0])) && !isNaN(parseFloat(coord[1]))) {
          points.push([parseFloat(coord[0]), parseFloat(coord[1])]);
        }
      }
      return { type: 'poly', points };
    }
    case 'arc': {
      const [cx, cy] = parseCoord(tokens[1]);
      const r = parseFloat(tokens[2]);
      return { type: 'arc', cx, cy, r };
    }
    case 'ring': {
      const [cx, cy] = parseCoord(tokens[1]);
      const outerR = parseFloat(tokens[2]);
      return { type: 'ring', cx, cy, outerR };
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
    default:
      return null;
  }
}

// ── Bounds checking ─────────────────────────────────────────────────────────

function checkBounds(cmd, index, xMin, xMax, yMin, yMax) {
  const warnings = [];
  const cmdLabel = cmd.type === 'cutout' ? `cutout-${cmd.subShape}` : cmd.type;

  function check(label, value, bound, side) {
    const isX = label.startsWith('x') || label.startsWith('cx');
    const axisMax = isX ? xMax : yMax;
    const axisMin = isX ? xMin : yMin;
    if (side === 'min' && value < bound - TOLERANCE) {
      warnings.push({
        line: index,
        command: cmdLabel,
        message: `${label}=${value.toFixed(2)} below ${isX ? 'x' : 'y'} min=${axisMin.toFixed(2)}`,
      });
    } else if (side === 'max' && value > bound + TOLERANCE) {
      warnings.push({
        line: index,
        command: cmdLabel,
        message: `${label}=${value.toFixed(2)} exceeds ${isX ? 'x' : 'y'} max=${axisMax.toFixed(2)}`,
      });
    }
  }

  switch (cmd.type) {
    case 'rect':
      check('x', cmd.x, xMin, 'min');
      check('y', cmd.y, yMin, 'min');
      check('x+w', cmd.x + cmd.w, xMax, 'max');
      check('y+h', cmd.y + cmd.h, yMax, 'max');
      break;

    case 'circle':
      check('cx-r', cmd.cx - cmd.r, xMin, 'min');
      check('cy-r', cmd.cy - cmd.r, yMin, 'min');
      check('cx+r', cmd.cx + cmd.r, xMax, 'max');
      check('cy+r', cmd.cy + cmd.r, yMax, 'max');
      break;

    case 'ellipse':
      check('cx-rx', cmd.cx - cmd.rx, xMin, 'min');
      check('cy-ry', cmd.cy - cmd.ry, yMin, 'min');
      check('cx+rx', cmd.cx + cmd.rx, xMax, 'max');
      check('cy+ry', cmd.cy + cmd.ry, yMax, 'max');
      break;

    case 'line':
      check('x1', cmd.x1, xMin, 'min');
      check('y1', cmd.y1, yMin, 'min');
      check('x1', cmd.x1, xMax, 'max');
      check('y1', cmd.y1, yMax, 'max');
      check('x2', cmd.x2, xMin, 'min');
      check('y2', cmd.y2, yMin, 'min');
      check('x2', cmd.x2, xMax, 'max');
      check('y2', cmd.y2, yMax, 'max');
      break;

    case 'poly':
      for (let pi = 0; pi < cmd.points.length; pi++) {
        const [px, py] = cmd.points[pi];
        check(`x[${pi}]`, px, xMin, 'min');
        check(`y[${pi}]`, py, yMin, 'min');
        check(`x[${pi}]`, px, xMax, 'max');
        check(`y[${pi}]`, py, yMax, 'max');
      }
      break;

    case 'arc':
      check('cx-r', cmd.cx - cmd.r, xMin, 'min');
      check('cy-r', cmd.cy - cmd.r, yMin, 'min');
      check('cx+r', cmd.cx + cmd.r, xMax, 'max');
      check('cy+r', cmd.cy + cmd.r, yMax, 'max');
      break;

    case 'ring':
      check('cx-outerR', cmd.cx - cmd.outerR, xMin, 'min');
      check('cy-outerR', cmd.cy - cmd.outerR, yMin, 'min');
      check('cx+outerR', cmd.cx + cmd.outerR, xMax, 'max');
      check('cy+outerR', cmd.cy + cmd.outerR, yMax, 'max');
      break;

    case 'cutout':
      switch (cmd.subShape) {
        case 'circle':
          check('cx-r', cmd.cx - cmd.r, xMin, 'min');
          check('cy-r', cmd.cy - cmd.r, yMin, 'min');
          check('cx+r', cmd.cx + cmd.r, xMax, 'max');
          check('cy+r', cmd.cy + cmd.r, yMax, 'max');
          break;
        case 'rect':
          check('x', cmd.x, xMin, 'min');
          check('y', cmd.y, yMin, 'min');
          check('x+w', cmd.x + cmd.w, xMax, 'max');
          check('y+h', cmd.y + cmd.h, yMax, 'max');
          break;
        case 'ellipse':
          check('cx-rx', cmd.cx - cmd.rx, xMin, 'min');
          check('cy-ry', cmd.cy - cmd.ry, yMin, 'min');
          check('cx+rx', cmd.cx + cmd.rx, xMax, 'max');
          check('cy+ry', cmd.cy + cmd.ry, yMax, 'max');
          break;
      }
      break;
  }

  return warnings;
}

// ── Hitbox parsing & validation ────────────────────────────────────────────

/**
 * Parse a single hitbox or selection command line.
 * Returns { kind: 'hitbox'|'selection', shape, ...geom, zBottom, zTop } or null.
 * Supports: rect, circle, poly, with optional trailing `z bottom-top`.
 */
function parseHitboxLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith('hitbox ') && !trimmed.startsWith('selection ')) return null;
  const tokens = trimmed.split(/\s+/);
  const kind = tokens[0];
  const shape = tokens[1];
  let zBottom = null,
    zTop = null;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i] === 'z' && tokens[i + 1]) {
      const parts = tokens[i + 1].split('-');
      if (parts.length === 2) {
        zBottom = parseFloat(parts[0]);
        zTop = parseFloat(parts[1]);
      }
      break;
    }
  }

  if (shape === 'rect') {
    const [x, y] = parseCoord(tokens[2]);
    const [w, h] = parseCoord(tokens[3]);
    return { kind, shape: 'rect', x, y, w, h, zBottom, zTop };
  }
  if (shape === 'circle') {
    const [cx, cy] = parseCoord(tokens[2]);
    const r = parseFloat(tokens[3]);
    return { kind, shape: 'circle', cx, cy, r, zBottom, zTop };
  }
  if (shape === 'poly') {
    const points = [];
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i] === 'z') break;
      const p = tokens[i].split(',');
      if (p.length === 2) {
        const px = parseFloat(p[0]);
        const py = parseFloat(p[1]);
        if (!isNaN(px) && !isNaN(py)) points.push([px, py]);
      }
    }
    return { kind, shape: 'poly', points, zBottom, zTop };
  }
  return null;
}

function validateHitboxes(bodyText, headerObj, footprint, padding) {
  const warnings = [];
  const [rows, cols] = footprint;
  const marg = 0.02 + padding;
  const blocksLight = headerObj.blocks_light === 'yes' || headerObj.blocks_light === 'true';
  const height = headerObj.height != null && headerObj.height !== '' ? parseFloat(headerObj.height) : null;

  let cmdIndex = 0;
  for (const line of bodyText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const hb = parseHitboxLine(trimmed);
    cmdIndex++;
    if (!hb) continue;

    const tag = hb.kind;

    // Bounds (respect padding)
    const outBounds = (v, max) => v < -marg || v > max + marg;
    if (hb.shape === 'rect') {
      if (
        outBounds(hb.x, cols) ||
        outBounds(hb.y, rows) ||
        outBounds(hb.x + hb.w, cols) ||
        outBounds(hb.y + hb.h, rows)
      ) {
        warnings.push({
          line: cmdIndex,
          command: tag,
          message: `rect ${hb.x},${hb.y} ${hb.w},${hb.h} extends beyond footprint (${cols}x${rows})`,
        });
      }
      if (hb.w <= 0 || hb.h <= 0) {
        warnings.push({ line: cmdIndex, command: tag, message: `rect has zero/negative size (w=${hb.w}, h=${hb.h})` });
      }
    } else if (hb.shape === 'circle') {
      if (hb.cx - hb.r < -marg || hb.cx + hb.r > cols + marg || hb.cy - hb.r < -marg || hb.cy + hb.r > rows + marg) {
        warnings.push({
          line: cmdIndex,
          command: tag,
          message: `circle at ${hb.cx},${hb.cy} r=${hb.r} extends beyond footprint (${cols}x${rows})`,
        });
      }
      if (hb.r <= 0)
        warnings.push({ line: cmdIndex, command: tag, message: `circle has zero/negative radius (r=${hb.r})` });
    } else if (hb.shape === 'poly') {
      for (const [px, py] of hb.points) {
        if (outBounds(px, cols) || outBounds(py, rows)) {
          warnings.push({
            line: cmdIndex,
            command: tag,
            message: `poly vertex ${px},${py} outside footprint (${cols}x${rows})`,
          });
          break;
        }
      }
    }

    // z-zone checks — only meaningful for `hitbox` (lighting) on blocks_light:yes props
    if (hb.kind === 'hitbox' && blocksLight && hb.zBottom != null && hb.zTop != null) {
      if (hb.zBottom < 0) {
        warnings.push({ line: cmdIndex, command: tag, message: `zBottom=${hb.zBottom} must be ≥ 0` });
      }
      if (hb.zTop < hb.zBottom) {
        warnings.push({ line: cmdIndex, command: tag, message: `zTop=${hb.zTop} < zBottom=${hb.zBottom} (inverted)` });
      }
      if (height != null && hb.zTop > height + 0.01) {
        warnings.push({ line: cmdIndex, command: tag, message: `zTop=${hb.zTop} exceeds declared height=${height}` });
      }
    }
  }

  // Header-level height check: props that block light should declare a height
  if (blocksLight && (headerObj.height == null || headerObj.height === '')) {
    warnings.push({
      line: -1,
      command: 'height',
      message: `blocks_light: yes but no height declared — shadow will be infinite. Add "height: <feet>" (e.g. 3 for a chair, 8 for a pillar).`,
    });
  }

  // Hitbox/selection use is gated by blocks_light — see CLAUDE.md "Hitbox & Selection Commands"
  const hasHitbox = /\n\s*hitbox\s+/.test(bodyText) || /^hitbox\s+/.test(bodyText.trimStart());

  if (blocksLight && !hasHitbox) {
    warnings.push({
      line: -1,
      command: 'hitbox',
      message: `blocks_light: yes requires at least one "hitbox" command for accurate light occlusion (auto-hull is often too loose). Example: hitbox rect 0.1,0.1 0.8,0.8 z 0-${headerObj.height || 3}`,
    });
  }
  if (!blocksLight && hasHitbox) {
    warnings.push({
      line: -1,
      command: 'hitbox',
      message: `blocks_light: no but "hitbox" commands are present — hitbox is ignored unless blocks_light: yes. Rename to "selection" for click detection, or set blocks_light: yes if the prop should cast shadows.`,
    });
  }

  return warnings;
}

// ── Header-level validation (lights, height, etc.) ──────────────────────────

const LIGHT_FIELDS_REQUIRED = ['preset', 'x', 'y'];
const LIGHT_FIELDS_KNOWN = new Set([
  'preset',
  'x',
  'y',
  'color',
  'radius',
  'intensity',
  'falloff',
  'dimRadius',
  'angle',
  'spread',
]);

function validateLightsHeader(rawHeaderText, parsedLightsValue, footprint) {
  const warnings = [];
  const presets = loadLightPresets();
  const [rows, cols] = footprint;

  // Catch the "lights:" key followed by an indented `- ` block — broken YAML multi-line form.
  const yamlMultilineMatch = rawHeaderText.match(/^lights:\s*\r?\n\s+-/m);
  if (yamlMultilineMatch) {
    warnings.push({
      line: -1,
      command: 'lights',
      message:
        'multi-line YAML format is silently ignored at parse time; collapse to a single-line JSON array: lights: [{"preset":"candle","x":0.5,"y":0.5}]',
    });
    return warnings; // further checks don't apply — the value wasn't parsed
  }

  if (parsedLightsValue == null) return warnings;

  // Parsed-field shape checks
  if (!Array.isArray(parsedLightsValue)) {
    warnings.push({
      line: -1,
      command: 'lights',
      message: `lights must be a JSON array, got ${typeof parsedLightsValue}. Format: lights: [{"preset":"candle","x":0.5,"y":0.5}]`,
    });
    return warnings;
  }

  for (let i = 0; i < parsedLightsValue.length; i++) {
    const entry = parsedLightsValue[i];
    const tag = `lights[${i}]`;
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push({ line: -1, command: tag, message: 'entry must be an object' });
      continue;
    }

    // Common mistake: "type" used instead of "preset"
    if (!('preset' in entry) && 'type' in entry) {
      warnings.push({
        line: -1,
        command: tag,
        message: `uses "type" key; the light loader expects "preset". Rename "type":"${entry.type}" → "preset":"${entry.type}"`,
      });
    }

    // Required fields
    for (const f of LIGHT_FIELDS_REQUIRED) {
      if (!(f in entry)) warnings.push({ line: -1, command: tag, message: `missing required field "${f}"` });
    }

    // Preset name must exist in manifest
    if (entry.preset != null) {
      if (typeof entry.preset !== 'string') {
        warnings.push({ line: -1, command: tag, message: `preset must be a string, got ${typeof entry.preset}` });
      } else if (presets.size > 0 && !presets.has(entry.preset)) {
        warnings.push({
          line: -1,
          command: tag,
          message: `unknown preset "${entry.preset}" (not in src/lights/manifest.json)`,
        });
      }
    }

    // Coordinate bounds
    if (typeof entry.x === 'number' && (entry.x < 0 || entry.x > cols)) {
      warnings.push({ line: -1, command: tag, message: `x=${entry.x} outside footprint (0..${cols})` });
    }
    if (typeof entry.y === 'number' && (entry.y < 0 || entry.y > rows)) {
      warnings.push({ line: -1, command: tag, message: `y=${entry.y} outside footprint (0..${rows})` });
    }

    // Numeric fields
    for (const f of ['x', 'y', 'radius', 'intensity', 'dimRadius', 'angle', 'spread']) {
      if (entry[f] != null && typeof entry[f] !== 'number') {
        warnings.push({ line: -1, command: tag, message: `${f} must be a number, got ${typeof entry[f]}` });
      }
    }

    // Hex color
    if (entry.color != null) {
      if (typeof entry.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry.color)) {
        warnings.push({ line: -1, command: tag, message: `color must match #rrggbb (got "${entry.color}")` });
      }
    }

    // Falloff
    if (entry.falloff != null && !VALID_FALLOFFS.has(entry.falloff)) {
      warnings.push({
        line: -1,
        command: tag,
        message: `falloff "${entry.falloff}" invalid — expected one of: ${[...VALID_FALLOFFS].join(', ')}`,
      });
    }

    // Unknown fields (typos / ignored keys)
    for (const k of Object.keys(entry)) {
      if (!LIGHT_FIELDS_KNOWN.has(k)) {
        warnings.push({ line: -1, command: tag, message: `unknown field "${k}" (ignored by loader)` });
      }
    }
  }

  return warnings;
}

const KNOWN_HEADER_FIELDS = new Set([
  'name',
  'category',
  'footprint',
  'facing',
  'shadow',
  'blocks_light',
  'height',
  'padding',
  'lights',
  'placement',
  'room_types',
  'typical_count',
  'clusters_with',
  'notes',
]);
const KNOWN_PLACEMENTS = new Set(['wall', 'corner', 'center', 'floor', 'any']);
const KNOWN_TYPICAL_COUNTS = new Set(['single', 'few', 'many']);
const REQUIRED_HEADER_FIELDS = ['name', 'category', 'footprint'];

function checkDuplicates(listValue, fieldName, warnings) {
  if (!listValue) return;
  const parts = listValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const dups = [];
  for (const p of parts) {
    if (seen.has(p)) dups.push(p);
    else seen.add(p);
  }
  if (dups.length) {
    warnings.push({
      line: -1,
      command: fieldName,
      message: `duplicate entries: ${[...new Set(dups)].join(', ')}`,
    });
  }
}

function validateHeader(rawHeaderText, headerObj, footprint) {
  const warnings = [];

  // Required fields
  for (const f of REQUIRED_HEADER_FIELDS) {
    if (!headerObj[f] || headerObj[f] === '') {
      warnings.push({ line: -1, command: f, message: `required field "${f}" is missing` });
    }
  }

  // Unknown header fields (typos like "heights:", "blocks-light:", etc.)
  for (const key of Object.keys(headerObj)) {
    if (!KNOWN_HEADER_FIELDS.has(key)) {
      warnings.push({
        line: -1,
        command: key,
        message: `unknown header field "${key}" (ignored by loader). Known fields: ${[...KNOWN_HEADER_FIELDS].join(', ')}`,
      });
    }
  }

  // Enumerated fields
  if (headerObj.placement && !KNOWN_PLACEMENTS.has(headerObj.placement)) {
    warnings.push({
      line: -1,
      command: 'placement',
      message: `invalid placement "${headerObj.placement}" — expected one of: ${[...KNOWN_PLACEMENTS].join(', ')}`,
    });
  }
  if (headerObj.typical_count && !KNOWN_TYPICAL_COUNTS.has(headerObj.typical_count)) {
    warnings.push({
      line: -1,
      command: 'typical_count',
      message: `invalid typical_count "${headerObj.typical_count}" — expected one of: ${[...KNOWN_TYPICAL_COUNTS].join(', ')}`,
    });
  }

  // Duplicate entries in comma-separated lists
  checkDuplicates(headerObj.clusters_with, 'clusters_with', warnings);
  checkDuplicates(headerObj.room_types, 'room_types', warnings);

  // height must be a positive number if present (or 0 for flat decals)
  if (headerObj.height != null && headerObj.height !== '') {
    const h = parseFloat(headerObj.height);
    if (isNaN(h)) {
      warnings.push({ line: -1, command: 'height', message: `must be a number, got "${headerObj.height}"` });
    } else if (h < 0) {
      warnings.push({ line: -1, command: 'height', message: `must be ≥ 0, got ${h}` });
    }
  }

  // Boolean-style fields: yes/no/true/false
  for (const f of ['facing', 'shadow', 'blocks_light']) {
    const v = headerObj[f];
    if (v != null && v !== '' && !['yes', 'no', 'true', 'false'].includes(v)) {
      warnings.push({ line: -1, command: f, message: `must be yes/no/true/false, got "${v}"` });
    }
  }

  // Lights — try to JSON-parse and hand off to the deep validator
  if (headerObj.lights != null && headerObj.lights !== '') {
    let parsed = null;
    try {
      parsed = JSON.parse(headerObj.lights);
    } catch (e) {
      warnings.push({
        line: -1,
        command: 'lights',
        message: `malformed JSON: ${e.message}. Format: lights: [{"preset":"candle","x":0.5,"y":0.5}]`,
      });
      // Still run YAML-multiline detection in case the parse failed due to that
      warnings.push(...validateLightsHeader(rawHeaderText, null, footprint));
      return warnings;
    }
    warnings.push(...validateLightsHeader(rawHeaderText, parsed, footprint));
  } else {
    // Catch YAML multi-line even when headerObj.lights is empty (the common silent-failure case)
    warnings.push(...validateLightsHeader(rawHeaderText, null, footprint));
  }

  return warnings;
}

/**
 * Validate a .prop file's text content.
 */
function validatePropText(text) {
  const sepIdx = text.indexOf('---');
  if (sepIdx === -1) {
    return {
      name: 'Unknown',
      footprint: [1, 1],
      valid: false,
      warnings: [{ line: -1, command: 'header', message: 'Missing --- separator' }],
    };
  }

  const headerText = text.substring(0, sepIdx);
  const bodyText = text.substring(sepIdx + 3);

  // Full keyed header (same algorithm the runtime parser uses)
  const headerObj = {};
  for (const line of headerText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.substring(0, colonIdx).trim().toLowerCase();
    const value = trimmed.substring(colonIdx + 1).trim();
    headerObj[key] = value;
  }

  const { name, footprint, padding } = parseHeader(headerText);
  const [rows, cols] = footprint;

  const xMin = -padding;
  const xMax = cols + padding;
  const yMin = -padding;
  const yMax = rows + padding;

  const allWarnings = [];

  // Header-level checks (lights, height, booleans)
  allWarnings.push(...validateHeader(headerText, headerObj, footprint));

  // Hitbox / selection command checks (bounds, z-zones, blocks_light↔height consistency)
  allWarnings.push(...validateHitboxes(bodyText, headerObj, footprint, padding));

  // Body draw-command bounds
  let cmdIndex = 0;
  for (const line of bodyText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const cmd = parseCommandLine(trimmed);
    if (cmd) {
      const w = checkBounds(cmd, cmdIndex, xMin, xMax, yMin, yMax);
      allWarnings.push(...w);
    }
    cmdIndex++;
  }

  return { name, footprint, valid: allWarnings.length === 0, warnings: allWarnings };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const propsDir = join(__dirname, '..', 'src', 'props');

  let files;
  if (args.length > 0) {
    // Specific files provided
    files = args.map((f) => {
      // If it's just a filename, look in src/props/
      if (!f.includes('/') && !f.includes('\\')) {
        return join(propsDir, f);
      }
      return f;
    });
  } else {
    // Scan all .prop files
    files = readdirSync(propsDir)
      .filter((f) => f.endsWith('.prop'))
      .sort()
      .map((f) => join(propsDir, f));
  }

  let hasWarnings = false;
  let totalFiles = 0;
  let totalWarnings = 0;

  for (const filePath of files) {
    let text;
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch (e) {
      console.error(`\u2717 ${basename(filePath)} \u2014 could not read: ${e.message}`);
      hasWarnings = true;
      continue;
    }

    const result = validatePropText(text);
    totalFiles++;
    const fp = `${result.footprint[0]}x${result.footprint[1]}`;

    if (result.valid) {
      console.log(`\u2713 ${basename(filePath)} (${fp}) \u2014 OK`);
    } else {
      hasWarnings = true;
      totalWarnings += result.warnings.length;
      console.log(
        `\u2717 ${basename(filePath)} (${fp}) \u2014 ${result.warnings.length} warning${result.warnings.length !== 1 ? 's' : ''}:`,
      );
      for (const w of result.warnings) {
        console.log(`  [${w.line}] ${w.command}: ${w.message}`);
      }
    }
  }

  console.log('');
  console.log(
    `Scanned ${totalFiles} file${totalFiles !== 1 ? 's' : ''}${totalWarnings > 0 ? `, ${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''} found` : ', all OK'}.`,
  );

  process.exit(hasWarnings ? 1 : 0);
}

main();
