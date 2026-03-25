#!/usr/bin/env node

/**
 * update-manifest.js
 *
 * Scans all .prop files in mapwright/src/props/, parses each file's YAML-like
 * header, and regenerates mapwright/src/props/manifest.json.
 *
 * Usage:  node mapwright/tools/update-manifest.js
 *
 * The manifest is a flat JSON array of prop names (filenames without .prop),
 * sorted alphabetically. This matches the format consumed by prop-catalog.js
 * and prop-catalog-node.js.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROPS_DIR = resolve(__dirname, '..', 'src', 'props');
const MANIFEST_PATH = join(PROPS_DIR, 'manifest.json');


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

// --- Main ---

// Read all .prop files
const files = fs.readdirSync(PROPS_DIR)
  .filter(f => f.endsWith('.prop'))
  .sort();

const propNames = [];
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
}

// Sort alphabetically
propNames.sort();

// Write manifest
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(propNames) + '\n', 'utf-8');

// Print summary
const categoryCount = Object.keys(categories).length;
if (warnings.length > 0) {
  console.log('Warnings:');
  for (const w of warnings) {
    console.log(`  - ${w}`);
  }
  console.log('');
}
console.log(`Updated manifest: ${propNames.length} props across ${categoryCount} categories`);

// Print category breakdown
const sortedCategories = Object.entries(categories).sort((a, b) => a[0].localeCompare(b[0]));
for (const [cat, count] of sortedCategories) {
  console.log(`  ${cat}: ${count}`);
}
