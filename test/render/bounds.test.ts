/**
 * Unit tests for the bounds module — coordinate transforms and bounding box
 * calculations used by the render pipeline.
 *
 * All functions under test are pure (no canvas, no side effects).
 */
import { describe, it, expect } from 'vitest';
import { calculateBoundsFromCells, calculateBounds, toCanvas } from '../../src/render/bounds.js';

// ---------------------------------------------------------------------------
// calculateBoundsFromCells
// ---------------------------------------------------------------------------

describe('calculateBoundsFromCells', () => {
  it('returns bounds for a 3x4 grid at gridSize 5', () => {
    const cells = [
      [{}, {}, {}, {}],
      [{}, {}, {}, {}],
      [{}, {}, {}, {}],
    ];
    const bounds = calculateBoundsFromCells(cells, 5);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 15 });
  });

  it('returns bounds for a 1x1 grid', () => {
    const cells = [[{}]];
    const bounds = calculateBoundsFromCells(cells, 10);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  it('null cells do not affect bounds (grid shape determines extent)', () => {
    const cells = [
      [null, {}, null],
      [{}, null, {}],
    ];
    // 2 rows x 3 cols, gridSize 5 → maxX=15, maxY=10
    const bounds = calculateBoundsFromCells(cells, 5);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 15, maxY: 10 });
  });

  it('all-null grid still uses matrix dimensions', () => {
    const cells = [
      [null, null],
      [null, null],
      [null, null],
    ];
    const bounds = calculateBoundsFromCells(cells, 5);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 15 });
  });

  it('handles gridSize of 1', () => {
    const cells = [[{}, {}]];
    const bounds = calculateBoundsFromCells(cells, 1);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 1 });
  });

  it('handles large gridSize', () => {
    const cells = [[{}]];
    const bounds = calculateBoundsFromCells(cells, 100);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it('empty first row uses 0 columns', () => {
    // Edge case: rows exist but first row is empty
    const cells = [[]];
    const bounds = calculateBoundsFromCells(cells, 5);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 5 });
  });
});

// ---------------------------------------------------------------------------
// toCanvas
// ---------------------------------------------------------------------------

describe('toCanvas', () => {
  it('applies scale and offset to both axes', () => {
    const transform = { scale: 2, offsetX: 10, offsetY: 20 };
    const result = toCanvas(5, 3, transform);
    expect(result).toEqual({ x: 20, y: 26 });
  });

  it('returns offset when input is (0, 0)', () => {
    const transform = { scale: 1, offsetX: 50, offsetY: 75 };
    const result = toCanvas(0, 0, transform);
    expect(result).toEqual({ x: 50, y: 75 });
  });

  it('works with scale = 1 (identity scaling)', () => {
    const transform = { scale: 1, offsetX: 0, offsetY: 0 };
    const result = toCanvas(7, 13, transform);
    expect(result).toEqual({ x: 7, y: 13 });
  });

  it('handles negative coordinates', () => {
    const transform = { scale: 10, offsetX: 100, offsetY: 100 };
    const result = toCanvas(-5, -3, transform);
    expect(result).toEqual({ x: 50, y: 70 });
  });

  it('handles fractional scale', () => {
    const transform = { scale: 0.5, offsetX: 0, offsetY: 0 };
    const result = toCanvas(10, 20, transform);
    expect(result).toEqual({ x: 5, y: 10 });
  });

  it('handles zero scale (degenerate)', () => {
    const transform = { scale: 0, offsetX: 10, offsetY: 20 };
    const result = toCanvas(100, 200, transform);
    expect(result).toEqual({ x: 10, y: 20 });
  });

  it('handles negative offsets', () => {
    const transform = { scale: 20, offsetX: -100, offsetY: -200 };
    const result = toCanvas(10, 15, transform);
    expect(result).toEqual({ x: 100, y: 100 });
  });
});

// ---------------------------------------------------------------------------
// calculateBounds (legacy coordinate-based)
// ---------------------------------------------------------------------------

