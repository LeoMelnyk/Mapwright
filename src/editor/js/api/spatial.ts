import {
  getApi,
  CARDINAL_DIRS,
  OFFSETS,
  state,
  mutate,
  setReciprocal,
  cellKey,
  parseCellKey,
  floodFillRoom,
  roomBoundsFromKeys,
  toInt,
  toDisp,
  ApiValidationError,
} from './_shared.js';
import type { EdgeValue, PartitionRoomOptions } from '../../../types.js';
import { isPropAt } from '../prop-spatial.js';

// ── Spatial Queries ───────────────────────────────────────────────────────

/**
 * Find the cell that holds a room's label marker. Read-only.
 * @param {string} label - Room label to search for
 * @returns {{ success: boolean, row?: number, col?: number, error?: string }}
 */
export function findCellByLabel(label: string | number): {
  success: boolean;
  row?: number;
  col?: number;
  error?: string;
} {
  const cells = state.dungeon.cells;
  const target = String(label);
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r];
    for (let c = 0; c < row.length; c++) {
      if (cells[r][c]?.center?.label === target) return { success: true, row: toDisp(r), col: toDisp(c) };
    }
  }
  return { success: false, error: `Label "${label}" not found` };
}

/**
 * BFS from a label cell, stopping at walls, doors, secret doors, and diagonal walls.
 * @param {string} label - Room label
 * @returns {Set<string>|null} Set of "row,col" cell keys, or null if label not found
 */
export function _collectRoomCells(label: string): Set<string> | null {
  const start = getApi().findCellByLabel(label);
  if (!start.success) return null;
  return floodFillRoom(state.dungeon.cells, start.row!, start.col!);
}

/**
 * Return ordered wall cells along a specific side of a room.
 * @param {Set<string>} roomCellSet - Set of "row,col" cell keys for the room
 * @param {string} wall - 'north', 'south', 'east', or 'west'
 * @returns {Array<[number, number]>} Sorted [[row, col], ...] along the wall axis
 */
export function _getWallCells(roomCellSet: Set<string>, wall: string): [number, number][] {
  if (!CARDINAL_DIRS.includes(wall))
    throw new ApiValidationError('INVALID_WALL', `wall must be one of: ${CARDINAL_DIRS.join(', ')}`, { wall });
  const result: [number, number][] = [];
  const [dr, dc] = OFFSETS[wall];
  for (const key of roomCellSet) {
    const [r, c] = parseCellKey(key);
    if (!roomCellSet.has(cellKey(r + dr, c + dc))) {
      result.push([r, c] as [number, number]);
    }
  }
  if (wall === 'north' || wall === 'south') {
    result.sort((a, b) => a[1] - b[1]);
  } else {
    result.sort((a, b) => a[0] - b[0]);
  }
  return result;
}

/**
 * Check whether cell (r, c) is covered by any existing prop (anchor or spanned).
 * @param {number} r - Row index
 * @param {number} c - Column index
 * @returns {boolean} True if the cell is covered by a prop
 */
export function _isCellCoveredByProp(r: number, c: number): boolean {
  return isPropAt(r, c);
}

/**
 * BFS from the label cell through open edges to find the full room extent.
 * @param {string} label - Room label
 * @returns {{ r1: number, c1: number, r2: number, c2: number, centerRow: number, centerCol: number }|null}
 */
export function getRoomBounds(
  label: string,
):
  | { success: true; r1: number; c1: number; r2: number; c2: number; centerRow: number; centerCol: number }
  | { success: false; error: string } {
  const roomCells = getApi()._collectRoomCells(label);
  if (!roomCells) return { success: false, error: `Room "${label}" not found` };
  const bounds = roomBoundsFromKeys(roomCells);
  if (!bounds) return { success: false, error: `Room "${label}" has no bounds` };
  return {
    success: true,
    r1: toDisp(bounds.r1),
    c1: toDisp(bounds.c1),
    r2: toDisp(bounds.r2),
    c2: toDisp(bounds.c2),
    centerRow: toDisp(bounds.centerRow),
    centerCol: toDisp(bounds.centerCol),
  };
}

/**
 * Find all wall/door positions on the shared boundary between two labeled rooms.
 * @param {string} label1 - First room label
 * @param {string} label2 - Second room label
 * @returns {Array<{ row: number, col: number, direction: string, type: string }>|null}
 */
