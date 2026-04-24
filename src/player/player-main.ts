// Player view entry point: WebSocket connection, catalog loading, canvas init.

import playerState from './player-state.js';
import * as playerCanvas from './player-canvas.js';
import {
  invalidateFullMapCache,
  invalidateLightingOnly,
  invalidatePropsChange,
  patchOpenedDoor,
  revealFogCells,
  concealFogCells,
  resetFogLayers,
  markAssetsReady,
} from './player-canvas.js';
import {
  loadPropCatalog,
  ensurePropHitboxesForMap,
  loadTextureCatalog,
  collectTextureIds,
  ensureTexturesLoaded,
  RangeTool,
} from '../editor/js/index.js';
import { BRIDGE_TEXTURE_IDS, markWeatherFullRebuild } from '../render/index.js';
import { CARDINAL_OFFSETS } from '../util/index.js';
import type { Dungeon, PropDefinition, Theme, VisibleBounds } from '../types.js';

// ── WebSocket message types ────────────────────────────────────────────────

interface SessionInitMessage {
  type: 'session:init';
  dungeon: Dungeon;
  resolvedTheme?: Theme | null;
  renderQuality?: number;
  revealedCells?: string[];
  openedDoors?: { row: number; col: number; dir: string; wasSecret?: boolean }[];
  openedStairs?: number[];
  viewport?: {
    panX: number;
    panY: number;
    zoom: number;
    canvasWidth: number;
    canvasHeight: number;
  };
}

interface ViewportUpdateMessage {
  type: 'viewport:update';
  panX: number;
  panY: number;
  zoom: number;
  canvasWidth: number;
  canvasHeight: number;
}

interface FogRevealMessage {
  type: 'fog:reveal';
  cells: string[];
}

interface FogConcealMessage {
  type: 'fog:conceal';
  cells: string[];
}

interface FogResetMessage {
  type: 'fog:reset';
}

interface DoorOpenMessage {
  type: 'door:open';
  row: number;
  col: number;
  dir: string;
  wasSecret: boolean;
}

interface StairsOpenMessage {
  type: 'stairs:open';
  stairIds: number[];
}

interface DungeonUpdateMessage {
  type: 'dungeon:update';
  cells: Dungeon['cells'];
  metadata: Dungeon['metadata'];
  resolvedTheme?: Theme | null;
  changeHints?: {
    themeChanged?: boolean;
    gridResized?: boolean;
    lightingChanged?: boolean;
    propsChanged?: boolean;
    dirtyRegion?: VisibleBounds | null;
  };
}

interface RangeHighlightMessage {
  type: 'range:highlight';
  cells: { row: number; col: number }[];
  distanceFt: number;
  subTool: string;
  [key: string]: unknown;
}

interface SessionEndMessage {
  type: 'session:end';
}

type WSMessage =
  | SessionInitMessage
  | ViewportUpdateMessage
  | FogRevealMessage
  | FogConcealMessage
  | FogResetMessage
  | DoorOpenMessage
  | StairsOpenMessage
  | DungeonUpdateMessage
  | RangeHighlightMessage
  | SessionEndMessage;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let playerRangeTool: InstanceType<typeof RangeTool> | null = null;
const statusEl = (): HTMLElement | null => document.getElementById('connection-status')!;
const resyncBtn = (): HTMLElement | null => document.getElementById('resync-btn')!;

// ── Session auth ───────────────────────────────────────────────────────────

let playerToken: string | null = null;

async function checkSessionAndConnect(): Promise<void> {
  try {
    const res = await fetch('/api/session/status');
    const status = (await res.json()) as { active: boolean; passwordRequired: boolean };
    if (status.active && status.passwordRequired) {
      showPasswordPrompt();
      return;
    }
  } catch {
    // Server unreachable — try connecting anyway (will reconnect on failure)
  }
  connect();
}

