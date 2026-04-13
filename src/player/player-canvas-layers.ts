// Shading layer builder, hatching layer builder, walls overlay (init/incremental/rebuild),
// fog-edge composite masks.

import { renderCells, drawHatching, drawRockShading, drawOuterShading } from '../render/index.js';
import { classifyAllTrimFog } from './fog.js';
import playerState from './player-state.js';
import { cellKey, CARDINAL_OFFSETS } from '../util/index.js';
import { S, getMapCache, getMapPxPerFoot, resolveTheme, type OffscreenLayer } from './player-canvas-state.js';
import { _openDiagFogHalf, _traceDiagVoidTriangle } from './player-canvas-fog.js';
import type { Cell, CellGrid, RenderTransform, Theme, VisibleBounds } from '../types.js';

// ── Shading layer (build-once) ──────────────────────────────────────────────
// Renders the outer-shading halo for the entire map onto an offscreen canvas.
// Uses all-true roomCells so shading covers everywhere; the fog-edge mask
// controls visibility.  Only rebuilt if theme shading params change.

function shadingSig(theme: Theme, cacheW: number, cacheH: number): string {
  const s = (theme as Record<string, unknown>).outerShading as Record<string, unknown> | undefined;
  return `${cacheW},${cacheH},${s?.color},${s?.size},${s?.roughness}`;
}

export function buildShadingLayer(fullCells: CellGrid, gridSize: number, theme: Theme): void {
  const composite = getMapCache().getComposite();
  const outerShading = (theme as Record<string, unknown>).outerShading as Record<string, unknown> | undefined;
  if (!composite || !outerShading?.color || !((outerShading.size as number) > 0)) {
    S._shadingLayer = null;
    return;
  }

  const { cacheW, cacheH } = composite;
  const sig = shadingSig(theme, cacheW, cacheH);
  if (S._shadingLayer?.sig === sig) return;

  const offscreen = document.createElement('canvas');
  offscreen.width = cacheW;
  offscreen.height = cacheH;
  const sCtx = offscreen.getContext('2d')!;

  const cacheTransform: RenderTransform = { scale: getMapPxPerFoot(), offsetX: 0, offsetY: 0 };
  const numRows = fullCells.length;
  const numCols = fullCells[0]?.length ?? 0;
  const allRoom: boolean[][] = Array.from({ length: numRows }, () => Array(numCols).fill(true));
  drawOuterShading(sCtx, fullCells, allRoom, gridSize, theme, cacheTransform);

  S._shadingLayer = { canvas: offscreen, ctx: sCtx, cacheW, cacheH, sig };
  S._fogEdgeMaskVersion = -1;
}

// ── Hatching layer (build-once) ─────────────────────────────────────────────
// Renders hatching for the entire map onto an offscreen canvas. Only rebuilt
// if the theme's hatching-relevant values change (effectively once per session).

function hatchSig(theme: Theme, cacheW: number, cacheH: number): string {
  const t = theme as Record<string, unknown>;
  return `${cacheW},${cacheH},${t.hatchOpacity},${t.hatchSize},${t.hatchDistance},${t.hatchStyle},${t.hatchColor}`;
}

export function buildHatchingLayer(fullCells: CellGrid, gridSize: number, theme: Theme): void {
  const composite = getMapCache().getComposite();
  if (!composite || !(theme as Record<string, unknown>).hatchOpacity) {
    S._hatchLayer = null;
    return;
  }

  const { cacheW, cacheH } = composite;
  const sig = hatchSig(theme, cacheW, cacheH);
  if (S._hatchLayer?.hatchSig === sig) return;

  const offscreen = document.createElement('canvas');
  offscreen.width = cacheW;
  offscreen.height = cacheH;
  const hCtx = offscreen.getContext('2d')!;

  // Transparent background — the shading layer below provides the backdrop
  const cacheTransform: RenderTransform = { scale: getMapPxPerFoot(), offsetX: 0, offsetY: 0 };
  const numRows = fullCells.length;
  const numCols = fullCells[0]?.length ?? 0;
  const allRoom: boolean[][] = Array.from({ length: numRows }, () => Array(numCols).fill(true));
  drawHatching(hCtx, fullCells, allRoom, gridSize, theme, cacheTransform);
  drawRockShading(hCtx, fullCells, allRoom, gridSize, theme, cacheTransform);

  S._hatchLayer = { canvas: offscreen, ctx: hCtx, cacheW, cacheH, hatchSig: sig };
  S._fogEdgeMaskVersion = -1;
}

