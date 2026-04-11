// Panel smoke tests.
//
// Panels are heavily DOM-coupled, so we can't test interactive behavior in
// the Node test environment. These smoke tests verify the panel API surface:
// pure-function helpers, callback setters, and that querying state from a
// stubbed DOM doesn't throw. They are intentionally minimal — the goal is to
// prevent panel modules from regressing into "throws on import" or "throws
// when called with no DOM context".

import { describe, it, expect, vi } from 'vitest';

// The test/setup.ts globals provide stubs for document/window with
// querySelector returning null and getElementById returning a fake.

describe('panels/sidebar', () => {
  it('module imports cleanly', async () => {
    const mod = await import('../src/editor/js/panels/sidebar.js');
    expect(typeof mod.init).toBe('function');
    expect(typeof mod.setPanelChangeCallback).toBe('function');
    expect(typeof mod.getActivePanel).toBe('function');
    expect(typeof mod.togglePanel).toBe('function');
  });

  it('getActivePanel returns null when no .icon-btn.active exists', async () => {
    const { getActivePanel } = await import('../src/editor/js/panels/sidebar.js');
    expect(getActivePanel()).toBeNull();
  });

  it('setPanelChangeCallback does not throw', async () => {
    const { setPanelChangeCallback } = await import('../src/editor/js/panels/sidebar.js');
    expect(() => setPanelChangeCallback(vi.fn())).not.toThrow();
  });

  it('togglePanel does not throw when no matching button exists', async () => {
    const { togglePanel } = await import('../src/editor/js/panels/sidebar.js');
    expect(() => togglePanel('nonexistent')).not.toThrow();
  });
});

describe('panels/right-sidebar', () => {
  it('module imports cleanly with the expected public surface', async () => {
    const mod = await import('../src/editor/js/panels/right-sidebar.js');
    expect(typeof mod.init).toBe('function');
    expect(typeof mod.setRightPanelChangeCallback).toBe('function');
    expect(typeof mod.getActiveRightPanel).toBe('function');
    expect(typeof mod.toggleRightPanel).toBe('function');
  });

  it('getActiveRightPanel returns null when no .right-icon-btn.active exists', async () => {
    const { getActiveRightPanel } = await import('../src/editor/js/panels/right-sidebar.js');
    expect(getActiveRightPanel()).toBeNull();
  });
});
