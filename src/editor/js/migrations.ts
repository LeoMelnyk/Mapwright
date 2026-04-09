import type { CellGrid } from '../../types.js';

/** Loose dungeon JSON shape for migrations (fields may be absent in older formats). */
interface MigrationJson {
  metadata: Record<string, unknown> & { formatVersion?: number; gridSize?: number; props?: unknown[]; nextPropId?: number; levels?: unknown[]; bridges?: unknown[]; stairs?: unknown[] };
  cells: CellGrid;
  [key: string]: unknown;
}
// Format versioning and migration registry for .mapwright save files.

import { migrateHalfTextures } from './io.js';
import { computeCircleCenter, computeArcCellData, computeTrimCrossing } from '../../util/trim-geometry.js';

export const CURRENT_FORMAT_VERSION = 4;

// Migration registry: each entry upgrades from one version to the next.
// Migrations are applied in sequence: 0→1, 1→2, etc.
const migrations = [
  // v0 → v1: half-texture format migration (pre-existing logic from io.js)
  { from: 0, to: 1, migrate: (json: MigrationJson) => (migrateHalfTextures as (j: unknown) => void)(json) },
  // v1 → v2: extract cell.prop entries into metadata.props[] overlay array
  { from: 1, to: 2, migrate: (json: MigrationJson) => migratePropsToOverlay(json) },
  // v2 → v3: double grid resolution (half-cell coordinates)
  { from: 2, to: 3, migrate: (json: MigrationJson) => migrateToHalfCell(json) },
  // v3 → v4: convert old arc trim format to per-cell trimClip/trimWall/trimPassable
  { from: 3, to: 4, migrate: (json: MigrationJson) => _migrateArcToPerCell(json.cells) },
];

/**
 * Extract all cell.prop entries into metadata.props[] overlay format.
 * Cell.prop entries are deleted after copying — the overlay is the sole source of truth.
 */
function migratePropsToOverlay(json: MigrationJson) {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
  if (!json.metadata) return;
  if (json.metadata.props) return; // already migrated

  json.metadata.props = [];
  json.metadata.nextPropId ??= 1;
  const gridSize = json.metadata.gridSize ?? 5;

  for (let row = 0; row < json.cells.length; row++) {
    const rowArr = json.cells[row];
    if (!rowArr) continue; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- legacy data
    for (let col = 0; col < rowArr.length; col++) {
      const cell = rowArr[col];
      if (!cell?.prop) continue;

      json.metadata.props.push({
        id: `prop_${json.metadata.nextPropId++}`,
        type: cell.prop.type,
        x: col * gridSize,
        y: row * gridSize,
        rotation: cell.prop.facing || 0,
        scale: 1.0,
        zIndex: 10, // default "furniture" layer
        flipped: !!cell.prop.flipped,
      });

      delete cell.prop;
    }
  }
}

// ── v2 → v3: Half-cell resolution ──────────────────────────────────────────
//
// Doubles the grid in both dimensions.  Each old cell (r, c) becomes four
// sub-cells:   TL = (r*2, c*2)      TR = (r*2, c*2+1)
//              BL = (r*2+1, c*2)    BR = (r*2+1, c*2+1)
//
// World-feet coordinates are stable: gridSize is halved, so
//   col_new * gridSize_new = (col*2) * (gridSize/2) = col * gridSize.
// Props and lights (stored in world-feet) need no changes.

/** Properties replicated to all 4 sub-cells (floor appearance). */
const REPLICATE_KEYS = ['fill', 'texture', 'textureSecondary', 'waterDepth', 'lavaDepth', 'hazard'];