export function findWallBetween(
  label1: string,
  label2: string,
):
  | { success: true; walls: Array<{ row: number; col: number; direction: string; type: string }> }
  | { success: false; error: string } {
  const room1Cells = getApi()._collectRoomCells(label1);
  const room2Cells = getApi()._collectRoomCells(label2);
  if (!room1Cells) return { success: false, error: `Room "${label1}" not found` };
  if (!room2Cells) return { success: false, error: `Room "${label2}" not found` };

  const cells = state.dungeon.cells;
  const results: Array<{ row: number; col: number; direction: string; type: string }> = [];

  for (const key of room1Cells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    for (const dir of CARDINAL_DIRS) {
      const [dr, dc] = OFFSETS[dir];
      const nr = r + dr,
        nc = c + dc;
      if (!room2Cells.has(cellKey(nr, nc))) continue;
      results.push({
        row: toDisp(r),
        col: toDisp(c),
        direction: dir,
        type: ((cell as Record<string, unknown>)[dir] as string) || 'w',
      });
    }
  }

  if (results.length === 0)
    return { success: false, error: `No shared wall between rooms "${label1}" and "${label2}"` };
  return { success: true, walls: results };
}

/**
 * Add an internal wall partition across a room.
 * direction: 'horizontal' (wall across rows) or 'vertical' (wall across cols).
 * position: the absolute row (horizontal) or col (vertical) where the wall goes.
 * wallType: 'w' (wall) or 'iw' (invisible wall). Default 'w'.
 * @param {string} roomLabel - Room label
 * @param {string} direction - 'horizontal' or 'vertical'
 * @param {number} position - Row (horizontal) or column (vertical) for the partition
 * @param {string} [wallType='w'] - 'w' (wall) or 'iw' (invisible wall)
 * @param {Object} [options] - { doorAt: number } to place a door at a specific position
 * @returns {{ success: boolean, wallsPlaced: number }}
 */
export function partitionRoom(
  roomLabel: string,
  direction: string,
  position: number,
  wallType: string = 'w',
  options: PartitionRoomOptions = {},
): { success: true; wallsPlaced: number } {
  if (!['horizontal', 'vertical'].includes(direction)) {
    throw new ApiValidationError('INVALID_PARTITION_DIRECTION', 'direction must be "horizontal" or "vertical"', {
      direction,
      validDirections: ['horizontal', 'vertical'],
    });
  }
  if (!['w', 'iw'].includes(wallType)) {
    throw new ApiValidationError('INVALID_WALL_TYPE', 'wallType must be "w" or "iw"', {
      wallType,
      validTypes: ['w', 'iw'],
    });
  }
  position = toInt(position);
  const doorAt = options.doorAt != null ? toInt(options.doorAt) : undefined;

  const roomCells = getApi()._collectRoomCells(roomLabel);
  if (!roomCells) throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${roomLabel}" not found`, { label: roomLabel });

  // Collect affected coords (partition cells + their reciprocal neighbors)
  const coords: Array<{ row: number; col: number }> = [];
  for (const key of roomCells) {
    const [r, c] = parseCellKey(key);
    if (direction === 'horizontal') {
      if (r !== position) continue;
      if (!roomCells.has(cellKey(r + 1, c))) continue;
      coords.push({ row: r, col: c });
      coords.push({ row: r + 1, col: c });
    } else {
      if (c !== position) continue;
      if (!roomCells.has(cellKey(r, c + 1))) continue;
      coords.push({ row: r, col: c });
      coords.push({ row: r, col: c + 1 });
    }
  }

  if (coords.length === 0)
    throw new ApiValidationError(
      'NO_PARTITION_CELLS',
      `No cells at ${direction} position ${position} in room "${roomLabel}"`,
      { roomLabel, direction, position },
    );

  let count = 0;
  mutate(
    'partitionRoom',
    coords,
    () => {
      const cells = state.dungeon.cells;
      if (direction === 'horizontal') {
        for (const key of roomCells) {
          const [r, c] = parseCellKey(key);
          if (r !== position) continue;
          if (!roomCells.has(cellKey(r + 1, c))) continue;
          const val = (doorAt === c ? 'd' : wallType) as EdgeValue;
          cells[r][c]!.south = val;
          setReciprocal(r, c, 'south', val);
          count++;
        }
      } else {
        for (const key of roomCells) {
          const [r, c] = parseCellKey(key);
          if (c !== position) continue;
          if (!roomCells.has(cellKey(r, c + 1))) continue;
          const val = (doorAt === r ? 'd' : wallType) as EdgeValue;
          cells[r][c]!.east = val;
          setReciprocal(r, c, 'east', val);
          count++;
        }
      }
    },
    { invalidate: ['lighting'] },
  );

  return { success: true, wallsPlaced: count };
}

// ── Relational placement ─────────────────────────────────────────────────

type Cardinal = 'north' | 'south' | 'east' | 'west';

const CARDINAL_OFFSETS: Record<Cardinal, [number, number]> = {
  north: [-1, 0],
  south: [1, 0],
  east: [0, 1],
  west: [0, -1],
};

