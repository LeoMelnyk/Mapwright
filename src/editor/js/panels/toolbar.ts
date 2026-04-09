import type { CellGrid, Dungeon } from '../../../types.js';
// Toolbar: tool buttons, door type, file ops, undo/redo
import state, { undo, redo, notify, subscribe, pushUndo, markDirty } from '../state.js';
import { loadDungeon, loadDungeonJSON, saveDungeon, saveDungeonAs, newDungeon, exportPng, exportDd2vtt, reloadAssets } from '../io.js';
import { setCursor } from '../canvas-view.js';
import { SYRINGE_CURSOR, STAMP_CURSOR } from '../tools/index.js';
import { convertOnePageDungeon } from '../import-opd.js';
import { convertDonjonDungeon } from '../import-donjon.js';
import { showToast } from '../toast.js';

let onToolChange: ((tool: string) => void) | null = null;

/**
 * Register a callback invoked when the active tool changes.
 * @param {Function} cb - Callback receiving the new tool name
 */
export function setToolChangeCallback(cb: (tool: string) => void): void {
  onToolChange = cb;
}

/**
 * Programmatically activate a tool (triggers the same callback as toolbar clicks).
 * @param {string} name - Tool name to activate
 */
export function activateTool(name: string): void {
  if (onToolChange) onToolChange(name);
}

