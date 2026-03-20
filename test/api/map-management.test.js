import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js'; // Initialize getApi()

import {
  newMap,
  getMapInfo,
  getFullMapInfo,
  setName,
  setTheme,
  setLabelStyle,
  setFeature,
  getMap,
} from '../../src/editor/js/api/map-management.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRoom(r1, c1, r2, c2, label, labelRow, labelCol) {
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
    const lr = labelRow ?? Math.floor((r1 + r2) / 2);
    const lc = labelCol ?? Math.floor((c1 + c2) / 2);
    if (!cells[lr][lc]) cells[lr][lc] = {};
    cells[lr][lc].center = { label };
  }
}

function addDoor(r, c, direction) {
  const cells = state.dungeon.cells;
  const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
  const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
  cells[r][c][direction] = 'd';
  const [dr, dc] = OFFSETS[direction];
  const nr = r + dr, nc = c + dc;
  if (cells[nr]?.[nc]) {
    cells[nr][nc][OPPOSITE[direction]] = 'd';
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon');
  state.dungeon.metadata.lights = [];
  state.dungeon.metadata.nextLightId = 1;
  state.undoStack = [];
  state.redoStack = [];
});

// ── newMap ────────────────────────────────────────────────────────────────────

describe('newMap', () => {
  it('creates an empty dungeon with specified dimensions', () => {
    const result = newMap('My Dungeon', 15, 25, 5, 'blue-parchment');
    expect(result.success).toBe(true);
    expect(state.dungeon.cells.length).toBe(15);
    expect(state.dungeon.cells[0].length).toBe(25);
    expect(state.dungeon.metadata.dungeonName).toBe('My Dungeon');
    expect(state.dungeon.metadata.gridSize).toBe(5);
    expect(state.dungeon.metadata.theme).toBe('blue-parchment');
  });

  it('resets currentLevel and selectedCells', () => {
    state.currentLevel = 5;
    state.selectedCells = [{ row: 1, col: 1 }];
    newMap('Reset', 10, 10);
    expect(state.currentLevel).toBe(0);
    expect(state.selectedCells).toEqual([]);
  });

  it('defaults gridSize to 5 and theme to stone-dungeon', () => {
    newMap('Default', 10, 10);
    expect(state.dungeon.metadata.gridSize).toBe(5);
    expect(state.dungeon.metadata.theme).toBe('stone-dungeon');
  });

  it('all cells are null in a new map', () => {
    newMap('Empty', 5, 5);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        expect(state.dungeon.cells[r][c]).toBeNull();
      }
    }
  });

  it('pushes undo state before creating new map', () => {
    newMap('First', 10, 10);
    // The undo stack should have the previous state
    expect(state.undoStack.length).toBe(1);
  });
});

// ── getMapInfo ────────────────────────────────────────────────────────────────

describe('getMapInfo', () => {
  it('returns correct metadata for empty dungeon', () => {
    const info = getMapInfo();
    expect(info.success).toBe(true);
    expect(info.name).toBe('Test');
    expect(info.rows).toBe(20);
    expect(info.cols).toBe(30);
    expect(info.gridSize).toBe(5);
    expect(info.theme).toBe('stone-dungeon');
    expect(info.propCount).toBe(0);
    expect(info.labelCount).toBe(0);
  });

  it('counts props correctly', () => {
    const gs = state.dungeon.metadata.gridSize || 5;
    state.dungeon.metadata.props = [
      { id: 1, type: 'chair', x: 5 * gs, y: 5 * gs, rotation: 0 },
      { id: 2, type: 'table', x: 7 * gs, y: 7 * gs, rotation: 0 },
    ];
    const info = getMapInfo();
    expect(info.propCount).toBe(2);
  });

  it('counts labels correctly', () => {
    const cells = state.dungeon.cells;
    cells[3][3] = { center: { label: 'A1' } };
    cells[5][5] = { center: { label: 'A2' } };
    const info = getMapInfo();
    expect(info.labelCount).toBe(2);
  });

  it('reports light count', () => {
    state.dungeon.metadata.lights = [
      { id: 1, x: 10, y: 10, type: 'point', radius: 20 },
      { id: 2, x: 20, y: 20, type: 'point', radius: 30 },
    ];
    const info = getMapInfo();
    expect(info.lightCount).toBe(2);
  });

  it('reports lighting enabled status', () => {
    state.dungeon.metadata.lightingEnabled = true;
    expect(getMapInfo().lightingEnabled).toBe(true);
    state.dungeon.metadata.lightingEnabled = false;
    expect(getMapInfo().lightingEnabled).toBe(false);
  });

  it('reports label style', () => {
    state.dungeon.metadata.labelStyle = 'bold';
    expect(getMapInfo().labelStyle).toBe('bold');
  });

  it('reports features', () => {
    const info = getMapInfo();
    expect(info.features).toBeDefined();
    expect(typeof info.features).toBe('object');
  });

  it('collects texture IDs', () => {
    const cells = state.dungeon.cells;
    cells[3][3] = { texture: { id: 'cobblestone' } };
    cells[4][4] = { texture: { id: 'dirt' } };
    const info = getMapInfo();
    expect(info.textureIds).toContain('cobblestone');
    expect(info.textureIds).toContain('dirt');
  });
});