/** Mirror facing across the given axis. */
function mirrorFacing(facing: number, axis: 'vertical' | 'horizontal'): number {
  // Normalize 0–359
  const f = ((facing % 360) + 360) % 360;
  if (axis === 'vertical') {
    // Mirror left↔right: east(90)↔west(270), north/south unchanged
    if (f === 90) return 270;
    if (f === 270) return 90;
    return f;
  }
  // horizontal: mirror top↔bottom: north(0)↔south(180), east/west unchanged
  if (f === 0) return 180;
  if (f === 180) return 0;
  return f;
}

/**
 * Place a prop offset from an anchor cell in a cardinal direction.
 *
 * Saves the "compute (anchorRow + dr*offset, anchorCol + dc*offset) and call
 * placeProp" pattern. Use for "put a small-table 2 cells west of the throne".
 *
 * @param anchorRow Display row of the anchor cell
 * @param anchorCol Display col of the anchor cell
 * @param direction Cardinal direction from anchor
 * @param offset Cells away from anchor (1 = adjacent)
 * @param propType Prop catalog key to place
 * @param facing Optional rotation (0/90/180/270)
 */
export function placeRelative(
  anchorRow: number,
  anchorCol: number,
  direction: string,
  offset: number,
  propType: string,
  facing: number = 0,
): { success: true; row: number; col: number; placed: ReturnType<ReturnType<typeof getApi>['placeProp']> } {
  const dirOff = (CARDINAL_OFFSETS as Record<string, [number, number] | undefined>)[direction];
  if (!dirOff) {
    throw new ApiValidationError('INVALID_DIRECTION', `direction must be north|south|east|west`, { direction });
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new ApiValidationError('INVALID_OFFSET', 'offset must be a non-negative integer', { offset });
  }
  const [dr, dc] = dirOff;
  const targetRow = toInt(anchorRow) + dr * toInt(offset);
  const targetCol = toInt(anchorCol) + dc * toInt(offset);
  const placed = getApi().placeProp(toDisp(targetRow), toDisp(targetCol), propType, facing);
  return { success: true, row: toDisp(targetRow), col: toDisp(targetCol), placed };
}

/**
 * Place a pair of props mirrored across a room's centerline axis.
 *
 * For formal rooms (throne rooms, temples) where you want bilateral symmetry
 * — pillars flanking a throne, braziers either side of an altar.
 *
 * `axis: 'vertical'` mirrors left↔right across the room's vertical centerline
 * (most common for entry-axis rooms). `axis: 'horizontal'` mirrors top↔bottom.
 *
 * Facing is auto-mirrored (east becomes west on vertical mirror, etc.) so
 * facing props (chairs, thrones) point appropriately on each side.
 *
 * @param roomLabel Room to compute centerline from
 * @param axis 'vertical' (most common) or 'horizontal'
 * @param anchorRow Display row of the first prop
 * @param anchorCol Display col of the first prop
 * @param propType Prop to place at both positions
 * @param facing Rotation for the anchor prop (mirror prop gets auto-mirrored)
 */
export function placeSymmetric(
  roomLabel: string,
  axis: string,
  anchorRow: number,
  anchorCol: number,
  propType: string,
  facing: number = 0,
): {
  success: true;
  axis: 'vertical' | 'horizontal';
  centerline: number;
  placed: Array<{ row: number; col: number; facing: number }>;
} {
  if (axis !== 'vertical' && axis !== 'horizontal') {
    throw new ApiValidationError('INVALID_AXIS', `axis must be 'vertical' or 'horizontal'`, { axis });
  }
  const axisN: 'vertical' | 'horizontal' = axis;
  const api = getApi() as unknown as {
    getRoomBounds: (l: string) => { success: boolean; r1: number; c1: number; r2: number; c2: number };
    placeProp: (r: number, c: number, t: string, f: number) => unknown;
  };
  const bounds = api.getRoomBounds(roomLabel);
  if (!bounds.success) {
    throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${roomLabel}" not found`, { label: roomLabel });
  }
  const ar = toInt(anchorRow);
  const ac = toInt(anchorCol);
  let mr: number, mc: number;
  let centerline: number;
  if (axisN === 'vertical') {
    centerline = (bounds.c1 + bounds.c2) / 2;
    mr = ar;
    mc = bounds.c1 + bounds.c2 - ac;
  } else {
    centerline = (bounds.r1 + bounds.r2) / 2;
    mr = bounds.r1 + bounds.r2 - ar;
    mc = ac;
  }

  const placed: Array<{ row: number; col: number; facing: number }> = [];
  // Anchor first
  api.placeProp(ar, ac, propType, facing);
  placed.push({ row: ar, col: ac, facing });

  // Mirror — skip if it lands on the same cell (anchor on the axis)
  if (mr !== ar || mc !== ac) {
    const mirroredFacing = mirrorFacing(facing, axisN);
    api.placeProp(mr, mc, propType, mirroredFacing);
    placed.push({ row: mr, col: mc, facing: mirroredFacing });
  }

  return { success: true, axis: axisN, centerline, placed };
}

