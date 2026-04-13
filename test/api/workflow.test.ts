import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';

import {
  checkpoint,
  rollback,
  listCheckpoints,
  clearCheckpoint,
  transaction,
  getSessionInfo,
  _clearCheckpoints,
} from '../../src/editor/js/api/operational.js';
import { paintCell } from '../../src/editor/js/api/cells.js';
import { loadMap, newMap } from '../../src/editor/js/api/map-management.js';

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  state.undoStack = [];
  state.redoStack = [];
  state.dirty = false;
  state.unsavedChanges = false;
  _clearCheckpoints();
});

// ─── checkpoints ────────────────────────────────────────────────────────────

describe('checkpoint / rollback', () => {
  it('records and rolls back to a named depth', () => {
    paintCell(1, 1);
    const cp = checkpoint('phase-1');
    expect(cp.depth).toBe(1);

    paintCell(2, 2);
    paintCell(3, 3);
    expect(state.undoStack.length).toBe(3);

    const rb = rollback('phase-1');
    expect(rb.undid).toBe(2);
    expect(state.undoStack.length).toBe(1);
    expect(state.dungeon.cells[2][2]).toBeNull();
    expect(state.dungeon.cells[1][1]).not.toBeNull();
  });

  it('throws CHECKPOINT_NOT_FOUND for unknown name', () => {
    expect(() => rollback('nope')).toThrow(/CHECKPOINT_NOT_FOUND|No checkpoint/);
  });

  it('overwrites a checkpoint of the same name', () => {
    paintCell(1, 1);
    checkpoint('x');
    paintCell(2, 2);
    checkpoint('x');
    expect(checkpoint('x').depth).toBe(2);
  });

  it('preserves the checkpoint after rollback (re-rollable)', () => {
    paintCell(1, 1);
    checkpoint('x');
    paintCell(2, 2);
    rollback('x');
    paintCell(3, 3);
    rollback('x');
    expect(state.undoStack.length).toBe(1);
  });

  it('listCheckpoints reports each with stepsAhead', () => {
    paintCell(1, 1);
    checkpoint('a');
    paintCell(2, 2);
    paintCell(3, 3);
    const r = listCheckpoints();
    expect(r.checkpoints).toHaveLength(1);
    expect(r.checkpoints[0]).toMatchObject({ name: 'a', depth: 1, stepsAhead: 2 });
    expect(r.current).toBe(3);
  });

  it('clearCheckpoint removes the entry', () => {
    checkpoint('x');
    expect(clearCheckpoint('x').existed).toBe(true);
    expect(clearCheckpoint('x').existed).toBe(false);
  });

  it('newMap clears checkpoints', () => {
    checkpoint('x');
    newMap('Other', 10, 10);
    expect(listCheckpoints().checkpoints).toHaveLength(0);
  });

  it('loadMap clears checkpoints', () => {
    checkpoint('x');
    const json = JSON.stringify(state.dungeon);
    loadMap(JSON.parse(json));
    expect(listCheckpoints().checkpoints).toHaveLength(0);
  });

  it('rejects empty checkpoint names', () => {
    expect(() => checkpoint('')).toThrow(/INVALID_CHECKPOINT_NAME|non-empty/);
  });
});

// ─── transaction ────────────────────────────────────────────────────────────

describe('transaction', () => {
  it('commits all commands when every one succeeds', async () => {
    const r = await transaction([
      ['paintCell', 1, 1],
      ['paintCell', 2, 2],
      ['paintCell', 3, 3],
    ]);
    expect(r.success).toBe(true);
    expect(r.committed).toBe(true);
    expect(state.dungeon.cells[1][1]).not.toBeNull();
    expect(state.dungeon.cells[3][3]).not.toBeNull();
  });

  it('rolls back the entire batch on a failure', async () => {
    const before = JSON.stringify(state.dungeon);
    const r = await transaction([
      ['paintCell', 1, 1],
      ['paintCell', 2, 2],
      ['paintCell', 999, 999], // out of bounds
    ]);
    expect(r.success).toBe(false);
    expect(r.committed).toBe(false);
    expect(r.failedAt).toBe(2);
    expect(JSON.stringify(state.dungeon)).toBe(before);
  });

  it('reports the failing command with code+context', async () => {
    const r = await transaction([['paintCell', 999, 999]]);
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].code).toBe('OUT_OF_BOUNDS');
    expect(r.results[0].context).toMatchObject({ row: 999, col: 999 });
  });

  it('rejects malformed entries with INVALID_COMMAND', async () => {
    const r = await transaction([[]]);
    expect(r.success).toBe(false);
    expect(r.results[0].code).toBe('INVALID_COMMAND');
  });

  it('reports UNKNOWN_METHOD for unrecognized commands', async () => {
    const r = await transaction([['floopTheCells', 1, 2]]);
    expect(r.results[0].code).toBe('UNKNOWN_METHOD');
  });
});

// ─── getSessionInfo ─────────────────────────────────────────────────────────

describe('getSessionInfo', () => {
  it('returns map name and dimensions', () => {
    const r = getSessionInfo();
    expect(r.mapName).toBe('Test');
    expect(r.rows).toBe(20);
    expect(r.cols).toBe(30);
  });

  it('reports undo depth', () => {
    paintCell(1, 1);
    paintCell(2, 2);
    const r = getSessionInfo();
    expect(r.undoDepth).toBe(2);
  });

  it('reports active checkpoints', () => {
    paintCell(1, 1);
    checkpoint('a');
    paintCell(2, 2);
    const r = getSessionInfo();
    expect(r.checkpoints).toHaveLength(1);
    expect(r.checkpoints[0]).toMatchObject({ name: 'a', stepsAhead: 1 });
  });

  it('reports counts from metadata', () => {
    paintCell(1, 1);
    state.dungeon.cells[1][1].center = { label: 'A1' };
    const r = getSessionInfo();
    expect(r.counts.rooms).toBe(1);
  });
});

// ─── loadMap returns info ───────────────────────────────────────────────────

describe('loadMap', () => {
  it('returns getMapInfo equivalent', () => {
    const json = JSON.stringify(state.dungeon);
    const r = loadMap(JSON.parse(json));
    expect(r.success).toBe(true);
    expect(r.info).toMatchObject({ rows: 20, cols: 30, name: 'Test' });
  });
});
