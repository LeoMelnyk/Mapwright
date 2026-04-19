/**
 * Tests for the jump-flooded wall SDF.
 */
import { describe, it, expect } from 'vitest';
import { buildWallSDF, sampleSDF } from '../../src/render/sdf.js';

describe('buildWallSDF', () => {
  it('returns zero at wall seed cells', () => {
    // Single horizontal segment from (0, 5) to (10, 5)
    const sdf = buildWallSDF([{ x1: 0, y1: 5, x2: 10, y2: 5 }], 10, 10, 1);
    // Sampling at the wall should be very near zero (Bresenham rasterization
    // may quantize a half-pixel off, hence the tolerance).
    expect(sampleSDF(sdf, 5, 5)).toBeLessThan(1);
  });

  it('distance grows with world-feet distance from the wall', () => {
    const sdf = buildWallSDF([{ x1: 0, y1: 5, x2: 10, y2: 5 }], 10, 10, 2);
    const near = sampleSDF(sdf, 5, 5);
    const mid = sampleSDF(sdf, 5, 7);
    const far = sampleSDF(sdf, 5, 9);
    expect(mid).toBeGreaterThan(near);
    expect(far).toBeGreaterThan(mid);
  });

  it('scales distance by the SDF pixel resolution', () => {
    // Same world geometry at two different scales. The world distance is
    // the same; the stored distance is in pixels so the higher-res field
    // should report roughly double the raw value for the same world
    // offset (2 ft at 0.5 px/ft = 1 px, vs 2 ft at 1 px/ft = 2 px).
    const lowRes = buildWallSDF([{ x1: 0, y1: 5, x2: 10, y2: 5 }], 10, 10, 0.5);
    const hiRes = buildWallSDF([{ x1: 0, y1: 5, x2: 10, y2: 5 }], 10, 10, 1);
    const loD = sampleSDF(lowRes, 5, 7);
    const hiD = sampleSDF(hiRes, 5, 7);
    expect(hiD).toBeGreaterThan(loD);
  });

  it('out-of-bounds samples return Infinity', () => {
    const sdf = buildWallSDF([{ x1: 0, y1: 0, x2: 1, y2: 1 }], 5, 5, 1);
    expect(sampleSDF(sdf, -1, -1)).toBe(Infinity);
    expect(sampleSDF(sdf, 100, 100)).toBe(Infinity);
  });

  it('empty segment list leaves every cell at Infinity', () => {
    const sdf = buildWallSDF([], 5, 5, 1);
    expect(sampleSDF(sdf, 0, 0)).toBe(Infinity);
    expect(sampleSDF(sdf, 2, 2)).toBe(Infinity);
  });

  it('two parallel walls — halfway between is equidistant', () => {
    // Walls at y=2 and y=8, sample at y=5 — closer to the nearer one;
    // since they're symmetric at (width/2, 5) distances should match.
    const sdf = buildWallSDF(
      [
        { x1: 0, y1: 2, x2: 10, y2: 2 },
        { x1: 0, y1: 8, x2: 10, y2: 8 },
      ],
      10,
      10,
      1,
    );
    const d = sampleSDF(sdf, 5, 5);
    expect(d).toBeGreaterThan(2); // 3 px away from nearest wall (y=2 or y=8)
    expect(d).toBeLessThan(4);
  });
});
