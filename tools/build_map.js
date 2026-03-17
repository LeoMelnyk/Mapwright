#!/usr/bin/env node

/**
 * Dungeon Map Build Pipeline
 *
 * Combines compilation (.map -> .mapwright) and rendering (.mapwright -> .png)
 * into a single command.
 *
 * Usage:
 *   node build_map.js <dungeon.map> [output.png]
 *   node build_map.js <dungeon.map> --check      (validate only, no output)
 *   node build_map.js <dungeon.map> --watch       (rebuild on file change)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas } from '@napi-rs/canvas';
import { compileMap } from './src/compile/compile.js';
import { validateMatrixFormat } from './src/render/validate.js';
import { calculateCanvasSize, renderDungeonToCanvas } from './src/render/compile.js';
import { THEMES } from './src/render/themes.js';
import { loadPropCatalogSync } from './src/render/prop-catalog-node.js';

// ── Prop Catalog Loading ─────────────────────────────────────────────
// The browser loads the prop catalog via fetch; in Node we read it synchronously.

const propCatalog = loadPropCatalogSync();

// ── Theme Loading ────────────────────────────────────────────────────
// The browser loads themes via fetch; in Node we read them synchronously.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const themesDir = path.join(__dirname, 'src', 'themes');

try {
  const keys = JSON.parse(fs.readFileSync(path.join(themesDir, 'manifest.json'), 'utf-8'));
  for (const key of keys) {
    try {
      const { displayName: _displayName, ...themeProps } = JSON.parse(
        fs.readFileSync(path.join(themesDir, `${key}.theme`), 'utf-8')
      );
      THEMES[key] = themeProps;
    } catch { /* skip missing/malformed themes */ }
  }
} catch (e) {
  console.warn('Warning: could not load themes:', e.message);
}

// ── Arg Parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const checkMode = args.includes('--check');
const positional = args.filter(a => !a.startsWith('--'));

const inputPath = positional[0];
const explicitOutput = positional[1];

if (!inputPath) {
  console.error('Usage: node build_map.js <dungeon.map> [output.png]');
  console.error('');
  console.error('Flags:');
  console.error('  --check   Validate only (compile but skip rendering)');
  console.error('  --watch   Rebuild automatically on file changes');
  process.exit(1);
}

if (watchMode && checkMode) {
  console.error('Error: --watch and --check are mutually exclusive.');
  process.exit(1);
}

// ── Derived Paths ───────────────────────────────────────────────────

const jsonPath = inputPath.replace(/\.map$/, '.mapwright') === inputPath
  ? inputPath + '.mapwright'
  : inputPath.replace(/\.map$/, '.mapwright');

const imagePath = explicitOutput
  ? explicitOutput
  : inputPath.replace(/\.map$/, '.png') === inputPath
    ? inputPath + '.png'
    : inputPath.replace(/\.map$/, '.png');

// ── Build Pipeline ──────────────────────────────────────────────────

function build() {
  const start = performance.now();

  // Step 1: Compile .map -> JSON
  const result = compileMap(inputPath);

  if (checkMode) {
    // Validation-only: compile succeeded (which includes reachability checks),
    // so we're done.
    const elapsed = (performance.now() - start).toFixed(0);
    console.log(`\n\u2713 Validation passed (${elapsed}ms)`);
    return;
  }

  // Step 2: Write intermediate .json (needed for the editor)
  fs.writeFileSync(jsonPath, JSON.stringify(result));

  // Step 3: Render to PNG
  validateMatrixFormat(result);

  const { width, height } = calculateCanvasSize(result);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  renderDungeonToCanvas(ctx, result, width, height, propCatalog);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(imagePath, buffer);

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`\n\u2713 Built in ${elapsed}ms`);
  console.log(`  JSON:  ${jsonPath}`);
  console.log(`  PNG:   ${imagePath}`);
}

// ── Main ────────────────────────────────────────────────────────────

try {
  build();
} catch (err) {
  console.error(`\n\u274c ${err.message}`);
  if (!watchMode) process.exit(1);
}

if (watchMode) {
  console.log(`\nWatching for changes... (${inputPath})`);

  let debounceTimer = null;

  fs.watch(inputPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.clear();
      try {
        build();
      } catch (err) {
        console.error(`\n\u274c ${err.message}`);
      }
      console.log(`\nWatching for changes... (${inputPath})`);
    }, 100);
  });
}