// ── Walls overlay (incremental) ─────────────────────────────────────────────
// Persistent transparent canvas containing only walls/doors from revealed cells.
// Updated incrementally on reveal; full rebuild on conceal or structure change.

const _BORDER_DIRS: string[] = ['north', 'south', 'east', 'west', 'nw-se', 'ne-sw'];
const _OPPOSITE: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };
// Sourced from util/grid.ts CARDINAL_OFFSETS — single source of truth.
const _OFFSETS = CARDINAL_OFFSETS as unknown as Record<string, [number, number]>;

/** Clone a cell for the walls overlay, converting secret doors to walls/doors
 *  and stripping walls on the unrevealed side of open diagonal trims. */
function _wallsCellForPlayer(cell: Cell | null, r: number, c: number): Cell | null {
  if (!cell) return null;
  const pc: Record<string, unknown> = JSON.parse(JSON.stringify(cell));
  const openedSet = _wallsOpenedSet();
  for (const dir of _BORDER_DIRS) {
    if (pc[dir] === 's') {
      pc[dir] = openedSet.has(`${r},${c},${dir}`) ? 'd' : 'w';
    } else if (pc[dir] === 'iw' || pc[dir] === 'id') {
      delete pc[dir];
    }
  }

  // Open diagonal trims: strip walls on the unrevealed side
  const hasNWSE = !!pc['nw-se'];
  const hasNESW = !!pc['ne-sw'];
  if ((hasNWSE || hasNESW) && !pc.trimCorner && !pc.trimClip) {
    const revealed = playerState.revealedCells;
    let sideARevealed: boolean, sideBRevealed: boolean;
    if (hasNWSE) {
      sideARevealed = revealed.has(cellKey(r - 1, c)) || revealed.has(cellKey(r, c + 1));
      sideBRevealed = revealed.has(cellKey(r + 1, c)) || revealed.has(cellKey(r, c - 1));
    } else {
      sideARevealed = revealed.has(cellKey(r - 1, c)) || revealed.has(cellKey(r, c - 1));
      sideBRevealed = revealed.has(cellKey(r + 1, c)) || revealed.has(cellKey(r, c + 1));
    }
    if (sideARevealed !== sideBRevealed) {
      if (hasNWSE) {
        if (!sideARevealed) {
          delete pc.north;
          delete pc.east;
        } else {
          delete pc.south;
          delete pc.west;
        }
      } else {
        if (!sideARevealed) {
          delete pc.north;
          delete pc.west;
        } else {
          delete pc.south;
          delete pc.east;
        }
      }
    }
  }

  return pc as unknown as Cell;
}

/** Build the opened-door lookup set (cached per content version). */
function _wallsOpenedSet(): Set<string> {
  if (S._wallsOpenedVersion === S._playerContentVersion) return S._wallsOpenedCache;
  S._wallsOpenedCache = new Set();
  for (const d of playerState.openedDoors) {
    S._wallsOpenedCache.add(`${d.row},${d.col},${d.dir}`);

    if (_OFFSETS[d.dir]) {
      const [dr, dc] = _OFFSETS[d.dir]!;
      S._wallsOpenedCache.add(`${d.row + dr},${d.col + dc},${_OPPOSITE[d.dir]}`);
    }
  }
  S._wallsOpenedVersion = S._playerContentVersion;
  return S._wallsOpenedCache;
}

