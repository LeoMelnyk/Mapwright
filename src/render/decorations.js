import { toCanvas } from './bounds.js';

/**
 * Draw background
 */
function drawBackground(ctx, width, height, theme) {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
}

/**
 * Draw dungeon title at the top of the map
 */
function drawDungeonTitle(ctx, width, dungeonName, fontSize, theme, yOffset = 0) {
  ctx.save();

  ctx.font = `bold ${fontSize}px Georgia, "Times New Roman", serif`;
  ctx.fillStyle = theme.textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const x = width / 2;
  const y = yOffset + 15;

  ctx.fillText(dungeonName, x, y);

  ctx.restore();
}

/**
 * Draw grid overlay for matrix-based map
 */
function drawMatrixGrid(ctx, cells, roomCells, gridSize, transform, theme, showGridInCorridors) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  ctx.globalAlpha = 0.5;

  const shouldDraw = (r, c) => {
    if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
    return roomCells[r][c] || (showGridInCorridors && cells[r]?.[c]);
  };

  ctx.beginPath();

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      if (!shouldDraw(row, col)) continue;

      if (shouldDraw(row + 1, col)) {
        const p1 = toCanvas(col * gridSize, (row + 1) * gridSize, transform);
        const p2 = toCanvas((col + 1) * gridSize, (row + 1) * gridSize, transform);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
      }

      if (shouldDraw(row, col + 1)) {
        const p1 = toCanvas((col + 1) * gridSize, row * gridSize, transform);
        const p2 = toCanvas((col + 1) * gridSize, (row + 1) * gridSize, transform);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
      }
    }
  }

  ctx.stroke();
  ctx.globalAlpha = 1.0;
}

/**
 * Draw grid overlay (legacy coordinate-based)
 */
function drawGrid(ctx, config, bounds, transform, theme) {
  const gridSize = config.gridSize;
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;

  const startX = Math.floor(bounds.minX / gridSize) * gridSize;
  const endX = Math.ceil(bounds.maxX / gridSize) * gridSize;
  for (let x = startX; x <= endX; x += gridSize) {
    const px = toCanvas(x, 0, transform);
    ctx.beginPath();
    ctx.moveTo(px.x, 0);
    ctx.lineTo(px.x, ctx.canvas.height);
    ctx.stroke();
  }

  const startY = Math.floor(bounds.minY / gridSize) * gridSize;
  const endY = Math.ceil(bounds.maxY / gridSize) * gridSize;
  for (let y = startY; y <= endY; y += gridSize) {
    const py = toCanvas(0, y, transform);
    ctx.beginPath();
    ctx.moveTo(0, py.y);
    ctx.lineTo(ctx.canvas.width, py.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1.0;
}

/**
 * Find the best position for compass rose
 */
function findCompassRosePosition(cells, gridSize, width, height, transform) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const isCornerClear = (canvasX, canvasY) => {
    const feetX = (canvasX - transform.offsetX) / transform.scale;
    const feetY = (canvasY - transform.offsetY) / transform.scale;

    const cellX = Math.floor(feetX / gridSize);
    const cellY = Math.floor(feetY / gridSize);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const checkX = cellX + dx;
        const checkY = cellY + dy;

        if (checkX < 0 || checkX >= numCols || checkY < 0 || checkY >= numRows) {
          continue;
        }

        if (cells[checkY][checkX] !== null) {
          return false;
        }
      }
    }

    return true;
  };

  const corners = [
    { x: width - 80, y: 80 },
    { x: 80, y: 80 },
    { x: width - 80, y: height - 80 },
    { x: 80, y: height - 80 }
  ];

  for (const corner of corners) {
    if (isCornerClear(corner.x, corner.y)) {
      return corner;
    }
  }

  return null;
}

/**
 * Draw compass rose (decorative 8-pointed design)
 */
function drawCompassRose(ctx, x, y, theme) {
  const size = 35;
  const innerSize = size * 0.6;

  const fillColor = theme.compassRoseFill || theme.wallStroke || '#000000';
  const strokeColor = theme.compassRoseStroke || theme.wallStroke || '#000000';

  ctx.save();

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.stroke();

  const drawPoint = (angle, length, filled) => {
    const rad = (angle - 90) * Math.PI / 180;
    const tipX = x + Math.cos(rad) * length;
    const tipY = y + Math.sin(rad) * length;
    const baseLeft = (angle - 90 - 15) * Math.PI / 180;
    const baseRight = (angle - 90 + 15) * Math.PI / 180;
    const baseLength = length * 0.3;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(x + Math.cos(baseLeft) * baseLength, y + Math.sin(baseLeft) * baseLength);
    ctx.lineTo(x, y);
    ctx.lineTo(x + Math.cos(baseRight) * baseLength, y + Math.sin(baseRight) * baseLength);
    ctx.closePath();

    if (filled) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };

  drawPoint(0, size, true);
  drawPoint(90, size * 0.9, false);
  drawPoint(180, size * 0.9, false);
  drawPoint(270, size * 0.9, false);

  drawPoint(45, innerSize, false);
  drawPoint(135, innerSize, false);
  drawPoint(225, innerSize, false);
  drawPoint(315, innerSize, false);

  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = theme.textColor || '#000000';
  ctx.font = 'bold 14px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('N', x, y - size - 8);

  ctx.restore();
}

/**
 * Draw scale indicator
 */
function drawScaleIndicator(ctx, x, y, gridSize, theme) {
  ctx.fillStyle = theme.textColor;
  ctx.font = 'bold 12px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillText(`1 square = ${gridSize} feet`, x, y);
}

/**
 * Draw decorative border
 */
