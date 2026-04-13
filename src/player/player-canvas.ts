// Player view canvas: render loop, pan/zoom, fog overlay, tool interaction.
//
// Barrel module — delegates to sub-modules:
//   player-canvas-state.ts   — shared mutable state + helper accessors
//   player-canvas-fog.ts     — fog overlay builder, diagonal fog helpers
//   player-canvas-layers.ts  — shading, hatching, walls overlay, fog-edge composites
//   player-canvas-cache.ts   — full-map cache builder, invalidation, clearAll
//   player-canvas-render.ts  — render loop, animation, diagnostics
//   player-canvas-viewport.ts — viewport lerp, DM viewport sync
//   player-canvas-input.ts   — mouse/touch/wheel handlers

import { S, getTransform, type ToolLike } from './player-canvas-state.js';
import { revealFogCells as _revealFogCells, concealFogCells as _concealFogCells } from './player-canvas-fog.js';
import { revealWallsCells, rebuildWallsLayer } from './player-canvas-layers.js';
import {
  invalidateFullMapCache,
  invalidateThemeChange,
  invalidatePropsChange,
  invalidateLightingOnly,
  patchOpenedDoor,
  clearAll,
  invalidateFogOverlay,
  resetFogLayers,
  markAssetsReady,
  setRequestRender as setCacheRequestRender,
} from './player-canvas-cache.js';
import { requestRender } from './player-canvas-render.js';
import {
  applyDMViewport,
  snapToDMViewport,
  resyncToDM,
  setRequestRender as setViewportRequestRender,
} from './player-canvas-viewport.js';
import {
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onMouseLeave,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onWheel,
  setRequestRender as setInputRequestRender,
} from './player-canvas-input.js';

// Wire up requestRender into sub-modules that need it (breaks circular deps)
setCacheRequestRender(requestRender);
setViewportRequestRender(requestRender);
setInputRequestRender(requestRender);

// ── Wrappers that wire callbacks to avoid circular imports between fog ↔ layers ──

function revealFogCells(cellKeys: string[]): void {
  _revealFogCells(cellKeys, revealWallsCells);
}

function concealFogCells(cellKeys: string[]): void {
  _concealFogCells(cellKeys, rebuildWallsLayer);
}

// ── init & setActiveTool (kept in barrel) ───────────────────────────────────

export function setActiveTool(tool: ToolLike): void {
  if (S.activeTool?.onDeactivate) S.activeTool.onDeactivate();
  S.activeTool = tool;
  if (S.activeTool.onActivate) S.activeTool.onActivate();
}

function resizeCanvas(): void {
  if (!S.canvas) return;
  S.canvas.width = window.innerWidth;
  S.canvas.height = window.innerHeight;
  requestRender();
}

export function init(canvasEl: HTMLCanvasElement): void {
  S.canvas = canvasEl;
  S.ctx = S.canvas.getContext('2d')!;
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Toggle diagnostics overlay with 'D' key
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'd' || e.key === 'D') {
      S._diagEnabled = !S._diagEnabled;
      requestRender();
    }
  });

  // Mouse events for player pan/zoom + tool interaction
  S.canvas.addEventListener('mousedown', onMouseDown);
  S.canvas.addEventListener('mousemove', onMouseMove);
  S.canvas.addEventListener('mouseup', onMouseUp);
  S.canvas.addEventListener('mouseleave', onMouseLeave);
  S.canvas.addEventListener('wheel', onWheel, { passive: false });
  S.canvas.addEventListener('contextmenu', (e: Event) => e.preventDefault());

  // Touch events for mobile/tablet support
  S.canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  S.canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  S.canvas.addEventListener('touchend', onTouchEnd);
  S.canvas.addEventListener('touchcancel', onTouchEnd);

  requestRender();
}

// ── Re-exports ──────────────────────────────────────────────────────────────
// Everything that player-main.ts (the only consumer) needs.

export {
  // State helpers
  getTransform,

  // Render
  requestRender,

  // Cache / invalidation
  invalidateFullMapCache,
  invalidateThemeChange,
  invalidatePropsChange,
  invalidateLightingOnly,
  patchOpenedDoor,
  clearAll,
  invalidateFogOverlay,
  resetFogLayers,
  markAssetsReady,

  // Fog
  revealFogCells,
  concealFogCells,

  // Viewport
  applyDMViewport,
  snapToDMViewport,
  resyncToDM,
};
