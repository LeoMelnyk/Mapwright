import type { CellGrid, Theme, RenderTransform } from '../types.js';
import { toCanvas } from './bounds.js';
import { displayGridSize as _dgs } from '../util/index.js';

// ─── Constants ─────
const COMPASS_ROSE_SIZE = 35;

/**
 * Draw background fill for the entire canvas.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} width - Canvas width in pixels
 * @param {number} height - Canvas height in pixels
 * @param {Object} theme - Theme object with background color
 * @returns {void}
 */
function drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number, theme: Theme): void {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
}

/**
 * Draw dungeon title at the top of the map.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} width - Canvas width in pixels
 * @param {string} dungeonName - Title text to draw
 * @param {number} fontSize - Font size in pixels
 * @param {Object} theme - Theme object with textColor
 * @param {number} [yOffset=0] - Vertical offset from the top
 * @returns {void}
 */
function drawDungeonTitle(ctx: CanvasRenderingContext2D, width: number, dungeonName: string, fontSize: number, theme: Theme, yOffset: number = 0): void {
  ctx.save();

  ctx.font = `bold ${fontSize}px Georgia, "Times New Roman", serif`;
  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = theme.textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const x = width / 2;
  const y = yOffset + 15;

  ctx.fillText(dungeonName, x, y);

  ctx.restore();
}

// ─── Grid noise helper ─────
// Deterministic hash-based noise for grid wobble (no randomness per frame)
function _gridNoise(row: any, col: any, dir: any, noiseAmount: any, gridSize: any) {
  if (!noiseAmount) return 0;
  // Simple hash from coordinates + direction seed
  let h = (row * 7919 + col * 104729 + dir * 31) | 0;
  h = ((h >> 16) ^ h) * 0x45d9f3b;
  h = ((h >> 16) ^ h) * 0x45d9f3b;
  h = (h >> 16) ^ h;
  // Map to [-1, 1] range, scale by noise amount and gridSize
  return ((h & 0xffff) / 0x8000 - 1) * noiseAmount * gridSize * 0.15;
}

/**
 * Draw grid overlay for matrix-based map.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {Array<Array<boolean>>} roomCells - Room cell mask
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {Object} theme - Theme with grid style config
 * @param {boolean} showGridInCorridors - Whether to show grid in corridor cells
 * @param {Object} metadata - Dungeon metadata with resolution
 * @returns {void}
 */
