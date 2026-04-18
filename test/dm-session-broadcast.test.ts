// Unit tests for the DM→player session broadcast gate in
// src/editor/js/dm-session-broadcast.ts.
//
// The gate must fire a debounced `dungeon:update` message whenever the
// dungeon's content, lighting, or overlay-prop state changes — including
// light-only and prop-only mutations that go through the metaOnly path
// and never bump contentVersion.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

import state, { notify } from '../src/editor/js/state.js';
import { createEmptyDungeon } from '../src/editor/js/utils.js';
import { sessionState } from '../src/editor/js/dm-session-state.js';
import { onPropSpatialDirty } from '../src/editor/js/prop-spatial.js';
import { snapshotBroadcastBaseline, startDungeonBroadcast } from '../src/editor/js/dm-session-broadcast.js';
import { placeLight, removeLight, setAmbientLight, setLightingEnabled } from '../src/editor/js/api/lighting.js';
import { placeProp, removeProp, rotateProp } from '../src/editor/js/api/props.js';
import { setWall, removeWall, setDoor, removeDoor } from '../src/editor/js/api/walls-doors.js';
import { paintCell, paintRect, eraseCell } from '../src/editor/js/api/cells.js';
import { setLabel, removeLabel } from '../src/editor/js/api/labels.js';
import { setTexture, setTextureRect } from '../src/editor/js/api/textures.js';
import { setFill, removeFill, setFillRect, setHazard } from '../src/editor/js/api/fills.js';
import { addStairs, removeStairs, addBridge } from '../src/editor/js/api/stairs-bridges.js';
import {
  getContentVersion,
  getLightingVersion,
  getPropsVersion,
  invalidateVisibilityCache,
  invalidatePropsRenderLayer,
  smartInvalidate,
} from '../src/render/index.js';

// ── Stateful version counters ──────────────────────────────────────────────
// test/setup.ts mocks the render pipeline with no-op stubs. We install
// stateful behavior here so that invalidateVisibilityCache / smartInvalidate /
// invalidatePropsRenderLayer bump their respective counters the way the
// real modules do. Both the editor-api code (via mutate()) and
// dm-session-broadcast.ts read through these same mocked bindings, so a
// single shared counter object keeps them in sync.
const versions = { contentV: 0, lightingV: 0, propsV: 0 };

vi.mocked(getContentVersion).mockImplementation(() => versions.contentV);
vi.mocked(getLightingVersion).mockImplementation(() => versions.lightingV);
vi.mocked(getPropsVersion).mockImplementation(() => versions.propsV);
vi.mocked(smartInvalidate).mockImplementation(() => {
  versions.contentV++;
});
vi.mocked(invalidateVisibilityCache).mockImplementation(() => {
  versions.lightingV++;
});
vi.mocked(invalidatePropsRenderLayer).mockImplementation(() => {
  versions.propsV++;
});

// ── Helpers ────────────────────────────────────────────────────────────────

type WsStub = { readyState: number; send: Mock };

function setupCatalogs() {
  state.propCatalog = {
    categories: ['features', 'structure'],
    props: {
      pillar: {
        name: 'pillar',
        category: 'structure',
        footprint: [1, 1],
        facing: false,
        placement: 'corner',
        roomTypes: ['any'],
        typicalCount: '4',
        clustersWith: [],
        notes: null,
      },
      brazier: {
        name: 'brazier',
        category: 'features',
        footprint: [1, 1],
        facing: false,
        placement: 'wall',
        roomTypes: ['any'],
        typicalCount: '2',
        clustersWith: [],
        lights: [{ preset: 'brazier', x: 0.5, y: 0.5 }],
        notes: null,
      },
    },
  } as unknown as typeof state.propCatalog;
  state.lightCatalog = {
    categories: ['fire'],
    lights: {
      torch: {
        displayName: 'Torch',
        category: 'fire',
        type: 'point',
        radius: 20,
        color: '#ff8833',
        intensity: 1,
        falloff: 'smooth',
      },
      brazier: {
        displayName: 'Brazier',
        category: 'fire',
        type: 'point',
        radius: 22,
        color: '#ff8844',
        intensity: 1,
        falloff: 'smooth',
      },
    },
  } as unknown as typeof state.lightCatalog;
}

