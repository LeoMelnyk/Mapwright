// Fog of war: cell filtering for the player view.
import { cellKey, CARDINAL_OFFSETS } from '../util/index.js';
import { classifyStairShape, getOccupiedCells } from '../editor/js/index.js';
import type { Dungeon, Cell, CellGrid, Stairs, Bridge, OverlayProp, PropCatalog } from '../types.js';
import type { OpenedDoor } from './player-state.js';

type TrimCorner = 'nw' | 'ne' | 'sw' | 'se';
type TrimFogClass = 'roomOnly' | 'exteriorOnly' | 'both';

// Which neighbors are on the exterior side for each trimCorner.
// Includes cardinal + the corner diagonal to handle large arcs where
// cardinals traverse 3+ trim cells before reaching a non-trim cell.
const _EXTERIOR_DIRS: Record<TrimCorner, [number, number][]> = {
  nw: [
    [-1, 0],
    [0, -1],
    [-1, -1],
  ], // north, west, nw diagonal
  ne: [
    [-1, 0],
    [0, 1],
    [-1, 1],
  ], // north, east, ne diagonal
  sw: [
    [1, 0],
    [0, -1],
    [1, -1],
  ], // south, west, sw diagonal
  se: [
    [1, 0],
    [0, 1],
    [1, 1],
  ], // south, east, se diagonal
};
const _INTERIOR_DIRS: Record<TrimCorner, [number, number][]> = {
  nw: [
    [1, 0],
    [0, 1],
    [1, 1],
  ], // south, east, se diagonal
  ne: [
    [1, 0],
    [0, -1],
    [1, -1],
  ], // south, west, sw diagonal
  sw: [
    [-1, 0],
    [0, 1],
    [-1, 1],
  ], // north, east, ne diagonal
  se: [
    [-1, 0],
    [0, -1],
    [-1, -1],
  ], // north, west, nw diagonal
};

/**
 * Ray-casting point-in-polygon test.
 */
