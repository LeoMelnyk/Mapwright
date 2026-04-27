// Legacy → segments storage migration. See plan
// `i-want-to-a-sleepy-breeze.md` §"Migration table (Phase 3, two-pass)".
//
// This module is intentionally importable from BOTH the editor
// (`editor/js/migrations.ts`) and the CLI render pipeline
// (`render/compile.ts`), so it lives in `src/util/` with no editor or
// renderer dependencies.
//
// Two-pass algorithm:
//
//   Pass 1: walk every cell and compute its diagonal void-corner from
//   neighbor state (matches `getDiagonalTrimCorner`'s logic in
//   `render/floors.ts`). The map MUST be fully built before any cell is
//   mutated, otherwise Pass 2 may see a partly-mutated grid where neighbor
//   cells have already lost their `'nw-se'` / `'ne-sw'` flags.
//
//   Pass 2: walk every cell that has legacy data and no pre-existing
//   `cell.segments`. Build segments + interiorEdges per the migration table.
//   By default, delete the legacy texture/diagonal/trim/weather fields.
//
// Idempotent: cells that already carry `segments` are skipped. Truly empty
// cells (`{}` with no legacy data) are left untouched — `getSegments()`
// synthesizes the implicit full segment on demand.

import type { CardinalDirection, Cell, CellHalfKey, EdgeValue, InteriorEdge, Segment } from '../types.js';
import { diagonalSegments, trimSegments } from './cell-segments.js';

/**
 * Legacy cell shape. Pre-segments saves carry these fields directly on the
 * cell; post-migration cells have none of them. The migration is the only
 * code that reads these fields — the runtime `Cell` type intentionally
 * doesn't include them so accidental writes from the editor don't compile.
 */
export interface LegacyCell extends Cell {
  texture?: string;
  textureOpacity?: number;
  textureSecondary?: string;
  textureSecondaryOpacity?: number;
  'nw-se'?: EdgeValue;
  'ne-sw'?: EdgeValue;
  trimmed?: boolean;
  trimWall?: CardinalDirection | number[][];
  trimCorner?: 'nw' | 'ne' | 'sw' | 'se' | string;
  trimRound?: boolean;
  trimInverted?: boolean;
  trimOpen?: boolean;
  trimPassable?: boolean;
  trimClip?: number[][];
  trimCrossing?: boolean | Record<string, string>;
  trimHideExterior?: boolean;
  trimShowExteriorOnly?: boolean;
  trimInsideArc?: boolean;
  trimArcRadius?: number;
  trimArcCenterRow?: number;
  trimArcCenterCol?: number;
  trimArcInverted?: boolean;
  weatherGroupId?: string;
  weatherHalves?: Partial<Record<CellHalfKey, string>>;
}

export type LegacyCellGrid = (LegacyCell | null)[][];

export interface MigrateSegmentsOptions {
  /**
   * When true (default), deletes legacy texture/diagonal/trim/weather fields
   * after segments are written. Set false to leave both shapes coexisting —
   * useful when running the migration as a non-committal probe (e.g. early
   * P3 testing) before flipping the renderer.
   *
   * `getSegments()` always prefers explicit `cell.segments` over legacy
   * fields, so the migrated state is correct regardless of this flag.
   */
  removeLegacyFields?: boolean;
}

export interface MigrateSegmentsResult {
  /** Number of cells that were migrated (had legacy data, were not already segmented). */
  cellsMigrated: number;
  /** Number of cells skipped because they already had `segments`. */
  cellsAlreadySegmented: number;
  /** Number of diagonal cells whose void corner was inferred from neighbor state. */
  voidCornersDetected: number;
}

/**
 * Migrate every cell of `cells` from the legacy texture/diagonal/trim shape
 * to authoritative `segments` + `interiorEdges`. Mutates the grid in place.
 */
