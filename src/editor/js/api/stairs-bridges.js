import {
  state, pushUndo, markDirty, notify, getApi,
  validateBounds, isInBounds,
  classifyStairShape, isDegenerate, getOccupiedCells,
  isBridgeDegenerate, getBridgeOccupiedCells,
  toInt,
  accumulateDirtyRect,
} from './_shared.js';

/**
 * Place stairs at a cell using legacy direction mode (delegates to addStairs).
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @param {string} direction - 'up' or 'down'
 * @returns {{ success: boolean, id: number }}
 */
export function setStairs(row, col, direction) {
  // Note: toInt conversion happens inside addStairs, so pass display coords
  if (direction === 'up' || direction === 'down') {
    return getApi().addStairs(row, col, row, col + 1, row + 1, col + 1);
  }
  throw new Error(`Invalid stairs direction: ${direction}. Use 'up' or 'down' for legacy, or use addStairs().`);
}

/**
 * Add stairs defined by 3 corner points (arbitrary polygon shape).
 * @param {number} p1r - Point 1 row
 * @param {number} p1c - Point 1 column
 * @param {number} p2r - Point 2 row
 * @param {number} p2c - Point 2 column
 * @param {number} p3r - Point 3 row (depth point)
 * @param {number} p3c - Point 3 column (depth point)
 * @returns {{ success: boolean, id: number }}
 */
export function addStairs(p1r, p1c, p2r, p2c, p3r, p3c) {
  p1r = toInt(p1r); p1c = toInt(p1c);
  p2r = toInt(p2r); p2c = toInt(p2c);
  p3r = toInt(p3r); p3c = toInt(p3c);
  const p1 = [p1r, p1c], p2 = [p2r, p2c], p3 = [p3r, p3c];
  if (isDegenerate(p1, p2, p3)) {
    throw new Error('Degenerate stair shape (zero area)');
  }
  const shape = classifyStairShape(p1, p2, p3);
  const occupied = getOccupiedCells(shape.vertices);
  if (occupied.length === 0) {
    throw new Error('No cells covered by this stair shape');
  }
  const cells = state.dungeon.cells;
  for (const { row, col } of occupied) {
    if (!isInBounds(cells, row, col)) {
      throw new Error(`Stair extends out of bounds at (${row}, ${col})`);
    }
    if (cells[row]?.[col]?.center?.['stair-id'] != null) {
      throw new Error(`Overlap: cell (${row}, ${col}) already has a stair`);
    }
  }

  pushUndo();
  const meta = state.dungeon.metadata;
  if (!meta.stairs) meta.stairs = [];
  if (meta.nextStairId == null) meta.nextStairId = 0;
  const id = meta.nextStairId++;
  meta.stairs.push({ id, points: [p1, p2, p3], link: null });

  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const { row, col } of occupied) {
    if (!cells[row][col]) cells[row][col] = {};
    if (!cells[row][col].center) cells[row][col].center = {};
    cells[row][col].center['stair-id'] = id;
    if (row < minR) minR = row;
    if (row > maxR) maxR = row;
    if (col < minC) minC = col;
    if (col > maxC) maxC = col;
  }

  accumulateDirtyRect(minR, minC, maxR, maxC);
  markDirty();
  notify();
  return { success: true, id };
}

/**
 * Remove the stair that covers the given cell position.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeStairs(row, col) {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  const id = cell?.center?.['stair-id'];

  if (id == null) {
    if (cell?.center?.['stairs-up'] || cell?.center?.['stairs-down']) {
      pushUndo();
      delete cell.center['stairs-up'];
      delete cell.center['stairs-down'];
      delete cell.center['stairs-link'];
      if (Object.keys(cell.center).length === 0) delete cell.center;
      accumulateDirtyRect(row, col, row, col);
      markDirty();
      notify();
    }
    return { success: true };
  }

  pushUndo();
  const meta = state.dungeon.metadata;
  const stairs = meta?.stairs || [];
  const idx = stairs.findIndex(s => s.id === id);

  if (idx !== -1) {
    const stairDef = stairs[idx];
    if (stairDef.link) {
      const partner = stairs.find(s => s.link === stairDef.link && s.id !== id);
      if (partner) partner.link = null;
    }
    stairs.splice(idx, 1);
  }

  const cells = state.dungeon.cells;
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      if (cells[r]?.[c]?.center?.['stair-id'] === id) {
        delete cells[r][c].center['stair-id'];
        if (Object.keys(cells[r][c].center).length === 0) delete cells[r][c].center;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }

  if (minR <= maxR) accumulateDirtyRect(minR, minC, maxR, maxC);
  markDirty();
  notify();
  return { success: true };
}

/**
 * Link two stairs together with a shared A-Z label.
 * @param {number} r1 - First stair row
 * @param {number} c1 - First stair column
 * @param {number} r2 - Second stair row
 * @param {number} c2 - Second stair column
 * @returns {{ success: boolean, label: string }}
 */
