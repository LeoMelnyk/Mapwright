import { describe, it, expect } from 'vitest';
import {
  resolveZIndex, Z_PRESETS,
  gridToWorldFeet, worldFeetToGrid,
  isGridAlignedRotation, effectiveSpan,
  getOverlayPropAABB, createOverlayProp, nextPropId,
} from '../../src/editor/js/prop-overlay.js';
import { PropSpatialIndex } from '../../src/editor/js/prop-spatial-overlay.js';

// ── resolveZIndex ───────────────────────────────────────────────────────────

describe('resolveZIndex', () => {
  it('resolves preset names', () => {
    expect(resolveZIndex('floor')).toBe(0);
    expect(resolveZIndex('furniture')).toBe(10);
    expect(resolveZIndex('tall')).toBe(20);
    expect(resolveZIndex('hanging')).toBe(30);
  });

  it('passes through numbers', () => {
    expect(resolveZIndex(5)).toBe(5);
    expect(resolveZIndex(0)).toBe(0);
    expect(resolveZIndex(99)).toBe(99);
  });

  it('defaults unknown strings to furniture', () => {
    expect(resolveZIndex('bogus')).toBe(Z_PRESETS.furniture);
  });
});

// ── Coordinate conversion ───────────────────────────────────────────────────

describe('gridToWorldFeet', () => {
  it('converts at gridSize 5', () => {
    expect(gridToWorldFeet(3, 7, 5)).toEqual({ x: 35, y: 15 });
  });

  it('converts at gridSize 10', () => {
    expect(gridToWorldFeet(0, 0, 10)).toEqual({ x: 0, y: 0 });
  });
});

describe('worldFeetToGrid', () => {
  it('inverse of gridToWorldFeet for exact values', () => {
    expect(worldFeetToGrid(35, 15, 5)).toEqual({ row: 3, col: 7 });
  });

  it('floors fractional values', () => {
    expect(worldFeetToGrid(37.5, 17.5, 5)).toEqual({ row: 3, col: 7 });
  });
});

// ── isGridAlignedRotation ───────────────────────────────────────────────────

describe('isGridAlignedRotation', () => {
  it('returns true for 0, 90, 180, 270', () => {
    expect(isGridAlignedRotation(0)).toBe(true);
    expect(isGridAlignedRotation(90)).toBe(true);
    expect(isGridAlignedRotation(180)).toBe(true);
    expect(isGridAlignedRotation(270)).toBe(true);
  });

  it('returns true for equivalent values (360, -90)', () => {
    expect(isGridAlignedRotation(360)).toBe(true);
    expect(isGridAlignedRotation(-90)).toBe(true);
  });

  it('returns false for arbitrary angles', () => {
    expect(isGridAlignedRotation(45)).toBe(false);
    expect(isGridAlignedRotation(135)).toBe(false);
    expect(isGridAlignedRotation(1)).toBe(false);
  });
});

// ── effectiveSpan ───────────────────────────────────────────────────────────

describe('effectiveSpan', () => {
  const propDef1x3 = { footprint: [1, 3] };
  const propDef2x2 = { footprint: [2, 2] };

  it('returns original footprint at 0°', () => {
    expect(effectiveSpan(propDef1x3, 0)).toEqual([1, 3]);
  });

  it('swaps at 90°', () => {
    expect(effectiveSpan(propDef1x3, 90)).toEqual([3, 1]);
  });

  it('returns original at 180°', () => {
    expect(effectiveSpan(propDef1x3, 180)).toEqual([1, 3]);
  });

  it('swaps at 270°', () => {
    expect(effectiveSpan(propDef1x3, 270)).toEqual([3, 1]);
  });

  it('square props are unchanged at any grid rotation', () => {
    expect(effectiveSpan(propDef2x2, 90)).toEqual([2, 2]);
  });

  it('handles arbitrary rotation with AABB', () => {
    const [eRows, eCols] = effectiveSpan(propDef1x3, 45);
    // 45° rotation of 1x3: both dimensions should be roughly sqrt(0.5)*(1+3)
    expect(eRows).toBeGreaterThan(1);
    expect(eCols).toBeGreaterThan(1);
    expect(eRows).toBeLessThan(4);
    expect(eCols).toBeLessThan(4);
  });
});

// ── getOverlayPropAABB ──────────────────────────────────────────────────────

describe('getOverlayPropAABB', () => {
  const propDef = { footprint: [1, 2] };
  const gridSize = 5;

  it('grid-aligned at scale 1.0', () => {
    const prop = { x: 10, y: 15, rotation: 0, scale: 1.0 };
    const aabb = getOverlayPropAABB(prop, propDef, gridSize);
    expect(aabb).toEqual({ minX: 10, minY: 15, maxX: 20, maxY: 20 });
  });

  it('grid-aligned at 90° swaps dimensions', () => {
    const prop = { x: 10, y: 15, rotation: 90, scale: 1.0 };
    const aabb = getOverlayPropAABB(prop, propDef, gridSize);
    // 1x2 at 90° → effective 2x1 → width=5, height=10
    expect(aabb).toEqual({ minX: 10, minY: 15, maxX: 15, maxY: 25 });
  });

  it('scale 2.0 doubles size', () => {
    const prop = { x: 10, y: 15, rotation: 0, scale: 2.0 };
    const aabb = getOverlayPropAABB(prop, propDef, gridSize);
    // 1x2 at scale 2 → width=20, height=10
    expect(aabb).toEqual({ minX: 10, minY: 15, maxX: 30, maxY: 25 });
  });
});

