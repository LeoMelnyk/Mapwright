import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js'; // initialize getApi()

import {
  renderAscii,
  inspectRegion,
  getRoomSummary,
  queryCells,
  getLightingCoverage,
  findConflicts,
  getPropPlacementOptions,
  searchProps,
  listDoors,
  listWalls,
  listFills,
  unlabelledRooms,
  getThemeColors,
} from '../../src/editor/js/api/inspect.js';
import { markPropSpatialDirty } from '../../src/editor/js/prop-spatial.js';

function freshDungeon(rows = 20, cols = 30) {
  state.dungeon = createEmptyDungeon('Test', rows, cols, 5, 'stone-dungeon', 1);
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
  state.dirty = false;
  state.unsavedChanges = false;
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
      brazier: {
        name: 'Brazier',
        category: 'furniture',
        footprint: [1, 1],
        facing: false,
        placement: 'floor',
        roomTypes: ['any'],
        typicalCount: '1',
        clustersWith: [],
        notes: null,
      },
    },
  };
  markPropSpatialDirty();
}

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

beforeEach(() => freshDungeon());

// ─── renderAscii ─────────────────────────────────────────────────────────

describe('renderAscii', () => {
  it('renders a small empty region as void', () => {
    const r = renderAscii(2, 2, 4, 4);
    expect(r.success).toBe(true);
    expect(r.cols).toBe(3);
    expect(r.rows).toBe(3);
    expect(r.ascii).toContain(' ');
  });

  it('renders walls and a floor', () => {
    buildRoom(2, 2, 4, 4);
    const r = renderAscii(2, 2, 4, 4);
    // Three lines per row (top, content, bottom) plus one more boundary
    expect(r.ascii.split('\n').length).toBe(7);
    expect(r.ascii).toContain('|');
    expect(r.ascii).toContain('-');
    expect(r.ascii).toContain('.');
  });

  it('renders doors as D and secret doors as S', () => {
    buildRoom(2, 2, 4, 4);
    state.dungeon.cells[3][4].east = 'd';
    state.dungeon.cells[3][2].west = 's';
    const r = renderAscii(2, 2, 4, 4);
    expect(r.ascii).toContain('D');
    expect(r.ascii).toContain('S');
  });

  it('uses different glyphs for fills, props, labels', () => {
    buildRoom(2, 2, 4, 4);
    state.dungeon.cells[3][3].fill = 'water';
    state.dungeon.cells[2][3].prop = { type: 'chair', span: [1, 1], facing: 0 };
    state.dungeon.cells[4][4].center = { label: 'A1' };
    const r = renderAscii(2, 2, 4, 4);
    expect(r.ascii).toContain('~'); // water
    expect(r.ascii).toContain('o'); // prop
    expect(r.ascii).toContain('*'); // label
  });

  it('rejects regions wider than 80 cells', () => {
    freshDungeon(20, 100);
    expect(() => renderAscii(0, 0, 5, 99)).toThrow(/REGION_TOO_WIDE|too wide/);
  });
});

// ─── inspectRegion ───────────────────────────────────────────────────────

