// Paint tool: click+drag to box-select a rectangle, then apply fill/texture/room on mouseup.
// Shift+click in texture mode: flood-fill the entire connected room.
// Shift+click in clear-texture mode: flood-clear an entire room's textures.
// Shift+drag in room mode: constrain selection to a square.
// Syringe mode: click to pick up a cell's texture, then auto-switch to texture paint.
import { Tool } from './tool-base.js';
import state, { pushUndo, markDirty, notify, getTheme } from '../state.js';
import { setCursor, getTransform, requestRender } from '../canvas-view.js';
import { toCanvas } from '../utils.js';
import { selectTexture } from '../panels/index.js';
import { loadTextureImages } from '../texture-catalog.js';
import { invalidateBlendLayerCache, captureBeforeState, smartInvalidate, accumulateDirtyRect, patchBlendForDirtyRegion } from '../../../render/index.js';
import { CARDINAL_DIRS, OPPOSITE, cellKey, parseCellKey, blockedByDiagonal, lockDiagonalHalf, isInBounds, normalizeBounds, snapToSquare } from '../../../util/index.js';

// SVG paint bucket cursor — hotspot at the drip tip (bottom-left of bucket)
const BUCKET_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='white' stroke='%23333' stroke-width='1.2' d='M16.56 8.94L7.62 0 6.21 1.41l2.38 2.38-5.15 5.15a1.49 1.49 0 0 0 0 2.12l5.5 5.5c.29.29.68.44 1.06.44s.77-.15 1.06-.44l5.5-5.5c.59-.58.59-1.53 0-2.12zM5.21 10L10 5.21 14.79 10H5.21zM19 11.5s-2 2.17-2 3.5c0 1.1.9 2 2 2s2-.9 2-2c0-1.33-2-3.5-2-3.5z'/%3E%3C/svg%3E") 2 22, crosshair`;

// SVG eyedropper/syringe cursor — hotspot at the tip (bottom-left)
export const SYRINGE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='white' stroke='%23333' stroke-width='1.2' d='M20.71 5.63l-2.34-2.34a1 1 0 0 0-1.41 0l-3.54 3.54 1.41 1.41L13.41 9.66l-5.66 5.66-1.41-1.41-1.41 1.41 1.41 1.41L4.59 18.5 3 20.08 3.92 21l1.5-1.59 1.76-1.76 1.41 1.41 1.41-1.41-1.41-1.41 5.66-5.66 1.41 1.41 1.42-1.42-1.42-1.41 3.54-3.54a1 1 0 0 0 0-1.41z'/%3E%3C/svg%3E") 1 23, crosshair`;

const FILL_DIRS = CARDINAL_DIRS;

/** Incrementally patch blend edges/corners for a dirty region instead of full rebuild. */
function _patchBlend(region) {
  const theme = getTheme();
  const textureOptions = state.textureCatalog
    ? { catalog: state.textureCatalog, blendWidth: theme.textureBlendWidth ?? 0.35, texturesVersion: state.texturesVersion ?? 0 }
    : null;
  if (textureOptions) {
    patchBlendForDirtyRegion(region, state.dungeon.cells, state.dungeon.metadata.gridSize || 5, textureOptions);
  }
}

// Room-side directions for each trim corner.  For a trimRound hypotenuse cell,
// the room interior is on the opposite side from the voided corner.
const ROOM_SIDE_DIRS = {
  nw: ['south', 'east'],
  ne: ['south', 'west'],
  sw: ['north', 'east'],
  se: ['north', 'west'],
};

/**
 * Phase 3 of the arc post-pass: correct arc cell membership based on fill direction.
 *
 * The arc post-pass (Phases 1+2) always claims all connected trimRound cells
 * regardless of which side the fill originated from. This phase determines the
 * fill direction per arc corner and:
 *   - Room-side fill → keeps trimRound cells, adds insideArc cells
 *   - Void-side fill → removes trimRound cells AND insideArc cells from the fill
 *
 * @param {Array} cells       - The dungeon cells grid
 * @param {Set}   filledCells - Current fill set (mutated)
 * @param {Array} toFill      - Current fill list (mutated)
 * @param {Set}   mainFillCells - Snapshot of filledCells from BEFORE the arc post-pass
 * @param {Set}   arcVisited  - Set of cellKeys for all trimRound cells claimed by arc post-pass
 */
