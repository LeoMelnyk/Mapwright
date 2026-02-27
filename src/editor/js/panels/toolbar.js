// Toolbar: tool buttons, door type, file ops, undo/redo
import state, { undo, redo, notify, subscribe, pushUndo, markDirty } from '../state.js';
import { loadDungeon, loadDungeonJSON, saveDungeon, saveDungeonAs, newDungeon, exportPng, exportMapFormat, reloadAssets } from '../io.js';
import { requestRender, setCursor } from '../canvas-view.js';
import { SYRINGE_CURSOR } from '../tools/tool-paint.js';
import { STAMP_CURSOR } from '../tools/tool-label.js';
import { convertOnePageDungeon } from '../import-opd.js';
import { convertDonjonDungeon } from '../import-donjon.js';
import { showToast } from '../toast.js';

let onToolChange = null;

export function setToolChangeCallback(cb) {
  onToolChange = cb;
}

/** Programmatically activate a tool (triggers the same callback as toolbar clicks). */
export function activateTool(name) {
  if (onToolChange) onToolChange(name);
}

/** Open a named sidebar panel (by panel ID) and activate its icon button. */
function openSidebarPanel(panelId) {
  const btn = document.querySelector(`.icon-btn[data-panel="${panelId}"]`);
  const panel = document.getElementById(`panel-${panelId}`);
  const sideContent = document.getElementById('side-content');
  if (!btn || !panel || !sideContent) return;

  document.querySelectorAll('.icon-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.side-panel').forEach(p => (p.style.display = 'none'));

  btn.classList.add('active');
  panel.style.display = panel.dataset.display || 'flex';
  sideContent.classList.remove('hidden');
}

// ── Sub-mode registry ────────────────────────────────────────────────────
// Single source of truth for all tool sub-options. Each entry drives:
//   click handlers, Tab/Shift+Tab cycling, cursor, and side effects.

const toolOptions = {
  room:   { key: 'roomMode',   attr: 'data-room-mode',   values: ['room', 'merge'] },
  paint:  { key: 'paintMode',  attr: 'data-paint-mode',
            values: ['texture', 'syringe', 'room', 'clear-texture'],
            cursor: v => v === 'syringe' ? SYRINGE_CURSOR : 'crosshair',
            onApply: v => {
              const r = document.getElementById('texture-opacity-row');
              if (r) r.style.display = v === 'texture' ? 'flex' : 'none';
              const s = document.getElementById('texture-secondary-row');
              if (s) s.style.display = (v === 'texture' || v === 'clear-texture') ? 'flex' : 'none';
              if (v === 'texture' || v === 'clear-texture' || v === 'syringe') openSidebarPanel('textures');
            } },
  fill:   { key: 'fillMode',   attr: 'data-fill-mode',
            values: ['water', 'lava', 'pit', 'difficult-terrain', 'clear-fill'],
            onApply: v => {
              const r = document.getElementById('water-depth-row');
              if (r) r.style.display = (v === 'water' || v === 'lava') ? 'flex' : 'none';
              // Sync depth button highlights to the active fluid's current depth
              if (v === 'water' || v === 'lava') {
                const activeDepth = (v === 'lava' ? state.lavaDepth : state.waterDepth) || 1;
                document.querySelectorAll('[data-water-depth]').forEach(b => {
                  b.classList.toggle('active', parseInt(b.dataset.waterDepth, 10) === activeDepth);
                });
              }
            } },
  erase:  { key: 'eraseMode',  attr: 'data-erase-mode',  values: ['all', 'texture'] },
  door:   { key: 'doorType',   attr: 'data-door-type',   values: ['d', 's'] },
  stairs: { key: 'stairsMode', attr: 'data-stairs-mode', values: ['place', 'link'],
            cursor: v => v === 'link' ? 'pointer' : 'crosshair' },
  bridge: { key: 'bridgeType', attr: 'data-bridge-type', values: ['wood', 'stone', 'rope', 'dock'] },
  trim:   { key: 'trimCorner', attr: 'data-trim-corner', values: ['auto', 'nw', 'ne', 'sw', 'se'],
            onApply: () => requestRender() },
  prop:   { key: 'propMode',   attr: 'data-prop-mode',   values: ['place', 'select'],
            cursor: v => v === 'select' ? 'default' : 'crosshair' },
  label:  { key: 'labelMode',  attr: 'data-label-mode',  values: ['room', 'dm'],
            cursor: v => v === 'dm' ? 'text' : STAMP_CURSOR,
            onApply: v => {
              const r = document.getElementById('dungeon-letter-row');
              if (r) r.style.display = (v === 'room' || !v) ? 'flex' : 'none';
            } },
  light:  { key: 'lightMode',  attr: 'data-light-mode',  values: ['place', 'select'],
            cursor: v => v === 'select' ? 'default' : 'crosshair' },
};

