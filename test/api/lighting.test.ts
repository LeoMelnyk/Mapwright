import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';

import {
  placeLight,
  removeLight,
  getLights,
  setAmbientLight,
  setLightingEnabled,
  listLightPresets,
  setLightGroup,
  setLightGroupEnabled,
  listLightGroups,
} from '../../src/editor/js/api/lighting.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
});

// ── placeLight ──────────────────────────────────────────────────────────────

describe('placeLight', () => {
  it('creates a light and returns its ID', () => {
    const result = placeLight(50, 75);
    expect(result.success).toBe(true);
    expect(typeof result.id).toBe('number');
  });

  it('adds light to metadata.lights array', () => {
    placeLight(50, 75);
    expect(state.dungeon.metadata.lights.length).toBe(1);
    const light = state.dungeon.metadata.lights[0];
    expect(light.x).toBe(50);
    expect(light.y).toBe(75);
  });

  it('auto-enables lighting on first light placement', () => {
    expect(state.dungeon.metadata.lightingEnabled).toBeFalsy();
    placeLight(50, 75);
    expect(state.dungeon.metadata.lightingEnabled).toBe(true);
  });

  it('assigns sequential IDs', () => {
    const r1 = placeLight(10, 10);
    const r2 = placeLight(20, 20);
    expect(r2.id).toBe(r1.id + 1);
  });

  it('uses default values for unspecified config', () => {
    placeLight(50, 75);
    const light = state.dungeon.metadata.lights[0];
    expect(light.type).toBe('point');
    expect(light.radius).toBe(30);
    expect(light.color).toBe('#ff9944');
    expect(light.intensity).toBe(1.0);
    expect(light.falloff).toBe('smooth');
  });

  it('applies config overrides', () => {
    placeLight(50, 75, { radius: 60, color: '#ffffff', intensity: 0.5, falloff: 'linear' });
    const light = state.dungeon.metadata.lights[0];
    expect(light.radius).toBe(60);
    expect(light.color).toBe('#ffffff');
    expect(light.intensity).toBe(0.5);
    expect(light.falloff).toBe('linear');
  });

  it('applies preset defaults when preset is specified', () => {
    const result = placeLight(50, 75, { preset: 'torch' });
    expect(result.success).toBe(true);
    const light = state.dungeon.metadata.lights[0];
    // The torch preset from setup.js mock: color '#ff8833', radius 20
    expect(light.color).toBe('#ff8833');
    expect(light.radius).toBe(20);
  });

  it('throws for unknown preset', () => {
    expect(() => placeLight(50, 75, { preset: 'nonexistent' })).toThrow('Unknown light preset');
  });

  it('throws for invalid light type', () => {
    expect(() => placeLight(50, 75, { type: 'spotlight' })).toThrow('Invalid light type');
  });

  it('creates directional light with angle and spread', () => {
    placeLight(50, 75, { type: 'directional', angle: 90, spread: 30 });
    const light = state.dungeon.metadata.lights[0];
    expect(light.type).toBe('directional');
    expect(light.angle).toBe(90);
    expect(light.spread).toBe(30);
  });

  it('clamps directional spread into [0, 180]', () => {
    placeLight(10, 10, { type: 'directional', spread: -20 });
    placeLight(20, 20, { type: 'directional', spread: 400 });
    placeLight(30, 30, { type: 'directional', spread: NaN });
    const [a, b, c] = state.dungeon.metadata.lights;
    expect(a.spread).toBe(0);
    expect(b.spread).toBe(180);
    expect(c.spread).toBe(45);
  });

  it('pushes to undo stack', () => {
    expect(state.undoStack.length).toBe(0);
    placeLight(50, 75);
    expect(state.undoStack.length).toBe(1);
  });
});

// ── removeLight ─────────────────────────────────────────────────────────────

