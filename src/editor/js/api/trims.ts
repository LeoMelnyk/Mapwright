import type { CardinalDirection, Cell, CreateTrimOptions, Direction } from '../../../types.js';
import type { TrimCorner } from '../../../util/trim-geometry.js';
import {
  getApi,
  CARDINAL_DIRS, OFFSETS, OPPOSITE,
  state, pushUndo, markDirty, notify,
  trimTool,
  validateBounds,
  toInt,
  captureBeforeState, smartInvalidate,
} from './_shared.js';
import { computeTrimCells, getEdge, deleteEdge } from '../../../util/index.js';

// ── Trim (reuses TrimTool._updatePreview + apply logic) ──────────────────

/**
 * Create a diagonal trim (corner cut) between two points.
 * @param {number} r1 - Tip row (corner to cut)
 * @param {number} c1 - Tip column
 * @param {number} r2 - Extent row (opposite corner of trim region)
 * @param {number} c2 - Extent column
 * @param {string|Object} [cornerOrOptions] - Corner direction or options object
 * @param {Object} [extraOptions] - Additional options when first arg is a string corner
 * @returns {{ success: boolean }}
 */
export function createTrim(r1: number, c1: number, r2: number, c2: number, cornerOrOptions: string | CreateTrimOptions = {}, extraOptions: CreateTrimOptions = {}): { success: true; note?: string } {
  r1 = toInt(r1); c1 = toInt(c1); r2 = toInt(r2); c2 = toInt(c2);
  validateBounds(r1, c1);
  validateBounds(r2, c2);

  // Support both calling conventions:
  //   createTrim(r1, c1, r2, c2, { corner, round, ... })
  //   createTrim(r1, c1, r2, c2, "nw", { round: true })
  let options;
  if (typeof cornerOrOptions === 'string') {
    options = { ...extraOptions, corner: cornerOrOptions };
  } else {
    options = cornerOrOptions;
  }

  const corner = options.corner ?? 'auto';
  const round = !!options.round;
  const inverted = !!options.inverted;
  const open = !!options.open;

  // Resolve corner from drag direction if auto
  let resolvedCorner: string;
  if (corner === 'auto') {
    const dr = r2 - r1;
    const dc = c2 - c1;
    if (dr <= 0 && dc <= 0) resolvedCorner = 'nw';
    else if (dr <= 0 && dc >= 0) resolvedCorner = 'ne';
    else if (dr >= 0 && dc <= 0) resolvedCorner = 'sw';
    else resolvedCorner = 'se';
  } else {
    if (!['nw', 'ne', 'sw', 'se'].includes(corner)) {
      throw new Error(`Invalid corner: ${corner}. Use 'auto', 'nw', 'ne', 'sw', 'se'.`);
    }
    resolvedCorner = corner;
  }

  // Set up trim tool state for preview computation
  const prevCorner = state.trimCorner;
  const prevRound = state.trimRound;
  const prevInverted = state.trimInverted;
  const prevOpen = state.trimOpen;

  state.trimCorner = corner;
  state.trimRound = round;
  state.trimInverted = inverted;
  state.trimOpen = open;

  trimTool.dragStart = { row: r1, col: c1 };
  trimTool.dragEnd = { row: r2, col: c2 };
  trimTool.resolvedCorner = resolvedCorner as TrimCorner;
  trimTool._updatePreview();

  const preview = trimTool.previewCells;
  if (!preview || preview.hypotenuse.length === 0) {
    state.trimCorner = prevCorner;
    state.trimRound = prevRound;
    state.trimInverted = prevInverted;
    state.trimOpen = prevOpen;
    trimTool.previewCells = null;
    return { success: true, note: 'No cells to trim' };
  }

  // Apply — same logic as TrimTool.onMouseUp
  const cells = state.dungeon.cells;
  const trimCoords = [
    ...preview.voided.map(({ row, col }: { row: number; col: number }) => ({ row, col })),
    ...preview.hypotenuse.map(({ row, col }: { row: number; col: number }) => ({ row, col })),
    ...(preview.insideArc ?? []).map(({ row, col }: { row: number; col: number }) => ({ row, col })),
  ];
  const before = captureBeforeState(cells, trimCoords);
  pushUndo();

  // Helper: clear all walls and reciprocals from a cell
  const clearWalls = (cell: Cell, r: number, c: number) => {
    for (const dir of CARDINAL_DIRS) {
      if (getEdge(cell, dir as Direction)) {
        deleteEdge(cell, dir as Direction);
        const [dr, dc] = OFFSETS[dir];
        const neighbor = cells[r + dr]?.[c + dc];
        if (neighbor) deleteEdge(neighbor, OPPOSITE[dir as CardinalDirection]);
      }
    }
    deleteEdge(cell, 'nw-se');
    deleteEdge(cell, 'ne-sw');
  };

  const clearOldTrimFlags = (cell: Cell) => {
    delete cell.trimRound;
    delete cell.trimArcCenterRow;
    delete cell.trimArcCenterCol;
    delete cell.trimArcRadius;
    delete cell.trimArcInverted;
    delete cell.trimInsideArc;
    delete cell.trimCorner;
    delete cell.trimOpen;
    delete cell.trimInverted;
    delete cell.trimClip;
    delete cell.trimWall;
    delete cell.trimPassable;
    delete cell.trimCrossing;
  };

  if (round) {
    // ── Round trim: per-cell data from computeTrimCells ──
    const trimData = computeTrimCells(preview, resolvedCorner as TrimCorner, inverted, open);
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;

    // Only clear walls on cells in the original trim zone, not buffer-ring neighbors
    const trimZone = new Set([
      ...preview.voided.map((c: { row: number; col: number }) => `${c.row},${c.col}`),
      ...preview.hypotenuse.map((c: { row: number; col: number }) => `${c.row},${c.col}`),
      ...(preview.insideArc ?? []).map((c: { row: number; col: number }) => `${c.row},${c.col}`),
    ]);

    for (const [key, val] of trimData) {
      const [r, c] = key.split(',').map(Number);
      if (r < 0 || r >= numRows || c < 0 || c >= numCols) continue;
      const inZone = trimZone.has(key);

      if (val === null) {
        cells[r][c] = null;
      } else if (val === 'interior') {
        if (inZone) {
          cells[r][c] ??= {};
          const cell = cells[r][c];
          clearWalls(cell, r, c);
          clearOldTrimFlags(cell);
        }
      } else if ((val as unknown as string) === 'diagonal') {
        // Inverted hypotenuse: straight diagonal wall (like straight trims)
        cells[r][c] ??= {};
        const cell = cells[r][c];
        if (inZone) clearWalls(cell, r, c);
        clearOldTrimFlags(cell);
        cell.trimCorner = resolvedCorner;
        if (resolvedCorner === 'nw' || resolvedCorner === 'se') cell['ne-sw'] = 'w';
        else cell['nw-se'] = 'w';
        if (open) cell.trimOpen = true;
      } else {
        cells[r][c] ??= {};
        const cell = cells[r][c];
        if (inZone) clearWalls(cell, r, c);
        clearOldTrimFlags(cell);
        Object.assign(cell, val);
      }
    }
  } else {
    // ── Straight trim: original logic (unchanged) ──
    if (!open) {
      for (const { row, col } of preview.voided) {
        cells[row][col] = null;
      }
    } else {
      for (const { row: r, col: c } of preview.voided) {
        const cell = cells[r]?.[c];
        if (!cell) continue;
        clearWalls(cell, r, c);
        clearOldTrimFlags(cell);
      }
    }

    for (const { row: r, col: c } of preview.hypotenuse) {
      cells[r][c] ??= {};
      const cell = cells[r][c];
      cell.trimCorner = resolvedCorner;
      clearWalls(cell, r, c);

      if (resolvedCorner === 'nw' || resolvedCorner === 'se') {
        cell['ne-sw'] = 'w';
      } else {
        cell['nw-se'] = 'w';
      }

      if (open) cell.trimOpen = true;
      else delete cell.trimOpen;
    }
  }

  // Restore state
  state.trimCorner = prevCorner;
  state.trimRound = prevRound;
  state.trimInverted = prevInverted;
  state.trimOpen = prevOpen;
  trimTool.previewCells = null;

  smartInvalidate(before, cells, { forceGeometry: true });
  markDirty();
  notify();
  return { success: true };
}

