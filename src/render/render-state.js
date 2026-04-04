// ── Render performance profiling ────────────────────────────────────────────
// Populated by renderCells on each frame. Read by canvas-view diagnostics overlay.
/** @type {Object.<string, { ms: number, frame: number }>} Per-phase timing data */
export const renderTimings = {};
// Frame stamp: incremented each frame by canvas-view. Used to detect stale timings.
let _timingFrame = 0;
/**
 * Increment the timing frame counter.
 * @returns {number} The new frame number
 */
export function bumpTimingFrame() { return ++_timingFrame; }
/**
 * Get the current timing frame counter.
 * @returns {number} Current frame number
 */
export function getTimingFrame() { return _timingFrame; }

/**
 * Time a function and record its duration in renderTimings.
 * @param {string} label - Phase name for the timing entry
 * @param {Function} fn - Function to execute and time
 * @returns {*} Return value of fn
 */
export function _t(label, fn) {
  const start = performance.now();
  const result = fn();
  renderTimings[label] = { ms: performance.now() - start, frame: _timingFrame };
  return result;
}

// ─── Content mutation counter ─────
// Bumped by smartInvalidate() on every content mutation. canvas-view.js checks
// this to know when the map cache needs rebuilding, even when notify() isn't called.
let _contentVersion = 0;
let _geometryVersion = 0; // bumped only on void↔floor transitions (needsGeometry)
/**
 * Get the current content mutation version counter.
 * @returns {number} Content version
 */
export function getContentVersion() { return _contentVersion; }
/**
 * Get the current geometry version counter (void/floor transitions only).
 * @returns {number} Geometry version
 */
export function getGeometryVersion() { return _geometryVersion; }
/**
 * Increment the content version counter.
 * @returns {void}
 */
export function bumpContentVersion() { _contentVersion++; }
/**
 * Internal: bump geometry version from render-cache.js smartInvalidate.
 * @returns {void}
 */
export function _bumpGeometryVersion() { _geometryVersion++; }

// ─── Dirty region tracking ─────
// Accumulated bounding rect of cells changed since the last cache rebuild.
// canvas-view.js reads this to decide whether a partial redraw is possible.
let _dirtyRegion = null;      // { minRow, maxRow, minCol, maxCol } or null
let _dirtyFullRebuild = false; // true → must do full rebuild (geometry change, undo, etc.)

// Parallel broadcast accumulator — tracks changes since last WebSocket broadcast.
// Not consumed by the editor render loop, only by dm-session.js.
let _broadcastDirtyRegion = null;
let _broadcastFullRebuild = false;

/**
 * Get the current dirty region, or null if a full rebuild is needed.
 * @returns {{ minRow: number, maxRow: number, minCol: number, maxCol: number }|null}
 */
export function getDirtyRegion() {
  if (_dirtyFullRebuild) return null;
  return _dirtyRegion;
}
/**
 * Reset the dirty region and full-rebuild flag.
 * @returns {void}
 */
export function consumeDirtyRegion() {
  _dirtyRegion = null;
  _dirtyFullRebuild = false;
}
/**
 * Get the broadcast dirty region, or null if a full rebuild is needed.
 * @returns {{ minRow: number, maxRow: number, minCol: number, maxCol: number }|null}
 */
export function getBroadcastDirtyRegion() {
  if (_broadcastFullRebuild) return null;
  return _broadcastDirtyRegion;
}
/**
 * Consume and return the broadcast dirty region, resetting it.
 * @returns {{ minRow: number, maxRow: number, minCol: number, maxCol: number }|null}
 */
export function consumeBroadcastDirtyRegion() {
  const r = _broadcastFullRebuild ? null : _broadcastDirtyRegion;
  _broadcastDirtyRegion = null;
  _broadcastFullRebuild = false;
  return r;
}

/**
 * Accumulate a rect of changed cells into the dirty region (for callers that bypass smartInvalidate).
 * @param {number} minRow - Top row of the changed region
 * @param {number} minCol - Left column of the changed region
 * @param {number} maxRow - Bottom row of the changed region
 * @param {number} maxCol - Right column of the changed region
 * @returns {void}
 */
export function accumulateDirtyRect(minRow, minCol, maxRow, maxCol) {
  if (!_dirtyRegion) {
    _dirtyRegion = { minRow, maxRow, minCol, maxCol };
  } else {
    if (minRow < _dirtyRegion.minRow) _dirtyRegion.minRow = minRow;
    if (maxRow > _dirtyRegion.maxRow) _dirtyRegion.maxRow = maxRow;
    if (minCol < _dirtyRegion.minCol) _dirtyRegion.minCol = minCol;
    if (maxCol > _dirtyRegion.maxCol) _dirtyRegion.maxCol = maxCol;
  }
  // Mirror to broadcast accumulator
  if (!_broadcastDirtyRegion) {
    _broadcastDirtyRegion = { minRow, maxRow, minCol, maxCol };
  } else {
    if (minRow < _broadcastDirtyRegion.minRow) _broadcastDirtyRegion.minRow = minRow;
    if (maxRow > _broadcastDirtyRegion.maxRow) _broadcastDirtyRegion.maxRow = maxRow;
    if (minCol < _broadcastDirtyRegion.minCol) _broadcastDirtyRegion.minCol = minCol;
    if (maxCol > _broadcastDirtyRegion.maxCol) _broadcastDirtyRegion.maxCol = maxCol;
  }
}

/**
 * Internal: accumulate a single cell into the dirty region.
 * Used by smartInvalidate in render-cache.js which needs direct per-cell accumulation
 * (including the broadcast mirror) without going through the public accumulateDirtyRect API.
 * @param {number} row - Cell row index
 * @param {number} col - Cell column index
 * @returns {void}
 */
export function _accumulateDirtyCell(row, col) {
  if (!_dirtyRegion) {
    _dirtyRegion = { minRow: row, maxRow: row, minCol: col, maxCol: col };
  } else {
    if (row < _dirtyRegion.minRow) _dirtyRegion.minRow = row;
    if (row > _dirtyRegion.maxRow) _dirtyRegion.maxRow = row;
    if (col < _dirtyRegion.minCol) _dirtyRegion.minCol = col;
    if (col > _dirtyRegion.maxCol) _dirtyRegion.maxCol = col;
  }
  // Mirror to broadcast accumulator
  if (!_broadcastDirtyRegion) {
    _broadcastDirtyRegion = { minRow: row, maxRow: row, minCol: col, maxCol: col };
  } else {
    if (row < _broadcastDirtyRegion.minRow) _broadcastDirtyRegion.minRow = row;
    if (row > _broadcastDirtyRegion.maxRow) _broadcastDirtyRegion.maxRow = row;
    if (col < _broadcastDirtyRegion.minCol) _broadcastDirtyRegion.minCol = col;
    if (col > _broadcastDirtyRegion.maxCol) _broadcastDirtyRegion.maxCol = col;
  }
}
