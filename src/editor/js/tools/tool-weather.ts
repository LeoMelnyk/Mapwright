// Weather cell-assignment tool.
//
// Activated implicitly when the Weather panel selects a group. Not shown in
// the main toolbar — the Weather panel owns entry/exit.
//
// Interaction:
//   - Left click / drag:        marquee rectangle → assign cells to group.
//   - Right click / drag:       marquee rectangle → unassign cells.
//   - Shift + left click:       flood-fill assign (whole connected room).
//   - Shift + right click:      flood-fill unassign (whole connected room).
//
// The flood fill uses the shared `floodFillRoom` utility so walls, doors,
// diagonal walls, and arc walls block the fill identically to the paint tool.

import type { Cell, RenderTransform } from '../../../types.js';
import { Tool, type EdgeInfo } from './tool-base.js';
import state, { mutate } from '../state.js';
import { requestRender } from '../canvas-view.js';
import { WEATHER_PALETTE } from '../panels/weather.js';
import { floodFillRoom, parseCellKey } from '../../../util/index.js';
import { markWeatherCellDirty } from '../../../render/index.js';

interface MarqueeState {
  startRow: number;
  startCol: number;
  currentRow: number;
  currentCol: number;
  /** Mouse button that started this marquee: 0 = left (assign), 2 = right (unassign). */
  button: 0 | 2;
}

export class WeatherTool extends Tool {
  /** In-progress marquee selection; null when no drag is active. */
  private marquee: MarqueeState | null = null;

  constructor() {
    super('weather', '', 'crosshair');
    this.claimsRightDrag = true;
  }

  override onMouseDown(row: number, col: number, _edge: EdgeInfo | null, event: MouseEvent | null): void {
    const groupId = state.selectedWeatherGroupId;
    if (!groupId) return;

    const button: 0 | 2 = event?.button === 2 ? 2 : 0;
    const shift = !!event?.shiftKey;

    // Shift+click: one-shot flood fill. Does not start a marquee.
    if (shift) {
      if (state.dungeon.cells[row]?.[col]) {
        if (button === 0) floodFillAssign(row, col, groupId);
        else floodFillUnassign(row, col);
      }
      requestRender();
      return;
    }

    this.marquee = { startRow: row, startCol: col, currentRow: row, currentCol: col, button };
    requestRender();
  }

  override onMouseMove(row: number, col: number): void {
    if (!this.marquee) return;
    if (row === this.marquee.currentRow && col === this.marquee.currentCol) return;
    this.marquee.currentRow = row;
    this.marquee.currentCol = col;
    requestRender();
  }

  override onMouseUp(): void {
    if (!this.marquee) return;
    const groupId = state.selectedWeatherGroupId;
    const { startRow, startCol, currentRow, currentCol, button } = this.marquee;
    this.marquee = null;

    if (button === 0) {
      if (groupId) assignRect(startRow, startCol, currentRow, currentCol, groupId);
    } else {
      unassignRect(startRow, startCol, currentRow, currentCol);
    }
    requestRender();
  }

  override onCancel(): boolean {
    if (!this.marquee) return false;
    this.marquee = null;
    requestRender();
    return true;
  }

  override onDeactivate(): void {
    this.marquee = null;
  }

  override renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number): void {
    if (!this.marquee) return;
    const groupId = state.selectedWeatherGroupId;
    if (!groupId) return;
    const isDelete = this.marquee.button === 2;
    const group = state.dungeon.metadata.weatherGroups?.find((g) => g.id === groupId);
    const baseColor = group ? WEATHER_PALETTE[group.colorIndex % WEATHER_PALETTE.length]! : '#ffffff';
    const color = isDelete ? '#dc3030' : baseColor;

    const { startRow, startCol, currentRow, currentCol } = this.marquee;
    const r1 = Math.min(startRow, currentRow);
    const r2 = Math.max(startRow, currentRow);
    const c1 = Math.min(startCol, currentCol);
    const c2 = Math.max(startCol, currentCol);
    const cellPx = gridSize * transform.scale;
    const x = c1 * gridSize * transform.scale + transform.offsetX;
    const y = r1 * gridSize * transform.scale + transform.offsetY;
    const w = (c2 - c1 + 1) * cellPx;
    const h = (r2 - r1 + 1) * cellPx;

    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
  }
}

