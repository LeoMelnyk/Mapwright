// DM session fog-of-war reveal functions.

import type { Cell, Direction } from '../../types.js';
import { sessionState, send } from './dm-session-state.js';
import state, { notify } from './state.js';
import { requestRender } from './canvas-view.js';
import { cellKey, traverse, CARDINAL_DIRS, CARDINAL_OFFSETS, getEdge } from '../../util/index.js';

// Map a cardinal entry direction to a hit-test point just inside the named
// border, so traverse() seeds in whichever segment owns that interval.
// `null`/'unknown' falls back to the cell center.
const HIT_EPS = 1e-3;
function startPointFromEntry(entryDir: string | null): { lx: number; ly: number } {
  if (entryDir === 'north') return { lx: 0.5, ly: HIT_EPS };
  if (entryDir === 'south') return { lx: 0.5, ly: 1 - HIT_EPS };
  if (entryDir === 'east') return { lx: 1 - HIT_EPS, ly: 0.5 };
  if (entryDir === 'west') return { lx: HIT_EPS, ly: 0.5 };
  // null or unknown — fall back to cell center.
  return { lx: 0.5, ly: 0.5 };
}

// Collapse a traverse() "r,c,segIdx" set to a "r,c" set, used by the
// fog-reveal session state which tracks revealed cells without segment detail.
function collapseToCellKeys(visited: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const k of visited) {
    const parts = k.split(',');
    out.add(`${parts[0]},${parts[1]}`);
  }
  return out;
}
import { snapshotBroadcastBaseline, broadcastInit } from './dm-session-broadcast.js';

/**
 * Reveal a room starting from the given cell via flood-fill BFS.
 * @param {number} startRow - Starting cell row.
 * @param {number} startCol - Starting cell column.
 * @returns {Array<string>} Array of newly revealed cell keys.
 */
export function revealRoom(startRow: number, startCol: number): string[] {
  const result = traverse(state.dungeon.cells, { row: startRow, col: startCol });
  const roomCells = collapseToCellKeys(result.visited);
  const newCells = [];
  for (const key of roomCells) {
    if (!sessionState.revealedCells.has(key)) {
      sessionState.revealedCells.add(key);
      newCells.push(key);
    }
  }
  return newCells;
}

/**
 * Set the starting room and reveal it. Called when DM picks a starting room.
 * @param {number} row - Cell row.
 * @param {number} col - Cell column.
 * @returns {Array<string>} Array of newly revealed cell keys.
 */
export function setStartingRoom(row: number, col: number): string[] {
  sessionState.startingRoom = cellKey(row, col);
  const newCells = revealRoom(row, col);

  // Broadcast as a fog reveal — no full session rebuild needed
  if (newCells.length > 0) {
    send({ type: 'fog:reveal', cells: newCells });
  }

  requestRender();
  notify();
  return newCells;
}

/**
 * Reveal a room starting from the given cell with a specific entry direction.
 * Used for diagonal doors where the BFS must start from a specific half.
 */
export function revealRoomFrom(startRow: number, startCol: number, entryDir: string | null) {
  const { lx, ly } = startPointFromEntry(entryDir);
  const result = traverse(state.dungeon.cells, { row: startRow, col: startCol, lx, ly });
  const roomCells = collapseToCellKeys(result.visited);
  const newCells = [];
  for (const key of roomCells) {
    if (!sessionState.revealedCells.has(key)) {
      sessionState.revealedCells.add(key);
      newCells.push(key);
    }
  }
  return newCells;
}

/**
 * Determine which entry direction reaches the unrevealed half of a diagonal cell.
 */
