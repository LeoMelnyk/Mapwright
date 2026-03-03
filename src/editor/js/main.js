// App initialization
import state, { undo, redo, subscribe, pushUndo, markDirty, loadAutosave, notify, invalidateLightmap } from './state.js';
import { showToast } from './toast.js';
import * as canvasView from './canvas-view.js';
import { saveDungeon, reloadAssets } from './io.js';
import { loadThemeCatalog } from './theme-catalog.js';
import { loadTextureCatalog, collectTextureIds, ensureTexturesLoaded } from './texture-catalog.js';
import { RoomTool, PaintTool, WallTool, DoorTool, LabelTool, StairsTool, BridgeTool, SelectTool, TrimTool, PropTool, EraseTool, LightTool, FillTool, RangeTool } from './tools/index.js';
import { loadPropCatalog } from './prop-catalog.js';
import { loadLightCatalog } from './light-catalog.js';
import { sessionState, renderSessionOverlay, renderDmFogOverlay, hitTestDoorButton, hitTestStairButton, openDoor, openStairs, setRangeHighlightCallback } from './dm-session.js';
import { setSessionOverlay, setSessionTool, setSessionRangeTool, setDmFogOverlay, zoomToFit } from './canvas-view.js';
import {
  initToolbar, setToolChangeCallback, applyToolSideEffects, cycleSubMode, getToolCursor, updateToolButtons, setSubMode,
  initSidebar, getActivePanel, setPanelChangeCallback, togglePanel,
  initProperties, setSelectPropCallback, deselectCell,
  initMetadata,
  initLevels, selectLevel,
  initHistoryPanel,
  initLightingPanel,
  initSessionPanel,
  initTexturesPanel, renderTexturesPanel,
  initRightSidebar,
  initClaudePanel,
} from './panels/index.js';
import { getClaudeSettings, setClaudeSetting } from './claude-settings.js';
import { getEditorSettings, setEditorSetting } from './editor-settings.js';

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
  const cursor = getToolCursor(name);
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
  document.querySelectorAll('.suboptions-bar, .tertiaryoptions-bar').forEach(el => el.style.display = 'none');
  document.getElementById('session-tool-row').style.display = 'flex';
  document.getElementById('drawing-toolbar')?.classList.add('session-active');
}

