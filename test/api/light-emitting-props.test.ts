import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';
import { listLightEmittingProps, placeProp } from '../../src/editor/js/api/props.js';
import { paintRect } from '../../src/editor/js/api/cells.js';
import { markPropSpatialDirty } from '../../src/editor/js/prop-spatial.js';

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 30, 30, 5, 'stone-dungeon', 1);
  state.undoStack = [];
  state.redoStack = [];
  state.propCatalog = {
    categories: ['features', 'furniture'],
    props: {
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
  state.lightCatalog = {
    categories: ['fire'],
    lights: {
      brazier: {
        type: 'point',
        radius: 22,
        color: '#ff8844',
        intensity: 1.0,
        falloff: 'smooth',
      },
    },
  };
  markPropSpatialDirty();
});

describe('listLightEmittingProps', () => {
  it('returns props with non-empty lights field', () => {
    const r = listLightEmittingProps();
    expect(r.success).toBe(true);
    expect(r.count).toBe(1);
    expect(r.props[0].name).toBe('brazier');
    expect(r.props[0].lights[0].preset).toBe('brazier');
  });

  it('omits props with no lights field', () => {
    const r = listLightEmittingProps();
    expect(r.props.find((p) => p.name === 'pillar')).toBeUndefined();
  });

  it('returns empty when catalog has no light-emitting props', () => {
    delete state.propCatalog!.props.brazier;
    const r = listLightEmittingProps();
    expect(r.count).toBe(0);
  });
});

describe('placeProp lightsAdded return', () => {
  it('returns lightsAdded when placing a light-emitting prop', () => {
    paintRect(2, 2, 8, 8);
    const r = placeProp(5, 5, 'brazier');
    expect(r.success).toBe(true);
    expect(r.lightsAdded).toBeDefined();
    expect(r.lightsAdded!.length).toBe(1);
    expect(r.lightsAdded![0].preset).toBe('brazier');
    expect(typeof r.lightsAdded![0].id).toBe('number');
  });

  it('omits lightsAdded when placing a non-emitting prop', () => {
    paintRect(2, 2, 8, 8);
    const r = placeProp(5, 5, 'pillar');
    expect(r.success).toBe(true);
    expect(r.lightsAdded).toBeUndefined();
  });

  it('actually adds the light to metadata.lights', () => {
    paintRect(2, 2, 8, 8);
    const before = state.dungeon.metadata.lights.length;
    placeProp(5, 5, 'brazier');
    const after = state.dungeon.metadata.lights.length;
    expect(after).toBe(before + 1);
  });
});
