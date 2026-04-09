// Onboarding: welcome modal, interactive tutorial, contextual first-use hints
//
// First launch: shows a welcome modal with three options:
//   - Start Tutorial (guided 5-step walkthrough)
//   - Explore Example (loads a pre-built demo dungeon)
//   - Start Fresh (blank canvas)
//
// First-use hints: shows a tip toast the first time each tool is activated.
// Tutorial: spotlight overlay that walks through creating a basic dungeon.

import type { EditorState } from '../../types.js';
import state, { subscribe, notify } from './state.js';
import { showToast } from './toast.js';
import { loadDungeonJSON } from './io.js';

const STORAGE_KEY = 'mw-onboarding-done';
const HINTS_KEY = 'mw-hints-seen';

// ─── First-Use Tool Hints ────────────────────────────────────────────────────

const TOOL_HINTS = {
  room:   'Shift = square · Tab = Room/Merge mode · Right-click = void cell',
  paint:  'Alt+Click = eyedrop texture · Tab = cycle Texture/Syringe/Room/Clear',
  fill:   'Click cells to fill · D/Shift+D = cycle depth · Tab = Water/Lava/Pit/Hazard',
  wall:   'Click between two cells to toggle a wall · Tab = Normal/Invisible',
  door:   'Click on a wall to add a door · Tab = Normal/Secret/Invisible',
  label:  'Click a cell to add a room label · Tab = Room Label/free-text DM note',
  stairs: 'Click 3 corner points to define stair shape · Tab = Place/Link mode',
  bridge: 'Click 3 points to place a bridge · R = rotate · Tab = Wood/Stone/Rope/Dock',
  trim:   'Drag from a room corner to trim · R = Round · I = Invert · O = Open',
  select: 'Drag to select cells · Ctrl+C/V = copy/paste · Ctrl+X = cut · Del = delete · Tab = Inspect',
  prop:   'Choose a prop from the sidebar, then click to place · R = rotate · F = flip',
  erase:  'Click or drag to erase cells · Shift = constrain to square',
  light:  'Choose a preset from the bar, then click to place · Ctrl+drag = resize radius · Ctrl+C/X/V = copy/cut/paste',
};

function getSeenHints() {
  try { return new Set(JSON.parse(localStorage.getItem(HINTS_KEY) ?? '[]')); }
  catch { return new Set(); }
}

function markHintSeen(tool: string) {
  const seen = getSeenHints();
  seen.add(tool);
  localStorage.setItem(HINTS_KEY, JSON.stringify([...seen]));
}

function showToolHint(tool: string) {
  if (!(TOOL_HINTS as Record<string, string>)[tool]) return;
  const seen = getSeenHints();
  if (seen.has(tool)) return;
  markHintSeen(tool);
  showToast(`\u{1f4a1} ${(TOOL_HINTS as Record<string, string>)[tool]}`, 6000);
}

// ─── Welcome Modal ───────────────────────────────────────────────────────────