/**
 * Place a pair of props flanking an anchor prop.
 *
 * Finds the first instance of `anchorPropType` in `roomLabel`, then places
 * `flankPropType` on either side. "Either side" is perpendicular to the
 * anchor's facing axis: for a north-facing throne, flanks go east+west.
 *
 * Common pattern: `placeFlanking("A1", "throne", "pillar")` puts pillars
 * either side of a throne. Use a 1-cell gap by default.
 *
 * @param roomLabel Room containing the anchor prop
 * @param anchorPropType Prop type to find and flank
 * @param flankPropType Prop type to place on each side
 * @param options.gap Cells of gap between anchor span and flank (default 1)
 * @param options.flankFacing Rotation for the flank props (default 0)
 */
export function placeFlanking(
  roomLabel: string,
  anchorPropType: string,
  flankPropType: string,
  options: { gap?: number; flankFacing?: number } = {},
): {
  success: true;
  anchor: { row: number; col: number; facing: number };
  placed: Array<{ row: number; col: number; side: 'east' | 'west' | 'north' | 'south' }>;
  skipped: Array<{ row: number; col: number; side: string; reason: string }>;
} {
  const gap = options.gap ?? 1;
  const flankFacing = options.flankFacing ?? 0;
  const api = getApi() as unknown as {
    _collectRoomCells: (l: string) => Set<string> | null;
    placeProp: (r: number, c: number, t: string, f: number) => { success: boolean };
    getPropFootprint: (t: string, f: number) => { success: boolean; spanRows: number; spanCols: number };
  };
  const roomCells = api._collectRoomCells(roomLabel);
  if (!roomCells) {
    throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${roomLabel}" not found`, { label: roomLabel });
  }

  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const matches = (meta.props ?? []).filter((p) => p.type === anchorPropType);
  let anchor: { row: number; col: number; facing: number } | null = null;
  for (const p of matches) {
    const pr = Math.floor(p.y / gs);
    const pc = Math.floor(p.x / gs);
    if (roomCells.has(cellKey(pr, pc))) {
      anchor = { row: pr, col: pc, facing: typeof p.rotation === 'number' ? p.rotation : (p.facing ?? 0) };
      break;
    }
  }
  if (!anchor) {
    throw new ApiValidationError('ANCHOR_NOT_FOUND', `No "${anchorPropType}" prop found in room "${roomLabel}"`, {
      roomLabel,
      anchorPropType,
    });
  }

  const fp = api.getPropFootprint(anchorPropType, anchor.facing);
  const spanRows = fp.spanRows || 1;
  const spanCols = fp.spanCols || 1;

  // Flank perpendicular to facing axis. facing N(0)/S(180) → flank E/W.
  // facing E(90)/W(270) → flank N/S. Default to E/W if facing is 0.
  const facingAxis = anchor.facing === 90 || anchor.facing === 270 ? 'vertical' : 'horizontal';

  const placed: Array<{ row: number; col: number; side: 'east' | 'west' | 'north' | 'south' }> = [];
  const skipped: Array<{ row: number; col: number; side: string; reason: string }> = [];

  const sides: Array<{ side: 'east' | 'west' | 'north' | 'south'; row: number; col: number }> =
    facingAxis === 'horizontal'
      ? [
          { side: 'west', row: anchor.row, col: anchor.col - gap - 1 },
          { side: 'east', row: anchor.row, col: anchor.col + spanCols + gap - 1 + 1 },
        ]
      : [
          { side: 'north', row: anchor.row - gap - 1, col: anchor.col },
          { side: 'south', row: anchor.row + spanRows + gap - 1 + 1, col: anchor.col },
        ];

  for (const s of sides) {
    if (!roomCells.has(cellKey(s.row, s.col))) {
      skipped.push({ row: toDisp(s.row), col: toDisp(s.col), side: s.side, reason: 'OUT_OF_ROOM' });
      continue;
    }
    try {
      api.placeProp(toDisp(s.row), toDisp(s.col), flankPropType, flankFacing);
      placed.push({ row: toDisp(s.row), col: toDisp(s.col), side: s.side });
    } catch (e) {
      skipped.push({
        row: toDisp(s.row),
        col: toDisp(s.col),
        side: s.side,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    success: true,
    anchor: { row: toDisp(anchor.row), col: toDisp(anchor.col), facing: anchor.facing },
    placed,
    skipped,
  };
}