function exitSessionToolsMode() {
  // Hide session toolbar + range sub-options, show normal toolbar
  document.getElementById('session-tool-row').style.display = 'none';
  const rangeOpts = document.getElementById('range-options');
  if (rangeOpts) rangeOpts.style.display = 'none';
  document.getElementById('editor-tool-row').style.display = 'flex';
  document.getElementById('drawing-toolbar')?.classList.remove('session-active');

  // Restore previous editor tool
  const toolToRestore = savedTool && tools[savedTool] ? savedTool : 'room';
  setTool(toolToRestore);
  updateToolButtons();
  savedTool = null;
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  // ── App version (status bar) ───────────────────────────────────────────
  fetch('/api/version').then(r => r.json()).then(({ version }) => {
    const el = document.getElementById('status-version');
    if (el) el.textContent = `v${version}`;
  }).catch(() => {});

  // ── Update check (toolbar) ────────────────────────────────────────────
  fetch('/api/check-update').then(r => r.json()).then(({ hasUpdate, latestVersion, url }) => {
    if (!hasUpdate) return;
    const el = document.getElementById('btn-update-alert');
    if (!el) return;
    el.textContent = `↑ v${latestVersion} available`;
    el.href = url;
    el.style.display = 'flex';
  }).catch(() => {});

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

  // Texture alert button: three states driven by /api/textures/status.
  //  - count < requiredCount          → "Missing Textures" (amber)
  //  - count >= required, count < cat → "New Textures Available" (teal)
  //  - otherwise                      → hidden
  const btnTextureAlert = document.getElementById('btn-texture-alert');

  function _updateAlertBtn({ count, requiredCount, catalogCount, downloadInProgress, downloadSnapshot }) {
    if (downloadInProgress) {
      if (!btnTextureAlert.classList.contains('downloading')) {
        btnTextureAlert.style.display = 'inline-flex';
        btnTextureAlert.classList.add('downloading');
        btnTextureAlert.style.setProperty('--dl-pct', '0%');
        btnTextureAlert.innerHTML = '<span>Downloading 0%</span>';
      }
      if (downloadSnapshot?.index !== undefined && downloadSnapshot?.total) {
        const pct = Math.round((downloadSnapshot.index / downloadSnapshot.total) * 100);
        btnTextureAlert.style.setProperty('--dl-pct', `${pct}%`);
        const span = btnTextureAlert.querySelector('span');
        if (span) span.textContent = `Downloading ${pct}%`;
      }
      _startDlPolling();
      return;
    }
    _stopDlPolling();
    btnTextureAlert.classList.remove('new-available');
    const label = btnTextureAlert.querySelector('.alert-label');
    if (count < requiredCount) {
      btnTextureAlert.title = 'Some required textures are missing — click to download';
      if (label) label.textContent = 'Missing Textures';
      btnTextureAlert.style.display = 'inline-flex';
    } else if (catalogCount !== null && count < catalogCount) {
      btnTextureAlert.classList.add('new-available');
      btnTextureAlert.title = 'New textures are available on Polyhaven — click to download';
      if (label) label.textContent = 'New Textures Available';
      btnTextureAlert.style.display = 'inline-flex';
    } else {
      btnTextureAlert.style.display = 'none';
    }
  }

  function _fetchAndUpdateAlert(retriesLeft = 12) {
    fetch('/api/textures/status')
      .then(r => r.json())
      .then(status => {
        _updateAlertBtn(status);
        // catalogCount comes from a background server fetch of the Polyhaven catalog.
        // If it's not resolved yet, retry every 1.5 s until it is (or retries run out).
        if (retriesLeft > 0 && status.catalogCount === null && status.count >= status.requiredCount) {
          setTimeout(() => _fetchAndUpdateAlert(retriesLeft - 1), 1500);
        }
      })
      .catch(() => {});
  }

  _fetchAndUpdateAlert();

  btnTextureAlert.addEventListener('click', () => {
    // Named target — if the downloader window is already open it gets focused
    // instead of opening a new one.
    window.open(
      `${location.protocol}//${location.host}/downloader/`,
      'mapwright-downloader',
      'width=520,height=520,resizable=no'
    );
  });

  // Transform the toolbar button into a live progress bar while downloading
  // in the background, and reload assets automatically when done.
  const _alertBtnOrigHTML = btnTextureAlert.innerHTML;

  let _dlPollInterval = null;
  function _startDlPolling() {
    if (_dlPollInterval) return;
    _dlPollInterval = setInterval(() => {
      fetch('/api/textures/status')
        .then(r => r.json())
        .then(status => { _updateAlertBtn(status); })
        .catch(() => {});
    }, 1500);
  }
  function _stopDlPolling() {
    if (_dlPollInterval) { clearInterval(_dlPollInterval); _dlPollInterval = null; }
  }

  function _resetAlertBtn() {
    btnTextureAlert.classList.remove('downloading', 'new-available');
    btnTextureAlert.style.removeProperty('--dl-pct');
    btnTextureAlert.innerHTML = _alertBtnOrigHTML;
  }

  function _recheckAlertBtn() {
    _fetchAndUpdateAlert(true);
  }

  const _bc = new BroadcastChannel('mapwright');
  _bc.addEventListener('message', async ({ data }) => {
    if (data?.type === 'download-start') {
      btnTextureAlert.style.display = 'inline-flex';
      btnTextureAlert.classList.add('downloading');
      btnTextureAlert.style.setProperty('--dl-pct', '0%');
      btnTextureAlert.innerHTML = '<span>Downloading 0%</span>';
      _startDlPolling();

    } else if (data?.type === 'download-progress') {
      const pct = Math.round((data.index / data.total) * 100);
      btnTextureAlert.style.setProperty('--dl-pct', `${pct}%`);
      const span = btnTextureAlert.querySelector('span');
      if (span) span.textContent = `Downloading ${pct}%`;

    } else if (data?.type === 'download-cancelled') {
      _stopDlPolling();
      _resetAlertBtn();
      // The server may still be finishing the current texture — poll until it confirms
      // the cancel before updating the button (avoids re-entering downloading mode).
      const _waitCancel = setInterval(() => {
        fetch('/api/textures/status')
          .then(r => r.json())
          .then(status => {
            if (!status.downloadInProgress) {
              clearInterval(_waitCancel);
              _updateAlertBtn(status);
            }
          })
          .catch(() => {});
      }, 500);

    } else if (data?.type === 'textures-downloaded') {
      _stopDlPolling();
      _resetAlertBtn();
      await reloadAssets();
      renderTexturesPanel();
      _recheckAlertBtn();
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
  initToolbar();
  setToolChangeCallback(setTool);
  initDraggableToolbar();
  initSidebar();
  initRightSidebar();
  initProperties();
  initMetadata();
  initLevels();

  // Init history panel
  const historyContainer = document.getElementById('history-panel-content');
  if (historyContainer) initHistoryPanel(historyContainer);

  // Init lighting panel
  const lightingContainer = document.getElementById('lighting-panel-content');
  if (lightingContainer) initLightingPanel(lightingContainer);

  // Init session panel
  const sessionContainer = document.getElementById('session-panel-content');
  if (sessionContainer) initSessionPanel(sessionContainer);

  // ── Claude AI (experimental) ─────────────────────────────────────────────
  // Toggle via View → Developer → Claude AI, or visit with ?claude to enable once.
  if (new URLSearchParams(location.search).has('claude')) {
    setEditorSetting('claude', true);
  }
  const CLAUDE_ENABLED = getEditorSettings().claude === true;

  if (!CLAUDE_ENABLED) {
    document.querySelector('[data-right-panel="claude"]')?.remove();
    document.getElementById('right-panel-claude')?.remove();
    document.getElementById('btn-claude-settings')?.remove();
    document.getElementById('modal-claude-settings')?.remove();
  } else {
    const claudeContainer = document.getElementById('claude-panel-content');
    if (claudeContainer) initClaudePanel(claudeContainer);
  }

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

  // Wire DM fog overlay (tints unrevealed cells for the DM's reference)
  setDmFogOverlay(renderDmFogOverlay);

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
    // Re-populate when gridSize changes so ft increments stay accurate
    let _rangeLastGridSize = state.dungeon?.metadata?.gridSize || 5;
    subscribe(() => {
      const gs = state.dungeon?.metadata?.gridSize || 5;
      if (gs !== _rangeLastGridSize) {
        _rangeLastGridSize = gs;
        populateRangeOptions();
      }
    });
  }

  // Wire session tools mode + auto-tool-switch on panel change
  setPanelChangeCallback((panelId) => {
    updateSessionToolsMode();
    // Auto-activate light tool when lighting panel is opened
    if (panelId === 'lighting' && state.activeTool !== 'light') {
      setTool('light');
      updateToolButtons();
    }
  });
  subscribe(() => updateSessionToolsMode());

  // Load light preset catalog (metadata only, fast)
  loadLightCatalog().then(catalog => {
    state.lightCatalog = catalog;
    // If the light tool activated before the catalog resolved, populate its preset bar now
    if (state.activeTool === 'light' && tools.light) {
      tools.light._syncPresetBar();
    }
    notify();
  }).catch(err => console.warn('Failed to load light catalog:', err));

  // Load prop catalog (async, doesn't block editor)
  const propCatalogPromise = loadPropCatalog((loaded, total) => onAssetProgress('props', loaded, total)).then(catalog => {
    state.propCatalog = catalog;
    // Invalidate the lighting visibility cache so wall segments are recomputed
    // with full prop data (props can cast shadows; segments cached before this
    // point would exclude prop-based walls, causing animated lights to render
    // without shadows until manually nudged).
    if (state.dungeon.metadata.lights?.length) {
      invalidateLightmap();
    }
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
  setSelectPropCallback((propType) => {
    state.selectedProp = propType;
    setTool('prop');
    updateToolButtons();
    setSubMode('prop', 'place');
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

  // Keyboard Shortcuts modal
  function openShortcutsModal() {
    const m = document.getElementById('modal-shortcuts');
    if (m) m.style.display = 'flex';
  }
  function closeShortcutsModal() {
    const m = document.getElementById('modal-shortcuts');
    if (m) m.style.display = 'none';
  }
  document.getElementById('btn-shortcuts')?.addEventListener('click', openShortcutsModal);
  document.getElementById('modal-shortcuts-close')?.addEventListener('click', closeShortcutsModal);
  document.getElementById('modal-shortcuts')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeShortcutsModal();
  });

  // Expose openShortcutsModal for keydown handler (defined before it, called by name)
  window._openShortcutsModal = openShortcutsModal;

  // Claude Settings modal (only wired when feature is enabled)
  if (CLAUDE_ENABLED) {
  function updatePullCmd(modelValue) {
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
    m.style.display = 'flex';
  }
  function closeClaudeSettingsModal() {
    const m = document.getElementById('modal-claude-settings');
    if (m) m.style.display = 'none';
  }
  document.getElementById('claude-model-select')?.addEventListener('change', (e) => updatePullCmd(e.target.value));
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
  } // end CLAUDE_ENABLED
});

function initDraggableToolbar() {
  const toolbar = document.getElementById('drawing-toolbar');
  const handle = document.getElementById('toolbar-drag-handle');
  const lockBtn = document.getElementById('toolbar-lock-btn');
  if (!toolbar || !handle || !lockBtn) return;

  let locked = true;
  let dragging = false;
  let startMouseX = 0, startMouseY = 0;
  let startLeft = 0, startBottom = 0;
  let activeSnap = null;
  let dragContainerWidth = 0;
  let dragContainerHeight = 0;

  const _SNAP_THRESHOLD = 40; // reserved for future snap-distance tuning
  const SNAP_EDGE = 20; // margin from container edge for snap positions
  const DOCK_CLASSES = ['toolbar-docked-top', 'toolbar-docked-left', 'toolbar-docked-right'];

  function applySnap(snapId) {
    toolbar.classList.remove(...DOCK_CLASSES);
    // Use 'auto'/'none' not '' — clearing with '' exposes base CSS values
    // (base CSS has bottom: 20px and left: 50% which would create conflicts)
    toolbar.style.left = 'auto';
    toolbar.style.right = 'auto';
    toolbar.style.top = 'auto';
    toolbar.style.bottom = 'auto';
    toolbar.style.transform = 'none';

    if (snapId === 'center-bottom') {
      toolbar.style.left = '50%';
      toolbar.style.transform = 'translateX(-50%)';
      toolbar.style.bottom = `${SNAP_EDGE}px`;
    } else if (snapId === 'center-top') {
      toolbar.style.left = '50%';
      toolbar.style.transform = 'translateX(-50%)';
      toolbar.style.top = `${SNAP_EDGE}px`;
      toolbar.classList.add('toolbar-docked-top');
    } else if (snapId === 'center-left') {
      toolbar.style.left = `${SNAP_EDGE}px`;
      toolbar.style.top = '50%';
      toolbar.style.transform = 'translateY(-50%)';
      toolbar.classList.add('toolbar-docked-left');
    } else if (snapId === 'center-right') {
      toolbar.style.right = `${SNAP_EDGE}px`;
      toolbar.style.top = '50%';
      toolbar.style.transform = 'translateY(-50%)';
      toolbar.classList.add('toolbar-docked-right');
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
      toolbar.style.left = `${left}px`;
      toolbar.style.right = 'auto';
      toolbar.style.bottom = `${bottom}px`;
      toolbar.style.top = 'auto';
      toolbar.style.transform = 'none';
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
    const containerRect = container.getBoundingClientRect();
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

function updateStatusBar() {
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

function onKeyDown(e) {
  // Don't intercept when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); if (state.undoStack.length) { undo(); showToast('Undo'); } else { showToast('Nothing to undo'); } canvasView.requestRender(); }
  if (e.ctrlKey && e.key === 'y') { e.preventDefault(); if (state.redoStack.length) { redo(); showToast('Redo'); } else { showToast('Nothing to redo'); } canvasView.requestRender(); }
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveDungeon(); }

  // H: zoom to fit current level
  if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey) {
    e.preventDefault();
    zoomToFit();
    return;
  }

  // ?: open keyboard shortcuts modal
  if (e.key === '?' && !e.ctrlKey) {
    e.preventDefault();
    window._openShortcutsModal?.();
    return;
  }

  // Ctrl+C: copy selected cells (Select tool only)
  if (e.ctrlKey && e.key === 'c' && state.activeTool === 'select' && state.selectedCells.length > 0) {
    e.preventDefault();
    const cells = state.dungeon.cells;
    const anchorRow = Math.min(...state.selectedCells.map(c => c.row));
    const anchorCol = Math.min(...state.selectedCells.map(c => c.col));
    state.clipboard = {
      anchorRow, anchorCol,
      cells: state.selectedCells.map(({ row, col }) => ({
        dRow: row - anchorRow,
        dCol: col - anchorCol,
        data: cells[row][col] ? JSON.parse(JSON.stringify(cells[row][col])) : null,
      })),
    };
    const n = state.selectedCells.length;
    showToast(`Copied ${n} cell${n === 1 ? '' : 's'}`);
    return;
  }

  // Ctrl+C: copy selected props (Prop tool only)
  if (e.ctrlKey && e.key === 'c' && state.activeTool === 'prop' && state.selectedPropAnchors.length > 0) {
    e.preventDefault();
    const cells = state.dungeon.cells;
    const anchorRow = Math.min(...state.selectedPropAnchors.map(a => a.row));
    const anchorCol = Math.min(...state.selectedPropAnchors.map(a => a.col));
    const props = [];
    for (const { row, col } of state.selectedPropAnchors) {
      const cell = cells[row]?.[col];
      if (cell?.prop) {
        props.push({
          dRow: row - anchorRow,
          dCol: col - anchorCol,
          prop: JSON.parse(JSON.stringify(cell.prop)),
        });
      }
    }
    if (props.length > 0) {
      state.propClipboard = { anchorRow, anchorCol, props };
      showToast(`Copied ${props.length} prop${props.length === 1 ? '' : 's'}`);
    }
    return;
  }

  // Ctrl+V: enter prop paste mode (Prop tool, when prop clipboard exists)
  if (e.ctrlKey && e.key === 'v' && state.propClipboard && state.activeTool === 'prop') {
    e.preventDefault();
    state.propPasteMode = true;
    canvasView.requestRender();
    return;
  }

  // Ctrl+V: enter paste mode (Select tool)
  if (e.ctrlKey && e.key === 'v' && state.clipboard) {
    e.preventDefault();
    if (state.activeTool !== 'select') {
      // Switch to select tool first
      const btn = document.querySelector('[data-tool="select"]');
      if (btn) btn.click();
    }
    state.pasteMode = true;
    canvasView.requestRender();
    return;
  }

  // Escape: cancel paste mode
  if (e.key === 'Escape' && (state.pasteMode || state.propPasteMode)) {
    state.pasteMode = false;
    state.propPasteMode = false;
    canvasView.requestRender();
    return;
  }

  // F1–F5: toggle sidebar panels
  const panelKeys = { 'F1': 'themes', 'F2': 'levels', 'F3': 'textures', 'F4': 'lighting', 'F5': 'session' };
  if (panelKeys[e.key]) { e.preventDefault(); togglePanel(panelKeys[e.key]); return; }

  // Ctrl+1–9: switch to level by index
  if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    selectLevel(parseInt(e.key, 10) - 1);
    return;
  }

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
    updateToolButtons();
    applyToolSideEffects(toolKeys[e.key]);
  }

  // Tab / Shift+Tab: cycle sub-options for current tool
  if (e.key === 'Tab') {
    e.preventDefault();
    cycleSubMode(e.shiftKey ? -1 : 1);
  }

  // Escape: deselect cell / close cell info panel
  if (e.key === 'Escape' && state.selectedCells.length) {
    deselectCell();
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

  // D / Shift+D: cycle water/lava depth (fill tool, water or lava mode only)
  if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey &&
      state.activeTool === 'fill' && (state.fillMode === 'water' || state.fillMode === 'lava')) {
    e.preventDefault();
    const cur = state.fillMode === 'lava' ? state.lavaDepth : state.waterDepth;
    const next = e.shiftKey ? (cur === 1 ? 3 : cur - 1) : (cur === 3 ? 1 : cur + 1);
    if (state.fillMode === 'lava') state.lavaDepth = next;
    else state.waterDepth = next;
    document.querySelectorAll('[data-water-depth]').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.waterDepth, 10) === next);
    });
    return;
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
