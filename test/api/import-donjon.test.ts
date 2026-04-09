import { describe, it, expect } from 'vitest';
import { convertDonjonDungeon } from '../../src/editor/js/import-donjon.js';

// ---------------------------------------------------------------------------
// Helpers: minimal Donjon data builders
// ---------------------------------------------------------------------------

/** Standard Donjon cell_bit flags. */
const BITS = {
  room: 2,
  corridor: 4,
  perimeter: 16,
  aperture: 32,
  arch: 65536,
  door: 131072,
  locked: 262144,
  trapped: 524288,
  secret: 1048576,
  portcullis: 2097152,
  stair_down: 4194304,
  stair_up: 8388608,
  room_id: 65472,
  label: 4278190080,
};

/** Encode a room_id into the cell_bit room_id field (bits 6-15). */
function roomId(id: number): number { return (id << 6) & BITS.room_id; }

/**
 * Build a minimal Donjon export with a single rectangular room.
 * The room occupies rows [r1..r2], cols [c1..c2] in a grid of size rows x cols.
 */
function singleRoomDonjon(
  gridRows: number,
  gridCols: number,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
) {
  const cells: number[][] = [];
  for (let r = 0; r < gridRows; r++) {
    const row: number[] = [];
    for (let c = 0; c < gridCols; c++) {
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) {
        row.push(BITS.room | roomId(1));
      } else {
        row.push(0);
      }
    }
    cells.push(row);
  }
  return {
    cell_bit: BITS,
    cells,
    rooms: [{ id: '1', north: r1, south: r2, east: c2, west: c1 }],
    stairs: [],
    settings: { name: 'Test Dungeon' },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Grid dimensions
// ═══════════════════════════════════════════════════════════════════════════

describe('convertDonjonDungeon - grid dimensions', () => {
  it('produces a cell grid at 2x resolution', () => {
    const data = singleRoomDonjon(5, 5, 1, 1, 3, 3);
    const result = convertDonjonDungeon(data);

    // 5 original rows × 2 = 10, 5 original cols × 2 = 10
    expect(result.cells.length).toBe(10);
    expect(result.cells[0].length).toBe(10);
  });

  it('stores formatVersion 4 and resolution 2 in metadata', () => {
    const data = singleRoomDonjon(4, 4, 1, 1, 2, 2);
    const result = convertDonjonDungeon(data);

    expect(result.metadata.formatVersion).toBe(4);
    expect(result.metadata.resolution).toBe(2);
  });

  it('sets gridSize to 2.5 (5 / resolution)', () => {
    const data = singleRoomDonjon(4, 4, 1, 1, 2, 2);
    const result = convertDonjonDungeon(data);

    expect(result.metadata.gridSize).toBe(2.5);
  });

  it('preserves the dungeon name from settings', () => {
    const data = singleRoomDonjon(4, 4, 1, 1, 2, 2);
    data.settings = { name: 'Cavern of Doom' };
    const result = convertDonjonDungeon(data);

    expect(result.metadata.dungeonName).toBe('Cavern of Doom');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Floor cells and walls
// ═══════════════════════════════════════════════════════════════════════════

describe('convertDonjonDungeon - walls', () => {
  it('creates floor cells for room-flagged Donjon cells', () => {
    const data = singleRoomDonjon(5, 5, 2, 2, 2, 2);
    const result = convertDonjonDungeon(data);

    // Original cell (2,2) → subcells (4,4), (4,5), (5,4), (5,5)
    expect(result.cells[4][4]).not.toBeNull();
    expect(result.cells[4][5]).not.toBeNull();
    expect(result.cells[5][4]).not.toBeNull();
    expect(result.cells[5][5]).not.toBeNull();
  });

  it('leaves void cells as null', () => {
    const data = singleRoomDonjon(5, 5, 2, 2, 2, 2);
    const result = convertDonjonDungeon(data);

    // Cell (0,0) is void → subcells (0,0)–(1,1) should all be null
    expect(result.cells[0][0]).toBeNull();
    expect(result.cells[0][1]).toBeNull();
    expect(result.cells[1][0]).toBeNull();
    expect(result.cells[1][1]).toBeNull();
  });

  it('places walls on room boundaries facing void', () => {
    // 3×3 grid, single room cell at (1,1)
    const data = singleRoomDonjon(3, 3, 1, 1, 1, 1);
    const result = convertDonjonDungeon(data);

    // Subcell (2,2) is top-left of the room's 2×2 block
    const tl = result.cells[2][2];
    expect(tl).not.toBeNull();
    expect(tl.north).toBe('w');
    expect(tl.west).toBe('w');
  });

  it('does NOT place walls between adjacent room cells', () => {
    // 4×4 grid, room spanning (1,1)–(1,2)
    const data = singleRoomDonjon(4, 4, 1, 1, 1, 2);
    const result = convertDonjonDungeon(data);

    // Right edge of first room block at (1,1) → subcell (2,3)
    // Left edge of second room block at (1,2) → subcell (2,4)
    // These should NOT have walls between them
    expect(result.cells[2][3]?.east).toBeUndefined();
    expect(result.cells[2][4]?.west).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Doors
// ═══════════════════════════════════════════════════════════════════════════

describe('convertDonjonDungeon - doors', () => {
  it('places door markers between room and door cells', () => {
    // 5×5 grid: room at (1,1)–(2,2), door at (1,3) connecting room to corridor at (1,4)
    const cells: number[][] = [];
    for (let r = 0; r < 5; r++) {
      const row: number[] = [];
      for (let c = 0; c < 5; c++) {
        if (r >= 1 && r <= 2 && c >= 1 && c <= 2) {
          row.push(BITS.room | roomId(1));
        } else if (r === 1 && c === 3) {
          row.push(BITS.door | BITS.perimeter);
        } else if (r === 1 && c === 4) {
          row.push(BITS.corridor);
        } else {
          row.push(0);
        }
      }
      cells.push(row);
    }

    const data = {
      cell_bit: BITS,
      cells,
      rooms: [{ id: '1', north: 1, south: 2, east: 2, west: 1 }],
      stairs: [],
    };

    const result = convertDonjonDungeon(data);

    // Door placement: the door cell (1,3) faces west toward room cell (1,2).
    // At 2x resolution, the room's east edge subcells (2,5) and (3,5) get 'd'.
    expect(result.cells[2][5]?.east).toBe('d');
    expect(result.cells[3][5]?.east).toBe('d');
  });

  it('places secret door markers for secret-flagged cells', () => {
    // Room at (1,1), secret door at (1,2) facing the room
    const cells: number[][] = [];
    for (let r = 0; r < 4; r++) {
      const row: number[] = [];
      for (let c = 0; c < 4; c++) {
        if (r === 1 && c === 1) {
          row.push(BITS.room | roomId(1));
        } else if (r === 1 && c === 2) {
          row.push(BITS.secret | BITS.perimeter);
        } else {
          row.push(0);
        }
      }
      cells.push(row);
    }

    const data = {
      cell_bit: BITS,
      cells,
      rooms: [{ id: '1', north: 1, south: 1, east: 1, west: 1 }],
      stairs: [],
    };

    const result = convertDonjonDungeon(data);

    // Secret door: room cell (1,1) east edge subcells (2,3) and (3,3) get 's'.
    expect(result.cells[2][3]?.east).toBe('s');
    expect(result.cells[3][3]?.east).toBe('s');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Corridors
// ═══════════════════════════════════════════════════════════════════════════

describe('convertDonjonDungeon - corridors', () => {
  it('creates floor cells for corridor-flagged Donjon cells', () => {
    const cells: number[][] = [
      [0, 0, 0],
      [0, BITS.corridor, 0],
      [0, 0, 0],
    ];
    const data = { cell_bit: BITS, cells, rooms: [], stairs: [] };
    const result = convertDonjonDungeon(data);

    // Corridor at (1,1) → subcells (2,2), (2,3), (3,2), (3,3)
    expect(result.cells[2][2]).not.toBeNull();
    expect(result.cells[2][3]).not.toBeNull();
    expect(result.cells[3][2]).not.toBeNull();
    expect(result.cells[3][3]).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stairs
// ═══════════════════════════════════════════════════════════════════════════

describe('convertDonjonDungeon - stairs', () => {
  it('creates stair entries for stair data', () => {
    // Room at (1,1)–(1,2), stair at (1,1) going north
    const cells: number[][] = [
      [0, BITS.corridor, 0],
      [0, BITS.room | roomId(1), BITS.room | roomId(1)],
      [0, 0, 0],
    ];
    const data = {
      cell_bit: BITS,
      cells,
      rooms: [{ id: '1', north: 1, south: 1, east: 2, west: 1 }],
      stairs: [{ row: 1, col: 1, dir: 'north' }],
    };
    const result = convertDonjonDungeon(data);

    expect(result.metadata.stairs.length).toBe(1);
    expect(result.metadata.stairs[0].points).toBeDefined();
    expect(result.metadata.stairs[0].points.length).toBe(3); // triangle
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Room labels
// ═══════════════════════════════════════════════════════════════════════════

describe('convertDonjonDungeon - room labels', () => {
  it('places room labels at the center of each room', () => {
    const data = singleRoomDonjon(5, 5, 1, 1, 3, 3);
    const result = convertDonjonDungeon(data);

    // Room center: floor((1+3)/2) = 2, floor((1+3)/2) = 2 → original (2,2)
    // Subcell (4,4) should have a label
    const cell = result.cells[4][4];
    expect(cell).not.toBeNull();
    expect(cell.center?.label).toBe('A1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Empty / malformed input
// ═══════════════════════════════════════════════════════════════════════════

describe('convertDonjonDungeon - empty / edge cases', () => {
  it('handles a grid with no rooms or corridors', () => {
    const data = {
      cell_bit: BITS,
      cells: [[0, 0], [0, 0]],
      rooms: [],
      stairs: [],
    };
    const result = convertDonjonDungeon(data);

    expect(result.cells.length).toBe(4); // 2 × 2
    expect(result.cells[0].length).toBe(4);
    // All cells should be null (void)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        expect(result.cells[r][c]).toBeNull();
      }
    }
  });

  it('handles missing stairs array gracefully', () => {
    const data = {
      cell_bit: BITS,
      cells: [[BITS.room | roomId(1)]],
      rooms: [{ id: '1', north: 0, south: 0, east: 0, west: 0 }],
      stairs: undefined as unknown as [],
    };
    // Should not throw
    const result = convertDonjonDungeon(data);
    expect(result.metadata.stairs).toEqual([]);
  });

  it('handles missing rooms array gracefully', () => {
    const data = {
      cell_bit: BITS,
      cells: [[BITS.corridor]],
      rooms: undefined as unknown as [],
      stairs: [],
    };
    const result = convertDonjonDungeon(data);
    expect(result.cells.length).toBe(2);
  });

  it('defaults dungeon name when settings.name is absent', () => {
    const data = {
      cell_bit: BITS,
      cells: [[0]],
      rooms: [],
      stairs: [],
    };
    const result = convertDonjonDungeon(data);
    expect(result.metadata.dungeonName).toBe('Imported Dungeon');
  });
});
