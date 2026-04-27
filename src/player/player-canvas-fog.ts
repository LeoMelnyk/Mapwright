// Fog overlay builder, diagonal fog helpers, incremental reveal/conceal functions.

import playerState from './player-state.js';
import { cellKey, getEdge, getInteriorEdges, getSegments, isChordEdge } from '../util/index.js';
import type { Cell } from '../types.js';
import { classifyAllTrimFog } from './fog.js';
import { S, getMapCache, getMapPxPerFoot, resolveTheme } from './player-canvas-state.js';

/**
 * For an open diagonal cell (diagonal wall, no trimCorner), determine which
 * half(s) should be fogged based on whether neighbors on each side are revealed.
 * Returns null if both sides revealed, or the half name ('ne','sw','nw','se') to fog.
 */
export function _openDiagFogHalf(cell: Cell, r: number, c: number, revealedCells: Set<string>): string | null {
  const hasNWSE = !!getEdge(cell, 'nw-se');
  const hasNESW = !!getEdge(cell, 'ne-sw');
  if (!hasNWSE && !hasNESW) return null;

  // For nw-se diagonal: halves are 'ne' (upper-right) and 'sw' (lower-left)
  // For ne-sw diagonal: halves are 'nw' (upper-left) and 'se' (lower-right)
  let sideA: string, sideB: string, aDirs: [number, number][], bDirs: [number, number][];
  if (hasNWSE) {
    sideA = 'ne';
    sideB = 'sw';
    aDirs = [
      [-1, 0],
      [0, 1],
    ]; // neighbors on the NE side
    bDirs = [
      [1, 0],
      [0, -1],
    ]; // neighbors on the SW side
  } else {
    sideA = 'nw';
    sideB = 'se';
    aDirs = [
      [-1, 0],
      [0, -1],
    ]; // neighbors on the NW side
    bDirs = [
      [1, 0],
      [0, 1],
    ]; // neighbors on the SE side
  }

  const aRevealed = aDirs.some(([dr, dc]) => revealedCells.has(cellKey(r + dr, c + dc)));
  const bRevealed = bDirs.some(([dr, dc]) => revealedCells.has(cellKey(r + dr, c + dc)));

  if (aRevealed && bRevealed) return null; // both sides revealed
  if (!aRevealed && !bRevealed) return null; // neither — full cell fogged anyway
  return aRevealed ? sideB : sideA; // fog the unrevealed half
}

/**
 * Trace the void triangle of a diagonal trim cell onto a canvas context.
 * The void corner determines which triangle to draw:
 *   nw → tl, tr, bl;  ne → tl, tr, br;  sw → tl, bl, br;  se → tr, bl, br
 */
export function _traceDiagVoidTriangle(
  drawCtx: CanvasRenderingContext2D,
  voidCorner: string,
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
  switch (voidCorner) {
    case 'nw':
      drawCtx.moveTo(tl_x, tl_y);
      drawCtx.lineTo(tr_x, tr_y);
      drawCtx.lineTo(bl_x, bl_y);
      break;
    case 'ne':
      drawCtx.moveTo(tl_x, tl_y);
      drawCtx.lineTo(tr_x, tr_y);
      drawCtx.lineTo(br_x, br_y);
      break;
    case 'sw':
      drawCtx.moveTo(tl_x, tl_y);
      drawCtx.lineTo(bl_x, bl_y);
      drawCtx.lineTo(br_x, br_y);
      break;
    case 'se':
      drawCtx.moveTo(tr_x, tr_y);
      drawCtx.lineTo(bl_x, bl_y);
      drawCtx.lineTo(br_x, br_y);
      break;
  }
  drawCtx.closePath();
}

// ── Fog overlay builder ─────────────────────────────────────────────────────
// Simple black mask with transparent holes for revealed cells.

