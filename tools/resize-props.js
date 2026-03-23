#!/usr/bin/env node
/**
 * Resize prop footprints and scale draw commands for half-cell resolution.
 * Reads prop-resize-plan.json, updates each .prop file in src/props/.
 *
 * Usage: node tools/resize-props.js [--dry-run]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = path.join(__dirname, 'prop-resize-plan.json');
const PROPS_DIR = path.join(__dirname, '..', 'src', 'props');
const DRY_RUN = process.argv.includes('--dry-run');

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf-8'));

let changed = 0, skipped = 0, notFound = 0;

for (const [propName, info] of Object.entries(plan.props)) {
  const propPath = path.join(PROPS_DIR, `${propName}.prop`);
  if (!fs.existsSync(propPath)) {
    console.log(`  SKIP ${propName} — file not found`);
    notFound++;
    continue;
  }

  const [oldRows, oldCols] = info.old;
  const [newRows, newCols] = info.new;

  if (oldRows === newRows && oldCols === newCols) {
    skipped++;
    continue;
  }

  const scaleX = newCols / oldCols;
  const scaleY = newRows / oldRows;

  const raw = fs.readFileSync(propPath, 'utf-8');
  const parts = raw.split(/^---$/m);
  if (parts.length < 2) {
    console.log(`  SKIP ${propName} — no --- separator found`);
    skipped++;
    continue;
  }

  // Update YAML header: footprint field
  let header = parts[0];
  header = header.replace(
    /footprint:\s*\d+x\d+/,
    `footprint: ${newRows}x${newCols}`
  );

  // Scale draw commands
  const body = parts.slice(1).join('---');
  const lines = body.split('\n');
  const scaledLines = lines.map(line => scalePropCommand(line, scaleX, scaleY));

  const result = header + '---' + scaledLines.join('\n');

  if (DRY_RUN) {
    console.log(`  WOULD UPDATE ${propName}: ${oldRows}x${oldCols} → ${newRows}x${newCols} (sx=${scaleX}, sy=${scaleY})`);
  } else {
    fs.writeFileSync(propPath, result, 'utf-8');
    console.log(`  UPDATED ${propName}: ${oldRows}x${oldCols} → ${newRows}x${newCols}`);
  }
  changed++;
}

console.log(`\nDone: ${changed} updated, ${skipped} unchanged, ${notFound} not found.`);
if (DRY_RUN) console.log('(dry run — no files written)');

// ─── Draw command scaling ───────────────────────────────────────────────────

/**
 * Scale coordinates in a single draw command line.
 * Handles: rect, circle, ellipse, line, arc, polygon, text, shadow-*, roundrect
 */
function scalePropCommand(line, sx, sy) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return line;

  // Detect command type
  const match = trimmed.match(/^(\w[\w-]*)\s+(.*)$/);
  if (!match) return line;

  const [, cmd, rest] = match;
  const indent = line.match(/^(\s*)/)[1];

  try {
    switch (cmd) {
      case 'rect':
      case 'roundrect':
        return indent + scaleRect(cmd, rest, sx, sy);
      case 'circle':
        return indent + scaleCircle(rest, sx, sy);
      case 'ellipse':
        return indent + scaleEllipse(rest, sx, sy);
      case 'line':
        return indent + scaleLine(rest, sx, sy);
      case 'arc':
        return indent + scaleArc(rest, sx, sy);
      case 'polygon':
        return indent + scalePolygon(rest, sx, sy);
      case 'text':
        return indent + scaleText(rest, sx, sy);
      case 'shadow-rect':
        return indent + scaleShadowRect(rest, sx, sy);
      case 'shadow-circle':
        return indent + scaleShadowCircle(rest, sx, sy);
      case 'shadow-ellipse':
        return indent + scaleShadowEllipse(rest, sx, sy);
      case 'shadow-polygon':
        return indent + scaleShadowPolygon(rest, sx, sy);
      case 'shadow-roundrect':
        return indent + scaleRect('shadow-roundrect', rest, sx, sy);
      default:
        return line; // Unknown command — leave unchanged
    }
  } catch (e) {
    console.warn(`    WARNING: failed to scale "${trimmed}": ${e.message}`);
    return line;
  }
}

function r(n) { return +parseFloat(n).toFixed(4); }