describe('inspectRegion', () => {
  it('returns one entry per cell in the region', () => {
    const r = inspectRegion(2, 2, 4, 4);
    expect(r.success).toBe(true);
    expect(r.cellCount).toBe(9);
    expect(r.cells).toHaveLength(9);
  });

  it('marks void cells with void:true', () => {
    const r = inspectRegion(2, 2, 4, 4);
    expect(r.cells.every((c) => c.void)).toBe(true);
  });

  it('returns walls, fill, prop, label for non-void cells', () => {
    buildRoom(2, 2, 4, 4);
    state.dungeon.cells[3][3].fill = 'lava';
    state.dungeon.cells[3][3].fillDepth = 2;
    state.dungeon.cells[3][3].prop = { type: 'brazier', span: [1, 1], facing: 0 };
    state.dungeon.cells[3][3].center = { label: 'X' };
    const r = inspectRegion(3, 3, 3, 3);
    const cell = r.cells[0];
    expect(cell.fill).toBe('lava');
    expect(cell.fillDepth).toBe(2);
    expect(cell.prop).toEqual({ type: 'brazier', facing: 0 });
    expect(cell.label).toBe('X');
  });

  it('reports lights inside the region', () => {
    state.dungeon.metadata.lights.push({
      id: 1,
      x: 15,
      y: 15,
      type: 'point',
      radius: 20,
      color: '#fff',
      intensity: 1,
      falloff: 'smooth',
    });
    const r = inspectRegion(0, 0, 10, 10);
    expect(r.lights).toHaveLength(1);
    expect(r.lights[0].id).toBe(1);
  });

  it('clamps out-of-bounds rectangles', () => {
    const r = inspectRegion(-5, -5, 100, 100);
    expect(r.bounds.r1).toBe(0);
    expect(r.bounds.c1).toBe(0);
    expect(r.bounds.r2).toBe(19);
    expect(r.bounds.c2).toBe(29);
  });
});

// ─── getRoomSummary ──────────────────────────────────────────────────────

describe('getRoomSummary', () => {
  it('returns success:false for unknown labels', () => {
    const r = getRoomSummary('Nonexistent');
    expect(r.success).toBe(false);
  });

  it('returns full summary for a labeled room', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const r = getRoomSummary('A1');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.label).toBe('A1');
    expect(r.cellCount).toBe(9);
    expect(r.bounds).toMatchObject({ r1: 2, c1: 2, r2: 4, c2: 4 });
  });

  it('lists adjacent rooms via doors', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    buildRoom(2, 5, 4, 7, 'A2');
    state.dungeon.cells[3][4].east = 'd';
    state.dungeon.cells[3][5].west = 'd';
    const r = getRoomSummary('A1');
    if (!r.success) throw new Error('expected success');
    expect(r.adjacentRooms).toContain('A2');
  });

  it('lists lights affecting the room', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    state.dungeon.metadata.lights.push({
      id: 7,
      x: 15,
      y: 15,
      type: 'point',
      radius: 25,
      color: '#fff',
      intensity: 1,
      falloff: 'smooth',
    });
    const r = getRoomSummary('A1');
    if (!r.success) throw new Error('expected success');
    expect((r.affectingLights as Array<{ id: number }>).some((l) => l.id === 7)).toBe(true);
  });
});

// ─── queryCells ──────────────────────────────────────────────────────────

describe('queryCells', () => {
  beforeEach(() => {
    buildRoom(2, 2, 5, 5);
    state.dungeon.cells[3][3].prop = { type: 'brazier', span: [1, 1], facing: 0 };
    state.dungeon.cells[3][4].prop = { type: 'chair', span: [1, 1], facing: 0 };
    state.dungeon.cells[4][4].fill = 'water';
    state.dungeon.cells[5][5].center = { label: 'X' };
    markPropSpatialDirty();
  });

  it('returns cells matching prop type', () => {
    const r = queryCells({ prop: 'brazier' });
    expect(r.count).toBe(1);
    expect(r.cells[0]).toMatchObject({ row: 3, col: 3 });
  });

  it('supports prop type arrays', () => {
    const r = queryCells({ prop: ['brazier', 'chair'] });
    expect(r.count).toBe(2);
  });

  it('matches hasFill', () => {
    const r = queryCells({ hasFill: true });
    expect(r.count).toBe(1);
    expect(r.cells[0].cell.fill).toBe('water');
  });

  it('matches hasLabel', () => {
    const r = queryCells({ hasLabel: true });
    expect(r.count).toBe(1);
    expect(r.cells[0].cell.center?.label).toBe('X');
  });

  it('respects region constraint', () => {
    const r = queryCells({ hasProp: true, region: { r1: 4, c1: 4, r2: 5, c2: 5 } });
    expect(r.count).toBe(0);
  });

  it('AND-combines multiple predicates', () => {
    const r = queryCells({ hasProp: true, prop: 'brazier' });
    expect(r.count).toBe(1);
  });

  it('matches isVoid:true for cells outside the room', () => {
    const r = queryCells({ isVoid: true, region: { r1: 0, c1: 0, r2: 1, c2: 1 } });
    expect(r.count).toBe(4);
  });
});