/** Fire onApply side effects for a tool's current sub-mode (e.g., open textures panel). */
export function applyToolSideEffects(toolName) {
  const opts = toolOptions[toolName];
  if (opts?.onApply) opts.onApply(state[opts.key] || opts.values[0]);
}

/** Convert a data attribute name to its dataset key, e.g. 'data-paint-mode' → 'paintMode'. */
function attrToDatasetKey(attr) {
  return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Set a sub-mode for a tool. Updates state, button highlights, cursor, and side effects. */
export function setSubMode(toolName, value) {
  const opts = toolOptions[toolName];
  if (!opts) return;
  state[opts.key] = value;
  document.querySelectorAll(`[${opts.attr}]`).forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute(opts.attr) === value);
  });
  if (state.activeTool === toolName && opts.cursor) setCursor(opts.cursor(value));
  if (opts.onApply) opts.onApply(value);
}

/** Cycle the active tool's sub-mode. delta = +1 (Tab) or -1 (Shift+Tab). */
export function cycleSubMode(delta) {
  const opts = toolOptions[state.activeTool];
  if (!opts) return false;
  const idx = opts.values.indexOf(state[opts.key]);
  const next = opts.values[(idx + delta + opts.values.length) % opts.values.length];
  setSubMode(state.activeTool, next);
  return true;
}

/** Get mode-aware cursor for a tool, or null if no cursor config in registry. */
export function getToolCursor(toolName) {
  const opts = toolOptions[toolName];
  return opts?.cursor ? opts.cursor(state[opts.key]) : null;
}

