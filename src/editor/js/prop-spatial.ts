// Prop spatial hash — maps every cell covered by a prop to its anchor info.
// Reads from metadata.props[] (overlay) instead of scanning cell.prop entries.
// Supports overlapping props: each cell stores a z-sorted stack.
// Rebuild cost: O(total overlay props). Lookup cost: O(1).
//
// NOTE: Cannot import state directly (circular dep with state.js).
// Uses a lazy getter set by main.js at init time.

import { isGridAlignedRotation } from './prop-overlay.js';

let spatialMap = null; // Map<"row,col", Array<{ anchorRow, anchorCol, propType, propId, zIndex }>>
let dirty = true;
let lastPropsRef = null;
let _getState = null;

/**
 * Set the state accessor function. Called once by main.js at init.
 * @param {Function} stateFn - Returns the current editor state object.
 * @returns {void}
 */
export function initPropSpatial(stateFn: () => any): void {
  _getState = stateFn;
}

function getState() {
  if (_getState) return _getState();
  return null;
}

function rebuildPropSpatialMap() {
  spatialMap = new Map();
  const st = getState();
  const meta = st?.dungeon?.metadata;
  const props = meta?.props;
  if (!props) { dirty = false; return; }

  const gridSize = meta.gridSize || 5;
  const catalog = st.propCatalog;

  // If the prop catalog hasn't loaded yet, don't build — stay dirty so we rebuild later
  if (!catalog?.props) { return; }

  for (const prop of props) {
    const propDef = catalog.props[prop.type];
    if (!propDef) continue;

    const col = Math.round(prop.x / gridSize);
    const row = Math.round(prop.y / gridSize);
    const rotation = prop.rotation ?? 0;
    const [fRows, fCols] = propDef.footprint;

    let spanRows, spanCols;
    if (isGridAlignedRotation(rotation)) {
      const r = ((rotation % 360) + 360) % 360;
      spanRows = (r === 90 || r === 270) ? fCols : fRows;
      spanCols = (r === 90 || r === 270) ? fRows : fCols;
    } else {
      spanRows = fRows;
      spanCols = fCols;
    }

    const entry = { anchorRow: row, anchorCol: col, propType: prop.type, propId: prop.id, zIndex: prop.zIndex ?? 10 };

    for (let r = row; r < row + spanRows; r++) {
      for (let c = col; c < col + spanCols; c++) {
        const key = `${r},${c}`;
        let stack = spatialMap.get(key);
        if (!stack) {
          stack = [];
          spatialMap.set(key, stack);
        }
        stack.push(entry);
      }
    }
  }

  // Sort each stack by zIndex descending (topmost first) for lookupPropAt
  for (const stack of spatialMap.values()) {
    if (stack.length > 1) {
      stack.sort((a, b) => (b.zIndex ?? 10) - (a.zIndex ?? 10));
    }
  }

  lastPropsRef = props;
  dirty = false;
}

function ensureBuilt() {
  const st = getState();
  const props = st?.dungeon?.metadata?.props;
  if (dirty || !spatialMap || props !== lastPropsRef) {
    rebuildPropSpatialMap();
  }
}

let _onDirtyCallback = null;
/**
 * Register a callback to run whenever the prop spatial map is dirtied.
 * @param {Function} fn - Callback invoked on spatial map invalidation.
 * @returns {void}
 */
export function onPropSpatialDirty(fn: () => void): void { _onDirtyCallback = fn; }

/**
 * Mark the spatial map as needing rebuild. Call on any prop mutation.
 * @returns {void}
 */
export function markPropSpatialDirty(): void {
  dirty = true;
  if (_onDirtyCallback) _onDirtyCallback();
}

/**
 * Look up the topmost prop covering (row, col).
 * @param {number} row - Grid row.
 * @param {number} col - Grid column.
 * @returns {{ anchorRow: number, anchorCol: number, propType: string, propId: string, zIndex: number }|null} Prop entry or null.
 */
export function lookupPropAt(row: number, col: number): { anchorRow: number; anchorCol: number; propType: string; propId: string; zIndex: number } | null {
  ensureBuilt();
  const stack = spatialMap.get(`${row},${col}`);
  return stack?.[0] || null;
}

/**
 * Look up ALL props covering (row, col), sorted topmost-first.
 * @param {number} row - Grid row.
 * @param {number} col - Grid column.
 * @returns {Array<{ anchorRow: number, anchorCol: number, propType: string, propId: string, zIndex: number }>} Prop stack.
 */
export function lookupAllPropsAt(row: number, col: number): Array<{ anchorRow: number; anchorCol: number; propType: string; propId: string; zIndex: number }> {
  ensureBuilt();
  return spatialMap.get(`${row},${col}`) || [];
}

/**
 * Check if (row, col) is covered by any prop. O(1).
 * @param {number} row - Grid row.
 * @param {number} col - Grid column.
 * @returns {boolean} True if at least one prop covers this cell.
 */
export function isPropAt(row: number, col: number): boolean {
  ensureBuilt();
  return spatialMap.has(`${row},${col}`);
}
