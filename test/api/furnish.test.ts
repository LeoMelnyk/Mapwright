import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';

import { autofurnish, furnishBrief } from '../../src/editor/js/api/furnish.js';
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
        roomTypes: ['throne-room', 'any'],
        typicalCount: '4',
        clustersWith: [],
        notes: null,
      },
      rubble: {
        name: 'rubble',
        category: 'furniture',
        footprint: [1, 1],
        facing: false,
        placement: 'floor',
        roomTypes: ['any'],
        typicalCount: '3',
        clustersWith: [],
        notes: null,
      },
    },
  };
  markPropSpatialDirty();
});

// ─── autofurnish ────────────────────────────────────────────────────────────

describe('autofurnish', () => {
  it('places a centerpiece, wall props, and floor props for a known roomType', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = autofurnish('A1', 'throne-room', { density: 'normal' });
    expect(r.success).toBe(true);
    expect(r.placed.length).toBeGreaterThan(0);
    // Centerpiece is 'throne'
    expect(r.placed.some((p) => p.via === 'centerpiece' && p.type === 'throne')).toBe(true);
  });

  it('reports an empty result when no props match the roomType', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    // Replace catalog with props that don't match any roomType including 'any'
    state.propCatalog = {
      categories: ['furniture'],
      props: {
        altar: {
          name: 'altar',
          category: 'furniture',
          footprint: [1, 1],
          facing: false,
          placement: 'center',
          roomTypes: ['temple'],
          typicalCount: '1',
          clustersWith: [],
          notes: null,
        },
      },
    };
    const r = autofurnish('A1', 'nonexistent-type');
    expect(r.placed).toHaveLength(0);
    expect(r.skipped.some((s) => s.reason.includes('No props tagged'))).toBe(true);
  });

  it('throws ROOM_NOT_FOUND for unknown labels', () => {
    expect(() => autofurnish('Nowhere', 'throne-room')).toThrow(/not found/);
  });

  it('places centerpiece inside L-shaped rooms (not in the void corner)', () => {
    // L-shape: 6x6 room with the top-right 3x3 corner removed.
    //   columns 2..7, rows 2..7, minus rows 2..4 cols 5..7.
    // bbox center = (4.5, 4.5) -> rounds to (4,4) which IS in the room here,
    // so let's use a more aggressive shape: 10x10 with top-right 6x6 missing.
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 11; r++) {
      for (let c = 2; c <= 11; c++) {
        // Remove the top-right 6x6 quadrant (rows 2..7, cols 6..11)
        if (r <= 7 && c >= 6) continue;
        cells[r][c] = {};
      }
    }
    cells[10][3].center = { label: 'L1' };

    const r = autofurnish('L1', 'throne-room', { density: 'sparse' });
    const centerpiece = r.placed.find((p) => p.via === 'centerpiece');
    expect(centerpiece).toBeDefined();
    if (!centerpiece) return;
    // The placed centerpiece must land on an actual room cell, not in the void.
    expect(cells[centerpiece.row]?.[centerpiece.col]).not.toBeNull();
  });

  it('throws INVALID_DENSITY for unknown density', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    // @ts-expect-error -- testing invalid input
    expect(() => autofurnish('A1', 'throne-room', { density: 'extreme' })).toThrow(/density must be/);
  });
});

// ─── furnishBrief ───────────────────────────────────────────────────────────

describe('furnishBrief', () => {
  it('runs autofurnish for each room in the brief', () => {
    buildRoom(2, 2, 6, 6, 'A1');
    buildRoom(2, 10, 6, 14, 'A2');
    const r = furnishBrief({
      rooms: [
        { label: 'A1', role: 'throne-room', density: 'normal' },
        { label: 'A2', role: 'throne-room', density: 'sparse' },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.rooms).toHaveLength(2);
    expect(r.totals.placed).toBeGreaterThan(0);
  });

  it('records per-room failures without aborting the batch', () => {
    buildRoom(2, 2, 6, 6, 'A1');
    const r = furnishBrief({
      rooms: [
        { label: 'A1', role: 'throne-room' },
        { label: 'Nowhere', role: 'throne-room' },
      ],
    });
    expect(r.rooms).toHaveLength(2);
    expect(r.rooms[1].placed).toHaveLength(0);
    expect(r.rooms[1].skipped[0].reason).toMatch(/ROOM_NOT_FOUND|not found/);
  });

  it('throws EMPTY_BRIEF for empty rooms array', () => {
    expect(() => furnishBrief({ rooms: [] })).toThrow(/requires brief.rooms/);
  });
});