function correctArcCells(cells, filledCells, toFill, mainFillCells, arcVisited) {
  // Group arc cells by trimCorner so we can detect fill direction per corner.
  const cornerGroups = {};
  for (const k of arcVisited) {
    const [r, c] = parseCellKey(k);
    const cell = cells[r]?.[c];
    if (!cell?.trimCorner) continue;
    const corner = cell.trimCorner;
    if (!cornerGroups[corner]) cornerGroups[corner] = [];
    cornerGroups[corner].push(k);
  }

  for (const [corner, arcKeys] of Object.entries(cornerGroups)) {
    const roomDirs = ROOM_SIDE_DIRS[corner];
    if (!roomDirs) continue;

    // Check if ANY trimRound cell in this corner has a room-side neighbor
    // in the main BFS fill (before arc post-pass). If so, the fill came
    // from the room interior; otherwise it came from the void/exterior.
    let fromRoomSide = false;
    for (const k of arcKeys) {
      const [r, c] = parseCellKey(k);
      for (const dirName of roomDirs) {
        const dirInfo = FILL_DIRS.find(d => d.dir === dirName);
        if (!dirInfo) continue;
        const nr = r + dirInfo.dr, nc = c + dirInfo.dc;
        const nKey = cellKey(nr, nc);
        // Room-side neighbor must be in mainFillCells AND not itself an arc cell
        if (mainFillCells.has(nKey) && !arcVisited.has(nKey)) {
          const nCell = cells[nr]?.[nc];
          if (!nCell?.trimRound && !nCell?.trimInsideArc) {
            fromRoomSide = true;
            break;
          }
        }
      }
      if (fromRoomSide) break;
    }

    if (fromRoomSide) {
      // Interior fill: keep trimRound cells, ADD insideArc cells
      const toAdd = new Set();
      for (const k of arcKeys) {
        const [r, c] = parseCellKey(k);
        for (const { dr, dc } of FILL_DIRS) {
          const nr = r + dr, nc = c + dc;
          const neighbor = cells[nr]?.[nc];
          if (!neighbor?.trimInsideArc || neighbor.trimCorner !== corner) continue;
          toAdd.add(cellKey(nr, nc));
        }
      }
      // Propagate through connected insideArc cells of the same corner
      const addQueue = [...toAdd];
      const addVisited = new Set(toAdd);
      while (addQueue.length > 0) {
        const nk = addQueue.shift();
        const [r, c] = parseCellKey(nk);
        for (const { dr, dc } of FILL_DIRS) {
          const nr = r + dr, nc = c + dc;
          const neighbor = cells[nr]?.[nc];
          if (!neighbor?.trimInsideArc || neighbor.trimCorner !== corner) continue;
          const nKey = cellKey(nr, nc);
          if (addVisited.has(nKey)) continue;
          addVisited.add(nKey);
          toAdd.add(nKey);
          addQueue.push(nKey);
        }
      }
      for (const nKey of toAdd) {
        if (!filledCells.has(nKey)) {
          filledCells.add(nKey);
          const [r, c] = parseCellKey(nKey);
          toFill.push([r, c, null]);
        }
      }
    } else {
      // Exterior fill: remap all arc cells (trimRound + insideArc) to write
      // textureSecondary instead of texture. The arc secondary post-pass in
      // the renderer draws textureSecondary in the void-corner region outside
      // the arc curve, so the exterior texture appears correctly there while
      // the room-side primary texture is preserved.
      const toRemap = new Set();

      // Collect trimRound cells
      for (const k of arcKeys) toRemap.add(k);

      // Collect insideArc cells adjacent to the arc
      for (const k of arcKeys) {
        const [r, c] = parseCellKey(k);
        for (const { dr, dc } of FILL_DIRS) {
          const nr = r + dr, nc = c + dc;
          const neighbor = cells[nr]?.[nc];
          if (!neighbor?.trimInsideArc || neighbor.trimCorner !== corner) continue;
          toRemap.add(cellKey(nr, nc));
        }
      }
      // Propagate through connected insideArc cells of the same corner
      const remapQueue = [...toRemap].filter(k => {
        const [r, c] = parseCellKey(k);
        return cells[r]?.[c]?.trimInsideArc;
      });
      const remapVisited = new Set(remapQueue);
      while (remapQueue.length > 0) {
        const nk = remapQueue.shift();
        const [r, c] = parseCellKey(nk);
        for (const { dr, dc } of FILL_DIRS) {
          const nr = r + dr, nc = c + dc;
          const neighbor = cells[nr]?.[nc];
          if (!neighbor?.trimInsideArc || neighbor.trimCorner !== corner) continue;
          const nKey = cellKey(nr, nc);
          if (remapVisited.has(nKey)) continue;
          remapVisited.add(nKey);
          toRemap.add(nKey);
          remapQueue.push(nKey);
        }
      }

      // Remap: change halfKey to 'textureSecondary' so the exterior texture
      // is written to the secondary slot, preserving the primary (room) texture.
      for (let i = 0; i < toFill.length; i++) {
        const k = cellKey(toFill[i][0], toFill[i][1]);
        if (toRemap.has(k)) {
          toFill[i][2] = 'textureSecondary';
        }
      }
      // trimRound cells added by the arc post-pass may not be in toFill yet
      // (they were added to filledCells but also to toFill during phase 1/2).
      // Ensure they're present with the correct halfKey.
      for (const k of arcKeys) {
        let found = false;
        for (let i = 0; i < toFill.length; i++) {
          if (cellKey(toFill[i][0], toFill[i][1]) === k) { found = true; break; }
        }
        if (!found && filledCells.has(k)) {
          const [r, c] = parseCellKey(k);
          toFill.push([r, c, 'textureSecondary']);
        }
      }
    }
  }
}

