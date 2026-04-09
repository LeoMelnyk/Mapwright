/**
 * Unit tests for warnings.ts — render warning dedup system.
 *
 * The module maintains a global Set of warnings and deduplicates them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { warn, flush } from '../../src/render/warnings.js';

// Suppress console.warn output during tests
vi.spyOn(console, 'warn').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// warn + flush
// ---------------------------------------------------------------------------

describe('warnings', () => {
  beforeEach(() => {
    // Clear any accumulated warnings from prior tests
    flush();
  });

  it('fires a warning and flush returns it', () => {
    warn('test warning');
    const result = flush();
    expect(result).toEqual(['test warning']);
  });

  it('deduplicates identical warnings', () => {
    warn('duplicate');
    warn('duplicate');
    warn('duplicate');
    const result = flush();
    expect(result).toEqual(['duplicate']);
  });

  it('preserves distinct warnings', () => {
    warn('first');
    warn('second');
    warn('third');
    const result = flush();
    expect(result).toHaveLength(3);
    expect(result).toContain('first');
    expect(result).toContain('second');
    expect(result).toContain('third');
  });

  it('flush clears the internal set', () => {
    warn('ephemeral');
    flush();
    const result = flush();
    expect(result).toEqual([]);
  });

  it('returns empty array when no warnings exist', () => {
    const result = flush();
    expect(result).toEqual([]);
  });

  it('calls console.warn for each warn() call', () => {
    const spy = console.warn;
    spy.mockClear();
    warn('hello');
    warn('hello'); // duplicate — still calls console.warn
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