export function rebuildFogOverlay(): void {
  const _t0 = performance.now();
  const composite = getMapCache().getComposite();
  if (!playerState.dungeon || !composite) return;

  const gridSize = playerState.dungeon.metadata.gridSize;
  const cacheW = composite.cacheW;
  const cacheH = composite.cacheH;

  // Create / resize fog overlay canvas
  if (S._fogOverlay?.cacheW !== cacheW || S._fogOverlay.cacheH !== cacheH) {
    const offscreen = document.createElement('canvas');
    offscreen.width = cacheW;
    offscreen.height = cacheH;
    S._fogOverlay = { canvas: offscreen, ctx: offscreen.getContext('2d')!, cacheW, cacheH };
  }

  const fCtx = S._fogOverlay.ctx;

  // Theme-colored mask with transparent holes — instant to rebuild.
  // Hatching is handled by a separate layer that rebuilds asynchronously.
  const theme = resolveTheme();
  const fogColor = theme?.background ?? '#000000';
  fCtx.globalCompositeOperation = 'source-over';
  fCtx.fillStyle = fogColor;
  fCtx.fillRect(0, 0, cacheW, cacheH);

  const cellPx = gridSize * getMapPxPerFoot();
  const cells = playerState.dungeon.cells;

  // Step 1: Clear full rects for ALL revealed cells (no gaps at cell boundaries)
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    fCtx.clearRect(c * cellPx, r * cellPx, cellPx, cellPx);
  }

  // Step 2: Paint fog color BACK over the unrevealed side of trim cells.
  // 2a: Arc trims (cells with arc interiorEdge)
  const trimSides = classifyAllTrimFog(playerState.revealedCells, cells);
  for (const [key, side] of trimSides) {
    if ((side as string) === 'both' || (side as string) === 'neither') continue;
    const [r, c] = key.split(',').map(Number) as [number, number];
    const cell = cells[r]?.[c];
    if (!cell) continue;
    const clip = getSegments(cell)[0]?.polygon as [number, number][] | undefined;
    if (!clip) continue;
    const px = c * cellPx,
      py = r * cellPx;
    fCtx.save();
    fCtx.fillStyle = fogColor;
    if (side === 'roomOnly') {
      // Paint fog over the exterior (cell rect minus trimClip via evenodd)
      fCtx.beginPath();
      fCtx.rect(px, py, cellPx, cellPx);
      fCtx.moveTo(px + clip[0]![0] * cellPx, py + clip[0]![1] * cellPx);
      for (let i = 1; i < clip.length; i++) {
        fCtx.lineTo(px + clip[i]![0] * cellPx, py + clip[i]![1] * cellPx);
      }
      fCtx.closePath();
      fCtx.fill('evenodd');
    } else {
      // exteriorOnly: paint fog over the room side (trimClip polygon)
      fCtx.beginPath();
      fCtx.moveTo(px + clip[0]![0] * cellPx, py + clip[0]![1] * cellPx);
      for (let i = 1; i < clip.length; i++) {
        fCtx.lineTo(px + clip[i]![0] * cellPx, py + clip[i]![1] * cellPx);
      }
      fCtx.closePath();
      fCtx.fill();
    }
    fCtx.restore();
  }

  // 2b: Diagonal trims with a void-corner cut — always fog the void triangle.
  // (Diagonal cells whose s1 segment is voided correspond to the legacy
  // `trimCorner` cut.)
  fCtx.fillStyle = fogColor;
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    const cell = cells[r]?.[c];
    if (!cell) continue;
    const ie = getInteriorEdges(cell)[0];
    // Skip chord cells (handled in 2a) and non-diagonal cells.
    if (!ie || isChordEdge(ie)) continue;
    const segs = getSegments(cell);
    // Find the voided segment; that polygon is the void triangle.
    const voidedIdx = segs.findIndex((s) => s.voided);
    if (voidedIdx < 0) continue;
    const voidPoly = segs[voidedIdx]!.polygon;
    const px = c * cellPx,
      py = r * cellPx;
    fCtx.beginPath();
    fCtx.moveTo(px + voidPoly[0]![0]! * cellPx, py + voidPoly[0]![1]! * cellPx);
    for (let i = 1; i < voidPoly.length; i++) {
      fCtx.lineTo(px + voidPoly[i]![0]! * cellPx, py + voidPoly[i]![1]! * cellPx);
    }
    fCtx.closePath();
    fCtx.fill();
  }

  // 2c: Open diagonal trims (diagonal wall, no void corner) — fog the unrevealed half
  for (const key of playerState.revealedCells) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    const cell = cells[r]?.[c];
    if (!cell) continue;
    const ie = getInteriorEdges(cell)[0];
    if (!ie || isChordEdge(ie)) continue;
    const segs = getSegments(cell);
    if (segs.some((s) => s.voided)) continue;
    const fogHalf = _openDiagFogHalf(cell, r, c, playerState.revealedCells);
    if (!fogHalf) continue;
    const px = c * cellPx,
      py = r * cellPx;
    fCtx.beginPath();
    _traceDiagVoidTriangle(fCtx, fogHalf, px, py, cellPx);
    fCtx.fill();
  }

  S._fogBuiltVersion = S._fogVersion;
  S._lastFogRebuildMs = performance.now() - _t0;
  S._fogRebuildCount++;
}

