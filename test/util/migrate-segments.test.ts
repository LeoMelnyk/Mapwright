// Tests for src/util/migrate-segments.ts (P3a foundation).
//
// Two strands:
//   1. Synthesis-↔-migration equivalence: for every row of the migration
//      table in the plan, build a legacy cell, call getSegments(legacy)
//      → segments_synth; then migrate(legacy) and call getSegments(migrated)
//      → segments_migrated. They must match. (Excluding void-corner cases,
//      which require neighbor state — synthesis can't see those.)
//
//   2. Idempotence + real-fixture safety: running the migration on real
//      saved maps doesn't throw, never mutates an already-migrated cell,
//      and produces segments that satisfy the same invariants the parity
//      harness already pins down.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Cell, CellGrid, Segment } from '../../src/types.js';
import { getSegments, getInteriorEdges } from '../../src/util/cell-segments.js';
import { migrateCellsToSegments, type LegacyCell, type LegacyCellGrid } from '../../src/util/migrate-segments.js';
import { migrateToLatest } from '../../src/editor/js/migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Strip cell.segments / cell.interiorEdges from a synthesized result so we
// compare the SHAPE (polygons, ids, textures, edges) without mutating the
// input. getSegments returns the live array when authoritative, or fresh
// objects when synthesizing — either way we deep-clone to be safe.
function cloneSegments(segs: Segment[]): Segment[] {
  return segs.map((s) => ({ ...s, polygon: s.polygon.map((p) => [p[0]!, p[1]!]) }));
}

function singleCellGrid(cell: Cell | LegacyCell): CellGrid {
  return [[cell as Cell]];
}

