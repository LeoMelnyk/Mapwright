// Caching helpers for per-frame decoration work in the editor render loop.
//
// Text rendering (title, subtitles, scale indicator) and the compass rose
// are identical frame-to-frame until inputs change, but re-running the
// Canvas2D calls each frame still costs font parses, path construction, and
// measureText layout. We render each decoration to a persistent OffscreenCanvas
// keyed on its visible inputs (text/scale/color), then just blit the cached
// bitmap onto the main canvas each frame.
//
// Lives under editor/ because compile.ts (PNG export) runs each decoration
// only once — caching would be pure overhead there.

import type { Theme } from '../../types.js';

// ─── Shared font-setter guard ────────────────────────────────────────────────
// Setting ctx.font re-parses the font string even when the value is unchanged,
// which shows up as a hot self-time entry in profiles. Track the last value
// per context and skip no-op assignments.
const _lastFont = new WeakMap<CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, string>();

export function setFont(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, font: string): void {
  if (_lastFont.get(ctx) === font) return;
  ctx.font = font;
  _lastFont.set(ctx, font);
}

// ─── Text cache ──────────────────────────────────────────────────────────────

type TextEntry = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  width: number;
  height: number;
  baselineOffset: number; // distance from top of canvas to the text baseline
};

const _textCache = new Map<string, TextEntry>();
const _TEXT_CACHE_MAX = 64;

// Scratch canvas for measuring text (cheap to reuse — no resize needed).
let _measureCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let _measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

function _getMeasureCtx() {
  if (_measureCtx) return _measureCtx;
  if (typeof OffscreenCanvas !== 'undefined') {
    _measureCanvas = new OffscreenCanvas(4, 4);
  } else {
    _measureCanvas = document.createElement('canvas');
    _measureCanvas.width = 4;
    _measureCanvas.height = 4;
  }
  _measureCtx = _measureCanvas.getContext('2d') as typeof _measureCtx;
  return _measureCtx!;
}

function _allocCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Render `text` in the given `font` and `color` to a cached OffscreenCanvas.
 * Returns `{ canvas, width, height, baselineOffset }`; the caller blits at
 * its desired anchor using these dimensions.
 *
 * The canvas is sized to hug the glyph ink plus a small margin. Callers
 * treat the returned bitmap as opaque — do not mutate it.
 */
export function getCachedText(text: string, font: string, color: string): TextEntry {
  const key = `${font}|${color}|${text}`;
  const hit = _textCache.get(key);
  if (hit) return hit;

  // LRU-ish cap: drop the oldest entry when we hit the limit. Map iteration
  // is insertion-ordered, so `keys().next()` is the oldest.
  if (_textCache.size >= _TEXT_CACHE_MAX) {
    const oldest = _textCache.keys().next().value;
    if (oldest !== undefined) _textCache.delete(oldest);
  }

  const mctx = _getMeasureCtx();
  mctx.font = font;
  const metrics = mctx.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent || 0;
  const descent = metrics.actualBoundingBoxDescent || 0;
  const textW = Math.max(1, Math.ceil(metrics.width));
  const textH = Math.max(1, Math.ceil(ascent + descent));
  // Small margin so anti-aliased edges aren't clipped.
  const margin = 2;
  const width = textW + margin * 2;
  const height = textH + margin * 2;

  const canvas = _allocCanvas(width, height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, margin, margin + ascent);

  const entry: TextEntry = { canvas, width, height, baselineOffset: margin + ascent };
  _textCache.set(key, entry);
  return entry;
}

/**
 * Draw cached text centered at (cx, topY)-style coordinates.
 * `align`: 'center' | 'left' — how to align horizontally around cx.
 * `baseline`: 'top' | 'bottom' | 'middle' — how to align vertically around y.
 */
