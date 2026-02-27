import { DIRECTIONS, TRIM_DIAGONALS, TRIM_CLEAR_WALLS } from './constants.js';
import { cellKey, parseCellKey } from '../util/index.js';

// ── Compute Trim Cells ──────────────────────────────────────────────

/**
 * For a trim of size N at the given corner, compute which cells are voided
 * (inside the triangle) and which form the hypotenuse (get diagonals).
 */
function computeTrimCells(corner, size, minR, maxR, minC, maxC) {
  const voided = [];
  const hypotenuse = [];
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      if (dr + dc >= size) continue;
      let r, c;
      switch (corner) {
        case 'nw': r = minR + dr; c = minC + dc; break;
        case 'ne': r = minR + dr; c = maxC - dc; break;
        case 'sw': r = maxR - dr; c = minC + dc; break;
        case 'se': r = maxR - dr; c = maxC - dc; break;
      }
      const key = cellKey(r, c);
      if (dr + dc < size - 1) {
        voided.push(key);
      } else {
        hypotenuse.push(key);
      }
    }
  }
  return { voided, hypotenuse };
}

// ── Apply Trims ──────────────────────────────────────────────────────

function applyTrims(grid, rooms, trimConfig) {
  const diagonals = new Map();
  const trimmedWalls = new Map();
  const trimCorners = new Map();
  const roundData = new Map();  // key → {centerRow, centerCol, radius}
  const trimDetails = [];       // per-trim detail records for reporting
  let totalVoided = 0;

  for (const [label, corners] of Object.entries(trimConfig)) {
    const room = rooms.get(label);
    if (!room) {
      throw new Error(`Trim references unknown room label: ${label}`);
    }

    // Compute bounding box
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (const key of room.cells) {
      const [r, c] = parseCellKey(key);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
    }

    // Track all cells affected by trims on this room (overlap detection)
    const affected = new Set();

    for (const { corner, size, round, inverted } of corners) {
      const diagType = TRIM_DIAGONALS[corner];
      const sizeLabel = size > 1 ? `${corner}${size}` : corner;

      let { voided, hypotenuse } = computeTrimCells(corner, size, minR, maxR, minC, maxC);

      // Filter out cells that are already void or out of bounds — these are harmless.
      // Only error if a trim cell belongs to a DIFFERENT room (real conflict).
      const isSkippable = (key) => {
        if (room.cells.has(key)) return false; // cell is in the room — keep it
        const [r, c] = parseCellKey(key);
        if (!grid.inBounds(r, c) || !grid.cells[r][c]) return true; // void or OOB — skip
        // Cell belongs to a different room — that's a real error
        throw new Error(
          `Room ${label}: trim '${sizeLabel}' extends into another room at cell [${c},${r}]`
        );
      };
      voided = voided.filter(k => !isSkippable(k));
      hypotenuse = hypotenuse.filter(k => !isSkippable(k));

      // Validate no overlap with other trims on this room
      for (const key of [...voided, ...hypotenuse]) {
        if (affected.has(key)) {
          const [r, c] = parseCellKey(key);
          throw new Error(
            `Room ${label}: trim '${sizeLabel}' overlaps with another trim at cell [${c},${r}]`
          );
        }
        affected.add(key);
      }

      // Collect per-trim detail for reporting
      trimDetails.push({
        label,
        spec: `${corner}${size}${round ? (inverted ? 'ri' : 'r') : ''}`,
        voidedCount: voided.length,
        hypotenuseCoords: hypotenuse.map(key => {
          const [r, c] = parseCellKey(key);
          return `(${c},${r})`;
        })
      });

      // Void cells: null them out and remove from room tracking
      for (const key of voided) {
        const [r, c] = parseCellKey(key);
        grid.cells[r][c] = null;
        grid.cellToRoom.delete(key);
        grid.cellToChar.delete(key);
        room.cells.delete(key);
        totalVoided++;

        // Fix neighbor borders: neighbors that were same-room now face void
        for (const { opposite, dr, dc } of DIRECTIONS) {
          const nr = r + dr;
          const nc = c + dc;
          if (!grid.inBounds(nr, nc)) continue;
          const neighbor = grid.cells[nr][nc];
          if (!neighbor) continue;
          // Add wall on the side facing the now-voided cell
          if (!neighbor[opposite]) {
            neighbor[opposite] = 'w';
          }
        }
      }

      // Record hypotenuse cells for diagonal application
      for (const key of hypotenuse) {
        diagonals.set(key, diagType);
        trimmedWalls.set(key, TRIM_CLEAR_WALLS[corner]);
        trimCorners.set(key, corner);
      }

      // Store arc metadata for rounded trims
      if (round) {
        // Arc center is the grid point at the room's bounding box corner
        let centerRow, centerCol;
        switch (corner) {
          case 'nw': centerRow = minR; centerCol = minC; break;
          case 'ne': centerRow = minR; centerCol = maxC + 1; break;
          case 'sw': centerRow = maxR + 1; centerCol = minC; break;
          case 'se': centerRow = maxR + 1; centerCol = maxC + 1; break;
        }
        for (const key of hypotenuse) {
          roundData.set(key, { centerRow, centerCol, radius: size, inverted: !!inverted });
        }
      }
    }
  }

  // Apply diagonals and clear replaced walls
  for (const [key, diagType] of diagonals) {
    const [r, c] = parseCellKey(key);
    const cell = grid.cells[r][c];
    if (!cell) continue;

    cell[diagType] = 'w';

    if (trimmedWalls.has(key)) {
      for (const wall of trimmedWalls.get(key)) {
        delete cell[wall];
      }
    }

    if (trimCorners.has(key)) {
      cell.trimCorner = trimCorners.get(key);
    }

    if (roundData.has(key)) {
      const rd = roundData.get(key);
      cell.trimRound = true;
      cell.trimArcCenterRow = rd.centerRow;
      cell.trimArcCenterCol = rd.centerCol;
      cell.trimArcRadius = rd.radius;
      if (rd.inverted) cell.trimArcInverted = true;
    }
  }

  return { diagonals, totalVoided, trimDetails };
}

export { computeTrimCells, applyTrims };
