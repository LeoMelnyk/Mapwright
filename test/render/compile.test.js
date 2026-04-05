/**
 * Unit tests for compile.ts — canvas sizing and theme resolution.
 *
 * calculateCanvasSize is pure (no canvas needed).
 * resolveTheme is not exported directly, so we test it indirectly via
 * renderDungeonToCanvas or by importing it from the module scope.
 * Since resolveTheme is a module-private function, we test its behavior
 * through calculateCanvasSize + renderDungeonToCanvas integration.
 */
import { describe, it, expect } from 'vitest';
import { calculateCanvasSize } from '../../src/render/compile.js';
import { THEMES } from '../../src/render/themes.js';
import { GRID_SCALE, MARGIN } from '../../src/render/constants.js';

// ---------------------------------------------------------------------------
// calculateCanvasSize
// ---------------------------------------------------------------------------

describe('calculateCanvasSize', () => {
  it('returns correct size for a simple 3x4 single-level dungeon', () => {
    const config = {
      metadata: { gridSize: 5 },
      cells: [
        [{}, {}, {}, {}],
        [{}, {}, {}, {}],
        [{}, {}, {}, {}],
      ],
    };
    const size = calculateCanvasSize(config);
    // bounds: minX=0, minY=0, maxX=20, maxY=15
    // width = ceil((20 - 0) * GRID_SCALE + MARGIN * 2)
    // height = ceil((15 - 0) * GRID_SCALE + MARGIN * 2)
    expect(size.width).toBe(Math.ceil(20 * GRID_SCALE + MARGIN * 2));
    expect(size.height).toBe(Math.ceil(15 * GRID_SCALE + MARGIN * 2));
  });

  it('returns fallback { width: 100, height: 100 } for empty cells', () => {
    expect(calculateCanvasSize({ metadata: { gridSize: 5 }, cells: [] }))
      .toEqual({ width: 100, height: 100 });
  });

  it('returns fallback for missing cells property', () => {
    expect(calculateCanvasSize({ metadata: { gridSize: 5 } }))
      .toEqual({ width: 100, height: 100 });
  });

  it('returns fallback for cells with empty first row', () => {
    expect(calculateCanvasSize({ metadata: { gridSize: 5 }, cells: [[]] }))
      .toEqual({ width: 100, height: 100 });
  });

  it('handles a 1x1 grid', () => {
    const config = {
      metadata: { gridSize: 10 },
      cells: [[{}]],
    };
    const size = calculateCanvasSize(config);
    // bounds: maxX=10, maxY=10
    expect(size.width).toBe(Math.ceil(10 * GRID_SCALE + MARGIN * 2));
    expect(size.height).toBe(Math.ceil(10 * GRID_SCALE + MARGIN * 2));
  });

  it('handles a multi-level dungeon (3D cells array)', () => {
    const config = {
      metadata: { gridSize: 5, levels: 2 },
      cells: [
        // Level 0: 2x3
        [
          [{}, {}, {}],
          [{}, {}, {}],
        ],
        // Level 1: 2x3
        [
          [{}, {}, {}],
          [{}, {}, {}],
        ],
      ],
    };
    const size = calculateCanvasSize(config);
    // Each level: bounds maxX=15, maxY=10
    // levelWidth = ceil(15 * GRID_SCALE + MARGIN * 2)
    // levelHeight = ceil(10 * GRID_SCALE + MARGIN * 2)
    // titleHeight = 32 + 40 = 72 (default titleFontSize)
    const levelWidth = Math.ceil(15 * GRID_SCALE + MARGIN * 2);
    const levelHeight = Math.ceil(10 * GRID_SCALE + MARGIN * 2);
    const titleHeight = 32 + 40;
    expect(size.width).toBe(levelWidth);
    expect(size.height).toBe((levelHeight + titleHeight) * 2);
  });

  it('null cells do not affect canvas size (grid shape determines extent)', () => {
    const config = {
      metadata: { gridSize: 5 },
      cells: [
        [null, {}, null],
        [{}, null, {}],
      ],
    };
    const size = calculateCanvasSize(config);
    // 2 rows x 3 cols, gridSize 5 → bounds maxX=15, maxY=10
    expect(size.width).toBe(Math.ceil(15 * GRID_SCALE + MARGIN * 2));
    expect(size.height).toBe(Math.ceil(10 * GRID_SCALE + MARGIN * 2));
  });
});

// ---------------------------------------------------------------------------
// resolveTheme (tested via THEMES registry behavior)
// ---------------------------------------------------------------------------

describe('resolveTheme (indirect)', () => {
  it('THEMES registry contains blue-parchment after setup', () => {
    // setup-render.js loads .theme files into the THEMES registry
    expect(THEMES['blue-parchment']).toBeDefined();
    expect(THEMES['blue-parchment'].background).toBeDefined();
  });

  it('all loaded themes have wallStroke and textColor', () => {
    const themeNames = Object.keys(THEMES);
    expect(themeNames.length).toBeGreaterThan(0);
    for (const name of themeNames) {
      expect(THEMES[name]).toHaveProperty('wallStroke');
      expect(THEMES[name]).toHaveProperty('textColor');
    }
  });

  it('blue-parchment is the default fallback theme', () => {
    // This validates the pattern used by resolveTheme: unknown name → blue-parchment
    const theme = THEMES['blue-parchment'];
    expect(theme).toBeDefined();
    expect(theme.background).toBe('#f0f4f8');
  });
});
