// App initialization
import state, { undo, redo, subscribe, pushUndo, markDirty, loadAutosave } from './state.js';
import { showToast } from './toast.js';
import * as canvasView from './canvas-view.js';
import * as toolbar from './panels/toolbar.js';
import * as sidebar from './panels/sidebar.js';
import * as properties from './panels/properties.js';
import * as metadata from './panels/metadata.js';
import * as levels from './panels/levels.js';
import { saveDungeon } from './io.js';

import { loadThemeCatalog } from './theme-catalog.js';
import { loadTextureCatalog, collectTextureIds, ensureTexturesLoaded } from './texture-catalog.js';
import { initTexturesPanel } from './panels/textures.js';

import { RoomTool, PaintTool, WallTool, DoorTool, LabelTool, StairsTool, BridgeTool, SelectTool, TrimTool, PropTool, EraseTool, LightTool, FillTool, RangeTool } from './tools/index.js';
import { loadPropCatalog } from './prop-catalog.js';
import { loadLightCatalog } from './light-catalog.js';
import { notify } from './state.js';
import { initLightingPanel } from './panels/lighting.js';
import { initSessionPanel } from './panels/session.js';
import * as rightSidebar from './panels/right-sidebar.js';
import { initHistoryPanel } from './panels/history.js';
import { sessionState, renderSessionOverlay, hitTestDoorButton, hitTestStairButton, openDoor, openStairs, setRangeHighlightCallback } from './dm-session.js';
import { setSessionOverlay, setSessionTool, setSessionRangeTool } from './canvas-view.js';
import { getActivePanel, setPanelChangeCallback, togglePanel } from './panels/sidebar.js';

// Tool registry
const tools = {
  room: new RoomTool(),
  paint: new PaintTool(),
  fill: new FillTool(),
  wall: new WallTool(),
  door: new DoorTool(),
  label: new LabelTool(),
  stairs: new StairsTool(),
  bridge: new BridgeTool(),
  select: new SelectTool(),
  trim: new TrimTool(),
  prop: new PropTool(),
  erase: new EraseTool(),
  light: new LightTool(),
};

function setTool(name) {
  // Deactivate previous tool (read state.activeTool before updating it)
  const prevTool = tools[state.activeTool];
  if (prevTool?.onDeactivate) prevTool.onDeactivate();

  state.activeTool = name;

  const tool = tools[name];
  if (!tool) return;

  // Activate new tool
  if (tool.onActivate) tool.onActivate();
  canvasView.setActiveTool(tool);
  // Use toolbar's mode-aware cursor, falling back to tool default
  const cursor = toolbar.getToolCursor(name);
  canvasView.setCursor(cursor ?? tool.getCursor());
}

// ── Session tools mode ─────────────────────────────────────────────────────

let savedTool = null;

function updateSessionToolsMode() {
  const shouldBeActive = getActivePanel() === 'session' && sessionState.active;
  if (shouldBeActive === state.sessionToolsActive) return;
  state.sessionToolsActive = shouldBeActive;

  if (shouldBeActive) {
    enterSessionToolsMode();
  } else {
    exitSessionToolsMode();
  }
  canvasView.requestRender();
}

function enterSessionToolsMode() {
  savedTool = state.activeTool;

  // Deactivate current editor tool
  const prevTool = tools[state.activeTool];
  if (prevTool?.onDeactivate) prevTool.onDeactivate();
  canvasView.setActiveTool(null);
  canvasView.setCursor('default');

  // Hide normal toolbar, show session toolbar
  document.getElementById('editor-tool-row').style.display = 'none';
  document.querySelectorAll('.suboptions-bar').forEach(el => el.style.display = 'none');
  document.getElementById('session-tool-row').style.display = 'flex';
}

