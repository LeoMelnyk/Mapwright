// Tests for the Weather API (src/editor/js/api/weather.ts).
//
// Covers: group CRUD + validation, cell assignment (single / rect / flood),
// half-cell awareness on diagonal-split cells, deletion clears assignments,
// undo / redo round-trips, no-op short-circuiting, error codes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js'; // initialise getApi()

import {
  createWeatherGroup,
  removeWeatherGroup,
  listWeatherGroups,
  getWeatherGroup,
  setWeatherGroup,
  setWeatherCell,
  setWeatherRect,
  floodFillWeather,
  getWeatherCell,
} from '../../src/editor/js/api/weather.js';
import { undo, redo } from '../../src/editor/js/state.js';
import { ApiValidationError } from '../../src/editor/js/api/errors.js';
import { getCellWeatherHalf, setEdge } from '../../src/util/index.js';

/** Run `fn` and return the ApiValidationError it threw, or fail the test. */
function expectApiError(fn: () => unknown, code: string): ApiValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiValidationError) {
      expect(e.code).toBe(code);
      return e;
    }
    throw e;
  }
  throw new Error(`Expected ApiValidationError with code "${code}", but no error thrown`);
}

// Mock render-side helpers we don't care about for unit testing — but track
// markWeatherCellDirty / markWeatherFullRebuild call counts so we can assert
// invalidation actually happens.
vi.mock('../../src/render/index.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/render/index.js');
  return {
    ...actual,
    markWeatherFullRebuild: vi.fn(),
    markWeatherCellDirty: vi.fn(),
    hasActiveWeatherLightning: vi.fn(() => false),
  };
});

import { markWeatherFullRebuild, markWeatherCellDirty, hasActiveWeatherLightning } from '../../src/render/index.js';

function paintFloor(r1: number, c1: number, r2: number, c2: number) {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      state.dungeon.cells[r][c] = {};
    }
  }
}

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  state.dungeon.metadata.weatherGroups = [];
  state.undoStack = [];
  state.redoStack = [];
  vi.mocked(markWeatherFullRebuild).mockClear();
  vi.mocked(markWeatherCellDirty).mockClear();
  vi.mocked(hasActiveWeatherLightning).mockReturnValue(false);
});

// ── createWeatherGroup ───────────────────────────────────────────────────────

describe('createWeatherGroup', () => {
  it('creates a group with sensible defaults when called bare', () => {
    const result = createWeatherGroup();
    expect(result.success).toBe(true);
    expect(result.id).toMatch(/^wg-/);
    expect(result.group.type).toBe('rain');
    expect(result.group.intensity).toBe(0.5);
    expect(result.group.hazeDensity).toBe(0);
    expect(result.group.wind).toEqual({ direction: 0, intensity: 0 });
    expect(result.group.lightning.enabled).toBe(false);
    expect(state.dungeon.metadata.weatherGroups).toHaveLength(1);
  });

  it('applies init overrides for every field', () => {
    const result = createWeatherGroup({
      name: 'Storm',
      type: 'snow',
      intensity: 0.8,
      hazeDensity: 0.3,
      wind: { direction: 90, intensity: 0.5 },
      lightning: { enabled: true, intensity: 1, frequency: 0.4, color: '#ffffff' },
      particleColor: '#abcdef',
    });
    expect(result.group.name).toBe('Storm');
    expect(result.group.type).toBe('snow');
    expect(result.group.intensity).toBe(0.8);
    expect(result.group.hazeDensity).toBe(0.3);
    expect(result.group.wind).toEqual({ direction: 90, intensity: 0.5 });
    expect(result.group.lightning).toEqual({ enabled: true, intensity: 1, frequency: 0.4, color: '#ffffff' });
    expect(result.group.particleColor).toBe('#abcdef');
  });

  it('normalises wind direction into [0, 360)', () => {
    const r1 = createWeatherGroup({ wind: { direction: 450 } });
    expect(r1.group.wind.direction).toBe(90);
    const r2 = createWeatherGroup({ wind: { direction: -90 } });
    expect(r2.group.wind.direction).toBe(270);
  });

  it('rejects unknown weather types', () => {
    expectApiError(() => createWeatherGroup({ type: 'hail' as never }), 'INVALID_WEATHER_TYPE');
  });

  it('rejects out-of-range intensity', () => {
    expectApiError(() => createWeatherGroup({ intensity: 1.5 }), 'INVALID_WEATHER_VALUE');
    expectApiError(() => createWeatherGroup({ intensity: -0.1 }), 'INVALID_WEATHER_VALUE');
    expectApiError(() => createWeatherGroup({ intensity: NaN }), 'INVALID_WEATHER_VALUE');
  });

  it('rejects malformed hex color', () => {
    expectApiError(() => createWeatherGroup({ particleColor: 'red' }), 'INVALID_WEATHER_COLOR');
    expectApiError(() => createWeatherGroup({ lightning: { color: '#xyz' } }), 'INVALID_WEATHER_COLOR');
  });

  it('marks weather full-rebuild after creation', () => {
    createWeatherGroup();
    expect(markWeatherFullRebuild).toHaveBeenCalled();
  });

  it('returns a deep clone, not a live reference', () => {
    const result = createWeatherGroup();
    result.group.intensity = 999;
    expect(state.dungeon.metadata.weatherGroups![0]!.intensity).toBe(0.5);
  });
});

