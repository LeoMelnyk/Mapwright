/**
 * Regression tests for the player-view fog layers:
 *   - Hatching layer (full-map coverage, fog-edge mask with rounded edges)
 *   - Walls overlay (only walls from revealed cells, incremental updates)
 *   - Fog overlay (theme-coloured background)
 *
 * Uses real canvas via @napi-rs/canvas (setup-render.js) to exercise the
 * actual render pipeline functions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas } from '@napi-rs/canvas';

import { drawHatching, drawRockShading, THEMES } from '../../src/render/index.js';
import { renderCells, invalidateGeometryCache } from '../../src/render/render.js';
import { buildPlayerCells } from '../../src/player/fog.js';
import { determineRoomCells } from '../../src/render/floors.js';
import { cellKey } from '../../src/util/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../util/fixtures');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Load a map config from the examples directory. */
function loadMap(filename) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8'));
}

/** Create an all-true roomCells grid (used for full-coverage hatching). */
function allTrueRoomCells(numRows, numCols) {
  return Array.from({ length: numRows }, () => Array(numCols).fill(true));
}

/** Count non-transparent pixels in a canvas (alpha > 0). */
function countNonTransparent(canvas) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) count++;
  }
  return count;
}

/** Check if a specific pixel is non-transparent. */
function isPixelVisible(canvas, x, y) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(x, y, 1, 1).data;
  return data[3] > 0;
}

/** Build a Set of cell keys from a rectangular region. */
function revealRect(r1, c1, r2, c2) {
  const s = new Set();
  for (let r = r1; r <= r2; r++)
    for (let c = c1; c <= c2; c++)
      s.add(cellKey(r, c));
  return s;
}

// ── Hatching layer tests ────────────────────────────────────────────────────

describe('Hatching layer (full-map coverage)', () => {
  const PX_PER_FOOT = 10;
  const GRID_SIZE = 5;

  it('renders hatching across entire map when roomCells are all-true', () => {
    const config = loadMap('island.mapwright');
    const { cells } = config;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const theme = THEMES['earth-cave'] || THEMES['stone-dungeon'];
    if (!theme.hatchOpacity) return; // skip if theme has no hatching

    const gridSize = config.metadata.gridSize;
    const cacheW = numCols * gridSize * PX_PER_FOOT;
    const cacheH = numRows * gridSize * PX_PER_FOOT;
    const canvas = createCanvas(cacheW, cacheH);
    const ctx = canvas.getContext('2d');
    const transform = { scale: PX_PER_FOOT, offsetX: 0, offsetY: 0 };

    const allRoom = allTrueRoomCells(numRows, numCols);
    drawHatching(ctx, cells, allRoom, gridSize, theme, transform);

    const nonTransparent = countNonTransparent(canvas);
    expect(nonTransparent).toBeGreaterThan(0);
  });

  it('renders no hatching when hatchOpacity is 0', () => {
    const config = loadMap('island.mapwright');
    const { cells } = config;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const gridSize = config.metadata.gridSize;
    const cacheW = numCols * gridSize * PX_PER_FOOT;
    const cacheH = numRows * gridSize * PX_PER_FOOT;
    const canvas = createCanvas(cacheW, cacheH);
    const ctx = canvas.getContext('2d');
    const transform = { scale: PX_PER_FOOT, offsetX: 0, offsetY: 0 };

    const noHatchTheme = { ...THEMES['stone-dungeon'], hatchOpacity: 0 };
    const allRoom = allTrueRoomCells(numRows, numCols);
    drawHatching(ctx, cells, allRoom, gridSize, noHatchTheme, transform);

    expect(countNonTransparent(canvas)).toBe(0);
  });

  it('full-coverage hatching has more content than room-only hatching', () => {
    const config = loadMap('island.mapwright');
    const { cells } = config;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const theme = { ...THEMES['stone-dungeon'], hatchOpacity: 0.5 };
    const gridSize = config.metadata.gridSize;
    const cacheW = numCols * gridSize * PX_PER_FOOT;
    const cacheH = numRows * gridSize * PX_PER_FOOT;
    const transform = { scale: PX_PER_FOOT, offsetX: 0, offsetY: 0 };

    // Full coverage (all-true roomCells)
    const fullCanvas = createCanvas(cacheW, cacheH);
    const allRoom = allTrueRoomCells(numRows, numCols);
    drawHatching(fullCanvas.getContext('2d'), cells, allRoom, gridSize, theme, transform);
    const fullPixels = countNonTransparent(fullCanvas);

    // Room-only coverage (real roomCells)
    const roomCanvas = createCanvas(cacheW, cacheH);
    const roomCells = determineRoomCells(cells);
    drawHatching(roomCanvas.getContext('2d'), cells, roomCells, gridSize, theme, transform);
    const roomPixels = countNonTransparent(roomCanvas);

    // Full coverage should have at least as much hatching (equal if map
    // has rooms everywhere; strictly more if there are gaps in room coverage)
    expect(fullPixels).toBeGreaterThanOrEqual(roomPixels);
    expect(fullPixels).toBeGreaterThan(0);
  });
});

