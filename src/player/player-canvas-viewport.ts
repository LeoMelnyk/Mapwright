// Viewport lerp (tickViewportLerp), DM viewport sync functions.

import playerState from './player-state.js';
import { S, LERP_SPEED } from './player-canvas-state.js';

// Forward declaration — set by player-canvas.ts barrel to break circular dep
let _requestRender: () => void = () => {};
export function setRequestRender(fn: () => void): void {
  _requestRender = fn;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Tick one frame of viewport interpolation. Returns true if still animating.
 */
export function tickViewportLerp(dt: number): boolean {
  if (!S.isLerping) return false;

  const t = Math.min(1, LERP_SPEED * dt); // fraction to close this frame
  playerState.panX = lerp(playerState.panX, S.targetPanX, t);
  playerState.panY = lerp(playerState.panY, S.targetPanY, t);
  playerState.zoom = lerp(playerState.zoom, S.targetZoom, t);

  // Snap when close enough
  const dx = Math.abs(playerState.panX - S.targetPanX);
  const dy = Math.abs(playerState.panY - S.targetPanY);
  const dz = Math.abs(playerState.zoom - S.targetZoom);
  if (dx < 0.5 && dy < 0.5 && dz < 0.001) {
    playerState.panX = S.targetPanX;
    playerState.panY = S.targetPanY;
    playerState.zoom = S.targetZoom;
    S.isLerping = false;
    return false;
  }
  return true;
}

function updateResyncButton(): void {
  const btn = document.getElementById('resync-btn');
  if (btn) btn.classList.toggle('visible', !playerState.followDM);
}

export function applyDMViewport(
  panX: number,
  panY: number,
  zoom: number,
  dmCanvasWidth: number,
  dmCanvasHeight: number,
): void {
  if (!S.canvas) return;
  // Adjust pan so the same world-center on the DM's canvas is centered on ours
  const dmW = dmCanvasWidth || S.canvas.width;
  const dmH = dmCanvasHeight || S.canvas.height;
  const adjustedPanX = panX + (S.canvas.width - dmW) / 2;
  const adjustedPanY = panY + (S.canvas.height - dmH) / 2;

  playerState.dmPanX = adjustedPanX;
  playerState.dmPanY = adjustedPanY;
  playerState.dmZoom = zoom;

  if (playerState.followDM) {
    S.targetPanX = adjustedPanX;
    S.targetPanY = adjustedPanY;
    S.targetZoom = zoom;
    S.isLerping = true;
    _requestRender();
  }
}

/**
 * Snap viewport directly (no interpolation) — used for initial sync.
 */
export function snapToDMViewport(): void {
  const px = playerState.dmPanX;
  const py = playerState.dmPanY;
  const z = playerState.dmZoom;
  playerState.panX = px;
  playerState.panY = py;
  playerState.zoom = z;
  S.targetPanX = px;
  S.targetPanY = py;
  S.targetZoom = z;
  S.isLerping = false;
  playerState.followDM = true;
  _requestRender();
  updateResyncButton();
}

export function resyncToDM(): void {
  S.targetPanX = playerState.dmPanX;
  S.targetPanY = playerState.dmPanY;
  S.targetZoom = playerState.dmZoom;
  S.isLerping = true;
  playerState.followDM = true;
  _requestRender();
  updateResyncButton();
}

export { updateResyncButton };
