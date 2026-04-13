// Door tool: click on cell edges to place/toggle doors (normal or secret)
import type { Direction, EdgeValue } from '../../../types.js';
import { Tool, type EdgeInfo } from './tool-base.js';
import state, { mutate } from '../state.js';
import { isInBounds, setEdgeReciprocal, deleteEdgeReciprocal, getEdge, CARDINAL_OFFSETS } from '../../../util/index.js';

/**
 * Door tool: click on cell edges to place/toggle doors (normal, secret, or invisible).
 */
export class DoorTool extends Tool {
  constructor() {
    super('door', 'D', 'pointer');
  }

  onActivate() {
    const statuses = {
      d: 'Click a wall to place door · Click again to toggle off · Right-click to remove',
      s: 'Click a wall to place secret door · Appears as wall to players until discovered',
      id: 'Click a wall to place invisible door · Hidden from players; DM can open',
    };
    state.statusInstruction = statuses[(state.doorType || 'd') as keyof typeof statuses];
  }

  onDeactivate() {
    state.statusInstruction = null;
  }

  onRightClick(row: number, col: number, edge: EdgeInfo | null) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;

    if (!isInBounds(cells, er, ec)) return;
    if (!cells[er]?.[ec]) return;
    if (!getEdge(cells[er][ec], direction as Direction)) return; // nothing to clear

    const coords: Array<{ row: number; col: number }> = [{ row: er, col: ec }];
    const offset = (CARDINAL_OFFSETS as unknown as Record<string, [number, number]>)[direction] as
      | [number, number]
      | undefined;
    if (offset && isInBounds(cells, er + offset[0], ec + offset[1])) {
      coords.push({ row: er + offset[0], col: ec + offset[1] });
    }

    mutate(
      'Remove door',
      coords,
      () => {
        deleteEdgeReciprocal(cells, er, ec, direction);
      },
      { invalidate: ['lighting'] },
    );
  }

  onMouseDown(row: number, col: number, edge: EdgeInfo | null) {
    if (!edge) return;
    const cells = state.dungeon.cells;
    const { direction, row: er, col: ec } = edge;

    if (!isInBounds(cells, er, ec)) return;

    const cell = cells[er]![ec] ?? {};
    const doorType = state.doorType || 'd';
    const isToggleOff = (cell as Record<string, unknown>)[direction] === doorType;
    const label = isToggleOff ? 'Remove door' : doorType === 's' ? 'Secret door' : 'Add door';

    const coords: Array<{ row: number; col: number }> = [{ row: er, col: ec }];
    const offset = (CARDINAL_OFFSETS as unknown as Record<string, [number, number]>)[direction] as
      | [number, number]
      | undefined;
    if (offset && isInBounds(cells, er + offset[0], ec + offset[1])) {
      coords.push({ row: er + offset[0], col: ec + offset[1] });
    }

    mutate(
      label,
      coords,
      () => {
        cells[er]![ec] ??= {};
        if (isToggleOff) {
          setEdgeReciprocal(cells, er, ec, direction, 'w');
        } else {
          setEdgeReciprocal(cells, er, ec, direction, doorType as EdgeValue);
        }
      },
      { invalidate: ['lighting'] },
    );
  }
}