// ── getFullMapInfo ───────────────────────────────────────────────────────────

describe('getFullMapInfo', () => {
  it('includes rooms with their bounds', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    buildRoom(2, 6, 4, 8, 'A2', 3, 7);
    const info = getFullMapInfo();
    expect(info.success).toBe(true);
    expect(info.rooms.length).toBe(2);
    const a1 = info.rooms.find(r => r.label === 'A1');
    expect(a1).toBeDefined();
    expect(a1.bounds.r1).toBe(2);
    expect(a1.bounds.r2).toBe(4);
  });

  it('includes props with their metadata', () => {
    const gs = state.dungeon.metadata.gridSize || 5;
    state.dungeon.metadata.props = [
      { id: 1, type: 'chair', x: 5 * gs, y: 5 * gs, rotation: 90 },
    ];
    const info = getFullMapInfo();
    expect(info.props.length).toBe(1);
    expect(info.props[0]).toEqual({ row: 5, col: 5, type: 'chair', facing: 90, id: 1 });
  });

  it('includes doors (deduplicated)', () => {
    buildRoom(2, 2, 4, 4, 'A1', 3, 3);
    buildRoom(2, 5, 4, 7, 'A2', 3, 6);
    const cells = state.dungeon.cells;
    for (let r = 2; r <= 4; r++) {
      cells[r][4].east = 'w';
      cells[r][5].west = 'w';
    }
    addDoor(3, 4, 'east');
    const info = getFullMapInfo();
    // Door should appear once (not both sides)
    const door = info.doors.find(d => d.row === 3 && d.col === 4 && d.direction === 'east');
    expect(door).toBeDefined();
    expect(door.type).toBe('d');
    // Should not have duplicate from reciprocal
    const reciprocal = info.doors.filter(d => d.row === 3 && d.col === 5 && d.direction === 'west');
    expect(reciprocal.length).toBe(0);
  });

  it('includes lights data', () => {
    state.dungeon.metadata.lights = [{ id: 1, x: 10, y: 10, type: 'point' }];
    const info = getFullMapInfo();
    expect(info.lights.length).toBe(1);
    expect(info.lights[0].id).toBe(1);
  });

  it('includes stairs and bridges data', () => {
    state.dungeon.metadata.stairs = [{ id: 1, points: [[1, 1], [2, 2], [3, 3]] }];
    state.dungeon.metadata.bridges = [{ id: 1, points: [[4, 4], [5, 5]] }];
    const info = getFullMapInfo();
    expect(info.stairs.length).toBe(1);
    expect(info.bridges.length).toBe(1);
  });

  it('returns deep copies (modifying result does not affect state)', () => {
    state.dungeon.metadata.lights = [{ id: 1, x: 10, y: 10 }];
    const info = getFullMapInfo();
    info.lights[0].x = 999;
    expect(state.dungeon.metadata.lights[0].x).toBe(10); // unchanged
  });
});

// ── setName ──────────────────────────────────────────────────────────────────

