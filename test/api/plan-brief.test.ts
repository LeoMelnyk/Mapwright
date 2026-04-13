import { describe, it, expect, beforeEach } from 'vitest';
import state from '../../src/editor/js/state.js';
import { createEmptyDungeon } from '../../src/editor/js/utils.js';
import '../../src/editor/js/api/index.js'; // Initialize getApi()

import { planBrief } from '../../src/editor/js/api/plan-brief.js';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.dungeon = createEmptyDungeon('Test', 20, 30, 5, 'stone-dungeon', 1);
  state.undoStack = [];
  state.redoStack = [];
});

// ── Basic layout: 2 rooms + 1 connection ─────────────────────────────────────

describe('planBrief with 2 rooms + 1 connection', () => {
  it('produces commands for newMap, createRoom, setLabel, and setDoor', () => {
    const result = planBrief({
      name: 'Test Dungeon',
      theme: 'stone-dungeon',
      gridSize: 5,
      rooms: [
        { label: 'A1', width: 5, height: 5, entrance: true },
        { label: 'A2', width: 4, height: 4 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.commands).toBeDefined();
    expect(result.mapSize).toBeDefined();
    expect(result.mapSize.rows).toBeGreaterThan(0);
    expect(result.mapSize.cols).toBeGreaterThan(0);

    const cmdTypes = result.commands.map(c => c[0]);
    expect(cmdTypes[0]).toBe('newMap');
    expect(cmdTypes).toContain('createRoom');
    expect(cmdTypes).toContain('setLabel');
    expect(cmdTypes).toContain('setDoor');
  });

  it('creates exactly 2 room commands + 1 corridor + labels', () => {
    const result = planBrief({
      name: 'Test',
      rooms: [
        { label: 'A1', width: 3, height: 3, entrance: true },
        { label: 'A2', width: 3, height: 3 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
      ],
    });

    const createRoomCmds = result.commands.filter(c => c[0] === 'createRoom');
    // 2 rooms + 1 corridor = 3 createRoom commands
    expect(createRoomCmds.length).toBe(3);

    const setLabelCmds = result.commands.filter(c => c[0] === 'setLabel');
    // 2 labels for the 2 rooms (corridor does not get a label from planBrief)
    expect(setLabelCmds.length).toBe(2);
    const labels = setLabelCmds.map(c => c[3]);
    expect(labels).toContain('A1');
    expect(labels).toContain('A2');
  });

  it('generates door commands for both ends of the corridor', () => {
    const result = planBrief({
      name: 'Test',
      rooms: [
        { label: 'A1', width: 4, height: 4, entrance: true },
        { label: 'A2', width: 4, height: 4 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
      ],
    });

    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    expect(doorCmds.length).toBe(2); // one at each end of the corridor
  });

  it('uses the provided theme and gridSize in newMap command', () => {
    const result = planBrief({
      name: 'Themed',
      theme: 'blue-parchment',
      gridSize: 10,
      rooms: [
        { label: 'A1', width: 3, height: 3 },
      ],
      connections: [],
    });

    const newMapCmd = result.commands.find(c => c[0] === 'newMap');
    expect(newMapCmd[1]).toBe('Themed');
    expect(newMapCmd[4]).toBe(10); // gridSize
    expect(newMapCmd[5]).toBe('blue-parchment');
  });
});

// ── 3 rooms in a chain ───────────────────────────────────────────────────────

describe('planBrief with 3 rooms in a chain', () => {
  it('creates rooms and corridors for a linear chain', () => {
    const result = planBrief({
      name: 'Chain',
      rooms: [
        { label: 'A1', width: 4, height: 4, entrance: true },
        { label: 'A2', width: 4, height: 4 },
        { label: 'A3', width: 4, height: 4 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
        { from: 'A2', to: 'A3', direction: 'east' },
      ],
    });

    expect(result.success).toBe(true);
    const createRoomCmds = result.commands.filter(c => c[0] === 'createRoom');
    // 3 rooms + 2 corridors = 5 createRoom commands
    expect(createRoomCmds.length).toBe(5);

    const setLabelCmds = result.commands.filter(c => c[0] === 'setLabel');
    expect(setLabelCmds.length).toBe(3);

    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    // 2 connections * 2 doors each = 4
    expect(doorCmds.length).toBe(4);
  });

  it('produces valid map dimensions that contain all rooms', () => {
    const result = planBrief({
      name: 'Chain',
      rooms: [
        { label: 'A1', width: 5, height: 5, entrance: true },
        { label: 'A2', width: 5, height: 5 },
        { label: 'A3', width: 5, height: 5 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'south' },
        { from: 'A2', to: 'A3', direction: 'south' },
      ],
    });

    expect(result.mapSize.rows).toBeGreaterThan(15); // 3 rooms of height 5 + corridors
  });

  it('handles north-south connections', () => {
    const result = planBrief({
      name: 'NS Chain',
      rooms: [
        { label: 'A1', width: 4, height: 4, entrance: true },
        { label: 'A2', width: 4, height: 4 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'south' },
      ],
    });

    expect(result.success).toBe(true);
    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    expect(doorCmds.length).toBe(2);
    // Door direction is at index 3, type at index 4
    const doorDirs = doorCmds.map(c => c[3]);
    // Both doors use 'south' direction (parent->corridor and corridor->child)
    expect(doorDirs.every(d => d === 'south' || d === 'north')).toBe(true);
  });
});

// ── Error cases ──────────────────────────────────────────────────────────────

describe('planBrief error handling', () => {
  it('throws when connection is missing direction', () => {
    expect(() => planBrief({
      name: 'Bad',
      rooms: [
        { label: 'A1', width: 3, height: 3 },
        { label: 'A2', width: 3, height: 3 },
      ],
      connections: [
        { from: 'A1', to: 'A2' }, // no direction
      ],
    })).toThrow('must specify direction');
  });

  it('throws when no rooms are provided', () => {
    expect(() => planBrief({
      name: 'Empty',
      rooms: [],
      connections: [],
    })).toThrow('at least one room');
  });

  it('throws when rooms array is missing', () => {
    expect(() => planBrief({
      name: 'NoRooms',
      connections: [],
    })).toThrow('at least one room');
  });

  it('throws when a room has no label', () => {
    expect(() => planBrief({
      name: 'NoLabel',
      rooms: [{ width: 3, height: 3 }],
      connections: [],
    })).toThrow('must have a label');
  });

  it('throws when a room has no width', () => {
    expect(() => planBrief({
      name: 'NoWidth',
      rooms: [{ label: 'A1', height: 3 }],
      connections: [],
    })).toThrow('must have width and height');
  });

  it('throws when a room has no height', () => {
    expect(() => planBrief({
      name: 'NoHeight',
      rooms: [{ label: 'A1', width: 3 }],
      connections: [],
    })).toThrow('must have width and height');
  });
});

// ── Layout properties ────────────────────────────────────────────────────────

describe('planBrief layout properties', () => {
  it('uses the entrance room as the layout root', () => {
    const result = planBrief({
      name: 'Entrance Test',
      rooms: [
        { label: 'B1', width: 3, height: 3 },
        { label: 'A1', width: 3, height: 3, entrance: true },
      ],
      connections: [
        { from: 'A1', to: 'B1', direction: 'east' },
      ],
    });

    // The first setLabel should be for B1 (input order), but A1 is root
    // The layout should still succeed
    expect(result.success).toBe(true);
  });

  it('falls back to first room as root when no entrance specified', () => {
    const result = planBrief({
      name: 'No Entrance',
      rooms: [
        { label: 'A1', width: 3, height: 3 },
        { label: 'A2', width: 3, height: 3 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('places disconnected rooms to the right of connected content', () => {
    const result = planBrief({
      name: 'Disconnected',
      rooms: [
        { label: 'A1', width: 3, height: 3, entrance: true },
        { label: 'A2', width: 3, height: 3 },
        { label: 'Island', width: 3, height: 3 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
        // Island has no connections
      ],
    });

    expect(result.success).toBe(true);
    // Island should still get a createRoom and setLabel
    const labels = result.commands.filter(c => c[0] === 'setLabel').map(c => c[3]);
    expect(labels).toContain('Island');
  });

  it('normalizes positions so minimum is at (1,1)', () => {
    const result = planBrief({
      name: 'Normalized',
      rooms: [
        { label: 'A1', width: 3, height: 3, entrance: true },
      ],
      connections: [],
    });

    const createRoom = result.commands.find(c => c[0] === 'createRoom');
    expect(createRoom[1]).toBeGreaterThanOrEqual(1); // r1 >= 1
    expect(createRoom[2]).toBeGreaterThanOrEqual(1); // c1 >= 1
  });

  it('handles secret door connections', () => {
    const result = planBrief({
      name: 'Secret',
      rooms: [
        { label: 'A1', width: 3, height: 3, entrance: true },
        { label: 'A2', width: 3, height: 3 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east', type: 'secret' },
      ],
    });

    expect(result.success).toBe(true);
    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    // Door type is at index 4: ['setDoor', row, col, dir, type]
    for (const cmd of doorCmds) {
      expect(cmd[4]).toBe('s');
    }
  });

  it('supports custom corridor width per connection', () => {
    const result = planBrief({
      name: 'Custom Corridor',
      rooms: [
        { label: 'A1', width: 6, height: 6, entrance: true },
        { label: 'A2', width: 6, height: 6 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east', corridorWidth: 4 },
      ],
    });

    expect(result.success).toBe(true);
    // The corridor createRoom command should have 4-wide corridor
    const createRoomCmds = result.commands.filter(c => c[0] === 'createRoom');
    // Third createRoom is the corridor
    const corridorCmd = createRoomCmds[2];
    // For east-west corridor: row span = corridorWidth
    const corridorHeight = corridorCmd[3] - corridorCmd[1] + 1;
    expect(corridorHeight).toBe(4);
  });

  it('handles west direction connections', () => {
    const result = planBrief({
      name: 'West',
      rooms: [
        { label: 'A1', width: 4, height: 4, entrance: true },
        { label: 'A2', width: 4, height: 4 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'west' },
      ],
    });

    expect(result.success).toBe(true);
    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    expect(doorCmds.length).toBe(2);
    // Door direction is at index 3: ['setDoor', row, col, dir, type]
    const doorDirs = doorCmds.map(c => c[3]);
    // Both doors use 'west' or 'east' direction depending on which side
    expect(doorDirs.every(d => d === 'west' || d === 'east')).toBe(true);
  });

  it('handles north direction connections', () => {
    const result = planBrief({
      name: 'North',
      rooms: [
        { label: 'A1', width: 4, height: 4, entrance: true },
        { label: 'A2', width: 4, height: 4 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'north' },
      ],
    });

    expect(result.success).toBe(true);
    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    expect(doorCmds.length).toBe(2);
    // Door direction is at index 3
    const doorDirs = doorCmds.map(c => c[3]);
    expect(doorDirs.every(d => d === 'north' || d === 'south')).toBe(true);
  });

  it('handles default corridorWidth from brief level', () => {
    const result = planBrief({
      name: 'Global CW',
      corridorWidth: 5,
      rooms: [
        { label: 'A1', width: 8, height: 8, entrance: true },
        { label: 'A2', width: 8, height: 8 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
      ],
    });

    expect(result.success).toBe(true);
    const createRoomCmds = result.commands.filter(c => c[0] === 'createRoom');
    // Third createRoom is the corridor
    const corridorCmd = createRoomCmds[2];
    const corridorHeight = corridorCmd[3] - corridorCmd[1] + 1;
    expect(corridorHeight).toBe(5);
  });

  it('handles 4 rooms in a cross layout', () => {
    const result = planBrief({
      name: 'Cross',
      rooms: [
        { label: 'Center', width: 5, height: 5, entrance: true },
        { label: 'N1', width: 4, height: 4 },
        { label: 'E1', width: 4, height: 4 },
        { label: 'S1', width: 4, height: 4 },
      ],
      connections: [
        { from: 'Center', to: 'N1', direction: 'north' },
        { from: 'Center', to: 'E1', direction: 'east' },
        { from: 'Center', to: 'S1', direction: 'south' },
      ],
    });

    expect(result.success).toBe(true);
    const createRoomCmds = result.commands.filter(c => c[0] === 'createRoom');
    // 4 rooms + 3 corridors = 7
    expect(createRoomCmds.length).toBe(7);
    const setLabelCmds = result.commands.filter(c => c[0] === 'setLabel');
    expect(setLabelCmds.length).toBe(4);
    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    expect(doorCmds.length).toBe(6); // 3 connections * 2 doors
  });

  it('handles connection type defaulting to normal door', () => {
    const result = planBrief({
      name: 'Default Door',
      rooms: [
        { label: 'A1', width: 4, height: 4, entrance: true },
        { label: 'A2', width: 4, height: 4 },
      ],
      connections: [
        { from: 'A1', to: 'A2', direction: 'east' },
      ],
    });

    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    for (const cmd of doorCmds) {
      expect(cmd[4]).toBe('d');
    }
  });

  it('uses default theme and gridSize when not specified', () => {
    const result = planBrief({
      name: 'Defaults',
      rooms: [{ label: 'A1', width: 3, height: 3 }],
      connections: [],
    });

    const newMapCmd = result.commands.find(c => c[0] === 'newMap');
    expect(newMapCmd[4]).toBe(5); // default gridSize
    expect(newMapCmd[5]).toBe('stone-dungeon'); // default theme
  });

  it('handles multiple rooms branching from one parent in same direction', () => {
    const result = planBrief({
      name: 'Branch',
      rooms: [
        { label: 'Hub', width: 6, height: 6, entrance: true },
        { label: 'E1', width: 4, height: 4 },
        { label: 'E2', width: 4, height: 4 },
      ],
      connections: [
        { from: 'Hub', to: 'E1', direction: 'east' },
        { from: 'Hub', to: 'E2', direction: 'east' },
      ],
    });

    expect(result.success).toBe(true);
    // 3 rooms + 2 corridors = 5 createRoom commands
    const createRoomCmds = result.commands.filter(c => c[0] === 'createRoom');
    expect(createRoomCmds.length).toBe(5);
    const setLabelCmds = result.commands.filter(c => c[0] === 'setLabel');
    expect(setLabelCmds.length).toBe(3);
  });

  it('handles single room with no connections', () => {
    const result = planBrief({
      name: 'Solo',
      rooms: [{ label: 'A1', width: 5, height: 5 }],
      connections: [],
    });

    expect(result.success).toBe(true);
    const createRoomCmds = result.commands.filter(c => c[0] === 'createRoom');
    expect(createRoomCmds.length).toBe(1);
    const doorCmds = result.commands.filter(c => c[0] === 'setDoor');
    expect(doorCmds.length).toBe(0);
  });
});