function resetSession(ws: WsStub) {
  sessionState.active = true;
  sessionState.ws = ws as unknown as WebSocket;
  sessionState.token = null;
  sessionState.revealedCells = new Set();
  sessionState.openedDoors = [];
  sessionState.openedStairs = [];
  sessionState.startingRoom = null;
  sessionState.playerCount = 0;
  sessionState.dmViewActive = false;
  sessionState.dmViewForced = false;
}

function lastSentMessage(ws: WsStub): Record<string, unknown> | null {
  const calls = ws.send.mock.calls;
  if (!calls.length) return null;
  return JSON.parse(calls[calls.length - 1][0] as string) as Record<string, unknown>;
}

/**
 * Advance past the debounce, assert exactly one dungeon:update was sent,
 * and return its changeHints for further assertions.
 */
function advanceAndGetHints(ws: WsStub): Record<string, unknown> {
  vi.advanceTimersByTime(1000);
  expect(ws.send).toHaveBeenCalledTimes(1);
  const msg = lastSentMessage(ws)!;
  expect(msg.type).toBe('dungeon:update');
  return msg.changeHints as Record<string, unknown>;
}

// ── Test harness ───────────────────────────────────────────────────────────

let ws: WsStub;

beforeEach(() => {
  vi.useFakeTimers();

  state.dungeon = createEmptyDungeon('Test', 20, 20, 5, 'stone-dungeon', 1);
  state.currentLevel = 0;
  state.undoStack = [];
  state.redoStack = [];
  state.listeners = [];
  state.dirty = false;
  state.unsavedChanges = false;
  setupCatalogs();

  // Paint an open floor region so props/walls can be placed.
  paintRect(1, 1, 10, 10);

  // Wire the prop-spatial dirty callback to bump propsVersion.
  // Real code does this inside initApp; tests bypass initApp.
  onPropSpatialDirty(() => invalidatePropsRenderLayer());

  // Reset version counters to zero after setup mutations so each test
  // starts from a known baseline.
  versions.contentV = 0;
  versions.lightingV = 0;
  versions.propsV = 0;

  ws = { readyState: 1, send: vi.fn() };
  resetSession(ws);

  // Establish the broadcast baseline (sets module-level _lastBroadcast*
  // to current zeroed counters) and register the dungeon broadcast
  // subscriber. Both are required for the gate to behave as in production.
  snapshotBroadcastBaseline();
  startDungeonBroadcast();
});

