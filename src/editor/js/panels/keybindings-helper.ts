// Keybindings Helper — floating panel showing contextual keybinds for the active tool
import state, { subscribe } from '../state.js';

// ── Keybinding definitions per tool ─────────────────────────────────────────
// Each tool has global bindings (always shown) and optionally mode-specific ones.

const GLOBAL_BINDS = [
  { key: 'Tab', desc: 'Cycle sub-mode' },
  { key: 'Shift+Tab', desc: 'Cycle sub-mode (reverse)' },
  { key: 'H', desc: 'Zoom to fit' },
  { key: '?', desc: 'All shortcuts' },
  { key: 'Ctrl+Z', desc: 'Undo' },
  { key: 'Ctrl+Y', desc: 'Redo' },
  { key: 'Ctrl+S', desc: 'Save' },
];

const TOOL_BINDS = {
  room: [
    { key: 'Shift', desc: 'Constrain to square' },
    { key: 'Right-click', desc: 'Void cells' },
  ],
  paint: [
    { key: 'Alt', desc: 'Sample texture' },
    { key: 'Shift', desc: 'Flood fill', modes: ['texture', 'clear-texture'] },
    { key: 'Right-click', desc: 'Clear texture' },
  ],
  fill: [
    { key: 'D', desc: 'Cycle depth', modes: ['water', 'lava'] },
    { key: 'Shift+D', desc: 'Cycle depth (reverse)', modes: ['water', 'lava'] },
    { key: 'Right-click', desc: 'Clear fill' },
  ],
  wall: [
    { key: 'Right-click', desc: 'Remove wall' },
  ],
  door: [
    { key: 'Right-click', desc: 'Remove door' },
  ],
  label: [
    { key: 'Del', desc: 'Delete selected label' },
  ],
  stairs: [
    { key: 'Esc', desc: 'Cancel placement' },
    { key: 'Right-click', desc: 'Delete stair' },
  ],
  bridge: [
    { key: 'Esc', desc: 'Cancel placement' },
    { key: 'Del', desc: 'Delete bridge' },
  ],
  select: [
    { key: 'Arrows', desc: 'Move selection' },
    { key: 'Ctrl+C', desc: 'Copy cells' },
    { key: 'Ctrl+X', desc: 'Cut cells' },
    { key: 'Ctrl+V', desc: 'Paste cells' },
    { key: 'Del', desc: 'Delete cells' },
    { key: 'Esc', desc: 'Deselect' },
  ],
  trim: [
    { key: 'R', desc: 'Toggle round' },
    { key: 'I', desc: 'Toggle inverted' },
    { key: 'O', desc: 'Toggle open' },
  ],
  prop: [
    { key: 'R', desc: 'Rotate 90°' },
    { key: 'Shift+R', desc: 'Rotate -90°' },
    { key: 'F', desc: 'Flip' },
    { key: 'Arrows', desc: 'Nudge (1 ft)' },
    { key: 'Shift+Arrows', desc: 'Nudge (1 cell)' },
    { key: 'Ctrl+C', desc: 'Copy props' },
    { key: 'Ctrl+X', desc: 'Cut props' },
    { key: 'Ctrl+V', desc: 'Paste props' },
    { key: 'Del', desc: 'Delete prop' },
    { key: 'Esc', desc: 'Deselect' },
  ],
  erase: [],
  light: [
    { key: 'Ctrl+C', desc: 'Copy light' },
    { key: 'Ctrl+X', desc: 'Cut light' },
    { key: 'Ctrl+V', desc: 'Paste light' },
    { key: 'Del', desc: 'Delete selected light' },
  ],
};

// ── Session (DM) tool keybindings ────────────────────────────────────────────

const SESSION_GLOBAL_BINDS = [
  { key: '1', desc: 'Doors tool' },
  { key: '2', desc: 'Range tool' },
  { key: '3', desc: 'Fog Reveal tool' },
  { key: 'H', desc: 'Zoom to fit' },
  { key: '?', desc: 'All shortcuts' },
];

const SESSION_TOOL_BINDS = {
  doors: [
    { key: 'Click door', desc: 'Open / close door' },
  ],
  range: [
    { key: 'Click+Drag', desc: 'Measure area' },
    { key: 'Tab', desc: 'Cycle shape' },
    { key: 'Shift+Tab', desc: 'Cycle shape (reverse)' },
  ],
  'fog-reveal': [
    { key: 'Click+Drag', desc: 'Reveal rectangle' },
  ],
};