/** Open a named sidebar panel (by panel ID) and activate its icon button. */
function openSidebarPanel(panelId: string) {
  const btn = document.querySelector<HTMLElement>(`.icon-btn[data-panel="${panelId}"]`);
  const panel = document.getElementById(`panel-${panelId}`);
  const sideContent = document.getElementById('side-content')!;
  if (!btn || !panel) return;

  document.querySelectorAll<HTMLElement>('.icon-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll<HTMLElement>('.side-panel').forEach(p => ((p).style.display = 'none'));

  btn.classList.add('active');
  panel.style.display = panel.dataset.display ?? 'flex';
  sideContent.classList.remove('hidden');
}

// ── Sub-mode registry ────────────────────────────────────────────────────
// Single source of truth for all tool sub-options. Each entry drives:
//   click handlers, Tab/Shift+Tab cycling, cursor, and side effects.

interface ToolOption {
  key: string;
  attr: string;
  values: string[];
  onApply?: (v: string) => void;
  cursor?: (v: string) => string;
}

const toolOptions: Record<string, ToolOption | undefined> = {
  room:   { key: 'roomMode',   attr: 'data-room-mode',   values: ['room', 'merge'],
            onApply: (v: string) => {
              state.statusInstruction = v === 'merge'
                ? 'Drag over adjacent rooms to merge them into one'
                : 'Drag to draw room · Shift for square · Right-click to void';
            } },
  paint:  { key: 'paintMode',  attr: 'data-paint-mode',
            values: ['texture', 'syringe', 'room', 'clear-texture'],
            cursor: (v: string) => v === 'syringe' ? SYRINGE_CURSOR : 'crosshair',
            onApply: (v: string) => {
              const bar = document.getElementById('paint-texture-options')!;
              bar.style.display = v === 'texture' || v === 'clear-texture' ? 'flex' : 'none';
              const r = document.getElementById('texture-opacity-row')!;
              r.style.display = v === 'texture' ? 'flex' : 'none';
              if (v === 'texture' || v === 'clear-texture' || v === 'syringe') openSidebarPanel('textures');
              const statuses = {
                texture:         'Drag to paint texture · Shift+click to flood fill · Alt+click to sample · Right-click to clear',
                syringe:         'Click to sample texture from a cell · Switches to Texture mode',
                room:            'Drag to paint room floor color',
                'clear-texture': 'Drag to clear texture · Shift+click to flood clear',
              };
              state.statusInstruction = statuses[v as keyof typeof statuses] || null;
            } },
  fill:   { key: 'fillMode',   attr: 'data-fill-mode',
            values: ['water', 'lava', 'pit', 'difficult-terrain', 'clear-fill'],
            onApply: (v: string) => {
              const bar = document.getElementById('fill-depth-options')!;
              bar.style.display = (v === 'water' || v === 'lava') ? 'flex' : 'none';
              // Sync depth button highlights to the active fluid's current depth
              if (v === 'water' || v === 'lava') {
                const activeDepth = (v === 'lava' ? state.lavaDepth : state.waterDepth) || 1;
                document.querySelectorAll<HTMLElement>('[data-water-depth]').forEach(b => {
                  b.classList.toggle('active', parseInt((b).dataset.waterDepth ?? '0', 10) === activeDepth);
                });
              }
              const statuses = {
                water:               'Drag to fill with water · Right-click cell to clear',
                lava:                'Drag to fill with lava · Right-click cell to clear',
                pit:                 'Drag to fill with pit · Right-click cell to clear',
                'difficult-terrain': 'Drag to paint difficult terrain · Right-click cell to clear',
                'clear-fill':        'Drag to clear fills from cells',
              };
              state.statusInstruction = statuses[v as keyof typeof statuses] || null;
            } },
  wall:   { key: 'wallType',   attr: 'data-wall-type',   values: ['w', 'iw'],
            onApply: (v: string) => {
              state.statusInstruction = v === 'iw'
                ? 'Click or drag edge to place invisible wall · Blocks movement but hidden from players · Right-click to remove'
                : 'Click or drag edge to place wall · Right-click to remove';
            } },
  door:   { key: 'doorType',   attr: 'data-door-type',   values: ['d', 's', 'id'],
            onApply: (v: string) => {
              const statuses = {
                d:  'Click a wall to place door · Click again to toggle off · Right-click to remove',
                s:  'Click a wall to place secret door · Appears as wall to players until discovered',
                id: 'Click a wall to place invisible door · Hidden from players; DM can open',
              };
              state.statusInstruction = statuses[v as keyof typeof statuses] || null;
            } },
  stairs: { key: 'stairsMode', attr: 'data-stairs-mode', values: ['place', 'link'],
            cursor: (v: string) => v === 'link' ? 'pointer' : 'crosshair',
            onApply: (v: string) => {
              state.statusInstruction = v === 'place'
                ? 'Click to place corner 1 of 3'
                : 'Click a stair to select it · Click another to link · Click a linked stair to unlink · Right-click to delete';
            } },
  bridge: { key: 'bridgeType', attr: 'data-bridge-type', values: ['wood', 'stone', 'rope', 'dock'],
            onApply: () => {
              state.statusInstruction = 'Click 3 points to place bridge · Hover to select/move · Del to delete';
            } },
  select: { key: 'selectMode', attr: 'data-select-mode', values: ['select', 'inspect'],
            cursor: () => 'default',
            onApply: (v: string) => {
              state.statusInstruction = v === 'inspect'
                ? 'Click a cell to inspect its properties'
                : 'Drag to select cells · Shift+drag to add · Arrow keys to move · Ctrl+C to copy · Del to delete';
            } },
  label:  { key: 'labelMode',  attr: 'data-label-mode',  values: ['room', 'dm'],
            cursor: (v: string) => v === 'dm' ? 'text' : STAMP_CURSOR,
            onApply: (v: string) => {
              const bar = document.getElementById('label-dungeon-options')!;
              bar.style.display = (v === 'room' || !v) ? 'flex' : 'none';
              const part = document.getElementById('label-dungeon-part')!;
              part.style.display = 'flex';
              state.statusInstruction = v === 'dm'
                ? 'Click to place DM annotation · Hover to select/move · Del to delete'
                : 'Click to place room label · Hover to select/move · Del to delete';
            } },
};

/**
 * Fire onApply side effects for a tool's current sub-mode (e.g., open textures panel).
 * @param {string} toolName - Tool identifier
 */
export function applyToolSideEffects(toolName: string): void {
  const opts = toolOptions[toolName];
  if (opts?.onApply) opts.onApply((state[opts.key] as string) || opts.values[0]);
}

/** Convert a data attribute name to its dataset key, e.g. 'data-paint-mode' → 'paintMode'. */
function attrToDatasetKey(attr: string) {
  return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
}

/**
 * Set a sub-mode for a tool. Updates state, button highlights, cursor, and side effects.
 * @param {string} toolName - Tool identifier (e.g. 'paint', 'fill')
 * @param {string} value - Sub-mode value
 */
export function setSubMode(toolName: string, value?: string): void {
  const opts = toolOptions[toolName];
  if (!opts) return;
  state[opts.key] = value;
  document.querySelectorAll<HTMLElement>(`[${opts.attr}]`).forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute(opts.attr) === value);
  });
  if (state.activeTool === toolName && opts.cursor) setCursor(opts.cursor(value!));
  if (opts.onApply) opts.onApply(value!);
  updateToolButtons();
}