afterEach(() => {
  vi.useRealTimers();
  sessionState.active = false;
  sessionState.ws = null;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('startDungeonBroadcast gate', () => {
  it('fires a debounced dungeon:update with lightingChanged=true after placeLight', () => {
    placeLight(25, 25, { preset: 'torch' });

    // Before debounce elapses, no broadcast yet.
    expect(ws.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = lastSentMessage(ws)!;
    expect(msg.type).toBe('dungeon:update');
    const hints = msg.changeHints as Record<string, unknown>;
    expect(hints.lightingChanged).toBe(true);
  });

  it('fires dungeon:update with propsChanged=true after placing a non-light-emitting prop', () => {
    placeProp(5, 5, 'pillar');

    vi.advanceTimersByTime(1000);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = lastSentMessage(ws)!;
    expect(msg.type).toBe('dungeon:update');
    const hints = msg.changeHints as Record<string, unknown>;
    expect(hints.propsChanged).toBe(true);
  });

  it('fires a single broadcast with both flags when placing a light-emitting prop (brazier)', () => {
    placeProp(5, 5, 'brazier');

    vi.advanceTimersByTime(1000);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const hints = lastSentMessage(ws)!.changeHints as Record<string, unknown>;
    expect(hints.lightingChanged).toBe(true);
    expect(hints.propsChanged).toBe(true);
  });

  it('coalesces rapid light placements within the debounce window into one send', () => {
    placeLight(10, 10, { preset: 'torch' });
    placeLight(15, 15, { preset: 'torch' });
    placeLight(20, 20, { preset: 'torch' });
    placeLight(25, 25, { preset: 'torch' });

    // No send yet — debounce pending.
    expect(ws.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('fires dungeon:update after removeLight', () => {
    // Set up a light without tripping the gate: disable the session, place,
    // advance past any pending debounce, re-enable, then re-baseline.
    sessionState.active = false;
    const { id } = placeLight(30, 30, { preset: 'torch' });
    vi.advanceTimersByTime(2000);
    sessionState.active = true;
    ws.send.mockClear();
    snapshotBroadcastBaseline();

    removeLight(id);
    vi.advanceTimersByTime(1000);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const hints = lastSentMessage(ws)!.changeHints as Record<string, unknown>;
    expect(hints.lightingChanged).toBe(true);
  });

  it('fires dungeon:update after removeProp', () => {
    sessionState.active = false;
    placeProp(5, 5, 'pillar');
    vi.advanceTimersByTime(2000);
    sessionState.active = true;
    ws.send.mockClear();
    snapshotBroadcastBaseline();

    removeProp(5, 5);
    vi.advanceTimersByTime(1000);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const hints = lastSentMessage(ws)!.changeHints as Record<string, unknown>;
    expect(hints.propsChanged).toBe(true);
  });

  it('does not send anything when the session is inactive', () => {
    sessionState.active = false;

    placeLight(10, 10, { preset: 'torch' });
    placeProp(6, 6, 'pillar');
    setWall(4, 4, 'north');

    vi.advanceTimersByTime(5000);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('regression: still broadcasts on a cell-only edit (setWall)', () => {
    setWall(4, 4, 'north');

    vi.advanceTimersByTime(1000);

    expect(ws.send).toHaveBeenCalledTimes(1);
    const msg = lastSentMessage(ws)!;
    expect(msg.type).toBe('dungeon:update');
  });

  it('does not broadcast on pure viewport changes (pan/zoom)', () => {
    state.panX += 100;
    state.panY -= 50;
    state.zoom = 2.0;
    notify();

    vi.advanceTimersByTime(2000);
    expect(ws.send).not.toHaveBeenCalled();
  });
});

// ── Cell-coord mutation coverage ───────────────────────────────────────────
// Each of these goes through mutate() with coords, which calls
// smartInvalidate and bumps contentVersion — the original working path.
// These tests lock in that every such API triggers a broadcast.

describe('cell-coord mutations trigger a broadcast', () => {
  it('setDoor', () => {
    setDoor(3, 3, 'north');
    advanceAndGetHints(ws);
  });

  it('removeDoor', () => {
    setDoor(3, 3, 'north');
    vi.advanceTimersByTime(2000);
    ws.send.mockClear();
    snapshotBroadcastBaseline();

    removeDoor(3, 3, 'north');
    advanceAndGetHints(ws);
  });

  it('removeWall', () => {
    setWall(3, 3, 'east');
    vi.advanceTimersByTime(2000);
    ws.send.mockClear();
    snapshotBroadcastBaseline();

    removeWall(3, 3, 'east');
    advanceAndGetHints(ws);
  });

  it('paintCell (creating a new cell)', () => {
    paintCell(0, 0);
    advanceAndGetHints(ws);
  });

  it('eraseCell', () => {
    eraseCell(5, 5);
    advanceAndGetHints(ws);
  });

  it('setLabel', () => {
    setLabel(5, 5, 'A1');
    advanceAndGetHints(ws);
  });

  it('removeLabel', () => {
    setLabel(5, 5, 'A1');
    vi.advanceTimersByTime(2000);
    ws.send.mockClear();
    snapshotBroadcastBaseline();

    removeLabel(5, 5);
    advanceAndGetHints(ws);
  });

  it('setTexture', () => {
    setTexture(5, 5, 'polyhaven/cobblestone_floor_03');
    advanceAndGetHints(ws);
  });

  it('setTextureRect (single debounced broadcast for the whole rect)', () => {
    setTextureRect(2, 2, 6, 6, 'polyhaven/cobblestone_floor_03');
    advanceAndGetHints(ws);
  });

  it('setFill', () => {
    setFill(5, 5, 'water', 2);
    advanceAndGetHints(ws);
  });

  it('removeFill', () => {
    setFill(5, 5, 'pit');
    vi.advanceTimersByTime(2000);
    ws.send.mockClear();
    snapshotBroadcastBaseline();

    removeFill(5, 5);
    advanceAndGetHints(ws);
  });

  it('setFillRect', () => {
    setFillRect(2, 2, 5, 5, 'lava', 1);
    advanceAndGetHints(ws);
  });

  it('setHazard', () => {
    setHazard(5, 5, true);
    advanceAndGetHints(ws);
  });

  it('addStairs (bumps both contentVersion and lightingVersion)', () => {
    addStairs(3, 3, 3, 5, 4, 5);
    const hints = advanceAndGetHints(ws);
    // Stairs use invalidate: ['lighting'] on top of cell coords.
    expect(hints.lightingChanged).toBe(true);
  });

  it('removeStairs', () => {
    const { id: _id } = addStairs(3, 3, 3, 5, 4, 5);
    void _id;
    vi.advanceTimersByTime(2000);
    ws.send.mockClear();
    snapshotBroadcastBaseline();

    removeStairs(3, 3);
    advanceAndGetHints(ws);
  });

  it('addBridge (bumps both contentVersion and lightingVersion)', () => {
    addBridge('wood', 3, 3, 3, 5, 4, 5);
    const hints = advanceAndGetHints(ws);
    expect(hints.lightingChanged).toBe(true);
  });
});

// ── Metadata-only mutation coverage ────────────────────────────────────────
// These go through mutate() with metaOnly: true and invalidate: ['lighting'].
// The gate should still fire because the lightingVersion bumps.

describe('metadata-only lighting mutations trigger a broadcast', () => {
  it('setAmbientLight', () => {
    setAmbientLight(0.5);
    const hints = advanceAndGetHints(ws);
    expect(hints.lightingChanged).toBe(true);
  });

  it('setLightingEnabled', () => {
    setLightingEnabled(false);
    const hints = advanceAndGetHints(ws);
    expect(hints.lightingChanged).toBe(true);
  });
});

// ── Prop rotation coverage ─────────────────────────────────────────────────
// rotateProp is a metaOnly mutation on an existing prop. It should still
// trigger a broadcast through the props/lighting version bumps.

describe('prop overlay mutations trigger a broadcast', () => {
  it('rotateProp', () => {
    placeProp(5, 5, 'pillar');
    vi.advanceTimersByTime(2000);
    ws.send.mockClear();
    snapshotBroadcastBaseline();

    rotateProp(5, 5, 90);
    const hints = advanceAndGetHints(ws);
    expect(hints.propsChanged).toBe(true);
  });
});

// ── Debounce coalescing across mutation types ──────────────────────────────
// Multiple mutations that each independently would trip the gate must still
// coalesce into a single broadcast when they happen inside one 1000ms window.

describe('debounce coalescing across mutation types', () => {
  it('setWall + placeLight + placeProp within one window → one send with combined hints', () => {
    setWall(3, 3, 'north');
    placeLight(25, 25, { preset: 'torch' });
    placeProp(6, 6, 'pillar');

    expect(ws.send).not.toHaveBeenCalled();
    const hints = advanceAndGetHints(ws);
    expect(hints.lightingChanged).toBe(true);
    expect(hints.propsChanged).toBe(true);
  });

  it('setFill + setTexture + setLabel within one window → one send', () => {
    setFill(5, 5, 'water', 1);
    setTexture(5, 5, 'polyhaven/cobblestone_floor_03');
    setLabel(5, 5, 'A1');

    expect(ws.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('mutations spread across two separate windows produce two sends', () => {
    setWall(3, 3, 'north');
    vi.advanceTimersByTime(1000);
    expect(ws.send).toHaveBeenCalledTimes(1);

    setWall(4, 4, 'east');
    vi.advanceTimersByTime(1000);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });
});
