import { describe, it, expect } from 'vitest';
import { buildPlayerCells } from '../src/player/fog.js';
import { cellKey } from '../src/util/grid.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal dungeon with the given cell grid. */
function makeDungeon(cells: (Record<string, unknown> | null)[][]) {
  return { cells, metadata: { gridSize: 5 } };
}

/** Create a 3x3 grid of empty floor cells. */
function make3x3() {
  const cells: (Record<string, unknown> | null)[][] = [];
  for (let r = 0; r < 3; r++) {
    const row: (Record<string, unknown> | null)[] = [];
    for (let c = 0; c < 3; c++) row.push({});
    cells.push(row);
  }
  return cells;
}

/** Reveal specific [r,c] pairs. */
function revealSet(...pairs: [number, number][]) {
  return new Set(pairs.map(([r, c]) => cellKey(r, c)));
}

/** Reveal all cells in a grid. */
function revealAll(rows: number, cols: number) {
  const set = new Set<string>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) set.add(cellKey(r, c));
  }
  return set;
}

// ═══════════════════════════════════════════════════════════════════════════
// Invisible wall stripping
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPlayerCells - invisible wall stripping', () => {
  it('strips iw (invisible wall) edges from output', () => {
    const cells = make3x3();
    cells[1][1] = { north: 'iw', south: 'w', east: 'iw', west: 'd' };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[1][1] as Record<string, unknown>;
    expect(pc).not.toBeNull();
    expect(pc.north).toBeUndefined(); // iw stripped
    expect(pc.east).toBeUndefined();  // iw stripped
    expect(pc.south).toBe('w');       // regular wall preserved
    expect(pc.west).toBe('d');        // door preserved
  });

  it('strips id (invisible door) edges from output', () => {
    const cells = make3x3();
    cells[1][1] = { north: 'id', south: 'id', east: 'w', west: 's' };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[1][1] as Record<string, unknown>;
    expect(pc.north).toBeUndefined(); // id stripped
    expect(pc.south).toBeUndefined(); // id stripped
    expect(pc.east).toBe('w');        // regular wall preserved
    // Secret door: hidden as wall (not opened)
    expect(pc.west).toBe('w');
  });

  it('strips iw and id on diagonal edges too', () => {
    const cells = make3x3();
    cells[1][1] = { 'nw-se': 'iw', 'ne-sw': 'id' };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[1][1] as Record<string, unknown>;
    expect(pc['nw-se']).toBeUndefined();
    expect(pc['ne-sw']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regular edge preservation
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPlayerCells - regular edge preservation', () => {
  it('preserves w (wall) edges', () => {
    const cells = make3x3();
    cells[0][0] = { north: 'w', south: 'w', east: 'w', west: 'w' };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[0][0] as Record<string, unknown>;
    expect(pc.north).toBe('w');
    expect(pc.south).toBe('w');
    expect(pc.east).toBe('w');
    expect(pc.west).toBe('w');
  });

  it('preserves d (door) edges', () => {
    const cells = make3x3();
    cells[1][1] = { north: 'd', east: 'd' };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[1][1] as Record<string, unknown>;
    expect(pc.north).toBe('d');
    expect(pc.east).toBe('d');
  });

  it('converts s (secret door) to w when not opened', () => {
    const cells = make3x3();
    cells[1][1] = { north: 's', east: 's' };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[1][1] as Record<string, unknown>;
    expect(pc.north).toBe('w');
    expect(pc.east).toBe('w');
  });

  it('converts opened s (secret door) to d', () => {
    const cells = make3x3();
    cells[1][1] = { north: 's', east: 's' };
    const revealed = revealAll(3, 3);
    const openedDoors = [{ row: 1, col: 1, dir: 'north' }];
    const result = buildPlayerCells(makeDungeon(cells), revealed, openedDoors);

    const pc = result[1][1] as Record<string, unknown>;
    expect(pc.north).toBe('d');  // opened → shown as door
    expect(pc.east).toBe('w');   // not opened → still hidden as wall
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Null cell handling
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPlayerCells - null cell handling', () => {
  it('returns null for null cells even when revealed', () => {
    const cells: (Record<string, unknown> | null)[][] = [
      [null, {}, null],
      [{},   null, {}],
      [null, {}, null],
    ];
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    expect(result[0][0]).toBeNull();
    expect(result[1][1]).toBeNull();
    expect(result[2][0]).toBeNull();
    expect(result[0][1]).not.toBeNull();
  });

  it('returns null for unrevealed non-null cells', () => {
    const cells = make3x3();
    const revealed = new Set<string>(); // nothing revealed
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(result[r][c]).toBeNull();
      }
    }
  });

  it('has correct output dimensions matching input', () => {
    const cells = make3x3();
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    expect(result.length).toBe(3);
    expect(result[0].length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deep copy guarantee
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPlayerCells - deep copy', () => {
  it('mutations to output do not affect original dungeon cells', () => {
    const cells = make3x3();
    cells[1][1] = { north: 'w', east: 'd', center: { label: 'A1' } };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    // Mutate the output
    const pc = result[1][1] as Record<string, unknown>;
    pc.north = 'MUTATED';
    pc.south = 'ADDED';

    // Original should be unchanged
    expect((cells[1][1] as Record<string, unknown>).north).toBe('w');
    expect((cells[1][1] as Record<string, unknown>).south).toBeUndefined();
  });

  it('mutations to output center do not affect original', () => {
    const cells = make3x3();
    cells[0][0] = { center: { 'stair-id': 5 } };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    // Mutate the output's center
    const pc = result[0][0] as Record<string, unknown>;
    const center = pc.center as Record<string, unknown>;
    center['stair-id'] = 999;

    // Original should be unchanged
    expect((cells[0][0] as Record<string, unknown>).center).toEqual({ 'stair-id': 5 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Label stripping
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPlayerCells - label stripping', () => {
  it('strips room labels from revealed cells', () => {
    const cells = make3x3();
    cells[1][1] = { center: { label: 'A1', 'stair-id': 3 } };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[1][1] as Record<string, unknown>;
    const center = pc.center as Record<string, unknown>;
    expect(center.label).toBeUndefined();
    // stair-id should be preserved
    expect(center['stair-id']).toBe(3);
  });

  it('strips dmLabel from revealed cells', () => {
    const cells = make3x3();
    cells[0][0] = { center: { dmLabel: 'DM note', 'stair-id': 1 } };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[0][0] as Record<string, unknown>;
    const center = pc.center as Record<string, unknown>;
    expect(center.dmLabel).toBeUndefined();
    expect(center['stair-id']).toBe(1);
  });

  it('removes empty center object after stripping label', () => {
    const cells = make3x3();
    cells[0][0] = { center: { label: 'B2' } };
    const revealed = revealAll(3, 3);
    const result = buildPlayerCells(makeDungeon(cells), revealed, []);

    const pc = result[0][0] as Record<string, unknown>;
    expect(pc.center).toBeUndefined();
  });
});
