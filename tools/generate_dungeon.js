#!/usr/bin/env node

/**
 * D&D Dungeon Map Generator
 *
 * Generates grid-based dungeon maps from JSON configuration using Canvas API.
 *
 * Usage: node generate_dungeon.js <path-to-mapwright>
 */

import fs from 'fs';
import { createCanvas } from '@napi-rs/canvas';

import { validateMatrixFormat } from '../src/render/validate.js';
import { calculateCanvasSize, renderDungeonToCanvas } from '../src/render/compile.js';

async function main() {
  try {
    const args = process.argv.slice(2);
    const jsonPath = args.find(a => !a.startsWith('--'));

    if (!jsonPath) {
      console.error('ERROR: No map file specified');
      console.error('Usage: node generate_dungeon.js <path-to-mapwright>');
      process.exit(1);
    }

    console.log(`Loading dungeon configuration from: ${jsonPath}`);
    const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    validateMatrixFormat(config);

    const { width, height } = calculateCanvasSize(config);
    console.log(`Canvas size: ${width}x${height} pixels`);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    console.log('Rendering dungeon map...');
    renderDungeonToCanvas(ctx, config, width, height);

    const outputPath = jsonPath.replace(/\.(mapwright|json)$/i, '.png');
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);

    console.log('Done — dungeon map generated successfully');
    console.log(`  Output: ${outputPath}`);
    process.exit(0);

  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
