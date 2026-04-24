// Weather cell-assignment tool.
//
// Activated implicitly when the Weather panel selects a group. Not shown in
// the main toolbar — the Weather panel owns entry/exit.
//
// Interaction:
//   - Left click / drag:        marquee rectangle → assign cells to group.
//   - Right click / drag:       marquee rectangle → unassign cells.
//   - Shift + left click:       flood-fill assign (whole connected half-region).
//   - Shift + right click:      flood-fill unassign (whole connected half-region).
//
// Split cells (diagonal walls, trims) carry per-half weather assignments. A
// shift-click reads the click's position inside the clicked cell and seeds
// the flood from the half that was hit — so flood fills respect diagonals
// and arc boundaries like `floodFillRoom` already does.
//
// Marquee drags are a bulk tool: they fill every half of every cell in the
// rect. Precision per-half assignment is done via flood fill.

import type { Cell, CellHalfKey, RenderTransform } from '../../../types.js';
import { Tool, type CanvasPos, type EdgeInfo } from './tool-base.js';
import state, { mutate } from '../state.js';
import { requestRender, getTransform } from '../canvas-view.js';
import { WEATHER_PALETTE } from '../panels/weather.js';
import {
  floodFillRoom,
  getCellHalves,
  getCellWeatherHalf,
  hitTestHalf,
  parseCellHalfKey,
  setCellWeatherHalf,
} from '../../../util/index.js';
import { markWeatherCellDirty } from '../../../render/index.js';
import { fromCanvas } from '../utils.js';

interface MarqueeState {
  startRow: number;
  startCol: number;
  currentRow: number;
  currentCol: number;
  /** Mouse button that started this marquee: 0 = left (assign), 2 = right (unassign). */
  button: 0 | 2;
  /** Which half of the start cell was clicked. Used when the marquee never
   *  leaves the start cell — a plain click on a split cell affects only the
   *  clicked half. Dragging across multiple cells upgrades to whole-cell fill. */
  startHalfKey: CellHalfKey;
}

export class WeatherTool extends Tool {
  /** In-progress marquee selection; null when no drag is active. */
  private marquee: MarqueeState | null = null;

  constructor() {
    super('weather', '', 'crosshair');
    this.claimsRightDrag = true;
  }