// ── listWeatherGroups / getWeatherGroup ──────────────────────────────────────

describe('listWeatherGroups', () => {
  it('returns an empty array when no groups exist', () => {
    expect(listWeatherGroups().groups).toEqual([]);
  });

  it('annotates each group with cellCount', () => {
    paintFloor(2, 2, 5, 5);
    const { id } = createWeatherGroup({ name: 'A' });
    setWeatherCell(2, 2, id);
    setWeatherCell(3, 3, id);
    const groups = listWeatherGroups().groups;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.cellCount).toBe(2);
  });
});

describe('getWeatherGroup', () => {
  it('returns success=false for a missing id (no throw)', () => {
    const result = getWeatherGroup('does-not-exist') as { success: false; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns the group with cellCount', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup({ name: 'X' });
    setWeatherCell(2, 2, id);
    const result = getWeatherGroup(id);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.group.name).toBe('X');
      expect(result.group.cellCount).toBe(1);
    }
  });
});

// ── setWeatherGroup ──────────────────────────────────────────────────────────

describe('setWeatherGroup', () => {
  it('patches only the supplied fields', () => {
    const { id } = createWeatherGroup({ name: 'A', type: 'rain', intensity: 0.5 });
    setWeatherGroup(id, { intensity: 0.9 });
    const g = state.dungeon.metadata.weatherGroups![0]!;
    expect(g.intensity).toBe(0.9);
    expect(g.name).toBe('A'); // unchanged
    expect(g.type).toBe('rain'); // unchanged
  });

  it('throws for unknown id', () => {
    expectApiError(() => setWeatherGroup('missing', { intensity: 0.5 }), 'WEATHER_GROUP_NOT_FOUND');
  });

  it('clears particleColor when patch sets it to null', () => {
    const { id } = createWeatherGroup({ particleColor: '#aabbcc' });
    expect(state.dungeon.metadata.weatherGroups![0]!.particleColor).toBe('#aabbcc');
    setWeatherGroup(id, { particleColor: null });
    expect(state.dungeon.metadata.weatherGroups![0]!.particleColor).toBeUndefined();
  });

  it('does not partially apply on a validation error', () => {
    const { id } = createWeatherGroup({ name: 'A', intensity: 0.5 });
    expectApiError(() => setWeatherGroup(id, { intensity: 0.7, type: 'invalid' as never }), 'INVALID_WEATHER_TYPE');
    const g = state.dungeon.metadata.weatherGroups![0]!;
    expect(g.intensity).toBe(0.5); // not advanced past the failed validation
  });

  it('invalidates lightmap when active-lightning state flips', async () => {
    // Mock returns false on entry, true on exit → a transition.
    vi.mocked(hasActiveWeatherLightning)
      .mockReturnValueOnce(false) // before
      .mockReturnValueOnce(true); // after
    const stateMod = await import('../../src/editor/js/state.js');
    const spy = vi.spyOn(stateMod, 'invalidateLightmap');
    const { id } = createWeatherGroup();
    setWeatherGroup(id, { lightning: { enabled: true } });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── removeWeatherGroup ───────────────────────────────────────────────────────

describe('removeWeatherGroup', () => {
  it('throws for unknown id', () => {
    expectApiError(() => removeWeatherGroup('missing'), 'WEATHER_GROUP_NOT_FOUND');
  });

  it('drops the group from metadata and clears cell assignments', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup();
    setWeatherCell(2, 2, id);
    setWeatherCell(3, 3, id);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBe(id);
    const result = removeWeatherGroup(id);
    expect(result.success).toBe(true);
    expect(result.removed.cells).toBe(2);
    expect(state.dungeon.metadata.weatherGroups).toHaveLength(0);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBeUndefined();
    expect(getCellWeatherHalf(state.dungeon.cells[3][3], 'full')).toBeUndefined();
  });

  it('does not touch cells assigned to other groups', () => {
    paintFloor(2, 2, 4, 4);
    const { id: id1 } = createWeatherGroup();
    const { id: id2 } = createWeatherGroup();
    setWeatherCell(2, 2, id1);
    setWeatherCell(3, 3, id2);
    removeWeatherGroup(id1);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBeUndefined();
    expect(getCellWeatherHalf(state.dungeon.cells[3][3], 'full')).toBe(id2);
  });
});

// ── setWeatherCell ───────────────────────────────────────────────────────────

describe('setWeatherCell', () => {
  it('writes weatherGroupId on an unsplit cell', () => {
    paintFloor(2, 2, 2, 2);
    const { id } = createWeatherGroup();
    setWeatherCell(2, 2, id);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBe(id);
    expect(markWeatherCellDirty).toHaveBeenCalledWith(2, 2);
  });

  it('clears assignment when groupId is null', () => {
    paintFloor(2, 2, 2, 2);
    const { id } = createWeatherGroup();
    setWeatherCell(2, 2, id);
    setWeatherCell(2, 2, null);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBeUndefined();
  });

  it('throws for unknown groupId', () => {
    paintFloor(2, 2, 2, 2);
    expectApiError(() => setWeatherCell(2, 2, 'missing'), 'WEATHER_GROUP_NOT_FOUND');
  });

  it('throws for out-of-bounds coords', () => {
    const { id } = createWeatherGroup();
    expectApiError(() => setWeatherCell(-1, 0, id), 'OUT_OF_BOUNDS');
    expectApiError(() => setWeatherCell(0, 999, id), 'OUT_OF_BOUNDS');
  });

  it('rejects non-full halfKey on an unsplit cell', () => {
    paintFloor(2, 2, 2, 2);
    const { id } = createWeatherGroup();
    expectApiError(() => setWeatherCell(2, 2, id, 'ne'), 'WEATHER_HALF_NOT_APPLICABLE');
  });

  it('requires explicit halfKey on a diagonal-split cell', () => {
    paintFloor(2, 2, 2, 2);
    setEdge(state.dungeon.cells[2][2]!, 'nw-se', 'w'); // splits cell into NE + SW halves
    const { id } = createWeatherGroup();
    expectApiError(() => setWeatherCell(2, 2, id), 'WEATHER_HALF_REQUIRED');
  });

  it('writes per-half on a diagonal-split cell', () => {
    paintFloor(2, 2, 2, 2);
    setEdge(state.dungeon.cells[2][2]!, 'nw-se', 'w');
    const { id } = createWeatherGroup();
    setWeatherCell(2, 2, id, 'ne');
    const cell = state.dungeon.cells[2][2];
    expect(getCellWeatherHalf(cell, 'ne')).toBe(id);
    expect(getCellWeatherHalf(cell, 'sw')).toBeUndefined();
  });

  it('rejects invalid half name on a split cell', () => {
    paintFloor(2, 2, 2, 2);
    setEdge(state.dungeon.cells[2][2]!, 'nw-se', 'w'); // halves are 'ne' / 'sw'
    const { id } = createWeatherGroup();
    expectApiError(() => setWeatherCell(2, 2, id, 'interior'), 'INVALID_HALF_KEY');
  });

  it('skips no-op writes (no undo entry created)', () => {
    paintFloor(2, 2, 2, 2);
    const { id } = createWeatherGroup();
    setWeatherCell(2, 2, id);
    const depthAfterFirst = state.undoStack.length;
    setWeatherCell(2, 2, id); // same value — should short-circuit
    expect(state.undoStack.length).toBe(depthAfterFirst);
  });
});

// ── setWeatherRect ───────────────────────────────────────────────────────────

describe('setWeatherRect', () => {
  it('assigns every floor cell in the rectangle', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup();
    const result = setWeatherRect(2, 2, 4, 4, id);
    expect(result.success).toBe(true);
    expect(result.count).toBe(9); // 3×3 = 9 cells
    for (let r = 2; r <= 4; r++) {
      for (let c = 2; c <= 4; c++) {
        expect(getCellWeatherHalf(state.dungeon.cells[r][c], 'full')).toBe(id);
      }
    }
  });

  it('skips void cells inside the rectangle', () => {
    paintFloor(2, 2, 4, 4);
    state.dungeon.cells[3][3] = null; // hole in the middle
    const { id } = createWeatherGroup();
    const result = setWeatherRect(2, 2, 4, 4, id);
    expect(result.count).toBe(8); // 9 minus the 1 void cell
    expect(state.dungeon.cells[3][3]).toBeNull();
  });

  it('clears every cell when groupId is null', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup();
    setWeatherRect(2, 2, 4, 4, id);
    const result = setWeatherRect(2, 2, 4, 4, null);
    expect(result.count).toBe(9);
    expect(getCellWeatherHalf(state.dungeon.cells[3][3], 'full')).toBeUndefined();
  });

  it('returns count=0 when nothing changes', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup();
    setWeatherRect(2, 2, 4, 4, id);
    const result = setWeatherRect(2, 2, 4, 4, id); // already assigned
    expect(result.count).toBe(0);
  });

  it('handles inverted rectangle args', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup();
    const result = setWeatherRect(4, 4, 2, 2, id); // inverted
    expect(result.count).toBe(9);
  });

  it('throws for unknown groupId', () => {
    paintFloor(2, 2, 4, 4);
    expectApiError(() => setWeatherRect(2, 2, 4, 4, 'missing'), 'WEATHER_GROUP_NOT_FOUND');
  });
});

