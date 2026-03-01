// Theme Catalog — loads .theme files, registers them with the renderer, provides previews.
// Uses localStorage to cache theme data on subsequent loads.
import { THEMES, renderDungeonToCanvas, calculateCanvasSize } from '../../render/index.js';

const BASE_URL = '/themes/';
const CACHE_KEY = 'theme-catalog';
const CACHE_VER_KEY = 'theme-catalog-ver';

let catalog = null; // { names: string[], themes: { [key]: themeObj & { displayName } } }

// Minimal dungeon used for preview renders — a plain 3×3 room
const PREVIEW_CELLS = [[{}, {}, {}], [{}, {}, {}], [{}, {}, {}]];

/**
 * Register themes into the shared THEMES registry and build the catalog.
 */
function buildFromData(themeMap) {
  const names = [];
  const themes = {};
  for (const [key, data] of Object.entries(themeMap)) {
    const { displayName, ...themeProps } = data;
    themes[key] = { ...themeProps, displayName };
    names.push(key);
    THEMES[key] = themeProps;
  }
  return { names, themes };
}

/**
 * Load all themes from /themes/manifest.json + individual .theme files.
 * Caches parsed results in localStorage for fast subsequent loads.
 * @param {function} [onProgress] — called with (loaded, total) as theme files are fetched
 */
export async function loadThemeCatalog(onProgress) {
  if (catalog) return catalog;

  try {
    const res = await fetch(`${BASE_URL}manifest.json`);
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const keys = await res.json();
    const version = keys.join(',');

    // Try localStorage cache
    const cachedVer = localStorage.getItem(CACHE_VER_KEY);
    if (cachedVer === version) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (cached && Object.keys(cached).length) {
          if (onProgress) onProgress(keys.length, keys.length);
          catalog = buildFromData(cached);
          return catalog;
        }
      } catch { /* cache corrupt, fall through */ }
    }

    // Fresh fetch
    let loaded = 0;
    if (onProgress) onProgress(0, keys.length);

    const results = await Promise.allSettled(
      keys.map(async (key) => {
        const r = await fetch(`${BASE_URL}${key}.theme`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        loaded++;
        if (onProgress) onProgress(loaded, keys.length);
        return { key, data };
      })
    );

    const themeMap = {};
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[theme-catalog] Failed to load theme:', result.reason);
        continue;
      }
      themeMap[result.value.key] = result.value.data;
    }

    // Cache to localStorage
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(themeMap));
      localStorage.setItem(CACHE_VER_KEY, version);
    } catch { /* localStorage full or unavailable */ }

    catalog = buildFromData(themeMap);
  } catch (e) {
    console.warn('[theme-catalog] Could not load themes from server:', e);
    catalog = { names: [], themes: {} };
  }

  return catalog;
}

/**
 * Synchronous getter — returns null until loadThemeCatalog() has resolved.
 */
export function getThemeCatalog() {
  return catalog;
}

/** Clear the in-memory catalog cache so the next load re-fetches from server. */
export function clearThemeCatalogCache() {
  catalog = null;
}

/**
 * Render a small offscreen canvas preview for a named theme.
 * Uses the full dungeon renderer on a minimal 3×3 room config.
 */
export function renderThemePreview(themeKey) {
  const config = {
    metadata: {
      dungeonName: '',
      gridSize: 5,
      theme: themeKey,
      features: { showGrid: false, compassRose: false, scale: false, border: false },
      levels: [{ name: '', startRow: 0, numRows: 3 }],
    },
    cells: PREVIEW_CELLS,
  };
  const { width, height } = calculateCanvasSize(config);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  renderDungeonToCanvas(canvas.getContext('2d'), config, width, height);
  return canvas;
}