const _wallsSkipPhases: Record<string, boolean> = {
  shading: true,
  hatching: true,
  floors: true,
  blending: true,
  fills: true,
  bridges: true,
  grid: true,
  props: true,
  hazard: true,
};

export function initWallsLayer(): void {
  const composite = getMapCache().getComposite();
  if (!composite) {
    S._wallsLayer = null;
    S._wallsCells = null;
    return;
  }

  const { cacheW, cacheH } = composite;
  const { dungeon } = playerState;
  if (!dungeon) return;
  const { cells, metadata } = dungeon;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;

  // Create canvas + empty filtered cells grid
  const offscreen = document.createElement('canvas');
  offscreen.width = cacheW;
  offscreen.height = cacheH;
  S._wallsLayer = { canvas: offscreen, ctx: offscreen.getContext('2d')!, cacheW, cacheH };
  S._wallsCells = Array.from({ length: numRows }, () => Array(numCols).fill(null)) as CellGrid;

  // Populate with currently revealed cells and do an initial render
  if (playerState.revealedCells.size > 0) {
    for (const key of playerState.revealedCells) {
      const [r, c] = key.split(',').map(Number) as [number, number];
      if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
        S._wallsCells[r]![c] = _wallsCellForPlayer(cells[r]?.[c] ?? null, r, c);
      }
    }
    const theme = resolveTheme();
    if (theme) {
      const cacheTransform: RenderTransform = { scale: getMapPxPerFoot(), offsetX: 0, offsetY: 0 };
      renderCells(S._wallsLayer.ctx, S._wallsCells, metadata.gridSize, theme, cacheTransform, {
        metadata,
        skipPhases: _wallsSkipPhases,
        skipLabels: true,
      });
    }
  }
}

/** Incrementally add walls for newly revealed cells. */
export function revealWallsCells(cellKeys: string[]): void {
  if (!S._wallsLayer || !S._wallsCells || !playerState.dungeon) return;
  const { cells, metadata } = playerState.dungeon;
  const gridSize = metadata.gridSize;
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const theme = resolveTheme();
  if (!theme) return;

  // Update filtered cells and compute dirty bounding box
  let minR = Infinity,
    maxR = -Infinity,
    minC = Infinity,
    maxC = -Infinity;
  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
      S._wallsCells[r]![c] = _wallsCellForPlayer(cells[r]?.[c] ?? null, r, c);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }
  if (minR > maxR) return;

  // Re-process neighboring open diagonal cells whose revealed state may have changed
  // (e.g. walls need restoring now that both sides are revealed)
  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as [number, number][]) {
      const nr = r + dr,
        nc = c + dc;
      if (nr < 0 || nr >= numRows || nc < 0 || nc >= numCols) continue;
      if (!S._wallsCells[nr]?.[nc]) continue;
      const src = cells[nr]?.[nc];
      if (!src) continue;
      const srcAny = src as Record<string, unknown>;
      if ((srcAny['nw-se'] || srcAny['ne-sw']) && !srcAny.trimCorner && !srcAny.trimClip) {
        S._wallsCells[nr][nc] = _wallsCellForPlayer(src, nr, nc);
      }
    }
  }

  // Render walls for dirty region (padded by 1 cell for wall strokes)
  const bounds: VisibleBounds = {
    minRow: Math.max(0, minR - 1),
    maxRow: Math.min(numRows - 1, maxR + 1),
    minCol: Math.max(0, minC - 1),
    maxCol: Math.min(numCols - 1, maxC + 1),
  };
  const cellPx = gridSize * getMapPxPerFoot();
  const wCtx = S._wallsLayer.ctx;
  wCtx.save();
  wCtx.beginPath();
  wCtx.rect(
    bounds.minCol * cellPx,
    bounds.minRow * cellPx,
    (bounds.maxCol - bounds.minCol + 1) * cellPx,
    (bounds.maxRow - bounds.minRow + 1) * cellPx,
  );
  wCtx.clip();
  wCtx.clearRect(0, 0, S._wallsLayer.cacheW, S._wallsLayer.cacheH);

  const cacheTransform: RenderTransform = { scale: getMapPxPerFoot(), offsetX: 0, offsetY: 0 };
  renderCells(wCtx, S._wallsCells, gridSize, theme, cacheTransform, {
    metadata,
    skipPhases: _wallsSkipPhases,
    skipLabels: true,
    visibleBounds: bounds,
  });
  wCtx.restore();
}

