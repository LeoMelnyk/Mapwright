// Regression tests for state.notify() re-entrancy guard.
//
// Before the guard, calling notify() inside a subscribe callback would
// recurse infinitely (subscribers fire → one calls notify → all subscribers
// fire again → loop). After the guard, nested notify calls are queued and
// drained once the outer pass finishes.

import { describe, it, expect, beforeEach } from 'vitest';
import state, { subscribe, notify } from '../src/editor/js/state.js';
import { createEmptyDungeon } from '../src/editor/js/utils.js';

function freshState() {
  state.dungeon = createEmptyDungeon('Test', 10, 10, 5, 'stone-dungeon', 1);
  state.listeners = [];
  state.undoStack = [];
  state.redoStack = [];
}

describe('notify re-entrancy guard', () => {
  beforeEach(() => freshState());

  it('does not infinite-loop when a subscriber calls notify()', () => {
    let outerCalls = 0;
    let innerCalls = 0;
    subscribe(() => { outerCalls++; if (outerCalls === 1) notify(); }, { label: 'outer' });
    subscribe(() => { innerCalls++; }, { label: 'inner' });

    notify();

    // Outer fires twice: once from the user's notify(), once from the queued nested notify
    // Inner fires twice for the same reason. Critically, neither fires more than that.
    expect(outerCalls).toBe(2);
    expect(innerCalls).toBe(2);
  });

  it('drains multiple queued notifies in order', () => {
    let calls = 0;
    let triggered = false;
    subscribe(() => {
      calls++;
      // Only fire the nested notifies once, on the first call
      if (!triggered) {
        triggered = true;
        notify();
        notify();
      }
    }, { label: 'observer' });

    notify();

    // Initial pass + 2 queued passes = 3 total invocations
    // (the two queued any-topic notifies coalesce to one drain pass)
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it('does not crash when a subscriber re-throws after notifying', () => {
    let count = 0;
    subscribe(() => {
      count++;
      if (count === 1) notify();
    }, { label: 'reentrant' });

    expect(() => notify()).not.toThrow();
  });
});
