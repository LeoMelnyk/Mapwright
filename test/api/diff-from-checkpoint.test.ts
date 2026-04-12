import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js';
import { checkpoint, diffFromCheckpoint } from '../../src/editor/js/api/operational.js';
import { setFill } from '../../src/editor/js/api/fills.js';
import { setLabel } from '../../src/editor/js/api/labels.js';
import { paintRect } from '../../src/editor/js/api/cells.js';

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 30, 30, 5, 'stone-dungeon', 1);
  state.undoStack = [];
  state.redoStack = [];
});

describe('diffFromCheckpoint', () => {
  it('returns zero summary when checkpoint is at current depth', () => {
    paintRect(2, 2, 6, 6);
    checkpoint('start');
    const r = diffFromCheckpoint('start');
    expect(r.success).toBe(true);
    expect(r.entriesAhead).toBe(0);
    expect(r.summary.cellsModified).toBe(0);
  });

  it('counts cells painted', () => {
    checkpoint('start');
    paintRect(2, 2, 4, 4);
    const r = diffFromCheckpoint('start');
    expect(r.summary.cellsModified).toBeGreaterThan(0);
    expect(r.summary.cellsPainted).toBe(9);
  });

  it('counts fills added', () => {
    paintRect(2, 2, 6, 6);
    checkpoint('start');
    setFill(3, 3, 'water', 1);
    setFill(4, 4, 'water', 1);
    const r = diffFromCheckpoint('start');
    expect(r.summary.fillsAdded).toBe(2);
  });

  it('counts labels added', () => {
    paintRect(2, 2, 6, 6);
    checkpoint('start');
    setLabel(4, 4, 'A1');
    const r = diffFromCheckpoint('start');
    expect(r.summary.labelsAdded).toBe(1);
  });

  it('reports per-entry labels with type and cellCount', () => {
    paintRect(2, 2, 4, 4);
    checkpoint('start');
    paintRect(5, 5, 6, 6);
    setLabel(5, 5, 'A2');
    const r = diffFromCheckpoint('start');
    expect(r.entryLabels.length).toBeGreaterThan(0);
    for (const entry of r.entryLabels) {
      expect(['patch', 'snapshot']).toContain(entry.type);
    }
  });

  it('throws CHECKPOINT_NOT_FOUND for unknown name', () => {
    expect(() => diffFromCheckpoint('nonexistent')).toThrow(/No checkpoint named/);
  });
});