/**
 * Assign every floor cell in the rectangle (inclusive) to `groupId`. Void
 * cells and cells already in `groupId` are skipped; all changes are one undo
 * step.
 */
function assignRect(r1: number, c1: number, r2: number, c2: number, groupId: string): void {
  const rowMin = Math.min(r1, r2);
  const rowMax = Math.max(r1, r2);
  const colMin = Math.min(c1, c2);
  const colMax = Math.max(c1, c2);
  const cells = state.dungeon.cells;
  const coords: { row: number; col: number }[] = [];
  const touched: Cell[] = [];
  for (let r = rowMin; r <= rowMax; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = colMin; c <= colMax; c++) {
      const cell = row[c];
      if (!cell) continue;
      if (cell.weatherGroupId === groupId) continue;
      coords.push({ row: r, col: c });
      touched.push(cell);
    }
  }
  if (coords.length === 0) return;
  mutate(
    coords.length === 1 ? 'Assign weather cell' : 'Assign weather cells',
    coords,
    () => {
      for (const cell of touched) cell.weatherGroupId = groupId;
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
}

/**
 * Unassign every floor cell in the rectangle (inclusive) that currently has a
 * weatherGroupId. One undo step.
 */
function unassignRect(r1: number, c1: number, r2: number, c2: number): void {
  const rowMin = Math.min(r1, r2);
  const rowMax = Math.max(r1, r2);
  const colMin = Math.min(c1, c2);
  const colMax = Math.max(c1, c2);
  const cells = state.dungeon.cells;
  const coords: { row: number; col: number }[] = [];
  const touched: Cell[] = [];
  for (let r = rowMin; r <= rowMax; r++) {
    const row = cells[r];
    if (!row) continue;
    for (let c = colMin; c <= colMax; c++) {
      const cell = row[c];
      if (!cell?.weatherGroupId) continue;
      coords.push({ row: r, col: c });
      touched.push(cell);
    }
  }
  if (coords.length === 0) return;
  mutate(
    coords.length === 1 ? 'Unassign weather cell' : 'Unassign weather cells',
    coords,
    () => {
      for (const cell of touched) delete cell.weatherGroupId;
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
}

/**
 * Flood fill from (row, col) to every cell in the connected room, assigning
 * each to `groupId`. Walls, doors, diagonal walls, and arc walls all block —
 * shares the traversal used by the paint tool's flood fill via `floodFillRoom`.
 */
function floodFillAssign(startRow: number, startCol: number, groupId: string): void {
  const cells = state.dungeon.cells;
  const room = floodFillRoom(cells, startRow, startCol);
  const coords: { row: number; col: number }[] = [];
  const touched: Cell[] = [];
  for (const key of room) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    if (cell.weatherGroupId === groupId) continue;
    coords.push({ row: r, col: c });
    touched.push(cell);
  }
  if (coords.length === 0) return;
  mutate(
    'Flood-fill weather',
    coords,
    () => {
      for (const cell of touched) cell.weatherGroupId = groupId;
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
}

/** Flood unassign from (row, col): every cell in the connected room loses its weatherGroupId. */
function floodFillUnassign(startRow: number, startCol: number): void {
  const cells = state.dungeon.cells;
  const room = floodFillRoom(cells, startRow, startCol);
  const coords: { row: number; col: number }[] = [];
  const touched: Cell[] = [];
  for (const key of room) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell?.weatherGroupId) continue;
    coords.push({ row: r, col: c });
    touched.push(cell);
  }
  if (coords.length === 0) return;
  mutate(
    'Flood-clear weather',
    coords,
    () => {
      for (const cell of touched) delete cell.weatherGroupId;
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
}