// ── floodFillWeather ─────────────────────────────────────────────────────────

describe('floodFillWeather', () => {
  it('fills a connected open region', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup();
    const result = floodFillWeather(3, 3, id);
    expect(result.success).toBe(true);
    expect(result.count).toBe(9);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBe(id);
    expect(getCellWeatherHalf(state.dungeon.cells[4][4], 'full')).toBe(id);
  });

  it('stops at walls', () => {
    paintFloor(2, 2, 4, 4);
    // Wall the cell at (3, 3) off from (3, 4): cell.east = 'w' on (3,3), cell.west = 'w' on (3,4)
    state.dungeon.cells[3][3].east = 'w';
    state.dungeon.cells[3][4].west = 'w';
    state.dungeon.cells[2][3].east = 'w';
    state.dungeon.cells[2][4].west = 'w';
    state.dungeon.cells[4][3].east = 'w';
    state.dungeon.cells[4][4].west = 'w';
    const { id } = createWeatherGroup();
    const result = floodFillWeather(3, 3, id);
    // Only cells in cols 2..3 (3 rows × 2 cols = 6) should be filled
    expect(result.count).toBe(6);
    expect(getCellWeatherHalf(state.dungeon.cells[3][3], 'full')).toBe(id);
    expect(getCellWeatherHalf(state.dungeon.cells[3][4], 'full')).toBeUndefined();
  });

  it('clears every cell when groupId is null', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup();
    setWeatherRect(2, 2, 4, 4, id);
    const result = floodFillWeather(3, 3, null);
    expect(result.count).toBe(9);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBeUndefined();
  });

  it('throws when the start cell is void', () => {
    const { id } = createWeatherGroup();
    expectApiError(() => floodFillWeather(3, 3, id), 'CELL_VOID');
  });

  it('returns count=0 when every reachable cell is already in the desired state', () => {
    paintFloor(2, 2, 3, 3);
    const { id } = createWeatherGroup();
    floodFillWeather(2, 2, id);
    const result = floodFillWeather(2, 2, id);
    expect(result.count).toBe(0);
  });
});