function migrateToHalfCell(json: MigrationJson) {
  const { metadata, cells } = json;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
  if (!metadata || !cells || cells.length === 0) return;

  const oldRows = cells.length;
  const oldCols = cells[0]?.length || 0;
  const newRows = oldRows * 2;
  const newCols = oldCols * 2;

  // Build new empty grid
  const newCells = [];
  for (let r = 0; r < newRows; r++) {
    const row = new Array(newCols).fill(null);
    newCells.push(row);
  }

  // Process each old cell
  let _trimVoidCount = 0;
  for (let r = 0; r < oldRows; r++) {
    for (let c = 0; c < oldCols; c++) {
      const cell = cells[r]?.[c];
      if (!cell) continue;

      const nr = r * 2, nc = c * 2;  // top-left sub-cell coords

      // Create the 4 sub-cells with replicated appearance properties
      const base = {};
      for (const key of REPLICATE_KEYS) {
        // Legacy format migration — access non-edge cell properties by dynamic key
        const val = (cell as Record<string, unknown>)[key];
        if (val !== undefined && val !== null) {
          // Deep-copy objects (texture), shallow-copy primitives
          (base as Record<string, unknown>)[key] = typeof val === 'object' ? JSON.parse(JSON.stringify(val)) : val;
        }
      }

      const tl = { ...JSON.parse(JSON.stringify(base)) };
      const tr = { ...JSON.parse(JSON.stringify(base)) };
      const bl = { ...JSON.parse(JSON.stringify(base)) };
      const br = { ...JSON.parse(JSON.stringify(base)) };

      // ── Outer walls / doors ──
      // North edge of old cell → north edge of TL and TR
      if (cell.north) { tl.north = cell.north; tr.north = cell.north; }
      // South edge of old cell → south edge of BL and BR
      if (cell.south) { bl.south = cell.south; br.south = cell.south; }
      // West edge of old cell → west edge of TL and BL
      if (cell.west)  { tl.west = cell.west;  bl.west = cell.west; }
      // East edge of old cell → east edge of TR and BR
      if (cell.east)  { tr.east = cell.east;  br.east = cell.east; }

      // ── Diagonal walls + Trim ──
      if (cell.trimCorner && !cell.trimRound && !cell.trimInsideArc) {
        // Straight trim hypotenuse: the diagonal cuts the cell into void + floor triangles.
        // One sub-cell is entirely void, two get the diagonal, one is entirely floor.
        //   NW corner (ne-sw): void=TL, diag=TR+BL, floor=BR
        //   NE corner (nw-se): void=TR, diag=TL+BR, floor=BL
        //   SW corner (nw-se): void=BL, diag=TL+BR, floor=TR
        //   SE corner (ne-sw): void=BR, diag=TR+BL, floor=TL
        const corner = cell.trimCorner;
        const diagType = (corner === 'nw' || corner === 'se') ? 'ne-sw' : 'nw-se';
        const diagVal = cell[diagType] ?? 'w';

        // Mark the corner sub-cell for voiding (applied after cell assignment below)
        if (corner === 'nw') { tl._void = true; _trimVoidCount++; }
        else if (corner === 'ne') { tr._void = true; _trimVoidCount++; }
        else if (corner === 'sw') { bl._void = true; _trimVoidCount++; }
        else { br._void = true; _trimVoidCount++; }

        // Set diagonal + trimCorner on the two diagonal sub-cells
        const diagCells = diagType === 'ne-sw' ? [tr, bl] : [tl, br];
        for (const dc of diagCells) {
          dc[diagType] = diagVal;
          dc.trimCorner = corner;
          if (cell.trimOpen) dc.trimOpen = true;
        }
      } else if (cell.trimRound) {
        // Round trim: skip diagonal replication (arc wall rendered from metadata).
        // Set trim properties on the corner sub-cell.
        const target =
          cell.trimCorner === 'nw' ? tl :
          cell.trimCorner === 'ne' ? tr :
          cell.trimCorner === 'sw' ? bl : br;
        target.trimCorner = cell.trimCorner;
        target.trimRound = true;
        if (cell.trimOpen) target.trimOpen = true;
        if (cell.trimArcInverted) target.trimArcInverted = true;
        if (cell.trimInsideArc) target.trimInsideArc = true;
        if (cell.trimArcCenterRow != null) {
          target.trimArcCenterRow = (cell.trimArcCenterRow) * 2;
          target.trimArcCenterCol = (cell.trimArcCenterCol as number) * 2;
          target.trimArcRadius = (cell.trimArcRadius as number) * 2;
        }
      } else if (cell.trimInsideArc) {
        // InsideArc cells are full floor cells — just propagate metadata to all sub-cells.
        // Do NOT treat as straight trims (no voiding, no diagonal walls).
        for (const sub of [tl, tr, bl, br]) {
          sub.trimInsideArc = true;
          sub.trimCorner = cell.trimCorner;
          if (cell.trimArcInverted) sub.trimArcInverted = true;
          if (cell.trimArcCenterRow != null) {
            sub.trimArcCenterRow = (cell.trimArcCenterRow) * 2;
            sub.trimArcCenterCol = (cell.trimArcCenterCol as number) * 2;
            sub.trimArcRadius = (cell.trimArcRadius as number) * 2;
          }
        }
      } else {
        // Non-trim diagonals: check if the cell is a trim hypotenuse (adjacent to void)
        // even without trimCorner — the old trim tool didn't always set trimCorner.
        const isVoid = (vr: number, vc: number) => vr < 0 || vr >= oldRows || vc < 0 || vc >= oldCols || !cells[vr][vc];
        let inferredCorner = null;
        if (cell['ne-sw']) {
          if (isVoid(r - 1, c) && isVoid(r, c - 1)) inferredCorner = 'nw';
          else if (isVoid(r + 1, c) && isVoid(r, c + 1)) inferredCorner = 'se';
        }
        if (cell['nw-se']) {
          if (isVoid(r - 1, c) && isVoid(r, c + 1)) inferredCorner = 'ne';
          else if (isVoid(r + 1, c) && isVoid(r, c - 1)) inferredCorner = 'sw';
        }

        if (inferredCorner) {
          // Treat as straight trim: void the corner sub-cell, set diagonal on the other two
          const diagType = (inferredCorner === 'nw' || inferredCorner === 'se') ? 'ne-sw' : 'nw-se';
          const diagVal = cell[diagType] ?? 'w';
          if (inferredCorner === 'nw') { tl._void = true; _trimVoidCount++; }
          else if (inferredCorner === 'ne') { tr._void = true; _trimVoidCount++; }
          else if (inferredCorner === 'sw') { bl._void = true; _trimVoidCount++; }
          else { br._void = true; _trimVoidCount++; }
          const diagCells = diagType === 'ne-sw' ? [tr, bl] : [tl, br];
          for (const dc of diagCells) {
            dc[diagType] = diagVal;
            dc.trimCorner = inferredCorner; // needed for triangular floor/lighting clipping
          }
        } else {
          // Regular diagonal (not adjacent to void): replicate to sub-cells
          if (cell['nw-se']) {
            tl['nw-se'] = cell['nw-se'];
            br['nw-se'] = cell['nw-se'];
          }
          if (cell['ne-sw']) {
            tr['ne-sw'] = cell['ne-sw'];
            bl['ne-sw'] = cell['ne-sw'];
          }
        }
      }
      // Non-corner trim flags (trimRound/trimInsideArc without trimCorner)
      if (!cell.trimCorner) {
        if (cell.trimRound) { tl.trimRound = true; tr.trimRound = true; bl.trimRound = true; br.trimRound = true; }
        if (cell.trimOpen) { tl.trimOpen = true; tr.trimOpen = true; bl.trimOpen = true; br.trimOpen = true; }
        if (cell.trimInsideArc) { tl.trimInsideArc = true; tr.trimInsideArc = true; bl.trimInsideArc = true; br.trimInsideArc = true; }
        if (cell.trimArcInverted) { tl.trimArcInverted = true; tr.trimArcInverted = true; bl.trimArcInverted = true; br.trimArcInverted = true; }
        if (cell.trimArcCenterRow != null) {
          for (const sub of [tl, tr, bl, br]) {
            sub.trimArcCenterRow = (cell.trimArcCenterRow) * 2;
            sub.trimArcCenterCol = (cell.trimArcCenterCol as number) * 2;
            sub.trimArcRadius = (cell.trimArcRadius as number) * 2;
          }
        }
      }

      // ── Labels ──
      // Place label on TL sub-cell (center of original cell maps closest to this)
      if (cell.center) {
        tl.center = JSON.parse(JSON.stringify(cell.center));
      }
      // Legacy properties moved to cell.center.label in later formats
      if ((cell as Record<string, unknown>).label) { tl.label = (cell as Record<string, unknown>).label; }
      if ((cell as Record<string, unknown>).dmLabel) { tl.dmLabel = (cell as Record<string, unknown>).dmLabel; }

      // Internal edges between sub-cells: leave empty (no walls)
      // This is the default — we just don't set north/south/east/west between them.

      newCells[nr][nc] = tl._void ? null : tl;
      newCells[nr][nc + 1] = tr._void ? null : tr;
      newCells[nr + 1][nc] = bl._void ? null : bl;
      newCells[nr + 1][nc + 1] = br._void ? null : br;
    }
  }

  if (_trimVoidCount > 0) console.log(`[migration] Voided ${_trimVoidCount} straight-trim sub-cells`);

  // ── Fix wall reciprocity between adjacent old cells ──
  // When old cell A had east='w' and old cell B (to the east) had west='w',
  // both were migrated to their respective sub-cells. But the NEW internal
  // boundary between A's TR/BR and B's TL/BL needs no walls (they were
  // neighboring cells, the wall was on the shared edge). This is already
  // correct because we only placed east walls on TR/BR and west walls on TL/BL,
  // and the sub-cells in between (A's TR east-neighbor is B's TL) inherit
  // those walls naturally.
  //
  // However, the NEW cells between old cell boundaries (e.g., A's TR and A's TL
  // share an east-west edge internally) should have NO walls — and they don't,
  // because we never set them.

  json.cells = newCells;

  // ── Center mid-wall doors ──
  // Door cells with doors on opposing sides (north+south or east+west) are
  // passageways. Move their doors from the outer edges to the internal sub-cell
  // boundary, placing the wall at the center of the original 5ft cell.
  _centerMidwallDoors(newCells, newRows, newCols);

  // ── Fix rounded trim arcs at doubled resolution ──
  // 1. Remove diagonal walls from trimRound cells — the arc wall is drawn from
  //    metadata (smooth curve), diagonal walls just create ugly staircase artifacts.
  // 2. Refine the void boundary at sub-cell precision so the floor edge is smoother.
  _fixArcTrims(newCells);

  // ── Metadata updates ──
  const oldGridSize = metadata.gridSize ?? 5;
  metadata.gridSize = oldGridSize / 2;
  metadata.resolution = 2;

  // Levels: double startRow and numRows
  if (metadata.levels) {
    for (const level of metadata.levels as Record<string, number>[]) {
      level.startRow = (level.startRow || 0) * 2;
      level.numRows = (level.numRows || 0) * 2;
    }
  }

  // Stairs: double corner point coordinates
  if (metadata.stairs) {
    for (const stair of metadata.stairs as Record<string, unknown>[]) {
      if (stair.points) {
        stair.points = (stair.points as [number, number][]).map(([r, c]) => [r * 2, c * 2]);
      }
      if (stair.corners) {
        stair.corners = (stair.corners as [number, number][]).map(([r, c]) => [r * 2, c * 2]);
      }
    }
  }

  // Bridges: double corner point coordinates
  if (metadata.bridges) {
    for (const bridge of metadata.bridges as Record<string, unknown>[]) {
      if (bridge.points) {
        bridge.points = (bridge.points as [number, number][]).map(([r, c]) => [r * 2, c * 2]);
      }
      if (bridge.corners) {
        bridge.corners = (bridge.corners as [number, number][]).map(([r, c]) => [r * 2, c * 2]);
      }
    }
  }

  // Props: world-feet coordinates — no changes needed
  // Lights: world-feet coordinates — no changes needed
}