describe('calculateBounds', () => {
  it('calculates bounds for a single grid room', () => {
    const config = {
      gridSize: 5,
      rooms: [
        {
          type: 'grid',
          coordinates: [[0, 0, 0], [2, 2, 4]],
        },
      ],
    };
    const bounds = calculateBounds(config);
    // coordinateToFeet(0,0,0,5) = [0,0], coordinateToFeet(2,2,4,5) = [15,15]
    // with padding of 5
    expect(bounds.minX).toBe(-5);
    expect(bounds.minY).toBe(-5);
    expect(bounds.maxX).toBe(20);
    expect(bounds.maxY).toBe(20);
  });

  it('calculates bounds for a rectangular room', () => {
    const config = {
      gridSize: 5,
      rooms: [
        {
          type: 'rectangular',
          topLeft: [10, 20],
          width: 30,
          height: 40,
        },
      ],
    };
    const bounds = calculateBounds(config);
    expect(bounds.minX).toBe(5);   // 10 - 5
    expect(bounds.minY).toBe(15);  // 20 - 5
    expect(bounds.maxX).toBe(45);  // 40 + 5
    expect(bounds.maxY).toBe(65);  // 60 + 5
  });

  it('calculates bounds for a circular room', () => {
    const config = {
      gridSize: 10,
      rooms: [
        {
          type: 'circular',
          center: [2, 2, 8], // coordinateToFeet → [25, 25]
          radiusSquares: 3,  // radius = 3 * 10 = 30
        },
      ],
    };
    const bounds = calculateBounds(config);
    expect(bounds.minX).toBe(-10);  // 25 - 30 - 5
    expect(bounds.minY).toBe(-10);
    expect(bounds.maxX).toBe(60);   // 25 + 30 + 5
    expect(bounds.maxY).toBe(60);
  });

  it('calculates bounds for a cave room', () => {
    const config = {
      gridSize: 5,
      rooms: [
        {
          type: 'cave',
          center: [50, 50],
          width: 40,
          height: 30,
        },
      ],
    };
    const bounds = calculateBounds(config);
    expect(bounds.minX).toBe(25);  // 50 - 20 - 5
    expect(bounds.minY).toBe(30);  // 50 - 15 - 5
    expect(bounds.maxX).toBe(75);  // 50 + 20 + 5
    expect(bounds.maxY).toBe(70);  // 50 + 15 + 5
  });

  it('merges bounds across multiple rooms', () => {
    const config = {
      gridSize: 5,
      rooms: [
        { type: 'rectangular', topLeft: [0, 0], width: 10, height: 10 },
        { type: 'rectangular', topLeft: [100, 100], width: 20, height: 20 },
      ],
    };
    const bounds = calculateBounds(config);
    expect(bounds.minX).toBe(-5);    // 0 - 5
    expect(bounds.minY).toBe(-5);    // 0 - 5
    expect(bounds.maxX).toBe(125);   // 120 + 5
    expect(bounds.maxY).toBe(125);   // 120 + 5
  });

  it('adds 5-unit padding on all sides', () => {
    const config = {
      gridSize: 5,
      rooms: [
        { type: 'rectangular', topLeft: [10, 10], width: 10, height: 10 },
      ],
    };
    const bounds = calculateBounds(config);
    expect(bounds.minX).toBe(10 - 5);
    expect(bounds.minY).toBe(10 - 5);
    expect(bounds.maxX).toBe(20 + 5);
    expect(bounds.maxY).toBe(20 + 5);
  });

  it('handles walls-type room', () => {
    const config = {
      gridSize: 5,
      rooms: [
        {
          type: 'walls',
          walls: [
            [[0, 0, 0], [3, 0, 2]],
            [[3, 0, 2], [3, 3, 4]],
          ],
        },
      ],
    };
    const bounds = calculateBounds(config);
    // coordinateToFeet(0,0,0,5) = [0,0]
    // coordinateToFeet(3,0,2,5) = [20,0]
    // coordinateToFeet(3,3,4,5) = [20,20]
    expect(bounds.minX).toBe(-5);
    expect(bounds.minY).toBe(-5);
    expect(bounds.maxX).toBe(25);
    expect(bounds.maxY).toBe(25);
  });

  it('handles custom-type room', () => {
    const config = {
      gridSize: 5,
      rooms: [
        {
          type: 'custom',
          walls: [
            { from: [0, 0, 0], to: [4, 0, 2] },
            { from: [4, 0, 2], to: [4, 4, 4] },
          ],
        },
      ],
    };
    const bounds = calculateBounds(config);
    // coordinateToFeet(0,0,0,5)=[0,0], (4,0,2)=[25,0], (4,4,4)=[25,25]
    expect(bounds.minX).toBe(-5);
    expect(bounds.minY).toBe(-5);
    expect(bounds.maxX).toBe(30);
    expect(bounds.maxY).toBe(30);
  });
});