function drawMatrixGrid(ctx: CanvasRenderingContext2D, cells: CellGrid, roomCells: boolean[][], gridSize: number, transform: RenderTransform, theme: Theme, showGridInCorridors: boolean, metadata: any): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;
  const resolution = metadata?.resolution || 1;

  const style = theme.gridStyle || 'lines';
  const lineWidth = theme.gridLineWidth ?? 4;
  const noise = theme.gridNoise ?? 0;
  const cornerFrac = theme.gridCornerLength ?? 0.3;
  const opacity = theme.gridOpacity ?? 0.5;

  ctx.lineCap = 'butt';

  const shouldDraw = (r: any, c: any) => {
    if (r < 0 || r >= numRows || c < 0 || c >= numCols) return false;
    return roomCells[r][c] || (showGridInCorridors && cells[r]?.[c]);
  };

  // @ts-expect-error — strict-mode migration
  ctx.strokeStyle = theme.gridLine;
  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = theme.gridLine;
  // @ts-expect-error — strict-mode migration
  ctx.lineWidth = lineWidth;
  // @ts-expect-error — strict-mode migration
  ctx.globalAlpha = opacity;

  if (style === 'lines' || style === 'dotted') {
    // Full lines or dashed lines between cells
    if (style === 'dotted') {
      const dashLen = (lineWidth as number) * 2;
      ctx.setLineDash([dashLen, dashLen]);
    }
    ctx.beginPath();

    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        if (!shouldDraw(row, col)) continue;

        // Horizontal line below this cell
        if ((row + 1) % resolution === 0 && shouldDraw(row + 1, col)) {
          const n1 = _gridNoise(row + 1, col, 0, noise, gridSize);
          const n2 = _gridNoise(row + 1, col + 1, 0, noise, gridSize);
          const p1 = toCanvas(col * gridSize, (row + 1) * gridSize + n1, transform);
          const p2 = toCanvas((col + 1) * gridSize, (row + 1) * gridSize + n2, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }

        // Vertical line to the right
        if ((col + 1) % resolution === 0 && shouldDraw(row, col + 1)) {
          const n1 = _gridNoise(row, col + 1, 1, noise, gridSize);
          const n2 = _gridNoise(row + 1, col + 1, 1, noise, gridSize);
          const p1 = toCanvas((col + 1) * gridSize + n1, row * gridSize, transform);
          const p2 = toCanvas((col + 1) * gridSize + n2, (row + 1) * gridSize, transform);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
      }
    }

    ctx.stroke();
    if (style === 'dotted') ctx.setLineDash([]);

  } else if (style === 'corners-x' || style === 'corners-dot') {
    // Iterate over intersection points (corners of the grid)
    // Intersection (r, c) is shared by cells (r-1,c-1), (r-1,c), (r,c-1), (r,c)
    const armLen = gridSize * (cornerFrac as number);
    const dotRadius = lineWidth;
    ctx.beginPath();

    for (let r = 0; r <= numRows; r++) {
      if (r % resolution !== 0) continue;
      for (let c = 0; c <= numCols; c++) {
        if (c % resolution !== 0) continue;

        // Only draw at fully interior intersections (all 4 adjacent cells must be drawable)
        if (!shouldDraw(r, c) || !shouldDraw(r - 1, c) ||
            !shouldDraw(r, c - 1) || !shouldDraw(r - 1, c - 1)) continue;

        const n = _gridNoise(r, c, style === 'corners-x' ? 2 : 3, noise, gridSize);
        const p = toCanvas(c * gridSize + n, r * gridSize + n, transform);

        if (style === 'corners-x') {
          const arm = armLen * transform.scale;
          ctx.moveTo(p.x - arm, p.y);
          ctx.lineTo(p.x + arm, p.y);
          ctx.moveTo(p.x, p.y - arm);
          ctx.lineTo(p.x, p.y + arm);
        } else {
          // @ts-expect-error — strict-mode migration
          ctx.moveTo(p.x + dotRadius, p.y);
          // @ts-expect-error — strict-mode migration
          ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
        }
      }
    }

    if (style === 'corners-x') ctx.stroke();
    else ctx.fill();
  }

  ctx.globalAlpha = 1.0;
}

/**
 * Draw grid overlay (legacy coordinate-based).
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Object} config - Dungeon config with gridSize
 * @param {Object} bounds - Bounding box {minX, minY, maxX, maxY}
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {Object} theme - Theme with gridLine color
 * @returns {void}
 */