// ── Hatching mask tests (rounded edges via Minkowski sum) ───────────────────

describe('Hatching mask (Minkowski sum with circles)', () => {
  it('circle union produces rounded outer edges', () => {
    // Simulate the compositing: circles at revealed cell centers,
    // then cut out revealed cells. The resulting mask should have
    // non-zero pixels in a rounded band.
    const cellPx = 50;
    const MAX_DIST = 2;
    const ballRadius = cellPx * (0.5 + MAX_DIST);
    const gridW = 20, gridH = 20;
    const canvasW = gridW * cellPx, canvasH = gridH * cellPx;

    // Reveal a 6×6 block in the centre
    const revealed = new Set();
    for (let r = 7; r <= 12; r++)
      for (let c = 7; c <= 12; c++)
        revealed.add(cellKey(r, c));

    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');

    // Step 1: fill circles at each revealed cell centre
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (const key of revealed) {
      const [r, c] = key.split(',').map(Number);
      const cx = (c + 0.5) * cellPx;
      const cy = (r + 0.5) * cellPx;
      ctx.moveTo(cx + ballRadius, cy);
      ctx.arc(cx, cy, ballRadius, 0, Math.PI * 2);
    }
    ctx.fill('nonzero');

    // Step 2: cut out revealed cells
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    for (const key of revealed) {
      const [r, c] = key.split(',').map(Number);
      ctx.rect(c * cellPx, r * cellPx, cellPx, cellPx);
    }
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // The mask should have content (the rounded band)
    const bandPixels = countNonTransparent(canvas);
    expect(bandPixels).toBeGreaterThan(0);

    // The corner of the band (diagonal from revealed block) should be
    // rounded, meaning a pixel at max Chebyshev distance but beyond
    // Euclidean radius should be TRANSPARENT (cut off by the circle).
    // The corner of the BFS band (e.g., 2 cells diagonally NW of the block)
    // is at row 5, col 5. Euclidean distance from nearest revealed cell
    // centre (7,7) = sqrt(4+4)*cellPx = 2.83*cellPx.
    // ballRadius = 2.5*cellPx, so the diagonal corner cell centre is
    // OUTSIDE the ball radius — the pixel there should be transparent.
    const cornerX = Math.floor(5.5 * cellPx);
    const cornerY = Math.floor(5.5 * cellPx);
    expect(isPixelVisible(canvas, cornerX, cornerY)).toBe(false);

    // But a cell directly adjacent to the block (e.g., row 6, col 10 — 1 cell north)
    // should be within the band.
    const adjX = Math.floor(10.5 * cellPx);
    const adjY = Math.floor(6.5 * cellPx);
    expect(isPixelVisible(canvas, adjX, adjY)).toBe(true);
  });
});

// ── Walls layer tests (only revealed cells) ─────────────────────────────────

