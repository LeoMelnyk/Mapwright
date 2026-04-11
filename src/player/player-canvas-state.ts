// Shared mutable state for the player canvas sub-modules.
// All canvas references, transform, MapCache instances, diagnostics, pan/touch state.

import { MapCache } from '../render/index.js';
import playerState from './player-state.js';
import { displayGridSize as _dgs } from '../util/index.js';
import type { CellGrid, RenderTransform, Theme, VisibleBounds } from '../types.js';

const CELL_SIZE = 40; // pixels per cell at zoom=1
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 5.0;
export const LERP_SPEED = 6; // higher = faster interpolation (units/sec style, used as factor per frame)
export const ANIM_INTERVAL_MS = 50; // 20fps — matches editor animation rate

export interface ToolLike {
  onActivate?(): void;
  onDeactivate?(): void;
  renderOverlay?(ctx: CanvasRenderingContext2D, transform: RenderTransform, gridSize: number): void;
  onMouseDown(row: number, col: number, edge: unknown, e: Event, pos: { x: number; y: number }): void;
  onMouseMove(row: number, col: number, edge: unknown, e: Event, pos: { x: number; y: number }): void;
  onMouseUp(row: number, col: number, edge: unknown, e: Event, pos: { x: number; y: number }): void;
}

export interface OffscreenLayer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  cacheW: number;
  cacheH: number;
}

export interface ShadingLayer extends OffscreenLayer {
  sig: string;
}

export interface HatchLayer extends OffscreenLayer {
  hatchSig: string;
}

/** Shared mutable state object — imported by all sub-modules. */
export const S = {
  // Canvas
  canvas: null as HTMLCanvasElement | null,
  ctx: null as CanvasRenderingContext2D | null,

  // Animation
  animFrameId: null as number | null,
  lastFrameTime: 0,
  _animClock: 0,
  _animLoopId: null as ReturnType<typeof setTimeout> | null,

  // Diagnostics overlay (toggle with 'D' key)
  _diagEnabled: false,
  _fpsFrames: 0,
  _fpsLastTime: 0,
  _fpsValue: 0,
  _lastFrameEnd: 0,
  _frameGapMs: 0,
  _lastFogRebuildMs: 0,
  _lastCacheBuildMs: 0,
  _cacheBuildCount: 0,
  _lastBuildType: 'none' as string, // 'full' | 'partial' | 'composite' | 'none'
  _lastBuildTimings: {} as Record<string, number | undefined>,
  _fogRebuildCount: 0,
  _lastRevealMs: 0,
  _lastRevealCellCount: 0,

  // Pan tracking
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  panStartPanX: 0,
  panStartPanY: 0,

  // Touch tracking
  touchMode: null as 'pan' | 'tool' | 'pinch' | null,
  lastPinchDist: 0,
  pinchMidX: 0,
  pinchMidY: 0,

  // Active tool
  activeTool: null as ToolLike | null,
  toolDragging: false,

  // Background image cache
  _bgImgCache: { dataUrl: null, el: null } as { dataUrl: string | null; el: HTMLImageElement | null },

  // Map cache
  _mapCache: null as MapCache | null,
  _playerContentVersion: 0,
  _playerLightingVersion: 0,
  _cacheBuiltVersion: -1,
  _cacheBuiltLightingVersion: -1,
  _pendingDirtyRegion: null as VisibleBounds | null,
  _pendingStructuralChange: false,
  _pendingPreserveCells: false,
  _cachedFullCells: null as CellGrid | null,

  // Fog overlay
  _fogOverlay: null as OffscreenLayer | null,
  _fogVersion: 0,
  _fogBuiltVersion: -1,

  // Shading + hatching layers
  _shadingLayer: null as ShadingLayer | null,
  _shadingComposite: null as OffscreenLayer | null,
  _hatchLayer: null as HatchLayer | null,
  _hatchComposite: null as OffscreenLayer | null,
  _fogEdgeMaskVersion: 0,
  _fogEdgeMaskDirty: 0,

  // Walls overlay
  _wallsLayer: null as OffscreenLayer | null,
  _wallsCells: null as CellGrid | null,

  // Asset readiness gate
  _assetsReady: false,
  _assetReadyCallbacks: [] as (() => void)[],

  // Loading overlay
  _loadingEl: null as HTMLElement | null,
  _cacheBuilding: false,

  // Viewport lerp
  targetPanX: 0,
  targetPanY: 0,
  targetZoom: 1,
  isLerping: false,

  // Walls cache
  _wallsOpenedVersion: -1,
  _wallsOpenedCache: new Set<string>(),
};

// ── Helper accessors ──────────────────────────────────────────────────────

/** Use the DM's render quality (sent via session:init). Defaults to 20. */
export function getMapPxPerFoot(): number {
  return playerState.renderQuality || 20;
}

export function getMapCache(): MapCache {
  S._mapCache ??= new MapCache({ pxPerFoot: getMapPxPerFoot() });
  return S._mapCache;
}

export function getTransform(): RenderTransform {
  if (!playerState.dungeon) return { offsetX: 0, offsetY: 0, scale: 1 };
  const { gridSize, resolution } = playerState.dungeon.metadata;
  const scale = (CELL_SIZE * playerState.zoom) / _dgs(gridSize, resolution);
  return { offsetX: playerState.panX, offsetY: playerState.panY, scale };
}

export function pixelToCell(
  px: number,
  py: number,
  transform: RenderTransform,
  gridSize: number,
): { row: number; col: number } {
  const x = (px - transform.offsetX) / transform.scale;
  const y = (py - transform.offsetY) / transform.scale;
  return { row: Math.floor(y / gridSize), col: Math.floor(x / gridSize) };
}

export function resolveTheme(): Theme | null {
  // Use the resolved theme sent by the DM (avoids empty THEMES lookup)
  if (playerState.resolvedTheme) return playerState.resolvedTheme;
  // Fallback: if dungeon metadata has an inline theme object
  const t = playerState.dungeon?.metadata.theme;
  if (typeof t === 'object') return t;
  return null;
}

export function getCachedBgImage(dataUrl: string, onInvalidate: () => void): HTMLImageElement | null {
  if (S._bgImgCache.dataUrl !== dataUrl) {
    const img = new Image();
    img.onload = () => {
      onInvalidate();
    };
    img.src = dataUrl;
    S._bgImgCache = { dataUrl, el: img };
  }
  return S._bgImgCache.el;
}
