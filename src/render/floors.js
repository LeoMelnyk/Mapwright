import { toCanvas } from './bounds.js';
import { isEdgeOpen } from '../util/index.js';

/**
 * Determine which cells should have room backgrounds (including flood fill for enclosed areas).
 * @param {Array<Array<Object>>} cells - 2D grid of cell objects
 * @returns {Array<Array<boolean>>} 2D boolean grid where true = room cell
 */
function determineRoomCells(cells) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const isRoom = Array.from({length: numRows}, () => Array(numCols).fill(false));

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      if (cells[row][col]) {
        isRoom[row][col] = true;
      }
    }
  }

  const isOutside = Array.from({length: numRows}, () => Array(numCols).fill(false));

  // Iterative flood fill to avoid stack overflow on large grids
  const stack = [];
  function seedOutside(r, c) {
    if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
    if (!isOutside[r][c]) { isOutside[r][c] = true; stack.push(r, c); }
  }

  for (let col = 0; col < numCols; col++) { seedOutside(0, col); seedOutside(numRows - 1, col); }
  for (let row = 0; row < numRows; row++) { seedOutside(row, 0); seedOutside(row, numCols - 1); }

  while (stack.length > 0) {
    const col = stack.pop();
    const row = stack.pop();
    const cell = cells[row][col];
    if (row > 0 && !isOutside[row - 1][col] && isEdgeOpen(cell, cells[row - 1]?.[col], 'north')) {
      isOutside[row - 1][col] = true; stack.push(row - 1, col);
    }
    if (row < numRows - 1 && !isOutside[row + 1][col] && isEdgeOpen(cell, cells[row + 1]?.[col], 'south')) {
      isOutside[row + 1][col] = true; stack.push(row + 1, col);
    }
    if (col < numCols - 1 && !isOutside[row][col + 1] && isEdgeOpen(cell, cells[row]?.[col + 1], 'east')) {
      isOutside[row][col + 1] = true; stack.push(row, col + 1);
    }
    if (col > 0 && !isOutside[row][col - 1] && isEdgeOpen(cell, cells[row]?.[col - 1], 'west')) {
      isOutside[row][col - 1] = true; stack.push(row, col - 1);
    }
  }

  return isRoom;
}

/**
 * Get the void corner for a cell with a diagonal wall.
 * @param {Object} cell - Cell object to check
 * @param {Array<Array<Object>>} cells - 2D cell grid for neighbor lookups
 * @param {number} row - Cell row index
 * @param {number} col - Cell column index
 * @returns {string|null} Corner direction ('nw', 'ne', 'sw', 'se') or null
 */
function getDiagonalTrimCorner(cell, cells, row, col) {
  // Arc boundary cells with trimClip use polygon clipping, not diagonal trimming.
  if (cell.trimClip) return null;
  if (cell.trimCorner) return cell.trimCorner;

  const hasDiag = cell['ne-sw'] || cell['nw-se'];
  if (!hasDiag) return null;

  const numRows = cells?.length || 0;
  const numCols = cells?.[0]?.length || 0;
  const isVoid = (r, c) => r < 0 || r >= numRows || c < 0 || c >= numCols || !cells[r][c];

  if (cell['ne-sw']) {
    if (isVoid(row - 1, col) && isVoid(row, col - 1)) return 'nw';
    if (isVoid(row + 1, col) && isVoid(row, col + 1)) return 'se';
  }
  if (cell['nw-se']) {
    if (isVoid(row - 1, col) && isVoid(row, col + 1)) return 'ne';
    if (isVoid(row + 1, col) && isVoid(row, col - 1)) return 'sw';
  }

  return null;
}

/**
 * Fill only the floor triangle of a trimmed cell.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} x - Cell X in feet
 * @param {number} y - Cell Y in feet
 * @param {number} size - Cell size in feet
 * @param {string} fillColor - CSS fill color
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {string} voidCorner - Corner direction ('nw', 'ne', 'sw', 'se')
 * @returns {void}
 */
function fillTrimmedCell(ctx, x, y, size, fillColor, transform, voidCorner) {
  const tl = toCanvas(x, y, transform);
  const tr = toCanvas(x + size, y, transform);
  const bl = toCanvas(x, y + size, transform);
  const br = toCanvas(x + size, y + size, transform);

  ctx.fillStyle = fillColor;
  ctx.beginPath();

  switch (voidCorner) {
    case 'nw':
      ctx.moveTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      break;
    case 'ne':
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.lineTo(br.x, br.y);
      break;
    case 'sw':
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      break;
    case 'se':
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(bl.x, bl.y);
      break;
  }

  ctx.closePath();
  ctx.fill();
}

/**
 * Fill a full room square cell.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} x - Cell X in feet
 * @param {number} y - Cell Y in feet
 * @param {number} size - Cell size in feet
 * @param {string} fillColor - CSS fill color
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {void}
 */
function fillRoomSquare(ctx, x, y, size, fillColor, transform) {
  const p1 = toCanvas(x, y, transform);
  const p2 = toCanvas(x + size, y + size, transform);
  const pixelSize = p2.x - p1.x;

  ctx.fillStyle = fillColor;
  ctx.fillRect(p1.x, p1.y, pixelSize, pixelSize);
}

export {
  determineRoomCells,
  getDiagonalTrimCorner,
  fillTrimmedCell,
  fillRoomSquare,
};
