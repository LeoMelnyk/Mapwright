import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';
import { describeMap } from '../../src/editor/js/api/inspect.js';
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

describe('describeMap', () => {
  it('returns one snapshot per labeled room', () => {
    buildRoom(2, 2, 6, 8, 'A1');
    buildRoom(2, 12, 6, 18, 'A2');
    const r = describeMap();
    expect(r.success).toBe(true);
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms.map((x) => x.label).sort()).toEqual(['A1', 'A2']);
  });

  it('describes a single room when label option passed', () => {
    buildRoom(2, 2, 6, 8, 'A1');
    buildRoom(2, 12, 6, 18, 'A2');
    const r = describeMap({ label: 'A1' });
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms[0].label).toBe('A1');
  });

  it('throws when label not found', () => {
    expect(() => describeMap({ label: 'Nowhere' })).toThrow(/not found/);
  });

  it('includes ASCII shape by default', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const r = describeMap();
    expect(r.rooms[0].ascii.length).toBeGreaterThan(0);
    expect(r.rooms[0].ascii).toContain('+');
    expect(r.rooms[0].ascii).toContain('|');
  });

  it('omits ASCII when includeAscii=false', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const r = describeMap({ includeAscii: false });
    expect(r.rooms[0].ascii).toBe('');
  });

  it('reports cellCount as the actual flood-fill size, not bbox', () => {
    buildRoom(2, 2, 5, 5, 'A1'); // 4×4 = 16 cells
    const r = describeMap({ label: 'A1' });
    expect(r.rooms[0].cellCount).toBe(16);
  });

  it('returns map metadata at top level', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const r = describeMap();
    expect(r.map.name).toBe('Test');
    expect(r.map.theme).toBe('stone-dungeon');
    expect(r.map.rows).toBeGreaterThan(0);
    expect(r.map.cols).toBeGreaterThan(0);
  });
});
