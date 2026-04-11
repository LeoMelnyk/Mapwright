import type { FillType, RenderTransform } from '../../../types.js';
// Fill tool: click-drag box selection to apply cell fills (water, lava, pit, difficult-terrain)
// or to clear fills (clear-fill mode). Right-click clears fills/hazard on a single cell.
import { Tool } from './tool-base.js';
import state, { mutate } from '../state.js';

const OVERLAY_COLORS = {
  'water':            { fill: 'rgba(60,120,220,0.12)',  stroke: 'rgba(60,120,220,0.85)' },
  'lava':             { fill: 'rgba(220,80,20,0.12)',   stroke: 'rgba(220,80,20,0.85)'  },
  'pit':              { fill: 'rgba(60,60,60,0.18)',    stroke: 'rgba(80,80,80,0.85)'   },
  'difficult-terrain':{ fill: 'rgba(160,100,40,0.12)', stroke: 'rgba(160,100,40,0.85)' },
  'clear-fill':       { fill: 'rgba(220,60,60,0.10)',  stroke: 'rgba(220,60,60,0.85)'  },
};

/**
 * Fill tool: click-drag box selection to apply cell fills (water, lava, pit, difficult-terrain)
 * or to clear fills. Right-click clears fills/hazard on a single cell.
 */
export class FillTool extends Tool {
  boxStart: { row: number; col: number } | null = null;
  boxEnd: { row: number; col: number } | null = null;

  constructor() {
    super('fill', '3', 'crosshair');
    this.boxStart = null; // { row, col } — drag start
    this.boxEnd   = null; // { row, col } — current cursor during drag
  }

  getCursor() { return 'crosshair'; }

  onActivate() {
    const statuses = {
      water:               'Drag to fill with water · Right-click cell to clear',
      lava:                'Drag to fill with lava · Right-click cell to clear',
      pit:                 'Drag to fill with pit · Right-click cell to clear',
      'difficult-terrain': 'Drag to paint difficult terrain · Right-click cell to clear',
      'clear-fill':        'Drag to clear fills from cells',
    };
    state.statusInstruction = statuses[(state.fillMode || 'water') as keyof typeof statuses] || null;
  }

  onDeactivate() {
    this.boxStart = null;
    this.boxEnd   = null;
    state.statusInstruction = null;
  }

  onMouseDown(row: number, col: number) {
    this.boxStart = { row, col };
    this.boxEnd   = { row, col };
  }

  onMouseMove(row: number, col: number) {
    if (this.boxStart) this.boxEnd = { row, col };
  }

  onMouseUp(row: number, col: number) {
    if (!this.boxStart) return;
    this.boxEnd = { row, col };
    const mode = state.fillMode || 'water';
    if (mode === 'clear-fill') {
      this._clearBox();
    } else {
      this._applyBox(mode);
    }
    this.boxStart = null;
    this.boxEnd   = null;
  }

  onRightClick(row: number, col: number) {
    const cells = state.dungeon.cells;
    if (row < 0 || row >= cells.length || col < 0 || col >= (cells[0]?.length || 0)) return;
    if (cells[row][col] === null) return;
    const mode = state.fillMode || 'water';
    const cell = cells[row][col];
    if (mode === 'difficult-terrain') {
      if (!cell.hazard) return;
      mutate('Clear hazard', [{ row, col }], () => {
        delete cell.hazard;
      });
    } else {
      if (!cell.fill) return;
      mutate('Clear fill', [{ row, col }], () => {
        delete cell.fill;
        delete cell.waterDepth;
        delete cell.lavaDepth;
      });
    }
  }

  _getBoxBounds() {
    const cells = state.dungeon.cells;
    const numRows = cells.length;
    const numCols = cells[0]?.length || 0;
    return {
      r1: Math.max(0, Math.min(this.boxStart!.row, this.boxEnd!.row)),
      r2: Math.min(numRows - 1, Math.max(this.boxStart!.row, this.boxEnd!.row)),
      c1: Math.max(0, Math.min(this.boxStart!.col, this.boxEnd!.col)),
      c2: Math.min(numCols - 1, Math.max(this.boxStart!.col, this.boxEnd!.col)),
    };
  }

  _applyBox(mode: string) {
    if (!this.boxStart || !this.boxEnd) return;
    const cells = state.dungeon.cells;
    const { r1, r2, c1, c2 } = this._getBoxBounds();
    const isFluid = (mode === 'water' || mode === 'lava');
    const depthKey = mode + 'Depth';
    const depth = isFluid ? (state[depthKey] ?? 1) : undefined;

    // Collect coords that will actually be mutated
    const coords: Array<{ row: number; col: number }> = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (cells[r]?.[c]) coords.push({ row: r, col: c });
      }
    }
    if (coords.length === 0) return;

    mutate(mode === 'difficult-terrain' ? 'Paint hazard' : 'Paint ' + mode, coords, () => {
      for (const { row: r, col: c } of coords) {
        const cell = cells[r][c];
        if (mode === 'difficult-terrain') {
          cell!.hazard = true;
        } else {
          cell!.fill = mode as FillType;
          if (isFluid) (cell as Record<string, unknown>)[depthKey] = depth;
          if (mode !== 'water') delete cell!.waterDepth;
          if (mode !== 'lava')  delete cell!.lavaDepth;
        }
      }
    });
  }

  _clearBox() {
    if (!this.boxStart || !this.boxEnd) return;
    const cells = state.dungeon.cells;
    const { r1, r2, c1, c2 } = this._getBoxBounds();

    const coords: Array<{ row: number; col: number }> = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (cells[r]?.[c]?.fill || cells[r]?.[c]?.hazard) coords.push({ row: r, col: c });
      }
    }
    if (coords.length === 0) return;

    mutate('Clear fill', coords, () => {
      for (const { row: r, col: c } of coords) {
        delete cells[r][c]!.fill;
        delete cells[r][c]!.waterDepth;
        delete cells[r][c]!.lavaDepth;
        delete cells[r][c]!.hazard;
      }
    });
  }

  renderOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number) {
    if (!this.boxStart || !this.boxEnd) return;
    const mode = state.fillMode || 'water';
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const color = OVERLAY_COLORS[mode as keyof typeof OVERLAY_COLORS] || OVERLAY_COLORS['water'];

    const sc = transform.scale;
    const tx = transform.offsetX;
    const ty = transform.offsetY;

    const r1 = Math.min(this.boxStart.row, this.boxEnd.row);
    const r2 = Math.max(this.boxStart.row, this.boxEnd.row);
    const c1 = Math.min(this.boxStart.col, this.boxEnd.col);
    const c2 = Math.max(this.boxStart.col, this.boxEnd.col);

    const x = c1 * gridSize * sc + tx;
    const y = r1 * gridSize * sc + ty;
    const w = (c2 - c1 + 1) * gridSize * sc;
    const h = (r2 - r1 + 1) * gridSize * sc;

    ctx.save();
    ctx.fillStyle = color.fill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = color.stroke;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}