export function migrateCellsToSegments(
  cells: LegacyCellGrid,
  options: MigrateSegmentsOptions = {},
): MigrateSegmentsResult {
  const removeLegacy = options.removeLegacyFields !== false;
  // Inside this function we treat cells as LegacyCellGrid so the migration
  // can read pre-segments fields. Old saves still carry those fields; new
  // saves don't, and the legacy reads naturally produce no work for them.
  const legacyCells = cells;

  // Pass 1: build the void-corner map.
  const voidCornerMap = new Map<string, VoidCorner>();
  for (let r = 0; r < legacyCells.length; r++) {
    const row = legacyCells[r]!;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      if (cell.segments && cell.segments.length > 0) continue;
      const corner = computeVoidCornerForDiagonal(cell, legacyCells, r, c);
      if (corner) voidCornerMap.set(`${r},${c}`, corner);
    }
  }

  // Pass 2: mutate.
  const result: MigrateSegmentsResult = {
    cellsMigrated: 0,
    cellsAlreadySegmented: 0,
    voidCornersDetected: voidCornerMap.size,
  };

  for (let r = 0; r < legacyCells.length; r++) {
    const row = legacyCells[r]!;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      if (cell.segments && cell.segments.length > 0) {
        result.cellsAlreadySegmented++;
        continue;
      }
      const voidCorner = voidCornerMap.get(`${r},${c}`) ?? null;
      const built = buildSegmentsForCell(cell, voidCorner);
      if (!built) continue; // truly empty cell — leave it alone

      cell.segments = built.segments;
      if (built.interiorEdges.length > 0) {
        cell.interiorEdges = built.interiorEdges;
      }
      if (removeLegacy) deleteLegacyFields(cell);
      result.cellsMigrated++;
    }
  }

  return result;
}

// ── Internals ──────────────────────────────────────────────────────────────

type VoidCorner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Determine the diagonal cell's void corner from neighbor state. Mirrors
 * `getDiagonalTrimCorner` in `render/floors.ts` exactly so migration's
 * void-marking matches what the legacy renderer drew.
 *
 * Returns null when the cell isn't a diagonal cell, or when its diagonal
 * doesn't produce a void corner under the current neighbor configuration.
 */
function computeVoidCornerForDiagonal(
  cell: LegacyCell,
  cells: LegacyCellGrid,
  row: number,
  col: number,
): VoidCorner | null {
  if (cell.trimClip) return null; // arc cells use polygon clipping, not corner-cut
  if (cell.trimCorner) {
    const c = cell.trimCorner;
    if (c === 'nw' || c === 'ne' || c === 'sw' || c === 'se') return c;
    return null;
  }
  const hasDiag = cell['ne-sw'] ?? cell['nw-se'];
  if (!hasDiag) return null;

  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const isVoid = (r: number, c: number): boolean => r < 0 || r >= numRows || c < 0 || c >= numCols || !cells[r]![c];

  if (cell['ne-sw']) {
    if (isVoid(row - 1, col) && isVoid(row, col - 1)) return 'nw';
    if (isVoid(row + 1, col) && isVoid(row, col + 1)) return 'se';
  }
  if (cell['nw-se']) {
    if (isVoid(row - 1, col) && isVoid(row, col + 1)) return 'ne';
    if (isVoid(row + 1, col) && isVoid(row, col - 1)) return 'sw';
  }
  return null;
}

interface BuildResult {
  segments: Segment[];
  interiorEdges: InteriorEdge[];
}

function buildSegmentsForCell(cell: LegacyCell, voidCorner: VoidCorner | null): BuildResult | null {
  // Trim-arc cell.
  if (cell.trimClip && cell.trimClip.length >= 3) {
    return buildTrimSegments(cell);
  }

  // Diagonal-split cell.
  if (cell['nw-se']) return buildDiagonalSegments(cell, 'nw-se', voidCorner);
  if (cell['ne-sw']) return buildDiagonalSegments(cell, 'ne-sw', voidCorner);

  // Unsplit cell with legacy data. Corner textures (NE/NW/SE/SW) and other
  // legacy-only fields also count — we build a default unsplit segment so
  // `deleteLegacyFields` runs and the cell isn't left with stale corner data
  // that the new render pipeline can't see.
  if (hasAnyLegacyField(cell)) {
    const seg: Segment = {
      id: 's0',
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    };
    if (cell.texture !== undefined) seg.texture = cell.texture;
    if (cell.textureOpacity !== undefined) seg.textureOpacity = cell.textureOpacity;
    if (cell.weatherGroupId !== undefined) seg.weatherGroupId = cell.weatherGroupId;
    return { segments: [seg], interiorEdges: [] };
  }

  // Truly empty cell — no migration needed.
  return null;
}