/**
 * After doubling the grid, fix rounded trim arcs:
 * - Remove diagonal walls from trimRound cells (arc wall rendered from metadata)
 * - Refine void boundary at sub-cell precision
 */

/**
 * Center mid-wall doors after grid doubling.
 * Passageway cells (doors on opposing sides) get their doors moved from the
 * outer edges to the internal sub-cell boundary — placing the wall at the
 * midpoint of the original 5ft cell.
 */
function _centerMidwallDoors(cells: CellGrid, numRows: number, numCols: number) {
  const isDoor = (v: string | null | undefined) => v === 'd' || v === 's';

  for (let r = 0; r < numRows; r += 2) {
    for (let c = 0; c < numCols; c += 2) {
      const tl = cells[r]?.[c], tr = cells[r]?.[c + 1];
      const bl = cells[r + 1]?.[c], br = cells[r + 1]?.[c + 1];
      if (!tl || !tr || !bl || !br) continue;

      // N-S passageway: doors on north and south outer edges
      if (isDoor(tl.north) && isDoor(bl.south)) {
        const doorN = tl.north, doorS = bl.south;
        // Remove from outer edges + reciprocals on neighbors
        delete tl.north; delete tr.north;
        delete bl.south; delete br.south;
        if (cells[r - 1]?.[c]) delete cells[r - 1][c]!.south;
        if (cells[r - 1]?.[c + 1]) delete cells[r - 1][c + 1]!.south;
        if (cells[r + 2]?.[c]) delete cells[r + 2][c]!.north;
        if (cells[r + 2]?.[c + 1]) delete cells[r + 2][c + 1]!.north;
        // Place at internal boundary (center of original cell)
        tl.south = doorN; tr.south = doorN;
        bl.north = doorS; br.north = doorS;
      }

      // E-W passageway: doors on west and east outer edges
      if (isDoor(tl.west) && isDoor(tr.east)) {
        const doorW = tl.west, doorE = tr.east;
        // Remove from outer edges + reciprocals on neighbors
        delete tl.west; delete bl.west;
        delete tr.east; delete br.east;
        if (cells[r]?.[c - 1]) delete cells[r][c - 1]!.east;
        if (cells[r + 1]?.[c - 1]) delete cells[r + 1][c - 1]!.east;
        if (cells[r]?.[c + 2]) delete cells[r][c + 2]!.west;
        if (cells[r + 1]?.[c + 2]) delete cells[r + 1][c + 2]!.west;
        // Place at internal boundary
        tl.east = doorW; bl.east = doorW;
        tr.west = doorE; br.west = doorE;
      }
    }
  }
}