export function linkStairs(r1, c1, r2, c2) {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  validateBounds(r1, c1);
  validateBounds(r2, c2);
  const id1 = state.dungeon.cells[r1]?.[c1]?.center?.['stair-id'];
  const id2 = state.dungeon.cells[r2]?.[c2]?.center?.['stair-id'];
  if (id1 == null) throw new Error(`Cell (${r1}, ${c1}) has no stairs to link`);
  if (id2 == null) throw new Error(`Cell (${r2}, ${c2}) has no stairs to link`);
  if (id1 === id2) throw new Error('Cannot link a stair to itself');

  const stairs = state.dungeon.metadata?.stairs || [];
  const s1 = stairs.find(s => s.id === id1);
  const s2 = stairs.find(s => s.id === id2);
  if (!s1 || !s2) throw new Error('Stair definition not found in metadata');

  const used = new Set(stairs.map(s => s.link).filter(Boolean));
  let label = null;
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i);
    if (!used.has(ch)) { label = ch; break; }
  }
  if (!label) throw new Error('No available link labels (A-Z exhausted)');

  pushUndo();
  if (s1.link) { const old = stairs.find(s => s.link === s1.link && s.id !== id1); if (old) old.link = null; }
  if (s2.link) { const old = stairs.find(s => s.link === s2.link && s.id !== id2); if (old) old.link = null; }
  s1.link = label;
  s2.link = label;

  markDirty();
  notify();
  return { success: true, label };
}

/**
 * Add a bridge defined by type and 3 corner points.
 * @param {string} type - Bridge type: 'wood', 'stone', 'rope', or 'dock'
 * @param {number} p1r - Point 1 row
 * @param {number} p1c - Point 1 column
 * @param {number} p2r - Point 2 row
 * @param {number} p2c - Point 2 column
 * @param {number} p3r - Point 3 row (depth point)
 * @param {number} p3c - Point 3 column (depth point)
 * @returns {{ success: boolean, id: number }}
 */
export function addBridge(type, p1r, p1c, p2r, p2c, p3r, p3c) {
  const VALID_TYPES = ['wood', 'stone', 'rope', 'dock'];
  if (!VALID_TYPES.includes(type)) throw new Error(`Invalid bridge type: ${type}`);

  p1r = toInt(p1r); p1c = toInt(p1c);
  p2r = toInt(p2r); p2c = toInt(p2c);
  p3r = toInt(p3r); p3c = toInt(p3c);
  const p1 = [p1r, p1c], p2 = [p2r, p2c], p3 = [p3r, p3c];
  if (isBridgeDegenerate(p1, p2, p3)) throw new Error('Degenerate bridge (zero depth)');

  const occupied = getBridgeOccupiedCells(p1, p2, p3);
  if (occupied.length === 0) throw new Error('Bridge covers no cells');

  const cells = state.dungeon.cells;
  const numRows = cells.length, numCols = cells[0]?.length || 0;
  for (const { row, col } of occupied) {
    if (row < 0 || row >= numRows || col < 0 || col >= numCols) {
      throw new Error(`Bridge extends out of bounds at (${row}, ${col})`);
    }
  }

  pushUndo();

  const meta = state.dungeon.metadata;
  if (!meta.bridges) meta.bridges = [];
  if (meta.nextBridgeId == null) meta.nextBridgeId = 0;

  const id = meta.nextBridgeId++;
  meta.bridges.push({ id, type, points: [p1, p2, p3] });

  for (const { row, col } of occupied) {
    if (!cells[row][col]) cells[row][col] = {};
    if (!cells[row][col].center) cells[row][col].center = {};
    cells[row][col].center['bridge-id'] = id;
  }

  markDirty();
  notify();
  return { success: true, id };
}

/**
 * Remove the bridge that covers the given cell position.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeBridge(row, col) {
  row = toInt(row); col = toInt(col);
  const cell = state.dungeon.cells[row]?.[col];
  const id = cell?.center?.['bridge-id'];
  if (id == null) throw new Error(`Cell (${row}, ${col}) has no bridge`);

  const meta = state.dungeon.metadata;
  const idx = (meta?.bridges || []).findIndex(b => b.id === id);
  if (idx === -1) throw new Error(`Bridge id ${id} not found in metadata`);

  pushUndo();
  meta.bridges.splice(idx, 1);

  const cells = state.dungeon.cells;
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      if (cells[r]?.[c]?.center?.['bridge-id'] === id) {
        delete cells[r][c].center['bridge-id'];
        if (Object.keys(cells[r][c].center).length === 0) delete cells[r][c].center;
      }
    }
  }

  markDirty();
  notify();
  return { success: true };
}

/**
 * Get all bridge definitions from metadata.
 * @returns {{ success: boolean, bridges: Array<Object> }}
 */
export function getBridges() {
  return { success: true, bridges: state.dungeon.metadata?.bridges || [] };
}
