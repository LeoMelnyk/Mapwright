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

  it('equals 1 for the current codebase', () => {
    expect(CURRENT_FORMAT_VERSION).toBe(1);
  });
});

// ── migrateToLatest ─────────────────────────────────────────────────────────

describe('migrateToLatest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies v0->v1 migration when formatVersion is absent (v0)', () => {
    const json = { metadata: {}, cells: [] };
    const result = migrateToLatest(json);

    expect(migrateHalfTextures).toHaveBeenCalledOnce();
    expect(migrateHalfTextures).toHaveBeenCalledWith(json);
    expect(result.metadata.formatVersion).toBe(1);
  });

  it('stamps formatVersion=1 after migration from v0', () => {
    const json = { metadata: { formatVersion: 0 }, cells: [] };
    migrateToLatest(json);
    expect(json.metadata.formatVersion).toBe(CURRENT_FORMAT_VERSION);
  });

  it('does not apply any migration when formatVersion equals current', () => {
    const json = { metadata: { formatVersion: 1 }, cells: [] };
    migrateToLatest(json);
    expect(migrateHalfTextures).not.toHaveBeenCalled();
    expect(json.metadata.formatVersion).toBe(1);
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
});
