// Fog of war: cell filtering for the player view.
import { cellKey } from '../util/index.js';
import { classifyStairShape, getOccupiedCells } from '../editor/js/index.js';

// Which neighbors are on the exterior side for each trimCorner.
// Includes cardinal + the corner diagonal to handle large arcs where
// cardinals traverse 3+ trim cells before reaching a non-trim cell.
const _EXTERIOR_DIRS = {
  nw: [[-1, 0], [0, -1], [-1, -1]],  // north, west, nw diagonal
  ne: [[-1, 0], [0,  1], [-1,  1]],  // north, east, ne diagonal
  sw: [[ 1, 0], [0, -1], [ 1, -1]],  // south, west, sw diagonal
  se: [[ 1, 0], [0,  1], [ 1,  1]],  // south, east, se diagonal
};
const _INTERIOR_DIRS = {
  nw: [[ 1, 0], [0,  1], [ 1,  1]],  // south, east, se diagonal
  ne: [[ 1, 0], [0, -1], [ 1, -1]],  // south, west, sw diagonal
  sw: [[-1, 0], [0,  1], [-1,  1]],  // north, east, ne diagonal
  se: [[-1, 0], [0, -1], [-1, -1]],  // north, west, nw diagonal
};

/**
 * Ray-casting point-in-polygon test.
 */
