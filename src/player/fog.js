// Fog of war: cell filtering for the player view.
import { cellKey } from '../util/index.js';
import { classifyStairShape, getOccupiedCells } from '../editor/js/index.js';

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

      // Exterior-only trimRound: if none of the interior-facing neighbors are revealed,
      // the cell was reached from the exterior side only. Flag it so renderFloors skips
      // the primary (interior-face) floor fill, leaving the canvas black. The arc
      // secondary post-pass still draws the void-corner (exterior) texture correctly.
      if (pc.trimRound && pc.trimCorner) {
        const INTERIOR_OFFSETS = {
          nw: [{ dr: 1, dc: 0 }, { dr: 0, dc: 1 }],
          ne: [{ dr: 1, dc: 0 }, { dr: 0, dc: -1 }],
          sw: [{ dr: -1, dc: 0 }, { dr: 0, dc: 1 }],
          se: [{ dr: -1, dc: 0 }, { dr: 0, dc: -1 }],
        };
        const offsets = INTERIOR_OFFSETS[pc.trimCorner];
        if (offsets) {
          const interiorRevealed = offsets.some(({ dr, dc }) =>
            revealedCells.has(cellKey(r + dr, c + dc))
          );
          if (!interiorRevealed) {
            pc.trimShowExteriorOnly = true;

            // Synthesize textureSecondary from an exterior-direction neighbor so the
            // arc secondary post-pass can draw terrain in the void-corner.
            // trimRound cells often don't have textureSecondary set; we inherit the
            // primary texture of the nearest revealed exterior cell instead.
            if (!pc.textureSecondary) {
              const EXTERIOR_DIRS = {
                nw: [{ dr: -1, dc: 0 }, { dr: 0, dc: -1 }],
                ne: [{ dr: -1, dc: 0 }, { dr: 0, dc:  1 }],
                sw: [{ dr:  1, dc: 0 }, { dr: 0, dc: -1 }],
                se: [{ dr:  1, dc: 0 }, { dr: 0, dc:  1 }],
              };
              const maxSteps = (pc.trimArcRadius ?? 3) + 1;
              outer: for (const { dr, dc } of EXTERIOR_DIRS[pc.trimCorner] ?? []) {
                for (let k = 1; k <= maxSteps; k++) {
                  const nr = r + dr * k, nc = c + dc * k;
                  const neighbor = cells[nr]?.[nc];
                  if (neighbor?.texture && revealedCells.has(cellKey(nr, nc))) {
                    pc.textureSecondary = neighbor.texture;
                    pc.textureSecondaryOpacity = neighbor.textureOpacity ?? 1.0;
                    break outer;
                  }
                }
              }
            }
          }
        }

        // Interior-only: if interior IS revealed but exterior terrain near the
        // arc center is NOT, flag the cell so the rounded corner pass skips the
        // entire wedge texture fill (including non-trimRound cells in the bbox).
        // Check cells diagonally outside the arc center — these are definitively
        // outside the building and represent the exterior terrain.
        if (!pc.trimShowExteriorOnly) {
          const EXTERIOR_DIAG = {
            nw: [{ dr: -1, dc: -1 }, { dr: -1, dc: 0 }, { dr: 0, dc: -1 }],
            ne: [{ dr: -1, dc:  1 }, { dr: -1, dc: 0 }, { dr: 0, dc:  1 }],
            sw: [{ dr:  1, dc: -1 }, { dr:  1, dc: 0 }, { dr: 0, dc: -1 }],
            se: [{ dr:  1, dc:  1 }, { dr:  1, dc: 0 }, { dr: 0, dc:  1 }],
          };
          let exteriorRevealed = false;
          for (const { dr, dc } of EXTERIOR_DIAG[pc.trimCorner] ?? []) {
            const er = pc.trimArcCenterRow + dr;
            const ec = pc.trimArcCenterCol + dc;
            if (er >= 0 && er < numRows && ec >= 0 && ec < numCols) {
              const extCell = cells[er]?.[ec];
              if (extCell) {
                exteriorRevealed = revealedCells.has(cellKey(er, ec));
                break;
              }
            }
          }
          if (!exteriorRevealed) {
            pc.trimHideExterior = true;
          }
        }
      }

      row.push(pc);
    }
    playerCells.push(row);
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
