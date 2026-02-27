// Grid math and coordinate helpers

/**
 * Convert feet coordinates to canvas pixels
 */
export function toCanvas(x, y, transform) {
  return {
    x: x * transform.scale + transform.offsetX,
    y: y * transform.scale + transform.offsetY,
  };
}

/**
 * Convert canvas pixels back to feet coordinates
 */
export function fromCanvas(px, py, transform) {
  return {
    x: (px - transform.offsetX) / transform.scale,
    y: (py - transform.offsetY) / transform.scale,
  };
}

/**
 * Convert canvas pixel position to grid cell (row, col)
 */
export function pixelToCell(px, py, transform, gridSize) {
  const feet = fromCanvas(px, py, transform);
  return {
    row: Math.floor(feet.y / gridSize),
    col: Math.floor(feet.x / gridSize),
  };
}

/**
 * Detect which edge of a cell the mouse is nearest to.
 * Returns { direction, row, col } or null.
 */
export function nearestEdge(px, py, transform, gridSize, edgeMarginRatio = 0.25) {
  const feet = fromCanvas(px, py, transform);
  const col = Math.floor(feet.x / gridSize);
  const row = Math.floor(feet.y / gridSize);

  const relX = (feet.x / gridSize) - col; // 0..1 within cell
  const relY = (feet.y / gridSize) - row;

  const margin = edgeMarginRatio;

  const candidates = [];

  if (relY < margin) candidates.push({ direction: 'north', dist: relY });
  if (relY > 1 - margin) candidates.push({ direction: 'south', dist: 1 - relY });
  if (relX > 1 - margin) candidates.push({ direction: 'east', dist: 1 - relX });
  if (relX < margin) candidates.push({ direction: 'west', dist: relX });

  // Diagonal detection
  const nwseDist = Math.abs(relX - relY) / Math.SQRT2;
  const neswDist = Math.abs(relX - (1 - relY)) / Math.SQRT2;
  if (nwseDist < margin * 0.7) candidates.push({ direction: 'nw-se', dist: nwseDist });
  if (neswDist < margin * 0.7) candidates.push({ direction: 'ne-sw', dist: neswDist });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  return { direction: candidates[0].direction, row, col };
}

/**
 * Create an empty dungeon JSON with given dimensions
 */
export function createEmptyDungeon(name, rows, cols, gridSize = 5, theme = 'stone-dungeon') {
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push(null);
    }
    cells.push(row);
  }
  return {
    metadata: {
      dungeonName: name,
      gridSize,
      theme,
      features: {
        showGrid: true,
        compassRose: true,
        scale: true,
        border: true,
      },
      levels: [{ name: 'Level 1', startRow: 0, numRows: rows }],
      bridges: [],
      nextBridgeId: 0,
    },
    cells,
  };
}

/**
 * Find the nearest grid corner (intersection point) to a canvas pixel position.
 * Grid corners are at integer (row, col) positions where lines cross.
 * @param {number} px - Canvas pixel X
 * @param {number} py - Canvas pixel Y
 * @param {object} transform - { scale, offsetX, offsetY }
 * @param {number} gridSize - Grid cell size in feet
 * @returns {{ row: number, col: number }}
 */
export function nearestCorner(px, py, transform, gridSize) {
  const feet = fromCanvas(px, py, transform);
  return {
    row: Math.round(feet.y / gridSize),
    col: Math.round(feet.x / gridSize),
  };
}

/**
 * Deep clone an object via JSON round-trip
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