function _fixArcTrims(cells: CellGrid) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Step 1: Remove diagonal walls from trimRound cells.
  // The arc wall is rendered as a smooth canvas arc from the arc metadata —
  // diagonal walls on hypotenuse cells only create visible staircase artifacts.
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = cells[r]?.[c];
      if (cell?.trimRound) {
        delete cell['nw-se'];
        delete cell['ne-sw'];
      }
    }
  }

  // Step 2: Collect unique arcs and refine void boundaries
  const arcs = new Map();
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = cells[r]?.[c];
      if (!cell?.trimRound || cell.trimArcRadius == null) continue;
      const key = `${cell.trimArcCenterRow},${cell.trimArcCenterCol},${cell.trimArcRadius},${cell.trimCorner}`;
      if (!arcs.has(key)) {
        arcs.set(key, {
          centerRow: cell.trimArcCenterRow,
          centerCol: cell.trimArcCenterCol,
          radius: cell.trimArcRadius,
          corner: cell.trimCorner,
          inverted: !!cell.trimArcInverted,
          open: !!cell.trimOpen,
        });
      }
    }
  }

  // For each arc, refine the void boundary at sub-cell precision.
  // The naive 2×2 migration creates chunky void blocks. This pass voids/unvoids
  // individual sub-cells based on their distance from the arc center.
  // Only touches cells clearly outside or inside the arc — leaves the
  // hypotenuse zone (cells near the arc boundary) untouched.
  for (const arc of arcs.values()) {
    const { centerRow: cr, centerCol: cc, radius: R, corner, inverted, open } = arc;
    if (open) continue; // open trims don't void cells

    // Bounding box of the arc region (with margin)
    let r1, c1, r2, c2;
    switch (corner) {
      case 'nw': r1 = cr; c1 = cc; r2 = cr + R + 1; c2 = cc + R + 1; break;
      case 'ne': r1 = cr; c1 = cc - R - 1; r2 = cr + R + 1; c2 = cc; break;
      case 'sw': r1 = cr - R - 1; c1 = cc; r2 = cr; c2 = cc + R + 1; break;
      case 'se': r1 = cr - R - 1; c1 = cc - R - 1; r2 = cr; c2 = cc; break;
    }

    // Arc circle center: for non-inverted arcs the circle center is offset
    // from the stored corner point by ±R (matching traceArcWedge in render.js).
    // Inverted arcs are centered at the corner point itself.
    let acr = cr, acc = cc;
    if (!inverted) {
      switch (corner) {
        case 'nw': acr = cr + R; acc = cc + R; break;
        case 'ne': acr = cr + R; acc = cc - R; break;
        case 'sw': acr = cr - R; acc = cc + R; break;
        case 'se': acr = cr - R; acc = cc - R; break;
      }
    }

    for (let r = Math.max(0, r1); r <= Math.min(numRows - 1, r2); r++) {
      for (let c = Math.max(0, c1); c <= Math.min(numCols - 1, c2); c++) {
        const cell = cells[r]?.[c];
        // Never touch hypotenuse or trimInsideArc cells
        if (cell?.trimRound || cell?.trimInsideArc || cell?.trimCorner) continue;

        const dr = r + 0.5 - acr;
        const dc = c + 0.5 - acc;
        const dist = Math.sqrt(dr * dr + dc * dc);

        // Only RESTORE voided cells that should be floor (inside the arc).
        // We do NOT void floor cells here — the arc clip in the renderer
        // already masks the void region visually, and voiding can destroy
        // adjacent corridor/room cells that happen to be near the arc boundary.
        if (!inverted) {
          if (dist < R - 0.9 && cell === null) {
            cells[r][c] = {};
          }
        } else {
          if (dist > R + 0.9 && cell === null) {
            cells[r][c] = {};
          }
        }
      }
    }
  }

  // Step 3: Repair arc flood-fill boundary gaps.
  // After step 1 deleted diagonal walls from trimRound cells, sub-cells of the
  // original trimRound cell that didn't get the trimRound flag are now regular
  // cells with no walls — the flood fill BFS passes right through them.
  // Mark them as trimInsideArc so the flood fill treats them as arc boundary.
  _repairArcFloodBoundary(cells);
}

