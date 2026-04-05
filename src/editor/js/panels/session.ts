// Session panel UI: start/stop session, starting room picker, player count, open player view.

import state, { subscribe } from '../state.js';
import { sessionState, startSession, endSession, setStartingRoom, revealAll, resetFog, toggleDmView } from '../dm-session.js';
import { showToast } from '../toast.js';
import { cellKey } from '../../../util/index.js';

let container: HTMLElement | null = null;
let localIP: string | null = null;

/**
 * Initialize the session panel: start/stop session, fog controls, player view links.
 * @param {HTMLElement} containerEl - Container element for the panel
 */
export function initSessionPanel(containerEl: HTMLElement): void {
  container = containerEl;
  fetch('/api/local-ip').then(r => r.json()).then(d => { localIP = d.ip; render(); }).catch(() => {});
  render();
  subscribe(() => render(), 'session');
}

let _lastSessionActive = null;
let _lastSessionCells = null;
let _lastPlayerCount = null;
let _lastDmViewActive = null;
let _lastDmViewForced = null;
function render() {
  if (!container) return;

  const active = sessionState.active;
  // Skip rebuild if nothing relevant changed and DOM is still populated
  if (active === _lastSessionActive && state.dungeon.cells === _lastSessionCells && sessionState.playerCount === _lastPlayerCount && sessionState.dmViewActive === _lastDmViewActive && sessionState.dmViewForced === _lastDmViewForced && container.children.length > 0) return;
  _lastSessionActive = active;
  _lastSessionCells = state.dungeon.cells;
  _lastPlayerCount = sessionState.playerCount;
  _lastDmViewActive = sessionState.dmViewActive;
  _lastDmViewForced = sessionState.dmViewForced;

  const labels = findRoomLabels();

  container.innerHTML = `
    <div class="panel-title">Player Session</div>

    <button class="toolbar-btn session-toggle-btn" style="width:100%;margin-bottom:8px;">
      ${active ? 'End Session' : 'Start Session'}
    </button>

    ${active ? `
      <div class="session-info">
        <div class="panel-field">
          <label>Players</label>
          <span class="session-player-count">${sessionState.playerCount}</span>
        </div>

        <div class="panel-field" style="margin-top:6px;">
          <label>Starting Room</label>
          <select class="session-room-select" style="width:100px;">
            <option value="">— pick —</option>
            ${labels.map(l => `<option value="${l.key}" ${l.key === sessionState.startingRoom ? 'selected' : ''}>${l.label}</option>`).join('')}
          </select>
        </div>

        <div style="display:flex;gap:4px;margin-top:8px;">
          <button class="toolbar-btn session-reveal-all" style="flex:1;font-size:11px;">Reveal All</button>
          <button class="toolbar-btn session-reset-fog" style="flex:1;font-size:11px;">Reset Fog</button>
        </div>

        <button class="toolbar-btn session-open-player" style="width:100%;margin-top:8px;">
          Open Player View ↗
        </button>

        <div style="margin-top:8px;font-size:11px;color:var(--text-dim);">
          Revealed: ${sessionState.revealedCells.size} cells
        </div>

        <div class="panel-field" style="margin-top:8px;display:flex;align-items:center;gap:6px;">
          <input type="checkbox" id="dm-view-toggle" ${(sessionState.dmViewActive || sessionState.dmViewForced) ? 'checked' : ''} ${sessionState.dmViewForced ? 'disabled' : ''} style="cursor:pointer;">
          <label for="dm-view-toggle" style="cursor:pointer;font-size:12px;">DM View (fog overlay)</label>
        </div>

        <div style="font-size:11px;color:var(--text-dim);margin-top:8px;line-height:1.4;">
          Share this link with players on your local network:
        </div>
        <div class="session-link-row" data-url="http://${localIP || ''}:${location.port || 3000}/player/">
          <code class="session-ip-link" title="Click to copy">http://••••••••••:${location.port || 3000}/player/</code>
          <button class="session-copy-btn" title="Copy player link">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
              <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
        </div>
      </div>
    ` : `
      <div style="font-size:12px;color:var(--text-dim);line-height:1.5;">
        Start a session to enable the player view with fog of war.
        <div style="margin-top:6px;">Share this link with players on your local network:</div>
        <div class="session-link-row" data-url="http://${localIP || ''}:${location.port || 3000}/player/">
          <code class="session-ip-link" title="Click to copy">http://••••••••••:${location.port || 3000}/player/</code>
          <button class="session-copy-btn" title="Copy player link">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
              <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
        </div>
      </div>
    `}
  `;

  // Wire events
  container.querySelector('.session-toggle-btn')?.addEventListener('click', () => {
    if (active) endSession(); else startSession();
  });

  container.querySelector('.session-room-select')?.addEventListener('change', (e) => {
    const key = e.target.value;
    if (!key) return;
    const [r, c] = key.split(',').map(Number);
    setStartingRoom(r, c);
    showToast('Starting room set — fog revealed');
  });

  container.querySelector('.session-reveal-all')?.addEventListener('click', () => {
    revealAll();
    showToast('All rooms revealed');
  });

  container.querySelector('.session-reset-fog')?.addEventListener('click', () => {
    resetFog();
    showToast('Fog reset');
  });

  container.querySelector('.session-open-player')?.addEventListener('click', () => {
    window.open(`${location.origin}/player/`, '_blank');
  });

  container.querySelector('#dm-view-toggle')?.addEventListener('change', () => {
    toggleDmView();
  });

  container.querySelectorAll('.session-link-row').forEach(row => {
    const copy = () => {
      const url = row.dataset.url;
      if (!url) return;
      navigator.clipboard.writeText(url).then(() => showToast('Link copied'));
    };
    row.querySelector('.session-ip-link')?.addEventListener('click', copy);
    row.querySelector('.session-copy-btn')?.addEventListener('click', copy);
  });
}

/**
 * Find all labeled rooms in the dungeon.
 * Returns [{ label, key, row, col }].
 */
function findRoomLabels() {
  const cells = state.dungeon.cells;
  const labels = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[0]?.length || 0); c++) {
      const lbl = cells[r]?.[c]?.center?.label;
      if (lbl) labels.push({ label: lbl, key: cellKey(r, c), row: r, col: c });
    }
  }
  labels.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return labels;
}