// ── getWeatherCell ───────────────────────────────────────────────────────────

describe('getWeatherCell', () => {
  it('returns an empty assignments array for unweathered cells', () => {
    paintFloor(2, 2, 2, 2);
    const result = getWeatherCell(2, 2);
    expect(result.assignments).toEqual([]);
    expect(result.isSplit).toBe(false);
  });

  it('returns the group on an unsplit cell', () => {
    paintFloor(2, 2, 2, 2);
    const { id } = createWeatherGroup();
    setWeatherCell(2, 2, id);
    const result = getWeatherCell(2, 2);
    expect(result.assignments).toEqual([{ halfKey: 'full', groupId: id }]);
    expect(result.isSplit).toBe(false);
  });

  it('reports both halves on a diagonally split cell', () => {
    paintFloor(2, 2, 2, 2);
    setEdge(state.dungeon.cells[2][2]!, 'nw-se', 'w');
    const { id: id1 } = createWeatherGroup();
    const { id: id2 } = createWeatherGroup();
    setWeatherCell(2, 2, id1, 'ne');
    setWeatherCell(2, 2, id2, 'sw');
    const result = getWeatherCell(2, 2);
    expect(result.isSplit).toBe(true);
    const sorted = [...result.assignments].sort((a, b) => a.halfKey.localeCompare(b.halfKey));
    expect(sorted).toEqual([
      { halfKey: 'ne', groupId: id1 },
      { halfKey: 'sw', groupId: id2 },
    ]);
  });
});

// ── undo / redo round-trip ───────────────────────────────────────────────────

describe('undo / redo', () => {
  it('round-trips a setWeatherCell change', () => {
    paintFloor(2, 2, 2, 2);
    const { id } = createWeatherGroup();
    setWeatherCell(2, 2, id);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBe(id);
    undo();
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBeUndefined();
    redo();
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBe(id);
  });

  it('round-trips a removeWeatherGroup that touched cells', () => {
    paintFloor(2, 2, 4, 4);
    const { id } = createWeatherGroup();
    setWeatherRect(2, 2, 4, 4, id);
    removeWeatherGroup(id);
    expect(state.dungeon.metadata.weatherGroups).toHaveLength(0);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBeUndefined();
    undo();
    expect(state.dungeon.metadata.weatherGroups).toHaveLength(1);
    expect(getCellWeatherHalf(state.dungeon.cells[2][2], 'full')).toBe(id);
  });
});
