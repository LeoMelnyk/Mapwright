import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderMapToBuffer, compareSnapshots, updateGolden } from './helpers/snapshot-compare.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, '../snapshots/renders');
const EXAMPLES_DIR = path.join(__dirname, '../../examples');
const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === '1';
const MAX_DIFF_PERCENT = 0.01; // 0.01% pixel difference allowed

const MAP_FILES = ['mines.json', 'island.json'];

describe('Visual Snapshot Tests', () => {
  for (const mapFile of MAP_FILES) {
    it(`renders ${mapFile} consistently`, async () => {
      const mapPath = path.join(EXAMPLES_DIR, mapFile);
      if (!fs.existsSync(mapPath)) {
        throw new Error(`Example map not found: ${mapPath}`);
      }

      const goldenName = mapFile.replace('.json', '.png');
      const goldenPath = path.join(SNAPSHOT_DIR, goldenName);
      const diffPath = path.join(SNAPSHOT_DIR, mapFile.replace('.json', '-diff.png'));

      const buffer = await renderMapToBuffer(mapPath);
      expect(buffer.length).toBeGreaterThan(0);

      if (UPDATE_GOLDENS || !fs.existsSync(goldenPath)) {
        updateGolden(buffer, goldenPath);
        console.log(`  Golden file ${UPDATE_GOLDENS ? 'updated' : 'created'}: ${goldenName}`);
        return;
      }

      const result = compareSnapshots(buffer, goldenPath, diffPath);

      if (result.error) {
        throw new Error(result.error);
      }

      if (result.diffPercent > MAX_DIFF_PERCENT) {
        throw new Error(
          `Visual regression in ${mapFile}: ${result.diffPercent.toFixed(4)}% pixels differ ` +
          `(${result.diffPixelCount}/${result.totalPixels}). ` +
          `Diff image saved to: ${diffPath}`
        );
      }

      // Clean up diff image if test passes
      if (fs.existsSync(diffPath)) {
        fs.unlinkSync(diffPath);
      }
    });
  }
});