const SESSION_TOOL_NAMES = {
  doors: 'Doors',
  range: 'Range',
  'fog-reveal': 'Fog Reveal',
};

const SESSION_TOOL_KEYS = {
  doors: '1',
  range: '2',
  'fog-reveal': '3',
};

// Mode key for filtering mode-specific bindings
const TOOL_MODE_KEYS = {
  paint: 'paintMode',
  fill: 'fillMode',
};

let panel: any = null;
let headerEl: any = null;
let bodyEl: any = null;
let lastTool: any = null;
let lastMode: any = null;
let lastSessionActive = false;
let lastSessionTool: any = null;

// Drag state
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

function getToolDisplayName(toolName: any) {
  const names = {
    room: 'Room', paint: 'Paint', fill: 'Fill', wall: 'Wall', door: 'Door',
    label: 'Label', stairs: 'Stairs', bridge: 'Bridge', select: 'Select',
    trim: 'Trim', prop: 'Prop', erase: 'Erase', light: 'Light',
  };
  return (names as any)[toolName] || toolName;
}

function getToolShortcut(toolName: any) {
  const keys = {
    room: '1', paint: '2', fill: '3', wall: '4', door: '5', label: '6',
    stairs: 'S', bridge: 'B', trim: 'T', select: 'A', prop: 'Q', erase: 'E', light: 'L',
  };
  return (keys as any)[toolName] || null;
}

function getActiveSessionTool() {
  const btn = document.querySelector('[data-session-tool].active');
  return btn ? (btn as HTMLElement).dataset.sessionTool : 'doors';
}

function buildContent(toolName: any) {
  // Session mode: show DM tool binds instead of editor tool binds
  if (state.sessionToolsActive) {
    return buildSessionContent(getActiveSessionTool());
  }

  const modeKey = (TOOL_MODE_KEYS as any)[toolName];
  const currentMode = modeKey ? state[modeKey] : null;
  const toolBinds = ((TOOL_BINDS as any)[toolName] || []).filter((b: any) => {
    if (!b.modes) return true;
    return b.modes.includes(currentMode);
  });

  let html = '';

  if (toolBinds.length > 0) {
    html += '<div class="kb-section">';
    for (const b of toolBinds) {
      html += `<div class="kb-row"><kbd>${b.key}</kbd><span>${b.desc}</span></div>`;
    }
    html += '</div>';
  }

  html += '<div class="kb-section kb-section-global">';
  for (const b of GLOBAL_BINDS) {
    html += `<div class="kb-row"><kbd>${b.key}</kbd><span>${b.desc}</span></div>`;
  }
  html += '</div>';

  return html;
}

function buildSessionContent(sessionTool: any) {
  const toolBinds = (SESSION_TOOL_BINDS as any)[sessionTool] || [];
  let html = '';

  if (toolBinds.length > 0) {
    html += '<div class="kb-section">';
    for (const b of toolBinds) {
      html += `<div class="kb-row"><kbd>${b.key}</kbd><span>${b.desc}</span></div>`;
    }
    html += '</div>';
  }

  html += '<div class="kb-section kb-section-global">';
  for (const b of SESSION_GLOBAL_BINDS) {
    html += `<div class="kb-row"><kbd>${b.key}</kbd><span>${b.desc}</span></div>`;
  }
  html += '</div>';

  return html;
}

/**
 * Refresh the keybindings helper panel content for the current tool/mode.
 */
export function refreshKeybindingsHelper(): void {
  refresh();
}

