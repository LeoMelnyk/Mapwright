// "Flood Rainbow" debug visualization. When the user toggles
// `state.debugFloodRainbow` on, this module:
//   1. Registers a FloodRecorder with src/util/flood-debug so every traverse()
//      call publishes per-cell BFS depth into `state.floodRainbowCells`.
//   2. Provides a canvas overlay that paints each visited cell with a hue
//      derived from its depth — a "wavefront" view of where BFS reached.
//
// Each new traverse() invocation replaces the previous trace. With BFSes that
// run every render frame (lava regions, pit groups, etc.) the overlay stays
// continuously refreshed; with discrete user actions (paint flood, weather
// fill) the trace persists until the next BFS or until the toggle is turned
// off.

import { setFloodRecorder, toCanvas, type FloodRecorder } from '../../util/index.js';
import type { RenderTransform } from '../../types.js';
import state from './state.js';
import { requestRender } from './canvas-view.js';

const recorder: FloodRecorder = {
  start() {
    state.floodRainbowCells = new Map();
  },
  visit(row, col, depth) {
    const k = `${row},${col}`;
    const existing = state.floodRainbowCells.get(k);
    // Keep the smallest depth seen — cells with multiple segments may be
    // visited via different paths; the BFS distance is the minimum.
    if (existing === undefined || depth < existing) {
      state.floodRainbowCells.set(k, depth);
    }
  },
  end() {
    requestRender();
  },
};

export function setFloodRainbowEnabled(enabled: boolean): void {
  if (enabled) {
    setFloodRecorder(recorder);
  } else {
    setFloodRecorder(null);
    state.floodRainbowCells = new Map();
    requestRender();
  }
}

/**
 * Draw the rainbow overlay. Called every frame from the canvas-view render
 * loop (after the map and other overlays). When the toggle is off or no flood
 * has been recorded, this is a near-no-op.
 */
export function renderFloodRainbowOverlay(
  ctx: CanvasRenderingContext2D,
  transform: RenderTransform,
  gridSize: number,
): void {
  if (!state.debugFloodRainbow) return;
  const cells = state.floodRainbowCells;
  if (cells.size === 0) return;

  ctx.save();
  const sizePx = gridSize * transform.scale;
  // Text is only legible when cells render at least ~14 px wide; skipping it
  // when zoomed out also saves a lot of fillText calls on large floods.
  const showText = sizePx >= 14;
  if (showText) {
    const fontPx = Math.max(8, Math.floor(sizePx * 0.42));
    ctx.font = `${fontPx}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, fontPx / 5);
  }
  for (const [key, depth] of cells) {
    const comma = key.indexOf(',');
    const row = Number(key.slice(0, comma));
    const col = Number(key.slice(comma + 1));
    const { x, y } = toCanvas(col * gridSize, row * gridSize, transform);
    const lightness = depthToLightness(depth);
    ctx.fillStyle = `hsla(0, 0%, ${lightness}%, 0.5)`;
    ctx.fillRect(x, y, sizePx, sizePx);
    if (showText) {
      // Light cells get dark text + light outline; dark cells get the inverse
      // so the depth label stays readable across the whole gradient.
      const textLight = lightness < 55;
      ctx.strokeStyle = textLight ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.85)';
      ctx.fillStyle = textLight ? 'rgba(255, 255, 255, 0.95)' : 'rgba(0, 0, 0, 0.95)';
      const text = String(depth);
      const tx = x + sizePx / 2;
      const ty = y + sizePx / 2;
      ctx.strokeText(text, tx, ty);
      ctx.fillText(text, tx, ty);
    }
  }
  ctx.restore();
}

/**
 * Map BFS depth to grayscale lightness (0–95). Log curve so the first ~50
 * depths get most of the distinguishable range, but very deep cells still
 * stay strictly darker than shallower ones — the value never wraps and
 * approaches 0 asymptotically rather than saturating at a floor.
 */
function depthToLightness(depth: number): number {
  return 95 / (1 + depth * 0.06);
}
