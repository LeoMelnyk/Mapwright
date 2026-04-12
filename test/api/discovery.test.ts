import { describe, it, expect } from 'vitest';
import '../../src/editor/js/api/index.js';
import { apiSearch, apiDetails, apiCategories } from '../../src/editor/js/api/discovery.js';

describe('apiSearch', () => {
  it('returns matching methods by keyword', () => {
    const r = apiSearch('prop');
    expect(r.success).toBe(true);
    expect(r.count).toBeGreaterThan(0);
    expect(r.results.some((x) => x.name === 'placeProp')).toBe(true);
  });

  it('respects the category filter', () => {
    const r = apiSearch('', { category: 'lighting' });
    expect(r.results.every((x) => x.category === 'lighting')).toBe(true);
    expect(r.results.some((x) => x.name === 'placeLight')).toBe(true);
  });

  it('respects the limit option', () => {
    const r = apiSearch('', { limit: 5 });
    expect(r.results.length).toBeLessThanOrEqual(5);
  });

  it('ranks name matches before intent matches', () => {
    const r = apiSearch('prop', { limit: 50 });
    // First result should have "prop" in its name
    expect(r.results[0].name.toLowerCase()).toContain('prop');
  });

  it('returns up to limit entries when query is empty', () => {
    const r = apiSearch('', { limit: 200 });
    expect(r.count).toBeGreaterThan(50);
  });
});

describe('apiDetails', () => {
  it('returns full info for a known method', () => {
    const r = apiDetails('createRoom');
    expect(r.success).toBe(true);
    expect(r.name).toBe('createRoom');
    expect(r.category).toBe('rooms');
    expect(r.intent).toBeTruthy();
    expect(r.sourceModule).toContain('cells');
  });

  it('throws on unknown method', () => {
    expect(() => apiDetails('nonexistentMethod')).toThrow(/UNKNOWN_API_METHOD|No API method/);
  });

  it('reports paramCount for a known method', () => {
    const r = apiDetails('placeProp');
    // placeProp signature is (row, col, propType, facing=0, options={}) — 4 required
    expect(r.paramCount).toBeGreaterThanOrEqual(3);
  });
});

describe('apiCategories', () => {
  it('lists every category with method counts', () => {
    const r = apiCategories();
    expect(r.success).toBe(true);
    expect(r.categories.length).toBeGreaterThan(10);
    const cats = r.categories.map((c) => c.category);
    expect(cats).toContain('lighting');
    expect(cats).toContain('rooms');
    expect(cats).toContain('relational');
    for (const c of r.categories) {
      expect(c.methodCount).toBeGreaterThan(0);
    }
  });
});

// ── Registry coverage check (closes Gap 1) ─────────────────────────────────
//
// Asserts every method on the assembled API has a corresponding entry in the
// discovery registry. If this fails after adding a new API method, add it to
// REGISTRY in src/editor/js/api/discovery.ts under the right category.

describe('discovery registry coverage', () => {
  it('every public API method is registered with apiSearch', async () => {
    const apiModule = (await import('../../src/editor/js/api/index.js')) as { default?: unknown } & Record<
      string,
      unknown
    >;
    // The default export is the assembled api object
    // (api module side-effects assign window.editorAPI)
    const api = ((globalThis as { window?: Record<string, unknown> }).window?.editorAPI ?? apiModule) as Record<
      string,
      unknown
    >;
    const methodNames = Object.keys(api).filter((k) => typeof api[k] === 'function' && !k.startsWith('_'));
    const missing: string[] = [];
    for (const name of methodNames) {
      try {
        apiDetails(name);
      } catch {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Methods missing from discovery REGISTRY (add to src/editor/js/api/discovery.ts):\n  ${missing.join('\n  ')}`,
      );
    }
  });
});