function refresh() {
  if (!panel || panel.style.display === 'none') return;

  const sessionActive = state.sessionToolsActive;
  const sessionTool = sessionActive ? getActiveSessionTool() : null;
  const toolName = state.activeTool;
  const modeKey = (TOOL_MODE_KEYS as any)[toolName];
  const currentMode = modeKey ? state[modeKey] : null;

  // Skip if nothing changed
  if (sessionActive === lastSessionActive && sessionTool === lastSessionTool &&
      toolName === lastTool && currentMode === lastMode) return;
  lastSessionActive = sessionActive;
  lastSessionTool = sessionTool;
  lastTool = toolName;
  lastMode = currentMode;

  if (sessionActive) {
    const key = (SESSION_TOOL_KEYS as any)[sessionTool!];
    headerEl.textContent = `DM: ${(SESSION_TOOL_NAMES as any)[sessionTool!] || sessionTool}` + (key ? ` (${key})` : '');
  } else {
    const shortcut = getToolShortcut(toolName);
    headerEl.textContent = `${getToolDisplayName(toolName)} Tool` + (shortcut ? ` (${shortcut})` : '');
  }
  bodyEl.innerHTML = buildContent(toolName);
}

/**
 * Show or hide the keybindings helper overlay panel.
 * @param {boolean} [visible] - Explicit visibility, or toggle if omitted
 */
export function toggleKeybindingsHelper(visible?: boolean): void {
  if (!panel) return;
  const show = visible !== undefined ? visible : panel.style.display === 'none';
  panel.style.display = show ? '' : 'none';
  // Sync checkbox
  const cb = document.getElementById('feat-keybindings');
  if (cb) (cb as HTMLInputElement).checked = show;
  if (!show) {
    // Reset to default CSS position
    panel.style.left = '';
    panel.style.top = '';
    panel.style.bottom = '';
    panel.style.right = '';
    try { localStorage.removeItem('mw-keybindings-pos'); } catch {}
  } else {
    lastTool = null;
    lastMode = null;
    lastSessionActive = false;
    lastSessionTool = null;
    refresh();
  }
  // Persist preference
  try { localStorage.setItem('mw-keybindings-helper', show ? '1' : '0'); } catch {}
}

function onDragStart(e: any) {
  // Only left button
  if (e.button !== 0) return;
  isDragging = true;
  const rect = panel.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
  panel.classList.add('kb-dragging');
  e.preventDefault();
}

function onDragMove(e: any) {
  if (!isDragging) return;
  const x = e.clientX - dragOffsetX;
  const y = e.clientY - dragOffsetY;
  // Clamp to viewport
  const maxX = window.innerWidth - panel.offsetWidth;
  const maxY = window.innerHeight - panel.offsetHeight;
  panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
  panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
  // Clear default positioning once user drags
  panel.style.bottom = 'auto';
  panel.style.right = 'auto';
}

function onDragEnd() {
  if (!isDragging) return;
  isDragging = false;
  panel.classList.remove('kb-dragging');
  // Save position
  try {
    localStorage.setItem('mw-keybindings-pos', JSON.stringify({
      left: panel.style.left,
      top: panel.style.top,
    }));
  } catch {}
}

/**
 * Initialize the keybindings helper: build panel, restore position, and subscribe to tool changes.
 */
export function initKeybindingsHelper(): void {
  panel = document.getElementById('keybindings-helper');
  if (!panel) return;

  headerEl = panel.querySelector('.kb-header-title');
  bodyEl = panel.querySelector('.kb-body');
  const closeBtn = panel.querySelector('.kb-close');
  const dragHandle = panel.querySelector('.kb-header');

  closeBtn!.addEventListener('click', () => toggleKeybindingsHelper(false));
  dragHandle!.addEventListener('mousedown', onDragStart);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);

  // Restore saved position
  try {
    // @ts-expect-error — strict-mode migration
    const pos = JSON.parse(localStorage.getItem('mw-keybindings-pos'));
    if (pos?.left && pos?.top) {
      panel.style.left = pos.left;
      panel.style.top = pos.top;
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
    }
  } catch {}

  // Restore visibility preference (default: visible)
  const pref = localStorage.getItem('mw-keybindings-helper');
  const show = pref !== '0';
  panel.style.display = show ? '' : 'none';
  const cb = document.getElementById('feat-keybindings');
  if (cb) (cb as HTMLInputElement).checked = show;

  // Refresh on state changes (tool switch, mode switch, session toggle)
  subscribe(refresh, 'keybindings');

  // Session tool buttons don't trigger state.notify(), so listen for clicks directly
  const sessionToolRow = document.getElementById('session-tool-row');
  if (sessionToolRow) {
    sessionToolRow.addEventListener('click', () => {
      // Small delay so the active class has been toggled before we read it
      requestAnimationFrame(refresh);
    });
  }
}