function hasAnyLegacyField(cell: LegacyCell): boolean {
  for (const field of LEGACY_CELL_FIELDS) {
    if (cell[field] !== undefined) return true;
  }
  return false;
}

function buildDiagonalSegments(cell: LegacyCell, diag: 'nw-se' | 'ne-sw', voidCorner: VoidCorner | null): BuildResult {
  const wallType = (cell[diag] ?? 'w') as EdgeValue;
  const { segments: pair, interiorEdge } = diagonalSegments(diag);
  const segments: [Segment, Segment] = [
    { ...pair[0], polygon: pair[0].polygon.map((p) => [p[0]!, p[1]!]) },
    { ...pair[1], polygon: pair[1].polygon.map((p) => [p[0]!, p[1]!]) },
  ];

  // Override the default 'w' wall with the cell's actual edge value.
  const edge: InteriorEdge = {
    vertices: interiorEdge.vertices.map((v) => [v[0]!, v[1]!]),
    wall: wallType,
    between: [interiorEdge.between[0], interiorEdge.between[1]],
  };

  // Legacy texture mapping for diagonals (matches synthesis in
  // cell-segments.ts: applyLegacyDiagonalTextures).
  //   diagonalSegments() returns [s0=SW or SE (secondary), s1=NE or NW (primary)].
  //   Both textures set: s0 ← textureSecondary, s1 ← texture.
  //   Only texture set: both segments fall back to texture (full-rect render).
  const primary = cell.texture;
  const primaryOp = cell.textureOpacity;
  const secondary = cell.textureSecondary;
  const secondaryOp = cell.textureSecondaryOpacity;
  if (primary !== undefined) {
    segments[1].texture = primary;
    if (primaryOp !== undefined) segments[1].textureOpacity = primaryOp;
  }
  if (secondary !== undefined) {
    segments[0].texture = secondary;
    if (secondaryOp !== undefined) segments[0].textureOpacity = secondaryOp;
  } else if (primary !== undefined) {
    segments[0].texture = primary;
    if (primaryOp !== undefined) segments[0].textureOpacity = primaryOp;
  }

  // weatherHalves → per-segment weatherGroupId (canonical key per diagonal).
  if (cell.weatherHalves) {
    const halfKeys = diag === 'nw-se' ? (['sw', 'ne'] as const) : (['se', 'nw'] as const);
    for (let i = 0; i < segments.length; i++) {
      const k = halfKeys[i]!;
      const gid = cell.weatherHalves[k];
      if (gid) segments[i]!.weatherGroupId = gid;
    }
  }

  // Apply void corner: mark the corresponding segment voided, drop its texture.
  if (voidCorner) {
    const voidIndex = voidedSegmentIndex(diag, voidCorner);
    if (voidIndex >= 0) {
      segments[voidIndex]!.voided = true;
      delete segments[voidIndex]!.texture;
      delete segments[voidIndex]!.textureOpacity;
    }
  }

  return { segments, interiorEdges: [edge] };
}

function voidedSegmentIndex(diag: 'nw-se' | 'ne-sw', voidCorner: VoidCorner): number {
  // diagonalSegments() return order:
  //   nw-se → [SW (s0), NE (s1)]
  //   ne-sw → [SE (s0), NW (s1)]
  if (diag === 'nw-se') {
    if (voidCorner === 'sw') return 0;
    if (voidCorner === 'ne') return 1;
  } else {
    if (voidCorner === 'se') return 0;
    if (voidCorner === 'nw') return 1;
  }
  return -1;
}

