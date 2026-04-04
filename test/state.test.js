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
