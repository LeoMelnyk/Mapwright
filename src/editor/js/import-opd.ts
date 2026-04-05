// Convert a One-Page-Dungeon JSON export into our internal dungeon format.
// OPD format: { rects, doors, notes, columns, water, title, story, version }
//
// Outputs at resolution=2 (half-cell grid) and formatVersion=4 natively,
// bypassing the migration pipeline entirely.
//
// OPD door types (from watabou source):
//   0 = connection     1 = normal door    2 = archway       3 = stairs
//   4 = portcullis     5 = special        6 = secret        7 = door (alt)
//   8 = long stairs    9 = steps (level change)

import { computeTrimCells } from '../../util/trim-geometry.js';

const RES = 2;             // half-cell resolution: each OPD cell → 2×2 subcells
const FORMAT_VERSION = 4;  // current format (half-cell + per-cell arcs)

/**
 * Classify an OPD door type.
 * Returns "door", "secret", "open", or "stairs".
 */
function classifyDoor(type: any) {
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
function dirToCardinal(dir: any) {
  if (dir.x ===  1) return { self: 'east',  reciprocal: 'west'  };
  if (dir.x === -1) return { self: 'west',  reciprocal: 'east'  };
  if (dir.y ===  1) return { self: 'south', reciprocal: 'north' };
  if (dir.y === -1) return { self: 'north', reciprocal: 'south' };
  return null;
}

/**
 * Build a stair triangle (3 points in grid-corner coords) for a cell
 * at (row, col) with the stair going in direction dir.
 * Coordinates are in the 2× internal grid.
 *
 * P1→P2 = base edge (entry side), P3 = midpoint of the far edge.
 * The triangle tapers toward the direction of travel, matching OPD's
 * directional stair arrows.
 */
function buildStairPoints(row: any, col: any, dir: any) {
  // Grid-corner coords: cell (r,c) has corners (r,c), (r,c+1), (r+1,c), (r+1,c+1).
  // The base edge is the side the stair enters FROM (opposite to dir).
  // P3 is the midpoint of the far edge so classifyStairShape() → triangle.
  // These coordinates are at 2× scale (each OPD cell = 2 subcells).
  const w = RES, h = RES; // stair spans the full 2×2 block
  if (dir.y === -1) {
    // Stair goes north: base = south edge, point = north midpoint
    return [[row + h, col], [row + h, col + w], [row, col + w / 2]];
  }
  if (dir.y === 1) {
    // Stair goes south: base = north edge, point = south midpoint
    return [[row, col + w], [row, col], [row + h, col + w / 2]];
  }
  if (dir.x === 1) {
    // Stair goes east: base = west edge, point = east midpoint
    return [[row, col], [row + h, col], [row + h / 2, col + w]];
  }
  if (dir.x === -1) {
    // Stair goes west: base = east edge, point = west midpoint
    return [[row + h, col + w], [row, col + w], [row + h / 2, col]];
  }
  return null;
}

// ── Subcell helpers ──────────────────────────────────────────────────────────

/** Set a wall/door on both subcells spanning one edge of a 2×2 block. */
function setEdge(cells: any, r: any, c: any, direction: any, value: any) {
  switch (direction) {
    case 'north':
      if (cells[r]?.[c]) cells[r][c].north = value;
      if (cells[r]?.[c + 1]) cells[r][c + 1].north = value;
      break;
    case 'south':
      if (cells[r + 1]?.[c]) cells[r + 1][c].south = value;
      if (cells[r + 1]?.[c + 1]) cells[r + 1][c + 1].south = value;
      break;
    case 'west':
      if (cells[r]?.[c]) cells[r][c].west = value;
      if (cells[r + 1]?.[c]) cells[r + 1][c].west = value;
      break;
    case 'east':
      if (cells[r]?.[c + 1]) cells[r][c + 1].east = value;
      if (cells[r + 1]?.[c + 1]) cells[r + 1][c + 1].east = value;
      break;
  }
}

/** Remove a wall/door from both subcells spanning one edge of a 2×2 block. */
function clearEdge(cells: any, r: any, c: any, direction: any) {
  switch (direction) {
    case 'north':
      if (cells[r]?.[c]) delete cells[r][c].north;
      if (cells[r]?.[c + 1]) delete cells[r][c + 1].north;
      break;
    case 'south':
      if (cells[r + 1]?.[c]) delete cells[r + 1][c].south;
      if (cells[r + 1]?.[c + 1]) delete cells[r + 1][c + 1].south;
      break;
    case 'west':
      if (cells[r]?.[c]) delete cells[r][c].west;
      if (cells[r + 1]?.[c]) delete cells[r + 1][c].west;
      break;
    case 'east':
      if (cells[r]?.[c + 1]) delete cells[r][c + 1].east;
      if (cells[r + 1]?.[c + 1]) delete cells[r + 1][c + 1].east;
      break;
  }
}

/** Set a door at the internal subcell boundary (center of a 2×2 block). */
function setCenterDoor(cells: any, r: any, c: any, axis: any, value: any) {
  if (axis === 'ew') {
    // Internal E-W boundary: between TL/BL and TR/BR
    if (cells[r]?.[c]) cells[r][c].east = value;
    if (cells[r]?.[c + 1]) cells[r][c + 1].west = value;
    if (cells[r + 1]?.[c]) cells[r + 1][c].east = value;
    if (cells[r + 1]?.[c + 1]) cells[r + 1][c + 1].west = value;
  } else {
    // Internal N-S boundary: between TL/TR and BL/BR
    if (cells[r]?.[c]) cells[r][c].south = value;
    if (cells[r]?.[c + 1]) cells[r][c + 1].south = value;
    if (cells[r + 1]?.[c]) cells[r + 1][c].north = value;
    if (cells[r + 1]?.[c + 1]) cells[r + 1][c + 1].north = value;
  }
}

/**
 * Convert a One-Page-Dungeon JSON object into our dungeon editor JSON.
 * Returns { metadata, cells } ready to assign to state.dungeon.
 */
export function convertOnePageDungeon(opd: any): { metadata: any; cells: any[][] } {
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

  const opdCols = maxX - minX + 1;
  const opdRows = maxY - minY + 1;
  const cols = opdCols * RES;
  const rows = opdRows * RES;

  // Helper: OPD coords → our internal (row, col) at 2× scale (top-left subcell)
  const toRow = (y: any) => (y - minY) * RES;
  const toCol = (x: any) => (x - minX) * RES;

  // ── 2. Blank grid (all void) ───────────────────────────────────────
  const cells = [];
  for (let r = 0; r < rows; r++) {
    cells.push(new Array(cols).fill(null));
  }

  // ── 3. Fill floor cells from rects (each OPD cell → 2×2 subcells) ──
  for (const rect of opd.rects) {
    for (let dy = 0; dy < rect.h; dy++) {
      for (let dx = 0; dx < rect.w; dx++) {
        const r = toRow(rect.y + dy);
        const c = toCol(rect.x + dx);
        // Fill all 4 subcells
        for (let sr = 0; sr < RES; sr++) {
          for (let sc = 0; sc < RES; sc++) {
            const rr = r + sr, cc = c + sc;
            if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
              if (!cells[rr][cc]) cells[rr][cc] = {};
            }
          }
        }
      }
    }
  }

  // ── 4. Walls at floor / void boundaries ────────────────────────────
  // Each subcell gets walls where it faces void or grid edge.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cells[r][c]) continue;
      if (r === 0          || !cells[r - 1][c]) cells[r][c].north = 'w';
      if (r === rows - 1   || !cells[r + 1][c]) cells[r][c].south = 'w';
      if (c === 0          || !cells[r][c - 1]) cells[r][c].west  = 'w';
      if (c === cols - 1   || !cells[r][c + 1]) cells[r][c].east  = 'w';
    }
  }

  // ── 5. Build set of 1×1 door-cell positions for mid-cell centering ─
  const doorCellSet = new Set();
  for (const rect of opd.rects) {
    if (rect.w === 1 && rect.h === 1) {
      doorCellSet.add(`${rect.x},${rect.y}`);
    }
  }

  // ── 6. Place doors and stairs ──────────────────────────────────────
  const stairs = [];
  let nextStairId = 0;

  for (const door of (opd.doors || [])) {
    const kind = classifyDoor(door.type);
    if (kind === 'open') continue; // open passage — leave as-is

    const cardinal = dirToCardinal(door.dir);
    if (!cardinal) continue;

    const r = toRow(door.y);
    const c = toCol(door.x);
    // Neighbor 2×2 block origin
    const nr = r + door.dir.y * RES;
    const nc = c + door.dir.x * RES;

    if (kind === 'stairs') {
      // Remove walls between the stair block and its neighbor
      clearEdge(cells, r, c, cardinal.self);
      clearEdge(cells, nr, nc, cardinal.reciprocal);

      // Create stair entry with points at 2× scale
      const points = buildStairPoints(r, c, door.dir);
      if (points) {
        const id = nextStairId++;
        stairs.push({ id, points, link: null });
        // Mark the top-left subcell as belonging to this stair
        if (cells[r]?.[c]) {
          if (!cells[r][c].center) cells[r][c].center = {};
          cells[r][c].center['stair-id'] = id;
        }
      }
    } else {
      const wallVal = kind === 'secret' ? 's' : 'd';
      const isDoorCell = doorCellSet.has(`${door.x},${door.y}`);

      if (kind === 'secret') {
        // Secret doors: OPD dir points toward the hidden room; the secret
        // wall faces the opposite direction (toward the main room).
        setEdge(cells, r, c, cardinal.reciprocal, wallVal);
        const oppR = r - door.dir.y * RES;
        const oppC = c - door.dir.x * RES;
        setEdge(cells, oppR, oppC, cardinal.self, wallVal);
      } else if (isDoorCell) {
        // Door on a 1×1 passage cell — check if rooms on both sides
        const oppR = r - door.dir.y * RES;
        const oppC = c - door.dir.x * RES;
        const oppHasFloor = cells[oppR]?.[oppC] != null;

        if (oppHasFloor) {
          // Passage connects rooms on both sides — center the door
          const axis = door.dir.x !== 0 ? 'ew' : 'ns';
          // Remove walls on both outer edges (connecting to rooms)
          clearEdge(cells, r, c, cardinal.self);
          clearEdge(cells, nr, nc, cardinal.reciprocal);
          const oppCardinal = dirToCardinal({ x: -door.dir.x, y: -door.dir.y });
          if (oppCardinal) {
            clearEdge(cells, r, c, oppCardinal.self);
            clearEdge(cells, oppR, oppC, oppCardinal.reciprocal);
          }
          // Place door at internal subcell boundary
          setCenterDoor(cells, r, c, axis, wallVal);
        } else {
          // Dead-end passage — place on outer edge
          setEdge(cells, r, c, cardinal.self, wallVal);
          setEdge(cells, nr, nc, cardinal.reciprocal, wallVal);
        }
      } else {
        // Door on a room boundary (not a 1×1 passage cell)
        setEdge(cells, r, c, cardinal.self, wallVal);
        setEdge(cells, nr, nc, cardinal.reciprocal, wallVal);
      }
    }
  }

  // ── 7. Notes → room labels (letter + ref number, skip flavor text) ──
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

  // ── 8. Props (columns, archways, portcullis) → metadata.props[] ────
  const gridSize = 5 / RES; // internal gridSize = 2.5
  const props: any = [];
  let nextPropId = 1;

  function addProp(row: any, col: any, type: any, rotation = 0) {
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
  // At 2× scale, OPD corner (col.x, col.y) maps to internal grid point (r, c).
  // The 4 surrounding OPD cells are at subcell blocks, so we check
  // the subcells adjacent to the grid intersection.
  for (const col of (opd.columns || [])) {
    const r = toRow(col.y);
    const c = toCol(col.x);
    // At 2×, the grid intersection is at (r, c). The 4 OPD cells sharing
    // this corner have their nearest subcells at:
    //   NW = (r-1, c-1), NE = (r-1, c), SW = (r, c-1), SE = (r, c)
    const nw = cells[r - 1]?.[c - 1];
    const ne = cells[r - 1]?.[c];
    const sw = cells[r]?.[c - 1];
    const se = cells[r]?.[c];

    // All 4 subcells must be floor
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

    if (door.type === 2) {
      // Center the archway prop in the 2×2 block (offset 0.5 perpendicular to passage)
      if (rotation === 0) {
        // Horizontal archway (1×2): center vertically
        addProp(r + 0.5, c, 'archway', 0);
      } else {
        // Vertical archway (2×1): center horizontally
        addProp(r, c + 0.5, 'archway', 90);
      }
      // Place invisible door at center of 2×2 block for fog/BFS control
      const doorAxis = door.dir.x !== 0 ? 'ew' : 'ns';
      setCenterDoor(cells, r, c, doorAxis, 'id');
    } else if (door.type === 4) {
      addProp(r, c, 'portcullis', rotation);
    }
  }

  // ── 9. Water fills (each OPD water cell → 2×2 subcells) ────────────
  for (const w of (opd.water || [])) {
    for (let dy = 0; dy < (w.h || 1); dy++) {
      for (let dx = 0; dx < (w.w || 1); dx++) {
        const r = toRow((w.y || 0) + dy);
        const c = toCol((w.x || 0) + dx);
        // Fill all 4 subcells
        for (let sr = 0; sr < RES; sr++) {
          for (let sc = 0; sc < RES; sc++) {
            const cell = cells[r + sr]?.[c + sc];
            if (cell) {
              cell.fill = 'water';
              cell.waterDepth = 1;
            }
          }
        }
      }
    }
  }

  // ── 10. Rotunda trims (circular rooms) — via computeTrimCells ────
  for (const rect of opd.rects) {
    if (!rect.rotunda) continue;
    const topR = toRow(rect.y);
    const leftC = toCol(rect.x);
    const botR = toRow(rect.y + rect.h - 1) + (RES - 1); // bottom-right subcell
    const rightC = toCol(rect.x + rect.w - 1) + (RES - 1);
    const sz = Math.floor(Math.min(rect.w, rect.h) / 2) * RES;
    if (sz < RES) continue;

    // r0 = corner tip cell, matching the trim tool's dragStart convention
    const cornerDefs = [
      { cn: 'nw', r0: topR,  c0: leftC  },
      { cn: 'ne', r0: topR,  c0: rightC },
      { cn: 'sw', r0: botR,  c0: leftC  },
      { cn: 'se', r0: botR,  c0: rightC },
    ];

    for (const { cn, r0, c0 } of cornerDefs) {
      const far = sz - 1;

      // Build hypotenuse + voided (same geometry as the trim tool)
      const hypotenuse = [];
      for (let i = 0; i < sz; i++) {
        let hr, hc;
        switch (cn) {
          case 'nw': hr = r0 + far - i; hc = c0 + i; break;
          case 'ne': hr = r0 + far - i; hc = c0 - i; break;
          case 'sw': hr = r0 - far + i; hc = c0 + i; break;
          case 'se': hr = r0 - far + i; hc = c0 - i; break;
        }
        hypotenuse.push({ row: hr, col: hc });
      }

      let voided = [];
      for (let i = 1; i < sz; i++) {
        for (let j = 0; j < i; j++) {
          let vr, vc;
          switch (cn) {
            case 'nw': vr = r0 + far - i; vc = c0 + j; break;
            case 'ne': vr = r0 + far - i; vc = c0 - i + 1 + j; break;
            case 'sw': vr = r0 - far + i; vc = c0 + j; break;
            case 'se': vr = r0 - far + i; vc = c0 - i + 1 + j; break;
          }
          voided.push({ row: vr, col: vc });
        }
      }

      // Compute arcCenter (same logic as trim tool _updatePreview)
      const allRows = hypotenuse.map(c => c.row).concat(voided.map(c => c.row));
      const allCols = hypotenuse.map(c => c.col).concat(voided.map(c => c.col));
      let arcCenter = { row: r0, col: c0 };
      if (allRows.length > 0) {
        // @ts-expect-error — strict-mode migration
        const minR = Math.min(...allRows);
        // @ts-expect-error — strict-mode migration
        const maxR = Math.max(...allRows);
        // @ts-expect-error — strict-mode migration
        const minC = Math.min(...allCols);
        // @ts-expect-error — strict-mode migration
        const maxC = Math.max(...allCols);
        switch (cn) {
          case 'nw': arcCenter = { row: minR, col: minC }; break;
          case 'ne': arcCenter = { row: minR, col: maxC + 1 }; break;
          case 'sw': arcCenter = { row: maxR + 1, col: minC }; break;
          case 'se': arcCenter = { row: maxR + 1, col: maxC + 1 }; break;
        }
      }

      // Filter voided → insideArc (cells between diagonal and arc curve)
      const insideArc: any = [];
      // @ts-expect-error — strict-mode migration
      let acxGrid, acyGrid;
      switch (cn) {
        case 'nw': acxGrid = arcCenter.col + sz; acyGrid = arcCenter.row + sz; break;
        case 'ne': acxGrid = arcCenter.col - sz; acyGrid = arcCenter.row + sz; break;
        case 'sw': acxGrid = arcCenter.col + sz; acyGrid = arcCenter.row - sz; break;
        case 'se': acxGrid = arcCenter.col - sz; acyGrid = arcCenter.row - sz; break;
      }
      voided = voided.filter(({ row: vr, col: vc }) => {
        // @ts-expect-error — strict-mode migration
        const dx = Math.max(vc - acxGrid, 0, acxGrid - (vc + 1));
        // @ts-expect-error — strict-mode migration
        const dy = Math.max(vr - acyGrid, 0, acyGrid - (vr + 1));
        const outside = Math.sqrt(dx * dx + dy * dy) > sz;
        if (!outside) insideArc.push({ row: vr, col: vc });
        return outside;
      });

      // Build preview and compute per-cell trim data
      const preview = { hypotenuse, voided, insideArc, arcCenter, size: sz };
      // @ts-expect-error — strict-mode migration
      const trimData = computeTrimCells(preview, cn, false, false);

      // Apply trim data to cells
      for (const [key, val] of trimData) {
        const [r, c] = key.split(',').map(Number);
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;

        if (val === null) {
          // Void — but skip cells with doors (they connect to adjacent rooms)
          const vc = cells[r]?.[c];
          if (vc) {
            const hasDoor = ['north','south','east','west'].some(d => vc[d] === 'd' || vc[d] === 's');
            if (!hasDoor) cells[r][c] = null;
          }
        } else if (val === 'interior') {
          if (cells[r]?.[c]) _clearWalls(cells, r, c, rows, cols);
        } else {
          // Arc boundary cell
          if (!cells[r][c]) cells[r][c] = {};
          _clearWalls(cells, r, c, rows, cols);
          Object.assign(cells[r][c], val);
        }
      }
    }
  }

  // ── 11. Assemble dungeon JSON (v4 format — half-cell, per-cell arcs) ─
  const metadata = {
    formatVersion: FORMAT_VERSION,
    dungeonName: opd.title || 'Imported Dungeon',
    gridSize,
    resolution: RES,
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
    (metadata as any).stairs = stairs;
    (metadata as any).nextStairId = nextStairId;
  }

  return { metadata, cells };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const OFFS = { north: [-1, 0], south: [1, 0], west: [0, -1], east: [0, 1] };
const OPP  = { north: 'south', south: 'north', west: 'east', east: 'west' };

/** Clear cardinal walls on cell + reciprocals, preserving doors. */
function _clearWalls(cells: any, r: any, c: any, numRows: any, numCols: any) {
  const cell = cells[r]?.[c];
  if (!cell) return;
  for (const dir of ['north', 'south', 'east', 'west']) {
    if (cell[dir] && cell[dir] !== 'd' && cell[dir] !== 's') {
      delete cell[dir];
      const [dr, dc] = (OFFS as any)[dir];
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < numRows && nc >= 0 && nc < numCols) {
        const nb = cells[nr]?.[nc];
        if (nb && nb[(OPP as any)[dir]] !== 'd' && nb[(OPP as any)[dir]] !== 's') delete nb[(OPP as any)[dir]];
      }
    }
  }
  delete cell['nw-se'];
  delete cell['ne-sw'];
}
