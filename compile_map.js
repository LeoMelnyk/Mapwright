#!/usr/bin/env node

/**
 * Dungeon Map Compiler
 *
 * Compiles an ASCII .map file into the matrix JSON format
 * understood by generate_dungeon.js.
 *
 * Input:  .map file (ASCII grid + legend + doors + trims)
 * Output: Matrix JSON (cells with borders, doors, labels)
 *
 * Usage: node compile_map.js <dungeon.map> [output.json]
 *        node compile_map.js <dungeon.map> --check   (validate only)
 */

import fs from 'fs';
import { compileMap } from './src/compile/compile.js';

// ── Entry Point ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const positional = args.filter(a => !a.startsWith('--'));

const inputPath = positional[0];
if (!inputPath) {
  console.error('Usage: node compile_map.js <dungeon.map> [output.json]');
  console.error('       node compile_map.js <dungeon.map> --check');
  console.error('');
  console.error('Flags:');
  console.error('  --check   Validate only (compile but don\'t write output)');
  console.error('');
  console.error('Map format:');
  console.error('  --- header (name, theme, features) ---');
  console.error('  ASCII grid (. = void, -/# = walled corridor, = = open corridor)');
  console.error('  legend: char → room label');
  console.error('  doors: col,row: door|secret');
  console.error('  trims: label: corner, corner, ...');
  console.error('  stairs: col,row: up|down');
  process.exit(1);
}

try {
  const result = compileMap(inputPath);

  if (checkMode) {
    console.log(`\n✓ Validation passed`);
    process.exit(0);
  }

  let outputPath = positional[1];
  if (!outputPath) {
    outputPath = inputPath.replace(/\.map$/, '.json');
    if (outputPath === inputPath) {
      outputPath = inputPath + '.json';
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`\n✓ Compiled → ${outputPath}`);
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