// ── Half-cell texture helpers ─────────────────────────────────────────────────

/** Normalized (0..1) mouse position within the cell (row, col). */
function getRelPos(event, row, col) {
  const t = getTransform();
  const gs = state.dungeon.metadata.gridSize;
  const worldX = (event.offsetX - t.offsetX) / t.scale;
  const worldY = (event.offsetY - t.offsetY) / t.scale;
  return {
    relX: (worldX - col * gs) / gs,
    relY: (worldY - row * gs) / gs,
  };
}

/**
 * Returns the half-texture key for the half that contains (relX, relY),
 * or null if the cell has no diagonal wall.
 * nw-se diagonal: NE half if relY < relX, else SW.
 * ne-sw diagonal: NW half if relX+relY < 1, else SE.
 */
function halfKeyFromPos(cell, relX, relY) {
  if (cell.trimRound) return null; // arc clip handles shaping — use whole-cell texture
  if (cell['nw-se']) return relY < relX ? 'texture' : 'textureSecondary';
  if (cell['ne-sw']) return relX + relY < 1 ? 'texture' : 'textureSecondary';
  return null;
}

/**
 * Returns the half-texture key based on the BFS entry direction into the cell.
 * nw-se: entry N/E → NE half; entry S/W → SW half.
 * ne-sw: entry N/W → NW half; entry S/E → SE half.
 */
function halfKeyFromEntry(cell, entryDir) {
  if (cell.trimRound) return null; // arc clip handles shaping — use whole-cell texture
  if (cell['nw-se']) return (entryDir === 'north' || entryDir === 'east') ? 'texture' : 'textureSecondary';
  if (cell['ne-sw']) return (entryDir === 'north' || entryDir === 'west') ? 'texture' : 'textureSecondary';
  return null;
}

/**
 * Converts a half-texture key back into a synthetic BFS entry direction.
 * Used to give diagonal start cells a proper entry direction so blockedByDiagonal works.
 */
function syntheticEntryFromHalfKey(halfKey) {
  if (halfKey === 'texture') return 'north';
  if (halfKey === 'textureSecondary') return 'south';
  return null;
}

export class PaintTool extends Tool {
  constructor() {
    super('paint', 'P', 'crosshair');
    this.dragging = false;
    this.dragStart = null;  // {row, col}
    this.dragEnd = null;    // {row, col}
    this.mousePos = null;   // canvas pixel pos for size label

    // Bound listeners stored so they can be removed on deactivate
    this._onKeyDown = (e) => {
      if (e.key === 'Alt' && state.paintMode !== 'syringe') {
        setCursor(SYRINGE_CURSOR);
      } else if (e.key === 'Shift' && !e.altKey && (state.paintMode === 'texture' || state.paintMode === 'clear-texture')) {
        setCursor(BUCKET_CURSOR);
      }
    };
    this._onKeyUp = (e) => {
      if (e.key === 'Alt') {
        // Restore: if shift still held in texture mode show bucket, else normal cursor
        if (e.shiftKey && (state.paintMode === 'texture' || state.paintMode === 'clear-texture')) {
          setCursor(BUCKET_CURSOR);
        } else {
          setCursor(state.paintMode === 'syringe' ? SYRINGE_CURSOR : 'crosshair');
        }
      } else if (e.key === 'Shift') {
        // If alt is still held, keep showing syringe cursor
        if (e.altKey && state.paintMode !== 'syringe') {
          setCursor(SYRINGE_CURSOR);
        } else {
          setCursor(state.paintMode === 'syringe' ? SYRINGE_CURSOR : 'crosshair');
        }
      }
    };
  }

  getCursor() {
    return state.paintMode === 'syringe' ? SYRINGE_CURSOR : 'crosshair';
  }