/**
 * Cycle the active tool's sub-mode forward or backward.
 * @param {number} delta - +1 (Tab) or -1 (Shift+Tab)
 * @returns {boolean} True if a sub-mode was cycled
 */
export function cycleSubMode(delta?: number): boolean {
  const opts = toolOptions[state.activeTool];
  if (!opts) return false;
  const idx = opts.values.indexOf(state[opts.key] as string);
  const next = opts.values[(idx + (delta ?? 1) + opts.values.length) % opts.values.length];
  setSubMode(state.activeTool, next);
  return true;
}

/**
 * Get mode-aware cursor for a tool, or null if no cursor config in registry.
 * @param {string} toolName - Tool identifier
 * @returns {string|null} CSS cursor string
 */
export function getToolCursor(toolName: string): string | null {
  const opts = toolOptions[toolName];
  if (!opts) return null;
  return opts.cursor ? opts.cursor(state[opts.key] as string) : null;
}

/**
 * Initialize the toolbar: bind menu dropdowns, tool buttons, sub-mode toggles, and keyboard shortcuts.
 */
export function init(): void {
  // ── Menu bar dropdowns ─────────────────────────────────────────────────
  const menuItems = document.querySelectorAll<HTMLElement>('.menu-item');
  const menubar = document.getElementById('menubar')!;

  /** Update aria-expanded on all triggers to match the open state. */
  function syncAriaExpanded() {
    menuItems.forEach(mi => {
      const isOpen = mi.classList.contains('open');
      const trigger = mi.querySelector('.menu-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', String(isOpen));
    });
    // Submenu triggers
    document.querySelectorAll<HTMLElement>('.menu-submenu-trigger').forEach(t => {
      const submenu = t.closest('.menu-submenu');
      const isOpen = submenu?.classList.contains('open') ?? submenu?.querySelector('.menu-submenu-dropdown:hover') !== null;
      t.setAttribute('aria-expanded', String(isOpen));
    });
  }

  /** Open a specific top-level menu item and focus its first action. */
  function openMenu(item: Element) {
    menuItems.forEach(mi => mi.classList.remove('open'));
    item.classList.add('open');
    syncAriaExpanded();
    // Focus first menu-action in the dropdown
    const firstAction = item.querySelector('.menu-dropdown > .menu-action, .menu-dropdown > label, .menu-dropdown > .menu-submenu > .menu-submenu-trigger') as HTMLElement;
    firstAction.focus();
  }

  /** Close all menus. */
  function closeAllMenus() {
    menuItems.forEach(mi => mi.classList.remove('open'));
    syncAriaExpanded();
  }

  /** Get all focusable items in the currently open dropdown (buttons, labels, submenu triggers). */
  function getFocusableItems(dropdown: Element): HTMLElement[] {
    return Array.from(dropdown.querySelectorAll(':scope > .menu-action, :scope > label, :scope > .menu-field, :scope > .menu-submenu > .menu-submenu-trigger'));
  }

  menuItems.forEach(item => {
    const trigger = item.querySelector('.menu-trigger') as HTMLElement;
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = item.classList.contains('open');
      closeAllMenus();
      if (!isOpen) openMenu(item);
    });
  });

  // Close menus on outside click
  document.addEventListener('click', () => {
    closeAllMenus();
  });

  // Clicks inside dropdowns don't propagate to document (keeps menu open),
  // except menu-action buttons which explicitly close after acting.
  document.querySelectorAll<HTMLElement>('.menu-dropdown').forEach(dd => {
    dd.addEventListener('click', (e) => e.stopPropagation());
  });

  // Set role="menuitem" and tabindex on all menu-action buttons
  document.querySelectorAll<HTMLElement>('.menu-action').forEach(action => {
    action.setAttribute('role', 'menuitem');
    action.setAttribute('tabindex', '-1');
  });

  // Close menu after a menu-action is invoked (but not submenu triggers)
  document.querySelectorAll<HTMLElement>('.menu-action').forEach(action => {
    if (action.classList.contains('menu-submenu-trigger')) return;
    action.addEventListener('click', () => {
      closeAllMenus();
    });
  });

  // ── Keyboard navigation for menus ─────────────────────────────────────
  menubar.addEventListener('keydown', (e: KeyboardEvent) => {
    const openItem = menubar.querySelector('.menu-item.open');
    if (!openItem) return; // No menu open — let default behavior handle it

    const menuItemsArr = Array.from(menuItems);
    const openIdx = menuItemsArr.indexOf(openItem as HTMLElement);
    const dropdown = openItem.querySelector('.menu-dropdown');
    if (!dropdown) return;

    // Check if we're inside a submenu
    const activeEl = document.activeElement as HTMLElement;
    const activeSubmenu = activeEl.closest('.menu-submenu-dropdown');

    // Determine which list of items to navigate
    const itemsContainer = activeSubmenu ?? dropdown;
    const items = getFocusableItems(itemsContainer);
    const currentIdx = items.indexOf(activeEl);

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const nextIdx = currentIdx < items.length - 1 ? currentIdx + 1 : 0;
        items[nextIdx]?.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : items.length - 1;
        items[prevIdx]?.focus();
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        // If on a submenu trigger, open the submenu and focus first item
        if (activeEl.classList.contains('menu-submenu-trigger')) {
          const submenuDropdown = activeEl.closest('.menu-submenu')?.querySelector('.menu-submenu-dropdown');
          if (submenuDropdown) {
            // CSS :focus-within or hover shows submenu — we just need to focus into it
            const subItems = getFocusableItems(submenuDropdown);
            if (subItems.length) { subItems[0].focus(); break; }
          }
        }
        // Otherwise, move to next top-level menu
        const nextMenuIdx = (openIdx + 1) % menuItemsArr.length;
        openMenu(menuItemsArr[nextMenuIdx]);
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        // If inside a submenu, go back to the submenu trigger
        if (activeSubmenu) {
          const submenuTrigger = activeSubmenu.closest('.menu-submenu')?.querySelector('.menu-submenu-trigger') as HTMLElement;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (submenuTrigger) { submenuTrigger.focus(); break; }
        }
        // Otherwise, move to previous top-level menu
        const prevMenuIdx = (openIdx - 1 + menuItemsArr.length) % menuItemsArr.length;
        openMenu(menuItemsArr[prevMenuIdx]);
        break;
      }
      case 'Home': {
        e.preventDefault();
        if (items.length) items[0].focus();
        break;
      }
      case 'End': {
        e.preventDefault();
        if (items.length) items[items.length - 1].focus();
        break;
      }
      case 'Enter':
      case ' ': {
        // If focused on a submenu trigger, open it
        if (activeEl.classList.contains('menu-submenu-trigger')) {
          e.preventDefault();
          const submenuDropdown = activeEl.closest('.menu-submenu')?.querySelector('.menu-submenu-dropdown');
          if (submenuDropdown) {
            const subItems = getFocusableItems(submenuDropdown);
            if (subItems.length) subItems[0].focus();
          }
          break;
        }
        // For other items, let the native click fire (don't prevent default for Enter on buttons)
        if (e.key === ' ') {
          e.preventDefault();
          activeEl.click();
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        // If inside a submenu, go back to the trigger
        if (activeSubmenu) {
          const submenuTrigger = activeSubmenu.closest('.menu-submenu')?.querySelector('.menu-submenu-trigger') as HTMLElement;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (submenuTrigger) { submenuTrigger.focus(); break; }
        }
        // Otherwise close the menu entirely
        const trigger = openItem.querySelector('.menu-trigger') as HTMLElement;
        closeAllMenus();
        trigger.focus();
        break;
      }
    }
  });

  // ── File operations ────────────────────────────────────────────────────
  document.getElementById('btn-new')?.addEventListener('click', () => { void newDungeon(); });
  document.getElementById('btn-load')?.addEventListener('click', () => { void loadDungeon(); });
  document.getElementById('btn-save')?.addEventListener('click', () => { void saveDungeon(); });
  document.getElementById('btn-save-as')?.addEventListener('click', () => { void saveDungeonAs(); });
  document.getElementById('btn-export-png')?.addEventListener('click', () => { void exportPng(); });
  document.getElementById('btn-export-dd2vtt')?.addEventListener('click', () => { void exportDd2vtt(); });
  document.getElementById('btn-reload-assets')?.addEventListener('click', () => { void reloadAssets(); });

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
  document.getElementById('btn-undo')?.addEventListener('click', undo);
  document.getElementById('btn-redo')?.addEventListener('click', redo);

  // ── Tool buttons ───────────────────────────────────────────────────────
  const toolButtons = document.querySelectorAll<HTMLElement>('[data-tool]');
  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const toolName = (btn).dataset.tool!;
      if (onToolChange) onToolChange(toolName);
      updateToolButtons();
      applyToolSideEffects(toolName);
      notify();
    });
  });

  // ── Sub-mode buttons (all tools, driven by toolOptions registry) ──────
  for (const [toolName, opts] of Object.entries(toolOptions)) {
    if (!opts) continue;
    const dsKey = attrToDatasetKey(opts.attr);
    document.querySelectorAll<HTMLElement>(`[${opts.attr}]`).forEach(btn => {
      btn.addEventListener('click', () => setSubMode(toolName, (btn).dataset[dsKey]));
    });
  }

  // ── Tab ↹ cycle badge — click to cycle the active tool's sub-mode ──────
  document.querySelectorAll<HTMLElement>('.suboptions-bar .cycle-hint').forEach(badge => {
    badge.addEventListener('click', () => cycleSubMode(1));
  });

  // Fluid depth buttons (shared by water and lava)
  document.querySelectorAll<HTMLElement>('[data-water-depth]').forEach(btn => {
    btn.addEventListener('click', () => {
      const depth = parseInt((btn).dataset.waterDepth ?? '1', 10);
      const mode = state.fillMode || 'water';
      if (mode === 'lava') {
        state.lavaDepth = depth;
      } else {
        state.waterDepth = depth;
      }
      document.querySelectorAll<HTMLElement>('[data-water-depth]').forEach(b => {
        b.classList.toggle('active', (b).dataset.waterDepth === (btn).dataset.waterDepth);
      });
    });
  });

  // Dungeon letter dropdown — populate A–Z and wire change
  const letterSelect = document.getElementById('dungeon-letter-select')!;
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i);
    const opt = document.createElement('option');
    opt.value = ch;
    opt.textContent = ch;
    letterSelect.appendChild(opt);
  }
  (letterSelect as HTMLInputElement).value = state.dungeon.metadata.dungeonLetter ?? 'A';
  letterSelect.addEventListener('change', () => {
    const newLetter = (letterSelect as HTMLInputElement).value;
    const oldLetter = state.dungeon.metadata.dungeonLetter ?? 'A';
    if (newLetter === oldLetter) return;

    pushUndo();
    // Rename all existing room labels to use the new letter
    const pattern = /^[A-Z](\d+)$/;
    for (const row of state.dungeon.cells) {
      for (const cell of row) {
        if (cell?.center?.label) {
          const m = pattern.exec(cell.center.label);
          if (m) cell.center.label = newLetter + m[1];
        }
      }
    }
    state.dungeon.metadata.dungeonLetter = newLetter;
    markDirty();
  });

  // Texture opacity slider
  const opacitySlider = document.getElementById('texture-opacity-slider')!;
  const opacityValue = document.getElementById('texture-opacity-value')!;
  opacitySlider.addEventListener('input', () => {
    state.textureOpacity = parseInt((opacitySlider as HTMLInputElement).value, 10) / 100;
    opacityValue.textContent = `${(opacitySlider as HTMLInputElement).value}%`;
  });

  // Secondary texture Yes/No buttons
  document.querySelectorAll<HTMLElement>('#paint-texture-options [data-secondary]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = (btn).dataset.secondary === 'true';
      state.paintSecondary = val;
      document.querySelectorAll<HTMLElement>('#paint-texture-options [data-secondary]').forEach(b => {
        b.classList.toggle('active', (b).dataset.secondary === String(val));
      });
    });
  });

  // Trim Yes/No toggle buttons (Round, Inverted, Open)
  document.querySelectorAll<HTMLElement>('#trim-shape-options [data-trim]').forEach(btn => {
    btn.addEventListener('click', () => {
      const prop = (btn).dataset.trim;            // 'round' | 'inverted' | 'open'
      const val = (btn).dataset.val === 'true';   // boolean
      const stateKey = 'trim' + prop!.charAt(0).toUpperCase() + prop!.slice(1);
      state[stateKey] = val;
      // Sync active class within this Yes/No pair
      document.querySelectorAll<HTMLElement>(`#trim-shape-options [data-trim="${prop}"]`).forEach(b => {
        b.classList.toggle('active', (b).dataset.val === String(val));
      });
    });
  });

  updateToolButtons();
  // Initialize all sub-mode button highlights from current state (no side effects)
  for (const [, opts] of Object.entries(toolOptions)) {
    if (!opts) continue;
    document.querySelectorAll<HTMLElement>(`[${opts.attr}]`).forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute(opts.attr) === (state[opts.key] ?? opts.values[0]));
    });
  }
  // Apply side effects for the restored active tool (e.g. show depth selector for water/lava)
  applyToolSideEffects(state.activeTool);

  // Keep dungeon letter dropdown in sync after load/new/undo.
  // Auto-detect the letter from existing labels when a new dungeon is loaded.
  let lastDungeon: Dungeon | null = null;
  let _lastTool: string | null = null;
  let _lastLighting: boolean | null = null;
  let _lastSessionTools: boolean | null = null;
  subscribe(() => {
    const meta = state.dungeon.metadata;
    if (state.dungeon !== lastDungeon) {
      lastDungeon = state.dungeon;
      meta.dungeonLetter ??= detectDungeonLetter(state.dungeon.cells);
      const sel = document.getElementById('dungeon-letter-select')!;
      (sel as HTMLInputElement).value = meta.dungeonLetter || 'A';
      // Force toolbar update on dungeon swap
      _lastTool = null;
    }
    // Only update toolbar buttons when relevant state changed
    const lighting = meta.lightingEnabled;
    if (state.activeTool !== _lastTool || lighting !== _lastLighting || state.sessionToolsActive !== _lastSessionTools) {
      _lastTool = state.activeTool;
      _lastLighting = lighting;
      _lastSessionTools = state.sessionToolsActive;
      updateToolButtons();
    }
  }, 'toolbar');
}

