// Theme Catalog — loads .theme files, registers them with the renderer, provides previews.
// Uses localStorage to cache theme data on subsequent loads.
import { THEMES, renderDungeonToCanvas, calculateCanvasSize } from '../../render/index.js';

const BASE_URL = '/themes/';
const CACHE_KEY = 'theme-catalog';
const CACHE_VER_KEY = 'theme-catalog-ver';

let catalog: any = null; // { names: string[], themes: {}, userNames: string[], userThemes: {} }

// Minimal dungeon used for preview renders — a plain 3×3 room
const PREVIEW_CELLS = [[{}, {}, {}], [{}, {}, {}], [{}, {}, {}]];

/**
 * Register themes into the shared THEMES registry and build the catalog.
 */
function buildFromData(themeMap: any) {
  const names = [];
  const themes = {};
  for (const [key, data] of Object.entries(themeMap)) {
    // @ts-expect-error — strict-mode migration
    const { displayName, ...themeProps } = data;
    (themes as any)[key] = { ...themeProps, displayName };
    names.push(key);
    THEMES[key] = themeProps;
  }
  return { names, themes };
}

/**
 * Load all themes from /themes/manifest.json + individual .theme files.
 * Also loads user-saved themes from /api/user-themes.
 * Caches parsed results in localStorage for fast subsequent loads.
 * @param {function} [onProgress] — called with (loaded, total) as theme files are fetched
 */
export async function loadThemeCatalog(onProgress: any) {
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
        // @ts-expect-error — strict-mode migration
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (cached && Object.keys(cached).length) {
          if (onProgress) onProgress(keys.length, keys.length);
          catalog = buildFromData(cached);
          // Still need to load user themes (not cached with built-ins)
          await _loadUserThemes();
          return catalog;
        }
      } catch { /* cache corrupt, fall through */ }
    }

    // Fresh fetch
    let loaded = 0;
    if (onProgress) onProgress(0, keys.length);

    const results = await Promise.allSettled(
      keys.map(async (key: any) => {
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
      (themeMap as any)[result.value.key] = result.value.data;
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

  // Load user-saved themes
  await _loadUserThemes();

  return catalog;
}

/**
 * Fetch user-saved themes from the server and register them.
 */
async function _loadUserThemes() {
  catalog.userNames = [];
  catalog.userThemes = {};
  try {
    const res = await fetch('/api/user-themes');
    if (!res.ok) return;
    const entries = await res.json();
    for (const entry of entries) {
      try {
        const r = await fetch(`/user-themes/${entry.filename}`);
        if (!r.ok) continue;
        const data = await r.json();
        const { displayName, ...themeProps } = data;
        const fullKey = `user:${entry.key}`;
        catalog.userNames.push(entry.key);
        catalog.userThemes[entry.key] = { ...themeProps, displayName: displayName || entry.key };
        THEMES[fullKey] = themeProps;
      } catch { /* skip individual failures */ }
    }
  } catch { /* no user themes endpoint available */ }
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

// ── User theme CRUD wrappers ──────────────────────────────────────────────

/**
 * Save a new user theme. Returns the slug key.
 */
export async function saveUserTheme(name: any, themeObj: any) {
  const res = await fetch('/api/user-themes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, theme: themeObj }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Save failed (HTTP ${res.status})`);
  }
  const { key } = await res.json();
  // Register locally
  const fullKey = `user:${key}`;
  THEMES[fullKey] = { ...themeObj };
  if (catalog) {
    catalog.userNames.push(key);
    catalog.userThemes[key] = { ...themeObj, displayName: name };
  }
  return key;
}

/**
 * Delete a user theme by slug key.
 */
export async function deleteUserTheme(key: any) {
  await fetch(`/api/user-themes/${key}`, { method: 'DELETE' });
  delete THEMES[`user:${key}`];
  if (catalog) {
    catalog.userNames = catalog.userNames.filter((k: any) => k !== key);
    delete catalog.userThemes[key];
  }
}

/**
 * Rename a user theme. Returns the new slug key.
 */
export async function renameUserTheme(oldKey: any, newName: any) {
  const res = await fetch(`/api/user-themes/${oldKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Rename failed (HTTP ${res.status})`);
  }
  const { key: newKey } = await res.json();
  // Update local registry
  const oldTheme = THEMES[`user:${oldKey}`];
  if (oldKey !== newKey) {
    delete THEMES[`user:${oldKey}`];
    THEMES[`user:${newKey}`] = oldTheme;
  }
  if (catalog) {
    const idx = catalog.userNames.indexOf(oldKey);
    if (idx >= 0) catalog.userNames[idx] = newKey;
    const themeData = catalog.userThemes[oldKey];
    if (themeData) {
      delete catalog.userThemes[oldKey];
      catalog.userThemes[newKey] = { ...themeData, displayName: newName };
    }
  }
  return newKey;
}

/**
 * Render a small offscreen canvas preview for a named theme.
 * Uses the full dungeon renderer on a minimal 3×3 room config.
 */
export function renderThemePreview(themeKey: any) {
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
  // @ts-expect-error — strict-mode migration
  renderDungeonToCanvas(canvas.getContext('2d'), config, width, height);
  return canvas;
}