// ─── getLightingCoverage ─────────────────────────────────────────────────

describe('getLightingCoverage', () => {
  it('reports zero cells when map is empty', () => {
    const r = getLightingCoverage();
    expect(r.totalCells).toBe(0);
  });

  it('marks cells as dark when no lights and ambient=0', () => {
    buildRoom(2, 2, 4, 4);
    state.dungeon.metadata.ambientLight = 0;
    const r = getLightingCoverage(0.15);
    expect(r.darkCells).toBe(9);
    expect(r.litCells).toBe(0);
  });

  it('marks cells as lit when ambient > threshold', () => {
    buildRoom(2, 2, 4, 4);
    state.dungeon.metadata.ambientLight = 0.5;
    const r = getLightingCoverage(0.15);
    expect(r.litCells).toBe(9);
    expect(r.darkCells).toBe(0);
  });

  it('respects region option', () => {
    buildRoom(2, 2, 5, 5);
    const r = getLightingCoverage(0.15, { r1: 2, c1: 2, r2: 3, c2: 3 });
    expect(r.totalCells).toBe(4);
  });
});

// ─── findConflicts ───────────────────────────────────────────────────────

describe('findConflicts', () => {
  it('returns no conflicts for a clean map', () => {
    buildRoom(2, 2, 4, 4);
    const r = findConflicts();
    expect(r.conflictCount).toBe(0);
  });

  it('detects lights in the void', () => {
    state.dungeon.metadata.lights.push({
      id: 1,
      x: 15,
      y: 15,
      type: 'point',
      radius: 10,
      color: '#fff',
      intensity: 1,
      falloff: 'smooth',
    });
    const r = findConflicts();
    expect(r.conflicts.some((c) => c.type === 'LIGHT_IN_VOID')).toBe(true);
  });

  it('detects unreachable rooms when an entrance is given', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    buildRoom(2, 5, 4, 7, 'A2');
    // No door — A2 is unreachable
    const r = findConflicts({ entranceLabel: 'A1' });
    expect(r.conflicts.some((c) => c.type === 'UNREACHABLE_ROOM')).toBe(true);
  });

  it('does not check connectivity if no entrance label provided', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    buildRoom(2, 5, 4, 7, 'A2');
    const r = findConflicts();
    expect(r.conflicts.every((c) => c.type !== 'UNREACHABLE_ROOM')).toBe(true);
  });
});

// ─── getPropPlacementOptions ─────────────────────────────────────────────

