#!/usr/bin/env node

/**
 * update-themes-manifest.js
 *
 * Scans all .theme files in mapwright/src/themes/ and regenerates two
 * derived artifacts:
 *   - manifest.json — flat JSON array of theme keys (sorted alphabetically)
 *   - bundle.json   — { version, themes: { key: parsedThemeObject } } for
 *                     one-shot client load (avoids 16 separate HTTP fetches
 *                     at startup)
 *
 * Usage:  node mapwright/tools/update-themes-manifest.js
 *
 * Run this script after adding, editing, or renaming any .theme file so the
 * client sees the change on its next load. The editor fetches bundle.json
 * first and falls back to per-file fetches if the bundle is missing.
 *
 * User-created themes (stored outside src/themes/, under MAPWRIGHT_THEME_PATH)
 * are not part of this bundle — they continue to load dynamically via
 * /api/user-themes.
 */

import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = resolve(__dirname, '..', 'src', 'themes');
const MANIFEST_PATH = join(THEMES_DIR, 'manifest.json');
const BUNDLE_PATH = join(THEMES_DIR, 'bundle.json');

const files = fs.readdirSync(THEMES_DIR)
  .filter(f => f.endsWith('.theme'))
  .sort();

const themeKeys = [];
const themeObjects = {};
const warnings = [];

for (const file of files) {
  const key = file.replace(/\.theme$/, '');
  const filePath = join(THEMES_DIR, file);
  const text = fs.readFileSync(filePath, 'utf-8');

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    warnings.push(`${file}: invalid JSON (${e.message}), skipping`);
    continue;
  }

  if (!data.displayName) {
    warnings.push(`${file}: missing 'displayName' field`);
  }

  themeKeys.push(key);
  themeObjects[key] = data;
}

themeKeys.sort();

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(themeKeys) + '\n', 'utf-8');

const sortedThemes = {};
const hasher = crypto.createHash('sha256');
for (const key of themeKeys) {
  sortedThemes[key] = themeObjects[key];
  hasher.update(key);
  hasher.update('\0');
  hasher.update(JSON.stringify(themeObjects[key]));
  hasher.update('\0');
}
const bundleVersion = hasher.digest('hex').slice(0, 16);
const bundle = { version: bundleVersion, themes: sortedThemes };
fs.writeFileSync(BUNDLE_PATH, JSON.stringify(bundle) + '\n', 'utf-8');
const bundleBytes = fs.statSync(BUNDLE_PATH).size;

if (warnings.length > 0) {
  console.log('Warnings:');
  for (const w of warnings) console.log(`  - ${w}`);
  console.log('');
}
console.log(`Updated manifest: ${themeKeys.length} themes`);
console.log(`Updated bundle:   ${themeKeys.length} themes, ${(bundleBytes / 1024).toFixed(1)} KB, version ${bundleVersion}`);
for (const key of themeKeys) console.log(`  ${key}`);
