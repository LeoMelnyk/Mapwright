import type { BridgeType } from '../../../types.js';
import {
  state, mutate, getApi,
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
export function setStairs(row: number, col: number, direction: string): { success: true; id: number } {
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
export function addStairs(p1r: number, p1c: number, p2r: number, p2c: number, p3r: number, p3c: number): { success: true; id: number } {
  p1r = toInt(p1r); p1c = toInt(p1c);
  p2r = toInt(p2r); p2c = toInt(p2c);
  p3r = toInt(p3r); p3c = toInt(p3c);
  const p1: [number, number] = [p1r, p1c], p2: [number, number] = [p2r, p2c], p3: [number, number] = [p3r, p3c];
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

  let stairId: number;
  mutate('Add stairs', occupied, () => {
    const meta = state.dungeon.metadata;
    stairId = meta.nextStairId++;
    meta.stairs.push({ id: stairId, points: [p1, p2, p3], link: null });

    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (const { row, col } of occupied) {
      cells[row][col] ??= {};
      cells[row][col].center ??= {};
      cells[row][col].center['stair-id'] = stairId;
      if (row < minR) minR = row;
      if (row > maxR) maxR = row;
      if (col < minC) minC = col;
      if (col > maxC) maxC = col;
    }

    accumulateDirtyRect(minR, minC, maxR, maxC);
  }, { invalidate: ['lighting'] });
  return { success: true, id: stairId! };
}

/**
 * Remove the stair that covers the given cell position.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeStairs(row: number, col: number): { success: true } {
  row = toInt(row); col = toInt(col);
  validateBounds(row, col);
  const cell = state.dungeon.cells[row][col];
  const id = cell?.center?.['stair-id'];

  if (id == null) {
    if (cell?.center?.['stairs-up'] || cell?.center?.['stairs-down']) {
      mutate('Remove legacy stairs', [{ row, col }], () => {
        if (!cell.center) return;
        delete cell.center['stairs-up'];
        delete cell.center['stairs-down'];
        delete cell.center['stairs-link'];
        if (Object.keys(cell.center).length === 0) delete cell.center;
        accumulateDirtyRect(row, col, row, col);
      }, { invalidate: ['lighting'] });
    }
    return { success: true };
  }

  // Collect all cells with this stair-id for coords
  const cells = state.dungeon.cells;
  const stairCoords: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      if (cells[r]?.[c]?.center?.['stair-id'] === id) {
        stairCoords.push({ row: r, col: c });
      }
    }
  }

  mutate('Remove stairs', stairCoords, () => {
    const meta = state.dungeon.metadata;
    const stairs = meta.stairs;
    const idx = stairs.findIndex(s => s.id === id);

    if (idx !== -1) {
      const stairDef = stairs[idx];
      if (stairDef.link) {
        const partner = stairs.find(s => s.link === stairDef.link && s.id !== id);
        if (partner) partner.link = null;
      }
      stairs.splice(idx, 1);
    }

    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (const { row: r, col: c } of stairCoords) {
      const stairCell = cells[r]?.[c];
      if (stairCell?.center?.['stair-id'] === id) {
        delete stairCell.center['stair-id'];
        if (Object.keys(stairCell.center).length === 0) delete stairCell.center;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }

    if (minR <= maxR) accumulateDirtyRect(minR, minC, maxR, maxC);
  }, { invalidate: ['lighting'] });
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
export function linkStairs(r1: number, c1: number, r2: number, c2: number): { success: true; label: string } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  validateBounds(r1, c1);
  validateBounds(r2, c2);
  const id1 = state.dungeon.cells[r1]?.[c1]?.center?.['stair-id'];
  const id2 = state.dungeon.cells[r2]?.[c2]?.center?.['stair-id'];
  if (id1 == null) throw new Error(`Cell (${r1}, ${c1}) has no stairs to link`);
  if (id2 == null) throw new Error(`Cell (${r2}, ${c2}) has no stairs to link`);
  if (id1 === id2) throw new Error('Cannot link a stair to itself');

  const stairs = state.dungeon.metadata.stairs;
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

  mutate('Link stairs', [], () => {
    if (s1.link) { const old = stairs.find(s => s.link === s1.link && s.id !== id1); if (old) old.link = null; }
    if (s2.link) { const old = stairs.find(s => s.link === s2.link && s.id !== id2); if (old) old.link = null; }
    s1.link = label;
    s2.link = label;
  }, { metaOnly: true, invalidate: ['lighting'] });
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
export function addBridge(type: string, p1r: number, p1c: number, p2r: number, p2c: number, p3r: number, p3c: number): { success: true; id: number } {
  const VALID_TYPES = ['wood', 'stone', 'rope', 'dock'];
  if (!VALID_TYPES.includes(type)) throw new Error(`Invalid bridge type: ${type}`);

  p1r = toInt(p1r); p1c = toInt(p1c);
  p2r = toInt(p2r); p2c = toInt(p2c);
  p3r = toInt(p3r); p3c = toInt(p3c);
  const p1: [number, number] = [p1r, p1c], p2: [number, number] = [p2r, p2c], p3: [number, number] = [p3r, p3c];
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

  let bridgeId: number;
  mutate('Add bridge', occupied, () => {
    const meta = state.dungeon.metadata;
    bridgeId = meta.nextBridgeId++;
    meta.bridges.push({ id: bridgeId, type: type as BridgeType, points: [p1, p2, p3] });

    for (const { row, col } of occupied) {
      cells[row][col] ??= {};
      cells[row][col].center ??= {};
      cells[row][col].center['bridge-id'] = bridgeId;
    }
  }, { invalidate: ['lighting'] });
  return { success: true, id: bridgeId! };
}

/**
 * Remove the bridge that covers the given cell position.
 * @param {number} row - Row index
 * @param {number} col - Column index
 * @returns {{ success: boolean }}
 */
export function removeBridge(row: number, col: number): { success: true } {
  row = toInt(row); col = toInt(col);
  const cell = state.dungeon.cells[row]?.[col];
  const id = cell?.center?.['bridge-id'];
  if (id == null) throw new Error(`Cell (${row}, ${col}) has no bridge`);

  const meta = state.dungeon.metadata;
  const idx = meta.bridges.findIndex(b => b.id === id);
  if (idx === -1) throw new Error(`Bridge id ${id} not found in metadata`);

  // Collect all cells with this bridge-id for coords
  const cells = state.dungeon.cells;
  const bridgeCoords: Array<{ row: number; col: number }> = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length || 0); c++) {
      if (cells[r]?.[c]?.center?.['bridge-id'] === id) {
        bridgeCoords.push({ row: r, col: c });
      }
    }
  }

  mutate('Remove bridge', bridgeCoords, () => {
    meta.bridges.splice(idx, 1);

    for (const { row: r, col: c } of bridgeCoords) {
      const bridgeCell = cells[r]?.[c];
      if (bridgeCell?.center?.['bridge-id'] === id) {
        delete bridgeCell.center['bridge-id'];
        if (Object.keys(bridgeCell.center).length === 0) delete bridgeCell.center;
      }
    }
  }, { invalidate: ['lighting'] });
  return { success: true };
}

/**
 * Get all bridge definitions from metadata.
 * @returns {{ success: boolean, bridges: Array<Object> }}
 */
export function getBridges(): { success: true; bridges: { id: number; type: string; points: [number, number][] }[] } {
  return { success: true, bridges: state.dungeon.metadata.bridges };
}
