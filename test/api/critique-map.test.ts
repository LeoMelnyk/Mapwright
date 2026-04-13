import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';
import { critiqueMap } from '../../src/editor/js/api/validation.js';
import { markPropSpatialDirty } from '../../src/editor/js/prop-spatial.js';

function buildRoom(r1: number, c1: number, r2: number, c2: number, label?: string) {
  const cells = state.dungeon.cells;
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      cells[r][c] = {};
      if (r === r1) cells[r][c].north = 'w';
      if (r === r2) cells[r][c].south = 'w';
      if (c === c1) cells[r][c].west = 'w';
      if (c === c2) cells[r][c].east = 'w';
    }
  }
  if (label) {
    const lr = Math.floor((r1 + r2) / 2);
    const lc = Math.floor((c1 + c2) / 2);
    cells[lr][lc].center = { label };
  }
}

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 30, 30, 5, 'stone-dungeon', 1);
  state.undoStack = [];
  state.redoStack = [];
  state.propCatalog = {
    categories: ['furniture', 'features'],
    props: {
      pillar: {
        name: 'pillar',
        category: 'furniture',
        footprint: [1, 1],
        facing: false,
        placement: 'wall',
        roomTypes: ['any'],
        typicalCount: '4',
        clustersWith: [],
        notes: null,
      },
      brazier: {
        name: 'brazier',
        category: 'features',
        footprint: [1, 1],
        facing: false,
        placement: 'wall',
        roomTypes: ['any'],
        typicalCount: '2',
        clustersWith: [],
        lights: [{ preset: 'brazier', x: 0.5, y: 0.5 }],
        notes: null,
      },
    },
  };
  markPropSpatialDirty();
});

describe('critiqueMap', () => {
  it('returns no findings for an empty map', () => {
    const r = critiqueMap();
    expect(r.success).toBe(true);
    expect(r.findingCount).toBe(0);
  });

  it('flags a labeled room with no props (completeness lens)', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = critiqueMap({ lenses: ['completeness'] });
    const noProps = r.findings.find((f) => f.message.includes('no props'));
    expect(noProps).toBeDefined();
    expect(noProps?.severity).toBe('warning');
  });

  it('flags rooms with no centerpiece near centroid', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    // Add one prop in the corner — far from centroid
    state.dungeon.metadata.props = [
      {
        id: 1,
        type: 'pillar',
        x: 3 * 5,
        y: 3 * 5,
        rotation: 0,
        scale: 1,
        flipped: false,
        zIndex: 0,
      },
    ];
    markPropSpatialDirty();
    const r = critiqueMap({ lenses: ['completeness'] });
    const noCenter = r.findings.find((f) => f.message.includes('centerpiece'));
    expect(noCenter).toBeDefined();
  });

  it('flags overcrowded rooms (spatial lens)', () => {
    buildRoom(2, 2, 4, 4, 'A1'); // 9 cells
    const props = [];
    let id = 1;
    for (let r = 2; r <= 4; r++) {
      for (let c = 2; c <= 4; c++) {
        props.push({
          id: id++,
          type: 'pillar',
          x: c * 5,
          y: r * 5,
          rotation: 0,
          scale: 1,
          flipped: false,
          zIndex: 0,
        });
      }
    }
    state.dungeon.metadata.props = props;
    markPropSpatialDirty();
    const r = critiqueMap({ lenses: ['spatial'] });
    const overcrowded = r.findings.find((f) => f.message.includes('density'));
    expect(overcrowded).toBeDefined();
  });

  it('flags homogeneous prop usage (composition lens)', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    state.dungeon.metadata.props = [
      { id: 1, type: 'pillar', x: 4 * 5, y: 4 * 5, rotation: 0, scale: 1, flipped: false, zIndex: 0 },
      { id: 2, type: 'pillar', x: 6 * 5, y: 4 * 5, rotation: 0, scale: 1, flipped: false, zIndex: 0 },
      { id: 3, type: 'pillar', x: 8 * 5, y: 4 * 5, rotation: 0, scale: 1, flipped: false, zIndex: 0 },
    ];
    markPropSpatialDirty();
    const r = critiqueMap({ lenses: ['composition'] });
    const homo = r.findings.find((f) => f.message.includes('homogeneous'));
    expect(homo).toBeDefined();
  });

  it('flags rooms with light-emitting props but no lights (lighting lens)', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    // Manually inject a brazier prop without going through placeProp (so no auto-light)
    state.dungeon.metadata.props = [
      { id: 1, type: 'brazier', x: 5 * 5, y: 5 * 5, rotation: 0, scale: 1, flipped: false, zIndex: 0 },
    ];
    markPropSpatialDirty();
    state.dungeon.metadata.lights = []; // explicitly clear
    const r = critiqueMap({ lenses: ['lighting'] });
    const orphan = r.findings.find((f) => f.message.includes('light-emitting'));
    expect(orphan).toBeDefined();
    expect(orphan?.severity).toBe('error');
  });

  it('flags blown-out lighting (intensity above threshold)', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    state.dungeon.metadata.props = [];
    state.dungeon.metadata.lights = [
      { id: 1, x: 5 * 5, y: 5 * 5, type: 'point', radius: 20, color: '#fff', intensity: 1.5, falloff: 'smooth' },
      { id: 2, x: 6 * 5, y: 5 * 5, type: 'point', radius: 20, color: '#fff', intensity: 1.5, falloff: 'smooth' },
    ];
    markPropSpatialDirty();
    const r = critiqueMap({ lenses: ['lighting'], intensitySumThreshold: 2.0 });
    const blown = r.findings.find((f) => f.message.includes('blown out'));
    expect(blown).toBeDefined();
  });

  it('respects the lenses option', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = critiqueMap({ lenses: ['completeness'] });
    expect(r.findings.every((f) => f.lens === 'completeness')).toBe(true);
  });

  it('sorts findings error → warning → info', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    state.dungeon.metadata.props = [
      { id: 1, type: 'brazier', x: 5 * 5, y: 5 * 5, rotation: 0, scale: 1, flipped: false, zIndex: 0 },
    ];
    markPropSpatialDirty();
    state.dungeon.metadata.lights = [];
    const r = critiqueMap();
    const sevOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < r.findings.length; i++) {
      expect(sevOrder[r.findings[i].severity]).toBeGreaterThanOrEqual(sevOrder[r.findings[i - 1].severity]);
    }
  });
});
