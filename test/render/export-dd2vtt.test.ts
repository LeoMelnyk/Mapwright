/**
 * Unit tests for the dd2vtt export module.
 *
 * These tests exercise buildDd2vtt() — the function that converts a mapwright
 * dungeon config + rendered PNG into Universal VTT (.dd2vtt) JSON format.
 *
 * No canvas or @napi-rs/canvas dependency — we use a fake PNG buffer and only
 * verify the JSON structure, coordinate math, and deduplication logic.
 */
import { describe, it, expect } from 'vitest';
import { buildDd2vtt } from '../../src/render/export-dd2vtt.js';

// Constants duplicated here so tests break loudly if the source values change
const GRID_SCALE = 20;
const MARGIN = 100;

const fakePng = Buffer.from('fake-png-data');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config: 1x1 grid, no walls, no lights. */
function emptyConfig(overrides = {}) {
  return {
    metadata: {
      gridSize: 5,
      resolution: 1,
      ambientLight: 0.5,
      lightingEnabled: false,
      lights: [],
      ...overrides,
    },
    cells: [[null]],
  };
}

/** A single cell with the given edges. */
function singleCellConfig(edges, metaOverrides = {}) {
  return {
    metadata: {
      gridSize: 5,
      resolution: 1,
      ambientLight: 0.5,
      lightingEnabled: true,
      lights: [],
      ...metaOverrides,
    },
    cells: [[{ north: null, south: null, east: null, west: null, ...edges }]],
  };
}

/** 2x2 grid helper — caller provides an array of 4 cell objects (or nulls). */
function grid2x2(cellArray, metaOverrides = {}) {
  return {
    metadata: {
      gridSize: 5,
      resolution: 1,
      ambientLight: 0.5,
      lightingEnabled: true,
      lights: [],
      ...metaOverrides,
    },
    cells: [
      [cellArray[0], cellArray[1]],
      [cellArray[2], cellArray[3]],
    ],
  };
}