// ── createOverlayProp ───────────────────────────────────────────────────────

describe('createOverlayProp', () => {
  it('creates a prop with defaults', () => {
    const metadata = { nextPropId: 1 };
    const prop = createOverlayProp(metadata, 'throne', 3, 5, 5);
    expect(prop).toEqual({
      id: 'prop_1',
      type: 'throne',
      x: 25,
      y: 15,
      rotation: 0,
      scale: 1.0,
      zIndex: 10,
      flipped: false,
    });
    expect(metadata.nextPropId).toBe(2);
  });

  it('accepts options', () => {
    const metadata = { nextPropId: 5 };
    const prop = createOverlayProp(metadata, 'rug', 0, 0, 5, {
      rotation: 45, scale: 0.5, zIndex: 'floor', flipped: true,
    });
    expect(prop.id).toBe('prop_5');
    expect(prop.rotation).toBe(45);
    expect(prop.scale).toBe(0.5);
    expect(prop.zIndex).toBe(0);
    expect(prop.flipped).toBe(true);
  });
});

// ── nextPropId ──────────────────────────────────────────────────────────────

describe('nextPropId', () => {
  it('auto-initializes from undefined', () => {
    const metadata = {};
    const id = nextPropId(metadata);
    expect(id).toBe('prop_1');
    expect(metadata.nextPropId).toBe(2);
  });

  it('increments monotonically', () => {
    const metadata = { nextPropId: 10 };
    expect(nextPropId(metadata)).toBe('prop_10');
    expect(nextPropId(metadata)).toBe('prop_11');
    expect(nextPropId(metadata)).toBe('prop_12');
  });
});

// ── PropSpatialIndex ────────────────────────────────────────────────────────

describe('PropSpatialIndex', () => {
  const propCatalog = {
    props: {
      'pillar': { footprint: [1, 1] },
      'table': { footprint: [2, 2] },
      'bookshelf': { footprint: [1, 3] },
    },
  };
  const gridSize = 5;

  function makeProps() {
    return [
      { id: 'prop_1', type: 'pillar', x: 10, y: 15, rotation: 0, scale: 1.0, zIndex: 10, flipped: false },
      { id: 'prop_2', type: 'table', x: 25, y: 20, rotation: 0, scale: 1.0, zIndex: 10, flipped: false },
      { id: 'prop_3', type: 'bookshelf', x: 50, y: 10, rotation: 0, scale: 1.0, zIndex: 10, flipped: false },
    ];
  }

  it('rebuilds and queries correctly', () => {
    const idx = new PropSpatialIndex();
    idx.rebuild(makeProps(), propCatalog, gridSize);

    // Point query on pillar (1x1 at 10,15 → AABB 10,15 to 15,20)
    const hits = idx.queryPoint(12, 17);
    expect(hits).toContain('prop_1');
    expect(hits).not.toContain('prop_2');
  });

  it('rectangle query finds overlapping props', () => {
    const idx = new PropSpatialIndex();
    idx.rebuild(makeProps(), propCatalog, gridSize);

    // Query region that overlaps pillar and table
    const hits = idx.query(5, 10, 30, 25);
    expect(hits).toContain('prop_1');
    expect(hits).toContain('prop_2');
    expect(hits).not.toContain('prop_3');
  });

  it('returns empty for no-match regions', () => {
    const idx = new PropSpatialIndex();
    idx.rebuild(makeProps(), propCatalog, gridSize);

    const hits = idx.query(100, 100, 200, 200);
    expect(hits).toHaveLength(0);
  });

  it('cell-grid backward compat works', () => {
    const idx = new PropSpatialIndex();
    idx.rebuild(makeProps(), propCatalog, gridSize);

    // Pillar at x=10,y=15 → row=3, col=2
    expect(idx.isPropAtCell(3, 2)).toBe(true);
    const info = idx.lookupPropAtCell(3, 2);
    expect(info.propId).toBe('prop_1');
    expect(info.propType).toBe('pillar');

    // Table at x=25,y=20 → row=4, col=5, spans 2x2
    expect(idx.isPropAtCell(4, 5)).toBe(true);
    expect(idx.isPropAtCell(5, 6)).toBe(true);

    // Empty cell
    expect(idx.isPropAtCell(0, 0)).toBe(false);
  });

  it('handles null/empty props gracefully', () => {
    const idx = new PropSpatialIndex();
    idx.rebuild(null, propCatalog, gridSize);
    expect(idx.queryPoint(10, 10)).toHaveLength(0);

    idx.rebuild([], propCatalog, gridSize);
    expect(idx.queryPoint(10, 10)).toHaveLength(0);
  });

  it('findPropAtGrid locates by grid position', () => {
    const idx = new PropSpatialIndex();
    const props = makeProps();
    idx.rebuild(props, propCatalog, gridSize);

    const found = idx.findPropAtGrid(3, 2, gridSize);
    expect(found).not.toBeNull();
    expect(found.id).toBe('prop_1');

    const notFound = idx.findPropAtGrid(0, 0, gridSize);
    expect(notFound).toBeNull();
  });

  it('dirty flag triggers lazy rebuild', () => {
    const idx = new PropSpatialIndex();
    const props = makeProps();
    idx.rebuild(props, propCatalog, gridSize);
    expect(idx.isPropAtCell(3, 2)).toBe(true);

    idx.markDirty();
    // ensureBuilt with same props reference — should rebuild
    idx.ensureBuilt(props, propCatalog, gridSize);
    expect(idx.isPropAtCell(3, 2)).toBe(true);
  });
});
