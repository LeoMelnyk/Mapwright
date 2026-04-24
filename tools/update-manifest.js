#!/usr/bin/env node

/**
 * update-manifest.js
 *
 * Scans all .prop files in mapwright/src/props/, parses each file's YAML-like
 * header, and regenerates two artifacts:
 *   - manifest.json — flat JSON array of prop names (sorted alphabetically)
 *   - bundle.json   — { version, props: { name: { text, autoHitbox?, hitbox?,
 *                     hitboxZones?, selectionHitbox? } } } for one-shot client
 *                     load with precomputed hitbox polygons (avoids ~900ms of
 *                     main-thread hitching during editor startup).
 *
 * Usage:  node --import tsx mapwright/tools/update-manifest.js
 *
 * Must run through the tsx loader so imports from `../src/render/props.ts`
 * resolve. Run this script after adding, editing, or renaming any .prop file
 * so the client sees the change on its next load. The editor fetches
 * bundle.json first and falls back to per-file fetches if the bundle is
 * missing.
 */

import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { parsePropFile, materializePropHitbox } from '../src/render/props.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROPS_DIR = resolve(__dirname, '..', 'src', 'props');
const MANIFEST_PATH = join(PROPS_DIR, 'manifest.json');
const BUNDLE_PATH = join(PROPS_DIR, 'bundle.json');

/**
 * Parse the YAML-like header from a .prop file (everything before the --- separator).
 * Returns an object with extracted fields, or null if parsing fails.
 */
function parseHeader(text) {
  const sepIndex = text.indexOf('\n---');
  if (sepIndex === -1) return null;

  const headerText = text.slice(0, sepIndex);
  const header = {};

  for (const line of headerText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    header[key] = value;
  }

  return header;
}

/**
 * JSON replacer that serializes Infinity as the literal string "Infinity" so
 * hitboxZones with zTop = Infinity survive the round-trip. The client reads
 * these back as strings and the lighting engine handles the sentinel (or we
 * convert on read). We coerce here to keep the bundle JSON-spec compliant.
 */
function finiteZone(zone) {
  return {
    polygon: zone.polygon,
    zBottom: zone.zBottom,
    zTop: Number.isFinite(zone.zTop) ? zone.zTop : null,
  };
}

// --- Main ---

// Read all .prop files
const files = fs
  .readdirSync(PROPS_DIR)
  .filter((f) => f.endsWith('.prop'))
  .sort();

const propNames = [];
const propTexts = {};
const categories = {};
const warnings = [];

for (const file of files) {
  const name = file.replace(/\.prop$/, '');
  const filePath = join(PROPS_DIR, file);
  const text = fs.readFileSync(filePath, 'utf-8');
  const header = parseHeader(text);

  if (!header) {
    warnings.push(`${file}: no --- separator found, skipping`);
    continue;
  }

  if (!header.name) {
    warnings.push(`${file}: missing 'name' field`);
  }
  if (!header.category) {
    warnings.push(`${file}: missing 'category' field`);
  }

  // Track categories
  const category = header.category || 'Uncategorized';
  categories[category] = (categories[category] || 0) + 1;

  propNames.push(name);
  propTexts[name] = text;
}

// Sort alphabetically
propNames.sort();

// Write manifest
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(propNames) + '\n', 'utf-8');

// Bake hitboxes alongside raw text so the client avoids ~900ms of convex-hull
// rasterization at startup. For each prop we parse, materialize, and record
// only the expensive-to-compute fields (text + hitbox polygons).
const sortedProps = {};
const hasher = crypto.createHash('sha256');
const hitboxFailures = [];
let bakedWith = 0;

for (const name of propNames) {
  const text = propTexts[name];
  const entry = { text };
  try {
    const def = parsePropFile(text);
    materializePropHitbox(def);
    if (def.autoHitbox) entry.autoHitbox = def.autoHitbox;
    if (def.hitbox && def.hitbox !== def.autoHitbox) entry.hitbox = def.hitbox;
    if (def.hitboxZones) entry.hitboxZones = def.hitboxZones.map(finiteZone);
    if (def.selectionHitbox) entry.selectionHitbox = def.selectionHitbox;
    if (entry.autoHitbox || entry.hitbox || entry.hitboxZones || entry.selectionHitbox) {
      bakedWith++;
    }
  } catch (e) {
    hitboxFailures.push(`${name}: ${e.message}`);
  }
  sortedProps[name] = entry;

  // Version hash covers name + raw text + serialized hitbox payload so any
  // change (prop edit or hitbox algorithm change) busts client caches.
  hasher.update(name);
  hasher.update('\0');
  hasher.update(text);
  hasher.update('\0');
  hasher.update(JSON.stringify(entry));
  hasher.update('\0');
}

const bundleVersion = hasher.digest('hex').slice(0, 16);
const bundle = { version: bundleVersion, props: sortedProps };
fs.writeFileSync(BUNDLE_PATH, JSON.stringify(bundle) + '\n', 'utf-8');
const bundleBytes = fs.statSync(BUNDLE_PATH).size;

// Print summary
const categoryCount = Object.keys(categories).length;
if (warnings.length > 0) {
  console.log('Warnings:');
  for (const w of warnings) {
    console.log(`  - ${w}`);
  }
  console.log('');
}
if (hitboxFailures.length > 0) {
  console.log('Hitbox bake failures:');
  for (const f of hitboxFailures) {
    console.log(`  - ${f}`);
  }
  console.log('');
}
console.log(`Updated manifest: ${propNames.length} props across ${categoryCount} categories`);
console.log(
  `Updated bundle:   ${propNames.length} props (${bakedWith} with baked hitboxes), ${(bundleBytes / 1024).toFixed(1)} KB, version ${bundleVersion}`,
);

// Print category breakdown
const sortedCategories = Object.entries(categories).sort((a, b) => a[0].localeCompare(b[0]));
for (const [cat, count] of sortedCategories) {
  console.log(`  ${cat}: ${count}`);
}