function drawBorder(ctx, width, height, theme, borderType) {
  ctx.strokeStyle = theme.borderColor;
  ctx.lineWidth = 3;

  ctx.strokeRect(5, 5, width - 10, height - 10);

  ctx.lineWidth = 1;
  ctx.strokeRect(8, 8, width - 16, height - 16);
}

// ─── Map-space decoration variants ──────────────────────────────────────────
// These render relative to the dungeon grid bounds, so they pan/zoom with the map.

/**
 * Draw decorative border around the dungeon grid in map space.
 * @param {number} padding - padding in grid-feet outside the dungeon bounds
 */
function drawBorderOnMap(ctx, cells, gridSize, theme, transform, padding = 5) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const s = transform.scale / 10; // scale factor relative to GRID_SCALE=10

  // Dungeon bounds in feet
  const minXf = -padding;
  const minYf = -padding;
  const maxXf = numCols * gridSize + padding;
  const maxYf = numRows * gridSize + padding;

  const tl = toCanvas(minXf, minYf, transform);
  const br = toCanvas(maxXf, maxYf, transform);

  ctx.strokeStyle = theme.borderColor;
  ctx.lineWidth = 3 * s;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  const inset = 3 * s;
  ctx.lineWidth = 1 * s;
  ctx.strokeRect(tl.x + inset, tl.y + inset, br.x - tl.x - inset * 2, br.y - tl.y - inset * 2);
}

/**
 * Draw scale indicator in map space (below the dungeon grid).
 */
function drawScaleIndicatorOnMap(ctx, cells, gridSize, theme, transform) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const s = transform.scale / 10;

  // Position: center-bottom of the dungeon, slightly below
  const centerXf = (numCols * gridSize) / 2;
  const bottomYf = numRows * gridSize + 10; // 10 feet below
  const p = toCanvas(centerXf, bottomYf, transform);

  const fontSize = Math.max(8, Math.round(12 * s));

  ctx.fillStyle = theme.textColor;
  ctx.font = `bold ${fontSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`1 square = ${gridSize} feet`, p.x, p.y);
}

/**
 * Find compass rose position in map space (corners of the dungeon grid).
 */
function findCompassRosePositionOnMap(cells, gridSize, transform) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const s = transform.scale / 10;

  // Convert a feet position to cell coordinates and check if area is clear
  const isAreaClear = (feetX, feetY) => {
    const cellCol = Math.floor(feetX / gridSize);
    const cellRow = Math.floor(feetY / gridSize);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const checkCol = cellCol + dx;
        const checkRow = cellRow + dy;
        if (checkCol < 0 || checkCol >= numCols || checkRow < 0 || checkRow >= numRows) continue;
        if (cells[checkRow][checkCol] !== null) return false;
      }
    }
    return true;
  };

  // Offset from dungeon edges in feet
  const insetFeet = gridSize * 2;

  // Corners of the dungeon in feet (inset by a couple squares)
  const corners = [
    { fx: numCols * gridSize - insetFeet, fy: insetFeet },                       // top-right
    { fx: insetFeet, fy: insetFeet },                                             // top-left
    { fx: numCols * gridSize - insetFeet, fy: numRows * gridSize - insetFeet },   // bottom-right
    { fx: insetFeet, fy: numRows * gridSize - insetFeet },                        // bottom-left
  ];

  for (const corner of corners) {
    if (isAreaClear(corner.fx, corner.fy)) {
      const p = toCanvas(corner.fx, corner.fy, transform);
      return { x: p.x, y: p.y, scale: s };
    }
  }

  return null;
}

/**
 * Draw compass rose with optional scale factor.
 */
function drawCompassRoseScaled(ctx, x, y, theme, s = 1) {
  const size = 35 * s;
  const innerSize = size * 0.6;

  const fillColor = theme.compassRoseFill || theme.wallStroke || '#000000';
  const strokeColor = theme.compassRoseStroke || theme.wallStroke || '#000000';

  ctx.save();

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.stroke();

  const drawPoint = (angle, length, filled) => {
    const rad = (angle - 90) * Math.PI / 180;
    const tipX = x + Math.cos(rad) * length;
    const tipY = y + Math.sin(rad) * length;
    const baseLeft = (angle - 90 - 15) * Math.PI / 180;
    const baseRight = (angle - 90 + 15) * Math.PI / 180;
    const baseLength = length * 0.3;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(x + Math.cos(baseLeft) * baseLength, y + Math.sin(baseLeft) * baseLength);
    ctx.lineTo(x, y);
    ctx.lineTo(x + Math.cos(baseRight) * baseLength, y + Math.sin(baseRight) * baseLength);
    ctx.closePath();

    if (filled) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5 * s;
    ctx.stroke();
  };

  drawPoint(0, size, true);
  drawPoint(90, size * 0.9, false);
  drawPoint(180, size * 0.9, false);
  drawPoint(270, size * 0.9, false);

  drawPoint(45, innerSize, false);
  drawPoint(135, innerSize, false);
  drawPoint(225, innerSize, false);
  drawPoint(315, innerSize, false);

  ctx.beginPath();
  ctx.arc(x, y, 3 * s, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1 * s;
  ctx.stroke();

  const fontSize = Math.max(8, Math.round(14 * s));
  ctx.fillStyle = theme.textColor || '#000000';
  ctx.font = `bold ${fontSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('N', x, y - size - 8 * s);

  ctx.restore();
}

export {
  drawBackground,
  drawDungeonTitle,
  drawMatrixGrid,
  drawGrid,
  findCompassRosePosition,
  drawCompassRose,
  drawScaleIndicator,
  drawBorder,
  drawBorderOnMap,
  drawScaleIndicatorOnMap,
  findCompassRosePositionOnMap,
  drawCompassRoseScaled
};
