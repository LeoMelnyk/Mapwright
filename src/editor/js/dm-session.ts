// DM-side session manager: WebSocket connection, reveal state, viewport broadcast.

import type { RenderTransform } from '../../types.js';
import state, { subscribe, markDirty, notify, getTheme } from './state.js';
import { getCanvasSize, requestRender, panToLevel } from './canvas-view.js';
import { showToast } from './toast.js';
import { CARDINAL_DIRS, OPPOSITE, cellKey, parseCellKey, isInBounds, floodFillRoom } from '../../util/index.js';
import { toCanvas } from './utils.js';
import { classifyStairShape, getOccupiedCells, stairBoundingBox } from './stair-geometry.js';
import { getEditorSettings } from './editor-settings.js';
import { getContentVersion, consumeBroadcastDirtyRegion, getLightingVersion, getPropsVersion } from '../../render/index.js';

// ── Session state (runtime only, not serialized) ────────────────────────────

export const sessionState = {
  active: false,
  ws: null,
  revealedCells: new Set(),
  openedDoors: [],       // [{ row, col, dir, wasSecret }]
  openedStairs: [],      // [stairId, ...] — both ends pushed when pair opened
  startingRoom: null,    // cell key of starting room anchor
  playerCount: 0,
  dmViewActive: false,   // true when DM fog overlay is enabled
  dmViewForced: false,   // true when a tool (e.g. fog reveal) forces the overlay on
};

// ── WebSocket ───────────────────────────────────────────────────────────────

