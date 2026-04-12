// transforms.ts — Bulk geometric / replacement operations.
//
// cloneRoom: copy a labeled room's contents to a new offset (with optional new label).
// mirrorRegion: flip a rectangle along an axis.
// rotateRegion: rotate a square rectangle 90/180/270.
// replaceProp / replaceTexture: bulk swap by id.
//
// All transforms are single mutate() steps so they're undone atomically.

import type { Cell, EdgeValue } from '../../../types.js';
import { state, mutate, getApi, ApiValidationError, toInt, toDisp, parseCellKey, CARDINAL_DIRS } from './_shared.js';
import { normalizeRect } from './_rect-utils.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function inBounds(r: number, c: number): boolean {
  const cells = state.dungeon.cells;
  return r >= 0 && r < cells.length && c >= 0 && c < (cells[0]?.length ?? 0);
}

// ─── cloneRoom ────────────────────────────────────────────────────────────

/**
 * Copy a labeled room's cells (walls, fills, props, textures, label) to a
 * new offset. Overlay props (`metadata.props[]`) within the room's bounding
 * box are also copied. Lights inside the bbox are copied to the new offset.
 *
 * Source remains untouched. Use `newLabel` to rename the copy (otherwise
 * the same label is reused, which usually creates a labeled-room conflict —
 * caller's choice).
 *
 * Fails if any destination cell would land outside the grid or overlap an
 * existing non-void cell.
 */
export function cloneRoom(
  label: string,
  dr: number,
  dc: number,
  options: { newLabel?: string } = {},
): {
  success: true;
  copied: { cells: number; overlayProps: number; lights: number };
  bounds: { r1: number; c1: number; r2: number; c2: number };
} {
  dr = toInt(dr);
  dc = toInt(dc);
  const api = getApi() as unknown as { _collectRoomCells(l: string): Set<string> | null };
  const sourceSet = api._collectRoomCells(label);
  if (!sourceSet?.size) {
    throw new ApiValidationError('ROOM_NOT_FOUND', `Room "${label}" not found`, { label });
  }

  const cells = state.dungeon.cells;
  // Validate destination cells: in bounds and not occupied
  let minR = Infinity,
    maxR = -Infinity,
    minC = Infinity,
    maxC = -Infinity;
  for (const key of sourceSet) {
    const [r, c] = parseCellKey(key);
    const nr = r + dr,
      nc = c + dc;
    if (!inBounds(nr, nc)) {
      throw new ApiValidationError('CLONE_OUT_OF_BOUNDS', `Clone destination (${nr}, ${nc}) is outside the grid`, {
        row: nr,
        col: nc,
        dr,
        dc,
      });
    }
    if (cells[nr][nc]) {
      throw new ApiValidationError('CLONE_OVERLAP', `Clone destination (${nr}, ${nc}) is already non-void`, {
        row: nr,
        col: nc,
      });
    }
    if (nr < minR) minR = nr;
    if (nr > maxR) maxR = nr;
    if (nc < minC) minC = nc;
    if (nc > maxC) maxC = nc;
  }

  // Source bounding box (for overlay-prop / light filter)
  let srMinR = Infinity,
    srMaxR = -Infinity,
    srMinC = Infinity,
    srMaxC = -Infinity;
  for (const key of sourceSet) {
    const [r, c] = parseCellKey(key);
    if (r < srMinR) srMinR = r;
    if (r > srMaxR) srMaxR = r;
    if (c < srMinC) srMinC = c;
    if (c > srMaxC) srMaxC = c;
  }

  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;
  const newLabel = options.newLabel;

  // Coords for invalidation (destination cells)
  const coords: Array<{ row: number; col: number }> = [];
  for (const key of sourceSet) {
    const [r, c] = parseCellKey(key);
    coords.push({ row: r + dr, col: c + dc });
  }

  let cellsCopied = 0,
    overlayPropsCopied = 0,
    lightsCopied = 0;

  mutate(
    'cloneRoom',
    coords,
    () => {
      // 1. Copy each cell
      for (const key of sourceSet) {
        const [r, c] = parseCellKey(key);
        const src = cells[r][c];
        if (!src) continue;
        const dest = deepClone(src);
        if (newLabel != null && dest.center?.label != null) {
          dest.center.label = newLabel;
        }
        cells[r + dr][c + dc] = dest;
        cellsCopied++;
      }

      // 2. Copy overlay props inside source bbox
      if (meta.props) {
        meta.nextPropId ??= 1;
        const newProps = [];
        for (const op of meta.props) {
          const propRow = Math.round(op.y / gs);
          const propCol = Math.round(op.x / gs);
          if (propRow < srMinR || propRow > srMaxR || propCol < srMinC || propCol > srMaxC) continue;
          const copy = deepClone(op);
          copy.id = `prop_${meta.nextPropId++}`;
          copy.x = (propCol + dc) * gs;
          copy.y = (propRow + dr) * gs;
          newProps.push(copy);
          overlayPropsCopied++;
        }
        meta.props.push(...newProps);
      }

      // 3. Copy lights inside source bbox
      if (!meta.nextLightId) meta.nextLightId = 1;
      const newLights = [];
      for (const light of meta.lights) {
        const lr = Math.floor(light.y / gs);
        const lc = Math.floor(light.x / gs);
        if (lr < srMinR || lr > srMaxR || lc < srMinC || lc > srMaxC) continue;
        const copy = deepClone(light);
        copy.id = meta.nextLightId++;
        copy.x = light.x + dc * gs;
        copy.y = light.y + dr * gs;
        newLights.push(copy);
        lightsCopied++;
      }
      meta.lights.push(...newLights);
    },
    { invalidate: ['lighting', 'props'] },
  );

  return {
    success: true,
    copied: { cells: cellsCopied, overlayProps: overlayPropsCopied, lights: lightsCopied },
    bounds: { r1: toDisp(minR), c1: toDisp(minC), r2: toDisp(maxR), c2: toDisp(maxC) },
  };
}

