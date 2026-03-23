// Format versioning and migration registry for .mapwright save files.

import { migrateHalfTextures } from './io.js';

export const CURRENT_FORMAT_VERSION = 3;

// Migration registry: each entry upgrades from one version to the next.
// Migrations are applied in sequence: 0→1, 1→2, etc.
const migrations = [
  // v0 → v1: half-texture format migration (pre-existing logic from io.js)
  { from: 0, to: 1, migrate: (json) => migrateHalfTextures(json) },
  // v1 → v2: extract cell.prop entries into metadata.props[] overlay array
  { from: 1, to: 2, migrate: (json) => migratePropsToOverlay(json) },
  // v2 → v3: double grid resolution (half-cell coordinates)
  { from: 2, to: 3, migrate: (json) => migrateToHalfCell(json) },
];

/**
 * Extract all cell.prop entries into metadata.props[] overlay format.
 * Cell.prop entries are deleted after copying — the overlay is the sole source of truth.
 */
function migratePropsToOverlay(json) {
  if (!json.metadata) return;
  if (json.metadata.props) return; // already migrated

  json.metadata.props = [];
  if (!json.metadata.nextPropId) json.metadata.nextPropId = 1;
  const gridSize = json.metadata.gridSize || 5;

  for (let row = 0; row < json.cells.length; row++) {
    const rowArr = json.cells[row];
    if (!rowArr) continue;
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

function migrateToHalfCell(json) {
  const { metadata, cells } = json;
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
        if (cell[key] !== undefined && cell[key] !== null) {
          // Deep-copy objects (texture), shallow-copy primitives
          base[key] = typeof cell[key] === 'object' ? JSON.parse(JSON.stringify(cell[key])) : cell[key];
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
      if (cell.trimCorner && !cell.trimRound) {
        // Straight trim hypotenuse: the diagonal cuts the cell into void + floor triangles.
        // One sub-cell is entirely void, two get the diagonal, one is entirely floor.
        //   NW corner (ne-sw): void=TL, diag=TR+BL, floor=BR
        //   NE corner (nw-se): void=TR, diag=TL+BR, floor=BL
        //   SW corner (nw-se): void=BL, diag=TL+BR, floor=TR
        //   SE corner (ne-sw): void=BR, diag=TR+BL, floor=TL
        const corner = cell.trimCorner;
        const diagType = (corner === 'nw' || corner === 'se') ? 'ne-sw' : 'nw-se';
        const diagVal = cell[diagType] || 'w';

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
          target.trimArcCenterRow = cell.trimArcCenterRow * 2;
          target.trimArcCenterCol = cell.trimArcCenterCol * 2;
          target.trimArcRadius = cell.trimArcRadius * 2;
        }
      } else {
        // Non-trim diagonals: check if the cell is a trim hypotenuse (adjacent to void)
        // even without trimCorner — the old trim tool didn't always set trimCorner.
        const isVoid = (vr, vc) => vr < 0 || vr >= oldRows || vc < 0 || vc >= oldCols || !cells[vr][vc];
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
          const diagVal = cell[diagType] || 'w';
          if (inferredCorner === 'nw') { tl._void = true; _trimVoidCount++; }
          else if (inferredCorner === 'ne') { tr._void = true; _trimVoidCount++; }
          else if (inferredCorner === 'sw') { bl._void = true; _trimVoidCount++; }
          else { br._void = true; _trimVoidCount++; }
          const diagCells = diagType === 'ne-sw' ? [tr, bl] : [tl, br];
          for (const dc of diagCells) {
            dc[diagType] = diagVal;
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
            sub.trimArcCenterRow = cell.trimArcCenterRow * 2;
            sub.trimArcCenterCol = cell.trimArcCenterCol * 2;
            sub.trimArcRadius = cell.trimArcRadius * 2;
          }
        }
      }

      // ── Labels ──
      // Place label on TL sub-cell (center of original cell maps closest to this)
      if (cell.center) {
        tl.center = JSON.parse(JSON.stringify(cell.center));
      }
      if (cell.label) { tl.label = cell.label; }
      if (cell.dmLabel) { tl.dmLabel = cell.dmLabel; }

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

  // ── Fix rounded trim arcs at doubled resolution ──
  // 1. Remove diagonal walls from trimRound cells — the arc wall is drawn from
  //    metadata (smooth curve), diagonal walls just create ugly staircase artifacts.
  // 2. Refine the void boundary at sub-cell precision so the floor edge is smoother.
  _fixArcTrims(newCells);

  // ── Metadata updates ──
  const oldGridSize = metadata.gridSize || 5;
  metadata.gridSize = oldGridSize / 2;
  metadata.resolution = 2;

  // Levels: double startRow and numRows
  if (metadata.levels) {
    for (const level of metadata.levels) {
      level.startRow = (level.startRow || 0) * 2;
      level.numRows = (level.numRows || 0) * 2;
    }
  }

  // Stairs: double corner point coordinates
  if (metadata.stairs) {
    for (const stair of metadata.stairs) {
      if (stair.points) {
        stair.points = stair.points.map(([r, c]) => [r * 2, c * 2]);
      }
      if (stair.corners) {
        stair.corners = stair.corners.map(([r, c]) => [r * 2, c * 2]);
      }
    }
  }

  // Bridges: double corner point coordinates
  if (metadata.bridges) {
    for (const bridge of metadata.bridges) {
      if (bridge.points) {
        bridge.points = bridge.points.map(([r, c]) => [r * 2, c * 2]);
      }
      if (bridge.corners) {
        bridge.corners = bridge.corners.map(([r, c]) => [r * 2, c * 2]);
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
function _fixArcTrims(cells) {
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

    for (let r = Math.max(0, r1); r <= Math.min(numRows - 1, r2); r++) {
      for (let c = Math.max(0, c1); c <= Math.min(numCols - 1, c2); c++) {
        const cell = cells[r]?.[c];
        // Never touch hypotenuse or trimInsideArc cells
        if (cell?.trimRound || cell?.trimInsideArc || cell?.trimCorner) continue;

        const dr = r + 0.5 - cr;
        const dc = c + 0.5 - cc;
        const dist = Math.sqrt(dr * dr + dc * dc);

        if (!inverted) {
          // Normal arc: outside = dist > R
          if (dist > R + 0.9 && cell != null) {
            // Clearly outside — void it
            cells[r][c] = null;
          } else if (dist < R - 0.9 && cell === null) {
            // Clearly inside but was voided by 2×2 block — restore as floor
            cells[r][c] = {};
          }
        } else {
          // Inverted arc: outside = dist < R
          if (dist < R - 0.9 && cell != null) {
            cells[r][c] = null;
          } else if (dist > R + 0.9 && cell === null) {
            cells[r][c] = {};
          }
        }
      }
    }
  }
}

/**
 * Apply all necessary migrations to bring a dungeon JSON up to the current format version.
 * Modifies the json object in-place and returns it.
 * @param {object} json - Dungeon JSON with metadata and cells
 * @returns {object} The same json object, migrated
 */
export function migrateToLatest(json) {
  if (!json.metadata) return json;
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

  // Stamp current version if not yet set
  if (json.metadata.formatVersion == null) {
    json.metadata.formatVersion = CURRENT_FORMAT_VERSION;
  }

  return json;
}