describe('setName', () => {
  it('updates the dungeon name', () => {
    const result = setName('New Name');
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.dungeonName).toBe('New Name');
  });

  it('trims whitespace from the name', () => {
    setName('  Padded Name  ');
    expect(state.dungeon.metadata.dungeonName).toBe('Padded Name');
  });

  it('throws for empty string', () => {
    expect(() => setName('')).toThrow('non-empty string');
  });

  it('throws for non-string input', () => {
    expect(() => setName(42)).toThrow('non-empty string');
    expect(() => setName(null)).toThrow('non-empty string');
    expect(() => setName(undefined)).toThrow('non-empty string');
  });

  it('pushes undo state', () => {
    setName('Changed');
    expect(state.undoStack.length).toBe(1);
  });
});

// ── setTheme ─────────────────────────────────────────────────────────────────

describe('setTheme', () => {
  it('updates the theme', () => {
    const result = setTheme('blue-parchment');
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.theme).toBe('blue-parchment');
  });

  it('throws for empty string', () => {
    expect(() => setTheme('')).toThrow('non-empty string');
  });

  it('throws for non-string input', () => {
    expect(() => setTheme(null)).toThrow('non-empty string');
  });

  it('accepts custom theme names', () => {
    setTheme('my-custom-theme');
    expect(state.dungeon.metadata.theme).toBe('my-custom-theme');
  });

  it('pushes undo state', () => {
    setTheme('blue-parchment');
    expect(state.undoStack.length).toBe(1);
  });
});

// ── setLabelStyle ────────────────────────────────────────────────────────────

describe('setLabelStyle', () => {
  it('sets label style to "circled"', () => {
    const result = setLabelStyle('circled');
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.labelStyle).toBe('circled');
  });

  it('sets label style to "plain"', () => {
    setLabelStyle('plain');
    expect(state.dungeon.metadata.labelStyle).toBe('plain');
  });

  it('sets label style to "bold"', () => {
    setLabelStyle('bold');
    expect(state.dungeon.metadata.labelStyle).toBe('bold');
  });

  it('throws for invalid label style', () => {
    expect(() => setLabelStyle('italic')).toThrow('Invalid label style');
    expect(() => setLabelStyle('')).toThrow('Invalid label style');
  });

  it('pushes undo state', () => {
    setLabelStyle('plain');
    expect(state.undoStack.length).toBe(1);
  });
});

// ── setFeature ───────────────────────────────────────────────────────────────

describe('setFeature', () => {
  it('enables a valid feature', () => {
    const result = setFeature('grid', true);
    expect(result.success).toBe(true);
    expect(state.dungeon.metadata.features.grid).toBe(true);
  });

  it('disables a valid feature', () => {
    setFeature('compass', false);
    expect(state.dungeon.metadata.features.compass).toBe(false);
  });

  it('coerces truthy/falsy values to boolean', () => {
    setFeature('scale', 1);
    expect(state.dungeon.metadata.features.scale).toBe(true);
    setFeature('scale', 0);
    expect(state.dungeon.metadata.features.scale).toBe(false);
  });

  it('throws for invalid feature name', () => {
    expect(() => setFeature('foo', true)).toThrow('Invalid feature');
    expect(() => setFeature('', true)).toThrow('Invalid feature');
  });

  it('supports all valid features: grid, compass, scale, border', () => {
    for (const feature of ['grid', 'compass', 'scale', 'border']) {
      const result = setFeature(feature, true);
      expect(result.success).toBe(true);
    }
  });

  it('initializes features object if not present', () => {
    delete state.dungeon.metadata.features;
    setFeature('grid', true);
    expect(state.dungeon.metadata.features).toBeDefined();
    expect(state.dungeon.metadata.features.grid).toBe(true);
  });
});

// ── getMap ────────────────────────────────────────────────────────────────────

describe('getMap', () => {
  it('returns a deep copy of the dungeon', () => {
    const result = getMap();
    expect(result.success).toBe(true);
    expect(result.dungeon.metadata.dungeonName).toBe('Test');
    // Modifying the returned dungeon should not affect state
    result.dungeon.metadata.dungeonName = 'Modified';
    expect(state.dungeon.metadata.dungeonName).toBe('Test');
  });

  it('includes cells in the returned dungeon', () => {
    const result = getMap();
    expect(result.dungeon.cells).toBeDefined();
    expect(result.dungeon.cells.length).toBe(20);
    expect(result.dungeon.cells[0].length).toBe(30);
  });
});