function showWelcome(onTutorial: () => void, onExample: (url: string, name: string) => void, onFresh: () => void) {
  const overlay = document.createElement('div');
  overlay.className = 'onboarding-modal-overlay';
  overlay.innerHTML = `
    <div class="onboarding-modal">
      <div class="onboarding-modal-header">
        <img src="/MapwrightIcon.png" alt="Mapwright" width="32" height="32" class="onboarding-logo">
        <h2>Welcome to Mapwright</h2>
      </div>
      <p class="onboarding-modal-subtitle">A map editor for tabletop RPGs</p>
      <div class="onboarding-modal-options">
        <button class="onboarding-option" data-action="tutorial">
          <span class="onboarding-option-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>
            </svg>
          </span>
          <span class="onboarding-option-text">
            <strong>Quick Tour</strong>
            <span>Learn the basics in 5 steps (~2 min)</span>
          </span>
        </button>
      </div>
      <div class="onboarding-examples-section">
        <div class="onboarding-examples-label">Or explore an example map</div>
        <div class="onboarding-examples-grid" id="onboarding-examples-grid">
          <div class="onboarding-examples-loading">Loading examples...</div>
        </div>
      </div>
      <div class="onboarding-modal-options" style="margin-top:0">
        <button class="onboarding-option onboarding-option-subtle" data-action="fresh">
          <span class="onboarding-option-text">
            <strong>Start Fresh</strong>
            <span>I'll figure it out myself</span>
          </span>
        </button>
      </div>
      <div class="onboarding-modal-footer">
        Press <kbd>?</kbd> anytime for keyboard shortcuts
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Force reflow then animate in
  overlay.offsetHeight;
  overlay.classList.add('visible');

  function close() {
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    localStorage.setItem(STORAGE_KEY, 'true');
  }

  // Load example map thumbnails from the server
  const grid = overlay.querySelector('#onboarding-examples-grid');
  fetch('/api/examples')
    .then(r => r.json())
    .then(examples => {
      if (!examples.length) {
        grid!.innerHTML = '<div class="onboarding-examples-loading">No examples found</div>';
        return;
      }
      grid!.innerHTML = '';
      for (const ex of examples) {
        const btn = document.createElement('button');
        btn.className = 'onboarding-example-card';
        btn.dataset.url = ex.url;
        btn.dataset.name = ex.name;
        btn.innerHTML = `
          ${ex.thumbnail ? `<img src="${ex.thumbnail}" alt="${ex.name}" class="onboarding-example-img">` : '<div class="onboarding-example-img onboarding-example-placeholder"></div>'}
          <span class="onboarding-example-name">${ex.name}</span>
        `;
        btn.addEventListener('click', () => {
          close();
          onExample(ex.url, ex.name);
        });
        grid!.appendChild(btn);
      }
    })
    .catch(() => {
      grid!.innerHTML = '<div class="onboarding-examples-loading">Could not load examples</div>';
    });

  // Wire non-example buttons
  overlay.querySelector<HTMLInputElement>('[data-action="tutorial"]')?.addEventListener('click', () => { close(); onTutorial(); });
  overlay.querySelector<HTMLInputElement>('[data-action="fresh"]')?.addEventListener('click', () => { close(); onFresh(); });
}

// ─── Tutorial System ─────────────────────────────────────────────────────────

const TUTORIAL_STEPS = [
  {
    target: '[data-tool="room"]',
    title: 'Draw a Room',
    text: 'Select the <strong>Room</strong> tool, then click and drag on the canvas to draw a rectangular room. This is the foundation of every dungeon.',
    hint: 'Try it now — drag a rectangle on the grid!',
    position: 'right',
    waitFor: 'room-created',
  },
  {
    target: '[data-tool="room"]',
    title: 'Add Another Room',
    text: 'Draw a second room next to your first one. Leave a small gap or draw it right next to the first room — either works.',
    hint: 'Tip: Hold Shift to constrain to a square.',
    position: 'right',
    waitFor: 'second-room',
  },
  {
    target: '[data-tool="door"]',
    title: 'Connect with a Door',
    text: 'Switch to the <strong>Door</strong> tool, then click on the wall between your two rooms to place a door.',
    hint: 'Doors can only be placed on existing walls.',
    position: 'right',
    waitFor: 'door-placed',
  },
  {
    target: '[data-tool="prop"]',
    title: 'Add Furniture',
    text: 'Select the <strong>Prop</strong> tool. The sidebar on the right shows all available furniture — tables, chairs, braziers, and more. Click a prop, then click on the map to place it.',
    hint: 'R to rotate, F to flip while placing.',
    position: 'right',
    waitFor: 'prop-placed',
  },
  {
    target: '[data-menu="file"] .menu-trigger',
    title: 'Export Your Map!',
    text: 'When you\'re happy with your dungeon, go to <strong>File → Export to PNG</strong> to save a high-quality image ready for your VTT or print.',
    hint: 'You can also save your work as JSON with Ctrl+S.',
    position: 'below',
    waitFor: null, // last step, no auto-advance
  },
];

class Tutorial {
  step: number = 0;
  overlay: HTMLElement | null = null;
  _listener: ((state: EditorState) => void) | null = null;
  _prevUndoLen: number = 0;
  _roomCount: number = 0;
  _doorCount: number = 0;
  _propCount: number = 0;

  constructor() {}

  start() {
    this._snapshot();
    this._createOverlay();
    this._showStep(0);

    // Subscribe to state changes for auto-advance
    this._listener = () => this._checkCompletion();
    subscribe(this._listener, 'onboarding');
  }

  _snapshot() {
    this._prevUndoLen = state.undoStack.length;
    this._roomCount = this._countRooms();
    this._doorCount = this._countDoors();
    this._propCount = this._countProps();
  }

  _countRooms() {
    let count = 0;
    const cells = state.dungeon.cells;
    const visited = new Set();
    for (let r = 0; r < cells.length; r++) {
      for (let c = 0; c < (cells[0]?.length || 0); c++) {
        if (!cells[r][c] || visited.has(`${r},${c}`)) continue;
        count++;
        // BFS to mark connected cells
        const queue = [[r, c]];
        while (queue.length) {
          const [cr, cc] = queue.pop()!;
          const key = `${cr},${cc}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const cell = cells[cr]?.[cc];
          if (!cell) continue;
          const dirs: [number, number, string][] = [[-1, 0, 'north'], [1, 0, 'south'], [0, -1, 'west'], [0, 1, 'east']];
          for (const [dr, dc, dir] of dirs) {
            const nr = cr + dr, nc = cc + dc;
            if (nr < 0 || nr >= cells.length || nc < 0 || nc >= (cells[0]?.length || 0)) continue;
            if (!cells[nr][nc]) continue;
            // Connected if no wall between them
            if (!(cell as Record<string, unknown>)[dir] || (cell as Record<string, unknown>)[dir] === 'd' || (cell as Record<string, unknown>)[dir] === 's' || (cell as Record<string, unknown>)[dir] === 'id') {
              queue.push([nr, nc]);
            }
          }
        }
      }
    }
    return count;
  }

  _countDoors() {
    let count = 0;
    const cells = state.dungeon.cells;
    for (const row of cells) {
      for (const cell of row) {
        if (!cell) continue;
        for (const dir of ['north', 'south', 'east', 'west']) {
          if ((cell as Record<string, unknown>)[dir] === 'd' || (cell as Record<string, unknown>)[dir] === 's' || (cell as Record<string, unknown>)[dir] === 'id') count++;
        }
      }
    }
    return count / 2; // each door is counted twice (both sides)
  }

  _countProps() {
    return state.dungeon.metadata.props?.length ?? 0;
  }

  _checkCompletion() {
    const stepDef = TUTORIAL_STEPS[this.step];
    if (!stepDef.waitFor) return;

    let advance = false;
    switch (stepDef.waitFor) {
      case 'room-created':
        advance = this._countRooms() > this._roomCount;
        break;
      case 'second-room':
        advance = this._countRooms() > this._roomCount;
        break;
      case 'door-placed':
        advance = this._countDoors() > this._doorCount;
        break;
      case 'prop-placed':
        advance = this._countProps() > this._propCount;
        break;
    }

    if (advance) {
      this._snapshot();
      setTimeout(() => this.next(), 400);
    }
  }

  _createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'tutorial-overlay';
    this.overlay.innerHTML = `
      <div class="tutorial-backdrop"></div>
      <div class="tutorial-spotlight"></div>
      <div class="tutorial-panel">
        <div class="tutorial-step-counter"></div>
        <div class="tutorial-title"></div>
        <div class="tutorial-text"></div>
        <div class="tutorial-hint"></div>
        <div class="tutorial-actions">
          <button class="tutorial-btn tutorial-btn-skip">Skip Tour</button>
          <button class="tutorial-btn tutorial-btn-next">Next</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.overlay.querySelector('.tutorial-btn-skip')!.addEventListener('click', () => this.end());
    this.overlay.querySelector('.tutorial-btn-next')!.addEventListener('click', () => {
      if (this.step >= TUTORIAL_STEPS.length - 1) {
        this.end();
      } else {
        this.next();
      }
    });

    // Allow clicking through to the canvas (except the panel)
    this.overlay.querySelector('.tutorial-backdrop')!.addEventListener('click', (e: Event) => {
      e.stopPropagation();
    });

    requestAnimationFrame(() => this.overlay!.classList.add('visible'));
  }

  _showStep(index: number) {
    this.step = index;
    const stepDef = TUTORIAL_STEPS[index];
    const panel = this.overlay!.querySelector('.tutorial-panel') as HTMLElement;
    const spotlight = this.overlay!.querySelector('.tutorial-spotlight') as HTMLElement;

    // Update content
    panel.querySelector('.tutorial-step-counter')!.textContent = `Step ${index + 1} of ${TUTORIAL_STEPS.length}`;
    panel.querySelector('.tutorial-title')!.textContent = stepDef.title;
    panel.querySelector('.tutorial-text')!.innerHTML = stepDef.text;
    panel.querySelector('.tutorial-hint')!.textContent = stepDef.hint || '';

    const nextBtn = panel.querySelector('.tutorial-btn-next')!;
    nextBtn.textContent = index >= TUTORIAL_STEPS.length - 1 ? 'Finish' : 'Next';

    // Position spotlight on target element
    const target = document.querySelector(stepDef.target);
    if (target) {
      const rect = target.getBoundingClientRect();
      const padding = 6;
      spotlight.style.left = `${rect.left - padding}px`;
      spotlight.style.top = `${rect.top - padding}px`;
      spotlight.style.width = `${rect.width + padding * 2}px`;
      spotlight.style.height = `${rect.height + padding * 2}px`;
      spotlight.style.display = 'block';

      // Position panel relative to spotlight
      this._positionPanel(panel, rect, stepDef.position);
    } else {
      spotlight.style.display = 'none';
      // Center the panel
      panel.style.left = '50%';
      panel.style.top = '50%';
      panel.style.transform = 'translate(-50%, -50%)';
    }

    // Animate panel
    panel.classList.remove('tutorial-panel-enter');
    panel.offsetHeight;
    panel.classList.add('tutorial-panel-enter');
  }

  _positionPanel(panel: HTMLElement, targetRect: DOMRect, position: string) {
    const panelWidth = 320;
    const gap = 16;

    panel.style.transform = 'none';
    panel.style.width = `${panelWidth}px`;

    switch (position) {
      case 'right':
        panel.style.left = `${targetRect.right + gap}px`;
        panel.style.top = `${targetRect.top}px`;
        break;
      case 'below':
        panel.style.left = `${targetRect.left}px`;
        panel.style.top = `${targetRect.bottom + gap}px`;
        break;
      case 'left':
        panel.style.left = `${targetRect.left - panelWidth - gap}px`;
        panel.style.top = `${targetRect.top}px`;
        break;
      default:
        panel.style.left = `${targetRect.right + gap}px`;
        panel.style.top = `${targetRect.top}px`;
    }

    // Clamp to viewport
    requestAnimationFrame(() => {
      const pr = panel.getBoundingClientRect();
      if (pr.right > window.innerWidth - 16) {
        panel.style.left = `${window.innerWidth - panelWidth - 16}px`;
      }
      if (pr.bottom > window.innerHeight - 16) {
        panel.style.top = `${window.innerHeight - pr.height - 16}px`;
      }
      if (pr.left < 16) {
        panel.style.left = '16px';
      }
    });
  }

  next() {
    if (this.step < TUTORIAL_STEPS.length - 1) {
      this._showStep(this.step + 1);
    }
  }

  end() {
    // Remove state listener
    if (this._listener) {
      const idx = state.listeners.findIndex(e => e.fn === this._listener);
      if (idx !== -1) state.listeners.splice(idx, 1);
      this._listener = null;
    }
    if (this.overlay) {
      this.overlay.classList.remove('visible');
      this.overlay.addEventListener('transitionend', () => this.overlay?.remove(), { once: true });
      // Fallback removal in case transitionend doesn't fire
      setTimeout(() => { if (this.overlay?.parentNode) this.overlay.remove(); }, 500);
    }
    showToast('Press ? anytime for keyboard shortcuts');
  }
}

// ─── Example Map Loader ──────────────────────────────────────────────────────

function loadExampleMap(url: string, name: string) {
  fetch(url)
    .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
    .then(json => {
      loadDungeonJSON(json, { fileName: name });
      // Clear undo stack so the example feels like a fresh start
      state.undoStack.length = 0;
      state.redoStack.length = 0;
      state.unsavedChanges = false;
      notify();
      showToast(`Loaded "${name}" — explore and modify it freely!`);
    })
    .catch(err => showToast(`Failed to load example: ${err.message}`));
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Initialize onboarding: first-use tool hints and welcome modal on first launch.
 * @returns {void}
 */
export function initOnboarding(): void {
  // ── First-use tool hints ───────────────────────────────────────────────────
  let lastTool = state.activeTool;
  subscribe(() => {
    if (state.activeTool !== lastTool) {
      lastTool = state.activeTool;
      showToolHint(lastTool);
    }
  }, 'tool-hints');

  // ── First-launch welcome ───────────────────────────────────────────────────
  // Don't show welcome if a file was opened via URL param (file association)
  const openParam = new URLSearchParams(window.location.search).get('open');
  if (openParam) return;

  if (!localStorage.getItem(STORAGE_KEY)) {
    // Delay slightly so the editor is visually ready
    setTimeout(() => openWelcomeScreen(), 600);
  }
}

/**
 * Open the welcome screen (called on first launch and from Help menu).
 * @returns {void}
 */
export function openWelcomeScreen(): void {
  showWelcome(
    // Tutorial
    () => {
      const tutorial = new Tutorial();
      tutorial.start();
    },
    // Example map (receives url and name from the clicked card)
    (url: string, name: string) => loadExampleMap(url, name),
    // Fresh — do nothing
    () => {}
  );
}