export function init() {
  // ── Menu bar dropdowns ─────────────────────────────────────────────────
  const menuItems = document.querySelectorAll('.menu-item');

  menuItems.forEach(item => {
    const trigger = item.querySelector('.menu-trigger');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = item.classList.contains('open');
      menuItems.forEach(mi => mi.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });

  // Close menus on outside click
  document.addEventListener('click', () => {
    menuItems.forEach(mi => mi.classList.remove('open'));
  });

  // Clicks inside dropdowns don't propagate to document (keeps menu open),
  // except menu-action buttons which explicitly close after acting.
  document.querySelectorAll('.menu-dropdown').forEach(dd => {
    dd.addEventListener('click', (e) => e.stopPropagation());
  });

  // Close menu after a menu-action is invoked (but not submenu triggers)
  document.querySelectorAll('.menu-action').forEach(action => {
    if (action.classList.contains('menu-submenu-trigger')) return;
    action.addEventListener('click', () => {
      menuItems.forEach(mi => mi.classList.remove('open'));
    });
  });

  // ── File operations ────────────────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', newDungeon);
  document.getElementById('btn-load').addEventListener('click', loadDungeon);
  document.getElementById('btn-save').addEventListener('click', saveDungeon);
  document.getElementById('btn-save-as').addEventListener('click', saveDungeonAs);
  document.getElementById('btn-export-png').addEventListener('click', exportPng);
  document.getElementById('btn-export-map').addEventListener('click', exportMapFormat);
  document.getElementById('btn-reload-assets').addEventListener('click', reloadAssets);

  // ── Import sub-menu ─────────────────────────────────────────────────
  document.getElementById('btn-import-opd')?.addEventListener('click', () => {
    menuItems.forEach(mi => mi.classList.remove('open'));
    showImportModal('One-Page-Dungeon', 'https://watabou.github.io/one-page-dungeon');
  });
  document.getElementById('btn-import-donjon')?.addEventListener('click', () => {
    menuItems.forEach(mi => mi.classList.remove('open'));
    showImportModal('Donjon', 'https://donjon.bin.sh/5e/dungeon/');
  });

  // ── Undo/redo ──────────────────────────────────────────────────────────
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  // ── Tool buttons ───────────────────────────────────────────────────────
  const toolButtons = document.querySelectorAll('[data-tool]');
  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const toolName = btn.dataset.tool;
      if (onToolChange) onToolChange(toolName);
      updateToolButtons();
      applyToolSideEffects(toolName);
      notify();
    });
  });

  // ── Sub-mode buttons (all tools, driven by toolOptions registry) ──────
  for (const [toolName, opts] of Object.entries(toolOptions)) {
    const dsKey = attrToDatasetKey(opts.attr);
    document.querySelectorAll(`[${opts.attr}]`).forEach(btn => {
      btn.addEventListener('click', () => setSubMode(toolName, btn.dataset[dsKey]));
    });
  }

  // Fluid depth buttons (shared by water and lava)
  document.querySelectorAll('[data-water-depth]').forEach(btn => {
    btn.addEventListener('click', () => {
      const depth = parseInt(btn.dataset.waterDepth, 10);
      const mode = state.fillMode || 'water';
      if (mode === 'lava') {
        state.lavaDepth = depth;
      } else {
        state.waterDepth = depth;
      }
      document.querySelectorAll('[data-water-depth]').forEach(b => {
        b.classList.toggle('active', b.dataset.waterDepth === btn.dataset.waterDepth);
      });
    });
  });

  // Dungeon letter dropdown — populate A–Z and wire change
  const letterSelect = document.getElementById('dungeon-letter-select');
  if (letterSelect) {
    for (let i = 0; i < 26; i++) {
      const ch = String.fromCharCode(65 + i);
      const opt = document.createElement('option');
      opt.value = ch;
      opt.textContent = ch;
      letterSelect.appendChild(opt);
    }
    letterSelect.value = state.dungeon.metadata.dungeonLetter || 'A';
    letterSelect.addEventListener('change', () => {
      const newLetter = letterSelect.value;
      const oldLetter = state.dungeon.metadata.dungeonLetter || 'A';
      if (newLetter === oldLetter) return;

      pushUndo();
      // Rename all existing room labels to use the new letter
      const pattern = /^[A-Z](\d+)$/;
      for (const row of state.dungeon.cells) {
        for (const cell of row) {
          if (cell?.center?.label) {
            const m = cell.center.label.match(pattern);
            if (m) cell.center.label = newLetter + m[1];
          }
        }
      }
      state.dungeon.metadata.dungeonLetter = newLetter;
      markDirty();
    });
  }

  // Texture opacity slider
  const opacitySlider = document.getElementById('texture-opacity-slider');
  const opacityValue = document.getElementById('texture-opacity-value');
  if (opacitySlider) {
    opacitySlider.addEventListener('input', () => {
      state.textureOpacity = parseInt(opacitySlider.value, 10) / 100;
      if (opacityValue) opacityValue.textContent = `${opacitySlider.value}%`;
    });
  }

  // Secondary texture checkbox
  const secondaryCb = document.getElementById('texture-secondary-cb');
  if (secondaryCb) {
    secondaryCb.checked = !!state.paintSecondary;
    secondaryCb.addEventListener('change', () => {
      state.paintSecondary = secondaryCb.checked;
    });
  }

  // Trim round/inverted checkboxes
  const trimRoundCb = document.getElementById('trim-round');
  if (trimRoundCb) {
    trimRoundCb.addEventListener('change', () => {
      state.trimRound = trimRoundCb.checked;
    });
  }
  const trimInvertedCb = document.getElementById('trim-inverted');
  if (trimInvertedCb) {
    trimInvertedCb.addEventListener('change', () => {
      state.trimInverted = trimInvertedCb.checked;
    });
  }
  const trimOpenCb = document.getElementById('trim-open');
  if (trimOpenCb) {
    trimOpenCb.addEventListener('change', () => {
      state.trimOpen = trimOpenCb.checked;
    });
  }

  updateToolButtons();
  // Initialize all sub-mode button highlights from current state (no side effects)
  for (const [, opts] of Object.entries(toolOptions)) {
    document.querySelectorAll(`[${opts.attr}]`).forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute(opts.attr) === (state[opts.key] || opts.values[0]));
    });
  }
  // Apply side effects for the restored active tool (e.g. show depth selector for water/lava)
  applyToolSideEffects(state.activeTool);

  // Keep dungeon letter dropdown in sync after load/new/undo.
  // Auto-detect the letter from existing labels when a new dungeon is loaded.
  let lastDungeon = null;
  subscribe(() => {
    const meta = state.dungeon.metadata;
    if (state.dungeon !== lastDungeon) {
      lastDungeon = state.dungeon;
      if (!meta.dungeonLetter) {
        meta.dungeonLetter = detectDungeonLetter(state.dungeon.cells);
      }
    }
    const sel = document.getElementById('dungeon-letter-select');
    if (sel) sel.value = meta.dungeonLetter || 'A';
    updateToolButtons();
  });
}