// ─── replaceProp / replaceTexture ──────────────────────────────────────────

/**
 * Bulk swap one prop type for another across the map (or within a region).
 * Also rewrites cell-level `cell.prop.type` and overlay `metadata.props[].type`.
 */
export function replaceProp(
  oldType: string,
  newType: string,
  options: { region?: { r1: number; c1: number; r2: number; c2: number } } = {},
): { success: true; replaced: number } {
  const catalog = state.propCatalog;
  if (!catalog?.props[newType]) {
    throw new ApiValidationError('UNKNOWN_PROP', `Unknown new prop type: ${newType}`, {
      propType: newType,
      available: Object.keys(catalog?.props ?? {}),
    });
  }
  const cells = state.dungeon.cells;
  const region = options.region;
  const r1 = region ? toInt(region.r1) : 0;
  const c1 = region ? toInt(region.c1) : 0;
  const r2 = region ? toInt(region.r2) : cells.length - 1;
  const c2 = region ? toInt(region.c2) : (cells[0]?.length ?? 0) - 1;

  const meta = state.dungeon.metadata;
  const gs = meta.gridSize || 5;

  let replaced = 0;
  const coords: Array<{ row: number; col: number }> = [];

  mutate(
    'replaceProp',
    coords,
    () => {
      // Cell-level props
      for (let r = Math.max(0, r1); r <= Math.min(cells.length - 1, r2); r++) {
        for (let c = Math.max(0, c1); c <= Math.min((cells[0]?.length ?? 0) - 1, c2); c++) {
          const cell = cells[r]?.[c];
          if (cell?.prop?.type === oldType) {
            cell.prop.type = newType;
            replaced++;
            coords.push({ row: r, col: c });
          }
        }
      }
      // Overlay props
      if (meta.props) {
        for (const op of meta.props) {
          if (op.type !== oldType) continue;
          const pr = Math.round(op.y / gs);
          const pc = Math.round(op.x / gs);
          if (pr < r1 || pr > r2 || pc < c1 || pc > c2) continue;
          op.type = newType;
          replaced++;
        }
      }
    },
    { invalidate: ['props'] },
  );

  return { success: true, replaced };
}

/** Bulk swap one texture id for another across the map (or within a region). */
export function replaceTexture(
  oldId: string,
  newId: string,
  options: { region?: { r1: number; c1: number; r2: number; c2: number } } = {},
): { success: true; replaced: number } {
  const cells = state.dungeon.cells;
  const region = options.region;
  const r1 = region ? toInt(region.r1) : 0;
  const c1 = region ? toInt(region.c1) : 0;
  const r2 = region ? toInt(region.r2) : cells.length - 1;
  const c2 = region ? toInt(region.c2) : (cells[0]?.length ?? 0) - 1;

  let replaced = 0;
  const coords: Array<{ row: number; col: number }> = [];

  mutate('replaceTexture', coords, () => {
    for (let r = Math.max(0, r1); r <= Math.min(cells.length - 1, r2); r++) {
      for (let c = Math.max(0, c1); c <= Math.min((cells[0]?.length ?? 0) - 1, c2); c++) {
        const cell = cells[r]?.[c];
        if (!cell) continue;
        if (cell.texture === oldId) {
          cell.texture = newId;
          replaced++;
          coords.push({ row: r, col: c });
        }
        // Also handle corner textures
        for (const k of ['textureNE', 'textureSW', 'textureNW', 'textureSE'] as const) {
          if (cell[k] === oldId) {
            cell[k] = newId;
            replaced++;
          }
        }
      }
    }
  });

  return { success: true, replaced };
}

// ─── mirrorRegion / rotateRegion ──────────────────────────────────────────
//
// Geometric transforms. WARNING: these only handle the cell grid and walls
// correctly. Multi-cell props, overlay props, lights, stairs, and bridges
// inside the region are NOT transformed (their geometry is ambiguous under
// reflection/rotation). Use cloneRoom for furnished rooms instead.

const MIRROR_H_EDGE: Record<string, string> = { east: 'west', west: 'east', north: 'north', south: 'south' };
const MIRROR_V_EDGE: Record<string, string> = { north: 'south', south: 'north', east: 'east', west: 'west' };

