import { describe, it, expect } from 'vitest';
import { floodFillRoom, cellKey, CARDINAL_DIRS, OPPOSITE, blockedByDiagonal, lockDiagonalHalf } from '../../src/util/grid.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Reconstruct a 2D cells array from the fog debug JSON dump.
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
 * Load expected texture state from correct.json.
 * Returns a Map of "r,c" -> { texture, textureSecondary }.
 */
function loadExpected(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const expected = new Map();
  for (const row of data.cells) {
    for (const cell of row) {
      if (cell.type === 'null') continue;
      expected.set(`${cell.r},${cell.c}`, {
        texture: cell.texture || null,
        textureSecondary: cell.textureSecondary || null,
      });
    }
  }
  return expected;
}

// Room-side directions for each trim corner
const TRIM_ROOM_DIRS = {
  nw: new Set(['south', 'east']),
  ne: new Set(['south', 'west']),
  sw: new Set(['north', 'east']),
  se: new Set(['north', 'west']),
};

const FILL_DIRS = CARDINAL_DIRS;

/**
 * Determine halfKey for an arc wall cell based on entry direction.
 * Uses trimCrossing with trimCorner fallback (mirrors paint tool logic).
 */
function halfKeyFromEntry(cell, entryDir) {
  if (cell.trimWall && cell.trimCorner) {
    if (cell.trimCrossing) {
      const exits = cell.trimCrossing[entryDir?.[0]] ?? '';
      const roomDirs = TRIM_ROOM_DIRS[cell.trimCorner];
      const reachesRoom = [...roomDirs].some(d => exits.includes(d[0]));
      const reachesVoid = ['north','south','east','west']
        .filter(d => !roomDirs.has(d))
        .some(d => exits.includes(d[0]));
      if (reachesRoom && reachesVoid) {
        return roomDirs.has(entryDir) ? 'texture' : 'textureSecondary';
      }
      return reachesRoom ? 'texture' : 'textureSecondary';
    }
    const roomDirs = TRIM_ROOM_DIRS[cell.trimCorner];
    return roomDirs.has(entryDir) ? 'texture' : 'textureSecondary';
  }
  if (cell.trimCorner) return 'texture';
  if (cell['nw-se']) return (entryDir === 'north' || entryDir === 'east') ? 'texture' : 'textureSecondary';
  if (cell['ne-sw']) return (entryDir === 'north' || entryDir === 'west') ? 'texture' : 'textureSecondary';
  return null;
}

/**
 * Simulate the paint tool's texture flood fill.
 * Returns a Map of "r,c" -> halfKey ('texture' or 'textureSecondary').
 */