/**
 * Mark non-flagged cells adjacent to trimRound cells with `fogBoundary` when
 * they fall inside the arc boundary. This closes gaps in the flood-fill
 * boundary caused by the v2→v3 migration only setting trimRound on one
 * sub-cell per original hypotenuse cell.
 *
 * Uses `fogBoundary` instead of `trimInsideArc` to avoid affecting rendering —
 * trimInsideArc changes floor clipping behavior, while fogBoundary only
 * affects the flood-fill BFS and arc post-pass in grid.js.
 *
 * Safe to run multiple times (idempotent) and on maps created at half-cell
 * resolution (no-op since those maps have correct per-cell trim flags).
 */
function _repairArcFloodBoundary(cells: CellGrid) {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
  if (!cells || cells.length === 0) return;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const DIRS = [{ dr: -1, dc: 0 }, { dr: 1, dc: 0 }, { dr: 0, dc: -1 }, { dr: 0, dc: 1 }];

  // Collect all trimRound cells with arc metadata
  const trimRoundCells = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = cells[r]?.[c];
      if (cell?.trimRound && cell.trimArcRadius != null) {
        trimRoundCells.push({ r, c, cell });
      }
    }
  }

  let repaired = 0;
  for (const { r, c, cell: trc } of trimRoundCells) {
    // Compute the actual arc circle center (same logic as _fixArcTrims step 2)
    let acr = trc.trimArcCenterRow as number;
    let acc = trc.trimArcCenterCol as number;
    const R = trc.trimArcRadius as number;
    const inverted = !!trc.trimArcInverted;
    const corner = trc.trimCorner as string;

    if (!inverted) {
      switch (corner) {
        case 'nw': acr += R; acc += R; break;
        case 'ne': acr += R; acc -= R; break;
        case 'sw': acr -= R; acc += R; break;
        case 'se': acr -= R; acc -= R; break;
      }
    }

    for (const { dr, dc } of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
      const neighbor = cells[nr]?.[nc];
      // Legacy property removed in format v4+
      if (!neighbor || neighbor.trimRound || neighbor.trimInsideArc || (neighbor as Record<string, unknown>).fogBoundary) continue;

      // Check if this neighbor is inside the arc (room side)
      const drr = nr + 0.5 - acr;
      const dcc = nc + 0.5 - acc;
      const dist = Math.sqrt(drr * drr + dcc * dcc);
      const isInside = inverted ? (dist > R) : (dist < R);

      if (isInside) {
        // Legacy property removed in format v4+
        (neighbor as Record<string, unknown>).fogBoundary = true;
        repaired++;
      }
    }
  }

  if (repaired > 0) console.log(`[migration] Repaired ${repaired} arc flood-boundary cells`);
}