function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws?role=dm`;

  const ws = new WebSocket(url);
  // @ts-expect-error — strict-mode migration
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
let rangeHighlightCallback: any = null;
/**
 * Set the callback for incoming range highlights from players.
 * @param {Function} fn - Callback receiving the range highlight message.
 * @returns {void}
 */
export function setRangeHighlightCallback(fn: (msg: any) => void): void { rangeHighlightCallback = fn; }

function handleMessage(msg: any) {
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

function send(msg: any) {
  // @ts-expect-error — strict-mode migration
  if (sessionState.ws?.readyState === 1) {
    // @ts-expect-error — strict-mode migration
    sessionState.ws.send(JSON.stringify(msg));
  }
}

// ── Session lifecycle ───────────────────────────────────────────────────────

/**
 * Start a DM session — connects WebSocket, reveals starting room, begins broadcasts.
 * @returns {void}
 */
export function startSession(): void {
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

/**
 * End the active DM session — disconnects WebSocket and clears session state.
 * @returns {void}
 */
export function endSession(): void {
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
    // @ts-expect-error — strict-mode migration
    sessionState.ws.close();
    sessionState.ws = null;
  }
  showToast('Session ended');
  markDirty();
  notify();
}

// ── Broadcast helpers ───────────────────────────────────────────────────────

function snapshotBroadcastBaseline() {
  _lastBroadcastThemeJSON = JSON.stringify(getTheme());
  _lastBroadcastLightingVersion = getLightingVersion();
  _lastBroadcastPropsVersion = getPropsVersion();
  _lastBroadcastGridRows = state.dungeon.cells.length;
  _lastBroadcastGridCols = state.dungeon.cells[0]?.length || 0;
  _lastBroadcastContentVersion = getContentVersion();
  consumeBroadcastDirtyRegion(); // clear any accumulated region
}

function broadcastInit() {
  snapshotBroadcastBaseline();
  const { width, height } = getCanvasSize();
  send({
    type: 'session:init',
    dungeon: state.dungeon,
    resolvedTheme: getTheme(),
    renderQuality: getEditorSettings().renderQuality || 20,
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
  }, 'dm-viewport');
}

// Dungeon broadcast (debounced 1s after structural edits)
// Uses content version from the render pipeline — immune to pan/zoom/resize
// which set state.dirty but don't change dungeon content.
let dungeonTimer: any = null;
let _lastBroadcastContentVersion = 0;
let _lastBroadcastLightingVersion = 0;
let _lastBroadcastThemeJSON: any = null;
let _lastBroadcastPropsVersion = 0;
let _lastBroadcastGridRows = 0;
let _lastBroadcastGridCols = 0;

function startDungeonBroadcast() {
  subscribe(() => {
    if (!sessionState.active) return;
    const cv = getContentVersion();
    if (cv === _lastBroadcastContentVersion) return; // no content change
    _lastBroadcastContentVersion = cv;
    if (dungeonTimer) clearTimeout(dungeonTimer);
    dungeonTimer = setTimeout(() => {
      // Compute change hints for the player
      const resolvedTheme = getTheme();
      const themeJSON = JSON.stringify(resolvedTheme);
      const lv = getLightingVersion();
      const pv = getPropsVersion();
      const numRows = state.dungeon.cells.length;
      const numCols = state.dungeon.cells[0]?.length || 0;

      const changeHints = {
        dirtyRegion: consumeBroadcastDirtyRegion(),
        themeChanged: themeJSON !== _lastBroadcastThemeJSON,
        lightingChanged: lv !== _lastBroadcastLightingVersion,
        propsChanged: pv !== _lastBroadcastPropsVersion,
        gridResized: numRows !== _lastBroadcastGridRows || numCols !== _lastBroadcastGridCols,
      };

      _lastBroadcastThemeJSON = themeJSON;
      _lastBroadcastLightingVersion = lv;
      _lastBroadcastPropsVersion = pv;
      _lastBroadcastGridRows = numRows;
      _lastBroadcastGridCols = numCols;

      send({
        type: 'dungeon:update',
        cells: state.dungeon.cells,
        metadata: state.dungeon.metadata,
        resolvedTheme,
        changeHints,
      });
    }, 1000);
  }, 'dm-dungeon');
}

// ── Fog of war: room reveal ─────────────────────────────────────────────────

/**
 * Reveal a room starting from the given cell via flood-fill BFS.
 * @param {number} startRow - Starting cell row.
 * @param {number} startCol - Starting cell column.
 * @returns {Array<string>} Array of newly revealed cell keys.
 */
export function revealRoom(startRow: number, startCol: number): string[] {
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
 * @param {number} row - Cell row.
 * @param {number} col - Cell column.
 * @returns {Array<string>} Array of newly revealed cell keys.
 */
export function setStartingRoom(row: number, col: number): string[] {
  // @ts-expect-error — strict-mode migration
  sessionState.startingRoom = cellKey(row, col);
  const newCells = revealRoom(row, col);

  // Broadcast as a fog reveal — no full session rebuild needed
  if (newCells.length > 0) {
    send({ type: 'fog:reveal', cells: newCells });
  }

  requestRender();
  notify();
  return newCells;
}

/**
 * Open a door and reveal the room on the other side.
 * @param {number} row - Door cell row.
 * @param {number} col - Door cell column.
 * @param {string} dir - Door direction (e.g. 'north', 'east', 'nw-se').
 * @param {Array|undefined} mergedCells - Optional array of merged door cells for wide doors.
 * @returns {void}
 */
export function openDoor(row: number, col: number, dir: string, mergedCells?: { row: number; col: number }[]): void {
  const cells = state.dungeon.cells;

  // Collect all door cells to open (merged or single)
  const doorCells = mergedCells && mergedCells.length > 1
    ? mergedCells
    : [{ row, col }];

  const newCells: any = [];

  for (const dc of doorCells) {
    const cell = cells[dc.row]?.[dc.col];
    if (!cell) continue;

    const doorType = (cell as any)[dir]; // 'd', 's', or 'id'
    const wasSecret = doorType === 's';

    // Record opened door
    // @ts-expect-error — strict-mode migration
    sessionState.openedDoors.push({ row: dc.row, col: dc.col, dir, wasSecret });

    if (dir === 'nw-se' || dir === 'ne-sw') {
      const otherEntry = getDiagonalOtherEntry(cell, dc.row, dc.col, dir);
      const revealed = revealRoomFrom(dc.row, dc.col, otherEntry);
      for (const key of revealed) {
        if (!newCells.includes(key)) newCells.push(key);
      }
      const thisSide = revealRoom(dc.row, dc.col);
      for (const key of thisSide) {
        if (!newCells.includes(key)) newCells.push(key);
      }
    } else {
      const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
      const [dr, dcc] = (OFFSETS as any)[dir];
      const revealed = revealRoom(dc.row + dr, dc.col + dcc);
      for (const key of revealed) {
        if (!newCells.includes(key)) newCells.push(key);
      }
      const thisSide = revealRoom(dc.row, dc.col);
      for (const key of thisSide) {
        if (!newCells.includes(key)) newCells.push(key);
      }
    }
  }

  // Broadcast each door cell so the player marks both sides as opened
  for (const dc of doorCells) {
    const doorType = (cells as any)[dc.row]?.[dc.col]?.[dir];
    const cellWasSecret = doorType === 's';
    send({ type: 'door:open', row: dc.row, col: dc.col, dir, wasSecret: cellWasSecret });
  }
  if (newCells.length > 0) {
    send({ type: 'fog:reveal', cells: newCells, duration: 500 });
  }

  requestRender();
  notify();
}

/**
 * Determine which entry direction reaches the unrevealed half of a diagonal cell.
 */
function getDiagonalOtherEntry(cell: any, r: any, c: any, diagDir: any) {
  if (diagDir === 'nw-se') {
    // NE half entered from north/east, SW half entered from south/west
    const neRevealed = ['north', 'east'].some(d => {
      // @ts-expect-error — strict-mode migration
      const { dr, dc } = CARDINAL_DIRS.find(cd => cd.dir === d);
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return neRevealed ? 'south' : 'north';
  }
  if (diagDir === 'ne-sw') {
    // NW half entered from north/west, SE half entered from south/east
    const nwRevealed = ['north', 'west'].some(d => {
      // @ts-expect-error — strict-mode migration
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
function revealRoomFrom(startRow: any, startCol: any, entryDir: any) {
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
 * Reveal all non-void cells on the map (DM override).
 * @returns {void}
 */
export function revealAll(): void {
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
 * Reveal all non-void cells within a rectangle.
 * @param {number} r1 - First corner row.
 * @param {number} c1 - First corner column.
 * @param {number} r2 - Second corner row.
 * @param {number} c2 - Second corner column.
 * @returns {void}
 */
export function revealRect(r1: number, c1: number, r2: number, c2: number): void {
  const cells = state.dungeon.cells;
  const minRow = Math.min(r1, r2), maxRow = Math.max(r1, r2);
  const minCol = Math.min(c1, c2), maxCol = Math.max(c1, c2);
  const newCells = [];
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
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
 * Re-fog all revealed cells within a rectangle.
 * @param {number} r1 - First corner row.
 * @param {number} c1 - First corner column.
 * @param {number} r2 - Second corner row.
 * @param {number} c2 - Second corner column.
 * @returns {void}
 */
export function concealRect(r1: number, c1: number, r2: number, c2: number): void {
  const cells = state.dungeon.cells;
  const minRow = Math.min(r1, r2), maxRow = Math.max(r1, r2);
  const minCol = Math.min(c1, c2), maxCol = Math.max(c1, c2);
  const hiddenCells = [];
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      if (!cells[r]?.[c]) continue;
      const key = cellKey(r, c);
      if (sessionState.revealedCells.has(key)) {
        sessionState.revealedCells.delete(key);
        hiddenCells.push(key);
      }
    }
  }
  if (hiddenCells.length > 0) {
    send({ type: 'fog:conceal', cells: hiddenCells });
  }
  requestRender();
  notify();
}

/**
 * Call when a new map is loaded while a session is active.
 * Resets fog state and re-sends session:init so the player reloads from scratch.
 * @returns {void}
 */
export function onMapLoaded(): void {
  if (!sessionState.active) return;
  sessionState.revealedCells.clear();
  sessionState.openedDoors = [];
  sessionState.openedStairs = [];
  sessionState.startingRoom = null;
  snapshotBroadcastBaseline();
  broadcastInit();
  requestRender();
  notify();
}

/**
 * Reset fog — hide everything and clear all opened doors/stairs.
 * @returns {void}
 */
export function resetFog(): void {
  sessionState.revealedCells.clear();
  sessionState.openedDoors = [];
  sessionState.openedStairs = [];
  sessionState.startingRoom = null;
  send({ type: 'fog:reset' });
  requestRender();
  notify();
}

// ── DM fog overlay ───────────────────────────────────────────────────────────

/**
 * Toggle the DM fog overlay on/off.
 * @returns {void}
 */
export function toggleDmView(): void {
  sessionState.dmViewActive = !sessionState.dmViewActive;
  requestRender();
  notify();
}

/**
 * Draw a semi-transparent dark tint over every non-void, unrevealed cell.
 * @param {CanvasRenderingContext2D} ctx - The canvas 2D context.
 * @param {Object} transform - The pan/zoom transform.
 * @param {number} gridSize - Grid cell size in feet.
 * @returns {void}
 */
export function renderDmFogOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number): void {
  if (!sessionState.active) return;
  // Show overlay when: forced by a tool (e.g. fog reveal), OR manually enabled while session panel is open
  if (!sessionState.dmViewForced && !(sessionState.dmViewActive && state.sessionToolsActive)) return;

  const cells = state.dungeon.cells;
  const numRows = cells.length;
  const numCols = cells[0]?.length || 0;

  // Build a single clipping path from all unrevealed cells
  ctx.save();
  ctx.beginPath();
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (!cells[r]?.[c]) continue;
      if (sessionState.revealedCells.has(cellKey(r, c))) continue;
      const { x, y } = toCanvas(c * gridSize, r * gridSize, transform);
      const size = gridSize * transform.scale;
      ctx.rect(x, y, size, size);
    }
  }
  ctx.clip();

  // Semi-transparent base tint
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Diagonal hatching — makes this clearly distinct from ambient lighting darkness
  const spacing = 8;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const w = ctx.canvas.width, h = ctx.canvas.height;
  for (let i = -h; i < w; i += spacing) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
  }
  ctx.stroke();

  ctx.restore();
}

// ── Debug: dump cell data + fog state for a region ──────────────────────────

/**
 * Dump cell data and fog state for a rectangular region (debug helper).
 * @param {number} r1 - First corner row.
 * @param {number} c1 - First corner column.
 * @param {number} r2 - Second corner row.
 * @param {number} c2 - Second corner column.
 * @returns {Array|null} 2D array of cell debug info, or null if debug panel is disabled.
 */
export function dumpFogRegion(r1: number, c1: number, r2: number, c2: number): any[] | null {
  if (!getEditorSettings().debug) {
    console.log('[dumpFogRegion] Enable the debug panel first (View > Developer > Debug Panel)');
    return null;
  }
  const cells = state.dungeon.cells;
  const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
  const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);

  const result = [];
  for (let r = minR; r <= maxR; r++) {
    const row = [];
    for (let c = minC; c <= maxC; c++) {
      const cell = cells[r]?.[c];
      const revealed = sessionState.revealedCells.has(cellKey(r, c));
      if (!cell) {
        row.push({ r, c, type: 'null', revealed });
      } else {
        // Full deep clone of cell data — don't cherry-pick properties
        const entry = JSON.parse(JSON.stringify(cell));
        entry.r = r;
        entry.c = c;
        entry.revealed = revealed;
        entry.type = cell.trimClip ? 'trimArc' : 'floor';
        row.push(entry);
      }
    }
    result.push(row);
  }

  // Download as JSON file
  const json = JSON.stringify({ r1: minR, c1: minC, r2: maxR, c2: maxC, cells: result }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fog-debug-${minR}-${minC}-${maxR}-${maxC}.json`;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`[dumpFogRegion] Downloaded fog-debug-${minR}-${minC}-${maxR}-${maxC}.json`);
  return result;
}