function exitSessionToolsMode() {
  // Hide session toolbar + range sub-options, show normal toolbar
  document.getElementById('session-tool-row').style.display = 'none';
  const rangeOpts = document.getElementById('range-options');
  if (rangeOpts) rangeOpts.style.display = 'none';
  document.getElementById('editor-tool-row').style.display = 'flex';

  // Restore previous editor tool
  const toolToRestore = savedTool && tools[savedTool] ? savedTool : 'room';
  setTool(toolToRestore);
  toolbar.updateToolButtons();
  savedTool = null;
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  // ── Editor UI theme (light/dark) ───────────────────────────────────────
  const savedTheme = localStorage.getItem('editor-ui-theme');
  if (savedTheme === 'light') document.documentElement.setAttribute('data-theme', 'light');

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('editor-ui-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('editor-ui-theme', 'light');
    }
  });

  // Restore autosaved state (before canvas init so zoom/pan are set)
  const restored = loadAutosave();
  // (no migration needed for autosaved state — always current format)

  // Init canvas
  const canvas = document.getElementById('editor-canvas');
  canvasView.init(canvas);

  // Set initial tool (use restored tool or default)
  if (!restored) state.activeTool = 'room';
  // Migration: if restored tool was removed, default to room
  if (!tools[state.activeTool]) state.activeTool = 'room';
  setTool(state.activeTool);

  // ── Asset loading bar ──────────────────────────────────────────────────
  const loadingBar = document.getElementById('loading-bar');
  const loadingFill = document.getElementById('loading-bar-fill');
  if (loadingBar) loadingBar.classList.add('active');

  const progress = { themes: null, props: null, textures: null };
  const toasted = { themes: false, props: false, textures: false };
  const labels = { themes: 'Themes', props: 'Props', textures: 'Textures' };
  function onAssetProgress(key, loaded, total) {
    progress[key] = { loaded, total };
    // Per-catalog toast
    if (loaded >= total && total > 0 && !toasted[key]) {
      toasted[key] = true;
      showToast(`${labels[key]} loaded`);
    }
    // Aggregate bar
    let sumLoaded = 0, sumTotal = 0;
    for (const v of Object.values(progress)) {
      if (v) { sumLoaded += v.loaded; sumTotal += v.total; }
    }
    if (loadingFill && sumTotal > 0) {
      loadingFill.style.width = `${Math.round((sumLoaded / sumTotal) * 100)}%`;
    }
    const allReported = Object.values(progress).every(v => v !== null);
    if (allReported && sumLoaded >= sumTotal && sumTotal > 0) {
      setTimeout(() => loadingBar?.classList.remove('active'), 400);
    }
  }

  // Load themes before metadata so the picker has catalog data on first render
  await loadThemeCatalog((loaded, total) => onAssetProgress('themes', loaded, total));

  // Init panels
  toolbar.init();
  toolbar.setToolChangeCallback(setTool);
  sidebar.init();
  rightSidebar.init();
  properties.init();
  metadata.init();
  levels.init();

  // Init history panel
  const historyContainer = document.getElementById('history-panel-content');
  if (historyContainer) initHistoryPanel(historyContainer);

  // Init lighting panel
  const lightingContainer = document.getElementById('lighting-panel-content');
  if (lightingContainer) initLightingPanel(lightingContainer);

  // Init session panel
  const sessionContainer = document.getElementById('session-panel-content');
  if (sessionContainer) initSessionPanel(sessionContainer);

  // Wire session overlay (door/stair-open buttons on DM canvas)
  setSessionOverlay(
    renderSessionOverlay,
    (px, py, transform, gridSize) => {
      const stair = hitTestStairButton(px, py, transform, gridSize);
      if (stair) {
        openStairs(stair.stairId, stair.partnerId);
        return true;
      }
      const door = hitTestDoorButton(px, py, transform, gridSize);
      if (door) {
        openDoor(door.row, door.col, door.dir);
        return true;
      }
      return false;
    },
  );

  // ── Range detector (session tool) ────────────────────────────────────────
  const dmRangeTool = new RangeTool(
    (msg) => {
      if (sessionState.ws?.readyState === 1) {
        sessionState.ws.send(JSON.stringify(msg));
      }
    },
    () => ({
      gridSize: state.dungeon.metadata.gridSize,
      numRows: state.dungeon.cells.length,
      numCols: state.dungeon.cells[0]?.length || 0,
    }),
    () => canvasView.requestRender(),
  );

  // Always render range highlights (including player-sent ones) in any session sub-mode
  setSessionRangeTool(dmRangeTool);

  // Wire incoming range highlights from players
  setRangeHighlightCallback((msg) => {
    dmRangeTool.applyRemoteHighlight(msg);
    canvasView.requestRender();
  });

  // Session tool button switching (Doors vs Range)
  document.querySelectorAll('[data-session-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-session-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tool = btn.dataset.sessionTool;
      const rangeOpts = document.getElementById('range-options');
      if (tool === 'range') {
        setSessionTool(dmRangeTool);
        canvasView.setCursor('crosshair');
        if (rangeOpts) rangeOpts.style.display = 'flex';
      } else {
        setSessionTool(null);
        canvasView.setCursor('default');
        if (rangeOpts) rangeOpts.style.display = 'none';
      }
      canvasView.requestRender();
    });
  });

  // Range shape sub-tool switching
  document.querySelectorAll('[data-range-shape]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-range-shape]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      dmRangeTool.setSubTool(btn.dataset.rangeShape);
    });
  });

  // Range distance dropdown — populate with gridSize increments up to 200ft
  const rangeDistSelect = document.getElementById('range-distance');
  if (rangeDistSelect) {
    function populateRangeOptions() {
      const gs = state.dungeon?.metadata?.gridSize || 5;
      // Keep "Auto" option, rebuild the rest
      rangeDistSelect.innerHTML = '<option value="0">Auto</option>';
      for (let ft = gs; ft <= 200; ft += gs) {
        const opt = document.createElement('option');
        opt.value = ft;
        opt.textContent = `${ft} ft`;
        rangeDistSelect.appendChild(opt);
      }
    }
    populateRangeOptions();
    rangeDistSelect.addEventListener('change', () => {
      dmRangeTool.setFixedRange(parseInt(rangeDistSelect.value, 10));
    });
  }

  // Wire session tools mode + auto-tool-switch on panel change
  setPanelChangeCallback((panelId) => {
    updateSessionToolsMode();
    // Auto-activate light tool when lighting panel is opened
    if (panelId === 'lighting' && state.activeTool !== 'light') {
      setTool('light');
      toolbar.updateToolButtons();
    }
  });
  subscribe(() => updateSessionToolsMode());

  // Load light preset catalog (metadata only, fast)
  loadLightCatalog().then(catalog => {
    state.lightCatalog = catalog;
    notify();
  }).catch(err => console.warn('Failed to load light catalog:', err));

  // Load prop catalog (async, doesn't block editor)
  const propCatalogPromise = loadPropCatalog((loaded, total) => onAssetProgress('props', loaded, total)).then(catalog => {
    state.propCatalog = catalog;
    notify();
    return catalog;
  }).catch(err => { console.warn('Failed to load prop catalog:', err); return null; });

  // Load texture catalog (metadata only — images load on demand)
  const textureCatalogPromise = loadTextureCatalog().then(catalog => {
    state.textureCatalog = catalog;
    const texContainer = document.getElementById('textures-panel-content');
    if (texContainer) initTexturesPanel(texContainer);
    notify();
    return catalog;
  }).catch(err => { console.warn('Failed to load texture catalog:', err); return null; });

  // After both catalogs are ready, pre-load textures for the current map (floor + props)
  Promise.all([propCatalogPromise, textureCatalogPromise]).then(([propCatalog, textureCatalog]) => {
    if (!textureCatalog) { onAssetProgress('textures', 1, 1); return; }

    const usedIds = collectTextureIds(state.dungeon.cells);
    if (propCatalog?.props) {
      for (const row of state.dungeon.cells) {
        if (!row) continue;
        for (const cell of row) {
          if (!cell?.prop) continue;
          const propDef = propCatalog.props[cell.prop.type];
          if (propDef?.textures) {
            for (const id of propDef.textures) usedIds.add(id);
          }
        }
      }
    }

    if (usedIds.size > 0) {
      ensureTexturesLoaded(usedIds, (loaded, total) => onAssetProgress('textures', loaded, total))
        .then(() => { state.texturesVersion++; notify(); });
    } else {
      onAssetProgress('textures', 1, 1);
    }
  });

  // Wire prop selection from explorer panel
  properties.setSelectPropCallback((propType) => {
    state.selectedProp = propType;
    setTool('prop');
    toolbar.updateToolButtons();
    toolbar.setSubMode('prop', 'place');
    notify();
  });

  // Expose toast for use across modules
  window.showToast = showToast;

  // Status bar updates
  subscribe(updateStatusBar);
  updateStatusBar();

  // Keyboard shortcuts
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  // Warn before navigating away with unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (state.unsavedChanges) {
      e.preventDefault();
    }
  });
});