function simulateTextureFill(cells, startRow, startCol, textureId) {
  const startCell = cells[startRow]?.[startCol];
  if (!startCell) return new Map();

  // Main BFS (same as paint tool)
  const filledCells = new Set([cellKey(startRow, startCol)]);
  const toFill = [[startRow, startCol, null]];
  const queue = [[startRow, startCol, null]];
  const visitedTraversal = new Set([`${startRow},${startCol},`]);
  lockDiagonalHalf(visitedTraversal, startRow, startCol, null, startCell);

  while (queue.length > 0) {
    const [r, c, entryDir] = queue.shift();
    const cell = cells[r]?.[c];
    if (!cell) continue;

    const diagonalBlocked = blockedByDiagonal(cell, entryDir);

    // Arc wall exit blocking
    let arcExits = null;
    if (cell.trimCrossing) {
      arcExits = cell.trimCrossing[entryDir?.[0]] ?? '';
    }

    for (const { dir, dr, dc } of FILL_DIRS) {
      if (cell[dir]) continue;
      if (diagonalBlocked.has(dir)) continue;
      if (arcExits !== null && !arcExits.includes(dir[0])) continue;

      const nr = r + dr, nc = c + dc;
      const neighborEntryDir = OPPOSITE[dir];
      const tKey = `${nr},${nc},${neighborEntryDir}`;
      if (visitedTraversal.has(tKey)) continue;
      visitedTraversal.add(tKey);
      if (!cells[nr]?.[nc]) continue;

      const neighborCell = cells[nr][nc];
      if (neighborCell[neighborEntryDir]) continue;

      // Lock arc cells
      if (neighborCell.trimCrossing) {
        const tc = neighborCell.trimCrossing;
        const myExits = tc[neighborEntryDir[0]] ?? '';
        for (const ld of ['north', 'south', 'east', 'west']) {
          if (ld === neighborEntryDir) continue;
          if ((tc[ld[0]] ?? '') !== myExits) visitedTraversal.add(`${nr},${nc},${ld}`);
        }
      }
      if (neighborCell.trimWall) continue; // skip arc cells — post-pass handles them

      lockDiagonalHalf(visitedTraversal, nr, nc, neighborEntryDir, neighborCell);
      queue.push([nr, nc, neighborEntryDir]);

      const fillKey = cellKey(nr, nc);
      if (!filledCells.has(fillKey)) {
        filledCells.add(fillKey);
        const halfKey = halfKeyFromEntry(neighborCell, neighborEntryDir);
        toFill.push([nr, nc, halfKey]);
      }
    }
  }

  const mainFillCells = new Set(filledCells);

  // Arc post-pass: determine side by checking if fill reached the center of NEARBY arcs
  let arcMinR = Infinity, arcMaxR = 0, arcMinC = Infinity, arcMaxC = 0;
  let hasNearbyArc = false;
  for (const k of mainFillCells) {
    const [fr, fc] = k.split(',').map(Number);
    for (const { dr, dc } of FILL_DIRS) {
      const nr = fr + dr, nc = fc + dc;
      if (cells[nr]?.[nc]?.trimWall) {
        hasNearbyArc = true;
        arcMinR = Math.min(arcMinR, nr); arcMaxR = Math.max(arcMaxR, nr);
        arcMinC = Math.min(arcMinC, nc); arcMaxC = Math.max(arcMaxC, nc);
      }
    }
  }
  let arcHalfKey = 'texture';
  if (hasNearbyArc) {
    const centerR = Math.floor((arcMinR + arcMaxR) / 2);
    const centerC = Math.floor((arcMinC + arcMaxC) / 2);
    const centerCell = cells[centerR]?.[centerC];
    const centerIsInside = mainFillCells.has(cellKey(centerR, centerC))
      && centerCell && !centerCell.trimWall;
    arcHalfKey = centerIsInside ? 'texture' : 'textureSecondary';
  }

  const arcVisited = new Set();
  const arcQueue = [];
  for (const k of mainFillCells) {
    const [fr, fc] = k.split(',').map(Number);
    if (cells[fr]?.[fc]?.trimWall) continue;
    const hasArcN = !!cells[fr-1]?.[fc]?.trimWall;
    const hasArcS = !!cells[fr+1]?.[fc]?.trimWall;
    const hasArcE = !!cells[fr]?.[fc+1]?.trimWall;
    const hasArcW = !!cells[fr]?.[fc-1]?.trimWall;
    if ((hasArcN && hasArcS) || (hasArcE && hasArcW)) continue;
    for (const { dir, dr, dc } of FILL_DIRS) {
      const nr = fr + dr, nc = fc + dc;
      const arcCell = cells[nr]?.[nc];
      if (!arcCell?.trimWall) continue;
      const nKey = cellKey(nr, nc);
      if (arcVisited.has(nKey)) continue;
      arcVisited.add(nKey);
      if (!filledCells.has(nKey)) {
        filledCells.add(nKey);
        toFill.push([nr, nc, arcHalfKey]);
      }
      arcQueue.push([nr, nc]);
    }
  }
  // Propagate: block at cells with wrong-side non-arc neighbor
  while (arcQueue.length > 0) {
    const [ar, ac] = arcQueue.shift();
    for (const { dr, dc } of FILL_DIRS) {
      const nr = ar + dr, nc = ac + dc;
      const arcCell = cells[nr]?.[nc];
      if (!arcCell?.trimWall) continue;
      const nKey = cellKey(nr, nc);
      if (arcVisited.has(nKey)) continue;
      let blocked = false;
      for (const { dir: d2, dr: dr2, dc: dc2 } of FILL_DIRS) {
        const mr = nr + dr2, mc = nc + dc2;
        if (!mainFillCells.has(cellKey(mr, mc))) continue;
        if (cells[mr]?.[mc]?.trimWall) continue;
        const hk = halfKeyFromEntry(arcCell, d2);
        if (hk && hk !== arcHalfKey) { blocked = true; break; }
      }
      if (blocked) continue;
      arcVisited.add(nKey);
      if (!filledCells.has(nKey)) {
        filledCells.add(nKey);
        toFill.push([nr, nc, arcHalfKey]);
      }
      arcQueue.push([nr, nc]);
    }
  }


  // Build result: apply textures
  const result = new Map();
  for (const [r, c, halfKey] of toFill) {
    const texKey = halfKey || 'texture';
    const prev = result.get(cellKey(r, c)) || { texture: null, textureSecondary: null };
    prev[texKey] = textureId;
    result.set(cellKey(r, c), prev);
  }
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('texture flood fill on open round trim room', () => {
  const fixture = resolve(__dirname, 'fixtures/open-trim-room.json');
  const expectedFile = resolve(__dirname, 'fixtures/open-trim-room-expected.json');
  const expected = loadExpected(expectedFile);
  const textureId = 'polyhaven/aerial_asphalt_01';

  // Room corners from the fixture
  const corners = {
    topLeft:     { row: 64, col: 4 },
    topRight:    { row: 64, col: 13 },
    bottomLeft:  { row: 73, col: 4 },
    bottomRight: { row: 73, col: 13 },
  };

  function runFillAndCompare(startRow, startCol) {
    const { cells } = loadCellsFromDump(fixture);
    const result = simulateTextureFill(cells, startRow, startCol, textureId);

    const wrongCells = [];
    for (const [key, exp] of expected) {
      const got = result.get(key) || { texture: null, textureSecondary: null };
      if (exp.texture !== got.texture || exp.textureSecondary !== got.textureSecondary) {
        const [r, c] = key.split(',');
        wrongCells.push({
          cell: key,
          expected: { tex: exp.texture?.split('/').pop(), sec: exp.textureSecondary?.split('/').pop() },
          got: { tex: got.texture?.split('/').pop(), sec: got.textureSecondary?.split('/').pop() },
        });
      }
    }

    if (wrongCells.length > 0) {
      console.log(`Wrong cells (${wrongCells.length}):`, wrongCells.slice(0, 10));
    }
    expect(wrongCells).toHaveLength(0);
  }

  it('flood fill from top-left corner matches expected', () => {
    runFillAndCompare(corners.topLeft.row, corners.topLeft.col);
  });

  it('flood fill from top-right corner matches expected', () => {
    runFillAndCompare(corners.topRight.row, corners.topRight.col);
  });

  it('flood fill from bottom-left corner matches expected', () => {
    runFillAndCompare(corners.bottomLeft.row, corners.bottomLeft.col);
  });

  it('flood fill from bottom-right corner matches expected', () => {
    runFillAndCompare(corners.bottomRight.row, corners.bottomRight.col);
  });

  it('flood fill from room center matches expected (inside fill)', () => {
    const centerExpectedFile = resolve(__dirname, 'fixtures/open-trim-room-expected-center.json');
    const centerExpected = loadExpected(centerExpectedFile);
    const centerTextureId = 'polyhaven/aerial_beach_01';
    const centerRow = 68, centerCol = 8;

    const { cells } = loadCellsFromDump(fixture);
    const result = simulateTextureFill(cells, centerRow, centerCol, centerTextureId);

    const wrongCells = [];
    for (const [key, exp] of centerExpected) {
      const got = result.get(key) || { texture: null, textureSecondary: null };
      if (exp.texture !== got.texture || exp.textureSecondary !== got.textureSecondary) {
        const [r, c] = key.split(',');
        wrongCells.push({
          cell: key,
          expected: { tex: exp.texture?.split('/').pop(), sec: exp.textureSecondary?.split('/').pop() },
          got: { tex: got.texture?.split('/').pop(), sec: got.textureSecondary?.split('/').pop() },
        });
      }
    }

    if (wrongCells.length > 0) {
      console.log(`Wrong cells (${wrongCells.length}):`, wrongCells.slice(0, 10));
    }
    expect(wrongCells).toHaveLength(0);
  });
});

describe('texture flood fill on multi-room open trim map', () => {
  const multiFixture = resolve(__dirname, 'fixtures/open-trim-multi-room.json');
  const multiExpectedFile = resolve(__dirname, 'fixtures/open-trim-multi-room-expected.json');

  it('outside fill from top-left corner matches expected', () => {
    const expected = loadExpected(multiExpectedFile);
    const textureId = 'polyhaven/aerial_beach_02';
    const { cells } = loadCellsFromDump(multiFixture);
    const result = simulateTextureFill(cells, 93, 5, textureId);

    const wrongCells = [];
    for (const [key, exp] of expected) {
      const got = result.get(key) || { texture: null, textureSecondary: null };
      if (exp.texture !== got.texture || exp.textureSecondary !== got.textureSecondary) {
        wrongCells.push({
          cell: key,
          expected: { tex: exp.texture?.split('/').pop(), sec: exp.textureSecondary?.split('/').pop() },
          got: { tex: got.texture?.split('/').pop(), sec: got.textureSecondary?.split('/').pop() },
        });
      }
    }

    if (wrongCells.length > 0) {
      console.log(`Wrong cells (${wrongCells.length}):`, wrongCells.slice(0, 10));
    }
    expect(wrongCells).toHaveLength(0);
  });
});
