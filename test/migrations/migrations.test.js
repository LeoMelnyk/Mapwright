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
});
