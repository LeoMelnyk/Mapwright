import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';
import { proposeFurnishing, commitFurnishing } from '../../src/editor/js/api/furnish.js';
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
        clustersWith: ['pillar'],
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
        clustersWith: ['throne'],
        notes: null,
      },
      brazier: {
        name: 'brazier',
        category: 'features',
        footprint: [1, 1],
        facing: false,
        placement: 'wall',
        roomTypes: ['throne-room', 'any'],
        typicalCount: '2',
        clustersWith: [],
        lights: [{ preset: 'brazier', x: 0.5, y: 0.5 }],
        notes: null,
      },
      rubble: {
        name: 'rubble',
        category: 'features',
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

describe('proposeFurnishing', () => {
  it('returns a plan without touching the map', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const before = state.dungeon.metadata.props?.length ?? 0;
    const r = proposeFurnishing('A1', 'throne-room');
    const after = state.dungeon.metadata.props?.length ?? 0;
    expect(r.success).toBe(true);
    expect(r.plan.length).toBeGreaterThan(0);
    expect(after).toBe(before); // no mutation
  });

  it('marks the centerpiece as primary', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = proposeFurnishing('A1', 'throne-room');
    const primary = r.plan.find((p) => p.role === 'primary');
    expect(primary).toBeDefined();
    expect(primary?.prop).toBe('throne');
  });

  it('honors clustersWith for secondary selection', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = proposeFurnishing('A1', 'throne-room', { density: 'normal' });
    // pillar clustersWith throne → should be among secondaries/flanks
    const hasPillar = r.plan.some((p) => p.prop === 'pillar' && (p.role === 'secondary' || p.role === 'flank'));
    expect(hasPillar).toBe(true);
  });

  it('respects the lightCap option', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const r = proposeFurnishing('A1', 'throne-room', { density: 'dense', lightCap: 1 });
    const litCount = r.plan.filter((p) => p.prop === 'brazier').length;
    expect(litCount).toBeLessThanOrEqual(1);
  });

  it('caps secondary count by density budget', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const sparse = proposeFurnishing('A1', 'throne-room', { density: 'sparse' });
    state.dungeon = createEmptyDungeon('Test', 30, 30, 5, 'stone-dungeon', 1);
    buildRoom(2, 2, 8, 12, 'A1');
    const dense = proposeFurnishing('A1', 'throne-room', { density: 'dense' });
    expect(dense.plan.length).toBeGreaterThan(sparse.plan.length);
  });

  it('throws on invalid density', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    // @ts-expect-error -- invalid density
    expect(() => proposeFurnishing('A1', 'throne-room', { density: 'extreme' })).toThrow(/density must be/);
  });

  it('throws when room not found', () => {
    expect(() => proposeFurnishing('Nowhere', 'throne-room')).toThrow(/Room "Nowhere" not found/);
  });

  it('reports rejected entries when no candidates match the room type', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    state.propCatalog!.props = {
      altar: {
        name: 'altar',
        category: 'features',
        footprint: [1, 1],
        facing: false,
        placement: 'center',
        roomTypes: ['temple'],
        typicalCount: '1',
        clustersWith: [],
        notes: null,
      },
    };
    const r = proposeFurnishing('A1', 'nonexistent');
    expect(r.plan).toHaveLength(0);
    expect(r.rejected.length).toBeGreaterThan(0);
  });
});

describe('commitFurnishing', () => {
  it('executes a plan and records placed entries', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const proposal = proposeFurnishing('A1', 'throne-room');
    const commit = commitFurnishing(proposal.plan);
    expect(commit.success).toBe(true);
    expect(commit.placed.length).toBeGreaterThan(0);
  });

  it('accepts the proposal object directly (with .plan key)', () => {
    buildRoom(2, 2, 8, 12, 'A1');
    const proposal = proposeFurnishing('A1', 'throne-room');
    const commit = commitFurnishing(proposal);
    expect(commit.success).toBe(true);
  });

  it('records per-entry failures without halting the batch', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    // Plan with one valid + one out-of-bounds entry
    const plan = [
      { role: 'primary' as const, prop: 'pillar', row: 3, col: 3, facing: 0, reasoning: '' },
      { role: 'scatter' as const, prop: 'pillar', row: 999, col: 999, facing: 0, reasoning: '' },
    ];
    const r = commitFurnishing(plan);
    expect(r.placed.length).toBeGreaterThanOrEqual(1);
    expect(r.failed.length).toBeGreaterThanOrEqual(1);
  });

  it('throws on invalid plan shape', () => {
    // @ts-expect-error -- invalid input
    expect(() => commitFurnishing(null)).toThrow(/expects an array/);
  });
});
