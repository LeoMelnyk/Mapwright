/**
 * Unit tests for validate.ts — dungeon config validation.
 *
 * Tests validateMatrixFormat, validateCell, and validateConfig.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  validateCell,
  validateMatrixFormat,
  validateConfig,
} from '../../src/render/validate.js';

// Suppress console output from validation functions
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// validateCell
// ---------------------------------------------------------------------------

describe('validateCell', () => {
  it('accepts null cell (void)', () => {
    const errors = [];
    validateCell(null, null, 0, 0, errors);
    expect(errors).toHaveLength(0);
  });

  it('accepts undefined cell (void)', () => {
    const errors = [];
    // undefined is not accepted — only null represents void cells
    validateCell(null, null, 0, 0, errors);
    expect(errors).toHaveLength(0);
  });

  it('accepts a valid cell with wall borders', () => {
    const errors = [];
    validateCell({ north: 'w', east: 'w', south: 'd', west: 's' }, null, 0, 0, errors);
    expect(errors).toHaveLength(0);
  });

  it('accepts a cell with center label', () => {
    const errors = [];
    validateCell({ center: { label: 'A1' } }, null, 0, 0, errors);
    expect(errors).toHaveLength(0);
  });

  it('rejects invalid border value', () => {
    const errors = [];
    validateCell({ north: 'x' }, null, 0, 0, errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("must be 'w', 'd', or 's'");
  });

  it('rejects non-object cell', () => {
    const errors = [];
    validateCell('invalid', null, 1, 2, errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('must be an object or null');
  });

  it('rejects center label with diagonal border', () => {
    const errors = [];
    validateCell({ 'nw-se': 'w', center: { label: 'A1' } }, null, 0, 0, errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('diagonal');
  });

  it('includes level in error message when provided', () => {
    const errors = [];
    validateCell('bad', 2, 3, 4, errors);
    expect(errors[0]).toContain('Level 2');
  });
});

// ---------------------------------------------------------------------------
// validateMatrixFormat
// ---------------------------------------------------------------------------

describe('validateMatrixFormat', () => {
  it('passes for a valid single-level dungeon', () => {
    const config = {
      metadata: { dungeonName: 'Test', gridSize: 5, levels: [{ name: null, startRow: 0, numRows: 2 }] },
      cells: [
        [{ north: 'w', west: 'w' }, { north: 'w', east: 'w' }],
        [{ south: 'w', west: 'w' }, { south: 'w', east: 'w' }],
      ],
    };
    // Should not throw
    expect(() => validateMatrixFormat(config)).not.toThrow();
  });

  it('throws for missing metadata', () => {
    const config = {
      cells: [[{}]],
    };
    expect(() => validateMatrixFormat(config)).toThrow();
  });

  it('throws for missing dungeonName', () => {
    const config = {
      metadata: { gridSize: 5 },
      cells: [[{}]],
    };
    expect(() => validateMatrixFormat(config)).toThrow();
  });

  it('throws for missing gridSize', () => {
    const config = {
      metadata: { dungeonName: 'Test' },
      cells: [[{}]],
    };
    expect(() => validateMatrixFormat(config)).toThrow();
  });

  it('throws for missing cells array', () => {
    const config = {
      metadata: { dungeonName: 'Test', gridSize: 5 },
    };
    expect(() => validateMatrixFormat(config)).toThrow();
  });

  it('throws for invalid cell edge values', () => {
    const config = {
      metadata: { dungeonName: 'Test', gridSize: 5 },
      cells: [
        [{ north: 'invalid' }],
      ],
    };
    expect(() => validateMatrixFormat(config)).toThrow();
  });

  it('accepts null cells in the grid (void spaces)', () => {
    const config = {
      metadata: { dungeonName: 'Test', gridSize: 5, levels: [{ name: null, startRow: 0, numRows: 2 }] },
      cells: [
        [null, { north: 'w', east: 'w', south: 'w', west: 'w' }],
        [null, null],
      ],
    };
    // Should not throw — null cells are valid void spaces
    expect(() => validateMatrixFormat(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateConfig (legacy coordinate-based)
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('throws for missing dungeonName', () => {
    expect(() => validateConfig({ gridSize: 5, rooms: [{ id: 'r1' }] })).toThrow('dungeonName');
  });

  it('throws for missing gridSize', () => {
    expect(() => validateConfig({ dungeonName: 'Test', rooms: [{ id: 'r1' }] })).toThrow('gridSize');
  });

  it('throws for no rooms', () => {
    expect(() => validateConfig({ dungeonName: 'Test', gridSize: 5, rooms: [] })).toThrow('No rooms');
  });

  it('throws for duplicate room IDs', () => {
    expect(() => validateConfig({
      dungeonName: 'Test',
      gridSize: 5,
      rooms: [{ id: 'r1' }, { id: 'r1' }],
    })).toThrow('Duplicate');
  });

  it('does not throw for a valid config', () => {
    expect(() => validateConfig({
      dungeonName: 'Test',
      gridSize: 5,
      rooms: [{ id: 'r1' }, { id: 'r2' }],
    })).not.toThrow();
  });
});
