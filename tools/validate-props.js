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

/**
 * Validate a .prop file's text content.
 */
function validatePropText(text) {
  const sepIdx = text.indexOf('---');
  if (sepIdx === -1) {
    return { name: 'Unknown', footprint: [1, 1], valid: false, warnings: [{ line: -1, command: 'header', message: 'Missing --- separator' }] };
  }

  const headerText = text.substring(0, sepIdx);
  const bodyText = text.substring(sepIdx + 3);
  const { name, footprint, padding } = parseHeader(headerText);
  const [rows, cols] = footprint;

  const xMin = -padding;
  const xMax = cols + padding;
  const yMin = -padding;
  const yMax = rows + padding;

  const allWarnings = [];
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
    files = args.map(f => {
      // If it's just a filename, look in src/props/
      if (!f.includes('/') && !f.includes('\\')) {
        return join(propsDir, f);
      }
      return f;
    });
  } else {
    // Scan all .prop files
    files = readdirSync(propsDir)
      .filter(f => f.endsWith('.prop'))
      .sort()
      .map(f => join(propsDir, f));
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
      console.log(`\u2717 ${basename(filePath)} (${fp}) \u2014 ${result.warnings.length} warning${result.warnings.length !== 1 ? 's' : ''}:`);
      for (const w of result.warnings) {
        console.log(`  [${w.line}] ${w.command}: ${w.message}`);
      }
    }
  }

  console.log('');
  console.log(`Scanned ${totalFiles} file${totalFiles !== 1 ? 's' : ''}${totalWarnings > 0 ? `, ${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''} found` : ', all OK'}.`);

  process.exit(hasWarnings ? 1 : 0);
}

main();