  onActivate() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    if (state.paintMode === 'syringe') setCursor(SYRINGE_CURSOR);
    const statuses = {
      texture:         'Drag to paint texture · Shift+click to flood fill · Alt+click to sample · Right-click to clear',
      syringe:         'Click to sample texture from a cell · Switches to Texture mode',
      room:            'Drag to paint room floor color',
      'clear-texture': 'Drag to clear texture · Shift+click to flood clear',
    };
    state.statusInstruction = statuses[state.paintMode || 'room'] || null;
  }

  onDeactivate() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    this.dragging = false;
    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    setCursor('crosshair'); // reset if shift was held when switching tools
    state.statusInstruction = null;
  }

  onMouseDown(row, col, edge, event) {
    // Alt+click: syringe pick regardless of current mode
    if (event.altKey) {
      this.syringePick(row, col, event);
      return;
    }
    // Shift+click: flood fill shortcuts (unchanged)
    if (event.shiftKey && state.paintMode === 'texture') {
      this.floodFill(row, col, event);
      return;
    }
    if (event.shiftKey && state.paintMode === 'clear-texture') {
      this.floodFillClear(row, col, event);
      return;
    }
    if (state.paintMode === 'syringe') {
      this.syringePick(row, col, event);
      return;
    }
    // Start box-drag for texture, clear-texture, and room modes
    const cells = state.dungeon.cells;
    if (!isInBounds(cells, row, col)) return;
    this.dragging = true;
    this.dragStart = { row, col };
    this.dragEnd = { row, col };
    this.mousePos = null;
  }

  onMouseMove(row, col, _edge, event, pos) {
    if (!this.dragging) return;
    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length || 1) - 1, col));

    if (event?.shiftKey && state.paintMode === 'room') {
      ({ row, col } = snapToSquare(row, col, this.dragStart.row, this.dragStart.col, cells));
    }

    this.dragEnd = { row, col };
    this.mousePos = pos || null;
    requestRender();
  }

  onMouseUp(row, col, _edge, event) {
    if (!this.dragging) return;
    this.dragging = false;

    const cells = state.dungeon.cells;
    row = Math.max(0, Math.min(cells.length - 1, row));
    col = Math.max(0, Math.min((cells[0]?.length || 1) - 1, col));

    if (event?.shiftKey && state.paintMode === 'room') {
      ({ row, col } = snapToSquare(row, col, this.dragStart.row, this.dragStart.col, cells));
    }

    this.dragEnd = { row, col };
    this._applyToBox();

    this.dragStart = null;
    this.dragEnd = null;
    this.mousePos = null;
    requestRender();
  }

  floodFill(startRow, startCol, event) {
    const cells = state.dungeon.cells;
    if (!cells[startRow]?.[startCol]) return; // void cell — nothing to fill

    const tid = state.activeTexture;
    if (!tid) return;
    loadTextureImages(tid); // ensure images are loading (no-op if already started)

    pushUndo('Flood fill');

    // Determine which half of the start cell was clicked (for diagonal cells)
    const startCell = cells[startRow][startCol];
    const { relX: startRelX, relY: startRelY } = event
      ? getRelPos(event, startRow, startCol)
      : { relX: 0.5, relY: 0.5 };
    const startHalfKey = halfKeyFromPos(startCell, startRelX, startRelY);

    // For diagonal start cells, derive a synthetic entry direction from the clicked half so
    // that blockedByDiagonal correctly restricts exits to the clicked half's side.
    let startEntry = syntheticEntryFromHalfKey(startHalfKey);

    // halfKeyFromPos returns null for trimRound cells (arc uses whole-cell texture).
    // For traversal we still need an entry direction so blockedByDiagonal can restrict
    // exits to the clicked half — derive it directly from mouse position geometry.
    if (startEntry === null && startCell.trimRound) {
      if (startCell['nw-se']) startEntry = startRelY < startRelX ? 'north' : 'south';
      else if (startCell['ne-sw']) startEntry = startRelX + startRelY < 1 ? 'north' : 'south';
    }

    // Queue entries: [r, c, entryDir] — entryDir is the direction we came FROM.
    const queue = [[startRow, startCol, startEntry]];

    // Visited keyed by (cell + entryDir). For diagonal cells, when a cell is first reached
    // from one half, lockDiagonalHalf pre-marks the other half's entry keys so the BFS
    // cannot re-enter the same cell from the opposite side of the diagonal wall.
    const visitedTraversal = new Set([`${startRow},${startCol},${startEntry ?? ''}`]);
    lockDiagonalHalf(visitedTraversal, startRow, startCol, startEntry, startCell);

    // toFill stores [r, c, halfKey] — halfKey is null for whole-cell, else 'texture' or 'textureSecondary'.
    const filledCells = new Set([cellKey(startRow, startCol)]);
    const toFill = [[startRow, startCol, startHalfKey]];

    while (queue.length > 0) {
      const [r, c, entryDir] = queue.shift();
      const cell = cells[r]?.[c];
      if (!cell) continue;

      const diagonalBlocked = blockedByDiagonal(cell, entryDir);
      for (const { dir, dr, dc } of FILL_DIRS) {
        if (cell[dir]) continue; // wall, door, or secret door — don't cross
        if (diagonalBlocked.has(dir)) continue; // diagonal wall blocks this exit

        const nr = r + dr, nc = c + dc;
        const neighborEntryDir = OPPOSITE[dir];
        const tKey = `${nr},${nc},${neighborEntryDir}`;
        if (visitedTraversal.has(tKey)) continue;
        visitedTraversal.add(tKey);
        if (!cells[nr]?.[nc]) continue; // void — stop

        const neighborCell = cells[nr][nc];
        if (neighborCell[neighborEntryDir]) continue; // wall on the entry side of neighbor

        // Lock diagonal neighbor cells to the first half they're reached from,
        // preventing the BFS from re-entering them from the opposite half.
        lockDiagonalHalf(visitedTraversal, nr, nc, neighborEntryDir, neighborCell);
        queue.push([nr, nc, neighborEntryDir]);

        const fillKey = cellKey(nr, nc);
        if (!filledCells.has(fillKey)) {
          filledCells.add(fillKey);
          const halfKey = halfKeyFromEntry(neighborCell, neighborEntryDir);
          toFill.push([nr, nc, halfKey]);
        }
      }
    }

    const forceSecondary = !!state.paintSecondary;

    // Snapshot the main BFS fill before the arc post-pass so Phase 3 can
    // determine which side of the arc the fill originated from.
    const mainFillCells = new Set(filledCells);

    // Arc post-pass: paint all trimRound ring cells connected to the filled region.
    // Two-phase approach:
    //   Phase 1 — seed: collect trimRound cells already in the main BFS fill, plus any
    //             trimRound cells adjacent to filled cells. No direction check is needed
    //             here because trimRound cells always use halfKey=null, so the write loop
    //             below selects texture vs textureSecondary solely via forceSecondary.
    //   Phase 2 — propagate: spread freely through adjacent trimRound cells so that
    //             large-radius arcs with many ring cells are fully claimed even when the
    //             main BFS diagonal-blocking stops short of propagating through them.
    const arcQueue = [];
    const arcVisited = new Set();

    for (const k of filledCells) {
      const [fr, fc] = k.split(',').map(Number);
      // Seed 1a: trimRound cells already reached by the main BFS
      if (cells[fr]?.[fc]?.trimRound && !arcVisited.has(k)) {
        arcVisited.add(k);
        arcQueue.push([fr, fc]);
      }
      // Seed 1b: trimRound cells adjacent to any filled cell
      for (const { dr, dc } of FILL_DIRS) {
        const nr = fr + dr, nc = fc + dc;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor?.trimRound) continue;
        const nKey = cellKey(nr, nc);
        if (arcVisited.has(nKey)) continue;
        arcVisited.add(nKey);
        if (!filledCells.has(nKey)) {
          filledCells.add(nKey);
          toFill.push([nr, nc, null]);
        }
        arcQueue.push([nr, nc]);
      }
    }
    // Phase 2: free propagation within the arc ring (handles large circles, multi-hop)
    while (arcQueue.length > 0) {
      const [ar, ac] = arcQueue.shift();
      for (const { dr, dc } of FILL_DIRS) {
        const nr = ar + dr, nc = ac + dc;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor?.trimRound) continue;
        const nKey = cellKey(nr, nc);
        if (arcVisited.has(nKey)) continue;
        arcVisited.add(nKey);
        if (!filledCells.has(nKey)) {
          filledCells.add(nKey);
          toFill.push([nr, nc, null]);
        }
        arcQueue.push([nr, nc]);
      }
    }

    // Phase 3: correct trimInsideArc cells — add if fill is from room side,
    // remove if fill is from void side (since they have no walls, the main BFS
    // may have incorrectly claimed them from the exterior).
    correctArcCells(cells, filledCells, toFill, mainFillCells, arcVisited);

    const opacity = state.textureOpacity ?? 1.0;
    let fMinR = Infinity, fMaxR = -Infinity, fMinC = Infinity, fMaxC = -Infinity;
    for (const [r, c, halfKey] of toFill) {
      const texKey = forceSecondary ? 'textureSecondary' : (halfKey || 'texture');
      const opKey = texKey + 'Opacity';
      cells[r][c][texKey] = tid;
      cells[r][c][opKey] = opacity;
      if (r < fMinR) fMinR = r; if (r > fMaxR) fMaxR = r;
      if (c < fMinC) fMinC = c; if (c > fMaxC) fMaxC = c;
    }
    if (fMinR <= fMaxR) {
      accumulateDirtyRect(fMinR, fMinC, fMaxR, fMaxC);
      _patchBlend({ minRow: fMinR, maxRow: fMaxR, minCol: fMinC, maxCol: fMaxC });
    }

    markDirty();
    notify();
  }

  /** Shift+click in clear-texture mode: flood-clear all textures in the connected room. */
  floodFillClear(startRow, startCol, event) {
    const cells = state.dungeon.cells;
    if (!cells[startRow]?.[startCol]) return;

    const startCell = cells[startRow][startCol];
    const { relX: startRelX, relY: startRelY } = event
      ? getRelPos(event, startRow, startCol)
      : { relX: 0.5, relY: 0.5 };
    const startHalfKey = halfKeyFromPos(startCell, startRelX, startRelY);
    const startEntry = syntheticEntryFromHalfKey(startHalfKey);

    const queue = [[startRow, startCol, startEntry]];
    const visitedTraversal = new Set([`${startRow},${startCol},${startEntry ?? ''}`]);
    lockDiagonalHalf(visitedTraversal, startRow, startCol, startEntry, startCell);

    const filledCells = new Set([cellKey(startRow, startCol)]);
    const toClear = [[startRow, startCol, startHalfKey]];

    while (queue.length > 0) {
      const [r, c, entryDir] = queue.shift();
      const cell = cells[r]?.[c];
      if (!cell) continue;

      const diagonalBlocked = blockedByDiagonal(cell, entryDir);
      for (const { dir, dr, dc } of FILL_DIRS) {
        if (cell[dir]) continue;
        if (diagonalBlocked.has(dir)) continue;

        const nr = r + dr, nc = c + dc;
        const neighborEntryDir = OPPOSITE[dir];
        const tKey = `${nr},${nc},${neighborEntryDir}`;
        if (visitedTraversal.has(tKey)) continue;
        visitedTraversal.add(tKey);
        if (!cells[nr]?.[nc]) continue;

        const neighborCell = cells[nr][nc];
        if (neighborCell[neighborEntryDir]) continue;

        lockDiagonalHalf(visitedTraversal, nr, nc, neighborEntryDir, neighborCell);
        queue.push([nr, nc, neighborEntryDir]);

        const fillKey = cellKey(nr, nc);
        if (!filledCells.has(fillKey)) {
          filledCells.add(fillKey);
          const halfKey = halfKeyFromEntry(neighborCell, neighborEntryDir);
          toClear.push([nr, nc, halfKey]);
        }
      }
    }

    // Snapshot the main BFS fill before the arc post-pass for Phase 3.
    const mainFillCells = new Set(filledCells);

    // Arc post-pass: clear all trimRound ring cells connected to the cleared region.
    // Same two-phase approach as floodFill: adjacency-seeded + free propagation.
    // No direction check — trimRound cells use halfKey=null so the write loop selects
    // texture vs textureSecondary solely via forceSecondary.
    const forceSecondary = !!state.paintSecondary;
    const arcQueueC = [];
    const arcVisitedC = new Set();

    for (const k of filledCells) {
      const [fr, fc] = k.split(',').map(Number);
      if (cells[fr]?.[fc]?.trimRound && !arcVisitedC.has(k)) {
        arcVisitedC.add(k);
        arcQueueC.push([fr, fc]);
      }
      for (const { dr, dc } of FILL_DIRS) {
        const nr = fr + dr, nc = fc + dc;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor?.trimRound) continue;
        const nKey = cellKey(nr, nc);
        if (arcVisitedC.has(nKey)) continue;
        arcVisitedC.add(nKey);
        if (!filledCells.has(nKey)) {
          filledCells.add(nKey);
          toClear.push([nr, nc, null]);
        }
        arcQueueC.push([nr, nc]);
      }
    }
    while (arcQueueC.length > 0) {
      const [ar, ac] = arcQueueC.shift();
      for (const { dr, dc } of FILL_DIRS) {
        const nr = ar + dr, nc = ac + dc;
        const neighbor = cells[nr]?.[nc];
        if (!neighbor?.trimRound) continue;
        const nKey = cellKey(nr, nc);
        if (arcVisitedC.has(nKey)) continue;
        arcVisitedC.add(nKey);
        if (!filledCells.has(nKey)) {
          filledCells.add(nKey);
          toClear.push([nr, nc, null]);
        }
        arcQueueC.push([nr, nc]);
      }
    }

    // Phase 3: correct trimInsideArc cells
    correctArcCells(cells, filledCells, toClear, mainFillCells, arcVisitedC);

    // Only push undo if there's actually something to clear
    let hasTexture = false;
    for (const [r, c, halfKey] of toClear) {
      const texKey = forceSecondary ? 'textureSecondary' : (halfKey || 'texture');
      if (cells[r][c][texKey]) { hasTexture = true; break; }
    }
    if (!hasTexture) return;

    pushUndo('Clear texture');
    let cMinR = Infinity, cMaxR = -Infinity, cMinC = Infinity, cMaxC = -Infinity;
    for (const [r, c, halfKey] of toClear) {
      const texKey = forceSecondary ? 'textureSecondary' : (halfKey || 'texture');
      const opKey = texKey + 'Opacity';
      delete cells[r][c][texKey];
      delete cells[r][c][opKey];
      if (r < cMinR) cMinR = r; if (r > cMaxR) cMaxR = r;
      if (c < cMinC) cMinC = c; if (c > cMaxC) cMaxC = c;
    }
    if (cMinR <= cMaxR) {
      accumulateDirtyRect(cMinR, cMinC, cMaxR, cMaxC);
      _patchBlend({ minRow: cMinR, maxRow: cMaxR, minCol: cMinC, maxCol: cMaxC });
    }

    markDirty();
    notify();
  }

  /** Syringe mode: pick up the texture from the clicked cell and switch to texture paint. */
  syringePick(row, col, event) {
    const cells = state.dungeon.cells;
    if (!cells[row]?.[col]) return;

    const cell = cells[row][col];
    const { relX, relY } = event ? getRelPos(event, row, col) : { relX: 0.5, relY: 0.5 };
    const halfKey = halfKeyFromPos(cell, relX, relY);
    const texKey = halfKey || 'texture';
    const opKey = halfKey ? halfKey + 'Opacity' : 'textureOpacity';

    const tid = cell[texKey];
    if (!tid) return; // no texture on this cell

    // Pick up opacity too
    const opacity = cell[opKey] ?? 1.0;
    state.textureOpacity = opacity;
    const slider = document.getElementById('texture-opacity-slider');
    const valueEl = document.getElementById('texture-opacity-value');
    if (slider) slider.value = Math.round(opacity * 100);
    if (valueEl) valueEl.textContent = `${Math.round(opacity * 100)}%`;

    // selectTexture sets activeTexture, switches to paint+texture mode, and updates the panel
    selectTexture(tid);
  }

  onRightClick(row, col, edge, event) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;
    if (cells[row][col] === null) return;

    const mode = state.paintMode || 'room';
    const cell = cells[row][col];

    if (mode === 'texture' || mode === 'clear-texture' || mode === 'syringe') {
      // Clear texture from cell
      const { relX, relY } = event ? getRelPos(event, row, col) : { relX: 0.5, relY: 0.5 };
      const halfKey = halfKeyFromPos(cell, relX, relY);
      if (halfKey) {
        if (!cell[halfKey]) return;
        pushUndo('Clear texture');
        delete cell[halfKey];
        delete cell[halfKey + 'Opacity'];
      } else {
        if (!cell.texture) return;
        pushUndo('Clear texture');
        delete cell.texture;
        delete cell.textureOpacity;
      }
      accumulateDirtyRect(row, col, row, col);
      _patchBlend({ minRow: row, maxRow: row, minCol: col, maxCol: col });
      markDirty();
      notify();
    }
  }

  /** Apply the active paint mode to all cells in the drag rectangle. */
  _applyToBox() {
    if (!this.dragStart || !this.dragEnd) return;

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row, this.dragStart.col, this.dragEnd.row, this.dragEnd.col);

    const mode = state.paintMode || 'room';
    const cells = state.dungeon.cells;

    if (mode === 'room') {
      let hasWork = false;
      for (let r = r1; r <= r2 && !hasWork; r++) {
        for (let c = c1; c <= c2 && !hasWork; c++) {
          if (cells[r]?.[c] === null || cells[r]?.[c]?.fill) hasWork = true;
        }
      }
      if (!hasWork) return;

      const coords = [];
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (cells[r]) coords.push({ row: r, col: c });
        }
      }
      const before = captureBeforeState(cells, coords);

      pushUndo('Paint room');
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (!cells[r]) continue;
          if (cells[r][c] !== null) {
            if (cells[r][c]?.fill) delete cells[r][c].fill;
          } else {
            cells[r][c] = {};
          }
        }
      }
      smartInvalidate(before, cells);
      markDirty();

    } else if (mode === 'texture') {
      const tid = state.activeTexture;
      if (!tid) return;
      loadTextureImages(tid);
      const opacity = state.textureOpacity ?? 1.0;
      const texKey = state.paintSecondary ? 'textureSecondary' : 'texture';
      const opKey = texKey + 'Opacity';
      let hasWork = false;
      for (let r = r1; r <= r2 && !hasWork; r++) {
        for (let c = c1; c <= c2 && !hasWork; c++) {
          const cell = cells[r]?.[c];
          if (cell && (cell[texKey] !== tid || cell[opKey] !== opacity)) hasWork = true;
        }
      }
      if (!hasWork) return;
      pushUndo('Paint texture');
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const cell = cells[r]?.[c];
          if (!cell) continue;
          cell[texKey] = tid;
          cell[opKey] = opacity;
        }
      }
      accumulateDirtyRect(r1, c1, r2, c2);
      _patchBlend({ minRow: r1, maxRow: r2, minCol: c1, maxCol: c2 });
      markDirty();
      notify();

    } else if (mode === 'clear-texture') {
      const clearKeys = state.paintSecondary
        ? ['textureSecondary', 'textureSecondaryOpacity']
        : ['texture', 'textureOpacity', 'textureSecondary', 'textureSecondaryOpacity'];
      const checkKeys = state.paintSecondary ? ['textureSecondary'] : ['texture', 'textureSecondary'];
      let hasWork = false;
      for (let r = r1; r <= r2 && !hasWork; r++) {
        for (let c = c1; c <= c2 && !hasWork; c++) {
          const cell = cells[r]?.[c];
          if (cell && checkKeys.some(k => cell[k])) hasWork = true;
        }
      }
      if (!hasWork) return;
      pushUndo('Clear texture');
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          const cell = cells[r]?.[c];
          if (!cell) continue;
          for (const k of clearKeys) delete cell[k];
        }
      }
      accumulateDirtyRect(r1, c1, r2, c2);
      invalidateBlendLayerCache();
      markDirty();
      notify();
    }
  }

  _drawSizeLabel(ctx, gridSize) {
    if (!this.mousePos || !this.dragStart || !this.dragEnd) return;
    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row, this.dragStart.col, this.dragEnd.row, this.dragEnd.col);
    const wFt = (c2 - c1 + 1) * gridSize;
    const hFt = (r2 - r1 + 1) * gridSize;
    const label = `${wFt} ft × ${hFt} ft`;

    ctx.save();
    ctx.font = 'bold 12px sans-serif';
    const pad = 5;
    const boxW = ctx.measureText(label).width + pad * 2;
    const boxH = 20;
    const bx = this.mousePos.x + 12;
    const by = this.mousePos.y - 12 - boxH;

    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + pad, by + boxH / 2);
    ctx.restore();
  }

  renderOverlay(ctx, transform, gridSize) {
    if (!this.dragging || !this.dragStart || !this.dragEnd) return;

    const { r1, c1, r2, c2 } = normalizeBounds(
      this.dragStart.row, this.dragStart.col, this.dragEnd.row, this.dragEnd.col);

    const mode = state.paintMode || 'room';
    const cellPx = gridSize * transform.scale;

    // Color per mode: green = room, blue = texture, red = clear
    const fillColor = mode === 'room'
      ? 'rgba(80, 200, 120, 0.25)'
      : mode === 'texture'
        ? 'rgba(80, 140, 220, 0.25)'
        : 'rgba(220, 80, 80, 0.25)';
    const strokeColor = mode === 'room'
      ? 'rgba(80, 200, 120, 0.9)'
      : mode === 'texture'
        ? 'rgba(80, 140, 220, 0.9)'
        : 'rgba(220, 80, 80, 0.9)';

    ctx.fillStyle = fillColor;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const p = toCanvas(c * gridSize, r * gridSize, transform);
        ctx.fillRect(p.x, p.y, cellPx, cellPx);
      }
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const x = c * gridSize;
        const y = r * gridSize;
        if (r === r1) { const p1 = toCanvas(x, y, transform), p2 = toCanvas(x + gridSize, y, transform); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
        if (r === r2) { const p1 = toCanvas(x, y + gridSize, transform), p2 = toCanvas(x + gridSize, y + gridSize, transform); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
        if (c === c1) { const p1 = toCanvas(x, y, transform), p2 = toCanvas(x, y + gridSize, transform); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
        if (c === c2) { const p1 = toCanvas(x + gridSize, y, transform), p2 = toCanvas(x + gridSize, y + gridSize, transform); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
      }
    }
    ctx.stroke();

    this._drawSizeLabel(ctx, gridSize);
  }
}