/** Full rebuild — used on conceal or structure change. */
export function rebuildWallsLayer(): void {
  S._wallsLayer = null;
  S._wallsCells = null;
  initWallsLayer();
}

// ── Fog-edge composites (shading + hatching) ───────────────────────────────
// Both layers share the same rounded Minkowski-sum mask around revealed cells.
// Rebuilt when fog changes.  The mask is built once per rebuild and applied to
// each layer canvas that has content.

function applyFogEdgeMask(
  maskCtx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  cacheW: number,
  cacheH: number,
  cellPx: number,
  ballRadius: number,
): void {
  maskCtx.globalCompositeOperation = 'source-over';
  maskCtx.clearRect(0, 0, cacheW, cacheH);
  maskCtx.drawImage(sourceCanvas, 0, 0);

  // Keep content only inside the rounded expanded region (Minkowski sum)
  maskCtx.globalCompositeOperation = 'destination-in';
  maskCtx.beginPath();
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    const cx = (c + 0.5) * cellPx;
    const cy = (r + 0.5) * cellPx;
    maskCtx.moveTo(cx + ballRadius, cy);
    maskCtx.arc(cx, cy, ballRadius, 0, Math.PI * 2);
  }
  maskCtx.fill('nonzero');

  // Cut out revealed cells for a clean inner edge
  maskCtx.globalCompositeOperation = 'destination-out';
  maskCtx.beginPath();
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    maskCtx.rect(c * cellPx, r * cellPx, cellPx, cellPx);
  }
  maskCtx.fill();

  // Paint hatching/shading BACK over the unrevealed side of trim cells
  const cells = playerState.dungeon?.cells;
  maskCtx.globalCompositeOperation = 'source-over';
  // Arc trims (trimClip cells)
  const trimSides = classifyAllTrimFog(playerState.revealedCells, cells!);
  for (const [key, side] of trimSides) {
    if ((side as string) === 'both' || (side as string) === 'neither') continue;
    const [r, c] = key.split(',').map(Number) as [number, number];
    const cell = cells?.[r]?.[c] as Record<string, unknown> | null;
    const clip = cell?.trimClip as [number, number][];
    const px = c * cellPx,
      py = r * cellPx;
    if (side === 'roomOnly') {
      maskCtx.save();
      maskCtx.beginPath();
      maskCtx.rect(px, py, cellPx, cellPx);
      maskCtx.moveTo(px + clip[0]![0] * cellPx, py + clip[0]![1] * cellPx);
      for (let i = 1; i < clip.length; i++) {
        maskCtx.lineTo(px + clip[i]![0] * cellPx, py + clip[i]![1] * cellPx);
      }
      maskCtx.closePath();
      maskCtx.clip('evenodd');
      maskCtx.drawImage(sourceCanvas, px, py, cellPx, cellPx, px, py, cellPx, cellPx);
      maskCtx.restore();
    } else {
      maskCtx.save();
      maskCtx.beginPath();
      maskCtx.moveTo(px + clip[0]![0] * cellPx, py + clip[0]![1] * cellPx);
      for (let i = 1; i < clip.length; i++) {
        maskCtx.lineTo(px + clip[i]![0] * cellPx, py + clip[i]![1] * cellPx);
      }
      maskCtx.closePath();
      maskCtx.clip();
      maskCtx.drawImage(sourceCanvas, px, py, cellPx, cellPx, px, py, cellPx, cellPx);
      maskCtx.restore();
    }
  }

  // Diagonal trims (trimCorner without trimClip) — paint shading back over void triangle
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    const cell = cells?.[r]?.[c] as Record<string, unknown> | null;
    if (!cell?.trimCorner || cell.trimClip) continue;
    const px = c * cellPx,
      py = r * cellPx;
    maskCtx.save();
    maskCtx.beginPath();
    _traceDiagVoidTriangle(maskCtx, cell.trimCorner as string, px, py, cellPx);
    maskCtx.clip();
    maskCtx.drawImage(sourceCanvas, px, py, cellPx, cellPx, px, py, cellPx, cellPx);
    maskCtx.restore();
  }

  // Open diagonal trims — paint shading back over the unrevealed half
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    const cell = cells?.[r]?.[c] as Record<string, unknown> | null;
    if (!cell || cell.trimCorner || cell.trimClip) continue;
    const fogHalf = _openDiagFogHalf(cell, r, c, playerState.revealedCells);
    if (!fogHalf) continue;
    const px = c * cellPx,
      py = r * cellPx;
    maskCtx.save();
    maskCtx.beginPath();
    _traceDiagVoidTriangle(maskCtx, fogHalf, px, py, cellPx);
    maskCtx.clip();
    maskCtx.drawImage(sourceCanvas, px, py, cellPx, cellPx, px, py, cellPx, cellPx);
    maskCtx.restore();
  }
}