function _pip(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Check whether a direction exits through the interior (trimClip) side
 * of the cell.  Used to validate direction-array candidates against the
 * actual arc geometry.
 */
function _exitsInterior(dr, dc, clip) {
  // Exit point on cell boundary, nudged toward center to avoid edge ambiguity
  const px = (dc + 1) / 2 * 0.96 + 0.02;
  const py = (dr + 1) / 2 * 0.96 + 0.02;
  return _pip(px, py, clip);
}

/**
 * Classify all trim cells in a revealed set.
 *
 * For each trim cell, direction arrays (based on trimCorner) provide candidate
 * search directions for the interior and exterior sides.  Each candidate is
 * validated against the cell's trimClip polygon — if the exit point lands on
 * the wrong side of the arc wall, the direction is skipped.  This handles
 * inverted arcs where the fixed direction mapping can be inaccurate.
 *
 * Returns a Map of "r,c" → 'roomOnly' | 'exteriorOnly' | 'both'.
 */
export function classifyAllTrimFog(revealedCells, cells) {
  const results = new Map();

  for (const key of revealedCells) {
    const [r, c] = key.split(',').map(Number);
    const cell = cells[r]?.[c];
    if (!cell?.trimClip || !cell.trimCorner) continue;

    const clip = cell.trimClip;

    // Check 1–2 cells out in each direction for a non-trim revealed cell.
    // Each direction is validated against the trimClip polygon to ensure it
    // exits on the expected side of the arc wall.
    const _sideRevealed = (dirs, wantInterior) => {
      for (const [dr, dc] of dirs) {
        // Validate: does this direction actually exit on the expected side?
        const isInterior = _exitsInterior(dr, dc, clip);
        if (isInterior !== wantInterior) continue;

        for (let dist = 1; dist <= 2; dist++) {
          const nr = r + dr * dist, nc = c + dc * dist;
          const neighbor = cells[nr]?.[nc];
          if (!neighbor) break; // void or out of bounds
          if (!neighbor.trimClip) {
            if (revealedCells.has(cellKey(nr, nc))) return true;
            break; // non-trim but not revealed
          }
          // Intermediate trim cell: verify the direction still exits on the
          // expected side.  Large/inverted arcs can curve so that a direction
          // that starts on the exterior flips to interior at the next cell.
          if (_exitsInterior(dr, dc, neighbor.trimClip) !== wantInterior) break;
        }
      }
      return false;
    };

    const extRevealed = _sideRevealed(_EXTERIOR_DIRS[cell.trimCorner], false);
    const intRevealed = _sideRevealed(_INTERIOR_DIRS[cell.trimCorner], true);

    if (intRevealed && extRevealed) results.set(key, 'both');
    else if (intRevealed) results.set(key, 'roomOnly');
    else if (extRevealed) results.set(key, 'exteriorOnly');
  }

  return results;
}

/**
 * Build a filtered cells array for the player view.
 * - Unrevealed cells → null (void — renderer skips them, hatching handles edges)
 * - Secret doors → 'w' (wall) unless the door was opened
 * - Room labels stripped from all cells
 */
export function buildPlayerCells(dungeon, revealedCells, openedDoors) {
  const cells = dungeon.cells;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const playerCells = [];

  // Build a set of opened door keys for fast lookup (include both sides of cardinal doors)
  const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
  const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
  const openedSet = new Set();
  for (const d of openedDoors) {
    openedSet.add(`${d.row},${d.col},${d.dir}`);
    // Add the mirror key for the adjacent cell's side
    if (OFFSETS[d.dir]) {
      const [dr, dc] = OFFSETS[d.dir];
      openedSet.add(`${d.row + dr},${d.col + dc},${OPPOSITE[d.dir]}`);
    }
  }

  for (let r = 0; r < numRows; r++) {
    const row = [];
    for (let c = 0; c < numCols; c++) {
      const key = cellKey(r, c);
      if (!revealedCells.has(key)) {
        row.push(null);
        continue;
      }

      const cell = cells[r]?.[c];
      if (!cell) { row.push(null); continue; }

      // Deep clone
      const pc = JSON.parse(JSON.stringify(cell));

      // Strip room labels, DM labels, and their position overrides
      if (pc.center?.label) delete pc.center.label;
      if (pc.center?.dmLabel) delete pc.center.dmLabel;
      delete pc.center?.labelX;
      delete pc.center?.labelY;
      delete pc.center?.dmLabelX;
      delete pc.center?.dmLabelY;
      if (pc.center && Object.keys(pc.center).length === 0) delete pc.center;

      // Secret doors: unopened → wall, opened → normal door
      // Invisible walls/doors: always stripped — players never see them
      for (const dir of ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw']) {
        if (pc[dir] === 's') {
          if (openedSet.has(`${r},${c},${dir}`)) {
            pc[dir] = 'd'; // render as normal door
          } else {
            pc[dir] = 'w'; // hide as wall
          }
        } else if (pc[dir] === 'iw' || pc[dir] === 'id') {
          delete pc[dir]; // invisible to players — no wall, no door symbol
        }
      }

      row.push(pc);
    }
    playerCells.push(row);
  }

  // ── Trim fog flags: hide exterior/interior of arc boundary cells ──
  // When only one side of a circular arc boundary is revealed, set flags
  // so the renderer only draws that side's floor/texture.
  const trimSides = classifyAllTrimFog(revealedCells, cells);
  for (const [key, side] of trimSides) {
    const [r, c] = key.split(',').map(Number);
    const pc = playerCells[r]?.[c];
    if (!pc) continue;
    if (side === 'roomOnly') pc.trimHideExterior = true;
    else if (side === 'exteriorOnly') pc.trimShowExteriorOnly = true;
  }

  return playerCells;
}

/**
 * Filter metadata.stairs for the player view:
 * - Only include stairs with at least one occupied cell revealed (hatching visible)
 * - For stairs not in openedStairIds, strip the link label (set link: null)
 */
export function filterBridgesForPlayer(bridges, revealedCells) {
  if (!bridges || bridges.length === 0) return [];
  return bridges.filter(bridge =>
    bridge.points.some(([row, col]) => revealedCells.has(cellKey(row, col)))
  );
}

export function filterPropsForPlayer(props, revealedCells, gridSize, propCatalog) {
  if (!props || props.length === 0) return [];
  return props.filter(prop => {
    const col = Math.floor(prop.x / gridSize);
    const row = Math.floor(prop.y / gridSize);
    const propDef = propCatalog?.props?.[prop.type];
    if (!propDef) return false;

    const [fRows, fCols] = propDef.footprint;
    const r = (((prop.rotation ?? 0) % 360) + 360) % 360;
    const eRows = (r === 90 || r === 270) ? fCols : fRows;
    const eCols = (r === 90 || r === 270) ? fRows : fCols;

    for (let dr = 0; dr < eRows; dr++) {
      for (let dc = 0; dc < eCols; dc++) {
        if (revealedCells.has(cellKey(row + dr, col + dc))) return true;
      }
    }
    return false;
  });
}

export function filterStairsForPlayer(stairs, revealedCells, openedStairIds) {
  if (!stairs || stairs.length === 0) return [];

  const openedSet = new Set(openedStairIds);

  return stairs
    .filter(stair => {
      const shape = classifyStairShape(stair.points[0], stair.points[1], stair.points[2]);
      const cells = getOccupiedCells(shape.vertices);
      return cells.some(({ row, col }) => revealedCells.has(cellKey(row, col)));
    })
    .map(stair => {
      if (openedSet.has(stair.id)) return stair;
      return { ...stair, link: null };
    });
}
