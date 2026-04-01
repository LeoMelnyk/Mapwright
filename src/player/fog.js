// Fog of war: cell filtering for the player view.
import { cellKey } from '../util/index.js';
import { classifyStairShape, getOccupiedCells } from '../editor/js/index.js';

// Which cardinal neighbors are on the exterior side for each trimCorner
const _EXTERIOR_DIRS = {
  nw: [[-1, 0], [0, -1]],  // north, west
  ne: [[-1, 0], [0,  1]],  // north, east
  sw: [[ 1, 0], [0, -1]],  // south, west
  se: [[ 1, 0], [0,  1]],  // south, east
};
const _INTERIOR_DIRS = {
  nw: [[ 1, 0], [0,  1]],  // south, east
  ne: [[ 1, 0], [0, -1]],  // south, west
  sw: [[-1, 0], [0,  1]],  // north, east
  se: [[-1, 0], [0, -1]],  // north, west
};

/**
 * Classify all trim cells in a revealed set.
 * Uses trimCorner to determine which neighbors are exterior vs interior.
 * Returns a Map of "r,c" → 'roomOnly' | 'exteriorOnly' | 'both'.
 */
export function classifyAllTrimFog(revealedCells, cells) {
  const results = new Map();

  for (const key of revealedCells) {
    const [r, c] = key.split(',').map(Number);
    const cell = cells[r]?.[c];
    if (!cell?.trimClip || !cell.trimCorner) continue;

    // Check 1–2 cells out in each direction for a non-trim revealed cell.
    // Limited to 2 cells to avoid crossing through the arc boundary and
    // finding revealed cells on the opposite side of the circle.
    const _sideRevealed = (dirs) => {
      for (const [dr, dc] of dirs) {
        for (let dist = 1; dist <= 2; dist++) {
          const nr = r + dr * dist, nc = c + dc * dist;
          const neighbor = cells[nr]?.[nc];
          if (!neighbor) break; // void or out of bounds — try next direction
          if (!neighbor.trimClip) {
            if (revealedCells.has(cellKey(nr, nc))) return true;
            break; // non-trim but not revealed — try next direction
          }
        }
      }
      return false;
    };

    const extRevealed = _sideRevealed(_EXTERIOR_DIRS[cell.trimCorner]);
    const intRevealed = _sideRevealed(_INTERIOR_DIRS[cell.trimCorner]);

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