export function updateToolButtons() {
  const lightingEnabled = !!state.dungeon.metadata.lightingEnabled;

  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === state.activeTool);
    // Hide the light tool when lighting is disabled
    if (btn.dataset.tool === 'light') {
      btn.style.display = lightingEnabled ? '' : 'none';
    }
  });

  // If lighting was disabled while the light tool was active, switch away
  if (!lightingEnabled && state.activeTool === 'light') {
    state.activeTool = 'room';
    document.querySelectorAll('[data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === state.activeTool);
    });
    if (onToolChange) onToolChange('room');
  }

  // Show/hide sub-option bars — all follow the convention "${toolName}-options"
  // Hide all when session tools are active (session toolbar replaces the editor toolbar)
  for (const toolName of Object.keys(toolOptions)) {
    const bar = document.getElementById(`${toolName}-options`);
    if (bar) bar.style.display = (!state.sessionToolsActive && state.activeTool === toolName) ? 'flex' : 'none';
  }
}

/** Scan cells for room labels and return the most common letter prefix, or 'A'. */
function detectDungeonLetter(cells) {
  const counts = {};
  const pattern = /^([A-Z])\d+$/;
  for (const row of cells) {
    for (const cell of row) {
      if (cell?.center?.label) {
        const m = cell.center.label.match(pattern);
        if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
      }
    }
  }
  let best = 'A', bestCount = 0;
  for (const [letter, count] of Object.entries(counts)) {
    if (count > bestCount) { best = letter; bestCount = count; }
  }
  return best;
}

// ── Import modal ──────────────────────────────────────────────────────

function showImportModal(siteName, siteUrl) {
  // Remove any existing modal
  document.getElementById('import-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'import-modal-overlay';
  overlay.className = 'import-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'import-modal';

  // Steps
  const steps = document.createElement('ol');
  steps.className = 'import-modal-steps';
  const stepTexts = [
    `Open <a href="${siteUrl}" target="_blank" rel="noopener">${siteName}</a>`,
    'Create a dungeon',
    'Download the JSON',
    'Drop it here!'
  ];
  for (const html of stepTexts) {
    const li = document.createElement('li');
    li.innerHTML = html;
    steps.appendChild(li);
  }

  // Drop zone / file picker
  const dropZone = document.createElement('div');
  dropZone.className = 'import-modal-dropzone';

  const dropLabel = document.createElement('span');
  dropLabel.className = 'import-modal-drop-label';
  dropLabel.textContent = 'Drag & drop JSON here, or click to browse';
  dropZone.appendChild(dropLabel);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleImportFile(file, siteName);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) handleImportFile(file, siteName);
  });

  // Cancel button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'import-modal-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Close on Escape
  const onKey = (e) => {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);

  modal.appendChild(steps);
  modal.appendChild(dropZone);
  modal.appendChild(fileInput);
  modal.appendChild(cancelBtn);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function handleImportFile(file, siteName) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);

      let dungeon;
      if (siteName === 'One-Page-Dungeon') {
        dungeon = convertOnePageDungeon(json);
      } else if (siteName === 'Donjon') {
        dungeon = convertDonjonDungeon(json);
      } else {
        showToast('Unsupported import format');
        return;
      }

      loadDungeonJSON(dungeon, { fileName: file.name });
      document.getElementById('import-modal-overlay')?.remove();
      showToast(`Imported from ${siteName}`);
    } catch (err) {
      console.error('Import failed:', err);
      showToast('Import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
}
