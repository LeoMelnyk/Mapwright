import { vi, describe, it, expect, beforeEach } from 'vitest';

// The global setup.js mocks migrations.js — undo that so we test the REAL module.
vi.unmock('../../src/editor/js/migrations.js');

// Mock io.js since it has browser deps
vi.mock('../../src/editor/js/io.js', () => ({
  migrateHalfTextures: vi.fn(),
}));

import { CURRENT_FORMAT_VERSION, migrateToLatest } from '../../src/editor/js/migrations.js';
import { migrateHalfTextures } from '../../src/editor/js/io.js';

// ── CURRENT_FORMAT_VERSION ──────────────────────────────────────────────────

describe('CURRENT_FORMAT_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(CURRENT_FORMAT_VERSION)).toBe(true);
    expect(CURRENT_FORMAT_VERSION).toBeGreaterThan(0);
  });

  it('equals 3 for the current codebase', () => {
    expect(CURRENT_FORMAT_VERSION).toBe(4);
  });
});

// ── migrateToLatest ─────────────────────────────────────────────────────────

describe('migrateToLatest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies v0->v1->v2 migration when formatVersion is absent (v0)', () => {
    const json = { metadata: {}, cells: [] };
    const result = migrateToLatest(json);

    expect(migrateHalfTextures).toHaveBeenCalledOnce();
    expect(migrateHalfTextures).toHaveBeenCalledWith(json);
    expect(result.metadata.formatVersion).toBe(4);
    // v1->v2 creates metadata.props[]
    expect(result.metadata.props).toEqual([]);
  });

  it('stamps current version after migration from v0', () => {
    const json = { metadata: { formatVersion: 0 }, cells: [] };
    migrateToLatest(json);
    expect(json.metadata.formatVersion).toBe(CURRENT_FORMAT_VERSION);
  });

  it('does not apply any migration when formatVersion equals current', () => {
    const json = { metadata: { formatVersion: 4, props: [], resolution: 2 }, cells: [] };
    migrateToLatest(json);
    expect(migrateHalfTextures).not.toHaveBeenCalled();
    expect(json.metadata.formatVersion).toBe(4);
  });

  it('logs warning and returns json unchanged for future version', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const json = { metadata: { formatVersion: 99 }, cells: [] };
    const result = migrateToLatest(json);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('99');
    expect(warnSpy.mock.calls[0][0]).toContain('newer');
    expect(result.metadata.formatVersion).toBe(99);
    expect(migrateHalfTextures).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('returns the same json object (in-place mutation)', () => {
    const json = { metadata: {}, cells: [] };
    const result = migrateToLatest(json);
    expect(result).toBe(json);
  });

  it('returns json unchanged when metadata is missing', () => {
    const json = { cells: [] };
    const result = migrateToLatest(json);
    expect(result).toBe(json);
    expect(migrateHalfTextures).not.toHaveBeenCalled();
  });

  it('migration from v0 calls migrateHalfTextures with the json object', () => {
    const json = { metadata: { formatVersion: 0 }, cells: [[{ texture: 'half:stone' }]] };
    migrateToLatest(json);
    expect(migrateHalfTextures).toHaveBeenCalledWith(json);
  });

  it('preserves existing metadata fields during migration', () => {
    const json = { metadata: { dungeonName: 'Test', gridSize: 5 }, cells: [] };
    migrateToLatest(json);
    expect(json.metadata.dungeonName).toBe('Test');
    expect(json.metadata.gridSize).toBe(5);
    expect(json.metadata.formatVersion).toBe(CURRENT_FORMAT_VERSION);
  });

  // ── v1 → v2: Props to Overlay ──────────────────────────────────────────

  it('v1->v2 extracts cell.prop into metadata.props[]', () => {
    const json = {
      metadata: { formatVersion: 1, gridSize: 5 },
      cells: [
        [null, null, null],
        [null, { prop: { type: 'throne', span: [1, 1], facing: 90, flipped: false } }, null],
        [null, null, null],
      ],
    };
    migrateToLatest(json);

    expect(json.metadata.formatVersion).toBe(4);
    expect(json.metadata.props).toHaveLength(1);
    const p = json.metadata.props[0];
    expect(p.type).toBe('throne');
    expect(p.x).toBe(5);   // col=1 * gridSize=5
    expect(p.y).toBe(5);   // row=1 * gridSize=5
    expect(p.rotation).toBe(90);
    expect(p.scale).toBe(1.0);
    expect(p.zIndex).toBe(10);
    expect(p.id).toBe('prop_1');
  });

  it('v1->v2 handles multiple props', () => {
    const json = {
      metadata: { formatVersion: 1, gridSize: 10 },
      cells: [
        [{ prop: { type: 'pillar', span: [1, 1], facing: 0 } }, null],
        [null, { prop: { type: 'chair', span: [1, 1], facing: 270, flipped: true } }],
      ],
    };
    migrateToLatest(json);

    expect(json.metadata.props).toHaveLength(2);
    expect(json.metadata.props[0].type).toBe('pillar');
    expect(json.metadata.props[0].x).toBe(0);
    expect(json.metadata.props[0].y).toBe(0);
    expect(json.metadata.props[1].type).toBe('chair');
    expect(json.metadata.props[1].x).toBe(10);
    expect(json.metadata.props[1].y).toBe(10);
    expect(json.metadata.props[1].flipped).toBe(true);
    expect(json.metadata.nextPropId).toBe(3);
  });

  it('v1->v2 skips if metadata.props already exists', () => {
    const json = {
      metadata: { formatVersion: 1, props: [{ id: 'existing' }] },
      cells: [[{ prop: { type: 'throne', span: [1, 1], facing: 0 } }]],
    };
    migrateToLatest(json);

    // Should not overwrite existing props
    expect(json.metadata.props).toHaveLength(1);
    expect(json.metadata.props[0].id).toBe('existing');
  });

  it('v1->v2 creates empty array when no props exist', () => {
    const json = {
      metadata: { formatVersion: 1, gridSize: 5 },
      cells: [[null, {}], [null, null]],
    };
    migrateToLatest(json);

    expect(json.metadata.props).toEqual([]);
    expect(json.metadata.nextPropId).toBe(1);
  });

  // ── v1 → v2: Edge cases ──────────────────────────────────────────────────

  it('v1->v2 deletes cell.prop after extraction', () => {
    const json = {
      metadata: { formatVersion: 1, gridSize: 5 },
      cells: [
        [{ prop: { type: 'chair', span: [1, 1], facing: 0 } }],
      ],
    };
    migrateToLatest(json);

    expect(json.cells[0][0].prop).toBeUndefined();
    expect(json.metadata.props.length).toBe(1);
  });

  it('v1->v2 computes correct x/y from row/col and gridSize', () => {
    const json = {
      metadata: { formatVersion: 1, gridSize: 8 },
      cells: [
        [null, null, null],
        [null, null, { prop: { type: 'altar', span: [1, 1], facing: 180 } }],
      ],
    };
    migrateToLatest(json);

    const p = json.metadata.props[0];
    expect(p.x).toBe(16); // col=2 * gridSize=8
    expect(p.y).toBe(8);  // row=1 * gridSize=8
    expect(p.rotation).toBe(180);
  });

  it('v1->v2 assigns sequential prop ids', () => {
    const json = {
      metadata: { formatVersion: 1, gridSize: 5 },
      cells: [
        [{ prop: { type: 'a', span: [1, 1], facing: 0 } }, { prop: { type: 'b', span: [1, 1], facing: 0 } }],
        [{ prop: { type: 'c', span: [1, 1], facing: 0 } }, null],
      ],
    };
    migrateToLatest(json);

    const ids = json.metadata.props.map(p => p.id);
    expect(ids).toEqual(['prop_1', 'prop_2', 'prop_3']);
    expect(json.metadata.nextPropId).toBe(4);
  });

  // ── v2 → v3: Half-cell resolution ────────────────────────────────────────

  it('v2->v3 doubles grid dimensions', () => {
    const json = {
      metadata: { formatVersion: 2, gridSize: 10, props: [] },
      cells: [
        [null, {}],
        [{}, null],
      ],
    };
    migrateToLatest(json);

    expect(json.cells.length).toBe(4); // 2*2
    expect(json.cells[0].length).toBe(4); // 2*2
  });

  it('v2->v3 halves gridSize and sets resolution to 2', () => {
    const json = {
      metadata: { formatVersion: 2, gridSize: 10, props: [] },
      cells: [[null]],
    };
    migrateToLatest(json);

    expect(json.metadata.gridSize).toBe(5);
    expect(json.metadata.resolution).toBe(2);
  });

  it('v2->v3 replicates walls to correct sub-cells', () => {
    const json = {
      metadata: { formatVersion: 2, gridSize: 10, props: [] },
      cells: [
        [{ north: 'w', east: 'd' }],
      ],
    };
    migrateToLatest(json);

    const tl = json.cells[0][0];
    const tr = json.cells[0][1];
    const bl = json.cells[1][0];
    const br = json.cells[1][1];

    // North wall on TL and TR
    expect(tl.north).toBe('w');
    expect(tr.north).toBe('w');
    // East wall on TR and BR only
    expect(tr.east).toBe('d');
    expect(br.east).toBe('d');
    // TL and BL should not have east wall (internal)
    expect(tl.east).toBeUndefined();
    expect(bl.east).toBeUndefined();
  });

  it('v2->v3 replicates fill to all 4 sub-cells', () => {
    const json = {
      metadata: { formatVersion: 2, gridSize: 10, props: [] },
      cells: [
        [{ fill: 'water' }],
      ],
    };
    migrateToLatest(json);

    expect(json.cells[0][0].fill).toBe('water');
    expect(json.cells[0][1].fill).toBe('water');
    expect(json.cells[1][0].fill).toBe('water');
    expect(json.cells[1][1].fill).toBe('water');
  });

  it('v2->v3 places label on TL sub-cell', () => {
    const json = {
      metadata: { formatVersion: 2, gridSize: 10, props: [] },
      cells: [
        [{ center: { label: 'A1' } }],
      ],
    };
    migrateToLatest(json);

    expect(json.cells[0][0].center.label).toBe('A1');
    expect(json.cells[0][1].center).toBeUndefined();
    expect(json.cells[1][0].center).toBeUndefined();
  });

  it('v2->v3 doubles level startRow and numRows', () => {
    const json = {
      metadata: {
        formatVersion: 2, gridSize: 10, props: [],
        levels: [{ name: 'L1', startRow: 5, numRows: 10 }],
      },
      cells: Array.from({ length: 20 }, () => Array(10).fill(null)),
    };
    migrateToLatest(json);

    expect(json.metadata.levels[0].startRow).toBe(10);
    expect(json.metadata.levels[0].numRows).toBe(20);
  });

  it('v2->v3 doubles stair corner point coordinates', () => {
    const json = {
      metadata: {
        formatVersion: 2, gridSize: 10, props: [],
        stairs: [{ points: [[3, 4], [5, 6]] }],
      },
      cells: Array.from({ length: 10 }, () => Array(10).fill(null)),
    };
    migrateToLatest(json);

    expect(json.metadata.stairs[0].points[0]).toEqual([6, 8]);
    expect(json.metadata.stairs[0].points[1]).toEqual([10, 12]);
  });

  it('v2->v3 doubles bridge corner point coordinates', () => {
    const json = {
      metadata: {
        formatVersion: 2, gridSize: 10, props: [],
        bridges: [{ points: [[2, 3], [4, 5]] }],
      },
      cells: Array.from({ length: 10 }, () => Array(10).fill(null)),
    };
    migrateToLatest(json);

    expect(json.metadata.bridges[0].points[0]).toEqual([4, 6]);
    expect(json.metadata.bridges[0].points[1]).toEqual([8, 10]);
  });

  it('v2->v3 preserves null cells', () => {
    const json = {
      metadata: { formatVersion: 2, gridSize: 10, props: [] },
      cells: [
        [null, {}],
        [{}, null],
      ],
    };
    migrateToLatest(json);

    // Null old cells → all 4 sub-cells null
    expect(json.cells[0][0]).toBeNull();
    expect(json.cells[0][1]).toBeNull();
    expect(json.cells[1][0]).toBeNull();
    expect(json.cells[1][1]).toBeNull();
    // Non-null old cells → all 4 sub-cells exist
    expect(json.cells[0][2]).not.toBeNull();
    expect(json.cells[0][3]).not.toBeNull();
    expect(json.cells[1][2]).not.toBeNull();
    expect(json.cells[1][3]).not.toBeNull();
  });

  // ── v0 → v4: Full pipeline ───────────────────────────────────────────────

  it('applies full migration chain from v0 to v4', () => {
    const json = {
      metadata: { formatVersion: 0, gridSize: 10 },
      cells: [
        [null, { prop: { type: 'barrel', span: [1, 1], facing: 0 } }],
        [{ north: 'w', south: 'd' }, null],
      ],
    };
    migrateToLatest(json);

    expect(json.metadata.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    // v1->v2: prop extracted to overlay
    expect(json.metadata.props.length).toBe(1);
    expect(json.metadata.props[0].type).toBe('barrel');
    // v2->v3: grid doubled
    expect(json.cells.length).toBe(4);
    expect(json.cells[0].length).toBe(4);
    // v2->v3: gridSize halved
    expect(json.metadata.gridSize).toBe(5);
    expect(json.metadata.resolution).toBe(2);
  });

  // ── Specific version jumps ───────────────────────────────────────────────

  it('skips v0->v1 when starting at v1', () => {
    const json = {
      metadata: { formatVersion: 1, gridSize: 10 },
      cells: [[null]],
    };
    migrateToLatest(json);

    expect(migrateHalfTextures).not.toHaveBeenCalled();
    expect(json.metadata.formatVersion).toBe(CURRENT_FORMAT_VERSION);
  });

  it('v2 json only applies v2->v3 and v3->v4', () => {
    const json = {
      metadata: { formatVersion: 2, gridSize: 10, props: [] },
      cells: [[{}]],
    };
    migrateToLatest(json);

    expect(migrateHalfTextures).not.toHaveBeenCalled();
    expect(json.metadata.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    // Grid should have been doubled (v2->v3)
    expect(json.cells.length).toBe(2);
    expect(json.metadata.gridSize).toBe(5);
  });

  it('v3 json only applies v3->v4', () => {
    const json = {
      metadata: { formatVersion: 3, gridSize: 5, resolution: 2, props: [] },
      cells: [[{}]],
    };
    migrateToLatest(json);

    expect(json.metadata.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    // Grid should NOT have been doubled (v2->v3 not applied)
    expect(json.cells.length).toBe(1);
    expect(json.metadata.gridSize).toBe(5);
  });

  // ── Repair pass ──────────────────────────────────────────────────────────

  it('repair pass handles cells with trimWall but no trimCrossing', () => {
    // Already at v4 but missing trimCrossing — repair pass should fix
    const json = {
      metadata: { formatVersion: 4, props: [], resolution: 2 },
      cells: [
        [{ trimWall: [[0, 0], [1, 1]], trimClip: [[0, 0], [1, 0], [1, 1]] }],
      ],
    };
    // Should not throw
    migrateToLatest(json);
    expect(json.metadata.formatVersion).toBe(4);
  });
});