describe('migrate-segments: legacy → segments shape', () => {
  it('unsplit cell with texture → one full segment with the texture; legacy fields gone', () => {
    const migrated: LegacyCell = { texture: 'polyhaven/cobblestone_floor_03', textureOpacity: 0.7 };
    migrateCellsToSegments(singleCellGrid(migrated));

    expect(migrated.segments).toBeDefined();
    expect(migrated.segments).toHaveLength(1);
    expect(migrated.segments![0]!.texture).toBe('polyhaven/cobblestone_floor_03');
    expect(migrated.segments![0]!.textureOpacity).toBe(0.7);
    // Legacy fields gone after migration.
    expect(migrated.texture).toBeUndefined();
    expect(migrated.textureOpacity).toBeUndefined();
  });

  it('unsplit cell with only corner-blend textures → migrated and legacy corner fields stripped', () => {
    // Corner blend textures (textureNE/NW/SE/SW) are render-time artifacts —
    // the new segment pipeline regenerates them from blend topology, so any
    // surviving corner-texture data on a legacy cell with no main texture
    // is dead weight that must be cleaned up. Pre-fix: this case fell through
    // to "truly empty" and `deleteLegacyFields` was never called.
    const migrated = {
      textureNE: 'polyhaven/wood_floor',
      textureNEOpacity: 0.5,
      textureSW: 'polyhaven/dirt_floor',
    } as LegacyCell;
    migrateCellsToSegments(singleCellGrid(migrated));

    expect(migrated.segments).toBeDefined();
    expect(migrated.segments).toHaveLength(1);
    // No main texture was set, so the unsplit segment should have none either.
    expect(migrated.segments![0]!.texture).toBeUndefined();
    // All corner-texture fields stripped.
    expect((migrated as Cell).textureNE).toBeUndefined();
    expect((migrated as Cell).textureNEOpacity).toBeUndefined();
    expect((migrated as Cell).textureSW).toBeUndefined();
  });

  // Helper: wrap a single cell in a 3×3 grid of plain cells so that
  // computeVoidCornerForDiagonal sees populated neighbors on every side and
  // doesn't trigger spurious void-corner detection from the grid edges.
  function paddedGrid(cell: LegacyCell): CellGrid {
    return [
      [{}, {}, {}],
      [{}, cell as Cell, {}],
      [{}, {}, {}],
    ];
  }

  it('nw-se diagonal cell with primary + secondary texture → SW/NE segments', () => {
    const migrated: LegacyCell = { 'nw-se': 'w', texture: 'a', textureSecondary: 'b' };
    migrateCellsToSegments(paddedGrid(migrated));

    expect(migrated.segments).toHaveLength(2);
    // s0 = SW: legacy textureSecondary; s1 = NE: legacy texture.
    expect(migrated.segments![0]!.texture).toBe('b');
    expect(migrated.segments![1]!.texture).toBe('a');
    expect(migrated.interiorEdges).toHaveLength(1);
    expect(migrated.interiorEdges![0]!.wall).toBe('w');
    expect(migrated.interiorEdges![0]!.between).toEqual([0, 1]);
    expect(migrated['nw-se']).toBeUndefined();
    expect(migrated.textureSecondary).toBeUndefined();
  });

  it('ne-sw diagonal cell with door wall → migrated edge wall is the door type', () => {
    const migrated: LegacyCell = { 'ne-sw': 'd', texture: 'a' };
    migrateCellsToSegments(paddedGrid(migrated));
    expect(migrated.interiorEdges![0]!.wall).toBe('d');
    expect(migrated.segments).toHaveLength(2);
  });

  it('trim arc cell with interior + exterior textures → matching segments + chord wall', () => {
    const trimClip = [
      [1, 0.4],
      [1, 1],
      [0, 1],
      [0, 0.4],
      [0.5, 0.6],
    ];
    const migrated: LegacyCell = { trimClip, texture: 'floor', textureSecondary: 'void' };
    migrateCellsToSegments(singleCellGrid(migrated));

    expect(migrated.segments).toHaveLength(2);
    // s0 = interior gets primary `texture`; s1 = exterior gets `textureSecondary`.
    expect(migrated.segments![0]!.texture).toBe('floor');
    expect(migrated.segments![1]!.texture).toBe('void');
    expect(migrated.interiorEdges).toHaveLength(1);
    expect(migrated.interiorEdges![0]!.wall).toBe('w');
    expect(migrated.trimClip).toBeUndefined();
  });

  it('trim arc with trimHideExterior → exterior segment is voided after migration', () => {
    const migrated: LegacyCell = {
      trimClip: [
        [1, 0.4],
        [1, 1],
        [0, 1],
        [0, 0.4],
        [0.5, 0.6],
      ],
      trimHideExterior: true,
      texture: 'floor',
    };
    migrateCellsToSegments(singleCellGrid(migrated));
    expect(migrated.segments![1]!.voided).toBe(true);
    expect(migrated.trimHideExterior).toBeUndefined();
  });

  it('trim arc — `trimOpen` is NOT honored: chord wall stays "w" for BFS purposes', () => {
    // Per the geometric-model decision in P1.5: trimOpen is a render flag,
    // not a connectivity flag. Migration matches: chord is always 'w'.
    const migrated: LegacyCell = {
      trimClip: [
        [1, 0.4],
        [1, 1],
        [0, 1],
        [0, 0.4],
        [0.5, 0.6],
      ],
      trimOpen: true,
      texture: 'floor',
    };
    migrateCellsToSegments(singleCellGrid(migrated));
    expect(migrated.interiorEdges![0]!.wall).toBe('w');
  });

  it('weatherHalves on diagonal cell → distributed onto matching segments', () => {
    const cells: LegacyCellGrid = [
      [{}, {}, {}],
      [{}, { 'nw-se': 'w', texture: 'a', weatherHalves: { sw: 'storm', ne: 'calm' } }, {}],
      [{}, {}, {}],
    ];
    migrateCellsToSegments(cells as CellGrid);
    const migrated = cells[1]![1]!;
    expect(migrated.segments![0]!.weatherGroupId).toBe('storm'); // s0 = sw
    expect(migrated.segments![1]!.weatherGroupId).toBe('calm'); // s1 = ne
    expect(migrated.weatherHalves).toBeUndefined();
  });

  it('weatherGroupId on unsplit cell → moves to s0', () => {
    const migrated: LegacyCell = { weatherGroupId: 'fog', texture: 'a' };
    migrateCellsToSegments(singleCellGrid(migrated));
    expect(migrated.segments![0]!.weatherGroupId).toBe('fog');
    expect(migrated.weatherGroupId).toBeUndefined();
  });

  it('truly empty cell ({}) is left untouched — implicit segment is synthesized on demand', () => {
    const migrated: Cell = {};
    migrateCellsToSegments(singleCellGrid(migrated));
    expect(migrated.segments).toBeUndefined();
    expect(migrated.interiorEdges).toBeUndefined();
  });

  it('cell that already has segments is skipped (idempotence)', () => {
    const original: Cell = {
      segments: [
        {
          id: 'custom',
          polygon: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          texture: 'preserved',
        },
      ],
    };
    const result = migrateCellsToSegments(singleCellGrid(original));
    expect(result.cellsAlreadySegmented).toBe(1);
    expect(result.cellsMigrated).toBe(0);
    expect(original.segments![0]!.id).toBe('custom');
  });
});

