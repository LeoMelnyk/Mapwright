#!/usr/bin/env node

/**
 * update-gobo-manifest.js
 *
 * Scans all .gobo files in mapwright/src/gobos/, parses each file's YAML-like
 * header, and regenerates two artifacts:
 *   - manifest.json — flat JSON array of gobo ids (sorted alphabetically)
 *   - bundle.json   — { version, gobos: { id: rawFileText } } for one-shot
 *                     client load
 *
 * Usage:  node mapwright/tools/update-gobo-manifest.js
 *
 * Run after adding/editing/renaming any .gobo file.
 */

import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOBOS_DIR = resolve(__dirname, '..', 'src', 'gobos');
const MANIFEST_PATH = join(GOBOS_DIR, 'manifest.json');
const BUNDLE_PATH = join(GOBOS_DIR, 'bundle.json');

function parseHeader(text) {
  const header = {};
  for (const line of text.split('\n')) {
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

const files = fs
  .readdirSync(GOBOS_DIR)
  .filter((f) => f.endsWith('.gobo'))
  .sort();

const ids = [];
const texts = {};
const warnings = [];

for (const file of files) {
  const id = file.replace(/\.gobo$/, '');
  const filePath = join(GOBOS_DIR, file);
  const text = fs.readFileSync(filePath, 'utf-8');
  const header = parseHeader(text);

  if (!header.pattern) {
    warnings.push(`${file}: missing 'pattern' field`);
  }
  if (!header.name) {
    warnings.push(`${file}: missing 'name' field`);
  }

  ids.push(id);
  texts[id] = text;
}

ids.sort();

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(ids) + '\n', 'utf-8');

const sorted = {};
const hasher = crypto.createHash('sha256');
for (const id of ids) {
  sorted[id] = texts[id];
  hasher.update(id);
  hasher.update('\0');
  hasher.update(texts[id]);
  hasher.update('\0');
}
const version = hasher.digest('hex').slice(0, 16);
const bundle = { version, gobos: sorted };
fs.writeFileSync(BUNDLE_PATH, JSON.stringify(bundle) + '\n', 'utf-8');
const bundleBytes = fs.statSync(BUNDLE_PATH).size;

if (warnings.length > 0) {
  console.log('Warnings:');
  for (const w of warnings) console.log(`  - ${w}`);
  console.log('');
}
console.log(`Updated gobo manifest: ${ids.length} gobos`);
console.log(`Updated gobo bundle:   ${ids.length} gobos, ${(bundleBytes / 1024).toFixed(1)} KB, version ${version}`);
