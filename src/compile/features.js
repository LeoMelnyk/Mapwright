import { DIRECTIONS } from './constants.js';
import { cellKey, parseCellKey } from '../util/index.js';

// ── Place Doors ──────────────────────────────────────────────────────

// warnings: optional array — invalid doors are pushed here and skipped (non-fatal).
// Coordinates in messages use "row R, col C" to match the .map file format (row,col order).
function placeDoors(grid, doorConfig, warnings = []) {
  for (const door of doorConfig) {
    const { col, row, direction, type } = door;
    const borderType = type === 'secret' ? 's' : 'd';
    const at = `row ${row}, col ${col}`;

    if (!grid.inBounds(row, col)) {
      warnings.push(`Door at ${at}: out of bounds — skipped`);
      continue;
    }

    if (!grid.cells[row][col]) {
      warnings.push(`Door at ${at}: cell is void — skipped`);
      continue;
    }

    const myRoom = grid.getRoom(row, col);

    if (direction) {
      // Explicit direction
      const dir = DIRECTIONS.find(d => d.name === direction);
      if (!dir) {
        warnings.push(`Door at ${at}: unknown direction '${direction}' — skipped`);
        continue;
      }

      const nr = row + dir.dr;
      const nc = col + dir.dc;

      if (!grid.inBounds(nr, nc) || !grid.cells[nr][nc]) {
        warnings.push(`Door at ${at} ${direction}: neighbor cell is void or out of bounds — skipped`);
        continue;
      }

      const neighborRoom = grid.getRoom(nr, nc);
      if (neighborRoom === myRoom) {
        warnings.push(`Door at ${at} ${direction}: neighbor is the same room — skipped`);
        continue;
      }

      grid.cells[row][col][dir.name] = borderType;
      grid.cells[nr][nc][dir.opposite] = borderType;
    } else {
      // Auto-detect: find walls facing different rooms (not void)
      const candidates = [];

      for (const dir of DIRECTIONS) {
        const nr = row + dir.dr;
        const nc = col + dir.dc;

        if (!grid.inBounds(nr, nc) || !grid.cells[nr][nc]) continue;

        const neighborRoom = grid.getRoom(nr, nc);
        if (neighborRoom && neighborRoom !== myRoom) {
          candidates.push(dir);
        }
      }

      if (candidates.length === 0) {
        warnings.push(
          `Door at ${at}: no wall facing another room — skipped (only borders void or same room)`
        );
        continue;
      }

      if (candidates.length > 1) {
        const dirs = candidates.map(d => d.name).join(', ');
        warnings.push(
          `Door at ${at}: ambiguous — walls face multiple rooms (${dirs}) — skipped; add direction e.g. "${row},${col} ${candidates[0].name}: ${type}"`
        );
        continue;
      }

      const dir = candidates[0];
      const nr = row + dir.dr;
      const nc = col + dir.dc;

      grid.cells[row][col][dir.name] = borderType;
      grid.cells[nr][nc][dir.opposite] = borderType;
    }
  }
}

// ── Place Labels ─────────────────────────────────────────────────────

function placeLabels(grid, rooms, diagonals) {
  for (const [id, room] of rooms) {
    if (!room.label) continue; // Skip unlabeled corridors

    const cells = [...room.cells];

    // Compute centroid
    let sumR = 0, sumC = 0;
    for (const key of cells) {
      const [r, c] = parseCellKey(key);
      sumR += r;
      sumC += c;
    }
    const centerR = Math.round(sumR / cells.length);
    const centerC = Math.round(sumC / cells.length);

    // Find closest cell to centroid (no diagonal)
    let bestKey = null;
    let bestDist = Infinity;

    for (const key of cells) {
      if (diagonals.has(key)) continue;
      const [r, c] = parseCellKey(key);
      const dist = Math.abs(r - centerR) + Math.abs(c - centerC);
      if (dist < bestDist) {
        bestDist = dist;
        bestKey = key;
      }
    }

    if (!bestKey) {
      console.warn(`  ⚠ Room ${id}: no valid cell for label (all cells have diagonals)`);
      continue;
    }

    const [lr, lc] = parseCellKey(bestKey);
    if (!grid.cells[lr][lc].center) {
      grid.cells[lr][lc].center = {};
    }
    grid.cells[lr][lc].center.label = room.label;
  }
}

// ── Validate Reachability ────────────────────────────────────────────