function showPasswordPrompt(): void {
  const overlay = document.getElementById('password-overlay');
  const input = document.getElementById('password-input') as HTMLInputElement | null;
  const submit = document.getElementById('password-submit');
  const errorEl = document.getElementById('password-error');
  if (!overlay || !input || !submit) {
    connect();
    return;
  }

  overlay.classList.remove('hidden');

  const doSubmit = async () => {
    const password = input.value;
    if (!password) return;
    submit.textContent = 'Joining…';
    (submit as HTMLButtonElement).disabled = true;
    try {
      const res = await fetch('/api/session/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error: string };
        if (errorEl) {
          errorEl.textContent = data.error || 'Authentication failed';
          errorEl.classList.remove('hidden');
        }
        submit.textContent = 'Join';
        (submit as HTMLButtonElement).disabled = false;
        return;
      }
      const data = (await res.json()) as { token: string };
      playerToken = data.token;
      overlay.classList.add('hidden');
      connect();
    } catch {
      if (errorEl) {
        errorEl.textContent = 'Server unreachable';
        errorEl.classList.remove('hidden');
      }
      submit.textContent = 'Join';
      (submit as HTMLButtonElement).disabled = false;
    }
  };

  submit.addEventListener('click', () => {
    void doSubmit();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doSubmit();
  });
  input.focus();
}

// ── WebSocket ───────────────────────────────────────────────────────────────

