/**
 * Draggable toolbar, status bar, modals, and markdown parser.
 *
 * @module ui-components
 */

import state from './state.js';
import * as canvasView from './canvas-view.js';
import { showToast } from './toast.js';
import { getClaudeSettings, setClaudeSetting } from './claude-settings.js';
import { openWelcomeScreen } from './onboarding.js';

// ── Draggable toolbar ───────────────────────────────────────────────────────

/**
 * Initialize the draggable drawing toolbar with snap zones and persistence.
 * @returns {void}
 */
export function initDraggableToolbar(): void {
  const toolbar = document.getElementById('drawing-toolbar');
  const handle = document.getElementById('toolbar-drag-handle');
  const lockBtn = document.getElementById('toolbar-lock-btn');
  if (!toolbar || !handle || !lockBtn) return;

  let locked = true;
  let dragging = false;
  let startMouseX = 0, startMouseY = 0;
  let startLeft = 0, startBottom = 0;
  let activeSnap: any = null;
  let dragContainerWidth = 0;
  let dragContainerHeight = 0;

  const SNAP_EDGE = 20; // margin from container edge for snap positions
  const DOCK_CLASSES = ['toolbar-docked-top', 'toolbar-docked-left', 'toolbar-docked-right'];

  function applySnap(snapId: any) {
    toolbar!.classList.remove(...DOCK_CLASSES);
    // Use 'auto'/'none' not '' — clearing with '' exposes base CSS values
    // (base CSS has bottom: 20px and left: 50% which would create conflicts)
    toolbar!.style.left = 'auto';
    toolbar!.style.right = 'auto';
    toolbar!.style.top = 'auto';
    toolbar!.style.bottom = 'auto';
    toolbar!.style.transform = 'none';

    if (snapId === 'center-bottom') {
      toolbar!.style.left = '50%';
      toolbar!.style.transform = 'translateX(-50%)';
      toolbar!.style.bottom = `${SNAP_EDGE}px`;
    } else if (snapId === 'center-top') {
      toolbar!.style.left = '50%';
      toolbar!.style.transform = 'translateX(-50%)';
      toolbar!.style.top = `${SNAP_EDGE}px`;
      toolbar!.classList.add('toolbar-docked-top');
    } else if (snapId === 'center-left') {
      toolbar!.style.left = `${SNAP_EDGE}px`;
      toolbar!.style.top = '50%';
      toolbar!.style.transform = 'translateY(-50%)';
      toolbar!.classList.add('toolbar-docked-left');
    } else if (snapId === 'center-right') {
      toolbar!.style.right = `${SNAP_EDGE}px`;
      toolbar!.style.top = '50%';
      toolbar!.style.transform = 'translateY(-50%)';
      toolbar!.classList.add('toolbar-docked-right');
    }
  }

  function applyStoredPosition() {
    const saved = localStorage.getItem('mw-toolbar-pos');
    if (!saved) return;
    try {
      const pos = JSON.parse(saved);
      if (pos.snap) {
        applySnap(pos.snap);
        return;
      }
      const { left, bottom } = pos;
      if (isNaN(left) || isNaN(bottom)) return; // discard legacy { left, top } format
      toolbar!.style.left = `${left}px`;
      toolbar!.style.right = 'auto';
      toolbar!.style.bottom = `${bottom}px`;
      toolbar!.style.top = 'auto';
      toolbar!.style.transform = 'none';
    } catch {}
  }

  // Load persisted position and lock state
  const savedLocked = localStorage.getItem('mw-toolbar-locked');
  if (savedLocked === 'false') {
    locked = false;
    lockBtn.textContent = '🔓';
    toolbar.classList.add('toolbar-unlocked');
  }
  applyStoredPosition();

  lockBtn.addEventListener('click', () => {
    locked = !locked;
    lockBtn.textContent = locked ? '🔒' : '🔓';
    toolbar.classList.toggle('toolbar-unlocked', !locked);
    localStorage.setItem('mw-toolbar-locked', String(locked));
    if (locked && !localStorage.getItem('mw-toolbar-pos')) {
      // Reset to default centered position if no saved position
      toolbar.classList.remove(...DOCK_CLASSES);
      toolbar.style.left = '';
      toolbar.style.right = '';
      toolbar.style.top = '';
      toolbar.style.bottom = '';
      toolbar.style.transform = '';
    }
  });

  handle.addEventListener('mousedown', (e) => {
    if (locked) return;
    e.preventDefault();
    const container = toolbar.parentElement;
    const containerRect = container!.getBoundingClientRect();
    dragContainerWidth = containerRect.width;
    dragContainerHeight = containerRect.height;
    // Switch to horizontal layout first, then measure — so handle offsets
    // reflect the horizontal toolbar, not whatever docked orientation was active
    toolbar.classList.remove(...DOCK_CLASSES);
    toolbar.style.transform = 'none';
    // Force layout reflow to get handle position within the horizontal toolbar
    const toolbarRect = toolbar.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    const handleOffsetX = handleRect.left - toolbarRect.left;
    const handleOffsetY = handleRect.top  - toolbarRect.top;
    // Set startLeft/startBottom so the handle sits directly under the mouse
    startLeft   = (e.clientX - containerRect.left) - handleOffsetX;
    startBottom = containerRect.height - toolbarRect.height
                  - (e.clientY - containerRect.top) + handleOffsetY;
    toolbar.style.left   = `${startLeft}px`;
    toolbar.style.right  = 'auto';
    toolbar.style.bottom = `${startBottom}px`;
    toolbar.style.top    = 'auto';
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    activeSnap = null;
    dragging = true;
    // Show snap indicators
    const snapIndicators = document.getElementById('snap-indicators');
    if (snapIndicators) {
      snapIndicators.classList.add('visible');
      snapIndicators.querySelectorAll('.snap-indicator').forEach(el => el.classList.remove('active'));
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newLeft = startLeft + (e.clientX - startMouseX);
    // Moving mouse down (positive deltaY) decreases bottom distance
    const newBottom = startBottom - (e.clientY - startMouseY);

    // Check snap zones — snap if any part of toolbar overlaps the indicator rect
    const toolbarW = toolbar.offsetWidth;
    const toolbarH = toolbar.offsetHeight;
    const toolbarTop = dragContainerHeight - newBottom - toolbarH;
    const cW = dragContainerWidth;
    const cH = dragContainerHeight;
    // Toolbar rect in container coordinates (y-down)
    const tb = { x1: newLeft, y1: toolbarTop, x2: newLeft + toolbarW, y2: toolbarTop + toolbarH };
    // Snap indicator rects — must match CSS dimensions (100×20 for top/bottom, 20×100 for left/right)
    const snapRects = {
      'center-bottom': { x1: cW/2-50, y1: cH-SNAP_EDGE-20, x2: cW/2+50, y2: cH-SNAP_EDGE },
      'center-top':    { x1: cW/2-50, y1: SNAP_EDGE,        x2: cW/2+50, y2: SNAP_EDGE+20 },
      'center-left':   { x1: SNAP_EDGE,       y1: cH/2-50, x2: SNAP_EDGE+20,       y2: cH/2+50 },
      'center-right':  { x1: cW-SNAP_EDGE-20, y1: cH/2-50, x2: cW-SNAP_EDGE,       y2: cH/2+50 },
    };
    const prevSnap = activeSnap;
    activeSnap = null;
    for (const [snapId, sr] of Object.entries(snapRects)) {
      if (tb.x1 < sr.x2 && tb.x2 > sr.x1 && tb.y1 < sr.y2 && tb.y2 > sr.y1) {
        activeSnap = snapId;
        break;
      }
    }

    // Always keep toolbar following the mouse during drag — snap fires on mouseup
    toolbar.classList.remove(...DOCK_CLASSES);
    toolbar.style.left = `${newLeft}px`;
    toolbar.style.bottom = `${newBottom}px`;
    toolbar.style.top = 'auto';
    toolbar.style.right = 'auto';
    toolbar.style.transform = 'none';

    if (activeSnap !== prevSnap) {
      toolbar.classList.toggle('toolbar-snapping', !!activeSnap);
      // Highlight the active snap indicator
      const snapIndicators = document.getElementById('snap-indicators');
      if (snapIndicators) {
        snapIndicators.querySelectorAll('.snap-indicator').forEach(el => {
          el.classList.toggle('active', el.dataset.snap === activeSnap);
        });
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    toolbar.classList.remove('toolbar-snapping');
    // Hide snap indicators
    const snapIndicators = document.getElementById('snap-indicators');
    if (snapIndicators) {
      snapIndicators.classList.remove('visible');
      snapIndicators.querySelectorAll('.snap-indicator').forEach(el => el.classList.remove('active'));
    }
    if (activeSnap) {
      applySnap(activeSnap);
      localStorage.setItem('mw-toolbar-pos', JSON.stringify({ snap: activeSnap }));
    } else {
      const left = parseInt(toolbar.style.left, 10);
      const bottom = parseInt(toolbar.style.bottom, 10);
      if (!isNaN(left) && !isNaN(bottom)) {
        localStorage.setItem('mw-toolbar-pos', JSON.stringify({ left, bottom }));
      }
    }
    activeSnap = null;
  });
}

// ── Status bar ──────────────────────────────────────────────────────────────

/**
 * Update the status bar with cursor position, level name, zoom, and file name.
 * @returns {void}
 */
export function updateStatusBar(): void {
  const leftEl = document.getElementById('status-left');
  const centerEl = document.getElementById('status-center');
  const rightEl = document.getElementById('status-right');
  if (!leftEl) return;

  const hovered = state.hoveredCell;
  const cursorText = hovered ? `row: ${hovered.row}, col: ${hovered.col}` : '—';
  const zoom = Math.round(state.zoom * 100);

  // Detect which level the hovered cell belongs to
  const levels = state.dungeon.metadata.levels;
  let levelName = null;
  if (levels?.length) {
    if (hovered) {
      for (let i = levels.length - 1; i >= 0; i--) {
        if (hovered.row >= levels[i].startRow) {
          levelName = levels[i].name;
          break;
        }
      }
    } else {
      levelName = levels[state.currentLevel]?.name || null;
    }
  }

  const parts = [cursorText];
  if (levelName) parts.push(levelName);
  parts.push(`<span id="status-zoom" title="Click to reset zoom to 100%">zoom: ${zoom}%</span>`);
  leftEl.innerHTML = parts.join('  |  ');

  // Wire zoom click on the freshly created element (innerHTML rebuilds DOM each call)
  const zoomEl = document.getElementById('status-zoom');
  if (zoomEl && !zoomEl._wired) {
    zoomEl._wired = true;
    zoomEl.addEventListener('click', () => {
      state.zoom = 1;
      canvasView.requestRender();
      updateStatusBar();
    });
  }

  // Status instruction in center
  if (centerEl) centerEl.textContent = state.statusInstruction || '';

  if (rightEl) rightEl.textContent = state.fileName || '';
}

// ── Markdown parser (for release notes) ─────────────────────────────────────

/**
 * Escape HTML special characters in a string.
 * @param {string} s - Raw text to escape.
 * @returns {string} HTML-safe string.
 */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Convert inline markdown (bold, italic, code) to HTML.
 * @param {string} text - Markdown text with inline formatting.
 * @returns {string} HTML string with inline formatting applied.
 */
export function inlineMd(text: string): string {
  let s = escHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

/**
 * Convert a markdown string to HTML (headings, lists, tables, code blocks).
 * @param {string} md - Full markdown text.
 * @returns {string} Rendered HTML string.
 */
export function mdToHtml(md: string): string {
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  let inTable = false;
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCode) {
        if (inList)  { html += '</ul>'; inList = false; }
        if (inTable) { html += '</tbody></table>'; inTable = false; }
        html += '<pre class="rn-pre"><code>';
        inCode = true;
      } else {
        html += '</code></pre>';
        inCode = false;
      }
      continue;
    }
    if (inCode) { html += escHtml(line) + '\n'; continue; }

    // Table separator row
    if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;
    // Table row
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      if (!inTable) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<table class="rn-table"><tbody>';
        inTable = true;
      }
      const cells = line.trim().slice(1, -1).split('|')
        .map(c => `<td>${inlineMd(c.trim())}</td>`).join('');
      html += `<tr>${cells}</tr>`;
      continue;
    }
    if (inTable) { html += '</tbody></table>'; inTable = false; }

    if (line.startsWith('### ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h4 class="rn-h4">${inlineMd(line.slice(4))}</h4>`;
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h3 class="rn-h3">${inlineMd(line.slice(3))}</h3>`;
      continue;
    }
    if (/^  [-*] /.test(line)) {
      if (!inList) { html += '<ul class="rn-list">'; inList = true; }
      html += `<li class="rn-li rn-li-nested">${inlineMd(line.slice(4))}</li>`;
      continue;
    }
    if (/^[-*] /.test(line)) {
      if (!inList) { html += '<ul class="rn-list">'; inList = true; }
      html += `<li class="rn-li">${inlineMd(line.slice(2))}</li>`;
      continue;
    }
    if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<div class="rn-gap"></div>';
      continue;
    }
    html += `<p class="rn-p">${inlineMd(line)}</p>`;
  }
  if (inList)  html += '</ul>';
  if (inTable) html += '</tbody></table>';
  if (inCode)  html += '</code></pre>';
  return html;
}

// ── Shortcuts modal ─────────────────────────────────────────────────────────

/**
 * Wire up the keyboard shortcuts modal (open/close handlers).
 * @returns {void}
 */
export function initShortcutsModal(): void {
  function openShortcutsModal() {
    const m = document.getElementById('modal-shortcuts') as HTMLDialogElement;
    if (m) m.showModal();
  }
  function closeShortcutsModal() {
    const m = document.getElementById('modal-shortcuts') as HTMLDialogElement;
    if (m) m.close();
  }
  document.getElementById('btn-shortcuts')?.addEventListener('click', openShortcutsModal);
  document.getElementById('modal-shortcuts-close')?.addEventListener('click', closeShortcutsModal);
  document.getElementById('modal-shortcuts')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeShortcutsModal();
  });

  // Expose openShortcutsModal for keydown handler (defined before it, called by name)
  window._openShortcutsModal = openShortcutsModal;
}

// ── Release Notes modal ─────────────────────────────────────────────────────

/**
 * Wire up the release notes modal (fetches changelog, renders markdown).
 * @returns {void}
 */
export function initReleaseNotesModal(): void {
  function openReleaseNotesModal() {
    const m = document.getElementById('modal-release-notes');
    if (!m) return;
    const body = document.getElementById('release-notes-body');
    const badge = document.getElementById('release-notes-version');
    if (body && !body.dataset.loaded) {
      body.textContent = 'Loading…';
      fetch('/api/changelog')
        .then(r => r.json())
        .then(({ version, notes }) => {
          if (badge) badge.textContent = version;
          body.innerHTML = mdToHtml(notes);
          body.dataset.loaded = '1';
        })
        .catch(() => { body.textContent = 'Could not load release notes.'; });
    }
    (m as HTMLDialogElement).showModal();
  }
  function closeReleaseNotesModal() {
    const m = document.getElementById('modal-release-notes') as HTMLDialogElement;
    if (m) m.close();
  }
  document.getElementById('btn-welcome')?.addEventListener('click', openWelcomeScreen);
  document.getElementById('btn-release-notes')?.addEventListener('click', openReleaseNotesModal);
  document.getElementById('modal-release-notes-close')?.addEventListener('click', closeReleaseNotesModal);
  document.getElementById('modal-release-notes')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeReleaseNotesModal();
  });
}

// ── Claude Settings modal ───────────────────────────────────────────────────

/**
 * Wire up the Claude AI settings modal (Ollama base URL, model selection).
 * @returns {void}
 */
export function initClaudeSettingsModal(): void {
  function updatePullCmd(modelValue: any) {
    const cmd = document.getElementById('claude-pull-cmd');
    if (cmd) cmd.textContent = `ollama pull ${modelValue}`;
  }
  function openClaudeSettingsModal() {
    const m = document.getElementById('modal-claude-settings');
    if (!m) return;
    const settings = getClaudeSettings();
    const baseInput = document.getElementById('claude-ollama-base');
    const modelSelect = document.getElementById('claude-model-select');
    if (baseInput) baseInput.value = settings.ollamaBase || 'http://localhost:11434';
    if (modelSelect) {
      modelSelect.value = settings.model || 'qwen3.5:9b';
      updatePullCmd(modelSelect.value);
    }
    (m as HTMLDialogElement).showModal();
  }
  function closeClaudeSettingsModal() {
    const m = document.getElementById('modal-claude-settings') as HTMLDialogElement;
    if (m) m.close();
  }
  document.getElementById('claude-model-select')?.addEventListener('change', (e) => updatePullCmd(e.target!.value));
  document.getElementById('btn-claude-settings')?.addEventListener('click', openClaudeSettingsModal);
  document.getElementById('claude-settings-cancel')?.addEventListener('click', closeClaudeSettingsModal);
  document.getElementById('modal-claude-settings')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeClaudeSettingsModal();
  });
  document.getElementById('claude-settings-save')?.addEventListener('click', () => {
    const baseInput = document.getElementById('claude-ollama-base');
    const modelSelect = document.getElementById('claude-model-select');
    if (baseInput) setClaudeSetting('ollamaBase', baseInput.value.trim() || 'http://localhost:11434');
    if (modelSelect) setClaudeSetting('model', modelSelect.value);
    closeClaudeSettingsModal();
    showToast('AI settings saved.');
  });
}
