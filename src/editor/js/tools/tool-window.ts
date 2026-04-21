// Window tool: click on cardinal cell edges to place/toggle windows with the
// currently selected gobo. Windows mark the edge as `'win'` (which blocks
// light like a wall) and record a metadata.windows entry so the lighting
// pipeline can project the gobo pattern through the window's aperture.

import type { CardinalDirection, Direction, EdgeValue, Window as WindowDef } from '../../../types.js';
import { Tool, type EdgeInfo } from './tool-base.js';
import state, { mutate } from '../state.js';
import {
  isInBounds,
  setEdgeReciprocal,
  deleteEdgeReciprocal,
  getEdge,
  CARDINAL_OFFSETS,
  OPPOSITE,
} from '../../../util/index.js';

const CARDINALS: readonly CardinalDirection[] = ['north', 'south', 'east', 'west'];
const DIAGONALS = ['nw-se', 'ne-sw'] as const;
type WindowDir = WindowDef['direction'];

/**
 * Normalize an edge to its canonical (row, col, direction) form. For
 * cardinals: south becomes north of (r+1, c), east becomes west of (r, c+1).
 * For diagonals: no canonicalization needed — diagonals live on a single
 * cell with no reciprocal, so the stored direction matches the edge.
 */
function canonicalizeEdge(
  row: number,
  col: number,
  direction: string,
): { row: number; col: number; direction: WindowDir } | null {
  if ((DIAGONALS as readonly string[]).includes(direction)) {
    return { row, col, direction: direction as WindowDir };
  }
  if (!CARDINALS.includes(direction as CardinalDirection)) return null;
  if (direction === 'north') return { row, col, direction: 'north' };
  if (direction === 'west') return { row, col, direction: 'west' };
  const offsets = CARDINAL_OFFSETS as unknown as Record<string, [number, number]>;
  const [dr, dc] = offsets[direction]!;
  const opp = OPPOSITE[direction as CardinalDirection] as 'north' | 'west';
  return { row: row + dr, col: col + dc, direction: opp };
}

/** Window tool: click an edge to place a window, click again to remove. */
export class WindowTool extends Tool {
  constructor() {
    super('window', 'W', 'pointer');
  }

  onActivate() {
    state.statusInstruction =
      'Click a wall to place window · Click again to remove · Right-click to remove · Select gobo in the toolbar';
  }

  onDeactivate() {
    state.statusInstruction = null;
  }

  onRightClick(row: number, col: number, edge: EdgeInfo | null) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;
    if (!isInBounds(cells, er, ec)) return;
    const cell = cells[er]?.[ec];
    if (!cell) return;
    if (getEdge(cell, direction as Direction) !== 'win') return;

    const canon = canonicalizeEdge(er, ec, direction);
    if (!canon) return;

    const coords: Array<{ row: number; col: number }> = [{ row: er, col: ec }];
    const offsets = CARDINAL_OFFSETS as unknown as Record<string, [number, number]>;
    const offset = offsets[direction];
    if (offset && isInBounds(cells, er + offset[0], ec + offset[1])) {
      coords.push({ row: er + offset[0], col: ec + offset[1] });
    }

    mutate(
      'Remove window',
      coords,
      () => {
        deleteEdgeReciprocal(cells, er, ec, direction);
        removeWindowEntry(canon.row, canon.col, canon.direction);
      },
      { invalidate: ['lighting'] },
    );
  }

  onMouseDown(row: number, col: number, edge: EdgeInfo | null) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;
    if (!isInBounds(cells, er, ec)) return;

    const canon = canonicalizeEdge(er, ec, direction);
    if (!canon) return;

    const cell = cells[er]![ec] ?? {};
    const currentlyWindow = (cell as Record<string, unknown>)[direction] === 'win';
    const goboId = state.windowGobo || 'window-mullions';

    const coords: Array<{ row: number; col: number }> = [{ row: er, col: ec }];
    const offsets = CARDINAL_OFFSETS as unknown as Record<string, [number, number]>;
    const offset = offsets[direction];
    if (offset && isInBounds(cells, er + offset[0], ec + offset[1])) {
      coords.push({ row: er + offset[0], col: ec + offset[1] });
    }

    if (currentlyWindow) {
      // Existing window: if the gobo matches, toggle off; otherwise swap gobo
      // in place. Feels natural when dragging across an existing run to
      // convert it to a different style, or clicking again to remove.
      const existing = findWindowEntry(canon.row, canon.col, canon.direction);
      if (existing?.goboId === goboId) {
        mutate(
          'Remove window',
          coords,
          () => {
            setEdgeReciprocal(cells, er, ec, direction, 'w');
            removeWindowEntry(canon.row, canon.col, canon.direction);
          },
          { invalidate: ['lighting'] },
        );
      } else {
        mutate(
          'Change window gobo',
          coords,
          () => {
            upsertWindowEntry(canon.row, canon.col, canon.direction, goboId);
          },
          { invalidate: ['lighting'] },
        );
      }
      return;
    }

    mutate(
      'Add window',
      coords,
      () => {
        cells[er]![ec] ??= {};
        setEdgeReciprocal(cells, er, ec, direction, 'win' as EdgeValue);
        upsertWindowEntry(canon.row, canon.col, canon.direction, goboId);
      },
      { invalidate: ['lighting'] },
    );
  }
}

function findWindowEntry(row: number, col: number, direction: WindowDir): WindowDef | null {
  const meta = state.dungeon.metadata;
  const list = meta.windows;
  if (!list) return null;
  return list.find((w) => w.row === row && w.col === col && w.direction === direction) ?? null;
}

function upsertWindowEntry(row: number, col: number, direction: WindowDir, goboId: string): void {
  const meta = state.dungeon.metadata;
  meta.windows ??= [];
  const existing = meta.windows.find((w) => w.row === row && w.col === col && w.direction === direction);
  if (existing) {
    existing.goboId = goboId;
  } else {
    meta.windows.push({ row, col, direction, goboId });
  }
}

function removeWindowEntry(row: number, col: number, direction: WindowDir): void {
  const meta = state.dungeon.metadata;
  const list = meta.windows;
  if (!list?.length) return;
  const idx = list.findIndex((w) => w.row === row && w.col === col && w.direction === direction);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) delete meta.windows;
}