/** Check if a point is in the corner's quadrant relative to arc center. */
function _inCornerQuad(x: number, y: number, cx: number, cy: number, corner: string) {
  switch (corner) {
    case 'nw': return x <= cx && y <= cy;
    case 'ne': return x >= cx && y <= cy;
    case 'sw': return x <= cx && y >= cy;
    case 'se': return x >= cx && y >= cy;
  }
}

/**
 * Check if a cell is inside the room from the arc corner's perspective.
 * Arc corner coords are grid intersections: NW is at the first cell (inclusive),
 * while NE/SW/SE are one past the last cell in their respective directions.
 */
function _inTrimZone(r: number, c: number, cornerRow: number, cornerCol: number, corner: string) {
  switch (corner) {
    case 'nw': return r >= cornerRow && c >= cornerCol;
    case 'ne': return r >= cornerRow && c < cornerCol;
    case 'sw': return r < cornerRow && c >= cornerCol;
    case 'se': return r < cornerRow && c < cornerCol;
  }
}

/**
 * v3→v4: Convert old-format arc trim cells (trimRound, trimInsideArc, trimArcCenter*)
 * to new per-cell format (trimClip, trimWall, trimPassable).
 * Also cleans up fogBoundary markers and stale trimInsideArc from earlier migrations.
 */
