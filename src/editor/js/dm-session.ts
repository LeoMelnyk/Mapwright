// DM-side session manager — barrel module.
// Delegates to sub-modules; re-exports everything for consumers.

import type { RenderTransform } from '../../types.js';
import state, { markDirty, notify } from './state.js';
import { requestRender, panToLevel } from './canvas-view.js';
import { showToast } from './toast.js';
import { cellKey } from '../../util/index.js';
import { toCanvas } from './utils.js';

// ── Sub-module re-exports ──────────────────────────────────────────────────

export { sessionState, send } from './dm-session-state.js';
export { connectWS, clearReconnect, setRangeHighlightCallback } from './dm-session-websocket.js';
export {
  broadcastInit,
  snapshotBroadcastBaseline,
  startViewportBroadcast,
  startDungeonBroadcast,
} from './dm-session-broadcast.js';
export {
  revealRoom,
  revealRoomFrom,
  getDiagonalOtherEntry,
  setStartingRoom,
  openDoor,
  revealAll,
  revealRect,
  concealRect,
  onMapLoaded,
  resetFog,
} from './dm-session-reveal.js';
export {
  renderSessionOverlay,
  hitTestDoorButton,
  hitTestStairButton,
  openStairs,
  dumpFogRegion,
} from './dm-session-overlays.js';

// ── Imports for local use ──────────────────────────────────────────────────

import { sessionState, send } from './dm-session-state.js';
import { connectWS, clearReconnect } from './dm-session-websocket.js';
import { startViewportBroadcast, startDungeonBroadcast } from './dm-session-broadcast.js';

// ── Session lifecycle ───────────────────────────────────────────────────────

/**
 * Start a DM session — requests a session token, connects WebSocket, reveals starting room, begins broadcasts.
 * @returns {void}
 */
export async function startSession(password?: string): Promise<void> {
  if (sessionState.active) return;

  // Request a session token from the server, optionally with a player password
  try {
    const body: Record<string, string> = {};
    if (password) body.password = password;
    const res = await fetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { token: string };
    sessionState.token = data.token;
  } catch {
    showToast('Failed to start session — server unreachable');
    return;
  }

  sessionState.active = true;
  state.session.active = true;
  connectWS();
  // Pan to first level (same as clicking it in the level selector)
  const levels = state.dungeon.metadata.levels;
  if (levels.length) {
    state.currentLevel = 0;
    panToLevel(levels[0]!.startRow, levels[0]!.numRows);
  }
  // Subscribe to viewport changes
  startViewportBroadcast();
  startDungeonBroadcast();
  markDirty();
  notify();
}

/**
 * End the active DM session — disconnects WebSocket, clears session token, and resets state.
 * @returns {void}
 */
export function endSession(): void {
  if (!sessionState.active) return;
  send({ type: 'session:end' });
  sessionState.active = false;
  clearReconnect();
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
  // Clear server-side session token
  void fetch('/api/session/end', { method: 'POST' }).catch(() => {});
  sessionState.token = null;
  showToast('Session ended');
  markDirty();
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
  const numCols = cells[0]?.length ?? 0;

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
  const w = ctx.canvas.width,
    h = ctx.canvas.height;
  for (let i = -h; i < w; i += spacing) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
  }
  ctx.stroke();

  ctx.restore();
}