function drawGrid(ctx: CanvasRenderingContext2D, config: any, bounds: any, transform: RenderTransform, theme: Theme): void {
  const gridSize = config.gridSize;
  const style = theme.gridStyle || 'lines';
  const lineWidth = theme.gridLineWidth ?? 4;
  const noise = theme.gridNoise ?? 0;
  const cornerFrac = theme.gridCornerLength ?? 0.3;
  const opacity = theme.gridOpacity ?? 0.5;

  // @ts-expect-error — strict-mode migration
  ctx.strokeStyle = theme.gridLine;
  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = theme.gridLine;
  // @ts-expect-error — strict-mode migration
  ctx.lineWidth = lineWidth;
  // @ts-expect-error — strict-mode migration
  ctx.globalAlpha = opacity;

  const startX = Math.floor(bounds.minX / gridSize) * gridSize;
  const endX = Math.ceil(bounds.maxX / gridSize) * gridSize;
  const startY = Math.floor(bounds.minY / gridSize) * gridSize;
  const endY = Math.ceil(bounds.maxY / gridSize) * gridSize;

  if (style === 'lines' || style === 'dotted') {
    if (style === 'dotted') {
      const dashLen = (lineWidth as number) * 2;
      ctx.setLineDash([dashLen, dashLen]);
    }

    for (let x = startX; x <= endX; x += gridSize) {
      const col = Math.round(x / gridSize);
      ctx.beginPath();
      const n1 = _gridNoise(0, col, 1, noise, gridSize);
      const n2 = _gridNoise(999, col, 1, noise, gridSize);
      const p1 = toCanvas(x + n1, bounds.minY, transform);
      const p2 = toCanvas(x + n2, bounds.maxY, transform);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    for (let y = startY; y <= endY; y += gridSize) {
      const row = Math.round(y / gridSize);
      ctx.beginPath();
      const n1 = _gridNoise(row, 0, 0, noise, gridSize);
      const n2 = _gridNoise(row, 999, 0, noise, gridSize);
      const p1 = toCanvas(bounds.minX, y + n1, transform);
      const p2 = toCanvas(bounds.maxX, y + n2, transform);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    if (style === 'dotted') ctx.setLineDash([]);

  } else if (style === 'corners-x') {
    const armLen = gridSize * (cornerFrac as number);
    ctx.beginPath();

    for (let x = startX; x <= endX; x += gridSize) {
      for (let y = startY; y <= endY; y += gridSize) {
        const row = Math.round(y / gridSize);
        const col = Math.round(x / gridSize);
        const n = _gridNoise(row, col, 2, noise, gridSize);
        const p = toCanvas(x + n, y + n, transform);
        const arm = armLen * transform.scale;
        ctx.moveTo(p.x - arm, p.y);
        ctx.lineTo(p.x + arm, p.y);
        ctx.moveTo(p.x, p.y - arm);
        ctx.lineTo(p.x, p.y + arm);
      }
    }

    ctx.stroke();

  } else if (style === 'corners-dot') {
    const dotRadius = lineWidth;
    ctx.beginPath();

    for (let x = startX; x <= endX; x += gridSize) {
      for (let y = startY; y <= endY; y += gridSize) {
        const row = Math.round(y / gridSize);
        const col = Math.round(x / gridSize);
        const n = _gridNoise(row, col, 3, noise, gridSize);
        const p = toCanvas(x + n, y + n, transform);
        // @ts-expect-error — strict-mode migration
        ctx.moveTo(p.x + dotRadius, p.y);
        // @ts-expect-error — strict-mode migration
        ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
      }
    }

    ctx.fill();
  }

  ctx.globalAlpha = 1.0;
}

/**
 * Find the best position for compass rose in export canvas space.
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {number} width - Canvas width in pixels
 * @param {number} height - Canvas height in pixels
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {{ x: number, y: number }|null} Canvas position, or null if no space
 */
function findCompassRosePosition(cells: CellGrid, gridSize: number, width: number, height: number, transform: RenderTransform): { x: number; y: number } {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const isCornerClear = (canvasX: any, canvasY: any) => {
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

  // @ts-expect-error — strict-mode migration
  return null;
}

/**
 * Draw compass rose (decorative 8-pointed design).
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} x - Center X in canvas pixels
 * @param {number} y - Center Y in canvas pixels
 * @param {Object} theme - Theme with compassRose colors
 * @returns {void}
 */
function drawCompassRose(ctx: CanvasRenderingContext2D, x: number, y: number, theme: Theme): void {
  const size = COMPASS_ROSE_SIZE;
  const innerSize = size * 0.6;

  const fillColor = theme.compassRoseFill || theme.wallStroke || '#000000';
  const strokeColor = theme.compassRoseStroke || theme.wallStroke || '#000000';

  ctx.save();

  // @ts-expect-error — strict-mode migration
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.stroke();

  const drawPoint = (angle: any, length: any, filled: any) => {
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
      // @ts-expect-error — strict-mode migration
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    // @ts-expect-error — strict-mode migration
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
  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = fillColor;
  ctx.fill();
  // @ts-expect-error — strict-mode migration
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = theme.textColor || '#000000';
  ctx.font = 'bold 14px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('N', x, y - size - 8);

  ctx.restore();
}

/**
 * Draw scale indicator bar.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} x - Center X in canvas pixels
 * @param {number} y - Y position in canvas pixels
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme with textColor
 * @param {number} resolution - Resolution multiplier
 * @returns {void}
 */
function drawScaleIndicator(ctx: CanvasRenderingContext2D, x: number, y: number, gridSize: number, theme: Theme, resolution: number): void {
  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = theme.textColor;
  ctx.font = 'bold 12px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillText(`1 square = ${_dgs(gridSize, resolution)} feet`, x, y);
}

/**
 * Draw decorative border around the export canvas.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} width - Canvas width in pixels
 * @param {number} height - Canvas height in pixels
 * @param {Object} theme - Theme with borderColor
 * @returns {void}
 */
function drawBorder(ctx: CanvasRenderingContext2D, width: number, height: number, theme: Theme): void {
  // @ts-expect-error — strict-mode migration
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
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme with borderColor
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {number} [padding=5] - Padding in grid-feet outside the dungeon bounds
 * @returns {void}
 */
function drawBorderOnMap(ctx: CanvasRenderingContext2D, cells: CellGrid, gridSize: number, theme: Theme, transform: RenderTransform, padding: number = 5): void {
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

  // @ts-expect-error — strict-mode migration
  ctx.strokeStyle = theme.borderColor;
  ctx.lineWidth = 3 * s;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  const inset = 3 * s;
  ctx.lineWidth = 1 * s;
  ctx.strokeRect(tl.x + inset, tl.y + inset, br.x - tl.x - inset * 2, br.y - tl.y - inset * 2);
}

/**
 * Draw scale indicator in map space (below the dungeon grid).
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} theme - Theme with textColor
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @param {number} resolution - Resolution multiplier
 * @returns {void}
 */
function drawScaleIndicatorOnMap(ctx: CanvasRenderingContext2D, cells: CellGrid, gridSize: number, theme: Theme, transform: RenderTransform, resolution: number): void {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const s = transform.scale / 10;

  // Position: center-bottom of the dungeon, slightly below
  const centerXf = (numCols * gridSize) / 2;
  const bottomYf = numRows * gridSize + 10; // 10 feet below
  const p = toCanvas(centerXf, bottomYf, transform);

  const fontSize = Math.max(8, Math.round(12 * s));

  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = theme.textColor;
  ctx.font = `bold ${fontSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`1 square = ${_dgs(gridSize, resolution)} feet`, p.x, p.y);
}

/**
 * Find compass rose position in map space (corners of the dungeon grid).
 * @param {Array<Array<Object>>} cells - 2D cell grid
 * @param {number} gridSize - Grid cell size in feet
 * @param {Object} transform - Transform with scale, offsetX, offsetY
 * @returns {{ x: number, y: number }|null} Canvas position, or null if no space
 */
function findCompassRosePositionOnMap(cells: CellGrid, gridSize: number, transform: RenderTransform): { x: number; y: number } {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  const s = transform.scale / 10;

  // Convert a feet position to cell coordinates and check if area is clear
  const isAreaClear = (feetX: any, feetY: any) => {
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
      // @ts-expect-error — strict-mode migration
      return { x: p.x, y: p.y, scale: s };
    }
  }

  // @ts-expect-error — strict-mode migration
  return null;
}

/**
 * Draw compass rose with optional scale factor.
 * @param {CanvasRenderingContext2D} ctx - Canvas rendering context
 * @param {number} x - Center X in canvas pixels
 * @param {number} y - Center Y in canvas pixels
 * @param {Object} theme - Theme with compassRose colors
 * @param {number} [s=1] - Scale factor
 * @returns {void}
 */
function drawCompassRoseScaled(ctx: CanvasRenderingContext2D, x: number, y: number, theme: Theme, s: number = 1): void {
  const size = COMPASS_ROSE_SIZE * s;
  const innerSize = size * 0.6;

  const fillColor = theme.compassRoseFill || theme.wallStroke || '#000000';
  const strokeColor = theme.compassRoseStroke || theme.wallStroke || '#000000';

  ctx.save();

  // @ts-expect-error — strict-mode migration
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.stroke();

  const drawPoint = (angle: any, length: any, filled: any) => {
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
      // @ts-expect-error — strict-mode migration
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    // @ts-expect-error — strict-mode migration
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
  // @ts-expect-error — strict-mode migration
  ctx.fillStyle = fillColor;
  ctx.fill();
  // @ts-expect-error — strict-mode migration
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1 * s;
  ctx.stroke();

  const fontSize = Math.max(8, Math.round(14 * s));
  // @ts-expect-error — strict-mode migration
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
