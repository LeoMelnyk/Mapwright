import fs from 'fs';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { calculateCanvasSize, renderDungeonToCanvas } from '../../../src/render/compile.js';
import { loadPropCatalogSync } from '../../../src/render/prop-catalog-node.js';

let propCatalog = null;

function getPropCatalog() {
  if (!propCatalog) {
    propCatalog = loadPropCatalogSync();
  }
  return propCatalog;
}

/**
 * Render a dungeon JSON file to a PNG buffer.
 * Textures are skipped (not in repo) — renders walls, doors, fills, props, lighting.
 */
export async function renderMapToBuffer(jsonPath) {
  const config = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const { width, height } = calculateCanvasSize(config);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  renderDungeonToCanvas(ctx, config, width, height, getPropCatalog(), null);

  return canvas.toBuffer('image/png');
}

/**
 * Compare a rendered PNG buffer against a golden file.
 * Returns { match, diffPixelCount, totalPixels, diffPercent }.
 * Optionally writes a diff image if diffOutputPath is provided.
 */
export function compareSnapshots(actualBuffer, goldenPath, diffOutputPath) {
  const actual = PNG.sync.read(actualBuffer);
  const golden = PNG.sync.read(fs.readFileSync(goldenPath));

  if (actual.width !== golden.width || actual.height !== golden.height) {
    return {
      match: false,
      diffPixelCount: actual.width * actual.height,
      totalPixels: actual.width * actual.height,
      diffPercent: 100,
      error: `Size mismatch: actual ${actual.width}x${actual.height} vs golden ${golden.width}x${golden.height}`,
    };
  }

  const { width, height } = actual;
  const totalPixels = width * height;
  const diff = new PNG({ width, height });

  const diffPixelCount = pixelmatch(
    actual.data, golden.data, diff.data,
    width, height,
    { threshold: 0.1 }
  );

  if (diffOutputPath && diffPixelCount > 0) {
    fs.mkdirSync(path.dirname(diffOutputPath), { recursive: true });
    fs.writeFileSync(diffOutputPath, PNG.sync.write(diff));
  }

  return {
    match: diffPixelCount === 0,
    diffPixelCount,
    totalPixels,
    diffPercent: (diffPixelCount / totalPixels) * 100,
  };
}

/**
 * Write a PNG buffer as a golden file.
 */
export function updateGolden(buffer, goldenPath) {
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
  fs.writeFileSync(goldenPath, buffer);
}
