// Convert a Donjon random dungeon JSON export into our internal dungeon format.
// Donjon format: { cells (2D bitmask grid), rooms, stairs, settings, cell_bit, ... }
//
// Donjon cell bitmask flags (from cell_bit):
//   room=2, corridor=4, perimeter=16, aperture=32, arch=65536,
//   door=131072, locked=262144, trapped=524288, secret=1048576,
//   portcullis=2097152, stair_down=4194304, stair_up=8388608,
//   room_id=65472 (bits 6-15), label=4278190080 (bits 24-31)
//
// Outputs at resolution=2 (half-cell grid) and formatVersion=4 natively,
// bypassing the migration pipeline entirely.

import type { Bridge, CellGrid, Direction, EdgeValue, Light, Metadata, Stairs } from '../../types.js';
import { getEdge, deleteEdge, CARDINAL_OFFSETS } from '../../util/index.js';

/** Donjon JSON export shape. */
interface DonjonData {
  cell_bit: Record<string, number>;
  cells: number[][];
  rooms: { id: string; north: number; south: number; east: number; west: number; shape?: string; doors?: Record<string, { row: number; col: number }[]> }[];
  stairs: { row: number; col: number; dir: string; next_row?: number; next_col?: number }[];
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}
import { computeCircleCenter, computeArcCellData } from '../../util/trim-geometry.js';

const RES = 2;             // half-cell resolution: each Donjon cell → 2×2 subcells
const FORMAT_VERSION = 4;  // current format (half-cell + per-cell arcs)

// ── Subcell helpers ──────────────────────────────────────────────────────────

/** Set a wall/door on both subcells spanning one edge of a 2×2 block. */
function setEdge(cells: CellGrid, r: number, c: number, direction: string, value: EdgeValue) {
  switch (direction) {
    case 'north':
      if (cells[r]?.[c])     cells[r][c].north     = value;
      if (cells[r]?.[c + 1]) cells[r][c + 1]!.north = value;
      break;
    case 'south':
      if (cells[r + 1]?.[c])     cells[r + 1][c]!.south     = value;
      if (cells[r + 1]?.[c + 1]) cells[r + 1][c + 1]!.south = value;
      break;
    case 'west':
      if (cells[r]?.[c])     cells[r][c].west     = value;
      if (cells[r + 1]?.[c]) cells[r + 1][c]!.west = value;
      break;
    case 'east':
      if (cells[r]?.[c + 1])     cells[r][c + 1]!.east     = value;
      if (cells[r + 1]?.[c + 1]) cells[r + 1][c + 1]!.east = value;
      break;
  }
}

/** Remove a wall/door from both subcells spanning one edge of a 2×2 block. */
function clearEdge(cells: CellGrid, r: number, c: number, direction: string) {
  switch (direction) {
    case 'north':
      if (cells[r]?.[c])     delete cells[r][c].north;
      if (cells[r]?.[c + 1]) delete cells[r][c + 1]!.north;
      break;
    case 'south':
      if (cells[r + 1]?.[c])     delete cells[r + 1][c]!.south;
      if (cells[r + 1]?.[c + 1]) delete cells[r + 1][c + 1]!.south;
      break;
    case 'west':
      if (cells[r]?.[c])     delete cells[r][c].west;
      if (cells[r + 1]?.[c]) delete cells[r + 1][c]!.west;
      break;
    case 'east':
      if (cells[r]?.[c + 1])     delete cells[r][c + 1]!.east;
      if (cells[r + 1]?.[c + 1]) delete cells[r + 1][c + 1]!.east;
      break;
  }
}

