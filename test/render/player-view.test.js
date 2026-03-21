import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderPlayerViewToBuffer, renderMapToBuffer, compareSnapshots, updateGolden } from './helpers/snapshot-compare.js';
import { cellKey } from '../../src/util/grid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = path.join(__dirname, '../snapshots/player-view');
const EXAMPLES_DIR = path.join(__dirname, '../../examples');
const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === '1';
const MAX_DIFF_PERCENT = 0.1;

/**
 * Reveal all non-null cells in a map config.
 */
function revealAllCells(config) {
  const revealed = new Set();
  const cells = config.cells;
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      if (cells[r][c]) revealed.add(cellKey(r, c));
    }
  }
  return revealed;
}

/**
 * Reveal only cells in the top-left quadrant of the map.
 */
function revealTopLeftQuadrant(config) {
  const revealed = new Set();
  const cells = config.cells;
  const midRow = Math.floor(cells.length / 2);
  const midCol = Math.floor((cells[0]?.length || 0) / 2);
  for (let r = 0; r < midRow; r++) {
    for (let c = 0; c < midCol; c++) {
      if (cells[r][c]) revealed.add(cellKey(r, c));
    }
  }
  return revealed;
}

const MAP_FILES = ['mines.mapwright', 'island.mapwright'];

describe('Player View Snapshot Tests', () => {
  describe('fully revealed (should match DM view minus labels/decorations)', () => {
    for (const mapFile of MAP_FILES) {
      it(`renders ${mapFile} with all cells revealed`, async () => {
        const mapPath = path.join(EXAMPLES_DIR, mapFile);
        if (!fs.existsSync(mapPath)) throw new Error(`Example map not found: ${mapPath}`);

        const config = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
        const revealed = revealAllCells(config);

        const goldenName = mapFile.replace(/\.(mapwright|json)$/, '-full.png');
        const goldenPath = path.join(SNAPSHOT_DIR, goldenName);
        const diffPath = path.join(SNAPSHOT_DIR, mapFile.replace(/\.(mapwright|json)$/, '-full-diff.png'));

        const buffer = await renderPlayerViewToBuffer(mapPath, revealed);
        expect(buffer.length).toBeGreaterThan(0);

        if (UPDATE_GOLDENS || !fs.existsSync(goldenPath)) {
          updateGolden(buffer, goldenPath);
          console.log(`  Golden file ${UPDATE_GOLDENS ? 'updated' : 'created'}: ${goldenName}`);
          return;
        }

        const result = compareSnapshots(buffer, goldenPath, diffPath);
        if (result.error) throw new Error(result.error);
        if (result.diffPercent > MAX_DIFF_PERCENT) {
          throw new Error(
            `Visual regression in ${mapFile} (full reveal): ${result.diffPercent.toFixed(4)}% pixels differ. Diff: ${diffPath}`
          );
        }
        if (fs.existsSync(diffPath)) fs.unlinkSync(diffPath);
      });
    }
  });

  describe('partial reveal (fog-of-war active)', () => {
    for (const mapFile of MAP_FILES) {
      it(`renders ${mapFile} with top-left quadrant revealed`, async () => {
        const mapPath = path.join(EXAMPLES_DIR, mapFile);
        if (!fs.existsSync(mapPath)) throw new Error(`Example map not found: ${mapPath}`);

        const config = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
        const revealed = revealTopLeftQuadrant(config);

        const goldenName = mapFile.replace(/\.(mapwright|json)$/, '-partial.png');
        const goldenPath = path.join(SNAPSHOT_DIR, goldenName);
        const diffPath = path.join(SNAPSHOT_DIR, mapFile.replace(/\.(mapwright|json)$/, '-partial-diff.png'));

        const buffer = await renderPlayerViewToBuffer(mapPath, revealed);
        expect(buffer.length).toBeGreaterThan(0);

        if (UPDATE_GOLDENS || !fs.existsSync(goldenPath)) {
          updateGolden(buffer, goldenPath);
          console.log(`  Golden file ${UPDATE_GOLDENS ? 'updated' : 'created'}: ${goldenName}`);
          return;
        }

        const result = compareSnapshots(buffer, goldenPath, diffPath);
        if (result.error) throw new Error(result.error);
        if (result.diffPercent > MAX_DIFF_PERCENT) {
          throw new Error(
            `Visual regression in ${mapFile} (partial reveal): ${result.diffPercent.toFixed(4)}% pixels differ. Diff: ${diffPath}`
          );
        }
        if (fs.existsSync(diffPath)) fs.unlinkSync(diffPath);
      });
    }
  });

  describe('no cells revealed (everything fogged)', () => {
    for (const mapFile of MAP_FILES) {
      it(`renders ${mapFile} as fully fogged`, async () => {
        const mapPath = path.join(EXAMPLES_DIR, mapFile);
        if (!fs.existsSync(mapPath)) throw new Error(`Example map not found: ${mapPath}`);

        const goldenName = mapFile.replace(/\.(mapwright|json)$/, '-fogged.png');
        const goldenPath = path.join(SNAPSHOT_DIR, goldenName);
        const diffPath = path.join(SNAPSHOT_DIR, mapFile.replace(/\.(mapwright|json)$/, '-fogged-diff.png'));

        const buffer = await renderPlayerViewToBuffer(mapPath, new Set());
        expect(buffer.length).toBeGreaterThan(0);

        if (UPDATE_GOLDENS || !fs.existsSync(goldenPath)) {
          updateGolden(buffer, goldenPath);
          console.log(`  Golden file ${UPDATE_GOLDENS ? 'updated' : 'created'}: ${goldenName}`);
          return;
        }

        const result = compareSnapshots(buffer, goldenPath, diffPath);
        if (result.error) throw new Error(result.error);
        if (result.diffPercent > MAX_DIFF_PERCENT) {
          throw new Error(
            `Visual regression in ${mapFile} (fogged): ${result.diffPercent.toFixed(4)}% pixels differ. Diff: ${diffPath}`
          );
        }
        if (fs.existsSync(diffPath)) fs.unlinkSync(diffPath);
      });
    }
  });
});
