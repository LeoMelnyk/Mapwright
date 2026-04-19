// DM session broadcast helpers: viewport/dungeon broadcast with debouncing, baseline snapshots.

import { sessionState, send } from './dm-session-state.js';
import state, { subscribe, getTheme } from './state.js';
import { getCanvasSize } from './canvas-view.js';
import { getEditorSettings } from './editor-settings.js';
import {
  getContentVersion,
  consumeBroadcastDirtyRegion,
  getLightingVersion,
  getPropsVersion,
} from '../../render/index.js';

// ── Baseline tracking ──────────────────────────────────────────────────────

let _lastBroadcastContentVersion = 0;
let _lastBroadcastLightingVersion = 0;
let _lastBroadcastThemeJSON: string | null = null;
let _lastBroadcastPropsVersion = 0;
let _lastBroadcastGridRows = 0;
let _lastBroadcastGridCols = 0;

export function snapshotBroadcastBaseline() {
  _lastBroadcastThemeJSON = JSON.stringify(getTheme());
  _lastBroadcastLightingVersion = getLightingVersion();
  _lastBroadcastPropsVersion = getPropsVersion();
  _lastBroadcastGridRows = state.dungeon.cells.length;
  _lastBroadcastGridCols = state.dungeon.cells[0]?.length ?? 0;
  _lastBroadcastContentVersion = getContentVersion();
  consumeBroadcastDirtyRegion(); // clear any accumulated region
}

export function broadcastInit() {
  snapshotBroadcastBaseline();
  const { width, height } = getCanvasSize();
  send({
    type: 'session:init',
    dungeon: state.dungeon,
    resolvedTheme: getTheme(),
    renderQuality: getEditorSettings().renderQuality ?? 20,
    revealedCells: [...sessionState.revealedCells],
    openedDoors: sessionState.openedDoors,
    openedStairs: sessionState.openedStairs,
    viewport: {
      panX: state.panX,
      panY: state.panY,
      zoom: state.zoom,
      canvasWidth: width,
      canvasHeight: height,
    },
  });
}

// ── Viewport broadcast (throttled via rAF) ──────────────────────────────────

let viewportDirty = false;
let lastPanX = 0,
  lastPanY = 0,
  lastZoom = 0;

export function startViewportBroadcast() {
  subscribe(() => {
    if (!sessionState.active) return;
    if (state.panX === lastPanX && state.panY === lastPanY && state.zoom === lastZoom) return;
    lastPanX = state.panX;
    lastPanY = state.panY;
    lastZoom = state.zoom;

    if (!viewportDirty) {
      viewportDirty = true;
      requestAnimationFrame(() => {
        viewportDirty = false;
        const { width, height } = getCanvasSize();
        send({
          type: 'viewport:update',
          panX: state.panX,
          panY: state.panY,
          zoom: state.zoom,
          canvasWidth: width,
          canvasHeight: height,
        });
      });
    }
  }, 'dm-viewport');
}

// ── Dungeon broadcast (debounced 1s after structural edits) ─────────────────
// Uses content version from the render pipeline — immune to pan/zoom/resize
// which set state.dirty but don't change dungeon content.

let dungeonTimer: ReturnType<typeof setTimeout> | null = null;

export function startDungeonBroadcast() {
  subscribe(() => {
    if (!sessionState.active) return;
    const cv = getContentVersion();
    const lv = getLightingVersion();
    const pv = getPropsVersion();
    if (
      cv === _lastBroadcastContentVersion &&
      lv === _lastBroadcastLightingVersion &&
      pv === _lastBroadcastPropsVersion
    )
      return; // no content/lighting/prop change
    _lastBroadcastContentVersion = cv;
    if (dungeonTimer) clearTimeout(dungeonTimer);
    dungeonTimer = setTimeout(() => {
      // Compute change hints for the player
      const resolvedTheme = getTheme();
      const themeJSON = JSON.stringify(resolvedTheme);
      const lvNow = getLightingVersion();
      const pvNow = getPropsVersion();
      const numRows = state.dungeon.cells.length;
      const numCols = state.dungeon.cells[0]?.length ?? 0;

      const changeHints = {
        dirtyRegion: consumeBroadcastDirtyRegion(),
        themeChanged: themeJSON !== _lastBroadcastThemeJSON,
        lightingChanged: lvNow !== _lastBroadcastLightingVersion,
        propsChanged: pvNow !== _lastBroadcastPropsVersion,
        gridResized: numRows !== _lastBroadcastGridRows || numCols !== _lastBroadcastGridCols,
      };

      _lastBroadcastThemeJSON = themeJSON;
      _lastBroadcastLightingVersion = lvNow;
      _lastBroadcastPropsVersion = pvNow;
      _lastBroadcastGridRows = numRows;
      _lastBroadcastGridCols = numCols;

      send({
        type: 'dungeon:update',
        cells: state.dungeon.cells,
        metadata: state.dungeon.metadata,
        resolvedTheme,
        changeHints,
      });
    }, 1000);
  }, 'dm-dungeon');
}