function rebuildCellEdges(cell: Cell, mapping: Record<string, string>): Cell {
  const out: Cell = deepClone(cell);
  const rec = out as Record<string, unknown>;
  // Save edges, clear, then reassign under new keys.
  const original: Record<string, EdgeValue> = {};
  for (const dir of CARDINAL_DIRS) {
    const v = (cell as Record<string, unknown>)[dir];
    if (v != null) original[dir] = v as EdgeValue;
    delete rec[dir];
  }
  for (const [from, to] of Object.entries(mapping)) {
    if (original[from] != null) rec[to] = original[from];
  }
  return out;
}

/**
 * Mirror a rectangular region across an axis. `axis: "horizontal"` flips
 * left/right (east<->west); `axis: "vertical"` flips top/bottom (north<->south).
 *
 * Operates on cell grid + walls only. Multi-cell props, overlay props,
 * lights, stairs, and bridges inside the region are left in place — caller
 * should clear them first or use `cloneRoom` instead.
 */
export function mirrorRegion(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  axis: string,
): { success: true; mirrored: number } {
  const { minR, maxR, minC, maxC } = normalizeRect(r1, c1, r2, c2);
  if (axis !== 'horizontal' && axis !== 'vertical') {
    throw new ApiValidationError('INVALID_AXIS', 'axis must be "horizontal" or "vertical"', {
      axis,
      valid: ['horizontal', 'vertical'],
    });
  }
  const cells = state.dungeon.cells;
  const mapping = axis === 'horizontal' ? MIRROR_H_EDGE : MIRROR_V_EDGE;
  const coords: Array<{ row: number; col: number }> = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });

  let mirrored = 0;
  mutate(
    'mirrorRegion',
    coords,
    () => {
      // Snapshot source cells (deep-cloned with rewritten edges)
      const snapshot: Array<{ r: number; c: number; cell: Cell | null }> = [];
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          const src = cells[r][c];
          snapshot.push({
            r,
            c,
            cell: src ? rebuildCellEdges(src, mapping) : null,
          });
        }
      }
      // Write into mirrored positions
      for (const { r, c, cell } of snapshot) {
        const newR = axis === 'vertical' ? maxR - (r - minR) : r;
        const newC = axis === 'horizontal' ? maxC - (c - minC) : c;
        cells[newR][newC] = cell;
        if (cell) mirrored++;
      }
    },
    { forceGeometry: true, invalidate: ['lighting'] },
  );

  return { success: true, mirrored };
}

/**
 * Rotate a SQUARE rectangular region by 90, 180, or 270 degrees clockwise.
 * Throws if the region is not square. Same caveats as mirrorRegion: props,
 * lights, stairs, bridges are not transformed.
 */
export function rotateRegion(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  degrees: number,
): { success: true; rotated: number; degrees: number } {
  const { minR, maxR, minC, maxC } = normalizeRect(r1, c1, r2, c2);
  const size = maxR - minR + 1;
  if (size !== maxC - minC + 1) {
    throw new ApiValidationError('NOT_SQUARE', 'rotateRegion requires a square region', {
      rows: size,
      cols: maxC - minC + 1,
    });
  }
  if (![90, 180, 270].includes(degrees)) {
    throw new ApiValidationError('INVALID_ROTATION', 'degrees must be 90, 180, or 270', {
      degrees,
      valid: [90, 180, 270],
    });
  }

  // Edge mapping per rotation step (90° clockwise rotates: north -> east, east -> south, south -> west, west -> north)
  const ROT90: Record<string, string> = { north: 'east', east: 'south', south: 'west', west: 'north' };
  const ROT180: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
  const ROT270: Record<string, string> = { north: 'west', west: 'south', south: 'east', east: 'north' };
  const mapping = degrees === 90 ? ROT90 : degrees === 180 ? ROT180 : ROT270;

  const cells = state.dungeon.cells;
  const coords: Array<{ row: number; col: number }> = [];
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) coords.push({ row: r, col: c });

  let rotated = 0;
  mutate(
    'rotateRegion',
    coords,
    () => {
      const snapshot: Array<Array<Cell | null>> = [];
      for (let r = minR; r <= maxR; r++) {
        const row: Array<Cell | null> = [];
        for (let c = minC; c <= maxC; c++) {
          const src = cells[r][c];
          row.push(src ? rebuildCellEdges(src, mapping) : null);
        }
        snapshot.push(row);
      }
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          let nr: number, nc: number;
          if (degrees === 90) {
            nr = c;
            nc = size - 1 - r;
          } else if (degrees === 180) {
            nr = size - 1 - r;
            nc = size - 1 - c;
          } else {
            nr = size - 1 - c;
            nc = r;
          }
          const cell = snapshot[r][c];
          cells[minR + nr][minC + nc] = cell;
          if (cell) rotated++;
        }
      }
    },
    { forceGeometry: true, invalidate: ['lighting'] },
  );

  return { success: true, rotated, degrees };
}
