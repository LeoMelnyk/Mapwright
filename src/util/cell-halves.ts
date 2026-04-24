// Half-cell geometry and weather-assignment helpers.
//
// A cell may be split into two independently-addressable halves by either a
// diagonal wall (nw-se / ne-sw) or an arc trim (trimClip). Weather (and
// potentially future per-half features) needs to address each half
// separately. This module is the single source of truth for:
//   - enumerating a cell's halves
//   - hit-testing a point to a half
//   - tracing a half's clip polygon onto a 2D canvas context
//   - reading / writing the per-half weatherGroupId with the correct invariant
//
// Coordinate conventions:
//   - hitTestHalf uses cell-local [0..1] coords: (lx=col-axis, ly=row-axis).
//   - trimClip vertices are stored as [x, y] = [col-axis, row-axis], both in
//     [0..1]. The ray-casting PIP algorithm is orientation-symmetric, so we
//     can pass trimClip directly and feed (lx, ly) into pointInPolygon's
//     (py, px) params — the math is consistent as long as we use the same
//     convention for both point and polygon vertices.

import type { Cell, CellHalfKey } from '../types.js';
import { pointInPolygon } from './polygon.js';

/** Returns the ordered list of half-keys that exist for this cell. */
export function getCellHalves(cell: Cell | null | undefined): CellHalfKey[] {
  if (!cell) return [];
  if (cell['nw-se']) return ['ne', 'sw'];
  if (cell['ne-sw']) return ['nw', 'se'];
  if (cell.trimClip && cell.trimClip.length >= 3) return ['interior', 'exterior'];
  return ['full'];
}

/**
 * Returns true if the cell is split (has more than one addressable half).
 * Equivalent to `getCellHalves(cell).length > 1` without the array alloc.
 */
export function isCellSplit(cell: Cell | null | undefined): boolean {
  if (!cell) return false;
  if (cell['nw-se'] || cell['ne-sw']) return true;
  if (cell.trimClip && cell.trimClip.length >= 3) return true;
  return false;
}

/**
 * Classify a point in cell-local coords (lx, ly ∈ [0..1]) to the half it
 * falls in. For unsplit cells always returns 'full'.
 */
export function hitTestHalf(cell: Cell | null | undefined, lx: number, ly: number): CellHalfKey {
  if (!cell) return 'full';
  if (cell['nw-se']) {
    // nw-se line goes from (0,0) to (1,1) → y = x.
    // NE half: above/right of line (lx > ly). SW half: below/left (lx <= ly).
    return lx > ly ? 'ne' : 'sw';
  }
  if (cell['ne-sw']) {
    // ne-sw line goes from (1,0) to (0,1) → y = 1 - x, i.e. x + y = 1.
    // NW half: upper-left (lx + ly < 1). SE half: lower-right.
    return lx + ly < 1 ? 'nw' : 'se';
  }
  if (cell.trimClip && cell.trimClip.length >= 3) {
    // Orientation-symmetric PIP: pass (lx, ly) against polygon stored as [x, y].
    return pointInPolygon(lx, ly, cell.trimClip) ? 'interior' : 'exterior';
  }
  return 'full';
}

/**
 * Appends the clip path for a single half onto `ctx`'s current path and
 * returns the fill rule that should be used by the caller's `fill()` / `clip()`.
 *
 * The caller is responsible for `ctx.beginPath()` before and
 * `ctx.clip(rule)` / `ctx.fill(rule)` after. When unioning multiple halves,
 * the caller should pick `'evenodd'` if any contributing half returned it.
 */