/**
 * Refresh toolbar button state (active highlights, visibility based on features).
 */
export function updateToolButtons(): void {
  const lightingEnabled = state.dungeon.metadata.lightingEnabled;

  document.querySelectorAll<HTMLElement>('[data-tool]').forEach(btn => {
    btn.classList.toggle('active', (btn).dataset.tool === state.activeTool);
    // Hide the light tool when lighting is disabled
    if ((btn).dataset.tool === 'light') {
      (btn).style.display = lightingEnabled ? '' : 'none';
    }
  });

  // If lighting was disabled while the light tool was active, switch away
  if (!lightingEnabled && state.activeTool === 'light') {
    state.activeTool = 'room';
    document.querySelectorAll<HTMLElement>('[data-tool]').forEach(btn => {
      btn.classList.toggle('active', (btn).dataset.tool === state.activeTool);
    });
    if (onToolChange) onToolChange('room');
  }

  // Show/hide sub-option bars — all follow the convention "${toolName}-options"
  // Hide all when session tools are active (session toolbar replaces the editor toolbar)
  for (const toolName of Object.keys(toolOptions)) {
    const bar = document.getElementById(`${toolName}-options`);
    if (bar) bar.style.display = (!state.sessionToolsActive && state.activeTool === toolName) ? 'flex' : 'none';
  }

  // Trim has no sub-mode bar (only tertiary shape bar)
  const trimShapeBar = document.getElementById('trim-shape-options')!;
  trimShapeBar.style.display = (!state.sessionToolsActive && state.activeTool === 'trim') ? 'flex' : 'none';

  // Mode-dependent tertiary bars: hidden when session active or wrong tool active.
  // When the tool IS active, onApply (called from applyToolSideEffects) controls visibility.
  if (state.sessionToolsActive || state.activeTool !== 'paint') {
    const b = document.getElementById('paint-texture-options')!;
    b.style.display = 'none';
  }
  if (state.sessionToolsActive || state.activeTool !== 'fill') {
    const b = document.getElementById('fill-depth-options')!;
    b.style.display = 'none';
  }
  if (state.sessionToolsActive || state.activeTool !== 'label') {
    const b = document.getElementById('label-dungeon-options')!;
    b.style.display = 'none';
  }
  if (state.sessionToolsActive || state.activeTool !== 'light') {
    const b = document.getElementById('light-options')!;
    b.style.display = 'none';
  }

  // Hide the sub-bar panel border/space when no bars are visible (e.g. light, erase, prop)
  const toolbarSubbars = document.getElementById('toolbar-subbars')!;
  const anyVisible = [...toolbarSubbars.querySelectorAll(
    '.suboptions-bar, .tertiaryoptions-bar, .session-suboptions'
  )].some(el => (el as HTMLElement).style.display && (el as HTMLElement).style.display !== 'none');
  toolbarSubbars.classList.toggle('toolbar-subbars-empty', !anyVisible);
}