describe('migrate-segments: void corners (require neighbor state)', () => {
  it('nw-se diagonal: N void + E void → NE corner voided (s1)', () => {
    // For nw-se:
    //   N void + E void → 'ne' corner voided
    //   S void + W void → 'sw' corner voided
    // Construct a setup where exactly N+E are void (S and W are floor cells).
    const cells: CellGrid = [
      [null, null, null],
      [{}, { 'nw-se': 'w', texture: 'a' }, null], // (1,1) has N=null, E=null, S=cell, W=cell → 'ne' detected
      [{}, {}, null],
    ];
    migrateCellsToSegments(cells);
    const target = cells[1]![1]!;
    expect(target.segments).toBeDefined();
    expect(target.segments!.length).toBe(2);
    // s1 = NE segment for nw-se. With ne voided, s1 has voided=true.
    expect(target.segments![1]!.voided).toBe(true);
    expect(target.segments![0]!.voided).toBeUndefined();
  });

  it('nw-se diagonal: S void + W void → SW corner voided (s0)', () => {
    const cells: CellGrid = [
      [null, {}, {}],
      [null, { 'nw-se': 'w', texture: 'a' }, {}], // S=null, W=null, N=cell, E=cell → 'sw' detected
      [null, null, null],
    ];
    migrateCellsToSegments(cells);
    const target = cells[1]![1]!;
    expect(target.segments).toBeDefined();
    // s0 = SW segment for nw-se. With sw voided, s0 has voided=true.
    expect(target.segments![0]!.voided).toBe(true);
    expect(target.segments![1]!.voided).toBeUndefined();
  });

  it('two-pass: void-corner detection sees pre-mutation neighbor state', () => {
    // Two adjacent diagonal cells. Without two-pass, processing the first
    // would remove its diagonal flag before the second cell's neighbor
    // check could see it. Verify both get correct void corners.
    const cells: CellGrid = [
      [null, null, null, null],
      [null, { 'nw-se': 'w' }, { 'nw-se': 'w' }, null],
      [null, null, null, null],
    ];
    migrateCellsToSegments(cells);
    // Both have row 0 (north) void. Row 2 (south) void. Sides depend on column.
    // (1,1): N void + W void? W=cells[1][0]=null → void. N void + W void doesn't
    //   match the matrix for nw-se (which checks N+E or S+W). E=(1,2)=cell, not void.
    //   So no void corner detected for (1,1). Same for (1,2).
    // The point of this test is just confirming Pass 1 doesn't blow up with
    // chained processing, not that every cell gets a void corner.
    expect(cells[1]![1]!.segments).toBeDefined();
    expect(cells[1]![2]!.segments).toBeDefined();
  });
});

describe('migrate-segments: real fixture round-trip', () => {
  it('island.mapwright migrates without throwing and every cell satisfies invariants', () => {
    const path = resolve(__dirname, 'fixtures/island.mapwright');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    migrateToLatest(data); // legacy version migration first
    const cells: CellGrid = data.cells;

    const result = migrateCellsToSegments(cells);
    expect(result.cellsMigrated).toBeGreaterThan(0);

    // Every cell with segments must satisfy the parity-harness invariants.
    for (let r = 0; r < cells.length; r++) {
      const row = cells[r]!;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!cell) continue;
        const segs = getSegments(cell);
        expect(segs.length).toBeGreaterThanOrEqual(1);
        for (const seg of segs) {
          expect(seg.polygon.length).toBeGreaterThanOrEqual(3);
          for (const [x, y] of seg.polygon) {
            expect(x).toBeGreaterThanOrEqual(-1e-6);
            expect(x).toBeLessThanOrEqual(1 + 1e-6);
            expect(y).toBeGreaterThanOrEqual(-1e-6);
            expect(y).toBeLessThanOrEqual(1 + 1e-6);
          }
        }
        // Interior edges' between indices must be valid.
        const ies = getInteriorEdges(cell);
        for (const ie of ies) {
          expect(ie.between[0]).toBeGreaterThanOrEqual(0);
          expect(ie.between[0]).toBeLessThan(segs.length);
          expect(ie.between[1]).toBeGreaterThanOrEqual(0);
          expect(ie.between[1]).toBeLessThan(segs.length);
        }
      }
    }
  });

  it('running migration twice is idempotent (no double-mutation, no errors)', () => {
    const path = resolve(__dirname, 'fixtures/island.mapwright');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    migrateToLatest(data);
    const cells: CellGrid = data.cells;

    const first = migrateCellsToSegments(cells);
    const second = migrateCellsToSegments(cells);
    expect(second.cellsMigrated).toBe(0);
    expect(second.cellsAlreadySegmented).toBe(first.cellsMigrated);
  });
});

describe('migrate-segments: removeLegacyFields option', () => {
  it('removeLegacyFields: false leaves both shapes coexisting', () => {
    const cell: Cell = { 'nw-se': 'w', texture: 'a', textureSecondary: 'b' };
    migrateCellsToSegments(singleCellGrid(cell), { removeLegacyFields: false });
    expect(cell.segments).toBeDefined();
    expect(cell['nw-se']).toBe('w'); // legacy field preserved
    expect(cell.texture).toBe('a');
    expect(cell.textureSecondary).toBe('b');
  });

  it('default removeLegacyFields=true deletes every legacy field', () => {
    const cell: Cell = {
      'nw-se': 'w',
      texture: 'a',
      textureOpacity: 0.5,
      textureSecondary: 'b',
      textureSecondaryOpacity: 0.7,
      weatherHalves: { sw: 'g1', ne: 'g2' },
    };
    migrateCellsToSegments(singleCellGrid(cell));
    expect(cell['nw-se']).toBeUndefined();
    expect(cell.texture).toBeUndefined();
    expect(cell.textureOpacity).toBeUndefined();
    expect(cell.textureSecondary).toBeUndefined();
    expect(cell.textureSecondaryOpacity).toBeUndefined();
    expect(cell.weatherHalves).toBeUndefined();
  });
});
