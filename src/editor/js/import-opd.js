// Convert a One-Page-Dungeon JSON export into our internal dungeon format.
// OPD format: { rects, doors, notes, columns, water, title, story, version }
//
// OPD door types (from watabou source):
//   0 = connection     1 = normal door    2 = archway       3 = stairs
//   4 = portcullis     5 = special        6 = secret        7 = door (alt)
//   8 = long stairs    9 = steps (level change)

/**
 * Classify an OPD door type.
 * Returns "door", "secret", "open", or "stairs".
 */
function classifyDoor(type) {
  switch (type) {
    case 0:  return 'open';    // empty / open passage
    case 2:  return 'open';    // archway
    case 3:  return 'stairs';  // staircase
    case 8:  return 'stairs';  // long stairs
    case 9:  return 'stairs';  // steps / level change
    case 6:  return 'secret';  // secret door
    default: return 'door';    // 1=normal, 4=portcullis, 5=special, 7=barred
  }
}

/**
 * Convert OPD direction {x, y} to our cardinal direction names
 * and the reciprocal direction for the neighbouring cell.
 */
function dirToCardinal(dir) {
  if (dir.x ===  1) return { self: 'east',  reciprocal: 'west'  };
  if (dir.x === -1) return { self: 'west',  reciprocal: 'east'  };
  if (dir.y ===  1) return { self: 'south', reciprocal: 'north' };
  if (dir.y === -1) return { self: 'north', reciprocal: 'south' };
  return null;
}

/**
 * Build a stair triangle (3 points in grid-corner coords) for a cell
 * at (row, col) with the stair going in direction dir.
 *
 * P1→P2 = base edge (entry side), P3 = midpoint of the far edge.
 * The triangle tapers toward the direction of travel, matching OPD's
 * directional stair arrows.
 */
function buildStairPoints(row, col, dir) {
  // Grid-corner coords: cell (r,c) has corners (r,c), (r,c+1), (r+1,c), (r+1,c+1).
  // The base edge is the side the stair enters FROM (opposite to dir).
  // P3 is the midpoint of the far edge so classifyStairShape() → triangle.
  if (dir.y === -1) {
    // Stair goes north: base = south edge, point = north midpoint
    return [[row + 1, col], [row + 1, col + 1], [row, col + 0.5]];
  }
  if (dir.y === 1) {
    // Stair goes south: base = north edge, point = south midpoint
    return [[row, col + 1], [row, col], [row + 1, col + 0.5]];
  }
  if (dir.x === 1) {
    // Stair goes east: base = west edge, point = east midpoint
    return [[row, col], [row + 1, col], [row + 0.5, col + 1]];
  }
  if (dir.x === -1) {
    // Stair goes west: base = east edge, point = west midpoint
    return [[row + 1, col + 1], [row, col + 1], [row + 0.5, col]];
  }
  return null;
}

/**
 * Convert a One-Page-Dungeon JSON object into our dungeon editor JSON.
 * Returns { metadata, cells } ready to assign to state.dungeon.
 */