/** Scan cells for room labels and return the most common letter prefix, or 'A'. */
function detectDungeonLetter(cells: CellGrid) {
  const counts = {};
  const pattern = /^([A-Z])\d+$/;
  for (const row of cells) {
    for (const cell of row) {
      if (cell?.center?.label) {
        const m = pattern.exec(cell.center.label);
        if (m) (counts as Record<string, number>)[m[1]] = ((counts as Record<string, number>)[m[1]] || 0) + 1;
      }
    }
  }
  let best = 'A', bestCount = 0;
  for (const [letter, count] of Object.entries(counts)) {
    if ((count as number) > bestCount) { best = letter; bestCount = count as number; }
  }
  return best;
}

// ── Import modal ──────────────────────────────────────────────────────

function showImportModal(siteName: string, siteUrl: string) {
  // Remove any existing modal
  (document.getElementById('import-modal-overlay')! as HTMLDialogElement).close();
  document.getElementById('import-modal-overlay')?.remove();

  const overlay = document.createElement('dialog');
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
    const file = e.dataTransfer!.files[0];
    handleImportFile(file, siteName);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files![0];
    handleImportFile(file, siteName);
  });

  // Cancel button
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'import-modal-cancel';
  cancelBtn.textContent = 'Cancel';
  function closeImportModal() { overlay.close(); overlay.remove(); }

  cancelBtn.addEventListener('click', closeImportModal);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeImportModal();
  });

  // Close on Escape (dialog handles Escape natively, but clean up the DOM)
  overlay.addEventListener('close', () => overlay.remove());

  modal.appendChild(steps);
  modal.appendChild(dropZone);
  modal.appendChild(fileInput);
  modal.appendChild(cancelBtn);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.showModal();
}

function handleImportFile(file: File, siteName: string) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result as string);

      let dungeon;
      if (siteName === 'One-Page-Dungeon') {
        dungeon = convertOnePageDungeon(json);
      } else if (siteName === 'Donjon') {
        dungeon = convertDonjonDungeon(json);
      } else {
        showToast('Unsupported import format');
        return;
      }

      loadDungeonJSON(dungeon as unknown as Dungeon, { fileName: file.name });
      const importDialog = document.getElementById('import-modal-overlay')! as HTMLDialogElement;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (importDialog) { importDialog.close(); importDialog.remove(); }
      showToast(`Imported from ${siteName}`);
    } catch (err) {
      console.error('Import failed:', err);
      showToast('Import failed: ' + (err as Error).message);
    }
  };
  reader.readAsText(file);
}
