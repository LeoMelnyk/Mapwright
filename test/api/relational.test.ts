import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';
import { placeRelative, placeSymmetric, placeFlanking } from '../../src/editor/js/api/spatial.js';
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
    categories: ['furniture'],
    props: {
      throne: {
        name: 'throne',
        category: 'furniture',
        footprint: [1, 1],
        facing: true,
        placement: 'center',
        roomTypes: ['throne-room'],
        typicalCount: '1',
        clustersWith: [],
        notes: null,
      },
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
    },
  };
  markPropSpatialDirty();
});

describe('placeRelative', () => {
  it('places a prop offset from an anchor cell in a cardinal direction', () => {
    buildRoom(2, 2, 8, 8, 'A1');
    const r = placeRelative(5, 5, 'east', 2, 'pillar');
    expect(r.success).toBe(true);
    expect(r.row).toBe(5);
    expect(r.col).toBe(7);
  });

  it('throws on invalid direction', () => {
    buildRoom(2, 2, 8, 8, 'A1');
    expect(() => placeRelative(5, 5, 'diagonal', 2, 'pillar')).toThrow(/direction must be/);
  });

  it('throws on negative offset', () => {
    buildRoom(2, 2, 8, 8, 'A1');
    expect(() => placeRelative(5, 5, 'east', -1, 'pillar')).toThrow(/non-negative/);
  });

  it('handles all four cardinal directions correctly', () => {
    buildRoom(2, 2, 10, 10, 'A1');
    const east = placeRelative(6, 6, 'east', 1, 'pillar');
    const west = placeRelative(6, 6, 'west', 1, 'pillar');
    const north = placeRelative(6, 6, 'north', 1, 'pillar');
    const south = placeRelative(6, 6, 'south', 1, 'pillar');
    expect(east.col).toBe(7);
    expect(west.col).toBe(5);
    expect(north.row).toBe(5);
    expect(south.row).toBe(7);
  });
});

describe('placeSymmetric', () => {
  it('places a pair mirrored across vertical centerline', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = placeSymmetric('A1', 'vertical', 5, 4, 'pillar');
    expect(r.placed).toHaveLength(2);
    expect(r.placed[0].col).toBe(4);
    // bbox is c1=2, c2=12, so mirror of 4 = 2+12-4 = 10
    expect(r.placed[1].col).toBe(10);
    expect(r.placed[0].row).toBe(r.placed[1].row);
  });

  it('places a pair mirrored across horizontal centerline', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = placeSymmetric('A1', 'horizontal', 3, 7, 'pillar');
    expect(r.placed).toHaveLength(2);
    // bbox r1=2, r2=8, so mirror of 3 = 2+8-3 = 7
    expect(r.placed[1].row).toBe(7);
    expect(r.placed[0].col).toBe(r.placed[1].col);
  });

  it('returns single placement when anchor lies on the axis', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    // Centerline is at col 7 (since (2+12)/2=7). Place at col 7 — mirror is same cell.
    const r = placeSymmetric('A1', 'vertical', 5, 7, 'pillar');
    expect(r.placed).toHaveLength(1);
  });

  it('mirrors facing for facing props', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = placeSymmetric('A1', 'vertical', 5, 4, 'throne', 90); // east-facing
    expect(r.placed[0].facing).toBe(90);
    expect(r.placed[1].facing).toBe(270); // west-facing on the mirror
  });

  it('throws on invalid axis', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    expect(() => placeSymmetric('A1', 'diagonal', 5, 4, 'pillar')).toThrow(/axis must be/);
  });

  it('throws when room not found', () => {
    expect(() => placeSymmetric('Nowhere', 'vertical', 5, 4, 'pillar')).toThrow(/not found/);
  });
});

describe('placeFlanking', () => {
  it('flanks an anchor prop with two copies', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    state.dungeon.metadata.props = [];
    state.dungeon.metadata.nextPropId = 1;
    const gs = state.dungeon.metadata.gridSize || 5;
    state.dungeon.metadata.props.push({
      id: 1,
      type: 'throne',
      x: 7 * gs,
      y: 5 * gs,
      rotation: 0,
      scale: 1,
      flipped: false,
      zIndex: 0,
    });
    markPropSpatialDirty();
    const r = placeFlanking('A1', 'throne', 'pillar', { gap: 1 });
    expect(r.placed.length).toBeGreaterThanOrEqual(1);
    expect(r.anchor.row).toBe(5);
    expect(r.anchor.col).toBe(7);
  });

  it('throws when anchor prop not found in room', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    state.dungeon.metadata.props = [];
    expect(() => placeFlanking('A1', 'throne', 'pillar')).toThrow(/No "throne" prop found/);
  });

  it('throws when room not found', () => {
    expect(() => placeFlanking('Nowhere', 'throne', 'pillar')).toThrow(/Room "Nowhere" not found/);
  });
});