/** Set a door at the internal subcell boundary (center of a 2×2 block). */
function setCenterDoor(cells: CellGrid, r: number, c: number, axis: string, value: EdgeValue) {
  if (axis === 'ns') {
    // Horizontal door at center: between TL/TR and BL/BR
    if (cells[r]?.[c])     cells[r][c].south     = value;
    if (cells[r]?.[c + 1]) cells[r][c + 1]!.south = value;
    if (cells[r + 1]?.[c])     cells[r + 1][c]!.north     = value;
    if (cells[r + 1]?.[c + 1]) cells[r + 1][c + 1]!.north = value;
  } else {
    // Vertical door at center: between TL/BL and TR/BR
    if (cells[r]?.[c])     cells[r][c].east     = value;
    if (cells[r]?.[c + 1]) cells[r][c + 1]!.west = value;
    if (cells[r + 1]?.[c])     cells[r + 1][c]!.east     = value;
    if (cells[r + 1]?.[c + 1]) cells[r + 1][c + 1]!.west = value;
  }
}

const OFFS = CARDINAL_OFFSETS;
const OPP  = { north: 'south', south: 'north', west: 'east', east: 'west' };

/** Clear cardinal walls on cell + reciprocals, preserving doors. */
function _clearWalls(cells: CellGrid, r: number, c: number, numRows: number, numCols: number) {
  const cell = cells[r]?.[c];
  if (!cell) return;
  for (const dir of ['north', 'south', 'east', 'west'] as const) {
    const edge = getEdge(cell, dir as Direction);
    if (edge && edge !== 'd' && edge !== 's') {
      deleteEdge(cell, dir as Direction);
      const [dr, dc] = OFFS[dir];
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < numRows && nc >= 0 && nc < numCols) {
        const nb = cells[nr]?.[nc];
        const oppDir = OPP[dir] as Direction;
        if (nb && getEdge(nb, oppDir) !== 'd' && getEdge(nb, oppDir) !== 's') deleteEdge(nb, oppDir);
      }
    }
  }
  deleteEdge(cell, 'nw-se');
  deleteEdge(cell, 'ne-sw');
}

/**
 * Convert a Donjon dungeon JSON object into our dungeon editor JSON.
 * Returns { metadata, cells } ready to assign to state.dungeon.
 */
