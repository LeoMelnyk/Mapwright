// Setup for visual render tests — provides the same Node.js polyfills as server.js
// so the real render pipeline can run without a browser.
// Unlike test/setup.js, this does NOT mock renderDungeonToCanvas.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, Path2D, ImageData } from '@napi-rs/canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem(k) { return store.get(k) ?? null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
}

// ── Load themes from disk into the shared THEMES registry ──────────────────
// In the browser, themes are loaded via HTTP. In Node tests, load directly.
import { THEMES } from '../../src/render/themes.js';

const themesDir = path.join(__dirname, '../../src/themes');
if (fs.existsSync(themesDir)) {
  for (const file of fs.readdirSync(themesDir)) {
    if (!file.endsWith('.theme')) continue;
    const key = file.replace('.theme', '');
    const data = JSON.parse(fs.readFileSync(path.join(themesDir, file), 'utf-8'));
    const { displayName, ...themeProps } = data;
    THEMES[key] = themeProps;
  }
}
