// Player view entry point: WebSocket connection, catalog loading, canvas init.

import playerState from './player-state.js';
import * as playerCanvas from './player-canvas.js';
import { loadPropCatalog, loadTextureCatalog, collectTextureIds, ensureTexturesLoaded, RangeTool } from '../editor/js/index.js';

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
  playerState.dungeon = msg.dungeon;
  playerState.resolvedTheme = msg.resolvedTheme || null;

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

  // Load textures used in this map (floor + props)
  if (playerState.textureCatalog) {
    const usedIds = collectTextureIds(playerState.dungeon.cells);
    if (playerState.propCatalog?.props) {
      for (const row of playerState.dungeon.cells) {
        if (!row) continue;
        for (const cell of row) {
          if (!cell?.prop) continue;
          const propDef = playerState.propCatalog.props[cell.prop.type];
          if (propDef?.textures) {
            for (const id of propDef.textures) usedIds.add(id);
          }
        }
      }
    }
    if (usedIds.size > 0) {
      ensureTexturesLoaded(usedIds).then(() => { playerState.texturesVersion++; playerCanvas.requestRender(); });
    }
  }

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
  playerCanvas.requestRender();
}

function onDoorOpen(msg) {
  playerState.openedDoors.push({
    row: msg.row,
    col: msg.col,
    dir: msg.dir,
    wasSecret: msg.wasSecret,
  });
  playerCanvas.requestRender();
}

function onStairsOpen(msg) {
  for (const id of msg.stairIds) {
    playerState.openedStairs.push(id);
  }
  playerCanvas.requestRender();
}

function onDungeonUpdate(msg) {
  if (!playerState.dungeon) return;
  playerState.dungeon.cells = msg.cells;
  playerState.dungeon.metadata = msg.metadata;
  if (msg.resolvedTheme) playerState.resolvedTheme = msg.resolvedTheme;

  // Ensure new textures are loaded (floor + props)
  if (playerState.textureCatalog) {
    const usedIds = collectTextureIds(msg.cells);
    if (playerState.propCatalog?.props) {
      for (const row of msg.cells) {
        if (!row) continue;
        for (const cell of row) {
          if (!cell?.prop) continue;
          const propDef = playerState.propCatalog.props[cell.prop.type];
          if (propDef?.textures) {
            for (const id of propDef.textures) usedIds.add(id);
          }
        }
      }
    }
    if (usedIds.size > 0) {
      ensureTexturesLoaded(usedIds).then(() => { playerState.texturesVersion++; playerCanvas.requestRender(); });
    }
  }

  playerCanvas.requestRender();
}

function onSessionEnd() {
  setStatus('disconnected', 'Session ended');
  statusEl()?.classList.remove('hidden');
  const toolbar = document.getElementById('player-toolbar');
  if (toolbar) toolbar.style.display = 'none';
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

  // Load catalogs (async, non-blocking)
  const propCatalogPromise = loadPropCatalog().then(catalog => {
    playerState.propCatalog = catalog;
    playerCanvas.requestRender();
    return catalog;
  }).catch(err => { console.warn('Player: failed to load prop catalog:', err); return null; });

  const textureCatalogPromise = loadTextureCatalog().then(catalog => {
    playerState.textureCatalog = catalog;
    playerCanvas.requestRender();
    return catalog;
  }).catch(err => { console.warn('Player: failed to load texture catalog:', err); return null; });

  // After both catalogs are ready, preload textures for any dungeon already received (floor + props)
  Promise.all([propCatalogPromise, textureCatalogPromise]).then(([propCatalog, textureCatalog]) => {
    if (!textureCatalog || !playerState.dungeon) return;
    const usedIds = collectTextureIds(playerState.dungeon.cells);
    if (propCatalog?.props) {
      for (const row of playerState.dungeon.cells) {
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
      ensureTexturesLoaded(usedIds).then(() => { playerState.texturesVersion++; playerCanvas.requestRender(); });
    }
  });

  // Connect to DM
  connect();
});
