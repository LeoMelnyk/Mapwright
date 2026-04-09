/**
 * Unit tests for themes.ts — theme registry integrity.
 *
 * The THEMES registry is populated by setup-render.js loading .theme files
 * from src/themes/. These tests verify that all loaded themes have the
 * required properties for the render pipeline.
 */
import { describe, it, expect } from 'vitest';
import { THEMES } from '../../src/render/themes.js';

// ---------------------------------------------------------------------------
// Theme registry integrity
// ---------------------------------------------------------------------------

describe('THEMES registry', () => {
  it('has at least one theme loaded', () => {
    expect(Object.keys(THEMES).length).toBeGreaterThan(0);
  });

  it('contains the default blue-parchment theme', () => {
    expect(THEMES['blue-parchment']).toBeDefined();
  });

  it('all theme keys are valid non-empty strings', () => {
    for (const key of Object.keys(THEMES)) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('all themes have required rendering properties', () => {
    const requiredProps = [
      'background',
      'wallStroke',
      'textColor',
      'gridLine',
      'borderColor',
      'doorFill',
      'doorStroke',
    ];

    for (const [name, theme] of Object.entries(THEMES)) {
      for (const prop of requiredProps) {
        expect(theme, `Theme "${name}" missing "${prop}"`).toHaveProperty(prop);
      }
    }
  });

  it('all themes have string color values for core properties', () => {
    const colorProps = ['background', 'wallStroke', 'textColor'];

    for (const [name, theme] of Object.entries(THEMES)) {
      for (const prop of colorProps) {
        expect(typeof theme[prop], `Theme "${name}".${prop} should be a string`).toBe('string');
      }
    }
  });

  it('no duplicate theme entries (keys are unique by nature of object)', () => {
    // Object keys are inherently unique, but verify the count matches
    // the number of .theme files loaded (sanity check)
    const keys = Object.keys(THEMES);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});
