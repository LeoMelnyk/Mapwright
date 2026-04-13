import { describe, it, expect } from 'vitest';
import { convertOnePageDungeon } from '../../src/editor/js/import-opd.js';

// ---------------------------------------------------------------------------
// Helpers: minimal OPD data builders
// ---------------------------------------------------------------------------

/** Build a minimal OPD with a single rect (room). */
function singleRectOpd(x: number, y: number, w: number, h: number, title = 'Test OPD') {
  return {
    rects: [{ x, y, w, h }],
    doors: [],
    notes: [],
    columns: [],
    water: [],
    title,
  };
}

/** Build OPD with two adjacent rooms and a door between them. */
function twoRoomsWithDoor(doorType = 1) {
  return {
    rects: [
      { x: 0, y: 0, w: 3, h: 3 },  // left room
      { x: 4, y: 0, w: 3, h: 3 },  // right room
      { x: 3, y: 1, w: 1, h: 1 },  // door cell connecting them
    ],
    doors: [
      { x: 3, y: 1, dir: { x: 1, y: 0 }, type: doorType },
    ],
    notes: [],
    columns: [],
    water: [],
    title: 'Two Rooms',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Grid dimensions
// ═══════════════════════════════════════════════════════════════════════════

describe('convertOnePageDungeon - grid dimensions', () => {
  it('produces a cell grid at 2x resolution with 1-cell padding', () => {
    // Rect at (0,0) w=2 h=2 → OPD bbox: [-1, -1] to [2, 2] with padding
    // That's 4 cols × 4 rows at original → 8×8 at 2x
    const opd = singleRectOpd(0, 0, 2, 2);
    const result = convertOnePageDungeon(opd);

    // opdCols = (maxX+1) - (minX-1) + 1 = 2 - (-1) + 1 = 4; rows similarly
    expect(result.cells.length).toBe(8);  // 4 × 2
    expect(result.cells[0].length).toBe(8);
  });

  it('stores formatVersion 4 and resolution 2', () => {
    const opd = singleRectOpd(0, 0, 1, 1);
    const result = convertOnePageDungeon(opd);

    expect(result.metadata.formatVersion).toBe(4);
    expect(result.metadata.resolution).toBe(2);
  });

  it('sets gridSize to 2.5', () => {
    const opd = singleRectOpd(0, 0, 1, 1);
    const result = convertOnePageDungeon(opd);

    expect(result.metadata.gridSize).toBe(2.5);
  });

  it('preserves the dungeon title', () => {
    const opd = singleRectOpd(0, 0, 1, 1, 'Crypt of the Spider Queen');
    const result = convertOnePageDungeon(opd);

    expect(result.metadata.dungeonName).toBe('Crypt of the Spider Queen');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Floor cells and walls
// ═══════════════════════════════════════════════════════════════════════════

describe('convertOnePageDungeon - floors and walls', () => {
  it('creates floor cells for all rect cells (2x2 subcells each)', () => {
    const opd = singleRectOpd(0, 0, 2, 2);
    const result = convertOnePageDungeon(opd);

    // Rect occupies OPD (0,0) and (0,1) and (1,0) and (1,1)
    // With 1-cell padding, minX=-1, minY=-1
    // toRow(0) = (0-(-1))*2 = 2, toCol(0) = 2
    // So cell (2,2) should be a floor cell
    expect(result.cells[2][2]).not.toBeNull();
    expect(result.cells[3][3]).not.toBeNull();
  });

  it('leaves padded border cells as void (null)', () => {
    const opd = singleRectOpd(0, 0, 1, 1);
    const result = convertOnePageDungeon(opd);

    // Top-left subcells (0,0)–(1,1) are in the padding zone → void
    expect(result.cells[0][0]).toBeNull();
    expect(result.cells[0][1]).toBeNull();
    expect(result.cells[1][0]).toBeNull();
    expect(result.cells[1][1]).toBeNull();
  });

  it('places walls on floor cells adjacent to void', () => {
    const opd = singleRectOpd(0, 0, 1, 1);
    const result = convertOnePageDungeon(opd);

    // The single rect cell maps to subcells at offset (2,2) through (3,3).
    // Top-left subcell (2,2) should have north and west walls (facing void).
    const tl = result.cells[2][2];
    expect(tl).not.toBeNull();
    expect(tl.north).toBe('w');
    expect(tl.west).toBe('w');

    // Bottom-right subcell (3,3) should have south and east walls.
    const br = result.cells[3][3];
    expect(br).not.toBeNull();
    expect(br.south).toBe('w');
    expect(br.east).toBe('w');
  });

  it('does NOT place walls between adjacent floor subcells', () => {
    // 2x1 room → 4 subcells wide, 2 subcells tall
    const opd = singleRectOpd(0, 0, 2, 1);
    const result = convertOnePageDungeon(opd);

    // toRow(0) = 2, toCol(0) = 2, toCol(1) = 4
    // Internal boundary between subcell (2,3) and (2,4) should have no walls
    expect(result.cells[2][3]?.east).toBeUndefined();
    expect(result.cells[2][4]?.west).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Doors
// ═══════════════════════════════════════════════════════════════════════════

describe('convertOnePageDungeon - doors', () => {
  it('places door markers (type=1) between rooms', () => {
    const opd = twoRoomsWithDoor(1);
    const result = convertOnePageDungeon(opd);

    // Door at OPD (3,1) dir=(1,0) — east-facing
    // With padding: toRow(1)=(1-(-1))*2=4, toCol(3)=(3-(-1))*2=8
    // Door is placed on the east edge of the block at (4,8)
    // setEdge 'east' on block (r,c) sets cells[r][c+1].east and cells[r+1][c+1].east
    const doorCell = result.cells[4][9]; // c+1 = 9
    expect(doorCell).not.toBeNull();
    // The door is either on this cell or its neighbor. Check for 'd' edge.
    const hasDoor = ['north', 'south', 'east', 'west'].some(
      dir => doorCell?.[dir] === 'd'
    );
    // The centered door path may place 'd' on internal subcell boundaries instead.
    // Check the broader 2x2 block for any door marker.
    let foundDoor = false;
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        const cell = result.cells[4 + dr]?.[8 + dc];
        if (cell) {
          for (const dir of ['north', 'south', 'east', 'west']) {
            if (cell[dir] === 'd') foundDoor = true;
          }
        }
      }
    }
    expect(foundDoor).toBe(true);
  });

  it('places secret door markers (type=6)', () => {
    const opd = twoRoomsWithDoor(6);
    const result = convertOnePageDungeon(opd);

    // Search for 's' markers in the door cell's 2x2 block
    // toRow(1) = 4, toCol(3) = 8
    let foundSecret = false;
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        const cell = result.cells[4 + dr]?.[8 + dc];
        if (cell) {
          for (const dir of ['north', 'south', 'east', 'west']) {
            if (cell[dir] === 's') foundSecret = true;
          }
        }
      }
    }
    expect(foundSecret).toBe(true);
  });

  it('skips open passages (type=0) — no door markers placed', () => {
    const opd = twoRoomsWithDoor(0); // open connection
    const result = convertOnePageDungeon(opd);

    // Door cell block should not have 'd' or 's'
    // toRow(1) = 4, toCol(3) = 8
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        const cell = result.cells[4 + dr]?.[8 + dc];
        if (cell) {
          for (const dir of ['north', 'south', 'east', 'west']) {
            expect(cell[dir]).not.toBe('d');
            expect(cell[dir]).not.toBe('s');
          }
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stairs
// ═══════════════════════════════════════════════════════════════════════════

describe('convertOnePageDungeon - stairs', () => {
  it('creates stair entries for stair-type doors (type=3)', () => {
    const opd = {
      rects: [
        { x: 0, y: 0, w: 3, h: 3 },
        { x: 3, y: 1, w: 1, h: 1 }, // passage cell with stair
      ],
      doors: [
        { x: 3, y: 1, dir: { x: -1, y: 0 }, type: 3 }, // stair going west into room
      ],
      notes: [],
    };
    const result = convertOnePageDungeon(opd);

    expect(result.metadata.stairs.length).toBe(1);
    expect(result.metadata.stairs[0].points).toBeDefined();
    expect(result.metadata.stairs[0].points.length).toBe(3); // triangle
    expect(result.metadata.stairs[0].link).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Notes → room labels
// ═══════════════════════════════════════════════════════════════════════════

describe('convertOnePageDungeon - notes/labels', () => {
  it('places room labels from notes', () => {
    const opd = {
      rects: [{ x: 0, y: 0, w: 3, h: 3 }],
      doors: [],
      notes: [{ pos: { x: 1, y: 1 }, text: 'Throne Room', ref: '1' }],
    };
    const result = convertOnePageDungeon(opd);

    // toRow(1) = (1 - (-1)) * 2 = 4, toCol(1) = 4
    const cell = result.cells[4]?.[4];
    expect(cell).not.toBeNull();
    expect(cell?.center?.label).toBe('A1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Water fills
// ═══════════════════════════════════════════════════════════════════════════

describe('convertOnePageDungeon - water', () => {
  it('marks water-filled subcells with fill and waterDepth', () => {
    const opd = {
      rects: [{ x: 0, y: 0, w: 3, h: 3 }],
      doors: [],
      notes: [],
      water: [{ x: 1, y: 1, w: 1, h: 1 }],
    };
    const result = convertOnePageDungeon(opd);

    // toRow(1) = 4, toCol(1) = 4
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        const cell = result.cells[4 + dr]?.[4 + dc];
        expect(cell).not.toBeNull();
        expect(cell?.fill).toBe('water');
        expect(cell?.waterDepth).toBe(1);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Columns → props
// ═══════════════════════════════════════════════════════════════════════════

describe('convertOnePageDungeon - columns', () => {
  it('creates pillar-corner props for column entries at open intersections', () => {
    // 3x3 room with a column at grid intersection (1,1)
    const opd = {
      rects: [{ x: 0, y: 0, w: 3, h: 3 }],
      doors: [],
      notes: [],
      columns: [{ x: 1, y: 1 }],
    };
    const result = convertOnePageDungeon(opd);

    // Column positions become pillar-corner props
    const pillars = result.metadata.props.filter((p: Record<string, unknown>) => p.type === 'pillar-corner');
    expect(pillars.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Empty / edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe('convertOnePageDungeon - empty / edge cases', () => {
  it('handles a single 1x1 room', () => {
    const opd = singleRectOpd(0, 0, 1, 1);
    const result = convertOnePageDungeon(opd);

    // Should produce a valid grid with at least one floor cell
    let floorCount = 0;
    for (let r = 0; r < result.cells.length; r++) {
      for (let c = 0; c < result.cells[0].length; c++) {
        if (result.cells[r][c] !== null) floorCount++;
      }
    }
    expect(floorCount).toBe(4); // 1 OPD cell = 2×2 subcells
  });

  it('handles missing doors array gracefully', () => {
    const opd = {
      rects: [{ x: 0, y: 0, w: 2, h: 2 }],
      doors: undefined as unknown as [],
      notes: [],
    };
    const result = convertOnePageDungeon(opd);
    expect(result.cells.length).toBeGreaterThan(0);
  });

  it('handles missing notes array gracefully', () => {
    const opd = {
      rects: [{ x: 0, y: 0, w: 2, h: 2 }],
      doors: [],
      notes: undefined as unknown as [],
    };
    const result = convertOnePageDungeon(opd);
    expect(result.cells.length).toBeGreaterThan(0);
  });

  it('defaults dungeon name when title is absent', () => {
    const opd = {
      rects: [{ x: 0, y: 0, w: 1, h: 1 }],
      doors: [],
      notes: [],
    };
    const result = convertOnePageDungeon(opd);
    expect(result.metadata.dungeonName).toBe('Imported Dungeon');
  });
});