export function drawCachedText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  entry: TextEntry,
  x: number,
  y: number,
  align: 'left' | 'center' = 'center',
  baseline: 'top' | 'bottom' | 'middle' | 'alphabetic' = 'top',
): void {
  const dx = align === 'center' ? x - entry.width / 2 : x;
  let dy: number;
  switch (baseline) {
    case 'top':
      dy = y;
      break;
    case 'bottom':
      dy = y - entry.height;
      break;
    case 'middle':
      dy = y - entry.height / 2;
      break;
    case 'alphabetic':
      // Align so the text baseline sits exactly at y.
      dy = y - entry.baselineOffset;
      break;
  }
  ctx.drawImage(entry.canvas as CanvasImageSource, dx, dy);
}

// ─── Compass rose cache ─────────────────────────────────────────────────────
//
// The compass is ~25 arcs/strokes + one text character. Its content only
// depends on the theme colors and the scale factor (zoom). We render it to an
// OffscreenCanvas once per (scale, theme-colors) tuple and blit thereafter.

const COMPASS_BASE = 35;

type CompassEntry = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  // Offset from the top-left of the cached canvas to the compass center point.
  // Callers get (x, y) of the center in world/canvas space and blit at
  // (x - centerOffsetX, y - centerOffsetY).
  centerOffsetX: number;
  centerOffsetY: number;
};

let _compassCache: { key: string; entry: CompassEntry } | null = null;

/**
 * Get or build a cached compass-rose bitmap for the given scale + theme.
 * Matches drawCompassRoseScaled output exactly.
 */
export function getCachedCompass(theme: Theme, s: number): CompassEntry {
  const fillColor = (theme.compassRoseFill ?? theme.wallStroke) || '#000000';
  const strokeColor = (theme.compassRoseStroke ?? theme.wallStroke) || '#000000';
  const textColor = theme.textColor ?? '#000000';
  const key = `${s.toFixed(3)}|${fillColor}|${strokeColor}|${textColor}`;

  if (_compassCache?.key === key) return _compassCache.entry;

  const size = COMPASS_BASE * s;
  const fontSize = Math.max(8, Math.round(14 * s));
  // The 'N' label sits `size + 8*s + fontSize` above the center. Point arms
  // extend `size` below/right of the center. Pad generously for stroke widths.
  const padTop = Math.ceil(size + 8 * s + fontSize + 4);
  const padOther = Math.ceil(size + 4);
  const width = padOther * 2;
  const height = padTop + padOther;
  const cx = padOther;
  const cy = padTop;

  const canvas = _allocCanvas(width, height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  const innerSize = size * 0.6;

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(cx, cy, size, 0, Math.PI * 2);
  ctx.stroke();

  const drawPoint = (angle: number, length: number, filled: boolean) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    const tipX = cx + Math.cos(rad) * length;
    const tipY = cy + Math.sin(rad) * length;
    const baseLeft = ((angle - 90 - 15) * Math.PI) / 180;
    const baseRight = ((angle - 90 + 15) * Math.PI) / 180;
    const baseLength = length * 0.3;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(cx + Math.cos(baseLeft) * baseLength, cy + Math.sin(baseLeft) * baseLength);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + Math.cos(baseRight) * baseLength, cy + Math.sin(baseRight) * baseLength);
    ctx.closePath();

    if (filled) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5 * s;
    ctx.stroke();
  };

  drawPoint(0, size, true);
  drawPoint(90, size * 0.9, false);
  drawPoint(180, size * 0.9, false);
  drawPoint(270, size * 0.9, false);

  drawPoint(45, innerSize, false);
  drawPoint(135, innerSize, false);
  drawPoint(225, innerSize, false);
  drawPoint(315, innerSize, false);

  ctx.beginPath();
  ctx.arc(cx, cy, 3 * s, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1 * s;
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.font = `bold ${fontSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('N', cx, cy - size - 8 * s);

  const entry: CompassEntry = { canvas, centerOffsetX: cx, centerOffsetY: cy };
  _compassCache = { key, entry };
  return entry;
}

/**
 * Drop all cached decoration bitmaps. Call on theme change, tab switch, or any
 * event that invalidates the cache wholesale.
 */
export function invalidateDecorationCache(): void {
  _textCache.clear();
  _compassCache = null;
}
