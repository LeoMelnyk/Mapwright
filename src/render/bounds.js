import { coordinateToFeet, getCoordinateBounds } from './validate.js';

/**
 * Calculate bounds from matrix-based cells
 */
function calculateBoundsFromCells(cells, gridSize) {
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  return {
    minX: 0,
    minY: 0,
    maxX: numCols * gridSize,
    maxY: numRows * gridSize
  };
}

/**
 * Calculate bounds (legacy coordinate-based system)
 */
function calculateBounds(config) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  const gridSize = config.gridSize;

  for (const room of config.rooms) {
    if (room.type === 'walls') {
      const coords = [];
      for (const wallSegment of room.walls) {
        coords.push(...wallSegment);
      }
      const bounds = getCoordinateBounds(coords, gridSize);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);

    } else if (room.type === 'grid') {
      const bounds = getCoordinateBounds(room.coordinates, gridSize);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);

    } else if (room.type === 'circular') {
      const [centerX, centerY] = coordinateToFeet(room.center[0], room.center[1], room.center[2], gridSize);
      const radius = room.radiusSquares * gridSize;
      minX = Math.min(minX, centerX - radius);
      minY = Math.min(minY, centerY - radius);
      maxX = Math.max(maxX, centerX + radius);
      maxY = Math.max(maxY, centerY + radius);

    } else if (room.type === 'custom') {
      const coords = [];
      for (const wall of room.walls) {
        coords.push(wall.from);
        coords.push(wall.to);
        if (wall.controlPoints) {
          coords.push(...wall.controlPoints);
        }
      }
      const bounds = getCoordinateBounds(coords, gridSize);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);

    } else if (room.type === 'rectangular') {
      const [x, y] = room.topLeft;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + room.width);
      maxY = Math.max(maxY, y + room.height);

    } else if (room.type === 'cave') {
      const [cx, cy] = room.center;
      const hw = room.width / 2;
      const hh = room.height / 2;
      minX = Math.min(minX, cx - hw);
      minY = Math.min(minY, cy - hh);
      maxX = Math.max(maxX, cx + hw);
      maxY = Math.max(maxY, cy + hh);
    }
  }

  const padding = 5;
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

/**
 * Convert feet coordinates to canvas pixels
 */
function toCanvas(x, y, transform) {
  return {
    x: x * transform.scale + transform.offsetX,
    y: y * transform.scale + transform.offsetY,
  };
}

export { calculateBoundsFromCells, calculateBounds, toCanvas };
