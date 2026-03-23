import {
  getApi,
  CARDINAL_DIRS, OFFSETS, OPPOSITE,
  state, pushUndo, markDirty, notify,
  trimTool,
  validateBounds,
  toInt,
  captureBeforeState, smartInvalidate,
} from './_shared.js';

// ── Trim (reuses TrimTool._updatePreview + apply logic) ──────────────────

export function createTrim(r1, c1, r2, c2, cornerOrOptions = {}, extraOptions = {}) {
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
    options = cornerOrOptions || {};
  }

  const corner = options.corner || 'auto';
  const round = !!options.round;
  const inverted = !!options.inverted;
  const open = !!options.open;

  // Resolve corner from drag direction if auto
  let resolvedCorner;
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
  trimTool.resolvedCorner = resolvedCorner;
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
    ...preview.voided.map(({ row, col }) => ({ row, col })),
    ...preview.hypotenuse.map(({ row, col }) => ({ row, col })),
    ...(preview.insideArc || []).map(({ row, col }) => ({ row, col })),
  ];
  const before = captureBeforeState(cells, trimCoords);
  pushUndo();
  const size = preview.hypotenuse.length;

  // Void interior (or clear walls in open mode)
  if (!open) {
    for (const { row, col } of preview.voided) {
      cells[row][col] = null;
    }
  } else {
    for (const { row: r, col: c } of preview.voided) {
      const cell = cells[r]?.[c];
      if (!cell) continue;
      for (const dir of CARDINAL_DIRS) {
        if (cell[dir]) {
          delete cell[dir];
          const [dr, dc] = OFFSETS[dir];
          const neighbor = cells[r + dr]?.[c + dc];
          if (neighbor) delete neighbor[OPPOSITE[dir]];
        }
      }
      delete cell['nw-se'];
      delete cell['ne-sw'];
      delete cell.trimCorner;
      delete cell.trimRound;
      delete cell.trimArcCenterRow;
      delete cell.trimArcCenterCol;
      delete cell.trimArcRadius;
      delete cell.trimArcInverted;
      delete cell.trimOpen;
    }
  }

  // Set hypotenuse cells
  for (const { row: r, col: c } of preview.hypotenuse) {
    if (!cells[r][c]) cells[r][c] = {};
    const cell = cells[r][c];

    cell.trimCorner = resolvedCorner;

    // Clear all cardinal walls + reciprocals
    for (const dir of CARDINAL_DIRS) {
      if (cell[dir]) {
        delete cell[dir];
        const [dr, dc] = OFFSETS[dir];
        const neighbor = cells[r + dr]?.[c + dc];
        if (neighbor) delete neighbor[OPPOSITE[dir]];
      }
    }
    delete cell['nw-se'];
    delete cell['ne-sw'];

    // Set diagonal border
    if (resolvedCorner === 'nw' || resolvedCorner === 'se') {
      cell['ne-sw'] = 'w';
    } else {
      cell['nw-se'] = 'w';
    }

    if (round) {
      cell.trimRound = true;
      cell.trimArcInverted = inverted;
      cell.trimArcCenterRow = preview.arcCenter.row;
      cell.trimArcCenterCol = preview.arcCenter.col;
      cell.trimArcRadius = size;
      if (open) cell.trimOpen = true;
      else delete cell.trimOpen;
    } else {
      delete cell.trimRound;
      delete cell.trimArcCenterRow;
      delete cell.trimArcCenterCol;
      delete cell.trimArcRadius;
      delete cell.trimArcInverted;
      if (open) cell.trimOpen = true;
      else delete cell.trimOpen;
    }
  }

  // Clear walls from insideArc cells and mark with metadata for BFS detection
  for (const { row: r, col: c } of (preview.insideArc || [])) {
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const dir of CARDINAL_DIRS) {
      if (cell[dir]) {
        delete cell[dir];
        const [dr, dc] = OFFSETS[dir];
        const neighbor = cells[r + dr]?.[c + dc];
        if (neighbor) delete neighbor[OPPOSITE[dir]];
      }
    }
    delete cell['nw-se'];
    delete cell['ne-sw'];
    delete cell.trimRound;
    cell.trimInsideArc = true;
    cell.trimCorner = resolvedCorner;
    cell.trimArcCenterRow = preview.arcCenter.row;
    cell.trimArcCenterCol = preview.arcCenter.col;
    cell.trimArcRadius = size;
    cell.trimArcInverted = inverted;
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
export function roundRoomCorners(label, trimSize = 3, options = {}) {
  if (typeof label === 'string' && typeof trimSize === 'object') {
    // roundRoomCorners("A10", { trimSize: 4 })
    options = trimSize;
    trimSize = options.trimSize || 3;
  }

  const bounds = getApi().getRoomBounds(label);
  if (!bounds) throw new Error(`Room "${label}" not found`);

  const { r1, c1, r2, c2 } = bounds;
  const roomHeight = r2 - r1 + 1;
  const roomWidth = c2 - c1 + 1;

  if (trimSize * 2 > roomHeight || trimSize * 2 > roomWidth) {
    throw new Error(
      `Trim size ${trimSize} is too large for room "${label}" (${roomWidth}×${roomHeight}). ` +
      `Max trim size: ${Math.floor(Math.min(roomHeight, roomWidth) / 2)}`
    );
  }

  const inverted = !!options.inverted;
  // createTrim expects (tip, extent) where tip is the corner's outermost cell
  // and extent is the opposite corner of the trim region.
  // tip = the actual room corner cell, extent = trimSize cells inward.
  const s = trimSize - 1;
  const corners = [
    { corner: 'nw', tipR: r1, tipC: c1, extR: r1 + s, extC: c1 + s },
    { corner: 'ne', tipR: r1, tipC: c2, extR: r1 + s, extC: c2 - s },
    { corner: 'sw', tipR: r2, tipC: c1, extR: r2 - s, extC: c1 + s },
    { corner: 'se', tipR: r2, tipC: c2, extR: r2 - s, extC: c2 - s },
  ];

  const applied = [];
  for (const { corner, tipR, tipC, extR, extC } of corners) {
    getApi().createTrim(tipR, tipC, extR, extC, corner, { round: true, inverted });
    applied.push(corner);
  }

  return { success: true, corners: applied, trimSize, bounds: { r1, c1, r2, c2 } };
}
