// DM session WebSocket connection, reconnect with exponential backoff, inbound message dispatch.

import { sessionState } from './dm-session-state.js';
import state, { notify } from './state.js';
import { showToast } from './toast.js';
import { broadcastInit } from './dm-session-broadcast.js';

// Reconnect backoff: start at 1s, double on each failure, cap at 30s, give up
// after MAX_RECONNECT_ATTEMPTS so we don't loop forever against a dead server.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 12; // ~6 min total wall time at the cap
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Inbound message size cap. Server enforces 2 MB; client refuses anything
// noticeably larger to defend against a compromised relay.
const WS_MAX_INBOUND = 4 * 1024 * 1024;

function scheduleReconnect() {
  if (!sessionState.active) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    showToast('Session disconnected — gave up reconnecting. Restart the session.');
    sessionState.active = false;
    return;
  }
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts++;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWS, delay);
}

export function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenParam = sessionState.token ? `&token=${sessionState.token}` : '';
  const url = `${protocol}//${location.host}/ws?role=dm${tokenParam}`;

  const ws = new WebSocket(url);
  sessionState.ws = ws;

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    showToast('Session started — connected to server');
    broadcastInit();
  });

  ws.addEventListener('close', () => {
    if (sessionState.active) {
      showToast('WebSocket disconnected — reconnecting…');
      scheduleReconnect();
    }
  });

  ws.addEventListener('error', () => ws.close());

  ws.addEventListener('message', (e) => {
    const raw = typeof e.data === 'string' ? e.data : String(e.data);
    if (raw.length > WS_MAX_INBOUND) {
      console.warn('[dm-session] inbound message exceeds size cap, dropping');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn('[dm-session] malformed WebSocket message', raw.slice(0, 120));
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    handleMessage(msg as Record<string, unknown>);
  });
}

export function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
}

// Range highlight callback (set by main.js)
interface RangeHighlightMsg {
  cells: { row: number; col: number }[];
  distanceFt: number;
  subTool: string;
  [key: string]: unknown;
}
let rangeHighlightCallback: ((msg: RangeHighlightMsg) => void) | null = null;
/**
 * Set the callback for incoming range highlights from players.
 * @param {Function} fn - Callback receiving the range highlight message.
 * @returns {void}
 */
export function setRangeHighlightCallback(fn: (msg: RangeHighlightMsg) => void): void {
  rangeHighlightCallback = fn;
}

// ── Inbound message validators ──────────────────────────────────────────────
// The relay only forwards messages with allowlisted types, but we still
// validate shape here so a compromised relay or future schema drift can't
// crash the editor.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isCellArray(v: unknown): v is { row: number; col: number }[] {
  if (!Array.isArray(v)) return false;
  if (v.length > 10_000) return false; // sanity cap
  for (const c of v) {
    if (!c || typeof c !== 'object') return false;
    const cell = c as { row?: unknown; col?: unknown };
    if (!isFiniteNumber(cell.row) || !isFiniteNumber(cell.col)) return false;
  }
  return true;
}

function handleMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'player:join':
      // New player connected — send them the current state
      broadcastInit();
      break;

    case 'player:count': {
      const count = msg.count;
      if (!isFiniteNumber(count) || count < 0 || count > 1000) return;
      sessionState.playerCount = count;
      state.session.playerCount = count;
      notify();
      break;
    }

    case 'range:highlight':
      // A player sent a range highlight — apply locally for DM rendering.
      // Validate the full structure before invoking the callback so a
      // malformed payload can't crash the renderer.
      if (
        rangeHighlightCallback &&
        isCellArray(msg.cells) &&
        isFiniteNumber(msg.distanceFt) &&
        typeof msg.subTool === 'string'
      ) {
        rangeHighlightCallback(msg as unknown as RangeHighlightMsg);
      }
      break;
  }
}