function scaleCoord(str, sx, sy) {
  const [x, y] = str.split(',');
  return `${r(parseFloat(x) * sx)},${r(parseFloat(y) * sy)}`;
}

function scaleRect(cmd, rest, sx, sy) {
  // rect x,y w,h [fill|stroke|texfill ...] [radius]
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy); // position
  const [w, h] = tokens[1].split(',');
  tokens[1] = `${r(parseFloat(w) * sx)},${r(parseFloat(h) * sy)}`; // size
  return `${cmd} ${tokens.join(' ')}`;
}

function scaleCircle(rest, sx, sy) {
  // circle cx,cy radius [fill|stroke|texfill ...]
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy); // center
  const radius = parseFloat(tokens[1]);
  // Scale radius by average of sx/sy for non-uniform scaling
  tokens[1] = `${r(radius * (sx + sy) / 2)}`;
  return `circle ${tokens.join(' ')}`;
}

function scaleEllipse(rest, sx, sy) {
  // ellipse cx,cy rx,ry [fill|stroke ...]
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy);
  const [rx, ry] = tokens[1].split(',');
  tokens[1] = `${r(parseFloat(rx) * sx)},${r(parseFloat(ry) * sy)}`;
  return `ellipse ${tokens.join(' ')}`;
}

function scaleLine(rest, sx, sy) {
  // line x1,y1 x2,y2 [stroke ...] [width]
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy);
  tokens[1] = scaleCoord(tokens[1], sx, sy);
  // Scale line width if present (look for a number after color)
  for (let i = 2; i < tokens.length; i++) {
    if (/^\d+(\.\d+)?$/.test(tokens[i]) && i >= 3) {
      tokens[i] = `${r(parseFloat(tokens[i]) * (sx + sy) / 2)}`;
      break;
    }
  }
  return `line ${tokens.join(' ')}`;
}

function scaleArc(rest, sx, sy) {
  // arc cx,cy radius startAngle endAngle [stroke ...]
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy);
  tokens[1] = `${r(parseFloat(tokens[1]) * (sx + sy) / 2)}`;
  return `arc ${tokens.join(' ')}`;
}

function scalePolygon(rest, sx, sy) {
  // polygon x1,y1 x2,y2 ... [fill|stroke ...]
  const tokens = rest.split(/\s+/);
  const scaled = tokens.map(t => {
    if (t.includes(',') && !t.startsWith('#') && !t.startsWith('polyhaven')) {
      return scaleCoord(t, sx, sy);
    }
    return t;
  });
  return `polygon ${scaled.join(' ')}`;
}

function scaleText(rest, sx, sy) {
  // text x,y "content" [size] [fill ...]
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy);
  // Scale font size if present
  for (let i = 1; i < tokens.length; i++) {
    if (/^\d+(\.\d+)?$/.test(tokens[i]) && !tokens[i - 1]?.startsWith('"')) {
      tokens[i] = `${r(parseFloat(tokens[i]) * (sx + sy) / 2)}`;
      break;
    }
  }
  return `text ${tokens.join(' ')}`;
}

function scaleShadowRect(rest, sx, sy) {
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy);
  const [w, h] = tokens[1].split(',');
  tokens[1] = `${r(parseFloat(w) * sx)},${r(parseFloat(h) * sy)}`;
  return `shadow-rect ${tokens.join(' ')}`;
}

function scaleShadowCircle(rest, sx, sy) {
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy);
  tokens[1] = `${r(parseFloat(tokens[1]) * (sx + sy) / 2)}`;
  return `shadow-circle ${tokens.join(' ')}`;
}

function scaleShadowEllipse(rest, sx, sy) {
  const tokens = rest.split(/\s+/);
  tokens[0] = scaleCoord(tokens[0], sx, sy);
  const [rx, ry] = tokens[1].split(',');
  tokens[1] = `${r(parseFloat(rx) * sx)},${r(parseFloat(ry) * sy)}`;
  return `shadow-ellipse ${tokens.join(' ')}`;
}

function scaleShadowPolygon(rest, sx, sy) {
  const tokens = rest.split(/\s+/);
  const scaled = tokens.map(t => {
    if (t.includes(',') && !t.startsWith('#')) {
      return scaleCoord(t, sx, sy);
    }
    return t;
  });
  return `shadow-polygon ${scaled.join(' ')}`;
}