export function convertOnePageDungeon(opd) {
  // ── 1. Bounding box ────────────────────────────────────────────────
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const r of opd.rects) {
    minX = Math.min(minX, r.x);
    maxX = Math.max(maxX, r.x + r.w - 1);
    minY = Math.min(minY, r.y);
    maxY = Math.max(maxY, r.y + r.h - 1);
  }
  // 1-cell padding so outer walls aren't on the grid edge
  minX -= 1;
  minY -= 1;
  maxX += 1;
  maxY += 1;

  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;

  // Helper: OPD coords → our (row, col)
  const toRow = y => y - minY;
  const toCol = x => x - minX;

  // ── 2. Blank grid (all void) ───────────────────────────────────────
  const cells = [];
  for (let r = 0; r < rows; r++) {
    cells.push(new Array(cols).fill(null));
  }

  // ── 3. Fill floor cells from rects ─────────────────────────────────
  for (const rect of opd.rects) {
    for (let dy = 0; dy < rect.h; dy++) {
      for (let dx = 0; dx < rect.w; dx++) {
        const r = toRow(rect.y + dy);
        const c = toCol(rect.x + dx);
        if (r >= 0 && r < rows && c >= 0 && c < cols) {
          if (!cells[r][c]) cells[r][c] = {};
        }
      }
    }
  }

  // ── 4. Walls at floor / void boundaries ────────────────────────────
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cells[r][c]) continue;
      if (r === 0          || !cells[r - 1][c]) cells[r][c].north = 'w';
      if (r === rows - 1   || !cells[r + 1][c]) cells[r][c].south = 'w';
      if (c === 0          || !cells[r][c - 1]) cells[r][c].west  = 'w';
      if (c === cols - 1   || !cells[r][c + 1]) cells[r][c].east  = 'w';
    }
  }

  // ── 5. Place doors and stairs ──────────────────────────────────────
  const stairs = [];
  let nextStairId = 0;

  for (const door of (opd.doors || [])) {
    const kind = classifyDoor(door.type);
    if (kind === 'open') continue; // open passage — leave as-is

    const cardinal = dirToCardinal(door.dir);
    if (!cardinal) continue;

    const r = toRow(door.y);
    const c = toCol(door.x);
    const nr = r + door.dir.y;
    const nc = c + door.dir.x;

    if (kind === 'stairs') {
      // Remove any wall between the stair cell and its neighbor
      if (cells[r]?.[c])   delete cells[r][c][cardinal.self];
      if (cells[nr]?.[nc]) delete cells[nr][nc][cardinal.reciprocal];

      // Create stair entry
      const points = buildStairPoints(r, c, door.dir);
      if (points) {
        const id = nextStairId++;
        stairs.push({ id, points, link: null });
        // Mark the cell as belonging to this stair
        if (cells[r]?.[c]) {
          if (!cells[r][c].center) cells[r][c].center = {};
          cells[r][c].center['stair-id'] = id;
        }
      }
    } else {
      // Door or secret door
      const wallVal = kind === 'secret' ? 's' : 'd';
      if (cells[r]?.[c])   cells[r][c][cardinal.self]       = wallVal;
      if (cells[nr]?.[nc]) cells[nr][nc][cardinal.reciprocal] = wallVal;
    }
  }

  // ── 6. Notes → room labels (letter + ref number, skip flavor text) ──
  const dungeonLetter = 'A';
  for (const note of (opd.notes || [])) {
    if (!note.ref || !note.pos) continue;
    const r = toRow(Math.floor(note.pos.y));
    const c = toCol(Math.floor(note.pos.x));
    if (cells[r]?.[c]) {
      if (!cells[r][c].center) cells[r][c].center = {};
      cells[r][c].center.label = dungeonLetter + note.ref;
    }
  }

  // ── 7. Props (columns, archways, portcullis) → metadata.props[] ────
  const gridSize = 5;
  const props = [];
  let nextPropId = 1;

  function addProp(row, col, type, rotation = 0) {
    props.push({
      id: `prop_${nextPropId++}`,
      type,
      x: col * gridSize,
      y: row * gridSize,
      rotation,
      scale: 1.0,
      zIndex: 10,
      flipped: false,
    });
  }

  // Columns: OPD columns are at grid intersections (corners where 4 cells meet).
  // Only place a pillar if all 4 surrounding cells are open floor with
  // no walls at the shared corner — i.e. it's a room-interior column.
  for (const col of (opd.columns || [])) {
    // OPD corner (col.x, col.y) → the 4 cells sharing that corner:
    //   NW = (y-1, x-1), NE = (y-1, x), SW = (y, x-1), SE = (y, x)
    const r = toRow(col.y);
    const c = toCol(col.x);
    const nw = cells[r - 1]?.[c - 1];
    const ne = cells[r - 1]?.[c];
    const sw = cells[r]?.[c - 1];
    const se = cells[r]?.[c];

    // All 4 cells must be floor
    if (!nw || !ne || !sw || !se) continue;

    // No walls at the shared edges meeting at this corner
    if (nw.east || nw.south) continue;
    if (ne.west || ne.south) continue;
    if (sw.east || sw.north) continue;
    if (se.west || se.north) continue;

    // Don't place on stair cells
    if (se.center?.['stair-id'] != null) continue;

    addProp(r, c, 'pillar-corner');
  }

  // Archways and portcullis: place visual props on door cells
  for (const door of (opd.doors || [])) {
    if (door.type !== 2 && door.type !== 4) continue; // archway=2, portcullis=4

    const r = toRow(door.y);
    const c = toCol(door.x);
    if (!cells[r]?.[c]) continue;

    // Rotation: horizontal passage = 0, vertical = 90
    const rotation = door.dir.x !== 0 ? 90 : 0;

    if (door.type === 2) addProp(r, c, 'archway', rotation);
    else if (door.type === 4) addProp(r, c, 'portcullis', rotation);
  }

  // ── 8. Water fills ─────────────────────────────────────────────────
  for (const w of (opd.water || [])) {
    // OPD water entries are rects: { x, y, w, h }
    for (let dy = 0; dy < (w.h || 1); dy++) {
      for (let dx = 0; dx < (w.w || 1); dx++) {
        const r = toRow((w.y || 0) + dy);
        const c = toCol((w.x || 0) + dx);
        if (cells[r]?.[c]) {
          cells[r][c].fill = 'water';
          cells[r][c].waterDepth = 1;
        }
      }
    }
  }

  // ── 9. Rotunda trims (circular rooms) ──────────────────────────────
  const OFFS = { north: [-1, 0], south: [1, 0], west: [0, -1], east: [0, 1] };
  const OPP  = { north: 'south', south: 'north', west: 'east', east: 'west' };

  for (const rect of opd.rects) {
    if (!rect.rotunda) continue;
    const topR = toRow(rect.y);
    const leftC = toCol(rect.x);
    const botR = toRow(rect.y + rect.h - 1);
    const rightC = toCol(rect.x + rect.w - 1);
    const sz = Math.floor(Math.min(rect.w, rect.h) / 2);
    if (sz < 1) continue;

    const corners = [
      { cn: 'nw', r0: topR,  c0: leftC,  ac: { row: topR,     col: leftC } },
      { cn: 'ne', r0: topR,  c0: rightC, ac: { row: topR,     col: rightC + 1 } },
      { cn: 'sw', r0: botR,  c0: leftC,  ac: { row: botR + 1, col: leftC } },
      { cn: 'se', r0: botR,  c0: rightC, ac: { row: botR + 1, col: rightC + 1 } },
    ];

    for (const { cn, r0, c0, ac } of corners) {
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

      // Rounded arc: filter void cells — cells inside arc become insideArc floor
      const insideArc = [];
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

      // Apply: void cells (skip cells with doors — they connect to adjacent rooms)
      for (const { row, col } of voidCells) {
        const vc = cells[row]?.[col];
        if (!vc) continue;
        const hasDoor = ['north','south','east','west'].some(d => vc[d] === 'd' || vc[d] === 's');
        if (hasDoor) continue;
        cells[row][col] = null;
      }

      // Helper: clear cardinal walls on cell + reciprocals, but preserve doors
      function clearWalls(r, c) {
        const cell = cells[r]?.[c];
        if (!cell) return;
        for (const dir of ['north', 'south', 'east', 'west']) {
          if (cell[dir] && cell[dir] !== 'd' && cell[dir] !== 's') {
            delete cell[dir];
            const [dr, dc] = OFFS[dir];
            const nb = cells[r + dr]?.[c + dc];
            if (nb && nb[OPP[dir]] !== 'd' && nb[OPP[dir]] !== 's') delete nb[OPP[dir]];
          }
        }
        delete cell['nw-se'];
        delete cell['ne-sw'];
      }

      // Apply: hypotenuse cells
      for (const { row: r, col: c } of hyp) {
        if (!cells[r]?.[c]) continue;
        clearWalls(r, c);
        const cell = cells[r][c];
        cell.trimCorner = cn;
        cell[cn === 'nw' || cn === 'se' ? 'ne-sw' : 'nw-se'] = 'w';
        cell.trimRound = true;
        cell.trimArcInverted = false;
        cell.trimArcCenterRow = ac.row;
        cell.trimArcCenterCol = ac.col;
        cell.trimArcRadius = sz;
      }

      // Apply: insideArc cells
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

  // ── 10. Assemble dungeon JSON (v2 format — overlay props) ─────────
  const metadata = {
    formatVersion: 2,
    dungeonName: opd.title || 'Imported Dungeon',
    gridSize,
    theme: 'sepia-parchment',
    labelStyle: 'circled',
    features: {
      showGrid: true,
      compassRose: true,
      scale: true,
      border: true,
    },
    dungeonLetter: dungeonLetter,
    levels: [{ name: null, startRow: 0, numRows: rows }],
    props,
    nextPropId,
  };

  if (stairs.length > 0) {
    metadata.stairs = stairs;
    metadata.nextStairId = nextStairId;
  }

  return { metadata, cells };
}
