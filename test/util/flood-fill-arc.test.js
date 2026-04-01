import { describe, it, expect } from 'vitest';
import { floodFillRoom, cellKey } from '../../src/util/grid.js';
import { migrateToLatest } from '../../src/editor/js/migrations.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Reconstruct a 2D cells array from a fog debug JSON dump.
 * The dump has cells[rowIdx][colIdx] = { r, c, type, ...cellProps }.
 */
function loadCellsFromDump(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const { r1, c1, r2, c2, cells: dumpCells } = data;
  const numRows = r2 + 1;
  const numCols = c2 + 1;
  const cells = Array.from({ length: numRows }, () => Array(numCols).fill(null));

  for (const row of dumpCells) {
    for (const entry of row) {
      if (entry.type === 'null') continue;
      const { r, c, type, revealed, ...props } = entry;
      cells[r][c] = props;
    }
  }
  return { cells, r1, c1, r2, c2 };
}

/**
 * Load expected fog state from a dump that has `revealed` flags on each cell.
 * Returns a Map of "r,c" -> boolean (true = should be revealed).
 */
function loadExpectedFogState(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const expected = new Map();
  for (const row of data.cells) {
    for (const entry of row) {
      if (entry.type === 'null') continue;
      expected.set(cellKey(entry.r, entry.c), !!entry.revealed);
    }
  }
  return expected;
}

/** Find a labeled cell in the grid. */
function findLabel(cells, label) {
  for (let r = 0; r < cells.length; r++)
    for (let c = 0; c < (cells[r]?.length || 0); c++)
      if (cells[r]?.[c]?.center?.label === label) return { r, c };
  return null;
}

/**
 * Run floodFillRoom and compare against expected fog state.
 * Returns { wronglyFogged, wronglyRevealed } arrays of descriptive strings.
 */
function runFogAndCompare(cells, startRow, startCol, expected) {
  const filled = floodFillRoom(cells, startRow, startCol);
  const wronglyFogged = [];   // should be revealed but BFS missed
  const wronglyRevealed = []; // should be fogged but BFS included

  for (const [key, shouldBeRevealed] of expected) {
    const isRevealed = filled.has(key);
    if (shouldBeRevealed && !isRevealed) {
      const [r, c] = key.split(',').map(Number);
      const cell = cells[r]?.[c];
      wronglyFogged.push(`(${r},${c})${cell?.trimWall ? ' trimWall' : ''}${cell?.trimCorner ? ' ' + cell.trimCorner : ''}`);
    } else if (!shouldBeRevealed && isRevealed) {
      wronglyRevealed.push(`(${key})`);
    }
  }
  return { wronglyFogged, wronglyRevealed };
}

// ── Circular room fog reveal ───────────────────────────────────────────────

describe('floodFillRoom — circular room fog reveal', () => {
  const seedFile = resolve(__dirname, 'fixtures/circular-room-seed.json');
  const { cells } = loadCellsFromDump(seedFile);

  const a1 = findLabel(cells, 'A1');
  const a2 = findLabel(cells, 'A2');

  it('finds A1 and A2 labels', () => {
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
  });

  describe('inside reveal (from A2 — room center)', () => {
    const expectedFile = resolve(__dirname, 'fixtures/circular-room-inside-fog.json');
    const expected = loadExpectedFogState(expectedFile);

    it('reveals exactly the expected cells (no false negatives)', () => {
      const { wronglyFogged } = runFogAndCompare(cells, a2.r, a2.c, expected);
      if (wronglyFogged.length > 0) {
        console.log(`Wrongly FOGGED (${wronglyFogged.length}):`, wronglyFogged.slice(0, 20).join(', '));
      }
      expect(wronglyFogged).toHaveLength(0);
    });

    it('does not over-reveal cells (no false positives)', () => {
      const { wronglyRevealed } = runFogAndCompare(cells, a2.r, a2.c, expected);
      if (wronglyRevealed.length > 0) {
        console.log(`Wrongly REVEALED (${wronglyRevealed.length}):`, wronglyRevealed.slice(0, 20).join(', '));
      }
      expect(wronglyRevealed).toHaveLength(0);
    });
  });

  describe('outside reveal (from A1 — bottom-left corner)', () => {
    const expectedFile = resolve(__dirname, 'fixtures/circular-room-outside-fog.json');
    const expected = loadExpectedFogState(expectedFile);

    it('reveals exactly the expected cells (no false negatives)', () => {
      const { wronglyFogged } = runFogAndCompare(cells, a1.r, a1.c, expected);
      if (wronglyFogged.length > 0) {
        console.log(`Wrongly FOGGED (${wronglyFogged.length}):`, wronglyFogged.slice(0, 20).join(', '));
      }
      expect(wronglyFogged).toHaveLength(0);
    });

    it('does not over-reveal cells (no false positives)', () => {
      const { wronglyRevealed } = runFogAndCompare(cells, a1.r, a1.c, expected);
      if (wronglyRevealed.length > 0) {
        console.log(`Wrongly REVEALED (${wronglyRevealed.length}):`, wronglyRevealed.slice(0, 20).join(', '));
      }
      expect(wronglyRevealed).toHaveLength(0);
    });
  });
});

// ── Legacy island.mapwright test ───────────────────────────────────────────

describe('floodFillRoom — open round trim (island.mapwright)', () => {
  const mapData = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/island.mapwright'), 'utf8'));
  migrateToLatest(mapData);
  const cells = mapData.cells;
  const expected = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/fog-after-island.json'), 'utf8'));

  const a7 = findLabel(cells, 'A7');

  it('finds A7 label for exterior start', () => {
    expect(a7).not.toBeNull();
  });

  it('exterior flood fill does not fog any expected-revealed cells', () => {
    const filled = floodFillRoom(cells, a7.r, a7.c);
    const wronglyFogged = [];
    for (const row of expected.cells) {
      for (const cell of row) {
        const key = cellKey(cell.r, cell.c);
        if (cell.revealed && !filled.has(key)) {
          wronglyFogged.push(`(${cell.r},${cell.c}) ${cell.type}${cell.corner ? ' ' + cell.corner : ''}`);
        }
      }
    }
    if (wronglyFogged.length > 0) console.log('Should be REVEALED but fogged:', wronglyFogged.join(', '));
    expect(wronglyFogged).toHaveLength(0);
  });
});
