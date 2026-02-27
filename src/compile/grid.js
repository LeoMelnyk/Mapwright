import { DIRECTIONS, RESERVED_CHARS, OPEN_CORRIDOR_CHAR } from './constants.js';
import { cellKey, parseCellKey } from '../util/index.js';

// ── Grid class ───────────────────────────────────────────────────────

class Grid {
  constructor(numRows, numCols) {
    this.numRows = numRows;
    this.numCols = numCols;
    this.cells = Array.from({ length: numRows }, () => Array(numCols).fill(null));
    this.cellToRoom = new Map();   // "row,col" -> internal room ID
    this.cellToChar = new Map();   // "row,col" -> original ASCII character
  }

  getRoom(row, col) { return this.cellToRoom.get(cellKey(row, col)) || null; }

  getChar(row, col) { return this.cellToChar.get(cellKey(row, col)) || null; }

  setRoom(row, col, roomId, char) {
    const k = cellKey(row, col);
    this.cellToRoom.set(k, roomId);
    this.cellToChar.set(k, char);
    if (!this.cells[row][col]) this.cells[row][col] = {};
  }

  inBounds(row, col) {
    return row >= 0 && row < this.numRows && col >= 0 && col < this.numCols;
  }
}

// ── Grid Parser ──────────────────────────────────────────────────────

function parseGrid(gridLines, legend) {
  // Validate all rows are the same length
  // Use raw line length (no trimming — spaces matter for alignment)
  const maxLen = Math.max(...gridLines.map(l => l.length));
  const rows = gridLines.map(l => l.padEnd(maxLen, '.'));

  const numRows = rows.length;
  const numCols = maxLen;

  // Collect cells by character
  const charCells = new Map(); // char -> [{row, col}, ...]

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const ch = rows[r][c];
      if (ch === '.') continue; // void
      if (!charCells.has(ch)) charCells.set(ch, []);
      charCells.get(ch).push({ row: r, col: c });
    }
  }

  // Validate characters in grid against legend
  for (const ch of charCells.keys()) {
    if (RESERVED_CHARS.has(ch)) continue; // -, #, and = are always valid
    if (!(ch in legend)) {
      throw new Error(
        `Character '${ch}' appears in grid but is not in legend. ` +
        `Add it to the legend or use '.' for void.`
      );
    }
  }

  // Validate legend characters appear in grid
  for (const ch in legend) {
    if (!charCells.has(ch)) {
      console.warn(`  ⚠ Legend character '${ch}' does not appear in the grid`);
    }
  }

  // Flood fill to find connected components per character
  const rooms = new Map(); // internalId -> { id, label, char, cells: Set("row,col") }
  const visited = new Set();

  let corridorCounter = 0;

  for (const [ch, cells] of charCells) {
    const cellSet = new Set(cells.map(c => cellKey(c.row, c.col)));
    const isLabeled = ch in legend && legend[ch] !== null;
    let componentCount = 0;

    for (const cell of cells) {
      const key = cellKey(cell.row, cell.col);
      if (visited.has(key)) continue;

      // Flood fill this connected component
      const component = new Set();
      const queue = [cell];

      while (queue.length > 0) {
        const { row, col } = queue.shift();
        const k = cellKey(row, col);
        if (component.has(k)) continue;
        if (!cellSet.has(k)) continue;
        component.add(k);
        visited.add(k);

        // Check 4 neighbors (only same character)
        for (const { dr, dc } of DIRECTIONS) {
          const nr = row + dr;
          const nc = col + dc;
          const nk = cellKey(nr, nc);
          if (cellSet.has(nk) && !component.has(nk)) {
            queue.push({ row: nr, col: nc });
          }
        }
      }

      componentCount++;

      // Determine room ID
      let id, label;
      if (isLabeled) {
        if (componentCount > 1) {
          throw new Error(
            `Character '${ch}' (label: ${legend[ch]}) has disconnected cells. ` +
            `All cells of a labeled room must be contiguous.`
          );
        }
        id = legend[ch];
        label = legend[ch];
      } else {
        corridorCounter++;
        id = `_c${corridorCounter}`;
        label = null;
      }

      rooms.set(id, { id, label, char: ch, cells: component });
    }
  }

  return { rooms, numRows, numCols };
}

// ── Build Grid ───────────────────────────────────────────────────────

function buildGrid(rooms, numRows, numCols) {
  const grid = new Grid(numRows, numCols);

  for (const [id, room] of rooms) {
    for (const key of room.cells) {
      const [r, c] = parseCellKey(key);
      grid.setRoom(r, c, id, room.char);
    }
  }

  return grid;
}

// ── Compute Borders ──────────────────────────────────────────────────

function computeBorders(grid) {
  for (let r = 0; r < grid.numRows; r++) {
    for (let c = 0; c < grid.numCols; c++) {
      if (!grid.cells[r][c]) continue;

      const myRoom = grid.getRoom(r, c);
      const myChar = grid.getChar(r, c);
      const cell = grid.cells[r][c];

      for (const { name, dr, dc } of DIRECTIONS) {
        const nr = r + dr;
        const nc = c + dc;

        if (!grid.inBounds(nr, nc)) {
          cell[name] = 'w';
          continue;
        }

        const neighborRoom = grid.getRoom(nr, nc);
        const neighborChar = grid.getChar(nr, nc);

        if (!neighborRoom) {
          // Facing void
          cell[name] = 'w';
        } else if (neighborRoom !== myRoom) {
          // Different room — check open corridor rules
          if (myChar === OPEN_CORRIDOR_CHAR || neighborChar === OPEN_CORRIDOR_CHAR) {
            // Open corridor: no wall on either side
            // (neighbor's reciprocal will also skip due to this check)
          } else {
            cell[name] = 'w';
          }
        }
        // Same room → omit (open passage)
      }
    }
  }
}

export { Grid, parseGrid, buildGrid, computeBorders };