function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenParam = playerToken ? `&token=${playerToken}` : '';
  const url = `${protocol}//${location.host}/ws?role=player${tokenParam}`;

  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    playerState.connected = true;
    setStatus('connected', 'Connected');
    setTimeout(() => statusEl()?.classList.add('hidden'), 2000);
  });

  ws.addEventListener('close', (e: CloseEvent) => {
    playerState.connected = false;
    if (e.code === 4002) {
      // Password required — show prompt instead of reconnecting
      showPasswordPrompt();
      return;
    }
    setStatus('disconnected', 'Disconnected — reconnecting…');
    statusEl()?.classList.remove('hidden');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    ws?.close();
  });

  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: WSMessage;
    try {
      msg = JSON.parse(e.data) as WSMessage;
    } catch {
      console.warn('[player] malformed WebSocket message', String(e.data).slice(0, 120));
      return;
    }
    handleMessage(msg);
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function setStatus(cls: string, text: string): void {
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
async function loadMapTextures(): Promise<void> {
  if (!playerState.textureCatalog || !playerState.dungeon) return;
  const usedIds = collectTextureIds(playerState.dungeon.cells);
  const metadata = playerState.dungeon.metadata as Record<string, unknown>;
  if (playerState.propCatalog?.props && metadata.props) {
    for (const op of metadata.props as Array<{ type: string }>) {
      const propDef = playerState.propCatalog.props[op.type] as PropDefinition | undefined;
      if (propDef?.textures) {
        for (const id of propDef.textures) usedIds.add(id);
      }
    }
  }
  // Include bridge textures (canonical IDs in render/constants.ts)
  if (playerState.dungeon.metadata.bridges.length) {
    const bridgeTexLookup = BRIDGE_TEXTURE_IDS as unknown as Record<string, string | undefined>;
    for (const b of playerState.dungeon.metadata.bridges) {
      const texId = bridgeTexLookup[b.type] ?? BRIDGE_TEXTURE_IDS.wood;
      usedIds.add(texId);
    }
  }
  if (usedIds.size > 0) {
    // Only bump texturesVersion if new textures were actually loaded (not already cached).
    // Check _loadPromise — if it exists, the texture was already loading/loaded before this call.
    const catalog = playerState.textureCatalog as Record<string, unknown>;
    const textures = catalog.textures as Record<string, Record<string, unknown>> | undefined;
    const hadNew = [...usedIds].some((id) => {
      const entry = textures?.[id];
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
let _initDone: boolean = false;

async function tryInitialBuild(): Promise<void> {
  if (_initDone) return;
  if (!playerState.dungeon || !playerState.propCatalog || !playerState.textureCatalog) return;
  _initDone = true;

  // Fresh PropDefinitions have no materialized hitboxes. The lighting engine
  // reads hitbox polygons to compute prop shadow geometry — without this,
  // props on the map don't block light correctly.
  ensurePropHitboxesForMap(playerState.dungeon);

  await loadMapTextures();
  markAssetsReady();
  invalidateFullMapCache();
  playerCanvas.requestRender();
}

// ── Range tool ──────────────────────────────────────────────────────────────

function initRangeTool(): void {
  playerRangeTool = new RangeTool(
    (msg: Record<string, unknown>) => {
      if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
    },
    () => ({
      gridSize: playerState.dungeon?.metadata.gridSize ?? 5,
      numRows: playerState.dungeon?.cells.length ?? 0,
      numCols: playerState.dungeon?.cells[0]?.length ?? 0,
    }),
    () => playerCanvas.requestRender(),
  );
  playerCanvas.setActiveTool(playerRangeTool as Parameters<typeof playerCanvas.setActiveTool>[0]);
}

// ── Message handling ────────────────────────────────────────────────────────

function handleMessage(msg: WSMessage): void {
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

function onSessionInit(msg: SessionInitMessage): void {
  // Clear all old caches before loading the new map
  playerCanvas.clearAll();
  // The weather haze cache is module-scoped in render-weather; clear it so
  // stale haze from a prior session can't bleed into the new map.
  markWeatherFullRebuild();

  playerState.dungeon = msg.dungeon;
  playerState.resolvedTheme = msg.resolvedTheme ?? null;
  playerState.renderQuality = msg.renderQuality ?? 20;

  // Restore revealed cells
  playerState.revealedCells = new Set(msg.revealedCells ?? []);
  playerState.openedDoors = msg.openedDoors ?? [];
  playerState.openedStairs = msg.openedStairs ?? [];

  // Apply DM viewport (snap immediately on init — no interpolation)
  if (msg.viewport) {
    playerCanvas.applyDMViewport(
      msg.viewport.panX,
      msg.viewport.panY,
      msg.viewport.zoom,
      msg.viewport.canvasWidth,
      msg.viewport.canvasHeight,
    );
    playerCanvas.snapToDMViewport();
  }

  // Reset for a fresh initial build (handles reconnects / new sessions)
  _initDone = false;

  // Invalidate the full-map cache — the actual build is deferred until assets are ready
  invalidateFullMapCache();

  // Try to kick off the initial build (no-op if catalogs aren't loaded yet —
  // the DOMContentLoaded path will call tryInitialBuild again when they are)
  void tryInitialBuild();

  // Show range toolbar and init tool
  const toolbar = document.getElementById('player-toolbar')!;
  toolbar.style.display = 'flex';
  if (!playerRangeTool) initRangeTool();

  // Populate distance dropdown based on gridSize
  const distSelect = document.getElementById('player-range-distance')! as HTMLSelectElement | null;
  if (distSelect) {
    const gs = playerState.dungeon.metadata.gridSize || 5;
    distSelect.innerHTML = '<option value="0">Auto</option>';
    for (let ft = gs; ft <= 200; ft += gs) {
      const opt = document.createElement('option');
      opt.value = String(ft);
      opt.textContent = `${ft} ft`;
      distSelect.appendChild(opt);
    }
  }

  playerCanvas.requestRender();
}

function onFogReveal(msg: FogRevealMessage): void {
  for (const key of msg.cells) {
    playerState.revealedCells.add(key);
  }
  // Incrementally punch holes in the existing fog mask — no full rebuild
  revealFogCells(msg.cells);
  playerCanvas.requestRender();
}

function onFogConceal(msg: FogConcealMessage): void {
  for (const key of msg.cells) {
    playerState.revealedCells.delete(key);
  }
  // Incrementally paint black back over concealed cells — no full rebuild
  concealFogCells(msg.cells);
  playerCanvas.requestRender();
}

function onFogReset(): void {
  playerState.revealedCells.clear();
  playerState.openedDoors = [];
  playerState.openedStairs = [];
  resetFogLayers();
  playerCanvas.requestRender();
}

function onDoorOpen(msg: DoorOpenMessage): void {
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
    const offset = (CARDINAL_OFFSETS as Record<string, readonly [number, number] | undefined>)[msg.dir];
    const [dr, dc] = offset ?? [0, 0];
    const rows = [msg.row, msg.row + dr];
    const cols = [msg.col, msg.col + dc];
    invalidateFullMapCache(
      {
        minRow: Math.min(...rows),
        maxRow: Math.max(...rows),
        minCol: Math.min(...cols),
        maxCol: Math.max(...cols),
      },
      { structural: true },
    );
  }
  // Normal doors don't change the rendered content — player already sees them as doors
  playerCanvas.requestRender();
}

function onStairsOpen(msg: StairsOpenMessage): void {
  for (const id of msg.stairIds) {
    playerState.openedStairs.push(id);
  }
  // Stair link labels changed — rebuild only the affected stair regions
  const stairs = playerState.dungeon?.metadata.stairs ?? [];
  let region: VisibleBounds | null = null;
  for (const id of msg.stairIds) {
    const stair = stairs.find((s) => s.id === id);
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

function onDungeonUpdate(msg: DungeonUpdateMessage): void {
  if (!playerState.dungeon) return;
  playerState.dungeon.cells = msg.cells;
  playerState.dungeon.metadata = msg.metadata;
  // The DM may have edited weather groups or cell assignments; the weather
  // cache has no visibility into either, so force a full rebuild. Cheap — it
  // just flips a flag; the actual redraw runs on the next updateWeatherCache.
  markWeatherFullRebuild();
  // Idempotent: materializes hitboxes for any newly-introduced prop types
  // so lighting shadows pick them up on the next render.
  ensurePropHitboxesForMap(playerState.dungeon);
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
    void loadMapTextures().then(() => {
      invalidateFullMapCache();
      playerCanvas.requestRender();
    });
  } else if (hints.dirtyRegion && !hints.themeChanged) {
    // Partial cell change — use dirty region for targeted rebuild
    const structural = !!hints.lightingChanged;
    void loadMapTextures().then(() => {
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
    void loadMapTextures().then(() => {
      invalidateFullMapCache(hints.dirtyRegion ?? null);
      playerCanvas.requestRender();
    });
  }

  playerCanvas.requestRender();
}

function onSessionEnd(): void {
  setStatus('disconnected', 'Session ended');
  statusEl()?.classList.remove('hidden');
  const toolbar = document.getElementById('player-toolbar')!;
  toolbar.style.display = 'none';

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

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('player-canvas')! as HTMLCanvasElement;
  playerCanvas.init(canvas);

  // Resync button
  const btn = resyncBtn();
  if (btn) btn.addEventListener('click', () => playerCanvas.resyncToDM());

  // Range shape sub-tool switching (player toolbar)
  document.querySelectorAll<HTMLElement>('#player-toolbar [data-range-shape]').forEach((shapeBtn) => {
    shapeBtn.addEventListener('click', () => {
      document
        .querySelectorAll<HTMLElement>('#player-toolbar [data-range-shape]')
        .forEach((b) => b.classList.remove('active'));
      shapeBtn.classList.add('active');
      if (playerRangeTool) playerRangeTool.setSubTool(shapeBtn.dataset.rangeShape!);
    });
  });

  // Range distance dropdown (player toolbar)
  const playerDistSelect = document.getElementById('player-range-distance')! as HTMLSelectElement | null;
  if (playerDistSelect) {
    playerDistSelect.addEventListener('change', () => {
      if (playerRangeTool) playerRangeTool.setFixedRange(parseInt(playerDistSelect.value, 10));
    });
  }

  // Load catalogs, then try the initial build (no-op if session init
  // hasn't arrived yet — onSessionInit will call tryInitialBuild again)
  const propCatalogPromise = loadPropCatalog()
    .then((catalog: unknown) => {
      playerState.propCatalog = catalog as typeof playerState.propCatalog;
      return catalog;
    })
    .catch((err: unknown) => {
      console.warn('Player: failed to load prop catalog:', err);
      return null;
    });

  const textureCatalogPromise = loadTextureCatalog()
    .then((catalog: unknown) => {
      playerState.textureCatalog = catalog as typeof playerState.textureCatalog;
      return catalog;
    })
    .catch((err: unknown) => {
      console.warn('Player: failed to load texture catalog:', err);
      return null;
    });

  void Promise.all([propCatalogPromise, textureCatalogPromise]).then(() => tryInitialBuild());

  // Check for password-protected session, then connect to DM
  void checkSessionAndConnect();
});