describe('getPropPlacementOptions', () => {
  it('marks every cell of an empty room as valid', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const r = getPropPlacementOptions('A1', 'chair');
    expect(r.success).toBe(true);
    if (!r.summary || !r.options) throw new Error('expected options');
    expect(r.summary.total).toBe(9);
    expect(r.summary.valid).toBe(9);
    expect(r.summary.invalid).toBe(0);
    expect(r.options.every((o) => o.valid)).toBe(true);
  });

  it('flags cells already covered by a prop', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const meta = state.dungeon.metadata;
    meta.props = meta.props ?? [];
    meta.nextPropId = (meta.nextPropId ?? 1) as number;
    meta.props.push({
      id: `prop_${meta.nextPropId++}`,
      type: 'brazier',
      x: 3 * 5,
      y: 3 * 5,
      rotation: 0,
      scale: 1,
      zIndex: 10,
      flipped: false,
    });
    markPropSpatialDirty();
    const r = getPropPlacementOptions('A1', 'chair');
    if (!r.options) throw new Error('expected options');
    const overlap = r.options.find((o) => o.row === 3 && o.col === 3);
    expect(overlap?.valid).toBe(false);
    expect(overlap?.reasons).toContain('OVERLAPS_PROP');
  });

  it('flags cells that block doors', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    state.dungeon.cells[3][4].east = 'd';
    state.dungeon.cells[3][2].west = 'd';
    const r = getPropPlacementOptions('A1', 'chair');
    if (!r.options) throw new Error('expected options');
    const blockers = r.options.filter((o) => o.reasons?.includes('BLOCKS_DOOR'));
    expect(blockers.length).toBeGreaterThan(0);
  });

  it('omits invalid options when includeInvalid:false', () => {
    buildRoom(2, 2, 4, 4, 'A1');
    const meta = state.dungeon.metadata;
    meta.props = meta.props ?? [];
    meta.nextPropId = (meta.nextPropId ?? 1) as number;
    meta.props.push({
      id: `prop_${meta.nextPropId++}`,
      type: 'brazier',
      x: 3 * 5,
      y: 3 * 5,
      rotation: 0,
      scale: 1,
      zIndex: 10,
      flipped: false,
    });
    markPropSpatialDirty();
    const r = getPropPlacementOptions('A1', 'chair', { includeInvalid: false });
    if (!r.options) throw new Error('expected options');
    expect(r.options.every((o) => o.valid)).toBe(true);
    expect(r.summary?.invalid).toBe(1);
  });

  it('returns success:false for unknown rooms', () => {
    const r = getPropPlacementOptions('Nowhere', 'chair');
    expect(r.success).toBe(false);
  });
});

// ─── searchProps ─────────────────────────────────────────────────────────

describe('searchProps', () => {
  it('filters by placement', () => {
    const r = searchProps({ placement: 'floor' });
    expect(r.count).toBeGreaterThan(0);
    expect(r.props.every((p) => p.placement === 'floor')).toBe(true);
  });

  it('filters by roomType (any-of)', () => {
    const r = searchProps({ roomTypes: ['any'] });
    expect(r.props.every((p) => p.roomTypes.includes('any'))).toBe(true);
  });

  it('filters by namePattern (case-insensitive substring)', () => {
    const r = searchProps({ namePattern: 'BRAZ' });
    expect(r.props.some((p) => p.name === 'brazier')).toBe(true);
  });

  it('returns empty list with no catalog', () => {
    state.propCatalog = null;
    const r = searchProps({});
    expect(r.count).toBe(0);
  });
});

// ─── listDoors / listWalls / listFills ───────────────────────────────────

describe('list enumerations', () => {
  it('listDoors returns deduplicated door entries', () => {
    buildRoom(2, 2, 4, 4);
    buildRoom(2, 5, 4, 7);
    state.dungeon.cells[3][4].east = 'd';
    state.dungeon.cells[3][5].west = 'd';
    const r = listDoors();
    expect(r.doors.length).toBe(1);
  });

  it('listWalls returns all wall edges', () => {
    buildRoom(2, 2, 4, 4);
    const r = listWalls();
    expect(r.walls.length).toBeGreaterThan(0);
  });

  it('listFills enumerates filled cells', () => {
    buildRoom(2, 2, 4, 4);
    state.dungeon.cells[3][3].fill = 'water';
    state.dungeon.cells[3][3].fillDepth = 2;
    const r = listFills();
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toMatchObject({ row: 3, col: 3, type: 'water', depth: 2 });
  });
});

// ─── unlabelledRooms ─────────────────────────────────────────────────────

describe('unlabelledRooms', () => {
  it('detects rooms with no center.label', () => {
    buildRoom(2, 2, 4, 4); // no label
    buildRoom(2, 6, 4, 8, 'A2');
    const r = unlabelledRooms();
    expect(r.count).toBe(1);
    expect(r.rooms[0].cellCount).toBe(9);
  });
});

// ─── getThemeColors ──────────────────────────────────────────────────────

describe('getThemeColors', () => {
  it('returns the theme name from metadata', () => {
    const r = getThemeColors();
    expect(r.themeName).toBe('stone-dungeon');
  });
});