describe('Walls layer (revealed cells only)', () => {
  it('walls from unrevealed cells are not rendered', () => {
    const config = loadMap('island.mapwright');
    const { cells, metadata } = config;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const gridSize = metadata.gridSize;
    const theme = THEMES[metadata.theme] || THEMES['stone-dungeon'];
    const PX_PER_FOOT = 10;
    const cacheW = numCols * gridSize * PX_PER_FOOT;
    const cacheH = numRows * gridSize * PX_PER_FOOT;
    const cacheTransform = { scale: PX_PER_FOOT, offsetX: 0, offsetY: 0 };

    const skipPhases = {
      shading: true, hatching: true, floors: true, blending: true,
      fills: true, bridges: true, grid: true, props: true, hazard: true,
    };

    // Reveal only a small region — cells 5-10, cols 5-15
    const revealed = revealRect(5, 5, 10, 15);

    // Build filtered cells (null for unrevealed)
    const filteredCells = Array.from({ length: numRows }, () => Array(numCols).fill(null));
    for (const key of revealed) {
      const [r, c] = key.split(',').map(Number);
      if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
        filteredCells[r][c] = cells[r][c];
      }
    }

    // Render walls with filtered cells
    invalidateGeometryCache();
    const filteredCanvas = createCanvas(cacheW, cacheH);
    renderCells(filteredCanvas.getContext('2d'), filteredCells, gridSize, theme, cacheTransform, {
      metadata, skipPhases, skipLabels: true,
    });

    // Render walls with ALL cells
    invalidateGeometryCache();
    const fullCanvas = createCanvas(cacheW, cacheH);
    renderCells(fullCanvas.getContext('2d'), cells, gridSize, theme, cacheTransform, {
      metadata, skipPhases, skipLabels: true,
    });

    // Filtered should have fewer wall pixels
    const filteredPixels = countNonTransparent(filteredCanvas);
    const fullPixels = countNonTransparent(fullCanvas);
    expect(filteredPixels).toBeLessThan(fullPixels);
    expect(filteredPixels).toBeGreaterThan(0); // some walls exist in revealed area
  });

  it('incremental reveal adds walls without losing existing ones', () => {
    const config = loadMap('island.mapwright');
    const { cells, metadata } = config;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const gridSize = metadata.gridSize;
    const theme = THEMES[metadata.theme] || THEMES['stone-dungeon'];
    const PX_PER_FOOT = 10;
    const cacheW = numCols * gridSize * PX_PER_FOOT;
    const cacheH = numRows * gridSize * PX_PER_FOOT;
    const cellPx = gridSize * PX_PER_FOOT;
    const cacheTransform = { scale: PX_PER_FOOT, offsetX: 0, offsetY: 0 };

    const skipPhases = {
      shading: true, hatching: true, floors: true, blending: true,
      fills: true, bridges: true, grid: true, props: true, hazard: true,
    };

    // Find two adjacent regions that have actual cells with walls
    let region1Cells = 0, region2Cells = 0;
    const midRow = Math.floor(numRows / 2);
    for (let r = 0; r < midRow; r++)
      for (let c = 0; c < numCols; c++)
        if (cells[r]?.[c]) region1Cells++;
    for (let r = midRow; r < numRows; r++)
      for (let c = 0; c < numCols; c++)
        if (cells[r]?.[c]) region2Cells++;

    // Skip if either half is empty
    if (!region1Cells || !region2Cells) return;

    // Phase 1: render walls for top half
    const wallsCells = Array.from({ length: numRows }, () => Array(numCols).fill(null));
    for (let r = 0; r < midRow; r++)
      for (let c = 0; c < numCols; c++)
        if (cells[r]?.[c]) wallsCells[r][c] = cells[r][c];

    const canvas = createCanvas(cacheW, cacheH);
    const ctx = canvas.getContext('2d');
    invalidateGeometryCache();
    renderCells(ctx, wallsCells, gridSize, theme, cacheTransform, {
      metadata, skipPhases, skipLabels: true,
    });
    const phase1Pixels = countNonTransparent(canvas);

    // Phase 2: add bottom half (incremental)
    for (let r = midRow; r < numRows; r++)
      for (let c = 0; c < numCols; c++)
        if (cells[r]?.[c]) wallsCells[r][c] = cells[r][c];

    const bounds = {
      minRow: Math.max(0, midRow - 1),
      maxRow: numRows - 1,
      minCol: 0,
      maxCol: numCols - 1,
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(bounds.minCol * cellPx, bounds.minRow * cellPx,
      (bounds.maxCol - bounds.minCol + 1) * cellPx,
      (bounds.maxRow - bounds.minRow + 1) * cellPx);
    ctx.clip();
    ctx.clearRect(0, 0, cacheW, cacheH);
    invalidateGeometryCache();
    renderCells(ctx, wallsCells, gridSize, theme, cacheTransform, {
      metadata, skipPhases, skipLabels: true, visibleBounds: bounds,
    });
    ctx.restore();

    const phase2Pixels = countNonTransparent(canvas);
    expect(phase1Pixels).toBeGreaterThan(0);
    expect(phase2Pixels).toBeGreaterThan(phase1Pixels);
  });
});

// ── Fog overlay colour tests ────────────────────────────────────────────────