function validateReachability(grid, rooms) {
  // Build adjacency: rooms connected via doors or open borders
  const adj = new Map();
  for (const [id] of rooms) adj.set(id, new Set());

  for (let r = 0; r < grid.numRows; r++) {
    for (let c = 0; c < grid.numCols; c++) {
      if (!grid.cells[r][c]) continue;
      const myRoom = grid.getRoom(r, c);

      for (const { name, dr, dc } of DIRECTIONS) {
        const nr = r + dr;
        const nc = c + dc;
        if (!grid.inBounds(nr, nc) || !grid.cells[nr][nc]) continue;

        const neighborRoom = grid.getRoom(nr, nc);
        if (!neighborRoom || neighborRoom === myRoom) continue;

        const border = grid.cells[r][c][name];
        // Connected if: door, secret door, or open passage (no border)
        if (border === 'd' || border === 's' || !border) {
          adj.get(myRoom).add(neighborRoom);
          adj.get(neighborRoom).add(myRoom);
        }
      }
    }
  }

  // Add linked stair connections to adjacency
  for (let r = 0; r < grid.numRows; r++) {
    for (let c = 0; c < grid.numCols; c++) {
      const cell = grid.cells[r][c];
      if (!cell || !cell.center) continue;
      for (const dir of ['stairs-up', 'stairs-down']) {
        const link = cell.center[dir];
        if (!Array.isArray(link)) continue; // skip standalone (true) stairs
        const [linkedRow, linkedCol] = link;
        const myRoom = grid.getRoom(r, c);
        const linkedRoom = grid.getRoom(linkedRow, linkedCol);
        if (myRoom && linkedRoom && myRoom !== linkedRoom) {
          adj.get(myRoom).add(linkedRoom);
          adj.get(linkedRoom).add(myRoom);
        }
      }
    }
  }

  // BFS from first labeled room
  let startRoom = null;
  for (const [id, room] of rooms) {
    if (room.label) { startRoom = id; break; }
  }
  if (!startRoom) return;

  const visited = new Set([startRoom]);
  const queue = [startRoom];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of (adj.get(current) || [])) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const unreachable = [];
  for (const [id, room] of rooms) {
    if (room.label && !visited.has(id)) unreachable.push(id);
  }

  if (unreachable.length > 0) {
    console.warn(`  ⚠ Unreachable rooms from ${startRoom}: ${unreachable.join(', ')}`);
  }
}

// ── Place Stairs ─────────────────────────────────────────────────────

/**
 * Check if a specific cell is valid for stair placement in a given room.
 */
function isValidStairCell(grid, rooms, roomLabel, row, col) {
  const room = rooms.get(roomLabel);
  if (!room) return false;
  if (!room.cells.has(cellKey(row, col))) return false;
  const cell = grid.cells[row]?.[col];
  if (!cell) return false;
  if (cell['nw-se'] || cell['ne-sw']) return false;
  if (cell.center) return false;
  return true;
}

function findBestStairCell(grid, rooms, roomLabel) {
  const room = rooms.get(roomLabel);
  if (!room) {
    throw new Error(`Stairs reference unknown room label: "${roomLabel}"`);
  }

  const cells = [...room.cells];
  let sumR = 0, sumC = 0;
  for (const key of cells) {
    const [r, c] = parseCellKey(key);
    sumR += r;
    sumC += c;
  }
  const centerR = Math.round(sumR / cells.length);
  const centerC = Math.round(sumC / cells.length);

  let bestKey = null, bestDist = Infinity;
  for (const key of cells) {
    const [r, c] = parseCellKey(key);
    const cell = grid.cells[r]?.[c];
    if (!cell) continue;
    if (cell['nw-se'] || cell['ne-sw']) continue;
    if (cell.center) continue;
    const dist = Math.abs(r - centerR) + Math.abs(c - centerC);
    if (dist < bestDist) {
      bestDist = dist;
      bestKey = key;
    }
  }

  if (!bestKey) {
    throw new Error(
      `Stairs in room "${roomLabel}": no valid cell — all cells have diagonals or existing content. ` +
      `Enlarge the room or use explicit coordinates.`
    );
  }

  const [r, c] = parseCellKey(bestKey);
  return { row: r, col: c };
}

function validateStairCell(grid, col, row) {
  if (!grid.inBounds(row, col)) {
    throw new Error(`Stairs at ${col},${row}: out of bounds`);
  }
  const cell = grid.cells[row][col];
  if (!cell) {
    throw new Error(`Stairs at ${col},${row}: cell is void`);
  }
  if (cell.center?.label) {
    throw new Error(
      `Stairs at ${col},${row}: cell already has label "${cell.center.label}". ` +
      `Place stairs on an adjacent unlabeled cell (they would overlap visually).`
    );
  }
  if (cell['nw-se'] || cell['ne-sw']) {
    throw new Error(
      `Stairs at ${col},${row}: cell has a diagonal border from a trim — ` +
      `move the stair to a non-trimmed cell, or use room-relative syntax (RoomLabel: up).`
    );
  }
  return cell;
}

function placeStairs(grid, stairConfig) {
  for (const stair of stairConfig) {
    const { col, row, type } = stair;

    const cell = validateStairCell(grid, col, row);
    if (!cell.center) cell.center = {};

    if (stair.linkedCol !== undefined) {
      // Linked pair — validate and place both ends with reciprocal [row, col] targets
      const { linkedCol, linkedRow, linkedType } = stair;

      const linkedCell = validateStairCell(grid, linkedCol, linkedRow);
      if (!linkedCell.center) linkedCell.center = {};

      cell.center[`stairs-${type}`] = [linkedRow, linkedCol];
      linkedCell.center[`stairs-${linkedType}`] = [row, col];
    } else {
      // Standalone — visual marker only
      cell.center[`stairs-${type}`] = true;
    }
  }
}

export { placeDoors, placeLabels, validateReachability, isValidStairCell, findBestStairCell, validateStairCell, placeStairs };
