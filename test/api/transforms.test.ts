import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';

import {
  cloneRoom,
  replaceProp,
  replaceTexture,
  mirrorRegion,
  rotateRegion,
} from '../../src/editor/js/api/transforms.js';
import { setTexture } from '../../src/editor/js/api/textures.js';
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
      chair: {
        name: 'Chair',
        category: 'furniture',
        footprint: [1, 1],
        facing: true,
        placement: 'floor',
        roomTypes: ['any'],
        typicalCount: '1',
        clustersWith: [],
        notes: null,
      },
      sofa: {
        name: 'Sofa',
        category: 'furniture',
        footprint: [1, 1],
        facing: true,
        placement: 'floor',
        roomTypes: ['any'],
        typicalCount: '1',
        clustersWith: [],
        notes: null,
      },
    },
  };
  markPropSpatialDirty();
});

// ─── cloneRoom ──────────────────────────────────────────────────────────────

describe('cloneRoom', () => {
  it('copies the cells of a labeled room to a new offset', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const r = cloneRoom('A1', 0, 10);
    expect(r.success).toBe(true);
    expect(r.copied.cells).toBe(9);
    expect(state.dungeon.cells[3][13]).not.toBeNull();
    expect(state.dungeon.cells[2][12]?.north).toBe('w');
  });

  it('renames the label if newLabel given', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    cloneRoom('A1', 0, 10, { newLabel: 'A2' });
    expect(state.dungeon.cells[3][13]?.center?.label).toBe('A2');
  });

  it('throws CLONE_OUT_OF_BOUNDS for an off-grid destination', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    expect(() => cloneRoom('A1', 0, 100)).toThrow(/CLONE_OUT_OF_BOUNDS|outside/);
  });

  it('throws CLONE_OVERLAP if destination cells already exist', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    state.dungeon.cells[3][13] = {};
    expect(() => cloneRoom('A1', 0, 10)).toThrow(/already non-void/);
  });

  it('copies overlay props inside the room bbox', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const meta = state.dungeon.metadata;
    meta.props = [];
    meta.nextPropId = 1;
    meta.props.push({
      id: 'prop_1',
      type: 'chair',
      x: 3 * 5,
      y: 3 * 5,
      rotation: 0,
      scale: 1,
      zIndex: 10,
      flipped: false,
    });
    const r = cloneRoom('A1', 0, 10);
    expect(r.copied.overlayProps).toBe(1);
    expect(meta.props.some((p) => p.x === 13 * 5 && p.y === 3 * 5)).toBe(true);
  });
});

// ─── replaceProp ────────────────────────────────────────────────────────────

describe('replaceProp', () => {
  it('swaps the type of overlay props', () => {
    const meta = state.dungeon.metadata;
    meta.props = [
      { id: 'prop_1', type: 'chair', x: 10, y: 10, rotation: 0, scale: 1, zIndex: 10, flipped: false },
      { id: 'prop_2', type: 'chair', x: 20, y: 20, rotation: 0, scale: 1, zIndex: 10, flipped: false },
    ];
    const r = replaceProp('chair', 'sofa');
    expect(r.replaced).toBe(2);
    expect(meta.props.every((p) => p.type === 'sofa')).toBe(true);
  });

  it('respects region constraint', () => {
    const meta = state.dungeon.metadata;
    meta.props = [
      { id: 'prop_1', type: 'chair', x: 10, y: 10, rotation: 0, scale: 1, zIndex: 10, flipped: false }, // (2,2)
      { id: 'prop_2', type: 'chair', x: 50, y: 50, rotation: 0, scale: 1, zIndex: 10, flipped: false }, // (10,10)
    ];
    const r = replaceProp('chair', 'sofa', { region: { r1: 0, c1: 0, r2: 5, c2: 5 } });
    expect(r.replaced).toBe(1);
  });

  it('throws on unknown new prop type', () => {
    expect(() => replaceProp('chair', 'nonexistent')).toThrow(/UNKNOWN_PROP|Unknown new/);
  });
});

// ─── replaceTexture ────────────────────────────────────────────────────────

describe('replaceTexture', () => {
  it('swaps texture id across the map', () => {
    buildRoom(2, 2, 4, 4);
    setTexture(3, 3, 'polyhaven/cobblestone_floor_03');
    const r = replaceTexture('polyhaven/cobblestone_floor_03', 'polyhaven/wood_floor');
    expect(r.replaced).toBe(1);
    expect(state.dungeon.cells[3][3]?.texture).toBe('polyhaven/wood_floor');
  });
});

// ─── mirrorRegion ──────────────────────────────────────────────────────────

describe('mirrorRegion', () => {
  it('flips a region horizontally and swaps east/west walls', () => {
    state.dungeon.cells[3][2] = { east: 'w' };
    mirrorRegion(2, 2, 4, 4, 'horizontal');
    expect(state.dungeon.cells[3][4]?.west).toBe('w');
  });

  it('flips a region vertically and swaps north/south walls', () => {
    state.dungeon.cells[2][3] = { south: 'w' };
    mirrorRegion(2, 2, 4, 4, 'vertical');
    expect(state.dungeon.cells[4][3]?.north).toBe('w');
  });

  it('throws on invalid axis', () => {
    expect(() => mirrorRegion(2, 2, 4, 4, 'diag')).toThrow(/horizontal/);
  });
});

// ─── rotateRegion ──────────────────────────────────────────────────────────

describe('rotateRegion', () => {
  it('rotates a square region 90 degrees clockwise', () => {
    state.dungeon.cells[2][2] = { north: 'w' };
    rotateRegion(2, 2, 4, 4, 90);
    // (2,2) had north wall — after 90° CW rotates to (2,4) with east wall
    expect(state.dungeon.cells[2][4]?.east).toBe('w');
  });

  it('throws if region is not square', () => {
    expect(() => rotateRegion(2, 2, 4, 5, 90)).toThrow(/square/);
  });

  it('throws on invalid degrees', () => {
    expect(() => rotateRegion(2, 2, 4, 4, 45)).toThrow(/90, 180/);
  });
});