/**
 * Incrementally update the fog overlay for newly revealed cells.
 * Avoids a full rebuild — just punches transparent holes in the existing mask.
 */
export function revealFogCells(cellKeys: string[], revealWallsCells: (cellKeys: string[]) => void): void {
  const _t0 = performance.now();
  if (!S._fogOverlay || !playerState.dungeon) return;
  const { cells, metadata } = playerState.dungeon;
  const gridSize = metadata.gridSize;
  const cellPx = gridSize * getMapPxPerFoot();
  const numRows = cells.length;
  const numCols = cells[0]?.length ?? 0;
  const fCtx = S._fogOverlay.ctx;
  const theme = resolveTheme();
  const fogColor = theme?.background ?? '#000000';

  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    fCtx.clearRect(c * cellPx, r * cellPx, cellPx, cellPx);
  }

  // Refresh fog masks on neighboring open diagonal cells whose revealed state changed.
  // When both sides become revealed, the fog triangle is cleared; if still one-sided,
  // repaint the correct half.
  const refreshed = new Set<string>();
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
      const nk = cellKey(nr, nc);
      if (refreshed.has(nk) || !playerState.revealedCells.has(nk)) continue;
      const cell = cells[nr]?.[nc];
      if (!cell) continue;
      const ie = getInteriorEdges(cell)[0];
      // Skip chord cells, void-corner diagonals, and non-diagonal cells.
      if (ie && isChordEdge(ie)) continue;
      const segs = getSegments(cell);
      if (segs.some((s) => s.voided)) continue;
      if (!getEdge(cell, 'nw-se') && !getEdge(cell, 'ne-sw')) continue;
      refreshed.add(nk);
      const px = nc * cellPx,
        py = nr * cellPx;
      // Reclear the whole cell, then re-fog the unrevealed half if needed
      fCtx.clearRect(px, py, cellPx, cellPx);
      const fogHalf = _openDiagFogHalf(cell, nr, nc, playerState.revealedCells);
      if (fogHalf) {
        fCtx.fillStyle = fogColor;
        fCtx.beginPath();
        _traceDiagVoidTriangle(fCtx, fogHalf, px, py, cellPx);
        fCtx.fill();
      }
    }
  }

  S._fogBuiltVersion = S._fogVersion;
  S._fogEdgeMaskDirty++;
  revealWallsCells(cellKeys);
  S._lastRevealMs = performance.now() - _t0;
  S._lastRevealCellCount = cellKeys.length;
}

/**
 * Incrementally update the fog overlay for newly concealed cells.
 * Paints black back over the cells without a full rebuild.
 */
export function concealFogCells(cellKeys: string[], rebuildWallsLayer: () => void): void {
  if (!S._fogOverlay || !playerState.dungeon) return;
  const gridSize = playerState.dungeon.metadata.gridSize;
  const cellPx = gridSize * getMapPxPerFoot();
  const fCtx = S._fogOverlay.ctx;
  const theme = resolveTheme();
  fCtx.fillStyle = theme?.background ?? '#000000';
  for (const key of cellKeys) {
    const [r, c] = key.split(',').map(Number) as [number, number];
    fCtx.fillRect(c * cellPx, r * cellPx, cellPx, cellPx);
  }
  S._fogBuiltVersion = S._fogVersion;
  S._fogEdgeMaskDirty++;
  rebuildWallsLayer();
}