export function halfClip(
  ctx: CanvasRenderingContext2D,
  cell: Cell,
  halfKey: CellHalfKey,
  px: number,
  py: number,
  cellPx: number,
): 'nonzero' | 'evenodd' {
  if (halfKey === 'full') {
    // Unsplit cell. If it happens to have a trimClip (legacy — shouldn't
    // normally co-occur since getCellHalves would have split it), fall back
    // to the trimClip polygon to preserve old rendering behavior.
    if (cell.trimClip && cell.trimClip.length >= 3) {
      tracePolygon(ctx, cell.trimClip, px, py, cellPx);
      return 'nonzero';
    }
    ctx.rect(px, py, cellPx, cellPx);
    return 'nonzero';
  }
  if (halfKey === 'interior') {
    if (cell.trimClip && cell.trimClip.length >= 3) {
      tracePolygon(ctx, cell.trimClip, px, py, cellPx);
    }
    return 'nonzero';
  }
  if (halfKey === 'exterior') {
    // Rect + trimClip as a hole (via evenodd rule at fill/clip time).
    ctx.rect(px, py, cellPx, cellPx);
    if (cell.trimClip && cell.trimClip.length >= 3) {
      tracePolygon(ctx, cell.trimClip, px, py, cellPx);
    }
    return 'evenodd';
  }
  // Diagonal halves: the half-key ('ne'/'sw'/'nw'/'se') directly names the
  // corner contained by the solid triangle — traceCornerTriangle draws the
  // right triangle whose three vertices include that corner.
  traceCornerTriangle(ctx, halfKey, px, py, cellPx);
  return 'nonzero';
}

/**
 * Traces a right-triangle path whose three vertices include the named
 * corner (plus the two adjacent cell corners along the diagonal). Passing
 * `'ne'` draws the NE triangle (top-left, top-right, bottom-right) — the
 * half of a nw-se-split cell that contains the NE corner.
 *
 * Same geometry as `_traceDiagVoidTriangle` in
 * `player/player-canvas-fog.ts` — duplicated here (20 lines of pure math)
 * to keep `src/util/` free of any `src/player/` dependency. The "void"
 * naming there reflects fog's use (paint the unrevealed side); here we
 * use it to paint the solid half of a weather-split cell. Geometry is
 * identical.
 */
export function traceCornerTriangle(
  ctx: CanvasRenderingContext2D,
  cornerKey: string,
  px: number,
  py: number,
  size: number,
): void {
  const tl_x = px,
    tl_y = py;
  const tr_x = px + size,
    tr_y = py;
  const bl_x = px,
    bl_y = py + size;
  const br_x = px + size,
    br_y = py + size;
  switch (cornerKey) {
    case 'nw':
      ctx.moveTo(tl_x, tl_y);
      ctx.lineTo(tr_x, tr_y);
      ctx.lineTo(bl_x, bl_y);
      break;
    case 'ne':
      ctx.moveTo(tl_x, tl_y);
      ctx.lineTo(tr_x, tr_y);
      ctx.lineTo(br_x, br_y);
      break;
    case 'sw':
      ctx.moveTo(tl_x, tl_y);
      ctx.lineTo(bl_x, bl_y);
      ctx.lineTo(br_x, br_y);
      break;
    case 'se':
      ctx.moveTo(tr_x, tr_y);
      ctx.lineTo(bl_x, bl_y);
      ctx.lineTo(br_x, br_y);
      break;
    default:
      return;
  }
  ctx.closePath();
}

function tracePolygon(ctx: CanvasRenderingContext2D, poly: number[][], px: number, py: number, cellPx: number): void {
  ctx.moveTo(px + poly[0]![0]! * cellPx, py + poly[0]![1]! * cellPx);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(px + poly[i]![0]! * cellPx, py + poly[i]![1]! * cellPx);
  }
  ctx.closePath();
}

// ── Weather assignment read/write ──────────────────────────────────────────

/**
 * Reads the weather group assigned to a specific half of a cell. Handles
 * legacy cells that have `weatherGroupId` set on a split cell (pre-refactor
 * maps): trim cells fall back to `weatherGroupId` as the interior-half
 * assignment (matching how the old renderer clipped to `trimClip`), and
 * diagonal-split cells fall back to `weatherGroupId` for both halves.
 */
export function getCellWeatherHalf(cell: Cell | null | undefined, halfKey: CellHalfKey): string | undefined {
  if (!cell) return undefined;
  if (halfKey === 'full') return cell.weatherGroupId;
  const halves = cell.weatherHalves;
  if (halves?.[halfKey]) return halves[halfKey];
  // Legacy fallback: split cell with only weatherGroupId set.
  if (cell.weatherGroupId) {
    if (cell.trimClip && cell.trimClip.length >= 3) {
      // Old trim cells had weather clipped to interior only.
      return halfKey === 'interior' ? cell.weatherGroupId : undefined;
    }
    if (cell['nw-se'] || cell['ne-sw']) {
      // Diagonal cells had no half distinction before — both halves inherit.
      return cell.weatherGroupId;
    }
  }
  return undefined;
}

