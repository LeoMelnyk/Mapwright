import type { CardinalDirection, Cell, CreateTrimOptions, Direction, InteriorEdge, Segment } from '../../../types.js';
import type { TrimCorner } from '../../../util/trim-geometry.js';
import { getApi, CARDINAL_DIRS, OFFSETS, OPPOSITE, state, mutate, trimTool, validateBounds, toInt } from './_shared.js';
import {
  computeTrimCells,
  diagonalSegments,
  getEdge,
  deleteEdge,
  getSegments,
  primaryTextureSegmentIndex,
  spliceSegments,
  trimSegments,
} from '../../../util/index.js';

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
export function createTrim(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  cornerOrOptions: string | CreateTrimOptions = {},
  extraOptions: CreateTrimOptions = {},
): { success: true; note?: string } {
  r1 = toInt(r1);
  c1 = toInt(c1);
  r2 = toInt(r2);
  c2 = toInt(c2);
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
  const invisible = !!options.invisible;

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
  const trimCoords: Array<{ row: number; col: number }> = [
    ...preview.voided.map(({ row, col }: { row: number; col: number }) => ({ row, col })),
    ...preview.hypotenuse.map(({ row, col }: { row: number; col: number }) => ({ row, col })),
    ...(preview.insideArc ?? []).map(({ row, col }: { row: number; col: number }) => ({ row, col })),
  ];

  mutate(
    'createTrim',
    trimCoords,
    () => {
      // Helper: clear all walls (cardinal + interior partition) from a cell.
      // Trim placement claims the cell shape — any pre-existing diagonal/arc
      // partition must be wiped before the new partition is written.
      const clearWalls = (cell: Cell, r: number, c: number) => {
        for (const dir of CARDINAL_DIRS) {
          if (getEdge(cell, dir as Direction)) {
            deleteEdge(cell, dir as Direction);
            const [dr, dc] = OFFSETS[dir]!;
            const neighbor = cells[r + dr]?.[c + dc];
            if (neighbor) deleteEdge(neighbor, OPPOSITE[dir as CardinalDirection]);
          }
        }
        delete cell.segments;
        delete cell.interiorEdges;
      };

      // Helper: clear walls on the NEIGHBORS of a cell that's about to be
      // voided (set to null). Without this, neighbors keep reciprocal walls
      // pointing into the void, leaving stray wall segments visible inside
      // the trimmed corner.
      const clearNeighborWalls = (r: number, c: number) => {
        for (const dir of CARDINAL_DIRS) {
          const [dr, dc] = OFFSETS[dir]!;
          const neighbor = cells[r + dr]?.[c + dc];
          if (neighbor) deleteEdge(neighbor, OPPOSITE[dir as CardinalDirection]);
        }
      };

      const cornerDiag = (cor: string): 'nw-se' | 'ne-sw' => (cor === 'nw' || cor === 'se' ? 'ne-sw' : 'nw-se');

      // Snapshot the cell's primary texture/opacity before partitioning so
      // the room half (interior arc segment / NE diagonal segment) inherits
      // it after the partition lands. Without this, trim placement wipes
      // existing floor textures.
      const snapshotPrimaryTexture = (cell: Cell): { texture?: string; opacity?: number } => {
        const segs = getSegments(cell);
        const idx = primaryTextureSegmentIndex(cell);
        const seg = segs[idx];
        return { texture: seg?.texture, opacity: seg?.textureOpacity };
      };

      // Apply a partition (segments + one interior edge) to a cell via
      // spliceSegments. Always passes deep-cloned arrays so `replacePartition`'s
      // invariant assertions don't share references with the factory output.
      // `preservedTexture` is written onto the new primary segment afterwards.
      const writePartition = (
        cell: Cell,
        segments: [Segment, Segment],
        interiorEdge: InteriorEdge,
        preservedTexture: { texture?: string; opacity?: number } = {},
      ) => {
        spliceSegments(cell, {
          kind: 'replacePartition',
          segments: segments.map((s) => ({
            ...s,
            polygon: s.polygon.map((p) => [p[0]!, p[1]!]),
          })),
          interiorEdges: [
            {
              vertices: interiorEdge.vertices.map((v) => [v[0]!, v[1]!]),
              wall: interiorEdge.wall,
              between: [interiorEdge.between[0], interiorEdge.between[1]],
            },
          ],
        });
        if (preservedTexture.texture !== undefined) {
          spliceSegments(cell, {
            kind: 'setSegmentTexture',
            segmentIndex: primaryTextureSegmentIndex(cell),
            texture: preservedTexture.texture,
            textureOpacity: preservedTexture.opacity,
          });
        }
      };

      if (round) {
        // ── Round trim: per-cell trimClip from computeTrimCells, fed to
        // trimSegments() to produce the canonical (interior, exterior)
        // partition. The chord polyline (`interiorEdge.vertices`) fully
        // describes the curve; downstream renderers stroke it directly via
        // `isChordEdge`.
        const trimData = computeTrimCells(preview, resolvedCorner as TrimCorner, inverted, open);
        const numRows = cells.length;
        const numCols = cells[0]?.length ?? 0;

        for (const [key, val] of trimData) {
          const [r, c] = key.split(',').map(Number) as [number, number];
          if (r < 0 || r >= numRows || c < 0 || c >= numCols) continue;

          if (val === null) {
            clearNeighborWalls(r, c);
            cells[r]![c] = null;
            continue;
          }

          cells[r]![c] ??= {};
          const cell = cells[r]![c];
          const preserved = snapshotPrimaryTexture(cell);
          clearWalls(cell, r, c);

          if (val === 'interior') {
            // Plain floor — no partition needed; the cell stays unsplit.
            // Restore the primary texture onto the (now unsplit) full segment.
            if (preserved.texture !== undefined) {
              spliceSegments(cell, {
                kind: 'setSegmentTexture',
                segmentIndex: 0,
                texture: preserved.texture,
                textureOpacity: preserved.opacity,
              });
            }
            continue;
          }

          // Arc boundary cell.
          const { segments, interiorEdge } = trimSegments(val.trimClip, !!val.trimOpen, invisible);
          writePartition(cell, segments, interiorEdge, preserved);
          // Closed trim: void the exterior segment (the chord-cut piece on
          // the corner side). The chord wall is 'w' or 'iw' (per `invisible`)
          // from trimSegments when openExterior=false, so connectivity is
          // correct; this just hides the floor on the outside half.
          if (!val.trimOpen) {
            spliceSegments(cell, {
              kind: 'setSegmentVoided',
              segmentIndex: 1,
              voided: true,
            });
          }
        }
      } else {
        // ── Straight (non-round) trim ──
        if (!open) {
          for (const { row, col } of preview.voided) {
            clearNeighborWalls(row, col);
            cells[row]![col] = null;
          }
        } else {
          for (const { row: r, col: c } of preview.voided) {
            const cell = cells[r]?.[c];
            if (!cell) continue;
            clearWalls(cell, r, c);
          }
        }

        const diag = cornerDiag(resolvedCorner);
        // Map the trimmed corner to the segment indices (room vs cut) of
        // the resulting diagonal partition. `diagonalSegments` orders:
        //   nw-se: s0=SW, s1=NE
        //   ne-sw: s0=SE, s1=NW
        // For an NW or NE corner trim the cut triangle is s1; for SW/SE it
        // is s0. The opposite index is the room half that should keep the
        // floor texture.
        const cutIdx = resolvedCorner === 'nw' || resolvedCorner === 'ne' ? 1 : 0;
        const roomIdx = 1 - cutIdx;
        for (const { row: r, col: c } of preview.hypotenuse) {
          cells[r]![c] ??= {};
          const cell = cells[r]![c];
          const preserved = snapshotPrimaryTexture(cell);
          clearWalls(cell, r, c);
          const { segments, interiorEdge } = diagonalSegments(diag);
          interiorEdge.wall = open ? null : invisible ? 'iw' : 'w';
          // No preservedTexture passed — we write it ourselves below to the
          // corner-aware room segment, since `primaryTextureSegmentIndex` for
          // diagonals always returns 1 (correct for SW/SE corners but the
          // void side for NW/NE).
          writePartition(cell, segments, interiorEdge);
          if (preserved.texture !== undefined) {
            spliceSegments(cell, {
              kind: 'setSegmentTexture',
              segmentIndex: roomIdx,
              texture: preserved.texture,
              textureOpacity: preserved.opacity,
            });
          }
          if (!open) {
            spliceSegments(cell, {
              kind: 'setSegmentVoided',
              segmentIndex: cutIdx,
              voided: true,
            });
          }
        }
      }
    },
    { forceGeometry: true, invalidate: ['lighting'] },
  );

  // Restore state
  state.trimCorner = prevCorner;
  state.trimRound = prevRound;
  state.trimInverted = prevInverted;
  state.trimOpen = prevOpen;
  trimTool.previewCells = null;

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
export function roundRoomCorners(
  label: string,
  trimSize: number | Record<string, number | boolean> = 3,
  options: Record<string, number | boolean | string> = {},
): { success: true; corners: string[]; trimSize: number; bounds: { r1: number; c1: number; r2: number; c2: number } } {
  if (typeof label === 'string' && typeof trimSize === 'object') {
    // roundRoomCorners("A10", { trimSize: 4 })
    options = trimSize;
    trimSize = (options.trimSize as number) || 3;
  }

  const boundsResult = getApi().getRoomBounds(label);
  if (!boundsResult.success) throw new Error(`Room "${label}" not found`);

  const { r1, c1, r2, c2 } = boundsResult;
  const roomHeight = r2 - r1 + 1;
  const roomWidth = c2 - c1 + 1;

  if ((trimSize as number) * 2 > roomHeight || (trimSize as number) * 2 > roomWidth) {
    throw new Error(
      `Trim size ${trimSize} is too large for room "${label}" (${roomWidth}×${roomHeight}). ` +
        `Max trim size: ${Math.floor(Math.min(roomHeight, roomWidth) / 2)}`,
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

// ── trimCorner: label-based single-corner trim, works on any room shape ──

type CompassCorner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Find every convex outer corner of a room's cell set. A cell contributes
 * a corner in direction `d` when both neighbors on the two axes that meet
 * at `d` are outside the room. A 1×1 room has all four corners on its
 * single cell; an L-shape has six.
 *
 * @returns Array of { row, col, corner } in display coords.
 */
function findConvexCorners(
  cellList: Array<[number, number]>,
): Array<{ row: number; col: number; corner: CompassCorner }> {
  const set = new Set(cellList.map(([r, c]) => `${r},${c}`));
  const has = (r: number, c: number) => set.has(`${r},${c}`);
  const out: Array<{ row: number; col: number; corner: CompassCorner }> = [];
  for (const [r, c] of cellList) {
    if (!has(r - 1, c) && !has(r, c - 1)) out.push({ row: r, col: c, corner: 'nw' });
    if (!has(r - 1, c) && !has(r, c + 1)) out.push({ row: r, col: c, corner: 'ne' });
    if (!has(r + 1, c) && !has(r, c - 1)) out.push({ row: r, col: c, corner: 'sw' });
    if (!has(r + 1, c) && !has(r, c + 1)) out.push({ row: r, col: c, corner: 'se' });
  }
  return out;
}

/** Priority for resolving a compass corner on an irregular room. */
function cornerPriority(corner: CompassCorner, r: number, c: number): [number, number] {
  // Lower scores win. Pick the cell most extreme in the compass direction.
  switch (corner) {
    case 'nw':
      return [r, c]; // min row, min col
    case 'ne':
      return [r, -c]; // min row, max col
    case 'sw':
      return [-r, c]; // max row, min col
    case 'se':
      return [-r, -c]; // max row, max col
  }
}

/**
 * Cut a single corner from a labeled room. Label-based — no coordinate math,
 * no tip/extent reasoning. Works on rectangular AND irregular rooms (L, U, +,
 * polygon).
 *
 * Two calling conventions:
 *   trimCorner("A1", "nw", 3, { round: true })            // explicit compass corner
 *   trimCorner("A1", [row, col], 3, { round: true })       // auto-detect nearest corner
 *
 * For the compass form on irregular rooms: resolves to the most-extreme
 * floor cell whose convex corner matches that compass direction (e.g. "nw"
 * picks the cell with the lowest row + lowest col that has its north and
 * west neighbors outside the room).
 *
 * For the cell-coord form: finds every convex corner of the room and picks
 * the one nearest to the provided cell.
 *
 * @param label     Room label, e.g. "A1"
 * @param cornerOrCell  Compass ("nw"/"ne"/"sw"/"se") OR [row, col] coordinate near a corner
 * @param size      Trim size (number of cells cut from the corner)
 * @param options   Standard createTrim options: { round, inverted, open }
 */
export function trimCorner(
  label: string,
  cornerOrCell: CompassCorner | [number, number] | { row: number; col: number },
  size: number,
  options: { round?: boolean; inverted?: boolean; open?: boolean } = {},
): { success: true; corner: CompassCorner; resolvedCell: { row: number; col: number }; size: number } {
  const api = getApi();
  const boundsResult = api.getRoomBounds(label);
  if (!boundsResult.success) {
    throw new Error(`Room "${label}" not found`);
  }
  const { r1, c1, r2, c2 } = boundsResult;

  // Collect the room's actual cell list (in display coords).
  const cellsResult = (
    api as unknown as {
      listRoomCells(l: string): { success: boolean; cells?: [number, number][]; error?: string };
    }
  ).listRoomCells(label);
  if (!cellsResult.success || !cellsResult.cells?.length) {
    throw new Error(`Room "${label}" has no cells`);
  }
  const roomCells = cellsResult.cells;
  const cellSet = new Set(roomCells.map(([r, c]) => `${r},${c}`));

  // Resolve the target corner cell and compass direction.
  let cornerDir: CompassCorner;
  let tipR: number;
  let tipC: number;

  if (typeof cornerOrCell === 'string') {
    // Compass form.
    if (!['nw', 'ne', 'sw', 'se'].includes(cornerOrCell)) {
      throw new Error(`Invalid corner: "${cornerOrCell}". Use "nw", "ne", "sw", or "se".`);
    }
    cornerDir = cornerOrCell;
    // Try the bbox corner cell first — it's a floor cell for rectangular rooms.
    const bboxTip =
      cornerDir === 'nw'
        ? { row: r1, col: c1 }
        : cornerDir === 'ne'
          ? { row: r1, col: c2 }
          : cornerDir === 'sw'
            ? { row: r2, col: c1 }
            : { row: r2, col: c2 };
    if (cellSet.has(`${bboxTip.row},${bboxTip.col}`)) {
      tipR = bboxTip.row;
      tipC = bboxTip.col;
    } else {
      // Irregular room — find the convex corner cell most extreme in this compass direction.
      const allCorners = findConvexCorners(roomCells).filter((c) => c.corner === cornerDir);
      if (!allCorners.length) {
        throw new Error(
          `Room "${label}" has no convex ${cornerDir} corner. Try the [row, col] form with a cell near the corner you want trimmed.`,
        );
      }
      allCorners.sort((a, b) => {
        const [ap1, ap2] = cornerPriority(cornerDir, a.row, a.col);
        const [bp1, bp2] = cornerPriority(cornerDir, b.row, b.col);
        return ap1 - bp1 || ap2 - bp2;
      });
      tipR = allCorners[0]!.row;
      tipC = allCorners[0]!.col;
    }
  } else {
    // Cell coord form — [row, col] or { row, col }.
    const refRow = Array.isArray(cornerOrCell) ? cornerOrCell[0] : cornerOrCell.row;
    const refCol = Array.isArray(cornerOrCell) ? cornerOrCell[1] : cornerOrCell.col;
    if (typeof refRow !== 'number' || typeof refCol !== 'number') {
      throw new Error(`trimCorner cell arg must be [row, col] or {row, col}; got ${JSON.stringify(cornerOrCell)}`);
    }
    const allCorners = findConvexCorners(roomCells);
    if (!allCorners.length) {
      throw new Error(`Room "${label}" has no convex corners — is it a single cell with walls on all sides?`);
    }
    // Pick the convex corner nearest to the reference cell (Euclidean).
    allCorners.sort((a, b) => {
      const da = (a.row - refRow) ** 2 + (a.col - refCol) ** 2;
      const db = (b.row - refRow) ** 2 + (b.col - refCol) ** 2;
      return da - db;
    });
    cornerDir = allCorners[0]!.corner;
    tipR = allCorners[0]!.row;
    tipC = allCorners[0]!.col;
  }

  // Compute extent cell: `size` cells inward from the tip along both axes.
  // `size` matches the roundRoomCorners convention (1 = minimal, 2 = modest, 3 = significant).
  const s = Math.max(1, Math.floor(size)) - 1;
  const extR = cornerDir === 'nw' || cornerDir === 'ne' ? tipR + s : tipR - s;
  const extC = cornerDir === 'nw' || cornerDir === 'sw' ? tipC + s : tipC - s;

  api.createTrim(tipR, tipC, extR, extC, cornerDir, {
    round: !!options.round,
    inverted: !!options.inverted,
    open: !!options.open,
  });

  return {
    success: true,
    corner: cornerDir,
    resolvedCell: { row: tipR, col: tipC },
    size: Math.max(1, Math.floor(size)),
  };
}
