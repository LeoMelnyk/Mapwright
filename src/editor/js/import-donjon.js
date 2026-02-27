// Convert a Donjon random dungeon JSON export into our internal dungeon format.
// Donjon format: { cells (2D bitmask grid), rooms, stairs, settings, cell_bit, ... }
//
// Donjon cell bitmask flags (from cell_bit):
//   room=2, corridor=4, perimeter=16, aperture=32, arch=65536,
//   door=131072, locked=262144, trapped=524288, secret=1048576,
//   portcullis=2097152, stair_down=4194304, stair_up=8388608,
//   room_id=65472 (bits 6-15), label=4278190080 (bits 24-31)

/**
 * Convert a Donjon dungeon JSON object into our dungeon editor JSON.
 * Returns { metadata, cells } ready to assign to state.dungeon.
 */
export function convertDonjonDungeon(data) {
  const bits = data.cell_bit;
  const src = data.cells;
  const rows = src.length;
  const cols = src[0]?.length || 0;

  // Combine all "door-type" bits
  const DOOR_BITS = bits.door | bits.locked | bits.trapped | bits.secret | bits.portcullis;

  // ── 1. Create floor grid from bitmask ───────────────────────────────
  // Donjon door cells sit at perimeter (wall) positions between rooms/corridors
  // but they carry the corridor bit — they must become floor so passages connect.
  const cells = [];
  for (let r = 0; r < rows; r++) {
    cells.push(new Array(cols).fill(null));
    for (let c = 0; c < cols; c++) {
      const v = src[r][c];
      if (v & (bits.room | bits.corridor)) {
        // Room, corridor, door, and arch cells all become floor
        cells[r][c] = {};
      }
    }
  }

  // ── 2. Wall detection at floor/void boundaries ──────────────────────
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cells[r][c]) continue;
      if (r === 0          || !cells[r - 1][c]) cells[r][c].north = 'w';
      if (r === rows - 1   || !cells[r + 1][c]) cells[r][c].south = 'w';
      if (c === 0          || !cells[r][c - 1]) cells[r][c].west  = 'w';
      if (c === cols - 1   || !cells[r][c + 1]) cells[r][c].east  = 'w';
    }
  }

  // ── 3. Place doors ──────────────────────────────────────────────────
  // Door cells are now floor. They sit between room and corridor cells,
  // with perimeter (void) on the perpendicular sides. The door marker
  // goes on the wall between the door cell and adjacent room cells.
  const SELF_DIR = [
    { dr: -1, dc:  0, self: 'north', recip: 'south' },
    { dr:  1, dc:  0, self: 'south', recip: 'north' },
    { dr:  0, dc: -1, self: 'west',  recip: 'east'  },
    { dr:  0, dc:  1, self: 'east',  recip: 'west'  },
  ];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = src[r][c];
      if (v & bits.arch) continue; // arches are open passages, no door
      if (!(v & DOOR_BITS)) continue;

      const wallVal = (v & bits.secret) ? 's' : 'd';

      // Place door wall between this cell and its room-flagged neighbor(s)
      for (const { dr, dc, self, recip } of SELF_DIR) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (!(src[nr][nc] & bits.room)) continue; // only toward room cells
        cells[r][c][self] = wallVal;
        if (cells[nr]?.[nc]) cells[nr][nc][recip] = wallVal;
      }
    }
  }

  // ── 4. Stairs ───────────────────────────────────────────────────────
  const stairs = [];
  let nextStairId = 0;

  const DIR_TO_VEC = { north: { x: 0, y: -1 }, south: { x: 0, y: 1 }, east: { x: 1, y: 0 }, west: { x: -1, y: 0 } };
  const DIR_TO_CARDINAL = { north: 'north', south: 'south', east: 'east', west: 'west' };
  const CARDINAL_RECIP = { north: 'south', south: 'north', east: 'west', west: 'east' };

  for (const stair of (data.stairs || [])) {
    const r = stair.row;
    const c = stair.col;
    const dir = DIR_TO_VEC[stair.dir];
    if (!dir || !cells[r]?.[c]) continue;

    // Build triangle stair points (same pattern as OPD)
    let points;
    if (dir.y === -1) {
      points = [[r + 1, c], [r + 1, c + 1], [r, c + 0.5]];
    } else if (dir.y === 1) {
      points = [[r, c + 1], [r, c], [r + 1, c + 0.5]];
    } else if (dir.x === 1) {
      points = [[r, c], [r + 1, c], [r + 0.5, c + 1]];
    } else if (dir.x === -1) {
      points = [[r + 1, c + 1], [r, c + 1], [r + 0.5, c]];
    }

    if (points) {
      const id = nextStairId++;
      stairs.push({ id, points, link: null });
      if (!cells[r][c].center) cells[r][c].center = {};
      cells[r][c].center['stair-id'] = id;

      // Remove wall between stair cell and neighbor in stair direction
      const cardinal = DIR_TO_CARDINAL[stair.dir];
      const nr = r + (dir.y || 0);
      const nc = c + (dir.x || 0);
      if (cells[r][c][cardinal]) delete cells[r][c][cardinal];
      if (cells[nr]?.[nc]?.[CARDINAL_RECIP[cardinal]]) delete cells[nr][nc][CARDINAL_RECIP[cardinal]];
    }
  }

  // ── 5. Room coordinate offset ───────────────────────────────────────
  // Donjon room metadata coords may be offset from the cell grid (some
  // exports pad the grid). Compute the offset from the first room.
  let roomOffR = 0, roomOffC = 0;
  const firstRoom = (data.rooms || []).find(r => r);
  if (firstRoom) {
    const targetId = parseInt(firstRoom.id);
    outer:
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (((src[r][c] & bits.room_id) >> 6) === targetId) {
          roomOffR = r - firstRoom.north;
          roomOffC = c - firstRoom.west;
          break outer;
        }
      }
    }
  }

  // ── 6. Room labels ────────────────────────────────────────────────
  const dungeonLetter = 'A';
  for (const room of (data.rooms || [])) {
    if (!room) continue;
    const centerR = Math.floor((room.north + room.south) / 2) + roomOffR;
    const centerC = Math.floor((room.west + room.east) / 2) + roomOffC;
    if (cells[centerR]?.[centerC]) {
      if (!cells[centerR][centerC].center) cells[centerR][centerC].center = {};
      cells[centerR][centerC].center.label = dungeonLetter + room.id;
    }
  }

  // ── 7. Room shape trims ─────────────────────────────────────────────
  const OFFS = { north: [-1, 0], south: [1, 0], west: [0, -1], east: [0, 1] };
  const OPP  = { north: 'south', south: 'north', west: 'east', east: 'west' };

  for (const room of (data.rooms || [])) {
    if (!room) continue;
    if (room.shape !== 'circle' && room.shape !== 'polygon') continue;

    const topR = room.north + roomOffR;
    const leftC = room.west + roomOffC;
    const botR = room.south + roomOffR;
    const rightC = room.east + roomOffC;
    const roomW = rightC - leftC + 1;
    const roomH = botR - topR + 1;
    const minDim = Math.min(roomW, roomH);

    let sz, round;
    if (room.shape === 'circle') {
      sz = Math.floor(minDim / 2);
      round = true;
    } else {
      // polygon-6 or polygon-7
      const sides = room.polygon || 6;
      sz = Math.max(1, Math.floor(minDim / (sides <= 6 ? 3 : 4)));
      round = false;
    }
    if (sz < 1) continue;

    const cornerDefs = [
      { cn: 'nw', r0: topR,  c0: leftC,  ac: { row: topR,     col: leftC } },
      { cn: 'ne', r0: topR,  c0: rightC, ac: { row: topR,     col: rightC + 1 } },
      { cn: 'sw', r0: botR,  c0: leftC,  ac: { row: botR + 1, col: leftC } },
      { cn: 'se', r0: botR,  c0: rightC, ac: { row: botR + 1, col: rightC + 1 } },
    ];

    for (const { cn, r0, c0, ac } of cornerDefs) {
      const far = sz - 1;

      // Hypotenuse cells
      const hyp = [];
      for (let i = 0; i < sz; i++) {
        let hr, hc;
        switch (cn) {
          case 'nw': hr = r0 + far - i; hc = c0 + i; break;
          case 'ne': hr = r0 + far - i; hc = c0 - i; break;
          case 'sw': hr = r0 - far + i; hc = c0 + i; break;
          case 'se': hr = r0 - far + i; hc = c0 - i; break;
        }
        hyp.push({ row: hr, col: hc });
      }

      // Voided cells (triangle interior)
      let voidCells = [];
      for (let i = 1; i < sz; i++) {
        for (let j = 0; j < i; j++) {
          let vr, vc;
          switch (cn) {
            case 'nw': vr = r0 + far - i; vc = c0 + j; break;
            case 'ne': vr = r0 + far - i; vc = c0 - i + 1 + j; break;
            case 'sw': vr = r0 - far + i; vc = c0 + j; break;
            case 'se': vr = r0 - far + i; vc = c0 - i + 1 + j; break;
          }
          voidCells.push({ row: vr, col: vc });
        }
      }

      // For rounded trims: filter void cells — cells inside arc become insideArc
      let insideArc = [];
      if (round && voidCells.length > 0) {
        let pivotX, pivotY;
        switch (cn) {
          case 'nw': pivotX = ac.col + sz; pivotY = ac.row + sz; break;
          case 'ne': pivotX = ac.col - sz; pivotY = ac.row + sz; break;
          case 'sw': pivotX = ac.col + sz; pivotY = ac.row - sz; break;
          case 'se': pivotX = ac.col - sz; pivotY = ac.row - sz; break;
        }
        voidCells = voidCells.filter(({ row: vr, col: vc }) => {
          const dx = Math.max(vc - pivotX, 0, pivotX - (vc + 1));
          const dy = Math.max(vr - pivotY, 0, pivotY - (vr + 1));
          const outside = Math.sqrt(dx * dx + dy * dy) > sz;
          if (!outside) insideArc.push({ row: vr, col: vc });
          return outside;
        });
      }

      // Helper: clear all cardinal walls on cell + reciprocals
      function clearWalls(r, c) {
        const cell = cells[r]?.[c];
        if (!cell) return;
        for (const dir of ['north', 'south', 'east', 'west']) {
          if (cell[dir]) {
            delete cell[dir];
            const [dr, dc] = OFFS[dir];
            const nb = cells[r + dr]?.[c + dc];
            if (nb) delete nb[OPP[dir]];
          }
        }
        delete cell['nw-se'];
        delete cell['ne-sw'];
      }

      // Apply: void cells
      for (const { row, col } of voidCells) {
        if (cells[row]?.[col]) cells[row][col] = null;
      }

      // Apply: hypotenuse cells
      for (const { row: r, col: c } of hyp) {
        if (!cells[r]?.[c]) continue;
        clearWalls(r, c);
        const cell = cells[r][c];
        cell.trimCorner = cn;
        cell[cn === 'nw' || cn === 'se' ? 'ne-sw' : 'nw-se'] = 'w';
        if (round) {
          cell.trimRound = true;
          cell.trimArcInverted = false;
          cell.trimArcCenterRow = ac.row;
          cell.trimArcCenterCol = ac.col;
          cell.trimArcRadius = sz;
        }
      }

      // Apply: insideArc cells (rounded trims only)
      for (const { row: r, col: c } of insideArc) {
        if (!cells[r]?.[c]) continue;
        clearWalls(r, c);
        const cell = cells[r][c];
        cell.trimInsideArc = true;
        cell.trimCorner = cn;
        cell.trimArcCenterRow = ac.row;
        cell.trimArcCenterCol = ac.col;
        cell.trimArcRadius = sz;
        cell.trimArcInverted = false;
      }
    }
  }

  // ── 8. Assemble dungeon JSON ────────────────────────────────────────
  const metadata = {
    dungeonName: data.settings?.name || 'Imported Dungeon',
    gridSize: 5,
    theme: 'sepia-parchment',
    labelStyle: 'circled',
    features: {
      showGrid: true,
      compassRose: true,
      scale: true,
      border: true,
    },
    dungeonLetter,
    levels: [{ name: null, startRow: 0, numRows: rows }],
  };

  if (stairs.length > 0) {
    metadata.stairs = stairs;
    metadata.nextStairId = nextStairId;
  }

  return { metadata, cells };
}