function buildTrimSegments(cell: LegacyCell): BuildResult {
  const trimClip = cell.trimClip!;
  // The chord wall is always 'w' for migration. Legacy BFS treats the chord
  // as a wall unconditionally via `trimCrossing`; `trimOpen` / `trimPassable`
  // are render flags, not connectivity flags. (Recorded in P1.5 — see plan
  // §"geometric model is source of truth".)
  const { segments: pair, interiorEdge: edge } = trimSegments(trimClip, false);
  const segments: [Segment, Segment] = [
    { ...pair[0], polygon: pair[0].polygon.map((p) => [p[0]!, p[1]!]) },
    { ...pair[1], polygon: pair[1].polygon.map((p) => [p[0]!, p[1]!]) },
  ];
  const interiorEdge: InteriorEdge = {
    vertices: edge.vertices.map((v) => [v[0]!, v[1]!]),
    wall: edge.wall,
    between: [edge.between[0], edge.between[1]],
  };

  // Note: legacy `trimRound`/`trimArcCenterRow`/`trimArcCenterCol`/
  // `trimArcRadius`/`trimArcInverted` are intentionally dropped. The chord
  // polyline (`vertices`) fully describes the curve; `isChordEdge` /
  // `getChordCorner` derive everything downstream consumers need.

  if (cell.texture !== undefined) {
    segments[0].texture = cell.texture;
    if (cell.textureOpacity !== undefined) segments[0].textureOpacity = cell.textureOpacity;
  }
  if (cell.trimHideExterior) {
    segments[1].voided = true;
  } else if (cell.textureSecondary !== undefined) {
    segments[1].texture = cell.textureSecondary;
    if (cell.textureSecondaryOpacity !== undefined) {
      segments[1].textureOpacity = cell.textureSecondaryOpacity;
    }
  }
  // `trimShowExteriorOnly` mirrors `trimHideExterior` for the opposite side:
  // void the interior so only the exterior segment renders.
  if (cell.trimShowExteriorOnly) {
    segments[0].voided = true;
    delete segments[0].texture;
    delete segments[0].textureOpacity;
  }

  if (cell.weatherHalves) {
    if (cell.weatherHalves.interior) segments[0].weatherGroupId = cell.weatherHalves.interior;
    if (cell.weatherHalves.exterior) segments[1].weatherGroupId = cell.weatherHalves.exterior;
  }

  return { segments, interiorEdges: [interiorEdge] };
}

/**
 * Every legacy (pre-segments) cell field that the migration knows how to
 * either convert (`texture`, `'nw-se'`, `trimClip`, …) or strip after the
 * conversion. Exported for `render/validate.ts` so its known-key set can
 * accept legacy input without naming the fields itself — keeping all
 * legacy field literals confined to this module.
 */
export const LEGACY_CELL_FIELDS = [
  'texture',
  'textureOpacity',
  'textureSecondary',
  'textureSecondaryOpacity',
  'textureNE',
  'textureNEOpacity',
  'textureNW',
  'textureNWOpacity',
  'textureSE',
  'textureSEOpacity',
  'textureSW',
  'textureSWOpacity',
  'nw-se',
  'ne-sw',
  'trimClip',
  'trimWall',
  'trimCorner',
  'trimRound',
  'trimInverted',
  'trimOpen',
  'trimPassable',
  'trimCrossing',
  'trimHideExterior',
  'trimShowExteriorOnly',
  'trimInsideArc',
  'trimArcRadius',
  'trimArcCenterRow',
  'trimArcCenterCol',
  'trimArcInverted',
  'trimmed',
  'weatherGroupId',
  'weatherHalves',
] as const;

function deleteLegacyFields(cell: LegacyCell): void {
  for (const field of LEGACY_CELL_FIELDS) {
    delete cell[field];
  }
}
