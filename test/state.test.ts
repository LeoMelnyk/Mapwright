import { describe, it, expect, beforeEach, vi } from 'vitest';
import state, {
  pushUndo,
  undo,
  redo,
  markDirty,
  clearDirty,
  notify,
  subscribe,
  invalidateLightmap,
  getTheme,
  setUndoDisabled,
  undoDisabled,
  jumpToState,
  loadAutosave,
  notifyTimings,
  mutate,
} from '../src/editor/js/state.js';
import { createEmptyDungeon } from '../src/editor/js/utils.js';
import { THEMES, invalidateVisibilityCache } from '../src/render/index.js';

// ---------------------------------------------------------------------------
// Helper: reset state to a clean dungeon before each test
// ---------------------------------------------------------------------------

function freshState(rows = 10, cols = 10) {
  state.dungeon = createEmptyDungeon('Test', rows, cols, 5, 'stone-dungeon', 1);
  state.currentLevel = 0;
  state.selectedCells = [];
  state.undoStack = [];
  state.redoStack = [];
  state.listeners = [];
  state.dirty = false;
  state.unsavedChanges = false;
  state.fileHandle = null;
  state.fileName = null;
  setUndoDisabled(false);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Default state
// ═══════════════════════════════════════════════════════════════════════════

describe('Default state', () => {
  it('has a dungeon object with cells and metadata', () => {
    expect(state.dungeon).toBeDefined();
    expect(state.dungeon.metadata).toBeDefined();
    expect(state.dungeon.cells).toBeDefined();
    expect(Array.isArray(state.dungeon.cells)).toBe(true);
  });

  it('dungeon cells is a 2D array with correct dimensions', () => {
    freshState(10, 15);
    expect(state.dungeon.cells.length).toBe(10);
    expect(state.dungeon.cells[0].length).toBe(15);
  });

  it('all cells are null initially (void)', () => {
    freshState(5, 5);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        expect(state.dungeon.cells[r][c]).toBeNull();
      }
    }
  });

  it('metadata contains expected default fields', () => {
    freshState();
    const m = state.dungeon.metadata;
    expect(m.dungeonName).toBe('Test');
    expect(m.theme).toBe('stone-dungeon');
    expect(m.features).toBeDefined();
    expect(m.features.showGrid).toBe(true);
    expect(m.levels).toBeDefined();
    expect(m.levels.length).toBeGreaterThanOrEqual(1);
  });

  it('has default tool and mode values', () => {
    expect(state.activeTool).toBeDefined();
    expect(state.roomMode).toBe('room');
    expect(state.paintMode).toBe('texture');
    expect(state.doorType).toBe('d');
  });

  it('has empty undo and redo stacks by default after reset', () => {
    freshState();
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([]);
  });

  it('has default zoom and pan values', () => {
    expect(typeof state.zoom).toBe('number');
    expect(typeof state.panX).toBe('number');
    expect(typeof state.panY).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. pushUndo / undo / redo
// ═══════════════════════════════════════════════════════════════════════════

describe('pushUndo', () => {
  beforeEach(() => freshState());

  it('adds an entry to the undo stack', () => {
    pushUndo('action1');
    expect(state.undoStack.length).toBe(1);
    expect(state.undoStack[0].label).toBe('action1');
  });

  it('defaults label to "Edit"', () => {
    pushUndo();
    expect(state.undoStack[0].label).toBe('Edit');
  });

  it('serializes the current dungeon state as JSON', () => {
    state.dungeon.metadata.dungeonName = 'Snapshot';
    pushUndo('snap');
    const parsed = JSON.parse(state.undoStack[0].json);
    expect(parsed.metadata.dungeonName).toBe('Snapshot');
  });

  it('clears the redo stack on new push', () => {
    // Simulate a redo entry
    state.redoStack.push({ json: '{}', label: 'old' });
    expect(state.redoStack.length).toBe(1);
    pushUndo('new action');
    expect(state.redoStack.length).toBe(0);
  });

  it('accepts pre-serialized JSON to avoid double serialization', () => {
    const preJson = JSON.stringify({ metadata: { dungeonName: 'Pre' }, cells: [] });
    pushUndo('pre', preJson);
    expect(state.undoStack[0].json).toBe(preJson);
  });

  it('enforces MAX_UNDO limit (100) by shifting oldest entry', () => {
    for (let i = 0; i < 105; i++) {
      pushUndo(`action-${i}`);
    }
    expect(state.undoStack.length).toBe(100);
    // The oldest surviving entry should be action-5
    expect(state.undoStack[0].label).toBe('action-5');
  });

  it('deep-clones state: mutations after push do not affect snapshot', () => {
    state.dungeon.metadata.dungeonName = 'Before';
    pushUndo('snap');
    state.dungeon.metadata.dungeonName = 'After';
    const parsed = JSON.parse(state.undoStack[0].json);
    expect(parsed.metadata.dungeonName).toBe('Before');
  });

  it('records performance timing in _lastPushUndoMs', () => {
    pushUndo('timed');
    expect(state._lastPushUndoMs).toBeDefined();
    expect(typeof state._lastPushUndoMs.stringify).toBe('number');
    expect(typeof state._lastPushUndoMs.total).toBe('number');
  });
});

describe('undo', () => {
  beforeEach(() => freshState());

  it('restores the previous dungeon state', () => {
    state.dungeon.metadata.dungeonName = 'Original';
    pushUndo('before rename');
    state.dungeon.metadata.dungeonName = 'Changed';

    undo();
    expect(state.dungeon.metadata.dungeonName).toBe('Original');
  });

  it('pushes current state onto redo stack', () => {
    pushUndo('a');
    state.dungeon.metadata.dungeonName = 'Current';
    undo();
    expect(state.redoStack.length).toBe(1);
    const redoParsed = JSON.parse(state.redoStack[0].json);
    expect(redoParsed.metadata.dungeonName).toBe('Current');
  });

  it('removes the entry from the undo stack', () => {
    pushUndo('a');
    pushUndo('b');
    expect(state.undoStack.length).toBe(2);
    undo();
    expect(state.undoStack.length).toBe(1);
  });

  it('is a no-op when undo stack is empty', () => {
    const dungeonBefore = JSON.stringify(state.dungeon);
    undo();
    expect(JSON.stringify(state.dungeon)).toBe(dungeonBefore);
    expect(state.redoStack.length).toBe(0);
  });

  it('marks state dirty after undo', () => {
    pushUndo('a');
    state.dirty = false;
    state.unsavedChanges = false;
    undo();
    expect(state.dirty).toBe(true);
    expect(state.unsavedChanges).toBe(true);
  });

  it('calls notify after undo', () => {
    const spy = vi.fn();
    subscribe(spy);
    pushUndo('a');
    spy.mockClear();
    undo();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('multiple undos in sequence restore correct states', () => {
    state.dungeon.metadata.dungeonName = 'V1';
    pushUndo('v1');
    state.dungeon.metadata.dungeonName = 'V2';
    pushUndo('v2');
    state.dungeon.metadata.dungeonName = 'V3';

    undo(); // back to V2
    expect(state.dungeon.metadata.dungeonName).toBe('V2');
    undo(); // back to V1
    expect(state.dungeon.metadata.dungeonName).toBe('V1');
  });
});

describe('redo', () => {
  beforeEach(() => freshState());

  it('re-applies the last undone state', () => {
    state.dungeon.metadata.dungeonName = 'Original';
    pushUndo('a');
    state.dungeon.metadata.dungeonName = 'Changed';
    undo();
    expect(state.dungeon.metadata.dungeonName).toBe('Original');
    redo();
    expect(state.dungeon.metadata.dungeonName).toBe('Changed');
  });

  it('is a no-op when redo stack is empty', () => {
    const dungeonBefore = JSON.stringify(state.dungeon);
    redo();
    expect(JSON.stringify(state.dungeon)).toBe(dungeonBefore);
  });

  it('pushes current state onto undo stack', () => {
    pushUndo('a');
    undo();
    const undoLenBefore = state.undoStack.length;
    redo();
    expect(state.undoStack.length).toBe(undoLenBefore + 1);
  });

  it('marks state dirty after redo', () => {
    pushUndo('a');
    undo();
    state.dirty = false;
    state.unsavedChanges = false;
    redo();
    expect(state.dirty).toBe(true);
    expect(state.unsavedChanges).toBe(true);
  });

  it('calls notify after redo', () => {
    const spy = vi.fn();
    subscribe(spy);
    pushUndo('a');
    undo();
    spy.mockClear();
    redo();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('redo stack clears when a new pushUndo occurs after undo', () => {
    state.dungeon.metadata.dungeonName = 'V1';
    pushUndo('a');
    state.dungeon.metadata.dungeonName = 'V2';
    undo();
    // redo stack has one entry
    expect(state.redoStack.length).toBe(1);
    // new action clears redo
    pushUndo('b');
    expect(state.redoStack.length).toBe(0);
  });

  it('multiple redo calls in sequence restore in correct order', () => {
    state.dungeon.metadata.dungeonName = 'V1';
    pushUndo('v1');
    state.dungeon.metadata.dungeonName = 'V2';
    pushUndo('v2');
    state.dungeon.metadata.dungeonName = 'V3';

    undo(); // V2
    undo(); // V1
    redo(); // V2
    expect(state.dungeon.metadata.dungeonName).toBe('V2');
    redo(); // V3
    expect(state.dungeon.metadata.dungeonName).toBe('V3');
  });

  it('full undo/redo cycle preserves data integrity', () => {
    state.dungeon.metadata.dungeonName = 'Start';
    pushUndo('start');
    state.dungeon.cells[0][0] = { north: 'w', south: 'w', east: 'w', west: 'w' };
    pushUndo('paint');
    state.dungeon.metadata.dungeonName = 'End';

    undo(); // back to after paint (cells[0][0] set)
    undo(); // back to Start (cells[0][0] null)
    expect(state.dungeon.metadata.dungeonName).toBe('Start');
    expect(state.dungeon.cells[0][0]).toBeNull();

    redo(); // after paint
    expect(state.dungeon.cells[0][0]).toEqual({ north: 'w', south: 'w', east: 'w', west: 'w' });
    redo(); // End
    expect(state.dungeon.metadata.dungeonName).toBe('End');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. markDirty / clearDirty
// ═══════════════════════════════════════════════════════════════════════════

describe('markDirty / clearDirty', () => {
  beforeEach(() => freshState());

  it('markDirty sets dirty flag to true', () => {
    state.dirty = false;
    markDirty();
    expect(state.dirty).toBe(true);
  });

  it('markDirty sets unsavedChanges to true', () => {
    state.unsavedChanges = false;
    markDirty();
    expect(state.unsavedChanges).toBe(true);
  });

  it('clearDirty resets dirty to false', () => {
    state.dirty = true;
    clearDirty();
    expect(state.dirty).toBe(false);
  });

  it('clearDirty does NOT reset unsavedChanges', () => {
    markDirty();
    clearDirty();
    expect(state.unsavedChanges).toBe(true);
  });

  it('markDirty is idempotent', () => {
    markDirty();
    markDirty();
    markDirty();
    expect(state.dirty).toBe(true);
    expect(state.unsavedChanges).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. notify / subscribe
// ═══════════════════════════════════════════════════════════════════════════

describe('subscribe / notify', () => {
  beforeEach(() => freshState());

  it('subscribe adds a listener', () => {
    const fn = vi.fn();
    subscribe(fn);
    expect(state.listeners.length).toBe(1);
  });

  it('notify calls all subscribers', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    subscribe(fn1);
    subscribe(fn2);
    notify();
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('subscriber receives the state object as argument', () => {
    const fn = vi.fn();
    subscribe(fn);
    notify();
    expect(fn).toHaveBeenCalledWith(state);
  });

  it('subscribe stores an optional label for timing diagnostics', () => {
    const fn = vi.fn();
    subscribe(fn, 'my-label');
    expect(state.listeners[0].label).toBe('my-label');
  });

  it('subscribe defaults label to "unknown" when not provided', () => {
    const fn = vi.fn();
    subscribe(fn);
    expect(state.listeners[0].label).toBe('unknown');
  });

  it('notify updates notifyTimings', () => {
    const fn = vi.fn();
    subscribe(fn, 'test-sub');
    const frameBefore = notifyTimings.frame;
    notify();
    expect(notifyTimings.frame).toBe(frameBefore + 1);
    expect(notifyTimings.subscribers.length).toBe(1);
    expect(notifyTimings.subscribers[0].label).toBe('test-sub');
    expect(typeof notifyTimings.total).toBe('number');
  });

  it('notify increments frame counter each call', () => {
    const frameBefore = notifyTimings.frame;
    notify();
    notify();
    notify();
    expect(notifyTimings.frame).toBe(frameBefore + 3);
  });

  it('removing a listener manually prevents future calls', () => {
    const fn = vi.fn();
    subscribe(fn);
    notify();
    expect(fn).toHaveBeenCalledTimes(1);

    // Manual removal (subscribe does not return unsubscribe)
    state.listeners.length = 0;
    notify();
    expect(fn).toHaveBeenCalledTimes(1); // not called again
  });

  it('multiple subscribers are all called in order', () => {
    const order = [];
    subscribe(() => order.push('A'), 'A');
    subscribe(() => order.push('B'), 'B');
    subscribe(() => order.push('C'), 'C');
    notify();
    expect(order).toEqual(['A', 'B', 'C']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. invalidateLightmap
// ═══════════════════════════════════════════════════════════════════════════

describe('invalidateLightmap', () => {
  beforeEach(() => {
    freshState();
    vi.mocked(invalidateVisibilityCache).mockClear();
  });

  it('calls invalidateVisibilityCache with true by default', () => {
    invalidateLightmap();
    expect(invalidateVisibilityCache).toHaveBeenCalledWith(true);
  });

  it('passes structuralChange argument through', () => {
    invalidateLightmap(false);
    expect(invalidateVisibilityCache).toHaveBeenCalledWith(false);
  });

  it('passes "props" argument through', () => {
    invalidateLightmap('props');
    expect(invalidateVisibilityCache).toHaveBeenCalledWith('props');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. getTheme
// ═══════════════════════════════════════════════════════════════════════════

describe('getTheme', () => {
  beforeEach(() => freshState());

  it('returns theme object for a known theme string', () => {
    state.dungeon.metadata.theme = 'stone-dungeon';
    const theme = getTheme();
    expect(theme).toBe(THEMES['stone-dungeon']);
  });

  it('returns blue-parchment as fallback for unknown theme string', () => {
    state.dungeon.metadata.theme = 'nonexistent-theme';
    const theme = getTheme();
    expect(theme).toBe(THEMES['blue-parchment']);
  });

  it('returns savedThemeData for user: prefix with embedded data', () => {
    const customTheme = { name: 'Custom', wallColor: '#000' };
    state.dungeon.metadata.theme = 'user:my-custom';
    state.dungeon.metadata.savedThemeData = { theme: customTheme };
    const theme = getTheme();
    expect(theme).toBe(customTheme);
  });

  it('falls back to blue-parchment for user: prefix without saved data', () => {
    state.dungeon.metadata.theme = 'user:missing';
    const theme = getTheme();
    expect(theme).toBe(THEMES['blue-parchment']);
  });

  it('returns theme object directly if metadata.theme is an object', () => {
    const inlineTheme = { wallColor: '#333', gridColor: '#999' };
    state.dungeon.metadata.theme = inlineTheme;
    const theme = getTheme();
    expect(theme).toBe(inlineTheme);
  });

  it('returns blue-parchment for null theme', () => {
    state.dungeon.metadata.theme = null;
    const theme = getTheme();
    expect(theme).toBe(THEMES['blue-parchment']);
  });

  it('returns blue-parchment for undefined theme', () => {
    state.dungeon.metadata.theme = undefined;
    const theme = getTheme();
    expect(theme).toBe(THEMES['blue-parchment']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. setUndoDisabled
// ═══════════════════════════════════════════════════════════════════════════

describe('setUndoDisabled', () => {
  beforeEach(() => freshState());

  it('when disabled, pushUndo is a no-op', () => {
    setUndoDisabled(true);
    pushUndo('should not appear');
    expect(state.undoStack.length).toBe(0);
  });

  it('re-enabling allows pushUndo to work again', () => {
    setUndoDisabled(true);
    pushUndo('no');
    setUndoDisabled(false);
    pushUndo('yes');
    expect(state.undoStack.length).toBe(1);
    expect(state.undoStack[0].label).toBe('yes');
  });

  it('does not affect undo/redo operations', () => {
    pushUndo('a');
    setUndoDisabled(true);
    // undo should still work even with pushUndo disabled
    state.dungeon.metadata.dungeonName = 'Changed';
    undo();
    expect(state.dungeon.metadata.dungeonName).toBe('Test');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. jumpToState
// ═══════════════════════════════════════════════════════════════════════════

describe('jumpToState', () => {
  beforeEach(() => freshState());

  it('restores dungeon to the target undo stack entry', () => {
    state.dungeon.metadata.dungeonName = 'V1';
    pushUndo('v1');
    state.dungeon.metadata.dungeonName = 'V2';
    pushUndo('v2');
    state.dungeon.metadata.dungeonName = 'V3';
    pushUndo('v3');
    state.dungeon.metadata.dungeonName = 'Current';

    // Jump to index 0 (V1)
    jumpToState(0);
    expect(state.dungeon.metadata.dungeonName).toBe('V1');
  });

  it('moves entries above target to redo stack', () => {
    pushUndo('a');
    pushUndo('b');
    pushUndo('c');
    // Stack: [a, b, c]
    jumpToState(0);
    // 'a' is restored (popped from undo), 'b' and 'c' moved to redo, plus current
    // redo should have: current + c + b = 3 entries
    expect(state.redoStack.length).toBe(3);
  });

  it('is a no-op for negative index', () => {
    pushUndo('a');
    const dungeonBefore = JSON.stringify(state.dungeon);
    jumpToState(-1);
    expect(JSON.stringify(state.dungeon)).toBe(dungeonBefore);
  });

  it('is a no-op for index >= stack length', () => {
    pushUndo('a');
    const dungeonBefore = JSON.stringify(state.dungeon);
    jumpToState(5);
    expect(JSON.stringify(state.dungeon)).toBe(dungeonBefore);
  });

  it('marks dirty and notifies after jump', () => {
    const spy = vi.fn();
    subscribe(spy);
    pushUndo('a');
    state.dirty = false;
    state.unsavedChanges = false;
    spy.mockClear();

    jumpToState(0);
    expect(state.dirty).toBe(true);
    expect(state.unsavedChanges).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('jump to last index behaves like a single undo', () => {
    state.dungeon.metadata.dungeonName = 'V1';
    pushUndo('v1');
    state.dungeon.metadata.dungeonName = 'V2';
    pushUndo('v2');
    state.dungeon.metadata.dungeonName = 'Current';

    jumpToState(1); // jump to v2
    expect(state.dungeon.metadata.dungeonName).toBe('V2');
    // redo stack: current state pushed
    expect(state.redoStack.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. loadAutosave
// ═══════════════════════════════════════════════════════════════════════════

describe('loadAutosave', () => {
  beforeEach(() => freshState());

  it('returns false when no autosave exists', async () => {
    // IndexedDB is mocked/unavailable in test env, localStorage is empty
    const result = await loadAutosave();
    expect(typeof result).toBe('boolean');
  });

  it('loads from localStorage fallback when IndexedDB fails', async () => {
    const saved = {
      dungeon: createEmptyDungeon('Saved', 10, 10, 5, 'stone-dungeon', 1),
      currentLevel: 0,
      activeTool: 'wall',
      zoom: 2.0,
      panX: 100,
      panY: 200,
    };
    // Ensure dungeon has metadata and cells for validation
    localStorage.setItem('dungeon-editor-autosave', JSON.stringify(saved));

    const result = await loadAutosave();
    if (result) {
      expect(state.dungeon.metadata.dungeonName).toBe('Saved');
      expect(state.activeTool).toBe('wall');
      expect(state.zoom).toBe(2.0);
      expect(state.panX).toBe(100);
      expect(state.panY).toBe(200);
    }
    // Clean up
    localStorage.removeItem('dungeon-editor-autosave');
  });

  it('rejects invalid localStorage data (no metadata)', async () => {
    localStorage.setItem('dungeon-editor-autosave', JSON.stringify({ dungeon: { cells: [] } }));
    const result = await loadAutosave();
    // Should return false because metadata is missing
    expect(result).toBe(false);
    localStorage.removeItem('dungeon-editor-autosave');
  });

  it('rejects invalid localStorage data (no cells)', async () => {
    localStorage.setItem('dungeon-editor-autosave', JSON.stringify({ dungeon: { metadata: {} } }));
    const result = await loadAutosave();
    expect(result).toBe(false);
    localStorage.removeItem('dungeon-editor-autosave');
  });

  it('handles corrupt JSON in localStorage gracefully', async () => {
    localStorage.setItem('dungeon-editor-autosave', '{broken json!!!');
    const result = await loadAutosave();
    expect(result).toBe(false);
    localStorage.removeItem('dungeon-editor-autosave');
  });

  it('defaults activeTool when not in saved data', async () => {
    const saved = {
      dungeon: createEmptyDungeon('Saved', 10, 10, 5, 'stone-dungeon', 1),
      currentLevel: 0,
    };
    localStorage.setItem('dungeon-editor-autosave', JSON.stringify(saved));
    const result = await loadAutosave();
    if (result) {
      expect(state.activeTool).toBe('room'); // default fallback
    }
    localStorage.removeItem('dungeon-editor-autosave');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Singleton behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('Singleton behavior', () => {
  beforeEach(() => freshState());

  it('default export and named exports operate on the same object', () => {
    state.dungeon.metadata.dungeonName = 'Singleton';
    pushUndo('x');
    expect(state.undoStack.length).toBe(1);
    const parsed = JSON.parse(state.undoStack[0].json);
    expect(parsed.metadata.dungeonName).toBe('Singleton');
  });

  it('mutations to state.dungeon persist across function calls', () => {
    state.dungeon.cells[0][0] = { north: 'w' };
    markDirty();
    expect(state.dirty).toBe(true);
    expect(state.dungeon.cells[0][0]).toEqual({ north: 'w' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Hybrid undo (patch / snapshot)
// ═══════════════════════════════════════════════════════════════════════════

describe('hybrid undo', () => {
  beforeEach(() => freshState());

  // ── mutate() stores compact patches for cell-level changes ──────────

  it('mutate() stores a compact patch (not full JSON) for cell changes', () => {
    state.dungeon.cells[2][3] = { north: 'w' };
    mutate('paint cell', [{ row: 2, col: 3 }], () => {
      state.dungeon.cells[2][3] = { north: 'w', east: 'd' };
    });

    expect(state.undoStack.length).toBe(1);
    const entry = state.undoStack[0];
    // Should be a patch entry, not a full JSON snapshot
    expect(entry.patch).toBeDefined();
    expect(entry.json).toBeUndefined();
    expect(entry.patch!.cells.length).toBe(1);
    expect(entry.patch!.cells[0].row).toBe(2);
    expect(entry.patch!.cells[0].col).toBe(3);
    expect(entry.patch!.cells[0].before).toEqual({ north: 'w' });
    expect(entry.patch!.cells[0].after).toEqual({ north: 'w', east: 'd' });
  });

  it('patch entry captures null → object transition', () => {
    // Cell starts as null (void)
    expect(state.dungeon.cells[5][5]).toBeNull();
    mutate('create cell', [{ row: 5, col: 5 }], () => {
      state.dungeon.cells[5][5] = { south: 'w' };
    });

    const patch = state.undoStack[0].patch!;
    expect(patch.cells[0].before).toBeNull();
    expect(patch.cells[0].after).toEqual({ south: 'w' });
  });

  it('patch entry captures object → null transition', () => {
    state.dungeon.cells[3][3] = { west: 'd' };
    mutate('erase cell', [{ row: 3, col: 3 }], () => {
      state.dungeon.cells[3][3] = null;
    });

    const patch = state.undoStack[0].patch!;
    expect(patch.cells[0].before).toEqual({ west: 'd' });
    expect(patch.cells[0].after).toBeNull();
  });

  // ── Keyframe interval ──────────────────────────────────────────────────

  it('stores a full keyframe snapshot every KEYFRAME_INTERVAL entries', () => {
    // KEYFRAME_INTERVAL is 10. The keyframe triggers when
    // _entriesSinceKeyframe() >= 10, which happens on the 11th mutate
    // (after 10 patches are already in the stack).
    for (let i = 0; i < 11; i++) {
      mutate(`action-${i}`, [{ row: 0, col: 0 }], () => {
        state.dungeon.cells[0][0] = { north: `v${i}` } as Record<string, unknown>;
      });
    }

    expect(state.undoStack.length).toBe(11);
    // Entries 0-9 should be patches
    for (let i = 0; i < 10; i++) {
      expect(state.undoStack[i].patch).toBeDefined();
      expect(state.undoStack[i].json).toBeUndefined();
    }
    // Entry 10 (11th mutate) should be a full keyframe
    expect(state.undoStack[10].json).toBeDefined();
    expect(state.undoStack[10].patch).toBeUndefined();
  });

  it('metadata-only changes (empty coords) always store full snapshots', () => {
    mutate('rename', [], () => {
      state.dungeon.metadata.dungeonName = 'Renamed';
    });

    expect(state.undoStack.length).toBe(1);
    const entry = state.undoStack[0];
    expect(entry.json).toBeDefined();
    expect(entry.patch).toBeUndefined();
  });

  // ── Undo reverses a patch entry ────────────────────────────────────────

  it('undo reverses a patch entry (cells restored to before-state)', () => {
    state.dungeon.cells[4][4] = { north: 'w', south: 'w' };
    mutate('modify', [{ row: 4, col: 4 }], () => {
      state.dungeon.cells[4][4] = { north: 'w', south: 'w', east: 'd' };
    });

    expect(state.dungeon.cells[4][4]).toEqual({ north: 'w', south: 'w', east: 'd' });

    undo();

    // Should be back to before-state
    expect(state.dungeon.cells[4][4]).toEqual({ north: 'w', south: 'w' });
  });

  it('undo restores null cells correctly', () => {
    expect(state.dungeon.cells[7][7]).toBeNull();
    mutate('create', [{ row: 7, col: 7 }], () => {
      state.dungeon.cells[7][7] = { west: 'w' };
    });
    expect(state.dungeon.cells[7][7]).not.toBeNull();

    undo();
    expect(state.dungeon.cells[7][7]).toBeNull();
  });

  // ── Redo re-applies a patch entry ──────────────────────────────────────

  it('redo after undo of a patch restores undo stack symmetry', () => {
    state.dungeon.cells[1][1] = { north: 'w' };
    mutate('modify', [{ row: 1, col: 1 }], () => {
      state.dungeon.cells[1][1] = { north: 'w', east: 'd' };
    });

    // Verify patch is on the undo stack
    expect(state.undoStack.length).toBe(1);
    expect(state.undoStack[0].patch).toBeDefined();

    undo();
    expect(state.dungeon.cells[1][1]).toEqual({ north: 'w' });
    expect(state.redoStack.length).toBe(1);

    // Redo pushes an entry back onto the undo stack
    redo();
    expect(state.undoStack.length).toBe(1);
    expect(state.redoStack.length).toBe(0);
  });

  // ── Mixed undo/redo across patch and snapshot entries ──────────────────

  it('mixed undo across patch and keyframe entries', () => {
    // Build up 12 actions: 10 patches + 1 keyframe + 1 patch
    state.dungeon.cells[0][0] = {};
    for (let i = 0; i < 12; i++) {
      mutate(`action-${i}`, [{ row: 0, col: 0 }], () => {
        state.dungeon.cells[0][0] = { north: `v${i}` } as Record<string, unknown>;
      });
    }

    // Current state: cells[0][0] = { north: 'v11' }
    expect((state.dungeon.cells[0][0] as Record<string, unknown>).north).toBe('v11');

    // Entry [10] is a keyframe, [11] is a patch.
    expect(state.undoStack[10].json).toBeDefined();
    expect(state.undoStack[11].patch).toBeDefined();

    // Undo last action (patch) → v10
    undo();
    expect((state.dungeon.cells[0][0] as Record<string, unknown>).north).toBe('v10');

    // Undo the keyframe → restores the snapshot (state as of v9)
    undo();
    expect((state.dungeon.cells[0][0] as Record<string, unknown>).north).toBe('v9');

    // Undo a patch → v8
    undo();
    expect((state.dungeon.cells[0][0] as Record<string, unknown>).north).toBe('v8');
  });

  it('multiple undos across a keyframe boundary', () => {
    state.dungeon.cells[0][0] = {};
    // Push 10 patches (no keyframe yet — keyframe would be the 11th)
    for (let i = 0; i < 10; i++) {
      mutate(`a-${i}`, [{ row: 0, col: 0 }], () => {
        state.dungeon.cells[0][0] = { north: `s${i}` } as Record<string, unknown>;
      });
    }

    // All 10 entries should be patches
    expect(state.undoStack.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(state.undoStack[i].patch).toBeDefined();
    }

    // Undo all 10 entries
    for (let i = 0; i < 10; i++) {
      undo();
    }

    // Should be back to original empty cell
    expect(state.dungeon.cells[0][0]).toEqual({});
    expect(state.undoStack.length).toBe(0);
    expect(state.redoStack.length).toBe(10);
  });

  // ── pushUndo (non-mutate path) still stores full snapshots ─────────────

  it('pushUndo() always stores a full JSON snapshot', () => {
    state.dungeon.metadata.dungeonName = 'Before Push';
    pushUndo('manual snapshot');

    expect(state.undoStack.length).toBe(1);
    const entry = state.undoStack[0];
    expect(entry.json).toBeDefined();
    expect(entry.patch).toBeUndefined();

    const parsed = JSON.parse(entry.json!);
    expect(parsed.metadata.dungeonName).toBe('Before Push');
  });

  it('pushUndo() entries integrate correctly with mutate() patch entries', () => {
    // pushUndo captures the current state as a full snapshot
    state.dungeon.metadata.dungeonName = 'Original';
    pushUndo('snapshot');

    // Modify metadata + paint a cell after the snapshot
    state.dungeon.metadata.dungeonName = 'Modified';
    state.dungeon.cells[0][0] = { north: 'w' };

    // mutate → patch (since pushUndo just added a keyframe, _entriesSinceKeyframe()=0)
    mutate('paint', [{ row: 0, col: 0 }], () => {
      state.dungeon.cells[0][0] = { north: 'w', east: 'd' };
    });

    expect(state.undoStack.length).toBe(2);
    expect(state.undoStack[0].json).toBeDefined();  // full snapshot
    expect(state.undoStack[1].patch).toBeDefined();  // compact patch

    // Undo the patch — restores cells to before-state
    undo();
    expect(state.dungeon.cells[0][0]).toEqual({ north: 'w' });

    // Undo the snapshot — restores full dungeon to 'Original' state
    undo();
    expect(state.dungeon.metadata.dungeonName).toBe('Original');
    expect(state.dungeon.cells[0][0]).toBeNull(); // was null when snapshot was taken
  });

  // ── Deep copy isolation in patches ─────────────────────────────────────

  it('patch before/after are deep copies — mutations do not affect undo data', () => {
    state.dungeon.cells[2][2] = { north: 'w', center: { label: 'A1' } };
    mutate('modify', [{ row: 2, col: 2 }], () => {
      state.dungeon.cells[2][2] = { north: 'w', east: 'd', center: { label: 'A1' } };
    });

    // Mutate the live cell
    (state.dungeon.cells[2][2] as Record<string, unknown>).north = 'MUTATED';

    // The patch's after-state should still have the original value
    const afterState = state.undoStack[0].patch!.cells[0].after as Record<string, unknown>;
    expect(afterState.north).toBe('w');
    expect(afterState.east).toBe('d');
  });

  // ── Metadata changes in patches ────────────────────────────────────────

  it('captures metadata changes when they occur during mutate()', () => {
    mutate('rename and paint', [{ row: 0, col: 0 }], () => {
      state.dungeon.cells[0][0] = { west: 'w' };
      state.dungeon.metadata.dungeonName = 'Changed During Mutate';
    });

    const entry = state.undoStack[0];
    expect(entry.patch).toBeDefined();
    expect(entry.patch!.meta).not.toBeNull();
    expect(entry.patch!.meta!.before).toBeDefined();
    expect(entry.patch!.meta!.after).toBeDefined();

    const afterMeta = JSON.parse(entry.patch!.meta!.after);
    expect(afterMeta.dungeonName).toBe('Changed During Mutate');
  });

  it('does not store metadata patch when metadata is unchanged', () => {
    state.dungeon.cells[1][1] = { north: 'w' };
    mutate('cell only', [{ row: 1, col: 1 }], () => {
      state.dungeon.cells[1][1] = { north: 'w', south: 'd' };
    });

    const entry = state.undoStack[0];
    expect(entry.patch!.meta).toBeNull();
  });

  // ── Undo marks dirty and notifies ──────────────────────────────────────

  it('undo of patch entry marks dirty and notifies', () => {
    const spy = vi.fn();
    subscribe(spy);

    mutate('action', [{ row: 0, col: 0 }], () => {
      state.dungeon.cells[0][0] = {};
    });
    spy.mockClear();
    state.dirty = false;

    undo();
    expect(state.dirty).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