function _migrateArcToPerCell(cells: CellGrid) {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
  if (!cells || cells.length === 0) return;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // 1. Collect all unique arcs by scanning trimRound cells
  const arcs = new Map(); // key -> { centerRow, centerCol, radius, corner, inverted, open }
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = cells[r]?.[c];
      if (!cell?.trimRound || cell.trimArcRadius == null) continue;
      const key = `${cell.trimArcCenterRow},${cell.trimArcCenterCol},${cell.trimCorner}`;
      if (!arcs.has(key)) {
        arcs.set(key, {
          centerRow: cell.trimArcCenterRow,
          centerCol: cell.trimArcCenterCol,
          radius: cell.trimArcRadius,
          corner: cell.trimCorner,
          inverted: !!cell.trimArcInverted,
          open: !!cell.trimOpen,
        });
      }
    }
  }

  if (arcs.size === 0) return; // no arcs to migrate

  // 2. For each arc, compute circle center and process all cells in its zone
  let converted = 0;
  for (const arc of arcs.values()) {
    const { cx, cy } = computeCircleCenter(arc.centerRow, arc.centerCol, arc.radius, arc.corner, arc.inverted);
    const R = arc.radius;

    // Scan all cells that have this arc's metadata
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const cell = cells[r]?.[c];
        if (!cell) continue;

        const isThisArc = cell.trimArcCenterRow === arc.centerRow &&
                          cell.trimArcCenterCol === arc.centerCol &&
                          cell.trimCorner === arc.corner;
        // Legacy property removed in format v4+
        if (!isThisArc && !(cell as Record<string, unknown>).fogBoundary) continue;

        if (cell.trimRound && isThisArc) {
          // Arc boundary cell: compute per-cell clip/wall
          const data = computeArcCellData(r, c, cx, cy, R, arc.corner, arc.inverted);
          // Remove old properties
          delete cell.trimRound;
          delete cell.trimArcCenterRow;
          delete cell.trimArcCenterCol;
          delete cell.trimArcRadius;
          delete cell.trimArcInverted;
          delete cell['ne-sw'];
          delete cell['nw-se'];
          // Legacy property removed in format v4+
          delete (cell as Record<string, unknown>).fogBoundary;

          if (data) {
            // Stamp new properties
            cell.trimCorner = arc.corner;
            cell.trimClip = data.trimClip;
            cell.trimWall = data.trimWall;
            cell.trimCrossing = data.trimCrossing as unknown as Record<string, string>;
            if (arc.open) cell.trimOpen = true;
            if (arc.inverted) cell.trimInverted = true;
          } else {
            // Arc doesn't intersect this cell — clean stale corner marker
            delete cell.trimCorner;
            delete cell.trimOpen;
          }
          converted++;
        } else if (cell.trimInsideArc && isThisArc) {
          // Interior cell: make it regular floor
          delete cell.trimInsideArc;
          delete cell.trimCorner;
          delete cell.trimArcCenterRow;
          delete cell.trimArcCenterCol;
          delete cell.trimArcRadius;
          delete cell.trimArcInverted;
          // Legacy property removed in format v4+
          delete (cell as Record<string, unknown>).fogBoundary;
          converted++;
        } else if ((cell as Record<string, unknown>).fogBoundary) {
          // fogBoundary marker from earlier migration: check if arc passes through
          const data = computeArcCellData(r, c, cx, cy, R, arc.corner, arc.inverted);
          // Legacy property removed in format v4+
          delete (cell as Record<string, unknown>).fogBoundary;
          if (data) {
            cell.trimCorner = arc.corner;
            cell.trimClip = data.trimClip;
            cell.trimWall = data.trimWall;
            cell.trimCrossing = data.trimCrossing as unknown as Record<string, string>;
            if (arc.open) cell.trimOpen = true;
            if (arc.inverted) cell.trimInverted = true;
            converted++;
          }
        }
      }
    }

    // Second pass: scan the arc's bounding box for cells the arc passes
    // through that weren't marked in the old format. The old format only
    // tagged hypotenuse-diagonal cells with trimRound, but the circular arc
    // extends beyond those into neighboring cells.
    const rMin = Math.max(0, Math.floor(cy - R) - 1);
    const rMax = Math.min(numRows - 1, Math.ceil(cy + R) + 1);
    const cMin = Math.max(0, Math.floor(cx - R) - 1);
    const cMax = Math.min(numCols - 1, Math.ceil(cx + R) + 1);

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const cell = cells[r]?.[c];
        if (!cell || cell.trimClip) continue; // skip void or already-processed
        const data = computeArcCellData(r, c, cx, cy, R, arc.corner, arc.inverted);
        if (data) {
          cell.trimCorner = arc.corner;
          cell.trimClip = data.trimClip;
          cell.trimWall = data.trimWall;
          cell.trimCrossing = data.trimCrossing as unknown as Record<string, string>;
          if (arc.open) cell.trimOpen = true;
          if (arc.inverted) cell.trimInverted = true;
          converted++;
        } else {
          if (cell.trimCorner === arc.corner && !cell.trimWall) {
            // Stale trimCorner from old format — clean up
            delete cell.trimCorner;
            delete cell.trimOpen;
          }
          // Promote secondary texture on cells outside the arc (void side).
          // For open trims these stay as floor but should show the outer texture.
          // Only apply within the arc's own quadrant to avoid cross-corner overlap.
          if (cell.textureSecondary && arc.open) {
            const d2 = (c + 0.5 - cx) ** 2 + (r + 0.5 - cy) ** 2;
            const outside = arc.inverted ? d2 < R * R : d2 > R * R;
            const inQuad = arc.inverted
              ? !_inCornerQuad(c + 0.5, r + 0.5, cx, cy, arc.corner)
              : _inCornerQuad(c + 0.5, r + 0.5, cx, cy, arc.corner);
            const inZone = arc.inverted
              ? !_inTrimZone(r, c, arc.centerRow, arc.centerCol, arc.corner)
              : _inTrimZone(r, c, arc.centerRow, arc.centerCol, arc.corner);
            if (outside && inQuad && inZone) {
              cell.texture = cell.textureSecondary;
              cell.textureOpacity = 1;
            }
          }
        }
      }
    }
  }

  if (converted > 0) console.log(`[migration] Converted ${converted} arc trim cells to per-cell format`);
}