describe('Fog overlay uses theme background colour', () => {
  it('fog fill matches theme.background, not black', () => {
    const theme = THEMES['stone-dungeon'];
    expect(theme.background).toBeDefined();
    expect(theme.background).not.toBe('#000000');

    // Simulate fog overlay: fill, then clearRect for revealed
    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, 200, 200);
    // Punch a hole for one cell
    ctx.clearRect(50, 50, 50, 50);

    // Fog area should be theme background, not black
    const fogPixel = ctx.getImageData(10, 10, 1, 1).data;
    // Parse theme.background hex
    const bg = theme.background;
    const expectedR = parseInt(bg.slice(1, 3), 16);
    const expectedG = parseInt(bg.slice(3, 5), 16);
    const expectedB = parseInt(bg.slice(5, 7), 16);
    expect(fogPixel[0]).toBe(expectedR);
    expect(fogPixel[1]).toBe(expectedG);
    expect(fogPixel[2]).toBe(expectedB);
    expect(fogPixel[3]).toBe(255); // fully opaque

    // Hole should be transparent
    const holePixel = ctx.getImageData(75, 75, 1, 1).data;
    expect(holePixel[3]).toBe(0);
  });

  it('conceal paints theme background, not black', () => {
    const theme = THEMES['earth-cave'] || THEMES['stone-dungeon'];
    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext('2d');

    // Start with fog
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, 200, 200);
    // Reveal
    ctx.clearRect(50, 50, 50, 50);
    // Conceal (should paint theme background, not black)
    ctx.fillStyle = theme.background;
    ctx.fillRect(50, 50, 50, 50);

    const pixel = ctx.getImageData(75, 75, 1, 1).data;
    const bg = theme.background;
    const expectedR = parseInt(bg.slice(1, 3), 16);
    expect(pixel[0]).toBe(expectedR);
    expect(pixel[3]).toBe(255);
  });
});

// ── Player cell filtering (buildPlayerCells) ────────────────────────────────

describe('buildPlayerCells fog filtering', () => {
  it('unrevealed cells are null', () => {
    const config = loadMap('island.mapwright');
    const { cells } = config;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;

    // Find a cell that actually has content
    let contentCell = null;
    for (let r = 0; r < numRows && !contentCell; r++)
      for (let c = 0; c < numCols && !contentCell; c++)
        if (cells[r][c]) contentCell = { r, c };

    expect(contentCell).not.toBeNull();

    // Reveal just that cell
    const revealed = new Set([cellKey(contentCell.r, contentCell.c)]);
    const playerCells = buildPlayerCells(config, revealed, []);

    // The revealed cell should be non-null
    expect(playerCells[contentCell.r][contentCell.c]).not.toBeNull();

    // A cell far from the revealed one should be null
    const farR = contentCell.r > 5 ? 0 : numRows - 1;
    expect(playerCells[farR][0]).toBeNull();
  });

  it('secret doors become walls for unrevealed secrets', () => {
    const config = loadMap('island.mapwright');
    const { cells } = config;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;

    // Find a secret door in the map
    let secretPos = null;
    for (let r = 0; r < numRows && !secretPos; r++) {
      for (let c = 0; c < numCols && !secretPos; c++) {
        const cell = cells[r][c];
        if (!cell) continue;
        for (const dir of ['north', 'south', 'east', 'west']) {
          if (cell[dir] === 's') {
            secretPos = { r, c, dir };
            break;
          }
        }
      }
    }

    if (!secretPos) return; // no secrets in this map — skip

    // Reveal the secret door cell but don't open it
    const revealed = new Set([cellKey(secretPos.r, secretPos.c)]);
    const playerCells = buildPlayerCells(config, revealed, []);
    const playerCell = playerCells[secretPos.r][secretPos.c];

    // Secret door should appear as a wall (not 's')
    expect(playerCell[secretPos.dir]).toBe('w');
  });
});

// ── skipPhases.hatching in renderCells ──────────────────────────────────────

describe('skipPhases.hatching', () => {
  it('skips hatching when skipPhases.hatching is true', () => {
    const config = loadMap('island.mapwright');
    const { cells, metadata } = config;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    const gridSize = metadata.gridSize;
    const theme = { ...THEMES['stone-dungeon'], hatchOpacity: 0.5 };
    const PX_PER_FOOT = 10;
    const cacheW = numCols * gridSize * PX_PER_FOOT;
    const cacheH = numRows * gridSize * PX_PER_FOOT;
    const cacheTransform = { scale: PX_PER_FOOT, offsetX: 0, offsetY: 0 };

    // Render WITH hatching
    invalidateGeometryCache();
    const withCanvas = createCanvas(cacheW, cacheH);
    renderCells(withCanvas.getContext('2d'), cells, gridSize, theme, cacheTransform, { metadata });
    const withPixels = countNonTransparent(withCanvas);

    // Render WITHOUT hatching (skipPhases.hatching = true)
    invalidateGeometryCache();
    const withoutCanvas = createCanvas(cacheW, cacheH);
    renderCells(withoutCanvas.getContext('2d'), cells, gridSize, theme, cacheTransform, {
      metadata, skipPhases: { hatching: true },
    });
    const withoutPixels = countNonTransparent(withoutCanvas);

    // With hatching should have more pixels than without
    expect(withPixels).toBeGreaterThan(withoutPixels);
  });
});
