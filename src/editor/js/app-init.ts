/**
 * Application bootstrap — the bulk of the DOMContentLoaded handler.
 *
 * Loads catalogs, initialises panels, wires session tools, and sets up
 * the canvas. Called once from main.js.
 *
 * @module app-init
 */

import type { RenderTransform } from '../../types.js';
import state, { subscribe, loadAutosave, notify, invalidateLightmap } from './state.js';
import { showToast } from './toast.js';
import * as canvasView from './canvas-view.js';
import { reloadAssets, loadDungeonJSON } from './io.js';
import { loadThemeCatalog } from './theme-catalog.js';
import { loadTextureCatalog, collectTextureIds, ensureTexturesLoaded } from './texture-catalog.js';
import type { Tool } from './tools/tool-base.js';
import { RangeTool, FogRevealTool, type LightTool } from './tools/index.js';
import { loadPropCatalog, ensurePropHitboxesForMap } from './prop-catalog.js';
import { invalidateMinimapCache } from './minimap.js';
import { initPropSpatial, onPropSpatialDirty } from './prop-spatial.js';
import { loadLightCatalog } from './light-catalog.js';
import { loadGoboCatalog } from './gobo-catalog.js';
import {
  sessionState,
  renderSessionOverlay,
  renderDmFogOverlay,
  hitTestDoorButton,
  hitTestStairButton,
  openDoor,
  openStairs,
  setRangeHighlightCallback,
} from './dm-session.js';
import {
  setSessionOverlay,
  setSessionTool,
  setSessionRangeTool,
  setDmFogOverlay,
  setWeatherOverlay,
} from './canvas-view.js';
import {
  initToolbar,
  setToolChangeCallback,
  initSidebar,
  setPanelChangeCallback,
  initProperties,
  setSelectPropCallback,
  initMetadata,
  initLevels,
  initHistoryPanel,
  initLightingPanel,
  initWeatherPanel,
  renderWeatherGroupOverlay,
  initSessionPanel,
  initTexturesPanel,
  renderTexturesPanel,
  initRightSidebar,
  initClaudePanel,
  initBackgroundImagePanel,
  initKeybindingsHelper,
  toggleKeybindingsHelper,
  initDebugPanel,
  initPropEditDialog,
  initLightEditDialog,
  updateToolButtons,
  setSubMode,
} from './panels/index.js';
import { getEditorSettings, setEditorSetting } from './editor-settings.js';
import { initOnboarding } from './onboarding.js';
import { initTextureAlerts } from './texture-alerts.js';
import {
  initDraggableToolbar,
  updateStatusBar,
  initShortcutsModal,
  initReleaseNotesModal,
  initClaudeSettingsModal,
} from './ui-components.js';
import { getEl } from './utils.js';

/**
 * Main application bootstrap.
 *
 * @param {Object}   tools   - Tool registry (keyed by tool name).
 * @param {Function} setTool - Switches the active editor tool.
 * @param {Function} updateSessionToolsMode - Syncs session tools active state.
 * @returns {Promise<void>}
 */