export function convertDonjonDungeon(data: DonjonData): { metadata: Metadata; cells: CellGrid[][] } {
  const bits = data.cell_bit;
  const src = data.cells;
  const origRows = src.length;
  const origCols = src[0]?.length || 0;
  const rows = origRows * RES;
  const cols = origCols * RES;
  const gridSize = 5 / RES;  // 2.5 feet per subcell

  // Combine all "door-type" bits
  const DOOR_BITS = bits.door | bits.locked | bits.trapped | bits.secret | bits.portcullis;

  // ── 1. Create floor grid ────────────────────────────────────────────
  // Each Donjon floor cell (r,c) expands to a 2×2 block of subcells.
  // Door cells carry the corridor bit and must become floor so passages connect.
  const cells = [];
  for (let r = 0; r < rows; r++) {
    cells.push(new Array(cols).fill(null));
  }

  for (let r = 0; r < origRows; r++) {
    for (let c = 0; c < origCols; c++) {
      const v = src[r][c];
      if (v & (bits.room | bits.corridor)) {
        for (let dr = 0; dr < RES; dr++) {
          for (let dc = 0; dc < RES; dc++) {
            cells[r * RES + dr][c * RES + dc] = {};
          }
        }
      }
    }
  }

  // ── 2. Wall detection at floor/void boundaries ──────────────────────
  // For each original Donjon cell, check cardinal neighbors and place walls
  // on the appropriate subcell edges of the 2×2 block.
  for (let r = 0; r < origRows; r++) {
    for (let c = 0; c < origCols; c++) {
      const sr = r * RES, sc = c * RES;
      if (!cells[sr][sc]) continue;  // void cell

      if (r === 0          || !cells[(r - 1) * RES][c * RES]) setEdge(cells, sr, sc, 'north', 'w');
      if (r === origRows-1 || !cells[(r + 1) * RES][c * RES]) setEdge(cells, sr, sc, 'south', 'w');
      if (c === 0          || !cells[r * RES][(c - 1) * RES]) setEdge(cells, sr, sc, 'west',  'w');
      if (c === origCols-1 || !cells[r * RES][(c + 1) * RES]) setEdge(cells, sr, sc, 'east',  'w');
    }
  }

  // ── 3. Place doors ──────────────────────────────────────────────────
  // Door cells sit at perimeter positions between rooms/corridors.
  // The door marker goes on the shared edge between the door cell and
  // its room-flagged neighbor(s).
  const SELF_DIR = [
    { dr: -1, dc:  0, self: 'north', recip: 'south' },
    { dr:  1, dc:  0, self: 'south', recip: 'north' },
    { dr:  0, dc: -1, self: 'west',  recip: 'east'  },
    { dr:  0, dc:  1, self: 'east',  recip: 'west'  },
  ];

  for (let r = 0; r < origRows; r++) {
    for (let c = 0; c < origCols; c++) {
      const v = src[r][c];
      if (v & bits.arch) continue;  // arches are open passages, no door
      if (!(v & DOOR_BITS)) continue;

      const wallVal = (v & bits.secret) ? 's' : 'd';
      const sr = r * RES, sc = c * RES;

      for (const { dr, dc, self, recip } of SELF_DIR) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= origRows || nc < 0 || nc >= origCols) continue;
        if (!(src[nr][nc] & bits.room)) continue;  // only toward room cells
        setEdge(cells, sr, sc, self, wallVal);
        setEdge(cells, nr * RES, nc * RES, recip, wallVal);
      }
    }
  }

  // ── 3b. Archways: place archway props + invisible doors ─────────
  const props = [];
  let nextPropId = 1;

  for (let r = 0; r < origRows; r++) {
    for (let c = 0; c < origCols; c++) {
      const v = src[r][c];
      if (!(v & bits.arch)) continue;

      const sr = r * RES, sc = c * RES;
      if (!cells[sr]?.[sc]) continue;

      // Determine passage direction from room neighbors
      const hasRoomN = r > 0 && (src[r - 1][c] & bits.room);
      const hasRoomS = r < origRows - 1 && (src[r + 1][c] & bits.room);
      const hasRoomE = c < origCols - 1 && (src[r][c + 1] & bits.room);
      const hasRoomW = c > 0 && (src[r][c - 1] & bits.room);

      // Passage direction: N-S means archway spans E-W (rotation 0)
      //                    E-W means archway spans N-S (rotation 90)
      const vertical = hasRoomE || hasRoomW;
      const rotation = vertical ? 90 : 0;

      // Place archway prop at center of 2×2 block
      if (rotation === 0) {
        // Horizontal archway (1×2): center vertically in block
        props.push({
          id: `prop_${nextPropId++}`, type: 'archway',
          x: sc * gridSize, y: (sr + 0.5) * gridSize,
          rotation: 0, flipped: false,
        });
      } else {
        // Vertical archway (2×1): center horizontally in block
        props.push({
          id: `prop_${nextPropId++}`, type: 'archway',
          x: (sc + 0.5) * gridSize, y: sr * gridSize,
          rotation: 90, flipped: false,
        });
      }

      // Place invisible door at the center of the 2×2 block
      // N-S passage → horizontal door (ns axis), E-W → vertical (ew axis)
      const doorAxis = (hasRoomN || hasRoomS) ? 'ns' : 'ew';
      setCenterDoor(cells, sr, sc, doorAxis, 'id');
    }
  }

  // ── 4. Stairs ───────────────────────────────────────────────────────
  const stairs = [];
  let nextStairId = 0;

  const DIR_TO_VEC = {
    north: { x: 0, y: -1 }, south: { x: 0, y: 1 },
    east:  { x: 1, y:  0 }, west:  { x: -1, y: 0 },
  };
  const CARDINAL_RECIP = { north: 'south', south: 'north', east: 'west', west: 'east' };

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  for (const stair of (data.stairs || [])) {
    const r = stair.row;
    const c = stair.col;
    const dir = DIR_TO_VEC[stair.dir as keyof typeof DIR_TO_VEC];
    const sr = r * RES, sc = c * RES;
    if (!cells[sr]?.[sc]) continue;

    // Build triangle stair points at 2× scale (grid-corner coords × RES)
    let points;
    if (dir.y === -1) {
      // North: base = south edge, point = north midpoint
      points = [[sr + RES, sc], [sr + RES, sc + RES], [sr, sc + RES / 2]];
    } else if (dir.y === 1) {
      // South: base = north edge, point = south midpoint
      points = [[sr, sc + RES], [sr, sc], [sr + RES, sc + RES / 2]];
    } else if (dir.x === 1) {
      // East: base = west edge, point = east midpoint
      points = [[sr, sc], [sr + RES, sc], [sr + RES / 2, sc + RES]];
    } else if (dir.x === -1) {
      // West: base = east edge, point = west midpoint
      points = [[sr + RES, sc + RES], [sr, sc + RES], [sr + RES / 2, sc]];
    }

    if (points) {
      const id = nextStairId++;
      stairs.push({ id, points, link: null });
      cells[sr][sc].center ??= {};
      cells[sr][sc].center['stair-id'] = id;

      // Remove wall between stair cell and neighbor in stair direction
      const nr = r + (dir.y || 0);
      const nc = c + (dir.x || 0);
      clearEdge(cells, sr, sc, stair.dir);
      clearEdge(cells, nr * RES, nc * RES, CARDINAL_RECIP[stair.dir as keyof typeof CARDINAL_RECIP]);
    }
  }

  // ── 5. Room coordinate offset ───────────────────────────────────────
  // Donjon room metadata coords may be offset from the cell grid (some
  // exports pad the grid). Compute the offset from the first room.
  let roomOffR = 0, roomOffC = 0;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const firstRoom = ((data as Record<string, unknown>).rooms as Record<string, unknown>[] || []).find((r: unknown) => r);
  if (firstRoom) {
    const targetId = parseInt(firstRoom.id as string);
    outer:
    for (let r = 0; r < origRows; r++) {
      for (let c = 0; c < origCols; c++) {
        if (((src[r][c] & bits.room_id) >> 6) === targetId) {
          roomOffR = r - (firstRoom.north as number);
          roomOffC = c - (firstRoom.west as number);
          break outer;
        }
      }
    }
  }

  // ── 6. Room labels ────────────────────────────────────────────────
  const dungeonLetter = 'A';
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  for (const room of (data.rooms || [])) {
    const centerR = Math.floor((room.north + room.south) / 2) + roomOffR;
    const centerC = Math.floor((room.west  + room.east)  / 2) + roomOffC;
    const scr = centerR * RES, scc = centerC * RES;
    if (cells[scr]?.[scc]) {
      cells[scr][scc].center ??= {};
      cells[scr][scc].center.label = dungeonLetter + room.id;
    }
  }

  // ── 7. Room shape trims ─────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  for (const room of (data.rooms || [])) {
    if (room.shape !== 'circle' && room.shape !== 'polygon') continue;

    // Compute dimensions in original Donjon cell units
    const topR_orig   = room.north + roomOffR;
    const leftC_orig  = room.west  + roomOffC;
    const botR_orig   = room.south + roomOffR;
    const rightC_orig = room.east  + roomOffC;
    const minDim_orig = Math.min(rightC_orig - leftC_orig + 1, botR_orig - topR_orig + 1);

    // Convert room corners to subcell coordinates
    const topR   = topR_orig   * RES;
    const leftC  = leftC_orig  * RES;
    const botR   = botR_orig   * RES + (RES - 1);
    const rightC = rightC_orig * RES + (RES - 1);

    // ── Punch-through: corridor openings through trims ──────────────
    // Each door punches a corridor-width lane from the room edge inward
    // to the halfway mark, so passages blend through circle/polygon trims.
    const roomW_sub = rightC - leftC + 1;
    const roomH_sub = botR - topR + 1;
    const punchThrough = new Map();  // key → 'ew'|'ns' (punch axis)
    const punchDepth = Math.round(Math.min(roomW_sub, roomH_sub) / 2);

    for (const [dir, doorList] of Object.entries(room.doors ?? {})) {
      for (const door of doorList) {
        // For polygon rooms, skip doors at exact corner edges — those
        // corridors exit straight out, not through the diagonal trim.
        if (room.shape === 'polygon') {
          const axis2 = (dir === 'east' || dir === 'west') ? 'ew' : 'ns';
          if (axis2 === 'ew') {
            if (door.row === room.north || door.row === room.south) continue;
          } else {
            if (door.col === room.west || door.col === room.east) continue;
          }
        }

        const doorGridR = door.row + roomOffR;
        const doorGridC = door.col + roomOffC;
        const axis = (dir === 'east' || dir === 'west') ? 'ew' : 'ns';

        if (axis === 'ew') {
          const cFrom = dir === 'east' ? rightC : leftC;
          const cTo   = dir === 'east' ? rightC - punchDepth + 1 : leftC + punchDepth - 1;
          for (let dr = 0; dr < RES; dr++) {
            const r = doorGridR * RES + dr;
            const lo = Math.min(cFrom, cTo), hi = Math.max(cFrom, cTo);
            for (let c = lo; c <= hi; c++) punchThrough.set(`${r},${c}`, axis);
          }
        } else {
          const rFrom = dir === 'south' ? botR : topR;
          const rTo   = dir === 'south' ? botR - punchDepth + 1 : topR + punchDepth - 1;
          for (let dc = 0; dc < RES; dc++) {
            const c = doorGridC * RES + dc;
            const lo = Math.min(rFrom, rTo), hi = Math.max(rFrom, rTo);
            for (let r = lo; r <= hi; r++) punchThrough.set(`${r},${c}`, axis);
          }
        }
      }
    }

    if (room.shape === 'circle') {
      // ── True circle: per-cell arc trim ─────────────────────────────
      const R = Math.min(roomW_sub, roomH_sub) / 2;

      // ── Apply circle trim per quadrant ─────────────────────────────
      const arcCenters = {
        nw: { row: topR,     col: leftC     },
        ne: { row: topR,     col: rightC + 1 },
        sw: { row: botR + 1, col: leftC     },
        se: { row: botR + 1, col: rightC + 1 },
      };

      for (const cn of ['nw', 'ne', 'sw', 'se']) {
        const ac = arcCenters[cn as keyof typeof arcCenters];
        const { cx, cy } = computeCircleCenter(ac.row, ac.col, R, cn as 'nw' | 'ne' | 'sw' | 'se', false);

        let rStart = 0, rEnd = 0, cStart = 0, cEnd = 0;
        switch (cn) {
          case 'nw': rStart = topR;       rEnd = topR+R-1;     cStart = leftC;        cEnd = leftC+R-1;     break;
          case 'ne': rStart = topR;       rEnd = topR+R-1;     cStart = rightC-R+1;   cEnd = rightC;        break;
          case 'sw': rStart = botR-R+1;   rEnd = botR;         cStart = leftC;        cEnd = leftC+R-1;     break;
          case 'se': rStart = botR-R+1;   rEnd = botR;         cStart = rightC-R+1;   cEnd = rightC;        break;
        }

        for (let r = rStart; r <= rEnd; r++) {
          for (let c = cStart; c <= cEnd; c++) {
            if (r < 0 || r >= rows || c < 0 || c >= cols) continue;

            // Skip non-room cells
            const origR = Math.floor(r / RES);
            const origC = Math.floor(c / RES);
            if (!(src[origR]?.[origC] & bits.room)) continue;

            // Skip cells in punch-through lanes (corridor openings)
            if (punchThrough.has(`${r},${c}`)) continue;

            const arcData = computeArcCellData(r, c, cx, cy, R, cn as 'nw' | 'ne' | 'sw' | 'se', false);
            if (arcData) {
              // Arc boundary cell — apply per-cell clip/wall
              cells[r][c] ??= {};
              _clearWalls(cells, r, c, rows, cols);
              for (const dir of ['north', 'south', 'east', 'west']) {
                const [dr, dc] = OFFS[dir as keyof typeof OFFS];
                const nb = cells[r + dr]?.[c + dc];
                if (nb?.[OPP[dir as keyof typeof OPP]] && nb[OPP[dir as keyof typeof OPP]] !== 'd' && nb[OPP[dir as keyof typeof OPP]] !== 's') delete nb[OPP[dir as keyof typeof OPP]];
              }
              cells[r][c].trimCorner = cn;
              cells[r][c].trimClip = arcData.trimClip;
              cells[r][c].trimWall = arcData.trimWall;
              cells[r][c].trimCrossing = arcData.trimCrossing;
            } else {
              // No arc intersection — void if outside circle
              const d2 = (c + 0.5 - cx) ** 2 + (r + 0.5 - cy) ** 2;
              if (d2 >= R * R) {
                const vc = cells[r]?.[c];
                if (vc) {
                  const hasDoor = ['north', 'south', 'east', 'west'].some(d => vc[d] === 'd' || vc[d] === 's');
                  if (!hasDoor) cells[r][c] = null;
                }
              }
              // else: inside circle — leave as-is (walls from step 2 are correct)
            }
          }
        }
      }
    } else {
    // ── Polygon trims (straight diagonal) ─────────────────────────────
    const sz = Math.max(1, Math.floor(minDim_orig / (((room as Record<string, unknown>).polygon as number || 6) <= 6 ? 3 : 4))) * RES;
    if (sz >= RES) {

    const cornerDefs = [
      { cn: 'nw', r0: topR, c0: leftC  },
      { cn: 'ne', r0: topR, c0: rightC },
      { cn: 'sw', r0: botR, c0: leftC  },
      { cn: 'se', r0: botR, c0: rightC },
    ];

    for (const { cn, r0, c0 } of cornerDefs) {
      const far = sz - 1;

      // Voided cells (triangle interior, subcell coords)
      const voided = [];
      for (let i = 1; i < sz; i++) {
        for (let j = 0; j < i; j++) {
          let vr, vc;
          switch (cn) {
            case 'nw': vr = r0 + far - i; vc = c0 + j;         break;
            case 'ne': vr = r0 + far - i; vc = c0 - i + 1 + j; break;
            case 'sw': vr = r0 - far + i; vc = c0 + j;         break;
            case 'se': vr = r0 - far + i; vc = c0 - i + 1 + j; break;
          }
          voided.push({ row: vr, col: vc });
        }
      }

      // Void the interior triangle (skip punch-through cells)
      for (const { row, col } of voided) {
        if (punchThrough.has(`${row},${col}`)) continue;
        const vc = cells[row!]?.[col!];
        if (!vc) continue;
        const hasDoor = ['north', 'south', 'east', 'west'].some(d => vc[d] === 'd' || vc[d] === 's');
        if (hasDoor) continue;
        cells[row!][col!] = null;
      }

      // Hypotenuse cells: diagonal wall + trimCorner (skip punch-through)
      const hypotenuse = [];
      for (let i = 0; i < sz; i++) {
        let hr = 0, hc = 0;
        switch (cn) {
          case 'nw': hr = r0 + far - i; hc = c0 + i; break;
          case 'ne': hr = r0 + far - i; hc = c0 - i; break;
          case 'sw': hr = r0 - far + i; hc = c0 + i; break;
          case 'se': hr = r0 - far + i; hc = c0 - i; break;
        }
        hypotenuse.push({ row: hr, col: hc });
      }

      const diagType = (cn === 'nw' || cn === 'se') ? 'ne-sw' : 'nw-se';
      for (const { row: hr, col: hc } of hypotenuse) {
        if (punchThrough.has(`${hr},${hc}`)) continue;
        if (!cells[hr]) continue;
        cells[hr][hc] ??= {};
        _clearWalls(cells, hr, hc, rows, cols);
        for (const dir of ['north', 'south', 'east', 'west']) {
          const [dr, dc] = OFFS[dir as keyof typeof OFFS];
          const nb = cells[hr + dr]?.[hc + dc];
          if (nb?.[OPP[dir as keyof typeof OPP]]) delete nb[OPP[dir as keyof typeof OPP]];
        }
        cells[hr][hc].trimCorner = cn;
        cells[hr][hc][diagType]  = 'w';
      }
    }
    } // sz >= RES
    } // else (polygon)

    // ── Wall repair: side walls on punch-through cells facing void/trim ──
    // Shared by circle and polygon rooms. Only perpendicular to punch
    // direction (no end cap). Checks void and void-side of trim cells.
    const FACING = { north: 's', south: 'n', east: 'w', west: 'e' };
    for (const [key, axis] of punchThrough) {
      const [r, c] = key.split(',').map(Number);
      const cell = cells[r]?.[c];
      if (!cell) continue;
      const sides = axis === 'ew'
        ? [['north', -1, 0], ['south', 1, 0]]
        : [['west', 0, -1], ['east', 0, 1]];
      for (const [dir, dr, dc] of sides) {
        const nb = cells[r + dr]?.[c + dc];
        if (!nb) {
          cell[dir] ??= 'w';
        } else if (nb.trimCorner) {
          // Wall needed if shared edge is on void side of the trim
          if (nb.trimCorner.includes(FACING[dir as keyof typeof FACING])) {
            cell[dir] ??= 'w';
          }
        }
      }
    }
  }

  // ── 7b. Repair: restore cells voided by another room's trim ─────────
  // A polygon/circle trim may void cells that belong to an adjacent room.
  // Scan the grid and restore any null cell whose original Donjon data
  // says should be floor (room or corridor).
  const restoredCells = new Set();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r][c] !== null) continue;
      const origR = Math.floor(r / RES);
      const origC = Math.floor(c / RES);
      const origVal = src[origR]?.[origC] || 0;
      let restore = false;
      if (origVal & bits.corridor) {
        restore = true;
      } else if (origVal & bits.room) {
        // Check if any cardinal neighbor in the original grid is a different
        // room or a corridor — if so, this cell is shared/adjacent and should
        // not have been voided by the shaped room's trim.
        const myRoomId = (origVal & bits.room_id) >> 6;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nv = src[origR + dr]?.[origC + dc] || 0;
          if (nv & bits.corridor) { restore = true; break; }
          if ((nv & bits.room) && ((nv & bits.room_id) >> 6) !== myRoomId) { restore = true; break; }
        }
      }
      if (restore) {
        cells[r][c] = {};
        restoredCells.add(`${r},${c}`);
      }
    }
  }

  // ── 7c. Rebuild walls on restored cells ─────────────────────────────
  // Only restored cells need walls — add where they border void/trim.
  for (const key of restoredCells) {
    const [r, c] = (key as string).split(',').map(Number);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const [dir, [dr, dc]] of [['north',[-1,0]],['south',[1,0]],['west',[0,-1]],['east',[0,1]]] as [string, [number, number]][]) {
      const nr = r + dr, nc = c + dc;
      if (!cells[nr]?.[nc]) {
        if (!(cell as Record<string, unknown>)[dir]) (cell as Record<string, unknown>)[dir] = 'w';
      }
    }
  }

  // ── 8. Assemble dungeon JSON (v4 format — half-cell, per-cell arcs) ──
  const metadata = {
    formatVersion: FORMAT_VERSION,
    dungeonName: data.settings?.name ?? 'Imported Dungeon',
    gridSize,
    resolution: RES,
    theme: 'sepia-parchment',
    labelStyle: 'circled' as const,
    features: {
      showGrid: true,
      compassRose: true,
      scale: true,
      border: true,
    },
    dungeonLetter,
    levels: [{ name: null, startRow: 0, numRows: rows }],
    props,
    nextPropId,
    lightingEnabled: false,
    ambientLight: 1.0,
    lights: [] as Light[],
    stairs: stairs.length > 0 ? stairs : [] as Stairs[],
    bridges: [] as Bridge[],
    nextLightId: 0,
    nextBridgeId: 0,
    nextStairId: stairs.length > 0 ? nextStairId : 0,
  };

  return { metadata: metadata as unknown as Metadata, cells: cells as unknown as CellGrid[][] };
}