function ensureComposite(existing: OffscreenLayer | null, cacheW: number, cacheH: number): OffscreenLayer {
  if (existing?.cacheW === cacheW && existing.cacheH === cacheH) return existing;
  const offscreen = document.createElement('canvas');
  offscreen.width = cacheW;
  offscreen.height = cacheH;
  return { canvas: offscreen, ctx: offscreen.getContext('2d')!, cacheW, cacheH };
}

export function rebuildFogEdgeComposites(): void {
  const hasShading = !!S._shadingLayer;
  const hasHatching = !!S._hatchLayer;
  if ((!hasShading && !hasHatching) || !playerState.dungeon || playerState.revealedCells.size === 0) {
    S._shadingComposite = null;
    S._hatchComposite = null;
    S._fogEdgeMaskVersion = S._fogEdgeMaskDirty;
    return;
  }

  const theme = resolveTheme();
  if (!theme) {
    S._fogEdgeMaskVersion = S._fogEdgeMaskDirty;
    return;
  }

  const ref = S._hatchLayer ?? S._shadingLayer!;
  const { cacheW, cacheH } = ref;
  const gridSize = playerState.dungeon.metadata.gridSize;
  const cellPx = gridSize * getMapPxPerFoot();
  const MAX_DIST = Math.round((((theme as Record<string, unknown>).hatchDistance as number | undefined) ?? 1) * 2);
  const ballRadius = cellPx * (0.5 + MAX_DIST);

  // Shading composite (below hatching)
  if (hasShading) {
    const sc = ensureComposite(S._shadingComposite, cacheW, cacheH);
    S._shadingComposite = sc;
    applyFogEdgeMask(sc.ctx, S._shadingLayer!.canvas, cacheW, cacheH, cellPx, ballRadius);
  } else {
    S._shadingComposite = null;
  }

  // Hatching composite (above shading)
  if (hasHatching && (theme as Record<string, unknown>).hatchOpacity) {
    const hc = ensureComposite(S._hatchComposite, cacheW, cacheH);
    S._hatchComposite = hc;
    applyFogEdgeMask(hc.ctx, S._hatchLayer!.canvas, cacheW, cacheH, cellPx, ballRadius);
  } else {
    S._hatchComposite = null;
  }

  S._fogEdgeMaskVersion = S._fogEdgeMaskDirty;
}