// Expose on window for console access
if (typeof window !== 'undefined') {
  // @ts-expect-error — strict-mode migration
  window.dumpFogRegion = dumpFogRegion;
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
    // @ts-expect-error — strict-mode migration
    openedSet.add(`${d.row},${d.col},${d.dir}`);
    // @ts-expect-error — strict-mode migration
    if ((OFFSETS as any)[d.dir]) {
      // @ts-expect-error — strict-mode migration
      const [dr, dc] = (OFFSETS as any)[d.dir];
      // @ts-expect-error — strict-mode migration
      openedSet.add(`${d.row + dr},${d.col + dc},${(OPPOSITE as any)[d.dir]}`);
    }
  }

  for (const key of sessionState.revealedCells) {
    // @ts-expect-error — strict-mode migration
    const [r, c] = parseCellKey(key);
    const cell = cells[r]?.[c];
    if (!cell) continue;

    // Cardinal doors (normal, secret, and invisible)
    for (const dir of ['north', 'south', 'east', 'west']) {
      if ((cell as any)[dir] !== 'd' && (cell as any)[dir] !== 's' && (cell as any)[dir] !== 'id') continue;

      const dkey = `${r},${c},${dir}`;
      if (seen.has(dkey)) continue;

      const isSecret = (cell as any)[dir] === 's';
      const isInvisible = (cell as any)[dir] === 'id';

      // Secret doors: always show button until opened
      if (isSecret) {
        if (openedSet.has(dkey)) continue;
        seen.add(dkey);
        doors.push({ row: r, col: c, dir, type: 's' });
        continue;
      }

      // Normal/invisible doors: only show if neighbor is unrevealed
      const [dr, dc] = (OFFSETS as any)[dir];
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
      if ((cell as any)[diagDir] !== 'd' && (cell as any)[diagDir] !== 's' && (cell as any)[diagDir] !== 'id') continue;

      const dkey = `${r},${c},${diagDir}`;
      if (seen.has(dkey)) continue;

      const isSecret = (cell as any)[diagDir] === 's';
      const isInvisible = (cell as any)[diagDir] === 'id';

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
        // @ts-expect-error — strict-mode migration
        const { dr, dc } = CARDINAL_DIRS.find(d => d.dir === exitDir);
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
  return mergeDoorRuns(doors);
}

/**
 * Group adjacent cardinal doors of the same direction and type into merged runs.
 * Each merged run produces a single door entry with a `cells` array.
 * Diagonal doors pass through unchanged.
 */
function mergeDoorRuns(doors: any) {
  // Step direction for grouping: north/south doors run along columns, east/west along rows
  const STEP = { north: [0, 1], south: [0, 1], east: [1, 0], west: [1, 0] };

  const cardinalDoors = [];
  const otherDoors = [];
  for (const d of doors) {
    if ((STEP as any)[d.dir]) cardinalDoors.push(d);
    else otherDoors.push(d);
  }

  // Group by direction + type + fixed coordinate (row for N/S, col for E/W)
  const groups = {};
  for (const door of cardinalDoors) {
    const [dr] = (STEP as any)[door.dir];
    const fixedCoord = dr === 0 ? door.row : door.col;
    const key = `${door.dir}:${door.type}:${fixedCoord}`;
    if (!(groups as any)[key]) (groups as any)[key] = [];
    (groups as any)[key].push(door);
  }

  const merged = [];
  for (const key of Object.keys(groups)) {
    const group = (groups as any)[key];
    const dir = group[0].dir;
    const [dr] = (STEP as any)[dir];

    // Sort by step coordinate
    group.sort((a: any, b: any) => (dr === 0 ? a.col - b.col : a.row - b.row));

    // Find consecutive runs
    let runStart = 0;
    for (let i = 1; i <= group.length; i++) {
      const prev = group[i - 1];
      const curr = group[i];
      const prevStep = dr === 0 ? prev.col : prev.row;
      const currStep = curr ? (dr === 0 ? curr.col : curr.row) : -999;

      if (currStep !== prevStep + 1) {
        const run = group.slice(runStart, i);
        if (run.length === 1) {
          merged.push(run[0]);
        } else {
          merged.push({
            row: run[0].row,
            col: run[0].col,
            dir: run[0].dir,
            type: run[0].type,
            cells: run.map((d: any) => ({ row: d.row, col: d.col })),
          });
        }
        runStart = i;
      }
    }
  }

  merged.push(...otherDoors);
  return merged;
}

/**
 * For a diagonal door in a revealed cell, determine which cardinal exit directions
 * belong to the unrevealed (other) half.
 */
function getOtherSideDirs(cell: any, r: any, c: any, diagDir: any) {
  // Determine which half is revealed by checking which neighbors are revealed
  if (diagDir === 'nw-se') {
    // NE half exits: north, east. SW half exits: south, west.
    const neRevealed = ['north', 'east'].some(d => {
      // @ts-expect-error — strict-mode migration
      const { dr, dc } = CARDINAL_DIRS.find(cd => cd.dir === d);
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return neRevealed ? ['south', 'west'] : ['north', 'east'];
  }
  if (diagDir === 'ne-sw') {
    // NW half exits: north, west. SE half exits: south, east.
    const nwRevealed = ['north', 'west'].some(d => {
      // @ts-expect-error — strict-mode migration
      const { dr, dc } = CARDINAL_DIRS.find(cd => cd.dir === d);
      return sessionState.revealedCells.has(cellKey(r + dr, c + dc));
    });
    return nwRevealed ? ['south', 'east'] : ['north', 'west'];
  }
  return null;
}

/**
 * Get the canvas pixel position of a single cell's door midpoint.
 */
function getSingleDoorMidpoint(row: any, col: any, dir: any, gridSize: any, transform: any) {
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
 * Get the canvas pixel position of a door midpoint.
 * For merged doors (with a `cells` array), returns the center of the full run.
 */
function getDoorMidpoint(door: any, gridSize: any, transform: any) {
  if (door.cells && door.cells.length > 1) {
    const first = door.cells[0];
    const last = door.cells[door.cells.length - 1];
    const p1 = getSingleDoorMidpoint(first.row, first.col, door.dir, gridSize, transform);
    const p2 = getSingleDoorMidpoint(last.row, last.col, door.dir, gridSize, transform);
    // @ts-expect-error — strict-mode migration
    return { x: (p1!.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }
  return getSingleDoorMidpoint(door.row, door.col, door.dir, gridSize, transform);
}

/**
 * Draw a small open-door icon using canvas paths.
 */
function drawDoorIcon(ctx: any, x: any, y: any, radius: any, color: any) {
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
 * Render door-open and stair overlay buttons on the DM canvas.
 * @param {CanvasRenderingContext2D} ctx - The canvas 2D context.
 * @param {Object} transform - The pan/zoom transform.
 * @param {number} gridSize - Grid cell size in feet.
 * @returns {void}
 */
export function renderSessionOverlay(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number): void {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return;

  // Door buttons
  const doors = findRevealableDoors();
  for (const door of doors) {
    const p = getDoorMidpoint(door, gridSize, transform);
    const color = door.type === 's' ? 'rgba(220, 60, 60, 0.85)'
                : door.type === 'id' ? 'rgba(80, 130, 255, 0.85)'
                : 'rgba(60, 180, 170, 0.85)';
    // @ts-expect-error — strict-mode migration
    drawDoorIcon(ctx, p!.x, p.y, DOOR_BUTTON_RADIUS, color);
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
 * @param {number} px - Canvas pixel X.
 * @param {number} py - Canvas pixel Y.
 * @param {Object} transform - The pan/zoom transform.
 * @param {number} gridSize - Grid cell size in feet.
 * @returns {Object|null} The door object if hit, or null.
 */
export function hitTestDoorButton(px: number, py: number, transform: RenderTransform, gridSize: number): any {
  if (!sessionState.active || sessionState.revealedCells.size === 0) return null;

  const doors = findRevealableDoors();
  for (const door of doors) {
    const p = getDoorMidpoint(door, gridSize, transform);
    // @ts-expect-error — strict-mode migration
    const dx = px - p!.x, dy = py - p.y;
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
    // @ts-expect-error — strict-mode migration
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
function getStairButtonPos(stair: any, transform: any) {
  const p = toCanvas(stair.worldX, stair.worldY, transform);
  const s = transform.scale / 10;
  return { x: p.x + 10 * s, y: p.y + 10 * s };
}

/**
 * Draw an amber stair-open button.
 */
function drawStairIcon(ctx: any, x: any, y: any, radius: any) {
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
 * @param {number} px - Canvas pixel X.
 * @param {number} py - Canvas pixel Y.
 * @param {Object} transform - The pan/zoom transform.
 * @returns {Object|null} The stair object if hit, or null.
 */
export function hitTestStairButton(px: number, py: number, transform: RenderTransform): any {
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
 * @param {number} stairId - ID of the stair being opened.
 * @param {number} partnerId - ID of the linked partner stair.
 * @returns {void}
 */
export function openStairs(stairId: number, partnerId: number): void {
  const stairs = state.dungeon.metadata?.stairs || [];

  // Record both IDs as opened
  // @ts-expect-error — strict-mode migration
  sessionState.openedStairs.push(stairId, partnerId);

  // BFS reveal from the partner stair's first occupied cell
  const partner = stairs.find(s => s.id === partnerId);
  let allNewCells: any = [];
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