  override onMouseDown(
    row: number,
    col: number,
    _edge: EdgeInfo | null,
    event: MouseEvent | null,
    pos: CanvasPos | null,
  ): void {
    const groupId = state.selectedWeatherGroupId;
    if (!groupId) return;

    const button: 0 | 2 = event?.button === 2 ? 2 : 0;
    const shift = !!event?.shiftKey;

    // Shift+click: one-shot flood fill. Resolve which half of the clicked
    // cell was hit; the flood respects the diagonal/arc split from there.
    if (shift) {
      const cell = state.dungeon.cells[row]?.[col];
      if (cell) {
        const halfKey = resolveClickedHalf(cell, row, col, pos);
        if (button === 0) floodFillAssignHalf(row, col, halfKey, groupId);
        else floodFillUnassignHalf(row, col, halfKey);
      }
      requestRender();
      return;
    }

    const startCell = state.dungeon.cells[row]?.[col];
    const startHalfKey: CellHalfKey = startCell ? resolveClickedHalf(startCell, row, col, pos) : 'full';
    this.marquee = {
      startRow: row,
      startCol: col,
      currentRow: row,
      currentCol: col,
      button,
      startHalfKey,
    };
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
    const { startRow, startCol, currentRow, currentCol, button, startHalfKey } = this.marquee;
    this.marquee = null;

    const singleCell = startRow === currentRow && startCol === currentCol;

    if (button === 0) {
      if (!groupId) {
        requestRender();
        return;
      }
      if (singleCell && startHalfKey !== 'full') {
        assignSingleHalf(startRow, startCol, startHalfKey, groupId);
      } else {
        assignRect(startRow, startCol, currentRow, currentCol, groupId);
      }
    } else {
      if (singleCell && startHalfKey !== 'full') {
        unassignSingleHalf(startRow, startCol, startHalfKey);
      } else {
        unassignRect(startRow, startCol, currentRow, currentCol);
      }
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
 * Resolve which half of the clicked cell a canvas-pixel position falls in.
 * Returns 'full' for unsplit cells. When `pos` is missing (e.g. keyboard-
 * driven invocation) defaults to the cell's first declared half.
 */
function resolveClickedHalf(cell: Cell, row: number, col: number, pos: CanvasPos | null): CellHalfKey {
  const halves = getCellHalves(cell);
  if (halves.length === 1) return halves[0]!;
  if (!pos) return halves[0]!;
  const transform = getTransform();
  const gridSize = state.dungeon.metadata.gridSize;
  const feet = fromCanvas(pos.x, pos.y, transform);
  const lx = feet.x / gridSize - col;
  const ly = feet.y / gridSize - row;
  return hitTestHalf(cell, lx, ly);
}

/**
 * Assign weather for a single half of a single cell (click on a split cell
 * without dragging). One undo step.
 */
function assignSingleHalf(row: number, col: number, halfKey: CellHalfKey, groupId: string): void {
  const cells = state.dungeon.cells;
  const cell = cells[row]?.[col];
  if (!cell) return;
  if (getCellWeatherHalf(cell, halfKey) === groupId) return;
  const coords = [{ row, col }];
  mutate(
    'Assign weather half',
    coords,
    () => setCellWeatherHalf(cell, halfKey, groupId),
    { topic: 'cells' },
  );
  markWeatherCellDirty(row, col);
}

/** Clear weather for a single half of a single cell. One undo step. */
function unassignSingleHalf(row: number, col: number, halfKey: CellHalfKey): void {
  const cells = state.dungeon.cells;
  const cell = cells[row]?.[col];
  if (!cell) return;
  if (getCellWeatherHalf(cell, halfKey) === undefined) return;
  const coords = [{ row, col }];
  mutate(
    'Unassign weather half',
    coords,
    () => setCellWeatherHalf(cell, halfKey, null),
    { topic: 'cells' },
  );
  markWeatherCellDirty(row, col);
}

/**
 * Assign every floor cell in the rectangle (inclusive) to `groupId`. Void
 * cells are skipped; for split cells, every half is set to `groupId`. All
 * changes are one undo step.
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
      // Skip when every half is already this group.
      if (cell.weatherGroupId === groupId && !cell.weatherHalves) continue;
      const halves = getCellHalves(cell);
      const allAssigned = halves.every((h) => getCellWeatherHalf(cell, h) === groupId);
      if (allAssigned) continue;
      coords.push({ row: r, col: c });
      touched.push(cell);
    }
  }
  if (coords.length === 0) return;
  mutate(
    coords.length === 1 ? 'Assign weather cell' : 'Assign weather cells',
    coords,
    () => {
      for (const cell of touched) {
        for (const h of getCellHalves(cell)) setCellWeatherHalf(cell, h, groupId);
      }
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
}

/**
 * Unassign every floor cell in the rectangle (inclusive). Both
 * `weatherGroupId` and any `weatherHalves` entries are cleared. One undo step.
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
      if (!cell) continue;
      if (!cell.weatherGroupId && !cell.weatherHalves) continue;
      coords.push({ row: r, col: c });
      touched.push(cell);
    }
  }
  if (coords.length === 0) return;
  mutate(
    coords.length === 1 ? 'Unassign weather cell' : 'Unassign weather cells',
    coords,
    () => {
      for (const cell of touched) {
        for (const h of getCellHalves(cell)) setCellWeatherHalf(cell, h, null);
      }
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
}

/**
 * Flood fill from (row, col, halfKey) to every connected half-region,
 * assigning each to `groupId`. Diagonal walls, arc walls, and trim
 * boundaries confine the flood to one side — `floodFillRoom`'s half-aware
 * mode handles the adjacency.
 */
function floodFillAssignHalf(
  startRow: number,
  startCol: number,
  halfKey: CellHalfKey,
  groupId: string,
): void {
  const cells = state.dungeon.cells;
  const room = floodFillRoom(cells, startRow, startCol, {
    returnHalves: true,
    startHalfKey: halfKey,
  });
  // Group writes by cell (multiple halves of the same cell share one mutate entry).
  const writesByCell = new Map<string, { row: number; col: number; halves: CellHalfKey[] }>();
  for (const key of room) {
    const { row: r, col: c, halfKey: hk } = parseCellHalfKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    if (getCellWeatherHalf(cell, hk) === groupId) continue;
    const k = `${r},${c}`;
    let entry = writesByCell.get(k);
    if (!entry) {
      entry = { row: r, col: c, halves: [] };
      writesByCell.set(k, entry);
    }
    entry.halves.push(hk);
  }
  if (writesByCell.size === 0) return;
  const coords = Array.from(writesByCell.values()).map(({ row, col }) => ({ row, col }));
  mutate(
    'Flood-fill weather',
    coords,
    () => {
      for (const entry of writesByCell.values()) {
        const cell = cells[entry.row]?.[entry.col];
        if (!cell) continue;
        for (const hk of entry.halves) setCellWeatherHalf(cell, hk, groupId);
      }
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
}

/**
 * Flood unassign from (row, col, halfKey). Every connected half-region loses
 * its weather assignment.
 */
function floodFillUnassignHalf(startRow: number, startCol: number, halfKey: CellHalfKey): void {
  const cells = state.dungeon.cells;
  const room = floodFillRoom(cells, startRow, startCol, {
    returnHalves: true,
    startHalfKey: halfKey,
  });
  const writesByCell = new Map<string, { row: number; col: number; halves: CellHalfKey[] }>();
  for (const key of room) {
    const { row: r, col: c, halfKey: hk } = parseCellHalfKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;
    if (getCellWeatherHalf(cell, hk) === undefined) continue;
    const k = `${r},${c}`;
    let entry = writesByCell.get(k);
    if (!entry) {
      entry = { row: r, col: c, halves: [] };
      writesByCell.set(k, entry);
    }
    entry.halves.push(hk);
  }
  if (writesByCell.size === 0) return;
  const coords = Array.from(writesByCell.values()).map(({ row, col }) => ({ row, col }));
  mutate(
    'Flood-clear weather',
    coords,
    () => {
      for (const entry of writesByCell.values()) {
        const cell = cells[entry.row]?.[entry.col];
        if (!cell) continue;
        for (const hk of entry.halves) setCellWeatherHalf(cell, hk, null);
      }
    },
    { topic: 'cells' },
  );
  for (const { row, col } of coords) markWeatherCellDirty(row, col);
}