function updateStatusBar() {
  const leftEl = document.getElementById('status-left');
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
  parts.push(`zoom: ${zoom}%`);
  leftEl.textContent = parts.join('  |  ');
  if (rightEl) rightEl.textContent = state.fileName || '';
}

function onKeyDown(e) {
  // Don't intercept when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); if (state.undoStack.length) { undo(); showToast('Undo'); } else { showToast('Nothing to undo'); } canvasView.requestRender(); }
  if (e.ctrlKey && e.key === 'y') { e.preventDefault(); if (state.redoStack.length) { redo(); showToast('Redo'); } else { showToast('Nothing to redo'); } canvasView.requestRender(); }
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveDungeon(); }

  // F1–F5: toggle sidebar panels
  const panelKeys = { 'F1': 'themes', 'F2': 'levels', 'F3': 'textures', 'F4': 'lighting', 'F5': 'session' };
  if (panelKeys[e.key]) { e.preventDefault(); togglePanel(panelKeys[e.key]); return; }

  // Suppress tool shortcuts in session tools mode — use session-specific keybinds instead
  const toolKeys = { '1': 'room', '2': 'paint', '3': 'fill', '4': 'wall', '5': 'door', '6': 'label', 's': 'stairs', 'b': 'bridge', 't': 'trim', 'a': 'select', 'q': 'prop', 'e': 'erase', 'l': 'light' };
  if (state.sessionToolsActive) {
    // 1/2: switch session tools
    const sessionToolKeys = { '1': 'doors', '2': 'range' };
    if (sessionToolKeys[e.key]) {
      e.preventDefault();
      const toolName = sessionToolKeys[e.key];
      const btn = document.querySelector(`[data-session-tool="${toolName}"]`);
      if (btn) btn.click();
      return;
    }
    // Tab / Shift+Tab: cycle range shape sub-tools
    if (e.key === 'Tab') {
      e.preventDefault();
      const shapes = [...document.querySelectorAll('#range-options [data-range-shape]')];
      if (shapes.length === 0) return;
      const activeIdx = shapes.findIndex(b => b.classList.contains('active'));
      const dir = e.shiftKey ? -1 : 1;
      const nextIdx = (activeIdx + dir + shapes.length) % shapes.length;
      shapes[nextIdx].click();
      return;
    }
    if (toolKeys[e.key]) return;
  }

  // Number keys for tools + L for light
  if (toolKeys[e.key]) {
    setTool(toolKeys[e.key]);
    toolbar.updateToolButtons();
    toolbar.applyToolSideEffects(toolKeys[e.key]);
  }

  // Tab / Shift+Tab: cycle sub-options for current tool
  if (e.key === 'Tab') {
    e.preventDefault();
    toolbar.cycleSubMode(e.shiftKey ? -1 : 1);
  }

  // Escape: deselect cell / close cell info panel
  if (e.key === 'Escape' && state.selectedCells.length) {
    properties.deselectCell();
    return;
  }

  // Delete selected cells
  if (e.key === 'Delete' && state.selectedCells.length) {
    pushUndo();
    for (const { row, col } of state.selectedCells) {
      state.dungeon.cells[row][col] = null;
    }
    state.selectedCells = [];
    markDirty();
    canvasView.requestRender();
  }

  // Forward to active tool
  const tool = tools[state.activeTool];
  if (tool?.onKeyDown) tool.onKeyDown(e);
}

function onKeyUp(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  // Forward to active tool (needed for room tool shift-release)
  const tool = tools[state.activeTool];
  if (tool?.onKeyUp) tool.onKeyUp(e);
}