export async function initApp(
  tools: Record<string, Tool>,
  setTool: (name: string) => void,
  updateSessionToolsMode: () => void,
): Promise<void> {
  // Wire up prop spatial hash (lazy getter to avoid circular import)
  initPropSpatial(() => state);
  // When props change (move/place/rotate/scale/remove):
  //   1. Clear the prop sub-layer cache so the next render rebuilds it.
  //   2. Route through MapCache.invalidateProps(), which uses the grid-only rebuild path.
  //      That replays only the top phases (walls + grid + props + labels) against a
  //      cached pre-grid snapshot, skipping the expensive floors/textures/blending/fills
  //      phases that a full contentVersion bump would rerun on every wheel tick.
  const { invalidatePropsRenderLayer } = await import('../../render/index.js');
  const { getMapCache } = await import('./canvas-view-state.js');
  onPropSpatialDirty(() => {
    invalidatePropsRenderLayer();
    getMapCache().invalidateProps();
  });

  // ── App version (status bar) ───────────────────────────────────────────
  fetch('/api/version')
    .then((r) => r.json())
    .then(({ version }) => {
      state.appVersion = version;
      const el = document.getElementById('status-version');
      if (el) el.textContent = `v${version}`;
    })
    .catch(() => {});

  // ── Update check (toolbar) ────────────────────────────────────────────
  fetch('/api/check-update')
    .then((r) => r.json())
    .then(({ hasUpdate, latestVersion, url }) => {
      if (!hasUpdate) return;
      const el = document.getElementById('btn-update-alert');
      if (!el) return;
      el.textContent = `↑ v${latestVersion} available`;
      (el as HTMLAnchorElement).href = url;
      el.style.display = 'flex';
    })
    .catch(() => {});

  // ── Editor UI theme (light/dark) ───────────────────────────────────────
  const savedTheme = localStorage.getItem('editor-ui-theme');
  if (savedTheme === 'light') document.documentElement.setAttribute('data-theme', 'light');

  getEl('theme-toggle').addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('editor-ui-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('editor-ui-theme', 'light');
    }
  });

  // ── Texture alerts ─────────────────────────────────────────────────────
  initTextureAlerts(reloadAssets, renderTexturesPanel);

  // Restore autosaved state (before canvas init so zoom/pan are set)
  const restored = await loadAutosave();
  // (no migration needed for autosaved state — always current format)

  // Init canvas
  const canvas = getEl<HTMLCanvasElement>('editor-canvas');
  canvasView.init(canvas);

  // Set initial tool (use restored tool or default)
  if (!restored) state.activeTool = 'room';
  // Migration: if restored tool was removed, default to room

  if (!tools[state.activeTool]) state.activeTool = 'room';
  setTool(state.activeTool);

  // ── Loading overlay (spinner over canvas during init / file open) ────
  const editorLoadingOverlay = document.getElementById('editor-loading-overlay');

  // ── Asset loading bar ──────────────────────────────────────────────────
  const loadingBar = document.getElementById('loading-bar');
  const loadingFill = document.getElementById('loading-bar-fill');
  if (loadingBar) loadingBar.classList.add('active');

  const progress: Record<string, { loaded: number; total: number } | null> = {
    themes: null,
    props: null,
    textures: null,
  };
  const toasted = { themes: false, props: false, textures: false };
  const labels = { themes: 'Themes', props: 'Props', textures: 'Textures' };
  // Texture progress events fire on Image `load` (bytes arrived), but textures
  // aren't GPU-ready until `decode()` + `createImageBitmap()` finish. Gate the
  // overlay on this flag, which the texture preload `.then()` sets — otherwise
  // the overlay hides during the decode gap and textures pop in on first paint.
  let texturesReady = false;
  function maybeHideOverlay(sumLoaded: number, sumTotal: number) {
    const allReported = Object.values(progress).every((v) => v !== null);
    if (allReported && sumLoaded >= sumTotal && sumTotal > 0 && texturesReady) {
      setTimeout(() => loadingBar?.classList.remove('active'), 400);
      editorLoadingOverlay?.classList.add('hidden');
    }
  }
  function onAssetProgress(key: string, loaded: number, total: number) {
    (progress as Record<string, unknown>)[key] = { loaded, total };
    // Per-catalog toast
    if (loaded >= total && total > 0 && !(toasted as Record<string, boolean>)[key]) {
      (toasted as Record<string, boolean>)[key] = true;
      showToast(`${(labels as Record<string, string>)[key]} loaded`);
    }
    // Aggregate bar
    let sumLoaded = 0,
      sumTotal = 0;
    for (const v of Object.values(progress)) {
      if (v) {
        sumLoaded += v.loaded;
        sumTotal += v.total;
      }
    }
    if (loadingFill && sumTotal > 0) {
      loadingFill.style.width = `${Math.round((sumLoaded / sumTotal) * 100)}%`;
    }
    maybeHideOverlay(sumLoaded, sumTotal);
  }
  function markTexturesReady() {
    texturesReady = true;
    let sumLoaded = 0,
      sumTotal = 0;
    for (const v of Object.values(progress)) {
      if (v) {
        sumLoaded += v.loaded;
        sumTotal += v.total;
      }
    }
    maybeHideOverlay(sumLoaded, sumTotal);
  }

  // Load themes in the background — don't block editor startup.
  // The metadata panel's theme picker rebuilds when the catalog arrives via
  // the user-themes-changed event (also fired on user-theme save/delete).
  void loadThemeCatalog((loaded: number, total: number) => onAssetProgress('themes', loaded, total))
    .then(() => {
      // Theme colors drive the minimap background; invalidate any cache that
      // was built before THEMES finished populating.
      invalidateMinimapCache();
      window.dispatchEvent(new Event('user-themes-changed'));
      notify();
    })
    .catch((err) => console.warn('Failed to load theme catalog:', err));

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

  // Init weather panel
  const weatherContainer = document.getElementById('weather-panel-content');
  if (weatherContainer) initWeatherPanel(weatherContainer);

  // Init session panel
  const sessionContainer = document.getElementById('session-panel-content');
  if (sessionContainer) initSessionPanel(sessionContainer);

  // Init background image panel
  const bgImageContainer = document.getElementById('background-image-panel-content');
  if (bgImageContainer) initBackgroundImagePanel(bgImageContainer);

  // Prop edit dialog (floating, opens on double-click / Enter)
  initPropEditDialog();

  // Light edit dialog (floating, opens on double-click / Enter on a selected light)
  initLightEditDialog();

  // Keybindings helper (floating panel)
  initKeybindingsHelper();
  document.getElementById('feat-keybindings')?.addEventListener('change', (e) => {
    toggleKeybindingsHelper((e.target as HTMLInputElement).checked);
  });

  // ── Claude AI (experimental) ─────────────────────────────────────────────
  // Toggle via View → Developer → Claude AI, or visit with ?claude to enable once.
  if (new URLSearchParams(location.search).has('claude')) {
    setEditorSetting('claude', true);
  }
  const CLAUDE_ENABLED = getEditorSettings().claude === true;

  if (!CLAUDE_ENABLED) {
    document.querySelector<HTMLInputElement>('[data-right-panel="claude"]')?.remove();
    document.getElementById('right-panel-claude')?.remove();
    document.getElementById('sep-claude-settings')?.remove();
    document.getElementById('btn-claude-settings')?.remove();
    document.getElementById('modal-claude-settings')?.remove();
  } else {
    const claudeContainer = document.getElementById('claude-panel-content');
    if (claudeContainer) initClaudePanel(claudeContainer);
  }

  // Debug panel (always init — visibility controlled by feat-debug checkbox)
  const debugContainer = document.getElementById('debug-panel-content');
  if (debugContainer) initDebugPanel(debugContainer);

  // Wire session overlay (door/stair-open buttons on DM canvas)
  setSessionOverlay(
    renderSessionOverlay as unknown as (...args: unknown[]) => void,
    ((px: number, py: number, transform: RenderTransform, gridSize: number) => {
      const stair = hitTestStairButton(px, py, transform);
      if (stair) {
        openStairs(stair.stairId, stair.partnerId);
        return true;
      }
      const door = hitTestDoorButton(px, py, transform, gridSize);
      if (door) {
        openDoor(door.row, door.col, door.dir, door.cells);
        return true;
      }
      return false;
    }) as unknown as (...args: unknown[]) => boolean,
  );

  // Wire DM fog overlay (tints unrevealed cells for the DM's reference)
  setDmFogOverlay(renderDmFogOverlay as unknown as (...args: unknown[]) => void);

  // Wire weather group overlay (editor-only color wash showing group membership)
  setWeatherOverlay(renderWeatherGroupOverlay as unknown as (...args: unknown[]) => void);

  // ── Range detector (session tool) ────────────────────────────────────────
  const dmRangeTool = new RangeTool(
    (msg: Record<string, unknown>) => {
      if (sessionState.ws?.readyState === 1) {
        sessionState.ws.send(JSON.stringify(msg));
      }
    },
    () => ({
      gridSize: state.dungeon.metadata.gridSize,
      numRows: state.dungeon.cells.length,
      numCols: state.dungeon.cells[0]?.length ?? 0,
    }),
    () => canvasView.requestRender(),
  );

  // ── Fog reveal (session tool) ─────────────────────────────────────────────
  const dmFogRevealTool = new FogRevealTool();

  // Always render range highlights (including player-sent ones) in any session sub-mode
  setSessionRangeTool(dmRangeTool);

  // Wire incoming range highlights from players
  setRangeHighlightCallback((msg) => {
    dmRangeTool.applyRemoteHighlight(msg);
    canvasView.requestRender();
  });

  // Session tool button switching (Doors vs Range)
  document.querySelectorAll<HTMLElement>('[data-session-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('[data-session-tool]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const tool = btn.dataset.sessionTool;
      const rangeOpts = document.getElementById('range-options');
      if (tool === 'range') {
        setSessionTool(dmRangeTool);
        canvasView.setCursor('crosshair');
        if (rangeOpts) rangeOpts.style.display = 'flex';
      } else if (tool === 'fog-reveal') {
        setSessionTool(dmFogRevealTool);
        canvasView.setCursor('crosshair');
        if (rangeOpts) rangeOpts.style.display = 'none';
      } else {
        setSessionTool(null);
        canvasView.setCursor('default');
        if (rangeOpts) rangeOpts.style.display = 'none';
      }
      canvasView.requestRender();
    });
  });

  // Range shape sub-tool switching
  document.querySelectorAll<HTMLElement>('[data-range-shape]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('[data-range-shape]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      dmRangeTool.setSubTool(btn.dataset.rangeShape!);
    });
  });

  // Range distance dropdown — populate with gridSize increments up to 200ft
  const rangeDistSelect = document.getElementById('range-distance');
  if (rangeDistSelect) {
    const el = rangeDistSelect;
    function populateRangeOptions() {
      const gs = state.dungeon.metadata.gridSize || 5;
      // Keep "Auto" option, rebuild the rest
      el.innerHTML = '<option value="0">Auto</option>';
      for (let ft = gs; ft <= 200; ft += gs) {
        const opt = document.createElement('option');
        opt.value = String(ft);
        opt.textContent = `${ft} ft`;
        el.appendChild(opt);
      }
    }
    populateRangeOptions();
    el.addEventListener('change', () => {
      dmRangeTool.setFixedRange(parseInt((el as HTMLSelectElement).value, 10));
    });
    // Re-populate when gridSize changes so ft increments stay accurate
    let _rangeLastGridSize = state.dungeon.metadata.gridSize || 5;
    subscribe(() => {
      const gs = state.dungeon.metadata.gridSize || 5;
      if (gs !== _rangeLastGridSize) {
        _rangeLastGridSize = gs;
        populateRangeOptions();
      }
    }, 'range-grid');
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
  subscribe(() => updateSessionToolsMode(), 'session-tools');

  // Load light preset catalog (metadata only, fast)
  loadLightCatalog()
    .then((catalog) => {
      state.lightCatalog = catalog;
      // If the light tool activated before the catalog resolved, populate its preset bar now

      if (state.activeTool === 'light' && tools.light) {
        (tools.light as LightTool)._syncPresetBar();
      }
      notify();
    })
    .catch((err) => console.warn('Failed to load light catalog:', err));

  // Load gobo catalog — tiny bundle, populates the render-side gobo registry so
  // `extractGoboZones` can resolve pattern/density when props declare `gobos:`.
  loadGoboCatalog()
    .then(() => invalidateLightmap())
    .catch((err) => console.warn('Failed to load gobo catalog:', err));

  // Load prop catalog (async, doesn't block editor)
  const propCatalogPromise = loadPropCatalog((loaded, total) => onAssetProgress('props', loaded, total))
    .then((catalog) => {
      state.propCatalog = catalog;
      // Hitboxes are baked into bundle.json; ensurePropHitboxesForMap is a
      // safety net for props that lack baked data (e.g. per-file fallback path).
      ensurePropHitboxesForMap(state.dungeon);
      // Invalidate the lighting visibility cache so wall segments are recomputed
      // with full prop data (props can cast shadows; segments cached before this
      // point would exclude prop-based walls, causing animated lights to render
      // without shadows until manually nudged).
      if (state.dungeon.metadata.lights.length) {
        invalidateLightmap();
      }
      invalidateMinimapCache();
      notify();
      return catalog;
    })
    .catch((err) => {
      console.warn('Failed to load prop catalog:', err);
      return null;
    });

  // Load texture catalog (metadata only — images load on demand)
  const textureCatalogPromise = loadTextureCatalog()
    .then((catalog) => {
      state.textureCatalog = catalog;
      const texContainer = document.getElementById('textures-panel-content');
      if (texContainer) initTexturesPanel(texContainer);
      invalidateMinimapCache();
      notify();
      return catalog;
    })
    .catch((err) => {
      console.warn('Failed to load texture catalog:', err);
      return null;
    });

  // After both catalogs are ready, pre-load textures for the current map (floor + props)
  void Promise.all([propCatalogPromise, textureCatalogPromise]).then(([propCatalog, textureCatalog]) => {
    if (!textureCatalog) {
      onAssetProgress('textures', 1, 1);
      markTexturesReady();
      return;
    }

    const usedIds = collectTextureIds(state.dungeon.cells);
    if (propCatalog?.props && state.dungeon.metadata.props) {
      for (const op of state.dungeon.metadata.props) {
        const propDef = propCatalog.props[op.type];

        if (propDef?.textures) {
          for (const id of propDef.textures) usedIds.add(id);
        }
      }
    }
    // Bridge textures (hardcoded Polyhaven IDs in bridges.js)
    if (state.dungeon.metadata.bridges.length) {
      const bridgeTexIds = {
        wood: 'polyhaven/weathered_planks',
        stone: 'polyhaven/stone_wall',
        rope: 'polyhaven/worn_planks',
        dock: 'polyhaven/brown_planks_09',
      };
      for (const b of state.dungeon.metadata.bridges) {
        const tid = bridgeTexIds[b.type];
        if (tid) usedIds.add(tid);
      }
    }

    if (usedIds.size > 0) {
      void ensureTexturesLoaded(usedIds, (loaded, total) => onAssetProgress('textures', loaded, total)).then(() => {
        state.texturesVersion++;
        notify();
        markTexturesReady();
      });
    } else {
      onAssetProgress('textures', 1, 1);
      markTexturesReady();
    }
  });

  // ── Auto-load file from URL (file association / double-click) ─────────────
  const openParam = new URLSearchParams(window.location.search).get('open');
  if (openParam) {
    // Wait for prop catalog so textures load correctly
    void propCatalogPromise.then(() =>
      fetch(`/api/open-file?path=${encodeURIComponent(openParam)}`)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.json();
        })
        .then((json) => loadDungeonJSON(json, { fileName: openParam.split(/[/\\]/).pop() }))
        .catch((err) => console.warn('Auto-load failed:', err)),
    );
  }

  // Wire prop selection from explorer panel
  setSelectPropCallback((propType) => {
    state.selectedProp = propType;
    setTool('prop');
    updateToolButtons();
    setSubMode('prop', 'place');
    notify();
  });

  // Expose toast for use across modules
  (window as unknown as Record<string, unknown>).showToast = showToast;

  // Status bar updates
  subscribe(updateStatusBar, 'status-bar');
  updateStatusBar();

  // Modals
  initShortcutsModal();
  initReleaseNotesModal();

  // Claude Settings modal (only wired when feature is enabled)
  if (CLAUDE_ENABLED) {
    initClaudeSettingsModal();
  }

  // Onboarding (welcome modal, tutorial, first-use hints)
  initOnboarding();

  // Warn before navigating away with unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (state.unsavedChanges) {
      e.preventDefault();
    }
  });
}
