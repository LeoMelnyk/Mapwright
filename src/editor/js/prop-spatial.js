// Prop spatial hash — maps every cell covered by a prop to its anchor info.
// Rebuild cost: O(total cells). Lookup cost: O(1).
// Lazy rebuild: triggers on dirty flag OR when cells reference changes.

let spatialMap = null; // Map<"row,col", { anchorRow, anchorCol, propType }>
let dirty = true;
let lastCellsRef = null; // track cells array reference for auto-invalidation

function rebuildPropSpatialMap(cells) {
  spatialMap = new Map();
  const numRows = cells.length;
  for (let row = 0; row < numRows; row++) {
    const rowArr = cells[row];
    if (!rowArr) continue;
    const numCols = rowArr.length;
    for (let col = 0; col < numCols; col++) {
      const cell = rowArr[col];
      if (!cell?.prop) continue;
      const [spanRows, spanCols] = cell.prop.span;
      for (let r = row; r < row + spanRows; r++) {
        for (let c = col; c < col + spanCols; c++) {
          spatialMap.set(`${r},${c}`, { anchorRow: row, anchorCol: col, propType: cell.prop.type });
        }
      }
    }
  }
  lastCellsRef = cells;
  dirty = false;
}

function ensureBuilt(cells) {
  if (dirty || !spatialMap || cells !== lastCellsRef) {
    rebuildPropSpatialMap(cells);
  }
}

/**
 * Mark the spatial map as needing rebuild. Call on any structural state change.
 */
export function markPropSpatialDirty() {
  dirty = true;
}

/**
 * Look up the prop anchor covering (row, col). Returns { anchorRow, anchorCol, propType } or null.
 */
export function lookupPropAt(row, col, cells) {
  ensureBuilt(cells);
  return spatialMap.get(`${row},${col}`) || null;
}

/**
 * Check if (row, col) is covered by any prop. O(1).
 */
export function isPropAt(row, col, cells) {
  ensureBuilt(cells);
  return spatialMap.has(`${row},${col}`);
}
