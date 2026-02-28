// DM-side session manager: WebSocket connection, reveal state, viewport broadcast.

import state, { subscribe, markDirty, notify, getTheme } from './state.js';
import { getTransform, getCanvasSize, requestRender, panToLevel } from './canvas-view.js';
import { showToast } from './toast.js';
import { CARDINAL_DIRS, OPPOSITE, cellKey, parseCellKey, isInBounds, floodFillRoom } from '../../util/index.js';
import { toCanvas } from './utils.js';
import { classifyStairShape, getOccupiedCells, stairBoundingBox } from './stair-geometry.js';

// ── Session state (runtime only, not serialized) ────────────────────────────

export const sessionState = {
  active: false,
  ws: null,
  revealedCells: new Set(),
  openedDoors: [],       // [{ row, col, dir, wasSecret }]
  openedStairs: [],      // [stairId, ...] — both ends pushed when pair opened
  startingRoom: null,    // cell key of starting room anchor
  playerCount: 0,
};

// ── WebSocket ───────────────────────────────────────────────────────────────

function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws?role=dm`;

  const ws = new WebSocket(url);
  sessionState.ws = ws;

  ws.addEventListener('open', () => {
    showToast('Session started — connected to server');
    broadcastInit();
  });

  ws.addEventListener('close', () => {
    if (sessionState.active) {
      showToast('WebSocket disconnected — reconnecting…');
      setTimeout(connectWS, 2000);
    }
  });

  ws.addEventListener('error', () => ws.close());

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  });
}

// Range highlight callback (set by main.js)
let rangeHighlightCallback = null;
export function setRangeHighlightCallback(fn) { rangeHighlightCallback = fn; }

function handleMessage(msg) {
  switch (msg.type) {
    case 'player:join':
      // New player connected — send them the current state
      broadcastInit();
      break;

    case 'player:count':
      sessionState.playerCount = msg.count;
      state.session.playerCount = msg.count;
      notify();
      break;

    case 'range:highlight':
      // A player sent a range highlight — apply locally for DM rendering
      if (rangeHighlightCallback) rangeHighlightCallback(msg);
      break;
  }
}

function send(msg) {
  if (sessionState.ws?.readyState === 1) {
    sessionState.ws.send(JSON.stringify(msg));
  }
}

// ── Session lifecycle ───────────────────────────────────────────────────────

export function startSession() {
  if (sessionState.active) return;
  sessionState.active = true;
  state.session.active = true;
  connectWS();
  // Pan to first level (same as clicking it in the level selector)
  const levels = state.dungeon.metadata?.levels;
  if (levels?.length) {
    state.currentLevel = 0;
    panToLevel(levels[0].startRow, levels[0].numRows);
  }
  // Subscribe to viewport changes
  startViewportBroadcast();
  startDungeonBroadcast();
  markDirty();
  notify();
}

export function endSession() {
  if (!sessionState.active) return;
  send({ type: 'session:end' });
  sessionState.active = false;
  sessionState.revealedCells.clear();
  sessionState.openedDoors = [];
  sessionState.openedStairs = [];
  sessionState.startingRoom = null;
  sessionState.playerCount = 0;
  state.session.active = false;
  state.session.playerCount = 0;
  if (sessionState.ws) {
    sessionState.ws.close();
    sessionState.ws = null;
  }
  showToast('Session ended');
  markDirty();
  notify();
}

// ── Broadcast helpers ───────────────────────────────────────────────────────

function broadcastInit() {
  const transform = getTransform();
  const { width, height } = getCanvasSize();
  send({
    type: 'session:init',
    dungeon: state.dungeon,
    resolvedTheme: getTheme(),
    revealedCells: [...sessionState.revealedCells],
    openedDoors: sessionState.openedDoors,
    openedStairs: sessionState.openedStairs,
    viewport: {
      panX: state.panX,
      panY: state.panY,
      zoom: state.zoom,
      canvasWidth: width,
      canvasHeight: height,
    },
  });
}

// Viewport broadcast (throttled via rAF)
let viewportDirty = false;
let lastPanX = 0, lastPanY = 0, lastZoom = 0;

function startViewportBroadcast() {
  subscribe(() => {
    if (!sessionState.active) return;
    if (state.panX === lastPanX && state.panY === lastPanY && state.zoom === lastZoom) return;
    lastPanX = state.panX;
    lastPanY = state.panY;
    lastZoom = state.zoom;

    if (!viewportDirty) {
      viewportDirty = true;
      requestAnimationFrame(() => {
        viewportDirty = false;
        const { width, height } = getCanvasSize();
        send({
          type: 'viewport:update',
          panX: state.panX,
          panY: state.panY,
          zoom: state.zoom,
          canvasWidth: width,
          canvasHeight: height,
        });
      });
    }
  });
}

// Dungeon broadcast (debounced 1s after edits)
let dungeonTimer = null;

function startDungeonBroadcast() {
  subscribe(() => {
    if (!sessionState.active) return;
    if (!state.dirty) return;
    if (dungeonTimer) clearTimeout(dungeonTimer);
    dungeonTimer = setTimeout(() => {
      send({
        type: 'dungeon:update',
        cells: state.dungeon.cells,
        metadata: state.dungeon.metadata,
        resolvedTheme: getTheme(),
      });
    }, 1000);
  });
}

// ── Fog of war: room reveal ─────────────────────────────────────────────────

/**
 * Reveal a room starting from the given cell. Returns the set of newly revealed cells.
 * Uses the shared diagonal-aware floodFillRoom BFS from util/grid.js.
 */
export function revealRoom(startRow, startCol) {
  const roomCells = floodFillRoom(state.dungeon.cells, startRow, startCol);
  const newCells = [];
  for (const key of roomCells) {
    if (!sessionState.revealedCells.has(key)) {
      sessionState.revealedCells.add(key);
      newCells.push(key);
    }
  }
  return newCells;
}

/**
 * Set the starting room and reveal it. Called when DM picks a starting room.
 */
export function setStartingRoom(row, col) {
  sessionState.startingRoom = cellKey(row, col);
  const newCells = revealRoom(row, col);

  // Broadcast initial reveal (no fade for starting room)
  const { width: sw, height: sh } = getCanvasSize();
  send({
    type: 'session:init',
    dungeon: state.dungeon,
    resolvedTheme: getTheme(),
    revealedCells: [...sessionState.revealedCells],
    openedDoors: sessionState.openedDoors,
    openedStairs: sessionState.openedStairs,
    viewport: {
      panX: state.panX,
      panY: state.panY,
      zoom: state.zoom,
      canvasWidth: sw,
      canvasHeight: sh,
    },
  });

  requestRender();
  notify();
  return newCells;
}

/**
 * Open a door and reveal the room on the other side.
 */
export function openDoor(row, col, dir) {
  const cells = state.dungeon.cells;
  const cell = cells[row]?.[col];
  if (!cell) return;

  const doorType = cell[dir]; // 'd', 's', or 'id'
  const wasSecret = doorType === 's';

  // Record opened door
  sessionState.openedDoors.push({ row, col, dir, wasSecret });

  let newCells;

  if (dir === 'nw-se' || dir === 'ne-sw') {
    // Diagonal door: BFS from the OTHER half of the same cell.
    // Determine which entry direction reaches the unrevealed half.
    const otherEntry = getDiagonalOtherEntry(cell, row, col, dir);
    newCells = revealRoomFrom(row, col, otherEntry);

    // Also re-reveal from this side
    const thisSideCells = revealRoom(row, col);
    for (const key of thisSideCells) {
      if (!newCells.includes(key)) newCells.push(key);
    }
  } else {
    // Cardinal door: BFS from the neighbor on the other side
    const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
    const [dr, dc] = OFFSETS[dir];
    const otherRow = row + dr, otherCol = col + dc;

    newCells = revealRoom(otherRow, otherCol);

    // Also reveal from this side (in case the door is in a corridor between two rooms)
    const thisSideCells = revealRoom(row, col);
    for (const key of thisSideCells) {
      if (!newCells.includes(key)) newCells.push(key);
    }
  }

  // Broadcast
  send({ type: 'door:open', row, col, dir, wasSecret });
  if (newCells.length > 0) {
    send({ type: 'fog:reveal', cells: newCells, duration: 500 });
  }

  requestRender();
  notify();
}

/**
 * Determine which entry direction reaches the unrevealed half of a diagonal cell.
 */
function getDiagonalOtherEntry(cell, r, c, diagDir) {
  if (diagDir === 'nw-se') {
    // NE half entered from north/east, SW half entered from south/west
    const neRevealed = ['north', 'east'].some(d => {
      const { dr, dc } = CARDINAL_DIRS.find(cd => cd.dir === d);
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return neRevealed ? 'south' : 'north';
  }
  if (diagDir === 'ne-sw') {
    // NW half entered from north/west, SE half entered from south/east
    const nwRevealed = ['north', 'west'].some(d => {
      const { dr, dc } = CARDINAL_DIRS.find(cd => cd.dir === d);
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return nwRevealed ? 'south' : 'north';
  }
  return null;
}

/**
 * Reveal a room starting from the given cell with a specific entry direction.
 * Used for diagonal doors where the BFS must start from a specific half.
 */
function revealRoomFrom(startRow, startCol, entryDir) {
  const roomCells = floodFillRoom(state.dungeon.cells, startRow, startCol, { startEntryDir: entryDir });
  const newCells = [];
  for (const key of roomCells) {
    if (!sessionState.revealedCells.has(key)) {
      sessionState.revealedCells.add(key);
      newCells.push(key);
    }
  }
  return newCells;
}

/**
 * Reveal all cells (DM override).
 */
export function revealAll() {
  const cells = state.dungeon.cells;
  const newCells = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[0]?.length || 0); c++) {
      if (!cells[r]?.[c]) continue;
      const key = cellKey(r, c);
      if (!sessionState.revealedCells.has(key)) {
        sessionState.revealedCells.add(key);
        newCells.push(key);
      }
    }
  }
  if (newCells.length > 0) {
    send({ type: 'fog:reveal', cells: newCells, duration: 500 });
  }
  requestRender();
  notify();
}

/**
 * Reset fog — hide everything.
 */
export function resetFog() {
  sessionState.revealedCells.clear();
  sessionState.openedDoors = [];
  sessionState.openedStairs = [];
  sessionState.startingRoom = null;
  broadcastInit();
  requestRender();
  notify();
}

// ── Door overlay (DM canvas) ────────────────────────────────────────────────

const DOOR_BUTTON_RADIUS = 10;

/**
 * Find all doors that border a revealed cell and face an unrevealed area.
 * Secret doors always show a button until explicitly opened (even if both sides are revealed).
 * Checks cardinal doors (north/south/east/west) and diagonal doors (nw-se/ne-sw).
 */
function findRevealableDoors() {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return [];

  const cells = state.dungeon.cells;
  const doors = [];
  const seen = new Set();
  const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };

  // Build opened-door set for fast lookup (include both sides of cardinal doors)
  const openedSet = new Set();
  for (const d of sessionState.openedDoors) {
    openedSet.add(`${d.row},${d.col},${d.dir}`);
    if (OFFSETS[d.dir]) {
      const [dr, dc] = OFFSETS[d.dir];
      openedSet.add(`${d.row + dr},${d.col + dc},${OPPOSITE[d.dir]}`);
    }
  }

  for (const key of sessionState.revealedCells) {
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;

    // Cardinal doors (normal, secret, and invisible)
    for (const dir of ['north', 'south', 'east', 'west']) {
      if (cell[dir] !== 'd' && cell[dir] !== 's' && cell[dir] !== 'id') continue;

      const dkey = `${r},${c},${dir}`;
      if (seen.has(dkey)) continue;

      const isSecret = cell[dir] === 's';
      const isInvisible = cell[dir] === 'id';

      // Secret doors: always show button until opened
      if (isSecret) {
        if (openedSet.has(dkey)) continue;
        seen.add(dkey);
        doors.push({ row: r, col: c, dir, type: 's' });
        continue;
      }

      // Normal/invisible doors: only show if neighbor is unrevealed
      const [dr, dc] = OFFSETS[dir];
      const nr = r + dr, nc = c + dc;
      const neighborKey = cellKey(nr, nc);
      if (sessionState.revealedCells.has(neighborKey)) continue;
      if (!isInBounds(cells, nr, nc)) continue;
      if (!cells[nr]?.[nc]) continue;

      seen.add(dkey);
      doors.push({ row: r, col: c, dir, type: isInvisible ? 'id' : 'd' });
    }

    // Diagonal doors (nw-se, ne-sw)
    for (const diagDir of ['nw-se', 'ne-sw']) {
      if (cell[diagDir] !== 'd' && cell[diagDir] !== 's' && cell[diagDir] !== 'id') continue;

      const dkey = `${r},${c},${diagDir}`;
      if (seen.has(dkey)) continue;

      const isSecret = cell[diagDir] === 's';
      const isInvisible = cell[diagDir] === 'id';

      // Secret doors: always show button until opened
      if (isSecret) {
        if (openedSet.has(dkey)) continue;
        seen.add(dkey);
        doors.push({ row: r, col: c, dir: diagDir, type: 's' });
        continue;
      }

      // Normal/invisible doors: check if the OTHER half has unrevealed neighbor cells
      const otherSideDirs = getOtherSideDirs(cell, r, c, diagDir);
      if (!otherSideDirs) continue;

      let hasUnrevealed = false;
      for (const exitDir of otherSideDirs) {
        const { dir: _, dr, dc } = CARDINAL_DIRS.find(d => d.dir === exitDir);
        const nr = r + dr, nc = c + dc;
        if (!isInBounds(cells, nr, nc)) continue;
        if (!cells[nr]?.[nc]) continue;
        if (!sessionState.revealedCells.has(cellKey(nr, nc))) {
          hasUnrevealed = true;
          break;
        }
      }
      if (!hasUnrevealed) continue;

      seen.add(dkey);
      doors.push({ row: r, col: c, dir: diagDir, type: isInvisible ? 'id' : 'd' });
    }
  }
  return doors;
}

/**
 * For a diagonal door in a revealed cell, determine which cardinal exit directions
 * belong to the unrevealed (other) half.
 */
function getOtherSideDirs(cell, r, c, diagDir) {
  // Determine which half is revealed by checking which neighbors are revealed
  if (diagDir === 'nw-se') {
    // NE half exits: north, east. SW half exits: south, west.
    const neRevealed = ['north', 'east'].some(d => {
      const { dr, dc } = CARDINAL_DIRS.find(cd => cd.dir === d);
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return neRevealed ? ['south', 'west'] : ['north', 'east'];
  }
  if (diagDir === 'ne-sw') {
    // NW half exits: north, west. SE half exits: south, east.
    const nwRevealed = ['north', 'west'].some(d => {
      const { dr, dc } = CARDINAL_DIRS.find(cd => cd.dir === d);
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return nwRevealed ? ['south', 'east'] : ['north', 'west'];
  }
  return null;
}

/**
 * Get the canvas pixel position of a door midpoint.
 */
function getDoorMidpoint(row, col, dir, gridSize, transform) {
  const x = col * gridSize, y = row * gridSize;
  switch (dir) {
    case 'north': return toCanvas(x + gridSize / 2, y, transform);
    case 'south': return toCanvas(x + gridSize / 2, y + gridSize, transform);
    case 'east':  return toCanvas(x + gridSize, y + gridSize / 2, transform);
    case 'west':  return toCanvas(x, y + gridSize / 2, transform);
    case 'nw-se': return toCanvas(x + gridSize / 2, y + gridSize / 2, transform);
    case 'ne-sw': return toCanvas(x + gridSize / 2, y + gridSize / 2, transform);
  }
}

/**
 * Draw a small open-door icon using canvas paths.
 */
function drawDoorIcon(ctx, x, y, radius, color) {
  const r = radius;

  // Background circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Open door icon: a door frame with an open door
  const s = r * 0.55;
  ctx.save();
  ctx.translate(x, y);

  // Door frame (rectangle)
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-s, -s, s * 2, s * 2);

  // Open door panel (angled line from left side)
  ctx.beginPath();
  ctx.moveTo(-s, -s);
  ctx.lineTo(-s * 0.2, -s * 0.3);
  ctx.lineTo(-s * 0.2, s * 0.3);
  ctx.lineTo(-s, s);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

/**
 * Render door-open overlay buttons on the DM canvas.
 * Called from canvas-view.js during the render pass.
 */
export function renderSessionOverlay(ctx, transform, gridSize) {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return;

  // Door buttons
  const doors = findRevealableDoors();
  for (const { row, col, dir, type } of doors) {
    const p = getDoorMidpoint(row, col, dir, gridSize, transform);
    const color = type === 's' ? 'rgba(220, 60, 60, 0.85)'
                : type === 'id' ? 'rgba(80, 130, 255, 0.85)'
                : 'rgba(60, 180, 170, 0.85)';
    drawDoorIcon(ctx, p.x, p.y, DOOR_BUTTON_RADIUS, color);
  }

  // Stair buttons
  const stairs = findRevealableStairs();
  for (const stair of stairs) {
    const p = getStairButtonPos(stair, transform);
    drawStairIcon(ctx, p.x, p.y, STAIR_BUTTON_RADIUS);
  }
}

/**
 * Test if a click hits a door overlay button.
 * Returns the door object if hit, null otherwise.
 */
export function hitTestDoorButton(px, py, transform, gridSize) {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return null;

  const doors = findRevealableDoors();
  for (const door of doors) {
    const p = getDoorMidpoint(door.row, door.col, door.dir, gridSize, transform);
    const dx = px - p.x, dy = py - p.y;
    if (dx * dx + dy * dy <= DOOR_BUTTON_RADIUS * DOOR_BUTTON_RADIUS) {
      return door;
    }
  }
  return null;
}

// ── Stair overlay (DM canvas) ─────────────────────────────────────────────

const STAIR_BUTTON_RADIUS = 10;

/**
 * Find all linked stairs where this end is revealed and the partner end is not.
 */
function findRevealableStairs() {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return [];

  const stairs = state.dungeon.metadata?.stairs || [];
  const gridSize = state.dungeon.metadata.gridSize;
  const result = [];
  const seen = new Set();

  for (const stairDef of stairs) {
    if (!stairDef.link) continue;
    if (sessionState.openedStairs.includes(stairDef.id)) continue;

    // Compute occupied cells
    const shape = classifyStairShape(stairDef.points[0], stairDef.points[1], stairDef.points[2]);
    const occupied = getOccupiedCells(shape.vertices);

    // At least one occupied cell must be revealed
    const hasRevealed = occupied.some(
      ({ row, col }) => sessionState.revealedCells.has(cellKey(row, col))
    );
    if (!hasRevealed) continue;

    // Find linked partner
    const partner = stairs.find(s => s.link === stairDef.link && s.id !== stairDef.id);
    if (!partner) continue;

    // Partner must have at least one unrevealed cell
    const partnerShape = classifyStairShape(partner.points[0], partner.points[1], partner.points[2]);
    const partnerCells = getOccupiedCells(partnerShape.vertices);
    const partnerHasUnrevealed = partnerCells.some(
      ({ row, col }) => !sessionState.revealedCells.has(cellKey(row, col))
    );
    if (!partnerHasUnrevealed) continue;

    // Deduplicate pairs
    const pairKey = [stairDef.id, partner.id].sort().join(',');
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    // Button position: NW corner of bounding box (matching label badge)
    const bbox = stairBoundingBox(stairDef.points);
    result.push({
      stairId: stairDef.id,
      partnerId: partner.id,
      link: stairDef.link,
      worldX: bbox.minCol * gridSize,
      worldY: bbox.minRow * gridSize,
    });
  }
  return result;
}

/**
 * Get canvas position for a stair button (offset from NW corner, matching label badge).
 */
function getStairButtonPos(stair, transform) {
  const p = toCanvas(stair.worldX, stair.worldY, transform);
  const s = transform.scale / 10;
  return { x: p.x + 10 * s, y: p.y + 10 * s };
}

/**
 * Draw an amber stair-open button.
 */
function drawStairIcon(ctx, x, y, radius) {
  const r = radius;

  // Background circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(220, 170, 50, 0.85)';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Stair steps icon: 3 staggered horizontal lines
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  const s = r * 0.5;
  for (let i = -1; i <= 1; i++) {
    const yy = i * s * 0.6;
    const xx = i * s * 0.3;
    ctx.beginPath();
    ctx.moveTo(xx - s * 0.5, yy);
    ctx.lineTo(xx + s * 0.5, yy);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Test if a click hits a stair overlay button.
 */
export function hitTestStairButton(px, py, transform, gridSize) {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return null;

  const stairs = findRevealableStairs();
  for (const stair of stairs) {
    const p = getStairButtonPos(stair, transform);
    const dx = px - p.x, dy = py - p.y;
    if (dx * dx + dy * dy <= STAIR_BUTTON_RADIUS * STAIR_BUTTON_RADIUS) {
      return stair;
    }
  }
  return null;
}

/**
 * Open a linked stair pair and reveal the room at the partner's end.
 */
export function openStairs(stairId, partnerId) {
  const stairs = state.dungeon.metadata?.stairs || [];

  // Record both IDs as opened
  sessionState.openedStairs.push(stairId, partnerId);

  // BFS reveal from the partner stair's first occupied cell
  const partner = stairs.find(s => s.id === partnerId);
  let allNewCells = [];
  let partnerRow = null;
  if (partner) {
    const partnerShape = classifyStairShape(partner.points[0], partner.points[1], partner.points[2]);
    const partnerCells = getOccupiedCells(partnerShape.vertices);
    if (partnerCells.length > 0) {
      partnerRow = partnerCells[0].row;
      allNewCells = revealRoom(partnerRow, partnerCells[0].col);
    }
  }

  // Broadcast
  send({ type: 'stairs:open', stairIds: [stairId, partnerId] });
  if (allNewCells.length > 0) {
    send({ type: 'fog:reveal', cells: allNewCells, duration: 500 });
  }

  // Auto-pan to the partner stair's level
  if (partnerRow !== null) {
    const levels = state.dungeon.metadata.levels;
    if (levels?.length) {
      for (let i = levels.length - 1; i >= 0; i--) {
        if (partnerRow >= levels[i].startRow) {
          state.currentLevel = i;
          panToLevel(levels[i].startRow, levels[i].numRows);
          break;
        }
      }
    }
  }

  requestRender();
  notify();
}
