// Session panel UI: start/stop session, starting room picker, player count, open player view.

import state, { subscribe } from '../state.js';
import { sessionState, startSession, endSession, setStartingRoom, revealAll, resetFog, toggleDmView } from '../dm-session.js';
import { showToast } from '../toast.js';
import { cellKey } from '../../../util/index.js';
import { getEditorSettings, setEditorSetting } from '../editor-settings.js';

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

let _lastSessionActive: unknown = null;
let _lastSessionCells: unknown = null;
let _lastPlayerCount: unknown = null;
let _lastDmViewActive: unknown = null;
let _lastDmViewForced: unknown = null;
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
  const playerUrl = `http://${localIP ?? ''}:${location.port || 3000}/player/`;
  const savedPassword = String(getEditorSettings().sessionPassword ?? '');
  const copySvg = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" stroke-width="1.5"/></svg>`;

  container.innerHTML = `
    <div class="panel-title">Player Session</div>

    <button class="toolbar-btn session-toggle-btn" style="width:100%;margin-bottom:10px;">
      ${active ? 'End Session' : 'Start Session'}
    </button>

    ${!active ? `
      <div class="panel-field session-password-field">
        <label>Player Password <span style="color:var(--text-dim);font-weight:normal;">(optional)</span></label>
        <div class="session-password-row">
          <input type="password" class="session-password-input" value="${savedPassword.replace(/"/g, '&quot;')}" placeholder="No password">
          <button class="session-copy-btn session-password-copy" title="Copy password">${copySvg}</button>
        </div>
      </div>
    ` : `
      <div class="session-info">
        <div class="session-field-row">
          <label>Players</label>
          <span class="session-player-count">${sessionState.playerCount}</span>
        </div>
        <div class="session-field-row">
          <label>Starting Room</label>
          <select class="session-room-select">
            <option value="">— pick —</option>
            ${labels.map(l => `<option value="${l.key}" ${l.key === sessionState.startingRoom ? 'selected' : ''}>${l.label}</option>`).join('')}
          </select>
        </div>

        <div class="session-section-label">Share with Players</div>
        <div class="session-share-row">
          <label>Link</label>
          <div class="session-link-row" data-url="${playerUrl}">
            <code class="session-ip-link" title="Click to copy">http://••••••••••:${location.port || 3000}/pl…</code>
            <button class="session-copy-btn" title="Copy player link">${copySvg}</button>
          </div>
        </div>
        ${savedPassword ? `
        <div class="session-share-row">
          <label>Password</label>
          <div class="session-link-row" data-url="${savedPassword}">
            <code class="session-ip-link" title="Click to copy">${'•'.repeat(Math.min(savedPassword.length, 20))}</code>
            <button class="session-copy-btn" title="Copy password">${copySvg}</button>
          </div>
        </div>
        ` : ''}

        <div class="session-section-label">Fog of War</div>
        <div class="session-field-row">
          <label>DM View</label>
          <div class="trim-toggle">
            <button class="toolbar-btn session-dm-view-yes ${(sessionState.dmViewActive || sessionState.dmViewForced) ? 'active' : ''}" ${sessionState.dmViewForced ? 'disabled' : ''}>Yes</button>
            <button class="toolbar-btn session-dm-view-no ${!(sessionState.dmViewActive || sessionState.dmViewForced) ? 'active' : ''}" ${sessionState.dmViewForced ? 'disabled' : ''}>No</button>
          </div>
        </div>
        <div style="display:flex;gap:4px;margin-top:8px;">
          <button class="toolbar-btn session-reveal-all" style="flex:1;font-size:11px;">Reveal All</button>
          <button class="toolbar-btn session-reset-fog" style="flex:1;font-size:11px;">Reset Fog</button>
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">
          Revealed: ${sessionState.revealedCells.size} cells
        </div>

        <button class="toolbar-btn session-open-player" style="width:100%;margin-top:10px;">
          Open Player View ↗
        </button>
      </div>
    `}
  `;

  // Wire events
  const pwInput = container.querySelector<HTMLInputElement>('.session-password-input');
  pwInput?.addEventListener('input', () => {
    setEditorSetting('sessionPassword', pwInput.value);
  });
  container.querySelector('.session-password-copy')?.addEventListener('click', () => {
    const pw = pwInput?.value;
    if (pw) void navigator.clipboard.writeText(pw).then(() => showToast('Password copied'));
    else showToast('No password set');
  });

  container.querySelector('.session-toggle-btn')?.addEventListener('click', () => {
    if (active) {
      endSession();
    } else {
      const pw = String(getEditorSettings().sessionPassword ?? '');
      void startSession(pw || undefined);
    }
  });

  container.querySelector('.session-room-select')?.addEventListener('change', (e) => {
    const key = ((e.target ?? e.currentTarget) as HTMLSelectElement).value;
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

  container.querySelector('.session-dm-view-yes')?.addEventListener('click', () => {
    if (!sessionState.dmViewActive && !sessionState.dmViewForced) toggleDmView();
  });
  container.querySelector('.session-dm-view-no')?.addEventListener('click', () => {
    if (sessionState.dmViewActive && !sessionState.dmViewForced) toggleDmView();
  });

  container.querySelectorAll('.session-link-row').forEach(row => {
    const copy = () => {
      const url = (row as HTMLElement).dataset.url;
      if (!url) return;
      void navigator.clipboard.writeText(url).then(() => showToast('Link copied'));
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