/**
 * Repair: add trimCrossing to arc cells from intermediate code versions
 * that stored trimWall/trimClip but not trimCrossing.
 */
function _repairMissingCrossing(cells: CellGrid) {
  let repaired = 0;
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      const cell = cells[r]?.[c];
      if (!cell?.trimWall || cell.trimCrossing) continue;
      if (cell.trimClip) {
        cell.trimCrossing = computeTrimCrossing(cell.trimClip, cell.trimWall as number[][]) as unknown as Record<string, string>;
        repaired++;
      }
    }
  }
  if (repaired > 0) console.log(`[migration] Repaired ${repaired} arc cells with missing trimCrossing`);
}

/**
 * Apply all necessary migrations to bring a dungeon JSON up to the current format version.
 * Modifies the json object in-place and returns it.
 * @param {object} json - Dungeon JSON with metadata and cells
 * @returns {object} The same json object, migrated
 */
export function migrateToLatest(json: MigrationJson): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data may be missing
  if (!json.metadata) return json as unknown as Record<string, unknown>;
  let version = json.metadata.formatVersion ?? 0;

  // Warn if file is from a newer version than we support
  if (version > CURRENT_FORMAT_VERSION) {
    console.warn(
      `[migrations] File format version ${version} is newer than supported version ${CURRENT_FORMAT_VERSION}. ` +
      `Some features may not work correctly. Consider updating mapwright.`
    );
    return json;
  }

  // Apply migrations in sequence
  for (const m of migrations) {
    if (version === m.from) {
      m.migrate(json);
      version = m.to;
      json.metadata.formatVersion = version;
    }
  }

  // Repair pass: convert any remaining old-format arc cells (handles pre-release v4 files
  // that had the old trimRound/trimInsideArc format before the per-cell overhaul).
  let hasOldFormat = false;
  let hasMissingCrossing = false;
  outer: for (let r = 0; r < json.cells.length; r++) {
    for (let c = 0; c < (json.cells[r]?.length || 0); c++) {
      const cell = json.cells[r]?.[c];
      if (cell?.trimRound) { hasOldFormat = true; break outer; }
      if (cell?.trimWall && !cell.trimCrossing) hasMissingCrossing = true;
    }
  }
  if (hasOldFormat) _migrateArcToPerCell(json.cells);
  // Repair: add trimCrossing/trimCorner to cells from intermediate code versions
  if (hasMissingCrossing && !hasOldFormat) _repairMissingCrossing(json.cells);

  // Stamp current version if not yet set
  json.metadata.formatVersion ??= CURRENT_FORMAT_VERSION;

  return json;
}