export function getDiagonalOtherEntry(cell: Cell | null, r: number, c: number, diagDir: string) {
  if (diagDir === 'nw-se') {
    // NE half entered from north/east, SW half entered from south/west
    const neRevealed = ['north', 'east'].some((d) => {
      const { dr, dc } = CARDINAL_DIRS.find((cd) => cd.dir === d)!;
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return neRevealed ? 'south' : 'north';
  }
  if (diagDir === 'ne-sw') {
    // NW half entered from north/west, SE half entered from south/east
    const nwRevealed = ['north', 'west'].some((d) => {
      const { dr, dc } = CARDINAL_DIRS.find((cd) => cd.dir === d)!;
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return nwRevealed ? 'south' : 'north';
  }
  return null;
}

/**
 * Open a door and reveal the room on the other side.
 * @param {number} row - Door cell row.
 * @param {number} col - Door cell column.
 * @param {string} dir - Door direction (e.g. 'north', 'east', 'nw-se').
 * @param {Array|undefined} mergedCells - Optional array of merged door cells for wide doors.
 * @returns {void}
 */
export function openDoor(row: number, col: number, dir: string, mergedCells?: { row: number; col: number }[]): void {
  const cells = state.dungeon.cells;

  // Collect all door cells to open (merged or single)
  const doorCells = mergedCells && mergedCells.length > 1 ? mergedCells : [{ row, col }];

  const newCells: string[] = [];

  for (const dc of doorCells) {
    const cell = cells[dc.row]?.[dc.col];
    if (!cell) continue;

    const doorType = getEdge(cell, dir as Direction); // 'd', 's', or 'id'
    const wasSecret = doorType === 's';

    // Record opened door
    sessionState.openedDoors.push({ row: dc.row, col: dc.col, dir, wasSecret });

    if (dir === 'nw-se' || dir === 'ne-sw') {
      const otherEntry = getDiagonalOtherEntry(cell, dc.row, dc.col, dir);
      const revealed = revealRoomFrom(dc.row, dc.col, otherEntry);
      for (const key of revealed) {
        if (!newCells.includes(key)) newCells.push(key);
      }
      const thisSide = revealRoom(dc.row, dc.col);
      for (const key of thisSide) {
        if (!newCells.includes(key)) newCells.push(key);
      }
    } else {
      const [dr, dcc] = CARDINAL_OFFSETS[dir as keyof typeof CARDINAL_OFFSETS];
      const revealed = revealRoom(dc.row + dr, dc.col + dcc);
      for (const key of revealed) {
        if (!newCells.includes(key)) newCells.push(key);
      }
      const thisSide = revealRoom(dc.row, dc.col);
      for (const key of thisSide) {
        if (!newCells.includes(key)) newCells.push(key);
      }
    }
  }

  // Broadcast each door cell so the player marks both sides as opened
  for (const dc of doorCells) {
    const doorCell = cells[dc.row]?.[dc.col];
    const doorType = doorCell ? getEdge(doorCell, dir as Direction) : undefined;
    const cellWasSecret = doorType === 's';
    send({ type: 'door:open', row: dc.row, col: dc.col, dir, wasSecret: cellWasSecret });
  }
  if (newCells.length > 0) {
    send({ type: 'fog:reveal', cells: newCells, duration: 500 });
  }

  requestRender();
  notify();
}

/**
 * Reveal all non-void cells on the map (DM override).
 * @returns {void}
 */
export function revealAll(): void {
  const cells = state.dungeon.cells;
  const newCells = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[0]?.length ?? 0); c++) {
      if (!cells[r]?.[c]) continue;
      const key = cellKey(r, c);
      if (!sessionState.revealedCells.has(key)) {
        sessionState.revealedCells.add(key);
        newCells.push(key);
      }
    }
  }
  if (newCells.length > 0) {
    send({ type: 'fog:reveal', cells: newCells, duration: 500 });
  }
  requestRender();
  notify();
}

/**
 * Reveal all non-void cells within a rectangle.
 * @param {number} r1 - First corner row.
 * @param {number} c1 - First corner column.
 * @param {number} r2 - Second corner row.
 * @param {number} c2 - Second corner column.
 * @returns {void}
 */
export function revealRect(r1: number, c1: number, r2: number, c2: number): void {
  const cells = state.dungeon.cells;
  const minRow = Math.min(r1, r2),
    maxRow = Math.max(r1, r2);
  const minCol = Math.min(c1, c2),
    maxCol = Math.max(c1, c2);
  const newCells = [];
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      if (!cells[r]?.[c]) continue;
      const key = cellKey(r, c);
      if (!sessionState.revealedCells.has(key)) {
        sessionState.revealedCells.add(key);
        newCells.push(key);
      }
    }
  }
  if (newCells.length > 0) {
    send({ type: 'fog:reveal', cells: newCells, duration: 500 });
  }
  requestRender();
  notify();
}

/**
 * Re-fog all revealed cells within a rectangle.
 * @param {number} r1 - First corner row.
 * @param {number} c1 - First corner column.
 * @param {number} r2 - Second corner row.
 * @param {number} c2 - Second corner column.
 * @returns {void}
 */
export function concealRect(r1: number, c1: number, r2: number, c2: number): void {
  const cells = state.dungeon.cells;
  const minRow = Math.min(r1, r2),
    maxRow = Math.max(r1, r2);
  const minCol = Math.min(c1, c2),
    maxCol = Math.max(c1, c2);
  const hiddenCells = [];
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      if (!cells[r]?.[c]) continue;
      const key = cellKey(r, c);
      if (sessionState.revealedCells.has(key)) {
        sessionState.revealedCells.delete(key);
        hiddenCells.push(key);
      }
    }
  }
  if (hiddenCells.length > 0) {
    send({ type: 'fog:conceal', cells: hiddenCells });
  }
  requestRender();
  notify();
}

/**
 * Call when a new map is loaded while a session is active.
 * Resets fog state and re-sends session:init so the player reloads from scratch.
 * @returns {void}
 */
export function onMapLoaded(): void {
  if (!sessionState.active) return;
  sessionState.revealedCells.clear();
  sessionState.openedDoors = [];
  sessionState.openedStairs = [];
  sessionState.startingRoom = null;
  snapshotBroadcastBaseline();
  broadcastInit();
  requestRender();
  notify();
}

/**
 * Reset fog — hide everything and clear all opened doors/stairs.
 * @returns {void}
 */
export function resetFog(): void {
  sessionState.revealedCells.clear();
  sessionState.openedDoors = [];
  sessionState.openedStairs = [];
  sessionState.startingRoom = null;
  send({ type: 'fog:reset' });
  requestRender();
  notify();
}
