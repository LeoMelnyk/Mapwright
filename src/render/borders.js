import { GRID_SCALE } from './constants.js';
import { toCanvas } from './bounds.js';

// ─── Constants ─────
const DOOR_LENGTH_MULT = 0.6;
const DIAG_DOOR_LENGTH_MULT = 0.80 * Math.SQRT2; // Compensate for sqrt(2) diagonal length so door fills 80% of the diagonal
const SECRET_FONT_MULT = 0.7;
const STAIR_NUM_LINES = 6;
const STAIR_HATCH_MARGIN = 0.08;
const STAIR_HATCH_LINE_SPACING = 0.2;

/**
 * Compute a scale factor relative to the base GRID_SCALE.
 * Static renderer: transform.scale === GRID_SCALE → s = 1
 * Editor at zoom 2x: transform.scale === 2*GRID_SCALE → s = 2
 */
function scaleFactor(transform) {
  return transform.scale / GRID_SCALE;
}

/**
 * Render a border (wall, door, or secret door)
 */
function renderBorder(ctx, x1, y1, x2, y2, borderType, orientation, theme, gridSize, transform) {
  const s = scaleFactor(transform);
  // Compute wall span in grid units — normally 1, but resolution-aware calls may pass wider spans
  const wallSpan = orientation === 'horizontal' ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
  const doorGridSize = wallSpan * gridSize; // use wall length for door sizing, not raw gridSize
  const fx1 = x1 * gridSize;
  const fy1 = y1 * gridSize;
  const fx2 = x2 * gridSize;
  const fy2 = y2 * gridSize;

  const p1 = toCanvas(fx1, fy1, transform);
  const p2 = toCanvas(fx2, fy2, transform);

  ctx.lineCap = 'square';

  if (borderType === 'w') {
    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  } else if (borderType === 'iw') {
    // Invisible wall: dashed blue ghost line (only shown when wall/door tool is active)
    ctx.save();
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeStyle = 'rgba(80, 130, 255, 0.65)';
    ctx.lineWidth = 4 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();
  } else if (borderType === 'id') {
    // Invisible door: ghost door symbol (only shown when wall/door tool is active)
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const doorLength = doorGridSize * transform.scale * DOOR_LENGTH_MULT;
    const halfDoorLength = doorLength / 2;

    ctx.save();
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeStyle = 'rgba(80, 130, 255, 0.65)';
    ctx.lineWidth = 4 * s;
    ctx.lineCap = 'round';

    if (orientation === 'horizontal') {
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(midX - halfDoorLength, midY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(midX + halfDoorLength, midY); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(midX, midY - halfDoorLength); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(midX, midY + halfDoorLength); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Ghost door rectangle
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = 'rgba(80, 130, 255, 0.3)';
    ctx.strokeStyle = 'rgba(80, 130, 255, 0.85)';
    ctx.lineWidth = 2 * s;
    const doorThickness = 6 * s;
    if (orientation === 'horizontal') {
      ctx.fillRect(midX - halfDoorLength / 2, midY - doorThickness / 2, doorLength / 2 * 1.0, doorThickness);
      ctx.strokeRect(midX - halfDoorLength / 2, midY - doorThickness / 2, doorLength / 2 * 1.0, doorThickness);
    } else {
      ctx.fillRect(midX - doorThickness / 2, midY - halfDoorLength / 2, doorThickness, doorLength / 2 * 1.0);
      ctx.strokeRect(midX - doorThickness / 2, midY - halfDoorLength / 2, doorThickness, doorLength / 2 * 1.0);
    }
    ctx.restore();
  } else if (borderType === 'd') {
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    const doorLength = doorGridSize * transform.scale * DOOR_LENGTH_MULT;
    const halfDoorLength = doorLength / 2;

    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;

    if (orientation === 'horizontal') {
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(midX - halfDoorLength, midY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(midX + halfDoorLength, midY);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(midX, midY - halfDoorLength);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(midX, midY + halfDoorLength);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    drawDoorAtPosition(ctx, midX, midY, orientation, theme, doorGridSize, transform);
  } else if (borderType === 's') {
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    const doorLength = doorGridSize * transform.scale * DOOR_LENGTH_MULT;
    const halfDoorLength = doorLength / 2;

    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;

    if (orientation === 'horizontal') {
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(midX - halfDoorLength, midY);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(midX + halfDoorLength, midY);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(midX, midY - halfDoorLength);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(midX, midY + halfDoorLength);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    drawSecretDoorAtPosition(ctx, midX, midY, orientation, theme, doorGridSize, transform);
  }
}

/**
 * Draw a door at a specific position
 */
function drawDoorAtPosition(ctx, cx, cy, orientation, theme, gridSize, transform) {
  const s = scaleFactor(transform);
  const doorLength = gridSize * transform.scale * DOOR_LENGTH_MULT;
  const doorThickness = 6 * s;

  ctx.fillStyle = theme.doorFill || '#FFFFFF';
  ctx.strokeStyle = theme.doorStroke || theme.wallStroke;
  ctx.lineWidth = 2 * s;

  if (orientation === 'horizontal') {
    const halfLength = doorLength / 2;
    ctx.fillRect(cx - halfLength, cy - doorThickness / 2, doorLength, doorThickness);
    ctx.strokeRect(cx - halfLength, cy - doorThickness / 2, doorLength, doorThickness);
  } else {
    const halfLength = doorLength / 2;
    ctx.fillRect(cx - doorThickness / 2, cy - halfLength, doorThickness, doorLength);
    ctx.strokeRect(cx - doorThickness / 2, cy - halfLength, doorThickness, doorLength);
  }
}

/**
 * Draw a secret door at a specific position
 */
function drawSecretDoorAtPosition(ctx, cx, cy, orientation, theme, gridSize, transform) {
  ctx.save();

  ctx.fillStyle = theme.secretDoorColor || theme.wallStroke;
  ctx.strokeStyle = theme.secretDoorColor || theme.wallStroke;

  const fontSize = gridSize * transform.scale * SECRET_FONT_MULT;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (orientation === 'horizontal') {
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 2);
    ctx.fillText('S', 0, 0);
  } else {
    ctx.fillText('S', cx, cy);
  }

  ctx.restore();
}

/**
 * Draw stairs icon in a matrix cell center
 */
function drawStairsInCell(ctx, cx, cy, stairType, theme, gridSize, hasLabel, transform) {
  const s = transform ? scaleFactor(transform) : 1;
  ctx.save();
  const color = theme.wallStroke || '#000000';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  const yOffset = (hasLabel ? 8 : 0) * s;
  const centerX = cx;
  const centerY = cy + yOffset;

  const numLines = STAIR_NUM_LINES;
  const lineSpacing = 5 * s;
  const maxLineLength = 32 * s;
  const minLineLength = 6 * s;
  const totalHeight = (numLines - 1) * lineSpacing;
  const topY = centerY - totalHeight / 2;

  ctx.lineWidth = 1.5 * s;
  ctx.lineCap = 'round';

  for (let i = 0; i < numLines; i++) {
    let progress;
    if (stairType === 'stairs-up') {
      progress = (numLines - 1 - i) / (numLines - 1);
    } else {
      progress = i / (numLines - 1);
    }
    const lineLen = minLineLength + progress * (maxLineLength - minLineLength);
    const y = topY + i * lineSpacing;

    ctx.beginPath();
    ctx.moveTo(centerX - lineLen / 2, y);
    ctx.lineTo(centerX + lineLen / 2, y);
    ctx.stroke();
  }

  const arrowSize = 7 * s;
  const arrowGap = 5 * s;
  if (stairType === 'stairs-up') {
    const arrowTipY = topY - arrowGap - arrowSize;
    ctx.beginPath();
    ctx.moveTo(centerX, arrowTipY);
    ctx.lineTo(centerX - arrowSize, arrowTipY + arrowSize);
    ctx.lineTo(centerX + arrowSize, arrowTipY + arrowSize);
    ctx.closePath();
    ctx.fill();
  } else {
    const arrowTipY = topY + totalHeight + arrowGap + arrowSize;
    ctx.beginPath();
    ctx.moveTo(centerX, arrowTipY);
    ctx.lineTo(centerX - arrowSize, arrowTipY - arrowSize);
    ctx.lineTo(centerX + arrowSize, arrowTipY - arrowSize);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Render a diagonal border (wall, door, or secret door)
 */
function renderDiagonalBorder(ctx, col, row, borderType, diagonal, theme, gridSize, transform, span = 1) {
  const s = scaleFactor(transform);
  let fx1, fy1, fx2, fy2;

  if (diagonal === 'nw-se') {
    fx1 = col * gridSize;
    fy1 = row * gridSize;
    fx2 = (col + span) * gridSize;
    fy2 = (row + span) * gridSize;
  } else {
    fx1 = (col + 1) * gridSize;
    fy1 = row * gridSize;
    fx2 = (col + 1 - span) * gridSize;
    fy2 = (row + span) * gridSize;
  }
  // Scale door length to match the span
  const doorGs = gridSize * span;

  const p1 = toCanvas(fx1, fy1, transform);
  const p2 = toCanvas(fx2, fy2, transform);

  ctx.lineCap = 'square';

  if (borderType === 'w') {
    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

  } else if (borderType === 'iw') {
    // Invisible diagonal wall: dashed blue ghost line
    ctx.save();
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeStyle = 'rgba(80, 130, 255, 0.65)';
    ctx.lineWidth = 4 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();

  } else if (borderType === 'id') {
    // Invisible diagonal door: ghost diagonal door symbol
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const doorLength = doorGs * transform.scale * DIAG_DOOR_LENGTH_MULT;
    const halfDoorLength = doorLength / 2;
    const diagonalLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
    const ratio = halfDoorLength / diagonalLength;
    const dx = (p2.x - p1.x) * ratio;
    const dy = (p2.y - p1.y) * ratio;

    ctx.save();
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.strokeStyle = 'rgba(80, 130, 255, 0.65)';
    ctx.lineWidth = 4 * s;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(midX - dx, midY - dy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(midX + dx, midY + dy); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    ctx.setLineDash([]);

    // Ghost door rectangle at diagonal
    ctx.translate(midX, midY);
    if (diagonal === 'nw-se') { ctx.rotate(Math.PI / 4); } else { ctx.rotate(-Math.PI / 4); }
    const doorThickness = 6 * s;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = 'rgba(80, 130, 255, 0.3)';
    ctx.strokeStyle = 'rgba(80, 130, 255, 0.85)';
    ctx.lineWidth = 2 * s;
    ctx.fillRect(-halfDoorLength / 2, -doorThickness / 2, doorLength / 2, doorThickness);
    ctx.strokeRect(-halfDoorLength / 2, -doorThickness / 2, doorLength / 2, doorThickness);
    ctx.restore();

  } else if (borderType === 'd') {
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    const doorLength = doorGs * transform.scale * DIAG_DOOR_LENGTH_MULT;
    const halfDoorLength = doorLength / 2;

    const diagonalLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
    const ratio = halfDoorLength / diagonalLength;
    const dx = (p2.x - p1.x) * ratio;
    const dy = (p2.y - p1.y) * ratio;

    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(midX - dx, midY - dy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(midX + dx, midY + dy);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    drawDiagonalDoor(ctx, midX, midY, diagonal, theme, doorGs, transform);

  } else if (borderType === 's') {
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    const doorLength = doorGs * transform.scale * DIAG_DOOR_LENGTH_MULT;
    const halfDoorLength = doorLength / 2;

    const diagonalLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
    const ratio = halfDoorLength / diagonalLength;
    const dx = (p2.x - p1.x) * ratio;
    const dy = (p2.y - p1.y) * ratio;

    ctx.strokeStyle = theme.wallStroke;
    ctx.lineWidth = 6 * s;

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(midX - dx, midY - dy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(midX + dx, midY + dy);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    drawDiagonalSecretDoor(ctx, midX, midY, diagonal, theme, doorGs, transform);
  }
}

function drawDiagonalDoor(ctx, cx, cy, diagonal, theme, gridSize, transform) {
  const s = scaleFactor(transform);
  const doorLength = gridSize * transform.scale * DOOR_LENGTH_MULT;
  const doorThickness = 6 * s;

  ctx.save();
  ctx.translate(cx, cy);

  if (diagonal === 'nw-se') {
    ctx.rotate(Math.PI / 4);
  } else {
    ctx.rotate(-Math.PI / 4);
  }

  ctx.fillStyle = theme.doorFill || '#ffffff';
  ctx.strokeStyle = theme.doorStroke || theme.wallStroke;
  ctx.lineWidth = 2 * s;

  const halfLength = doorLength / 2;
  ctx.fillRect(-halfLength, -doorThickness / 2, doorLength, doorThickness);
  ctx.strokeRect(-halfLength, -doorThickness / 2, doorLength, doorThickness);

  ctx.restore();
}

function drawDiagonalSecretDoor(ctx, cx, cy, diagonal, theme, gridSize, transform) {
  ctx.save();
  ctx.translate(cx, cy);

  if (diagonal === 'nw-se') {
    ctx.rotate(Math.PI / 4);
  } else {
    ctx.rotate(-Math.PI / 4);
  }

  ctx.fillStyle = theme.secretDoorColor || theme.wallStroke;
  const fontSize = gridSize * transform.scale * SECRET_FONT_MULT;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('S', 0, 0);

  ctx.restore();
}

// ── Double Door Auto-Detection ──────────────────────────────────────────────

function getDoubleDoorRole(cells, row, col, borderDirection, resolution = 1) {
  return _getDoorRole(cells, row, col, borderDirection, resolution, 'cardinal');
}

/**
 * Unified door role logic for both cardinal and diagonal directions.
 *
 * Groups sub-cells into display doors (pairs of `resolution`), then groups
 * display doors into double doors (pairs of 2).
 *
 * Returns:
 *   'anchor'      — first sub-cell of a double door (renders the double door)
 *   'single-wide' — first sub-cell of a lone display door (renders single door at display scale)
 *   'partner'     — skip (already rendered by an anchor or single-wide)
 *   null          — leftover sub-cell, render at sub-cell scale
 */
function _getDoorRole(cells, row, col, direction, resolution, mode) {
  const cell = cells[row]?.[col];
  if (!cell) return null;
  const bt = cell[direction];
  if (bt !== 'd' && bt !== 's') return null;

  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Step direction along the run
  let dr, dc;
  if (mode === 'cardinal') {
    if (direction === 'north' || direction === 'south') { dr = 0; dc = 1; }
    else { dr = 1; dc = 0; }
  } else {
    // diagonal
    if (direction === 'nw-se') { dr = 1; dc = 1; }
    else { dr = 1; dc = -1; }
  }

  // Walk backwards to find run start
  let startR = row, startC = col;
  while (true) {
    const pr = startR - dr, pc = startC - dc;
    if (pr < 0 || pr >= numRows || pc < 0 || pc >= numCols) break;
    if (cells[pr]?.[pc]?.[direction] !== bt) break;
    startR = pr; startC = pc;
  }

  // Count total run length
  let runLen = 0;
  let r = startR, c = startC;
  while (r >= 0 && r < numRows && c >= 0 && c < numCols && cells[r]?.[c]?.[direction] === bt) {
    runLen++;
    r += dr; c += dc;
  }

  // Position = number of steps from run start (not Manhattan distance)
  const posInRun = dr !== 0 ? Math.abs(row - startR) : Math.abs(col - startC);

  // Group into display doors, then pair display doors into doubles
  const numDisplayDoors = Math.floor(runLen / resolution);
  const numDoublePairs = Math.floor(numDisplayDoors / 2);
  const leftoverDisplayDoors = numDisplayDoors % 2;

  // Zone boundaries (in sub-cell positions from run start)
  const doubleZoneEnd = numDoublePairs * 2 * resolution;
  const singleWideZoneEnd = doubleZoneEnd + leftoverDisplayDoors * resolution;
  // Anything past singleWideZoneEnd is leftover sub-cells → null

  if (posInRun < doubleZoneEnd) {
    // Inside a double-door zone
    // Each double door spans 2*resolution sub-cells
    const posInDouble = posInRun % (2 * resolution);
    return posInDouble === 0 ? 'anchor' : 'partner';
  }

  if (posInRun < singleWideZoneEnd) {
    // Inside a single-wide (display door) zone
    const posInSingle = posInRun - doubleZoneEnd;
    return posInSingle === 0 ? 'single-wide' : 'partner';
  }

  // Leftover sub-cell — render at sub-cell scale
  return null;
}

function getDoubleDoorDiagonalRole(cells, row, col, diagonal, resolution = 1) {
  return _getDoorRole(cells, row, col, diagonal, resolution, 'diagonal');
}

function renderDoubleBorder(ctx, cells, row, col, borderDirection, borderType, orientation, theme, gridSize, transform, resolution = 1) {
  const s = scaleFactor(transform);
  const span = 2 * resolution; // double door spans 2 display cells = 2*resolution sub-cells
  let gx1, gy1, gx2, gy2;
  if (borderDirection === 'north') {
    gx1 = col; gy1 = row; gx2 = col + span; gy2 = row;
  } else if (borderDirection === 'south') {
    gx1 = col; gy1 = row + 1; gx2 = col + span; gy2 = row + 1;
  } else if (borderDirection === 'west') {
    gx1 = col; gy1 = row; gx2 = col; gy2 = row + span;
  } else if (borderDirection === 'east') {
    gx1 = col + 1; gy1 = row; gx2 = col + 1; gy2 = row + span;
  }

  const p1 = toCanvas(gx1 * gridSize, gy1 * gridSize, transform);
  const p2 = toCanvas(gx2 * gridSize, gy2 * gridSize, transform);

  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;

  const doubleDoorLength = gridSize * (resolution || 1) * transform.scale * 1.6;
  const halfDoorLength = doubleDoorLength / 2;

  ctx.strokeStyle = theme.wallStroke;
  ctx.lineWidth = 6 * s;
  ctx.lineCap = 'square';

  if (orientation === 'horizontal') {
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(midX - halfDoorLength, midY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(midX + halfDoorLength, midY);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(midX, midY - halfDoorLength);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(midX, midY + halfDoorLength);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  const displayGs = gridSize * (resolution || 1);
  if (borderType === 'd') {
    drawDoubleDoorAtPosition(ctx, midX, midY, orientation, theme, displayGs, transform);
  } else if (borderType === 's') {
    drawDoubleSecretDoorAtPosition(ctx, midX, midY, orientation, theme, displayGs, transform);
  }
}

function renderDiagonalDoubleBorder(ctx, cells, row, col, borderType, diagonal, theme, gridSize, transform, resolution = 1) {
  const s = scaleFactor(transform);
  const span = 2 * resolution; // double door spans 2 display cells

  let fx1, fy1, fx2, fy2;
  if (diagonal === 'nw-se') {
    fx1 = col * gridSize;            fy1 = row * gridSize;
    fx2 = (col + span) * gridSize;   fy2 = (row + span) * gridSize;
  } else {
    fx1 = (col + 1) * gridSize;          fy1 = row * gridSize;
    fx2 = (col + 1 - span) * gridSize;   fy2 = (row + span) * gridSize;
  }

  const p1 = toCanvas(fx1, fy1, transform);
  const p2 = toCanvas(fx2, fy2, transform);
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;

  const doubleDoorLength = gridSize * (resolution || 1) * transform.scale * (2 * DIAG_DOOR_LENGTH_MULT);
  const halfDoorLength = doubleDoorLength / 2;

  const diagLen = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
  const ratio = halfDoorLength / diagLen;
  const dx = (p2.x - p1.x) * ratio;
  const dy = (p2.y - p1.y) * ratio;

  ctx.strokeStyle = theme.wallStroke;
  ctx.lineWidth = 6 * s;
  ctx.lineCap = 'square';

  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(midX - dx, midY - dy);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(midX + dx, midY + dy);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  const displayGs = gridSize * (resolution || 1);
  if (borderType === 'd') {
    drawDiagonalDoubleDoor(ctx, midX, midY, diagonal, theme, displayGs, transform);
  } else if (borderType === 's') {
    drawDiagonalDoubleSecretDoor(ctx, midX, midY, diagonal, theme, displayGs, transform);
  }
}

function drawDoubleDoorAtPosition(ctx, cx, cy, orientation, theme, gridSize, transform) {
  const s = scaleFactor(transform);
  const totalLength = gridSize * transform.scale * 1.6;
  const doorThickness = 6 * s;
  const panelLength = totalLength / 2;
  const gap = 2 * s;

  ctx.fillStyle = theme.doorFill || '#FFFFFF';
  ctx.strokeStyle = theme.doorStroke || theme.wallStroke;
  ctx.lineWidth = 2 * s;

  const halfTotal = totalLength / 2;
  const halfThick = doorThickness / 2;

  if (orientation === 'horizontal') {
    ctx.fillRect(cx - halfTotal, cy - halfThick, panelLength - gap / 2, doorThickness);
    ctx.strokeRect(cx - halfTotal, cy - halfThick, panelLength - gap / 2, doorThickness);
    ctx.fillRect(cx + gap / 2, cy - halfThick, panelLength - gap / 2, doorThickness);
    ctx.strokeRect(cx + gap / 2, cy - halfThick, panelLength - gap / 2, doorThickness);
  } else {
    ctx.fillRect(cx - halfThick, cy - halfTotal, doorThickness, panelLength - gap / 2);
    ctx.strokeRect(cx - halfThick, cy - halfTotal, doorThickness, panelLength - gap / 2);
    ctx.fillRect(cx - halfThick, cy + gap / 2, doorThickness, panelLength - gap / 2);
    ctx.strokeRect(cx - halfThick, cy + gap / 2, doorThickness, panelLength - gap / 2);
  }
}

function drawDoubleSecretDoorAtPosition(ctx, cx, cy, orientation, theme, gridSize, transform) {
  ctx.save();
  ctx.fillStyle = theme.secretDoorColor || theme.wallStroke;

  const fontSize = gridSize * transform.scale * 1.0;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (orientation === 'horizontal') {
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 2);
    ctx.fillText('S', 0, 0);
  } else {
    ctx.fillText('S', cx, cy);
  }

  ctx.restore();
}

function drawDiagonalDoubleDoor(ctx, cx, cy, diagonal, theme, gridSize, transform) {
  const s = scaleFactor(transform);
  const totalLength = gridSize * transform.scale * (2 * DIAG_DOOR_LENGTH_MULT);
  const doorThickness = 6 * s;
  const panelLength = totalLength / 2;
  const gap = 2 * s;

  ctx.save();
  ctx.translate(cx, cy);

  if (diagonal === 'nw-se') {
    ctx.rotate(Math.PI / 4);
  } else {
    ctx.rotate(-Math.PI / 4);
  }

  ctx.fillStyle = theme.doorFill || '#ffffff';
  ctx.strokeStyle = theme.doorStroke || theme.wallStroke;
  ctx.lineWidth = 2 * s;

  const halfTotal = totalLength / 2;
  const halfThick = doorThickness / 2;

  ctx.fillRect(-halfTotal, -halfThick, panelLength - gap / 2, doorThickness);
  ctx.strokeRect(-halfTotal, -halfThick, panelLength - gap / 2, doorThickness);
  ctx.fillRect(gap / 2, -halfThick, panelLength - gap / 2, doorThickness);
  ctx.strokeRect(gap / 2, -halfThick, panelLength - gap / 2, doorThickness);

  ctx.restore();
}

function drawDiagonalDoubleSecretDoor(ctx, cx, cy, diagonal, theme, gridSize, transform) {
  ctx.save();
  ctx.translate(cx, cy);

  if (diagonal === 'nw-se') {
    ctx.rotate(Math.PI / 4);
  } else {
    ctx.rotate(-Math.PI / 4);
  }

  ctx.fillStyle = theme.secretDoorColor || theme.wallStroke;
  const fontSize = gridSize * transform.scale * 1.0;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('S', 0, 0);

  ctx.restore();
}

/**
 * Draw a stairs link label badge (circled letter) near the stairs icon
 */
function drawStairsLinkLabel(ctx, cx, cy, label, theme, transform) {
  const s = transform ? scaleFactor(transform) : 1;
  ctx.save();
  const radius = 8 * s;
  const badgeX = cx + 20 * s;
  const badgeY = cy - 16 * s;

  // Circle background
  ctx.beginPath();
  ctx.arc(badgeX, badgeY, radius, 0, Math.PI * 2);
  ctx.fillStyle = theme.wallStroke || '#000000';
  ctx.fill();

  // Letter
  ctx.fillStyle = theme.floorFill || '#ffffff';
  ctx.font = `bold ${10 * s}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, badgeX, badgeY);

  ctx.restore();
}

/**
 * Draw a stair shape from a metadata stair definition.
 * Renders parallel hatching lines within the polygon defined by the 3 corner points.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ id: number, points: number[][], link: string|null }} stairDef
 * @param {object} theme
 * @param {number} gridSize
 * @param {object} transform
 */
function drawStairShape(ctx, stairDef, theme, gridSize, transform) {
  const [p1, p2, p3] = stairDef.points;
  const lines = _computeStairHatchLines(p1, p2, p3);
  if (lines.length === 0) return;

  const s = scaleFactor(transform);
  const color = theme.wallStroke || '#000000';

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * s;
  ctx.lineCap = 'round';

  for (const line of lines) {
    const start = toCanvas(line.c1 * gridSize, line.r1 * gridSize, transform);
    const end = toCanvas(line.c2 * gridSize, line.r2 * gridSize, transform);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Compute hatching lines for a stair shape (inline, to avoid cross-module import in render/).
 *
 * Unified algorithm: decompose P3 relative to P2 into depth (perpendicular to base)
 * and inward shift (parallel to base toward P1). narrowLen = baseLen - 2 * inward.
 * This naturally handles rectangles (inward=0), trapezoids, and triangles.
 */
function _computeStairHatchLines(p1, p2, p3, lineSpacing = STAIR_HATCH_LINE_SPACING) {
  // Base vector and length
  const baseR = p2[0] - p1[0];
  const baseC = p2[1] - p1[1];
  const baseLen = Math.hypot(baseR, baseC);
  if (baseLen < 0.01) return [];
  const baseUnitR = baseR / baseLen;
  const baseUnitC = baseC / baseLen;

  // Decompose P3-P2 into base-parallel (inward) and base-perpendicular (depth)
  const relR = p3[0] - p2[0];
  const relC = p3[1] - p2[1];
  const inward = -(relR * baseUnitR + relC * baseUnitC);
  const depthR = relR + inward * baseUnitR;
  const depthC = relC + inward * baseUnitC;
  const depth = Math.hypot(depthR, depthC);
  if (depth < 0.01) return [];

  // Narrow end: centered on the depth midline
  const narrowLen = baseLen - 2 * inward;
  const midR = (p1[0] + p2[0]) / 2;
  const midC = (p1[1] + p2[1]) / 2;
  const narrowCenterR = midR + depthR;
  const narrowCenterC = midC + depthC;

  let narrowStart, narrowEnd;
  if (narrowLen > 0.05) {
    const halfNarrow = narrowLen / 2;
    narrowStart = [narrowCenterR - halfNarrow * baseUnitR, narrowCenterC - halfNarrow * baseUnitC];
    narrowEnd = [narrowCenterR + halfNarrow * baseUnitR, narrowCenterC + halfNarrow * baseUnitC];
  } else {
    narrowStart = [narrowCenterR, narrowCenterC];
    narrowEnd = [narrowCenterR, narrowCenterC];
  }

  const numLines = Math.max(1, Math.round(depth / lineSpacing));
  const lines = [];
  const margin = STAIR_HATCH_MARGIN;

  for (let i = 0; i <= numLines; i++) {
    const t = margin + (i / numLines) * (1 - 2 * margin);
    const r1 = p1[0] + t * (narrowStart[0] - p1[0]);
    const c1 = p1[1] + t * (narrowStart[1] - p1[1]);
    const r2 = p2[0] + t * (narrowEnd[0] - p2[0]);
    const c2 = p2[1] + t * (narrowEnd[1] - p2[1]);
    const lineLen = Math.hypot(r2 - r1, c2 - c1);
    if (lineLen < 0.05) continue;
    lines.push({ r1, c1, r2, c2 });
  }
  return lines;
}

/**
 * Draw a stair link label badge at a specific world-feet position.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} worldX - World feet X position
 * @param {number} worldY - World feet Y position
 * @param {string} label - Letter label (A-Z)
 * @param {object} theme
 * @param {object} transform
 */
function drawStairShapeLinkLabel(ctx, worldX, worldY, label, theme, transform) {
  const s = scaleFactor(transform);
  const p = toCanvas(worldX, worldY, transform);
  ctx.save();
  const radius = 8 * s;
  // Offset slightly into the stair area (southeast from corner)
  const badgeX = p.x + 10 * s;
  const badgeY = p.y + 10 * s;

  // Circle background
  ctx.beginPath();
  ctx.arc(badgeX, badgeY, radius, 0, Math.PI * 2);
  ctx.fillStyle = theme.wallStroke || '#000000';
  ctx.fill();

  // Letter
  ctx.fillStyle = theme.floorFill || '#ffffff';
  ctx.font = `bold ${10 * s}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, badgeX, badgeY);

  ctx.restore();
}

/**
 * Return canvas-space endpoints for a cardinal wall segment (without drawing).
 */
function wallSegmentCoords(x1, y1, x2, y2, gridSize, transform) {
  const fx1 = x1 * gridSize;
  const fy1 = y1 * gridSize;
  const fx2 = x2 * gridSize;
  const fy2 = y2 * gridSize;
  const p1 = toCanvas(fx1, fy1, transform);
  const p2 = toCanvas(fx2, fy2, transform);
  return { p1, p2 };
}

/**
 * Return canvas-space endpoints for a diagonal wall segment (without drawing).
 */
function diagonalWallSegmentCoords(col, row, diagonal, gridSize, transform) {
  let fx1, fy1, fx2, fy2;
  if (diagonal === 'nw-se') {
    fx1 = col * gridSize;
    fy1 = row * gridSize;
    fx2 = (col + 1) * gridSize;
    fy2 = (row + 1) * gridSize;
  } else {
    fx1 = (col + 1) * gridSize;
    fy1 = row * gridSize;
    fx2 = col * gridSize;
    fy2 = (row + 1) * gridSize;
  }
  const p1 = toCanvas(fx1, fy1, transform);
  const p2 = toCanvas(fx2, fy2, transform);
  return { p1, p2 };
}

export {
  renderBorder,
  drawDoorAtPosition,
  drawSecretDoorAtPosition,
  drawStairsInCell,
  drawStairShape,
  drawStairShapeLinkLabel,
  renderDiagonalBorder,
  drawDiagonalDoor,
  drawDiagonalSecretDoor,
  getDoubleDoorRole,
  getDoubleDoorDiagonalRole,
  renderDoubleBorder,
  renderDiagonalDoubleBorder,
  drawDoubleDoorAtPosition,
  drawDoubleSecretDoorAtPosition,
  drawDiagonalDoubleDoor,
  drawDiagonalDoubleSecretDoor,
  drawStairsLinkLabel,
  wallSegmentCoords,
  diagonalWallSegmentCoords,
  scaleFactor
};