describe('removeLight', () => {
  it('removes a light by ID', () => {
    const { id } = placeLight(50, 75);
    const result = removeLight(id);
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.lights.length).toBe(0);
  });

  it('throws for unknown light ID', () => {
    placeLight(50, 75);
    expect(() => removeLight(999)).toThrow('not found');
  });

  it('returns success when lights array is empty/missing', () => {
    const result = removeLight(1);
    expect(result.success).toBe(true);
  });

  it('removes only the specified light', () => {
    const { id: id1 } = placeLight(10, 10);
    const { id: id2 } = placeLight(20, 20);
    removeLight(id1);
    expect(state.dungeon.metadata.lights.length).toBe(1);
    expect(state.dungeon.metadata.lights[0].id).toBe(id2);
  });

  it('pushes to undo stack', () => {
    const { id } = placeLight(50, 75);
    const stackBefore = state.undoStack.length;
    removeLight(id);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });
});

// ── getLights ────────────────────────────────────────────────────────────────

describe('getLights', () => {
  it('returns empty array when no lights exist', () => {
    const result = getLights();
    expect(result.success).toBe(true);
    expect(result.lights).toEqual([]);
  });

  it('returns all placed lights', () => {
    placeLight(10, 10);
    placeLight(20, 20);
    const result = getLights();
    expect(result.lights.length).toBe(2);
  });

  it('returns a deep copy (mutations do not affect state)', () => {
    placeLight(50, 75);
    const result = getLights();
    result.lights[0].x = 999;
    expect(state.dungeon.metadata.lights[0].x).toBe(50); // unchanged
  });

  it('includes all light properties', () => {
    placeLight(50, 75, { radius: 40, color: '#aabbcc' });
    const light = getLights().lights[0];
    expect(light.x).toBe(50);
    expect(light.y).toBe(75);
    expect(light.radius).toBe(40);
    expect(light.color).toBe('#aabbcc');
  });
});

// ── setAmbientLight ─────────────────────────────────────────────────────────

describe('setAmbientLight', () => {
  it('sets ambient light level on metadata', () => {
    const result = setAmbientLight(0.5);
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.ambientLight).toBe(0.5);
  });

  it('accepts 0 (complete darkness)', () => {
    setAmbientLight(0);
    expect(state.dungeon.metadata.ambientLight).toBe(0);
  });

  it('accepts 1 (full brightness)', () => {
    setAmbientLight(1);
    expect(state.dungeon.metadata.ambientLight).toBe(1);
  });

  it('throws for values below 0', () => {
    expect(() => setAmbientLight(-0.1)).toThrow('between 0 and 1');
  });

  it('throws for values above 1', () => {
    expect(() => setAmbientLight(1.1)).toThrow('between 0 and 1');
  });

  it('throws for non-number values', () => {
    expect(() => setAmbientLight('bright')).toThrow('between 0 and 1');
    expect(() => setAmbientLight(null)).toThrow('between 0 and 1');
  });

  it('pushes to undo stack', () => {
    const stackBefore = state.undoStack.length;
    setAmbientLight(0.5);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });
});

// ── setLightingEnabled ──────────────────────────────────────────────────────

describe('setLightingEnabled', () => {
  it('enables lighting', () => {
    const result = setLightingEnabled(true);
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.lightingEnabled).toBe(true);
  });

  it('disables lighting', () => {
    setLightingEnabled(true);
    setLightingEnabled(false);
    expect(state.dungeon.metadata.lightingEnabled).toBe(false);
  });

  it('coerces truthy/falsy values', () => {
    setLightingEnabled(1);
    expect(state.dungeon.metadata.lightingEnabled).toBe(true);
    setLightingEnabled(0);
    expect(state.dungeon.metadata.lightingEnabled).toBe(false);
    setLightingEnabled('yes');
    expect(state.dungeon.metadata.lightingEnabled).toBe(true);
  });

  it('pushes to undo stack', () => {
    const stackBefore = state.undoStack.length;
    setLightingEnabled(true);
    expect(state.undoStack.length).toBe(stackBefore + 1);
  });
});

