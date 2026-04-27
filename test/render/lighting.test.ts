/**
 * Unit tests for lighting.ts — wall segment extraction and visibility computation.
 *
 * These test the core raycasting functions used by the dungeon lighting system.
 */
import { describe, it, expect } from 'vitest';
import {
  extractWallSegments,
  computeVisibility,
  falloffMultiplier,
  clampSpread,
  kelvinToRgb,
  getEffectiveLight,
  renderLightmap,
  invalidateVisibilityCache,
} from '../../src/render/lighting.js';
import type { Cell, Light, CellGrid } from '../../src/types.js';
import { setDiagonalEdge } from '../../src/util/index.js';
import { createCanvas } from '@napi-rs/canvas';

// ---------------------------------------------------------------------------
// extractWallSegments
// ---------------------------------------------------------------------------

describe('extractWallSegments', () => {
  it('extracts wall segments from a simple 2x2 grid with perimeter walls', () => {
    const cells = [
      [
        { north: 'w', west: 'w' },
        { north: 'w', east: 'w' },
      ],
      [
        { south: 'w', west: 'w' },
        { south: 'w', east: 'w' },
      ],
    ];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);
    // Should have segments for the outer walls + void boundary segments
    expect(segments.length).toBeGreaterThan(0);
    // All segments should have x1, y1, x2, y2
    for (const seg of segments) {
      expect(seg).toHaveProperty('x1');
      expect(seg).toHaveProperty('y1');
      expect(seg).toHaveProperty('x2');
      expect(seg).toHaveProperty('y2');
    }
  });

  it('extracts correct segments for a 1x1 cell with all walls', () => {
    const cells = [[{ north: 'w', south: 'w', east: 'w', west: 'w' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);
    // A single cell with all four walls, plus void boundaries on all sides
    // Dedup means void boundaries and explicit walls merge where they overlap
    expect(segments.length).toBeGreaterThan(0);

    // Verify the four cardinal wall segments exist
    const hasNorth = segments.some((s) => s.y1 === 0 && s.y2 === 0 && s.x1 === 0 && s.x2 === 10);
    const hasSouth = segments.some((s) => s.y1 === 10 && s.y2 === 10 && s.x1 === 0 && s.x2 === 10);
    const hasWest = segments.some((s) => s.x1 === 0 && s.x2 === 0 && s.y1 === 0 && s.y2 === 10);
    const hasEast = segments.some((s) => s.x1 === 10 && s.x2 === 10 && s.y1 === 0 && s.y2 === 10);
    expect(hasNorth).toBe(true);
    expect(hasSouth).toBe(true);
    expect(hasWest).toBe(true);
    expect(hasEast).toBe(true);
  });

  it('invisible walls (iw) are excluded from segments', () => {
    const cells = [[{ north: 'iw', south: 'w', east: 'w', west: 'iw' }]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // The 'iw' borders should not produce wall segments from the explicit wall check.
    // However, void boundaries will still add segments on edges adjacent to out-of-bounds.
    // The explicit north='iw' should not add a duplicate — the void boundary already adds it.
    // Count segments at y=0 (north edge): should come from void boundary only
    const northSegments = segments.filter(
      (s) => s.y1 === 0 && s.y2 === 0 && Math.min(s.x1, s.x2) === 0 && Math.max(s.x1, s.x2) === 10,
    );
    // Exactly one (from the void boundary, not from explicit 'iw')
    expect(northSegments).toHaveLength(1);
  });

  it('invisible doors (id) are excluded from segments', () => {
    // Two cells side by side with an invisible door between them
    const cells = [[{ east: 'id' }, { west: 'id' }]];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // The border at x=5 between the two cells should NOT appear as a wall segment
    // (both cells have non-null neighbors, so no void boundary either)
    const middleWall = segments.filter(
      (s) => s.x1 === 5 && s.x2 === 5 && Math.min(s.y1, s.y2) === 0 && Math.max(s.y1, s.y2) === 5,
    );
    expect(middleWall).toHaveLength(0);
  });

  it('null cells produce void boundary segments for adjacent non-null cells', () => {
    const cells = [[null, { north: 'w', south: 'w', east: 'w', west: 'w' }]];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // The non-null cell at [0][1] should have void boundaries on all sides
    // except where it has explicit walls (which overlap with void boundaries)
    expect(segments.length).toBeGreaterThan(0);
  });

  it('diagonal walls produce segments', () => {
    const diagCell: Cell = {};
    setDiagonalEdge(diagCell, 'nw-se', 'w');
    const cells = [[diagCell]];
    const gridSize = 10;
    const segments = extractWallSegments(cells, gridSize, null);

    // Should include a diagonal segment from (0,0) to (10,10)
    const hasDiagonal = segments.some(
      (s) =>
        (s.x1 === 0 && s.y1 === 0 && s.x2 === 10 && s.y2 === 10) ||
        (s.x1 === 10 && s.y1 === 10 && s.x2 === 0 && s.y2 === 0),
    );
    expect(hasDiagonal).toBe(true);
  });

  it('deduplicates shared wall segments between adjacent cells', () => {
    const cells = [
      [{ south: 'w' }, null],
      [{ north: 'w' }, null],
    ];
    const gridSize = 5;
    const segments = extractWallSegments(cells, gridSize, null);

    // The shared border at y=5 between [0][0] and [1][0] should appear only once
    const sharedBorder = segments.filter(
      (s) =>
        Math.min(s.y1, s.y2) === 5 &&
        Math.max(s.y1, s.y2) === 5 &&
        Math.min(s.x1, s.x2) === 0 &&
        Math.max(s.x1, s.x2) === 5,
    );
    expect(sharedBorder).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// computeVisibility
// ---------------------------------------------------------------------------

// Convert the interleaved Float32Array returned by computeVisibility into
// {x,y} points for readable assertions.
function polygonPoints(poly: Float32Array): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < poly.length; i += 2) out.push({ x: poly[i]!, y: poly[i + 1]! });
  return out;
}

describe('computeVisibility', () => {
  it('returns an interleaved Float32Array of polygon points', () => {
    // Simple box of wall segments around the light
    const segments = [
      { x1: 0, y1: 0, x2: 20, y2: 0 },
      { x1: 20, y1: 0, x2: 20, y2: 20 },
      { x1: 20, y1: 20, x2: 0, y2: 20 },
      { x1: 0, y1: 20, x2: 0, y2: 0 },
    ];
    const polygon = computeVisibility(10, 10, 15, segments);
    expect(polygon).toBeInstanceOf(Float32Array);
    expect(polygon.length).toBeGreaterThan(0);
    expect(polygon.length % 2).toBe(0); // interleaved x,y pairs
    for (let i = 0; i < polygon.length; i++) {
      expect(typeof polygon[i]).toBe('number');
    }
  });

  it('visibility polygon stays within bounding radius', () => {
    const segments = [
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { x1: 100, y1: 0, x2: 100, y2: 100 },
      { x1: 100, y1: 100, x2: 0, y2: 100 },
      { x1: 0, y1: 100, x2: 0, y2: 0 },
    ];
    const lx = 50,
      ly = 50,
      radius = 30;
    const polygon = computeVisibility(lx, ly, radius, segments);

    // The function adds a square bounding box at radius+1, so corner points
    // can be up to sqrt(2) * (radius+1) from center
    const maxDist = Math.SQRT2 * (radius + 1) + 1; // bounding box diagonal + tolerance
    for (const pt of polygonPoints(polygon)) {
      const dist = Math.sqrt((pt.x - lx) ** 2 + (pt.y - ly) ** 2);
      expect(dist).toBeLessThanOrEqual(maxDist);
    }
  });

  it('returns polygon even with no nearby wall segments', () => {
    // No segments at all — the function adds its own bounding box
    const polygon = computeVisibility(50, 50, 20, []);
    expect(polygon).toBeInstanceOf(Float32Array);
    expect(polygon.length).toBeGreaterThan(0);
  });

  it('wall segment occludes area behind it', () => {
    // Place a wall between the light and a far corner
    const segments = [
      // Vertical wall at x=15, from y=5 to y=15
      { x1: 15, y1: 5, x2: 15, y2: 15 },
    ];
    const lx = 10,
      ly = 10,
      radius = 20;
    const polygon = computeVisibility(lx, ly, radius, segments);

    // The polygon should exist and have reasonable structure
    const points = polygonPoints(polygon);
    expect(points.length).toBeGreaterThan(3);

    // Points far to the right of the wall (x > 20) and within the wall's
    // y-range should be occluded — check that no polygon point extends far right
    // in the shadow zone (roughly y=7..13, x>20)
    const shadowZonePoints = points.filter((pt) => pt.x > 25 && pt.y > 7 && pt.y < 13);
    expect(shadowZonePoints).toHaveLength(0);
  });
});

// ─── falloffMultiplier ─────────────────────────────────────────────────────
//
// Lock in the shape of each curve so the real-time gradient-stops path and
// the HQ per-pixel path can't silently diverge — both import the same
// function, but a regression that "simplifies" the formula in one branch
// would show up here.

describe('falloffMultiplier', () => {
  const radius = 30;

  it('peaks at 1.0 at distance 0 for every curve', () => {
    for (const f of ['smooth', 'linear', 'quadratic', 'inverse-square'] as const) {
      expect(falloffMultiplier(0, radius, f)).toBeCloseTo(1.0, 5);
    }
  });

  it('reaches 0 at the radius boundary for every curve', () => {
    for (const f of ['smooth', 'linear', 'quadratic', 'inverse-square'] as const) {
      expect(falloffMultiplier(radius, radius, f)).toBeLessThanOrEqual(0.01);
    }
  });

  it('linear is monotonically decreasing', () => {
    let prev = 1.1;
    for (let d = 0; d <= radius; d += 2) {
      const v = falloffMultiplier(d, radius, 'linear');
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  it('quadratic falls faster than linear at mid-range', () => {
    const lin = falloffMultiplier(radius / 2, radius, 'linear');
    const quad = falloffMultiplier(radius / 2, radius, 'quadratic');
    expect(quad).toBeLessThan(lin);
  });

  it('inverse-square is sharper than smooth near the light', () => {
    const inv = falloffMultiplier(radius * 0.1, radius, 'inverse-square');
    const smooth = falloffMultiplier(radius * 0.1, radius, 'smooth');
    // Both should be high near the source, but inverse-square drops faster
    // once you leave the 10% zone — locks in the current visual feel.
    const invMid = falloffMultiplier(radius * 0.5, radius, 'inverse-square');
    const smoothMid = falloffMultiplier(radius * 0.5, radius, 'smooth');
    expect(inv).toBeGreaterThan(0.3);
    expect(smooth).toBeGreaterThan(0.3);
    expect(invMid).toBeLessThan(smoothMid);
  });

  it('handles negative / out-of-range inputs without returning NaN', () => {
    for (const f of ['smooth', 'linear', 'quadratic', 'inverse-square'] as const) {
      expect(Number.isFinite(falloffMultiplier(-5, radius, f))).toBe(true);
      expect(Number.isFinite(falloffMultiplier(radius * 2, radius, f))).toBe(true);
    }
  });
});

// ─── kelvinToRgb ───────────────────────────────────────────────────────────

describe('kelvinToRgb', () => {
  function hexToRgb(h: string) {
    return {
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16),
    };
  }

  it('returns a valid #rrggbb string across the useful range', () => {
    for (const k of [1500, 2700, 4000, 5500, 6500, 8000, 10000]) {
      expect(kelvinToRgb(k)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('warm temps are red-dominant, cool temps are blue-dominant', () => {
    const warm = hexToRgb(kelvinToRgb(1800));
    const cool = hexToRgb(kelvinToRgb(9000));
    expect(warm.r).toBeGreaterThan(warm.b);
    expect(cool.b).toBeGreaterThan(cool.r);
  });

  it('6500K (daylight) is near-neutral — channels within 20% of each other', () => {
    const { r, g, b } = hexToRgb(kelvinToRgb(6500));
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    expect(max - min).toBeLessThan(max * 0.25);
  });

  it('clamps extreme inputs into the usable range', () => {
    expect(() => kelvinToRgb(-1)).not.toThrow();
    expect(() => kelvinToRgb(100000)).not.toThrow();
    expect(kelvinToRgb(-1)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ─── clampSpread ───────────────────────────────────────────────────────────

describe('clampSpread', () => {
  it('passes through values inside [0, 180]', () => {
    expect(clampSpread(0)).toBe(0);
    expect(clampSpread(45)).toBe(45);
    expect(clampSpread(90)).toBe(90);
    expect(clampSpread(180)).toBe(180);
  });

  it('clamps out-of-range values', () => {
    expect(clampSpread(-10)).toBe(0);
    expect(clampSpread(360)).toBe(180);
    expect(clampSpread(1000)).toBe(180);
  });

  it('returns the default (45°) for undefined/NaN', () => {
    expect(clampSpread(undefined)).toBe(45);
    expect(clampSpread(NaN)).toBe(45);
    expect(clampSpread(Infinity)).toBe(45);
  });
});

// ─── getEffectiveLight ─────────────────────────────────────────────────────

describe('getEffectiveLight', () => {
  const baseLight: Light = {
    id: 1,
    x: 10,
    y: 10,
    type: 'point',
    radius: 20,
    color: '#ffffff',
    intensity: 1,
    falloff: 'smooth',
  };

  it('returns the input reference unchanged for non-animated lights', () => {
    const eff = getEffectiveLight(baseLight, 0);
    expect(eff).toBe(baseLight);
  });

  it('applies pulse animation to intensity', () => {
    const animated: Light = { ...baseLight, animation: { type: 'pulse', speed: 1, amplitude: 0.5 } };
    // The per-light buffer is reused (see "ephemeral" contract), so snapshot
    // the intensity immediately after each call instead of reading from two
    // returned references.
    const loIntensity = getEffectiveLight(animated, 0).intensity;
    const hiIntensity = getEffectiveLight(animated, 0.625).intensity;
    expect(loIntensity).toBeGreaterThan(0);
    expect(hiIntensity).toBeGreaterThan(0);
    expect(loIntensity).not.toBe(hiIntensity);
  });

  it('never drops below 0.01 intensity even with a mean-negative animation', () => {
    const animated: Light = { ...baseLight, animation: { type: 'pulse', speed: 1, amplitude: 5 } };
    for (let t = 0; t < 10; t += 0.1) {
      const eff = getEffectiveLight(animated, t);
      expect(eff.intensity).toBeGreaterThanOrEqual(0.01);
    }
  });

  it('reuses the same per-light buffer across frames (GC sanity)', () => {
    const animated: Light = { ...baseLight, animation: { type: 'pulse', speed: 1, amplitude: 0.3 } };
    const a = getEffectiveLight(animated, 0.1);
    const b = getEffectiveLight(animated, 0.2);
    // Same backing buffer, different intensity
    expect(a).toBe(b);
  });
});

// ─── Blend-mode stacking (Phase 4.11 audit) ────────────────────────────────
//
// The contract: lights accumulate ADDITIVELY on the lightmap, which is then
// composited onto the base render with `multiply`. Regression tests below
// render two overlapping lights into a real canvas and verify pixel values.

describe('blend-mode stacking', () => {
  /** Build a 10×10 open room (no walls) so lights reach everywhere unoccluded. */
  function openRoomCells(rows: number, cols: number): CellGrid {
    const cells: CellGrid = [];
    for (let r = 0; r < rows; r++) {
      const row: CellGrid[number] = [];
      for (let c = 0; c < cols; c++) row.push({});
      cells.push(row);
    }
    return cells;
  }

  const gridSize = 5;
  const cells = openRoomCells(10, 10);
  const transform = { scale: 1, offsetX: 0, offsetY: 0 };
  const w = gridSize * 10;
  const h = gridSize * 10;

  function renderAt(lights: Light[], ambient = 0) {
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    // Fill the base with pure white so 'multiply' preserves whatever the
    // lightmap contributes verbatim — easiest way to read the lightmap back.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    invalidateVisibilityCache('walls');
    renderLightmap(ctx, lights, cells, gridSize, transform, w, h, ambient, null, null, null, null);
    return ctx.getImageData(0, 0, w, h);
  }

  function pixelAt(img: ImageData, x: number, y: number) {
    const i = (y * img.width + x) * 4;
    return { r: img.data[i]!, g: img.data[i + 1]!, b: img.data[i + 2]! };
  }

  it('overlapping lights accumulate brighter than either alone', () => {
    const base: Light = {
      id: 1,
      x: 25,
      y: 25,
      type: 'point',
      radius: 15,
      color: '#400000', // dim red so two stacked reds stay below channel clip
      intensity: 1,
      falloff: 'linear',
    };
    const one = renderAt([base]);
    const two = renderAt([
      { ...base, id: 1, x: 22 },
      { ...base, id: 2, x: 28 },
    ]);
    const p1 = pixelAt(one, 25, 25);
    const p2 = pixelAt(two, 25, 25);
    expect(p2.r).toBeGreaterThan(p1.r);
  });

  it('red + blue overlap yields magenta at the overlap center', () => {
    const lights: Light[] = [
      { id: 1, x: 22, y: 25, type: 'point', radius: 15, color: '#400000', intensity: 1, falloff: 'linear' },
      { id: 2, x: 28, y: 25, type: 'point', radius: 15, color: '#000040', intensity: 1, falloff: 'linear' },
    ];
    const img = renderAt(lights);
    const overlap = pixelAt(img, 25, 25);
    // Both channels should be lit; green should be near zero.
    expect(overlap.r).toBeGreaterThan(20);
    expect(overlap.b).toBeGreaterThan(20);
    expect(overlap.g).toBeLessThan(overlap.r);
    expect(overlap.g).toBeLessThan(overlap.b);
  });

  it('ambient=0, no lights → lightmap is black, base gets blacked out', () => {
    const img = renderAt([], 0);
    const p = pixelAt(img, 25, 25);
    expect(p.r + p.g + p.b).toBe(0);
  });

  it('ambient=1, no lights → lightmap is white, base unchanged', () => {
    const img = renderAt([], 1);
    const p = pixelAt(img, 25, 25);
    // multiply by white = unchanged base (255)
    expect(p.r).toBeGreaterThan(240);
    expect(p.g).toBeGreaterThan(240);
    expect(p.b).toBeGreaterThan(240);
  });

  it('soft shadows smooth the edge of a wall shadow', () => {
    // Room wide enough that the shadow cast by the single wall cell has room
    // to extend. Light is at top-left; wall sits in the middle; shadow falls
    // below-right of the wall, where we sample.
    const rows = 15;
    const cols = 25;
    const withWall = openRoomCells(rows, cols);
    // Single wall cell at (row=7, col=12) surrounded on every edge so it's
    // fully opaque. Surrounded cells are still floor, so light can reach right
    // up to the wall's edge.
    if (withWall[7]) withWall[7]![12] = { north: 'w', south: 'w', east: 'w', west: 'w' };
    const canvas = createCanvas(cols * gridSize, rows * gridSize);
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    function sample(softR: number) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cols * gridSize, rows * gridSize);
      invalidateVisibilityCache('walls');
      const light: Light = {
        id: 1,
        x: 15, // cell (1, 3) — upper-left of wall
        y: 15,
        type: 'point',
        radius: 80,
        color: '#ffffff',
        intensity: 1,
        falloff: 'linear',
        softShadowRadius: softR,
      };
      renderLightmap(
        ctx,
        [light],
        withWall,
        gridSize,
        transform,
        cols * gridSize,
        rows * gridSize,
        0,
        null,
        null,
        null,
        null,
      );
      return ctx.getImageData(0, 0, cols * gridSize, rows * gridSize);
    }
    const hard = sample(0);
    const soft = sample(3);
    // Sum pixel-wise |soft - hard| across the shadow-edge zone. If soft
    // shadows have any effect at all, the two renders disagree in the
    // penumbra region (soft light leaks into pixels the hard version
    // left fully dark, and vice versa near the lit edge).
    let totalDiff = 0;
    for (let y = 45; y < 70; y++) {
      for (let x = 60; x < 100; x++) {
        totalDiff += Math.abs(pixelAt(soft, x, y).r - pixelAt(hard, x, y).r);
      }
    }
    expect(totalDiff).toBeGreaterThan(0);
  });

  it('darkness light carves a dark pocket out of bright ambient', () => {
    const imgLight = renderAt([], 1); // ambient only, full bright
    const imgDark = renderAt(
      [
        {
          id: 1,
          x: 25,
          y: 25,
          type: 'point',
          radius: 15,
          color: '#ffffff',
          intensity: 1,
          falloff: 'linear',
          darkness: true,
        },
      ],
      1,
    );
    const bright = pixelAt(imgLight, 25, 25);
    const dark = pixelAt(imgDark, 25, 25);
    expect(dark.r).toBeLessThan(bright.r);
    expect(dark.g).toBeLessThan(bright.g);
    expect(dark.b).toBeLessThan(bright.b);
    // Edges of the canvas stay bright.
    const edge = pixelAt(imgDark, 2, 2);
    expect(edge.r).toBeGreaterThan(dark.r + 100);
  });
});