/**
 * Writes the weather group for a specific half. Pass `null` to clear.
 *
 * Storage rules:
 *   - Unsplit cell: always stores into `weatherGroupId`, ignoring `halfKey`.
 *   - Split cell: stores into `weatherHalves[halfKey]`. Any legacy
 *     `weatherGroupId` on the cell is migrated onto the halves on first
 *     touch. `weatherHalves` stays populated even when both halves share
 *     the same group — the two slots are independently addressable so
 *     "same group on both halves" remains a persistent, queryable state
 *     instead of collapsing back to the ambiguous single-scalar form.
 */
export function setCellWeatherHalf(cell: Cell, halfKey: CellHalfKey, groupId: string | null): void {
  const halves = getCellHalves(cell);
  const isSplit = halves[0] !== 'full';

  if (!isSplit) {
    // Unsplit cell: always the single weatherGroupId.
    if (groupId) cell.weatherGroupId = groupId;
    else delete cell.weatherGroupId;
    delete cell.weatherHalves;
    return;
  }

  // Split cell. Clamp halfKey to a valid one; drop writes to 'full'.
  if (halfKey === 'full' || !halves.includes(halfKey)) return;

  // Migrate legacy weatherGroupId onto halves before writing.
  if (cell.weatherGroupId !== undefined && !cell.weatherHalves) {
    const legacy = cell.weatherGroupId;
    delete cell.weatherGroupId;
    if (cell.trimClip && cell.trimClip.length >= 3) {
      // Old trim assignment only covered the interior.
      cell.weatherHalves = { interior: legacy };
    } else {
      cell.weatherHalves = Object.fromEntries(halves.map((h) => [h, legacy])) as Partial<Record<CellHalfKey, string>>;
    }
  } else if (cell.weatherGroupId !== undefined) {
    // Invariant violation (both set): drop the legacy scalar.
    delete cell.weatherGroupId;
  }

  cell.weatherHalves ??= {};
  if (groupId) cell.weatherHalves[halfKey] = groupId;
  else delete cell.weatherHalves[halfKey];

  // Drop the map entirely when no halves remain. Do NOT collapse equal
  // halves back to weatherGroupId — on a split cell, the scalar form is
  // ambiguous with legacy data and the read helpers treat it as
  // interior-only for trim cells. Keeping halves always preserves the
  // user's "both halves same group" as a first-class state.
  if (Object.keys(cell.weatherHalves).length === 0) {
    delete cell.weatherHalves;
  }
}

/**
 * Iterate over every weather assignment on a cell, yielding each half-key and
 * its group id. Handles the three cases uniformly:
 *   - Unsplit cell with weatherGroupId → yields ('full', gid).
 *   - Split cell with weatherHalves    → yields each ('hk', gid) entry.
 *   - Split cell with legacy weatherGroupId (no weatherHalves) → expands per
 *     the same fallback rules as {@link getCellWeatherHalf}.
 */
export function forEachCellWeatherAssignment(
  cell: Cell | null | undefined,
  fn: (halfKey: CellHalfKey, groupId: string) => void,
): void {
  if (!cell) return;
  const halves = getCellHalves(cell);
  if (halves[0] === 'full') {
    if (cell.weatherGroupId) fn('full', cell.weatherGroupId);
    return;
  }
  if (cell.weatherHalves) {
    for (const k of Object.keys(cell.weatherHalves) as CellHalfKey[]) {
      const gid = cell.weatherHalves[k];
      if (gid) fn(k, gid);
    }
    return;
  }
  if (cell.weatherGroupId) {
    const legacy = cell.weatherGroupId;
    if (cell.trimClip && cell.trimClip.length >= 3) {
      fn('interior', legacy);
    } else {
      for (const h of halves) fn(h, legacy);
    }
  }
}

/**
 * True if the cell has any weather assignment matching `groupId`, across
 * unsplit, split, or legacy forms. Used by lightning strike eligibility and
 * similar "is this cell in the group at all" checks.
 */
export function cellHasGroup(cell: Cell | null | undefined, groupId: string): boolean {
  if (!cell) return false;
  if (cell.weatherGroupId === groupId) return true;
  if (cell.weatherHalves) {
    for (const k of Object.keys(cell.weatherHalves) as CellHalfKey[]) {
      if (cell.weatherHalves[k] === groupId) return true;
    }
  }
  return false;
}