// ── listLightPresets ────────────────────────────────────────────────────────

describe('listLightPresets', () => {
  it('returns categories and presets', () => {
    const result = listLightPresets();
    expect(result.success).toBe(true);
    expect(result.categories).toEqual(['fire']);
    expect(result.presets.torch).toBeDefined();
    expect(result.presets.torch.displayName).toBe('Torch');
  });

  it('preset entries include type, color, radius, intensity', () => {
    const result = listLightPresets();
    const torch = result.presets.torch;
    expect(torch.type).toBe('point');
    expect(torch.color).toBe('#ff8833');
    expect(torch.radius).toBe(20);
    expect(torch.intensity).toBe(1);
  });

  it('returns preset category', () => {
    const result = listLightPresets();
    expect(result.presets.torch.category).toBe('fire');
  });
});

// ── Light groups ────────────────────────────────────────────────────────────

describe('light groups', () => {
  it('assigns a light to a group via setLightGroup', () => {
    const { id } = placeLight(10, 10);
    setLightGroup(id, 'torches');
    expect(state.dungeon.metadata.lights[0].group).toBe('torches');
  });

  it('clears a group when passed "" or null', () => {
    const { id } = placeLight(10, 10);
    setLightGroup(id, 'torches');
    setLightGroup(id, '');
    expect(state.dungeon.metadata.lights[0].group).toBeUndefined();
    setLightGroup(id, 'torches');
    setLightGroup(id, null);
    expect(state.dungeon.metadata.lights[0].group).toBeUndefined();
  });

  it('throws if the target light does not exist', () => {
    try {
      setLightGroup(999, 'torches');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { code: string }).code).toBe('LIGHT_NOT_FOUND');
    }
  });

  it('setLightGroupEnabled(false) adds the group to disabledLightGroups', () => {
    placeLight(10, 10);
    setLightGroup(state.dungeon.metadata.lights[0].id, 'traps');
    setLightGroupEnabled('traps', false);
    expect(state.dungeon.metadata.disabledLightGroups).toContain('traps');
  });

  it('setLightGroupEnabled(true) removes it', () => {
    state.dungeon.metadata.disabledLightGroups = ['traps', 'aura'];
    setLightGroupEnabled('traps', true);
    expect(state.dungeon.metadata.disabledLightGroups).toEqual(['aura']);
  });

  it('clears the disabled-groups field entirely when the last group re-enables', () => {
    state.dungeon.metadata.disabledLightGroups = ['traps'];
    setLightGroupEnabled('traps', true);
    expect(state.dungeon.metadata.disabledLightGroups).toBeUndefined();
  });

  it('rejects empty / non-string group names', () => {
    try {
      setLightGroupEnabled('', true);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { code: string }).code).toBe('INVALID_LIGHT_GROUP');
    }
  });

  it('listLightGroups summarizes counts + enabled state', () => {
    const a = placeLight(1, 1).id;
    const b = placeLight(2, 2).id;
    const c = placeLight(3, 3).id;
    setLightGroup(a, 'torches');
    setLightGroup(b, 'torches');
    setLightGroup(c, 'traps');
    setLightGroupEnabled('traps', false);
    const { groups } = listLightGroups();
    const torches = groups.find((g) => g.name === 'torches')!;
    const traps = groups.find((g) => g.name === 'traps')!;
    expect(torches.lightCount).toBe(2);
    expect(torches.enabled).toBe(true);
    expect(traps.lightCount).toBe(1);
    expect(traps.enabled).toBe(false);
  });

  it('ungrouped lights live in the "" bucket and are always enabled', () => {
    placeLight(1, 1);
    placeLight(2, 2);
    const { groups } = listLightGroups();
    const ungrouped = groups.find((g) => g.name === '')!;
    expect(ungrouped.lightCount).toBe(2);
    expect(ungrouped.enabled).toBe(true);
  });
});
