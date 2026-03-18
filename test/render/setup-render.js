// Setup for visual render tests — provides the same Node.js polyfills as server.js
// so the real render pipeline can run without a browser.
// Unlike test/setup.js, this does NOT mock renderDungeonToCanvas.

import { createCanvas, Path2D, ImageData } from '@napi-rs/canvas';

if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = Path2D;
if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = ImageData;

if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    constructor(w, h) {
      this._canvas = createCanvas(w, h);
    }
    get width() { return this._canvas.width; }
    set width(v) { this._canvas.width = v; }
    get height() { return this._canvas.height; }
    set height(v) { this._canvas.height = v; }
    getContext(type, options) { return this._canvas.getContext(type, options); }
    transferToImageBitmap() { return this._canvas; }
  };
}

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvas(1, 1);
      return {};
    },
  };
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
