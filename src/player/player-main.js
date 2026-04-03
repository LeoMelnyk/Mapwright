// Player view entry point: WebSocket connection, catalog loading, canvas init.

import playerState from './player-state.js';
import * as playerCanvas from './player-canvas.js';
import { invalidateFullMapCache, invalidateLightingOnly, invalidatePropsChange, patchOpenedDoor, revealFogCells, concealFogCells, resetFogLayers, markAssetsReady } from './player-canvas.js';
import { loadPropCatalog, loadTextureCatalog, collectTextureIds, ensureTexturesLoaded, RangeTool } from '../editor/js/index.js';
import { BRIDGE_TEXTURE_IDS } from '../render/index.js';

let ws = null;
let reconnectTimer = null;
let playerRangeTool = null;
const statusEl = () => document.getElementById('connection-status');
const resyncBtn = () => document.getElementById('resync-btn');

// ── WebSocket ───────────────────────────────────────────────────────────────

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws?role=player`;

  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    playerState.connected = true;
    setStatus('connected', 'Connected');
    // Hide status after 2s
    setTimeout(() => statusEl()?.classList.add('hidden'), 2000);
  });

  ws.addEventListener('close', () => {
    playerState.connected = false;
    setStatus('disconnected', 'Disconnected — reconnecting…');
    statusEl()?.classList.remove('hidden');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    ws?.close();
  });

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function setStatus(cls, text) {
  const el = statusEl();
  if (!el) return;
  el.className = '';
  el.id = 'connection-status';
  el.classList.add(cls);
  el.textContent = text;
}

// ── Texture loading helper ──────────────────────────────────────────────────

/** Load all textures used by the current dungeon (floor + prop textures).
 *  Resolves immediately if catalogs aren't ready yet or no textures needed. */
async function loadMapTextures() {
  if (!playerState.textureCatalog || !playerState.dungeon) return;
  const usedIds = collectTextureIds(playerState.dungeon.cells);
  if (playerState.propCatalog?.props && playerState.dungeon.metadata?.props) {
    for (const op of playerState.dungeon.metadata.props) {
      const propDef = playerState.propCatalog.props[op.type];
      if (propDef?.textures) {
        for (const id of propDef.textures) usedIds.add(id);
      }
    }
  }
  // Include bridge textures (hardcoded IDs in bridges.js)
  if (playerState.dungeon.metadata?.bridges?.length) {
    for (const b of playerState.dungeon.metadata.bridges) {
      const texId = BRIDGE_TEXTURE_IDS[b.type] || BRIDGE_TEXTURE_IDS.wood;
      usedIds.add(texId);
    }
  }
  if (usedIds.size > 0) {
    // Only bump texturesVersion if new textures were actually loaded (not already cached).
    // Check _loadPromise — if it exists, the texture was already loading/loaded before this call.
    const catalog = playerState.textureCatalog;
    const hadNew = [...usedIds].some(id => {
      const entry = catalog?.textures?.[id];
      return entry && !entry._loadPromise;
    });
    await ensureTexturesLoaded(usedIds);
    if (hadNew) {
      playerState.texturesVersion++;
    }
  }
}

// ── Asset convergence ───────────────────────────────────────────────────────
// Both catalogs + dungeon must be available before we can load textures and
// build the initial cache.  Two async paths race: catalog loading (DOMContentLoaded)
// and session init (WebSocket).  This function is called from both; it only
// proceeds when all prerequisites are met, and only runs once.
let _initDone = false;

async function tryInitialBuild() {
  if (_initDone) return;
  if (!playerState.dungeon || !playerState.propCatalog || !playerState.textureCatalog) return;
  _initDone = true;

  await loadMapTextures();
  markAssetsReady();
  invalidateFullMapCache();
  playerCanvas.requestRender();
}

// ── Range tool ──────────────────────────────────────────────────────────────

function initRangeTool() {
  playerRangeTool = new RangeTool(
    (msg) => {
      if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
    },
    () => ({
      gridSize: playerState.dungeon?.metadata?.gridSize || 5,
      numRows: playerState.dungeon?.cells?.length || 0,
      numCols: playerState.dungeon?.cells?.[0]?.length || 0,
    }),
    () => playerCanvas.requestRender(),
  );
  playerCanvas.setActiveTool(playerRangeTool);
}

// ── Message handling ────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case 'session:init':
      onSessionInit(msg);
      break;

    case 'viewport:update':
      playerCanvas.applyDMViewport(msg.panX, msg.panY, msg.zoom, msg.canvasWidth, msg.canvasHeight);
      break;

    case 'fog:reveal':
      onFogReveal(msg);
      break;

    case 'fog:conceal':
      onFogConceal(msg);
      break;

    case 'fog:reset':
      onFogReset();
      break;

    case 'door:open':
      onDoorOpen(msg);
      break;

    case 'stairs:open':
      onStairsOpen(msg);
      break;

    case 'dungeon:update':
      onDungeonUpdate(msg);
      break;

    case 'range:highlight':
      if (playerRangeTool) {
        playerRangeTool.applyRemoteHighlight(msg);
        playerCanvas.requestRender();
      }
      break;

    case 'session:end':
      onSessionEnd();
      break;
  }
}

function onSessionInit(msg) {
  // Clear all old caches before loading the new map
  playerCanvas.clearAll();

  playerState.dungeon = msg.dungeon;
  playerState.resolvedTheme = msg.resolvedTheme || null;
  playerState.renderQuality = msg.renderQuality || 20;

  // Restore revealed cells
  playerState.revealedCells = new Set(msg.revealedCells || []);
  playerState.openedDoors = msg.openedDoors || [];
  playerState.openedStairs = msg.openedStairs || [];

  // Apply DM viewport (snap immediately on init — no interpolation)
  if (msg.viewport) {
    playerCanvas.applyDMViewport(
      msg.viewport.panX, msg.viewport.panY, msg.viewport.zoom,
      msg.viewport.canvasWidth, msg.viewport.canvasHeight
    );
    playerCanvas.snapToDMViewport();
  }

  // Reset for a fresh initial build (handles reconnects / new sessions)
  _initDone = false;

  // Invalidate the full-map cache — the actual build is deferred until assets are ready
  invalidateFullMapCache();

  // Try to kick off the initial build (no-op if catalogs aren't loaded yet —
  // the DOMContentLoaded path will call tryInitialBuild again when they are)
  tryInitialBuild();

  // Show range toolbar and init tool
  const toolbar = document.getElementById('player-toolbar');
  if (toolbar) toolbar.style.display = 'flex';
  if (!playerRangeTool) initRangeTool();

  // Populate distance dropdown based on gridSize
  const distSelect = document.getElementById('player-range-distance');
  if (distSelect) {
    const gs = playerState.dungeon?.metadata?.gridSize || 5;
    distSelect.innerHTML = '<option value="0">Auto</option>';
    for (let ft = gs; ft <= 200; ft += gs) {
      const opt = document.createElement('option');
      opt.value = ft;
      opt.textContent = `${ft} ft`;
      distSelect.appendChild(opt);
    }
  }

  playerCanvas.requestRender();
}

function onFogReveal(msg) {
  for (const key of msg.cells) {
    playerState.revealedCells.add(key);
  }
  // Incrementally punch holes in the existing fog mask — no full rebuild
  revealFogCells(msg.cells);
  playerCanvas.requestRender();
}

function onFogConceal(msg) {
  for (const key of msg.cells) {
    playerState.revealedCells.delete(key);
  }
  // Incrementally paint black back over concealed cells — no full rebuild
  concealFogCells(msg.cells);
  playerCanvas.requestRender();
}

function onFogReset() {
  playerState.revealedCells.clear();
  playerState.openedDoors = [];
  playerState.openedStairs = [];
  resetFogLayers();
  playerCanvas.requestRender();
}

function onDoorOpen(msg) {
  playerState.openedDoors.push({
    row: msg.row,
    col: msg.col,
    dir: msg.dir,
    wasSecret: msg.wasSecret,
  });
  if (msg.wasSecret) {
    // Patch cached cells to convert 's' → 'd' before the partial rebuild
    patchOpenedDoor(msg.row, msg.col, msg.dir);
    // Secret door rendered as wall → now a door — rebuild the affected region only
    const OFFSETS = { north: [-1, 0], south: [1, 0], east: [0, 1], west: [0, -1] };
    const [dr, dc] = OFFSETS[msg.dir] || [0, 0];
    const rows = [msg.row, msg.row + dr];
    const cols = [msg.col, msg.col + dc];
    invalidateFullMapCache({
      minRow: Math.min(...rows),
      maxRow: Math.max(...rows),
      minCol: Math.min(...cols),
      maxCol: Math.max(...cols),
    }, { structural: true });
  }
  // Normal doors don't change the rendered content — player already sees them as doors
  playerCanvas.requestRender();
}

function onStairsOpen(msg) {
  for (const id of msg.stairIds) {
    playerState.openedStairs.push(id);
  }
  // Stair link labels changed — rebuild only the affected stair regions
  const stairs = playerState.dungeon?.metadata?.stairs || [];
  let region = null;
  for (const id of msg.stairIds) {
    const stair = stairs.find(s => s.id === id);
    if (!stair?.points) continue;
    for (const [r, c] of stair.points) {
      if (!region) {
        region = { minRow: r, maxRow: r, minCol: c, maxCol: c };
      } else {
        region.minRow = Math.min(region.minRow, r);
        region.maxRow = Math.max(region.maxRow, r);
        region.minCol = Math.min(region.minCol, c);
        region.maxCol = Math.max(region.maxCol, c);
      }
    }
  }
  invalidateFullMapCache(region);
  playerCanvas.requestRender();
}

function onDungeonUpdate(msg) {
  if (!playerState.dungeon) return;
  playerState.dungeon.cells = msg.cells;
  playerState.dungeon.metadata = msg.metadata;
  // Only replace resolvedTheme when it actually changed (preserves reference for render caches)
  if (msg.changeHints?.themeChanged && msg.resolvedTheme) {
    playerState.resolvedTheme = msg.resolvedTheme;
  } else if (!playerState.resolvedTheme && msg.resolvedTheme) {
    playerState.resolvedTheme = msg.resolvedTheme;
  }

  const hints = msg.changeHints;

  // Route to the cheapest rebuild based on what changed
  if (!hints || hints.gridResized) {
    // No hints (legacy) or grid resized — full rebuild with texture loading
    loadMapTextures().then(() => {
      invalidateFullMapCache();
      playerCanvas.requestRender();
    });
  } else if (hints.dirtyRegion && !hints.themeChanged) {
    // Partial cell change — use dirty region for targeted rebuild
    const structural = !!hints.lightingChanged;
    loadMapTextures().then(() => {
      invalidateFullMapCache(hints.dirtyRegion, { structural });
      playerCanvas.requestRender();
    });
  } else if (hints.propsChanged && !hints.themeChanged && !hints.dirtyRegion) {
    // Props-only change (may include lighting from prop lights) — needs cells rebuild for props layer
    // but preserves cached cells array so fluid/blend caches stay valid
    invalidatePropsChange();
    playerCanvas.requestRender();
  } else if (hints.lightingChanged && !hints.themeChanged && !hints.dirtyRegion && !hints.propsChanged) {
    // Lighting-only change — composite rebuild only (cells layer stays cached)
    invalidateLightingOnly();
    playerCanvas.requestRender();
  } else if (hints.themeChanged && !hints.dirtyRegion) {
    // Theme change — clear all caches and do a full rebuild (theme colors affect every layer)
    playerCanvas.clearAll();
    invalidateFullMapCache();
    playerCanvas.requestRender();
  } else {
    // Multiple change types or theme+cells — full rebuild
    loadMapTextures().then(() => {
      invalidateFullMapCache(hints.dirtyRegion || null);
      playerCanvas.requestRender();
    });
  }

  playerCanvas.requestRender();
}

function onSessionEnd() {
  setStatus('disconnected', 'Session ended');
  statusEl()?.classList.remove('hidden');
  const toolbar = document.getElementById('player-toolbar');
  if (toolbar) toolbar.style.display = 'none';

  // Clear all state and caches
  playerState.dungeon = null;
  playerState.resolvedTheme = null;
  playerState.revealedCells = new Set();
  playerState.openedDoors = [];
  playerState.openedStairs = [];
  playerCanvas.clearAll();
  _initDone = false;
}

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('player-canvas');
  playerCanvas.init(canvas);

  // Resync button
  const btn = resyncBtn();
  if (btn) btn.addEventListener('click', () => playerCanvas.resyncToDM());

  // Range shape sub-tool switching (player toolbar)
  document.querySelectorAll('#player-toolbar [data-range-shape]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#player-toolbar [data-range-shape]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (playerRangeTool) playerRangeTool.setSubTool(btn.dataset.rangeShape);
    });
  });

  // Range distance dropdown (player toolbar)
  const playerDistSelect = document.getElementById('player-range-distance');
  if (playerDistSelect) {
    playerDistSelect.addEventListener('change', () => {
      if (playerRangeTool) playerRangeTool.setFixedRange(parseInt(playerDistSelect.value, 10));
    });
  }

  // Load catalogs, then try the initial build (no-op if session init
  // hasn't arrived yet — onSessionInit will call tryInitialBuild again)
  const propCatalogPromise = loadPropCatalog().then(catalog => {
    playerState.propCatalog = catalog;
    return catalog;
  }).catch(err => { console.warn('Player: failed to load prop catalog:', err); return null; });

  const textureCatalogPromise = loadTextureCatalog().then(catalog => {
    playerState.textureCatalog = catalog;
    return catalog;
  }).catch(err => { console.warn('Player: failed to load texture catalog:', err); return null; });

  Promise.all([propCatalogPromise, textureCatalogPromise]).then(() => tryInitialBuild());

  // Connect to DM
  connect();
});