function cell(n, e, s, w) {
  return { north: n, south: s, east: e, west: w };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildDd2vtt', () => {
  // -- Top-level format structure ------------------------------------------

  describe('format structure', () => {
    it('returns format 0.3', () => {
      const result = buildDd2vtt(fakePng, emptyConfig(), 500, 500);
      expect(result.format).toBe(0.3);
    });

    it('contains all required top-level keys', () => {
      const result = buildDd2vtt(fakePng, emptyConfig(), 500, 500);
      expect(result).toHaveProperty('format');
      expect(result).toHaveProperty('resolution');
      expect(result).toHaveProperty('image');
      expect(result).toHaveProperty('line_of_sight');
      expect(result).toHaveProperty('portals');
      expect(result).toHaveProperty('lights');
      expect(result).toHaveProperty('environment');
    });

    it('resolution contains map_origin, map_size, and pixels_per_grid', () => {
      const result = buildDd2vtt(fakePng, emptyConfig(), 500, 500);
      expect(result.resolution).toHaveProperty('map_origin');
      expect(result.resolution).toHaveProperty('map_size');
      expect(result.resolution).toHaveProperty('pixels_per_grid');
      expect(result.resolution.map_origin).toEqual({ x: 0, y: 0 });
    });
  });

  // -- Image encoding ------------------------------------------------------

  describe('image encoding', () => {
    it('encodes the PNG buffer as base64', () => {
      const result = buildDd2vtt(fakePng, emptyConfig(), 500, 500);
      expect(result.image).toBe(fakePng.toString('base64'));
    });

    it('round-trips the base64 back to the original buffer', () => {
      const result = buildDd2vtt(fakePng, emptyConfig(), 500, 500);
      const decoded = Buffer.from(result.image, 'base64');
      expect(decoded.toString()).toBe('fake-png-data');
    });
  });

  // -- Resolution / grid math ----------------------------------------------

  describe('resolution calculation', () => {
    it('pixels_per_grid = GRID_SCALE * gridSize * resolution', () => {
      const config = emptyConfig({ gridSize: 5, resolution: 1 });
      const result = buildDd2vtt(fakePng, config, 200, 200);
      // 20 * 5 * 1 = 100
      expect(result.resolution.pixels_per_grid).toBe(100);
    });

    it('pixels_per_grid scales with resolution', () => {
      const config = emptyConfig({ gridSize: 5, resolution: 2 });
      const result = buildDd2vtt(fakePng, config, 400, 400);
      // 20 * 5 * 2 = 200
      expect(result.resolution.pixels_per_grid).toBe(200);
    });

    it('map_size is canvas dimensions divided by pixels_per_grid', () => {
      const config = emptyConfig({ gridSize: 5, resolution: 1 });
      const ppg = GRID_SCALE * 5;
      const result = buildDd2vtt(fakePng, config, 500, 300);
      expect(result.resolution.map_size.x).toBeCloseTo(500 / ppg, 5);
      expect(result.resolution.map_size.y).toBeCloseTo(300 / ppg, 5);
    });
  });

  // -- Environment ---------------------------------------------------------

  describe('environment', () => {
    it('ambient light maps to environment.brt', () => {
      const result = buildDd2vtt(fakePng, emptyConfig({ ambientLight: 0.8 }), 500, 500);
      expect(result.environment.brt).toBe(0.8);
    });

    it('defaults ambientLight to 0.5 when undefined', () => {
      const config = {
        metadata: { gridSize: 5, resolution: 1, ambientLight: 0.5, lightingEnabled: false, lights: [] },
        cells: [[null]],
      };
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.environment.brt).toBe(0.5);
    });

    it('environment.exp is always 0', () => {
      const result = buildDd2vtt(fakePng, emptyConfig(), 500, 500);
      expect(result.environment.exp).toBe(0);
    });
  });

  // -- Wall extraction (line_of_sight) -------------------------------------

  describe('wall extraction', () => {
    it('cell with wall on north produces one line_of_sight entry', () => {
      const config = singleCellConfig({ north: 'w' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.line_of_sight).toHaveLength(1);
      // Each entry is a pair of {x,y} points
      expect(result.line_of_sight[0]).toHaveLength(2);
      expect(result.line_of_sight[0][0]).toHaveProperty('x');
      expect(result.line_of_sight[0][0]).toHaveProperty('y');
    });

    it('cell with walls on all four sides produces four entries', () => {
      const config = singleCellConfig({ north: 'w', south: 'w', east: 'w', west: 'w' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.line_of_sight).toHaveLength(4);
    });

    it('null edges are ignored', () => {
      const config = singleCellConfig({ north: null, south: null, east: null, west: null });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.line_of_sight).toHaveLength(0);
      expect(result.portals).toHaveLength(0);
    });
  });

  // -- Door extraction (portals) -------------------------------------------

  describe('door extraction', () => {
    it('door edge becomes a portal with closed=true', () => {
      const config = singleCellConfig({ east: 'd' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.portals).toHaveLength(1);
      expect(result.portals[0].closed).toBe(true);
      expect(result.portals[0].freestanding).toBe(false);
    });

    it('secret door edge becomes a portal with closed=true', () => {
      const config = singleCellConfig({ south: 's' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.portals).toHaveLength(1);
      expect(result.portals[0].closed).toBe(true);
    });

    it('portal has position at midpoint of bounds', () => {
      const config = singleCellConfig({ north: 'd' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      const portal = result.portals[0];
      const midX = (portal.bounds[0].x + portal.bounds[1].x) / 2;
      const midY = (portal.bounds[0].y + portal.bounds[1].y) / 2;
      expect(portal.position.x).toBeCloseTo(midX, 5);
      expect(portal.position.y).toBeCloseTo(midY, 5);
    });

    it('horizontal door (north/south) has rotation 0', () => {
      const config = singleCellConfig({ north: 'd' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.portals[0].rotation).toBe(0);
    });

    it('vertical door (east/west) has rotation 90', () => {
      const config = singleCellConfig({ west: 'd' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.portals[0].rotation).toBe(90);
    });

    it('doors do not appear in line_of_sight', () => {
      const config = singleCellConfig({ north: 'd', south: 's' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.line_of_sight).toHaveLength(0);
      expect(result.portals).toHaveLength(2);
    });
  });

  // -- Invisible walls / doors ---------------------------------------------

  describe('invisible walls and doors', () => {
    it('invisible wall (iw) is excluded from line_of_sight', () => {
      const config = singleCellConfig({ north: 'iw', south: 'w' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.line_of_sight).toHaveLength(1); // only south wall
    });

    it('invisible door (id) is excluded from portals', () => {
      const config = singleCellConfig({ east: 'id', west: 'd' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.portals).toHaveLength(1); // only west door
    });

    it('all-invisible cell produces no entries', () => {
      const config = singleCellConfig({ north: 'iw', south: 'iw', east: 'id', west: 'id' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.line_of_sight).toHaveLength(0);
      expect(result.portals).toHaveLength(0);
    });
  });

  // -- Deduplication -------------------------------------------------------

  describe('wall deduplication', () => {
    it('identical edges on the same cell direction are deduplicated', () => {
      // The dedup key includes direction, so east/west on shared border are distinct.
      // But two cells sharing the exact same direction+segment key are deduplicated.
      // With direction in the key, adjacent cells produce separate entries for
      // each side of a shared border (east vs west, south vs north).
      const config = grid2x2([
        cell('w', 'w', 'w', 'w'), // row 0, col 0 — 4 walls
        cell('w', 'w', 'w', 'w'), // row 0, col 1 — 4 walls (west != east key)
        null,
        null,
      ]);
      const result = buildDd2vtt(fakePng, config, 500, 500);
      // Each cell contributes all 4 walls — direction makes keys distinct
      expect(result.line_of_sight).toHaveLength(8);
    });

    it('vertically adjacent cells each contribute their own edge', () => {
      const config = grid2x2([
        cell('w', 'w', 'w', 'w'), // row 0, col 0
        null,
        cell('w', 'w', 'w', 'w'), // row 1, col 0
        null,
      ]);
      const result = buildDd2vtt(fakePng, config, 500, 500);
      // south of row0 and north of row1 have different direction keys
      expect(result.line_of_sight).toHaveLength(8);
    });

    it('same cell processed once — no duplicate walls within a single cell', () => {
      // A single cell with 4 walls produces exactly 4 entries
      const config = singleCellConfig({ north: 'w', south: 'w', east: 'w', west: 'w' });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.line_of_sight).toHaveLength(4);
    });
  });

  // -- Empty dungeon -------------------------------------------------------

  describe('empty dungeon', () => {
    it('no cells (all null) produces empty arrays', () => {
      const config = {
        metadata: { gridSize: 5, resolution: 1, ambientLight: 0.5, lightingEnabled: true, lights: [] },
        cells: [[null, null], [null, null]],
      };
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.line_of_sight).toEqual([]);
      expect(result.portals).toEqual([]);
      expect(result.lights).toEqual([]);
    });
  });

  // -- Lights --------------------------------------------------------------

  describe('light extraction', () => {
    it('converts lights to dd2vtt format with position, range, intensity, color', () => {
      const config = singleCellConfig({}, {
        lightingEnabled: true,
        lights: [
          { x: 5, y: 5, radius: 20, intensity: 0.8, color: '#ff9944' },
        ],
      });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.lights).toHaveLength(1);

      const light = result.lights[0];
      expect(light).toHaveProperty('position');
      expect(light.position).toHaveProperty('x');
      expect(light.position).toHaveProperty('y');
      expect(light).toHaveProperty('range');
      expect(light.intensity).toBe(0.8);
      expect(light).toHaveProperty('color');
      expect(light.shadows).toBe(true);
    });

    it('light radius is converted from feet to grid units', () => {
      const gridSize = 5;
      const config = singleCellConfig({}, {
        gridSize,
        resolution: 1,
        lightingEnabled: true,
        lights: [
          { x: 0, y: 0, radius: 20, intensity: 1.0, color: '#ffffff' },
        ],
      });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      // radius 20 feet / displayGridSize 5 = 4 grid units
      expect(result.lights[0].range).toBe(4);
    });

    it('light color is converted from hex to space-separated 0-1 RGB', () => {
      const config = singleCellConfig({}, {
        lightingEnabled: true,
        lights: [
          { x: 0, y: 0, radius: 10, intensity: 1.0, color: '#ff0000' },
        ],
      });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.lights[0].color).toBe('1.000 0.000 0.000');
    });

    it('white light color parses correctly', () => {
      const config = singleCellConfig({}, {
        lightingEnabled: true,
        lights: [
          { x: 0, y: 0, radius: 10, intensity: 1.0, color: '#ffffff' },
        ],
      });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.lights[0].color).toBe('1.000 1.000 1.000');
    });

    it('no lights when lightingEnabled is false', () => {
      const config = singleCellConfig({}, {
        lightingEnabled: false,
        lights: [
          { x: 5, y: 5, radius: 20, intensity: 1.0, color: '#ff9944' },
        ],
      });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.lights).toEqual([]);
    });

    it('no lights when lights array is empty', () => {
      const config = singleCellConfig({}, {
        lightingEnabled: true,
        lights: [],
      });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.lights).toEqual([]);
    });

    it('multiple lights are all exported', () => {
      const config = singleCellConfig({}, {
        lightingEnabled: true,
        lights: [
          { x: 0, y: 0, radius: 10, intensity: 1.0, color: '#ff0000' },
          { x: 10, y: 10, radius: 30, intensity: 0.5, color: '#0000ff' },
        ],
      });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.lights).toHaveLength(2);
    });

    it('defaults light intensity to 1.0 if not specified', () => {
      const config = singleCellConfig({}, {
        lightingEnabled: true,
        lights: [
          { x: 0, y: 0, radius: 10, intensity: 1.0, color: '#ff9944' },
        ],
      });
      const result = buildDd2vtt(fakePng, config, 500, 500);
      expect(result.lights[0].intensity).toBe(1.0);
    });
  });
});