/**
 * Round all 4 corners of a labeled room with curved arc trims.
 * Automatically computes the correct corner direction, trim region,
 * and arc parameters — no manual coordinate math needed.
 *
 * @param {string} label - Room label (e.g. "A10")
 * @param {number} trimSize - Number of cells to trim from each corner (default: 3)
 * @param {object} [options] - { inverted: false }
 * @returns {{ success, corners: string[] }}
 */
export function roundRoomCorners(label: string, trimSize: number | Record<string, number | boolean> = 3, options: Record<string, number | boolean | string> = {}): { success: true; corners: string[]; trimSize: number; bounds: { r1: number; c1: number; r2: number; c2: number } } {
  if (typeof label === 'string' && typeof trimSize === 'object') {
    // roundRoomCorners("A10", { trimSize: 4 })
    options = trimSize;
    trimSize = (options.trimSize as number) || 3;
  }

  const bounds = getApi().getRoomBounds(label);
  if (!bounds) throw new Error(`Room "${label}" not found`);

  const { r1, c1, r2, c2 } = bounds;
  const roomHeight = r2 - r1 + 1;
  const roomWidth = c2 - c1 + 1;

  if ((trimSize as number) * 2 > roomHeight || (trimSize as number) * 2 > roomWidth) {
    throw new Error(
      `Trim size ${trimSize} is too large for room "${label}" (${roomWidth}×${roomHeight}). ` +
      `Max trim size: ${Math.floor(Math.min(roomHeight, roomWidth) / 2)}`
    );
  }

  const inverted = !!options.inverted;
  // createTrim expects (tip, extent) where tip is the corner's outermost cell
  // and extent is the opposite corner of the trim region.
  // tip = the actual room corner cell, extent = trimSize cells inward.
  const s = (trimSize as number) - 1;
  const corners = [
    { corner: 'nw', tipR: r1, tipC: c1, extR: r1 + s, extC: c1 + s },
    { corner: 'ne', tipR: r1, tipC: c2, extR: r1 + s, extC: c2 - s },
    { corner: 'sw', tipR: r2, tipC: c1, extR: r2 - s, extC: c1 + s },
    { corner: 'se', tipR: r2, tipC: c2, extR: r2 - s, extC: c2 - s },
  ];

  const applied = [];
  for (const { corner, tipR, tipC, extR, extC } of corners) {
    getApi().createTrim(tipR, tipC, extR, extC, corner, { round: true, inverted, open: !!options.open });
    applied.push(corner);
  }

  return { success: true, corners: applied, trimSize: trimSize as number, bounds: { r1, c1, r2, c2 } };
}
