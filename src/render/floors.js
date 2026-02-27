import { toCanvas } from './bounds.js';
import { seededLcg } from './effects.js';
import { isEdgeOpen } from '../util/index.js';

/**
 * Determine which cells should have room backgrounds (including flood fill for enclosed areas)
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

  function floodFillOutside(row, col) {
    if (row < 0 || row >= numRows || col < 0 || col >= numCols) return;
    if (isOutside[row][col]) return;

    const cell = cells[row][col];
    isOutside[row][col] = true;

    if (row > 0 && isEdgeOpen(cell, cells[row - 1]?.[col], 'north')) {
      floodFillOutside(row - 1, col);
    }
    if (row < numRows - 1 && isEdgeOpen(cell, cells[row + 1]?.[col], 'south')) {
      floodFillOutside(row + 1, col);
    }
    if (col < numCols - 1 && isEdgeOpen(cell, cells[row]?.[col + 1], 'east')) {
      floodFillOutside(row, col + 1);
    }
    if (col > 0 && isEdgeOpen(cell, cells[row]?.[col - 1], 'west')) {
      floodFillOutside(row, col - 1);
    }
  }

  for (let col = 0; col < numCols; col++) {
    floodFillOutside(0, col);
    floodFillOutside(numRows - 1, col);
  }
  for (let row = 0; row < numRows; row++) {
    floodFillOutside(row, 0);
    floodFillOutside(row, numCols - 1);
  }

  return isRoom;
}

/**
 * Get the void corner for a cell with a diagonal wall.
 */
function getDiagonalTrimCorner(cell, cells, row, col) {
  // insideArc cells are full floor cells rendered as rectangles — their trimCorner
  // is metadata for BFS, not a diagonal clip indicator.
  if (cell.trimInsideArc) return null;
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
 * Fill only the floor triangle of a trimmed cell
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

function fillRoomSquare(ctx, x, y, size, fillColor, transform) {
  const p1 = toCanvas(x, y, transform);
  const p2 = toCanvas(x + size, y + size, transform);
  const pixelSize = p2.x - p1.x;

  ctx.fillStyle = fillColor;
  ctx.fillRect(p1.x, p1.y, pixelSize, pixelSize);
}

/**
 * Sample N points along an arc with radial noise for a hand-drawn look.
 * The first point is moved-to (no noise), interior points have radial jitter,
 * and the final endpoint is exact so it joins cleanly to adjacent straight walls.
 */
function drawRoughArc(ctx, cx, cy, radius, startAngle, endAngle, anticlockwise, roughness, rand) {
  // Compute signed angular span in the direction of travel
  let span = endAngle - startAngle;
  if (anticlockwise) {
    if (span > 0) span -= 2 * Math.PI;
  } else {
    if (span < 0) span += 2 * Math.PI;
  }

  const arcLen = Math.abs(span) * radius;
  const spacing = 25;
  const numCtrl = Math.max(1, Math.ceil(arcLen / spacing));

  // Generate control points with radial offsets along the arc
  const pts = [];
  for (let i = 0; i <= numCtrl; i++) {
    const t = i / numCtrl;
    const angle = startAngle + span * t;
    const noise = (i > 0 && i < numCtrl) ? (rand() - 0.5) * 2 * roughness : 0;
    const r = radius + noise;
    pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }

  // Smooth curve through control points using quadratic Bézier
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const xMid = (pts[i].x + pts[i + 1].x) / 2;
      const yMid = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, xMid, yMid);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
}

/**
 * Draw a quarter-circle arc wall for a rounded trim corner.
 * Applies the same rough-line and drop-shadow effects as straight walls.
 */
function drawRoundedWall(ctx, rc, theme, gridSize, transform) {
  const R = rc.radius * gridSize;
  const Rpx = R * transform.scale;
  const s = transform.scale / 10;

  const useRough = (theme.wallRoughness || 0) > 0;
  const amp = (theme.wallRoughness || 0) * s * 1.5;
  const seed = (rc.centerRow * 1000 + rc.centerCol) * 17 + 99991;
  const rand = useRough ? seededLcg(seed) : null;

  // Resolve arc center and angle parameters
  let cx, cy, startAngle, endAngle, anticlockwise;
  if (rc.inverted) {
    const op = toCanvas(rc.centerCol * gridSize, rc.centerRow * gridSize, transform);
    cx = op.x; cy = op.y;
    switch (rc.corner) {
      case 'nw': startAngle = Math.PI / 2;     endAngle = 0;               anticlockwise = true;  break;
      case 'ne': startAngle = Math.PI / 2;     endAngle = Math.PI;         anticlockwise = false; break;
      case 'sw': startAngle = 0;               endAngle = 3 * Math.PI / 2; anticlockwise = true;  break;
      case 'se': startAngle = Math.PI;         endAngle = 3 * Math.PI / 2; anticlockwise = false; break;
    }
  } else {
    let acx, acy;
    switch (rc.corner) {
      case 'nw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
      case 'ne': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow + rc.radius) * gridSize; break;
      case 'sw': acx = (rc.centerCol + rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
      case 'se': acx = (rc.centerCol - rc.radius) * gridSize; acy = (rc.centerRow - rc.radius) * gridSize; break;
    }
    const acp = toCanvas(acx, acy, transform);
    cx = acp.x; cy = acp.y;
    switch (rc.corner) {
      case 'nw': startAngle = 3 * Math.PI / 2; endAngle = Math.PI;         anticlockwise = true;  break;
      case 'ne': startAngle = 3 * Math.PI / 2; endAngle = 0;               anticlockwise = false; break;
      case 'sw': startAngle = Math.PI / 2;     endAngle = Math.PI;         anticlockwise = false; break;
      case 'se': startAngle = Math.PI / 2;     endAngle = 0;               anticlockwise = true;  break;
    }
  }

  // Shadow pass — clean arc, same shadow settings as straight walls
  if (theme.wallShadow) {
    const { color, blur, offsetX, offsetY } = theme.wallShadow;
    ctx.save();
    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;
    ctx.lineCap = 'butt';
    ctx.shadowColor = color;
    ctx.shadowBlur = blur * s;
    ctx.shadowOffsetX = offsetX * s;
    ctx.shadowOffsetY = offsetY * s;
    ctx.beginPath();
    ctx.arc(cx, cy, Rpx, startAngle, endAngle, anticlockwise);
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.restore();
  }

  // Wall stroke pass — rough or clean
  ctx.strokeStyle = theme.wallStroke;
  ctx.lineWidth = 6 * s;
  ctx.lineCap = useRough ? 'round' : 'butt';
  ctx.beginPath();
  if (useRough) {
    drawRoughArc(ctx, cx, cy, Rpx, startAngle, endAngle, anticlockwise, amp, rand);
  } else {
    ctx.arc(cx, cy, Rpx, startAngle, endAngle, anticlockwise);
  }
  ctx.stroke();
}

export {
  determineRoomCells,
  getDiagonalTrimCorner,
  fillTrimmedCell,
  fillRoomSquare,
  drawRoundedWall
};