function _pip(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!,
      [xj, yj] = poly[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
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
function _exitsInterior(dr: number, dc: number, clip: [number, number][]): boolean {
  // Exit point on cell boundary, nudged toward center to avoid edge ambiguity
  const px = ((dc + 1) / 2) * 0.96 + 0.02;
  const py = ((dr + 1) / 2) * 0.96 + 0.02;
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
export function classifyAllTrimFog(revealedCells: Set<string>, cells: CellGrid): Map<string, TrimFogClass> {
  const results = new Map<string, TrimFogClass>();

  for (const key of revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    const cell = cells[r]?.[c] as (Cell & { trimClip?: [number, number][]; trimCorner?: TrimCorner }) | null;
    if (!cell?.trimClip || !cell.trimCorner) continue;

    const clip = cell.trimClip;

    // Check 1–2 cells out in each direction for a non-trim revealed cell.
    // Each direction is validated against the trimClip polygon to ensure it
    // exits on the expected side of the arc wall.
    const _sideRevealed = (dirs: [number, number][], wantInterior: boolean): boolean => {
      for (const [dr, dc] of dirs) {
        // Validate: does this direction actually exit on the expected side?
        const isInterior = _exitsInterior(dr, dc, clip);
        if (isInterior !== wantInterior) continue;

        for (let dist = 1; dist <= 2; dist++) {
          const nr = r + dr * dist,
            nc = c + dc * dist;
          const neighbor = cells[nr]?.[nc] as (Cell & { trimClip?: [number, number][] }) | null;
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
export function buildPlayerCells(dungeon: Dungeon, revealedCells: Set<string>, openedDoors: OpenedDoor[]): CellGrid {
  const cells = dungeon.cells;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const playerCells: CellGrid = [];

  // Build a set of opened door keys for fast lookup (include both sides of cardinal doors)
  const OPPOSITE: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
  const openedSet = new Set<string>();
  for (const d of openedDoors) {
    openedSet.add(`${d.row},${d.col},${d.dir}`);
    // Add the mirror key for the adjacent cell's side
    const off = (CARDINAL_OFFSETS as Record<string, readonly [number, number] | undefined>)[d.dir];
    if (off) {
      const [dr, dc] = off;
      openedSet.add(`${d.row + dr},${d.col + dc},${OPPOSITE[d.dir]}`);
    }
  }

  for (let r = 0; r < numRows; r++) {
    const row: (Cell | null)[] = [];
    for (let c = 0; c < numCols; c++) {
      const key = cellKey(r, c);
      if (!revealedCells.has(key)) {
        row.push(null);
        continue;
      }

      const cell = cells[r]?.[c];
      if (!cell) {
        row.push(null);
        continue;
      }

      // Deep clone
      const pc: Record<string, unknown> = JSON.parse(JSON.stringify(cell));

      // Strip room labels, DM labels, and their position overrides
      const center = pc.center as Record<string, unknown> | undefined;
      if (center?.label) delete center.label;
      if (center?.dmLabel) delete center.dmLabel;
      delete center?.labelX;
      delete center?.labelY;
      delete center?.dmLabelX;
      delete center?.dmLabelY;
      if (center && Object.keys(center).length === 0) delete pc.center;

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

      row.push(pc as unknown as Cell);
    }
    playerCells.push(row);
  }

  // ── Trim fog flags: hide exterior/interior of arc boundary cells ──
  // When only one side of a circular arc boundary is revealed, set flags
  // so the renderer only draws that side's floor/texture.
  const trimSides = classifyAllTrimFog(revealedCells, cells);
  for (const [key, side] of trimSides) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    const pc = playerCells[r]?.[c] as Record<string, unknown> | null;
    if (!pc) continue;
    if (side === 'roomOnly') pc.trimHideExterior = true;
    else if (side === 'exteriorOnly') pc.trimShowExteriorOnly = true;
  }

  // ── Open diagonal trims: strip walls on the unrevealed side ──
  // When only one side of a diagonal wall is revealed, remove cardinal
  // walls on the unrevealed side so they don't render through the fog.
  for (const key of revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    const pc = playerCells[r]?.[c] as Record<string, unknown> | null;
    if (!pc || pc.trimCorner || pc.trimClip) continue;
    const hasNWSE = !!pc['nw-se'];
    const hasNESW = !!pc['ne-sw'];
    if (!hasNWSE && !hasNESW) continue;

    // Determine which side's neighbors are revealed
    // nw-se diagonal: sideA=NE (north,east), sideB=SW (south,west)
    // ne-sw diagonal: sideA=NW (north,west), sideB=SE (south,east)
    let sideARevealed: boolean, sideBRevealed: boolean;
    if (hasNWSE) {
      sideARevealed = revealedCells.has(cellKey(r - 1, c)) || revealedCells.has(cellKey(r, c + 1));
      sideBRevealed = revealedCells.has(cellKey(r + 1, c)) || revealedCells.has(cellKey(r, c - 1));
    } else {
      sideARevealed = revealedCells.has(cellKey(r - 1, c)) || revealedCells.has(cellKey(r, c - 1));
      sideBRevealed = revealedCells.has(cellKey(r + 1, c)) || revealedCells.has(cellKey(r, c + 1));
    }
    if (sideARevealed && sideBRevealed) continue;
    if (!sideARevealed && !sideBRevealed) continue;

    // Strip walls on the unrevealed side
    if (hasNWSE) {
      // NE side walls: north, east; SW side walls: south, west
      if (!sideARevealed) {
        delete pc.north;
        delete pc.east;
      } else {
        delete pc.south;
        delete pc.west;
      }
    } else {
      // NW side walls: north, west; SE side walls: south, east
      if (!sideARevealed) {
        delete pc.north;
        delete pc.west;
      } else {
        delete pc.south;
        delete pc.east;
      }
    }
  }

  return playerCells;
}

/**
 * Filter metadata.stairs for the player view:
 * - Only include stairs with at least one occupied cell revealed (hatching visible)
 * - For stairs not in openedStairIds, strip the link label (set link: null)
 */
export function filterBridgesForPlayer(bridges: Bridge[] | undefined, revealedCells: Set<string>): Bridge[] {
  if (!bridges || bridges.length === 0) return [];
  return bridges.filter((bridge) => bridge.points.some(([row, col]) => revealedCells.has(cellKey(row, col))));
}

export function filterPropsForPlayer(
  props: OverlayProp[] | undefined,
  revealedCells: Set<string>,
  gridSize: number,
  propCatalog: PropCatalog | null,
): OverlayProp[] {
  if (!props || props.length === 0) return [];
  return props.filter((prop) => {
    const col = Math.floor(prop.x / gridSize);
    const row = Math.floor(prop.y / gridSize);
    const propDef = propCatalog?.props[prop.type];
    if (!propDef) return false;

    const [fRows, fCols] = propDef.footprint;
    const r = ((prop.rotation % 360) + 360) % 360;
    const eRows = r === 90 || r === 270 ? fCols : fRows;
    const eCols = r === 90 || r === 270 ? fRows : fCols;

    for (let dr = 0; dr < eRows; dr++) {
      for (let dc = 0; dc < eCols; dc++) {
        if (revealedCells.has(cellKey(row + dr, col + dc))) return true;
      }
    }
    return false;
  });
}

export function filterStairsForPlayer(
  stairs: Stairs[] | undefined,
  revealedCells: Set<string>,
  openedStairIds: number[],
): Stairs[] {
  if (!stairs || stairs.length === 0) return [];

  const openedSet = new Set(openedStairIds);

  return stairs
    .filter((stair) => {
      const shape = classifyStairShape(stair.points[0], stair.points[1], stair.points[2]);
      const cells = getOccupiedCells(shape.vertices);
      return cells.some(({ row, col }: { row: number; col: number }) => revealedCells.has(cellKey(row, col)));
    })
    .map((stair) => {
      if (openedSet.has(stair.id)) return stair;
      return { ...stair, link: null };
    });
}
